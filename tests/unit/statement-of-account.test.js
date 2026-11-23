// Statement of Account, receipts for every confirmed payment, and the admin
// outstanding balance. All figures come from stored Payment rows; nothing here
// may write. No DB: models are in-memory stand-ins whose writers throw.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const SystemSetting = require('../../models/SystemSetting');
const { buildStatement } = require('../../services/statementOfAccount');
const Ops = require('../../services/adminOperationsAnalytics');
const controller = require('../../controllers/paymentController');

const oid = () => new mongoose.Types.ObjectId();
const parentId = oid(); const pediaId = oid(); const childId = oid();
const appt = { _id: oid(), id: 7, childId, parentId, pediatricianId: pediaId, totalAmount: 1000, status: 'approved', appointmentDate: new Date('2026-11-20'), appointmentTime: '09:00' };
const row = (status, amount, extra = {}) => ({ status, amount, paymentMethod: 'paymongo', paymentType: 'down_payment', transactionDate: new Date('2026-11-01'), ...extra });

function testStatement() {
  let s = buildStatement(appt, []);
  assert.deepStrictEqual([s.status, s.totalPaid, s.balanceDue, s.payments.length], ['Unpaid', 0, 1000, 0]);

  s = buildStatement(appt, [row('Pending', 500), row('Failed', 1000), row('Expired', 1000), row('Cancelled', 1000), row('Verification Pending', 500)]);
  assert.deepStrictEqual([s.status, s.totalPaid, s.balanceDue, s.payments.length], ['Unpaid', 0, 1000, 0]);

  const deposit = row('Paid', 500, { receiptNumber: 'KC-RCPT-2026-000001', paidAt: new Date('2026-11-02'), paymongoSourceType: 'gcash' });
  s = buildStatement(appt, [deposit, row('Pending', 500, { paymentType: 'balance_payment' })]);
  assert.deepStrictEqual([s.status, s.totalPaid, s.balanceDue], ['Partially Paid', 500, 500]);
  assert.strictEqual(s.payments[0].method, 'GCash');

  // Rows arrive newest first; the statement lists them oldest first.
  const balance = row('Paid', 500, { paymentType: 'balance_payment', paymentMethod: 'cash', referenceNumber: 'KC-CASH-X', transactionDate: new Date('2026-11-20') });
  s = buildStatement(appt, [balance, deposit]);
  assert.deepStrictEqual([s.status, s.totalPaid, s.balanceDue], ['Fully Paid', 1000, 0]);
  assert.deepStrictEqual(s.payments.map((p) => p.balanceAfter), [500, 0]);
  assert.strictEqual(s.payments[1].receiptNumber, null);
  assert.strictEqual(s.payments[1].reference, 'KC-CASH-X');
  assert.deepStrictEqual(s.payments[1].date, new Date('2026-11-20'));

  // Staff deposits and installments are money received.
  s = buildStatement(appt, [row('Down Payment', 500), row('Partially Paid', 200)]);
  assert.deepStrictEqual([s.status, s.totalPaid, s.balanceDue], ['Partially Paid', 700, 300]);

  s = buildStatement(appt, [row('Refunded', 500)]);
  assert.deepStrictEqual([s.status, s.totalPaid, s.totalRefunded, s.balanceDue, s.payments[0].refunded], ['Unpaid', 0, 500, 1000, true]);

  s = buildStatement({ ...appt, status: 'cancelled' }, [row('Paid', 500)]);
  assert.deepStrictEqual([s.closed, s.totalPaid, s.balanceDue], [true, 500, 0]);

  s = buildStatement({ ...appt, totalAmount: 0 }, []);
  assert.deepStrictEqual([s.status, s.balanceDue], ['No Fee', 0]);
}

function testOutstanding() {
  assert.deepStrictEqual(
    Ops.summarizeOutstanding([{ totalAmount: 1000, paid: 0 }, { totalAmount: 1000, paid: 500 }, { totalAmount: 1000, paid: 1000 }, { totalAmount: 500, paid: 600 }, { _id: 'pending', count: 3 }]),
    { amount: 1500, unpaid: 1, partiallyPaid: 1, fullyPaid: 2 }
  );
  const [first] = Ops.outstandingPipeline();
  assert.deepStrictEqual(first.$match.status, { $nin: ['cancelled', 'rejected'] });
  assert.deepStrictEqual(first.$match.isSynthetic, { $ne: true });
}

// ── Endpoints ───────────────────────────────────────────────────────────────
let rows = [];
let found = null;
const lean = (v) => ({ lean: async () => v, select: () => ({ lean: async () => v }) });
Appointment.findOne = (q) => lean(q.id === appt.id ? appt : null);
Appointment.findById = () => lean(appt);
Payment.find = () => ({ sort: () => ({ lean: async () => rows }) });
Payment.findOne = async () => found;
const pediaClinic = { clinicName: 'Pedia Clinic', clinicAddress: 'J Catolico Avenue', phoneNumber: null };
User.findById = (id) => lean({ ...(String(id) === String(pediaId) ? pediaClinic : {}), _id: parentId, firstName: 'Ana', lastName: 'Cruz', email: 'a@example.com' });
Child.findById = () => lean({ _id: childId, firstName: 'Leo', lastName: 'Cruz' });
// getClinic() is the existing upsert-if-missing settings read used by receipts.
SystemSetting.getClinic = async () => ({ clinicName: 'Test Clinic', address: 'Profile address', phoneNumber: '+63 1' });
for (const M of [Payment, Appointment]) {
  for (const m of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'insertMany', 'deleteOne', 'deleteMany']) {
    M[m] = () => { throw new Error(`must not write (${M.modelName}.${m})`); };
  }
}
for (const m of ['nextReceiptNumber', 'nextPaymentRef']) Payment[m] = () => { throw new Error('must not allocate numbers'); };

const GuardianLink = require('../../models/GuardianLink');
GuardianLink.findOne = () => lean(null);

async function call(handler, params, user) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params, user, query: {}, body: {} }, res);
  return res;
}

async function testEndpoints() {
  const parent = { userId: String(parentId), role: 'parent' };
  rows = [row('Paid', 500)];
  const params = { appointmentId: '7' };
  let r = await call(controller.getAppointmentStatement, params, parent);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.statement.childName, 'Leo Cruz');
  assert.strictEqual(r.body.statement.balanceDue, 500);
  // The pediatrician's clinic details; a blank one falls back to Clinic Profile.
  assert.deepStrictEqual(r.body.statement.issuer, { clinicName: 'Pedia Clinic', address: 'J Catolico Avenue', phoneNumber: '+63 1' });
  // Recorded later: the same request now shows the new balance.
  rows = [row('Paid', 500), row('Paid', 500)];
  r = await call(controller.getAppointmentStatement, params, { userId: String(pediaId), role: 'pediatrician' });
  assert.strictEqual(r.body.statement.status, 'Fully Paid');
  r = await call(controller.getAppointmentStatement, params, { userId: String(oid()), role: 'secretary', linkedPediatricianId: String(pediaId) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual((await call(controller.getAppointmentStatement, params, { userId: String(oid()), role: 'admin' })).statusCode, 200);

  for (const user of [
    { userId: String(oid()), role: 'parent' },
    { userId: String(oid()), role: 'pediatrician' },
    { userId: String(oid()), role: 'secretary', linkedPediatricianId: String(oid()) },
  ]) assert.strictEqual((await call(controller.getAppointmentStatement, params, user)).statusCode, 403, user.role);
  assert.strictEqual((await call(controller.getAppointmentStatement, { appointmentId: 'x' }, parent)).statusCode, 404);

  const receipt = async (status, extra, user = parent) => {
    found = { _id: oid(), appointmentId: appt._id, referenceNumber: 'KC-CASH-X', balanceDue: 500, ...row(status, 500, extra) };
    return call(controller.getPaymentReceipt, { paymentRef: 'KC-CASH-X' }, user);
  };
  for (const status of ['Paid', 'Down Payment', 'Partially Paid', 'Refunded']) {
    r = await receipt(status, { paymentType: 'partial_installment' });
    assert.strictEqual(r.statusCode, 200, status);
    assert.strictEqual(r.body.receipt.paymentTypeLabel, 'Partial payment');
    assert.deepStrictEqual(r.body.receipt.paidAt, new Date('2026-11-01'));
    assert.strictEqual(r.body.receipt.amount, 500);
    assert.strictEqual(r.body.receipt.issuer.clinicName, 'Pedia Clinic');
    assert.strictEqual(r.body.receipt.clinic.clinicName, 'Test Clinic');
  }
  for (const status of ['Pending', 'Verification Pending', 'Failed', 'Expired', 'Cancelled']) {
    assert.strictEqual((await receipt(status)).statusCode, 409, status);
  }
  assert.strictEqual((await receipt('Down Payment', {}, { userId: String(oid()), role: 'parent' })).statusCode, 403);
}

(async () => {
  testStatement();
  testOutstanding();
  await testEndpoints();
  console.log('Statement of account OK — balances from actual payments, receipts for every confirmed payment, access per appointment, outstanding totals, no writes');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
