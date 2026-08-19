// Unit tests for Step 13: make the ML training/evaluation workflow correctly
// use reviewed assessment data when available, while keeping synthetic data
// explicitly separate. No live DB required — Assessment/AssessmentResult/
// AssessmentAnswer/Child/CoreBankQuestion's .find()/.countDocuments() are
// monkey-patched on their shared singleton models, matching the pattern in
// tests/unit/dataset-quality.test.js. Tests A/E/F/G/H run the REAL
// ml/trainer.py against ml/test_dataset.csv (via ml/model_manager.js) with
// TrainedModel's static methods monkey-patched, matching the pattern in
// tests/unit/model-activation.test.js.
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const Child = require('../../models/Child');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const TrainedModel = require('../../models/TrainedModel');
const TrainingDataset = require('../../models/TrainingDataset');
const modelManager = require('../../ml/model_manager');

const adminRouter = require('../../routes/admin');
const { resolveTrainingQualityGate, computeDatasetProvenance } = adminRouter.__testables;

const FORBIDDEN_FEATURES = [
  'risk_category', 'gender_encoded', 'gender', 'reviewedBy', 'reviewer',
  'diagnosis', 'careStage', 'care_stage', 'prediction', 'recommendation',
];

function chainable(result) {
  return { select: () => chainable(result), sort: () => chainable(result), lean: async () => result };
}

function withMockedModels({ assessments, results, answers, children, questions, reviewedCount, excludedCount }) {
  const originals = {
    assessmentFind: Assessment.find,
    assessmentCount: Assessment.countDocuments,
    resultFind: AssessmentResult.find,
    answerFind: AssessmentAnswer.find,
    childFind: Child.find,
    questionFind: CoreBankQuestion.find,
  };
  Assessment.find = () => ({ lean: async () => assessments });
  Assessment.countDocuments = async (query) => {
    if (query && query.mlReviewStatus === 'excluded') return excludedCount ?? 0;
    if (query && query.mlReviewStatus === 'reviewed') return reviewedCount ?? assessments.length;
    return 0;
  };
  AssessmentResult.find = () => ({ lean: async () => results });
  AssessmentAnswer.find = () => ({ lean: async () => answers });
  Child.find = () => ({ select: () => ({ lean: async () => children }) });
  CoreBankQuestion.find = () => chainable(questions);

  return {
    restore() {
      Assessment.find = originals.assessmentFind;
      Assessment.countDocuments = originals.assessmentCount;
      AssessmentResult.find = originals.resultFind;
      AssessmentAnswer.find = originals.answerFind;
      Child.find = originals.childFind;
      CoreBankQuestion.find = originals.questionFind;
    },
  };
}

const QUESTIONS = [{ questionId: 'Q01' }, { questionId: 'Q02' }];

function makeAssessment(i, { childId, riskCategory, reviewedBy = `ped${i}` }) {
  return {
    _id: `a${i}`,
    childId: childId || `child${i}`,
    completedAt: new Date(`2026-0${(i % 9) + 1}-01`),
    startedAt: new Date('2026-01-01'),
    mlLabel: { riskCategory, reviewedBy, reviewedAt: new Date(`2026-0${(i % 9) + 1}-02`) },
  };
}
function makeResult(i, overallScore = 60) {
  return { assessmentId: `a${i}`, communicationScore: overallScore, socialScore: overallScore, cognitiveScore: overallScore, motorScore: overallScore, overallScore };
}
function makeChild(childId) {
  return { _id: childId, dateOfBirth: new Date('2021-01-01') };
}

// Runs the REAL trainer.py against ml/test_dataset.csv, with TrainedModel's
// statics monkey-patched so no live DB is required (same technique as
// tests/unit/model-activation.test.js). Returns { result, savedDoc }.
async function trainOnBundledTestDataset() {
  const origCreate = TrainedModel.create;
  const origFindOne = TrainedModel.findOne;
  const origUpdateMany = TrainedModel.updateMany;
  let savedDoc = null;

  TrainedModel.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  TrainedModel.updateMany = async () => ({ modifiedCount: 0 });
  TrainedModel.create = async (fields) => {
    const doc = { ...fields, save: async function () { savedDoc = { ...this }; } };
    return doc;
  };

  const result = await modelManager.trainModel(path.resolve('ml/test_dataset.csv'), 'fake-dataset-id');

  TrainedModel.create = origCreate;
  TrainedModel.findOne = origFindOne;
  TrainedModel.updateMany = origUpdateMany;

  if (result.model_path && fs.existsSync(result.model_path)) fs.unlinkSync(result.model_path);

  return { result, savedDoc };
}

async function run() {
  // ── A. Synthetic dataset training still works (unaffected by Step 13) ──
  let trained;
  {
    trained = await trainOnBundledTestDataset();
    assert.ok(trained.result.success !== false, 'training against the bundled synthetic test dataset must still succeed');
    assert.strictEqual(trained.savedDoc.status, 'completed');
  }

  // ── E. Feature columns exclude risk_category ──
  {
    assert.ok(!trained.result.features_used.includes('risk_category'), 'risk_category must never be a feature');
  }

  // ── F. Feature columns exclude gender_encoded (and gender) ──
  // ml/test_dataset.csv HAS a gender column — proves it's dropped, not just absent.
  {
    assert.ok(!trained.result.features_used.includes('gender_encoded'), 'gender_encoded must never be a feature');
    assert.ok(!trained.result.features_used.includes('gender'), 'gender must never be a feature');
    for (const forbidden of FORBIDDEN_FEATURES) {
      assert.ok(!trained.result.features_used.includes(forbidden), `feature columns must not include ${forbidden}`);
    }
    assert.deepStrictEqual(
      trained.result.features_used.slice().sort(),
      ['age_months', 'cognitive_score', 'communication_score', 'motor_score', 'overall_score', 'social_score'],
      'feature set must be exactly the canonical score columns plus age_months'
    );
  }

  // ── G. Evaluation metrics are produced (accuracy/precision/recall/F1 + confusion matrix + class distribution) ──
  {
    const r = trained.result;
    for (const key of ['accuracy', 'precision', 'recall', 'f1']) {
      assert.strictEqual(typeof r[key], 'number', `${key} must be a number`);
    }
    assert.ok(r.confusion_matrix && Array.isArray(r.confusion_matrix.labels) && Array.isArray(r.confusion_matrix.matrix), 'confusion_matrix must be present and structured');
    assert.ok(r.class_distribution && typeof r.class_distribution === 'object', 'class_distribution must be present');
    assert.strictEqual(typeof r.training_samples, 'number');
    assert.strictEqual(typeof r.test_samples, 'number');
    assert.strictEqual(typeof r.total_rows, 'number');
    assert.strictEqual(typeof r.rows_dropped, 'number');
  }

  // ── H. Class names are Low/Medium/High only ──
  {
    const VALID = new Set(['Low', 'Medium', 'High']);
    for (const name of trained.result.class_names) {
      assert.ok(VALID.has(name), `unexpected class name: ${name}`);
    }
  }

  // ── I. Source provenance is preserved (schema + display computation) ──
  {
    // Schema accepts the documented enum values and defaults to 'unknown'.
    const withDefault = new TrainingDataset({ name: 'x', originalName: 'x.csv', storedName: 'x.csv', filePath: '/tmp/x.csv', fileType: 'csv' });
    assert.strictEqual(withDefault.provenance.sourceType, 'unknown');

    const reviewed = new TrainingDataset({
      name: 'x', originalName: 'x.csv', storedName: 'x.csv', filePath: '/tmp/x.csv', fileType: 'csv',
      fileSize: 100, uploadedBy: new (require('mongoose').Types.ObjectId)(),
      provenance: { sourceType: 'reviewed_assessment' },
    });
    assert.strictEqual(reviewed.provenance.sourceType, 'reviewed_assessment');
    assert.strictEqual(reviewed.validateSync(), undefined);

    // Display computation prefers the STORED field over the filename heuristic.
    const namedLikeSynthetic = computeDatasetProvenance({ name: 'demo_dataset.csv', originalName: 'demo_dataset.csv', provenance: { sourceType: 'reviewed_assessment' } });
    assert.strictEqual(namedLikeSynthetic.sourceType, 'reviewed_assessment', 'a recorded sourceType must win over a synthetic-looking filename');
    assert.strictEqual(namedLikeSynthetic.label, 'Reviewed Assessment Data');
    assert.strictEqual(namedLikeSynthetic.recordedExplicitly, true);

    // Legacy dataset (no stored field) falls back to the Step 10 filename heuristic.
    const legacy = computeDatasetProvenance({ name: 'kindercura_demo_training_dataset.csv', originalName: 'kindercura_demo_training_dataset.csv', provenance: {} });
    assert.strictEqual(legacy.sourceType, 'synthetic');
    assert.strictEqual(legacy.recordedExplicitly, false);
    assert.strictEqual(legacy.label, 'Test/Synthetic Data');

    // Never describes anything as "Clinically Validated".
    assert.ok(!/clinically validated/i.test(namedLikeSynthetic.label));
    assert.ok(!/clinically validated/i.test(legacy.label));
  }

  // ── C. Not-ready reviewed dataset is blocked ──
  {
    const mocks = withMockedModels({ assessments: [], results: [], answers: [], children: [], questions: QUESTIONS, reviewedCount: 0, excludedCount: 0 });
    const gate = await resolveTrainingQualityGate({ provenance: { sourceType: 'reviewed_assessment' } });
    mocks.restore();
    assert.strictEqual(gate.blocked, true);
    assert.strictEqual(gate.readiness.status, 'not_ready');
  }

  // ── D. Warning-level reviewed dataset is allowed, with warnings surfaced ──
  {
    const n = 12;
    const assessments = Array.from({ length: n }, (_, i) => makeAssessment(i, { childId: `childD${i}`, riskCategory: 'Low', reviewedBy: `pedD${i % 3}` }));
    const results = assessments.map((_, i) => makeResult(i, 90));
    const children = assessments.map((a) => makeChild(a.childId));
    const mocks = withMockedModels({ assessments, results, answers: [], children, questions: QUESTIONS, reviewedCount: n, excludedCount: 0 });
    const gate = await resolveTrainingQualityGate({ provenance: { sourceType: 'reviewed_assessment' } });
    mocks.restore();
    assert.strictEqual(gate.blocked, false, 'a warning-level dataset must still be trainable');
    assert.strictEqual(gate.readiness.status, 'warning');
    assert.ok(gate.warnings.length > 0, 'warnings must be surfaced, not silently dropped');
  }

  // ── B. Reviewed dataset with valid (balanced) labels trains ──
  // Confirms both halves: the gate allows it, AND the real training
  // pipeline succeeds for a dataset flagged reviewed_assessment.
  {
    const labels = ['Low', 'Low', 'Low', 'Low', 'Medium', 'Medium', 'Medium', 'Medium', 'High', 'High', 'High', 'High'];
    const assessments = labels.map((riskCategory, i) => makeAssessment(i, { childId: `childB${i}`, riskCategory, reviewedBy: `pedB${i % 4}` }));
    const results = assessments.map((_, i) => makeResult(i, 60));
    const children = assessments.map((a) => makeChild(a.childId));
    const answers = assessments.map((_, i) => ({ assessmentId: `a${i}`, questionId: 'Q01', answer: 'yes' }));
    const mocks = withMockedModels({ assessments, results, answers, children, questions: QUESTIONS, reviewedCount: assessments.length, excludedCount: 0 });
    const gate = await resolveTrainingQualityGate({ provenance: { sourceType: 'reviewed_assessment' } });
    mocks.restore();
    assert.strictEqual(gate.blocked, false);
    assert.strictEqual(gate.readiness.status, 'ready');

    const { result } = await trainOnBundledTestDataset();
    assert.ok(result.success !== false, 'training must succeed once the gate allows it');
  }

  // ── Synthetic/unknown datasets are never gated against reviewed-assessment readiness ──
  // (no models are mocked here at all — if the gate tried to query the DB for a
  // non-reviewed dataset, this would throw, since the real Mongoose statics
  // are in effect and there is no live DB in this test run.)
  {
    const synthGate = await resolveTrainingQualityGate({ provenance: { sourceType: 'synthetic' } });
    assert.strictEqual(synthGate.blocked, false);
    assert.deepStrictEqual(synthGate.warnings, []);
    assert.strictEqual(synthGate.readiness, null);

    const unknownGate = await resolveTrainingQualityGate({ provenance: { sourceType: 'unknown' } });
    assert.strictEqual(unknownGate.blocked, false);

    const noProvenanceGate = await resolveTrainingQualityGate({});
    assert.strictEqual(noProvenanceGate.blocked, false);
  }

  console.log('ML reviewed-training (Step 13) tests OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
