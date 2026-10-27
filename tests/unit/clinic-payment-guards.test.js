// Clinic payment confirmations (ADMIN bug scan P5, P7).
//
//   P5 Walk-in: two confirmations at once (double click, or a secretary and an
//      admin) both passed the status check and recorded two Paid cash
//      payments. The appointment is now claimed atomically; the loser gets 409.
//   P7 Pay at Clinic: a Refunded, Cancelled, Failed or Expired reference could
//      be confirmed and switched back to Paid. Only Pending / Verification
//      Pending references can be confirmed now.
//
// No DB: models are stubbed and the controller is called directly as an admin.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const Notification = require('../../models/Notification');
const Child = require('../../models/Child');
const User = require('../../models/User');
const receiptService = require('../../services/receiptService');
const controller = require('../../controllers/paymentController');

const adminId = String(new mongoose.Types.ObjectId());
const realError = console.error;
const call = async (fn, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  console.error = () => {};
  try { await fn({ user: { userId: adminId, role: 'admin' }, body: {}, ...req }, res); } finally { console.error = realError; }
  return res;
};

(async () => {
  Notification.create = async (n) => n;

  // ── P5: walk-in confirmed once, even when two requests race ─────────────
  const apptState = { _id: new mongoose.Types.ObjectId(), id: 41, pendingPaymentMode: 'walk_in', paymentStatus: 'Pending Payment', status: 'pending', totalAmount: 800, parentId: new mongoose.Types.ObjectId() };
  const doc = () => ({ ...apptState, async save() { Object.assign(apptState, { status: this.status }); } });
  // findOne(...) is awaited for the document and .lean()'d for the reply.
  Appointment.findOne = () => { const p = Promise.resolve(doc()); p.lean = async () => ({ ...apptState }); return p; };
  const leanNull = () => ({ lean: async () => null });
  Child.findById = leanNull;
  User.findById = leanNull;
  Appointment.findOneAndUpdate = async (filter, { $set }) => {
    await new Promise((r) => setImmediate(r));
    if (!filter.paymentStatus.$in.includes(apptState.paymentStatus)) return null;
    Object.assign(apptState, $set);
    return { ...apptState };
  };
  const created = [];
  Payment.create = async (rows) => { created.push(...rows); return rows; };

  const [a, b] = await Promise.all([
    call(controller.confirmWalkIn, { params: { appointmentId: '41' } }),
    call(controller.confirmWalkIn, { params: { appointmentId: '41' } }),
  ]);
  assert.deepStrictEqual([a.statusCode, b.statusCode].sort(), [200, 409], `one wins, one is told it is done: ${JSON.stringify([a.body, b.body])}`);
  assert.strictEqual(created.length, 1, 'exactly one cash payment is recorded');
  assert.strictEqual(apptState.paymentStatus, 'Paid');
  assert.strictEqual(apptState.status, 'approved');

  // ── P7: only an open Pay-at-Clinic reference can be confirmed ───────────
  const appt = { _id: new mongoose.Types.ObjectId(), id: 42, status: 'approved', totalAmount: 500, pediatricianId: new mongoose.Types.ObjectId() };
  Appointment.findById = () => { const p = Promise.resolve(appt); p.lean = async () => ({ ...appt }); return p; };
  let settled = 0;
  receiptService.settlePayment = async ({ paymentId }) => { settled += 1; return { alreadySettled: false, emailed: false, payment: { _id: paymentId, status: 'Paid', receiptNumber: 'R-1', paidAt: new Date(), amount: 500 } }; };
  for (const status of ['Refunded', 'Cancelled', 'Failed', 'Expired']) {
    Payment.findOne = async () => ({ _id: new mongoose.Types.ObjectId(), paymentRef: 'KC-PAY-9', paymentMethod: 'pay_at_clinic', status, totalAmount: 500, appointmentId: appt._id });
    const r = await call(controller.confirmClinicPayment, { params: { paymentRef: 'kc-pay-9' } });
    assert.strictEqual(r.statusCode, 409, `${status} cannot be confirmed`);
    assert.strictEqual(r.body.code, 'NOT_PAYABLE');
  }
  assert.strictEqual(settled, 0, 'nothing was settled');
  Payment.findOne = async () => ({ _id: new mongoose.Types.ObjectId(), paymentRef: 'KC-PAY-9', paymentMethod: 'pay_at_clinic', status: 'Pending', totalAmount: 500, appointmentId: appt._id, parentId: null });
  const r = await call(controller.confirmClinicPayment, { params: { paymentRef: 'KC-PAY-9' } });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(settled, 1, 'a Pending reference is still confirmed');

  console.log('Clinic payment guards OK — a walk-in is confirmed once under a race, and only an open Pay at Clinic reference can be confirmed');
})().catch((err) => {
  realError(err);
  process.exitCode = 1;
});
