// tests/unit/ml-r2-artifact.test.js
// Model-artifact lifecycle under production-like settings (Render + R2 + the
// Vercel Python ML service), run fully offline:
//   - an in-process mock R2 bucket (USE_BLOB=true, R2_* pointed at it)
//   - the real api/ml_train.py and api/ml_predict.py handlers, behind a proxy
//     that enforces Vercel's 4.5 MB request/response body limit
//   - the real ml/trainer.py and ml/predict.py (needs scikit-learn/pandas/joblib)
// Verifies: trained artifacts land in R2 under uploads/models/<file>, a model
// recorded with a Windows path (the production v4 failure) is loaded from R2 by
// its key, the prediction reaches prediction.riskCategory, oversized artifacts
// fail with a clear reason, and question_based models still receive Q01-Q34.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATASET = path.join(ROOT, 'ml', 'datasets', 'kindercura_assessment_dataset.csv');
const BUCKET = 'kindercura-ml-models';
const SECRET = 'test-ml-secret';
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startMockR2() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const parts = new URL(req.url, 'http://mock').pathname.replace(/^\/+/, '').split('/');
    const bucket = parts.shift();
    const key = decodeURIComponent(parts.join('/'));
    if (bucket !== BUCKET) { res.statusCode = 400; return res.end('wrong bucket'); }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const obj = objects.get(key);
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.statusCode = 200; return res.end(); }
      if (!obj) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      res.setHeader('Content-Length', obj.length);
      res.statusCode = 200;
      return res.end(req.method === 'GET' ? obj : undefined);
    });
  });
  return listen(server).then((port) => ({ port, objects, close: () => server.close() }));
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

// Routes /api/py/train and /api/py/predict like vercel.json, and rejects
// bodies over Vercel's limit with its plain-text 413 the way production would.
function startVercelProxy(trainPort, predictPort) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (body.length > VERCEL_BODY_LIMIT) {
        res.statusCode = 413;
        return res.end('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE');
      }
      const port = req.url.startsWith('/api/py/train') ? trainPort : predictPort;
      const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.end(body);
    });
  });
  return listen(server).then((port) => ({ port, close: () => server.close() }));
}

async function run() {
  const r2 = await startMockR2();
  const train = await startPythonHandler('api.ml_train');
  const predict = await startPythonHandler('api.ml_predict');
  const vercel = await startVercelProxy(train.port, predict.port);

  Object.assign(process.env, {
    USE_BLOB: 'true',
    R2_ENDPOINT: `http://127.0.0.1:${r2.port}`,
    R2_BUCKET: BUCKET,
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_REGION: 'auto',
    ML_SERVICE_URL: `http://127.0.0.1:${vercel.port}`,
    ML_SERVICE_SECRET: SECRET,
  });
  delete process.env.USE_LOCAL_PYTHON;

  const modelManager = require('../../ml/model_manager');
  const fileStorage = require('../../services/fileStorage');
  const assessmentProgress = require('../../services/assessmentProgress');
  const TrainedModel = require('../../models/TrainedModel');
  const Child = require('../../models/Child');
  assert.strictEqual(fileStorage.USE_BLOB, true, 'R2 object storage must be on for this test');

  TrainedModel.findOne = () => ({ sort: () => ({ lean: async () => null }), lean: async () => null });
  Child.findById = () => ({ lean: async () => ({ dateOfBirth: new Date(Date.now() - 60 * 30.44 * 864e5) }) });
  const useActiveModel = (doc) => { TrainedModel.findOne = () => ({ sort: () => ({ lean: async () => null }), lean: async () => doc }); };
  const scores = (v) => ({ communicationScore: v, socialScore: v, cognitiveScore: v, motorScore: v, overallScore: v });

  // Large enough (>1 MB) to exercise the gzip path to the remote trainer.
  const lines = fs.readFileSync(DATASET, 'utf8').trim().split('\n');
  const bigDataset = [lines[0], ...Array.from({ length: 200 }, () => lines.slice(1)).flat()].join('\n');
  assert.ok(modelManager.buildRemoteTrainingPayload(bigDataset, 'csv', 'score_based').dataset_content_gzip_base64);

  try {
    // A. Remote (Vercel) training: artifact persisted to R2 under its portable key.
    const scoreRun = await modelManager.trainModel('/uploads/datasets/big.csv', null, { featureSet: 'score_based', datasetContent: bigDataset });
    assert.match(scoreRun.model_path, /^uploads\/models\/kindercura_model_[\w]+\.joblib$/);
    const scoreArtifact = r2.objects.get(scoreRun.model_path);
    assert.ok(scoreArtifact, 'score_based artifact must be in R2');
    assert.ok(scoreArtifact.length < modelManager.MAX_REMOTE_ARTIFACT_BYTES, 'artifact must fit the Vercel body limit');

    // B. The production v4 failure: modelPath recorded as a Windows path.
    const filename = modelManager.modelArtifactFilename(scoreRun.model_path);
    const windowsPath = `C:/Users/user/Documents/KinderCura-by-Dumzkie/KinderCura System Final/uploads/models/${filename}`;
    const scoreModel = { version: 4, isActive: true, status: 'completed', modelPath: windowsPath, featuresUsed: scoreRun.features_used };
    useActiveModel(scoreModel);
    const smoke = await modelManager.smokeTestModel(scoreModel);
    assert.strictEqual(smoke.ok, true, `smoke test: ${smoke.error}`);
    const record = await assessmentProgress.buildPredictionForStorage(scores(20), 'child-1', {});
    assert.strictEqual(record.source, 'ml', `expected ML prediction, got: ${record.mlUnavailableReason}`);
    assert.ok(['Low', 'Medium', 'High'].includes(record.riskCategory));
    assert.strictEqual(record.modelVersion, 4);

    // C. Artifact missing from R2: clean fallback naming the key, no path mangling.
    useActiveModel({ ...scoreModel, modelPath: 'C:/Users/user/uploads/models/kindercura_model_missing.joblib' });
    const missing = await assessmentProgress.buildPredictionForStorage(scores(20), 'child-1', {});
    assert.strictEqual(missing.source, 'rule_based');
    assert.strictEqual(missing.riskCategory, null);
    assert.match(missing.mlUnavailableReason, /key uploads\/models\/kindercura_model_missing\.joblib/);
    assert.doesNotMatch(missing.mlUnavailableReason, /opt\/render|C:\//);

    // D. Oversized artifact (like an unbounded 49k-row forest): explicit reason,
    // and the activation smoke test refuses it.
    r2.objects.set('uploads/models/oversized.joblib', Buffer.alloc(modelManager.MAX_REMOTE_ARTIFACT_BYTES + 512 * 1024));
    const oversized = { ...scoreModel, modelPath: 'uploads/models/oversized.joblib' };
    useActiveModel(oversized);
    const big = await assessmentProgress.buildPredictionForStorage(scores(20), 'child-1', {});
    assert.match(big.mlUnavailableReason, /above the .* the remote ML service accepts/);
    assert.strictEqual((await modelManager.smokeTestModel(oversized)).ok, false);

    // E. question_based model through the same R2 + Vercel path still receives Q01-Q34.
    const qRun = await modelManager.trainModel('/uploads/datasets/q.csv', null, { featureSet: 'question_based', datasetContent: lines.join('\n') });
    assert.ok(r2.objects.get(qRun.model_path), 'question_based artifact must be in R2');
    useActiveModel({ version: 5, isActive: true, status: 'completed', modelPath: qRun.model_path, featuresUsed: qRun.features_used });
    const answers = (a) => Object.fromEntries(Array.from({ length: 34 }, (_, i) => [`Q${String(i + 1).padStart(2, '0')}`, a]));
    const yes = await assessmentProgress.buildPredictionForStorage(scores(100), 'child-1', answers('yes'));
    const no = await assessmentProgress.buildPredictionForStorage(scores(0), 'child-1', answers('no'));
    assert.strictEqual(yes.source, 'ml');
    assert.strictEqual(no.source, 'ml');
    assert.notDeepStrictEqual(yes.probabilities, no.probabilities, 'answers must reach a question_based model');
    const noAnswers = await assessmentProgress.buildPredictionForStorage(scores(50), 'child-1', {});
    assert.strictEqual(noAnswers.mlUnavailableReason, 'question_answers_unavailable');

    // F. Local Python training with R2 on (how v4 was produced on a Windows
    // machine): the artifact is uploaded and recorded by key, not by local path.
    process.env.USE_LOCAL_PYTHON = 'true';
    TrainedModel.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    const before = new Set(r2.objects.keys());
    const localRun = await modelManager.trainModel(DATASET, null, { featureSet: 'score_based' });
    delete process.env.USE_LOCAL_PYTHON;
    assert.match(localRun.model_path, /^uploads\/models\/kindercura_model_[\w]+\.joblib$/);
    assert.ok(!before.has(localRun.model_path) && r2.objects.has(localRun.model_path), 'local training must upload to R2');
    fs.rmSync(path.join(modelManager.MODEL_DIR, modelManager.modelArtifactFilename(localRun.model_path)), { force: true });

    console.log('ML R2 artifact lifecycle tests OK');
  } finally {
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
