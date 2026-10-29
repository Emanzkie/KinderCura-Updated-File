// services/refundService.js
// Parent refund requests for online (PayMongo) payments.
//
//   pending_review --reject--> rejected
//   pending_review --approve--> approved --PayMongo accepts--> processing
//   processing --PayMongo succeeded--> refunded   (Payment.status -> 'Refunded')
//   processing --PayMongo failed / refused--> failed
//
// A refund is 'refunded' only when PayMongo itself reports `succeeded` — in the
// create response, a status re-check, or the payment.refunded webhook (which is
// re-fetched, never trusted). Staff approval alone never gets there.
//
// Duplicates: Refund.activeKey keeps one live request per payment; every status
// change is a findOneAndUpdate on the expected current status, so a double
// click or two staff members approving at once sends one PayMongo call; and an
// existing refund on the PayMongo payment is adopted instead of creating
// another. PayMongo also refuses a refund above what is left on the payment.
const mongoose = require('mongoose');
const Refund = require('../models/Refund');
const Payment = require('../models/Payment');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const User = require('../models/User');
const Notification = require('../models/Notification');
const paymongoService = require('./paymongoService');
const { hasPermission } = require('../middleware/guardianAccess');
const { REFUND_WINDOW_DAYS, REFUNDABLE_APPOINTMENT_STATUSES, REFUND_POLICY } = require('../constants/refundPolicy');

const DAY_MS = 24 * 60 * 60 * 1000;
const IN_FLIGHT = ['approved', 'processing'];
const STALE_SYNC_MS = 60 * 1000;
const MAX_SYNCS_PER_LIST = 5;

const STATUS_LABELS = Object.freeze({
  pending_review: 'Pending Review',
  approved: 'Approved',
  processing: 'Processing',
  refunded: 'Refunded',
  rejected: 'Rejected',
  failed: 'Failed',
});

function httpError(statusCode, message, code = null) {
  return Object.assign(new Error(message), { statusCode, code });
}

function money(amount) {
  return `₱${Number(amount || 0).toFixed(2)}`;
}

async function notify(userId, title, message, relatedPage) {
  if (!userId) return;
  try {
    await Notification.create({ userId, title, message, type: 'payment', isRead: false, relatedPage });
  } catch (err) {
    console.warn('refundService notify failed:', err.message);
  }
}

function notifyParent(refund, title, message) {
  return notify(refund.parentId, title, message, '/parent/appointments');
}

// ── Eligibility ────────────────────────────────────────────────────────────

/**
 * The PayMongo payment that may be refunded for this appointment, or an
 * httpError saying why not. Only a cancelled/rejected appointment with a
 * settled online payment inside the refund window qualifies.
 */
async function findRefundablePayment(appointment, now = new Date()) {
  if (!REFUNDABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
    throw httpError(400, 'Only a cancelled or rejected appointment can be refunded.', 'NOT_CANCELLED');
  }
  const payment = await Payment.findOne({ appointmentId: appointment._id, paymentMethod: 'paymongo', status: 'Paid' })
    .sort({ paidAt: -1 });
  if (!payment) {
    const paidAtClinic = await Payment.exists({ appointmentId: appointment._id, status: 'Paid' });
    throw paidAtClinic
      ? httpError(400, 'This appointment was paid at the clinic. Refunds for clinic payments are handled at the clinic counter.', 'CLINIC_PAYMENT')
      : httpError(400, 'There is no online payment to refund for this appointment.', 'NO_ONLINE_PAYMENT');
  }
  if (!(Number(payment.amount) > 0)) {
    throw httpError(400, 'There is no online payment to refund for this appointment.', 'NO_ONLINE_PAYMENT');
  }
  const paidAt = payment.paidAt || payment.transactionDate || payment.createdAt;
  if (paidAt && now.getTime() - new Date(paidAt).getTime() > REFUND_WINDOW_DAYS * DAY_MS) {
    throw httpError(400, `Online refunds can only be requested within ${REFUND_WINDOW_DAYS} days of payment.`, 'WINDOW_PASSED');
  }
  return payment;
}

async function mayRequestFor(user, appointment) {
  if (String(appointment.parentId || '') === String(user.userId)) return true;
  return hasPermission(user.userId, appointment.childId, 'manageAppointments');
}

// ── Parent request ─────────────────────────────────────────────────────────

async function requestRefund({ user, appointmentNumericId, reason, now = new Date() }) {
  const text = String(reason || '').trim();
  if (!text) throw httpError(400, 'Please tell the clinic why you are requesting a refund.');
  if (text.length > 500) throw httpError(400, 'Please keep the reason under 500 characters.');

  const appointment = await Appointment.findOne({ id: Number(appointmentNumericId) });
  if (!appointment) throw httpError(404, 'Appointment not found.');
  if (!await mayRequestFor(user, appointment)) throw httpError(403, 'Access denied.');

  const payment = await findRefundablePayment(appointment, now);

  let refund;
  try {
    refund = await Refund.create({
      appointmentId: appointment._id,
      appointmentNumericId: appointment.id,
      paymentId: payment._id,
      parentId: appointment.parentId || null,
      childId: appointment.childId || null,
      pediatricianId: appointment.pediatricianId || null,
      requestedBy: new mongoose.Types.ObjectId(String(user.userId)),
      amount: Number(payment.amount),
      currency: payment.currency || 'PHP',
      reason: text,
      status: 'pending_review',
      activeKey: String(payment._id),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      throw httpError(409, 'A refund has already been requested for this payment.', 'DUPLICATE');
    }
    throw err;
  }

  await notify(
    appointment.pediatricianId,
    'Refund Requested',
    `A parent requested a refund of ${money(refund.amount)} for Appointment #${appointment.id}. Review it under Appointments > Refunds.`,
    '/pedia/pediatrician-appointments'
  );
  return refund;
}

// ── Staff review ───────────────────────────────────────────────────────────

async function loadForStaff(refundId, scopePediatricianId) {
  if (!mongoose.Types.ObjectId.isValid(String(refundId))) throw httpError(404, 'Refund request not found.');
  const refund = await Refund.findById(refundId).lean();
  if (!refund) throw httpError(404, 'Refund request not found.');
  if (String(refund.pediatricianId || '') !== String(scopePediatricianId || '')) throw httpError(403, 'Access denied.');
  return refund;
}

function reviewer(user, note) {
  return {
    reviewedBy: new mongoose.Types.ObjectId(String(user.userId)),
    reviewedByRole: user.role,
    reviewedAt: new Date(),
    reviewNote: note || null,
  };
}

async function reviewRefund({ user, scopePediatricianId, refundId, decision, note }) {
  const text = String(note || '').trim().slice(0, 500);
  if (!['approve', 'reject'].includes(decision)) throw httpError(400, 'Decision must be approve or reject.');
  if (decision === 'reject' && !text) throw httpError(400, 'Please give the parent a reason for rejecting the refund.');

  const current = await loadForStaff(refundId, scopePediatricianId);
  const alreadyReviewed = httpError(409, `This refund request is already ${STATUS_LABELS[current.status] || current.status}.`);

  if (decision === 'reject') {
    const refund = await Refund.findOneAndUpdate(
      { _id: current._id, status: 'pending_review' },
      { $set: { status: 'rejected', ...reviewer(user, text) }, $unset: { activeKey: 1 } },
      { new: true }
    ).lean();
    if (!refund) throw alreadyReviewed;
    await notifyParent(refund, 'Refund Request Rejected',
      `Your refund request for Appointment #${refund.appointmentNumericId} was not approved. Reason: ${text}`);
    return refund;
  }

  const claimed = await Refund.findOneAndUpdate(
    { _id: current._id, status: 'pending_review' },
    { $set: { status: 'approved', ...reviewer(user, text) } },
    { new: true }
  ).lean();
  if (!claimed) throw alreadyReviewed;
  await notifyParent(claimed, 'Refund Approved',
    `Your refund of ${money(claimed.amount)} for Appointment #${claimed.appointmentNumericId} was approved and is being sent to PayMongo.`);
  return processApprovedRefund(claimed);
}

// ── PayMongo ───────────────────────────────────────────────────────────────

async function resolvePaymongoPaymentId(payment) {
  if (payment.paymongoPaymentId) return payment.paymongoPaymentId;
  if (!payment.paymongoCheckoutSessionId) return null;
  const session = await paymongoService.retrieveCheckoutSession(payment.paymongoCheckoutSessionId);
  return paymongoService.readSessionOutcome(session).paymentId || null;
}

async function markFailed(refund, reason) {
  const failed = await Refund.findOneAndUpdate(
    { _id: refund._id, status: { $in: IN_FLIGHT } },
    { $set: { status: 'failed', failureReason: reason, lastProviderSyncAt: new Date() }, $unset: { activeKey: 1 } },
    { new: true }
  ).lean();
  if (failed) {
    await notifyParent(failed, 'Refund Failed',
      `PayMongo could not complete the refund for Appointment #${failed.appointmentNumericId}. The clinic has been shown the reason; you may request again.`);
  }
  return failed || Refund.findById(refund._id).lean();
}

/** Send an approved refund to PayMongo, once. */
async function processApprovedRefund(refund) {
  if (!paymongoService.isConfigured()) {
    return markFailed(refund, 'Online refunds are not available: PayMongo is not configured on the server.');
  }
  try {
    const payment = await Payment.findById(refund.paymentId).lean();
    if (!payment) return markFailed(refund, 'The payment for this refund no longer exists.');
    const paymongoPaymentId = await resolvePaymongoPaymentId(payment);
    if (!paymongoPaymentId) return markFailed(refund, 'The PayMongo payment for this booking could not be found.');

    // A refund PayMongo already has for this payment (an earlier attempt whose
    // response was lost) is adopted, never duplicated.
    const existing = (await paymongoService.retrievePaymentRefunds(paymongoPaymentId))
      .find((r) => r.status !== 'failed');
    const providerRefund = existing || await paymongoService.createRefund({
      paymentId: paymongoPaymentId,
      amount: refund.amount,
      reason: 'requested_by_customer',
      notes: `KinderCura refund for Appointment #${refund.appointmentNumericId}`,
      metadata: { kc_refund_id: String(refund._id), kc_payment_ref: String(payment.paymentRef || '') },
    });

    await Refund.updateOne(
      { _id: refund._id, status: 'approved' },
      { $set: { status: 'processing', paymongoPaymentId, paymongoRefundId: providerRefund.id } }
    );
    return applyProviderRefund(refund._id, providerRefund);
  } catch (err) {
    console.error('[refund] PayMongo refund failed for', String(refund._id), err.message);
    return markFailed(refund, err.message || 'PayMongo refused the refund.');
  }
}

/** Apply PayMongo's refund status. Idempotent: replays change nothing. */
async function applyProviderRefund(refundId, providerRefund) {
  const providerStatus = providerRefund?.status || null;
  const now = new Date();

  if (providerStatus === 'succeeded') {
    const refunded = await Refund.findOneAndUpdate(
      { _id: refundId, status: { $in: IN_FLIGHT } },
      { $set: { status: 'refunded', providerStatus, refundedAt: now, lastProviderSyncAt: now } },
      { new: true }
    ).lean();
    if (refunded) {
      await Payment.updateOne({ _id: refunded.paymentId, status: 'Paid' }, { $set: { status: 'Refunded' } });
      await notifyParent(refunded, 'Refund Completed',
        `PayMongo confirmed your refund of ${money(refunded.amount)} for Appointment #${refunded.appointmentNumericId}. It should reach your GCash or Maya account within 24 hours.`);
      return refunded;
    }
  } else if (providerStatus === 'failed') {
    const refund = await Refund.findById(refundId).lean();
    if (refund && IN_FLIGHT.includes(refund.status)) {
      await Refund.updateOne({ _id: refundId }, { $set: { providerStatus } });
      return markFailed(refund, 'PayMongo reported that the refund failed.');
    }
  } else {
    await Refund.updateOne(
      { _id: refundId, status: { $in: IN_FLIGHT } },
      { $set: { status: 'processing', providerStatus, lastProviderSyncAt: now } }
    );
  }
  return Refund.findById(refundId).lean();
}

/** Ask PayMongo for the current status of a processing refund. */
async function syncRefund(refund) {
  if (refund.status !== 'processing' || !refund.paymongoRefundId) return refund;
  try {
    return await applyProviderRefund(refund._id, await paymongoService.retrieveRefund(refund.paymongoRefundId));
  } catch (err) {
    console.warn('[refund] Status check failed for', String(refund._id), err.message);
    await Refund.updateOne({ _id: refund._id }, { $set: { lastProviderSyncAt: new Date() } });
    return refund;
  }
}

/** Fallback for a missed webhook: re-check a few stale processing refunds. */
async function syncStale(refunds) {
  const now = Date.now();
  const stale = refunds
    .filter((r) => r.status === 'processing' && r.paymongoRefundId
      && (!r.lastProviderSyncAt || now - new Date(r.lastProviderSyncAt).getTime() > STALE_SYNC_MS))
    .slice(0, MAX_SYNCS_PER_LIST);
  if (!stale.length || !paymongoService.isConfigured()) return refunds;
  const fresh = new Map((await Promise.all(stale.map(syncRefund))).map((r) => [String(r._id), r]));
  return refunds.map((r) => fresh.get(String(r._id)) || r);
}

/**
 * payment.refunded webhook. The payload only says "look again": the refund is
 * re-fetched from PayMongo before anything changes.
 */
async function handleRefundWebhook(resource) {
  const attrs = resource?.attributes || {};
  const refundIds = [
    ...(String(resource?.id || '').startsWith('ref_') ? [resource.id] : []),
    ...(Array.isArray(attrs.refunds) ? attrs.refunds.map((r) => r?.id).filter(Boolean) : []),
  ];
  const paymongoPaymentId = String(resource?.id || '').startsWith('pay_') ? resource.id : (attrs.payment_id || null);

  let refund = refundIds.length
    ? await Refund.findOne({ paymongoRefundId: { $in: refundIds } }).lean()
    : null;
  if (!refund && paymongoPaymentId) {
    refund = await Refund.findOne({ paymongoPaymentId, status: { $in: IN_FLIGHT } }).sort({ createdAt: -1 }).lean();
  }
  if (!refund || !refund.paymongoRefundId) return { matched: false };
  if (!IN_FLIGHT.includes(refund.status)) return { matched: true, status: refund.status };

  const updated = await applyProviderRefund(refund._id, await paymongoService.retrieveRefund(refund.paymongoRefundId));
  return { matched: true, status: updated?.status };
}

// ── Lists ──────────────────────────────────────────────────────────────────

function serialize(refund, extra = {}) {
  return {
    id: String(refund._id),
    appointmentId: refund.appointmentNumericId,
    status: refund.status,
    statusLabel: STATUS_LABELS[refund.status] || refund.status,
    amount: refund.amount,
    currency: refund.currency || 'PHP',
    reason: refund.reason,
    reviewNote: refund.reviewNote || null,
    reviewedAt: refund.reviewedAt || null,
    failureReason: refund.failureReason || null,
    refundedAt: refund.refundedAt || null,
    createdAt: refund.createdAt || null,
    ...extra,
  };
}

/** The parent's refunds, which appointments can still be refunded, and the policy. */
async function listForParent(user, now = new Date()) {
  const appointments = await Appointment.find({ parentId: user.userId }).select('_id id status').lean();
  const appointmentIds = appointments.map((a) => a._id);

  const refunds = await syncStale(
    await Refund.find({ appointmentId: { $in: appointmentIds } }).sort({ createdAt: -1 }).lean()
  );
  const live = new Set(refunds.filter((r) => !['rejected', 'failed'].includes(r.status)).map((r) => String(r.paymentId)));

  const closed = appointments.filter((a) => REFUNDABLE_APPOINTMENT_STATUSES.includes(a.status));
  const paid = closed.length
    ? await Payment.find({ appointmentId: { $in: closed.map((a) => a._id) }, status: 'Paid' })
      .select('appointmentId appointmentNumericId paymentMethod amount paidAt transactionDate createdAt').lean()
    : [];

  const eligible = [];
  const paidAtClinic = new Set();
  for (const p of paid) {
    if (p.paymentMethod !== 'paymongo') { paidAtClinic.add(p.appointmentNumericId); continue; }
    const paidAt = p.paidAt || p.transactionDate || p.createdAt;
    const inWindow = !paidAt || now.getTime() - new Date(paidAt).getTime() <= REFUND_WINDOW_DAYS * DAY_MS;
    if (inWindow && Number(p.amount) > 0 && !live.has(String(p._id))) {
      eligible.push({ appointmentId: p.appointmentNumericId, amount: p.amount });
    }
  }

  return {
    refunds: refunds.map((r) => serialize(r)),
    eligible,
    // Paid at the clinic: nothing to request online, the page explains why.
    clinicPaidAppointmentIds: [...paidAtClinic].filter((id) => !eligible.some((e) => e.appointmentId === id)),
    policy: REFUND_POLICY,
  };
}

/** Every refund request for one pediatrician's appointments, newest first. */
async function listForClinic(pediatricianId) {
  const refunds = await syncStale(
    await Refund.find({ pediatricianId }).sort({ createdAt: -1 }).limit(200).lean()
  );
  const ids = (key) => [...new Set(refunds.map((r) => String(r[key] || '')).filter(Boolean))];
  const [children, parents, appointments, payments] = await Promise.all([
    Child.find({ _id: { $in: ids('childId') } }).select('firstName lastName').lean(),
    User.find({ _id: { $in: ids('parentId') } }).select('firstName lastName').lean(),
    Appointment.find({ _id: { $in: ids('appointmentId') } }).select('appointmentDate appointmentTime status').lean(),
    Payment.find({ _id: { $in: ids('paymentId') } }).select('paymentRef receiptNumber paymongoSourceType paidAt').lean(),
  ]);
  const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const childMap = byId(children);
  const parentMap = byId(parents);
  const apptMap = byId(appointments);
  const paymentMap = byId(payments);
  const name = (p) => (p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : null);

  return refunds.map((r) => {
    const appt = apptMap.get(String(r.appointmentId));
    const payment = paymentMap.get(String(r.paymentId));
    return serialize(r, {
      childName: name(childMap.get(String(r.childId))),
      parentName: name(parentMap.get(String(r.parentId))),
      appointmentDate: appt?.appointmentDate || null,
      appointmentTime: appt?.appointmentTime || null,
      appointmentStatus: appt?.status || null,
      paymentRef: payment?.paymentRef || null,
      receiptNumber: payment?.receiptNumber || null,
      ewallet: { gcash: 'GCash', paymaya: 'Maya', maya: 'Maya' }[String(payment?.paymongoSourceType || '').toLowerCase()] || 'E-Wallet',
      paidAt: payment?.paidAt || null,
    });
  });
}

module.exports = {
  STATUS_LABELS,
  findRefundablePayment,
  requestRefund,
  reviewRefund,
  processApprovedRefund,
  applyProviderRefund,
  syncRefund,
  handleRefundWebhook,
  listForParent,
  listForClinic,
};
