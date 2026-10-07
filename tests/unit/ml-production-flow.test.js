// tests/unit/ml-production-flow.test.js
// End-to-end replay of the production ML flow, offline:
//   Render-style Node app (the real server.js routes, JWT auth)
//   -> "Vercel" (the real api/ml_train.py + api/ml_predict.py, routed by reading
//      vercel.json, with Vercel's 4.5 MB body limit)
//   -> "R2" (an in-memory S3-compatible bucket)
//   -> MongoDB replaced by an in-memory store patched onto the Mongoose models.
// Requires python with scikit-learn, pandas and joblib (ml/requirements.txt).
//
// Story: model v4 is active but recorded with a Windows path and has no
// artifact in R2 (the production state). A new assessment falls back with
// model_artifact_not_found; the admin retrains the existing dataset, activates
// the candidate, and the next new assessment is saved with an ML riskCategory
// that the parent results API and the pediatrician patient API both return.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUCKET = 'kindercura-ml-models';
const SECRET = 'test-ml-secret';
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

Object.assign(process.env, {
  USE_BLOB: 'true',
  R2_BUCKET: BUCKET,
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_REGION: 'auto',
  ML_SERVICE_SECRET: SECRET,
  JWT_SECRET: 'test-jwt-secret',
  APP_URL: 'https://kindercura.com',
});
delete process.env.USE_LOCAL_PYTHON;
delete process.env.VERCEL;
delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

// ── helpers ─────────────────────────────────────────────────────────────────
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function startMockR2() {
  const objects = new Map();
  const server = http.createServer(async (req, res) => {
    const parts = new URL(req.url, 'http://mock').pathname.replace(/^\/+/, '').split('/');
    const bucket = parts.shift();
    const key = decodeURIComponent(parts.join('/'));
    const body = await readBody(req);
    if (bucket !== BUCKET) { res.statusCode = 400; return res.end('wrong bucket'); }
    if (req.method === 'PUT') { objects.set(key, body); res.statusCode = 200; return res.end(); }
    if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
    const obj = objects.get(key);
    if (!obj) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Length', obj.length);
    return res.end(req.method === 'GET' ? obj : undefined);
  });
  const port = await listen(server);
  return { port, objects, close: () => server.close() };
}

function startPythonHandler(moduleName) {
  const script = `
import sys, os
from http.server import HTTPServer
sys.path.insert(0, r"${ROOT.replace(/\\/g, '/')}")
os.environ['ML_SERVICE_SECRET'] = "${SECRET}"
from ${moduleName} import handler
server = HTTPServer(('127.0.0.1', 0), handler)
print(f"READY:{server.server_address[1]}", flush=True)
server.serve_forever()
`;
  const proc = spawn('python', ['-c', script]);
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/READY:(\d+)/);
      if (m) resolve({ port: Number(m[1]), close: () => proc.kill() });
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => reject(new Error(`${moduleName} exited (${code}): ${err}`)));
  });
}

// Routes exactly as vercel.json does (first matching `src`, anchored), and
// enforces Vercel's request/response body limit.
async function startVercel(destPorts) {
  const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).routes;
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const pathname = new URL(req.url, 'http://x').pathname;
    const route = routes.find((r) => new RegExp(`^${r.src}$`).test(pathname));
    seen.push({ method: req.method, pathname, dest: route && route.dest, body });
    if (body.length > VERCEL_BODY_LIMIT) { res.statusCode = 413; return res.end('FUNCTION_PAYLOAD_TOO_LARGE'); }
    const port = destPorts[route && route.dest];
    if (!port) { res.statusCode = 502; return res.end(`no test backend for ${route && route.dest}`); }
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, async (upRes) => {
      const out = await readBody(upRes);
      if (out.length > VERCEL_BODY_LIMIT) { res.statusCode = 500; return res.end('FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE'); }
      res.writeHead(upRes.statusCode, upRes.headers);
      res.end(out);
    });
    up.end(body);
  });
  const port = await listen(server);
  return { port, seen, close: () => server.close() };
}

// ── in-memory Mongoose models ───────────────────────────────────────────────
function installMemoryModels(mongoose, models) {
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && (a instanceof Date || b instanceof Date ? +a === +b : String(a) === String(b)));
  const get = (doc, key) => key.split('.').reduce((o, p) => (o == null ? o : o[p]), doc);
  const isOps = (c) => c && typeof c === 'object' && !(c instanceof Date) && !(c instanceof mongoose.Types.ObjectId)
    && Object.keys(c).length && Object.keys(c).every((k) => k.startsWith('$'));
  function matches(doc, filter = {}) {
    return Object.entries(filter).every(([k, cond]) => {
      if (k === '$or') return cond.some((f) => matches(doc, f));
      const v = get(doc, k);
      if (!isOps(cond)) return same(v, cond);
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$ne') return !same(v, arg);
        if (op === '$in') return arg.some((a) => same(v, a));
        if (op === '$lt') return v < arg;
        if (op === '$exists') return (v !== undefined) === Boolean(arg);
        throw new Error(`memory model: unsupported operator ${op}`);
      });
    });
  }
  const sortDocs = (docs, sort) => (!sort ? docs : [...docs].sort((x, y) => {
    for (const [k, dir] of Object.entries(sort)) {
      const a = get(x, k); const b = get(y, k);
      if (same(a, b)) continue;
      const c = a == null ? -1 : b == null ? 1 : (a < b ? -1 : 1);
      return dir < 0 ? -c : c;
    }
    return 0;
  }));
  const query = (run) => {
    const o = {};
    const q = {
      sort(s) { o.sort = s; return q; },
      limit(n) { o.limit = n; return q; },
      select() { return q; },
      populate() { return q; },
      lean() { return q; },
      exec() { return Promise.resolve().then(() => run(o)); },
      then(a, b) { return q.exec().then(a, b); },
      catch(b) { return q.exec().catch(b); },
    };
    return q;
  };
  const stores = {};
  for (const [name, Model] of Object.entries(models)) {
    const docs = [];
    stores[name] = docs;
    const hydrate = (d) => {
      if (!d.save) Object.defineProperty(d, 'save', { value: async function save() { return this; }, enumerable: false });
      return d;
    };
    const apply = (d, upd) => Object.assign(d, upd.$set || upd);
    Model.find = (f) => query((o) => { const r = sortDocs(docs.filter((d) => matches(d, f)), o.sort); return o.limit ? r.slice(0, o.limit) : r; });
    Model.findOne = (f) => query((o) => sortDocs(docs.filter((d) => matches(d, f)), o.sort)[0] || null);
    Model.findById = (id) => query(() => docs.find((d) => same(d._id, id)) || null);
    Model.exists = async (f) => (docs.some((d) => matches(d, f)) ? { _id: 1 } : null);
    Model.countDocuments = async (f) => docs.filter((d) => matches(d, f)).length;
    Model.create = async (data) => { const d = hydrate({ _id: new mongoose.Types.ObjectId(), ...data }); docs.push(d); return d; };
    Model.updateMany = async (f, upd) => { const hit = docs.filter((d) => matches(d, f)); hit.forEach((d) => apply(d, upd)); return { modifiedCount: hit.length }; };
    Model.findByIdAndUpdate = (id, upd) => query(() => { const d = docs.find((x) => same(x._id, id)); if (d) apply(d, upd); return d || null; });
    Model.findOneAndUpdate = (f, upd, opts = {}) => query(() => {
      let d = docs.find((x) => matches(x, f));
      if (!d && opts.upsert) { d = hydrate({ _id: new mongoose.Types.ObjectId(), ...f }); docs.push(d); }
      if (d) apply(d, upd);
      return d || null;
    });
    Model.__insert = (data) => { const d = hydrate({ _id: new mongoose.Types.ObjectId(), ...data }); docs.push(d); return d; };
  }
  return stores;
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── test ────────────────────────────────────────────────────────────────────
async function run() {
  const r2 = await startMockR2();
  const train = await startPythonHandler('api.ml_train');
  const predict = await startPythonHandler('api.ml_predict');
  const vercel = await startVercel({ 'api/ml_train.py': train.port, 'api/ml_predict.py': predict.port });
  process.env.R2_ENDPOINT = `http://127.0.0.1:${r2.port}`;
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${vercel.port}`;

  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  const M = {
    TrainedModel: require('../../models/TrainedModel'),
    TrainingDataset: require('../../models/TrainingDataset'),
    Assessment: require('../../models/Assessment'),
    AssessmentAnswer: require('../../models/AssessmentAnswer'),
    AssessmentResult: require('../../models/AssessmentResult'),
    Child: require('../../models/Child'),
    User: require('../../models/User'),
    Appointment: require('../../models/Appointment'),
    CoreBankQuestion: require('../../models/CoreBankQuestion'),
    PediaCustomQuestionAssignment: require('../../models/PediaCustomQuestionAssignment'),
  };
  const db = installMemoryModels(mongoose, M);
  const fileStorage = require('../../services/fileStorage');
  const modelManager = require('../../ml/model_manager');
  assert.strictEqual(fileStorage.USE_BLOB, true);

  const app = require('../../server.js');
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;

  const tokenFor = (userId, role) => jwt.sign({ userId: String(userId), role }, process.env.JWT_SECRET);
  const call = async (method, url, token, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  // ── Seed production-like state ──
  const admin = M.User.__insert({ role: 'admin', firstName: 'Ada', lastName: 'Admin' });
  const parent = M.User.__insert({ role: 'parent', firstName: 'Pat', lastName: 'Parent', email: 'p@example.com' });
  const pedia = M.User.__insert({ role: 'pediatrician', firstName: 'Dee', lastName: 'Doc' });
  const child = M.Child.__insert({ firstName: 'Kid', lastName: 'One', parentId: parent._id, dateOfBirth: new Date(Date.now() - 5 * 365.25 * 864e5) });
  M.Appointment.__insert({ id: 1, childId: child._id, parentId: parent._id, pediatricianId: pedia._id, status: 'approved', appointmentDate: new Date() });
  const QIDS = Array.from({ length: 34 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`);
  const DOMAINS = ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'];
  QIDS.forEach((q) => M.CoreBankQuestion.__insert({ questionId: q, origin: 'core_bank' }));
  const scoreFeatures = ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'age_months'];
  const v4 = M.TrainedModel.__insert({
    version: 4, status: 'completed', isActive: true, featureSetType: 'score_based', featuresUsed: scoreFeatures,
    modelPath: 'C:/Users/user/Documents/KinderCura-by-Dumzkie/KinderCura System Final/uploads/models/kindercura_model_20260903_014033_913914.joblib',
  });
  // v4's dataset record survives, but its CSV never reached object storage.
  const v4Dataset = M.TrainingDataset.__insert({
    name: 'Synthetic Model Dataset — 49,311 records', storedName: '1756860000000_syn-20260903-50000_clean.csv',
    filePath: '/uploads/datasets/1756860000000_syn-20260903-50000_clean.csv',
    rowCount: 49311, status: 'trained', modelId: v4._id, provenance: { sourceType: 'synthetic' },
  });
  // The CSV the admin uploads. KC_TEST_DATASET points at a real file (e.g. the
  // generated 50,000-row dataset); the default is a seeded 15,000-row file
  // from the same generator (> 1 MB, so the gzip path to the trainer runs).
  let uploadCsv;
  if (process.env.KC_TEST_DATASET) {
    uploadCsv = fs.readFileSync(process.env.KC_TEST_DATASET);
  } else {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-flow-')), 'dataset.csv');
    const gen = spawnSync('python', [path.join(ROOT, 'ml/datasets/generate_kindercura_dataset.py'), '--rows', '15000', '--seed', '20261006',
      '--max-age-months', '107', '--unique', '--app-rounding', '--out', out], { encoding: 'utf8' });
    assert.strictEqual(gen.status, 0, gen.stderr);
    uploadCsv = fs.readFileSync(out);
  }
  const uploadRows = uploadCsv.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).length - 1;
  const adminToken = tokenFor(admin._id, 'admin');
  const parentToken = tokenFor(parent._id, 'parent');
  const pediaToken = tokenFor(pedia._id, 'pediatrician');

  const submitAssessment = async (answer) => {
    const answers = QIDS.map((q, i) => ({ questionId: q, domain: DOMAINS[i % 4], questionText: `Does your child do ${q}?`, answer: typeof answer === 'function' ? answer(i) : answer }));
    const r = await call('POST', '/assessments/submit', parentToken, { childId: String(child._id), answers });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return db.AssessmentResult.find((d) => String(d.assessmentId) === r.body.assessmentId);
  };

  try {
    // TEST A: ML health endpoints return JSON, right service, secret verified.
    const health = await modelManager.checkPythonEnvironment();
    assert.strictEqual(health.ok, true, health.error);
    assert.strictEqual(health.service, 'kindercura-ml-train');
    assert.strictEqual(health.secretVerified, true);
    const predictHealth = await modelManager.checkRemoteEndpoint('/api/py/predict', 'kindercura-ml-predict');
    assert.strictEqual(predictHealth.ok, true, predictHealth.error);
    assert.ok(vercel.seen.some((s) => s.pathname === '/api/py/train' && s.dest === 'api/ml_train.py'), 'vercel.json must route /api/py/train to the Python function');
    process.env.ML_SERVICE_SECRET = 'wrong-secret';
    const mismatch = await modelManager.checkPythonEnvironment();
    process.env.ML_SERVICE_SECRET = SECRET;
    assert.strictEqual(mismatch.ok, false);
    assert.match(mismatch.error, /does not match/);

    // Production diagnostics as the admin sees them, before the fix-up.
    const before = await call('GET', '/ml/diagnostics', adminToken);
    assert.strictEqual(before.status, 200, JSON.stringify(before.body));
    assert.strictEqual(before.body.mlService.train.ok, true);
    assert.strictEqual(before.body.objectStorage.ok, true);
    assert.strictEqual(before.body.activeModel.version, 4);
    assert.strictEqual(before.body.activeModel.artifact.found, false);
    assert.strictEqual(before.body.activeModel.portableReference, false);
    assert.strictEqual(before.body.datasets.find((d) => d.rows === 49311).found, false, 'the v4 dataset file is missing from object storage');
    assert.ok(before.body.problems.some((p) => /v4 artifact is missing/.test(p)));
    assert.strictEqual(before.body.sections.trainingService.ok, true);
    assert.strictEqual(before.body.sections.objectStorage.ok, true);
    assert.strictEqual(before.body.sections.activeModel.state, 'artifact_missing');
    assert.match(before.body.sections.activeModel.detail, /v4 \(legacy model\): artifact unavailable/);
    assert.strictEqual(before.body.readiness.canPredict, false);
    const modelsBefore = (await call('GET', '/ml/models', adminToken)).body.models;
    const v4Row = modelsBefore.find((m) => m.version === 4);
    assert.strictEqual(v4Row.legacy, true);
    assert.strictEqual(v4Row.artifactAvailable, false);
    assert.strictEqual(v4Row.artifactKey, 'uploads/models/kindercura_model_20260903_014033_913914.joblib');

    // Production symptom: a new assessment falls back, with the real reason.
    const fallback = await submitAssessment('no');
    assert.strictEqual(fallback.prediction.source, 'rule_based');
    assert.strictEqual(fallback.prediction.riskCategory, null);
    assert.match(fallback.prediction.mlUnavailableReason, /^model_artifact_not_found: .*key uploads\/models\/kindercura_model_20260903_014033_913914\.joblib/);
    assert.doesNotMatch(fallback.prediction.mlUnavailableReason, /opt\/render|C:\//);

    // Retraining the v4 dataset fails, naming the missing object-storage key.
    const lost = await call('POST', `/admin/training/${v4Dataset._id}/train`, adminToken, {});
    assert.strictEqual(lost.status, 404);
    assert.match(lost.body.error, /Dataset file not found in object storage \(key public\/uploads\/datasets\/1756860000000_syn-20260903-50000_clean\.csv\)/);

    // TEST B-E: Admin -> Training -> Upload Dataset (the real multipart route), then Process.
    const fd = new FormData();
    fd.append('dataset', new Blob([uploadCsv], { type: 'text/csv' }), 'kindercura_synthetic_training_dataset_50000.csv');
    fd.append('name', 'KinderCura Synthetic Training Dataset');
    fd.append('targetModule', 'assessment');
    fd.append('sourceType', 'synthetic');
    const uploadRes = await fetch(`${base}/admin/training/upload`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: fd });
    const uploaded = await uploadRes.json();
    assert.strictEqual(uploadRes.status, 201, JSON.stringify(uploaded));
    const dataset = db.TrainingDataset.find((d) => String(d._id) === uploaded.datasetId);
    assert.strictEqual(dataset.rowCount, uploadRows);
    assert.strictEqual(dataset.status, 'uploaded');
    assert.ok(r2.objects.get(`public/uploads/datasets/${dataset.storedName}`).equals(uploadCsv), 'uploaded CSV stored in R2 byte-for-byte');
    assert.strictEqual(dataset.storageKey, `public/uploads/datasets/${dataset.storedName}`, 'MongoDB records the exact R2 key');
    const ready = await call('GET', '/ml/diagnostics', adminToken);
    assert.strictEqual(ready.body.readiness.canTrain, true, 'a broken legacy model must not block training');

    // Process, double-clicked: exactly one training run starts.
    const [first, second] = await Promise.all([
      call('POST', `/admin/training/${dataset._id}/train`, adminToken, {}),
      call('POST', `/admin/training/${dataset._id}/train`, adminToken, {}),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], JSON.stringify([first.body, second.body]));
    const retrain = first.status === 200 ? first : second;
    assert.strictEqual(retrain.body.validation.rows, uploadRows);
    assert.strictEqual(retrain.body.validation.invalidLabels, 0);
    const v5 = await waitFor(() => db.TrainedModel.find((m) => m.version === 5 && m.status !== 'training'), 180000, 'v5 training');
    assert.strictEqual(db.TrainedModel.filter((m) => m.version >= 5).length, 1, 'the double click must not start a second run');
    assert.strictEqual(v5.status, 'completed', v5.errorMessage);
    assert.ok(vercel.seen.some((s) => s.method === 'POST' && s.pathname === '/api/py/train' && JSON.parse(s.body).dataset_content_gzip_base64), 'dataset sent gzipped to /api/py/train');
    assert.match(v5.modelPath, /^uploads\/models\/kindercura_model_\w+\.joblib$/, 'TrainedModel stores the R2 key, never a local path');
    assert.ok(r2.objects.has(v5.modelPath), 'artifact stored in R2');
    assert.ok(r2.objects.get(v5.modelPath).length < modelManager.MAX_REMOTE_ARTIFACT_BYTES);
    assert.notStrictEqual(v5.isActive, true, 'a new model is only a candidate');
    assert.strictEqual(v4.isActive, true, 'v4 stays active until a candidate is activated');
    assert.strictEqual(dataset.status, 'trained');
    assert.strictEqual(v5.totalRows, uploadRows, 'every uploaded row reaches training');
    assert.strictEqual(v5.rowsDropped, 0);

    // TEST F: candidate loads from R2 and passes the real smoke test, then activation.
    const smoke = await call('POST', `/ml/models/${v5._id}/smoke-test`, adminToken);
    assert.strictEqual(smoke.body.ok, true, JSON.stringify(smoke.body));
    const activate = await call('POST', `/ml/models/${v5._id}/activate`, adminToken);
    assert.strictEqual(activate.status, 200, JSON.stringify(activate.body));
    assert.strictEqual(v5.isActive, true);
    assert.strictEqual(v4.isActive, false);
    assert.strictEqual(db.TrainedModel.filter((m) => m.isActive).length, 1, 'exactly one active model');

    // A candidate whose artifact is gone cannot be switched to, and the active model stays.
    const broken = M.TrainedModel.__insert({ version: 0, status: 'completed', isActive: false, featureSetType: 'score_based', featuresUsed: scoreFeatures, modelPath: 'uploads/models/kindercura_model_missing.joblib' });
    const brokenRow = (await call('GET', '/ml/models', adminToken)).body.models.find((m) => m.version === 0);
    assert.strictEqual(brokenRow.lifecycleState, 'artifact_missing');
    assert.strictEqual(brokenRow.canActivate, false);
    const refused = await call('POST', `/ml/models/${broken._id}/activate`, adminToken);
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /smoke test failed: Model file not found/i);
    assert.strictEqual(v5.isActive, true, 'a failed switch leaves the active model active');
    assert.notStrictEqual(broken.isActive, true);

    // LOW / MEDIUM / HIGH profiles, predicted by the model through the real submit route.
    const profiles = [
      ['Low', (i) => (i % 9 === 0 ? 'no' : 'yes')],
      ['Medium', (i) => ['yes', 'sometimes', 'no'][i % 3]],
      ['High', (i) => (i % 9 === 0 ? 'yes' : 'no')],
    ];
    for (const [expected, answerFor] of profiles) {
      const rec = await submitAssessment(answerFor);
      assert.strictEqual(rec.prediction.source, 'ml', rec.prediction.mlUnavailableReason);
      assert.strictEqual(rec.prediction.riskCategory, expected, `overall ${rec.overallScore}: ${JSON.stringify(rec.prediction.probabilities)}`);
      const pv = await call('GET', `/assessments/${rec.assessmentId}/results`, parentToken);
      const pp = (await call('GET', '/assessments/pedia-patients', pediaToken)).body.patients.find((p) => p.childId === String(child._id));
      assert.strictEqual(pv.body.results.prediction.riskCategory, expected, 'parent API');
      assert.strictEqual(pp.prediction.riskCategory, expected, 'pediatrician API');
    }

    // TEST G-H: a NEW assessment is predicted by the model and persisted.
    const saved = await submitAssessment((i) => (i % 3 === 0 ? 'yes' : 'no'));
    assert.strictEqual(saved.prediction.source, 'ml', saved.prediction.mlUnavailableReason);
    assert.ok(['Low', 'Medium', 'High'].includes(saved.prediction.riskCategory));
    assert.strictEqual(saved.prediction.modelVersion, 5);
    assert.strictEqual(saved.prediction.mlUnavailableReason, null);
    const castCheck = new M.AssessmentResult({ ...saved, _id: undefined });
    assert.strictEqual(castCheck.validateSync(), undefined, 'saved prediction must satisfy the AssessmentResult schema');
    assert.strictEqual(castCheck.prediction.riskCategory, saved.prediction.riskCategory);

    // TEST I-J: the parent results API returns the stored value.
    const parentView = await call('GET', `/assessments/${saved.assessmentId}/results`, parentToken);
    assert.strictEqual(parentView.status, 200, JSON.stringify(parentView.body));
    assert.strictEqual(parentView.body.results.prediction.riskCategory, saved.prediction.riskCategory);
    assert.strictEqual(parentView.body.results.prediction.source, 'ml');

    // TEST K: the pediatrician patient API returns the same stored value.
    const pediaView = await call('GET', '/assessments/pedia-patients', pediaToken);
    assert.strictEqual(pediaView.status, 200, JSON.stringify(pediaView.body));
    const patient = pediaView.body.patients.find((p) => p.childId === String(child._id));
    assert.strictEqual(patient.prediction.riskCategory, saved.prediction.riskCategory);
    const history = await call('GET', `/assessments/${child._id}/history`, pediaToken);
    assert.strictEqual(history.body.assessments.find((a) => a.id === String(saved.assessmentId)).prediction.riskCategory, saved.prediction.riskCategory);

    // Both screens format the value with the same shared helper.
    global.window = {};
    require('../../js/shared/care-plan-labels.js');
    const label = global.window.KCCarePlan.riskCategoryLabel;
    assert.strictEqual(label(parentView.body.results.prediction.riskCategory, parentView.body.results.prediction.source), saved.prediction.riskCategory);
    assert.strictEqual(label(patient.prediction.riskCategory, patient.prediction.source), saved.prediction.riskCategory);
    const parentJs = fs.readFileSync(path.join(ROOT, 'js/parent/results.js'), 'utf8');
    const pediaJs = fs.readFileSync(path.join(ROOT, 'js/pedia/pediatrician-patients.js'), 'utf8');
    assert.ok(parentJs.includes('CP.riskCategoryLabel(prediction.riskCategory, prediction.source)'));
    assert.ok(pediaJs.includes('CP.riskCategoryLabel(prediction.riskCategory, prediction.source)'));

    // TEST L: a question_based model receives the assessment's Q01-Q34 answers.
    const retrainQ = await call('POST', `/admin/training/${dataset._id}/train`, adminToken, { featureSet: 'question_based' });
    assert.strictEqual(retrainQ.status, 200, JSON.stringify(retrainQ.body));
    const v6 = await waitFor(() => db.TrainedModel.find((m) => m.version === 6 && m.status !== 'training'), 180000, 'v6 training');
    assert.strictEqual(v6.status, 'completed', v6.errorMessage);
    assert.strictEqual((await call('POST', `/ml/models/${v6._id}/activate`, adminToken)).status, 200);
    const allYes = await submitAssessment('yes');
    const lastPredict = [...vercel.seen].reverse().find((s) => s.pathname === '/api/py/predict' && s.method === 'POST');
    const sentData = JSON.parse(lastPredict.body).data;
    assert.ok(QIDS.every((q) => sentData[q] === 'yes'), 'all Q01-Q34 answers must be sent');
    const allNo = await submitAssessment('no');
    assert.strictEqual(allYes.prediction.source, 'ml');
    assert.strictEqual(allNo.prediction.source, 'ml');
    assert.notDeepStrictEqual(allYes.prediction.probabilities, allNo.prediction.probabilities);

    const after = await call('GET', '/ml/diagnostics?smoke=1', adminToken);
    assert.strictEqual(after.body.ok, true, JSON.stringify(after.body.problems));
    assert.strictEqual(after.body.smokeTest.ok, true);

    console.log('ML production flow tests OK — health/secret, diagnostics, fallback reason, retrain via Vercel to R2, activation, new assessment riskCategory persisted, parent + pediatrician APIs agree, Q01-Q34 sent');
  } finally {
    appServer.close();
    vercel.close();
    train.close();
    predict.close();
    r2.close();
  }
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
