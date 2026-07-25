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

const datasetStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureDatasetDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanBase = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    cb(null, `${Date.now()}_${cleanBase}${ext}`);
  },
});

const datasetUpload = multer({
  storage: datasetStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.json'].includes(ext)) return cb(null, true);
    cb(new Error('Only CSV and JSON datasets are allowed.'));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

function parseDatasetFile(fullPath, ext) {
  const raw = fs.readFileSync(fullPath, 'utf8');

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

function safeRemoveUpload(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/datasets/')) return;
  const fileName = publicPath.replace('/uploads/datasets/', '');
  const fullPath = path.join(__dirname, '..', 'public', 'uploads', 'datasets', fileName);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
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
    { $setOnInsert: { singleton: 'default', appointmentSlots: { enforceThirtyMinuteSlots: true, slotMinutes: 30 } } },
    { new: true, upsert: true }
  );
}

function formatAppointmentSlotSettings(doc) {
  return {
    enforceThirtyMinuteSlots: Boolean(doc?.appointmentSlots?.enforceThirtyMinuteSlots ?? true),
    slotMinutes: 30,
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

// GET /api/admin/training/datasets
// Loads dataset cards and the admin upload/training table.
router.get('/training/datasets', authMiddleware, adminOnly, async (req, res) => {
  try {
    const docs = await TrainingDataset.find().sort({ createdAt: -1 }).populate('uploadedBy', 'firstName lastName').populate('trainedBy', 'firstName lastName').lean();
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
      trainedAt: d.trainedAt,
    }));

    const summary = {
      total: datasets.length,
      uploaded: datasets.filter((d) => d.status === 'uploaded').length,
      trained: datasets.filter((d) => d.status === 'trained').length,
      failed: datasets.filter((d) => d.status === 'failed').length,
      totalRows: datasets.reduce((sum, d) => sum + (d.rowCount || 0), 0),
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
      const fullPath = path.join(ensureDatasetDir(), req.file.filename);
      const parsed = parseDatasetFile(fullPath, ext);

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

    // Resolve the file on disk
    const datasetPath = modelManager.resolveDatasetPath(dataset.filePath);
    if (!datasetPath) {
      return res.status(404).json({ error: `Dataset file not found on disk: ${dataset.filePath}` });
    }

    // Mark as training
    dataset.status = 'training';
    dataset.errorMessage = null;
    await dataset.save();

    // Determine next model version
    const lastModel = await TrainedModel.findOne().sort({ version: -1 }).lean();
    const nextVersion = (lastModel?.version || 0) + 1;

    // Create placeholder model doc
    const modelDoc = await TrainedModel.create({
      datasetId: dataset._id,
      version: nextVersion,
      modelPath: '',
      status: 'training',
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

    // Run training in the background (async, no await in request handler)
    modelManager.trainModel(datasetPath).then(async (metrics) => {
      // Deactivate previous active models
      await TrainedModel.updateMany({ isActive: true }, { $set: { isActive: false } });

      modelDoc.modelPath = metrics.model_path;
      modelDoc.accuracy = metrics.accuracy;
      modelDoc.precision = metrics.precision;
      modelDoc.recall = metrics.recall;
      modelDoc.f1Score = metrics.f1;
      modelDoc.featureImportances = metrics.feature_importances;
      modelDoc.perClassMetrics = metrics.per_class_metrics || {};
      modelDoc.classNames = metrics.class_names || [];
      modelDoc.featuresUsed = metrics.features_used || [];
      modelDoc.trainingSamples = metrics.training_samples;
      modelDoc.testSamples = metrics.test_samples;
      modelDoc.totalRows = metrics.total_rows || 0;
      modelDoc.rowsDropped = metrics.rows_dropped || 0;
      modelDoc.status = 'completed';
      modelDoc.isActive = true;
      await modelDoc.save();

      dataset.status = 'trained';
      dataset.trainedBy = req.user.userId;
      dataset.trainedAt = new Date();
      dataset.modelId = modelDoc._id;
      dataset.trainingMetrics = { accuracy: metrics.accuracy, precision: metrics.precision, recall: metrics.recall, f1: metrics.f1 };
      dataset.trainingSummary =
        `Model v${nextVersion}: ${(metrics.accuracy * 100).toFixed(1)}% accuracy. ` +
        `${metrics.training_samples} train / ${metrics.test_samples} test samples. ` +
        `Categories: ${(metrics.class_names || []).join(', ')}.`;
      await dataset.save();

      sse.broadcast('analytics:update', { type: 'ml', action: 'training_completed', datasetId: String(dataset._id), accuracy: metrics.accuracy });
    }).catch(async (trainErr) => {
      console.error('ML training failed:', trainErr.message);
      modelDoc.status = 'failed';
      modelDoc.errorMessage = trainErr.message;
      await modelDoc.save();

      dataset.status = 'failed';
      dataset.errorMessage = trainErr.message;
      dataset.trainingSummary = `Training failed: ${trainErr.message}`;
      await dataset.save();

      sse.broadcast('analytics:update', { type: 'ml', action: 'training_failed', datasetId: String(dataset._id), error: trainErr.message });
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
            slotMinutes: 30,
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
// Filtered analytics for a specific pediatrician
router.get('/analytics/pediatrician', authMiddleware, async (req, res) => {
  try {
    const pediaId = req.user.role === 'pediatrician' ? req.user.userId : req.query.pediatricianId;
    if (!pediaId) return res.status(400).json({ error: 'Pediatrician ID required' });

    const objectId = new mongoose.Types.ObjectId(pediaId);

    const [
      myAppointments,
      myAssessments,
      myChildrenCount,
    ] = await Promise.all([
      Appointment.find({ pediatricianId: objectId }).lean(),
      Assessment.find({ reviewedByPediatrician: objectId }).lean(),
      Child.find().lean(),
    ]);

    const myApptCount = myAppointments.length;
    const pendingAppts = myAppointments.filter(a => a.status === 'pending').length;
    const approvedAppts = myAppointments.filter(a => a.status === 'approved').length;
    const completedAppts = myAppointments.filter(a => a.status === 'completed').length;

    const summaryTotals = {
      totalAppointments: myApptCount,
      pendingAppointments: pendingAppts,
      approvedAppointments: approvedAppts,
      completedAppointments: completedAppts,
      reviewedAssessments: myAssessments.length,
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
// Filtered analytics for a specific parent (their children and appointments)
router.get('/analytics/parent', authMiddleware, async (req, res) => {
  try {
    const parentId = req.user.role === 'parent' ? req.user.userId : req.query.parentId;
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

module.exports = router;
