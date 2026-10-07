// ml/model_manager.js
// Purpose:
// - Bridge between Node.js and the Python ML scripts (trainer.py / predict.py)
// - Supports both local Python execution (child_process.spawn) and Vercel Python Serverless Functions
// - Communicates over HTTP with separate /api/py/train and /api/py/predict endpoints in production
// - Authenticates using dedicated ML_SERVICE_SECRET (no fallback to JWT/SESSION secret)
// - Persists training results and model artifacts safely via services/fileStorage.js
// - Validates ML environment readiness before attempting training
//
// Exported functions:
//   trainModel(datasetPath, datasetId, options) – train a model, persist metrics and artifact
//   getPrediction(modelPath, inputData)         – predict risk category for one assessment
//   getModelStatus(modelId)                     – query a TrainedModel document by ID
//   checkPythonEnvironment()                    – verify Python / ML service availability
//   resolveDatasetPath(filePath)                – locate a dataset file on disk or storage
//   ensureModelDir()                            – create uploads/models/ if missing
//   predict(modelPath, scores)                  – alias kept for backward compatibility

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const TrainedModel = require('../models/TrainedModel');
const fileStorage = require('../services/fileStorage');

// ── Path constants ──────────────────────────────────────────────────────
const MODEL_DIR = path.join(__dirname, '..', 'uploads', 'models');
const TRAINER_SCRIPT = path.join(__dirname, 'trainer.py');
const PREDICT_SCRIPT = path.join(__dirname, 'predict.py');

// Feature names the current pipeline no longer supports.
const UNSUPPORTED_FEATURES = ['gender_encoded'];

// Object-store folder for model artifacts. A TrainedModel.modelPath is always
// resolved to `${MODEL_STORE_DIR}/<filename>` — the R2 object key — no matter
// what form it was recorded in (relative key, POSIX path, or a Windows path
// like C:/Users/.../uploads/models/x.joblib from a model trained on a
// developer machine).
const MODEL_STORE_DIR = 'uploads/models';

// Vercel Functions reject request/response bodies over 4.5 MB. Artifacts travel
// base64-encoded (x4/3) inside JSON, so the raw artifact must stay well below it.
const MAX_REMOTE_ARTIFACT_BYTES = Math.floor((4.5 * 1024 * 1024 - 64 * 1024) * 3 / 4);

// Datasets above this size are gzip-compressed before being sent to the remote
// trainer, keeping large datasets (e.g. 49k rows) under the same body limit.
const DATASET_GZIP_THRESHOLD_BYTES = 1024 * 1024;

/** Artifact filename from any recorded modelPath (handles / and \ separators). */
function modelArtifactFilename(modelPath) {
  return String(modelPath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Stable object-store key for a recorded modelPath, e.g. 'uploads/models/x.joblib'. */
function modelArtifactKey(modelPath) {
  const filename = modelArtifactFilename(modelPath);
  return filename ? `${MODEL_STORE_DIR}/${filename}` : '';
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * True when a TrainedModel document's feature set is still supported by the
 * current ml/predict.py.
 */
function isModelCompatible(trainedModelDoc) {
  const features = Array.isArray(trainedModelDoc?.featuresUsed) ? trainedModelDoc.featuresUsed : [];
  return !features.some((f) => UNSUPPORTED_FEATURES.includes(f));
}

// ── Activation smoke test ───────────────────────────────────────────────
// A model document can look perfectly activatable in MongoDB while its
// .joblib artifact is missing, corrupt, or trained on different columns than
// the document claims. isModelCompatible() cannot see any of that — it only
// reads featuresUsed. The smoke test below actually loads the artifact and
// runs one prediction through the SAME code path live predictions use, so a
// model is only ever promoted after it has demonstrably produced a result.
//
// This is a read-only probe: it writes nothing, touches no assessment, and
// never changes which model is active.

// Values used to build the probe. Deliberately mid-range and unremarkable —
// this checks that the pipeline RUNS, not that it produces any particular
// answer, so the numbers must never be read as an expected output.
const SMOKE_TEST_SCORE = 70;
const SMOKE_TEST_AGE_MONTHS = 60;
const SMOKE_TEST_ANSWER = 2; // 'yes' under routes/assessments.js scoreAnswer()

const SCORE_FEATURE_COLUMNS = [
  'communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score',
];
const QUESTION_FEATURE_PATTERN = /^Q\d{2}$/;

/**
 * Build one synthetic prediction input for *model*.
 *
 * Derived from the document's own featuresUsed when it has one, which makes
 * the probe do double duty: it verifies the artifact predicts AND that the
 * artifact's stored feature_columns actually agree with what the database
 * says the model was trained on. If they have drifted apart, ml/predict.py
 * fails with "Missing required feature: X" and the smoke test catches it.
 *
 * Falls back to a superset probe (both known feature sets) for older
 * documents that never recorded featuresUsed — there the artifact is the only
 * source of truth, so the probe simply supplies everything it might ask for.
 */
function buildSmokeTestProbe(model) {
  const features = Array.isArray(model?.featuresUsed) ? model.featuresUsed : [];

  if (!features.length) {
    const probe = { age_months: SMOKE_TEST_AGE_MONTHS };
    SCORE_FEATURE_COLUMNS.forEach((c) => { probe[c] = SMOKE_TEST_SCORE; });
    for (let n = 1; n <= 34; n += 1) probe[`Q${String(n).padStart(2, '0')}`] = SMOKE_TEST_ANSWER;
    return probe;
  }

  const probe = {};
  for (const feature of features) {
    if (feature === 'age_months') probe[feature] = SMOKE_TEST_AGE_MONTHS;
    else if (QUESTION_FEATURE_PATTERN.test(feature)) probe[feature] = SMOKE_TEST_ANSWER;
    else probe[feature] = SMOKE_TEST_SCORE; // every remaining supported feature is a 0-100 score
  }
  return probe;
}

/** True when the model's .joblib artifact can actually be read back. */
async function modelArtifactExists(modelPath) {
  if (!modelPath) return false;
  const loaded = await loadModelBuffer(modelPath);
  return Boolean(loaded && loaded.buffer && loaded.buffer.length);
}

/**
 * Run the pre-activation smoke test for *model*.
 *
 * Three checks, in the order that fails most cheaply first:
 *   1. artifact_present  — the .joblib is readable on disk or in blob storage
 *   2. features_supported — no feature the current predict.py cannot handle
 *   3. test_prediction   — one real prediction through getPrediction()
 *
 * NEVER throws: a failure is reported as { ok: false } with the reason, so a
 * caller can render it rather than handling an exception. Returns the full
 * check list either way so the admin UI can show what passed as well as what
 * failed.
 */
async function smokeTestModel(model) {
  const startedAt = Date.now();
  const checks = [];
  const finish = (ok, error, prediction) => ({
    ok,
    checks,
    prediction: prediction || null,
    error: error || null,
    durationMs: Date.now() - startedAt,
  });

  // 1. Artifact present
  let artifactOk = false;
  try {
    artifactOk = await modelArtifactExists(model?.modelPath);
  } catch (err) {
    checks.push({ name: 'artifact_present', ok: false, detail: `Could not read the model file: ${err.message}` });
    return finish(false, `Could not read the model file: ${err.message}`);
  }
  checks.push({
    name: 'artifact_present',
    ok: artifactOk,
    detail: artifactOk
      ? `Model file found (${model.modelPath}).`
      : `Model file not found: ${model?.modelPath || '(no path recorded)'}`,
  });
  if (!artifactOk) return finish(false, `Model file not found: ${model?.modelPath || '(no path recorded)'}`);

  // 2. Features supported
  const compatible = isModelCompatible(model);
  const unsupported = (Array.isArray(model?.featuresUsed) ? model.featuresUsed : [])
    .filter((f) => UNSUPPORTED_FEATURES.includes(f));
  checks.push({
    name: 'features_supported',
    ok: compatible,
    detail: compatible
      ? `All ${(model.featuresUsed || []).length} feature column(s) are supported by the current prediction pipeline.`
      : `Unsupported feature column(s): ${unsupported.join(', ')}.`,
  });
  if (!compatible) return finish(false, `Unsupported feature column(s): ${unsupported.join(', ')}.`);

  // 3. One real prediction
  const probe = buildSmokeTestProbe(model);
  try {
    const prediction = await getPrediction(model.modelPath, probe);
    const category = prediction && prediction.risk_category;
    if (!category) {
      checks.push({ name: 'test_prediction', ok: false, detail: 'The prediction returned no risk_category.' });
      return finish(false, 'The test prediction returned no risk_category.');
    }
    if (!['Low', 'Medium', 'High'].includes(category)) {
      checks.push({ name: 'test_prediction', ok: false, detail: `The prediction returned "${category}", not Low, Medium or High.` });
      return finish(false, `The test prediction returned "${category}", not Low, Medium or High.`);
    }
    checks.push({
      name: 'test_prediction',
      ok: true,
      detail: `Test prediction succeeded (returned "${category}").`,
    });
    return finish(true, null, prediction);
  } catch (err) {
    checks.push({ name: 'test_prediction', ok: false, detail: `Test prediction failed: ${err.message}` });
    return finish(false, `Test prediction failed: ${err.message}`);
  }
}

// ── Mode & URL Helpers ──────────────────────────────────────────────────

/**
 * True when the app should use the deployed Vercel Python Serverless Function
 * instead of spawning a local Python child process.
 */
function isRemoteML() {
  if (process.env.USE_LOCAL_PYTHON === 'true') return false;
  return Boolean(process.env.VERCEL || process.env.NOW_REGION || process.env.ML_SERVICE_URL);
}

/** An ML pipeline failure with a stable `code` (persisted as the fallback reason prefix). */
class MlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ML_SERVICE_URL must be the deployment's base URL. A value that already ends
// in /api/py/train would otherwise become .../api/py/train/api/py/train.
const ML_ENDPOINT_SUFFIX = /\/api\/py(\/(train|predict))?$/i;
let warnedAboutUrlSuffix = false;

/**
 * Base URL for the ML service.
 */
function getMLServiceUrl() {
  if (process.env.ML_SERVICE_URL) {
    let base = process.env.ML_SERVICE_URL.trim().replace(/\/+$/, '');
    if (ML_ENDPOINT_SUFFIX.test(base)) {
      base = base.replace(ML_ENDPOINT_SUFFIX, '');
      if (!warnedAboutUrlSuffix) {
        warnedAboutUrlSuffix = true;
        console.warn(`[ml] ML_SERVICE_URL should be the base URL only; ignoring its /api/py path and using ${base}`);
      }
    }
    return base;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/+$/, '')}`;
  }
  return 'http://localhost:3000';
}

function hostOf(value) {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A configuration problem that guarantees every ML call fails, or null.
 * On Vercel the functions share the app's deployment, so pointing at "self"
 * is only wrong when the Node app runs elsewhere (e.g. Render).
 */
function mlServiceConfigProblem() {
  const raw = (process.env.ML_SERVICE_URL || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(getMLServiceUrl());
  } catch {
    return 'ML_SERVICE_URL is not a valid URL — it must look like https://<project>.vercel.app';
  }
  if (!/^https?:$/.test(parsed.protocol)) return 'ML_SERVICE_URL must start with https://';
  if (!(process.env.VERCEL || process.env.NOW_REGION)) {
    const selfHosts = [process.env.APP_URL, process.env.RENDER_EXTERNAL_URL, process.env.RENDER_EXTERNAL_HOSTNAME]
      .filter(Boolean).map(hostOf).filter(Boolean);
    if (selfHosts.includes(parsed.host.toLowerCase())) {
      return `ML_SERVICE_URL points at this Node app (${parsed.host}), not at the Vercel deployment that runs api/ml_train.py and api/ml_predict.py`;
    }
  }
  return null;
}

function pageTitle(text) {
  const m = String(text || '').match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  return m ? m[1].trim() : '';
}

function looksLikeVercelProtection(status, text, location = '') {
  return /vercel\.com/i.test(location) || /sso-api|_vercel_sso|Authentication Required|vercel\.com\/login/i.test(text || '')
    || ((status === 401 || status === 403) && /vercel/i.test(text || ''));
}

const PROTECTION_HINT = ' This is Vercel Deployment Protection blocking a server-to-server request: point ML_SERVICE_URL at the '
  + "project's public production domain, or create a Protection Bypass for Automation secret in Vercel and set it on this "
  + 'server as VERCEL_AUTOMATION_BYPASS_SECRET.';

/**
 * Readable text for an error field from any ML-service or Vercel response:
 * a string, an object such as { code, message } (Vercel platform errors), or
 * anything else. Never "[object Object]".
 */
function serviceErrorText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const message = serviceErrorText(value.message || value.error || value.detail || '');
    const code = value.code != null ? String(value.code) : '';
    if (message || code) return [code, message].filter(Boolean).join(': ');
    try { return JSON.stringify(value).slice(0, 200); } catch { return 'unreadable error object'; }
  }
  return String(value);
}

/** True for a JSON body produced by api/ml_train.py or api/ml_predict.py themselves. */
function isMlFunctionBody(data) {
  return Boolean(data) && (typeof data.success === 'boolean' || typeof data.service === 'string');
}

/**
 * One request to the Python ML service. Never follows redirects (a followed
 * redirect to a login page is how an HTML page ended up being parsed as JSON),
 * logs the target, status and content type (never headers or secrets), and
 * throws MlError('ml_service_unreachable', ...) with a specific diagnosis
 * whenever the answer is not JSON. Resolves { ok, status, data, target }.
 */
async function mlServiceRequest(endpoint, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const problem = mlServiceConfigProblem();
  if (problem) throw new MlError('ml_service_misconfigured', problem);

  const url = `${getMLServiceUrl()}${endpoint}`;
  let target = url;
  try { const u = new URL(url); target = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }

  const headers = { Accept: 'application/json', 'x-ml-secret': getMLSecret() };
  if (body) headers['Content-Type'] = 'application/json';
  const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;

  console.log(`[ml] ML service request: ${method} ${target}${body ? ` (body ${formatMB(Buffer.byteLength(body))})` : ''}`);
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `no response within ${Math.round(timeoutMs / 1000)}s` : (err.cause?.code || err.cause?.message || err.message);
    console.warn(`[ml] ML service request failed: ${method} ${target}: ${reason}`);
    throw new MlError('ml_service_unreachable', `ML service ${target} is unreachable: ${reason}`);
  }

  const contentType = res.headers.get('content-type') || '(none)';
  console.log(`[ml] ML service response: ${method} ${target} -> HTTP ${res.status}, content-type ${contentType}`);

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    const where = hostOf(location) || 'another page';
    throw new MlError('ml_service_unreachable', `ML service ${target} redirected (HTTP ${res.status}) to ${where} instead of answering.`
      + (looksLikeVercelProtection(res.status, '', location) ? PROTECTION_HINT : ' ML_SERVICE_URL is not the Python ML deployment.'));
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  // 401/403 with JSON: either our function rejected the secret (POST), or
  // Vercel rejected the request before it ever reached the function — the
  // health GET of our functions never answers 401 itself.
  if ((res.status === 401 || res.status === 403) && data && typeof data === 'object') {
    const detail = serviceErrorText(data.error) || serviceErrorText(data.message) || 'no detail';
    if (isMlFunctionBody(data)) {
      throw new MlError('ml_service_unauthorized', `ML service authentication failed (HTTP ${res.status}) at ${target}: ${detail}. `
        + 'Check that ML_SERVICE_SECRET is identical on Render and on Vercel.');
    }
    const bypassNote = bypass
      ? ' A VERCEL_AUTOMATION_BYPASS_SECRET is set on this server, but Vercel did not accept it — it must equal the Protection Bypass for Automation secret of this Vercel project.'
      : PROTECTION_HINT;
    throw new MlError('ml_service_blocked', `Vercel rejected ${method} ${target} with HTTP ${res.status} (${detail}) before it reached the KinderCura ML function.${bypassNote}`);
  }

  if (data === null || typeof data !== 'object') {
    const html = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text);
    const title = html ? pageTitle(text) : '';
    let hint;
    if (html && looksLikeVercelProtection(res.status, text)) hint = PROTECTION_HINT;
    else if (res.status === 413) hint = ' The request body is larger than the ML service accepts.';
    else if (res.status === 504 || /FUNCTION_INVOCATION_TIMEOUT/.test(text)) hint = ' The ML function timed out.';
    else if (html) hint = ' ML_SERVICE_URL is serving a web page, not the KinderCura Python ML functions (api/ml_train.py / api/ml_predict.py).';
    else hint = '';
    throw new MlError('ml_service_unreachable', `ML service ${target} returned HTTP ${res.status} with content-type ${contentType} instead of JSON`
      + (title ? ` (page title "${title}")` : '') + '.' + hint);
  }
  return { ok: res.ok, status: res.status, data, target };
}

/**
 * GET health of one remote ML endpoint. Confirms it is the expected KinderCura
 * function and that this server's ML_SERVICE_SECRET matches the function's.
 */
async function checkRemoteEndpoint(endpoint, expectedService) {
  if (!getMLSecret()) return { ok: false, error: 'ML_SERVICE_SECRET is not set on this server.' };
  try {
    const { ok, status, data, target } = await mlServiceRequest(endpoint, { timeoutMs: 20000 });
    if (!ok) {
      const detail = serviceErrorText(data.error) || serviceErrorText(data.message);
      return { ok: false, target, error: `ML service ${target} health check returned HTTP ${status}${detail ? `: ${detail}` : ''}` };
    }
    if (data.service !== expectedService) {
      return { ok: false, target, error: `ML service ${target} answered, but not as ${expectedService} (service=${data.service || 'missing'}) — ML_SERVICE_URL is not the KinderCura ML deployment.` };
    }
    if (data.secretConfigured === false) return { ok: false, target, error: `ML_SERVICE_SECRET is not set on the Vercel ML service (${target}).` };
    if (data.authorized === false) return { ok: false, target, error: `ML_SERVICE_SECRET on this server does not match the one on the Vercel ML service (${target}).` };
    return { ok: true, target, service: data.service, python: data.python || 'remote-python', secretVerified: data.authorized === true };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

/**
 * Internal authorization secret for ML endpoints.
 * Strict: reads ML_SERVICE_SECRET only.
 */
function getMLSecret() {
  return process.env.ML_SERVICE_SECRET || '';
}

// ── Storage & Dataset Helpers ───────────────────────────────────────────

/**
 * Ensure the uploads/models directory exists.
 */
function ensureModelDir() {
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
  }
  return MODEL_DIR;
}

/**
 * Resolve the path to the dataset file on disk.
 */
function resolveDatasetPath(filePath) {
  if (!filePath) return null;
  const fileName = filePath.replace(/^\/uploads\/datasets\//, '');

  const candidates = [
    path.join(__dirname, '..', 'public', 'uploads', 'datasets', fileName),
    path.join(__dirname, '..', 'uploads', 'datasets', fileName),
    path.join(__dirname, '..', filePath),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // If caller passed an absolute path
  if (fs.existsSync(filePath)) return filePath;

  return null;
}

/**
 * Load dataset content as a string, checking in-memory content, disk, or fileStorage.
 */
async function loadDatasetContent(datasetPathOrContent) {
  if (!datasetPathOrContent) return null;
  if (typeof datasetPathOrContent === 'string' && (datasetPathOrContent.includes('\n') || datasetPathOrContent.includes(','))) {
    return datasetPathOrContent;
  }
  if (Buffer.isBuffer(datasetPathOrContent)) {
    return datasetPathOrContent.toString('utf8');
  }
  if (typeof datasetPathOrContent === 'string' && fs.existsSync(datasetPathOrContent)) {
    return fs.readFileSync(datasetPathOrContent, 'utf8');
  }
  // Try reading via fileStorage (Blob or disk)
  if (typeof datasetPathOrContent === 'string') {
    const fileName = path.basename(datasetPathOrContent);
    const stored = await fileStorage.readStored('public/uploads/datasets', fileName);
    if (stored) return stored.toString('utf8');
  }
  return null;
}

// ── Environment Check ───────────────────────────────────────────────────

/**
 * Check that Python 3 and ML components are ready.
 * In remote mode, checks /api/py/train health endpoint.
 * In local mode, checks local python + sklearn imports.
 */
async function checkPythonEnvironment() {
  if (isRemoteML()) {
    const health = await checkRemoteEndpoint('/api/py/train', 'kindercura-ml-train');
    if (!health.ok) console.warn(`[ml] ML training service health check failed: ${health.error}`);
    return health.ok ? { ...health, mode: 'remote' } : { ok: false, error: health.error, code: health.code };
  }

  // Local child_process.spawn verification
  return new Promise((resolve) => {
    const checkCode = 'import sklearn; import pandas; import joblib; print("OK")';
    const proc = spawn('python', ['-c', checkCode], { timeout: 15000 });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim() === 'OK') {
        resolve({ ok: true, python: 'python', mode: 'local' });
      } else {
        resolve({
          ok: false,
          error:
            'Python ML environment is not ready. ' +
            'Please install dependencies: pip install -r ml/requirements.txt\n' +
            (stderr || stdout || '').trim(),
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        ok: false,
        error: `Python is not available on this system: ${err.message}`,
      });
    });
  });
}

// ── Core Functions ──────────────────────────────────────────────────────

/**
 * A. trainModel(datasetPath, datasetId, options)
 *
 * Trains a candidate model, persists the .joblib artifact, and saves metrics
 * to the TrainedModel MongoDB collection with isActive: false.
 *
 * options.ownsModelDoc — set to FALSE when the CALLER has already created the
 * TrainedModel document for this run and will fill in the metrics itself.
 *
 * Why that option exists: routes/admin.js POST /training/:id/train creates a
 * placeholder TrainedModel (so the UI can show "training" immediately and hold
 * the version number), then calls this function, which used to unconditionally
 * create a SECOND document for the same run. The result was two 'completed'
 * models per training run, consecutive versions, identical modelPath and
 * identical metrics — which made "current model version" unreportable. The
 * live database still contains such a pair (v2 and v3, same artifact, same
 * second). Defaults to true so every other caller — routes/ml.js
 * POST /train-model, ml/tests, any direct call — behaves exactly as before.
 */
async function trainModel(datasetPath, datasetId, options = {}) {
  const outputDir = ensureModelDir();
  const featureSet = typeof options === 'string'
    ? options
    : (options?.featureSet || 'score_based');
  const ownsModelDoc = typeof options === 'object' && options !== null && options.ownsModelDoc === false
    ? false
    : true;

  // Determine next model version
  const lastModel = await TrainedModel.findOne().sort({ version: -1 }).lean();
  const nextVersion = (lastModel?.version || 0) + 1;

  let modelDoc;
  if (datasetId && ownsModelDoc) {
    modelDoc = await TrainedModel.create({
      datasetId,
      version: nextVersion,
      modelPath: '',
      status: 'training',
      featureSetType: featureSet,
    });
  }

  try {
    let result;

    if (isRemoteML()) {
      // ── Remote Vercel Python Function (/api/py/train) ─────────────────────
      const datasetContent = options?.datasetContent || await loadDatasetContent(datasetPath);
      if (!datasetContent) {
        throw new Error(`Could not load dataset content from: ${datasetPath}`);
      }

      const fileType = (typeof datasetPath === 'string' && datasetPath.toLowerCase().endsWith('.json')) ? 'json' : 'csv';
      const { ok, status, data } = await mlServiceRequest('/api/py/train', {
        method: 'POST',
        body: JSON.stringify(buildRemoteTrainingPayload(datasetContent, fileType, featureSet)),
        timeoutMs: 300000,
      });
      if (!ok || !data.success) {
        throw new MlError(status === 401 ? 'ml_service_unauthorized' : 'training_failed',
          `ML training service returned HTTP ${status}: ${serviceErrorText(data.error) || 'training failed'}`);
      }
      console.log(`[ml] Remote training succeeded: ${data.total_rows || '?'} rows, accuracy ${data.accuracy}, artifact ${formatMB(data.artifact_size_bytes || 0)}`);
      result = data;

      // The service trains in its own ephemeral /tmp — its model_path is
      // meaningless here. Without the artifact bytes there is nothing to keep.
      if (!result.model_artifact_base64) {
        throw new Error('ML training service returned no model artifact.');
      }
      const artifactBuffer = Buffer.from(result.model_artifact_base64, 'base64');
      const filename = modelArtifactFilename(result.model_filename) || `kindercura_model_${Date.now()}.joblib`;
      result.model_path = await persistModelArtifact(filename, artifactBuffer);
    } else {
      // ── Local Python Subprocess Execution ────────────────────────────────
      result = await new Promise((resolve, reject) => {
        const proc = spawn(
          'python',
          [TRAINER_SCRIPT, '--input', datasetPath, '--output', outputDir, '--feature-set', featureSet],
          { timeout: 300000 }
        );

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));

        proc.on('close', (code) => {
          try {
            const parsed = JSON.parse(stdout.trim());
            if (parsed.success) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error || 'Training failed with no details.'));
            }
          } catch (parseErr) {
            reject(
              new Error(
                `Training process exited with code ${code}. ` +
                `stdout: ${stdout.trim() || '(empty)'}. ` +
                `stderr: ${stderr.trim() || '(empty)'}`
              )
            );
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`Failed to start training process: ${err.message}`));
        });
      });

      // trainer.py reports the absolute path on THIS machine (e.g. a Windows
      // C:/Users/... path). Never record that: store the artifact under its
      // portable key (uploaded to R2 when object storage is on).
      const localArtifact = result.model_path;
      const filename = modelArtifactFilename(result.model_filename || localArtifact);
      result.model_path = await persistModelArtifact(filename, fs.readFileSync(localArtifact), { localCopy: localArtifact });
    }

    // ── Success: update candidate TrainedModel document ────────────────────
    if (modelDoc) {
      // Candidate model only — isActive remains false until explicit admin approval.
      modelDoc.modelPath = result.model_path;
      modelDoc.status = 'completed';
      modelDoc.trainedAt = new Date();

      // Flat metric fields
      modelDoc.accuracy = result.accuracy;
      modelDoc.precision = result.precision;
      modelDoc.recall = result.recall;
      modelDoc.f1Score = result.f1;

      // Structured metrics
      modelDoc.metrics = {
        accuracy: result.accuracy,
        precision: result.precision,
        recall: result.recall,
        f1_score: result.f1,
      };

      // Extended analytics
      modelDoc.featureImportances = result.feature_importances || {};
      modelDoc.perClassMetrics = result.per_class_metrics || {};
      modelDoc.confusionMatrix = result.confusion_matrix || null;
      modelDoc.classDistribution = result.class_distribution || null;
      modelDoc.classNames = result.class_names || [];
      modelDoc.featuresUsed = result.features_used || [];
      modelDoc.featureCount = result.feature_count || (result.features_used ? result.features_used.length : 0);
      modelDoc.featureSetType = result.feature_set_type || featureSet;
      modelDoc.trainingSamples = result.training_samples || 0;
      modelDoc.testSamples = result.test_samples || 0;
      modelDoc.totalRows = result.total_rows || 0;
      modelDoc.rowsDropped = result.rows_dropped || 0;

      await modelDoc.save();
    }

    return result;
  } catch (err) {
    if (modelDoc) {
      modelDoc.status = 'failed';
      modelDoc.errorMessage = err.message;
      await modelDoc.save();
    }
    throw err;
  }
}

/**
 * Resolve local disk path for a model file if it exists.
 */
function resolveModelPath(modelPath) {
  if (!modelPath) return null;
  const fileName = modelArtifactFilename(modelPath);
  if (!fileName) return null;
  const candidates = [
    path.join(MODEL_DIR, fileName),
    modelPath,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Upload (object storage on) or place (local disk) a trained artifact under
 * its portable key and return that key — the only form ever recorded as
 * TrainedModel.modelPath. Throws when the object store cannot confirm the
 * upload, so a model is never saved pointing at an artifact that isn't there.
 */
async function persistModelArtifact(filename, buffer, { localCopy = null } = {}) {
  const key = modelArtifactKey(filename);
  if (!key || !buffer || !buffer.length) throw new Error('Cannot store an empty model artifact.');

  if (fileStorage.USE_BLOB) {
    await fileStorage.storeFile(MODEL_STORE_DIR, filename, { buffer, mimetype: 'application/octet-stream' });
    const stored = await fileStorage.existsStored(MODEL_STORE_DIR, filename);
    if (!stored) throw new Error(`Model artifact upload could not be verified in object storage (key ${key}).`);
    console.log(`[ml] Model artifact stored in object storage: key=${key} size=${formatMB(buffer.length)}`);
  } else {
    const target = path.join(ensureModelDir(), filename);
    if (!localCopy || path.resolve(localCopy) !== path.resolve(target)) fs.writeFileSync(target, buffer);
    console.log(`[ml] Model artifact stored on local disk (object storage off): key=${key} size=${formatMB(buffer.length)}`);
  }
  if (buffer.length > MAX_REMOTE_ARTIFACT_BYTES) {
    console.warn(`[ml] Model artifact ${key} is ${formatMB(buffer.length)} — larger than the remote ML service can accept (${formatMB(MAX_REMOTE_ARTIFACT_BYTES)}).`);
  }
  return key;
}

/**
 * Load a model artifact. With object storage on, the object store (R2) is the
 * source of truth and is read first; local disk is the fallback (and the only
 * source when object storage is off). Resolves { buffer, source, key } or null.
 */
async function loadModelBuffer(modelPath) {
  const key = modelArtifactKey(modelPath);
  const filename = modelArtifactFilename(modelPath);
  if (!key) return null;

  const fromDisk = () => {
    const resolved = resolveModelPath(modelPath);
    return resolved ? { buffer: fs.readFileSync(resolved), source: 'local-disk', key, localPath: resolved } : null;
  };

  let loaded = null;
  if (fileStorage.USE_BLOB) {
    console.log(`[ml] Downloading model artifact from object storage: key=${key}`);
    const buffer = await fileStorage.readStored(MODEL_STORE_DIR, filename);
    loaded = buffer && buffer.length ? { buffer, source: 'object-storage', key } : fromDisk();
  } else {
    loaded = fromDisk();
  }

  if (loaded) {
    console.log(`[ml] Model artifact loaded: source=${loaded.source} key=${key} size=${formatMB(loaded.buffer.length)}`);
  } else {
    console.warn(`[ml] Model artifact not found: key=${key} (looked in ${fileStorage.USE_BLOB ? 'object storage, then local disk' : 'local disk'}; recorded modelPath=${modelPath})`);
  }
  return loaded;
}

/**
 * Where a recorded modelPath's artifact can be found, without downloading it
 * (object-store HEAD, or a local stat). Resolves { key, found, source, sizeBytes }.
 */
async function artifactStatus(modelPath) {
  const key = modelArtifactKey(modelPath);
  if (!key) return { key: null, found: false, source: null, sizeBytes: null };
  if (fileStorage.USE_BLOB) {
    const info = await fileStorage.statStored(MODEL_STORE_DIR, modelArtifactFilename(modelPath));
    if (info) return { key, found: true, source: 'object-storage', sizeBytes: info.size };
  }
  const local = resolveModelPath(modelPath);
  if (local) return { key, found: true, source: 'local-disk', sizeBytes: fs.statSync(local).size };
  return { key, found: false, source: null, sizeBytes: null };
}

// Mirrors ml/trainer.py: columns each feature set requires, and valid labels.
const TRAINING_REQUIRED_COLUMNS = {
  score_based: ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'risk_category'],
  question_based: [...Array.from({ length: 34 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`), 'risk_category'],
};
const VALID_RISK_LABELS = ['Low', 'Medium', 'High'];

/**
 * Check a CSV dataset before it is sent to the trainer: required columns,
 * row count and risk_category labels (case-insensitive, as the trainer
 * reads them). Resolves { ok, rows, columns, labelCounts, invalidLabels, error }.
 * Rows with an invalid label are reported, not rejected here — the trainer
 * drops them — but a file with no usable label at all is refused.
 */
function validateTrainingCsv(content, featureSet = 'score_based') {
  const lines = String(content || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { ok: false, rows: 0, error: 'The dataset has no data rows.' };
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const required = TRAINING_REQUIRED_COLUMNS[featureSet] || TRAINING_REQUIRED_COLUMNS.score_based;
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, rows: lines.length - 1, columns: header.length, error: `The dataset is missing required column(s) for ${featureSet} training: ${missing.join(', ')}.` };
  }
  const labelIndex = header.indexOf('risk_category');
  const labelCounts = {};
  let invalidLabels = 0;
  for (const line of lines.slice(1)) {
    const raw = (line.split(',')[labelIndex] || '').trim().replace(/^"|"$/g, '');
    const label = raw ? raw[0].toUpperCase() + raw.slice(1).toLowerCase() : '';
    if (VALID_RISK_LABELS.includes(label)) labelCounts[label] = (labelCounts[label] || 0) + 1;
    else invalidLabels += 1;
  }
  const rows = lines.length - 1;
  if (!Object.keys(labelCounts).length) {
    return { ok: false, rows, columns: header.length, labelCounts, invalidLabels, error: 'No row has a valid risk_category (expected Low, Medium or High).' };
  }
  return { ok: true, rows, columns: header.length, labelCounts, invalidLabels, error: null };
}

function buildRemoteTrainingPayload(datasetContent, fileType, featureSet) {
  const payload = { file_type: fileType, feature_set: featureSet };
  const raw = Buffer.from(String(datasetContent), 'utf8');
  if (raw.length > DATASET_GZIP_THRESHOLD_BYTES) {
    payload.dataset_content_gzip_base64 = zlib.gzipSync(raw).toString('base64');
  } else {
    payload.dataset_content = datasetContent;
  }
  return payload;
}


/**
 * B. getPrediction(modelPath, inputData)
 *
 * Predicts risk category for an assessment.
 * Uses /api/py/predict over HTTP in remote mode, or local predict.py spawn in local mode.
 */
async function getPrediction(modelPath, inputData) {
  const resolvedLocalPath = resolveModelPath(modelPath);

  if (isRemoteML() || (!resolvedLocalPath && fileStorage.USE_BLOB)) {
    const loaded = await loadModelBuffer(modelPath);
    if (!loaded) {
      throw new MlError('model_artifact_not_found', `Model artifact not found (key ${modelArtifactKey(modelPath) || '(none)'}) in ${fileStorage.USE_BLOB ? 'object storage' : 'local disk'}`);
    }
    if (loaded.buffer.length > MAX_REMOTE_ARTIFACT_BYTES) {
      throw new MlError('model_artifact_too_large', `Model artifact ${loaded.key} is ${formatMB(loaded.buffer.length)}, above the ${formatMB(MAX_REMOTE_ARTIFACT_BYTES)} the remote ML service accepts — retrain the model`);
    }

    const { ok, status, data } = await mlServiceRequest('/api/py/predict', {
      method: 'POST',
      body: JSON.stringify({ model_artifact_base64: loaded.buffer.toString('base64'), data: inputData }),
      timeoutMs: 60000,
    });
    if (!ok || !data.success) {
      const message = serviceErrorText(data.error) || `Prediction service returned HTTP ${status}`;
      const code = status === 401 ? 'ml_service_unauthorized' : /Could not load model/i.test(message) ? 'model_load_failed' : 'prediction_failed';
      throw new MlError(code, message);
    }
    return { ...data, artifact_source: loaded.source, artifact_key: loaded.key };
  }

  // Local child_process.spawn execution
  if (!resolvedLocalPath) {
    throw new MlError('model_artifact_not_found', `Model artifact not found on local disk (key ${modelArtifactKey(modelPath) || '(none)'})`);
  }

  const dataArg = JSON.stringify(inputData);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      [PREDICT_SCRIPT, '--model', resolvedLocalPath, '--data', dataArg],
      { timeout: 30000 }
    );


    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          resolve({ ...result, artifact_source: 'local-disk', artifact_key: modelArtifactKey(modelPath) });
        } else {
          const message = result.error || 'Prediction failed.';
          reject(new MlError(/Could not load model/i.test(message) ? 'model_load_failed' : 'prediction_failed', message));
        }
      } catch (parseErr) {
        reject(
          new Error(
            `Prediction process exited with code ${code}. ` +
            `stdout: ${stdout.trim() || '(empty)'}. ` +
            `stderr: ${stderr.trim() || '(empty)'}`
          )
        );
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start prediction process: ${err.message}`));
    });
  });
}

/**
 * C. getModelStatus(modelId)
 */
async function getModelStatus(modelId) {
  try {
    const doc = await TrainedModel.findById(modelId).lean();
    if (!doc) return null;

    return {
      id: String(doc._id),
      datasetId: doc.datasetId ? String(doc.datasetId) : null,
      version: doc.version,
      modelPath: doc.modelPath,
      status: doc.status,
      isActive: doc.isActive,
      trainedAt: doc.trainedAt,
      createdAt: doc.createdAt,
      errorMessage: doc.errorMessage || null,
      featureSetType: doc.featureSetType || 'score_based',
      featureCount: doc.featureCount || (Array.isArray(doc.featuresUsed) ? doc.featuresUsed.length : 0),
      featuresUsed: doc.featuresUsed || [],
      metrics: {
        accuracy: doc.metrics?.accuracy ?? doc.accuracy ?? 0,
        precision: doc.metrics?.precision ?? doc.precision ?? 0,
        recall: doc.metrics?.recall ?? doc.recall ?? 0,
        f1_score: doc.metrics?.f1_score ?? doc.f1Score ?? 0,
      },
    };
  } catch (err) {
    console.error('getModelStatus error:', err.message);
    return null;
  }
}

// Backward-compatible alias
const predict = getPrediction;

module.exports = {
  trainModel,
  getPrediction,
  getModelStatus,
  predict,
  checkPythonEnvironment,
  resolveDatasetPath,
  loadDatasetContent,
  ensureModelDir,
  isModelCompatible,
  // Pre-activation safety probe — see the "Activation smoke test" block above.
  smokeTestModel,
  buildSmokeTestProbe,
  modelArtifactExists,
  resolveModelPath,
  loadModelBuffer,
  artifactStatus,
  persistModelArtifact,
  modelArtifactKey,
  modelArtifactFilename,
  buildRemoteTrainingPayload,
  validateTrainingCsv,
  MAX_REMOTE_ARTIFACT_BYTES,
  MODEL_STORE_DIR,
  isRemoteML,
  getMLServiceUrl,
  getMLSecret,
  mlServiceRequest,
  mlServiceConfigProblem,
  checkRemoteEndpoint,
  serviceErrorText,
  MlError,
  MODEL_DIR,
  UNSUPPORTED_FEATURES,
};

