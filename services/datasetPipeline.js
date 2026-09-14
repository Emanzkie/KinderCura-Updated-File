// services/datasetPipeline.js
// ============================================================================
// Node bridge for REQUIREMENT B — the synthetic MODEL dataset pipeline.
//
// Runs ml/pipeline.py's generate + clean stages, then registers the CLEANED
// file as an ordinary TrainingDataset document so the rest of KinderCura
// treats it exactly like any other uploaded dataset.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------
// It does not train. Training stays with the ONE existing path —
// POST /api/admin/training/:id/train -> ml/model_manager.js -> ml/trainer.py —
// so there is no second training implementation to drift out of sync, and the
// dataset produced here is subject to exactly the same quality gate, candidate/
// active model lifecycle and metric recording as a hand-uploaded dataset.
// That is why the admin flow is two buttons ("Generate & Clean", then "Send to
// Model") rather than one: the second button is the existing endpoint.
//
// It also does not reimplement generation or cleaning in JavaScript. Both live
// in Python next to the trainer that consumes them, and are invoked here.
//
// PLATFORM NOTE
// -------------
// Generation requires a LOCAL Python with pandas/scikit-learn, because it
// spawns a child process and writes multi-megabyte files. That is the same
// constraint the local training path already has (ml/model_manager.js falls
// back to a remote /api/py/train service on Vercel, which has no equivalent
// generate endpoint and a read-only filesystem). On a deployment without local
// Python, checkPipelineEnvironment() reports it and the route returns a clear
// 503 telling the admin to run `npm run dataset:generate` locally and upload
// the resulting file through the existing Upload Dataset form.
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TrainingDataset = require('../models/TrainingDataset');
const fileStorage = require('./fileStorage');

const PROJECT_ROOT = path.join(__dirname, '..');
const PIPELINE_SCRIPT = path.join(PROJECT_ROOT, 'ml', 'pipeline.py');
const GENERATED_DIR = path.join(PROJECT_ROOT, 'ml', 'datasets', 'generated');

// Where the registered dataset file lands. Must match routes/admin.js's
// DATASET_DIR / DATASET_ACCESS so the existing training route can read it back.
const DATASET_DIR = 'public/uploads/datasets';
const DATASET_ACCESS = { access: 'private' };

// Bounds on the requested record count. The lower bound is the trainer's own
// 10-row floor with room for a stratified split; the upper bound keeps a
// mistyped request (50000000) from filling the disk.
const MIN_ROWS = 100;
const MAX_ROWS = 200000;
const DEFAULT_ROWS = 50000;
const DEFAULT_SEED = 20260903;
const DEFAULT_DEFECT_RATE = 0.02;

// Generation is CPU-bound and single-threaded; 50,000 rows takes a few seconds
// locally. Ten minutes is a ceiling for a pathological request, not an
// expectation.
const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;

/** Clamp and validate a requested record count. */
function normalizeRowCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(n)));
}

/** Directory the Python side writes raw/clean/report artifacts into. */
function resolveOutputDir() {
  try {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    fs.accessSync(GENERATED_DIR, fs.constants.W_OK);
    return GENERATED_DIR;
  } catch {
    // Read-only project filesystem (Vercel): fall back to the OS temp dir so
    // generation at least has somewhere to write.
    const tmp = path.join(os.tmpdir(), 'kindercura-datasets');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

/**
 * Verify a local Python with the ML dependencies is available.
 * Mirrors ml/model_manager.js checkPythonEnvironment()'s local branch, but is
 * deliberately separate: that function reports "ready" in remote mode, and
 * remote mode cannot generate a dataset.
 */
function checkPipelineEnvironment() {
  return new Promise((resolve) => {
    const proc = spawn('python', ['-c', 'import pandas, sklearn, joblib; print("OK")'], { timeout: 20000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim() === 'OK') {
        resolve({ ok: true, mode: 'local' });
      } else {
        resolve({
          ok: false,
          error:
            'Dataset generation needs a local Python 3 with pandas, scikit-learn and joblib. ' +
            'Install them with `pip install -r ml/requirements.txt`, or generate the dataset on a ' +
            'machine that has them (`npm run dataset:generate`) and upload the cleaned CSV using ' +
            'the Upload Dataset form above.\n' + (stderr || stdout || '').trim(),
        });
      }
    });
    proc.on('error', (err) => {
      resolve({
        ok: false,
        error:
          `Python is not available on this server (${err.message}). Generate the dataset locally ` +
          'with `npm run dataset:generate` and upload the cleaned CSV using the Upload Dataset form.',
      });
    });
  });
}

/**
 * Run ml/pipeline.py's generate + clean stages and return its report.
 *
 * --skip-training is always passed: see the header. --json makes the script
 * emit one machine-readable object on stdout and nothing else.
 */
function runGenerateAndClean({ rows, seed, defectRate, normalize }) {
  const outputDir = resolveOutputDir();
  const args = [
    PIPELINE_SCRIPT,
    '--rows', String(rows),
    '--seed', String(seed),
    '--defect-rate', String(defectRate),
    '--output-dir', outputDir,
    '--skip-training',
    '--json',
  ];
  if (normalize) args.push('--normalize');

  return new Promise((resolve, reject) => {
    const proc = spawn('python', args, { timeout: PIPELINE_TIMEOUT_MS, cwd: PROJECT_ROOT });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(
          `Dataset generation exited with code ${code}. ` +
          `stdout: ${stdout.trim().slice(0, 500) || '(empty)'} ` +
          `stderr: ${stderr.trim().slice(0, 500) || '(empty)'}`
        ));
        return;
      }
      if (!parsed.success) {
        reject(new Error(parsed.error || 'Dataset generation failed with no details.'));
        return;
      }
      resolve(parsed);
    });

    proc.on('error', (err) => reject(new Error(`Could not start dataset generation: ${err.message}`)));
  });
}

/** Header row of a CSV, as an array of column names. */
function readCsvHeader(csvText) {
  const firstLine = csvText.slice(0, csvText.indexOf('\n') === -1 ? undefined : csvText.indexOf('\n'));
  return firstLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
}

/**
 * Generate + clean a synthetic model dataset and register the CLEANED file as
 * a TrainingDataset the existing training route can consume.
 *
 * @param {object} options
 * @param {number} options.rows        requested record count (default 50,000)
 * @param {number} options.seed        PRNG seed for reproducibility
 * @param {number} options.defectRate  fraction of rows generated with defects
 * @param {boolean} options.normalize  min-max scale the score columns
 * @param {string} options.userId      admin who triggered the run
 * @returns {Promise<{dataset: object, report: object}>}
 */
async function generateDataset({ rows, seed, defectRate, normalize, userId }) {
  const env = await checkPipelineEnvironment();
  if (!env.ok) {
    const err = new Error(env.error);
    err.statusCode = 503;
    throw err;
  }

  const requestedRows = normalizeRowCount(rows);
  const usedSeed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : DEFAULT_SEED;
  const usedDefectRate = Number.isFinite(Number(defectRate))
    ? Math.min(0.5, Math.max(0, Number(defectRate)))
    : DEFAULT_DEFECT_RATE;

  const report = await runGenerateAndClean({
    rows: requestedRows,
    seed: usedSeed,
    defectRate: usedDefectRate,
    normalize: Boolean(normalize),
  });

  const cleanPath = report.files.clean;
  if (!fs.existsSync(cleanPath)) {
    throw new Error(`Cleaning reported success but the clean file is missing: ${cleanPath}`);
  }
  const buffer = fs.readFileSync(cleanPath);
  const csvText = buffer.toString('utf8');
  const columns = readCsvHeader(csvText);

  const storedName = `${Date.now()}_${report.dataset_version}_clean.csv`;
  await fileStorage.storeFile(
    DATASET_DIR,
    storedName,
    { buffer, mimetype: 'text/csv' },
    DATASET_ACCESS
  );

  const cleaning = report.cleaning || {};
  const generation = report.generation || {};

  const dataset = await TrainingDataset.create({
    name: `Synthetic Model Dataset — ${cleaning.final_records.toLocaleString('en-US')} records`,
    originalName: path.basename(cleanPath),
    storedName,
    filePath: `/uploads/datasets/${storedName}`,
    fileType: 'CSV',
    fileSize: buffer.length,
    // Row/column counts are the CLEANED file's real counts, straight from the
    // preprocessing run — never the requested figure.
    rowCount: cleaning.final_records,
    columnCount: columns.length,
    sampleColumns: columns.slice(0, 12),
    targetModule: 'assessment',
    notes:
      `Generated by ml/pipeline.py (seed ${generation.seed}, ${generation.requested_rows} requested). ` +
      `Cleaned: ${cleaning.original_records} read, ${cleaning.duplicates_removed} duplicates removed, ` +
      `${cleaning.invalid_records} invalid rejected, ${cleaning.final_records} training-ready. ` +
      'Synthetic data — not real patient records.',
    uploadedBy: userId,
    status: 'uploaded',
    provenance: { sourceType: 'synthetic' },
    syntheticPipeline: {
      datasetVersion: report.dataset_version,
      generator: {
        script: generation.script,
        seed: generation.seed,
        requestedRows: generation.requested_rows,
        generatedRows: generation.generated_rows,
        defectRate: generation.defect_rate,
        injectedDefects: generation.injected_defects,
      },
      cleaning: {
        originalRecords: cleaning.original_records,
        validRecords: cleaning.valid_records,
        invalidRecords: cleaning.invalid_records,
        duplicatesRemoved: cleaning.duplicates_removed,
        finalRecords: cleaning.final_records,
        rejectionsByReason: cleaning.rejections_by_reason,
        missingValuesFilled: cleaning.missing_values_filled,
        normalization: cleaning.normalization,
        encoding: cleaning.encoding,
        classDistribution: cleaning.class_distribution,
        warnings: cleaning.warnings,
      },
      files: report.files,
      generatedAt: report.finished_at || report.started_at,
      durationSeconds: report.duration_seconds,
    },
  });

  return { dataset, report };
}

module.exports = {
  DEFAULT_ROWS,
  DEFAULT_SEED,
  DEFAULT_DEFECT_RATE,
  MIN_ROWS,
  MAX_ROWS,
  normalizeRowCount,
  checkPipelineEnvironment,
  generateDataset,
};
