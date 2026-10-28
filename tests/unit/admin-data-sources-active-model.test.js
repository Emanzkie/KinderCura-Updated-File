// Admin Data Sources showed "Model v4": GET /api/admin/dataset-pipeline/status
// only returned the model trained from the page's latest generated dataset,
// which was a candidate, while v5 was the model serving predictions. The
// response now carries activeModel (TrainedModel isActive), read as stored,
// and null when no model is active.
//
// No DB: models and the pipeline environment check are stubbed, and the real
// handler is called from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const TrainedModel = require('../../models/TrainedModel');
const TrainingDataset = require('../../models/TrainingDataset');
const datasetPipeline = require('../../services/datasetPipeline');
const router = require('../../routes/admin');

const results = [];
const ok = (m) => results.push(m);
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};

const oid = () => new mongoose.Types.ObjectId();
const pipelineDataset = { _id: oid(), name: 'Synthetic Model Dataset — 49,311 records', status: 'trained', createdAt: new Date('2026-09-03'), syntheticPipeline: { datasetVersion: 'syn-20260903' }, provenance: { sourceType: 'synthetic' } };
const candidate = { _id: oid(), version: 4, status: 'completed', isActive: false, datasetId: pipelineDataset._id, accuracy: 0.632, trainedAt: new Date('2026-09-03T01:40:35Z') };
const activeDataset = { _id: oid(), name: 'KinderCura Synthetic Training Dataset V2', rowCount: 50000, createdAt: new Date('2026-10-06T10:52:54Z'), syntheticPipeline: null };
const active = {
  _id: oid(), version: 5, status: 'completed', isActive: true, datasetId: activeDataset, featureSetType: 'score_based',
  trainedAt: new Date('2026-10-07T11:03:48Z'), activatedAt: new Date('2026-10-07T11:10:00Z'),
  accuracy: 0.6969, precision: 0.7, recall: 0.6969, f1Score: 0.69, trainingSamples: 40000, testSamples: 10000, classNames: ['High', 'Low', 'Medium'],
};

let activeDoc = active;
TrainingDataset.findOne = () => chain(pipelineDataset);
TrainingDataset.countDocuments = async () => 2;
TrainedModel.findOne = (q) => chain(q && q.isActive ? activeDoc : candidate);
datasetPipeline.checkPipelineEnvironment = async () => ({ ok: true });

const handler = (() => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/dataset-pipeline/status' && l.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
})();
const call = () => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
  };
  Promise.resolve(handler({ user: { role: 'admin' }, method: 'GET', originalUrl: '/test' }, res)).catch(reject);
});

(async () => {
  let r = await call();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.model.version, 4, 'the generated dataset\'s own model is still reported as before');
  const a = r.body.activeModel;
  assert.strictEqual(a.version, 5, 'activeModel is the isActive model, not the generated dataset\'s');
  assert.strictEqual(a.trainedAt.getTime(), active.trainedAt.getTime());
  assert.strictEqual(a.accuracy, 0.6969);
  assert.strictEqual(a.f1Score, 0.69);
  assert.strictEqual(a.testSamples, 10000);
  assert.deepStrictEqual(a.dataset, {
    id: String(activeDataset._id), name: 'KinderCura Synthetic Training Dataset V2', rowCount: 50000,
    uploadedAt: activeDataset.createdAt, pipelineVersion: null,
  }, 'the stored dataset name is sent unchanged; the page decides how to show it');
  ok('activeModel is the model serving predictions (v5), with its stored training date, metrics and dataset');

  activeDoc = null;
  r = await call();
  assert.strictEqual(r.body.activeModel, null, 'no active model: null, never a guess');
  ok('no active model: activeModel is null');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Admin Data Sources active model tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
