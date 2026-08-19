// Unit tests for Step 5 (persisting the ML prediction on each completed
// AssessmentResult) / Step 8 (keeping riskCategory and careStage as two
// separate stored fields), and making historical reads (reassessment
// comparison + recommendations) use that stored snapshot instead of
// recomputing against whichever ML model is active right now.
//
// No live DB or Python process required — TrainedModel.findOne and
// ml/model_manager.js's predict are monkey-patched on their shared
// singleton modules (Node's require cache guarantees services/
// assessmentProgress.js and routes/recommendations.js see the same
// instances patched here). Call counters prove "ML was/was not invoked"
// assertions directly, rather than just checking the output shape.
const assert = require('assert');
const staging = require('../../constants/developmental-staging');
const assessmentProgress = require('../../services/assessmentProgress');
const AssessmentResult = require('../../models/AssessmentResult');
const recommendationsRouter = require('../../routes/recommendations');
const { getPredictionForResult } = recommendationsRouter.__testables;
const TrainedModel = require('../../models/TrainedModel');
const modelManager = require('../../ml/model_manager');

function fakeScores(overallScore) {
  return {
    communicationScore: overallScore,
    socialScore: overallScore,
    cognitiveScore: overallScore,
    motorScore: overallScore,
    overallScore,
  };
}

// Monkey-patches TrainedModel.findOne / modelManager.predict on their
// shared singleton modules and counts invocations, so a test can assert
// "ML was never called" directly instead of only checking output shape.
function withCallCounters() {
  const calls = { findOne: 0, predict: 0 };
  const origFindOne = TrainedModel.findOne;
  const origPredict = modelManager.predict;
  return {
    calls,
    setFindOneResult(doc) { TrainedModel.findOne = () => { calls.findOne += 1; return { lean: async () => doc }; }; },
    setPredictResult(fn) { modelManager.predict = async (...args) => { calls.predict += 1; return fn(...args); }; },
    restore() { TrainedModel.findOne = origFindOne; modelManager.predict = origPredict; },
  };
}

async function run() {
  // A. Completed assessment with a compatible ML model: full prediction
  // saved — source, modelVersion, riskCategory, careStage, care-plan
  // levels, probabilities all present and consistent.
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult({ version: 4, modelPath: '/fake/model.joblib', featuresUsed: ['communication_score', 'overall_score'] });
    mocks.setPredictResult(async () => ({
      risk_category: 'High',
      consultation_needed: true,
      probabilities: { Low: 0.1, Medium: 0.2, High: 0.7 },
    }));

    const record = await assessmentProgress.buildPredictionForStorage(fakeScores(20), null);
    mocks.restore();

    assert.strictEqual(record.source, 'ml');
    assert.strictEqual(record.modelVersion, 4);
    assert.strictEqual(record.riskCategory, 'High');
    assert.strictEqual(record.careStage, staging.CARE_STAGE.SEVERE);
    assert.strictEqual(record.careStageLabel, staging.getCareStageDefinition(staging.CARE_STAGE.SEVERE).label);
    assert.strictEqual(record.consultationLevel, 'required');
    assert.strictEqual(record.monitoringLevel, 'close_monitoring');
    assert.deepStrictEqual(record.probabilities, { Low: 0.1, Medium: 0.2, High: 0.7 });
    assert.ok(record.generatedAt instanceof Date);

    // F. riskCategory (ML classification, 'High') and careStage ('severe')
    // are two SEPARATE fields with two separate vocabularies, never
    // collapsed into one value.
    assert.notStrictEqual(record.riskCategory, record.careStage);
    assert.strictEqual(typeof record.riskCategory, 'string');
    assert.strictEqual(typeof record.careStage, 'string');
  }

  // B. Completed assessment without an active ML model: still produces a
  // complete, valid record — source rule_based, modelVersion null.
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult(null); // no active model at all
    const record = await assessmentProgress.buildPredictionForStorage(fakeScores(50), 'child-2');
    mocks.restore();

    assert.strictEqual(record.source, 'rule_based');
    assert.strictEqual(record.modelVersion, null);
    assert.strictEqual(record.riskCategory, null); // F: no ML involved -> no risk category, but careStage still set
    assert.strictEqual(record.careStage, staging.CARE_STAGE.INTERMEDIATE);
    assert.ok(record.careStageLabel);
    assert.ok(record.consultationLevel);
    assert.ok(record.monitoringLevel);
    assert.strictEqual(record.probabilities, null);
  }

  // C. ML failure (predict() throws): still produces a complete, valid
  // rule-based record rather than blocking assessment completion.
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult({ version: 5, modelPath: '/fake/model.joblib', featuresUsed: ['communication_score', 'overall_score'] });
    mocks.setPredictResult(async () => { throw new Error('python process crashed'); });

    const record = await assessmentProgress.buildPredictionForStorage(fakeScores(50), null);
    mocks.restore();

    assert.strictEqual(record.source, 'rule_based');
    assert.strictEqual(record.modelVersion, null);
    assert.strictEqual(record.careStage, staging.CARE_STAGE.INTERMEDIATE);
    // Data-integrity rule: no ambiguous partial state (e.g. source: ml with riskCategory: null).
    assert.notStrictEqual(record.source, 'ml');
  }

  // D. An assessment result that already has a stored prediction: reading
  // it back must NEVER call TrainedModel.findOne or modelManager.predict —
  // the stored value is used exactly as recorded.
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult({ version: 99, modelPath: '/fake/newer-model.joblib', featuresUsed: [] });
    mocks.setPredictResult(async () => { throw new Error('predict() should never be called when a prediction is already stored'); });

    const resultDoc = {
      overallScore: 20,
      prediction: {
        source: 'ml',
        modelVersion: 1,
        riskCategory: 'High',
        careStage: staging.CARE_STAGE.SEVERE,
        careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.SEVERE).label,
        consultationLevel: 'required',
        monitoringLevel: 'close_monitoring',
        probabilities: { Low: 0.05, Medium: 0.1, High: 0.85 },
        generatedAt: new Date('2026-07-15'),
      },
    };

    const careStageInfo = assessmentProgress.getStoredOrDerivedCareStage(resultDoc);
    mocks.restore();

    assert.strictEqual(mocks.calls.findOne, 0, 'TrainedModel.findOne must not be called when a prediction is already stored');
    assert.strictEqual(mocks.calls.predict, 0, 'modelManager.predict must not be called when a prediction is already stored');
    assert.strictEqual(careStageInfo.source, 'ml');
    assert.strictEqual(careStageInfo.modelVersion, 1);
    assert.strictEqual(careStageInfo.riskCategory, 'High');
  }

  // E. Historical model version stays frozen: a July result stored with
  // modelVersion 1 keeps reporting modelVersion 1 even once modelVersion 2
  // is the currently active model — it is never re-run through it.
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult({ version: 2, modelPath: '/fake/v2-model.joblib', featuresUsed: [] }); // "now active"
    mocks.setPredictResult(async () => { throw new Error('July must not be re-predicted through the newer model'); });

    const julyResult = {
      overallScore: 20,
      prediction: {
        source: 'ml',
        modelVersion: 1,
        riskCategory: 'High',
        careStage: staging.CARE_STAGE.SEVERE,
        careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.SEVERE).label,
        consultationLevel: 'required',
        monitoringLevel: 'close_monitoring',
        probabilities: null,
        generatedAt: new Date('2026-07-15'),
      },
    };

    const careStageInfo = assessmentProgress.getStoredOrDerivedCareStage(julyResult);
    mocks.restore();

    assert.strictEqual(careStageInfo.modelVersion, 1);
    assert.strictEqual(mocks.calls.findOne, 0);
    assert.strictEqual(mocks.calls.predict, 0);
  }

  // F (cont'd). Missing historical prediction (pre-Step-5 legacy record):
  // backward-compatible rule-based fallback works, and — critically — does
  // NOT attempt a live ML call (which would misrepresent history).
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult({ version: 3, modelPath: '/fake/model.joblib', featuresUsed: [] });
    mocks.setPredictResult(async () => { throw new Error('legacy records must not be run through ML retroactively'); });

    const legacyResult = { overallScore: 65 }; // no `prediction` field at all
    const careStageInfo = assessmentProgress.getStoredOrDerivedCareStage(legacyResult);
    mocks.restore();

    assert.strictEqual(careStageInfo.source, 'rule_based');
    assert.strictEqual(careStageInfo.modelVersion, null);
    assert.strictEqual(careStageInfo.careStage, staging.getCareStageFromScore(65));
    assert.strictEqual(mocks.calls.findOne, 0);
    assert.strictEqual(mocks.calls.predict, 0);
  }

  // G. Recommendation endpoint (routes/recommendations.js) uses the stored
  // prediction via getPredictionForResult() and does not retrain/re-predict.
  {
    const mocks = withCallCounters();
    mocks.setFindOneResult({ version: 7, modelPath: '/fake/model.joblib', featuresUsed: [] });
    mocks.setPredictResult(async () => { throw new Error('routes/recommendations.js must not re-predict a stored assessment'); });

    const resultDoc = {
      overallScore: 50,
      prediction: {
        source: 'ml',
        modelVersion: 2,
        riskCategory: 'Medium',
        careStage: staging.CARE_STAGE.INTERMEDIATE,
        careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.INTERMEDIATE).label,
        consultationLevel: 'scheduled',
        monitoringLevel: 'continued_parent_monitoring',
        probabilities: null,
        generatedAt: new Date('2026-06-01'),
      },
    };

    const predictionInfo = getPredictionForResult(resultDoc);
    mocks.restore();

    assert.strictEqual(mocks.calls.findOne, 0);
    assert.strictEqual(mocks.calls.predict, 0);
    assert.strictEqual(predictionInfo.source, 'ml');
    assert.strictEqual(predictionInfo.modelVersion, 2);
    assert.strictEqual(predictionInfo.careStage, staging.CARE_STAGE.INTERMEDIATE);
  }

  // H. Regression (found during Step 6 live verification): routes/
  // recommendations.js fetches AssessmentResult WITHOUT .lean() (a hydrated
  // Mongoose document, not a plain object) — getStoredOrDerivedCareStage
  // must read the stored prediction correctly from a REAL hydrated
  // document, not just from a plain-object test fixture. Spreading a
  // Mongoose subdocument (`{ ...doc.prediction }`) silently drops every
  // field; this is exactly what caught that bug in the first place.
  {
    const doc = new AssessmentResult({
      assessmentId: new (require('mongoose').Types.ObjectId)(),
      childId: new (require('mongoose').Types.ObjectId)(),
      overallScore: 20,
      prediction: {
        source: 'ml',
        modelVersion: 3,
        riskCategory: 'High',
        careStage: staging.CARE_STAGE.SEVERE,
        careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.SEVERE).label,
        consultationLevel: 'required',
        monitoringLevel: 'close_monitoring',
        probabilities: { Low: 0.1, Medium: 0.1, High: 0.8 },
        generatedAt: new Date(),
      },
    });

    // Sanity check this is genuinely a hydrated Mongoose document, not a plain object.
    assert.ok(doc.prediction.constructor.name !== 'Object' || typeof doc.toObject === 'function');

    const careStageInfo = assessmentProgress.getStoredOrDerivedCareStage(doc);
    assert.strictEqual(careStageInfo.source, 'ml');
    assert.strictEqual(careStageInfo.modelVersion, 3);
    assert.strictEqual(careStageInfo.riskCategory, 'High');
    assert.strictEqual(careStageInfo.careStage, staging.CARE_STAGE.SEVERE);
    assert.strictEqual(careStageInfo.consultationLevel, 'required');
    assert.deepStrictEqual(careStageInfo.probabilities, { Low: 0.1, Medium: 0.1, High: 0.8 });
  }

  console.log('Prediction persistence tests OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
