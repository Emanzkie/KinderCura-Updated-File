// Unit tests for Step 7: explicit, admin-controlled model activation.
// Training must produce a candidate only (never auto-activate, never touch
// the currently active model); activation is a separate, validated,
// admin-only action. No live DB or Python process required for most cases —
// TrainedModel's static methods are monkey-patched on the shared singleton
// model (Node's require cache guarantees ml/model_manager.js and
// routes/ml.js see the same instance patched here). Test A additionally
// runs the real trainer.py against the small bundled test dataset to prove
// the actual training code path never sets isActive.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const TrainedModel = require('../../models/TrainedModel');
const modelManager = require('../../ml/model_manager');
const mlRouter = require('../../routes/ml');
const { adminOnly } = require('../../middleware/auth');
const { modelLifecycleState, getModelActivationBlocker, performModelActivation } = mlRouter.__testables;

const GENDER_MODEL_FEATURES = ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'age_months', 'gender_encoded'];
const CLEAN_MODEL_FEATURES = ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'age_months'];

async function run() {
  // ── A & B: training produces a candidate only, never touches an existing active model ──
  {
    const origCreate = TrainedModel.create;
    const origFindOne = TrainedModel.findOne;
    const origUpdateMany = TrainedModel.updateMany;
    let updateManyCalls = 0;
    let savedDoc = null;

    TrainedModel.findOne = () => ({ sort: () => ({ lean: async () => ({ version: 1 }) }) }); // "an existing active model, v1, already exists"
    TrainedModel.updateMany = async (...args) => { updateManyCalls += 1; return { modifiedCount: 0 }; };
    TrainedModel.create = async (fields) => {
      const doc = { ...fields, save: async function () { savedDoc = { ...this }; } };
      return doc;
    };

    const result = await modelManager.trainModel(path.resolve('ml/test_dataset.csv'), 'fake-dataset-id');

    TrainedModel.create = origCreate;
    TrainedModel.findOne = origFindOne;
    TrainedModel.updateMany = origUpdateMany;

    // This test exercises the real trainer.py, which writes a real .joblib
    // artifact to uploads/models/ — clean it up so repeated test runs don't
    // accumulate throwaway model files.
    if (result.model_path && fs.existsSync(result.model_path)) fs.unlinkSync(result.model_path);

    assert.ok(result.success !== false, 'training must succeed');
    // A. Newly trained model: completed, and isActive was never assigned by
    // the training code path (stays whatever the schema default is — undefined
    // here since this is a plain fixture object, but the key point is training
    // code never sets it to true).
    assert.strictEqual(savedDoc.status, 'completed');
    assert.ok(!('isActive' in savedDoc), 'training code must never assign isActive at all');
    // B. Training never calls updateMany — an existing active model (real or
    // simulated) is never touched by the training code path.
    assert.strictEqual(updateManyCalls, 0, 'training must never deactivate any other model');
  }

  // ── C: compatible candidate activation swaps active status ──
  {
    let updateManyFilter = null;
    let updateManyUpdate = null;
    const origUpdateMany = TrainedModel.updateMany;
    TrainedModel.updateMany = async (filter, update) => { updateManyFilter = filter; updateManyUpdate = update; return { modifiedCount: 1 }; };

    const candidate = {
      _id: 'candidate-id',
      status: 'completed',
      modelPath: '/fake/candidate.joblib',
      featuresUsed: CLEAN_MODEL_FEATURES,
      isActive: false,
      save: async function () { this.saved = true; },
    };

    const blocker = getModelActivationBlocker(candidate);
    assert.strictEqual(blocker, null, 'a completed, compatible, file-backed candidate must be activatable');

    await performModelActivation(candidate);
    TrainedModel.updateMany = origUpdateMany;

    assert.strictEqual(candidate.isActive, true, 'candidate becomes active');
    assert.strictEqual(candidate.saved, true, 'candidate is saved');
    // Proves the "deactivate everything else" call is issued, scoped to
    // exclude only the newly activated model — this is what makes the
    // previously active model become inactive.
    assert.deepStrictEqual(updateManyFilter, { _id: { $ne: 'candidate-id' }, isActive: true });
    assert.deepStrictEqual(updateManyUpdate, { $set: { isActive: false } });
  }

  // ── D: incompatible candidate activation is rejected ──
  {
    const incompatible = { status: 'completed', modelPath: '/fake/old.joblib', featuresUsed: GENDER_MODEL_FEATURES };
    const blocker = getModelActivationBlocker(incompatible);
    assert.ok(blocker && /features no longer supported/i.test(blocker));
  }

  // ── E: a still-training model cannot be activated ──
  {
    const training = { status: 'training', modelPath: '', featuresUsed: [] };
    const blocker = getModelActivationBlocker(training);
    assert.ok(blocker && /still training/i.test(blocker));
  }

  // ── F: a failed model cannot be activated ──
  {
    const failed = { status: 'failed', modelPath: '', featuresUsed: [] };
    const blocker = getModelActivationBlocker(failed);
    assert.ok(blocker && /failed training/i.test(blocker));
  }

  // ── G: non-admin activation is rejected (adminOnly middleware, unchanged, reused as-is) ──
  {
    let statusCode = null;
    let body = null;
    const fakeRes = {
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
    };
    let nextCalled = false;
    adminOnly({ user: { role: 'parent' } }, fakeRes, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusCode, 403);
    assert.ok(body && /admin/i.test(body.error));
  }

  // ── H: prediction/stage lookup still only trusts an active AND compatible model ──
  // (regression coverage — the compatibility gate itself is unchanged by Step 7;
  // full behavior already covered by tests/unit/recommendations-staging.test.js
  // and tests/unit/prediction-persistence.test.js, re-affirmed here directly.)
  {
    assert.strictEqual(modelManager.isModelCompatible({ featuresUsed: CLEAN_MODEL_FEATURES }), true);
    assert.strictEqual(modelManager.isModelCompatible({ featuresUsed: GENDER_MODEL_FEATURES }), false);
  }

  // ── J: the existing old gender_encoded model remains incompatible and cannot be activated ──
  {
    const oldLiveModel = { status: 'completed', modelPath: 'uploads/models/kindercura_model_20260813_034229.joblib', featuresUsed: GENDER_MODEL_FEATURES };
    assert.strictEqual(modelManager.isModelCompatible(oldLiveModel), false);
    const blocker = getModelActivationBlocker(oldLiveModel);
    assert.ok(blocker && /features no longer supported/i.test(blocker));
  }

  // ── lifecycleState labeling (point 4) ──
  {
    assert.strictEqual(modelLifecycleState({ status: 'training' }, null), 'training');
    assert.strictEqual(modelLifecycleState({ status: 'failed' }, null), 'failed');
    assert.strictEqual(modelLifecycleState({ status: 'completed', isActive: true }, true), 'active');
    assert.strictEqual(modelLifecycleState({ status: 'completed', isActive: false }, true), 'candidate');
    assert.strictEqual(modelLifecycleState({ status: 'completed', isActive: false }, false), 'incompatible');
  }

  console.log('Model activation lifecycle tests OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
