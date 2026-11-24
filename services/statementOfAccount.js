// services/statementOfAccount.js
// Builds an appointment's Statement of Account from its stored Payment rows.
// Pure and READ-ONLY: nothing here queries or writes. The paid amount and the
// balance always come from paymentService.summarizeConfirmationPayment, so they
// follow the recorded payments and not the fee that was booked.
const paymentService = require('./paymentService');
const receiptService = require('./receiptService');

const REFUNDED = 'Refunded';

// A refunded payment was still paid once, so its receipt stays available.
const RECEIPT_STATUSES = Object.freeze([...paymentService.VERIFIED_PAYMENT_STATUSES, REFUNDED]);

/** Staff-recorded rows have no paidAt; their transaction date is the paid date. */
function paidDate(payment) {
  return payment.paidAt || payment.transactionDate || payment.createdAt || null;
}

function methodLabel(payment) {
  return payment.paymentMethod === 'paymongo'
    ? receiptService.ewalletBrandLabel(payment.paymongoSourceType, 'Paid Online (PayMongo)')
    : receiptService.paymentMethodLabel(payment.paymentMethod);
}

function buildStatement(appointment, rows = []) {
  const summary = paymentService.summarizeConfirmationPayment(appointment, rows);
  const closed = ['cancelled', 'rejected'].includes(appointment.status);

  let running = summary.totalAmount;
  let refunded = 0;
  const payments = rows
    .filter((r) => RECEIPT_STATUSES.includes(r.status))
    .sort((a, b) => new Date(paidDate(a) || 0) - new Date(paidDate(b) || 0))
    .map((r) => {
      const amount = Number(r.amount ?? r.amountPaid) || 0;
      const isRefunded = r.status === REFUNDED;
      const returned = isRefunded ? amount : Number(r.refundedAmount) || 0;
      refunded += returned;
      if (!isRefunded) running = Math.max(paymentService.roundCurrency(running - amount), 0);
      return {
        date: paidDate(r),
        receiptNumber: r.receiptNumber || null,
        reference: r.paymentRef || r.referenceNumber || null,
        method: methodLabel(r),
        type: paymentService.paymentTypeLabel(r.paymentType),
        amount,
        refunded: isRefunded,
        refundedAmount: returned,
        balanceAfter: closed ? null : running,
      };
    });

  let status = 'Unpaid';
  if (!(summary.totalAmount > 0)) status = 'No Fee';
  else if (summary.state === 'Fully Paid' || summary.state === 'Partially Paid') status = summary.state;

  return {
    statementNumber: `SOA-${appointment.id}`,
    appointmentId: appointment.id,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    appointmentStatus: appointment.status,
    service: appointment.reason || 'Consultation',
    closed,
    totalAmount: summary.totalAmount,
    totalPaid: summary.verifiedPaid,
    totalRefunded: paymentService.roundCurrency(refunded),
    balanceDue: closed ? 0 : summary.balanceDue,
    status,
    payments,
  };
}

module.exports = { buildStatement, paidDate, RECEIPT_STATUSES };
