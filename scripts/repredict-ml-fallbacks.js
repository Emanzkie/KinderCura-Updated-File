// scripts/repredict-ml-fallbacks.js
// ============================================================================
// Re-runs the Random Forest prediction for assessment results whose ML step
// FAILED FOR A TECHNICAL REASON at submission time, and stores the result.
//
// WHY THIS IS NEEDED
// ------------------
// AssessmentResult.prediction is written once, at POST /submit, by
// services/assessmentProgress.js buildPredictionForStorage(). When the
// server handling the submission cannot reach the active model's artifact
// (e.g. the local dev server, which shares the Atlas database but keeps
// models only on local disk, while the artifact lives in R2), the ML step
// throws and a rule-based fallback is stored instead. The parent then sees
// "No ML prediction" for an assessment that the active model could have
// classified.
//
// WHAT IT DOES (and does not do)
// ------------------------------
//   * Only results with prediction.source 'rule_based' AND a technical
//     failure reason (RETRYABLE_REASON) are considered. A fallback for
//     no_active_model / active_model_incompatible / question_answers_
//     unavailable, or a legacy record with no reason, is an accurate
//     record of "no ML result was possible" and is never touched.
//   * Same model then as now: the most recent ML-sourced result stored
//     before the failure must have used the CURRENTLY active model version,
//     and that model must not have been activated after the failure.
//     Otherwise the run would attach a different model's answer to history.
//   * Same inputs: the child's age_months (a model feature) must be the same
//     today as at the failed submission.
//   * The prediction is produced by the existing buildPredictionForStorage()
//     with the stored scores and core-bank answers — nothing is computed
//     here. Only a result that comes back source 'ml' from the expected
//     model version is written; a second fallback is reported, not stored.
//   * Only the `prediction` field is written. Scores, Recommendation
//     documents (and their scheduled activities) and everything else stay
//     as they are.
//
// SAFETY
//   * --dry-run is the DEFAULT. Nothing is written without --apply.
//   * With --apply, the previous prediction of every affected result is
//     dumped to backups/ BEFORE any write; the run aborts if that fails.
//   * The update is conditional on the stored fallback still being in
//     place, so re-running is a no-op.
//
// USAGE
//   node scripts/repredict-ml-fallbacks.js              # dry run (default)
//   node scripts/repredict-ml-fallbacks.js --apply      # writes
// ============================================================================

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const AssessmentResult = require('../models/AssessmentResult');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const TrainedModel = require('../models/TrainedModel');
const Child = require('../models/Child');
const assessmentProgress = require('../services/assessmentProgress');
const { DATA_ORIGIN } = require('../constants/dataOrigin');

// MlError codes from ml/model_manager.js that mean "the model could not be
// reached or run", plus the generic catch-all in getMLCareStage.
const RETRYABLE_REASON = /^(model_artifact_not_found|model_load_failed|prediction_failed|ml_service_)/;

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');

function isRetryableReason(reason) {
  return typeof reason === 'string' && RETRYABLE_REASON.test(reason);
}

// Same formula as services/assessmentProgress.js getMLCareStage (age_months).
function ageMonthsAt(dateOfBirth, at) {
  const diffMs = new Date(at).getTime() - new Date(dateOfBirth).getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.4375)));
}

/** Why a candidate must be skipped, or null when it may be re-run. */
function skipReason({ result, child, activeModel, previousMlVersion, now }) {
  const failedAt = new Date(result.prediction.generatedAt);
  if (!activeModel) return 'no active model today';
  if (activeModel.activatedAt && new Date(activeModel.activatedAt) > failedAt) {
    return `active model v${activeModel.version} was activated after the failure`;
  }
  if (previousMlVersion !== activeModel.version) {
    return `model in use at the failure was v${previousMlVersion ?? 'unknown'}, active model is v${activeModel.version}`;
  }
  if (child?.dateOfBirth && ageMonthsAt(child.dateOfBirth, failedAt) !== ageMonthsAt(child.dateOfBirth, now)) {
    return 'child age_months has changed since the submission';
  }
  return null;
}

function isExpectedMlPrediction(prediction, activeModel) {
  return Boolean(prediction && prediction.source === 'ml' && prediction.riskCategory
    && prediction.modelVersion === activeModel.version);
}

async function run({ apply = false, now = new Date(), log = console.log, backup = writeBackup } = {}) {
  const activeModel = await TrainedModel.findOne({ isActive: true, status: 'completed' }).lean();
  const found = await AssessmentResult.find({
    'prediction.source': 'rule_based',
    'prediction.mlUnavailableReason': { $regex: RETRYABLE_REASON },
  }).lean();
  const candidates = found.filter((r) => r.prediction && r.prediction.source === 'rule_based' && isRetryableReason(r.prediction.mlUnavailableReason));

  log(`Active model: ${activeModel ? `v${activeModel.version}` : 'none'}`);
  log(`Results with a technical ML failure: ${candidates.length}`);

  const planned = [];
  const skipped = [];
  for (const result of candidates) {
    const id = String(result._id);
    const failedAt = new Date(result.prediction.generatedAt);
    const previousMl = await AssessmentResult.findOne({
      'prediction.source': 'ml',
      'prediction.generatedAt': { $lt: failedAt },
    }).sort({ 'prediction.generatedAt': -1 }).select('prediction.modelVersion').lean();
    const child = await Child.findById(result.childId).select('dateOfBirth').lean();

    const reason = skipReason({ result, child, activeModel, previousMlVersion: previousMl?.prediction?.modelVersion ?? null, now });
    if (reason) {
      skipped.push({ id, reason });
      log(`  skip …${id.slice(-6)} (${failedAt.toISOString()}): ${reason}`);
      continue;
    }

    // Exactly what POST /submit passes (routes/assessments.js).
    const answers = await AssessmentAnswer.find({ assessmentId: result.assessmentId, origin: DATA_ORIGIN.CORE_BANK }).lean();
    const answersByQuestion = Object.fromEntries(answers.map((a) => [String(a.questionId), String(a.answer ?? '')]));
    const scores = {
      communicationScore: result.communicationScore,
      socialScore: result.socialScore,
      cognitiveScore: result.cognitiveScore,
      motorScore: result.motorScore,
      overallScore: result.overallScore,
    };
    const prediction = await assessmentProgress.buildPredictionForStorage(scores, result.childId, answersByQuestion);
    if (!isExpectedMlPrediction(prediction, activeModel)) {
      const why = `re-run did not produce a v${activeModel.version} ML result (${prediction?.mlUnavailableReason || prediction?.source || 'no result'})`;
      skipped.push({ id, reason: why });
      log(`  skip …${id.slice(-6)} (${failedAt.toISOString()}): ${why}`);
      continue;
    }
    planned.push({ id, previous: result.prediction, prediction });
    log(`  ${apply ? 'write' : 'would write'} …${id.slice(-6)} (${failedAt.toISOString()}): riskCategory=${prediction.riskCategory} (model v${prediction.modelVersion})`);
  }

  let written = 0;
  if (apply && planned.length) {
    await backup(planned.map((p) => ({ resultId: p.id, prediction: p.previous })));
    for (const p of planned) {
      const res = await AssessmentResult.updateOne(
        { _id: p.id, 'prediction.source': 'rule_based', 'prediction.mlUnavailableReason': p.previous.mlUnavailableReason },
        { $set: { prediction: p.prediction } }
      );
      written += res?.modifiedCount || 0;
    }
  }

  log(`\n${apply ? 'APPLIED' : 'DRY RUN — nothing written'}: ${planned.length} to write, ${written} written, ${skipped.length} skipped.`);
  return { planned, skipped, written };
}

function writeBackup(rows) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `ml-repredict-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(check) || check.length !== rows.length) throw new Error('backup verification failed');
  console.log(`Backup written & verified: ${path.relative(ROOT, file)} (${rows.length} result(s))`);
}

async function main() {
  require('dotenv').config();
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) {
    console.error('Refusing to run: --apply and --dry-run are mutually exclusive.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }
  console.log(`KinderCura — re-run failed ML predictions. Mode: ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    await run({ apply });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('\nRe-prediction failed:', err.message);
    try { await mongoose.disconnect(); } catch { /* already closed */ }
    process.exit(1);
  });
}

module.exports = { RETRYABLE_REASON, isRetryableReason, ageMonthsAt, skipReason, isExpectedMlPrediction, run };
