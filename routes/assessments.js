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
const { DATA_ORIGIN } = require('../constants/dataOrigin');
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

function scoreAnswer(answer) {
  if (answer === 'yes') return 2;
  if (answer === 'sometimes') return 1;
  return 0;
}

const THRESHOLD_RANGES = {
  'delayed': { min: 0, max: 25 },
  'at-risk': { min: 26, max: 50 },
  'on-track': { min: 51, max: 100 }
};

function getStatus(score) {
  if (score >= 51) return 'on-track';
  if (score >= 26) return 'at-risk';
  return 'delayed';
}

function getScoreThreshold(score) {
  if (score >= 51) return 'on-track';
  if (score >= 26) return 'at-risk';
  return 'delayed';
}

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

    res.json({
      success: true,
      assessmentId: String(assessment._id),
      ageGroup: ageInfo.group,
      ageLabel: ageInfo.label,
      childAge: ageInfo.age,
      totalQuestions: 20,
      questions: [], // frontend already has the question list hardcoded
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
    let { assessmentId, childId, answers } = req.body;
    const answersArray = normalizeAnswers(answers);

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

    const storedAnswers = await AssessmentAnswer.find({ assessmentId }).lean();
    const totals = {
      Communication: { earned: 0, total: 0 },
      'Social Skills': { earned: 0, total: 0 },
      Cognitive: { earned: 0, total: 0 },
      'Motor Skills': { earned: 0, total: 0 },
    };

    for (const a of storedAnswers) {
      if (!totals[a.domain]) continue;
      totals[a.domain].total += 2;
      totals[a.domain].earned += scoreAnswer(a.answer);
    }

    const communicationScore = totals.Communication.total ? Math.round((totals.Communication.earned / totals.Communication.total) * 100) : 0;
    const socialScore        = totals['Social Skills'].total ? Math.round((totals['Social Skills'].earned / totals['Social Skills'].total) * 100) : 0;
    const cognitiveScore     = totals.Cognitive.total ? Math.round((totals.Cognitive.earned / totals.Cognitive.total) * 100) : 0;
    const motorScore         = totals['Motor Skills'].total ? Math.round((totals['Motor Skills'].earned / totals['Motor Skills'].total) * 100) : 0;
    const overallScore       = Math.round((communicationScore + socialScore + cognitiveScore + motorScore) / 4);

    const riskFlags = [];
    if (communicationScore < 40) riskFlags.push('Communication delay detected');
    if (socialScore < 40) riskFlags.push('Social skills concern detected');
    if (cognitiveScore < 40) riskFlags.push('Cognitive development concern');
    if (motorScore < 40) riskFlags.push('Motor skills delay detected');

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

    res.json({ success: true, resultId: String(result._id), assessmentId: String(assessmentId), analysisStatus: 'complete' });
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

    const { diagnosis, recommendations, nextAssessmentDate, nextAssessmentReason } = req.body;
    if (!diagnosis) return res.status(400).json({ error: 'Diagnosis is required.' });

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
    latest.diagnosis = diagnosis;
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
    });
  } catch (err) {
    console.error('assessments diagnose error:', err);
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

      // Determine answer-level AI insight based on scoring logic
      const score = scoreAnswer(a.answer);
      let insight = 'On Track';
      let insightLevel = 'positive';
      if (score === 1) {
        insight = 'Developing — may need monitoring';
        insightLevel = 'warning';
      } else if (score === 0) {
        insight = 'Concern — not yet demonstrated';
        insightLevel = 'concern';
      }

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
      const domainMap = {
        'Communication': { score: result.communicationScore, status: result.communicationStatus },
        'Social Skills': { score: result.socialScore, status: result.socialStatus },
        'Cognitive':     { score: result.cognitiveScore, status: result.cognitiveStatus },
        'Motor Skills':  { score: result.motorScore, status: result.motorStatus },
      };
      for (const [domain, data] of Object.entries(domainMap)) {
        domainSummaries[domain] = {
          score: data.score,
          status: data.status,
          riskLevel: data.score < 26 ? 'high' : data.score < 51 ? 'moderate' : 'low',
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
      overallRisk: result
        ? (result.overallScore < 26 ? 'High Risk' : result.overallScore < 51 ? 'Moderate Risk' : 'Low Risk')
        : null,
      riskFlags: result ? (result.riskFlags || []) : [],
      domainSummaries,
      answersByDomain: grouped,
    });
  } catch (err) {
    console.error('assessments review-answers error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
