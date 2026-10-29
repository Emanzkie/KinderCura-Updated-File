// constants/refundPolicy.js
// The Refund Policy parents see, and the rules services/refundService.js
// enforces. One source for both, so the page never promises something the
// server refuses.

// PayMongo accepts GCash refunds for 180 days (Maya: 12 months), so 180 days
// covers every e-wallet KinderCura takes online.
const REFUND_WINDOW_DAYS = 180;

// Appointment statuses whose online payment may be refunded.
const REFUNDABLE_APPOINTMENT_STATUSES = Object.freeze(['cancelled', 'rejected']);

const REFUND_POLICY = Object.freeze({
  title: 'Refund Policy',
  points: Object.freeze([
    'Refunds are available for appointments paid online through GCash or Maya that were cancelled, or rejected by the clinic. Completed appointments are not eligible.',
    `Request a refund within ${REFUND_WINDOW_DAYS} days of payment. The full amount paid goes back to the same GCash or Maya account.`,
    'The pediatrician or clinic staff review each request. You will be notified of the decision and the reason.',
    'Approved refunds are processed by PayMongo and usually arrive within 24 hours. A refund shows as Refunded only after PayMongo confirms it.',
    'Payments made at the clinic are refunded at the clinic counter, not online.',
  ]),
});

module.exports = { REFUND_WINDOW_DAYS, REFUNDABLE_APPOINTMENT_STATUSES, REFUND_POLICY };
