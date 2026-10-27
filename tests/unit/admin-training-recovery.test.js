// Model training can no longer get stuck on "training" (ADMIN bug scan C5, C14).
//
//   C5  On a serverless host the response was sent and training continued in
//       the background, which the host may freeze. The dataset then stayed
//       'training' forever and the page disabled Retrain and Delete. A run
//       older than the trainer's own limit is now marked failed (on listing,
//       training or deleting) so it can be retried, and the background run
//       asks the host to stay alive until it settles.
//   C14 An unknown feature set reached the trainer only after the dataset had
//       been claimed; it is now refused first.
//
// No DB, no Python: models and the ML manager are stubbed, the real admin
// router runs in-process.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const User = require('../../models/User');
const TrainingDataset = require('../../models/TrainingDataset');
const TrainedModel = require('../../models/TrainedModel');
const fileStorage = require('../../services/fileStorage');
const modelManager = require('../../ml/model_manager');
const adminRouter = require('../../routes/admin');

const results = [];
const ok = (label) => results.push(label);
const chain = (value) => { const q = { select: () => q, lean: () => q, sort: () => q, populate: () => q, then: (a, b) => Promise.resolve(value).then(a, b) }; return q; };
const newId = () => new mongoose.Types.ObjectId();
const MINUTE = 60 * 1000;

const datasets = new Map();
const models = new Map();
const statusMatches = (status, cond) => (typeof cond === 'string' ? status === cond : cond && cond.$ne !== undefined ? status !== cond.$ne : true);
const before = (date, cond) => !cond || !cond.$lt || new Date(date) < cond.$lt;
const inIds = (id, cond) => !cond || !cond.$in || cond.$in.some((x) => String(x) === String(id));
const datasetMatches = (d, q) => (!q._id || (q._id.$in ? inIds(d._id, q._id) : String(d._id) === String(q._id)))
  && (!q.status || statusMatches(d.status, q.status)) && before(d.updatedAt, q.updatedAt);
const asDoc = (d) => ({ ...d, async save() { datasets.set(String(d._id), { ...datasets.get(String(d._id)), ...this, updatedAt: new Date() }); } });

TrainingDataset.find = (q = {}) => chain([...datasets.values()].filter((d) => datasetMatches(d, q)).map((d) => ({ ...d })));
TrainingDataset.findById = (id) => { const d = datasets.get(String(id)); return chain(d ? asDoc(d) : null); };
TrainingDataset.updateMany = async (q, { $set }) => {
  for (const d of datasets.values()) if (datasetMatches(d, q)) Object.assign(d, $set, { updatedAt: new Date() });
};
TrainingDataset.findOneAndUpdate = async (q, { $set }) => {
  const d = [...datasets.values()].find((x) => datasetMatches(x, q));
  if (!d) return null;
  Object.assign(d, $set, { updatedAt: new Date() });
  return { ...d };
};
TrainingDataset.findOneAndDelete = async (q) => {
  const d = [...datasets.values()].find((x) => datasetMatches(x, q));
  if (d) datasets.delete(String(d._id));
  return d || null;
};
TrainingDataset.exists = async (q) => (datasets.has(String(q._id)) ? { _id: q._id } : null);
TrainedModel.updateMany = async (q, { $set }) => {
  for (const m of models.values()) {
    if (inIds(m.datasetId, q.datasetId) && statusMatches(m.status, q.status) && before(m.createdAt, q.createdAt)) Object.assign(m, $set);
  }
};
TrainedModel.find = () => chain([]);
TrainedModel.findOne = () => chain(null);
TrainedModel.countDocuments = async () => 0;
TrainedModel.create = async (doc) => { const m = { _id: newId(), createdAt: new Date(), ...doc, async save() { models.set(String(this._id), this); } }; models.set(String(m._id), m); return m; };

const CSV = 'communication_score,social_score,cognitive_score,motor_score,overall_score,risk_category\n1,1,1,1,1,Low\n2,2,2,2,2,High\n';
fileStorage.readStored = async () => Buffer.from(CSV);
let trainCalls = 0;
let finishTraining;
modelManager.resolveDatasetPath = () => null;
modelManager.checkPythonEnvironment = async () => ({ ok: true });
modelManager.trainModel = () => { trainCalls += 1; return new Promise((resolve) => { finishTraining = resolve; }); };

const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  const adminId = String(newId());
  User.findById = () => chain({ _id: adminId, role: 'admin', status: 'active' });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET);
  const call = (method, url, body) => quiet(async () => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  const addDataset = (data) => {
    const id = newId();
    datasets.set(String(id), { _id: id, name: 'ds', filePath: `/uploads/datasets/${id}.csv`, storedName: `${id}.csv`, status: 'uploaded', createdAt: new Date(), updatedAt: new Date(), ...data });
    return String(id);
  };

  try {
    // ── Abandoned runs are released ───────────────────────────────────────
    const abandoned = addDataset({ status: 'training', updatedAt: new Date(Date.now() - 40 * MINUTE) });
    const running = addDataset({ status: 'training', updatedAt: new Date(Date.now() - 2 * MINUTE) });
    const abandonedModel = String(newId());
    models.set(abandonedModel, { _id: abandonedModel, datasetId: abandoned, status: 'training', createdAt: new Date(Date.now() - 40 * MINUTE) });

    let r = await call('GET', '/api/admin/training/datasets');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const listed = Object.fromEntries(r.body.datasets.map((d) => [d.id, d]));
    assert.strictEqual(listed[abandoned].status, 'failed', 'a run abandoned 40 minutes ago is marked failed');
    assert.match(listed[abandoned].errorMessage, /train this dataset again/);
    assert.strictEqual(listed[running].status, 'training', 'a run started 2 minutes ago is left alone');
    assert.strictEqual(models.get(abandonedModel).status, 'failed', 'its placeholder model is marked failed too');
    assert.strictEqual(r.body.summary.processing, 1);
    ok('listing datasets marks abandoned training runs failed and leaves live ones alone');

    // ── Unknown feature set refused before anything is claimed ────────────
    const fresh = addDataset({});
    r = await call('POST', `/api/admin/training/${fresh}/train`, { featureSet: 'everything' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /score_based, question_based/);
    assert.strictEqual(datasets.get(fresh).status, 'uploaded', 'the dataset is not claimed');
    assert.strictEqual(trainCalls, 0);
    ok('an unknown model type is refused before the dataset is marked training');

    // ── A live run blocks retrain and delete; an abandoned one does not ───
    r = await call('POST', `/api/admin/training/${running}/train`, {});
    assert.strictEqual(r.status, 409);
    r = await call('DELETE', `/api/admin/training/${running}`);
    assert.strictEqual(r.status, 409, 'a live run cannot be deleted from under itself');
    assert(datasets.has(running));

    datasets.get(running).updatedAt = new Date(Date.now() - 20 * MINUTE);
    r = await call('POST', `/api/admin/training/${running}/train`, { featureSet: 'score_based' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(datasets.get(running).status, 'training', 'the abandoned run can be retrained straight away');
    assert.strictEqual(trainCalls, 1);
    finishTraining({ model_path: 'm.joblib', accuracy: 0.9, precision: 0.9, recall: 0.9, f1: 0.9, class_names: ['Low', 'High'], training_samples: 2, test_samples: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(datasets.get(running).status, 'trained');
    ok('a live run blocks Retrain and Delete; once abandoned it can be retrained and completes normally');

    const stuckForDelete = addDataset({ status: 'training', updatedAt: new Date(Date.now() - 60 * MINUTE) });
    r = await call('DELETE', `/api/admin/training/${stuckForDelete}`);
    assert.strictEqual(r.status, 200);
    assert(!datasets.has(stuckForDelete));
    r = await call('DELETE', '/api/admin/training/not-an-id');
    assert.strictEqual(r.status, 404);
    ok('an abandoned run can be deleted, and a malformed id is a 404');

    // ── JSON datasets and the chosen model type (C15, C16) ────────────────
    const v = modelManager.validateTrainingDataset(JSON.stringify([
      { communication_score: 1, social_score: 1, cognitive_score: 1, motor_score: 1, overall_score: 1, risk_category: 'low' },
      { communication_score: 2, social_score: 2, cognitive_score: 2, motor_score: 2, overall_score: 2, risk_category: 'High' },
    ]), 'score_based', 'json');
    assert.strictEqual(v.ok, true, JSON.stringify(v));
    assert.deepStrictEqual(v.labelCounts, { Low: 1, High: 1 });
    assert.strictEqual(modelManager.validateTrainingDataset('{not json', 'score_based', 'json').ok, false);
    assert.strictEqual(modelManager.validateTrainingDataset('{"a":1}', 'score_based', 'json').ok, false);
    assert.strictEqual(modelManager.validateTrainingDataset(JSON.stringify([{ communication_score: 1, risk_category: 'Low' }]), 'score_based', 'json').ok, false);
    ok('JSON datasets are validated as JSON (rows, required columns, labels)');

    const savedRead = fileStorage.readStored;
    fileStorage.readStored = async () => Buffer.from(JSON.stringify([
      { communication_score: 1, social_score: 1, cognitive_score: 1, motor_score: 1, overall_score: 1, risk_category: 'Low' },
    ]));
    let trainedWith = null;
    modelManager.trainModel = (_p, _id, opts) => { trainedWith = opts; return new Promise(() => {}); };
    const jsonDataset = addDataset({ storedName: 'x.json', filePath: '/uploads/datasets/x.json' });
    r = await call('POST', `/api/admin/training/${jsonDataset}/train`, { featureSet: 'score_based' });
    fileStorage.readStored = savedRead;
    assert.strictEqual(r.status, 200, `a JSON dataset from storage can be trained: ${JSON.stringify(r.body)}`);
    assert.strictEqual(trainedWith.featureSet, 'score_based');

    r = await call('POST', `/api/admin/training/${fresh}/train`, { featureSet: 'question_based' });
    assert.strictEqual(r.status, 400, 'a score-only CSV is refused for question-based training');
    assert.match(r.body.error, /Q01/);
    ok('the requested model type reaches the trainer, and JSON datasets from storage train');

    // ── Upload limits (C17) ───────────────────────────────────────────────
    const upload = async (name, content) => quiet(async () => {
      const fd = new FormData();
      fd.append('dataset', new Blob([content]), name);
      const res = await fetch(`${base}/api/admin/training/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
    r = await upload('big.csv', Buffer.alloc(4 * 1024 * 1024 + 10, 'a'));
    assert.strictEqual(r.status, 413);
    assert.match(r.body.error, /4 MB/);
    r = await upload('labels.csv', 'name,age\nA,3\n');
    assert.strictEqual(r.status, 400, 'a file no model type could train on is refused at upload');
    assert.match(r.body.error, /cannot be trained/);
    r = await upload('broken.json', '{not json');
    assert.strictEqual(r.status, 400);
    const datasetDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'datasets');
    const leftovers = fs.existsSync(datasetDir) ? fs.readdirSync(datasetDir).filter((f) => /_(labels\.csv|broken\.json|big\.csv)$/.test(f)) : [];
    assert.deepStrictEqual(leftovers, [], 'a refused upload leaves no file behind');
    ok('uploads over 4 MB get a clear 413, and untrainable or unreadable files are refused at upload');
  } finally {
    server.closeAllConnections();
    server.close();
  }

  console.log(results.map((m) => `  ok - ${m}`).join('\n'));
  console.log(`Admin training recovery tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
