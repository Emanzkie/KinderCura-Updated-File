// Model activation / rollback safety tests.
//
// Covers the guarantees an admin relies on when switching the model that
// serves live ML predictions:
//   1. a compatible model can be activated
//   2. an incompatible model is refused
//   3. activating one model deactivates the previous one
//   4. exactly one model is active afterwards, always
//   5. rollback to an earlier compatible model works
//   6. a model that fails its prediction smoke test is refused
//   7. deactivating never deletes a document or a .joblib artifact
//   8. deactivate-all returns the system to the rule-based fallback
//
// No live DB and no Python: TrainedModel's statics are replaced with a small
// in-memory store, and the smoke test is stubbed per case. Node's require
// cache guarantees routes/ml.js and ml/model_manager.js see the same patched
// singleton. Test 6 additionally runs the REAL smoke test against a genuinely
// missing artifact, so the failure path is proven end to end rather than only
// simulated.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TrainedModel = require('../../models/TrainedModel');
const modelManager = require('../../ml/model_manager');
const mlRouter = require('../../routes/ml');
const {
  getModelActivationBlocker,
  performModelActivation,
  performModelDeactivation,
  runActivationPreflight,
} = mlRouter.__testables;

const CLEAN_FEATURES = ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'age_months'];
const GENDER_FEATURES = [...CLEAN_FEATURES, 'gender_encoded'];

// ── In-memory TrainedModel store ────────────────────────────────────────────
// Models are plain objects with a save() that writes back into the store, so
// isActive changes are observable exactly as they would be in MongoDB.
function installFakeStore(docs) {
  const store = docs.map((d) => ({ ...d }));

  const originals = {
    updateMany: TrainedModel.updateMany,
    countDocuments: TrainedModel.countDocuments,
    find: TrainedModel.find,
    findById: TrainedModel.findById,
    deleteOne: TrainedModel.deleteOne,
    deleteMany: TrainedModel.deleteMany,
    findByIdAndDelete: TrainedModel.findByIdAndDelete,
  };

  // Any delete reaching the model layer is a test failure: deactivation must
  // never remove a model. Tracked rather than allowed.
  const deleteCalls = [];
  TrainedModel.deleteOne = async (...a) => { deleteCalls.push(['deleteOne', a]); return { deletedCount: 0 }; };
  TrainedModel.deleteMany = async (...a) => { deleteCalls.push(['deleteMany', a]); return { deletedCount: 0 }; };
  TrainedModel.findByIdAndDelete = async (...a) => { deleteCalls.push(['findByIdAndDelete', a]); return null; };

  const matches = (doc, filter) => {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '_id' && cond && typeof cond === 'object' && '$ne' in cond) {
        if (String(doc._id) === String(cond.$ne)) return false;
      } else if (key === '_id') {
        if (String(doc._id) !== String(cond)) return false;
      } else if (doc[key] !== cond) return false;
    }
    return true;
  };

  TrainedModel.updateMany = async (filter, update) => {
    let modified = 0;
    for (const doc of store) {
      if (!matches(doc, filter)) continue;
      Object.assign(doc, update.$set || {});
      modified += 1;
    }
    return { modifiedCount: modified };
  };
  TrainedModel.countDocuments = async (filter = {}) => store.filter((d) => matches(d, filter)).length;
  TrainedModel.find = (filter = {}) => {
    const result = store.filter((d) => matches(d, filter));
    const chain = { select: () => chain, lean: async () => result.map((d) => ({ ...d })), then: (r) => r(result) };
    return chain;
  };
  TrainedModel.findById = async (id) => {
    const doc = store.find((d) => String(d._id) === String(id));
    if (!doc) return null;
    return Object.assign(doc, { save: async () => doc });
  };

  return {
    store,
    deleteCalls,
    activeVersions: () => store.filter((d) => d.isActive).map((d) => d.version).sort(),
    get: (version) => {
      const doc = store.find((d) => d.version === version);
      return Object.assign(doc, { save: async () => doc });
    },
    restore: () => Object.assign(TrainedModel, originals),
  };
}

/** Replace smokeTestModel for one case; returns a restore function. */
function stubSmokeTest(impl) {
  const original = modelManager.smokeTestModel;
  modelManager.smokeTestModel = impl;
  return () => { modelManager.smokeTestModel = original; };
}

const PASSING_SMOKE = async () => ({
  ok: true,
  checks: [
    { name: 'artifact_present', ok: true, detail: 'stub' },
    { name: 'features_supported', ok: true, detail: 'stub' },
    { name: 'test_prediction', ok: true, detail: 'stub' },
  ],
  prediction: { risk_category: 'Low', probabilities: { Low: 1, Medium: 0, High: 0 } },
  error: null,
  durationMs: 0,
});

async function run() {
  const fixtures = [
    { _id: 'id-v1', version: 1, status: 'completed', modelPath: '/fake/v1.joblib', featuresUsed: GENDER_FEATURES, isActive: true },
    { _id: 'id-v2', version: 2, status: 'completed', modelPath: '/fake/v2.joblib', featuresUsed: CLEAN_FEATURES, isActive: false },
    { _id: 'id-v3', version: 3, status: 'completed', modelPath: '/fake/v3.joblib', featuresUsed: CLEAN_FEATURES, isActive: false },
    { _id: 'id-v4', version: 4, status: 'completed', modelPath: '/fake/v4.joblib', featuresUsed: CLEAN_FEATURES, isActive: false },
  ];

  // ── 1 + 3 + 4: activate a compatible model, previous one is deactivated,
  //              exactly one stays active ───────────────────────────────────
  {
    const db = installFakeStore(fixtures);
    const restoreSmoke = stubSmokeTest(PASSING_SMOKE);

    assert.deepStrictEqual(db.activeVersions(), [1], 'v1 is active to begin with');

    const v4 = db.get(4);
    const preflight = await runActivationPreflight(v4);
    assert.strictEqual(preflight.ok, true, 'a compatible, file-backed, smoke-tested model must pass preflight');
    assert.strictEqual(preflight.blocker, null);

    const result = await performModelActivation(v4);

    assert.strictEqual(result.activeCount, 1, 'activation reports exactly one active model');
    assert.deepStrictEqual(db.activeVersions(), [4], 'only v4 is active after activation');
    assert.strictEqual(db.store.find((d) => d.version === 1).isActive, false, 'v1 was deactivated');
    // 7. Deactivation is a flag change, never a delete.
    assert.strictEqual(db.store.length, 4, 'no model document was removed');
    assert.strictEqual(db.store.find((d) => d.version === 1).modelPath, '/fake/v1.joblib',
      'the deactivated model keeps its artifact path');
    assert.deepStrictEqual(db.deleteCalls, [], 'activation must never delete any model document');

    restoreSmoke();
    db.restore();
  }

  // ── 2: an incompatible model is refused ──────────────────────────────────
  {
    const db = installFakeStore(fixtures);
    const restoreSmoke = stubSmokeTest(PASSING_SMOKE);

    const v1 = db.get(1);
    const blocker = getModelActivationBlocker(v1);
    assert.ok(blocker && /features no longer supported/i.test(blocker),
      'the gender_encoded model must be refused by the document-level gate');

    const preflight = await runActivationPreflight(v1);
    assert.strictEqual(preflight.ok, false, 'preflight must refuse an incompatible model');
    assert.strictEqual(preflight.smokeTest, null,
      'an incompatible model must be refused BEFORE spending a Python process on a smoke test');

    restoreSmoke();
    db.restore();
  }

  // ── 5: rollback from v4 to an earlier compatible model (v2) ──────────────
  {
    const db = installFakeStore([
      { _id: 'id-v1', version: 1, status: 'completed', modelPath: '/fake/v1.joblib', featuresUsed: GENDER_FEATURES, isActive: false },
      { _id: 'id-v2', version: 2, status: 'completed', modelPath: '/fake/v2.joblib', featuresUsed: CLEAN_FEATURES, isActive: false },
      { _id: 'id-v4', version: 4, status: 'completed', modelPath: '/fake/v4.joblib', featuresUsed: CLEAN_FEATURES, isActive: true },
    ]);
    const restoreSmoke = stubSmokeTest(PASSING_SMOKE);

    assert.deepStrictEqual(db.activeVersions(), [4], 'v4 is active before rollback');

    const v2 = db.get(2);
    const preflight = await runActivationPreflight(v2);
    assert.strictEqual(preflight.ok, true, 'rollback target must pass the same preflight as a forward switch');

    await performModelActivation(v2);

    assert.deepStrictEqual(db.activeVersions(), [2], 'rollback makes v2 the only active model');
    assert.strictEqual(db.store.find((d) => d.version === 4).isActive, false, 'v4 was deactivated by the rollback');
    assert.strictEqual(db.store.find((d) => d.version === 4).modelPath, '/fake/v4.joblib',
      'the rolled-back-from model keeps its artifact and can be re-activated');
    assert.strictEqual(db.store.length, 3, 'rollback removed no model');
    assert.deepStrictEqual(db.deleteCalls, [], 'rollback must never delete any model document');

    restoreSmoke();
    db.restore();
  }

  // ── 6: a model that fails its prediction smoke test is refused ───────────
  {
    const db = installFakeStore(fixtures);
    const restoreSmoke = stubSmokeTest(async () => ({
      ok: false,
      checks: [
        { name: 'artifact_present', ok: true, detail: 'stub' },
        { name: 'features_supported', ok: true, detail: 'stub' },
        { name: 'test_prediction', ok: false, detail: 'Test prediction failed: boom' },
      ],
      prediction: null,
      error: 'Test prediction failed: boom',
      durationMs: 3,
    }));

    const v4 = db.get(4);
    const preflight = await runActivationPreflight(v4);

    assert.strictEqual(preflight.ok, false, 'a failed smoke test must block activation');
    assert.ok(/smoke test failed/i.test(preflight.blocker), 'the blocker must say the smoke test failed');
    assert.ok(/boom/.test(preflight.blocker), 'the blocker must carry the underlying reason');
    assert.ok(preflight.smokeTest, 'the failing smoke-test detail must be returned for the UI to display');
    // The critical part: nothing changed.
    assert.deepStrictEqual(db.activeVersions(), [1], 'a failed preflight must leave the active model untouched');

    restoreSmoke();
    db.restore();
  }

  // ── 6b: the REAL smoke test, unstubbed, against a missing artifact ───────
  // Proves the failure path is genuine and not an artifact of the stub above.
  {
    const missing = {
      _id: 'id-missing',
      status: 'completed',
      version: 99,
      modelPath: path.join('uploads', 'models', '__definitely_not_a_real_model__.joblib'),
      featuresUsed: CLEAN_FEATURES,
    };
    assert.ok(!fs.existsSync(missing.modelPath), 'the fixture path must really not exist');

    const smoke = await modelManager.smokeTestModel(missing);
    assert.strictEqual(smoke.ok, false, 'a missing artifact must fail the smoke test');
    const artifactCheck = smoke.checks.find((c) => c.name === 'artifact_present');
    assert.ok(artifactCheck && artifactCheck.ok === false, 'the artifact_present check must be the one that fails');
    assert.ok(/not found/i.test(smoke.error), 'the error must say the file was not found');
    assert.strictEqual(smoke.prediction, null, 'no prediction is reported when the artifact is missing');
  }

  // ── 7 + 8: deactivate-all returns to rule-based and deletes nothing ──────
  {
    const db = installFakeStore([
      { _id: 'id-v2', version: 2, status: 'completed', modelPath: '/fake/v2.joblib', featuresUsed: CLEAN_FEATURES, isActive: false },
      { _id: 'id-v4', version: 4, status: 'completed', modelPath: '/fake/v4.joblib', featuresUsed: CLEAN_FEATURES, isActive: true },
    ]);

    const result = await performModelDeactivation();

    assert.strictEqual(result.deactivated, 1, 'exactly one model was deactivated');
    assert.deepStrictEqual(result.previous, [{ version: 4, modelPath: '/fake/v4.joblib' }],
      'the response must name what was deactivated, so it can be re-activated later');
    assert.deepStrictEqual(db.activeVersions(), [], 'no model is active — new predictions use the rule-based fallback');
    assert.strictEqual(db.store.length, 2, 'deactivation removed no model document');
    assert.strictEqual(db.store.find((d) => d.version === 4).modelPath, '/fake/v4.joblib',
      'the deactivated model keeps its artifact path');
    assert.deepStrictEqual(db.deleteCalls, [], 'deactivation must never delete anything');

    // And it must be re-activatable straight afterwards — deactivation is not
    // a one-way door.
    const restoreSmoke = stubSmokeTest(PASSING_SMOKE);
    const v4 = db.get(4);
    assert.strictEqual((await runActivationPreflight(v4)).ok, true, 'a deactivated model stays activatable');
    await performModelActivation(v4);
    assert.deepStrictEqual(db.activeVersions(), [4], 're-activation after deactivation works');
    restoreSmoke();

    db.restore();
  }

  // ── 4b: the invariant is verified, not assumed ───────────────────────────
  // If the post-write count says something other than 1 even after a repair
  // attempt, activation must FAIL loudly rather than report success.
  {
    const origUpdateMany = TrainedModel.updateMany;
    const origCount = TrainedModel.countDocuments;
    TrainedModel.updateMany = async () => ({ modifiedCount: 0 }); // a broken deactivation
    TrainedModel.countDocuments = async () => 2;                  // two models stay active

    const doc = { _id: 'x', status: 'completed', modelPath: '/fake/x.joblib', featuresUsed: CLEAN_FEATURES, isActive: false, save: async () => {} };
    await assert.rejects(
      () => performModelActivation(doc),
      /left 2 active model\(s\) instead of exactly 1/,
      'a violated single-active invariant must throw rather than pass silently'
    );

    TrainedModel.updateMany = origUpdateMany;
    TrainedModel.countDocuments = origCount;
  }

  // ── Probe construction ───────────────────────────────────────────────────
  // The probe must supply every feature the model claims to use, or the smoke
  // test would fail for the wrong reason.
  {
    const scoreProbe = modelManager.buildSmokeTestProbe({ featuresUsed: CLEAN_FEATURES });
    CLEAN_FEATURES.forEach((f) => assert.ok(f in scoreProbe, `probe must supply ${f}`));
    assert.strictEqual(scoreProbe.communication_score, 70);
    assert.strictEqual(scoreProbe.age_months, 60);

    const questionFeatures = ['Q01', 'Q17', 'Q34', 'age_months'];
    const questionProbe = modelManager.buildSmokeTestProbe({ featuresUsed: questionFeatures });
    questionFeatures.forEach((f) => assert.ok(f in questionProbe, `probe must supply ${f}`));
    assert.strictEqual(questionProbe.Q01, 2, 'question features get a valid 0/1/2 answer encoding');

    // A document with no recorded features still gets a usable probe covering
    // both known feature sets — the artifact is authoritative there.
    const fallbackProbe = modelManager.buildSmokeTestProbe({ featuresUsed: [] });
    assert.ok('overall_score' in fallbackProbe && 'Q34' in fallbackProbe,
      'the fallback probe must cover both feature sets');
  }

  console.log('Model activation/rollback safety tests OK — activate, refuse, deactivate, single-active, rollback, failed smoke test, artifacts preserved');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
