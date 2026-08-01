const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const Payment = require('../models/Payment');

const DOWN_PAYMENT_RATE = 0.3;
const PAYMENT_TYPES = new Set(['full_payment', 'down_payment', 'partial_installment', 'balance_payment']);
const PAYMENT_METHODS = new Set(['simulated_gateway', 'card', 'gcash', 'maya', 'bank_transfer', 'cash', 'check']);
const APPOINTMENT_PAYMENT_TYPE = {
  full_payment: 'Full',
  down_payment: 'Down',
  partial_installment: 'Partial',
  balance_payment: 'Partial',
};

const PAYMENT_TYPE_LABEL = {
  full_payment: 'Full Payment',
  down_payment: 'Down Payment',
  partial_installment: 'Partial Payment',
  balance_payment: 'Balance Payment',
};

function roundCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function asAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? roundCurrency(n) : NaN;
}

function calculateRequiredDownPayment(totalAmount) {
  return roundCurrency(asAmount(totalAmount) * DOWN_PAYMENT_RATE);
}

function normalizePaymentType(value) {
  const raw = String(value || '').trim().toLowerCase();
  const mapped = {
    full: 'full_payment',
    'full payment': 'full_payment',
    full_payment: 'full_payment',
    down: 'down_payment',
    'down payment': 'down_payment',
    down_payment: 'down_payment',
    partial: 'partial_installment',
    'partial payment': 'partial_installment',
    installment: 'partial_installment',
    partial_installment: 'partial_installment',
    balance: 'balance_payment',
    'balance payment': 'balance_payment',
    balance_payment: 'balance_payment',
  }[raw];
  return mapped || null;
}

function appointmentPaymentTypeFor(paymentType) {
  return APPOINTMENT_PAYMENT_TYPE[normalizePaymentType(paymentType)] || null;
}

function paymentTypeLabel(paymentType) {
  const normalized = normalizePaymentType(paymentType);
  return PAYMENT_TYPE_LABEL[normalized] || String(paymentType || '').trim() || null;
}

function normalizePaymentMethod(value, fallback = 'simulated_gateway') {
  const method = String(value || fallback).trim().toLowerCase();
  const mapped = {
    maya: 'maya',
    gcash: 'gcash',
    'bank transfer': 'bank_transfer',
    bank_transfer: 'bank_transfer',
    cash: 'cash',
    card: 'card',
    check: 'check',
    simulated_gateway: 'simulated_gateway',
  }[method] || method;
  return PAYMENT_METHODS.has(mapped) ? mapped : null;
}

function parseOptionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getAppointmentPaymentStatus(totalPaid, totalAmount, paymentType = null) {
  const total = asAmount(totalAmount);
  const paid = asAmount(totalPaid);
  if (total <= 0 || paid <= 0) return 'Unpaid';
  if (paid >= total) return 'Paid';
  if (normalizePaymentType(paymentType) === 'down_payment') return 'Down Payment';
  return 'Partially Paid';
}

function getTransactionStatus(totalPaid, totalAmount, paymentType = null) {
  const status = getAppointmentPaymentStatus(totalPaid, totalAmount, paymentType);
  return status === 'Unpaid' ? 'Pending' : status;
}

function buildPaymentSummary({ totalAmount, amountPaid, paymentType = null, nextInstallmentDate = null }) {
  const total = asAmount(totalAmount);
  const paid = Math.min(asAmount(amountPaid), total);
  const balance = Math.max(roundCurrency(total - paid), 0);
  const paymentStatus = getAppointmentPaymentStatus(paid, total, paymentType);
  return {
    paymentType: appointmentPaymentTypeFor(paymentType),
    totalAmount: total,
    amountPaid: paid,
    balanceDue: balance,
    paymentStatus,
    nextInstallmentDate,
    requiredDownPayment: calculateRequiredDownPayment(total),
  };
}

function buildInitialPaymentPlan({
  payment = null,
  totalAmount,
  actorRole = null,
  allowAdminOverride = false,
} = {}) {
  const total = asAmount(totalAmount);
  const requiredDownPayment = calculateRequiredDownPayment(total);

  if (total <= 0) {
    return {
      shouldRecord: false,
      canConfirm: false,
      appointmentStatus: 'pending',
      paymentFields: {
        paymentType: null,
        totalAmount: 0,
        amountPaid: 0,
        balanceDue: 0,
        paymentStatus: 'Unpaid',
        nextInstallmentDate: null,
      },
      requiredDownPayment: 0,
    };
  }

  if (!payment) {
    if (actorRole === 'admin' && allowAdminOverride) {
      return {
        shouldRecord: false,
        canConfirm: true,
        appointmentStatus: 'approved',
        paymentFields: {
          paymentType: null,
          totalAmount: total,
          amountPaid: 0,
          balanceDue: total,
          paymentStatus: 'Unpaid',
          nextInstallmentDate: null,
        },
        requiredDownPayment,
      };
    }
    throw new Error(`A payment of at least ${requiredDownPayment} is required to secure this appointment.`);
  }

  const paymentType = normalizePaymentType(payment.paymentType);
  if (!paymentType || !PAYMENT_TYPES.has(paymentType) || paymentType === 'balance_payment') {
    throw new Error('Payment type must be full_payment, down_payment, or partial_installment.');
  }

  const paymentMethod = normalizePaymentMethod(payment.paymentMethod);
  if (!paymentMethod) {
    throw new Error('Payment method must be simulated_gateway, card, gcash, bank_transfer, cash, or check.');
  }

  let amountPaid = asAmount(payment.amount ?? payment.amountPaid);
  let nextInstallmentDate = parseOptionalDate(payment.nextInstallmentDate);
  let finalPaymentType = paymentType;

  if (paymentType === 'full_payment') {
    amountPaid = total;
    nextInstallmentDate = null;
  } else if (paymentType === 'down_payment') {
    amountPaid = requiredDownPayment;
  } else if (!Number.isFinite(amountPaid)) {
    throw new Error('Enter a valid partial payment amount.');
  }

  if (amountPaid <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }

  if (amountPaid > total) {
    throw new Error('Payment amount cannot exceed the total consultation fee.');
  }

  if (amountPaid >= total) {
    amountPaid = total;
    finalPaymentType = 'full_payment';
    nextInstallmentDate = null;
  }

  if (amountPaid < requiredDownPayment && !(actorRole === 'admin' && allowAdminOverride)) {
    throw new Error(`Minimum down payment is ${requiredDownPayment} (30% of the consultation fee).`);
  }

  const summary = buildPaymentSummary({
    totalAmount: total,
    amountPaid,
    paymentType: finalPaymentType,
    nextInstallmentDate,
  });

  return {
    shouldRecord: true,
    canConfirm: amountPaid >= requiredDownPayment,
    appointmentStatus: amountPaid >= requiredDownPayment ? 'approved' : 'pending',
    paymentType: finalPaymentType,
    paymentMethod,
    amountPaid,
    nextInstallmentDate,
    notes: String(payment.notes || '').trim() || null,
    referenceNumber: String(payment.referenceNumber || '').trim() || null,
    requiredDownPayment,
    paymentFields: {
      paymentType: summary.paymentType,
      totalAmount: summary.totalAmount,
      amountPaid: summary.amountPaid,
      balanceDue: summary.balanceDue,
      paymentStatus: summary.paymentStatus,
      nextInstallmentDate: summary.nextInstallmentDate,
    },
  };
}

async function createInitialPayment({ appointment, plan, actor, session = null }) {
  if (!plan?.shouldRecord) return null;

  const payment = await Payment.create([{
    appointmentId: appointment._id,
    appointmentNumericId: appointment.id,
    amount: plan.amountPaid,
    totalAmount: plan.paymentFields.totalAmount,
    paymentType: plan.paymentType,
    balanceDue: plan.paymentFields.balanceDue,
    status: getTransactionStatus(plan.paymentFields.amountPaid, plan.paymentFields.totalAmount, plan.paymentType),
    transactionDate: new Date(),
    paymentMethod: plan.paymentMethod,
    nextInstallmentDate: plan.nextInstallmentDate,
    recordedBy: actor?.userId || null,
    recordedByRole: actor?.role || null,
    referenceNumber: plan.referenceNumber || makeReferenceNumber('KC-SIM'),
    notes: plan.notes,
  }], { session });

  return payment[0];
}

function canConfirmAppointment(appointment) {
  const total = asAmount(appointment?.totalAmount);
  if (total <= 0) {
    return {
      ok: true,
      totalAmount: total,
      amountPaid: 0,
      requiredDownPayment: 0,
      message: 'No consultation fee is configured for this appointment.',
    };
  }

  const amountPaid = asAmount(appointment?.amountPaid);
  const requiredDownPayment = calculateRequiredDownPayment(total);
  const overridden = Boolean(appointment?.paymentOverride?.isOverridden);
  const ok = amountPaid >= requiredDownPayment || overridden || appointment?.paymentStatus === 'Paid';

  return {
    ok,
    totalAmount: total,
    amountPaid,
    requiredDownPayment,
    message: ok
      ? null
      : `At least ${requiredDownPayment} must be paid before this appointment can be confirmed.`,
  };
}

function makeReferenceNumber(prefix = 'KC-PAY') {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

async function recordManualPayment({
  appointment,
  amountPaid,
  paymentMethod = 'cash',
  paymentType = 'balance_payment',
  nextInstallmentDate = null,
  notes = null,
  actor = null,
  session = null,
}) {
  const amount = asAmount(amountPaid);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }

  const method = normalizePaymentMethod(paymentMethod, 'cash');
  if (!method || !['cash', 'check', 'gcash', 'bank_transfer', 'card', 'simulated_gateway'].includes(method)) {
    throw new Error('Unsupported payment method.');
  }

  const type = normalizePaymentType(paymentType) || 'balance_payment';
  if (!['balance_payment', 'partial_installment', 'full_payment'].includes(type)) {
    throw new Error('Manual payment type must be balance_payment, partial_installment, or full_payment.');
  }

  const total = asAmount(appointment.totalAmount);
  const currentPaid = asAmount(appointment.amountPaid);
  const currentBalance = Math.max(roundCurrency(total - currentPaid), 0);

  if (total <= 0) {
    throw new Error('This appointment does not have a consultation fee to settle.');
  }

  if (currentBalance <= 0) {
    throw new Error('This appointment is already fully paid.');
  }

  if (amount > currentBalance) {
    throw new Error(`Payment amount cannot exceed the remaining balance of ${currentBalance}.`);
  }

  const newPaid = roundCurrency(currentPaid + amount);
  const summary = buildPaymentSummary({
    totalAmount: total,
    amountPaid: newPaid,
    paymentType: type === 'balance_payment' ? null : type,
    nextInstallmentDate: parseOptionalDate(nextInstallmentDate),
  });

  const payment = await Payment.create([{
    appointmentId: appointment._id,
    appointmentNumericId: appointment.id,
    amount,
    totalAmount: total,
    paymentType: type,
    balanceDue: summary.balanceDue,
    status: getTransactionStatus(summary.amountPaid, summary.totalAmount, type === 'balance_payment' ? null : type),
    transactionDate: new Date(),
    paymentMethod: method,
    nextInstallmentDate: summary.nextInstallmentDate,
    recordedBy: actor?.userId || null,
    recordedByRole: actor?.role || null,
    referenceNumber: makeReferenceNumber(method === 'cash' ? 'KC-CASH' : 'KC-PAY'),
    notes: String(notes || '').trim() || null,
  }], { session });

  appointment.totalAmount = summary.totalAmount;
  if (!appointment.paymentType && summary.paymentType) appointment.paymentType = summary.paymentType;
  appointment.amountPaid = summary.amountPaid;
  appointment.balanceDue = summary.balanceDue;
  appointment.paymentStatus = summary.paymentStatus;
  appointment.nextInstallmentDate = summary.nextInstallmentDate;
  await appointment.save({ session });

  return { payment: payment[0], summary };
}

async function getPaymentsForAppointment(appointmentId) {
  return Payment.find({ appointmentId }).sort({ transactionDate: -1, createdAt: -1 }).lean();
}

async function getPendingBalanceAppointments({ pediatricianId = null } = {}) {
  const query = {
    paymentStatus: 'Partially Paid',
    balanceDue: { $gt: 0 },
    status: { $nin: ['cancelled', 'rejected'] },
  };
  if (pediatricianId) query.pediatricianId = pediatricianId;
  return Appointment.find(query).sort({ appointmentDate: 1, appointmentTime: 1 }).lean();
}

async function withPaymentTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
    } catch (err) {
      if (!/Transaction numbers|replica set|mongos|transactions are not supported/i.test(err.message || '')) {
        throw err;
      }
      console.warn('MongoDB transactions unavailable for payments; retrying payment write without a session.');
      result = await work(null);
    }
    return result;
  } finally {
    await session.endSession();
  }
}

function serializePayment(payment) {
  if (!payment) return null;
  const amount = payment.amount ?? payment.amountPaid ?? 0;
  return {
    id: payment.id,
    appointmentId: payment.appointmentNumericId,
    amount,
    amountPaid: amount,
    totalAmount: payment.totalAmount,
    paymentType: payment.paymentType,
    paymentTypeLabel: paymentTypeLabel(payment.paymentType),
    balanceDue: payment.balanceDue,
    status: payment.status,
    transactionDate: payment.transactionDate,
    paymentMethod: payment.paymentMethod,
    nextInstallmentDate: payment.nextInstallmentDate,
    referenceNumber: payment.referenceNumber,
    receiptNumber: payment.referenceNumber,
    notes: payment.notes,
  };
}

function buildDeferredPaymentPlan({ totalAmount } = {}) {
  const total = asAmount(totalAmount);
  return {
    shouldRecord: false,
    canConfirm: false,
    appointmentStatus: 'pending',
    paymentFields: {
      paymentType: null,
      totalAmount: total,
      amountPaid: 0,
      balanceDue: total,
      paymentStatus: 'Pending Payment',
      nextInstallmentDate: null,
    },
    requiredDownPayment: calculateRequiredDownPayment(total),
  };
}

module.exports = {
  DOWN_PAYMENT_RATE,
  buildDeferredPaymentPlan,
  buildInitialPaymentPlan,
  buildPaymentSummary,
  calculateRequiredDownPayment,
  canConfirmAppointment,
  createInitialPayment,
  getPendingBalanceAppointments,
  getPaymentsForAppointment,
  appointmentPaymentTypeFor,
  normalizePaymentMethod,
  normalizePaymentType,
  paymentTypeLabel,
  recordManualPayment,
  roundCurrency,
  serializePayment,
  withPaymentTransaction,
};
