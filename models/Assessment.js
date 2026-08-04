// Assessment model
// One document per screening session.
// Connection note: mongoose model only; DB connection comes from db.js.
const mongoose = require('mongoose');

const assessmentSchema = new mongoose.Schema(
  {
    // Links the assessment to the child being screened.
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },

    // Tracks which parent created the assessment record.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: ['in_progress', 'submitted', 'complete'],
      default: 'in_progress',
      index: true,
    },

    currentProgress: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },

    // Pediatrician-written note shown on the parent Results page.
    // Free text. NOT a clinical outcome label — see clinicalOutcome below.
    diagnosis: { type: String, default: null },

    // ── Clinical outcome label ───────────────────────────────────────────────
    // The structured record of what the reviewing pediatrician actually
    // concluded, kept deliberately separate from the free-text `diagnosis`.
    //
    // Why this exists: `diagnosis` is unconstrained prose. Before this field,
    // the only populated diagnosis in the entire database was the string
    // "Yes please" — which is why the system had zero usable outcome labels
    // and no way to validate its own scoring against clinical judgement.
    //
    // This is the ONLY field that can ever serve as ground truth. A screening
    // counts as labelled training data when, and only when, this is non-null.
    // null = not yet reviewed, or reviewed without a conclusion recorded.
    // Never infer a label from `diagnosis` text, and never default this.
    clinicalOutcome: {
      type: String,
      enum: [
        'typical_development',      // no concern identified
        'monitor',                  // subclinical; re-screen later
        'referred_for_evaluation',  // sent for formal assessment
        'confirmed_delay',          // delay confirmed by the clinician
        'inconclusive',             // reviewed, no conclusion possible
      ],
      default: null,
      index: true,
    },

    // Which domains the outcome concerns. Empty for typical_development.
    clinicalOutcomeDomains: [{
      type: String,
      enum: ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'],
    }],

    clinicalOutcomeBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    clinicalOutcomeAt: { type: Date, default: null },
    recommendations: { type: String, default: null },
    nextAssessmentDate: { type: Date, default: null },
    nextAssessmentReason: { type: String, default: null, trim: true },

    // These two fields are required by the Results page banner.
    // They must exist in the schema so Mongoose will actually persist them.
    reviewedByPediatrician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'assessments' }
);

module.exports = mongoose.models.Assessment || mongoose.model('Assessment', assessmentSchema);
