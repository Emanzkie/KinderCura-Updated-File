// scripts/repredict-ml-fallbacks.js: re-runs the RF prediction only for
// results whose ML step failed for a technical reason, only with the model
// that was active at that time, and never stores a second fallback.
// Models and buildPredictionForStorage are stubbed: no DB, no ML.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const AssessmentResult = require('../../models/AssessmentResult');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const TrainedModel = require('../../models/TrainedModel');
const Child = require('../../models/Child');
const assessmentProgress = require('../../services/assessmentProgress');
const script = require('../../scripts/repredict-ml-fallbacks');

const chain = (v) => { const q = { select: () => q, sort: () => q, lean: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
const oid = () => String(new mongoose.Types.ObjectId());

const NOW = new Date('2026-10-31T08:00:00Z');
const FAILED_AT = new Date('2026-10-30T14:53:54Z');
const rb = (reason, at = FAILED_AT) => ({ source: 'rule_based', riskCategory: null, careStage: 'intermediate', mlUnavailableReason: reason, generatedAt: at });
const resultDoc = (prediction, childId = 'kid-1') => ({ _id: oid(), assessmentId: oid(), childId, communicationScore: 50, socialScore: 60, cognitiveScore: 55, motorScore: 59, overallScore: 56, prediction });
const mlPrediction = (version = 5) => ({ source: 'ml', modelVersion: version, riskCategory: 'Medium', careStage: 'intermediate', mlUnavailableReason: null, generatedAt: NOW });

function stubWorld({ results, activeModel = { version: 5, activatedAt: null }, previousMlVersion = 5, dob = '2022-01-05', prediction = mlPrediction() }) {
  const calls = { updates: [], predicted: [], answersQuery: null };
  TrainedModel.findOne = () => chain(activeModel);
  AssessmentResult.find = () => chain(results);
  AssessmentResult.findOne = () => chain(previousMlVersion == null ? null : { prediction: { modelVersion: previousMlVersion } });
  AssessmentResult.updateOne = async (filter, update) => { calls.updates.push({ filter, update }); return { modifiedCount: 1 }; };
  Child.findById = () => chain(dob ? { dateOfBirth: new Date(dob) } : {});
  AssessmentAnswer.find = (q) => { calls.answersQuery = q; return chain([{ questionId: 'Q01', answer: 'yes' }, { questionId: 'Q05', answer: 'no' }]); };
  assessmentProgress.buildPredictionForStorage = async (scores, childId, answers) => { calls.predicted.push({ scores, childId, answers }); return prediction; };
  return calls;
}

const quiet = () => {};
const results = [];

(async () => {
  // 1. Only technical-failure reasons qualify.
  assert.ok(script.isRetryableReason('model_artifact_not_found: Model artifact not found on local disk (key x)'));
  assert.ok(script.isRetryableReason('prediction_failed: Model file not found: /opt/x'));
  assert.ok(script.isRetryableReason('ml_service_unreachable: timeout'));
  for (const r of ['no_active_model', 'active_model_incompatible', 'question_answers_unavailable', 'unrecognized_risk_category:X', 'model_artifact_too_large: big', null, undefined, '']) {
    assert.ok(!script.isRetryableReason(r), `not retryable: ${r}`);
  }
  results.push('only technical ML failures are retried; no_active_model, incompatible models and legacy records are not');

  // 2. Dry run: predicts with the stored scores and core-bank answers, writes nothing.
  const target = resultDoc(rb('model_artifact_not_found: Model artifact not found on local disk (key k)'));
  let calls = stubWorld({ results: [target, resultDoc(rb('no_active_model'))] });
  let out = await script.run({ now: NOW, log: quiet, backup: () => { throw new Error('no backup in dry run'); } });
  assert.strictEqual(out.planned.length, 1);
  assert.strictEqual(out.written, 0);
  assert.deepStrictEqual(calls.updates, [], 'dry run writes nothing');
  assert.deepStrictEqual(calls.predicted[0].scores, { communicationScore: 50, socialScore: 60, cognitiveScore: 55, motorScore: 59, overallScore: 56 });
  assert.deepStrictEqual(calls.predicted[0].answers, { Q01: 'yes', Q05: 'no' });
  assert.deepStrictEqual(calls.answersQuery, { assessmentId: target.assessmentId, origin: 'core_bank' });
  results.push('dry run re-predicts from the stored scores and core-bank answers and writes nothing');

  // 3. Apply: backup first, then a conditional write of `prediction` only.
  calls = stubWorld({ results: [target] });
  const backups = [];
  out = await script.run({ apply: true, now: NOW, log: quiet, backup: async (rows) => { backups.push(rows); } });
  assert.strictEqual(out.written, 1);
  assert.strictEqual(backups.length, 1);
  assert.deepStrictEqual(backups[0], [{ resultId: target._id, prediction: target.prediction }]);
  assert.deepStrictEqual(calls.updates[0].filter, { _id: target._id, 'prediction.source': 'rule_based', 'prediction.mlUnavailableReason': target.prediction.mlUnavailableReason });
  assert.deepStrictEqual(Object.keys(calls.updates[0].update.$set), ['prediction']);
  assert.strictEqual(calls.updates[0].update.$set.prediction.source, 'ml');
  results.push('apply backs up the old prediction, then sets only `prediction`, conditional on the fallback still being stored');

  // 4. A re-run that falls back again is never stored.
  calls = stubWorld({ results: [target], prediction: { source: 'rule_based', riskCategory: null, mlUnavailableReason: 'model_artifact_not_found: again' } });
  out = await script.run({ apply: true, now: NOW, log: quiet, backup: async () => {} });
  assert.strictEqual(out.written, 0);
  assert.deepStrictEqual(calls.updates, []);
  assert.ok(/did not produce a v5 ML result/.test(out.skipped[0].reason));
  calls = stubWorld({ results: [target], prediction: mlPrediction(4) });
  out = await script.run({ apply: true, now: NOW, log: quiet, backup: async () => {} });
  assert.deepStrictEqual(calls.updates, [], 'a different model version is never stored');
  results.push('a second fallback, or a result from another model version, is reported and not stored');

  // 5. Model guard: the model in use at the failure must be today's active model.
  calls = stubWorld({ results: [target], previousMlVersion: 4 });
  out = await script.run({ apply: true, now: NOW, log: quiet, backup: async () => {} });
  assert.deepStrictEqual(calls.predicted, [], 'no prediction attempted');
  assert.ok(/was v4, active model is v5/.test(out.skipped[0].reason));
  calls = stubWorld({ results: [target], previousMlVersion: null });
  out = await script.run({ now: NOW, log: quiet });
  assert.ok(/was vunknown/.test(out.skipped[0].reason));
  calls = stubWorld({ results: [target], activeModel: { version: 5, activatedAt: new Date('2026-10-30T20:00:00Z') } });
  out = await script.run({ now: NOW, log: quiet });
  assert.ok(/activated after the failure/.test(out.skipped[0].reason));
  calls = stubWorld({ results: [target], activeModel: null });
  out = await script.run({ now: NOW, log: quiet });
  assert.strictEqual(out.skipped[0].reason, 'no active model today');
  results.push('skipped when the failure happened under another (or unknown) model, or no model is active');

  // 6. Age guard: age_months must not have changed since the submission.
  assert.strictEqual(script.ageMonthsAt('2022-01-05', FAILED_AT), script.ageMonthsAt('2022-01-05', NOW));
  calls = stubWorld({ results: [target] });
  out = await script.run({ now: new Date('2026-12-15T00:00:00Z'), log: quiet });
  assert.ok(/age_months has changed/.test(out.skipped[0].reason));
  assert.deepStrictEqual(calls.predicted, []);
  results.push('skipped when the child\'s age in months has changed since the submission');

  results.forEach((r) => console.log('ok -', r));
  console.log(`\nml-repredict-fallbacks: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
