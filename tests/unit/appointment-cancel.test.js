// Regression test for POST /api/appointments/:appointmentId/cancel.
//
// The bug: cancel had no status check, so a completed, rejected or already
// cancelled booking could be cancelled again, and every cancel overwrote the
// payment status with 'Cancelled' — erasing 'Paid' on a booking that had
// already been paid for.
//
// No DB and no network: model statics are monkey-patched and the handler is
// called directly from the router stack, as in the reschedule tests.
const assert = require('assert');
const mongoose = require('mongoose');

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Payment = require('../../models/Payment');
const Notification = require('../../models/Notification');

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const router = require('../../routes/appointments');

function chain(value) {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

const layer = router.stack.find((l) => l.route && l.route.path === '/:appointmentId/cancel' && l.route.methods.post);
assert(layer, 'POST /:appointmentId/cancel exists');
const cancel = layer.route.stack[layer.route.stack.length - 1].handle;

function call(user, appointmentId) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(cancel({ user, params: { appointmentId: String(appointmentId) }, body: {}, query: {} }, res)).catch(reject);
  });
}

const parentId = new mongoose.Types.ObjectId();
const pediaId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();
const parent = { userId: String(parentId), role: 'parent' };

let appointments;
let saves;

function makeAppt(fields) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    parentId, pediatricianId: pediaId, childId,
    appointmentDate: new Date('2030-01-07'), appointmentTime: '09:00',
    totalAmount: 1000, amountPaid: 0, balanceDue: 1000, paymentStatus: 'Pending Payment',
    ...fields,
  };
  doc.save = async function save() { saves.push(this.id); };
  doc.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
  return doc;
}

Appointment.findOne = (q) => chain(appointments.find((a) => a.id === q.id) || null);
User.findById = (id) => chain({ _id: id, firstName: 'Ana', lastName: 'Cruz', email: '' });
User.findOne = () => chain(null);
const otherParentId = new mongoose.Types.ObjectId();
const otherChildId = new mongoose.Types.ObjectId();
Child.findById = (id) => chain(String(id) === String(otherChildId)
  ? { _id: otherChildId, parentId: otherParentId, firstName: 'Other', lastName: 'Child' }
  : { _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto' });
GuardianLink.findOne = () => chain(null);
Payment.find = () => chain([]);
Payment.findOne = () => chain(null);
Notification.create = async (n) => n;

const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const ok = (m) => console.log('  ok -', m);

(async () => {
  appointments = [
    makeAppt({ id: 1, status: 'pending' }),
    makeAppt({ id: 2, status: 'approved', paymentStatus: 'Paid', amountPaid: 1000, balanceDue: 0 }),
    makeAppt({ id: 3, status: 'approved', paymentStatus: 'Down Payment', amountPaid: 300, balanceDue: 700 }),
    makeAppt({ id: 4, status: 'completed', paymentStatus: 'Paid', amountPaid: 1000, balanceDue: 0 }),
    makeAppt({ id: 5, status: 'cancelled', paymentStatus: 'Cancelled' }),
    makeAppt({ id: 6, status: 'rejected', paymentStatus: 'Cancelled' }),
    makeAppt({ id: 7, status: 'pending', parentId: otherParentId, childId: otherChildId }),
  ];
  const byId = (id) => appointments.find((a) => a.id === id);

  // 1. An unpaid pending booking cancels, and its payment status becomes Cancelled.
  saves = [];
  let r = await quiet(() => call(parent, 1));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(byId(1).status, 'cancelled');
  assert.strictEqual(byId(1).paymentStatus, 'Cancelled');
  ok('unpaid pending booking: cancelled, payment status Cancelled');

  // 2. A paid booking cancels but stays Paid, with the amount untouched.
  r = await quiet(() => call(parent, 2));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(byId(2).status, 'cancelled');
  assert.strictEqual(byId(2).paymentStatus, 'Paid', 'Paid must not be overwritten');
  assert.strictEqual(byId(2).amountPaid, 1000);
  ok('paid approved booking: cancelled, payment status stays Paid');

  // 3. A part-paid booking also keeps its payment status.
  r = await quiet(() => call(parent, 3));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(byId(3).paymentStatus, 'Down Payment');
  assert.strictEqual(byId(3).amountPaid, 300);
  ok('down-payment booking: cancelled, payment status stays Down Payment');

  // 4. Completed, cancelled and rejected bookings are refused and left unchanged.
  for (const [id, was] of [[4, 'completed'], [5, 'cancelled'], [6, 'rejected']]) {
    saves = [];
    const before = { ...byId(id) };
    r = await quiet(() => call(parent, id));
    assert.strictEqual(r.status, 400, `${was}: expected 400`);
    assert.match(r.body.error, new RegExp(`A ${was} appointment cannot be cancelled`));
    assert.strictEqual(byId(id).status, before.status);
    assert.strictEqual(byId(id).paymentStatus, before.paymentStatus);
    assert.deepStrictEqual(saves, [], `${was}: nothing saved`);
  }
  ok('completed, cancelled and rejected bookings: 400, nothing saved');

  // 5. Another family's booking is still refused.
  r = await quiet(() => call(parent, 7));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(byId(7).status, 'pending');
  ok("another parent's booking: 403, unchanged");

  console.log('\nAppointment cancel tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
