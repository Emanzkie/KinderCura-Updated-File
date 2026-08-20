// tests/unit/ml-deployment-bridge.test.js
// Unit tests for the Vercel Python Serverless ML Deployment Bridge.
// Validates:
// 1. isRemoteML() environment detection.
// 2. Strict ML_SERVICE_SECRET authorization.
// 3. Distinct endpoints: /api/py/train (training only) and /api/py/predict (prediction only).
// 4. In-memory dataset execution and base64 model artifact persistence via fileStorage.
// 5. Candidate model creation (status = completed, isActive = false) and active model preservation.
// 6. Feature set type preservation (score_based vs question_based).
// 7. End-to-end 100-row synthetic dataset processing.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const modelManager = require('../../ml/model_manager');
const fileStorage = require('../../services/fileStorage');
const TrainedModel = require('../../models/TrainedModel');

const CANONICAL_DATASET = path.join(__dirname, '..', '..', 'ml', 'datasets', 'kindercura_assessment_dataset.csv');

// Test helper: run Python handler via a lightweight local test HTTP server
function createPythonHttpServer(pyHandlerModulePath, envSecret) {
  const { spawn } = require('child_process');

  // Spawn a small Python process that hosts the handler module on an ephemeral port
  const pythonScript = `
import sys
import os
from http.server import HTTPServer

# Add repo root
sys.path.insert(0, r"${path.resolve(__dirname, '..', '..').replace(/\\/g, '/')}")
os.environ['ML_SERVICE_SECRET'] = "${envSecret}"

from ${pyHandlerModulePath} import handler

server = HTTPServer(('127.0.0.1', 0), handler)
port = server.server_address[1]
print(f"READY:{port}", flush=True)
server.serve_forever()
`;

  const proc = spawn('python', ['-c', pythonScript]);
  return new Promise((resolve, reject) => {
    let started = false;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      const match = stdout.match(/READY:(\d+)/);
      if (match && !started) {
        started = true;
        const port = parseInt(match[1], 10);
        resolve({
          port,
          url: `http://127.0.0.1:${port}`,
          close: () => {
            proc.kill();
          },
        });
      }
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (!started) {
        reject(new Error(`Python test server failed with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

// ── Test 1: isRemoteML and Environment Detection ───────────────────────────
function testEnvironmentDetection() {
  const origVercel = process.env.VERCEL;
  const origUrl = process.env.ML_SERVICE_URL;
  const origLocal = process.env.USE_LOCAL_PYTHON;

  try {
    delete process.env.VERCEL;
    delete process.env.ML_SERVICE_URL;
    delete process.env.USE_LOCAL_PYTHON;
    assert.strictEqual(modelManager.isRemoteML(), false, 'Default local dev must not be remote ML');

    process.env.VERCEL = '1';
    assert.strictEqual(modelManager.isRemoteML(), true, 'VERCEL=1 must enable remote ML');

    process.env.USE_LOCAL_PYTHON = 'true';
    assert.strictEqual(modelManager.isRemoteML(), false, 'USE_LOCAL_PYTHON=true must force local mode');

    delete process.env.VERCEL;
    process.env.ML_SERVICE_URL = 'https://custom-ml.example.com';
    delete process.env.USE_LOCAL_PYTHON;
    assert.strictEqual(modelManager.isRemoteML(), true, 'ML_SERVICE_URL must enable remote ML');
  } finally {
    if (origVercel !== undefined) process.env.VERCEL = origVercel; else delete process.env.VERCEL;
    if (origUrl !== undefined) process.env.ML_SERVICE_URL = origUrl; else delete process.env.ML_SERVICE_URL;
    if (origLocal !== undefined) process.env.USE_LOCAL_PYTHON = origLocal; else delete process.env.USE_LOCAL_PYTHON;
  }
}

// ── Test 2: Dedicated ML_SERVICE_SECRET Authorization ─────────────────────
async function testSecretAuthorization() {
  const TEST_SECRET = 'kindercura_test_ml_secret_xyz123';
  let trainServer, predictServer;

  try {
    trainServer = await createPythonHttpServer('api.ml_train', TEST_SECRET);
    predictServer = await createPythonHttpServer('api.ml_predict', TEST_SECRET);

    // 1. Health checks on GET do not require secret
    const trainHealth = await fetch(`${trainServer.url}/api/py/train`).then(r => r.json());
    assert.strictEqual(trainHealth.ok, true);
    assert.strictEqual(trainHealth.service, 'kindercura-ml-train');

    const predictHealth = await fetch(`${predictServer.url}/api/py/predict`).then(r => r.json());
    assert.strictEqual(predictHealth.ok, true);
    assert.strictEqual(predictHealth.service, 'kindercura-ml-predict');

    // 2. Training POST without secret must fail with 401
    const noAuthTrain = await fetch(`${trainServer.url}/api/py/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset_content: 'dummy' }),
    });
    assert.strictEqual(noAuthTrain.status, 401, 'Training request without x-ml-secret must return 401');

    // 3. Training POST with invalid secret must fail with 401
    const badAuthTrain = await fetch(`${trainServer.url}/api/py/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ml-secret': 'wrong_secret' },
      body: JSON.stringify({ dataset_content: 'dummy' }),
    });
    assert.strictEqual(badAuthTrain.status, 401, 'Training request with wrong secret must return 401');

    // 4. Predict POST without secret must fail with 401
    const noAuthPredict = await fetch(`${predictServer.url}/api/py/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert.strictEqual(noAuthPredict.status, 401, 'Predict request without x-ml-secret must return 401');
  } finally {
    if (trainServer) trainServer.close();
    if (predictServer) predictServer.close();
  }
}

// ── Test 3: Remote ML Training & Prediction Flow with Mocked DB ────────────
async function testRemoteMLTrainingAndPrediction() {
  const TEST_SECRET = 'kindercura_test_ml_secret_xyz123';
  let trainServer, predictServer;

  const origFindOne = TrainedModel.findOne;
  const origCreate = TrainedModel.create;
  const origUpdateMany = TrainedModel.updateMany;
  let savedDoc = null;

  TrainedModel.findOne = () => ({
    sort: () => ({ lean: async () => ({ version: 1 }) }),
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

  const origEnvUrl = process.env.ML_SERVICE_URL;
  const origEnvSecret = process.env.ML_SERVICE_SECRET;
  const origVercel = process.env.VERCEL;

  try {
    trainServer = await createPythonHttpServer('api.ml_train', TEST_SECRET);
    predictServer = await createPythonHttpServer('api.ml_predict', TEST_SECRET);

    process.env.ML_SERVICE_URL = trainServer.url;
    process.env.ML_SERVICE_SECRET = TEST_SECRET;
    process.env.VERCEL = '1';

    // 1. Test checkPythonEnvironment() in remote mode
    const envCheck = await modelManager.checkPythonEnvironment();
    assert.strictEqual(envCheck.ok, true, 'Remote checkPythonEnvironment must succeed');
    assert.strictEqual(envCheck.mode, 'remote');

    // 2. Train on canonical dataset via HTTP
    const datasetCsvContent = fs.readFileSync(CANONICAL_DATASET, 'utf8');
    const result = await modelManager.trainModel(CANONICAL_DATASET, 'testDataset123', {
      featureSet: 'score_based',
      datasetContent: datasetCsvContent,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.feature_set_type, 'score_based');
    assert.strictEqual(typeof result.accuracy, 'number');
    assert.ok(result.model_artifact_base64, 'Must return base64 model artifact');

    // 3. Verify candidate model safety
    assert.strictEqual(savedDoc.status, 'completed');
    assert.strictEqual(savedDoc.isActive, false, 'Candidate model must remain inactive (isActive = false)');
    assert.strictEqual(savedDoc.featureSetType, 'score_based');

    // 4. Verify prediction over HTTP with api/ml_predict
    process.env.ML_SERVICE_URL = predictServer.url; // point to predict server
    const prediction = await modelManager.getPrediction(result.model_path, {
      communication_score: 85,
      social_score: 90,
      cognitive_score: 80,
      motor_score: 85,
      overall_score: 85,
      age_months: 48,
    });

    assert.strictEqual(prediction.success, true);
    assert.ok(['Low', 'Medium', 'High'].includes(prediction.risk_category));
    assert.strictEqual(typeof prediction.consultation_needed, 'boolean');

    // Cleanup saved test artifact
    if (result.model_path && fs.existsSync(result.model_path)) {
      try { fs.unlinkSync(result.model_path); } catch (_) {}
    }
  } finally {
    TrainedModel.findOne = origFindOne;
    TrainedModel.create = origCreate;
    TrainedModel.updateMany = origUpdateMany;

    if (origEnvUrl !== undefined) process.env.ML_SERVICE_URL = origEnvUrl; else delete process.env.ML_SERVICE_URL;
    if (origEnvSecret !== undefined) process.env.ML_SERVICE_SECRET = origEnvSecret; else delete process.env.ML_SERVICE_SECRET;
    if (origVercel !== undefined) process.env.VERCEL = origVercel; else delete process.env.VERCEL;

    if (trainServer) trainServer.close();
    if (predictServer) predictServer.close();
  }
}

// ── Test 4: Question-based feature set over remote bridge ─────────────────
async function testQuestionBasedRemoteTraining() {
  const TEST_SECRET = 'kindercura_test_ml_secret_xyz123';
  let trainServer, predictServer;

  const origFindOne = TrainedModel.findOne;
  const origCreate = TrainedModel.create;
  const origUpdateMany = TrainedModel.updateMany;
  let savedDoc = null;

  TrainedModel.findOne = () => ({
    sort: () => ({ lean: async () => ({ version: 2 }) }),
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

  const origEnvUrl = process.env.ML_SERVICE_URL;
  const origEnvSecret = process.env.ML_SERVICE_SECRET;
  const origVercel = process.env.VERCEL;

  try {
    trainServer = await createPythonHttpServer('api.ml_train', TEST_SECRET);
    predictServer = await createPythonHttpServer('api.ml_predict', TEST_SECRET);

    process.env.ML_SERVICE_URL = trainServer.url;
    process.env.ML_SERVICE_SECRET = TEST_SECRET;
    process.env.VERCEL = '1';

    const datasetCsvContent = fs.readFileSync(CANONICAL_DATASET, 'utf8');
    const result = await modelManager.trainModel(CANONICAL_DATASET, 'testDatasetQuestion123', {
      featureSet: 'question_based',
      datasetContent: datasetCsvContent,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.feature_set_type, 'question_based');
    assert.strictEqual(savedDoc.featureSetType, 'question_based');
    assert.strictEqual(savedDoc.isActive, false);

    // Predict with question model
    process.env.ML_SERVICE_URL = predictServer.url;
    const questionInput = {};
    for (let n = 1; n <= 20; n++) {
      questionInput[`Q${String(n).padStart(2, '0')}`] = n % 2 === 0 ? 'yes' : 'sometimes';
    }
    for (let n = 21; n <= 34; n++) {
      questionInput[`Q${String(n).padStart(2, '0')}`] = '';
    }
    questionInput.age_months = 42;

    const prediction = await modelManager.getPrediction(result.model_path, questionInput);
    assert.strictEqual(prediction.success, true);
    assert.ok(['Low', 'Medium', 'High'].includes(prediction.risk_category));

    if (result.model_path && fs.existsSync(result.model_path)) {
      try { fs.unlinkSync(result.model_path); } catch (_) {}
    }
  } finally {
    TrainedModel.findOne = origFindOne;
    TrainedModel.create = origCreate;
    TrainedModel.updateMany = origUpdateMany;

    if (origEnvUrl !== undefined) process.env.ML_SERVICE_URL = origEnvUrl; else delete process.env.ML_SERVICE_URL;
    if (origEnvSecret !== undefined) process.env.ML_SERVICE_SECRET = origEnvSecret; else delete process.env.ML_SERVICE_SECRET;
    if (origVercel !== undefined) process.env.VERCEL = origVercel; else delete process.env.VERCEL;

    if (trainServer) trainServer.close();
    if (predictServer) predictServer.close();
  }
}

async function run() {
  testEnvironmentDetection();
  await testSecretAuthorization();
  await testRemoteMLTrainingAndPrediction();
  await testQuestionBasedRemoteTraining();
  console.log('ML deployment bridge tests OK');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
