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
    domain: doc.domain || 'Other',
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
    createdAt: doc.createdAt || null,
    questionId: q.id,
    questionText: q.questionText,
    questionType: q.questionType,
    options: Array.isArray(q.options) ? q.options : [],
    domain: q.domain || 'Other',
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

    const VALID_TYPES = ['yes_no', 'multiple_choice', 'short_answer'];
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
        errors.push({ index, error: `Question ${index}: Invalid type. Must be: ${VALID_TYPES.join(', ')}` });
        continue;
      }

      const cleanOptions = Array.isArray(q.options)
        ? q.options.map((o) => String(o).trim()).filter(Boolean)
        : [];

      if (q.questionType === 'multiple_choice' && cleanOptions.length < 2) {
        errors.push({ index, error: `Question ${index}: Multiple choice requires at least 2 options.` });
        continue;
      }

      try {
        const doc = await PediaCustomQuestion.create({
          pediatricianId: req.user.userId,
          questionSetId: questionSet._id,
          questionText: String(q.questionText).trim(),
          questionType: q.questionType,
          options: q.questionType === 'multiple_choice' ? cleanOptions : [],
          domain: q.domain || 'Other',
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

    const VALID_TYPES = ['yes_no', 'multiple_choice', 'short_answer'];
    if (!VALID_TYPES.includes(questionType)) {
      return res.status(400).json({ error: `Type must be: ${VALID_TYPES.join(', ')}` });
    }

    const cleanOptions = Array.isArray(options)
      ? options.map((o) => String(o).trim()).filter(Boolean)
      : [];

    if (questionType === 'multiple_choice' && cleanOptions.length < 2) {
      return res.status(400).json({ error: 'Multiple choice questions require at least 2 options.' });
    }

    const doc = await PediaCustomQuestion.create({
      pediatricianId: req.user.userId,
      questionText: String(questionText).trim(),
      questionType,
      options: questionType === 'multiple_choice' ? cleanOptions : [],
      domain: domain || 'Other',
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

    // If question is part of an assigned set, prevent editing (except isActive flag)
    if (doc.questionSetId) {
      const set = await QuestionSet.findById(doc.questionSetId).lean();
      if (set && set.status === 'assigned') {
        const { isActive } = req.body;
        // Only allow changing isActive for assigned questions
        if (Object.keys(req.body).length > 1 || isActive === undefined) {
          return res.status(403).json({ error: 'Cannot edit questions in assigned sets. Create a new version if changes are needed.' });
        }
      }
    }

    const { questionText, questionType, options, domain, ageMin, ageMax, isActive } = req.body;

    if (questionText !== undefined) doc.questionText = String(questionText).trim();
    if (questionType !== undefined) doc.questionType = questionType;
    if (options !== undefined) {
      doc.options = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean) : [];
    }
    if (domain !== undefined) doc.domain = domain || 'Other';
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

    // If question is part of an assigned set, prevent deletion
    if (doc.questionSetId) {
      const set = await QuestionSet.findById(doc.questionSetId).lean();
      if (set && set.status === 'assigned') {
        return res.status(403).json({ error: 'Cannot delete questions from assigned sets. Create a new version if changes are needed.' });
      }
    }

    await PediaCustomQuestionAssignment.deleteMany({ questionId: doc._id });
    await doc.deleteOne();

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

    const question = await PediaCustomQuestion.findOne({ id: Number(req.params.id), pediatricianId: req.user.userId });
    if (!question) {
      return res.status(404).json({ error: 'Question not found.' });
    }

    const child = await Child.findById(childId).lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found.' });
    }

    const relationship = await ensurePediaChildRelationship(req.user.userId, child._id, appointmentId || null);
    if (!relationship) {
      return res.status(403).json({ error: 'You can only assign questions to your own patients.' });
    }

    const existing = await PediaCustomQuestionAssignment.findOne({
      questionId: question._id,
      childId: child._id,
      appointmentId: appointmentId || null,
    }).lean();

    if (existing) {
      return res.json({ success: true, message: 'Already assigned.' });
    }

    const assignment = await PediaCustomQuestionAssignment.create({
      questionId: question._id,
      questionSetId: question.questionSetId || null,
      appointmentId: appointmentId || null,
      childId: child._id,
      parentId: child.parentId,
    });

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

    const relationship = await ensurePediaChildRelationship(req.user.userId, child._id, appointmentId || null);
    if (!relationship) {
      return res.status(403).json({ error: 'You can only assign questions to your own patients.' });
    }

    // Check which questions are already assigned to avoid duplicates
    const existingAssignments = await PediaCustomQuestionAssignment.find({
      questionId: { $in: questions.map(q => q._id) },
      childId: child._id,
      appointmentId: appointmentId || null,
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
        appointmentId: appointmentId || null,
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

    const assignments = await PediaCustomQuestionAssignment.find({ childId: child._id })
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
