// routes/checkups.js
// ============================================================================
// Longitudinal pediatrician check-up / medical-history API.
//
// This is deliberately a SEPARATE resource from Assessment
// (routes/assessments.js POST /diagnose/:childId): that endpoint records a
// pediatrician's review of ONE screening session's scores. This router
// records a CLINICAL VISIT over time — initial check-up, follow-up,
// follow-up, ... resolved/parent-monitoring — which may or may not be tied
// to a screening session at all. See models/PediatricianCheckup.js for the
// full rationale.
//
// Every write here is a NEW document. Nothing in this file ever overwrites a
// previous check-up record to reflect "the latest state" — PATCH only
// corrects the ONE record named in the URL (e.g. a typo), and never touches
// createdAt. The pattern for core business logic split out of the route
// handler and exposed via router.__testables (so it's unit-testable without
// a live HTTP request or DB) follows routes/assessments.js
// reviewAssessmentMlLabel / routes/recommendations.js buildOverallCarePlan.
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { authMiddleware } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianAccess');
const { pediatricianHasPatient, findLinkedAppointment } = require('../services/patientAccess');
const Child = require('../models/Child');
const Appointment = require('../models/Appointment');
const Assessment = require('../models/Assessment');
const PediatricianCheckup = require('../models/PediatricianCheckup');
const SpecialistReferral = require('../models/SpecialistReferral');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function formatPersonName(user, fallback) {
  if (!user) return fallback;
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || fallback;
}

// ── Authorization ────────────────────────────────────────────────────────
// canRead: the parent who owns the child, a guardian explicitly granted
// 'viewMedicalRecords', any pediatrician with an appointment for this child,
// or an admin.
// canWrite: ONLY a pediatrician with an appointment for this child — this is
// what stops arbitrary childId injection and cross-patient writes.
async function loadChildAndAccess(childId, user) {
  if (!mongoose.Types.ObjectId.isValid(String(childId))) {
    throw new HttpError(404, 'Child not found.');
  }
  const child = await Child.findById(childId).lean();
  if (!child) throw new HttpError(404, 'Child not found.');

  const isParentOwner = String(child.parentId) === String(user.userId);
  const isPediaLinked = user.role === 'pediatrician'
    && await pediatricianHasPatient(user.userId, child._id);
  const isAdmin = user.role === 'admin';
  const hasSharedAccess = (user.role === 'parent' && !isParentOwner)
    ? await hasPermission(user.userId, child._id, 'viewMedicalRecords')
    : false;

  return {
    child,
    isParentOwner,
    isPediaLinked,
    isAdmin,
    hasSharedAccess,
    canRead: isParentOwner || isPediaLinked || isAdmin || hasSharedAccess,
    canWrite: isPediaLinked,
  };
}

// ── Field validation (pure) ─────────────────────────────────────────────
function validateVisitType(value) {
  const v = String(value ?? '').trim();
  if (!PediatricianCheckup.VISIT_TYPES.includes(v)) {
    throw new HttpError(400, `visitType must be one of: ${PediatricianCheckup.VISIT_TYPES.join(', ')}`);
  }
  return v;
}

function validateStatus(value) {
  const v = String(value ?? '').trim();
  if (!PediatricianCheckup.STATUSES.includes(v)) {
    throw new HttpError(400, `status must be one of: ${PediatricianCheckup.STATUSES.join(', ')}`);
  }
  return v;
}

// Deliberately lighter-weight than Assessment's diagnosis validation
// (routes/assessments.js parseNextAssessmentDate/diagnose handler) — this is
// a per-visit clinical note, not the single ground-truth diagnosis field, and
// a "Resolved" follow-up may legitimately be short (e.g. "No further
// developmental concerns identified."). Still requires real text, not a
// one-character placeholder.
function validateDiagnosisText(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(400, 'Diagnosis is required.');
  if (text.length < 3) throw new HttpError(400, 'Diagnosis must describe a clinical finding.');
  if (text.length > 4000) throw new HttpError(400, 'Diagnosis is too long (4000 characters max).');
  return text;
}

function optionalText(value, maxLen, label) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLen) throw new HttpError(400, `${label} is too long (${maxLen} characters max).`);
  return text;
}

// Shared low-level date parser. 'YYYY-MM-DD' is anchored locally (matches
// parseNextAssessmentDate() in routes/assessments.js) so a date-only string
// never shifts a day across timezones.
function parseDateOnly(raw) {
  const dateOnly = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
      return null;
    }
    return { parsed, isDateOnly: true };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return { parsed, isDateOnly: false };
}

// A check-up record describes a visit that happened (or is being logged
// right now) — today or the past, not the future (1-day tolerance for clock
// skew). Defaults to now when omitted.
function parseCheckupDate(value) {
  if (value == null || String(value).trim() === '') return { value: new Date() };
  const result = parseDateOnly(String(value).trim());
  if (!result) return { error: 'Check-up date is invalid.' };

  const maxAllowed = new Date();
  maxAllowed.setDate(maxAllowed.getDate() + 1);
  if (result.parsed > maxAllowed) return { error: 'Check-up date cannot be in the future.' };
  return { value: result.parsed };
}

// Mirrors parseNextAssessmentDate()'s past-date rule exactly — a follow-up
// cannot be scheduled for a date that has already passed.
function parseFollowUpDate(value) {
  if (value == null || String(value).trim() === '') return { value: null };
  const result = parseDateOnly(String(value).trim());
  if (!result) return { error: 'Next follow-up date is invalid.' };

  if (result.isDateOnly) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const candidate = new Date(result.parsed);
    candidate.setHours(0, 0, 0, 0);
    if (candidate < today) return { error: 'Next follow-up date cannot be in the past.' };
  } else if (result.parsed < new Date()) {
    return { error: 'Next follow-up date cannot be in the past.' };
  }
  return { value: result.parsed };
}

function isoDay(d) { return d.toISOString().slice(0, 10); }
function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// True when `raw` is the follow-up date ALREADY stored on the record being
// edited. Re-sending an unchanged date is not a change, so it must not be held
// to the "not in the past" rule — an older record's follow-up date is
// legitimately in the past by the time it is corrected. Only a date that differs
// from the stored one goes through parseFollowUpDate().
function isRetainedFollowUpDate(existing, raw) {
  if (!existing || raw == null || String(raw).trim() === '') return false;
  const stored = existing instanceof Date ? existing : new Date(existing);
  if (Number.isNaN(stored.getTime())) return false;
  const text = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text === isoDay(stored) || text === localDay(stored);
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() === stored.getTime();
}

// ── Cross-reference resolution — every id is verified against THIS child,
// never trusted from the client as-is. ──────────────────────────────────
async function resolveAppointmentRef(rawAppointmentId, child, pediatricianId) {
  if (rawAppointmentId != null && String(rawAppointmentId).trim() !== '') {
    const numericId = Number(rawAppointmentId);
    if (!Number.isFinite(numericId)) throw new HttpError(400, 'appointmentId must be a number.');
    const appt = await Appointment.findOne({ id: numericId }).lean();
    if (!appt || String(appt.childId) !== String(child._id) || String(appt.pediatricianId) !== String(pediatricianId)) {
      throw new HttpError(400, 'The supplied appointment does not belong to this child and pediatrician.');
    }
    return numericId;
  }

  // Not supplied — auto-attach the most recent appointment between this
  // pediatrician and child, the same convenience routes/assessments.js POST
  // /child/:childId/progress-notes already provides, so the pediatrician
  // does not have to look up an appointment id by hand.
  const linked = await findLinkedAppointment(pediatricianId, child._id);
  return linked ? linked.id : null;
}

async function resolveAssessmentRef(rawAssessmentId, child) {
  if (rawAssessmentId == null || String(rawAssessmentId).trim() === '') return null;
  const id = String(rawAssessmentId).trim();
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'assessmentId is not a valid id.');
  const assessment = await Assessment.findOne({ _id: id, childId: child._id }).lean();
  if (!assessment) throw new HttpError(400, 'The supplied assessment does not belong to this child.');
  return assessment._id;
}

// previousRecordId auto-threads to the child's own most recent check-up when
// the caller does not supply one, so the chain stays connected without the
// pediatrician having to look up an id by hand — an initial check-up (no
// prior records) naturally resolves to null. Never crosses to another child,
// nor to another pediatrician's records: a pediatrician's timeline is their own.
async function resolvePreviousRecordRef(rawPreviousRecordId, child, pediatricianId) {
  if (rawPreviousRecordId != null && String(rawPreviousRecordId).trim() !== '') {
    const id = String(rawPreviousRecordId).trim();
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'previousRecordId is not a valid id.');
    const prev = await PediatricianCheckup.findOne({ _id: id, childId: child._id, pediatricianId }).lean();
    if (!prev) throw new HttpError(400, 'previousRecordId is not one of your check-ups for this child.');
    return prev._id;
  }

  const latest = await PediatricianCheckup.findOne({ childId: child._id, pediatricianId })
    .sort({ checkupDate: -1, createdAt: -1 })
    .lean();
  return latest ? latest._id : null;
}

// ── Notification (best-effort, never blocks the save) ──────────────────
function buildCheckupNotificationMessage(child, doc) {
  const childName = [child?.firstName, child?.lastName].filter(Boolean).join(' ').trim() || 'your child';
  const isInitial = doc.visitType === 'initial_checkup';
  const visitLabel = isInitial ? 'initial check-up' : 'follow-up check-up';
  const diagnosisPreview = String(doc.diagnosis || '').slice(0, 140);
  return `${isInitial ? 'An' : 'A'} ${visitLabel} was recorded for ${childName}. Diagnosis: ${diagnosisPreview}`;
}

async function notifyParentOfCheckup(child, doc) {
  if (!child?.parentId) return;
  try {
    await Notification.create({
      userId: child.parentId,
      title: 'New check-up recorded',
      message: buildCheckupNotificationMessage(child, doc),
      type: 'checkup',
      relatedPage: `/parent/reports.html?childId=${String(child._id)}`,
      isRead: false,
    });
  } catch (err) {
    console.warn('checkup notification create failed:', err.message);
  }
}

// ── Core business logic (exported for unit tests) ──────────────────────

async function createCheckupRecord(childId, user, body) {
  if (user.role !== 'pediatrician') throw new HttpError(403, 'Pediatricians only.');

  const { child, canWrite } = await loadChildAndAccess(childId, user);
  if (!canWrite) {
    throw new HttpError(403, 'You are not linked to this patient — only a pediatrician with an appointment for this child may record a check-up.');
  }

  const visitType = validateVisitType(body.visitType);
  const status = validateStatus(body.status);
  const diagnosis = validateDiagnosisText(body.diagnosis);
  const findings = optionalText(body.findings, 4000, 'Findings');
  const recommendations = optionalText(body.recommendations, 4000, 'Recommendations');
  const nextFollowUpReason = optionalText(body.nextFollowUpReason, 500, 'Next follow-up reason');

  const checkupDateResult = parseCheckupDate(body.checkupDate);
  if (checkupDateResult.error) throw new HttpError(400, checkupDateResult.error);

  const nextFollowUpDateResult = parseFollowUpDate(body.nextFollowUpDate);
  if (nextFollowUpDateResult.error) throw new HttpError(400, nextFollowUpDateResult.error);

  const [appointmentId, assessmentId, previousRecordId] = await Promise.all([
    resolveAppointmentRef(body.appointmentId, child, user.userId),
    resolveAssessmentRef(body.assessmentId, child),
    resolvePreviousRecordRef(body.previousRecordId, child, user.userId),
  ]);

  const created = await PediatricianCheckup.create({
    childId: child._id,
    pediatricianId: user.userId,
    appointmentId,
    assessmentId,
    checkupDate: checkupDateResult.value,
    visitType,
    diagnosis,
    findings,
    recommendations,
    nextFollowUpDate: nextFollowUpDateResult.value,
    nextFollowUpReason,
    status,
    previousRecordId,
  });

  await AuditLog.create({
    actorId: user.userId,
    action: 'checkup_created',
    targetType: 'PediatricianCheckup',
    targetId: created._id,
    details: { childId: String(child._id), visitType, status, previousRecordId: previousRecordId ? String(previousRecordId) : null },
  });

  await notifyParentOfCheckup(child, created);

  return created;
}

async function listCheckupsForChild(childId, user) {
  const { child, canRead } = await loadChildAndAccess(childId, user);
  if (!canRead) throw new HttpError(403, 'Access denied.');

  const filter = { childId: child._id };
  // Mirrors the existing progress-notes convention (routes/assessments.js):
  // a pediatrician only sees their OWN check-up timeline for this patient,
  // never another pediatrician's notes for the same child.
  if (user.role === 'pediatrician') filter.pediatricianId = user.userId;

  return PediatricianCheckup.find(filter)
    .populate('pediatricianId', 'firstName lastName')
    .sort({ checkupDate: -1, createdAt: -1 })
    .lean();
}

async function getCheckupRecord(childId, checkupId, user) {
  const { child, canRead } = await loadChildAndAccess(childId, user);
  if (!canRead) throw new HttpError(403, 'Access denied.');
  if (!mongoose.Types.ObjectId.isValid(String(checkupId))) throw new HttpError(404, 'Check-up record not found.');

  const record = await PediatricianCheckup.findOne({ _id: checkupId, childId: child._id })
    .populate('pediatricianId', 'firstName lastName')
    .lean();
  if (!record) throw new HttpError(404, 'Check-up record not found.');

  if (user.role === 'pediatrician') {
    const recordPediaId = record.pediatricianId && record.pediatricianId._id ? record.pediatricianId._id : record.pediatricianId;
    if (String(recordPediaId) !== String(user.userId)) throw new HttpError(403, 'Access denied.');
  }

  return record;
}

async function updateCheckupRecord(childId, checkupId, user, body) {
  if (user.role !== 'pediatrician') throw new HttpError(403, 'Pediatricians only.');

  const { child, canWrite } = await loadChildAndAccess(childId, user);
  if (!canWrite) throw new HttpError(403, 'You are not linked to this patient.');
  if (!mongoose.Types.ObjectId.isValid(String(checkupId))) throw new HttpError(404, 'Check-up record not found.');

  const record = await PediatricianCheckup.findOne({ _id: checkupId, childId: child._id });
  if (!record) throw new HttpError(404, 'Check-up record not found.');

  if (String(record.pediatricianId) !== String(user.userId)) {
    throw new HttpError(403, 'You can only edit your own check-up records.');
  }

  // Controlled edit: only clinical content fields may change. Identity/link
  // fields (childId, pediatricianId, appointmentId, assessmentId,
  // previousRecordId) and createdAt are never touched here — this corrects
  // ONE historical record (e.g. a typo), it never restructures the chain or
  // overwrites a different record.
  if (body.diagnosis !== undefined) record.diagnosis = validateDiagnosisText(body.diagnosis);
  if (body.findings !== undefined) record.findings = optionalText(body.findings, 4000, 'Findings');
  if (body.recommendations !== undefined) record.recommendations = optionalText(body.recommendations, 4000, 'Recommendations');
  if (body.nextFollowUpReason !== undefined) record.nextFollowUpReason = optionalText(body.nextFollowUpReason, 500, 'Next follow-up reason');
  if (body.status !== undefined) record.status = validateStatus(body.status);
  if (body.visitType !== undefined) record.visitType = validateVisitType(body.visitType);

  if (body.checkupDate !== undefined) {
    const r = parseCheckupDate(body.checkupDate);
    if (r.error) throw new HttpError(400, r.error);
    record.checkupDate = r.value;
  }
  if (body.nextFollowUpDate !== undefined && !isRetainedFollowUpDate(record.nextFollowUpDate, body.nextFollowUpDate)) {
    const r = parseFollowUpDate(body.nextFollowUpDate);
    if (r.error) throw new HttpError(400, r.error);
    record.nextFollowUpDate = r.value;
  }

  record.editedAt = new Date();
  record.editedBy = user.userId;

  await record.save();

  await AuditLog.create({
    actorId: user.userId,
    action: 'checkup_edited',
    targetType: 'PediatricianCheckup',
    targetId: record._id,
    details: { childId: String(child._id) },
  });

  return record;
}

// ── Refer to a Specialist ────────────────────────────────────────────────
// A referral is an ADDITIONAL record (models/SpecialistReferral.js). Nothing
// below writes to PediatricianCheckup, Assessment or Appointment: the source
// check-up keeps its own diagnosis, status, dates and pediatrician, and no
// appointment, specialist account or consultation is created. There is no
// update/delete for referrals.

function requiredText(value, minLen, maxLen, label, emptyMessage) {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(400, emptyMessage);
  if (text.length < minLen) throw new HttpError(400, `${label} is too short (at least ${minLen} characters).`);
  if (text.length > maxLen) throw new HttpError(400, `${label} is too long (${maxLen} characters max).`);
  return text;
}

function parseClientRequestId(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(text)) throw new HttpError(400, 'clientRequestId is invalid.');
  return text;
}

// The referral must come from one of THIS pediatrician's own check-ups for
// THIS child — a request cannot point it at another patient or at another
// pediatrician's record by changing an id.
async function resolveSourceCheckup(rawCheckupId, child, pediatricianId) {
  const id = String(rawCheckupId ?? '').trim();
  if (!id) throw new HttpError(400, 'Choose the check-up this referral is based on.');
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, 'sourceCheckupId is not a valid id.');
  const checkup = await PediatricianCheckup.findOne({ _id: id, childId: child._id }).lean();
  if (!checkup) throw new HttpError(400, 'The selected check-up does not belong to this child.');
  if (String(checkup.pediatricianId) !== String(pediatricianId)) {
    throw new HttpError(403, 'You can only refer from your own check-up records.');
  }
  return checkup;
}

async function notifyParentOfReferral(child, doc) {
  if (!child?.parentId) return;
  try {
    const childName = [child.firstName, child.lastName].filter(Boolean).join(' ').trim() || 'your child';
    await Notification.create({
      userId: child.parentId,
      title: 'Specialist referral recommended',
      message: `Your pediatrician recommended that ${childName} be evaluated by a specialist (${doc.specialty}). `
        + 'This is a recommendation only — no appointment has been booked. Please contact a specialist to arrange the evaluation.',
      type: 'referral',
      relatedPage: `/parent/reports.html?childId=${String(child._id)}`,
      isRead: false,
    });
  } catch (err) {
    console.warn('referral notification create failed:', err.message);
  }
}

// Returns { referral, duplicate }. A resubmission carrying the same
// clientRequestId returns the referral already saved (duplicate: true).
async function createReferralRecord(childId, user, body) {
  if (user.role !== 'pediatrician') throw new HttpError(403, 'Pediatricians only.');

  const { child, canWrite } = await loadChildAndAccess(childId, user);
  if (!canWrite) {
    throw new HttpError(403, 'You are not linked to this patient — only a pediatrician with an appointment for this child may record a referral.');
  }

  const specialty = requiredText(body.specialty, 3, 200, 'Recommended specialty', 'Recommended specialty is required.');
  const reason = requiredText(body.reason, 10, 2000, 'Reason for referral', 'Reason for referral is required.');
  const specialistName = optionalText(body.specialistName, 200, 'Specialist name');
  const specialistContact = optionalText(body.specialistContact, 300, 'Specialist contact details');
  const clientRequestId = parseClientRequestId(body.clientRequestId);

  const findPrevious = async () => {
    if (!clientRequestId) return null;
    const existing = await SpecialistReferral.findOne({ pediatricianId: user.userId, clientRequestId }).lean();
    if (existing && String(existing.childId) !== String(child._id)) {
      throw new HttpError(409, 'This request was already used for a different referral.');
    }
    return existing;
  };

  const previous = await findPrevious();
  if (previous) return { referral: previous, duplicate: true };

  const source = await resolveSourceCheckup(body.sourceCheckupId, child, user.userId);

  let created;
  try {
    created = await SpecialistReferral.create({
      childId: child._id,
      pediatricianId: user.userId,
      sourceCheckupId: source._id,
      assessmentId: source.assessmentId || null,
      specialty,
      specialistName,
      specialistContact,
      reason,
      referredAt: new Date(),
      clientRequestId,
    });
  } catch (err) {
    // Two identical submissions raced past findPrevious(): the unique index
    // kept only one, so hand that one back.
    if (err && err.code === 11000) {
      const raced = await findPrevious();
      if (raced) return { referral: raced, duplicate: true };
    }
    throw err;
  }

  await AuditLog.create({
    actorId: user.userId,
    action: 'specialist_referral_created',
    targetType: 'SpecialistReferral',
    targetId: created._id,
    details: { childId: String(child._id), sourceCheckupId: String(source._id), specialty },
  });

  await notifyParentOfReferral(child, created);

  return { referral: created, duplicate: false };
}

// Same visibility as the check-up list: parent owner, guardians granted
// 'viewMedicalRecords' and admins see every referral for the child; a
// pediatrician sees only the referrals they made.
async function listReferralsForChild(childId, user) {
  const { child, canRead } = await loadChildAndAccess(childId, user);
  if (!canRead) throw new HttpError(403, 'Access denied.');

  const filter = { childId: child._id };
  if (user.role === 'pediatrician') filter.pediatricianId = user.userId;

  return SpecialistReferral.find(filter)
    .populate('pediatricianId', 'firstName lastName')
    .sort({ referredAt: -1, createdAt: -1 })
    .lean();
}

// ── Response shaping ─────────────────────────────────────────────────────
function shapeReferral(doc) {
  const pedia = doc.pediatricianId;
  const pediaPopulated = Boolean(pedia) && typeof pedia === 'object' && pedia.firstName !== undefined;
  return {
    id: String(doc._id),
    childId: String(doc.childId),
    pediatricianId: pediaPopulated ? String(pedia._id) : String(pedia),
    pediatricianName: pediaPopulated ? formatPersonName(pedia, 'Pediatrician') : null,
    sourceCheckupId: doc.sourceCheckupId ? String(doc.sourceCheckupId) : null,
    assessmentId: doc.assessmentId ? String(doc.assessmentId) : null,
    specialty: doc.specialty,
    specialistName: doc.specialistName || null,
    specialistContact: doc.specialistContact || null,
    reason: doc.reason,
    referredAt: doc.referredAt || doc.createdAt,
    createdAt: doc.createdAt,
  };
}

function shapeCheckup(doc) {
  const pedia = doc.pediatricianId;
  const pediaPopulated = Boolean(pedia) && typeof pedia === 'object' && pedia.firstName !== undefined;
  return {
    id: String(doc._id),
    childId: String(doc.childId),
    pediatricianId: pediaPopulated ? String(pedia._id) : String(pedia),
    pediatricianName: pediaPopulated ? formatPersonName(pedia, 'Pediatrician') : null,
    appointmentId: doc.appointmentId ?? null,
    assessmentId: doc.assessmentId ? String(doc.assessmentId) : null,
    checkupDate: doc.checkupDate,
    visitType: doc.visitType,
    diagnosis: doc.diagnosis || null,
    findings: doc.findings || null,
    recommendations: doc.recommendations || null,
    nextFollowUpDate: doc.nextFollowUpDate || null,
    nextFollowUpReason: doc.nextFollowUpReason || null,
    status: doc.status,
    previousRecordId: doc.previousRecordId ? String(doc.previousRecordId) : null,
    editedAt: doc.editedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────

// GET /api/checkups/child/:childId
// Chronological check-up/medical history for one child, newest first.
router.get('/child/:childId', authMiddleware, async (req, res) => {
  try {
    const records = await listCheckupsForChild(req.params.childId, req.user);
    // Referrals are an extra field; if they cannot be read the check-up
    // history still loads, and referralsError tells the page why.
    let referrals = [];
    let referralsError = null;
    try {
      referrals = (await listReferralsForChild(req.params.childId, req.user)).map(shapeReferral);
    } catch (err) {
      console.error('referrals list error:', err);
      referralsError = 'Referrals could not be loaded.';
    }
    res.json({ success: true, checkups: records.map(shapeCheckup), referrals, referralsError });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('checkups list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checkups/child/:childId
// Records a NEW check-up. Never overwrites an existing record.
router.post('/child/:childId', authMiddleware, async (req, res) => {
  try {
    const created = await createCheckupRecord(req.params.childId, req.user, req.body || {});
    res.status(201).json({ success: true, checkup: shapeCheckup(created) });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('checkups create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checkups/child/:childId/referrals
// "Refer to a Specialist" — records a NEW referral linked to one of the
// pediatrician's check-ups. Must stay above the /:checkupId routes.
router.post('/child/:childId/referrals', authMiddleware, async (req, res) => {
  try {
    const { referral, duplicate } = await createReferralRecord(req.params.childId, req.user, req.body || {});
    res.status(duplicate ? 200 : 201).json({ success: true, duplicate, referral: shapeReferral(referral) });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('referral create error:', err);
    res.status(500).json({ error: 'The referral could not be saved. Please try again.' });
  }
});

// GET /api/checkups/child/:childId/:checkupId
router.get('/child/:childId/:checkupId', authMiddleware, async (req, res) => {
  try {
    const record = await getCheckupRecord(req.params.childId, req.params.checkupId, req.user);
    res.json({ success: true, checkup: shapeCheckup(record) });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('checkups get error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/checkups/child/:childId/:checkupId
// Controlled edit of ONE historical record (e.g. correcting a typo).
// Preserves createdAt; does not create a new record and does not touch any
// other record in the child's history.
router.patch('/child/:childId/:checkupId', authMiddleware, async (req, res) => {
  try {
    const record = await updateCheckupRecord(req.params.childId, req.params.checkupId, req.user, req.body || {});
    res.json({ success: true, checkup: shapeCheckup(record) });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('checkups update error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Exposed for tests only (see tests/unit/pediatrician-checkups.test.js).
router.__testables = {
  HttpError,
  loadChildAndAccess,
  createCheckupRecord,
  listCheckupsForChild,
  getCheckupRecord,
  updateCheckupRecord,
  resolveAppointmentRef,
  resolveAssessmentRef,
  resolvePreviousRecordRef,
  parseCheckupDate,
  parseFollowUpDate,
  isRetainedFollowUpDate,
  validateVisitType,
  validateStatus,
  validateDiagnosisText,
  shapeCheckup,
  createReferralRecord,
  listReferralsForChild,
  resolveSourceCheckup,
  shapeReferral,
};
