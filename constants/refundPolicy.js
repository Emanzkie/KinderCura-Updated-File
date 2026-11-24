// constants/refundPolicy.js
// The Refund Policy parents see, and the rules services/refundService.js
// enforces. One source for both, so the page never promises something the
// server refuses.

// PayMongo accepts GCash refunds for 180 days (Maya: 12 months), so 180 days
// covers every e-wallet KinderCura takes online.
const REFUND_WINDOW_DAYS = 180;

// Appointment statuses whose online payment may be refunded.
const REFUNDABLE_APPOINTMENT_STATUSES = Object.freeze(['cancelled', 'rejected']);

// Share of the online payment returned when the parent or guardian cancelled
// (Terms of Service, section 16). Everything else is refunded in full,
// including bookings cancelled before Appointment.cancelledBy was recorded.
const PARENT_CANCEL_REFUND_RATE = 0.5;

/** What may be refunded of `paidAmount` for this appointment. Pure. */
function refundFor(appointment, paidAmount) {
  const paid = Number(paidAmount) || 0;
  const familyCancelled = appointment?.status === 'cancelled' && appointment?.cancelledBy === 'family';
  const rate = familyCancelled ? PARENT_CANCEL_REFUND_RATE : 1;
  return { paidAmount: paid, refundPercent: rate * 100, amount: Math.round(paid * rate * 100) / 100 };
}

const REFUND_POLICY = Object.freeze({
  title: 'Refund Policy',
  points: Object.freeze([
    'Refunds are available for appointments paid online through GCash or Maya that were cancelled, or rejected by the clinic. Completed appointments are not eligible.',
    `Partial refund (${PARENT_CANCEL_REFUND_RATE * 100}%): half of the amount you paid online, when you cancel the appointment.`,
    'Full refund (100%): when the pediatrician or clinic cancels or rejects the appointment, or when a system or service-related problem prevents the consultation.',
    `Request a refund within ${REFUND_WINDOW_DAYS} days of payment. It goes back to the same GCash or Maya account.`,
    'The pediatrician or clinic staff review each request. You will be notified of the decision and the reason.',
    'Approved refunds are processed by PayMongo and usually arrive within 24 hours. A refund shows as Refunded only after PayMongo confirms it.',
    'Payments made at the clinic are refunded at the clinic counter, not online.',
  ]),
});

module.exports = { PARENT_CANCEL_REFUND_RATE, refundFor, REFUND_WINDOW_DAYS, REFUNDABLE_APPOINTMENT_STATUSES, REFUND_POLICY };
