const GuardianLink = require('../models/GuardianLink');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');

async function resolveChildIdFromReq(req) {
  // Explicit parameter
  const candidate = req.params.childId || req.body.childId || req.query.childId || null;
  if (candidate) return candidate;

  // Derive from appointmentId when present
  const apptId = req.params.appointmentId || req.body.appointmentId || req.query.appointmentId;
  if (apptId) {
    const appt = await Appointment.findOne({ id: Number(apptId) }).lean();
    if (appt) return appt.childId;
  }

  return null;
}

// permissionKey is a logical string like 'view_assessments' or 'view_messages'
function hasPermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const childId = await resolveChildIdFromReq(req);
      if (!childId) return res.status(400).json({ error: 'childId required for guardian permission check.' });

      // Admin bypass
      if (req.user && req.user.role === 'admin') return next();

      // Pediatrician bypass — real appointment-level auth happens in resolveChatAccess
      if (req.user && req.user.role === 'pediatrician') return next();

      const child = await Child.findById(childId).lean();
      if (!child) return res.status(404).json({ error: 'Child not found.' });

      // Parent (primary account owner) bypass
      if (String(child.parentId) === String(req.user.userId)) return next();

      const link = await GuardianLink.findOne({ childId: child._id, guardianId: req.user.userId, status: 'active' }).lean();
      if (!link) return res.status(403).json({ error: 'Access denied.' });

      const map = {
        view_assessments: 'viewAssessments',
        submit_assessments: 'submitAssessments',
        view_results: 'viewResults',
        upload_documents: 'uploadDocuments',
        manage_appointments: 'manageAppointments',
        view_medical_records: 'viewMedicalRecords',
        modify_child: 'modifyChild',
        invite_guardians: 'inviteGuardians',
        revoke_access: 'revokeAccess',
        view_messages: 'viewMessages',
        send_messages: 'sendMessages',
        manage_messages: 'manageMessages',
        view_notifications: 'viewNotifications',
        send_notifications: 'sendNotifications',
        manage_notifications: 'manageNotifications',
      };

      const prop = map[permissionKey] || permissionKey;
      const val = link.permissions ? link.permissions[prop] : undefined;

      // For string-based permissions like viewMedicalRecords allow 'partial' or 'full'
      if (typeof val === 'string') {
        if (val === 'partial' || val === 'full') return next();
      }

      if (val === true) return next();

      return res.status(403).json({ error: 'Permission denied.' });
    } catch (err) {
      console.error('guardianPermission.hasPermission error:', err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
  };
}

module.exports = { hasPermission };
