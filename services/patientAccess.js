// services/patientAccess.js
//
// "Is this child my patient?" for a pediatrician. The link is an appointment
// (there is no separate assignment collection), but only a LIVE one counts:
// a pending request being reviewed, an approved booking, or a completed visit.
// A cancelled or rejected booking ends the relationship, so it no longer opens
// the child's scores, answers, parent e-mail or diagnosis, and no longer lets
// the pediatrician write to the record.
//
// These are the same three statuses routes/custom-questions.js
// ensurePediaChildRelationship() and services/pediatricianAssignmentGuard.js
// already use for their "active link" test; the record routes used to check
// only that SOME appointment existed, whatever its status.
//
// Pending is included on purpose: the dashboard loads a child's assessment
// history to show scores on a request that has not been answered yet.
const Appointment = require('../models/Appointment');

const ACCESS_APPOINTMENT_STATUSES = Object.freeze(['pending', 'approved', 'completed']);

function patientAccessFilter(pediatricianId, childId = null) {
  const filter = { pediatricianId, status: { $in: ACCESS_APPOINTMENT_STATUSES } };
  if (childId != null) filter.childId = childId;
  return filter;
}

async function pediatricianHasPatient(pediatricianId, childId) {
  return Boolean(await Appointment.exists(patientAccessFilter(pediatricianId, childId)));
}

// The pediatrician's most recent appointment that grants access to this child
// (null when there is none). Used where a record is attached to a visit.
function findLinkedAppointment(pediatricianId, childId) {
  return Appointment.findOne(patientAccessFilter(pediatricianId, childId))
    .sort({ appointmentDate: -1, createdAt: -1 })
    .lean();
}

module.exports = { ACCESS_APPOINTMENT_STATUSES, patientAccessFilter, pediatricianHasPatient, findLinkedAppointment };
