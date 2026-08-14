// routes/secretary.js
// ─────────────────────────────────────────────────────────────────────────────
// Purpose:
//   This file handles all "Clinic Assistant/Secretary" account logic in KinderCura.
//
//   NEW FLOW (per panelist recommendation):
//   - The PEDIATRICIAN creates and manages their own secretary directly
//     from their Settings page ("Staff Access" tab).
//   - The admin can still VIEW secretaries in the user list for auditing,
//     but CANNOT create or link them.
//   - A pediatrician can only see and manage secretaries linked to themselves.
//   - Each secretary is always linked to exactly one pediatrician.
//
// Endpoints:
//   GET  /api/secretary/me                — secretary: get own profile + linked pedia
//   GET  /api/secretary/my-staff          — pediatrician: list own secretaries
//   POST /api/secretary/create            — pediatrician: create a new secretary
//   PUT  /api/secretary/:id/permissions   — pediatrician: update secretary permissions
//   PUT  /api/secretary/:id/deactivate    — pediatrician: deactivate a secretary
//   GET  /api/secretary/list              — admin only: see all secretaries (audit)
//   GET  /api/secretary/pediatricians     — admin only: pediatrician options for linking
//   PUT  /api/secretary/:id/link          — admin only: re-assign or unlink a secretary
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const bcrypt   = require('bcrypt');
const mongoose = require('mongoose');
const router   = express.Router();

const { authMiddleware, adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const sse = require('../sse');

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

// publicSecretaryProfile — the shape sent back to the secretary's own
// dashboard pages. It includes the linked pediatrician's info so the
// "On behalf of Dr. X" banner and role badge render correctly.
function publicSecretaryProfile(secretary, linkedPediatricianDoc = null) {
  return {
    id: String(secretary._id),
    firstName: secretary.firstName,
    middleName: secretary.middleName || null,
    lastName: secretary.lastName,
    username: secretary.username,
    email: secretary.email,
    role: secretary.role,           // always 'secretary'
    status: secretary.status,
    profileIcon: secretary.profileIcon || 'avatar1',
    // Permissions granted by the pediatrician (stored in the User document).
    permissions: secretary.secretaryPermissions || defaultPermissions(),
    linkedPediatricianId: secretary.linkedPediatricianId
      ? String(secretary.linkedPediatricianId)
      : null,
    linkedPediatrician: linkedPediatricianDoc
      ? {
          id:             String(linkedPediatricianDoc._id),
          firstName:      linkedPediatricianDoc.firstName,
          lastName:       linkedPediatricianDoc.lastName,
          clinicName:     linkedPediatricianDoc.clinicName || linkedPediatricianDoc.institution || null,
          clinicAddress:  linkedPediatricianDoc.clinicAddress || null,
          specialization: linkedPediatricianDoc.specialization || null,
        }
      : null,
  };
}

// defaultPermissions — what a newly created secretary can do by default.
// The pediatrician can turn individual permissions on/off from Settings.
function defaultPermissions() {
  return {
    viewAppointments:    true,   // can see the appointment list
    manageBookings:      true,   // can approve / reject booking requests
    rescheduleRequests:  true,   // can propose new dates/times
    approveSchedules:    true,   // can mark approved appointments as confirmed
    managePayments:      false,  // can confirm cash/POS payments — must be explicitly enabled
  };
}

function fullName(firstName, lastName, fallback = '') {
  const name = `${firstName || ''} ${lastName || ''}`.trim();
  return name || fallback;
}

function appointmentTimeValue(appt) {
  const d = appt?.appointmentDate ? new Date(appt.appointmentDate) : null;
  const dateValue = d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  const time = String(appt?.appointmentTime || '00:00');
  const [rawH, rawM] = time.split(':');
  const h = Number.parseInt(rawH, 10);
  const m = Number.parseInt(rawM || '0', 10);
  return dateValue + ((Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)) * 60000;
}

function publicAppointmentForSecretary(appt, child = null, parent = null) {
  return {
    id: appt.id,
    appointmentId: appt.id,
    status: appt.status,
    appointmentDate: appt.appointmentDate,
    appointmentTime: appt.appointmentTime,
    reason: appt.reason || null,
    notes: appt.notes || null,
    location: appt.location || null,
    createdAt: appt.createdAt,
    updatedAt: appt.updatedAt,
    childId: child ? String(child._id) : (appt.childId ? String(appt.childId) : null),
    childFirstName: child?.firstName || '',
    childLastName: child?.lastName || '',
    childName: child ? fullName(child.firstName, child.lastName, 'Unknown Child') : 'Unknown Child',
    childDateOfBirth: child?.dateOfBirth || null,
    childGender: child?.gender || null,
    childProfileIcon: child?.profileIcon || null,
    parentId: parent ? String(parent._id) : (appt.parentId ? String(appt.parentId) : null),
    parentFirstName: parent?.firstName || '',
    parentLastName: parent?.lastName || '',
    parentName: parent ? fullName(parent.firstName, parent.lastName, 'Unknown Parent') : 'Unknown Parent',
    parentEmail: parent?.email || '',
    parentPhoneNumber: parent?.phoneNumber || '',
  };
}

async function getSecretaryContext(req, res, requiredPermission = 'viewAppointments') {
  if (req.user.role !== 'secretary') {
    res.status(403).json({ error: 'Assistant/Secretary accounts only.' });
    return null;
  }

  const secretary = await User.findById(req.user.userId)
    .select('firstName lastName role status linkedPediatricianId secretaryPermissions')
    .lean();

  if (!secretary || secretary.role !== 'secretary') {
    res.status(404).json({ error: 'Secretary account not found.' });
    return null;
  }
  if (secretary.status !== 'active') {
    res.status(403).json({ error: 'Secretary account is not active.' });
    return null;
  }
  if (!secretary.linkedPediatricianId) {
    res.status(403).json({ error: 'Assistant/Secretary account is not linked to a pediatrician yet.' });
    return null;
  }

  const permissions = {
    ...defaultPermissions(),
    ...(secretary.secretaryPermissions || {}),
  };
  if (requiredPermission && !permissions[requiredPermission]) {
    res.status(403).json({ error: 'You do not have permission to view this scheduling area.' });
    return null;
  }

  return {
    secretary,
    permissions,
    pediatricianId: secretary.linkedPediatricianId,
  };
}

// ─── GET /api/secretary/me ────────────────────────────────────────────────────
// Returns the logged-in secretary's profile including linked pediatrician data.
// Called on both the secretary dashboard and appointments page load.
router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Guard: only secretary accounts may call this endpoint.
    if (req.user.role !== 'secretary') {
      return res.status(403).json({ error: 'Assistant/Secretary accounts only..' });
    }

    const secretary = await User.findById(req.user.userId).lean();
    if (!secretary) {
      return res.status(404).json({ error: 'Secretary account not found.' });
    }

    // Load the linked pediatrician if one is set.
    let linkedPediatrician = null;
    if (secretary.linkedPediatricianId) {
      linkedPediatrician = await User.findById(secretary.linkedPediatricianId)
        .select('firstName lastName clinicName clinicAddress institution specialization')
        .lean();
    }

    res.json({
      success: true,
      secretary: publicSecretaryProfile(secretary, linkedPediatrician),
    });
  } catch (err) {
    console.error('secretary /me error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Secretary scheduling views.
// GET /api/secretary/patients
// Returns patients who have appointment records with the secretary's linked pediatrician.
router.get('/patients', authMiddleware, async (req, res) => {
  try {
    const context = await getSecretaryContext(req, res, 'viewAppointments');
    if (!context) return;

    const appointments = await Appointment.find({ pediatricianId: context.pediatricianId })
      .sort({ appointmentDate: -1, createdAt: -1 })
      .lean();

    const latestByChild = new Map();
    const completedByChild = new Map();
    const countsByChild = new Map();

    for (const appt of appointments) {
      const childKey = String(appt.childId || '');
      if (!childKey) continue;

      countsByChild.set(childKey, (countsByChild.get(childKey) || 0) + 1);

      const currentLatest = latestByChild.get(childKey);
      if (!currentLatest || appointmentTimeValue(appt) > appointmentTimeValue(currentLatest)) {
        latestByChild.set(childKey, appt);
      }

      if (appt.status === 'completed') {
        const currentCompleted = completedByChild.get(childKey);
        if (!currentCompleted || appointmentTimeValue(appt) > appointmentTimeValue(currentCompleted)) {
          completedByChild.set(childKey, appt);
        }
      }
    }

    const childIds = Array.from(latestByChild.keys());
    const parentIds = Array.from(new Set(
      Array.from(latestByChild.values()).map((appt) => String(appt.parentId || '')).filter(Boolean)
    ));

    const [children, parents] = await Promise.all([
      childIds.length ? Child.find({ _id: { $in: childIds } }).lean() : [],
      parentIds.length
        ? User.find({ _id: { $in: parentIds } })
            .select('firstName lastName email phoneNumber profileIcon')
            .lean()
        : [],
    ]);

    const childMap = new Map(children.map((child) => [String(child._id), child]));
    const parentMap = new Map(parents.map((parent) => [String(parent._id), parent]));

    const patients = Array.from(latestByChild.values())
      .map((appt) => {
        const child = childMap.get(String(appt.childId));
        const parent = parentMap.get(String(appt.parentId));
        const lastVisit = completedByChild.get(String(appt.childId)) || null;
        return {
          ...publicAppointmentForSecretary(appt, child, parent),
          latestAppointmentId: appt.id,
          latestAppointmentStatus: appt.status,
          latestAppointmentDate: appt.appointmentDate,
          latestAppointmentTime: appt.appointmentTime,
          lastVisitDate: lastVisit?.appointmentDate || null,
          lastVisitTime: lastVisit?.appointmentTime || null,
          appointmentCount: countsByChild.get(String(appt.childId)) || 1,
        };
      })
      .sort((a, b) => appointmentTimeValue({
        appointmentDate: b.latestAppointmentDate,
        appointmentTime: b.latestAppointmentTime,
      }) - appointmentTimeValue({
        appointmentDate: a.latestAppointmentDate,
        appointmentTime: a.latestAppointmentTime,
      }));

    res.json({
      success: true,
      patients,
      permissions: context.permissions,
    });
  } catch (err) {
    console.error('secretary /patients error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/secretary/approvals
// Returns pending appointment requests for the linked pediatrician.
router.get('/approvals', authMiddleware, async (req, res) => {
  try {
    const context = await getSecretaryContext(req, res, 'viewAppointments');
    if (!context) return;

    const appointments = await Appointment.find({
      pediatricianId: context.pediatricianId,
      status: 'pending',
    })
      .sort({ appointmentDate: 1, appointmentTime: 1, createdAt: 1 })
      .lean();

    const childIds = Array.from(new Set(appointments.map((appt) => String(appt.childId || '')).filter(Boolean)));
    const parentIds = Array.from(new Set(appointments.map((appt) => String(appt.parentId || '')).filter(Boolean)));

    const [children, parents] = await Promise.all([
      childIds.length ? Child.find({ _id: { $in: childIds } }).lean() : [],
      parentIds.length
        ? User.find({ _id: { $in: parentIds } })
            .select('firstName lastName email phoneNumber profileIcon')
            .lean()
        : [],
    ]);

    const childMap = new Map(children.map((child) => [String(child._id), child]));
    const parentMap = new Map(parents.map((parent) => [String(parent._id), parent]));

    res.json({
      success: true,
      approvals: appointments.map((appt) => publicAppointmentForSecretary(
        appt,
        childMap.get(String(appt.childId)),
        parentMap.get(String(appt.parentId))
      )),
      permissions: context.permissions,
    });
  } catch (err) {
    console.error('secretary /approvals error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/secretary/my-staff  (pediatrician only)
// Returns all secretary accounts linked to the currently logged-in pediatrician.
// Used by the Pediatrician's Settings > "Staff Access" tab.
router.get('/my-staff', authMiddleware, async (req, res) => {
  try {
    // Guard: only a pediatrician can see their own staff list.
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    // Find all secretaries whose linkedPediatricianId points to this pedia.
    const secretaries = await User.find({
      role: 'secretary',
      linkedPediatricianId: req.user.userId,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      staff: secretaries.map((s) => ({
        id:          String(s._id),
        firstName:   s.firstName,
        lastName:    s.lastName,
        email:       s.email,
        username:    s.username,
        status:      s.status,
        permissions: s.secretaryPermissions || defaultPermissions(),
        createdAt:   s.createdAt,
      })),
    });
  } catch (err) {
    console.error('secretary /my-staff error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/secretary/create  (pediatrician only) ─────────────────────────
// Important: The pediatrician creates the secretary account directly.
// The newly created secretary is automatically linked to the creating pediatrician.
// No admin involvement is needed for creation.
router.post('/create', authMiddleware, async (req, res) => {
  try {
    // Guard: only a pediatrician may create a secretary account.
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Only a pediatrician can create an assistant/secretary account.' });
    }

    const { firstName, lastName, middleName, username, email, password } = req.body;

    // Validate all required fields are present.
    if (!firstName || !lastName || !username || !email || !password) {
      return res.status(400).json({
        error: 'First name, last name, username, email, and password are all required.',
      });
    }
    if (!isValidEmail(String(email).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const cleanEmail    = String(email).trim().toLowerCase();
    const cleanUsername = String(username).trim();

    // Reject duplicate email or username across all user roles.
    const existing = await User.findOne({
      $or: [{ email: cleanEmail }, { username: cleanUsername }],
    }).select('_id').lean();
    if (existing) {
      return res.status(409).json({ error: 'Email or username is already in use.' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    // Important: The secretary is immediately linked to the creating pediatrician.
    // linkedPediatricianId ensures all appointment queries are scoped correctly.
    const secretary = await User.create({
      firstName:             String(firstName).trim(),
      middleName:            middleName ? String(middleName).trim() : null,
      lastName:              String(lastName).trim(),
      username:              cleanUsername,
      email:                 cleanEmail,
      passwordHash,
      role:                  'secretary',
      status:                'active',          // active immediately; pedia has verified them
      emailVerified:         true,
      linkedPediatricianId:  req.user.userId,   // auto-link to the creating pediatrician
      secretaryPermissions:  defaultPermissions(), // default full scheduling permissions
    });

    sse.broadcast('analytics:update', { type: 'user', action: 'create', role: 'secretary' });

    res.status(201).json({
      success: true,
      message: `Assistant/Assistant/Secretary account created for ${secretary.firstName} ${secretary.lastName}. They can now log in with the credentials you provided.`,
      secretaryId: String(secretary._id),
    });
  } catch (err) {
    console.error('secretary /create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/secretary/:id/permissions  (pediatrician only) ─────────────────
// Allows the pediatrician to update which scheduling actions their secretary
// is permitted to perform. Medical decisions are never included here.
router.put('/:id/permissions', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    // Important: only allow editing secretaries that belong to THIS pediatrician.
    const secretary = await User.findOne({
      _id: req.params.id,
      role: 'secretary',
      linkedPediatricianId: req.user.userId,
    });
    if (!secretary) {
      return res.status(404).json({ error: 'Assistant/Secretary not found or not linked to your account.' });
    }

    const {
      viewAppointments,
      manageBookings,
      rescheduleRequests,
      approveSchedules,
      managePayments,
    } = req.body;

    // Merge incoming permissions with existing ones; only update fields that were sent.
    const current = secretary.secretaryPermissions || defaultPermissions();
    secretary.secretaryPermissions = {
      viewAppointments:   viewAppointments   !== undefined ? Boolean(viewAppointments)   : current.viewAppointments,
      manageBookings:     manageBookings     !== undefined ? Boolean(manageBookings)     : current.manageBookings,
      rescheduleRequests: rescheduleRequests !== undefined ? Boolean(rescheduleRequests) : current.rescheduleRequests,
      approveSchedules:   approveSchedules   !== undefined ? Boolean(approveSchedules)   : current.approveSchedules,
      managePayments:     managePayments     !== undefined ? Boolean(managePayments)     : current.managePayments,
    };
    await secretary.save();

    res.json({
      success: true,
      message: `Permissions updated for ${secretary.firstName} ${secretary.lastName}.`,
      permissions: secretary.secretaryPermissions,
    });
  } catch (err) {
    console.error('secretary /permissions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/secretary/:id/deactivate  (pediatrician only) ──────────────────
// Allows the pediatrician to deactivate (or re-activate) their secretary
// without deleting the account.
router.put('/:id/deactivate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    // Guard: pedia can only deactivate their own staff.
    const secretary = await User.findOne({
      _id: req.params.id,
      role: 'secretary',
      linkedPediatricianId: req.user.userId,
    });
    if (!secretary) {
      return res.status(404).json({ error: 'Assistant/Secretary not found or not linked to your account.' });
    }

    // Toggle: if already suspended, re-activate; otherwise suspend.
    secretary.status = secretary.status === 'suspended' ? 'active' : 'suspended';
    await secretary.save();

    const action = secretary.status === 'active' ? 'reactivated' : 'deactivated';
    res.json({
      success: true,
      message: `${secretary.firstName} ${secretary.lastName} has been ${action}.`,
      status: secretary.status,
    });
  } catch (err) {
    console.error('secretary /deactivate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/secretary/list  (admin only — audit view) ──────────────────────
// The admin can VIEW all secretary accounts for auditing purposes.
// The admin cannot create or modify secretaries; that is the pediatrician's role.
router.get('/list', authMiddleware, adminOnly, async (req, res) => {
  try {
    const secretaries = await User.find({ role: 'secretary' })
      .sort({ createdAt: -1 })
      .lean();

    // Fetch linked pediatrician names in a single query for efficiency.
    const pedIds = secretaries
      .filter((s) => s.linkedPediatricianId)
      .map((s) => s.linkedPediatricianId);

    const pediatricians = pedIds.length
      ? await User.find({ _id: { $in: pedIds } })
          .select('firstName lastName clinicName institution')
          .lean()
      : [];

    const pedMap = new Map(pediatricians.map((p) => [String(p._id), p]));

    res.json({
      success: true,
      secretaries: secretaries.map((s) => {
        const ped = s.linkedPediatricianId ? pedMap.get(String(s.linkedPediatricianId)) : null;
        return {
          id:                    String(s._id),
          firstName:             s.firstName,
          lastName:              s.lastName,
          username:              s.username,
          email:                 s.email,
          status:                s.status,
          createdAt:             s.createdAt,
          linkedPediatricianId:  s.linkedPediatricianId ? String(s.linkedPediatricianId) : null,
          // The pedia name so admin can see who each secretary belongs to.
          linkedPediatricianName: ped ? `Dr. ${ped.firstName} ${ped.lastName}` : 'Not linked',
        };
      }),
    });
  } catch (err) {
    console.error('secretary /list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/secretary/pediatricians  (admin only) ──────────────────────────
// Populates the "link to pediatrician" dropdowns on the admin Users page.
// js/admin/admin-users.js has always called this endpoint; it simply did not
// exist, so the dropdowns rendered with "Unlink" as their only option. The
// missing 404 was invisible because server.js's catch-all answered 200 + HTML.
// Shape matches what admin-users.js already reads: { id, name, clinic }.
router.get('/pediatricians', authMiddleware, adminOnly, async (req, res) => {
  try {
    const pediatricians = await User.find({ role: 'pediatrician' })
      .select('firstName lastName clinicName institution')
      .sort({ lastName: 1, firstName: 1 })
      .lean();

    res.json({
      success: true,
      pediatricians: pediatricians.map((p) => ({
        id: String(p._id),
        name: `Dr. ${p.firstName} ${p.lastName}`.trim(),
        clinic: p.clinicName || p.institution || 'No clinic on file',
      })),
    });
  } catch (err) {
    console.error('secretary /pediatricians error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/secretary/:id/link  (admin only) ───────────────────────────────
// Re-assigns a secretary to a pediatrician, or unlinks them when the body
// carries a null/empty linkedPediatricianId. Counterpart to the "Update Link"
// button in js/admin/admin-users.js, which previously always 404'd.
router.put('/:id/link', authMiddleware, adminOnly, async (req, res) => {
  try {
    const secretary = await User.findById(req.params.id);
    if (!secretary || secretary.role !== 'secretary') {
      return res.status(404).json({ error: 'Secretary not found.' });
    }

    const raw = req.body?.linkedPediatricianId;
    const wanted = raw == null || String(raw).trim() === '' ? null : String(raw).trim();

    if (wanted) {
      if (!mongoose.Types.ObjectId.isValid(wanted)) {
        return res.status(400).json({ error: 'linkedPediatricianId is not a valid id.' });
      }
      // Only ever link to a real pediatrician — a dangling link would break
      // every "on behalf of Dr. X" view the secretary pages render.
      const pediatrician = await User.findById(wanted).select('role firstName lastName').lean();
      if (!pediatrician || pediatrician.role !== 'pediatrician') {
        return res.status(400).json({ error: 'That user is not a pediatrician.' });
      }
      secretary.linkedPediatricianId = pediatrician._id;
      await secretary.save();
      return res.json({
        success: true,
        message: `Linked to Dr. ${pediatrician.firstName} ${pediatrician.lastName}.`,
        linkedPediatricianId: String(pediatrician._id),
      });
    }

    secretary.linkedPediatricianId = null;
    await secretary.save();
    res.json({ success: true, message: 'Secretary unlinked.', linkedPediatricianId: null });
  } catch (err) {
    console.error('secretary /:id/link error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
