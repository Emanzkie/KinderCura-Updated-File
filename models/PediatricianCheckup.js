// PediatricianCheckup model
// ============================================================================
// A dedicated, structured longitudinal check-up / medical-history record for
// a child — one document per visit. This is DELIBERATELY separate from
// Assessment (models/Assessment.js):
//
//   - Assessment.diagnosis/recommendations/nextAssessmentDate describe the
//     pediatrician's review of ONE screening session's scores.
//   - PediatricianCheckup describes a CLINICAL VISIT, which may or may not be
//     tied to a screening session at all (a pure follow-up check-up with no
//     new developmental assessment is common and must not be forced into an
//     Assessment document just to have somewhere to live).
//
// Every follow-up creates a NEW document — this model is never overwritten in
// place to reflect "the latest state"; previousRecordId threads the chain so
// the full history stays intact (see routes/checkups.js).
//
// No score fields live here on purpose. Scores remain in AssessmentResult;
// this model only links to an assessment by id when relevant (assessmentId)
// and never recomputes or duplicates a score.
const mongoose = require('mongoose');

// Adviser-specified examples: "Initial Check-up" / "Follow-up Check-up".
const VISIT_TYPES = ['initial_checkup', 'follow_up_checkup'];

// Descriptive record states ONLY — chosen explicitly by the pediatrician on
// the form. Never derived from a score, never a new scoring threshold. See
// the adviser requirement in the task brief: "Do NOT turn them into new
// scoring thresholds. Do NOT derive them automatically from assessment
// scores."
const STATUSES = [
  'initial_review',
  'monitoring',
  'improving',
  'stable',
  'needs_attention',
  'referred',
  'resolved',           // "Resolved / Ruled Out"
  'parent_monitoring',  // "Parent Monitoring"
];

const pediatricianCheckupSchema = new mongoose.Schema(
  {
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Numeric, matching Appointment.id (see models/Appointment.js) — the same
    // convention already used by models/PatientProgressNote.js.appointmentId,
    // not Appointment's Mongo _id.
    appointmentId: { type: Number, default: null, index: true },

    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', default: null, index: true },

    checkupDate: { type: Date, required: true, default: Date.now, index: true },

    visitType: { type: String, enum: VISIT_TYPES, required: true },

    // Free text, validated at the route layer (routes/checkups.js) the same
    // way Assessment.diagnosis is validated in POST /diagnose/:childId — kept
    // permissive here so the schema is not a second source of truth for that
    // rule.
    diagnosis: { type: String, default: null, trim: true },
    findings: { type: String, default: null, trim: true },
    recommendations: { type: String, default: null, trim: true },

    nextFollowUpDate: { type: Date, default: null },
    nextFollowUpReason: { type: String, default: null, trim: true },

    status: { type: String, enum: STATUSES, required: true, default: 'initial_review', index: true },

    // Threads this record to the check-up it follows, so the chain can be
    // walked without relying on date ordering alone. Self-referencing.
    previousRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'PediatricianCheckup', default: null, index: true },

    // Set only when an existing record is corrected via PATCH — createdAt is
    // never touched by that path (see routes/checkups.js updateCheckupRecord).
    editedAt: { type: Date, default: null },
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'pediatrician_checkups' }
);

pediatricianCheckupSchema.statics.VISIT_TYPES = VISIT_TYPES;
pediatricianCheckupSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.PediatricianCheckup || mongoose.model('PediatricianCheckup', pediatricianCheckupSchema);
