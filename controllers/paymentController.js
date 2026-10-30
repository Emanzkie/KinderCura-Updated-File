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
const QRCode = require('qrcode');
const SystemSetting = require('../models/SystemSetting');
const paymongoService = require('../services/paymongoService');
const receiptService = require('../services/receiptService');
const refundService = require('../services/refundService');
const followUpPlans = require('../services/followUpPlans');
const adminOps = require('../services/adminOperationsAnalytics');
const { SECRETARY_DEFAULT_PERMISSIONS } = require('../services/secretaryPermissions');
const { CLINIC_TIMEZONE, clinicDayStart, clinicDayEnd } = require('../constants/clinicTime');

const fileStorage = require('../services/fileStorage');

// Rows the Admin Payments table lists (newest first); its totals count all.
const ADMIN_MONITOR_ROW_LIMIT = 500;

// Project-relative folder. fileStorage maps it to disk locally and to a
// private Vercel Blob prefix in production — see services/fileStorage.js.
const PROOF_DIR = 'private/payment-proofs';
const PROOF_ACCESS = { access: 'private' };

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

// managePayments is off unless the pediatrician turned it on, the same default
// services/secretaryPermissions.js and the Staff Access settings show. It used
// to fall back to manageBookings/approveSchedules when unset, so a secretary
// could take payments while their settings said they could not.
function canSecretaryManagePayments(secretary) {
  const perms = { ...SECRETARY_DEFAULT_PERMISSIONS, ...((secretary && secretary.secretaryPermissions) || {}) };
  return perms.managePayments === true;
}

async function resolveClinicPediatricianId(req) {
  if (req.user.role === 'admin') return null;
  if (req.user.role === 'pediatrician') return req.user.userId;
  if (req.user.role === 'secretary') {
    if (!req.user.linkedPediatricianId) {
      throw new Error('Assistant/Secretary account is not linked to a pediatrician yet.');
    }
    const secretary = await User.findById(req.user.userId).select('secretaryPermissions').lean();
    if (!canSecretaryManagePayments(secretary)) {
      throw new Error('You do not have permission to manage payments.');
    }
    return req.user.linkedPediatricianId;
  }
  throw new Error('Clinic staff only.');
}

async function pushNotification(userId, title, message, type = 'payment', extra = {}) {
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
    // relatedPage / relatedId let the bell UI jump straight to the right page
    // (and appointment) without parsing the message text.
    if (extra && extra.relatedPage) payload.relatedPage = String(extra.relatedPage);
    if (extra && extra.relatedId != null) payload.relatedId = String(extra.relatedId);
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
// Parent selects walk-in before any upload.
// 'ewallet' was the legacy manual e-wallet-transfer mode — retired in favor of
// Pay Online (PayMongo) and Pay at Clinic (QR). Kept as a named case so a stale
// client gets a clear, intentional response instead of a generic 400.
async function selectPaymentMode(req, res) {
  try {
    const { mode } = req.body;
    if (mode === 'ewallet') {
      return res.status(410).json({
        error: 'Manual E-Wallet Transfer is no longer available. Please use Pay Online or Pay at Clinic.',
        code: 'EWALLET_RETIRED',
      });
    }
    if (mode !== 'walk_in') {
      return res.status(400).json({ error: "Mode must be 'walk_in'." });
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
// Retired: manual e-wallet proof upload. Superseded by Pay Online (PayMongo)
// and Pay at Clinic (QR). The route no longer runs an upload middleware in
// front of this (see routes/payments.js), so no file is ever accepted here.
async function uploadEwalletProof(req, res) {
  return res.status(410).json({
    error: 'Manual E-Wallet Transfer is no longer available. Please use Pay Online or Pay at Clinic.',
    code: 'EWALLET_RETIRED',
  });
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
    // Claimed atomically: two clicks at once (or a secretary and an admin)
    // used to both pass the checks above and record two Paid cash payments.
    const claimed = await Appointment.findOneAndUpdate(
      {
        _id: appointment._id,
        pendingPaymentMode: 'walk_in',
        paymentStatus: { $in: ['Pending Payment', 'Unpaid'] },
        status: { $nin: ['cancelled', 'rejected'] },
      },
      { $set: { amountPaid: total, balanceDue: 0, paymentStatus: 'Paid', paymentType: 'Full' } },
      { new: true }
    );
    if (!claimed) return res.status(409).json({ error: 'This walk-in payment has already been confirmed.' });

    // Create the payment record
    await Payment.create([{
      appointmentId: appointment._id,
      appointmentNumericId: appointment.id,
      parentId: appointment.parentId || null,
      childId: appointment.childId || null,
      pediatricianId: appointment.pediatricianId || null,
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

    // A Follow-up Check-up's assessments are assigned now (once).
    await followUpPlans.activateForAppointment(appointment);

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
// Retired: manual e-wallet admin approve/reject. No new 'Payment Verification
// Pending' record can be created (see uploadEwalletProof above), so this queue
// can no longer receive anything to act on.
async function verifyEwallet(req, res) {
  return res.status(410).json({
    error: 'Manual E-Wallet Transfer is no longer available.',
    code: 'EWALLET_RETIRED',
  });
}

// GET /api/payments/pending-ewallet
// Retired along with verifyEwallet above — this fed the admin's manual
// approval queue, which is no longer reachable from the admin UI.
async function getPendingEwallets(req, res) {
  return res.status(410).json({
    error: 'Manual E-Wallet Transfer is no longer available.',
    code: 'EWALLET_RETIRED',
  });
}

// GET /api/payments/proof/:filename
// Admin-only: securely serve an e-wallet proof image.
async function serveProofImage(req, res) {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    // path.basename prevents path traversal attacks
    const filename = path.basename(req.params.filename);

    // serveStored streams from disk locally and from the private Blob store in
    // production. The proof is never exposed by a public URL either way — the
    // admin check above is still the only way in.
    const sent = await fileStorage.serveStored(res, PROOF_DIR, filename, PROOF_ACCESS);
    if (!sent) {
      return res.status(404).json({ error: 'Proof image not found.' });
    }
  } catch (err) {
    console.error('serveProofImage error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Automated payments: PayMongo online checkout + Pay-at-Clinic QR
//
// Both routes share one rule: the browser never supplies the amount, the
// status, or who owns the appointment. Every figure below is read back out of
// MongoDB, and settlement always goes through receiptService.settlePayment()
// so receipts and emails stay idempotent.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the pediatrician whose clinic the caller is allowed to operate on.
 * Read from the database rather than the JWT, so re-linking a secretary takes
 * effect immediately instead of when their 48h token expires.
 * Throws for anyone who is not clinic staff.
 */
async function resolveCashierScope(req) {
  if (req.user.role === 'admin') return { pediatricianId: null, isAdmin: true };
  if (req.user.role === 'pediatrician') {
    return { pediatricianId: String(req.user.userId), isAdmin: false };
  }
  if (req.user.role === 'secretary') {
    const secretary = await User.findById(req.user.userId)
      .select('linkedPediatricianId secretaryPermissions status').lean();
    if (!secretary || secretary.status !== 'active') {
      throw Object.assign(new Error('This assistant account is not active.'), { statusCode: 403 });
    }
    if (!secretary.linkedPediatricianId) {
      throw Object.assign(
        new Error('Assistant/Secretary account is not linked to a pediatrician yet.'),
        { statusCode: 403 }
      );
    }
    if (!canSecretaryManagePayments(secretary)) {
      throw Object.assign(new Error('You do not have permission to manage payments.'), { statusCode: 403 });
    }
    return { pediatricianId: String(secretary.linkedPediatricianId), isAdmin: false };
  }
  throw Object.assign(new Error('Clinic staff only.'), { statusCode: 403 });
}

/** Parent-side ownership check for an appointment. */
async function assertParentMayPay(req, appointment) {
  const isOwner = String(appointment.parentId || '') === String(req.user.userId);
  if (isOwner) return true;
  if (req.user.role === 'admin') return true;
  return hasPermission(req.user.userId, appointment.childId, 'manageAppointments');
}

/** Shared preconditions before either payment route may start. */
function assertPayable(appointment) {
  if (['cancelled', 'rejected'].includes(appointment.status)) {
    throw Object.assign(new Error('This appointment has been cancelled.'), { statusCode: 400 });
  }
  if (appointment.paymentStatus === 'Paid') {
    throw Object.assign(new Error('This appointment is already paid.'), { statusCode: 400 });
  }
  const total = Number(appointment.totalAmount || 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw Object.assign(
      new Error('This appointment has no consultation fee set, so it cannot be paid online.'),
      { statusCode: 400 }
    );
  }
  return total;
}

/**
 * Find the open automated payment for an appointment, or create one.
 * Reusing the row keeps a single KC-PAY reference per appointment attempt
 * instead of minting a new record every time the parent revisits the page.
 */
async function ensureAutomatedPayment({ appointment, method, actor, parentEmail, receiptPhone = null, paymentType = 'full_payment' }) {
  const total = Number(appointment.totalAmount || 0);

  // The clinic balance row (paymentService.ensureBalancePayment) is never
  // reused for a new attempt.
  const existing = await Payment.findOne({
    appointmentId: appointment._id,
    paymentMethod: { $in: ['paymongo', 'pay_at_clinic'] },
    paymentType: { $ne: 'balance_payment' },
    status: { $in: ['Pending', 'Failed', 'Expired'] },
  }).sort({ createdAt: -1 });

  if (existing) {
    existing.paymentMethod = method;
    existing.paymentType = paymentType;
    existing.status = 'Pending';
    existing.totalAmount = total;
    existing.balanceDue = total;
    existing.failureReason = null;
    if (!existing.paymentRef) existing.paymentRef = await Payment.nextPaymentRef();
    if (parentEmail) existing.receiptEmail = parentEmail;
    if (receiptPhone) existing.receiptPhone = receiptPhone;
    await existing.save();
    return existing;
  }

  const paymentRef = await Payment.nextPaymentRef();
  return Payment.create({
    appointmentId: appointment._id,
    appointmentNumericId: appointment.id,
    parentId: appointment.parentId || null,
    childId: appointment.childId || null,
    pediatricianId: appointment.pediatricianId || null,
    amount: 0,
    totalAmount: total,
    balanceDue: total,
    paymentType,
    status: 'Pending',
    paymentMethod: method,
    currency: 'PHP',
    paymentRef,
    referenceNumber: paymentRef,
    receiptEmail: parentEmail || null,
    receiptPhone: receiptPhone || null,
    recordedBy: actor?.userId ? new mongoose.Types.ObjectId(String(actor.userId)) : null,
    recordedByRole: actor?.role || null,
    transactionDate: new Date(),
  });
}

// POST /api/payments/appointments/:appointmentId/checkout
// Parent chooses "Pay Online". Creates a pending payment then a PayMongo
// Checkout Session, and hands back the hosted checkout URL.
async function startOnlineCheckout(req, res) {
  try {
    if (!paymongoService.isConfigured()) {
      return res.status(503).json({
        error: 'Online payment is not available yet. Please choose Pay at Clinic.',
        code: 'PAYMONGO_NOT_CONFIGURED',
      });
    }

    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
    if (!await assertParentMayPay(req, appointment)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Authoritative amount — never req.body. Online is always the 50% deposit;
    // the rest is paid at the clinic on the appointment day.
    const total = assertPayable(appointment);
    if (Number(appointment.amountPaid || 0) > 0) {
      return res.status(400).json({
        error: 'Your deposit is already paid. The remaining balance is paid at the clinic.',
        code: 'DEPOSIT_ALREADY_PAID',
      });
    }
    const deposit = paymentService.calculateRequiredDownPayment(total);

    const clinic = await SystemSetting.getClinic();
    if (!clinic.onlinePaymentEnabled) {
      return res.status(503).json({ error: 'Online payment is currently disabled by the clinic.' });
    }

    const [parent, child] = await Promise.all([
      User.findById(appointment.parentId).select('firstName lastName email phoneNumber').lean(),
      Child.findById(appointment.childId).select('firstName lastName').lean(),
    ]);

    // Pre-fill only — never a second place for the parent to type contact
    // info. The registered account's email (and phone, when actually on
    // file) seed PayMongo's checkout billing fields; the parent may still
    // edit or replace them entirely inside the PayMongo hosted checkout.
    const payment = await ensureAutomatedPayment({
      appointment,
      method: 'paymongo',
      actor: req.user,
      parentEmail: parent?.email || null,
      receiptPhone: parent?.phoneNumber || null,
      paymentType: 'down_payment',
    });

    // Where PayMongo sends the parent back to. Behind Vercel's proxy
    // req.protocol reports "http" unless trust-proxy is enabled, which would
    // hand PayMongo an http:// return URL, so the configured public origin
    // wins and req is only the local-development fallback.
    const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
    const origin = process.env.APP_URL
      ? String(process.env.APP_URL).replace(/\/$/, '')
      : (vercelHost ? `https://${vercelHost}` : `${req.protocol}://${req.get('host')}`);
    const childName = child ? `${child.firstName} ${child.lastName}`.trim() : 'your child';

    const session = await paymongoService.createCheckoutSession({
      referenceNumber: payment.paymentRef,
      amount: deposit,
      currency: payment.currency || 'PHP',
      lineName: `${clinic.clinicName || 'KinderCura'} — Consultation (${Math.round(paymentService.DOWN_PAYMENT_RATE * 100)}% deposit)`,
      lineDescription: `Appointment #${appointment.id} for ${childName}`,
      successUrl: `${origin}/parent/payment?appointmentId=${appointment.id}&ref=${encodeURIComponent(payment.paymentRef)}&result=success`,
      cancelUrl: `${origin}/parent/payment?appointmentId=${appointment.id}&ref=${encodeURIComponent(payment.paymentRef)}&result=cancelled`,
      customerEmail: payment.receiptEmail || parent?.email || null,
      customerName: parent ? `${parent.firstName} ${parent.lastName}`.trim() : null,
      customerPhone: payment.receiptPhone || parent?.phoneNumber || null,
      paymentMethods: clinic.paymongoMethods?.length ? clinic.paymongoMethods : undefined,
      metadata: {
        kc_appointment_id: String(appointment.id),
        kc_payment_id: String(payment._id),
      },
    });

    payment.paymongoCheckoutSessionId = session.id;
    payment.paymongoPaymentIntentId = session.paymentIntentId;
    payment.checkoutUrl = session.checkoutUrl;
    await payment.save();

    appointment.pendingPaymentMode = 'paymongo';
    if (appointment.paymentStatus !== 'Payment Verification Pending') {
      appointment.paymentStatus = 'Pending Payment';
    }
    await appointment.save();

    res.status(201).json({
      success: true,
      paymentRef: payment.paymentRef,
      checkoutUrl: session.checkoutUrl,
      amount: deposit,
      totalAmount: total,
      balanceAtClinic: paymentService.roundCurrency(total - deposit),
      testMode: paymongoService.isTestMode(),
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('startOnlineCheckout error:', err.message);
    res.status(status).json({ error: err.message });
  }
}

// GET /api/payments/ref/:paymentRef/status
// Polled by the parent's page after returning from PayMongo. Reports only what
// the database says — a browser landing on success_url proves nothing.
async function getPaymentStatusByRef(req, res) {
  try {
    const payment = await Payment.findOne({ paymentRef: String(req.params.paymentRef).trim() });
    if (!payment) return res.status(404).json({ error: 'Payment reference not found.' });

    const appointment = await Appointment.findById(payment.appointmentId).lean();
    if (appointment && !await assertParentMayPay(req, appointment)
        && !['admin', 'secretary', 'pediatrician'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    res.json({
      success: true,
      paymentRef: payment.paymentRef,
      status: payment.status,
      paid: payment.status === 'Paid',
      receiptNumber: payment.receiptNumber,
      paidAt: payment.paidAt,
      amount: payment.totalAmount,
      paymentMethod: payment.paymentMethod,
      appointmentId: payment.appointmentNumericId,
    });
  } catch (err) {
    console.error('getPaymentStatusByRef error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/payments/ref/:paymentRef/reconcile
// Server-to-server confirmation with PayMongo. This is the safety net for when
// a webhook has not arrived (or is not configured yet): KinderCura asks
// PayMongo directly. It is still authoritative because the answer comes from
// PayMongo's API over our authenticated connection, not from the browser.
async function reconcileCheckout(req, res) {
  try {
    const payment = await Payment.findOne({ paymentRef: String(req.params.paymentRef).trim() });
    if (!payment) return res.status(404).json({ error: 'Payment reference not found.' });

    const appointment = await Appointment.findById(payment.appointmentId).lean();
    if (appointment && !await assertParentMayPay(req, appointment)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (payment.status === 'Paid') {
      return res.json({ success: true, paid: true, status: 'Paid', receiptNumber: payment.receiptNumber });
    }
    if (!payment.paymongoCheckoutSessionId) {
      return res.status(400).json({ error: 'This payment has no online checkout session to reconcile.' });
    }
    if (!paymongoService.isConfigured()) {
      return res.status(503).json({ error: 'PayMongo is not configured on the server.' });
    }

    const sessionJson = await paymongoService.retrieveCheckoutSession(payment.paymongoCheckoutSessionId);
    const outcome = paymongoService.readSessionOutcome(sessionJson);

    if (!outcome.isPaid) {
      return res.json({ success: true, paid: false, status: payment.status, gatewayStatus: outcome.status });
    }

    console.log(
      '[reconcile] Resolved billing for', payment.paymentRef,
      { billingEmail: outcome.billingEmail, billingPhone: outcome.billingPhone, sourceType: outcome.sourceType }
    );

    const result = await receiptService.settlePayment({
      paymentId: payment._id,
      method: 'paymongo',
      paymongo: {
        paymentId: outcome.paymentId,
        paymentIntentId: outcome.paymentIntentId,
        checkoutSessionId: payment.paymongoCheckoutSessionId,
        sourceType: outcome.sourceType,
        billingEmail: outcome.billingEmail,
        billingPhone: outcome.billingPhone,
      },
      notes: 'Confirmed by server-side reconciliation with PayMongo.',
    });

    if (!result.alreadySettled) await notifyPaymentSettled(result.payment);

    res.json({
      success: true,
      paid: true,
      status: 'Paid',
      receiptNumber: result.payment.receiptNumber,
      alreadySettled: result.alreadySettled,
    });
  } catch (err) {
    console.error('reconcileCheckout error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

/**
 * Notify the pediatrician (primary) and the parent that a payment settled.
 *
 * The pediatrician is the primary recipient: this runs from the webhook /
 * reconciliation path, so it does not depend on the secretary being online.
 * Called only when `settlePayment` reported a fresh settlement
 * (`alreadySettled === false`), so a retried webhook or a later reconcile does
 * not produce a duplicate "Payment Received" notification.
 */
async function notifyPaymentSettled(payment) {
  try {
    const appointment = await Appointment.findById(payment.appointmentId).lean();
    if (!appointment) return;

    const amount = `${payment.currency === 'PHP' || !payment.currency ? '₱' : `${payment.currency} `}`
      + Number(payment.amount).toFixed(2);
    const methodLabel = receiptService.ewalletBrandLabel(
      payment.paymongoSourceType,
      payment.paymentMethod === 'pay_at_clinic' ? 'Pay at Clinic' : 'E-Wallet'
    );
    // After the 50% online deposit the rest is still owed at the clinic.
    const balance = Number(appointment.balanceDue || 0);
    const balanceText = appointment.paymentStatus !== 'Paid' && balance > 0
      ? `₱${balance.toFixed(2)} is due at the clinic on the appointment day.`
      : null;

    // Parent — unchanged behaviour, plus the balance still due.
    await pushNotification(
      appointment.parentId,
      'Payment Received — Appointment Confirmed',
      `We received ${amount} for Appointment #${appointment.id}. `
        + `Receipt ${payment.receiptNumber} has been emailed to you.`
        + (balanceText ? ` The remaining ${balanceText}` : ''),
      'payment',
      { relatedPage: '/parent/appointments.html', relatedId: String(appointment.id) }
    );

    // Pediatrician — primary recipient and viewer.
    if (appointment.pediatricianId) {
      let childName = null;
      try {
        const child = await Child.findById(appointment.childId).select('firstName lastName').lean();
        childName = child ? `${child.firstName || ''} ${child.lastName || ''}`.trim() || null : null;
      } catch { /* name is best-effort */ }

      const parts = [
        `Appointment #${appointment.id}${childName ? ` for ${childName}` : ''} has been ${balanceText ? 'partly paid (deposit)' : 'paid'}.`,
        `Amount: ${amount} via ${methodLabel}.`,
      ];
      if (payment.receiptNumber) parts.push(`Receipt: ${payment.receiptNumber}.`);
      if (balanceText) parts.push(`Balance: ${balanceText}`);

      await pushNotification(
        appointment.pediatricianId,
        'Payment Received',
        parts.join(' '),
        'payment',
        { relatedPage: '/pedia/pediatrician-appointments.html', relatedId: String(appointment.id) }
      );
    }
  } catch (err) {
    console.warn('notifyPaymentSettled failed:', err.message);
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────

/**
 * Locate the Payment a webhook refers to.
 * PayMongo may deliver a checkout-session resource (v1's
 * `checkout_session.payment.paid`) or a payment resource (`payment.paid`), so
 * every identifier either shape can carry is tried in turn.
 */
async function findPaymentForWebhookResource(resource) {
  const attrs = resource?.attributes || {};
  const candidates = [];

  const ref = attrs.reference_number
    || attrs.metadata?.kc_payment_ref
    || attrs.external_reference_number
    || attrs.data?.attributes?.metadata?.kc_payment_ref;
  if (ref) candidates.push({ paymentRef: String(ref) });

  const kcPaymentId = attrs.metadata?.kc_payment_id || attrs.data?.attributes?.metadata?.kc_payment_id;
  if (kcPaymentId && mongoose.Types.ObjectId.isValid(String(kcPaymentId))) {
    candidates.push({ _id: new mongoose.Types.ObjectId(String(kcPaymentId)) });
  }

  if (resource?.id && String(resource.id).startsWith('cs_')) {
    candidates.push({ paymongoCheckoutSessionId: String(resource.id) });
  }

  const intentId = attrs.payment_intent_id || attrs.payment_intent?.id;
  if (intentId) candidates.push({ paymongoPaymentIntentId: String(intentId) });

  if (resource?.id && String(resource.id).startsWith('pay_')) {
    candidates.push({ paymongoPaymentId: String(resource.id) });
  }

  for (const query of candidates) {
    const found = await Payment.findOne(query);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve the billing email/phone and e-wallet source type PayMongo recorded
 * for a just-paid transaction, preferring a fresh, authoritative server-side
 * Checkout Session lookup (via our secret key, same call reconcileCheckout()
 * already makes) over whatever shape the webhook payload happened to embed.
 *
 * Why this matters: a webhook delivery is a "something happened" signal, not
 * a guaranteed full snapshot of the resource — PayMongo's webhook payload for
 * `checkout_session.payment.paid` / `payment.paid` may omit or truncate the
 * nested `billing` object even when a direct `GET` on the same resource
 * returns it in full. Because most payments settle via the webhook (it
 * usually beats the browser's own reconcile call), trusting only the
 * webhook's embedded billing risked silently keeping the pre-fill (the
 * registered KinderCura email) as the permanent receipt destination even
 * when the parent changed it on PayMongo's hosted checkout page. Re-fetching
 * here closes that gap for the webhook path the same way reconcileCheckout()
 * already closes it for the polling path.
 *
 * Never throws: a failed re-fetch just falls back to the webhook's own
 * embedded data so settlement is never blocked on this secondary lookup.
 */
async function resolvePaidBillingAndSource(payment, resource) {
  let billing = paymongoService.readBillingFromWebhookResource(resource);
  let sourceType = paymongoService.readSourceTypeFromWebhookResource(resource);

  if (payment.paymongoCheckoutSessionId && paymongoService.isConfigured()) {
    try {
      const sessionJson = await paymongoService.retrieveCheckoutSession(payment.paymongoCheckoutSessionId);
      const outcome = paymongoService.readSessionOutcome(sessionJson);
      // Prefer the freshly-fetched, authoritative value; keep the
      // webhook-embedded one only where the re-fetch did not return anything.
      billing = {
        billingEmail: outcome.billingEmail || billing.billingEmail,
        billingPhone: outcome.billingPhone || billing.billingPhone,
      };
      if (outcome.sourceType) sourceType = outcome.sourceType;
    } catch (err) {
      console.warn('[webhook] Could not re-fetch checkout session for billing:', err.message);
    }
  }

  return { billing, sourceType };
}

// POST /api/payments/webhook/paymongo
// Public endpoint. Authenticated by signature, never by a session.
async function handlePaymongoWebhook(req, res) {
  const signature = req.get('Paymongo-Signature');
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;

  const verdict = paymongoService.verifyWebhookSignature({
    rawBody: req.rawBody,
    signatureHeader: signature,
    secret,
  });

  if (!verdict.ok) {
    // 401 tells PayMongo the delivery was rejected. The reason is logged but
    // deliberately not echoed back to an unauthenticated caller.
    console.warn('[webhook] Rejected PayMongo delivery:', verdict.reason);
    return res.status(401).json({ received: false });
  }

  // From here on, respond 200 for anything we understood. A non-2xx makes
  // PayMongo retry, and retrying will not fix a payload we cannot match.
  try {
    const event = req.body?.data || {};
    const eventId = event.id || null;
    const eventType = event.attributes?.type || null;
    const resource = event.attributes?.data || null;

    // A refund event only says "look again": refundService re-fetches the
    // refund from PayMongo before changing anything.
    if (eventType === 'payment.refunded') {
      const outcome = await refundService.handleRefundWebhook(resource);
      return res.status(200).json({ received: true, refund: outcome });
    }

    const HANDLED_PAID = ['checkout_session.payment.paid', 'payment.paid', 'payment_intent.succeeded'];
    const HANDLED_FAILED = ['payment.failed', 'payment_intent.payment_failed'];
    const HANDLED_EXPIRED = ['checkout_session.expired', 'qr.expired'];

    if (![...HANDLED_PAID, ...HANDLED_FAILED, ...HANDLED_EXPIRED].includes(eventType)) {
      return res.status(200).json({ received: true, ignored: eventType });
    }

    const payment = await findPaymentForWebhookResource(resource);
    if (!payment) {
      console.warn('[webhook] No KinderCura payment matched event', eventType, eventId);
      return res.status(200).json({ received: true, matched: false });
    }

    // Replay guard: the same event id applied twice is a no-op.
    if (eventId && payment.lastWebhookEventId === eventId) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    if (HANDLED_PAID.includes(eventType)) {
      const attrs = resource?.attributes || {};
      const { billing, sourceType } = await resolvePaidBillingAndSource(payment, resource);
      console.log(
        '[webhook] Resolved billing for', payment.paymentRef, eventType,
        { billingEmail: billing.billingEmail, billingPhone: billing.billingPhone, sourceType }
      );
      const result = await receiptService.settlePayment({
        paymentId: payment._id,
        method: 'paymongo',
        paidAt: attrs.paid_at ? new Date(attrs.paid_at * 1000) : new Date(),
        eventId,
        paymongo: {
          paymentId: String(resource?.id || '').startsWith('pay_') ? resource.id : null,
          paymentIntentId: attrs.payment_intent_id || attrs.payment_intent?.id || null,
          checkoutSessionId: String(resource?.id || '').startsWith('cs_') ? resource.id : (payment.paymongoCheckoutSessionId || null),
          sourceType,
          billingEmail: billing.billingEmail,
          billingPhone: billing.billingPhone,
        },
        notes: `Confirmed by PayMongo webhook (${eventType}).`,
      });

      if (!result.alreadySettled) await notifyPaymentSettled(result.payment);
      return res.status(200).json({ received: true, settled: true, duplicate: result.alreadySettled });
    }

    const status = HANDLED_FAILED.includes(eventType) ? 'Failed' : 'Expired';
    await receiptService.markPaymentOutcome(payment._id, status, {
      reason: resource?.attributes?.last_payment_error || eventType,
      eventId,
    });
    await pushNotification(
      payment.parentId,
      status === 'Failed' ? 'Online Payment Failed' : 'Online Payment Expired',
      `Payment ${payment.paymentRef} for Appointment #${payment.appointmentNumericId} did not complete. `
        + 'You can try again or choose Pay at Clinic.',
      'payment'
    );
    return res.status(200).json({ received: true, status });
  } catch (err) {
    console.error('[webhook] Processing error:', err.stack || err.message);
    // Signature was valid but processing broke — ask PayMongo to retry.
    return res.status(500).json({ received: false });
  }
}

// ── Pay at Clinic ─────────────────────────────────────────────────────────

// What the Pay at Clinic QR encodes: the secretary Cashier page with the
// KC-PAY reference in the query string. A phone camera opens it as a link
// (a bare reference only showed up as text); the Cashier page also pulls the
// reference back out of this URL when a USB scanner types it into the box.
// The URL carries nothing but the reference, and the page behind it only
// shows details to signed-in clinic staff. Origin resolution follows the
// PayMongo return URLs: APP_URL, then Vercel's public host, then the request
// (local development, including a phone on the same network).
function clinicCounterUrl(req, paymentRef) {
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const origin = process.env.APP_URL
    ? String(process.env.APP_URL).replace(/\/$/, '')
    : (vercelHost ? `https://${vercelHost}` : `${req.protocol}://${req.get('host')}`);
  return `${origin}/secretary/secretary-cashier?ref=${encodeURIComponent(paymentRef)}`;
}

// POST /api/payments/appointments/:appointmentId/pay-at-clinic
// Creates the pending payment and returns a QR encoding the Cashier page URL
// for its KC-PAY reference. No patient data is ever placed in the QR.
async function startPayAtClinic(req, res) {
  try {
    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
    if (!await assertParentMayPay(req, appointment)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const total = assertPayable(appointment);
    const clinic = await SystemSetting.getClinic();

    // Two QRs come from here. With the 50% online deposit paid, it is the
    // balance (always payable at the clinic). With nothing paid, it is the
    // whole fee in cash — for parents without GCash or Maya.
    const isBalance = Number(appointment.amountPaid || 0) > 0;
    let payment;
    let amount;
    if (isBalance) {
      payment = await paymentService.ensureBalancePayment(appointment);
      if (!payment) return res.status(400).json({ error: 'This appointment is already paid.' });
      amount = paymentService.amountDueFor(payment, appointment);
    } else {
      if (!clinic.payAtClinicEnabled) {
        return res.status(503).json({ error: 'Pay at Clinic is currently disabled by the clinic.' });
      }
      const parent = await User.findById(appointment.parentId).select('email').lean();
      payment = await ensureAutomatedPayment({
        appointment,
        method: 'pay_at_clinic',
        actor: req.user,
        parentEmail: parent?.email || null,
        paymentType: 'full_payment',
      });
      amount = total;

      appointment.pendingPaymentMode = 'pay_at_clinic';
      if (appointment.paymentStatus !== 'Payment Verification Pending') {
        appointment.paymentStatus = 'Pending Payment';
      }
      await appointment.save();
    }

    // The QR payload is the Cashier page URL for this reference — nothing else.
    // Anyone who scans it outside the clinic reaches a staff-only page.
    const qrDataUrl = await QRCode.toDataURL(clinicCounterUrl(req, payment.paymentRef), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#3D4738', light: '#FFFFFF' },
    });

    res.status(201).json({
      success: true,
      paymentRef: payment.paymentRef,
      qrDataUrl,
      amount,
      isBalance,
      totalAmount: Number(appointment.totalAmount || 0),
      amountPaid: Number(appointment.amountPaid || 0),
      clinicName: clinic.clinicName,
      clinicPhone: clinic.phoneNumber,
      clinicAddress: clinic.address,
    });
  } catch (err) {
    console.error('startPayAtClinic error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

// GET /api/payments/clinic/lookup/:paymentRef
// Secretary scans a QR. Returns the details needed to eyeball the parent and
// child against the appointment — and nothing more.
async function lookupClinicPayment(req, res) {
  try {
    const scope = await resolveCashierScope(req);

    const ref = String(req.params.paymentRef || '').trim().toUpperCase();
    if (!/^KC-PAY-\d{4}-\d{6}$/.test(ref)) {
      return res.status(400).json({ error: 'That QR code is not a KinderCura payment reference.', code: 'INVALID_QR' });
    }

    const payment = await Payment.findOne({ paymentRef: ref });
    if (!payment) {
      return res.status(404).json({ error: 'Payment reference not found.', code: 'NOT_FOUND' });
    }

    const appointment = await Appointment.findById(payment.appointmentId);
    if (!appointment) {
      return res.status(404).json({ error: 'The appointment for this payment no longer exists.', code: 'NO_APPOINTMENT' });
    }

    // Clinic scoping: a secretary may only see their own pediatrician's patients.
    if (!scope.isAdmin && String(appointment.pediatricianId || '') !== String(scope.pediatricianId)) {
      return res.status(403).json({ error: 'This appointment belongs to another clinic.', code: 'WRONG_CLINIC' });
    }

    const [parent, child, pediatrician] = await Promise.all([
      User.findById(appointment.parentId).select('firstName lastName').lean(),
      Child.findById(appointment.childId).select('firstName lastName').lean(),
      appointment.pediatricianId
        ? User.findById(appointment.pediatricianId).select('firstName lastName').lean()
        : null,
    ]);

    // Every reason the secretary must not press Confirm, evaluated server-side.
    const blockers = [];
    if (payment.status === 'Paid') blockers.push({ code: 'ALREADY_PAID', message: `Already paid on ${new Date(payment.paidAt).toLocaleString('en-PH')} — receipt ${payment.receiptNumber}.` });
    if (payment.paymentMethod !== 'pay_at_clinic') blockers.push({ code: 'WRONG_METHOD', message: 'This payment is not set to Pay at Clinic.' });
    if (['cancelled', 'rejected'].includes(appointment.status)) blockers.push({ code: 'APPOINTMENT_CANCELLED', message: 'This appointment was cancelled.' });
    if (['Failed', 'Expired', 'Cancelled', 'Refunded'].includes(payment.status)) blockers.push({ code: 'PAYMENT_CLOSED', message: `This payment is marked ${payment.status}. Ask the parent to start a new payment.` });
    if (Number(payment.totalAmount) !== Number(appointment.totalAmount)) blockers.push({ code: 'AMOUNT_MISMATCH', message: 'The payment amount no longer matches the appointment fee. Escalate to admin.' });
    const isBalance = payment.paymentType === 'balance_payment';
    const amountDue = payment.status === 'Paid' ? Number(payment.amount || 0) : paymentService.amountDueFor(payment, appointment);
    if (isBalance && payment.status !== 'Paid' && !(amountDue > 0)) blockers.push({ code: 'NOTHING_DUE', message: 'Nothing is owed on this appointment any more.' });

    const apptDay = new Date(appointment.appointmentDate);
    const today = new Date();
    const sameDay = apptDay.toDateString() === today.toDateString();

    res.json({
      success: true,
      canConfirm: blockers.length === 0,
      blockers,
      isToday: sameDay,
      payment: {
        paymentRef: payment.paymentRef,
        amountDue,
        // A balance row is the half left after the online deposit.
        isBalance,
        totalAmount: Number(appointment.totalAmount || 0),
        paidSoFar: Number(appointment.amountPaid || 0),
        currency: payment.currency || 'PHP',
        paymentMethod: payment.paymentMethod,
        status: payment.status,
        receiptNumber: payment.receiptNumber,
        paidAt: payment.paidAt,
      },
      appointment: {
        id: appointment.id,
        date: appointment.appointmentDate,
        time: appointment.appointmentTime,
        service: appointment.reason || 'Consultation',
        status: appointment.status,
        parentName: parent ? `${parent.firstName} ${parent.lastName}`.trim() : '—',
        childName: child ? `${child.firstName} ${child.lastName}`.trim() : '—',
        pediatricianName: pediatrician ? `Dr. ${pediatrician.firstName} ${pediatrician.lastName}`.trim() : '—',
      },
    });
  } catch (err) {
    console.error('lookupClinicPayment error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

// POST /api/payments/clinic/:paymentRef/confirm
// The secretary states that cash actually changed hands. Scanning alone never
// marks anything paid; this explicit step does.
async function confirmClinicPayment(req, res) {
  try {
    const scope = await resolveCashierScope(req);

    const ref = String(req.params.paymentRef || '').trim().toUpperCase();
    const payment = await Payment.findOne({ paymentRef: ref });
    if (!payment) return res.status(404).json({ error: 'Payment reference not found.' });

    const appointment = await Appointment.findById(payment.appointmentId);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });

    if (!scope.isAdmin && String(appointment.pediatricianId || '') !== String(scope.pediatricianId)) {
      return res.status(403).json({ error: 'This appointment belongs to another clinic.' });
    }

    if (payment.status === 'Paid') {
      return res.status(409).json({
        error: 'This payment was already completed.',
        code: 'ALREADY_PAID',
        receiptNumber: payment.receiptNumber,
        paidAt: payment.paidAt,
      });
    }
    if (payment.paymentMethod !== 'pay_at_clinic') {
      return res.status(400).json({ error: 'This payment is not a Pay at Clinic transaction.' });
    }
    // Only an open reference can be paid. A refunded, cancelled, failed or
    // expired one used to be switched back to Paid by a scan.
    if (!['Pending', 'Verification Pending'].includes(payment.status)) {
      return res.status(409).json({
        error: `This payment is ${payment.status} and cannot be confirmed. Ask the parent to choose Pay at Clinic again for a new reference.`,
        code: 'NOT_PAYABLE',
      });
    }
    if (['cancelled', 'rejected'].includes(appointment.status)) {
      return res.status(400).json({ error: 'Cannot take payment for a cancelled appointment.' });
    }
    // The amount is whatever the appointment says. Nothing from req.body is used.
    if (Number(payment.totalAmount) !== Number(appointment.totalAmount)) {
      return res.status(409).json({ error: 'Payment amount no longer matches the appointment fee. Escalate to admin.' });
    }

    const result = await receiptService.settlePayment({
      paymentId: payment._id,
      method: 'pay_at_clinic',
      actor: req.user,
      notes: String(req.body?.notes || '').trim() || 'Cash payment received at clinic counter.',
    });

    if (!result.alreadySettled) await notifyPaymentSettled(result.payment);

    res.json({
      success: true,
      alreadySettled: result.alreadySettled,
      receiptNumber: result.payment.receiptNumber,
      receiptEmailed: result.emailed,
      paidAt: result.payment.paidAt,
      amount: result.payment.amount,
      appointmentId: appointment.id,
    });
  } catch (err) {
    console.error('confirmClinicPayment error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

// POST /api/payments/appointments/:appointmentId/collect-balance
// Clinic staff record the balance left after the online deposit, by
// appointment rather than by scanning (the pediatrician's appointment card).
// It resolves the balance reference and then takes exactly the Cashier's
// Confirm path, so there is one way a clinic payment gets settled.
async function collectBalance(req, res) {
  try {
    const scope = await resolveCashierScope(req);
    const appointment = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
    if (!scope.isAdmin && String(appointment.pediatricianId || '') !== String(scope.pediatricianId)) {
      return res.status(403).json({ error: 'This appointment belongs to another clinic.' });
    }
    if (['cancelled', 'rejected'].includes(appointment.status)) {
      return res.status(400).json({ error: 'Cannot take payment for a cancelled appointment.' });
    }
    if (appointment.paymentStatus !== 'Down Payment') {
      return res.status(409).json({
        error: appointment.paymentStatus === 'Paid'
          ? 'This appointment is already fully paid.'
          : 'The online deposit has not been paid yet, so there is no clinic balance to record.',
        code: 'NO_BALANCE',
      });
    }
    const payment = await paymentService.ensureBalancePayment(appointment);
    if (!payment) return res.status(409).json({ error: 'This appointment is already fully paid.', code: 'NO_BALANCE' });

    req.params.paymentRef = payment.paymentRef;
    return confirmClinicPayment(req, res);
  } catch (err) {
    console.error('collectBalance error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

// GET /api/payments/clinic/today
// Today's appointments for the caller's clinic, with payment state attached.
async function getClinicToday(req, res) {
  try {
    const scope = await resolveCashierScope(req);

    // Today in the clinic's time zone, not the server's: on Vercel (UTC) the
    // server's "today" was still yesterday until 8 AM in Manila. Cancelled
    // bookings are left out as well; their payment can no longer be taken.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: CLINIC_TIMEZONE });
    const start = clinicDayStart(today);
    const end = clinicDayEnd(today);

    const query = { appointmentDate: { $gte: start, $lte: end }, status: { $nin: ['rejected', 'cancelled'] } };
    if (!scope.isAdmin) query.pediatricianId = new mongoose.Types.ObjectId(String(scope.pediatricianId));

    const appointments = await Appointment.find(query).sort({ appointmentTime: 1 }).lean();
    const ids = appointments.map((a) => a._id);

    const [payments, parents, children] = await Promise.all([
      Payment.find({ appointmentId: { $in: ids } }).sort({ createdAt: -1 }).lean(),
      User.find({ _id: { $in: appointments.map((a) => a.parentId).filter(Boolean) } })
        .select('firstName lastName').lean(),
      Child.find({ _id: { $in: appointments.map((a) => a.childId).filter(Boolean) } })
        .select('firstName lastName').lean(),
    ]);

    const parentMap = new Map(parents.map((p) => [String(p._id), `${p.firstName} ${p.lastName}`.trim()]));
    const childMap = new Map(children.map((c) => [String(c._id), `${c.firstName} ${c.lastName}`.trim()]));
    // Prefer a settled payment; otherwise show the newest open one. When only
    // the deposit is in, the open balance row is the one to collect.
    const owesBalance = new Set(appointments
      .filter((a) => a.paymentStatus !== 'Paid' && Number(a.amountPaid || 0) > 0)
      .map((a) => String(a._id)));
    const isOpen = (p) => ['Pending', 'Verification Pending'].includes(p.status);
    const paymentMap = new Map();
    for (const p of payments) {
      const key = String(p.appointmentId);
      const current = paymentMap.get(key);
      const better = owesBalance.has(key)
        ? isOpen(p) && !isOpen(current || {})
        : p.status === 'Paid' && current?.status !== 'Paid';
      if (!current || better) paymentMap.set(key, p);
    }

    res.json({
      success: true,
      date: today,
      appointments: appointments.map((a) => {
        const pay = paymentMap.get(String(a._id)) || null;
        return {
          id: a.id,
          time: a.appointmentTime,
          parentName: parentMap.get(String(a.parentId)) || '—',
          childName: childMap.get(String(a.childId)) || '—',
          service: a.reason || 'Consultation',
          amount: a.totalAmount || 0,
          amountPaid: a.amountPaid || 0,
          balanceDue: a.balanceDue || 0,
          appointmentStatus: a.status,
          paymentStatus: a.paymentStatus,
          paymentMethod: pay?.paymentMethod || a.pendingPaymentMode || null,
          paymentRef: pay?.paymentRef || null,
          receiptNumber: pay?.receiptNumber || null,
        };
      }),
    });
  } catch (err) {
    console.error('getClinicToday error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

// GET /api/payments/admin/monitor
// Read-only reconciliation view. Admin observes; it does not approve.
async function getAdminPaymentMonitor(req, res) {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });

    const { method, status } = req.query;
    // Same period rules and status groups as Admin Analytics and Reports.
    const period = adminOps.parsePeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const query = { ...adminOps.periodMatch('createdAt', period) };
    if (method) query.paymentMethod = String(method);
    if (status) query.status = String(status);

    // The table shows the newest rows; the totals cover every matching
    // payment (they used to be added up from those 500 rows only).
    const [payments, groupRows] = await Promise.all([
      Payment.find(query).sort({ createdAt: -1 }).limit(ADMIN_MONITOR_ROW_LIMIT).lean(),
      Payment.aggregate([
        { $match: query },
        { $group: { _id: { status: '$status', method: '$paymentMethod' }, count: { $sum: 1 }, amount: { $sum: { $ifNull: ['$amount', 0] } } } },
      ]),
    ]);

    const totals = { paid: 0, pending: 0, failed: 0, refunded: 0, payAtClinic: 0, online: 0 };
    let paidAmount = 0;
    let count = 0;
    for (const row of groupRows) {
      const n = row.count || 0;
      count += n;
      const group = adminOps.paymentGroupFor(row._id && row._id.status);
      if (group === 'collected') { totals.paid += n; paidAmount += Number(row.amount || 0); }
      else if (group in totals) totals[group] += n;
      const rowMethod = row._id && row._id.method;
      if (rowMethod === 'pay_at_clinic') totals.payAtClinic += n;
      if (rowMethod === 'paymongo') totals.online += n;
    }

    // Batch-fetch display names rather than hydrating per row, same pattern
    // getClinicToday already uses below for its appointment list.
    const [parents, children, pediatricians] = await Promise.all([
      User.find({ _id: { $in: payments.map((p) => p.parentId).filter(Boolean) } })
        .select('firstName lastName').lean(),
      Child.find({ _id: { $in: payments.map((p) => p.childId).filter(Boolean) } })
        .select('firstName lastName').lean(),
      User.find({ _id: { $in: payments.map((p) => p.pediatricianId).filter(Boolean) } })
        .select('firstName lastName').lean(),
    ]);
    const parentMap = new Map(parents.map((u) => [String(u._id), fullName(u)]));
    const childMap = new Map(children.map((c) => [String(c._id), fullName(c)]));
    const pediatricianMap = new Map(pediatricians.map((u) => [String(u._id), fullName(u)]));

    res.json({
      success: true,
      summary: { ...totals, paidAmount: Math.round(paidAmount * 100) / 100, count, shown: payments.length },
      payments: payments.map((p) => ({
        id: p.id,
        paymentRef: p.paymentRef || p.referenceNumber,
        receiptNumber: p.receiptNumber,
        appointmentId: p.appointmentNumericId,
        parentName: parentMap.get(String(p.parentId)) || null,
        childName: childMap.get(String(p.childId)) || null,
        pediatricianName: pediatricianMap.get(String(p.pediatricianId)) || null,
        amount: p.amount,
        totalAmount: p.totalAmount,
        currency: p.currency || 'PHP',
        paymentMethod: p.paymentMethod,
        status: p.status,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        // The webhook resource for `checkout_session.payment.paid` is the
        // checkout session itself (`cs_...`), not a `pay_...` payment
        // sub-resource, so paymongoPaymentId is often left null even for a
        // genuinely-settled PayMongo payment. Fall back to whichever PayMongo
        // identifier the row actually has so the admin view isn't blank.
        paymongoPaymentId: p.paymongoPaymentId || p.paymongoPaymentIntentId || p.paymongoCheckoutSessionId || null,
        receiptSentAt: p.receiptSentAt,
      })),
    });
  } catch (err) {
    console.error('getAdminPaymentMonitor error:', err.message);
    res.status(500).json({ error: 'Could not load payments.' });
  }
}

// GET /api/payments/ref/:paymentRef/receipt
// One receipt view, shared by the parent's own appointment history and the
// admin payment monitor. Always built from the stored Payment/Appointment
// snapshot (receiptService.buildReceiptContext) — never recomputed from the
// pediatrician's current consultation rate, so an old receipt still shows
// its original historical amount after later rate changes.
async function getPaymentReceipt(req, res) {
  try {
    // Walk-in / manual payments never got a KC-PAY paymentRef — they only ever
    // had `referenceNumber` (e.g. KC-CASH-...), which the admin monitor already
    // surfaces as its fallback "Reference" value, so it must be matchable too.
    const ref = String(req.params.paymentRef || '').trim();
    const payment = await Payment.findOne({
      $or: [{ paymentRef: ref }, { receiptNumber: ref }, { referenceNumber: ref }],
    });
    if (!payment) return res.status(404).json({ error: 'Payment reference not found.' });

    if (req.user.role !== 'admin') {
      const appointment = payment.appointmentId
        ? await Appointment.findById(payment.appointmentId).lean()
        : null;
      const allowed = appointment
        ? await canAccessAppointment(req, appointment)
        : String(payment.parentId || '') === String(req.user.userId);
      if (!allowed) return res.status(403).json({ error: 'Access denied.' });
    }

    // An unpaid/pending/failed transaction must never be presented as a
    // completed receipt, however this endpoint was reached (browser history,
    // premature poll, a modified client). Only a settled payment has a real
    // receiptNumber and a final paidAt/amount worth showing. A refunded payment
    // was still paid, so its original receipt stays available.
    if (!['Paid', 'Refunded'].includes(payment.status)) {
      return res.status(409).json({
        error: 'This payment has not been confirmed yet. A receipt is not available.',
        status: payment.status,
      });
    }

    const receipt = await receiptService.buildReceiptContext(payment);
    res.json({ success: true, receipt });
  } catch (err) {
    console.error('getPaymentReceipt error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── Refunds (see services/refundService.js) ────────────────────────────────

function sendRefundError(res, err, label) {
  if (!err.statusCode) console.error(`${label} error:`, err.message);
  res.status(err.statusCode || 500).json({ error: err.message, code: err.code || undefined });
}

// Refund decisions belong to the appointment's pediatrician or their secretary
// (with Manage Payments) — not admins, who see refunds on the payment monitor.
async function resolveRefundScope(req) {
  if (!['pediatrician', 'secretary'].includes(req.user.role)) {
    throw Object.assign(new Error('Refund requests are reviewed by the pediatrician or their secretary.'), { statusCode: 403 });
  }
  try {
    return await resolveClinicPediatricianId(req);
  } catch (err) {
    throw Object.assign(err, { statusCode: 403 });
  }
}

// GET /api/payments/refunds/mine
async function getMyRefunds(req, res) {
  try {
    res.json({ success: true, ...(await refundService.listForParent(req.user)) });
  } catch (err) {
    sendRefundError(res, err, 'getMyRefunds');
  }
}

// POST /api/payments/appointments/:appointmentId/refund-request
async function requestRefund(req, res) {
  try {
    const refund = await refundService.requestRefund({
      user: req.user,
      appointmentNumericId: req.params.appointmentId,
      reason: req.body?.reason,
    });
    res.status(201).json({ success: true, refundId: String(refund._id), status: refund.status });
  } catch (err) {
    sendRefundError(res, err, 'requestRefund');
  }
}

// GET /api/payments/refunds/clinic
async function getClinicRefunds(req, res) {
  try {
    const pediatricianId = await resolveRefundScope(req);
    res.json({ success: true, refunds: await refundService.listForClinic(pediatricianId) });
  } catch (err) {
    sendRefundError(res, err, 'getClinicRefunds');
  }
}

// POST /api/payments/refunds/:refundId/review   { decision: 'approve'|'reject', note }
async function reviewRefund(req, res) {
  try {
    const scopePediatricianId = await resolveRefundScope(req);
    const refund = await refundService.reviewRefund({
      user: req.user,
      scopePediatricianId,
      refundId: req.params.refundId,
      decision: req.body?.decision,
      note: req.body?.note,
    });
    res.json({
      success: true,
      status: refund.status,
      statusLabel: refundService.STATUS_LABELS[refund.status],
      failureReason: refund.failureReason || null,
    });
  } catch (err) {
    sendRefundError(res, err, 'reviewRefund');
  }
}

// GET/PUT /api/payments/clinic-config — admin-managed clinic details.
// Exists so the clinic's real phone number is a single database value rather
// than a string duplicated across templates and pages.
const CLINIC_NAME_MAX_LENGTH = 120;
const CLINIC_EMAIL_MAX_LENGTH = 254;
const CLINIC_PHONE_MAX_LENGTH = 40;

// getClinic() fills a missing field with its schema default, so the merged
// clinic alone cannot say whether a name was ever saved. clinicNameConfigured
// reads the stored field, letting the admin settings form tell "not
// configured" apart from the built-in default.
async function clinicConfigBody() {
  const clinic = await SystemSetting.getClinic();
  const stored = await SystemSetting.findOne({ singleton: 'default' }).select('clinic.clinicName').lean();
  const storedName = stored && stored.clinic ? stored.clinic.clinicName : null;
  return {
    success: true,
    clinic,
    clinicNameConfigured: typeof storedName === 'string' && storedName.trim() !== '',
  };
}

async function getClinicConfig(req, res) {
  try {
    res.json(await clinicConfigBody());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function updateClinicConfig(req, res) {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });

    const allowed = [
      'clinicName', 'phoneNumber', 'email', 'address', 'currency',
      'onlinePaymentEnabled', 'payAtClinicEnabled', 'paymongoMethods', 'active',
    ];
    const set = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) set[`clinic.${key}`] = req.body[key];
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'No clinic fields supplied.' });
    if (set['clinic.clinicName'] !== undefined) {
      const name = typeof req.body.clinicName === 'string' ? req.body.clinicName.trim() : '';
      if (!name) return res.status(400).json({ error: 'Clinic name is required.' });
      if (name.length > CLINIC_NAME_MAX_LENGTH) {
        return res.status(400).json({ error: `Clinic name must be ${CLINIC_NAME_MAX_LENGTH} characters or fewer.` });
      }
      set['clinic.clinicName'] = name;
    }
    // The contact is shown on receipts and the Help & Support page.
    if (set['clinic.email'] !== undefined) {
      const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > CLINIC_EMAIL_MAX_LENGTH) {
        return res.status(400).json({ error: 'Enter a valid clinic email address.' });
      }
      set['clinic.email'] = email;
    }
    if (set['clinic.phoneNumber'] !== undefined) {
      const phone = typeof req.body.phoneNumber === 'string' ? req.body.phoneNumber.trim() : '';
      if (!phone || phone.length > CLINIC_PHONE_MAX_LENGTH) {
        return res.status(400).json({ error: `Clinic phone must be 1-${CLINIC_PHONE_MAX_LENGTH} characters.` });
      }
      set['clinic.phoneNumber'] = phone;
    }

    await SystemSetting.findOneAndUpdate(
      { singleton: 'default' },
      { $set: set, $setOnInsert: { singleton: 'default' } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(await clinicConfigBody());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  collectBalance,
  getMyRefunds,
  requestRefund,
  getClinicRefunds,
  reviewRefund,
  startOnlineCheckout,
  getPaymentStatusByRef,
  reconcileCheckout,
  handlePaymongoWebhook,
  startPayAtClinic,
  clinicCounterUrl,
  lookupClinicPayment,
  confirmClinicPayment,
  getClinicToday,
  getAdminPaymentMonitor,
  getPaymentReceipt,
  getClinicConfig,
  updateClinicConfig,
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
