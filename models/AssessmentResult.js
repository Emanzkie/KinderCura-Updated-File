// AssessmentResult model
// Stores the calculated scores after a screening is submitted.
// Connection note: this collection is used after screening submission calculates scores.
const mongoose = require('mongoose');

const assessmentResultSchema = new mongoose.Schema(
  {
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', required: true, unique: true, index: true },
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    communicationScore: { type: Number, default: 0 },
    socialScore: { type: Number, default: 0 },
    cognitiveScore: { type: Number, default: 0 },
    motorScore: { type: Number, default: 0 },
    overallScore: { type: Number, default: 0 },
    communicationStatus: { type: String, default: null },
    socialStatus: { type: String, default: null },
    cognitiveStatus: { type: String, default: null },
    motorStatus: { type: String, default: null },
    riskFlags: [{ type: String }],

    // Which band set produced the four *Status values above.
    // 'v2-80/60/40' = scored under constants/scoring.js ACTIVE_BANDS.
    // null          = pre-audit document, scored under the old 51/26 bands.
    // Stamped on write by routes/assessments.js and by
    // scripts/backfill-scoring-bands.js. See constants/scoring.js.
    scoringBandsVersion: { type: String, default: null, index: true },

    // ── Historical prediction snapshot (Step 5, field names updated Step 8) ──
    // The ML-classification/care-plan interpretation attached to THIS
    // assessment at the moment it was completed — written once by
    // routes/assessments.js POST /submit and never overwritten afterward.
    // This is what makes longitudinal comparison
    // (services/assessmentProgress.js) reproducible: a later reassessment,
    // or a newly trained ML model, must never change what an
    // already-completed assessment is reported as having shown.
    //
    // Step 8: THREE SEPARATE CONCEPTS — do not conflate them.
    //   riskCategory = ML classification ('Low'/'Medium'/'High'; the raw
    //     model output). null when source is rule_based (no ML involved).
    //   careStage/careStageLabel/consultationLevel/monitoringLevel = the
    //     CARE-PLAN classification derived from riskCategory (ml) OR from
    //     the developmental band (rule_based) — see
    //     constants/developmental-staging.js CARE_STAGE.*.
    //   developmentalBand (the SCORE classification, on-track/developing/
    //     at-risk/delayed) is DELIBERATELY NOT stored here — it is already
    //     fully derivable from overallScore via scoring.bandFor() /
    //     constants/developmental-staging.js getDevelopmentalBandFromScore(),
    //     so storing it a second time here would be redundant, drifting data.
    //
    // null on documents that predate this field, or predate Step 8's field
    // rename (stage/stageLabel -> careStage/careStageLabel) — see
    // services/assessmentProgress.js getStoredOrDerivedCareStage(), which
    // derives a rule-based-only care stage for them rather than inventing a
    // historical ML result that was never actually produced.
    prediction: {
      type: new mongoose.Schema(
        {
          source: { type: String, enum: ['ml', 'rule_based'], required: true },
          modelVersion: { type: Number, default: null }, // TrainedModel.version; null when source is rule_based
          riskCategory: { type: String, default: null }, // 'Low' | 'Medium' | 'High'; null when source is rule_based
          careStage: { type: String, required: true },    // constants/developmental-staging.js CARE_STAGE.*
          careStageLabel: { type: String, required: true },
          consultationLevel: { type: String, required: true },
          monitoringLevel: { type: String, required: true },
          probabilities: { type: mongoose.Schema.Types.Mixed, default: null },
          generatedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },

    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false, collection: 'results' }
);

module.exports = mongoose.models.AssessmentResult || mongoose.model('AssessmentResult', assessmentResultSchema);
