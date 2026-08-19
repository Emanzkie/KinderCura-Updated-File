// tests/unit/ml-feature-comparison.test.js
// Unit tests for Step 15: Score-Level vs Question-Level ML Feature Comparison.
// Validates training pipeline invocation, featureSetType configuration,
// artifact structure, predictor compatibility, leakage prevention, and model
// activation lifecycle safety.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const TrainedModel = require('../../models/TrainedModel');
const TrainingDataset = require('../../models/TrainingDataset');
const modelManager = require('../../ml/model_manager');

const CANONICAL_DATASET = path.join(__dirname, '..', '..', 'ml', 'datasets', 'kindercura_assessment_dataset.csv');

const FORBIDDEN_FEATURES = [
  'risk_category', 'gender', 'gender_encoded', 'reviewedBy', 'reviewer',
  'diagnosis', 'careStage', 'care_stage', 'prediction', 'recommendation',
  'consultationLevel', 'monitoringLevel', 'clinicalOutcome', 'mlLabel',
];

async function trainWithMockedDb(datasetPath, featureSet) {
  const origFindOne = TrainedModel.findOne;
  const origCreate = TrainedModel.create;
  const origUpdateMany = TrainedModel.updateMany;
  let savedDoc = null;

  TrainedModel.findOne = () => ({
    sort: () => ({ lean: async () => ({ version: 10 }) }),
  });
  TrainedModel.updateMany = async () => ({ modifiedCount: 0 });

  TrainedModel.create = async (fields) => {
    const doc = {
      isActive: false,
      ...fields,
      save: async function () {
        savedDoc = { ...this };
      },
    };
    return doc;
  };

  try {
    const result = await modelManager.trainModel(datasetPath, 'mockDatasetId123', { featureSet });
    return { result, savedDoc };
  } finally {
    TrainedModel.findOne = origFindOne;
    TrainedModel.create = origCreate;
    TrainedModel.updateMany = origUpdateMany;
  }
}

async function testScoreBasedTraining() {
  const { result, savedDoc } = await trainWithMockedDb(CANONICAL_DATASET, 'score_based');
  try {
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.feature_set_type, 'score_based');
    assert.strictEqual(savedDoc.featureSetType, 'score_based');
    assert.strictEqual(savedDoc.isActive, false, 'Trained model must remain candidate only (isActive = false)');
    assert.strictEqual(savedDoc.status, 'completed');

    // Verify feature columns contain the 5 score fields
    const expectedScores = ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score'];
    for (const s of expectedScores) {
      assert.ok(result.features_used.includes(s), `Missing score feature: ${s}`);
    }

    // Verify leakage prevention
    for (const f of FORBIDDEN_FEATURES) {
      assert.ok(!result.features_used.includes(f), `Forbidden feature leaked into score model: ${f}`);
    }

    // Verify prediction with score model
    const prediction = await modelManager.predict(result.model_path, {
      communication_score: 80,
      social_score: 75,
      cognitive_score: 85,
      motor_score: 90,
      overall_score: 82,
      age_months: 48,
    });
    assert.strictEqual(prediction.success, true);
    assert.ok(['Low', 'Medium', 'High'].includes(prediction.risk_category));
  } finally {
    if (result.model_path && fs.existsSync(result.model_path)) {
      try { fs.unlinkSync(result.model_path); } catch (_) {}
    }
  }
}

async function testQuestionBasedTraining() {
  const { result, savedDoc } = await trainWithMockedDb(CANONICAL_DATASET, 'question_based');
  try {
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.feature_set_type, 'question_based');
    assert.strictEqual(savedDoc.featureSetType, 'question_based');
    assert.strictEqual(savedDoc.isActive, false, 'Trained model must remain candidate only (isActive = false)');
    assert.strictEqual(savedDoc.status, 'completed');
    assert.ok(savedDoc.featureCount >= 34, `Expected at least 34 features, got ${savedDoc.featureCount}`);

    // Verify Q01-Q34 are present
    for (let n = 1; n <= 34; n++) {
      const qid = `Q${String(n).padStart(2, '0')}`;
      assert.ok(result.features_used.includes(qid), `Missing question feature: ${qid}`);
    }

    // Verify leakage prevention
    for (const f of FORBIDDEN_FEATURES) {
      assert.ok(!result.features_used.includes(f), `Forbidden feature leaked into question model: ${f}`);
    }

    // Verify prediction with question model (with string answers and age-gated blanks)
    const questionInput = {};
    for (let n = 1; n <= 20; n++) {
      questionInput[`Q${String(n).padStart(2, '0')}`] = n % 2 === 0 ? 'yes' : 'sometimes';
    }
    for (let n = 21; n <= 34; n++) {
      questionInput[`Q${String(n).padStart(2, '0')}`] = ''; // age-gated blank
    }
    questionInput.age_months = 40;

    const prediction = await modelManager.predict(result.model_path, questionInput);
    assert.strictEqual(prediction.success, true);
    assert.ok(['Low', 'Medium', 'High'].includes(prediction.risk_category));
    assert.strictEqual(typeof prediction.consultation_needed, 'boolean');
  } finally {
    if (result.model_path && fs.existsSync(result.model_path)) {
      try { fs.unlinkSync(result.model_path); } catch (_) {}
    }
  }
}

async function testModelCompatibilityCheck() {
  // Score-based model is compatible
  assert.strictEqual(modelManager.isModelCompatible({
    featuresUsed: ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score'],
  }), true);

  // Question-based model is compatible
  const qFeatures = Array.from({ length: 34 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`);
  assert.strictEqual(modelManager.isModelCompatible({ featuresUsed: qFeatures }), true);

  // Model containing legacy gender_encoded is rejected
  assert.strictEqual(modelManager.isModelCompatible({
    featuresUsed: ['communication_score', 'gender_encoded'],
  }), false);
}

async function run() {
  await testScoreBasedTraining();
  await testQuestionBasedTraining();
  await testModelCompatibilityCheck();
  console.log('ML feature comparison (Step 15) tests OK');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
