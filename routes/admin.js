// Admin routes (MongoDB version)
// Purpose:
// - dashboard counts and admin analytics
// - manage users
// - upload datasets for the admin training page
// - mark a dataset as trained so the admin can track model-preparation work

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');

const { authMiddleware, adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');
const Payment = require('../models/Payment');
const TrainingDataset = require('../models/TrainingDataset');
const Notification = require('../models/Notification');
const SystemSetting = require('../models/SystemSetting');
const paymentService = require('../services/paymentService');
const fileStorage = require('../services/fileStorage');
// Requirement B — synthetic MODEL dataset pipeline (generate + clean only;
// training stays with POST /training/:id/train). See services/datasetPipeline.js.
const datasetPipeline = require('../services/datasetPipeline');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const PediaCustomQuestion = require('../models/PediaCustomQuestion');
const PediaCustomQuestionAssignment = require('../models/PediaCustomQuestionAssignment');
const {
  DATA_ORIGIN,
  DATA_ORIGIN_LABELS,
  DATA_ORIGIN_VALUES,
  DATA_ORIGIN_SOURCE_KIND,
  APPROVAL_STATUS,
  approvalStatusLabel,
  generationMethodLabel,
} = require('../constants/dataOrigin');
// The completed reviewer round on the Dataset Question catalogue. Static
// catalogue data (no DB read) — surfaced so the admin page can show the
// REVIEWER decision as a fact distinct from PEDIATRICIAN approval. A reviewer
// "approve" never implies a pediatrician sign-off and never activates anything.
const { DATASET_REVIEW, DATASET_QUESTIONS } = require('../constants/datasetQuestions');
// approve | revise | reject → the label the admin page shows for the reviewer's
// wording decision. Kept separate from APPROVAL_STATUS_LABELS, which is the
// pediatrician lifecycle.
const REVIEWER_DECISION_LABELS = Object.freeze({
  approve: 'Approved',
  revise: 'Revision requested',
  reject: 'Rejected',
});
// DATASET_REVIEW.openMappingItems is the REVIEWER round's static record of
// which questions were approved on wording only, with a clinical question
// still open for a pediatrician to rule on (see constants/datasetQuestions.js
// — DQ09 today). Reviewer approval never closes that flag; only a pediatrician
// actually ruling on the question does, per docs/dataset-questions-open-issues.md
// and the DQ09 comment in constants/datasetQuestions.js ("approval of the
// wording did not settle the number"). So the flag is open only until the
// SAME question's live approvalStatus becomes APPROVED — computed here, never
// by editing the reviewer round's historical record.
function isMappingQuestionOpen(questionId, approvalStatus) {
  return DATASET_REVIEW.openMappingItems.includes(questionId) && approvalStatus !== APPROVAL_STATUS.APPROVED;
}

function datasetReviewerSummary(stillOpenMappingItems) {
  return {
    round: DATASET_REVIEW.round,
    decidedOn: DATASET_REVIEW.decidedOn,
    decision: DATASET_REVIEW.decision,
    decisionLabel: REVIEWER_DECISION_LABELS[DATASET_REVIEW.decision] || DATASET_REVIEW.decision,
    tally: DATASET_REVIEW.tally,
    openMappingItems: stillOpenMappingItems || DATASET_REVIEW.openMappingItems,
    caveat: DATASET_REVIEW.caveat,
    catalogueCount: DATASET_QUESTIONS.length,
  };
}
const sse = require('../sse');

function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return x.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fullName(doc) {
  if (!doc) return null;
  return `${doc.firstName || ''} ${doc.lastName || ''}`.trim() || null;
}

async function hydratePaymentAppointment(appointment) {
  const [child, parent, pediatrician] = await Promise.all([
    appointment.childId ? Child.findById(appointment.childId).lean() : null,
    appointment.parentId ? User.findById(appointment.parentId).lean() : null,
    appointment.pediatricianId ? User.findById(appointment.pediatricianId).lean() : null,
  ]);

  return {
    id: appointment.id,
    appointmentId: appointment.id,
    childName: fullName(child) || 'Unknown Child',
    parentName: fullName(parent) || 'Unknown Parent',
    pediatricianName: fullName(pediatrician),
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    status: appointment.status,
    paymentType: appointment.paymentType || null,
    paymentStatus: appointment.paymentStatus || 'Unpaid',
    totalAmount: appointment.totalAmount || 0,
    amountPaid: appointment.amountPaid || 0,
    balanceDue: appointment.balanceDue || 0,
    requiredDownPayment: paymentService.calculateRequiredDownPayment(appointment.totalAmount || 0),
    createdAt: appointment.createdAt,
  };
}

function ensureDatasetDir() {
  const dir = path.join(__dirname, '..', 'public', 'uploads', 'datasets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Project-relative folder. fileStorage maps it to disk locally and to Vercel
// Blob in production. Training data is patient-derived, so it stays private.
const DATASET_DIR = 'public/uploads/datasets';
const DATASET_ACCESS = { access: 'private' };

const datasetFilename = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const cleanBase = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
  cb(null, `${Date.now()}_${cleanBase}${ext}`);
};

const datasetStorage = fileStorage.makeStorage(DATASET_DIR, datasetFilename);

const datasetUpload = multer({
  storage: datasetStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.json'].includes(ext)) return cb(null, true);
    cb(new Error('Only CSV and JSON datasets are allowed.'));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Takes the file's text rather than a path, so it works for both a file on
// disk and an upload still buffered in memory on its way to blob storage.
function parseDatasetContent(raw, ext) {
  if (ext === '.json') {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const first = parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : {};
      const columns = Object.keys(first);
      return {
        rowCount: parsed.length,
        columnCount: columns.length,
        sampleColumns: columns.slice(0, 12),
      };
    }

    if (parsed && typeof parsed === 'object') {
      const columns = Object.keys(parsed);
      return { rowCount: 1, columnCount: columns.length, sampleColumns: columns.slice(0, 12) };
    }

    return { rowCount: 0, columnCount: 0, sampleColumns: [] };
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rowCount: 0, columnCount: 0, sampleColumns: [] };
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return {
    rowCount: Math.max(lines.length - 1, 0),
    columnCount: headers.length,
    sampleColumns: headers.slice(0, 12),
  };
}

// ── Step 10: reviewed-assessment dataset export ───────────────────────────
// Turns pediatrician-reviewed assessments (Assessment.mlLabel, see
// routes/assessments.js POST /:assessmentId/ml-label) into rows in the same
// canonical shape as ml/datasets/kindercura_assessment_dataset.csv — but
// these rows are REAL, not synthetic. risk_category here is ALWAYS
// assessment.mlLabel.riskCategory (the pediatrician's reviewed label) —
// never AssessmentResult.prediction (the ML's own output) and never a
// score threshold. Using either of those as "ground truth" would be
// exactly the circular-training mistake this feature exists to prevent.
function ageMonthsAt(dateOfBirth, atDate) {
  if (!dateOfBirth || !atDate) return null;
  const diffMs = new Date(atDate).getTime() - new Date(dateOfBirth).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return null;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.4375));
}

/**
 * Loads every eligible reviewed assessment and shapes it into canonical
 * dataset rows. Eligibility (all required, per Step 10 §6):
 *   - Assessment.status === 'complete'
 *   - Assessment.mlReviewStatus === 'reviewed'
 *   - Assessment.mlLabel.riskCategory is a valid Low/Medium/High
 *   - Assessment.mlLabel.reviewedBy exists
 *   - a matching AssessmentResult exists (real scores to export)
 * Anything that fails one of these is silently skipped and counted, never
 * exported with missing/invalid data.
 */
// Pure (no I/O) — the exact eligibility filter, split out so the rule
// itself (not just its effect) is unit-testable without a live DB.
function buildReviewedAssessmentFilter() {
  return {
    status: 'complete',
    mlReviewStatus: 'reviewed',
    'mlLabel.riskCategory': { $in: ['Low', 'Medium', 'High'] },
    'mlLabel.reviewedBy': { $exists: true, $ne: null },
  };
}

async function buildReviewedAssessmentExportRows() {
  const candidates = await Assessment.find(buildReviewedAssessmentFilter()).lean();

  const skipped = { noResult: 0 };
  if (!candidates.length) return { rows: [], total: 0, skipped, byLabel: { Low: 0, Medium: 0, High: 0 }, questionIds: [] };

  const assessmentIds = candidates.map((a) => a._id);
  const childIds = [...new Set(candidates.map((a) => String(a.childId)))];

  const [results, answers, children, questionDocs] = await Promise.all([
    AssessmentResult.find({ assessmentId: { $in: assessmentIds } }).lean(),
    AssessmentAnswer.find({ assessmentId: { $in: assessmentIds }, origin: DATA_ORIGIN.CORE_BANK }).lean(),
    Child.find({ _id: { $in: childIds } }).select('dateOfBirth').lean(),
    CoreBankQuestion.find({}).select('questionId').sort({ questionId: 1 }).lean(),
  ]);

  const resultByAssessment = new Map(results.map((r) => [String(r.assessmentId), r]));
  const childById = new Map(children.map((c) => [String(c._id), c]));
  const questionIds = questionDocs.map((q) => q.questionId);

  const answersByAssessment = new Map();
  for (const a of answers) {
    const key = String(a.assessmentId);
    if (!answersByAssessment.has(key)) answersByAssessment.set(key, new Map());
    answersByAssessment.get(key).set(a.questionId, a.answer);
  }

  // routes/assessments.js scoreAnswer(): yes=2, sometimes=1, anything else=0.
  const ANSWER_SCORE = { yes: 2, sometimes: 1, no: 0 };

  const rows = [];
  const byLabel = { Low: 0, Medium: 0, High: 0 };
  let refCounter = 0;

  for (const assessment of candidates) {
    const result = resultByAssessment.get(String(assessment._id));
    if (!result) { skipped.noResult += 1; continue; }

    refCounter += 1;
    const child = childById.get(String(assessment.childId));
    const ageMonths = ageMonthsAt(child?.dateOfBirth, assessment.completedAt || assessment.startedAt);
    const answerMap = answersByAssessment.get(String(assessment._id)) || new Map();

    const row = {
      assessment_ref: `REVIEWED-${String(refCounter).padStart(3, '0')}`,
      age_months: ageMonths != null ? ageMonths : '',
    };
    for (const qid of questionIds) {
      const answer = answerMap.get(qid);
      // Blank = not administered (age-gated) — NOT "0"/"no". Only a
      // recognized answer string is ever converted to a point value.
      row[qid] = Object.prototype.hasOwnProperty.call(ANSWER_SCORE, answer) ? ANSWER_SCORE[answer] : '';
    }
    row.communication_score = result.communicationScore;
    row.social_score = result.socialScore;
    row.cognitive_score = result.cognitiveScore;
    row.motor_score = result.motorScore;
    row.overall_score = result.overallScore;
    // The reviewed label ONLY — never the stored ML prediction.
    row.risk_category = assessment.mlLabel.riskCategory;

    // Step 12: internal-only fields for quality analysis (duplicate
    // detection, reviewer stats) — prefixed with `_` and never included in
    // rowsToCsv()'s output, which only reads the whitelisted CSV fieldnames
    // below. Never sent to the frontend either (see buildQualitySummary,
    // which reads these and strips them before responding).
    row._assessmentId = String(assessment._id);
    row._childId = String(assessment.childId);
    row._completedAt = assessment.completedAt || assessment.startedAt || null;
    row._reviewedBy = String(assessment.mlLabel.reviewedBy);
    row._reviewedAt = assessment.mlLabel.reviewedAt || null;

    byLabel[row.risk_category] = (byLabel[row.risk_category] || 0) + 1;
    rows.push(row);
  }

  return { rows, total: rows.length, skipped, byLabel, questionIds };
}

function rowsToCsv(rows, questionIds) {
  const fieldnames = ['assessment_ref', 'age_months', ...questionIds,
    'communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'risk_category'];
  const escapeCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(fieldnames.map((f) => escapeCell(row[f])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── Step 12: dataset readiness / quality control ───────────────────────────
// A technical, ML-pipeline-facing analysis of the SAME reviewed-assessment
// population buildReviewedAssessmentExportRows() already selects — this
// function calls it rather than re-querying, so the quality summary and the
// CSV export can never disagree about which assessments are eligible (see
// Step 12 task §13). This layer never touches mlLabel, never generates a
// label, and never claims clinical validity — it only characterizes what is
// technically available for ml/trainer.py to train on.

// ML-pipeline data-quality heuristics — NOT clinical thresholds. Chosen to
// match/reflect real constraints elsewhere in this codebase, documented
// per-constant below.
const QUALITY = Object.freeze({
  // Mirrors ml/trainer.py prepare_features()'s own hard minimum ("At least
  // 10 rows are needed for a meaningful model") — reused, not reinvented.
  MIN_ELIGIBLE_ROWS: 10,
  // sklearn's train_test_split(..., stratify=...) requires every represented
  // class to have at least 2 members (so at least 1 can land in each split).
  MIN_ROWS_PER_REPRESENTED_CLASS: 2,
  // Below this, a class is flagged even if it clears the hard minimum above.
  // A simple, documented, adjustable data-quality heuristic — not a claim
  // about what class balance is medically expected.
  CLASS_IMBALANCE_MAX_SHARE: 0.75,
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function summarizeMissingness(rows, questionIds) {
  const total = rows.length;
  const questionMissingness = {};
  for (const qid of questionIds) {
    const missing = rows.filter((r) => r[qid] === '').length;
    questionMissingness[qid] = { missing, total, percentage: total ? round2((missing / total) * 100) : 0 };
  }
  const scoreFields = ['age_months', 'communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score'];
  const scoreMissingness = {};
  for (const field of scoreFields) {
    const missing = rows.filter((r) => r[field] === '' || r[field] == null).length;
    scoreMissingness[field] = { missing, total, percentage: total ? round2((missing / total) * 100) : 0 };
  }
  return { questionMissingness, scoreMissingness };
}

/**
 * A duplicate here means the SAME real-world assessment event appears more
 * than once — approximated as two reviewed rows sharing both childId AND
 * completedAt. Deliberately NOT "same child appears more than once": a
 * child's legitimate reassessments always have different completedAt
 * timestamps and must never be flagged (Step 12 task §6 — this is what
 * makes longitudinal comparison work at all, see services/assessmentProgress.js).
 */
function detectDuplicates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row._childId}::${new Date(row._completedAt || 0).toISOString()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row._assessmentId);
  }
  let duplicateCount = 0;
  const duplicateGroups = [];
  for (const ids of groups.values()) {
    if (ids.length > 1) {
      duplicateCount += ids.length;
      duplicateGroups.push({ groupSize: ids.length });
    }
  }
  return { duplicateCount, duplicateGroups };
}

function summarizeAge(rows) {
  const values = rows.map((r) => r.age_months).filter((v) => v !== '' && v != null).sort((a, b) => a - b);
  if (!values.length) return { min: null, max: null, median: null, missingCount: rows.length };
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : round2((values[mid - 1] + values[mid]) / 2);
  return {
    min: values[0],
    max: values[values.length - 1],
    median,
    missingCount: rows.length - values.length,
  };
}

/**
 * Reviewer stats WITHOUT exposing raw pediatrician identifiers in the API
 * response — Step 12 task §9 ("the admin UI should show a privacy-safe
 * representation"). Assigns a stable-within-this-response pseudonym
 * ("Reviewer 1", "Reviewer 2", ...) by first-seen order; the real ObjectId
 * never leaves this function.
 */
function summarizeReviewers(rows) {
  const countByReviewer = new Map();
  let latestReviewAt = null;
  for (const row of rows) {
    countByReviewer.set(row._reviewedBy, (countByReviewer.get(row._reviewedBy) || 0) + 1);
    if (row._reviewedAt && (!latestReviewAt || new Date(row._reviewedAt) > new Date(latestReviewAt))) {
      latestReviewAt = row._reviewedAt;
    }
  }
  const reviewsByReviewer = [...countByReviewer.entries()].map(([, count], i) => ({
    reviewerRef: `Reviewer ${i + 1}`,
    count,
  }));
  return { uniqueReviewers: countByReviewer.size, latestReviewAt, reviewsByReviewer };
}

function summarizeClassDistribution(byLabel, total) {
  const classDistribution = {};
  for (const label of ['Low', 'Medium', 'High']) {
    const count = byLabel[label] || 0;
    classDistribution[label] = { count, percentage: total ? round2((count / total) * 100) : 0 };
  }
  return classDistribution;
}

/**
 * Assembles the full dataset-readiness/quality summary. Reuses
 * buildReviewedAssessmentExportRows() as the SINGLE source of the eligible
 * (exportable) row set — see module docstring above. Additionally queries
 * the broader "reviewed" population (without the strict validity filters)
 * purely to surface diagnostic flags for reviewed-but-ineligible records —
 * this does not create a second, competing eligibility rule; the exportable
 * set itself is computed exactly once, in exactly one place.
 */
async function buildReviewedAssessmentQualitySummary() {
  const exportResult = await buildReviewedAssessmentExportRows();
  const { rows, total: eligibleAssessments, skipped, byLabel, questionIds } = exportResult;

  const [totalReviewedAssessments, excludedAssessments] = await Promise.all([
    Assessment.countDocuments({ status: 'complete', mlReviewStatus: 'reviewed' }),
    Assessment.countDocuments({ mlReviewStatus: 'excluded' }),
  ]);

  const classDistribution = summarizeClassDistribution(byLabel, eligibleAssessments);
  const missingness = summarizeMissingness(rows, questionIds);
  const { duplicateCount, duplicateGroups } = detectDuplicates(rows);
  const ageStatistics = summarizeAge(rows);
  const reviewStatistics = summarizeReviewers(rows);

  // Reviewed-but-ineligible diagnostics: assessments marked 'reviewed' that
  // did NOT make it into the exportable set. skipped.noResult already comes
  // from buildReviewedAssessmentExportRows() itself (no duplicated query);
  // any further gap between totalReviewedAssessments and
  // (eligibleAssessments + skipped.noResult) means a document failed the
  // strict mlLabel validity filter (buildReviewedAssessmentFilter) despite
  // being marked 'reviewed' — e.g. reviewedBy or riskCategory missing/invalid.
  const unaccountedReviewed = Math.max(0, totalReviewedAssessments - eligibleAssessments - skipped.noResult);

  const qualityFlags = [];
  if (skipped.noResult > 0) {
    qualityFlags.push({ flag: 'missing_score', count: skipped.noResult, message: `${skipped.noResult} reviewed assessment(s) have no matching AssessmentResult and cannot be exported.` });
  }
  if (unaccountedReviewed > 0) {
    qualityFlags.push({ flag: 'invalid_label', count: unaccountedReviewed, message: `${unaccountedReviewed} assessment(s) are marked reviewed but have an invalid or incomplete mlLabel (missing riskCategory or reviewer) and were excluded from export.` });
  }
  if (duplicateCount > 0) {
    qualityFlags.push({ flag: 'duplicate_reference', count: duplicateCount, message: `${duplicateCount} eligible row(s) share the same child and completion timestamp as another row — likely duplicate submissions, not legitimate reassessments.` });
  }
  if (ageStatistics.missingCount > 0) {
    qualityFlags.push({ flag: 'age_data_missing', count: ageStatistics.missingCount, message: `${ageStatistics.missingCount} eligible row(s) have no computable age_months.` });
  }
  const zeroAnswerRows = rows.filter((r) => questionIds.every((qid) => r[qid] === '')).length;
  if (zeroAnswerRows > 0) {
    qualityFlags.push({ flag: 'missing_questions', count: zeroAnswerRows, message: `${zeroAnswerRows} eligible row(s) have no recorded answers for any core-bank question, despite being complete.` });
  }
  const maxShareEntry = Object.entries(classDistribution).reduce((max, [label, d]) => (d.count > (max?.count ?? -1) ? { label, ...d } : max), null);
  if (eligibleAssessments > 0 && maxShareEntry && maxShareEntry.percentage / 100 > QUALITY.CLASS_IMBALANCE_MAX_SHARE) {
    qualityFlags.push({ flag: 'unusual_class_distribution', message: `Class distribution is imbalanced (${maxShareEntry.label} accounts for ${maxShareEntry.percentage}% of eligible assessments) — a machine-learning data-quality heuristic, not a clinical claim.` });
  }
  if (eligibleAssessments > 0 && reviewStatistics.uniqueReviewers <= 1) {
    qualityFlags.push({ flag: 'single_reviewer', message: 'All eligible labels come from a single reviewer — no cross-reviewer consistency check is possible yet.' });
  }

  // ── Readiness: technical suitability for the CURRENT ml/trainer.py
  // pipeline, nothing more. Never "clinically valid"/"clinically invalid".
  const reasons = [];
  let blocked = false;

  if (eligibleAssessments < QUALITY.MIN_ELIGIBLE_ROWS) {
    blocked = true;
    reasons.push(`Only ${eligibleAssessments} eligible assessment(s) available (at least ${QUALITY.MIN_ELIGIBLE_ROWS} are required by the current training pipeline).`);
  }
  const underrepresentedClasses = Object.entries(classDistribution).filter(([, d]) => d.count > 0 && d.count < QUALITY.MIN_ROWS_PER_REPRESENTED_CLASS).map(([label]) => label);
  if (underrepresentedClasses.length) {
    blocked = true;
    reasons.push(`${underrepresentedClasses.join(', ')} class has fewer than ${QUALITY.MIN_ROWS_PER_REPRESENTED_CLASS} eligible example(s), which a stratified train/test split requires.`);
  }
  // Non-blocking flags still get surfaced as reasons for transparency, per
  // the Step 12 example response (imbalance appears alongside the row-count
  // blocker in one flat list).
  for (const qf of qualityFlags) reasons.push(qf.message);

  const status = blocked ? 'not_ready' : (qualityFlags.length ? 'warning' : 'ready');

  return {
    totalReviewedAssessments,
    eligibleAssessments,
    excludedAssessments,
    classDistribution,
    missingness,
    duplicateCount,
    duplicateGroups,
    ageStatistics,
    reviewStatistics,
    qualityFlags,
    readiness: {
      // "ready" means no HARD technical blocker — a WARNING dataset can
      // still be trained on if the admin chooses (Step 12 task §12: do not
      // automatically prevent training merely because it isn't perfect).
      ready: !blocked,
      status,
      reasons,
    },
  };
}

// ── Step 13: training-time quality gate ────────────────────────────────
// Reuses the SAME live readiness logic Step 12's quality endpoint uses
// (buildReviewedAssessmentQualitySummary, above) — this checks the CURRENT
// state of the reviewed-assessment population in the database, not a
// snapshot of the uploaded CSV, so it reflects reality even if reviews
// changed since export. Only applies when the dataset's provenance is
// explicitly 'reviewed_assessment' — synthetic/unknown datasets are never
// gated against reviewed-assessment readiness rules, which wouldn't mean
// anything for them. Extracted as its own function (rather than inlined in
// the route) so the gate decision itself is directly unit-testable without
// needing an HTTP layer.
async function resolveTrainingQualityGate(dataset) {
  if (dataset.provenance?.sourceType !== 'reviewed_assessment') {
    return { blocked: false, warnings: [], readiness: null };
  }
  const quality = await buildReviewedAssessmentQualitySummary();
  if (quality.readiness.status === 'not_ready') {
    return { blocked: true, warnings: [], readiness: quality.readiness };
  }
  const warnings = quality.readiness.status === 'warning' ? quality.readiness.reasons : [];
  return { blocked: false, warnings, readiness: quality.readiness };
}

// GET /api/admin/training/reviewed-assessments/quality
// Dataset readiness / quality-control summary for the reviewed-assessment
// export — see buildReviewedAssessmentQualitySummary() above. Purely
// descriptive: never modifies mlLabel, never generates a label, never
// claims clinical validity.
router.get('/training/reviewed-assessments/quality', authMiddleware, adminOnly, async (req, res) => {
  try {
    const summary = await buildReviewedAssessmentQualitySummary();
    res.json({ success: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/training/reviewed-assessments/summary
// How many reviewed assessments are currently available to export, broken
// down by label — lets the admin UI show a count before exporting.
router.get('/training/reviewed-assessments/summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { total, skipped, byLabel } = await buildReviewedAssessmentExportRows();
    res.json({ success: true, total, byLabel, skippedIncompleteResult: skipped.noResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/training/reviewed-assessments/export
// Downloads the reviewed-assessment rows as a CSV in the canonical dataset
// shape (see ml/datasets/README.md). Does NOT register a TrainingDataset or
// train anything — the admin reviews the file, then uploads it through the
// existing POST /training/upload flow like any other dataset (workflow:
// export -> admin review -> upload -> train -> candidate -> explicit activate).
// No PII: no child/parent name, email, phone, address, or Mongo _id is
// included — assessment_ref is a synthetic sequential label.
router.get('/training/reviewed-assessments/export', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows, questionIds } = await buildReviewedAssessmentExportRows();
    if (!rows.length) {
      return res.status(404).json({ error: 'No reviewed assessments are available to export yet.' });
    }
    const csv = rowsToCsv(rows, questionIds);
    const filename = `kindercura-reviewed-assessments-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function safeRemoveUpload(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/datasets/')) return;
  const fileName = publicPath.replace('/uploads/datasets/', '');
  fileStorage.deleteStored(DATASET_DIR, fileName, DATASET_ACCESS);
}

function resolveNotificationModel() {
  if (!Notification) return null;
  if (typeof Notification.create === 'function') return Notification;
  if (Notification.default && typeof Notification.default.create === 'function') return Notification.default;
  if (Notification.Notification && typeof Notification.Notification.create === 'function') return Notification.Notification;
  return null;
}

async function getSystemSettingsDoc() {
  return SystemSetting.findOneAndUpdate(
    { singleton: 'default' },
    { $setOnInsert: { singleton: 'default', appointmentSlots: { enforceThirtyMinuteSlots: true, slotMinutes: 60 } } },
    { new: true, upsert: true }
  );
}

function formatAppointmentSlotSettings(doc) {
  return {
    enforceThirtyMinuteSlots: Boolean(doc?.appointmentSlots?.enforceThirtyMinuteSlots ?? true),
    slotMinutes: 60,
  };
}

async function nextNotificationId() {
  try {
    const counters = mongoose.connection.collection('counters');
    const result = await counters.findOneAndUpdate({ _id: 'notifications' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    if (result?.value?.seq != null) return result.value.seq;
    const doc = await counters.findOne({ _id: 'notifications' });
    if (doc?.seq != null) return doc.seq;
  } catch (err) {
    console.warn('Admin notification counter fallback error:', err.message);
  }
  return Date.now();
}

// Notifications must never block the admin approval flow.
async function pushNotification(userId, title, message, type = 'admin', relatedPage = '/admin/admin-dashboard.html') {
  const payload = { userId: new mongoose.Types.ObjectId(String(userId)), title, message, type, relatedPage, isRead: false };
  const notificationModel = resolveNotificationModel();
  try {
    if (notificationModel) {
      await notificationModel.create(payload);
      return;
    }
  } catch (err) {
    console.warn('Admin notification model create failed, using collection fallback:', err.message);
  }
  try {
    await mongoose.connection.collection('notifications').insertOne({ ...payload, id: await nextNotificationId(), createdAt: new Date() });
  } catch (err) {
    console.warn('Admin notification insert fallback failed:', err.message);
  }
}

// GET /api/admin/dashboard
router.get('/dashboard', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [
      totalUsers,
      activeAssessments,
      completedScreenings,
      parentCount,
      pediatricianCount,
      adminCount,
      secretaryCount,
      childCount,
      latestUsers,
      latestAppointments,
      latestAssessments,
      paymentAppointments,
      trainingDatasetCount,
      trainedDatasetCount,
    ] = await Promise.all([
      User.countDocuments(),
      Assessment.countDocuments({ status: 'in_progress' }),
      Assessment.countDocuments({ status: { $in: ['submitted', 'complete'] } }),
      User.countDocuments({ role: 'parent' }),
      User.countDocuments({ role: 'pediatrician' }),
      User.countDocuments({ role: 'admin' }),
      // Important: count secretary accounts separately for the admin dashboard stats.
      User.countDocuments({ role: 'secretary' }),
      Child.countDocuments(),
      User.find().sort({ createdAt: -1 }).limit(3).lean(),
      Appointment.find().sort({ createdAt: -1 }).limit(3).lean(),
      Assessment.find().sort({ createdAt: -1 }).limit(3).lean(),
      Appointment.find().sort({ createdAt: -1 }).limit(12).lean(),
      TrainingDataset.countDocuments(),
      TrainingDataset.countDocuments({ status: 'trained' }),
    ]);

    const recentTraining = await TrainingDataset.find().sort({ updatedAt: -1 }).limit(2).lean();
    const recentPaymentAppointments = [];
    for (const appointment of paymentAppointments) {
      recentPaymentAppointments.push(await hydratePaymentAppointment(appointment));
    }

    const recentActivity = [
      ...latestUsers.map((u) => ({
        when: u.createdAt,
        type: 'User Registered',
        description: `${u.firstName} ${u.lastName} joined as ${u.role}.`,
      })),
      ...latestAppointments.map((a) => ({
        when: a.createdAt,
        type: 'Appointment Booked',
        description: `Appointment #${a.id} was booked with status ${a.status}.`,
      })),
      ...latestAssessments.map((a) => ({
        when: a.createdAt || a.startedAt,
        type: 'Assessment Activity',
        description: `Assessment ${a.status} recorded.`,
      })),
      ...recentTraining.map((d) => ({
        when: d.updatedAt || d.createdAt,
        type: d.status === 'trained' ? 'Dataset Trained' : 'Dataset Uploaded',
        description: `${d.name} (${d.rowCount || 0} rows) is currently marked as ${d.status}.`,
      })),
    ]
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, 6)
      .map((a) => ({ ...a, timestamp: fmtDate(a.when) }));

    res.json({
      success: true,
      totalUsers,
      activeAssessments,
      completedScreenings,
      uptime: '99.9%',
      parentCount,
      pediatricianCount,
      adminCount,
      secretaryCount,
      childCount,
      trainingDatasetCount,
      trainedDatasetCount,
      recentActivity,
      paymentAppointments: recentPaymentAppointments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users
router.get('/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { role, status, search = '' } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (search) {
      const rx = new RegExp(search, 'i');
      filter.$or = [
        { firstName: rx },
        { lastName: rx },
        { email: rx },
        { username: rx },
      ];
    }

    const users = await User.find(filter).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      users: users.map((u) => ({
        id: String(u._id),
        firstName: u.firstName,
        lastName: u.lastName,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: fmtDate(u.createdAt),
        licenseNumber: u.licenseNumber || null,
        institution: u.institution || null,
        specialization: u.specialization || null,
        organization: u.organization || null,
        department: u.department || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/approve
router.post('/users/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findByIdAndUpdate(userId, { status: 'active' }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    sse.broadcast('analytics:update', { type: 'user', action: 'approve', role: user.role });

    // Pediatricians should be told when their account is approved.
    if (user.role === 'pediatrician') {
      await pushNotification(
        user._id,
        'Account approved',
        'Your pediatrician account has been approved. You can now log in and start using KinderCura.',
        'admin',
        '/pedia/pediatrician-dashboard.html'
      );
    }

    res.json({ success: true, message: 'User approved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users/suspend
router.post('/users/suspend', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findByIdAndUpdate(userId, { status: 'suspended' }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    sse.broadcast('analytics:update', { type: 'user', action: 'suspend', role: user.role });

    res.json({ success: true, message: 'User suspended.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics
router.get('/analytics', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [
      avgScoresResult,
      monthlySignupsResult,
      apptStatsResult,
      roleStatsResult,
      datasetStatsResult,
      financialTotalsResult,
      paymentTypeBreakdownResult,
      paymentStatusStatsResult,
      summaryResult,
      activeUsers,
      activeAppointments,
    ] = await Promise.all([
      AssessmentResult.aggregate([
        { $match: { generatedAt: { $exists: true } } },
        {
          $group: {
            _id: null,
            avgCommunication: { $avg: '$communicationScore' },
            avgSocial: { $avg: '$socialScore' },
            avgCognitive: { $avg: '$cognitiveScore' },
            avgMotor: { $avg: '$motorScore' },
          },
        },
      ]),
      User.aggregate([
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
      ]),
      Appointment.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      User.aggregate([
        { $match: { role: { $exists: true } } },
        {
          $group: {
            _id: '$role',
            count: { $sum: 1 },
          },
        },
      ]),
      TrainingDataset.aggregate([
        { $match: { status: { $exists: true } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Appointment.aggregate([
        { $match: { status: { $nin: ['cancelled', 'rejected'] } } },
        {
          $group: {
            _id: null,
            totalBilled: { $sum: { $ifNull: ['$totalAmount', 0] } },
            totalOutstanding: { $sum: { $ifNull: ['$balanceDue', 0] } },
          },
        },
      ]),
      Payment.aggregate([
        {
          $group: {
            _id: '$paymentType',
            count: { $sum: 1 },
            totalCollected: { $sum: { $ifNull: ['$amount', { $ifNull: ['$amountPaid', 0] }] } },
          },
        },
        { $sort: { totalCollected: -1 } },
      ]),
      Appointment.aggregate([
        {
          $group: {
            _id: '$paymentStatus',
            count: { $sum: 1 },
            totalOutstanding: { $sum: { $ifNull: ['$balanceDue', 0] } },
          },
        },
      ]),
      Promise.all([
        User.countDocuments(),
        Child.countDocuments(),
        Assessment.countDocuments(),
        Assessment.countDocuments({ status: 'complete' }),
        Assessment.countDocuments({ status: 'in_progress' }),
        Appointment.countDocuments(),
      ]),
      User.countDocuments({ status: 'active' }),
      Appointment.countDocuments({ status: { $in: ['pending', 'approved'] } }),
    ]);

    const avg = avgScoresResult[0] || {};
    const averageScores = {
      avgCommunication: avg.avgCommunication != null ? Math.round(avg.avgCommunication) : 0,
      avgSocial: avg.avgSocial != null ? Math.round(avg.avgSocial) : 0,
      avgCognitive: avg.avgCognitive != null ? Math.round(avg.avgCognitive) : 0,
      avgMotor: avg.avgMotor != null ? Math.round(avg.avgMotor) : 0,
    };

    const now = new Date();
    const monthlyMap = {};
    monthlySignupsResult.forEach((m) => {
      monthlyMap[`${m._id.year}-${String(m._id.month).padStart(2, '0')}`] = m.count;
    });
    const monthlySignups = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlySignups.push({
        month: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        count: monthlyMap[key] || 0,
      });
    }

    const appointmentStats = apptStatsResult.map((a) => ({
      status: a._id,
      count: a.count,
    }));

    const roleBreakdown = roleStatsResult.map((r) => ({
      role: r._id,
      count: r.count,
    }));

    const datasetStats = datasetStatsResult.map((d) => ({
      status: d._id,
      count: d.count,
    }));

    const financialTotals = financialTotalsResult[0] || {};
    const paymentTypeBreakdown = paymentTypeBreakdownResult.map((item) => ({
      paymentType: item._id || 'unknown',
      paymentTypeLabel: paymentService.paymentTypeLabel(item._id) || 'Unknown',
      count: item.count,
      totalCollected: paymentService.roundCurrency(item.totalCollected || 0),
    }));
    const paymentStatusBreakdown = paymentStatusStatsResult.map((item) => ({
      paymentStatus: item._id || 'Unpaid',
      count: item.count,
      totalOutstanding: paymentService.roundCurrency(item.totalOutstanding || 0),
    }));
    const totalCollected = paymentTypeBreakdown.reduce((sum, item) => sum + (item.totalCollected || 0), 0);
    const financialSummary = {
      totalCollected: paymentService.roundCurrency(totalCollected),
      totalOutstanding: paymentService.roundCurrency(financialTotals.totalOutstanding || 0),
      totalBilled: paymentService.roundCurrency(financialTotals.totalBilled || 0),
      paymentTypeBreakdown,
      paymentStatusBreakdown,
    };

    const [totalUsers, totalChildren, totalAssessments, completedScreenings, inProgressScreenings, totalAppointments] = summaryResult;

    const summaryTotals = {
      totalUsers,
      totalChildren,
      totalAssessments,
      completedScreenings,
      inProgressScreenings,
      activeUsers,
      activeAppointments,
      totalAppointments,
    };

    res.json({
      success: true,
      averageScores,
      monthlySignups,
      appointmentStats,
      roleBreakdown,
      datasetStats,
      financialSummary,
      summaryTotals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/export-data
router.get('/export-data', authMiddleware, adminOnly, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      data: users.map((u) => ({
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Derives a dataset's display provenance. Prefers the STRUCTURED
// provenance.sourceType field (set explicitly at upload time — see POST
// /training/upload) whenever it's recorded; only falls back to the Step 10
// filename heuristic for datasets uploaded before that field existed
// (provenance.sourceType is 'unknown'/unset) — never overrides an explicitly
// recorded value. Extracted as its own function so this is directly
// unit-testable without going through the route/HTTP layer.
function computeDatasetProvenance(d) {
  const recordedSourceType = d.provenance?.sourceType;
  const n = `${d.name || ''} ${d.originalName || ''}`.toLowerCase();
  // NOTE: \b does not work here — '_' is a word character, so \bdemo\b
  // fails on 'kindercura_demo_training_dataset'. Treat any non-alphanumeric
  // (including '_') as the boundary instead.
  const selfDeclaredDemo =
    /(^|[^a-z0-9])(demo|sample|synthetic|fixture|mock|dummy|test)([^a-z0-9]|$)/.test(n) ||
    /_style|-style/.test(n);
  const isReviewedAssessmentExport = /reviewed[-_]?assessment/.test(n);
  // Real instruments these filenames gesture at. Naming one does not
  // make a file contain its data — that is exactly the confusion to kill.
  const imitates = [];
  if (/ecdi\s*2030|ecdi2030/.test(n)) imitates.push('ECDI2030 (UNICEF)');
  if (/dscore|d-score|childdevdata/.test(n)) imitates.push('D-score / childdevdata');
  if (/kindercura/.test(n)) imitates.push('KinderCura screening export');

  const sourceType = (recordedSourceType && recordedSourceType !== 'unknown')
    ? recordedSourceType
    : (isReviewedAssessmentExport ? 'reviewed_assessment' : (selfDeclaredDemo ? 'synthetic' : 'unrecorded'));
  const isSynthetic = sourceType === 'synthetic';
  const isReviewedAssessment = sourceType === 'reviewed_assessment';

  return {
    sourceType,
    recordedExplicitly: Boolean(recordedSourceType && recordedSourceType !== 'unknown'),
    recordedSource: d.notes && String(d.notes).trim() ? String(d.notes).trim() : null,
    isSynthetic,
    isReviewedAssessment,
    imitates,
    // Rendered verbatim by the UI. Never "Clinically Validated".
    label: isReviewedAssessment
      ? 'Reviewed Assessment Data'
      : (isSynthetic
        ? 'Test/Synthetic Data'
        : (d.notes && String(d.notes).trim() ? String(d.notes).trim() : 'not recorded')),
  };
}

// GET /api/admin/training/datasets
// Loads dataset cards and the admin upload/training table.
router.get('/training/datasets', authMiddleware, adminOnly, async (req, res) => {
  try {
    const docs = await TrainingDataset.find().sort({ createdAt: -1 }).populate('uploadedBy', 'firstName lastName').populate('trainedBy', 'firstName lastName').lean();

    // ── Model linkage (read-only) ────────────────────────────────────────
    // Resolves each dataset's modelId to the actual TrainedModel so the admin
    // page can say "used to train Model v4" instead of leaving the reader to
    // correlate two tables by hand. Purely additive to the RESPONSE — no
    // document is written, and nothing about training or activation changes.
    const TrainedModelRefForLink = require('../models/TrainedModel');
    const linkedModelIds = docs.map((d) => d.modelId).filter(Boolean);
    const linkedModels = linkedModelIds.length
      ? await TrainedModelRefForLink.find({ _id: { $in: linkedModelIds } })
          .select('version status isActive accuracy trainedAt totalRows trainingSamples testSamples')
          .lean()
      : [];
    const modelById = new Map(linkedModels.map((m) => [String(m._id), m]));

    const datasets = docs.map((d) => ({
      id: String(d._id),
      name: d.name,
      originalName: d.originalName,
      storedName: d.storedName,
      filePath: d.filePath,
      fileType: d.fileType,
      fileSize: d.fileSize,
      rowCount: d.rowCount || 0,
      columnCount: d.columnCount || 0,
      sampleColumns: Array.isArray(d.sampleColumns) ? d.sampleColumns : [],
      targetModule: d.targetModule || 'general',
      notes: d.notes || '',
      status: d.status,
      uploadedByName: d.uploadedBy ? `${d.uploadedBy.firstName} ${d.uploadedBy.lastName}` : 'Admin',
      trainedByName: d.trainedBy ? `${d.trainedBy.firstName} ${d.trainedBy.lastName}` : null,
      trainingSummary: d.trainingSummary || null,
      trainingMetrics: d.trainingMetrics || null,
      errorMessage: d.errorMessage || null,
      modelId: d.modelId ? String(d.modelId) : null,
      uploadedAt: d.createdAt,
      updatedAt: d.updatedAt,
      trainedAt: d.trainedAt,

      // ── Provenance ────────────────────────────────────────────────────────
      // Step 13: prefers the STRUCTURED provenance.sourceType field (set
      // explicitly at upload time — see POST /training/upload) whenever it's
      // recorded. Only falls back to the Step 10 filename heuristic for
      // datasets uploaded before that field existed (provenance.sourceType
      // is 'unknown'/unset) — never overrides an explicitly recorded value.
      provenance: computeDatasetProvenance(d),

      // ── Additive display metadata (no stored field is changed) ─────────
      // The generation + cleaning report this dataset was produced with, when
      // it came from the synthetic pipeline (services/datasetPipeline.js).
      // null for every hand-uploaded dataset. This is what lets the admin page
      // show real cleaning counts instead of a hardcoded figure.
      syntheticPipeline: d.syntheticPipeline || null,
      isPipelineDataset: Boolean(d.syntheticPipeline),

      // The model this dataset actually produced, resolved from modelId.
      trainedModel: (() => {
        const m = d.modelId ? modelById.get(String(d.modelId)) : null;
        if (!m) return null;
        return {
          id: String(m._id),
          version: m.version,
          status: m.status,
          isActive: Boolean(m.isActive),
          accuracy: m.accuracy,
          trainedAt: m.trainedAt,
          // Rows the trainer actually fitted on, straight from the training
          // run — this is the number that proves which records were used.
          totalRows: m.totalRows,
          trainingSamples: m.trainingSamples,
          testSamples: m.testSamples,
        };
      })(),
    }));

    // "Models trained" MUST come from the trained_models collection — a model
    // exists only if a training run produced one. TrainingDataset.status is set
    // to 'trained' by a path that merely REGISTERS the file (see the
    // trainingSummary text: "…were registered by the admin page"), so counting
    // that flag reported 3 models while trained_models held 0 documents.
    const TrainedModelRef = require('../models/TrainedModel');
    const [modelsCompleted, modelsActive, modelsTotal, activeModelDoc] = await Promise.all([
      TrainedModelRef.countDocuments({ status: 'completed' }),
      TrainedModelRef.countDocuments({ isActive: true, status: 'completed' }),
      TrainedModelRef.countDocuments({}),
      // The model currently serving live predictions. Read here so the admin
      // page's summary reports the ACTIVE model rather than "the newest one",
      // which are not always the same after a rollback.
      TrainedModelRef.findOne({ isActive: true, status: 'completed' })
        .select('version datasetId accuracy trainedAt totalRows trainingSamples testSamples featureSetType')
        .lean(),
    ]);

    const datasetsFlaggedTrained = datasets.filter((d) => d.status === 'trained').length;
    const latestUpdatedDataset = datasets.reduce((latest, dataset) => {
      const value = dataset.updatedAt || dataset.trainedAt || dataset.uploadedAt;
      if (!value) return latest;
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) return latest;
      return !latest || time > new Date(latest).getTime() ? value : latest;
    }, null);

    const summary = {
      total: datasets.length,
      ready: datasets.filter((d) => !['training', 'failed'].includes(d.status)).length,
      processing: datasets.filter((d) => d.status === 'training').length,
      uploaded: datasets.filter((d) => d.status === 'uploaded').length,
      // Authoritative: real model artifacts only.
      trained: modelsCompleted,
      failed: datasets.filter((d) => d.status === 'failed').length,
      totalRows: datasets.reduce((sum, d) => sum + (d.rowCount || 0), 0),

      // Kept separate and explicitly named so the two can never be conflated
      // again. The UI shows the discrepancy rather than hiding it.
      modelsCompleted,
      modelsActive,
      modelsTotal,
      datasetsFlaggedTrained,
      // True when datasets claim training that produced no model artifact.
      flagMismatch: datasetsFlaggedTrained > 0 && modelsCompleted === 0,
      lastUpdated: latestUpdatedDataset,

      // The model live predictions currently use, or null when none is active
      // (the rule-based fallback). Drives the "Current Model" tile.
      activeModel: activeModelDoc
        ? {
            version: activeModelDoc.version,
            datasetId: activeModelDoc.datasetId ? String(activeModelDoc.datasetId) : null,
            accuracy: activeModelDoc.accuracy,
            trainedAt: activeModelDoc.trainedAt,
            totalRows: activeModelDoc.totalRows,
            trainingSamples: activeModelDoc.trainingSamples,
            testSamples: activeModelDoc.testSamples,
            featureSetType: activeModelDoc.featureSetType || 'score_based',
          }
        : null,
    };

    res.json({ success: true, summary, datasets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/training/upload
// Stores dataset metadata and the uploaded file in /public/uploads/datasets.
router.post('/training/upload', authMiddleware, adminOnly, (req, res) => {
  datasetUpload.single('dataset')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Dataset file is required.' });

    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      // On blob-backed runs the bytes are still in memory; locally multer has
      // already written them. Parse first, then commit the file, so an
      // unparseable dataset never leaves a stored file behind.
      const raw = req.file.buffer
        ? req.file.buffer.toString('utf8')
        : fs.readFileSync(path.join(ensureDatasetDir(), req.file.filename), 'utf8');
      const parsed = parseDatasetContent(raw, ext);
      await fileStorage.storeFile(DATASET_DIR, req.file.filename, req.file, DATASET_ACCESS);

      // Step 13: structured provenance, set explicitly at upload time —
      // never inferred from the filename (that heuristic in GET
      // /training/datasets below is a fallback for datasets uploaded
      // before this field existed, not the primary source of truth).
      const SOURCE_TYPES = ['reviewed_assessment', 'synthetic', 'unknown'];
      const sourceType = SOURCE_TYPES.includes(req.body.sourceType) ? req.body.sourceType : 'unknown';

      const dataset = await TrainingDataset.create({
        name: String(req.body.name || path.basename(req.file.originalname, ext)).trim(),
        originalName: req.file.originalname,
        storedName: req.file.filename,
        filePath: `/uploads/datasets/${req.file.filename}`,
        fileType: ext.replace('.', '').toUpperCase(),
        fileSize: req.file.size,
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        sampleColumns: parsed.sampleColumns,
        targetModule: ['assessment', 'recommendation', 'general'].includes(req.body.targetModule) ? req.body.targetModule : 'general',
        notes: req.body.notes ? String(req.body.notes).trim() : null,
        uploadedBy: req.user.userId,
        status: 'uploaded',
        provenance: { sourceType },
      });

      sse.broadcast('analytics:update', { type: 'dataset', action: 'upload', targetModule: dataset.targetModule });

      res.status(201).json({ success: true, datasetId: String(dataset._id) });
    } catch (parseErr) {
      safeRemoveUpload(`/uploads/datasets/${req.file.filename}`);
      res.status(500).json({ error: parseErr.message });
    }
  });
});

// POST /api/admin/training/:id/train
// Triggers real ML training on the dataset via the Python pipeline.
// Training runs asynchronously — the response is immediate with status 'training'.
router.post('/training/:id/train', authMiddleware, adminOnly, async (req, res) => {
  try {
    const modelManager = require('../ml/model_manager');
    const TrainedModel = require('../models/TrainedModel');

    const dataset = await TrainingDataset.findById(req.params.id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });

    if (dataset.status === 'training') {
      return res.status(409).json({ error: 'This dataset is already being trained.' });
    }

    // Check Python environment before starting
    const envCheck = await modelManager.checkPythonEnvironment();
    if (!envCheck.ok) {
      return res.status(503).json({ error: envCheck.error });
    }

    // Resolve the file on disk or in storage
    let datasetPath = modelManager.resolveDatasetPath(dataset.filePath);
    let datasetContent = null;
    if (!datasetPath) {
      const storedName = dataset.storedName || path.basename(dataset.filePath);
      const storedBuffer = await fileStorage.readStored(DATASET_DIR, storedName, DATASET_ACCESS);
      if (storedBuffer) {
        datasetContent = storedBuffer.toString('utf8');
        datasetPath = `/uploads/datasets/${storedName}`;
      }
    }

    if (!datasetPath && !datasetContent) {
      return res.status(404).json({ error: `Dataset file not found: ${dataset.filePath}` });
    }


    // ── Step 13: quality gate for reviewed-assessment datasets ────────────
    const gate = await resolveTrainingQualityGate(dataset);
    if (gate.blocked) {
      return res.status(409).json({
        error: 'This reviewed-assessment dataset is not ready for training.',
        readiness: gate.readiness,
      });
    }
    const qualityWarnings = gate.warnings;

    // Mark as training
    dataset.status = 'training';
    dataset.errorMessage = null;
    await dataset.save();

    // Determine next model version
    const lastModel = await TrainedModel.findOne().sort({ version: -1 }).lean();
    const nextVersion = (lastModel?.version || 0) + 1;
    const featureSet = req.body?.featureSet || 'score_based';

    // Create placeholder model doc
    const modelDoc = await TrainedModel.create({
      datasetId: dataset._id,
      version: nextVersion,
      modelPath: '',
      status: 'training',
      featureSetType: featureSet,
      trainedBy: req.user.userId,
    });

    sse.broadcast('analytics:update', { type: 'ml', action: 'training_started', datasetId: String(dataset._id) });

    // Respond immediately so the UI can show the training state
    res.json({
      success: true,
      message: 'Training started. The page will update when training completes.',
      modelId: String(modelDoc._id),
      version: nextVersion,
    });

    // Run training in the background (async, no await in request handler).
    //
    // ownsModelDoc:false — this route already created `modelDoc` above and
    // fills in its metrics below. Without it, trainModel() creates a SECOND
    // TrainedModel for the same run: two 'completed' documents, consecutive
    // versions, identical modelPath and identical metrics, which made the
    // current model version impossible to report. (trained_models still holds
    // one such pair from before this fix — v2 and v3, same artifact, same
    // second.) Every other caller of trainModel() keeps the old behaviour.
    modelManager.trainModel(datasetPath, dataset._id, { featureSet, datasetContent, ownsModelDoc: false }).then(async (metrics) => {
      // Step 7: a successfully trained model is a CANDIDATE only. It does
      // NOT become active and the currently active model is left untouched
      // — an admin must explicitly activate it via the Trained Models panel
      // (POST /api/ml/models/:modelId/activate). This is what stops, e.g.,
      // a model trained from synthetic/test data from ever silently
      // becoming what real users' predictions are based on.
      modelDoc.modelPath = metrics.model_path;
      modelDoc.accuracy = metrics.accuracy;
      modelDoc.precision = metrics.precision;
      modelDoc.recall = metrics.recall;
      modelDoc.f1Score = metrics.f1;
      // Structured mirror of the four flat fields above. Populated here too
      // because consumers read one or the other and, until now, this path left
      // the sub-document at its zero defaults while the flat fields held the
      // real numbers — a model could report 65% accuracy and 0% accuracy at
      // the same time depending on which field was read.
      modelDoc.metrics = {
        accuracy: metrics.accuracy,
        precision: metrics.precision,
        recall: metrics.recall,
        f1_score: metrics.f1,
      };
      // When the run actually finished. Left null by this path before, which
      // is why the admin pages had no "last trained" timestamp to show.
      modelDoc.trainedAt = new Date();
      modelDoc.featureImportances = metrics.feature_importances;
      modelDoc.perClassMetrics = metrics.per_class_metrics || {};
      modelDoc.confusionMatrix = metrics.confusion_matrix || null;
      modelDoc.classDistribution = metrics.class_distribution || null;
      modelDoc.classNames = metrics.class_names || [];
      modelDoc.featuresUsed = metrics.features_used || [];
      modelDoc.featureCount = metrics.feature_count || (metrics.features_used ? metrics.features_used.length : 0);
      modelDoc.featureSetType = metrics.feature_set_type || featureSet;
      modelDoc.trainingSamples = metrics.training_samples;
      modelDoc.testSamples = metrics.test_samples;
      modelDoc.totalRows = metrics.total_rows || 0;
      modelDoc.rowsDropped = metrics.rows_dropped || 0;
      modelDoc.status = 'completed';
      // isActive intentionally not set here — stays false (schema default).
      await modelDoc.save();

      dataset.status = 'trained';
      dataset.trainedBy = req.user.userId;
      dataset.trainedAt = new Date();
      dataset.modelId = modelDoc._id;
      dataset.trainingMetrics = { accuracy: metrics.accuracy, precision: metrics.precision, recall: metrics.recall, f1: metrics.f1 };
      dataset.trainingSummary =
        `Model v${nextVersion}: ${(metrics.accuracy * 100).toFixed(1)}% accuracy. ` +
        `${metrics.training_samples} train / ${metrics.test_samples} test samples. ` +
        `Categories: ${(metrics.class_names || []).join(', ')}. ` +
        `Saved as a candidate — not active until approved in Trained Models.` +
        (qualityWarnings.length ? ` Reviewed-data quality warnings at training time: ${qualityWarnings.join(' ')}` : '');
      await dataset.save();

      sse.broadcast('analytics:update', { type: 'ml', action: 'training_completed', datasetId: String(dataset._id), accuracy: metrics.accuracy });
    }).catch(async (trainErr) => {
      console.error('ML training failed:', trainErr.message);
      // The failure handler must not be able to fail. Both writes below talk
      // to MongoDB, and a training run long enough to outlive a connection —
      // which a 50,000-row dataset is — will land here with a dead socket.
      // Before this guard, that second failure was an unhandled rejection, and
      // server.js's unhandledRejection handler shut the whole process down: a
      // transient Atlas blip during training took the entire app offline.
      // The dataset/model are left in 'training' when this happens, which the
      // admin pages already render as an in-progress run.
      try {
        modelDoc.status = 'failed';
        modelDoc.errorMessage = trainErr.message;
        await modelDoc.save();

        dataset.status = 'failed';
        dataset.errorMessage = trainErr.message;
        dataset.trainingSummary = `Training failed: ${trainErr.message}`;
        await dataset.save();

        sse.broadcast('analytics:update', { type: 'ml', action: 'training_failed', datasetId: String(dataset._id), error: trainErr.message });
      } catch (persistErr) {
        console.error('Could not persist the training failure state:', persistErr.message);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SYNTHETIC MODEL DATASET PIPELINE  (Requirement B)
//
// Generate -> validate -> clean -> register, exposed to the admin Data Sources
// page. Training is NOT here: the registered dataset is sent to the model
// through the EXISTING POST /training/:id/train above, so there is exactly one
// training implementation and the synthetic dataset goes through the same
// candidate/active model lifecycle as any hand-uploaded one.
//
// This pipeline is completely separate from the synthetic SYSTEM data
// (Requirement A, scripts/generate-system-demo-data.js). It creates no users,
// no children and no assessments — only a TrainingDataset document and a CSV.
// ────────────────────────────────────────────────────────────────────────────

// GET /api/admin/dataset-pipeline/status
// Everything the admin pages need to report the CURRENT state of the model
// dataset and the model trained from it. Every number is read from MongoDB or
// from a stored pipeline report — none is computed for display.
router.get('/dataset-pipeline/status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const TrainedModelRef = require('../models/TrainedModel');

    // The most recent dataset this pipeline produced. Identified by the
    // presence of a syntheticPipeline report, not by name or filename.
    const dataset = await TrainingDataset.findOne({ syntheticPipeline: { $ne: null } })
      .sort({ createdAt: -1 })
      .populate('uploadedBy', 'firstName lastName')
      .lean();

    let model = null;
    if (dataset) {
      // The latest COMPLETED model trained from this dataset. A run that is
      // still going, or failed, is reported separately below rather than being
      // presented as if it had produced metrics.
      model = await TrainedModelRef.findOne({ datasetId: dataset._id })
        .sort({ createdAt: -1 })
        .lean();
    }

    const [pipelineDatasetCount, environment] = await Promise.all([
      TrainingDataset.countDocuments({ syntheticPipeline: { $ne: null } }),
      datasetPipeline.checkPipelineEnvironment(),
    ]);

    res.json({
      success: true,
      environment: { ready: environment.ok, error: environment.ok ? null : environment.error },
      limits: {
        minRows: datasetPipeline.MIN_ROWS,
        maxRows: datasetPipeline.MAX_ROWS,
        defaultRows: datasetPipeline.DEFAULT_ROWS,
        defaultSeed: datasetPipeline.DEFAULT_SEED,
        defaultDefectRate: datasetPipeline.DEFAULT_DEFECT_RATE,
      },
      pipelineDatasetCount,
      dataset: dataset
        ? {
            id: String(dataset._id),
            name: dataset.name,
            status: dataset.status,
            rowCount: dataset.rowCount,
            columnCount: dataset.columnCount,
            fileSize: dataset.fileSize,
            filePath: dataset.filePath,
            uploadedAt: dataset.createdAt,
            trainedAt: dataset.trainedAt,
            uploadedByName: dataset.uploadedBy
              ? `${dataset.uploadedBy.firstName} ${dataset.uploadedBy.lastName}`
              : 'Admin',
            provenance: dataset.provenance || null,
            errorMessage: dataset.errorMessage || null,
            pipeline: dataset.syntheticPipeline,
          }
        : null,
      model: model
        ? {
            id: String(model._id),
            version: model.version,
            status: model.status,
            isActive: Boolean(model.isActive),
            featureSetType: model.featureSetType,
            trainedAt: model.trainedAt,
            // Metrics are echoed exactly as ml/trainer.py produced them.
            accuracy: model.accuracy,
            precision: model.precision,
            recall: model.recall,
            f1Score: model.f1Score,
            trainingSamples: model.trainingSamples,
            testSamples: model.testSamples,
            totalRows: model.totalRows,
            rowsDropped: model.rowsDropped,
            classNames: model.classNames || [],
            classDistribution: model.classDistribution || null,
            featuresUsed: model.featuresUsed || [],
            errorMessage: model.errorMessage || null,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/dataset-pipeline/generate
// Body: { rows, seed, defectRate, normalize }
// Runs ml/pipeline.py's generate + clean stages and registers the CLEANED file
// as a TrainingDataset. Deliberately does not train — the response carries the
// new datasetId so the caller can hand it to POST /training/:id/train.
router.post('/dataset-pipeline/generate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { dataset, report } = await datasetPipeline.generateDataset({
      rows: req.body?.rows,
      seed: req.body?.seed,
      defectRate: req.body?.defectRate,
      normalize: Boolean(req.body?.normalize),
      userId: req.user.userId,
    });

    sse.broadcast('analytics:update', {
      type: 'dataset',
      action: 'pipeline_generated',
      datasetId: String(dataset._id),
    });

    res.status(201).json({
      success: true,
      datasetId: String(dataset._id),
      datasetVersion: report.dataset_version,
      rowCount: dataset.rowCount,
      pipeline: dataset.syntheticPipeline,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// GET /api/admin/demo-data/summary
// Verification view for Requirement A: how many records in each collection are
// synthetic versus real. Read-only — this endpoint never generates or deletes
// anything; that is scripts/generate-system-demo-data.js's job, deliberately
// kept off the web surface so 1,500 accounts can never be created by a stray
// click. Counts come from countDocuments over the live collections.
router.get('/demo-data/summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    const SYNTHETIC = { isSynthetic: true };
    const models = [
      ['users', User],
      ['children', Child],
      ['assessments', Assessment],
      ['results', AssessmentResult],
      ['answers', AssessmentAnswer],
      ['appointments', Appointment],
    ];

    const collections = {};
    await Promise.all(models.map(async ([key, Model]) => {
      const [total, synthetic] = await Promise.all([
        Model.countDocuments({}),
        Model.countDocuments(SYNTHETIC),
      ]);
      collections[key] = { total, synthetic, real: total - synthetic };
    }));

    const roleRows = await User.aggregate([
      {
        $group: {
          _id: { role: '$role', synthetic: { $ifNull: ['$isSynthetic', false] } },
          count: { $sum: 1 },
        },
      },
    ]);
    const roles = {};
    roleRows.forEach((r) => {
      const role = r._id.role || 'unknown';
      roles[role] = roles[role] || { synthetic: 0, real: 0 };
      if (r._id.synthetic === true) roles[role].synthetic += r.count;
      else roles[role].real += r.count;
    });

    const batchRows = await User.aggregate([
      { $match: SYNTHETIC },
      { $group: { _id: '$syntheticBatch', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      collections,
      roles,
      batches: batchRows.map((b) => ({ batch: b._id || 'unlabelled', users: b.count })),
      // The adviser's threshold, evaluated against the live count rather than
      // asserted. `met` is false whenever the database says it is false.
      requirement: {
        label: 'More than 1,000 system user records',
        threshold: 1000,
        actual: collections.users.total,
        met: collections.users.total > 1000,
      },
      generatorCommand: 'node scripts/generate-system-demo-data.js --users=1500',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/training/:id
router.delete('/training/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dataset = await TrainingDataset.findByIdAndDelete(req.params.id);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });
    safeRemoveUpload(dataset.filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings/appointments
// Loads the admin-controlled slot enforcement switch.
router.get('/settings/appointments', authMiddleware, adminOnly, async (req, res) => {
  try {
    const doc = await getSystemSettingsDoc();
    res.json({ success: true, settings: formatAppointmentSlotSettings(doc) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/settings/appointments
// Saves the platform-wide appointment slot enforcement toggle.
router.put('/settings/appointments', authMiddleware, adminOnly, async (req, res) => {
  try {
    const enforceThirtyMinuteSlots = Boolean(req.body?.enforceThirtyMinuteSlots);

    const doc = await SystemSetting.findOneAndUpdate(
      { singleton: 'default' },
      {
        $set: {
          appointmentSlots: {
            enforceThirtyMinuteSlots,
            slotMinutes: 60,
          },
        },
        $setOnInsert: { singleton: 'default' },
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, settings: formatAppointmentSlotSettings(doc) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics/pediatrician
// Filtered analytics for a specific pediatrician.
// A pediatrician always reads their OWN figures (the id is taken from the
// token, never the query). Reading someone else's via ?pediatricianId is an
// admin action — previously any signed-in user could do it, which let a parent
// pull another clinician's appointment counts.
router.get('/analytics/pediatrician', authMiddleware, async (req, res) => {
  try {
    const isSelf = req.user.role === 'pediatrician';
    if (!isSelf && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admins only.' });
    }
    const pediaId = isSelf ? req.user.userId : req.query.pediatricianId;
    if (!pediaId) return res.status(400).json({ error: 'Pediatrician ID required' });

    const objectId = new mongoose.Types.ObjectId(pediaId);

    // A Child.find().lean() used to sit here, loading the ENTIRE children
    // collection into memory and assigning it to a variable nothing read. The
    // pediatrician dashboard re-requests this endpoint every 5 seconds, so it
    // was a full-collection scan on a 5-second timer for a value that was
    // never used. Removed.
    const [
      myAppointments,
      myAssessments,
    ] = await Promise.all([
      Appointment.find({ pediatricianId: objectId }).lean(),
      Assessment.find({ reviewedByPediatrician: objectId }).lean(),
    ]);

    const myApptCount = myAppointments.length;
    const pendingAppts = myAppointments.filter(a => a.status === 'pending').length;
    const approvedAppts = myAppointments.filter(a => a.status === 'approved').length;
    const completedAppts = myAppointments.filter(a => a.status === 'completed').length;

    // Assessments belonging to this pediatrician's patients that nobody has
    // reviewed yet. Additive field: the Review Progress chart previously
    // plotted reviewedAssessments against pendingAppointments — two different
    // units on one axis. These two counts share a denominator (the assessments
    // of children this pediatrician has an appointment with), so the chart can
    // show parts of one whole.
    const myChildIds = [...new Set(myAppointments.map(a => String(a.childId)).filter(Boolean))]
      .map(id => new mongoose.Types.ObjectId(id));
    const unreviewedAssessments = await Assessment.countDocuments({
      childId: { $in: myChildIds },
      status: 'complete',
      reviewedByPediatrician: null,
    });

    const summaryTotals = {
      totalAppointments: myApptCount,
      pendingAppointments: pendingAppts,
      approvedAppointments: approvedAppts,
      completedAppointments: completedAppts,
      reviewedAssessments: myAssessments.length,
      unreviewedAssessments,
    };

    res.json({
      success: true,
      summaryTotals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics/parent
// Filtered analytics for a specific parent (their children and appointments).
// Same rule as /analytics/pediatrician: a parent always reads their own row,
// and reading another parent's via ?parentId is admin-only.
router.get('/analytics/parent', authMiddleware, async (req, res) => {
  try {
    const isSelf = req.user.role === 'parent';
    if (!isSelf && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admins only.' });
    }
    const parentId = isSelf ? req.user.userId : req.query.parentId;
    if (!parentId) return res.status(400).json({ error: 'Parent ID required' });

    const objectId = new mongoose.Types.ObjectId(parentId);

    const [
      myChildren,
      myAppointments,
    ] = await Promise.all([
      Child.find({ parentId: objectId }).lean(),
      Appointment.find({ parentId: objectId }).lean(),
    ]);

    const myApptCount = myAppointments.length;
    const pendingAppts = myAppointments.filter(a => a.status === 'pending').length;
    const approvedAppts = myAppointments.filter(a => a.status === 'approved').length;
    const completedAppts = myAppointments.filter(a => a.status === 'completed').length;

    const summaryTotals = {
      totalChildren: myChildren.length,
      totalAppointments: myApptCount,
      pendingAppointments: pendingAppts,
      approvedAppointments: approvedAppts,
      completedAppointments: completedAppts,
    };

    res.json({
      success: true,
      summaryTotals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: find an orphan document for a user in any upload directory ──
function normalizeDocumentPath(value) {
  if (!value) return null;
  const clean = String(value).trim().replace(/\\/g, '/');
  if (!clean) return null;
  if (/^https?:\/\//i.test(clean)) return clean;

  const uploadsIndex = clean.indexOf('uploads/');
  if (uploadsIndex >= 0) {
    return `/${clean.slice(uploadsIndex).replace(/^\/+/, '')}`;
  }

  return clean.startsWith('/') ? clean : clean;
}

function uploadPathToDisk(publicPath) {
  const normalized = normalizeDocumentPath(publicPath);
  if (!normalized || /^https?:\/\//i.test(normalized)) return null;

  const uploadRelative = normalized.startsWith('/uploads/')
    ? normalized.slice(1)
    : normalized.startsWith('uploads/')
      ? normalized
      : null;

  if (uploadRelative) {
    const fullPath = path.join(__dirname, '..', uploadRelative);
    return fs.existsSync(fullPath) ? fullPath : null;
  }

  const fileName = path.basename(normalized);
  const candidates = [
    path.join(__dirname, '..', 'uploads', 'prc-documents', fileName),
    path.join(__dirname, '..', 'uploads', 'prc', fileName),
    path.join(__dirname, '..', 'uploads', 'profiles', fileName),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function extractTimestampFromPath(value) {
  if (!value) return null;
  const match = path.basename(String(value)).match(/_(\d{10,})(?:\.[^.]+)?$/);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function findOrphanDocument(user) {
  const userId = String(user?._id || user || '');
  const prcDocDir = path.join(__dirname, '..', 'uploads', 'prc-documents');
  const prcLegacyDir = path.join(__dirname, '..', 'uploads', 'prc'); // Old PRC upload dir
  const profilesDir = path.join(__dirname, '..', 'uploads', 'profiles');

  // 1. Check secure PRC-documents directory (returns filename only)
  if (fs.existsSync(prcDocDir)) {
    try {
      const files = fs.readdirSync(prcDocDir);
      const match = files.find((f) => f.startsWith(`prc_${userId}_`));
      if (match) {
        console.log('[PRC Admin] Found orphan in prc-documents (filename only):', match);
        return match; // Return filename only for secure endpoint
      }
    } catch { /* ignore */ }
  }

  // 2. Check legacy /uploads/prc directory (returns /uploads/prc/filename)
  if (fs.existsSync(prcLegacyDir)) {
    try {
      const files = fs.readdirSync(prcLegacyDir);
      const match = files.find((f) => f.startsWith(`prc_${userId}_`));
      if (match) {
        const fullPath = `/uploads/prc/${match}`;
        console.log('[PRC Admin] Found orphan in legacy prc (full path): ', fullPath);
        return fullPath;
      }
    } catch { /* ignore */ }
  }

  // 3. Check /uploads/profiles directory (returns /uploads/profiles/filename)
  if (fs.existsSync(profilesDir)) {
    try {
      const files = fs.readdirSync(profilesDir);
      const match = files.find((f) => f.startsWith(`pediatric_id_${userId}_`));
      if (match) {
        const fullPath = `/uploads/profiles/${match}`;
        console.log('[PRC Admin] Found orphan in profiles (full path):', fullPath);
        return fullPath;
      }
    } catch { /* ignore */ }
  }

  // 4. Recover registration uploads left under the default "user_<timestamp>"
  // name. This happened in an older two-file registration flow where the
  // profile image was renamed with the pediatrician id, but the ID card was not
  // written back to idDocumentPath/prcIdDocumentPath.
  if (fs.existsSync(profilesDir)) {
    try {
      const files = fs.readdirSync(profilesDir);
      const profileUploadTs = extractTimestampFromPath(user?.profileIcon);
      const createdTs = user?.createdAt ? new Date(user.createdAt).getTime() : null;
      const anchorTs = profileUploadTs || createdTs;

      if (anchorTs) {
        const nearby = files
          .filter((f) => /^user_\d+\.(jpe?g|png|webp)$/i.test(f))
          .map((f) => ({ file: f, ts: extractTimestampFromPath(f) }))
          .filter((item) => item.ts && Math.abs(item.ts - anchorTs) <= 30 * 1000)
          .sort((a, b) => Math.abs(a.ts - anchorTs) - Math.abs(b.ts - anchorTs))[0];

        if (nearby) {
          const fullPath = `/uploads/profiles/${nearby.file}`;
          console.log('[PRC Admin] Found timestamp-matched orphan document:', {
            userId,
            path: fullPath,
            deltaMs: Math.abs(nearby.ts - anchorTs),
          });
          return fullPath;
        }
      }
    } catch (err) {
      console.warn('[PRC Admin] Orphan timestamp search failed:', err.message);
    }
  }

  return null;
}

function buildPrcDocumentInfo(user) {
  const userId = String(user._id);
  const rawDbPath = user.prcIdDocumentPath || user.idDocumentPath || user.prcDocumentPath || null;
  let storedPath = normalizeDocumentPath(rawDbPath);
  let source = storedPath ? 'database' : 'none';

  if (!storedPath) {
    storedPath = normalizeDocumentPath(findOrphanDocument(user));
    source = storedPath ? 'orphan-upload' : 'missing';
  }

  const diskPath = uploadPathToDisk(storedPath);
  const isExternal = Boolean(storedPath && /^https?:\/\//i.test(storedPath));
  const staticUrl = storedPath && (isExternal || storedPath.startsWith('/uploads/'))
    ? storedPath
    : (storedPath && storedPath.startsWith('uploads/') ? `/${storedPath}` : null);

  const info = {
    storedPath,
    source,
    existsOnDisk: Boolean(isExternal || diskPath),
    staticUrl,
    secureEndpoint: `/api/prc/document/${userId}`,
    hasDocument: Boolean(storedPath),
  };

  console.log('[PRC Admin] Document integrity:', {
    userId,
    rawDbPath,
    storedPath: info.storedPath,
    source: info.source,
    existsOnDisk: info.existsOnDisk,
    staticUrl: info.staticUrl,
    secureEndpoint: info.secureEndpoint,
  });

  return info;
}
// ── PRC Verification admin endpoints (mounted at /api/admin) ──────

// GET /api/admin/pediatricians/prc-verification
// Returns list of pediatricians for the PRC verification table
router.get('/pediatricians/prc-verification', authMiddleware, adminOnly, async (req, res) => {
  try {
    const pediatricians = await User.find({ role: 'pediatrician' })
      .select('firstName lastName email phoneNumber clinicName clinicAddress prcLicenseNumber specialization prcVerificationStatus prcSubmittedAt createdAt licenseExpiry profileIcon prcIdDocumentPath idDocumentPath idDocumentUploadedAt')
      .sort({ createdAt: -1 })
      .lean();

    const mapped = pediatricians.map(u => {
      const docInfo = buildPrcDocumentInfo(u);
      return {
        _id: String(u._id),
        fullName: `Dr. ${u.firstName || ''} ${u.lastName || ''}`.trim(),
        email: u.email,
        phone: u.phoneNumber,
        clinicName: u.clinicName,
        clinicAddress: u.clinicAddress,
        prcLicenseNumber: u.prcLicenseNumber,
        licenseExpiry: u.licenseExpiry ? new Date(u.licenseExpiry).toLocaleDateString() : null,
        specialization: u.specialization,
        accountStatus: u.prcVerificationStatus || 'pending',
        prcIdDocumentPath: docInfo.storedPath,
        idDocumentPath: u.idDocumentPath || null,
        prcDocumentUrl: docInfo.secureEndpoint,
        prcDocumentStaticUrl: docInfo.staticUrl,
        hasPrcDocument: docInfo.hasDocument,
        prcDocumentExistsOnDisk: docInfo.existsOnDisk,
        prcDocumentSource: docInfo.source,
        prcSubmittedAt: u.prcSubmittedAt,
        createdAt: u.createdAt,
      };
    });

    res.json({ success: true, pediatricians: mapped });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/pediatricians/:id/prc-details
// Returns specific pediatrician details for the verification modal
router.get('/pediatricians/:id/prc-details', authMiddleware, adminOnly, async (req, res) => {
  try {
    console.log('[PRC Admin] Fetching details for ID:', req.params.id);
    console.log('[PRC Admin] Authenticated user:', req.user?.userId, 'role:', req.user?.role);

    const user = await User.findById(req.params.id).lean();
    console.log('[PRC Admin] User found in DB:', user ? 'yes' : 'no');

    if (!user) {
      console.log('[PRC Admin] User not found');
      return res.status(404).json({ error: 'Pediatrician not found' });
    }
    console.log('[PRC Admin] User role:', user.role);
    if (user.role !== 'pediatrician') {
      console.log('[PRC Admin] Not a pediatrician account, role is:', user.role);
      return res.status(403).json({ error: 'Not a pediatrician account' });
    }

    console.log('[PRC Admin] Document path from DB (user.prcIdDocumentPath):', user.prcIdDocumentPath);
    console.log('[PRC Admin] Document path from DB (user.idDocumentPath):', user.idDocumentPath);

    const docInfo = buildPrcDocumentInfo(user);
    console.log('[PRC Admin] Resolved document path (after orphan search):', docInfo.storedPath);

    const data = {
      _id: String(user._id),
      fullName: `Dr. ${user.firstName || ''} ${user.lastName || ''}`.trim(),
      email: user.email,
      phone: user.phoneNumber,
      clinicName: user.clinicName,
      clinicAddress: user.clinicAddress,
      prcLicenseNumber: user.prcLicenseNumber,
      licenseExpiry: user.licenseExpiry ? new Date(user.licenseExpiry).toLocaleDateString() : null,
      specialization: user.specialization,
      accountStatus: user.prcVerificationStatus || 'pending',
      prcIdDocumentPath: docInfo.storedPath,
      idDocumentPath: user.idDocumentPath || null,
      prcDocumentUrl: docInfo.secureEndpoint,
      prcDocumentStaticUrl: docInfo.staticUrl,
      hasPrcDocument: docInfo.hasDocument,
      prcDocumentExistsOnDisk: docInfo.existsOnDisk,
      prcDocumentSource: docInfo.source,
    };

    console.log('[PRC Admin] Returning data:', data);
    res.json({ success: true, pediatrician: data });
  } catch (error) {
    console.error('[PRC Admin] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/pediatricians/prc-verify
// Handle Approve/Reject actions for PRC verification
router.post('/pediatricians/prc-verify', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id, action } = req.body;

    if (!['verified', 'rejected'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.prcVerificationStatus = action;
    user.prcVerifiedAt = new Date();
    user.prcVerifiedBy = req.user.userId;
    user.status = action === 'verified' ? 'active' : 'pending';
    await user.save();

    const label = action === 'verified' ? 'approved' : 'rejected';
    res.json({ success: true, message: `Account ${label}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ *
 * Data origin reporting
 *
 * Shows which screening questions and answers come from the fixed core
 * bank versus which a pediatrician entered at runtime.
 * See constants/dataOrigin.js — the distinction is MECHANISM, not authorship.
 * ------------------------------------------------------------------ */

/**
 * Group a collection by its `origin` field and return a plain map.
 *
 * Important: this groups over whatever values are ACTUALLY present rather than
 * counting the two we expect. A summary built as core_bank + pedia_entry cannot
 * see a third value, so a stray or legacy origin would silently vanish from a
 * total that still looks plausible. Unrecognised values are surfaced instead.
 */
async function groupByOrigin(Model) {
  const rows = await Model.aggregate([{ $group: { _id: '$origin', count: { $sum: 1 } } }]);
  const map = {};
  for (const r of rows) {
    map[r._id == null ? '__unset__' : String(r._id)] = r.count;
  }
  return map;
}

function splitKnownAndOther(map) {
  const known = {};
  const other = [];
  let unset = 0;
  for (const [key, count] of Object.entries(map)) {
    if (key === '__unset__') unset = count;
    else if (DATA_ORIGIN_VALUES.includes(key)) known[key] = count;
    else other.push({ origin: key, count });
  }
  return { known, other, unset };
}

// GET /api/admin/data-origin/summary
router.get('/data-origin/summary', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Important: the two answer counts come from DIFFERENT collections, and
    // that is deliberate — do not "fix" this by unifying them.
    //
    // Core-bank answers live in assessment_answers, one document per answered
    // question. Pediatrician answers are stored on the assignment document
    // itself (answer / answeredAt on pedia_custom_question_assignments) and
    // never enter assessment_answers at all. Counting pedia answers from
    // assessment_answers would therefore report 0 forever.
    const [answerOrigins, coreQuestionOrigins, pediaQuestionOrigins, pediaAnswered, pediaAssignmentsTotal] =
      await Promise.all([
        groupByOrigin(AssessmentAnswer),
        groupByOrigin(CoreBankQuestion),
        groupByOrigin(PediaCustomQuestion),
        PediaCustomQuestionAssignment.countDocuments({ answer: { $ne: null } }),
        PediaCustomQuestionAssignment.countDocuments(),
      ]);

    const answers = splitKnownAndOther(answerOrigins);
    const coreQ = splitKnownAndOther(coreQuestionOrigins);
    const pediaQ = splitKnownAndOther(pediaQuestionOrigins);

    const coreBankQuestions = coreQ.known[DATA_ORIGIN.CORE_BANK] || 0;
    // Dataset Questions share the core_bank_questions collection but are a
    // separate origin — counted from `origin`, never from a citation filter.
    const datasetOriginQuestions = coreQ.known[DATA_ORIGIN.DATASET_QUESTION] || 0;
    const pediaEntryQuestions = pediaQ.known[DATA_ORIGIN.PEDIA_ENTRY] || 0;
    const coreBankAnswers = answers.known[DATA_ORIGIN.CORE_BANK] || 0;
    const datasetQuestionAnswers = answers.known[DATA_ORIGIN.DATASET_QUESTION] || 0;

    // Questions carrying no origin, or an origin this build does not know about.
    const unclassifiedQuestions = coreQ.unset + pediaQ.unset;
    const otherQuestions = [...coreQ.other, ...pediaQ.other];

    const warnings = [];
    if (answers.unset > 0) {
      warnings.push(`${answers.unset} answer(s) have no origin set — see scripts/backfill-answer-origin.js`);
    }
    if (answers.other.length) {
      warnings.push(`Unrecognised answer origin value(s): ${answers.other.map((o) => `${o.origin} (${o.count})`).join(', ')}`);
    }
    if (unclassifiedQuestions > 0) {
      warnings.push(`${unclassifiedQuestions} question(s) have no origin set`);
    }
    if (otherQuestions.length) {
      warnings.push(`Unrecognised question origin value(s): ${otherQuestions.map((o) => `${o.origin} (${o.count})`).join(', ')}`);
    }

    const otherAnswerTotal = answers.other.reduce((sum, o) => sum + o.count, 0);
    const otherQuestionTotal = otherQuestions.reduce((sum, o) => sum + o.count, 0);

    // ── Dataset Questions ───────────────────────────────────────────────────
    // A DISTINCT ORIGIN, not core-bank rows with a citation. These are
    // questions whose text came from an actual external dataset. The schema
    // refuses to store one without a checkable sourceCitation (see
    // models/CoreBankQuestion.js), so every row here has a real source. None
    // exist yet, and reporting zero is the correct answer.
    const datasetQuestionDocs = await CoreBankQuestion.find({
      origin: DATA_ORIGIN.DATASET_QUESTION,
    }).select('questionId sourceCitation sourceVersion importedAt importBatchId '
      + 'approvalStatus generationMethod isActive').lean();

    // Review lifecycle counts. `active` is reported separately from `approved`
    // because approval permits activation, it is not activation.
    const datasetApproval = {
      pending: datasetQuestionDocs.filter((d) => d.approvalStatus === APPROVAL_STATUS.PENDING).length,
      approved: datasetQuestionDocs.filter((d) => d.approvalStatus === APPROVAL_STATUS.APPROVED).length,
      rejected: datasetQuestionDocs.filter((d) => d.approvalStatus === APPROVAL_STATUS.REJECTED).length,
      active: datasetQuestionDocs.filter((d) => d.isActive === true).length,
    };

    const datasetQuestionIds = datasetQuestionDocs.map((d) => d.questionId);

    // How many dataset-derived questions have actually been answered at least
    // once, and how many answers they account for.
    let datasetAnswered = 0;
    let datasetAnswers = 0;
    if (datasetQuestionIds.length) {
      const [answeredRefs, answerCount] = await Promise.all([
        AssessmentAnswer.distinct('sourceQuestionRef', {
          sourceQuestionRef: { $in: datasetQuestionIds },
        }),
        AssessmentAnswer.countDocuments({ sourceQuestionRef: { $in: datasetQuestionIds } }),
      ]);
      datasetAnswered = answeredRefs.filter(Boolean).length;
      datasetAnswers = answerCount;
    }

    // Group by cited source so the UI can name each one with its version.
    const bySource = new Map();
    for (const d of datasetQuestionDocs) {
      const key = `${d.sourceCitation}||${d.sourceVersion || ''}`;
      const entry = bySource.get(key) || {
        citation: d.sourceCitation,
        version: d.sourceVersion || null,
        items: 0,
        lastImportedAt: null,
        batchIds: new Set(),
      };
      entry.items += 1;
      if (d.importedAt && (!entry.lastImportedAt || d.importedAt > entry.lastImportedAt)) {
        entry.lastImportedAt = d.importedAt;
      }
      if (d.importBatchId) entry.batchIds.add(d.importBatchId);
      bySource.set(key, entry);
    }

    // Core-bank questions answered at least once — the honest denominator for
    // "how much of the bank is actually exercised".
    const coreAnsweredRefs = await AssessmentAnswer.distinct('sourceQuestionRef', {
      origin: DATA_ORIGIN.CORE_BANK,
    });

    res.json({
      // ── Question origin 2 of 3: Dataset Question ───────────────────────────
      // Questions whose text came from an actual external dataset. A DISTINCT
      // ORIGIN from Core Question Bank, not a badge on it. NOT an ML training
      // dataset either — those live in the TrainingDataset collection and are
      // served by /admin/training/*. Zero here means no dataset question has
      // been imported yet.
      datasetQuestion: {
        label: DATA_ORIGIN_LABELS[DATA_ORIGIN.DATASET_QUESTION],
        sourceKind: DATA_ORIGIN_SOURCE_KIND[DATA_ORIGIN.DATASET_QUESTION],
        questions: datasetOriginQuestions,
        questionsAnswered: datasetAnswered,
        answers: datasetQuestionAnswers,
        sources: [...bySource.values()].map((e) => ({
          citation: e.citation,
          version: e.version,
          items: e.items,
          lastImportedAt: e.lastImportedAt,
          batchCount: e.batchIds.size,
        })),
        hasExternalDataset: datasetOriginQuestions > 0,
        // Pediatrician review lifecycle. Nothing here is usable in an
        // assessment until it is BOTH approved and active.
        approval: datasetApproval,
        // The REVIEWER round (wording only). Static catalogue data, present
        // even before any question is seeded. Distinct from `approval` above,
        // which is the PEDIATRICIAN lifecycle — a reviewer "Approved" is not a
        // pediatrician sign-off and does not activate anything.
        reviewerDecision: datasetReviewerSummary(
          DATASET_REVIEW.openMappingItems.filter((id) => {
            const doc = datasetQuestionDocs.find((d) => d.questionId === id);
            return isMappingQuestionOpen(id, doc ? doc.approvalStatus : null);
          })
        ),
      },
      // Deprecated alias of datasetQuestion (kept for one release).
      dataset: {
        label: DATA_ORIGIN_LABELS[DATA_ORIGIN.DATASET_QUESTION],
        questions: datasetOriginQuestions,
        questionsAnswered: datasetAnswered,
        answers: datasetQuestionAnswers,
        sources: [...bySource.values()].map((e) => ({
          citation: e.citation,
          version: e.version,
          items: e.items,
          lastImportedAt: e.lastImportedAt,
          batchCount: e.batchIds.size,
        })),
        // Drives the honest empty state in the admin UI.
        hasExternalDataset: datasetQuestionDocs.length > 0,
      },
      coreBankUsage: {
        questions: coreBankQuestions,
        questionsAnswered: coreAnsweredRefs.filter(Boolean).length,
        answers: coreBankAnswers,
      },
      // ── Question origin 1 of 3: Core Question Bank ────────────────────────
      // Source = our consultant pediatrician's interview.
      coreBank: {
        label: DATA_ORIGIN_LABELS[DATA_ORIGIN.CORE_BANK],
        sourceKind: DATA_ORIGIN_SOURCE_KIND[DATA_ORIGIN.CORE_BANK],
        questions: coreBankQuestions,
        answers: coreBankAnswers,
      },
      // ── Question origin 3 of 3: Pediatrician Entry ────────────────────────
      // Author = a pediatrician working inside KinderCura.
      pediaEntry: {
        label: DATA_ORIGIN_LABELS[DATA_ORIGIN.PEDIA_ENTRY],
        sourceKind: DATA_ORIGIN_SOURCE_KIND[DATA_ORIGIN.PEDIA_ENTRY],
        questions: pediaEntryQuestions,
        answers: pediaAnswered,
        assignmentsTotal: pediaAssignmentsTotal,
      },
      // Explicit buckets so nothing can drop out of the totals unnoticed.
      unclassified: {
        label: 'Unclassified',
        questions: unclassifiedQuestions,
        answers: answers.unset,
      },
      other: {
        label: 'Unrecognised origin',
        questions: otherQuestionTotal,
        answers: otherAnswerTotal,
        values: [...answers.other.map((o) => ({ ...o, scope: 'answers' })), ...otherQuestions.map((o) => ({ ...o, scope: 'questions' }))],
      },
      total: {
        questions: coreBankQuestions + datasetOriginQuestions + pediaEntryQuestions
          + unclassifiedQuestions + otherQuestionTotal,
        answers: coreBankAnswers + datasetQuestionAnswers + pediaAnswered
          + answers.unset + otherAnswerTotal,
      },
      warnings,
    });
  } catch (error) {
    console.error('data-origin summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/data-origin/list?origin=core_bank|pedia_entry|all&page=&limit=
router.get('/data-origin/list', authMiddleware, adminOnly, async (req, res) => {
  try {
    const originFilter = String(req.query.origin || 'all');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    // Filtering is by REAL ORIGIN. 'dataset_question' is a first-class origin,
    // not a citation sub-filter on the core bank: a question either came from
    // an external dataset or it did not. The older 'external_source'/'dataset'
    // spellings are accepted as deprecated aliases and now resolve to that
    // origin, so a stale bookmark cannot silently mean "core bank".
    const LEGACY_DATASET_ALIASES = ['external_source', 'dataset'];
    const resolvedFilter = LEGACY_DATASET_ALIASES.includes(originFilter)
      ? DATA_ORIGIN.DATASET_QUESTION
      : originFilter;

    if (resolvedFilter !== 'all' && !DATA_ORIGIN_VALUES.includes(resolvedFilter)) {
      return res.status(400).json({
        error: `origin must be one of: all, ${DATA_ORIGIN_VALUES.join(', ')}`,
      });
    }

    // core_bank_questions holds both system-provided origins, so it is read for
    // 'all', for core_bank, and for dataset_question — then narrowed by origin.
    const wantDatasetOnly = resolvedFilter === DATA_ORIGIN.DATASET_QUESTION;
    const wantCore = resolvedFilter === 'all'
      || resolvedFilter === DATA_ORIGIN.CORE_BANK
      || wantDatasetOnly;
    const wantPedia = resolvedFilter === 'all' || resolvedFilter === DATA_ORIGIN.PEDIA_ENTRY;

    const rows = [];

    if (wantCore) {
      // Both system-provided origins live here; each row keeps its own.
      const [questions, answerCounts] = await Promise.all([
        CoreBankQuestion.find({}).lean(),
        // One grouped pass instead of a count per question. Covers both
        // system-provided origins so a dataset question's answers are counted.
        AssessmentAnswer.aggregate([
          {
            $match: {
              sourceQuestionRef: { $nin: [null, ''] },
              origin: { $in: [DATA_ORIGIN.CORE_BANK, DATA_ORIGIN.DATASET_QUESTION] },
            },
          },
          { $group: { _id: '$sourceQuestionRef', count: { $sum: 1 } } },
        ]),
      ]);
      const answersByRef = new Map(answerCounts.map((a) => [a._id, a.count]));

      for (const q of questions) {
        // Read the STORED origin. A legacy row with no origin set is treated
        // as core bank, matching the schema default — never as a dataset
        // question, which must be an explicit, citation-backed claim.
        const rowOrigin = q.origin === DATA_ORIGIN.DATASET_QUESTION
          ? DATA_ORIGIN.DATASET_QUESTION
          : DATA_ORIGIN.CORE_BANK;
        const isDatasetQuestion = rowOrigin === DATA_ORIGIN.DATASET_QUESTION;

        rows.push({
          id: String(q._id),
          questionId: q.questionId,
          questionText: q.text,
          domain: q.domain,
          displayDomain: q.displayDomain || '',
          origin: rowOrigin,
          originLabel: DATA_ORIGIN_LABELS[rowOrigin],
          sourceKind: DATA_ORIGIN_SOURCE_KIND[rowOrigin],
          // Neither system-provided origin has an author. The legacy
          // `sourcedFrom` attribution is NOT used here — it is an unverified
          // string (see models/CoreBankQuestion.js) and belongs in the
          // provenance fields below, not in a "Created By" column.
          createdBy: isDatasetQuestion
            ? 'External dataset (system-managed)'
            : 'Core Question Bank (system-managed)',
          isSystemManaged: q.isSystemManaged !== false,
          createdAt: q.createdAt,
          timesAnswered: answersByRef.get(q.questionId) || 0,

          // ── Provenance (null means genuinely unrecorded) ─────────────────
          // Only a dataset question can carry a citation — the schema refuses
          // to save one without it, and refuses to put one on a core-bank row.
          hasExternalSource: isDatasetQuestion,
          // Deprecated mirror of hasExternalSource, kept for one release so a
          // cached admin page keeps rendering. Never means "ML dataset".
          isDataset: isDatasetQuestion,
          sourceCitation: q.sourceCitation || null,
          sourceVersion: q.sourceVersion || null,
          importedAt: q.importedAt || null,
          importBatchId: q.importBatchId || null,
          // Surfaced separately so the UI can mark it unverified. All 34
          // existing core-bank rows carry this from a removed schema default.
          sourcedFrom: q.sourcedFrom || null,

          // ── Review lifecycle (dataset questions only) ────────────────────
          // null on a core-bank row means "outside this workflow", which the
          // UI must render as "—", never as approved. `isActive` is included
          // because for a dataset question it is the activation gate: the
          // model refuses true unless approvalStatus is 'approved'.
          approvalStatus: q.approvalStatus || null,
          approvalStatusLabel: approvalStatusLabel(q.approvalStatus),
          generationMethod: q.generationMethod || null,
          generationMethodLabel: generationMethodLabel(q.generationMethod),
          approvedAt: q.approvedAt || null,
          isActive: q.isActive !== false,
          // True only when a pediatrician has actually approved it. A pending
          // question is never usable in an assessment.
          isUsableInAssessment: isDatasetQuestion
            ? (q.approvalStatus === APPROVAL_STATUS.APPROVED && q.isActive === true)
            : q.isActive !== false,

          // ── Reviewer decision (wording) — a SEPARATE axis from approval ───
          // Static catalogue fact joined by questionId. Only a reviewer round
          // decision; NOT the pediatrician sign-off in approvalStatus above.
          // The page shows all three side by side so they cannot be conflated:
          //   Reviewer decision  → this
          //   Pediatrician approval → approvalStatusLabel
          //   Active              → isActive
          reviewerDecision: isDatasetQuestion ? DATASET_REVIEW.decision : null,
          reviewerDecisionLabel: isDatasetQuestion
            ? (REVIEWER_DECISION_LABELS[DATASET_REVIEW.decision] || DATASET_REVIEW.decision)
            : null,
          reviewerDecisionRound: isDatasetQuestion
            ? `${DATASET_REVIEW.round} · ${DATASET_REVIEW.decidedOn}`
            : null,
          hasOpenMappingQuestion: isDatasetQuestion
            && isMappingQuestionOpen(q.questionId, q.approvalStatus || null),
        });
      }
    }

    if (wantPedia) {
      const questions = await PediaCustomQuestion.find({}).lean();
      const pediatricianIds = [...new Set(questions.map((q) => String(q.pediatricianId)).filter(Boolean))];

      const [pediatricians, assignmentCounts] = await Promise.all([
        User.find({ _id: { $in: pediatricianIds } }).select('firstName lastName').lean(),
        // Answered assignments only — an assigned-but-unanswered question has
        // not actually produced an answer.
        PediaCustomQuestionAssignment.aggregate([
          { $match: { answer: { $ne: null } } },
          { $group: { _id: '$questionId', count: { $sum: 1 } } },
        ]),
      ]);

      const nameById = new Map(pediatricians.map((u) => [String(u._id), fullName(u) || 'Unknown Pediatrician']));
      const answersByQuestion = new Map(assignmentCounts.map((a) => [String(a._id), a.count]));

      for (const q of questions) {
        rows.push({
          id: String(q._id),
          questionId: q.id != null ? `#${q.id}` : String(q._id),
          questionText: q.questionText,
          domain: q.domain || 'Other',
          displayDomain: '',
          origin: DATA_ORIGIN.PEDIA_ENTRY,
          originLabel: DATA_ORIGIN_LABELS[DATA_ORIGIN.PEDIA_ENTRY],
          sourceKind: DATA_ORIGIN_SOURCE_KIND[DATA_ORIGIN.PEDIA_ENTRY],
          createdBy: nameById.get(String(q.pediatricianId)) || 'Unknown Pediatrician',
          isSystemManaged: false,
          createdAt: q.createdAt,
          timesAnswered: answersByQuestion.get(String(q._id)) || 0,
          // A pediatrician-entered question has an AUTHOR, not an external
          // source. Never inherits core-bank provenance.
          hasExternalSource: false,
          isDataset: false,
          sourceCitation: null,
          sourceVersion: null,
          importedAt: null,
          importBatchId: null,
          sourcedFrom: null,
          // A pediatrician wrote it, so there is nobody else to approve it —
          // it is outside the dataset-question review workflow entirely.
          approvalStatus: null,
          approvalStatusLabel: null,
          generationMethod: null,
          generationMethodLabel: null,
          approvedAt: null,
          isActive: q.isActive !== false,
          isUsableInAssessment: q.isActive !== false,
        });
      }
    }

    // core_bank_questions holds BOTH system-provided origins, so a single-origin
    // filter must narrow the merged rows by their stored origin. Without this,
    // origin=core_bank would also return Dataset Questions and vice versa.
    // With no dataset question imported, that view is empty — the honest result.
    const visibleRows = resolvedFilter === 'all'
      ? rows
      : rows.filter((r) => r.origin === resolvedFilter);

    // Newest first, with a stable tiebreak so pagination cannot repeat or skip
    // rows when several share a timestamp.
    visibleRows.sort((a, b) => {
      const diff = new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      return diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));
    });

    // Note: the two sources are merged in memory because the combined row count
    // is small (34 core-bank + the pediatrician's own questions). If the
    // pediatrician question count ever grows into the thousands, this needs to
    // become a proper $unionWith aggregation with database-side paging.
    const total = visibleRows.length;
    const start = (page - 1) * limit;

    res.json({
      // Lets the UI render an accurate empty state instead of a bare "no rows".
      datasetQuestionView: wantDatasetOnly,
      // Deprecated aliases of datasetQuestionView (kept for one release).
      externalSourceView: wantDatasetOnly,
      datasetView: wantDatasetOnly,
      rows: visibleRows.slice(start, start + limit),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: start + limit < total,
        hasPrev: page > 1,
      },
      filter: originFilter,
    });
  } catch (error) {
    console.error('data-origin list error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

// Exposed for tests only (see tests/unit/reviewed-assessment-export.test.js).
// Attaching to the router function is inert for Express — app.use() only
// ever calls it as a request handler, so this does not affect routing.
router.__testables = {
  buildReviewedAssessmentFilter, buildReviewedAssessmentExportRows, rowsToCsv, ageMonthsAt,
  buildReviewedAssessmentQualitySummary, summarizeMissingness, detectDuplicates, summarizeAge,
  summarizeReviewers, summarizeClassDistribution, QUALITY, resolveTrainingQualityGate,
  computeDatasetProvenance,
};
