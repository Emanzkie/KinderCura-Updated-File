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
    // This is the ONLY field that can ever serve as ground truth for
    // validating the SCORING system's clinical judgement. A screening
    // counts as labelled training data when, and only when, this is non-null.
    // null = not yet reviewed, or reviewed without a conclusion recorded.
    // Never infer a label from `diagnosis` text, and never default this.
    //
    // Step 10: this is a DIFFERENT concept from `mlLabel` below.
    // clinicalOutcome is the pediatrician's actual clinical conclusion (5
    // values, used to validate scoring against clinical judgement). mlLabel
    // is a reviewed Low/Medium/High training TARGET for the ML classifier
    // specifically — the two are never auto-derived from each other, and a
    // screening can have one without the other.
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

    // ── ML training-target review (Step 10) ─────────────────────────────────
    // NOT a diagnosis, NOT the same field as clinicalOutcome above. This is
    // an authorized pediatrician's explicitly reviewed Low/Medium/High
    // training target for ml/trainer.py — the only legitimate source of
    // risk_category for a real (non-synthetic) exported dataset row (see
    // routes/admin.js GET /training/reviewed-assessments/export). The
    // system NEVER writes this field itself from scores, ML predictions, or
    // recommendation output — see routes/assessments.js POST
    // /:assessmentId/ml-label, the only writer.
    //
    // null = not reviewed. Reviewing again overwrites this with the latest
    // label (mlReviewStatus stays 'reviewed'); the previous value is not
    // lost — see AuditLog action 'ml_label_reviewed', written by the same
    // route on every save.
    mlLabel: {
      type: new mongoose.Schema(
        {
          riskCategory: { type: String, enum: ['Low', 'Medium', 'High'], required: true },
          reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          reviewedAt: { type: Date, required: true },
          reviewSource: { type: String, enum: ['pediatrician'], default: 'pediatrician' },
          notes: { type: String, default: null, trim: true },
        },
        { _id: false }
      ),
      default: null,
    },

    // Dataset-export eligibility state for THIS assessment's mlLabel.
    //   unreviewed -> no reviewed label yet; never exportable.
    //   reviewed   -> mlLabel is set and this assessment IS exportable
    //                 (subject to the export route's other validity checks).
    //   excluded   -> a reviewer explicitly marked this assessment as unfit
    //                 for training data (e.g. poor data quality) — never
    //                 exportable, independent of whether mlLabel is set.
    mlReviewStatus: {
      type: String,
      enum: ['unreviewed', 'reviewed', 'excluded'],
      default: 'unreviewed',
      index: true,
    },
  },
  { timestamps: true, collection: 'assessments' }
);

module.exports = mongoose.models.Assessment || mongoose.model('Assessment', assessmentSchema);
