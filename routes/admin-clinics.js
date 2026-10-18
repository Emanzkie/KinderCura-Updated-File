// routes/admin-clinics.js — mounted at /api/admin/clinics.
//
// Admin-only registration, pediatrician linking and reporting for registered
// clinics (models/Clinic.js). Backend for the Clinics section of
// ADMIN/admin-reports.html.
//
// WHAT COUNTS AS WHAT
//   Registered clinic   : a Clinic document, counted by _id. Never a
//                         pediatrician account, and never the shared
//                         system_settings.clinic receipt profile.
//   Pediatrician link   : User.clinicId, set only through PUT
//                         /pediatricians/:userId below.
//   Clinic transaction  : a Payment whose appointment carries that clinicId.
//                         Appointment.clinicId is recorded at booking
//                         (routes/appointments.js), so a payment belongs to
//                         the clinic the pediatrician was linked to when the
//                         visit was booked. Payments whose appointment has no
//                         clinicId are reported as "no clinic association" and
//                         are never assigned to a clinic by guesswork.
//
// Transaction figures reuse services/adminOperationsAnalytics.js: the same
// status groups as the Admin Payments monitor (collected = 'Paid' only), the
// same Payment.createdAt period filter, counts and amounts kept apart. One
// $group per request, and each payment has one appointment, so no payment is
// counted twice.
//
// No child, parent, assessment or payment-instrument field is read here.

const express = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const Clinic = require('../models/Clinic');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Appointment = require('../models/Appointment');
const AuditLog = require('../models/AuditLog');
const adminOps = require('../services/adminOperationsAnalytics');

const router = express.Router();
router.use(authMiddleware, adminOnly);

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const SEARCH_MAX = 100;
const LIMITS = { name: 120, address: 300, contactPhone: 40, contactEmail: 254 };
const PHONE = /^[0-9+()\-.\s]{7,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Validates a create or update body. `partial` allows missing fields (PATCH).
 * Returns { values } or { error }.
 */
function readClinicFields(body, { partial }) {
  const b = body || {};
  const values = {};
  for (const key of ['name', 'address']) {
    if (b[key] === undefined && partial) continue;
    const v = typeof b[key] === 'string' ? b[key].trim() : '';
    const label = key === 'name' ? 'Clinic name' : 'Clinic address';
    if (!v) return { error: `${label} is required.` };
    if (v.length > LIMITS[key]) return { error: `${label} must be ${LIMITS[key]} characters or fewer.` };
    values[key] = v;
  }
  for (const key of ['contactPhone', 'contactEmail']) {
    if (b[key] === undefined) continue;
    if (b[key] !== null && typeof b[key] !== 'string') return { error: `${key} must be text.` };
    const v = (b[key] || '').trim();
    if (!v) { values[key] = null; continue; }
    if (v.length > LIMITS[key]) return { error: `${key} must be ${LIMITS[key]} characters or fewer.` };
    if (key === 'contactPhone' && !PHONE.test(v)) return { error: 'Contact phone may contain only digits, spaces, +, -, ( ) and dots.' };
    if (key === 'contactEmail' && !EMAIL.test(v)) return { error: 'Contact email is not a valid email address.' };
    values[key] = key === 'contactEmail' ? v.toLowerCase() : v;
  }
  if (b.status !== undefined) {
    if (!Clinic.CLINIC_STATUSES.includes(b.status)) return { error: `Status must be one of: ${Clinic.CLINIC_STATUSES.join(', ')}.` };
    values.status = b.status;
  }
  return { values };
}

const publicClinic = (c) => ({
  id: String(c._id),
  name: c.name,
  address: c.address,
  contactPhone: c.contactPhone || null,
  contactEmail: c.contactEmail || null,
  status: c.status,
  registeredAt: c.createdAt || null,
  updatedAt: c.updatedAt || null,
});

const pediatricianName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || null;

// A clinic record is "incomplete" when it lacks a contact phone or a contact
// email. Name and address are required by the schema, so they never are.
const MISSING = { $in: [null, ''] };
const INCOMPLETE_FILTER = { $or: [{ contactPhone: MISSING }, { contactEmail: MISSING }] };
const COMPLETE_FILTER = { contactPhone: { $nin: [null, ''] }, contactEmail: { $nin: [null, ''] } };
const COMPLETENESS = { incomplete: INCOMPLETE_FILTER, complete: COMPLETE_FILTER };

/** Pediatrician accounts whose first, last or full name matches rx. */
function pediatricianNameFilter(rx) {
  const fullName = { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] };
  return {
    role: 'pediatrician',
    $or: [
      { firstName: rx },
      { lastName: rx },
      { $expr: { $regexMatch: { input: fullName, regex: rx.source, options: 'i' } } },
    ],
  };
}

/**
 * Payment rows grouped by the clinic their appointment was booked under, in
 * the shape adminOps.summarizePayments expects plus clinicId. With clinicIds,
 * only payments for those clinics.
 */
function paymentRowsByClinic(period, clinicIds) {
  const stages = [
    { $match: adminOps.periodMatch('createdAt', period) },
    {
      $lookup: {
        from: Appointment.collection.name,
        localField: 'appointmentId',
        foreignField: '_id',
        as: 'appt',
        pipeline: [{ $project: { _id: 0, clinicId: 1 } }],
      },
    },
    { $set: { clinicId: { $ifNull: [{ $first: '$appt.clinicId' }, null] } } },
  ];
  if (clinicIds) stages.push({ $match: { clinicId: { $in: clinicIds } } });
  stages.push({
    $group: {
      // noAppointment: the payment's appointment record no longer exists, the
      // other reason (besides booking before a clinic link) a payment has no clinic.
      _id: { clinicId: '$clinicId', status: '$status', currency: '$currency', noAppointment: { $eq: [{ $size: '$appt' }, 0] } },
      count: { $sum: 1 },
      amount: { $sum: { $ifNull: ['$amount', 0] } },
    },
  });
  return Payment.aggregate(stages);
}

/** Splits paymentRowsByClinic output into Map(clinicId string | 'none' → summary rows). */
function rowsPerClinic(rows) {
  const byClinic = new Map();
  for (const r of rows) {
    const key = r._id.clinicId ? String(r._id.clinicId) : 'none';
    if (!byClinic.has(key)) byClinic.set(key, []);
    byClinic.get(key).push({ _id: { status: r._id.status, currency: r._id.currency }, count: r.count, amount: r.amount });
  }
  return byClinic;
}

/** How many paymentRowsByClinic payments have no clinic because their appointment record is missing. */
function missingAppointmentCount(rows) {
  return rows.reduce((n, r) => n + (!r._id.clinicId && r._id.noAppointment ? r.count : 0), 0);
}

const periodOut = (period) => ({
  from: period.from ? period.from.toISOString() : null,
  to: period.to ? period.to.toISOString() : null,
});

function audit(req, action, targetId, details) {
  // Same record shape routes/admin.js writes; an audit failure must not undo
  // the change the admin just made, so it is logged rather than thrown.
  return AuditLog.create({ actorId: req.user.userId || null, action, targetType: 'Clinic', targetId, details })
    .catch((err) => console.error(`audit ${action} failed:`, err.message));
}

// GET /summary?from&to — clinic counts and the transaction split.
router.get('/summary', async (req, res) => {
  try {
    const period = adminOps.parsePeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const hasPeriod = Boolean(period.from || period.to);

    const [statusRows, newInPeriod, incomplete, linkedClinicIds, pediatricianTotal, paymentRows] = await Promise.all([
      Clinic.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      hasPeriod ? Clinic.countDocuments(adminOps.periodMatch('createdAt', period)) : null,
      Clinic.countDocuments(INCOMPLETE_FILTER),
      User.distinct('clinicId', { role: 'pediatrician', clinicId: { $ne: null } }),
      User.countDocuments({ role: 'pediatrician' }),
      paymentRowsByClinic(period, null),
    ]);
    // Only links that point at an existing clinic record count.
    const existingLinkedIds = linkedClinicIds.length
      ? await Clinic.distinct('_id', { _id: { $in: linkedClinicIds } })
      : [];
    const withPediatricians = existingLinkedIds.length;
    // Unlinked pediatricians who typed a clinic name at sign-up: that text is
    // a self-reported label, never a clinic record, so it is only reported.
    const [linkedPediatricians, unlinkedWithClinicName] = await Promise.all([
      existingLinkedIds.length
        ? User.countDocuments({ role: 'pediatrician', clinicId: { $in: existingLinkedIds } })
        : 0,
      User.countDocuments({
        role: 'pediatrician',
        clinicId: { $nin: existingLinkedIds },
        clinicName: /\S/,
      }),
    ]);
    const count = (s) => (statusRows.find((r) => r._id === s) || { count: 0 }).count;
    const byClinic = rowsPerClinic(paymentRows);
    const linkedRows = [...byClinic.entries()].filter(([k]) => k !== 'none').flatMap(([, v]) => v);

    res.json({
      success: true,
      period: periodOut(period),
      clinics: {
        registered: statusRows.reduce((n, r) => n + r.count, 0),
        active: count('active'),
        inactive: count('inactive'),
        newInPeriod,
        withPediatricians,
        incomplete,
      },
      pediatricians: {
        total: pediatricianTotal,
        linked: linkedPediatricians,
        unlinked: pediatricianTotal - linkedPediatricians,
        unlinkedWithClinicName,
      },
      transactions: {
        withClinic: adminOps.summarizePayments(linkedRows),
        withoutClinic: adminOps.summarizePayments(byClinic.get('none') || []),
        withoutClinicMissingAppointment: missingAppointmentCount(paymentRows),
        all: adminOps.summarizePayments(paymentRows.map((r) => ({ _id: { status: r._id.status, currency: r._id.currency }, count: r.count, amount: r.amount }))),
      },
    });
  } catch (err) {
    console.error('GET /admin/clinics/summary error:', err.message);
    res.status(500).json({ error: 'Could not load the clinic summary.' });
  }
});

// GET /?search&status&completeness&sort&page&limit&from&to — registered
// clinics, one page. search matches the clinic's name, address, phone or
// email, or the name of a pediatrician linked to it.
router.get('/', async (req, res) => {
  try {
    const period = adminOps.parsePeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, SEARCH_MAX) : '';
    const status = req.query.status ? String(req.query.status) : '';
    if (status && !Clinic.CLINIC_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status filter.' });
    const completeness = req.query.completeness ? String(req.query.completeness) : '';
    if (completeness && !COMPLETENESS[completeness]) return res.status(400).json({ error: 'Unknown completeness filter.' });
    const sorts = { name: { name: 1, _id: 1 }, newest: { createdAt: -1, _id: -1 }, oldest: { createdAt: 1, _id: 1 } };
    const sortKey = sorts[req.query.sort] ? req.query.sort : 'name';
    const limit = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(req.query.limit, 10) || PAGE_SIZE_DEFAULT));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const clauses = [];
    if (status) clauses.push({ status });
    if (completeness) clauses.push(COMPLETENESS[completeness]);
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const byPediatrician = await User.distinct('clinicId', { ...pediatricianNameFilter(rx), clinicId: { $ne: null } });
      clauses.push({ $or: [{ name: rx }, { address: rx }, { contactEmail: rx }, { contactPhone: rx }, { _id: { $in: byPediatrician } }] });
    }
    const filter = clauses.length ? { $and: clauses } : {};

    const [matchingIds, clinics] = await Promise.all([
      Clinic.distinct('_id', filter),
      Clinic.find(filter).sort(sorts[sortKey]).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    const total = matchingIds.length;
    const ids = clinics.map((c) => c._id);
    const [linkedInMatching, pediatricianRows, paymentRows] = await Promise.all([
      total ? User.countDocuments({ role: 'pediatrician', clinicId: { $in: matchingIds } }) : 0,
      ids.length
        ? User.aggregate([
          { $match: { role: 'pediatrician', clinicId: { $in: ids } } },
          { $sort: { lastName: 1, firstName: 1, _id: 1 } },
          { $group: { _id: '$clinicId', people: { $push: { id: '$_id', firstName: '$firstName', lastName: '$lastName' } } } },
        ])
        : [],
      ids.length ? paymentRowsByClinic(period, ids) : [],
    ]);
    const pediatricians = new Map(pediatricianRows.map((r) => [String(r._id), r.people]));
    const byClinic = rowsPerClinic(paymentRows);

    res.json({
      success: true,
      period: periodOut(period),
      page,
      limit,
      total,
      // Pediatrician accounts linked to any clinic matching the filters (not
      // just this page). Each pediatrician has at most one clinic.
      linkedPediatricians: linkedInMatching,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      clinics: clinics.map((c) => {
        const people = pediatricians.get(String(c._id)) || [];
        return {
          ...publicClinic(c),
          pediatricianCount: people.length,
          pediatricians: people.map((u) => ({ id: String(u.id), name: pediatricianName(u) })),
          transactionCount: adminOps.summarizePayments(byClinic.get(String(c._id)) || []).totalCount,
        };
      }),
    });
  } catch (err) {
    console.error('GET /admin/clinics error:', err.message);
    res.status(500).json({ error: 'Could not load registered clinics.' });
  }
});

// GET /pediatricians?search — pediatrician accounts for the link picker.
router.get('/pediatricians', async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, SEARCH_MAX) : '';
    const filter = { role: 'pediatrician' };
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }];
    }
    const users = await User.find(filter)
      .select('firstName lastName email status prcVerificationStatus clinicId isSynthetic')
      .sort({ lastName: 1, firstName: 1, _id: 1 })
      .limit(20)
      .lean();
    const clinicIds = [...new Set(users.filter((u) => u.clinicId).map((u) => String(u.clinicId)))];
    const clinics = clinicIds.length
      ? await Clinic.find({ _id: { $in: clinicIds } }).select('name').lean()
      : [];
    const clinicNames = new Map(clinics.map((c) => [String(c._id), c.name]));
    res.json({
      success: true,
      pediatricians: users.map((u) => ({
        id: String(u._id),
        name: pediatricianName(u),
        email: u.email || null,
        accountStatus: u.status || null,
        prcVerificationStatus: u.prcVerificationStatus || null,
        isSynthetic: u.isSynthetic === true,
        clinicId: u.clinicId ? String(u.clinicId) : null,
        clinicName: u.clinicId ? clinicNames.get(String(u.clinicId)) || null : null,
      })),
    });
  } catch (err) {
    console.error('GET /admin/clinics/pediatricians error:', err.message);
    res.status(500).json({ error: 'Could not load pediatricians.' });
  }
});

// PUT /pediatricians/:userId { clinicId: id | null } — link or unlink.
// Changes only User.clinicId. PRC status, account status and existing
// appointments are untouched; appointments booked from now on record the new
// clinic.
router.put('/pediatricians/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!OBJECT_ID.test(userId)) return res.status(400).json({ error: 'Invalid pediatrician id.' });
    const raw = req.body ? req.body.clinicId : undefined;
    if (raw === undefined) return res.status(400).json({ error: 'clinicId is required (use null to unlink).' });
    if (raw !== null && (typeof raw !== 'string' || !OBJECT_ID.test(raw))) {
      return res.status(400).json({ error: 'Invalid clinic id.' });
    }

    const user = await User.findOne({ _id: userId, role: 'pediatrician' }).select('clinicId').lean();
    if (!user) return res.status(404).json({ error: 'Pediatrician not found.' });

    let clinic = null;
    if (raw) {
      clinic = await Clinic.findById(raw).select('name status').lean();
      if (!clinic) return res.status(404).json({ error: 'Clinic not found.' });
      if (clinic.status !== 'active') return res.status(409).json({ error: 'This clinic is inactive. Reactivate it before linking pediatricians.' });
    }

    const from = user.clinicId ? String(user.clinicId) : null;
    const to = clinic ? String(clinic._id) : null;
    if (from !== to) {
      await User.updateOne({ _id: userId, role: 'pediatrician' }, { $set: { clinicId: clinic ? clinic._id : null } });
      await audit(req, to ? 'clinic_pediatrician_linked' : 'clinic_pediatrician_unlinked', to || from, { pediatricianId: userId, fromClinicId: from, toClinicId: to });
    }
    res.json({ success: true, pediatricianId: userId, clinicId: to, changed: from !== to });
  } catch (err) {
    console.error('PUT /admin/clinics/pediatricians error:', err.message);
    res.status(500).json({ error: 'Could not update the pediatrician link.' });
  }
});

// POST / — register a clinic.
router.post('/', async (req, res) => {
  try {
    const { values, error } = readClinicFields(req.body, { partial: false });
    if (error) return res.status(400).json({ error });
    const clinic = await Clinic.create({ ...values, createdBy: OBJECT_ID.test(String(req.user.userId)) ? req.user.userId : null });
    await audit(req, 'clinic_registered', clinic._id, { name: clinic.name });
    res.status(201).json({ success: true, clinic: publicClinic(clinic) });
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await Clinic.findOne({ identityKey: Clinic.clinicIdentityKey(req.body.name, req.body.address) }).select('name').lean();
      return res.status(409).json({
        error: 'A clinic with this name is already registered at this address.',
        existingClinicId: existing ? String(existing._id) : null,
      });
    }
    if (err && err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    console.error('POST /admin/clinics error:', err.message);
    res.status(500).json({ error: 'Could not register the clinic.' });
  }
});

// GET /:id?from&to — one clinic, its pediatricians and its transactions.
router.get('/:id', async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid clinic id.' });
    const period = adminOps.parsePeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const clinic = await Clinic.findById(req.params.id).lean();
    if (!clinic) return res.status(404).json({ error: 'Clinic not found.' });

    const [pediatricians, paymentRows] = await Promise.all([
      User.find({ role: 'pediatrician', clinicId: clinic._id })
        .select('firstName lastName email status prcVerificationStatus isSynthetic')
        .sort({ lastName: 1, firstName: 1, _id: 1 })
        .lean(),
      paymentRowsByClinic(period, [clinic._id]),
    ]);
    res.json({
      success: true,
      period: periodOut(period),
      clinic: publicClinic(clinic),
      pediatricians: pediatricians.map((u) => ({
        id: String(u._id),
        name: pediatricianName(u),
        email: u.email || null,
        accountStatus: u.status || null,
        prcVerificationStatus: u.prcVerificationStatus || null,
        isSynthetic: u.isSynthetic === true,
      })),
      transactions: adminOps.summarizePayments(rowsPerClinic(paymentRows).get(String(clinic._id)) || []),
    });
  } catch (err) {
    console.error('GET /admin/clinics/:id error:', err.message);
    res.status(500).json({ error: 'Could not load the clinic.' });
  }
});

// PATCH /:id — edit profile fields or status.
router.patch('/:id', async (req, res) => {
  try {
    if (!OBJECT_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid clinic id.' });
    const { values, error } = readClinicFields(req.body, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(values).length) return res.status(400).json({ error: 'No clinic fields supplied.' });

    const clinic = await Clinic.findById(req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found.' });
    const changed = Object.keys(values).filter((k) => clinic[k] !== values[k]);
    if (changed.length) {
      Object.assign(clinic, values);
      await clinic.save();
      await audit(req, 'clinic_updated', clinic._id, { fields: changed });
    }
    res.json({ success: true, clinic: publicClinic(clinic), changed });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'Another clinic with this name is already registered at this address.' });
    }
    if (err && err.name === 'ValidationError') return res.status(400).json({ error: err.message });
    console.error('PATCH /admin/clinics/:id error:', err.message);
    res.status(500).json({ error: 'Could not update the clinic.' });
  }
});

module.exports = router;
// Exposed for tests only.
module.exports._internals = { readClinicFields, paymentRowsByClinic, rowsPerClinic, missingAppointmentCount, pediatricianNameFilter, COMPLETENESS };
