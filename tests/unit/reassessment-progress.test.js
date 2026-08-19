// Unit tests for Step 4 (longitudinal reassessment comparison) / Step 8
// (concept separation): services/assessmentProgress.js +
// constants/developmental-staging.js compareCareStages/getCareStageRank, +
// routes/assessments.js /compare wiring.
//
// No live DB or Python process required. buildAssessmentProgressSummary()
// takes already-resolved Assessment/AssessmentResult objects as arguments
// (it does not fetch them itself), so plain JS fixtures work directly. The
// ML path (getMLCareStage) is exercised by monkey-patching TrainedModel.findOne
// and ml/model_manager.js's predict — both are shared singletons under
// Node's module cache, so patching them here reaches the same instances
// services/assessmentProgress.js imported. Originals are restored after use.
const assert = require('assert');
const staging = require('../../constants/developmental-staging');
const scoring = require('../../constants/scoring');
const assessmentProgress = require('../../services/assessmentProgress');
const TrainedModel = require('../../models/TrainedModel');
const modelManager = require('../../ml/model_manager');

function fakeResult(overallScore, overrides = {}) {
  return {
    communicationScore: overallScore,
    socialScore: overallScore,
    cognitiveScore: overallScore,
    motorScore: overallScore,
    overallScore,
    ...overrides,
  };
}

async function run() {
  const origFindOne = TrainedModel.findOne;
  const origPredict = modelManager.predict;

  // Default for most of this suite: no active model at all -> every
  // care-stage lookup below takes the rule-based path unless a test overrides this.
  TrainedModel.findOne = () => ({ lean: async () => null });

  try {
    // A. First completed assessment -> direction unavailable, previous null,
    // never labeled "improved" or "worsened".
    {
      const currentCareStageInfo = await assessmentProgress.getAssessmentCareStage(fakeResult(90));
      const comparison = assessmentProgress.compareAssessmentProgress(null, currentCareStageInfo);
      assert.strictEqual(comparison.direction, 'unavailable');
      assert.strictEqual(comparison.reason, 'first_assessment');
      assert.strictEqual(comparison.previousRank, null);
    }

    // Helper: full summary using plain fixtures, no DB.
    async function summaryFor(previousScore, currentScore) {
      const currentAssessment = { _id: 'current-id', completedAt: new Date('2026-08-15'), startedAt: new Date('2026-08-01') };
      const previousAssessment = previousScore == null ? null : { _id: 'previous-id', completedAt: new Date('2026-07-15'), startedAt: new Date('2026-07-01') };
      const currentResult = fakeResult(currentScore);
      const previousResult = previousScore == null ? null : fakeResult(previousScore);
      return assessmentProgress.buildAssessmentProgressSummary(currentAssessment, currentResult, previousAssessment, previousResult);
    }

    // B. Previous High (score 20 -> severe) -> Current Medium (score 50 -> intermediate) => improved.
    // This is the adviser's own July(High)->August(Medium) example.
    {
      const s = await summaryFor(20, 50);
      assert.strictEqual(s.previous.careStage, staging.CARE_STAGE.SEVERE);
      assert.strictEqual(s.current.careStage, staging.CARE_STAGE.INTERMEDIATE);
      assert.strictEqual(s.comparison.direction, 'improved');
    }

    // C. Previous Medium (50) -> Current Low (90) => improved.
    {
      const s = await summaryFor(50, 90);
      assert.strictEqual(s.comparison.direction, 'improved');
    }

    // D. Previous Low (90) -> Current Medium (50) => worsened.
    {
      const s = await summaryFor(90, 50);
      assert.strictEqual(s.comparison.direction, 'worsened');
    }

    // E. Previous Medium (50) -> Current High (20) => worsened.
    {
      const s = await summaryFor(50, 20);
      assert.strictEqual(s.comparison.direction, 'worsened');
    }

    // F. Same care stage (different raw scores, both land in LOW_CONCERN) => no_change.
    {
      const s = await summaryFor(65, 90);
      assert.strictEqual(s.previous.careStage, staging.CARE_STAGE.LOW_CONCERN);
      assert.strictEqual(s.current.careStage, staging.CARE_STAGE.LOW_CONCERN);
      assert.strictEqual(s.comparison.direction, 'no_change');
    }

    // G. Previous-assessment selection is scoped to the SAME child — proven
    // structurally via the query filter (no live DB in this suite).
    // H. Only status: 'complete' assessments are eligible — drafts/abandoned
    // assessments can never match this filter.
    {
      const anchor = new Date('2026-08-15');
      const filter = assessmentProgress.buildPreviousAssessmentFilter('child-A', 'current-assessment-id', anchor);
      assert.strictEqual(filter.childId, 'child-A'); // scoped to this child only
      assert.strictEqual(filter.status, 'complete'); // excludes in_progress/submitted drafts
      assert.deepStrictEqual(filter._id, { $ne: 'current-assessment-id' }); // excludes itself
      assert.deepStrictEqual(filter.completedAt, { $lt: anchor }); // strictly preceding
    }

    // I. Rule-based fallback works when no active ML model exists (the
    // default for this whole suite — see TrainedModel.findOne override above).
    {
      const careStageInfo = await assessmentProgress.getAssessmentCareStage(fakeResult(20));
      assert.strictEqual(careStageInfo.source, 'rule_based');
      assert.strictEqual(careStageInfo.careStage, staging.CARE_STAGE.SEVERE);
    }

    // J. ML source is correctly marked "ml" when a valid, compatible active
    // model produces a usable prediction.
    {
      TrainedModel.findOne = () => ({
        lean: async () => ({ version: 3, modelPath: '/fake/model.joblib', featuresUsed: ['communication_score', 'overall_score'] }),
      });
      modelManager.predict = async () => ({
        risk_category: 'High',
        consultation_needed: true,
        probabilities: { Low: 0.05, Medium: 0.15, High: 0.8 },
      });

      const mlCareStage = await assessmentProgress.getMLCareStage(fakeResult(20), null);
      assert.ok(mlCareStage);
      assert.strictEqual(mlCareStage.source, 'ml');
      assert.strictEqual(mlCareStage.riskCategory, 'High');
      assert.strictEqual(mlCareStage.careStage, staging.CARE_STAGE.SEVERE);
      assert.strictEqual(mlCareStage.consultationLevel, 'required');
      assert.strictEqual(mlCareStage.monitoringLevel, 'close_monitoring');
    }

    // F (model compatibility). An old/incompatible model (trained with
    // gender_encoded, per Step 2) never reaches predict() — getMLCareStage
    // short-circuits to null, and getAssessmentCareStage falls back to
    // rule_based safely instead of crashing.
    {
      TrainedModel.findOne = () => ({
        lean: async () => ({ version: 1, modelPath: '/fake/old-model.joblib', featuresUsed: ['communication_score', 'gender_encoded'] }),
      });
      modelManager.predict = async () => {
        throw new Error('predict() should never be called for an incompatible model');
      };

      const mlCareStage = await assessmentProgress.getMLCareStage(fakeResult(50), null);
      assert.strictEqual(mlCareStage, null);

      const careStageInfo = await assessmentProgress.getAssessmentCareStage(fakeResult(50));
      assert.strictEqual(careStageInfo.source, 'rule_based');
    }

    // K. Domain score deltas are calculated correctly (and null when there
    // is no previous result, per test A's first-assessment case).
    {
      const current = { communicationScore: 65, socialScore: 70, cognitiveScore: 55, motorScore: 60, overallScore: 62 };
      const previous = { communicationScore: 45, socialScore: 50, cognitiveScore: 60, motorScore: 55, overallScore: 52 };
      const scores = assessmentProgress.buildScoreChanges(current, previous);
      assert.deepStrictEqual(
        { previous: scores.communication.previous, current: scores.communication.current, difference: scores.communication.difference },
        { previous: 45, current: 65, difference: 20 }
      );
      assert.strictEqual(scores.social.difference, 20);
      assert.strictEqual(scores.cognitive.difference, -5); // worsened domain within an overall-improved comparison
      assert.strictEqual(scores.motor.difference, 5);

      const noPrevious = assessmentProgress.buildScoreChanges(current, null);
      assert.strictEqual(noPrevious.communication.previous, null);
      assert.strictEqual(noPrevious.communication.difference, null);
    }

    // L. Overall score delta is calculated correctly.
    {
      const scores = assessmentProgress.buildScoreChanges({ overallScore: 71 }, { overallScore: 45 });
      assert.strictEqual(scores.overall.current, 71);
      assert.strictEqual(scores.overall.previous, 45);
      assert.strictEqual(scores.overall.difference, 26);
    }

    // M. Step 8: comparison direction is driven by careStage, but each side's
    // developmentalBand (score classification) and riskCategory (ML
    // classification, null on the rule-based path used here) are preserved
    // for display/reporting — not collapsed into the comparison itself.
    {
      const s = await summaryFor(20, 50); // same July(High)->August(Medium) case as B
      assert.strictEqual(s.previous.developmentalBand, scoring.bandFor(20));
      assert.strictEqual(s.current.developmentalBand, scoring.bandFor(50));
      assert.strictEqual(s.previous.riskCategory, null); // rule_based path — no ML involved
      assert.strictEqual(s.current.riskCategory, null);
      // developmentalBand and careStage are independent vocabularies, even
      // though both happen to move in the same direction here.
      assert.notStrictEqual(s.previous.developmentalBand, s.previous.careStage);
      assert.notStrictEqual(s.current.developmentalBand, s.current.careStage);
    }

    console.log('Reassessment progress comparison tests OK');
  } finally {
    TrainedModel.findOne = origFindOne;
    modelManager.predict = origPredict;
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
