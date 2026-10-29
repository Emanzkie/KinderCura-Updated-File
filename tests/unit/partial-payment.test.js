// 50% online deposit, 50% at the clinic.
//
// - Pay Online charges half the pediatrician's fee; a second deposit is refused.
// - Pay at Clinic is refused before the deposit; afterwards it is the balance.
// - Settling the deposit records 50%, sets 'Down Payment', approves the booking
//   and creates one Pay at Clinic balance row; a replay changes nothing.
// - The Cashier looks the balance up and confirms it once; the booking is Paid.
// - The pediatrician can record it too (collect-balance), but not another
//   clinic or a secretary without Manage Payments.
// - Old full-payment rows still settle for the whole fee; refunds return the
//   online deposit; the 50% rate also governs approval and staff down payments.
//
// No DB, no network: models, PayMongo and email are stubbed in memory.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const SystemSetting = require('../../models/SystemSetting');
const paymongo = require('../../services/paymongoService');
const paymentService = require('../../services/paymentService');
const receiptService = require('../../services/receiptService');
const refundService = require('../../services/refundService');
const controller = require('../../controllers/paymentController');

const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();

// ── In-memory helpers ──────────────────────────────────────────────────────
const query = (value) => {
  const q = { lean: () => q, sort: () => q, select: () => q, session: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};
const same = (a, b) => String(a) === String(b);
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId)) {
    if ('$in' in v) return v.$in.some((x) => same(x, doc[k]));
    if ('$ne' in v) return !same(v.$ne, doc[k]);
  }
  return same(v, doc[k]);
});
const asDoc = (row) => Object.assign(row, { save: async () => row, toObject: () => ({ ...row }) });

const pediaId = oid();
const otherPedia = oid();
const parentId = oid();
const secretaryId = oid();
let state;
let seq;
function reset({ appointment = {}, payments = [] } = {}) {
  seq = 0;
  state = {
    appointment: asDoc({
      _id: oid(), id: 501, parentId, childId: oid(), pediatricianId: pediaId, status: 'pending',
      paymentStatus: 'Pending Payment', totalAmount: 950, amountPaid: 0, balanceDue: 950,
      appointmentDate: new Date(), appointmentTime: '10:00', reason: 'Check-up', ...appointment,
    }),
    payments: payments.map(asDoc),
    checkouts: [],
    notifications: [],
    secretaryPerms: { managePayments: true },
  };
}

Appointment.findOne = () => query(state.appointment);
Appointment.findById = () => query(state.appointment);
Payment.findOne = (f) => query([...state.payments].reverse().find((p) => matches(p, f)) || null);
Payment.findById = (id) => query(state.payments.find((p) => same(p._id, id)) || null);
Payment.exists = async (f) => state.payments.some((p) => matches(p, f)) || null;
Payment.create = async (doc) => { const row = asDoc({ _id: oid(), createdAt: new Date(), ...doc }); state.payments.push(row); return row; };
Payment.nextPaymentRef = async () => `KC-PAY-2026-${String(900 + (seq += 1)).padStart(6, '0')}`;
Payment.nextReceiptNumber = async () => `KC-RCPT-2026-${String(seq += 1).padStart(6, '0')}`;
Payment.findOneAndUpdate = (f, u) => {
  // The receipt-email claim is answered "already sent", so no email is built.
  if ('receiptSentAt' in f) return query(null);
  const row = state.payments.find((p) => matches(p, f));
  if (row) Object.assign(row, u.$set || {});
  return query(row || null);
};
Child.findById = () => query({ firstName: 'Kemri', lastName: 'Soto' });
User.findById = (id) => query(same(id, secretaryId)
  ? { _id: secretaryId, status: 'active', linkedPediatricianId: pediaId, secretaryPermissions: state.secretaryPerms }
  : { firstName: 'Ana', lastName: 'Soto', email: 'ana@example.invalid' });
Notification.create = async (doc) => { state.notifications.push(doc); return doc; };
SystemSetting.getClinic = async () => ({ clinicName: 'KinderCura Clinic', onlinePaymentEnabled: true, payAtClinicEnabled: true });
paymongo.isConfigured = () => true;
paymongo.createCheckoutSession = async (args) => { state.checkouts.push(args); return { id: 'cs_1', checkoutUrl: 'https://checkout.test/cs_1', paymentIntentId: 'pi_1' }; };
const quiet = console.error;

const parent = { userId: String(parentId), role: 'parent' };
const pedia = { userId: String(pediaId), role: 'pediatrician' };
const secretary = { userId: String(secretaryId), role: 'secretary' };
const call = async (handler, user, params = {}, body = {}) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user, params, body, protocol: 'https', get: () => 'kindercura.test' }, res);
  return res;
};
const deposit = () => state.payments.find((p) => p.paymentType === 'down_payment');
const balanceRows = () => state.payments.filter((p) => p.paymentType === 'balance_payment');

(async () => {
  console.error = () => {};
  try {
    // 1. Rate: one 50% rule everywhere.
    assert.strictEqual(paymentService.DOWN_PAYMENT_RATE, 0.5);
    assert.strictEqual(paymentService.calculateRequiredDownPayment(950), 475);
    assert.strictEqual(paymentService.calculateRequiredDownPayment(401), 200.5);
    assert.strictEqual(paymentService.canConfirmAppointment({ totalAmount: 400, amountPaid: 150 }).ok, false);
    assert.strictEqual(paymentService.canConfirmAppointment({ totalAmount: 400, amountPaid: 200 }).ok, true);
    const plan = paymentService.buildInitialPaymentPlan({ totalAmount: 400, payment: { paymentType: 'down_payment', paymentMethod: 'cash' } });
    assert.strictEqual(plan.amountPaid, 200);
    assert.throws(() => paymentService.buildInitialPaymentPlan({ totalAmount: 400, payment: { paymentType: 'partial_installment', paymentMethod: 'cash', amount: 120 } }), /Minimum down payment is 200 \(50% of the consultation fee\)/);
    ok('the deposit is 50% of the fee: online, staff-recorded down payments and approval all use it');

    // 2. Without an e-wallet: Pay at Clinic is the whole fee in cash (unchanged).
    //    Switching to Pay Online reuses that reference as the 50% deposit.
    reset();
    let res = await call(controller.startPayAtClinic, parent, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual([res.body.amount, res.body.isBalance], [950, false], 'full fee at the counter');
    assert.strictEqual(state.payments.length, 1);
    assert.deepStrictEqual([state.payments[0].paymentMethod, state.payments[0].paymentType, state.payments[0].status], ['pay_at_clinic', 'full_payment', 'Pending']);
    assert.deepStrictEqual([state.appointment.paymentStatus, state.appointment.status, state.appointment.amountPaid], ['Pending Payment', 'pending', 0], 'nothing paid until the secretary confirms');
    const clinicRef = state.payments[0].paymentRef;
    SystemSetting.getClinic = async () => ({ clinicName: 'KinderCura Clinic', onlinePaymentEnabled: true, payAtClinicEnabled: false });
    reset();
    res = await call(controller.startPayAtClinic, parent, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 503, 'the admin switch still turns full Pay at Clinic off');
    SystemSetting.getClinic = async () => ({ clinicName: 'KinderCura Clinic', onlinePaymentEnabled: true, payAtClinicEnabled: true });
    reset();
    await call(controller.startPayAtClinic, parent, { appointmentId: '501' });
    res = await call(controller.startOnlineCheckout, parent, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(state.checkouts[0].amount, 475, 'PayMongo is asked for half the fee');
    assert.deepStrictEqual([res.body.amount, res.body.totalAmount, res.body.balanceAtClinic], [475, 950, 475]);
    assert.strictEqual(deposit().paymentType, 'down_payment');
    assert.strictEqual(deposit().status, 'Pending');
    assert.strictEqual(state.payments.length, 1, 'the clinic reference is reused, now as the online deposit');
    assert.ok(clinicRef, 'a full Pay at Clinic reference was issued');
    assert.strictEqual(state.appointment.amountPaid, 0, 'nothing is recorded as paid before PayMongo confirms');
    ok('Pay at Clinic still gives a full-fee QR (and obeys its switch); Pay Online opens a PayMongo checkout for 50% and records nothing yet');

    // 3. PayMongo confirms the deposit (the reconcile path asks PayMongo itself).
    paymongo.retrieveCheckoutSession = async () => ({});
    paymongo.readSessionOutcome = () => ({ isPaid: true, paymentId: 'pay_1', status: 'paid' });
    res = await call(controller.reconcileCheckout, parent, { paymentRef: deposit().paymentRef });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.paid, true);
    assert.deepStrictEqual([deposit().status, deposit().amount, deposit().balanceDue, deposit().paymentType], ['Paid', 475, 475, 'down_payment']);
    assert.ok(deposit().receiptNumber, 'the deposit gets its own receipt');
    assert.deepStrictEqual(
      [state.appointment.amountPaid, state.appointment.balanceDue, state.appointment.paymentStatus, state.appointment.status],
      [475, 475, 'Down Payment', 'approved']
    );
    assert.strictEqual(balanceRows().length, 1, 'one balance row for the clinic');
    assert.ok(state.notifications.some((n) => same(n.userId, parentId) && /remaining ₱475.00 is due at the clinic/.test(n.message)), 'the parent is told what is due at the clinic');
    assert.ok(state.notifications.some((n) => same(n.userId, pediaId) && /partly paid \(deposit\)/.test(n.message)), 'the pediatrician is told it is a deposit');
    assert.deepStrictEqual([balanceRows()[0].paymentMethod, balanceRows()[0].status], ['pay_at_clinic', 'Pending']);
    assert.match(balanceRows()[0].paymentRef, /^KC-PAY-2026-\d{6}$/);
    const again = await receiptService.settlePayment({ paymentId: deposit()._id, method: 'paymongo' });
    assert.strictEqual(again.alreadySettled, true);
    assert.strictEqual(state.appointment.amountPaid, 475, 'a replayed confirmation does not count twice');
    assert.strictEqual(balanceRows().length, 1);
    res = await call(controller.startOnlineCheckout, parent, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'DEPOSIT_ALREADY_PAID');
    ok('a confirmed deposit records 50%, sets Down Payment, approves, and opens one clinic balance; replays and second deposits change nothing');

    // 4. The parent's balance QR and the Cashier lookup show the balance.
    res = await call(controller.startPayAtClinic, parent, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual([res.body.paymentRef, res.body.amount, res.body.amountPaid], [balanceRows()[0].paymentRef, 475, 475]);
    assert.strictEqual(balanceRows().length, 1, 'the same balance reference is reused');
    const ref = balanceRows()[0].paymentRef;
    res = await call(controller.lookupClinicPayment, secretary, { paymentRef: ref });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.canConfirm, true);
    assert.deepStrictEqual([res.body.payment.amountDue, res.body.payment.isBalance, res.body.payment.paidSoFar], [475, true, 475]);
    ok('the parent gets a clinic QR for the remaining 50%; the Cashier sees it as a balance with what was paid online');

    // 5. The Cashier confirms the balance: Paid, once.
    res = await call(controller.confirmClinicPayment, secretary, { paymentRef: ref });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.amount, 475);
    assert.deepStrictEqual([balanceRows()[0].status, balanceRows()[0].amount, balanceRows()[0].balanceDue], ['Paid', 475, 0]);
    assert.deepStrictEqual(
      [state.appointment.amountPaid, state.appointment.balanceDue, state.appointment.paymentStatus],
      [950, 0, 'Paid']
    );
    assert.notStrictEqual(balanceRows()[0].receiptNumber, deposit().receiptNumber, 'each half has its own receipt');
    res = await call(controller.confirmClinicPayment, secretary, { paymentRef: ref });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(state.appointment.amountPaid, 950);
    ok('the Cashier confirms the balance once: the booking becomes Paid with ₱950 collected in two receipts');

    // 6. Pediatrician records the balance from the appointment card.
    reset({ appointment: { status: 'approved', paymentStatus: 'Down Payment', amountPaid: 475, balanceDue: 475 } });
    res = await call(controller.collectBalance, { userId: String(otherPedia), role: 'pediatrician' }, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 403, 'another clinic');
    state.secretaryPerms = { managePayments: false };
    res = await call(controller.collectBalance, secretary, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 403, 'secretary without Manage Payments');
    res = await call(controller.collectBalance, parent, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 403, 'parents cannot record payments');
    assert.strictEqual(balanceRows().length, 0, 'refused calls create nothing');
    res = await call(controller.collectBalance, pedia, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual([state.appointment.paymentStatus, state.appointment.amountPaid], ['Paid', 950]);
    res = await call(controller.collectBalance, pedia, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 409, 'nothing left to record');
    reset({ appointment: { status: 'approved' } });
    res = await call(controller.collectBalance, pedia, { appointmentId: '501' });
    assert.strictEqual(res.statusCode, 409, 'no deposit yet, so no clinic balance');
    ok('the pediatrician can record the clinic balance once; other clinics, unpermitted secretaries and parents cannot');

    // 7. An older full Pay at Clinic reference still settles for the whole fee.
    reset({ appointment: { status: 'approved' }, payments: [{ _id: oid(), appointmentId: null, paymentRef: 'KC-PAY-2026-000063', paymentMethod: 'pay_at_clinic', paymentType: 'full_payment', status: 'Pending', totalAmount: 950, amount: 0 }] });
    state.payments[0].appointmentId = state.appointment._id;
    res = await call(controller.lookupClinicPayment, secretary, { paymentRef: 'KC-PAY-2026-000063' });
    assert.strictEqual(res.body.payment.amountDue, 950);
    res = await call(controller.confirmClinicPayment, secretary, { paymentRef: 'KC-PAY-2026-000063' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual([state.payments[0].amount, state.appointment.paymentStatus, state.appointment.amountPaid], [950, 'Paid', 950]);
    assert.strictEqual(balanceRows().length, 0);
    ok('a full Pay at Clinic reference issued before this change still settles for the whole fee');

    // 8. Refunds return the online deposit only.
    reset({ appointment: { status: 'cancelled', paymentStatus: 'Down Payment', amountPaid: 475, balanceDue: 475 }, payments: [] });
    await Payment.create({ appointmentId: state.appointment._id, paymentMethod: 'paymongo', paymentType: 'down_payment', status: 'Paid', amount: 475, totalAmount: 950, paidAt: new Date() });
    const refundable = await refundService.findRefundablePayment(state.appointment);
    assert.strictEqual(refundable.amount, 475);
    ok('a cancelled booking refunds the 50% paid online');

    console.log('Partial payment tests OK');
  } finally {
    console.error = quiet;
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
