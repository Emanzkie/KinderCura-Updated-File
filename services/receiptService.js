// services/receiptService.js
// One settlement path for both automated payment methods.
//
// PayMongo webhooks and the secretary's "Confirm Payment" button both end up
// here, so a receipt looks the same however the money arrived and the
// idempotency rules only have to be correct in one place.
//
// Idempotency: settlePayment() is safe to call repeatedly for the same
// payment. The receipt number is allocated exactly once, and the receipt email
// is sent exactly once, because both are guarded by a conditional update that
// only matches a row which has not been settled yet.

const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const User = require('../models/User');
const SystemSetting = require('../models/SystemSetting');
const emailService = require('./emailService');

/**
 * Collect everything a receipt needs to display, from the database rather than
 * from anything the caller passed in.
 */
async function buildReceiptContext(payment) {
  const appointment = payment.appointmentId
    ? await Appointment.findById(payment.appointmentId).lean()
    : null;

  const [parent, child, pediatrician, clinic] = await Promise.all([
    payment.parentId || appointment?.parentId
      ? User.findById(payment.parentId || appointment.parentId).select('firstName lastName email').lean()
      : null,
    payment.childId || appointment?.childId
      ? Child.findById(payment.childId || appointment.childId).select('firstName lastName').lean()
      : null,
    payment.pediatricianId || appointment?.pediatricianId
      ? User.findById(payment.pediatricianId || appointment.pediatricianId).select('firstName lastName').lean()
      : null,
    SystemSetting.getClinic(),
  ]);

  const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);

  return {
    clinic,
    receiptNumber: payment.receiptNumber,
    paymentRef: payment.paymentRef || payment.referenceNumber,
    parentName: fullName(parent) || 'Parent',
    parentEmail: payment.receiptEmail || parent?.email || null,
    childName: fullName(child) || 'Child',
    pediatricianName: fullName(pediatrician) ? `Dr. ${fullName(pediatrician)}` : 'Unassigned',
    appointmentId: appointment?.id ?? payment.appointmentNumericId ?? null,
    appointmentDate: appointment?.appointmentDate || null,
    appointmentTime: appointment?.appointmentTime || null,
    service: appointment?.reason || 'Consultation',
    paymentMethod: payment.paymentMethod,
    amount: payment.amount,
    currency: payment.currency || 'PHP',
    paidAt: payment.paidAt,
    status: payment.status,
  };
}

/** Human label for the receipt's "Payment Method" line. */
function paymentMethodLabel(method) {
  return {
    paymongo: 'Paid Online (PayMongo)',
    pay_at_clinic: 'Paid at Clinic',
    cash: 'Cash at Clinic',
    ewallet: 'E-Wallet Transfer',
    gcash: 'GCash',
    maya: 'Maya',
    card: 'Card',
    bank_transfer: 'Bank Transfer',
    check: 'Check',
    simulated_gateway: 'Online Payment',
  }[method] || String(method || 'Payment');
}

/**
 * Short brand label for a PayMongo e-wallet source type ('gcash' / 'paymaya').
 * Returns 'GCash' / 'Maya' when known, or `fallback` (default '—') otherwise.
 * Online checkout is e-wallet only, so 'GCash / Maya' is a safe fallback when
 * the money is in but PayMongo did not tell us which wallet was used.
 */
function ewalletBrandLabel(sourceType, fallback = '—') {
  const key = String(sourceType || '').trim().toLowerCase();
  return {
    gcash: 'GCash',
    paymaya: 'Maya',
    maya: 'Maya',
    grab_pay: 'GrabPay',
  }[key] || fallback;
}

/**
 * Mark a payment as settled, allocate its receipt number, sync the appointment,
 * and email the receipt — at most once, no matter how many times this runs.
 *
 * @param {object}  opts
 * @param {string}  opts.paymentId      Payment._id
 * @param {string}  [opts.method]       Overrides paymentMethod on settlement
 * @param {Date}    [opts.paidAt]
 * @param {object}  [opts.actor]        { userId, role } when a human confirmed it
 * @param {object}  [opts.paymongo]     { paymentId, paymentIntentId, checkoutSessionId }
 * @param {string}  [opts.eventId]      Webhook event id, stored for traceability
 * @param {string}  [opts.notes]
 * @returns {Promise<{ payment: object, alreadySettled: boolean, emailed: boolean }>}
 */
async function settlePayment({
  paymentId,
  method = null,
  paidAt = new Date(),
  actor = null,
  paymongo = null,
  eventId = null,
  notes = null,
}) {
  const existing = await Payment.findById(paymentId);
  if (!existing) throw new Error('Payment record not found.');

  // Fast path: already settled. Return without touching anything so a retried
  // webhook cannot produce a second receipt number or a second email.
  if (existing.status === 'Paid' && existing.receiptNumber) {
    return { payment: existing.toObject(), alreadySettled: true, emailed: false };
  }

  const receiptNumber = existing.receiptNumber || await Payment.nextReceiptNumber();

  const set = {
    status: 'Paid',
    paidAt,
    receiptNumber,
    amount: existing.totalAmount,
    balanceDue: 0,
    paymentType: 'full_payment',
    verifiedAt: paidAt,
  };
  if (method) set.paymentMethod = method;
  if (notes) set.notes = notes;
  if (eventId) set.lastWebhookEventId = eventId;
  if (actor?.userId) {
    set.verifiedBy = new mongoose.Types.ObjectId(String(actor.userId));
    set.recordedByRole = actor.role || existing.recordedByRole;
  }
  if (paymongo?.paymentId) set.paymongoPaymentId = paymongo.paymentId;
  if (paymongo?.paymentIntentId) set.paymongoPaymentIntentId = paymongo.paymentIntentId;
  if (paymongo?.checkoutSessionId) set.paymongoCheckoutSessionId = paymongo.checkoutSessionId;
  // Brand of the e-wallet used ('gcash' / 'paymaya'), when PayMongo told us.
  // paymentMethod itself stays whatever `method` is ('paymongo'), so admin
  // monitoring that keys on 'paymongo' is unaffected.
  if (paymongo?.sourceType) set.paymongoSourceType = String(paymongo.sourceType).toLowerCase();

  // The `status: { $ne: 'Paid' }` guard is the concurrency control: if two
  // webhook deliveries race, exactly one update matches and the other sees null.
  const updated = await Payment.findOneAndUpdate(
    { _id: existing._id, status: { $ne: 'Paid' } },
    { $set: set },
    { new: true }
  );

  if (!updated) {
    const current = await Payment.findById(existing._id).lean();
    return { payment: current, alreadySettled: true, emailed: false };
  }

  await syncAppointmentAfterPayment(updated);

  const emailed = await sendReceiptOnce(updated);
  return { payment: updated.toObject(), alreadySettled: false, emailed };
}

/**
 * Push the settled payment onto the appointment's denormalized snapshot and
 * approve it, mirroring what the existing walk-in confirmation already does.
 */
async function syncAppointmentAfterPayment(payment) {
  if (!payment.appointmentId) return null;
  const appointment = await Appointment.findById(payment.appointmentId);
  if (!appointment) return null;

  const total = Number(appointment.totalAmount || payment.totalAmount || 0);
  appointment.totalAmount = total;
  appointment.amountPaid = total;
  appointment.balanceDue = 0;
  appointment.paymentStatus = 'Paid';
  appointment.paymentType = 'Full';

  // A paid appointment that was still waiting on money is now confirmed.
  // Cancelled or rejected appointments are left alone — a late payment must
  // not silently resurrect them.
  if (appointment.status === 'pending') appointment.status = 'approved';

  await appointment.save();
  return appointment;
}

/**
 * Send the receipt email at most once per payment.
 * The `receiptSentAt: null` guard means a retried webhook finds no matching
 * row and skips sending, rather than mailing the parent twice.
 */
async function sendReceiptOnce(payment) {
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, receiptSentAt: null },
    { $set: { receiptSentAt: new Date() } },
    { new: true }
  );
  if (!claimed) return false; // another delivery already sent it

  try {
    const context = await buildReceiptContext(claimed);
    if (!context.parentEmail) {
      console.warn('[receiptService] No parent email on file for payment', String(payment._id));
      return false;
    }
    await emailService.sendPaymentReceiptEmail(context);
    return true;
  } catch (err) {
    // Roll the claim back so a later retry (or a manual resend) can try again.
    await Payment.updateOne({ _id: payment._id }, { $set: { receiptSentAt: null } });
    console.error('[receiptService] Receipt email failed for payment', String(payment._id), err.message);
    return false;
  }
}

/** Record a terminal non-success outcome coming from the gateway. */
async function markPaymentOutcome(paymentId, status, { reason = null, eventId = null } = {}) {
  const allowed = ['Failed', 'Expired', 'Cancelled', 'Refunded'];
  if (!allowed.includes(status)) throw new Error(`Unsupported payment outcome: ${status}`);

  // Never downgrade a payment that already settled.
  return Payment.findOneAndUpdate(
    { _id: paymentId, status: { $ne: 'Paid' } },
    { $set: { status, failureReason: reason, lastWebhookEventId: eventId } },
    { new: true }
  );
}

module.exports = {
  buildReceiptContext,
  paymentMethodLabel,
  ewalletBrandLabel,
  settlePayment,
  syncAppointmentAfterPayment,
  markPaymentOutcome,
};
