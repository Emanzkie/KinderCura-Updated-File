// routes/assessments.js
// MongoDB replacement for screening, results, and pediatrician patient assessment data.
// NOTE: Assessment data is saved in MongoDB collections through mongoose models.
// The database connection still comes from db.js, not from this file.
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianAccess');
const Assessment = require('../models/Assessment');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const User = require('../models/User');
const PatientProgressNote = require('../models/PatientProgressNote');
const Notification = require('../models/Notification');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const PediaCustomQuestionAssignment = require('../models/PediaCustomQuestionAssignment');
const AuditLog = require('../models/AuditLog');
const { DATA_ORIGIN } = require('../constants/dataOrigin');
const { normalizeDomain } = require('../constants/assessmentDomains');
const scoring = require('../constants/scoring');
const staging = require('../constants/developmental-staging');
const assessmentProgress = require('../services/assessmentProgress');
const sse = require('../sse');

// The core bank is 34 static rows that only change on deploy, so it is cached
// in memory instead of being re-read for every answer of every submission.
const CORE_BANK_TTL_MS = 5 * 60 * 1000;
let coreBankCache = { ids: null, loadedAt: 0 };

async function getCoreBankIds() {
  const now = Date.now();
  if (coreBankCache.ids && now - coreBankCache.loadedAt < CORE_BANK_TTL_MS) {
    return coreBankCache.ids;
  }
  const rows = await CoreBankQuestion.find({}).select('questionId').lean();
  coreBankCache = { ids: new Set(rows.map((r) => r.questionId)), loadedAt: now };
  return coreBankCache.ids;
}

// Important: origin is decided HERE, on the server. It is never read from
// req.body — a client must not be able to label its own answers as core-bank
// content. See constants/dataOrigin.js.
//
// This endpoint serves the parent screening flow, which only ever presents
// core-bank questions, so origin is always CORE_BANK. sourceQuestionRef is set
// only when the id actually resolves against the seeded bank; an unresolved id
// is left blank and warned about rather than given a fabricated reference.
function originFieldsFor(questionId, bankIds) {
  const id = String(questionId);
  const resolved = bankIds.has(id);
  if (!resolved) {
    console.warn(`assessments: questionId "${id}" not found in the core bank — sourceQuestionRef left blank.`);
  }
  return {
    origin: DATA_ORIGIN.CORE_BANK,
    sourceQuestionRef: resolved ? id : '',
  };
}

function getAgeInfo(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthday = now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate());
  if (beforeBirthday) age -= 1;
  if (age >= 3 && age <= 5) return { group: 'preschool', age, label: 'Preschool (Ages 3–5)' };
  if (age >= 6 && age <= 8) return { group: 'school', age, label: 'Early School Age (Ages 6–8)' };
  return null;
}

// Case-insensitive on purpose: the core screening flow always sends lowercase
// 'yes'/'sometimes'/'no' (js/parent/screening.js), but the custom-questions
// yes/no widget sends 'Yes'/'No' (js/parent/custom-questions.js). Lowercasing
// here is not a new scoring rule — it is the same 2/1/0 scale applied
// correctly regardless of which UI produced the string.
function scoreAnswer(answer) {
  const normalized = String(answer ?? '').trim().toLowerCase();
  if (normalized === 'yes') return 2;
  if (normalized === 'sometimes') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// SINGLE answer-level interpretation.
//
// This was previously written inline inside /review-answers only. The parent
// Results page now needs the same reading of an answer, so it lives here and
// both endpoints call it — there must not be two interpretations of "sometimes"
// in the codebase, for the same reason there must not be two sets of band
// cutoffs (see constants/scoring.js).
//
// `insight` keeps the exact clinician wording /review-answers already returned.
// `parentInsight` is the same three states in parent-facing words; the states
// and their boundaries are identical, only the vocabulary differs.
// ---------------------------------------------------------------------------
function interpretAnswer(answer) {
  const score = scoreAnswer(answer);
  if (score === 2) {
    return { score, insight: 'On Track', parentInsight: 'On Track', insightLevel: 'positive' };
  }
  if (score === 1) {
    return {
      score,
      insight: 'Developing — may need monitoring',
      parentInsight: 'Developing',
      insightLevel: 'warning',
    };
  }
  return {
    score,
    insight: 'Concern — not yet demonstrated',
    parentInsight: 'Needs Support',
    insightLevel: 'concern',
  };
}

// The four scoring domains and where their stored score/status live on an
// AssessmentResult. Replaces two separate literal maps.
const DOMAIN_SCORE_FIELDS = Object.freeze({
  'Communication':  Object.freeze({ score: 'communicationScore', status: 'communicationStatus' }),
  'Social Skills':  Object.freeze({ score: 'socialScore',        status: 'socialStatus' }),
  'Cognitive':      Object.freeze({ score: 'cognitiveScore',     status: 'cognitiveStatus' }),
  'Motor Skills':   Object.freeze({ score: 'motorScore',         status: 'motorStatus' }),
});

const PARENT_ANSWER_FALLBACK = 'Assessment item not recorded';

// Every core-bank question is phrased "Does your child <skill>?" (see
// DOCTOR_QUESTION_BANK in js/parent/screening.js). We reshape that stored text
// into a short bullet — a mechanical transform of the saved wording, never a
// generated statement. Anything that does not match the pattern (e.g. a
// pediatrician's custom question) is shown verbatim instead of being guessed at.
function describeItem(questionText, kind) {
  const raw = String(questionText || '').trim().replace(/\s+/g, ' ');
  if (!raw) return PARENT_ANSWER_FALLBACK;

  const match = raw.match(/^(?:does|can)\s+(?:your|the)\s+child\s+(.+?)\s*\?*$/i);
  if (!match || !match[1]) return raw;

  const phrase = match[1].charAt(0).toLowerCase() + match[1].slice(1);
  if (kind === 'strength') return `Can ${phrase}`;
  if (kind === 'developing') return `Beginning to ${phrase}`;
  return `Still learning to ${phrase}`;
}

// Neutral screening language only — these sentences describe what was answered,
// they never diagnose. Counts come from the stored answers; the percentage is
// NOT recomputed here (the stored result stays authoritative).
function buildDomainExplanation({ totalItems, achievedItems, developingItems }) {
  const items = totalItems === 1 ? 'assessment item' : 'assessment items';
  const skills = totalItems === 1 ? 'skill' : 'skills';

  if (totalItems === 0) return 'No assessment items were recorded for this area.';
  if (achievedItems === totalItems) {
    return totalItems === 1
      ? 'Your child consistently demonstrated the single assessment item in this area.'
      : `Your child consistently demonstrated all ${totalItems} ${items} in this area.`;
  }
  if (achievedItems > 0) {
    const rest = developingItems > 0
      ? ', and is beginning to show some of the remaining items.'
      : ', with the remaining items still needing practice.';
    return `Your child consistently demonstrated ${achievedItems} of ${totalItems} ${items} in this area${rest}`;
  }
  if (developingItems > 0) {
    return `Your child is beginning to show some of the ${totalItems} ${skills} assessed in this area, but none were demonstrated consistently yet.`;
  }
  return `Your child has not yet consistently demonstrated the ${totalItems} ${skills} assessed in this area.`;
}

// Builds the per-domain evidence behind each stored percentage.
// Returns null when there are no stored answers at all, so older results simply
// fall back to the plain score view instead of showing empty sections.
function buildDomainDetails(answers, result) {
  if (!Array.isArray(answers) || answers.length === 0) return null;

  const details = {};

  for (const [domain, fields] of Object.entries(DOMAIN_SCORE_FIELDS)) {
    const domainAnswers = answers
      .filter((a) => a.domain === domain)
      .sort((a, b) => String(a.questionId).localeCompare(String(b.questionId)));

    const items = [];
    const strengths = [];
    const developing = [];
    const needsSupport = [];
    let totalItems = 0;

    for (const a of domainAnswers) {
      const text = a.questionText ? String(a.questionText) : '';

      // A custom question whose type has no defined scoring rule (see the
      // scoringGaps block in POST /submit) never entered this domain's
      // percentage. Show it for the record, but keep it out of the
      // strength/developing/concern narrative instead of letting
      // interpretAnswer() guess a yes/sometimes/no reading for text it was
      // never designed to score.
      const normalizedAnswer = String(a.answer ?? '').trim().toLowerCase();
      const isUnscoredCustomAnswer = a.origin === DATA_ORIGIN.PEDIA_ENTRY
        && normalizedAnswer !== 'yes' && normalizedAnswer !== 'no' && normalizedAnswer !== 'sometimes';

      if (isUnscoredCustomAnswer) {
        items.push({
          questionId: String(a.questionId || ''),
          questionText: text || PARENT_ANSWER_FALLBACK,
          answer: a.answer,
          insight: 'Recorded — not included in this domain\'s score',
          insightLevel: 'neutral',
        });
        continue;
      }

      const read = interpretAnswer(a.answer);
      totalItems += 1;

      items.push({
        // 'Q05'-style core-bank code, not a MongoDB _id.
        questionId: String(a.questionId || ''),
        questionText: text || PARENT_ANSWER_FALLBACK,
        answer: a.answer,
        insight: read.parentInsight,
        insightLevel: read.insightLevel,
      });

      if (read.score === 2) strengths.push(describeItem(text, 'strength'));
      else if (read.score === 1) developing.push(describeItem(text, 'developing'));
      else needsSupport.push(describeItem(text, 'support'));
    }

    const achievedItems = strengths.length;
    const developingItems = developing.length;
    const concernItems = needsSupport.length;

    details[domain] = {
      // Straight from the stored result — never recalculated here.
      score: result?.[fields.score] ?? 0,
      status: result?.[fields.status] ?? scoring.getStatus(result?.[fields.score] ?? 0),
      totalItems,
      achievedItems,
      developingItems,
      concernItems,
      explanation: buildDomainExplanation({ totalItems, achievedItems, developingItems }),
      strengths,
      developing,
      needsSupport,
      items,
    };
  }

  return details;
}

// Band cutoffs, labels, and colours all come from constants/scoring.js.
// Do not reintroduce literal cutoffs here — see that file's header for why.
const THRESHOLD_RANGES = scoring.THRESHOLD_RANGES;

function getStatus(score) {
  return scoring.getStatus(score);
}

// Kept as a distinct name because the patient-filter endpoint reads more
// clearly with it, but it is the same lookup as getStatus.
function getScoreThreshold(score) {
  return scoring.getStatus(score);
}

// The pediatrician review endpoint reports risk in its own vocabulary. These
// two maps previously carried a SEPARATE set of literal cutoffs (<26 / <51),
// which was a fifth band set disagreeing with the other four. They are now
// keyed off the shared bands so the wording differs but the boundaries cannot.
const RISK_LEVEL_BY_BAND = Object.freeze({
  [scoring.BAND.ON_TRACK]:   'low',
  [scoring.BAND.DEVELOPING]: 'low',
  [scoring.BAND.AT_RISK]:    'moderate',
  [scoring.BAND.DELAYED]:    'high',
});

const OVERALL_RISK_BY_BAND = Object.freeze({
  [scoring.BAND.ON_TRACK]:   'Low Risk',
  [scoring.BAND.DEVELOPING]: 'Low Risk',
  [scoring.BAND.AT_RISK]:    'Moderate Risk',
  [scoring.BAND.DELAYED]:    'High Risk',
});

function normalizeAnswers(answers) {
  if (!answers) return [];
  if (Array.isArray(answers)) return answers;
  // save-draft may send a plain object of questionId -> answer
  return Object.entries(answers).map(([questionId, answer]) => ({
    questionId,
    domain: 'Unknown',
    questionText: '',
    answer,
  }));
}

function parseNextAssessmentDate(value) {
  if (value == null || String(value).trim() === '') return { value: null };

  const raw = String(value).trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let parsed;

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    parsed = new Date(year, month - 1, day, 12, 0, 0, 0);

    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      return { error: 'Next assessment date is invalid.' };
    }
  } else {
    parsed = new Date(raw);
  }

  if (Number.isNaN(parsed.getTime())) {
    return { error: 'Next assessment date is invalid.' };
  }

  if (dateOnly) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const candidate = new Date(parsed);
    candidate.setHours(0, 0, 0, 0);

    if (candidate < today) {
      return { error: 'Next assessment date cannot be in the past.' };
    }
  } else if (parsed < new Date()) {
    return { error: 'Next assessment date cannot be in the past.' };
  }

  return { value: parsed };
}

// API-facing view of a care-stage lookup (services/assessmentProgress.js
// getStoredOrDerivedCareStage / getAssessmentCareStage) — deliberately
// excludes anything filesystem-related (e.g. no model path). Returns null
// when there is no result to summarize (assessment not yet complete).
// riskCategory (ML classification) and careStage (care-plan classification)
// are kept as two separate fields — see constants/developmental-staging.js.
function predictionSummary(careStageInfo) {
  if (!careStageInfo) return null;
  return {
    source: careStageInfo.source,
    modelVersion: careStageInfo.modelVersion,
    riskCategory: careStageInfo.riskCategory,
    careStage: careStageInfo.careStage,
    careStageLabel: careStageInfo.careStageLabel,
    consultationLevel: careStageInfo.consultationLevel,
    monitoringLevel: careStageInfo.monitoringLevel,
    probabilities: careStageInfo.probabilities,
  };
}

async function buildHistoryForChild(childId) {
  const assessments = await Assessment.find({ childId }).sort({ startedAt: -1 }).lean();
  const assessmentIds = assessments.map((a) => a._id);
  const results = await AssessmentResult.find({ assessmentId: { $in: assessmentIds } }).lean();
  const resultMap = new Map(results.map((r) => [String(r.assessmentId), r]));

  return assessments.map((a) => {
    const r = resultMap.get(String(a._id));
    return {
      id: String(a._id),
      childId: String(a.childId),
      status: a.status,
      currentProgress: a.currentProgress,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      diagnosis: a.diagnosis || null,
      recommendations: a.recommendations || null,
      nextAssessmentDate: a.nextAssessmentDate || null,
      nextAssessmentReason: a.nextAssessmentReason || null,
      communicationScore: r?.communicationScore ?? null,
      socialScore: r?.socialScore ?? null,
      cognitiveScore: r?.cognitiveScore ?? null,
      motorScore: r?.motorScore ?? null,
      overallScore: r?.overallScore ?? null,
      // A. Developmental band — SCORE classification, computed live from
      // overallScore (never persisted). Separate from riskCategory/careStage
      // inside `prediction` below — see constants/developmental-staging.js.
      developmentalBand: r ? staging.getDevelopmentalBandFromScore(r.overallScore) : null,
      // B + C. Historical prediction snapshot (Step 5) — stored value only,
      // never recomputed against the currently active model. null when `r`
      // is null (assessment has no result yet, e.g. still in progress).
      prediction: r ? predictionSummary(assessmentProgress.getStoredOrDerivedCareStage(r)) : null,
    };
  });
}

// Builds a short, friendly message for the parent's bell notification.
function buildDiagnosisNotificationMessage(child, diagnosis) {
  const childName = [child?.firstName, child?.lastName].filter(Boolean).join(' ').trim() || 'your child';
  const shortDiagnosis = String(diagnosis || '').trim();
  return shortDiagnosis
    ? `A pediatrician submitted a diagnosis for ${childName}: ${shortDiagnosis}`
    : `A pediatrician submitted a diagnosis for ${childName}.`;
}

function resolveNotificationModel() {
  if (!Notification) return null;
  if (typeof Notification.create === 'function') return Notification;
  if (Notification.default && typeof Notification.default.create === 'function') return Notification.default;
  if (Notification.Notification && typeof Notification.Notification.create === 'function') return Notification.Notification;
  return null;
}

async function nextNotificationId() {
  try {
    const counters = mongoose.connection.collection('counters');
    const result = await counters.findOneAndUpdate(
      { _id: 'notifications' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );

    if (result?.value?.seq != null) return result.value.seq;

    const doc = await counters.findOne({ _id: 'notifications' });
    if (doc?.seq != null) return doc.seq;
  } catch (err) {
    console.warn('Diagnosis notification counter fallback error:', err.message);
  }

  return Date.now();
}

function buildDiagnosisRelatedPage(childId, assessmentId) {
  const params = new URLSearchParams();
  if (childId) params.set('childId', String(childId));
  if (assessmentId) params.set('assessmentId', String(assessmentId));
  const query = params.toString();
  return query ? `/parent/results.html?${query}` : '/parent/results.html';
}

// Sends one notification to the parent after the diagnosis is saved.
// The fallback insert keeps the diagnosis flow working even if the model export changes.
async function createParentDiagnosisNotification({ parentId, child, assessmentId, diagnosis }) {
  if (!parentId) return;

  const notificationModel = resolveNotificationModel();
  const payload = {
    userId: new mongoose.Types.ObjectId(String(parentId)),
    title: 'Pediatrician diagnosis updated',
    message: buildDiagnosisNotificationMessage(child, diagnosis),
    type: 'diagnosis',
    relatedPage: buildDiagnosisRelatedPage(child?._id, assessmentId),
    isRead: false,
  };

  try {
    if (notificationModel) {
      await notificationModel.create(payload);
      return;
    }
  } catch (err) {
    console.warn('Diagnosis notification model create failed, using collection fallback:', err.message);
  }

  try {
    await mongoose.connection.collection('notifications').insertOne({
      ...payload,
      id: await nextNotificationId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (err) {
    // Notification creation should never block diagnosis saving.
    console.warn('Diagnosis notification insert fallback failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Reassessment support: folding pediatrician Custom Questions into a NEW
// Assessment/AssessmentResult pair, per the adviser requirement that a
// completed historical assessment must never be updated by later custom-
// question activity. See models/PediaCustomQuestionAssignment.js:assessmentId.
// ---------------------------------------------------------------------------

// Every assignment for this child that is still unclaimed by any assessment
// AND unanswered. Matched on childId only (not parentId) so a secondary
// guardian with submitAssessments permission can also pick these up — the
// same access rule already used by /initialize and /submit below.
async function findPendingCustomQuestions(childId) {
  const assignments = await PediaCustomQuestionAssignment.find({
    childId,
    assessmentId: null,
    $or: [{ answer: null }, { answer: '' }],
  })
    .populate({ path: 'questionId', populate: { path: 'pediatricianId', select: 'firstName lastName' } })
    .sort({ createdAt: 1 })
    .lean();

  return assignments.filter((a) => a.questionId && a.questionId.isActive !== false);
}

function hasMeaningfulAnswerValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function serializePendingCustomQuestion(a) {
  const q = a.questionId || {};
  const ped = q.pediatricianId || {};
  return {
    assignmentId: a.id,
    questionText: q.questionText || '',
    // questionType is required on the model; the fallback only guards a
    // malformed/partial populate. Defaults to 'yes_no' (a scored type) now
    // that free-text 'short_answer' is retired.
    questionType: q.questionType || 'yes_no',
    options: Array.isArray(q.options) ? q.options : [],
    domain: normalizeDomain(q.domain),
    pediatricianName: ped.firstName ? `${ped.firstName} ${ped.lastName || ''}`.trim() : 'Pediatrician',
  };
}

// Mirrors the notification helper already in routes/custom-questions.js so the
// pediatrician still gets notified when a Custom Question is answered, even
// though this answer arrives through the reassessment flow instead of the
// standalone custom-questions page (preserves the existing notify-on-answer
// behavior — see adviser rule J).
async function notifyPediatricianCustomAnswer({ pediatricianId, child, questionText, answer }) {
  if (!pediatricianId) return;

  const notificationModel = resolveNotificationModel();
  const childName = [child?.firstName, child?.lastName].filter(Boolean).join(' ').trim() || 'a child';
  const shortAnswer = String(answer || '').trim().slice(0, 80);
  const payload = {
    userId: new mongoose.Types.ObjectId(String(pediatricianId)),
    title: '📝 Custom Question Answered',
    message: `${childName}'s parent answered: "${String(questionText || '').trim()}" — Answer: ${shortAnswer}`,
    type: 'assessment',
    relatedPage: '/pedia/pedia-questions.html',
    isRead: false,
  };

  try {
    if (notificationModel) {
      await notificationModel.create(payload);
      return;
    }
  } catch (err) {
    console.warn('Custom question answer notification model create failed, using collection fallback:', err.message);
  }

  try {
    await mongoose.connection.collection('notifications').insertOne({
      ...payload,
      id: await nextNotificationId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (err) {
    console.warn('Custom question answer notification insert fallback failed:', err.message);
  }
}

// POST /api/assessments/initialize
router.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const { childId } = req.body;
    if (!childId) return res.status(400).json({ error: 'childId is required.' });

    const child = await Child.findById(childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isOwner = String(child.parentId) === String(req.user.userId);
    const isPediaLinked = req.user.role === 'pediatrician' && await Appointment.exists({ childId: child._id, pediatricianId: req.user.userId });
    if (!isOwner && !isPediaLinked && !await hasPermission(req.user.userId, child._id, 'submitAssessments')) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const ageInfo = getAgeInfo(child.dateOfBirth);
    if (!ageInfo) return res.status(400).json({ error: 'Child must be between ages 3-8 for screening.' });

    const assessment = await Assessment.create({
      childId: child._id,
      createdBy: req.user.userId,
      status: 'in_progress',
      currentProgress: 0,
      startedAt: new Date(),
    });

    // Any Custom Questions a pediatrician has assigned and the parent hasn't
    // answered yet ride along in THIS new assessment — this is what makes a
    // screening a reassessment. Nothing is claimed/stamped yet; that only
    // happens on /submit, so an abandoned screening never orphans an
    // assignment against an incomplete Assessment.
    const pendingCustomQuestions = await findPendingCustomQuestions(child._id);

    res.json({
      success: true,
      assessmentId: String(assessment._id),
      ageGroup: ageInfo.group,
      ageLabel: ageInfo.label,
      childAge: ageInfo.age,
      totalQuestions: 20,
      questions: [], // frontend already has the question list hardcoded
      customQuestions: pendingCustomQuestions.map(serializePendingCustomQuestion),
    });
  } catch (err) {
    console.error('assessments initialize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assessments/save-draft
router.post('/save-draft', authMiddleware, async (req, res) => {
  try {
    const { assessmentId, progress, answers } = req.body;
    if (!assessmentId) return res.status(400).json({ error: 'assessmentId is required.' });

    await Assessment.findByIdAndUpdate(assessmentId, { currentProgress: progress || 0 });

    const answersArray = normalizeAnswers(answers);
    const bankIds = await getCoreBankIds();
    for (const a of answersArray) {
      if (!a.questionId || !a.answer) continue;
      await AssessmentAnswer.findOneAndUpdate(
        { assessmentId, questionId: String(a.questionId) },
        {
          assessmentId,
          questionId: String(a.questionId),
          domain: a.domain || 'Unknown',
          questionText: a.questionText || '',
          answer: a.answer,
          ...originFieldsFor(a.questionId, bankIds),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('assessments save-draft error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assessments/submit
router.post('/submit', authMiddleware, async (req, res) => {
  try {
    let { assessmentId, childId, answers, customAnswers } = req.body;
    const answersArray = normalizeAnswers(answers);
    const rawCustomAnswers = Array.isArray(customAnswers) ? customAnswers : [];

    if (!childId) return res.status(400).json({ error: 'childId is required.' });

    const child = await Child.findById(childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isOwner = String(child.parentId) === String(req.user.userId);
    const isPediaLinked = req.user.role === 'pediatrician' && await Appointment.exists({ childId: child._id, pediatricianId: req.user.userId });
    if (!isOwner && !isPediaLinked && !await hasPermission(req.user.userId, child._id, 'submitAssessments')) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    let assessment = assessmentId ? await Assessment.findById(assessmentId) : null;
    if (!assessment) {
      assessment = await Assessment.create({
        childId,
        createdBy: req.user.userId,
        status: 'in_progress',
        currentProgress: 100,
        startedAt: new Date(),
      });
      assessmentId = String(assessment._id);
    }

    const submitBankIds = await getCoreBankIds();
    for (const a of answersArray) {
      if (!a.questionId || !a.answer) continue;
      await AssessmentAnswer.findOneAndUpdate(
        { assessmentId, questionId: String(a.questionId) },
        {
          assessmentId,
          questionId: String(a.questionId),
          domain: a.domain || 'Unknown',
          questionText: a.questionText || '',
          answer: a.answer,
          ...originFieldsFor(a.questionId, submitBankIds),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const totals = {
      Communication: { earned: 0, total: 0 },
      'Social Skills': { earned: 0, total: 0 },
      Cognitive: { earned: 0, total: 0 },
      'Motor Skills': { earned: 0, total: 0 },
    };

    // Core-bank answers only, deliberately filtered by origin rather than "every
    // stored answer for this assessmentId" — see the Custom Question block below
    // for why a pedia_entry answer must never fall into this loop by accident.
    const storedCoreAnswers = await AssessmentAnswer.find({ assessmentId, origin: DATA_ORIGIN.CORE_BANK }).lean();
    for (const a of storedCoreAnswers) {
      if (!totals[a.domain]) continue;
      totals[a.domain].total += 2;
      totals[a.domain].earned += scoreAnswer(a.answer);
    }

    // ---------------------------------------------------------------------
    // Custom Question answers — this is what makes the new Assessment a
    // reassessment rather than a plain re-run of the core checklist.
    //
    // Each assignment can be claimed by exactly one assessment (enforced via
    // the assessmentId/answer guard below), and once claimed it is written
    // ONLY to this brand-new assessmentId's AssessmentAnswer rows — never to
    // any previous AssessmentAnswer or AssessmentResult. The previous
    // assessment was already 'complete' and its AssessmentResult document is
    // never touched by anything in this block.
    //
    // Scoring reuses the exact same 2/0 point scale as scoreAnswer() above —
    // no second scoring algorithm. A custom answer only contributes points
    // when BOTH are true:
    //   - its question's domain is one of the four scored domains. Every
    //     Custom Question domain is normalized to one of these four (see
    //     constants/assessmentDomains.js), so `domainIsScored` below is a
    //     defensive check, not an expected exclusion path anymore.
    //   - its question type is yes_no, so the answer maps onto the same
    //     yes/no scale the core bank already uses
    // multiple_choice and short_answer have no equivalent scale anywhere in
    // this codebase, so they are recorded (for the record/history/domain
    // details view) but deliberately excluded from scoring — surfaced below
    // via scoringGaps instead of silently guessed at.
    // ---------------------------------------------------------------------
    const scoringGaps = [];
    let customAnswersSaved = 0;

    if (rawCustomAnswers.length) {
      const seenAssignmentIds = new Set();
      const dedupedCustomAnswers = [];
      for (const item of rawCustomAnswers) {
        const aId = Number(item?.assignmentId);
        const ans = String(item?.answer ?? '').trim();
        if (!Number.isFinite(aId) || !ans) continue;
        if (seenAssignmentIds.has(aId)) continue; // dedupe: never score the same assignment twice in one submit
        seenAssignmentIds.add(aId);
        dedupedCustomAnswers.push({ assignmentId: aId, answer: ans });
      }

      if (dedupedCustomAnswers.length) {
        // Matched on childId only (not parentId) so the same secondary-guardian
        // access already checked above can also submit these.
        const assignmentDocs = await PediaCustomQuestionAssignment.find({
          id: { $in: dedupedCustomAnswers.map((i) => i.assignmentId) },
          childId: child._id,
        }).populate({ path: 'questionId', populate: { path: 'pediatricianId', select: 'firstName lastName' } });

        const assignmentById = new Map(assignmentDocs.map((a) => [a.id, a]));
        const submittedAt = new Date();

        for (const { assignmentId: aId, answer: ans } of dedupedCustomAnswers) {
          const assignment = assignmentById.get(aId);
          if (!assignment || !assignment.questionId) continue;

          // Already claimed by a (different) assessment, or already answered
          // standalone — refuse to re-score it. This is the duplicate-
          // submission/duplicate-scoring guard (adviser rule K).
          if (assignment.assessmentId || hasMeaningfulAnswerValue(assignment.answer)) {
            scoringGaps.push({
              assignmentId: aId,
              questionText: assignment.questionId.questionText,
              reason: 'Already answered previously — skipped to avoid duplicate scoring.',
            });
            continue;
          }

          const question = assignment.questionId;
          // Normalized here too (not just on save/read paths) so a question
          // created before this fix — or edited directly in the database —
          // still lands in the correct existing domain bucket at score time.
          const domain = normalizeDomain(question.domain);

          await AssessmentAnswer.findOneAndUpdate(
            { assessmentId, questionId: `custom_${assignment.id}` },
            {
              assessmentId,
              questionId: `custom_${assignment.id}`,
              domain,
              questionText: question.questionText || '',
              answer: ans,
              origin: DATA_ORIGIN.PEDIA_ENTRY,
              sourceQuestionRef: String(question._id),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          customAnswersSaved += 1;

          assignment.assessmentId = assessmentId;
          assignment.answer = ans;
          assignment.answeredAt = submittedAt;
          await assignment.save();

          const normalizedAnswer = ans.toLowerCase();
          const domainIsScored = Boolean(totals[domain]);
          const isYesNo = question.questionType === 'yes_no';
          const mapsToScale = normalizedAnswer === 'yes' || normalizedAnswer === 'no';

          if (domainIsScored && isYesNo && mapsToScale) {
            totals[domain].total += 2;
            totals[domain].earned += scoreAnswer(ans);
          } else {
            scoringGaps.push({
              assignmentId: aId,
              questionText: question.questionText,
              domain,
              questionType: question.questionType,
              reason: !domainIsScored
                ? `Domain "${domain}" is not a scored domain — answer recorded but not scored.`
                : `Question type "${question.questionType}" has no defined scoring rule — answer recorded but not scored.`,
            });
          }

          const pedId = question.pediatricianId?._id;
          if (pedId) {
            await notifyPediatricianCustomAnswer({
              pediatricianId: pedId,
              child,
              questionText: question.questionText,
              answer: ans,
            });
          }
        }
      }
    }

    const communicationScore = totals.Communication.total ? Math.round((totals.Communication.earned / totals.Communication.total) * 100) : 0;
    const socialScore        = totals['Social Skills'].total ? Math.round((totals['Social Skills'].earned / totals['Social Skills'].total) * 100) : 0;
    const cognitiveScore     = totals.Cognitive.total ? Math.round((totals.Cognitive.earned / totals.Cognitive.total) * 100) : 0;
    const motorScore         = totals['Motor Skills'].total ? Math.round((totals['Motor Skills'].earned / totals['Motor Skills'].total) * 100) : 0;
    const overallScore       = Math.round((communicationScore + socialScore + cognitiveScore + motorScore) / 4);

    const riskFlags = [];
    if (scoring.isRiskFlagged(communicationScore)) riskFlags.push('Communication delay detected');
    if (scoring.isRiskFlagged(socialScore)) riskFlags.push('Social skills concern detected');
    if (scoring.isRiskFlagged(cognitiveScore)) riskFlags.push('Cognitive development concern');
    if (scoring.isRiskFlagged(motorScore)) riskFlags.push('Motor skills delay detected');

    // ML PREDICTION -> STAGING INTERPRETATION -> persisted snapshot.
    // Generated once, right here, at completion time, and never recomputed
    // afterward — this is what lets a reassessment comparison months later
    // compare against exactly what THIS assessment showed, even if a newer
    // ML model is trained in the meantime. Never blocks a valid assessment
    // result from saving: buildPredictionForStorage always resolves to a
    // complete rule-based OR ML record, never throws, never partial.
    const prediction = await assessmentProgress.buildPredictionForStorage(
      { communicationScore, socialScore, cognitiveScore, motorScore, overallScore },
      childId
    );

    const result = await AssessmentResult.findOneAndUpdate(
      { assessmentId },
      {
        assessmentId,
        childId,
        communicationScore,
        socialScore,
        cognitiveScore,
        motorScore,
        overallScore,
        communicationStatus: getStatus(communicationScore),
        socialStatus: getStatus(socialScore),
        cognitiveStatus: getStatus(cognitiveScore),
        motorStatus: getStatus(motorScore),
        riskFlags,
        // Records which band set produced the four *Status values above, so
        // documents scored under the old 51/26 bands stay distinguishable.
        // null on a document means it predates constants/scoring.js.
        scoringBandsVersion: scoring.SCORING_BANDS_VERSION,
        prediction,
        generatedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Assessment.findByIdAndUpdate(assessmentId, {
      status: 'complete',
      currentProgress: 100,
      completedAt: new Date(),
    });

    sse.broadcast('analytics:update', { type: 'assessment', action: 'complete' });

    res.json({
      success: true,
      resultId: String(result._id),
      assessmentId: String(assessmentId),
      analysisStatus: 'complete',
      // Custom Question transparency: how many were folded into scoring vs.
      // recorded-but-not-scored (and why). Never silently dropped.
      customAnswersSaved,
      scoringGaps,
    });
  } catch (err) {
    console.error('assessments submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/pedia-patients
router.get('/pedia-patients', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const appointments = await Appointment.find({ pediatricianId: req.user.userId }).sort({ appointmentDate: -1, createdAt: -1 }).lean();
    const uniqueByChild = new Map();
    for (const a of appointments) {
      const key = String(a.childId);
      const current = uniqueByChild.get(key);
      if (!current || a.id > current.id) uniqueByChild.set(key, a);
    }

    const patients = [];
    for (const appt of uniqueByChild.values()) {
      const [child, parent, latestAssessment] = await Promise.all([
        Child.findById(appt.childId).lean(),
        User.findById(appt.parentId).lean(),
        Assessment.findOne({ childId: appt.childId }).sort({ startedAt: -1 }).lean(),
      ]);
      const latestResult = latestAssessment ? await AssessmentResult.findOne({ assessmentId: latestAssessment._id }).lean() : null;

      const paymentConfirmed = appt.paymentStatus === 'Paid' || Boolean(appt.paymentOverride?.isOverridden);

      patients.push({
        childId: child ? String(child._id) : null,
        childFirstName: child?.firstName || '',
        childLastName: child?.lastName || '',
        childDateOfBirth: child?.dateOfBirth || null,
        childGender: child?.gender || null,
        childProfileIcon: child?.profileIcon || null,
        parentFirstName: parent?.firstName || '',
        parentLastName: parent?.lastName || '',
        parentEmail: parent?.email || '',
        appointmentId: appt.id,
        appointmentStatus: appt.status,
        appointmentDate: appt.appointmentDate,
        reason: appt.reason,
        paymentStatus: appt.paymentStatus || 'Unpaid',
        paymentConfirmed,
        communicationScore: latestResult?.communicationScore ?? null,
        socialScore: latestResult?.socialScore ?? null,
        cognitiveScore: latestResult?.cognitiveScore ?? null,
        motorScore: latestResult?.motorScore ?? null,
        overallScore: latestResult?.overallScore ?? null,
        lastAssessmentDate: latestResult?.generatedAt ?? null,
        assessmentId: latestAssessment ? String(latestAssessment._id) : null,
        diagnosis: latestAssessment?.diagnosis || null,
        recommendations: latestAssessment?.recommendations || null,
        nextAssessmentDate: latestAssessment?.nextAssessmentDate || null,
        nextAssessmentReason: latestAssessment?.nextAssessmentReason || null,

        // Additive: the structured outcome label, so reopening the diagnosis
        // modal can show what was already recorded instead of a blank
        // dropdown. Kept separate from `diagnosis` above — see
        // models/Assessment.js on why the free text can never stand in for it.
        clinicalOutcome: latestAssessment?.clinicalOutcome || null,
        clinicalOutcomeDomains: Array.isArray(latestAssessment?.clinicalOutcomeDomains)
          ? latestAssessment.clinicalOutcomeDomains
          : [],
        clinicalOutcomeAt: latestAssessment?.clinicalOutcomeAt || null,

        // Step 10: reviewed ML training-target label — separate from
        // clinicalOutcome above. Additive so reopening the diagnosis modal
        // can show what was already reviewed instead of a blank dropdown.
        mlLabel: latestAssessment?.mlLabel ? {
          riskCategory: latestAssessment.mlLabel.riskCategory,
          reviewedAt: latestAssessment.mlLabel.reviewedAt,
          notes: latestAssessment.mlLabel.notes || null,
        } : null,
        mlReviewStatus: latestAssessment?.mlReviewStatus || 'unreviewed',

        // Step 14: pediatrician view — same developmentalBand/prediction
        // shape already exposed to the parent (GET
        // /:assessmentId/results). developmentalBand (score classification)
        // computed live from overallScore, never persisted; prediction
        // (riskCategory/careStage) is the STORED snapshot from this child's
        // latest completed assessment (see
        // services/assessmentProgress.js getStoredOrDerivedCareStage) —
        // never recomputed against whichever model is active now.
        developmentalBand: latestResult ? staging.getDevelopmentalBandFromScore(latestResult.overallScore) : null,
        prediction: latestResult ? predictionSummary(assessmentProgress.getStoredOrDerivedCareStage(latestResult)) : null,
      });
    }

    res.json({
      success: true,
      patients: patients.map((p) => ({
        ...p,
        scores: p.communicationScore != null ? {
          Communication: Math.round(p.communicationScore),
          'Social Skills': Math.round(p.socialScore),
          Cognitive: Math.round(p.cognitiveScore),
          'Motor Skills': Math.round(p.motorScore),
        } : {},
      })),
    });
  } catch (err) {
    console.error('assessments pedia-patients error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/patients
// Filter patients by assessment category and threshold level
router.get('/patients', authMiddleware, async (req, res) => {
  try {
    const { category, threshold } = req.query;

    const appointments = await Appointment.find({ pediatricianId: req.user.userId }).sort({ appointmentDate: -1, createdAt: -1 }).lean();
    const uniqueByChild = new Map();
    for (const a of appointments) {
      const key = String(a.childId);
      const current = uniqueByChild.get(key);
      if (!current || a.id > current.id) uniqueByChild.set(key, a);
    }

    const patients = [];
    for (const appt of uniqueByChild.values()) {
      const child = await Child.findById(appt.childId).lean();
      if (!child) continue;

      const parent = await User.findById(appt.parentId).lean();
      const latestAssessment = await Assessment.findOne({ childId: appt.childId }).sort({ startedAt: -1 }).lean();
      const latestResult = latestAssessment ? await AssessmentResult.findOne({ assessmentId: latestAssessment._id }).lean() : null;

      if (!latestResult) continue;

      const scoreMap = {
        motor: latestResult.motorScore,
        communication: latestResult.communicationScore,
        social: latestResult.socialScore,
        cognitive: latestResult.cognitiveScore
      };

      const score = category && scoreMap[category] != null ? scoreMap[category] : null;
      const patientThreshold = score != null ? getScoreThreshold(score) : null;

      if (category && threshold) {
        if (!THRESHOLD_RANGES[threshold]) continue;
        const range = THRESHOLD_RANGES[threshold];
        if (score == null || score < range.min || score > range.max) continue;
      } else if (category && patientThreshold !== threshold) {
        continue;
      }

      patients.push({
        childId: String(child._id),
        childFirstName: child.firstName || '',
        childLastName: child.lastName || '',
        childDateOfBirth: child.dateOfBirth || null,
        childGender: child.gender || null,
        parentFirstName: parent?.firstName || '',
        parentLastName: parent?.lastName || '',
        appointmentId: appt.id,
        appointmentStatus: appt.status,
        appointmentDate: appt.appointmentDate,
        motorScore: latestResult.motorScore,
        communicationScore: latestResult.communicationScore,
        socialScore: latestResult.socialScore,
        cognitiveScore: latestResult.cognitiveScore,
        overallScore: latestResult.overallScore,
        motorStatus: getStatus(latestResult.motorScore || 0),
        communicationStatus: getStatus(latestResult.communicationScore || 0),
        socialStatus: getStatus(latestResult.socialScore || 0),
        cognitiveStatus: getStatus(latestResult.cognitiveScore || 0),
        lastAssessmentDate: latestResult.generatedAt || null,
        thresholdMatch: patientThreshold
      });
    }

    res.json({
      success: true,
      filter: { category: category || 'all', threshold: threshold || 'all' },
      patients
    });
  } catch (err) {
    console.error('assessments patients filter error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assessments/diagnose/:childId
// Saves the pediatrician's diagnosis, updates the related assessment record,
// and creates a notification so the parent sees it in the bell modal.
router.post('/diagnose/:childId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const {
      diagnosis, recommendations, nextAssessmentDate, nextAssessmentReason,
      clinicalOutcome, clinicalOutcomeDomains,
    } = req.body;

    // Previously this was `if (!diagnosis)`, which accepted any truthy string —
    // that is how "Yes please" became the only diagnosis in the database.
    // Require real prose, and reject whitespace and trivial affirmations.
    const diagnosisText = String(diagnosis ?? '').trim();
    if (!diagnosisText) {
      return res.status(400).json({ error: 'Diagnosis is required.' });
    }
    if (diagnosisText.length < 10) {
      return res.status(400).json({
        error: 'Diagnosis must be at least 10 characters — please describe the clinical finding.',
      });
    }
    if (/^(yes|no|ok|okay|none|n\/?a|test|yes please|no please)[.!]*$/i.test(diagnosisText)) {
      return res.status(400).json({
        error: 'Diagnosis must describe a clinical finding, not a one-word reply.',
      });
    }

    // The structured outcome label. Optional so existing callers keep working,
    // but validated strictly when supplied — a mislabelled outcome is worse
    // than an absent one, because only this field can serve as ground truth.
    const OUTCOMES = Assessment.schema.path('clinicalOutcome').enumValues;
    const DOMAINS = ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'];

    let outcome = null;
    if (clinicalOutcome != null && String(clinicalOutcome).trim() !== '') {
      outcome = String(clinicalOutcome).trim();
      if (!OUTCOMES.includes(outcome)) {
        return res.status(400).json({
          error: `clinicalOutcome must be one of: ${OUTCOMES.join(', ')}`,
        });
      }
    }

    let outcomeDomains = [];
    if (Array.isArray(clinicalOutcomeDomains)) {
      outcomeDomains = clinicalOutcomeDomains.map((d) => String(d).trim()).filter(Boolean);
      const invalid = outcomeDomains.filter((d) => !DOMAINS.includes(d));
      if (invalid.length) {
        return res.status(400).json({
          error: `Unknown outcome domain(s): ${invalid.join(', ')}. Allowed: ${DOMAINS.join(', ')}`,
        });
      }
    }
    // A "typical development" conclusion cannot name affected domains.
    if (outcome === 'typical_development') outcomeDomains = [];

    const parsedNextAssessmentDate = parseNextAssessmentDate(nextAssessmentDate);
    if (parsedNextAssessmentDate.error) {
      return res.status(400).json({ error: parsedNextAssessmentDate.error });
    }

    // Load the child so we can update the correct assessment and notify the parent.
    const child = await Child.findById(req.params.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const latest = await Assessment.findOne({ childId: req.params.childId }).sort({ startedAt: -1 });
    if (!latest) return res.status(404).json({ error: 'No assessment found for this child.' });

    // Save the diagnosis on the assessment so the Results page can display it later.
    latest.diagnosis = diagnosisText;
    // Only stamp the outcome when one was actually supplied — an absent label
    // must stay null rather than being inferred from the prose above.
    if (outcome) {
      latest.clinicalOutcome = outcome;
      latest.clinicalOutcomeDomains = outcomeDomains;
      latest.clinicalOutcomeBy = req.user.userId;
      latest.clinicalOutcomeAt = new Date();
    }
    latest.recommendations = recommendations || null;
    latest.nextAssessmentDate = parsedNextAssessmentDate.value;
    latest.nextAssessmentReason = nextAssessmentReason ? String(nextAssessmentReason).trim() : null;
    latest.reviewedByPediatrician = req.user.userId;
    latest.reviewedAt = new Date();
    await latest.save();

    // Create the parent notification after the diagnosis is saved.
    // This is the part that makes the bell badge/list show the new diagnosis.
    await createParentDiagnosisNotification({
      parentId: child.parentId,
      child,
      assessmentId: String(latest._id),
      diagnosis,
    });

    res.json({
      success: true,
      nextAssessmentDate: latest.nextAssessmentDate || null,
      nextAssessmentReason: latest.nextAssessmentReason || null,
      clinicalOutcome: latest.clinicalOutcome || null,
      clinicalOutcomeDomains: latest.clinicalOutcomeDomains || [],
      // Surfaced so the caller knows whether this review produced a usable
      // ground-truth label, rather than having to infer it.
      isLabelled: Boolean(latest.clinicalOutcome),
    });
  } catch (err) {
    console.error('assessments diagnose error:', err);
    res.status(500).json({ error: err.message });
  }
});

const ML_LABEL_VALUES = ['Low', 'Medium', 'High'];

// Pure (no I/O) — returns null when riskCategory is a valid reviewed ML
// label, or a human-readable reason it isn't. Split out from the route
// handler so the validation rule is unit-testable without a live request.
function getMlLabelValidationError(riskCategory) {
  const value = String(riskCategory ?? '').trim();
  if (!value) return 'riskCategory is required.';
  if (!ML_LABEL_VALUES.includes(value)) return `riskCategory must be one of: ${ML_LABEL_VALUES.join(', ')}`;
  return null;
}

// POST /api/assessments/:assessmentId/ml-label
// Step 10: lets an authorized pediatrician assign a REVIEWED ML training
// target (Low/Medium/High) to a completed assessment — see
// models/Assessment.js `mlLabel`. This is NOT a diagnosis and does not
// touch `diagnosis`/`clinicalOutcome` — it exists purely so a later dataset
// export (routes/admin.js GET /training/reviewed-assessments/export) has an
// independently-supplied ground-truth label. The system NEVER computes this
// value itself — see "Important Label Quality Rules" in the Step 10 task:
// no threshold-of-score, no ML prediction, no recommendation output.
// Small typed error so the route can map it to the right HTTP status
// without the business logic itself knowing about Express.
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Core logic for reviewing an assessment's ML training-target label — split
 * out from the route handler so authorization/validation are unit-testable
 * without a live HTTP request. Throws HttpError on any rejection; never
 * partially applies a change (assessment.save() is the only write, after
 * every check has passed).
 *
 * @param {string} assessmentId
 * @param {{userId: string, role: string}} user  the authenticated reviewer
 * @param {{riskCategory: string, notes?: string|null}} input
 */
async function reviewAssessmentMlLabel(assessmentId, user, input) {
  if (user.role !== 'pediatrician') {
    throw new HttpError(403, 'Pediatricians only.');
  }

  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) throw new HttpError(404, 'Assessment not found.');

  if (assessment.status !== 'complete') {
    throw new HttpError(400, 'Only a completed assessment can be given a reviewed ML label.');
  }

  // Authorization: the pediatrician must actually be linked to this child
  // (an existing appointment) — the same check already used for
  // /:assessmentId/compare and routes/recommendations.js. Role alone is not
  // enough; this is what stops one pediatrician labelling another's
  // unrelated patient.
  const isPediaLinked = await Appointment.exists({ childId: assessment.childId, pediatricianId: user.userId });
  if (!isPediaLinked) {
    throw new HttpError(403, 'You are not linked to this patient — only a pediatrician with an appointment for this child may review it.');
  }

  const mlLabelError = getMlLabelValidationError(input.riskCategory);
  if (mlLabelError) throw new HttpError(400, mlLabelError);
  const riskCategory = String(input.riskCategory).trim();

  const notes = input.notes != null ? String(input.notes).trim().slice(0, 1000) || null : null;

  // Revision, not versioning: the project has no existing per-field history
  // mechanism for Assessment, and Step 10 asks for the smallest clean
  // implementation — not a new one. mlLabel always holds the LATEST valid
  // review; the value it's replacing (if any) is preserved in the AuditLog
  // entry below rather than silently discarded.
  const previousRiskCategory = assessment.mlLabel ? assessment.mlLabel.riskCategory : null;

  assessment.mlLabel = {
    riskCategory,
    reviewedBy: user.userId,
    reviewedAt: new Date(),
    reviewSource: 'pediatrician',
    notes,
  };
  assessment.mlReviewStatus = 'reviewed';
  await assessment.save();

  await AuditLog.create({
    actorId: user.userId,
    action: 'ml_label_reviewed',
    targetType: 'Assessment',
    targetId: assessment._id,
    details: { childId: String(assessment.childId), riskCategory, previousRiskCategory, notes },
  });

  return {
    mlLabel: {
      riskCategory: assessment.mlLabel.riskCategory,
      reviewedBy: String(assessment.mlLabel.reviewedBy),
      reviewedAt: assessment.mlLabel.reviewedAt,
      reviewSource: assessment.mlLabel.reviewSource,
      notes: assessment.mlLabel.notes,
    },
    mlReviewStatus: assessment.mlReviewStatus,
  };
}

router.post('/:assessmentId/ml-label', authMiddleware, async (req, res) => {
  try {
    const result = await reviewAssessmentMlLabel(req.params.assessmentId, req.user, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.statusCode).json({ error: err.message });
    console.error('assessments ml-label error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assessments/:assessmentId/ml-label/exclude
// Marks a completed assessment as unfit for ML dataset export (e.g. poor
// data quality, an unreliable screening) WITHOUT assigning a risk category.
// Distinct from simply never reviewing it — 'unreviewed' just means no one
// has looked yet; 'excluded' is an explicit reviewer decision that this
// assessment must never be exported, which the export route enforces by
// only selecting mlReviewStatus === 'reviewed'.
router.post('/:assessmentId/ml-label/exclude', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const assessment = await Assessment.findById(req.params.assessmentId);
    if (!assessment) return res.status(404).json({ error: 'Assessment not found.' });

    const isPediaLinked = await Appointment.exists({ childId: assessment.childId, pediatricianId: req.user.userId });
    if (!isPediaLinked) {
      return res.status(403).json({ error: 'You are not linked to this patient.' });
    }

    assessment.mlReviewStatus = 'excluded';
    await assessment.save();

    await AuditLog.create({
      actorId: req.user.userId,
      action: 'ml_label_excluded',
      targetType: 'Assessment',
      targetId: assessment._id,
      details: { childId: String(assessment.childId) },
    });

    res.json({ success: true, mlReviewStatus: assessment.mlReviewStatus });
  } catch (err) {
    console.error('assessments ml-label exclude error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/:assessmentId/results
// Returns the numeric results plus any pediatrician diagnosis/recommendation
// saved on the Assessment record, so the parent Results page can show the
// diagnosis banner again when the bell notification is opened.
router.get('/:assessmentId/results', authMiddleware, async (req, res) => {
  try {
    const result = await AssessmentResult.findOne({ assessmentId: req.params.assessmentId }).lean();
    if (!result) return res.status(404).json({ error: 'Results not found.' });

    const assessment = await Assessment.findById(req.params.assessmentId).lean();

    // Evidence behind each stored percentage. Read-only: it counts the answers
    // that were already saved for THIS assessment and never re-scores them.
    const answers = await AssessmentAnswer.find({ assessmentId: req.params.assessmentId }).lean();
    const domainDetails = buildDomainDetails(answers, result);

    res.json({
      success: true,
      results: {
        id: String(result._id),
        assessmentId: String(result.assessmentId),
        childId: String(result.childId),
        communicationScore: result.communicationScore,
        socialScore: result.socialScore,
        cognitiveScore: result.cognitiveScore,
        motorScore: result.motorScore,
        overallScore: result.overallScore,
        communicationStatus: result.communicationStatus,
        socialStatus: result.socialStatus,
        cognitiveStatus: result.cognitiveStatus,
        motorStatus: result.motorStatus,
        riskFlags: Array.isArray(result.riskFlags) ? result.riskFlags : [],
        generatedAt: result.generatedAt,

        // These fields come from the Assessment document, not AssessmentResult.
        diagnosis: assessment?.diagnosis || null,
        recommendations: assessment?.recommendations || null,
        nextAssessmentDate: assessment?.nextAssessmentDate || null,
        nextAssessmentReason: assessment?.nextAssessmentReason || null,
        reviewedByPediatrician: assessment?.reviewedByPediatrician ? String(assessment.reviewedByPediatrician) : null,
        reviewedAt: assessment?.reviewedAt || null,

        // Additive. null when the assessment has no stored answers (older
        // records) — callers must treat it as optional. Every field above is
        // unchanged so existing consumers keep working.
        domainDetails,

        // A. Developmental band — SCORE classification, computed live from
        // overallScore (never persisted). Separate from riskCategory/
        // careStage inside `prediction` below — see
        // constants/developmental-staging.js.
        developmentalBand: staging.getDevelopmentalBandFromScore(result.overallScore),

        // B + C. Historical prediction snapshot (Step 5) — the stored
        // classification this assessment was actually given at completion
        // time, never recomputed against whatever ML model is active now.
        // See services/assessmentProgress.js getStoredOrDerivedCareStage.
        // Never exposes the model's filesystem path.
        prediction: predictionSummary(assessmentProgress.getStoredOrDerivedCareStage(result)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/:childId/history
router.get('/:childId/history', authMiddleware, async (req, res) => {
  try {
    const child = await Child.findById(req.params.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isParentOwner = String(child.parentId) === String(req.user.userId);
    const isPediaLinked = req.user.role === 'pediatrician' && await Appointment.exists({ childId: child._id, pediatricianId: req.user.userId });
    const allowed = isParentOwner || isPediaLinked || req.user.role === 'admin' || await hasPermission(req.user.userId, child._id, 'viewAssessments');
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    const history = await buildHistoryForChild(child._id);
    res.json({ success: true, assessments: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// GET /api/assessments/child/:childId/progress-notes
// Returns the saved pediatrician progress notes for one child.
router.get('/child/:childId/progress-notes', authMiddleware, async (req, res) => {
  try {
    const child = await Child.findById(req.params.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isParentOwner = String(child.parentId) === String(req.user.userId);
    const isPediaLinked = req.user.role === 'pediatrician' && await Appointment.exists({
      childId: child._id,
      pediatricianId: req.user.userId,
    });

    const allowed = isParentOwner || isPediaLinked || req.user.role === 'admin' || await hasPermission(req.user.userId, child._id, 'viewAssessments');
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    const noteFilter = { childId: child._id };
    // Pediatricians only need to see their own note timeline in My Patients.
    if (req.user.role === 'pediatrician') {
      noteFilter.pediatricianId = req.user.userId;
    }

    const notes = await PatientProgressNote.find(noteFilter)
      .populate('pediatricianId', 'firstName lastName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      notes: notes.map((n) => ({
        id: n.id,
        mongoId: String(n._id),
        childId: String(n.childId),
        appointmentId: n.appointmentId || null,
        assessmentId: n.assessmentId ? String(n.assessmentId) : null,
        progressStatus: n.progressStatus,
        note: n.note,
        pediatricianName: n.pediatricianId?.firstName
          ? `${n.pediatricianId.firstName} ${n.pediatricianId.lastName || ''}`.trim()
          : 'Pediatrician',
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
    });
  } catch (err) {
    console.error('assessments progress-notes get error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assessments/child/:childId/progress-notes
// Saves one clinical follow-up note so pediatricians can track patient progress over time.
router.post('/child/:childId/progress-notes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const { progressStatus, note } = req.body;
    if (!note || !String(note).trim()) {
      return res.status(400).json({ error: 'Progress note is required.' });
    }

    const child = await Child.findById(req.params.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const linkedAppointment = await Appointment.findOne({
      childId: child._id,
      pediatricianId: req.user.userId,
    }).sort({ appointmentDate: -1, createdAt: -1 }).lean();

    if (!linkedAppointment) {
      return res.status(403).json({ error: 'You can only update progress for your own patients.' });
    }

    const latestAssessment = await Assessment.findOne({ childId: child._id })
      .sort({ startedAt: -1 })
      .lean();

    const VALID_STATUSES = [
      'initial_review',
      'monitoring',
      'follow_up',
      'improving',
      'stable',
      'needs_attention',
      'referred',
      'completed',
    ];
    const safeStatus = VALID_STATUSES.includes(String(progressStatus || '').trim())
      ? String(progressStatus).trim()
      : 'monitoring';

    const created = await PatientProgressNote.create({
      childId: child._id,
      pediatricianId: req.user.userId,
      appointmentId: linkedAppointment.id,
      assessmentId: latestAssessment ? latestAssessment._id : null,
      progressStatus: safeStatus,
      note: String(note).trim(),
    });

    res.status(201).json({
      success: true,
      note: {
        id: created.id,
        mongoId: String(created._id),
        progressStatus: created.progressStatus,
        note: created.note,
        createdAt: created.createdAt,
      },
    });
  } catch (err) {
    console.error('assessments progress-notes post error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/:childId/review-answers
// Returns all assessment answers for a child grouped by domain, along with
// the AI result scores and risk flags. Read-only for pediatricians.
// This powers the "Review Pre-Assessment" modal on the patients page.
router.get('/:childId/review-answers', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const child = await Child.findById(req.params.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    // Ensure pediatrician is linked to this patient through an appointment
    const linked = await Appointment.exists({
      childId: child._id,
      pediatricianId: req.user.userId,
    });
    if (!linked) {
      return res.status(403).json({ error: 'You can only review answers for your own patients.' });
    }

    // Get the latest completed assessment
    const assessment = await Assessment.findOne({
      childId: child._id,
      status: 'complete',
    }).sort({ completedAt: -1, startedAt: -1 }).lean();

    if (!assessment) {
      return res.status(404).json({ error: 'No completed assessment found for this child.' });
    }

    // Fetch all answers and the result for this assessment
    const [answers, result] = await Promise.all([
      AssessmentAnswer.find({ assessmentId: assessment._id }).lean(),
      AssessmentResult.findOne({ assessmentId: assessment._id }).lean(),
    ]);

    // Group answers by domain
    const grouped = {};
    for (const a of answers) {
      const domain = a.domain || 'Other';
      if (!grouped[domain]) grouped[domain] = [];

      // Answer-level insight comes from the shared interpretation helper so the
      // parent Results page and this modal can never disagree about an answer —
      // except for a custom answer interpretAnswer() was never designed to read
      // (see the matching guard in buildDomainDetails above).
      const normalizedAnswer = String(a.answer ?? '').trim().toLowerCase();
      const isUnscoredCustomAnswer = a.origin === DATA_ORIGIN.PEDIA_ENTRY
        && normalizedAnswer !== 'yes' && normalizedAnswer !== 'no' && normalizedAnswer !== 'sometimes';
      const { insight, insightLevel } = isUnscoredCustomAnswer
        ? { insight: 'Recorded — not scored', insightLevel: 'neutral' }
        : interpretAnswer(a.answer);

      grouped[domain].push({
        questionId: a.questionId,
        questionText: a.questionText || '(Question text not recorded)',
        answer: a.answer,
        aiInsight: insight,
        insightLevel,
      });
    }

    // Build domain-level summaries from the result
    const domainSummaries = {};
    if (result) {
      for (const [domain, fields] of Object.entries(DOMAIN_SCORE_FIELDS)) {
        const score = result[fields.score];
        domainSummaries[domain] = {
          score,
          status: result[fields.status],
          riskLevel: RISK_LEVEL_BY_BAND[scoring.bandFor(score)],
        };
      }
    }

    // Age calculation
    const ageInfo = getAgeInfo(child.dateOfBirth);

    res.json({
      success: true,
      child: {
        id: String(child._id),
        firstName: child.firstName,
        lastName: child.lastName,
        dateOfBirth: child.dateOfBirth,
        gender: child.gender,
        age: ageInfo ? ageInfo.age : null,
        ageLabel: ageInfo ? ageInfo.label : null,
      },
      assessment: {
        id: String(assessment._id),
        status: assessment.status,
        completedAt: assessment.completedAt,
        diagnosis: assessment.diagnosis || null,
        recommendations: assessment.recommendations || null,
        nextAssessmentDate: assessment.nextAssessmentDate || null,
        nextAssessmentReason: assessment.nextAssessmentReason || null,
      },
      overallScore: result ? result.overallScore : null,
      overallRisk: result ? OVERALL_RISK_BY_BAND[scoring.bandFor(result.overallScore)] : null,
      riskFlags: result ? (result.riskFlags || []) : [],
      domainSummaries,
      answersByDomain: grouped,
    });
  } catch (err) {
    console.error('assessments review-answers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assessments/:assessmentId/compare
// Compares this assessment's stored result against the immediately previous
// COMPLETED assessment for the same child. Read-only: it never recomputes or
// writes to either AssessmentResult — both stay exactly as originally
// generated, which is the adviser's core data-integrity requirement.
//
// Step 4 (reassessment comparison): also reports the OVERALL CARE STAGE for
// both assessments (ML-derived when a compatible model is active, rule-based
// fallback otherwise — see services/assessmentProgress.js) and the direction
// of change between them, plus each side's separate developmentalBand (Step
// 8 — a score classification, not the same thing as careStage; see
// constants/developmental-staging.js). This is an assessment-HISTORY
// comparison, not a diagnosis: it never claims medical recovery/cure and
// never implies a pediatrician's supervision should be reduced — it only
// reports "the flagged care stage went from X to Y". The existing per-domain
// `scores` table below is unchanged for backward compatibility with
// js/parent/results.js.
router.get('/:assessmentId/compare', authMiddleware, async (req, res) => {
  try {
    const currentAssessment = await Assessment.findById(req.params.assessmentId).lean();
    if (!currentAssessment) return res.status(404).json({ error: 'Assessment not found.' });

    const child = await Child.findById(currentAssessment.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isOwner = String(child.parentId) === String(req.user.userId);
    const isPediaLinked = req.user.role === 'pediatrician' && await Appointment.exists({ childId: child._id, pediatricianId: req.user.userId });
    const allowed = isOwner || isPediaLinked || req.user.role === 'admin' || await hasPermission(req.user.userId, child._id, 'viewAssessments');
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    const currentResult = await AssessmentResult.findOne({ assessmentId: currentAssessment._id }).lean();
    if (!currentResult) return res.status(404).json({ error: 'This assessment has no results yet.' });

    // Current assessment itself must be a completed one — comparing against
    // an in-progress/draft screening would be meaningless and misleading.
    if (currentAssessment.status !== 'complete') {
      return res.status(400).json({ error: 'This assessment is not yet complete.' });
    }

    const anchorDate = currentAssessment.completedAt || currentAssessment.startedAt;
    const previousAssessment = await assessmentProgress.getPreviousCompletedAssessment(
      currentAssessment.childId,
      currentAssessment._id,
      anchorDate
    );

    const previousResult = previousAssessment
      ? await AssessmentResult.findOne({ assessmentId: previousAssessment._id }).lean()
      : null;

    const summary = await assessmentProgress.buildAssessmentProgressSummary(
      currentAssessment,
      currentResult,
      previousAssessment,
      previousResult
    );

    res.json({
      success: true,
      hasPrevious: Boolean(previousAssessment && previousResult),
      current: summary.current,
      previous: summary.previous,
      scores: summary.scores,
      comparison: summary.comparison,
      // Convenience top-level care-plan views — same data as current/previous
      // above, mirroring routes/recommendations.js's overallCarePlan shape.
      currentCarePlan: summary.current ? {
        consultationLevel: summary.current.consultationLevel,
        monitoringLevel: summary.current.monitoringLevel,
      } : null,
      previousCarePlan: summary.previous ? {
        consultationLevel: summary.previous.consultationLevel,
        monitoringLevel: summary.previous.monitoringLevel,
      } : null,
    });
  } catch (err) {
    console.error('assessments compare error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Exposed for tests only (see tests/unit/reviewed-assessment-export.test.js).
// Attaching to the router function is inert for Express — app.use() only
// ever calls it as a request handler, so this does not affect routing.
router.__testables = { ML_LABEL_VALUES, getMlLabelValidationError, reviewAssessmentMlLabel };
