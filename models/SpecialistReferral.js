// SpecialistReferral model
// ============================================================================
// "Refer to a Specialist": a pediatrician's recorded RECOMMENDATION that the
// child be evaluated by a specialist outside KinderCura. The parent or guardian
// finds and contacts that specialist themselves.
//
// A referral is an ADDITIONAL history entry. Creating one never edits, moves
// or deletes anything else:
//   - the source check-up (PediatricianCheckup) keeps its diagnosis, status,
//     dates and its original pediatricianId — nothing is copied into it;
//   - no Appointment, User/specialist account or completed consultation is
//     created, and the child is not reassigned to another pediatrician;
//   - there is no update or delete route, so a saved referral stays as written.
//
// Links point back to the record the decision was based on: sourceCheckupId
// (the visit) and, when that visit was tied to a screening session, the same
// assessmentId — referenced by id, never duplicated as text.
const mongoose = require('mongoose');

const specialistReferralSchema = new mongoose.Schema(
  {
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },

    // The referring pediatrician (the one who recorded the source check-up).
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    sourceCheckupId: { type: mongoose.Schema.Types.ObjectId, ref: 'PediatricianCheckup', required: true, index: true },
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', default: null },

    // What the pediatrician recommends. Specialty is required because the exact
    // specialist is often not known; name and contact are recorded only when
    // the pediatrician actually provides them.
    specialty: { type: String, required: true, trim: true },
    specialistName: { type: String, default: null, trim: true },
    specialistContact: { type: String, default: null, trim: true },
    reason: { type: String, required: true, trim: true },

    referredAt: { type: Date, required: true, default: Date.now, index: true },

    // Sent by the form once per submission, so a resubmitted request returns
    // the referral that was already saved instead of creating a second one.
    clientRequestId: { type: String, default: null, trim: true },
  },
  { timestamps: true, collection: 'specialist_referrals' }
);

specialistReferralSchema.index(
  { pediatricianId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } }
);

module.exports = mongoose.models.SpecialistReferral || mongoose.model('SpecialistReferral', specialistReferralSchema);
