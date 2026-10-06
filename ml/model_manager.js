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

/**
 * Base URL for the ML service.
 */
function getMLServiceUrl() {
  if (process.env.ML_SERVICE_URL) {
    return process.env.ML_SERVICE_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/+$/, '')}`;
  }
  return 'http://localhost:3000';
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
    const stored = await fileStorage.readStored('uploads/datasets', fileName);
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
    try {
      const url = `${getMLServiceUrl()}/api/py/train`;
      const secret = getMLSecret();
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'x-ml-secret': secret },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const data = await res.json();
        return { ok: true, python: data.python || 'remote-python', mode: 'remote' };
      }
      return {
        ok: false,
        error: `Python ML service returned HTTP ${res.status}: ${res.statusText}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Python ML service is unreachable: ${err.message}`,
      };
    }
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
      const secret = getMLSecret();
      const url = `${getMLServiceUrl()}/api/py/train`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ml-secret': secret,
        },
        body: JSON.stringify(buildRemoteTrainingPayload(datasetContent, fileType, featureSet)),
      });

      const data = await parseServiceResponse(response, 'ML training service');
      if (!response.ok || !data.success) {
        throw new Error(data.error || `ML training service returned HTTP ${response.status}`);
      }
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

/** JSON body of an ML service response, or a readable error (e.g. Vercel's plain-text 413). */
async function parseServiceResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 200) || '(empty body)'}`);
  }
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
      throw new Error(`Model artifact not found (key ${modelArtifactKey(modelPath) || '(none)'}) in ${fileStorage.USE_BLOB ? 'object storage' : 'local disk'}`);
    }
    if (loaded.buffer.length > MAX_REMOTE_ARTIFACT_BYTES) {
      throw new Error(`Model artifact ${loaded.key} is ${formatMB(loaded.buffer.length)}, above the ${formatMB(MAX_REMOTE_ARTIFACT_BYTES)} the remote ML service accepts — retrain the model`);
    }

    const artifactBase64 = loaded.buffer.toString('base64');
    const secret = getMLSecret();
    const url = `${getMLServiceUrl()}/api/py/predict`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ml-secret': secret,
      },
      body: JSON.stringify({
        model_artifact_base64: artifactBase64,
        data: inputData,
      }),
    });

    const result = await parseServiceResponse(response, 'Prediction service');
    if (!response.ok || !result.success) {
      throw new Error(result.error || `Prediction service returned HTTP ${response.status}`);
    }
    return { ...result, artifact_source: loaded.source, artifact_key: loaded.key };
  }

  // Local child_process.spawn execution
  if (!resolvedLocalPath) {
    throw new Error(`Model file not found: ${modelPath}`);
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
          reject(new Error(result.error || 'Prediction failed.'));
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
  persistModelArtifact,
  modelArtifactKey,
  modelArtifactFilename,
  buildRemoteTrainingPayload,
  MAX_REMOTE_ARTIFACT_BYTES,
  MODEL_STORE_DIR,
  isRemoteML,
  getMLServiceUrl,
  getMLSecret,
  MODEL_DIR,
  UNSUPPORTED_FEATURES,
};

