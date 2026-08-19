// ml/model_manager.js
// Purpose:
// - Bridge between Node.js and the Python ML scripts (trainer.py / predict.py)
// - Spawns Python as a child process, captures JSON output from stdout
// - Persists training results into the TrainedModel MongoDB collection
// - Validates that Python + required packages are available before attempting work
//
// Exported functions:
//   trainModel(datasetPath, datasetId)  – train a model, persist metrics to DB
//   getPrediction(modelPath, inputData) – predict risk category for one assessment
//   getModelStatus(modelId)             – query a TrainedModel document by ID
//   checkPythonEnvironment()            – verify Python + sklearn are available
//   resolveDatasetPath(filePath)        – locate a dataset file on disk
//   ensureModelDir()                    – create uploads/models/ if missing
//   predict(modelPath, scores)          – alias kept for backward compatibility

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TrainedModel = require('../models/TrainedModel');

// ── Path constants ──────────────────────────────────────────────────────
const MODEL_DIR = path.join(__dirname, '..', 'uploads', 'models');
const TRAINER_SCRIPT = path.join(__dirname, 'trainer.py');
const PREDICT_SCRIPT = path.join(__dirname, 'predict.py');

// Feature names the current pipeline no longer supports. gender_encoded was
// dropped from trainer.py/predict.py because trainer.py fit a LabelEncoder
// on gender at train time but never persisted it in the model artifact —
// predict.py had to guess the encoding, and could guess wrong. A model
// trained before that change still lists gender_encoded in its stored
// featuresUsed; it must not be used for live prediction.
const UNSUPPORTED_FEATURES = ['gender_encoded'];

/**
 * True when a TrainedModel document's feature set is still supported by the
 * current ml/predict.py. Callers (routes/ml.js, routes/recommendations.js)
 * must check this BEFORE calling predict() on an active model, so an
 * incompatible old model fails cleanly and predictably rather than throwing
 * out of a Python subprocess call.
 */
function isModelCompatible(trainedModelDoc) {
  const features = Array.isArray(trainedModelDoc?.featuresUsed) ? trainedModelDoc.featuresUsed : [];
  return !features.some((f) => UNSUPPORTED_FEATURES.includes(f));
}

// ── Helpers ─────────────────────────────────────────────────────────────

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
 * Datasets are stored under public/uploads/datasets/ with a filePath like
 * "/uploads/datasets/17xxxxx_name.csv".
 */
function resolveDatasetPath(filePath) {
  const fileName = filePath.replace(/^\/uploads\/datasets\//, '');

  const candidates = [
    path.join(__dirname, '..', 'public', 'uploads', 'datasets', fileName),
    path.join(__dirname, '..', 'uploads', 'datasets', fileName),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // If the caller passed an absolute or project-relative path, try it directly
  if (fs.existsSync(filePath)) return filePath;

  return null;
}

/**
 * Check that Python 3 and the required ML packages are available.
 * Returns { ok, python, error }.
 */
async function checkPythonEnvironment() {
  return new Promise((resolve) => {
    // Separate imports with semicolons and spawn without shell: true
    // to avoid PowerShell splitting the comma-separated Python import.
    const checkCode = 'import sklearn; import pandas; import joblib; print("OK")';
    const proc = spawn('python', ['-c', checkCode], { timeout: 15000 });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim() === 'OK') {
        resolve({ ok: true, python: 'python' });
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

// ── Core functions ──────────────────────────────────────────────────────

/**
 * A. trainModel(datasetPath, datasetId)
 *
 * Executes:  python ml/trainer.py --input <datasetPath> --output uploads/models/
 *
 * 1. Creates a TrainedModel doc with status 'training' in the database.
 * 2. Spawns the Python trainer as a child process and captures stdout/stderr.
 * 3. Parses the JSON metrics from stdout.
 * 4. On success → updates the doc to 'completed' with real metrics.
 * 5. On failure → updates the doc to 'failed' with the error message.
 * 6. Returns the result object (metrics + model path + DB doc id).
 *
 * @param {string} datasetPath  Absolute path to the CSV/JSON dataset file
 * @param {string} datasetId    The MongoDB _id of the TrainingDataset document
 * @returns {Promise<object>}   Resolved metrics object from trainer.py
 */
async function trainModel(datasetPath, datasetId, options = {}) {
  const outputDir = ensureModelDir();
  const featureSet = typeof options === 'string'
    ? options
    : (options?.featureSet || 'score_based');

  // Determine next model version
  const lastModel = await TrainedModel.findOne().sort({ version: -1 }).lean();
  const nextVersion = (lastModel?.version || 0) + 1;

  // Create a TrainedModel document in 'training' state so the admin UI can
  // show progress immediately.
  let modelDoc;
  if (datasetId) {
    modelDoc = await TrainedModel.create({
      datasetId,
      version: nextVersion,
      modelPath: '',
      status: 'training',
      featureSetType: featureSet,
    });
  }

  try {
    // Spawn the Python training script
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(
        'python',
        [TRAINER_SCRIPT, '--input', datasetPath, '--output', outputDir, '--feature-set', featureSet],
        { timeout: 300000 } // 5-minute max
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

    // ── Success: update the TrainedModel document with real metrics ──────
    if (modelDoc) {
      // Step 7: training NEVER activates a model, and NEVER touches the
      // currently active one. A model finishing training successfully is a
      // CANDIDATE only — isActive stays at its schema default (false) until
      // an admin explicitly approves it via POST /api/ml/models/:id/activate.
      // This is what protects real users from ever silently switching to
      // (e.g.) a model trained on synthetic/test data.
      modelDoc.modelPath = result.model_path;
      modelDoc.status = 'completed';
      modelDoc.trainedAt = new Date();

      // Flat metric fields (consumed by routes/ml.js and routes/admin.js)
      modelDoc.accuracy = result.accuracy;
      modelDoc.precision = result.precision;
      modelDoc.recall = result.recall;
      modelDoc.f1Score = result.f1;

      // Structured metrics sub-object (consumed by getModelStatus)
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
    // ── Failure: record the error in the database ───────────────────────
    if (modelDoc) {
      modelDoc.status = 'failed';
      modelDoc.errorMessage = err.message;
      await modelDoc.save();
    }
    throw err;
  }
}

/**
 * B. getPrediction(modelPath, inputData)
 *
 * Executes:  python ml/predict.py --model <modelPath> --data '<inputData JSON>'
 *
 * Passes the inputData object as a JSON string via the --data CLI argument.
 * Parses the JSON result from stdout containing:
 *   { success, risk_category, consultation_needed, probabilities, features_used }
 *
 * @param {string} modelPath  Absolute path to the .joblib model file
 * @param {object} inputData  Score fields (communication_score, social_score, etc.)
 * @returns {Promise<object>}  Prediction result with risk_category + probabilities
 */
async function getPrediction(modelPath, inputData) {
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const dataArg = JSON.stringify(inputData);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      [PREDICT_SCRIPT, '--model', modelPath, '--data', dataArg],
      { timeout: 30000 } // 30-second max
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          resolve(result);
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
 *
 * Queries the TrainedModel collection by _id and returns the current status,
 * metrics, and metadata.  Returns null if the model is not found.
 *
 * @param {string} modelId  MongoDB ObjectId string for the TrainedModel doc
 * @returns {Promise<object|null>}
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

// ── Backward-compatible alias ───────────────────────────────────────────
// routes/recommendations.js and routes/ml.js call `modelManager.predict()`
// so we keep that name as an alias for getPrediction.
const predict = getPrediction;

// ── Exports ─────────────────────────────────────────────────────────────
module.exports = {
  trainModel,
  getPrediction,
  getModelStatus,
  predict,             // backward-compat alias for getPrediction
  checkPythonEnvironment,
  resolveDatasetPath,
  ensureModelDir,
  isModelCompatible,
  MODEL_DIR,
};
