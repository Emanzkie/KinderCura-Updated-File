const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const Payment = require('../models/Payment');
const Child = require('../models/Child');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { hasPermission } = require('../middleware/guardianAccess');
const paymentService = require('../services/paymentService');

const PROOF_DIR = path.join(__dirname, '..', 'private', 'payment-proofs');

function fullName(user) {
  if (!user) return null;
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || null;
}

async function canAccessAppointment(req, appointment) {
  if (!appointment) return false;
  if (req.user.role === 'admin') return true;
  if (String(appointment.parentId || '') === String(req.user.userId)) return true;
  if (String(appointment.pediatricianId || '') === String(req.user.userId)) return true;
  if (req.user.role === 'secretary' && req.user.linkedPediatricianId) {
    return String(appointment.pediatricianId || '') === String(req.user.linkedPediatricianId);
  }
  return hasPermission(req.user.userId, appointment.childId, 'manageAppointments');
}

async function resolveClinicPediatricianId(req) {
  if (req.user.role === 'admin') return null;
  if (req.user.role === 'pediatrician') return req.user.userId;
  if (req.user.role === 'secretary') {
    if (!req.user.linkedPediatricianId) {
      throw new Error('Assistant/Secretary account is not linked to a pediatrician yet.');
    }
    const secretary = await User.findById(req.user.userId).select('secretaryPermissions').lean();
    const perms = secretary?.secretaryPermissions || {};
    // managePayments is the single source of truth for payment actions.
    // Fallback only applies to documents that predate this field and haven't
    // been backfilled yet (see scripts/migrate-add-managePayments.js) — once
    // the field is explicitly true/false it is used as-is, never overridden.
    const canManagePayments = perms.managePayments === undefined
      ? Boolean(perms.manageBookings || perms.approveSchedules)
      : Boolean(perms.managePayments);
    if (!canManagePayments) {
      throw new Error('You do not have permission to manage payments.');
    }
    return req.user.linkedPediatricianId;
  }
  throw new Error('Clinic staff only.');
}

async function pushNotification(userId, title, message, type = 'payment') {
  if (!userId) return;
  try {
    const NotifModel = (typeof Notification?.create === 'function')
      ? Notification
      : (Notification?.default || Notification?.Notification || null);
    const payload = {
      userId: new mongoose.Types.ObjectId(String(userId)),
      title,
      message,
      type,
      isRead: false,
    };
    if (NotifModel) {
      await NotifModel.create(payload);
    } else {
      await mongoose.connection.collection('notifications').insertOne({ ...payload, createdAt: new Date() });
    }
  } catch (err) {
    console.warn('paymentController pushNotification failed:', err.message);
  }
}

async function hydrateBalanceAppointment(appointment) {
  const [child, parent, pediatrician] = await Promise.all([
    Child.findById(appointment.childId).lean(),
    User.findById(appointment.parentId).lean(),
    appointment.pediatricianId ? User.findById(appointment.pediatricianId).lean() : null,
  ]);

  return {
    id: appointment.id,
    appointmentId: appointment.id,
    childId: child ? String(child._id) : null,
    parentId: parent ? String(parent._id) : null,
    pediatricianId: pediatrician ? String(pediatrician._id) : null,
    childName: child ? fullName(child) : 'Unknown Child',
    parentName: parent ? fullName(parent) : 'Unknown Parent',
    pediatricianName: pediatrician ? fullName(pediatrician) : null,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    reason: appointment.reason,
    status: appointment.status,
    paymentType: appointment.paymentType || null,
    paymentStatus: appointment.paymentStatus,
    pendingPaymentMode: appointment.pendingPaymentMode || null,
    totalAmount: appointment.totalAmount || 0,
    amountPaid: appointment.amountPaid || 0,
    balanceDue: appointment.balanceDue || 0,
    nextInstallmentDate: appointment.nextInstallmentDate || null,
    requiredDownPayment: paymentService.calculateRequiredDownPayment(appointment.totalAmount || 0),
  };
}

// ── Existing handlers ────────────────────────────────────────────────────────

async function quoteDownPayment(req, res) {
  try {
    const totalAmount = Number(req.query.totalAmount ?? req.body?.totalAmount ?? 0);
    if (!Number.isFinite(totalAmount) || totalAmount < 0) {
      return res.status(400).json({ error: 'Enter a valid total amount.' });
    }
    res.json({
      success: true,
      totalAmount: paymentService.roundCurrency(totalAmount),
      requiredDownPayment: paymentService.calculateRequiredDownPayment(totalAmount),
      downPaymentRate: paymentService.DOWN_PAYMENT_RATE,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getAppointmentPayments(req, res) {
  try {
    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) }).lean();
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
    if (!await canAccessAppointment(req, appointment)) return res.status(403).json({ error: 'Access denied.' });

    const payments = await paymentService.getPaymentsForAppointment(appointment._id);
    res.json({
      success: true,
      appointment: await hydrateBalanceAppointment(appointment),
      payments: payments.map(paymentService.serializePayment),
    });
  } catch (err) {
    console.error('getAppointmentPayments error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function getPendingBalances(req, res) {
  try {
    const pediatricianId = await resolveClinicPediatricianId(req);
    const appointments = await paymentService.getPendingBalanceAppointments({ pediatricianId });
    const balances = [];
    for (const appointment of appointments) {
      balances.push(await hydrateBalanceAppointment(appointment));
    }
    res.json({ success: true, balances });
  } catch (err) {
    const status = /permission|linked|staff/i.test(err.message) ? 403 : 500;
    console.error('getPendingBalances error:', err);
    res.status(status).json({ error: err.message });
  }
}

async function recordManualPayment(req, res) {
  try {
    await resolveClinicPediatricianId(req);

    const result = await paymentService.withPaymentTransaction(async (session) => {
      const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) }).session(session);
      if (!appointment) {
        const err = new Error('Appointment not found.');
        err.statusCode = 404;
        throw err;
      }
      if (!await canAccessAppointment(req, appointment)) {
        const err = new Error('Access denied.');
        err.statusCode = 403;
        throw err;
      }
      if (['cancelled', 'rejected'].includes(appointment.status)) {
        const err = new Error('Cannot record payment for a cancelled or rejected appointment.');
        err.statusCode = 400;
        throw err;
      }
      return paymentService.recordManualPayment({
        appointment,
        amountPaid: req.body.amountPaid,
        paymentMethod: req.body.paymentMethod || 'cash',
        paymentType: req.body.paymentType || 'balance_payment',
        nextInstallmentDate: req.body.nextInstallmentDate || null,
        notes: req.body.notes || null,
        actor: req.user,
        session,
      });
    });

    const updated = await Appointment.findOne({ id: Number(req.params.appointmentId) }).lean();
    res.json({
      success: true,
      payment: paymentService.serializePayment(result.payment),
      summary: await hydrateBalanceAppointment(updated),
    });
  } catch (err) {
    const status = err.statusCode || (/permission|linked|staff|access/i.test(err.message) ? 403 : 400);
    console.error('recordManualPayment error:', err);
    res.status(status).json({ error: err.message });
  }
}

// ── New payment flow handlers ─────────────────────────────────────────────────

// POST /api/payments/appointments/:appointmentId/select-mode
// Parent selects walk-in or e-wallet before any upload.
async function selectPaymentMode(req, res) {
  try {
    const { mode } = req.body;
    if (!['walk_in', 'ewallet'].includes(mode)) {
      return res.status(400).json({ error: "Mode must be 'walk_in' or 'ewallet'." });
    }

    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });

    const isParentOwner = String(appointment.parentId || '') === String(req.user.userId);
    const isGuardian = !isParentOwner && await hasPermission(req.user.userId, appointment.childId, 'manageAppointments');
    if (!isParentOwner && !isGuardian && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (appointment.status !== 'pending') {
      return res.status(400).json({ error: 'Payment mode can only be selected for pending appointments.' });
    }
    if (appointment.paymentStatus === 'Paid') {
      return res.status(400).json({ error: 'This appointment is already paid.' });
    }

    appointment.pendingPaymentMode = mode;
    // Reset to Pending Payment if they switch from a prior mode
    if (appointment.paymentStatus !== 'Payment Verification Pending') {
      appointment.paymentStatus = 'Pending Payment';
    }
    await appointment.save();

    res.json({ success: true, mode, paymentStatus: appointment.paymentStatus });
  } catch (err) {
    console.error('selectPaymentMode error:', err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/appointments/:appointmentId/ewallet-proof
// Parent uploads e-wallet screenshot + reference number.
async function uploadEwalletProof(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'A proof image is required.' });
    }

    const referenceNumber = String(req.body.referenceNumber || '').trim();
    if (!referenceNumber) {
      // Remove uploaded file if validation fails
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'A reference number is required.' });
    }

    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    const isParentOwner = String(appointment.parentId || '') === String(req.user.userId);
    const isGuardian = !isParentOwner && await hasPermission(req.user.userId, appointment.childId, 'manageAppointments');
    if (!isParentOwner && !isGuardian && req.user.role !== 'admin') {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (appointment.status !== 'pending') {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Cannot upload proof for a non-pending appointment.' });
    }

    // Ensure mode is set to ewallet
    appointment.pendingPaymentMode = 'ewallet';
    appointment.paymentStatus = 'Payment Verification Pending';
    await appointment.save();

    // Create payment record as a pending e-wallet transaction
    const payment = await Payment.create([{
      appointmentId: appointment._id,
      appointmentNumericId: appointment.id,
      amount: 0,
      totalAmount: appointment.totalAmount,
      paymentType: 'full_payment',
      balanceDue: appointment.totalAmount,
      status: 'Verification Pending',
      paymentMethod: 'ewallet',
      referenceNumber,
      proofImagePath: req.file.filename,
      recordedBy: new mongoose.Types.ObjectId(String(req.user.userId)),
      recordedByRole: req.user.role,
      transactionDate: new Date(),
    }]);

    // Notify all admins about the new proof
    const admins = await User.find({ role: 'admin', status: 'active' }).select('_id').lean();
    for (const admin of admins) {
      await pushNotification(
        admin._id,
        'E-Wallet Proof Submitted',
        `Appointment #${appointment.id}: a parent submitted e-wallet proof. Reference: ${referenceNumber}.`,
        'payment'
      );
    }

    res.status(201).json({
      success: true,
      paymentId: payment[0].id,
      paymentStatus: appointment.paymentStatus,
    });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('uploadEwalletProof error:', err);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/appointments/:appointmentId/confirm-walkin
// Secretary or admin confirms that the parent paid cash/POS at the clinic counter.
async function confirmWalkIn(req, res) {
  try {
    await resolveClinicPediatricianId(req);

    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });

    if (!await canAccessAppointment(req, appointment)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (appointment.pendingPaymentMode !== 'walk_in') {
      return res.status(400).json({ error: 'This appointment is not set for walk-in payment.' });
    }

    if (!['Pending Payment', 'Unpaid'].includes(appointment.paymentStatus)) {
      return res.status(400).json({ error: `Cannot confirm walk-in: payment status is '${appointment.paymentStatus}'.` });
    }

    if (['cancelled', 'rejected'].includes(appointment.status)) {
      return res.status(400).json({ error: 'Cannot confirm payment for a cancelled or rejected appointment.' });
    }

    // CRITICAL: Mark appointment as Paid BEFORE calling approve, so canConfirmAppointment passes.
    const total = appointment.totalAmount || 0;
    appointment.amountPaid = total;
    appointment.balanceDue = 0;
    appointment.paymentStatus = 'Paid';
    appointment.paymentType = 'Full';
    await appointment.save();

    // Create the payment record
    await Payment.create([{
      appointmentId: appointment._id,
      appointmentNumericId: appointment.id,
      amount: total,
      totalAmount: total,
      paymentType: 'full_payment',
      balanceDue: 0,
      status: 'Paid',
      paymentMethod: 'cash',
      referenceNumber: `KC-CASH-${Date.now().toString(36).toUpperCase()}`,
      recordedBy: new mongoose.Types.ObjectId(String(req.user.userId)),
      recordedByRole: req.user.role,
      notes: req.body.notes || 'Walk-in cash payment confirmed at clinic.',
      transactionDate: new Date(),
      verifiedAt: new Date(),
      verifiedBy: new mongoose.Types.ObjectId(String(req.user.userId)),
    }]);

    // Approve the appointment now that payment is confirmed
    appointment.status = 'approved';
    await appointment.save();

    // Notify parent
    await pushNotification(
      appointment.parentId,
      'Payment Confirmed — Appointment Approved',
      `Your walk-in payment for Appointment #${appointment.id} has been confirmed. Your appointment is now approved.`,
      'payment'
    );

    // Notify pediatrician if action was taken by secretary
    if (req.user.role === 'secretary' && appointment.pediatricianId) {
      const secretary = await User.findById(req.user.userId).select('firstName lastName').lean();
      const secName = secretary ? `${secretary.firstName} ${secretary.lastName}` : 'Your secretary';
      await pushNotification(
        appointment.pediatricianId,
        'Walk-in Payment Confirmed',
        `${secName} confirmed walk-in payment for Appointment #${appointment.id}.`,
        'payment'
      );
    }

    const updated = await Appointment.findOne({ id: Number(req.params.appointmentId) }).lean();
    res.json({
      success: true,
      appointment: await hydrateBalanceAppointment(updated),
    });
  } catch (err) {
    const status = /permission|linked|staff|access/i.test(err.message) ? 403 : 500;
    console.error('confirmWalkIn error:', err);
    res.status(status).json({ error: err.message });
  }
}

// POST /api/payments/appointments/:appointmentId/verify-ewallet
// Admin approves or rejects an uploaded e-wallet proof.
async function verifyEwallet(req, res) {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const { action, notes } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: "Action must be 'approve' or 'reject'." });
    }

    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });

    if (appointment.paymentStatus !== 'Payment Verification Pending') {
      return res.status(400).json({ error: `Appointment payment status is '${appointment.paymentStatus}', not pending verification.` });
    }

    const payment = await Payment.findOne({
      appointmentId: appointment._id,
      status: 'Verification Pending',
    }).sort({ createdAt: -1 });

    if (action === 'approve') {
      const total = appointment.totalAmount || 0;

      if (payment) {
        payment.status = 'Paid';
        payment.amount = total;
        payment.balanceDue = 0;
        payment.verifiedAt = new Date();
        payment.verifiedBy = new mongoose.Types.ObjectId(String(req.user.userId));
        if (notes) payment.notes = String(notes).trim();
        await payment.save();
      }

      // CRITICAL: Update appointment payment fields BEFORE approving status.
      appointment.amountPaid = total;
      appointment.balanceDue = 0;
      appointment.paymentStatus = 'Paid';
      appointment.paymentType = 'Full';
      await appointment.save();

      appointment.status = 'approved';
      await appointment.save();

      await pushNotification(
        appointment.parentId,
        'E-Wallet Payment Verified — Appointment Approved',
        `Your e-wallet payment for Appointment #${appointment.id} has been verified. Your appointment is now approved.`,
        'payment'
      );
    } else {
      // reject
      if (payment) {
        payment.status = 'Cancelled';
        if (notes) payment.notes = String(notes).trim();
        await payment.save();
      }

      appointment.paymentStatus = 'Pending Payment';
      appointment.pendingPaymentMode = null;
      await appointment.save();

      await pushNotification(
        appointment.parentId,
        'E-Wallet Proof Rejected',
        `Your e-wallet proof for Appointment #${appointment.id} was not accepted. Please re-submit or choose walk-in payment.`,
        'payment'
      );
    }

    const updated = await Appointment.findOne({ id: Number(req.params.appointmentId) }).lean();
    res.json({
      success: true,
      action,
      appointment: await hydrateBalanceAppointment(updated),
    });
  } catch (err) {
    console.error('verifyEwallet error:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/pending-ewallet
// Admin: list all appointments with e-wallet proofs awaiting verification.
async function getPendingEwallets(req, res) {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const appointments = await Appointment.find({ paymentStatus: 'Payment Verification Pending' })
      .sort({ createdAt: -1 })
      .lean();

    const results = [];
    for (const appt of appointments) {
      const [child, parent, pediatrician, payment] = await Promise.all([
        Child.findById(appt.childId).lean(),
        User.findById(appt.parentId).lean(),
        appt.pediatricianId ? User.findById(appt.pediatricianId).lean() : null,
        Payment.findOne({ appointmentId: appt._id, status: 'Verification Pending' }).sort({ createdAt: -1 }).lean(),
      ]);

      results.push({
        id: appt.id,
        appointmentDate: appt.appointmentDate,
        appointmentTime: appt.appointmentTime,
        reason: appt.reason,
        status: appt.status,
        paymentStatus: appt.paymentStatus,
        totalAmount: appt.totalAmount || 0,
        childName: child ? `${child.firstName} ${child.lastName}` : 'Unknown',
        parentName: parent ? `${parent.firstName} ${parent.lastName}` : 'Unknown',
        parentEmail: parent?.email || null,
        pediatricianName: pediatrician ? `${pediatrician.firstName} ${pediatrician.lastName}` : null,
        referenceNumber: payment?.referenceNumber || null,
        proofImagePath: payment?.proofImagePath || null,
        proofSubmittedAt: payment?.createdAt || null,
        paymentId: payment?.id || null,
      });
    }

    res.json({ success: true, appointments: results, count: results.length });
  } catch (err) {
    console.error('getPendingEwallets error:', err);
    res.status(500).json({ error: err.message });
  }
}

// GET /api/payments/proof/:filename
// Admin-only: securely serve an e-wallet proof image.
function serveProofImage(req, res) {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    // path.basename prevents path traversal attacks
    const filename = path.basename(req.params.filename);
    const filePath = path.join(PROOF_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Proof image not found.' });
    }

    res.sendFile(filePath);
  } catch (err) {
    console.error('serveProofImage error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getAppointmentPayments,
  getPendingBalances,
  quoteDownPayment,
  recordManualPayment,
  selectPaymentMode,
  uploadEwalletProof,
  confirmWalkIn,
  verifyEwallet,
  getPendingEwallets,
  serveProofImage,
};
