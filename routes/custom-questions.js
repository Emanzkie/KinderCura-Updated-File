// Custom questions routes (MongoDB version)
// Purpose:
// - lets pediatricians create, edit, delete, and assign their own assessment questions
// - stores question records in MongoDB instead of SQL Server
// - sends a parent notification when a question is assigned
// - sends the pediatrician a notification when the parent answers
// Note: This file does NOT open the database connection by itself.
// The MongoDB connection string is still read from db.js using process.env.MONGODB_URI.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { authMiddleware } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianPermission');
const PediaCustomQuestion = require('../models/PediaCustomQuestion');
const PediaCustomQuestionAssignment = require('../models/PediaCustomQuestionAssignment');
const QuestionSet = require('../models/QuestionSet');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const { DATA_ORIGIN } = require('../constants/dataOrigin');
const { ASSESSMENT_DOMAINS, normalizeDomain, isValidNewDomain } = require('../constants/assessmentDomains');

// Custom questions feed assessment scoring, which only understands a yes/no
// scale (multiple choice is recorded but not scored). Free-text 'short_answer'
// was retired: it cannot be created or re-saved through the API. Historical
// short_answer records stay readable — the model enum still lists the value —
// but every create/update path below rejects it with a clear error.
const SUPPORTED_QUESTION_TYPES = ['yes_no', 'multiple_choice'];

// --- Safe notification helpers ------------------------------------------------
// These helpers mirror the safer notification pattern used in appointments/chat.
// If the Notification model export shape changes, we still keep the system working.
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
    console.warn('Notification counter fallback error:', err.message);
  }

  // Last-resort fallback so the route still works even if counters are not ready.
  return Date.now();
}

async function pushNotification({ userId, title, message, type = 'assessment', relatedPage = null, relatedId = null }) {
  if (!userId) return;

  const notificationModel = resolveNotificationModel();
  const payload = {
    userId: new mongoose.Types.ObjectId(String(userId)),
    title,
    message,
    type,
    relatedPage,
    relatedId,
    isRead: false,
  };

  try {
    if (notificationModel) {
      await notificationModel.create(payload);
      return;
    }
  } catch (err) {
    console.warn('Custom questions notification model create failed, using collection fallback:', err.message);
  }

  try {
    const notifications = mongoose.connection.collection('notifications');
    await notifications.insertOne({
      ...payload,
      id: await nextNotificationId(),
      createdAt: new Date(),
    });
  } catch (err) {
    console.warn('Custom questions notification insert fallback failed:', err.message);
  }
}

// Formats the MongoDB document into the frontend shape used by pedia-questions.html
function normalizeQuestion(doc) {
  return {
    id: doc.id,
    questionSetId: doc.questionSetId?._id || null,
    questionText: doc.questionText,
    questionType: doc.questionType,
    options: Array.isArray(doc.options) ? doc.options : [],
    // Defensive normalize, not just a fallback: guarantees the API never
    // hands the frontend a legacy domain string even for a document that
    // hasn't been touched by the model's pre('validate') hook or the
    // one-off migration script yet.
    domain: normalizeDomain(doc.domain),
    ageMin: doc.ageMin ?? 0,
    ageMax: doc.ageMax ?? 18,
    isActive: Boolean(doc.isActive),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function normalizeQuestionSet(doc, questions = []) {
  return {
    id: doc.id,
    setId: doc._id.toString(),
    title: doc.title || 'Question Set',
    description: doc.description || '',
    questionCount: doc.questionCount || (questions.length || 0),
    status: doc.status || 'draft', // 'draft' or 'assigned'
    isActive: Boolean(doc.isActive),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    questions: questions.map(normalizeQuestion),
  };
}

function normalizeAssignment(doc) {
  const q = doc.questionId || {};
  const ped = q.pediatricianId || {};
  const qs = doc.questionSetId || {};
  return {
    assignmentId: doc.id,
    questionSetId: qs._id ? qs._id.toString() : (doc.questionSetId ? doc.questionSetId.toString() : null),
    setTitle: qs.title || null,
    appointmentId: doc.appointmentId || null,
    answer: doc.answer || null,
    answeredAt: doc.answeredAt || null,
    // Which reassessment claimed this answer, if any. null when the answer
    // (if present) was given standalone through this page instead.
    assessmentId: doc.assessmentId ? doc.assessmentId.toString() : null,
    createdAt: doc.createdAt || null,
    questionId: q.id,
    questionText: q.questionText,
    questionType: q.questionType,
    options: Array.isArray(q.options) ? q.options : [],
    domain: normalizeDomain(q.domain),
    ageMin: q.ageMin ?? 0,
    ageMax: q.ageMax ?? 18,
    pediatricianName: ped.firstName ? `${ped.firstName} ${ped.lastName || ''}`.trim() : 'Pediatrician',
  };
}

function hasMeaningfulAnswer(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

// Safety check: pediatricians can only assign questions to children linked to them by appointment
async function ensurePediaChildRelationship(pediatricianObjectId, childObjectId, appointmentId = null) {
  const filter = {
    pediatricianId: pediatricianObjectId,
    childId: childObjectId,
    status: { $in: ['approved', 'completed', 'pending'] },
  };
  if (appointmentId != null) filter.id = appointmentId;
  return Appointment.findOne(filter).lean();
}

// appointmentId arrives in the request body and is used inside query filters,
// so anything but a positive whole number (an object such as { $ne: null }
// included) is refused instead of being handed to MongoDB.
function parseAppointmentId(raw) {
  if (raw == null || raw === '') return { value: null };
  const n = Number(raw);
  if (typeof raw === 'object' || !Number.isInteger(n) || n <= 0) {
    return { error: 'appointmentId must be a positive whole number.' };
  }
  return { value: n };
}

// Once a question has reached a parent its wording is frozen, so the answers
// stay answers to the question that was asked. A question in a set is locked
// when the set is assigned or answered (it used to be only 'assigned', so the
// questions of an answered set could be edited); a standalone question is
// locked as soon as it has any assignment. Only the active flag may change.
async function isQuestionEditLocked(doc) {
  if (doc.questionSetId) {
    const set = await QuestionSet.findById(doc.questionSetId).lean();
    return Boolean(set) && set.status !== 'draft';
  }
  return Boolean(await PediaCustomQuestionAssignment.exists({ questionId: doc._id }));
}

// Deleting removes the question's assignments, which would take a parent's
// answers with it, so a question a parent has answered is never deletable,
// and neither is one in an assigned or answered set. An unanswered standalone
// question can still be deleted along with its assignments.
async function isQuestionDeleteLocked(doc) {
  if (doc.questionSetId) {
    const set = await QuestionSet.findById(doc.questionSetId).lean();
    if (set && set.status !== 'draft') return true;
  }
  return Boolean(await PediaCustomQuestionAssignment.exists({ questionId: doc._id, answeredAt: { $ne: null } }));
}

// GET /api/questions
// Load all custom questions created by the logged-in pediatrician, grouped by QuestionSet
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }
    // Get all question sets for this pediatrician
    const questionSets = await QuestionSet.find({ pediatricianId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();

    // Get all questions (including those not in a set)
    const questions = await PediaCustomQuestion.find({ pediatricianId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();

    // Group questions by their questionSetId
    const questionsBySet = {};
    const standaloneQuestions = [];

    questions.forEach(q => {
      const normalized = normalizeQuestion(q);
      if (q.questionSetId) {
        const setId = q.questionSetId.toString();
        if (!questionsBySet[setId]) {
          questionsBySet[setId] = [];
        }
        questionsBySet[setId].push(normalized);
      } else {
        standaloneQuestions.push(normalized);
      }
    });

    // Build response with sets containing their questions
    const result = questionSets.map(set => {
      const setQuestions = questionsBySet[set._id.toString()] || [];
      return normalizeQuestionSet(set, setQuestions);
    });

    // Add standalone questions as individual items (for backward compatibility)
    const response = {
      success: true,
      questionSets: result,
      questions: standaloneQuestions, // Legacy field for standalone questions
      totalSets: result.length,
      totalStandaloneQuestions: standaloneQuestions.length,
    };

    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/questions/bulk
// Create multiple custom questions in one session as a QuestionSet (batch)
router.post('/bulk', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const { questions, setTitle, setDescription } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Questions array is required and must not be empty.' });
    }

    if (questions.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 questions per batch.' });
    }

    const VALID_TYPES = SUPPORTED_QUESTION_TYPES;
    const createdQuestions = [];
    const errors = [];

    // First, create the QuestionSet to group these questions
    const questionSet = await QuestionSet.create({
      pediatricianId: req.user.userId,
      title: setTitle || `Question Set - ${new Date().toLocaleDateString()}`,
      description: setDescription || '',
      questionCount: questions.length,
      isActive: true,
    });

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const index = i + 1;

      if (!q.questionText || !q.questionType) {
        errors.push({ index, error: `Question ${index}: Text and type are required.` });
        continue;
      }

      if (!VALID_TYPES.includes(q.questionType)) {
        errors.push({
          index,
          error: q.questionType === 'short_answer'
            ? `Question ${index}: Short Answer is no longer supported. Use Yes / No or Multiple Choice.`
            : `Question ${index}: Invalid type. Must be: ${VALID_TYPES.join(', ')}`,
        });
        continue;
      }

      const cleanOptions = Array.isArray(q.options)
        ? q.options.map((o) => String(o).trim()).filter(Boolean)
        : [];

      if (q.questionType === 'multiple_choice' && cleanOptions.length < 2) {
        errors.push({ index, error: `Question ${index}: Multiple choice requires at least 2 options.` });
        continue;
      }

      if (q.domain !== undefined && !isValidNewDomain(q.domain)) {
        errors.push({ index, error: `Question ${index}: Domain must be one of: ${ASSESSMENT_DOMAINS.join(', ')}.` });
        continue;
      }

      try {
        const doc = await PediaCustomQuestion.create({
          pediatricianId: req.user.userId,
          questionSetId: questionSet._id,
          questionText: String(q.questionText).trim(),
          questionType: q.questionType,
          options: q.questionType === 'multiple_choice' ? cleanOptions : [],
          domain: q.domain || undefined,
          ageMin: q.ageMin != null ? Number(q.ageMin) : 0,
          ageMax: q.ageMax != null ? Number(q.ageMax) : 18,
          isActive: true,
          // Set on the server, never read from req.body. Reaching this route
          // means an authenticated pediatrician created the question.
          origin: DATA_ORIGIN.PEDIA_ENTRY,
        });
        createdQuestions.push(normalizeQuestion(doc.toObject()));
      } catch (err) {
        errors.push({ index, error: `Question ${index}: ${err.message}` });
      }
    }

    // Update the question set with actual count of successfully created questions
    if (createdQuestions.length > 0) {
      questionSet.questionCount = createdQuestions.length;
      await questionSet.save();
    }

    if (createdQuestions.length === 0 && errors.length > 0) {
      // Delete the empty question set
      await QuestionSet.deleteOne({ _id: questionSet._id });
      return res.status(400).json({
        error: 'No questions were created.',
        details: errors
      });
    }

    res.status(201).json({
      success: true,
      questionSet: normalizeQuestionSet(questionSet.toObject(), createdQuestions),
      questions: createdQuestions,
      createdCount: createdQuestions.length,
      errorCount: errors.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/questions
// Create one new custom question (legacy single-question endpoint)
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const { questionText, questionType, options, domain, ageMin, ageMax } = req.body;

    if (!questionText || !questionType) {
      return res.status(400).json({ error: 'Question text and type are required.' });
    }

    const VALID_TYPES = SUPPORTED_QUESTION_TYPES;
    if (!VALID_TYPES.includes(questionType)) {
      return res.status(400).json({
        error: questionType === 'short_answer'
          ? 'Short Answer questions are no longer supported. Use Yes / No or Multiple Choice.'
          : `Type must be: ${VALID_TYPES.join(', ')}`,
      });
    }

    const cleanOptions = Array.isArray(options)
      ? options.map((o) => String(o).trim()).filter(Boolean)
      : [];

    if (questionType === 'multiple_choice' && cleanOptions.length < 2) {
      return res.status(400).json({ error: 'Multiple choice questions require at least 2 options.' });
    }

    if (domain !== undefined && !isValidNewDomain(domain)) {
      return res.status(400).json({ error: `Domain must be one of: ${ASSESSMENT_DOMAINS.join(', ')}.` });
    }

    const doc = await PediaCustomQuestion.create({
      pediatricianId: req.user.userId,
      questionText: String(questionText).trim(),
      questionType,
      options: questionType === 'multiple_choice' ? cleanOptions : [],
      domain: domain || undefined,
      ageMin: ageMin != null ? Number(ageMin) : 0,
      ageMax: ageMax != null ? Number(ageMax) : 18,
      isActive: true,
      // Set on the server, never read from req.body. Reaching this route
      // means an authenticated pediatrician created the question.
      origin: DATA_ORIGIN.PEDIA_ENTRY,
    });

    res.status(201).json({ success: true, question: normalizeQuestion(doc.toObject()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/questions/:id
// Edit an existing custom question
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const doc = await PediaCustomQuestion.findOne({ id: Number(req.params.id), pediatricianId: req.user.userId });
    if (!doc) {
      return res.status(404).json({ error: 'Question not found.' });
    }

    // Once a parent has the question (assigned or answered set, or any
    // assignment of a standalone question), only the active flag may change.
    if (await isQuestionEditLocked(doc)) {
      const { isActive } = req.body;
      if (Object.keys(req.body).length > 1 || isActive === undefined) {
        return res.status(403).json({ error: 'Cannot edit a question that has been assigned. Create a new version if changes are needed.' });
      }
    }

    const { questionText, questionType, options, domain, ageMin, ageMax, isActive } = req.body;

    if (questionType !== undefined && !SUPPORTED_QUESTION_TYPES.includes(questionType)) {
      return res.status(400).json({
        error: questionType === 'short_answer'
          ? 'Short Answer questions are no longer supported. Set this question to Yes / No or Multiple Choice.'
          : `Type must be: ${SUPPORTED_QUESTION_TYPES.join(', ')}`,
      });
    }

    // A legacy 'short_answer' record stays readable, but it cannot be saved
    // again as short_answer. An edit must move it onto a supported type; the
    // only exception is an isActive-only toggle, so a pediatrician can still
    // deactivate an old short_answer question without rewriting it.
    const isActiveOnlyToggle = Object.keys(req.body).length === 1 && isActive !== undefined;
    if (doc.questionType === 'short_answer' && questionType === undefined && !isActiveOnlyToggle) {
      return res.status(400).json({
        error: 'This is a legacy Short Answer question, which is no longer supported. '
          + 'Set its type to Yes / No or Multiple Choice to save changes.',
      });
    }

    if (questionText !== undefined) doc.questionText = String(questionText).trim();
    if (questionType !== undefined) doc.questionType = questionType;
    if (options !== undefined) {
      doc.options = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : [];
    }
    if (domain !== undefined) {
      if (!isValidNewDomain(domain)) {
        return res.status(400).json({ error: `Domain must be one of: ${ASSESSMENT_DOMAINS.join(', ')}.` });
      }
      doc.domain = domain;
    }
    if (ageMin !== undefined) doc.ageMin = Number(ageMin);
    if (ageMax !== undefined) doc.ageMax = Number(ageMax);
    if (isActive !== undefined) doc.isActive = Boolean(isActive);

    if (doc.questionType === 'multiple_choice' && doc.options.length < 2) {
      return res.status(400).json({ error: 'Multiple choice questions require at least 2 options.' });
    }

    await doc.save();
    res.json({ success: true, question: normalizeQuestion(doc.toObject()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/questions/:id
// Delete a custom question and its assignments
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const doc = await PediaCustomQuestion.findOne({ id: Number(req.params.id), pediatricianId: req.user.userId });
    if (!doc) {
      return res.status(404).json({ error: 'Question not found.' });
    }

    // Not from an assigned or answered set, and never a question a parent has
    // answered: deleting would remove their answers with the assignments.
    if (await isQuestionDeleteLocked(doc)) {
      return res.status(403).json({ error: 'Cannot delete a question from an assigned set or one a parent has already answered. Create a new version if changes are needed.' });
    }

    await PediaCustomQuestionAssignment.deleteMany({ questionId: doc._id });
    await doc.deleteOne();

    // Keep the set's stored count in step with the questions it still has.
    if (doc.questionSetId) {
      const remaining = await PediaCustomQuestion.countDocuments({ questionSetId: doc.questionSetId });
      await QuestionSet.updateOne({ _id: doc.questionSetId }, { $set: { questionCount: remaining } });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/questions/:id/assign
// Assign one question to one child (optionally tied to an appointment)
router.post('/:id/assign', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const { childId, appointmentId } = req.body;
    if (!childId) {
      return res.status(400).json({ error: 'childId is required.' });
    }
    const parsedAppointment = parseAppointmentId(appointmentId);
    if (parsedAppointment.error) {
      return res.status(400).json({ error: parsedAppointment.error });
    }
    const apptId = parsedAppointment.value;

    const question = await PediaCustomQuestion.findOne({ id: Number(req.params.id), pediatricianId: req.user.userId });
    if (!question) {
      return res.status(404).json({ error: 'Question not found.' });
    }
    // Same rule as assigning a whole set, which only picks active questions.
    if (!question.isActive) {
      return res.status(400).json({ error: 'This question is inactive. Activate it before assigning it.' });
    }

    const child = await Child.findById(childId).lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found.' });
    }

    const relationship = await ensurePediaChildRelationship(req.user.userId, child._id, apptId);
    if (!relationship) {
      return res.status(403).json({ error: 'You can only assign questions to your own patients.' });
    }

    const existing = await PediaCustomQuestionAssignment.findOne({
      questionId: question._id,
      childId: child._id,
      appointmentId: apptId,
    }).lean();

    if (existing) {
      return res.json({ success: true, message: 'Already assigned.' });
    }

    const assignment = await PediaCustomQuestionAssignment.create({
      questionId: question._id,
      questionSetId: question.questionSetId || null,
      appointmentId: apptId,
      childId: child._id,
      parentId: child.parentId,
    });

    // As when a whole set is assigned, the set is now frozen: its questions
    // must not change after a parent has one of them.
    if (question.questionSetId) {
      await QuestionSet.updateOne({ _id: question.questionSetId, status: 'draft' }, { $set: { status: 'assigned' } });
    }

    const ped = await User.findById(req.user.userId).select('firstName lastName').lean();

    // Create an in-app notification so the parent knows there is a new question.
    await pushNotification({
      userId: child.parentId,
      title: '📋 New Assessment Question',
      message: `Dr. ${ped?.firstName || ''} ${ped?.lastName || ''} assigned a new custom question for ${child.firstName}.`.trim(),
      type: 'assessment',
      relatedPage: '/parent/custom-questions.html',
    });

    res.json({ success: true, assignmentId: assignment.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// POST /api/questions/set/:setId/assign
// Assign an entire QuestionSet (batch) to one child - all questions in the set are assigned at once
router.post('/set/:setId/assign', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const { childId, appointmentId } = req.body;
    if (!childId) {
      return res.status(400).json({ error: 'childId is required.' });
    }
    const parsedAppointment = parseAppointmentId(appointmentId);
    if (parsedAppointment.error) {
      return res.status(400).json({ error: parsedAppointment.error });
    }
    const apptId = parsedAppointment.value;

    const questionSet = await QuestionSet.findOne({ _id: req.params.setId, pediatricianId: req.user.userId });
    if (!questionSet) {
      return res.status(404).json({ error: 'Question Set not found.' });
    }

    const questions = await PediaCustomQuestion.find({ questionSetId: questionSet._id, isActive: true }).lean();
    if (questions.length === 0) {
      return res.status(400).json({ error: 'No active questions in this set.' });
    }

    const child = await Child.findById(childId).lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found.' });
    }

    const relationship = await ensurePediaChildRelationship(req.user.userId, child._id, apptId);
    if (!relationship) {
      return res.status(403).json({ error: 'You can only assign questions to your own patients.' });
    }

    // Check which questions are already assigned to avoid duplicates
    const existingAssignments = await PediaCustomQuestionAssignment.find({
      questionId: { $in: questions.map(q => q._id) },
      childId: child._id,
      appointmentId: apptId,
    }).lean();

    const existingQuestionIds = new Set(existingAssignments.map(a => a.questionId.toString()));
    const questionsToAssign = questions.filter(q => !existingQuestionIds.has(q._id.toString()));

    if (questionsToAssign.length === 0) {
      return res.json({ success: true, message: 'All questions in this set are already assigned.' });
    }

    // Create assignments for all questions in the set
    const assignments = await PediaCustomQuestionAssignment.insertMany(
      questionsToAssign.map(q => ({
        questionId: q._id,
        questionSetId: questionSet._id,
        appointmentId: apptId,
        childId: child._id,
        parentId: child.parentId,
      }))
    );

    // Mark the question set as 'assigned' so it can no longer be edited
    questionSet.status = 'assigned';
    await questionSet.save();

    const ped = await User.findById(req.user.userId).select('firstName lastName').lean();

    // Send one notification for the entire set
    await pushNotification({
      userId: child.parentId,
      title: `📋 New Assessment Questions (${questionsToAssign.length})`,
      message: `Dr. ${ped?.firstName || ''} ${ped?.lastName || ''} assigned "${questionSet.title}" (${questionsToAssign.length} question${questionsToAssign.length > 1 ? 's' : ''}) for ${child.firstName}.`.trim(),
      type: 'assessment',
      relatedPage: '/parent/custom-questions.html',
      relatedId: String(questionSet._id), // Store the questionSetId for notification handler
    });

    res.json({
      success: true,
      assignedCount: assignments.length,
      message: `${assignments.length} question(s) assigned successfully.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/questions/assigned/:childId
// Parents, pediatricians, and linked guardians with view_assessments permission may access
router.get('/assigned/:childId', authMiddleware, hasPermission('view_assessments'), async (req, res) => {
  try {
    const child = await Child.findById(req.params.childId).lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found.' });
    }

    // Secondary parents who are linked via GuardianLink should also have access
    if (req.user.role === 'parent' && String(child.parentId) !== String(req.user.userId)) {
      const link = await GuardianLink.findOne({ childId: child._id, guardianId: req.user.userId, status: 'active' }).lean();
      if (!link) return res.status(403).json({ error: 'Access denied.' });
    }

    if (req.user.role === 'pediatrician') {
      const rel = await ensurePediaChildRelationship(req.user.userId, child._id);
      if (!rel) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    // A pediatrician only sees the questions they assigned (and the parent's
    // answers to them), never another pediatrician's for the same child.
    const filter = { childId: child._id };
    if (req.user.role === 'pediatrician') {
      const ownQuestions = await PediaCustomQuestion.find({ pediatricianId: req.user.userId }).select('_id').lean();
      filter.questionId = { $in: ownQuestions.map((q) => q._id) };
    }

    const assignments = await PediaCustomQuestionAssignment.find(filter)
      .populate({
        path: 'questionId',
        populate: { path: 'pediatricianId', select: 'firstName lastName' },
      })
      .populate('questionSetId')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, assignments: assignments.map(normalizeAssignment) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/questions/answer/:assignmentId
router.post('/answer/:assignmentId', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'parent') {
      return res.status(403).json({ error: 'Parents only.' });
    }

    const { answer } = req.body;
    if (!answer) {
      return res.status(400).json({ error: 'Answer required.' });
    }

    const assignment = await PediaCustomQuestionAssignment.findOne({ id: Number(req.params.assignmentId), parentId: req.user.userId })
      .populate({ path: 'questionId', populate: { path: 'pediatricianId', select: 'firstName lastName _id' } });

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    // Already folded into a reassessment (routes/assessments.js POST /submit) —
    // that endpoint already scored and permanently stored this answer under an
    // AssessmentResult. Overwriting it here would desync the assignment record
    // from history without ever being able to re-score that closed result, so
    // it is refused rather than silently accepted (adviser rule K).
    if (assignment.assessmentId) {
      return res.status(409).json({
        error: 'This question was already answered as part of a reassessment and cannot be changed here.',
      });
    }

    assignment.answer = String(answer);
    assignment.answeredAt = new Date();
    await assignment.save();

    // Notify the pediatrician right away once the parent submits the answer.
    const pedId = assignment.questionId?.pediatricianId?._id;
    if (pedId) {
      const child = await Child.findById(assignment.childId).select('firstName lastName').lean();
      const childName = child ? `${child.firstName || ''} ${child.lastName || ''}`.trim() : 'a child';
      const questionText = String(assignment.questionId?.questionText || 'your custom question').trim();
      const shortAnswer = String(answer).trim().slice(0, 80);

      await pushNotification({
        userId: pedId,
        title: '📝 Custom Question Answered',
        message: `${childName}'s parent answered: "${questionText}" — Answer: ${shortAnswer}`,
        type: 'assessment',
        relatedPage: '/pedia/pedia-questions.html',
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/questions/set/:setId/answer-batch
// Submit all answers for a question set at once (grouped submission)
router.post('/set/:setId/answer-batch', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'parent') {
      return res.status(403).json({ error: 'Parents only.' });
    }

    const rawAnswers = Array.isArray(req.body.answers) ? req.body.answers : [];
    if (rawAnswers.length === 0) {
      return res.status(400).json({ error: 'Answers array is required and must not be empty.' });
    }

    const normalizedAnswers = [];
    const seenAssignmentIds = new Set();

    for (const item of rawAnswers) {
      const assignmentId = Number(item?.assignmentId);
      const answer = String(item?.answer ?? '').trim();

      if (!Number.isFinite(assignmentId)) {
        return res.status(400).json({ error: 'Each answer must include a valid assignmentId.' });
      }
      if (!answer) {
        return res.status(400).json({ error: 'Please answer every question in the set before submitting.' });
      }
      if (seenAssignmentIds.has(assignmentId)) {
        return res.status(400).json({ error: 'Duplicate assignment IDs were submitted.' });
      }

      seenAssignmentIds.add(assignmentId);
      normalizedAnswers.push({ assignmentId, answer });
    }

    const questionSet = await QuestionSet.findById(req.params.setId).lean();
    if (!questionSet) {
      return res.status(404).json({ error: 'Question Set not found.' });
    }

    const submittedAssignments = await PediaCustomQuestionAssignment.find({
      id: { $in: normalizedAnswers.map(item => item.assignmentId) },
      questionSetId: questionSet._id,
      parentId: req.user.userId
    })
      .populate({ path: 'questionId', populate: { path: 'pediatricianId', select: 'firstName lastName _id' } })
      .populate('childId', 'firstName lastName');

    if (submittedAssignments.length !== normalizedAnswers.length) {
      return res.status(404).json({ error: 'One or more answers do not belong to this question set.' });
    }

    // Same guard as the single-answer endpoint above: a question already
    // folded into a reassessment is closed to further edits here.
    if (submittedAssignments.some(a => a.assessmentId)) {
      return res.status(409).json({
        error: 'One or more of these questions were already answered as part of a reassessment and cannot be changed here.',
      });
    }

    const childIds = new Set(submittedAssignments.map(a => String(a.childId?._id || a.childId)));
    if (childIds.size !== 1) {
      return res.status(400).json({ error: 'All answers must be for the same child.' });
    }

    const appointmentIds = new Set(submittedAssignments.map(a => String(a.appointmentId ?? 'no-appointment')));
    if (appointmentIds.size !== 1) {
      return res.status(400).json({ error: 'All answers must be for the same question-set assignment.' });
    }

    const childId = submittedAssignments[0].childId?._id || submittedAssignments[0].childId;
    const appointmentId = submittedAssignments[0].appointmentId ?? null;

    const allAssignmentsInGroup = await PediaCustomQuestionAssignment.find({
      questionSetId: questionSet._id,
      parentId: req.user.userId,
      childId,
      appointmentId
    })
      .populate({ path: 'questionId', populate: { path: 'pediatricianId', select: 'firstName lastName _id' } })
      .populate('childId', 'firstName lastName')
      .sort({ id: 1 });

    const expectedAssignmentIds = allAssignmentsInGroup.map(a => a.id);
    const expectedIdSet = new Set(expectedAssignmentIds);
    const isCompleteBatch = expectedAssignmentIds.length === normalizedAnswers.length
      && normalizedAnswers.every(item => expectedIdSet.has(item.assignmentId));

    if (!isCompleteBatch) {
      return res.status(400).json({
        error: `Please answer all ${expectedAssignmentIds.length} questions in this set before submitting.`
      });
    }

    const answersByAssignmentId = new Map(
      normalizedAnswers.map(item => [item.assignmentId, item.answer])
    );

    const submittedAt = new Date();
    await Promise.all(
      allAssignmentsInGroup.map((assignment) => {
        assignment.answer = answersByAssignmentId.get(assignment.id);
        assignment.answeredAt = submittedAt;
        return assignment.save();
      })
    );

    const hasUnansweredAssignments = await PediaCustomQuestionAssignment.exists({
      questionSetId: questionSet._id,
      $or: [
        { answer: null },
        { answer: '' },
        { answer: { $exists: false } }
      ]
    });

    await QuestionSet.updateOne(
      { _id: questionSet._id },
      hasUnansweredAssignments
        ? { $set: { status: 'assigned' } }
        : { $set: { status: 'answered' } }
    );

    const pedId = allAssignmentsInGroup[0]?.questionId?.pediatricianId?._id;
    const child = allAssignmentsInGroup[0]?.childId;
    if (pedId && child) {
      const childName = `${child.firstName || ''} ${child.lastName || ''}`.trim() || 'a child';
      const setTitle = questionSet.title || 'Question Set';
      const answerCount = allAssignmentsInGroup.length;

      await pushNotification({
        userId: pedId,
        title: `📝 Question Set Answered (${answerCount} questions)`,
        message: `${childName}'s parent answered all ${answerCount} questions in "${setTitle}".`,
        type: 'assessment',
        relatedPage: '/pedia/pedia-questions.html',
        relatedId: String(questionSet._id), // Store the questionSetId for notification handler
      });
    }

    res.json({
      success: true,
      answeredCount: allAssignmentsInGroup.length,
      message: `All ${allAssignmentsInGroup.length} answer${allAssignmentsInGroup.length !== 1 ? 's' : ''} submitted successfully for this set.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
