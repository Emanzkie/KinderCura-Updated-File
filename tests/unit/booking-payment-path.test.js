// Regression test for POST /api/appointments/create payment handling.
//
// The bug: only role 'parent' got the deferred pay-later plan. Every other
// role, including the parent-side roles legal_guardian, foster_parent and
// court_appointed, went down the clinic-staff path, which trusts
// req.body.payment. A guardian could send { paymentType: 'full_payment',
// paymentMethod: 'cash' } and get an approved, fully paid booking; without
// that payload the booking failed outright.
//
// No DB and no network: model statics are monkey-patched and the handler is
// called directly from the router stack, as in the reschedule tests.
const assert = require('assert');
const mongoose = require('mongoose');

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Notification = require('../../models/Notification');
const SystemSetting = require('../../models/SystemSetting');
const paymentService = require('../../services/paymentService');

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const router = require('../../routes/appointments');

function chain(value) {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q, session: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

const layer = router.stack.find((l) => l.route && l.route.path === '/create' && l.route.methods.post);
assert(layer, 'POST /create exists');
const create = layer.route.stack[layer.route.stack.length - 1].handle;

function call(user, body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(create({ user, body, params: {}, query: {} }, res)).catch(reject);
  });
}

// Next Monday at least a week out, so the date is never in the past.
const MONDAY = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

const pediaId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();
const pediatrician = {
  _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz', email: '',
  consultationFee: 1000,
  availability: { days: ['Monday'], startTime: '08:00', endTime: '17:00', maxPatientsPerDay: 50, breaks: [] },
};

let created;
let recordedPayments;
let nextId = 1;

SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
Child.findById = () => chain({ _id: childId, parentId: ownerId, firstName: 'Kemri', lastName: 'Soto' });
// Every non-owner caller in this test is a linked guardian allowed to manage appointments.
GuardianLink.findOne = () => chain({ childId, status: 'active', permissions: { manageAppointments: true } });
User.findById = (id) => chain({ _id: id, firstName: 'Caller', lastName: 'X', email: '' });
User.findOne = (q) => chain(String(q._id) === String(pediaId) ? pediatrician : null);
Appointment.find = () => chain([]);
Appointment.create = async (docs) => docs.map((d) => {
  const doc = { ...d, id: nextId++ };
  created.push(doc);
  return doc;
});
Notification.create = async (n) => n;
paymentService.withPaymentTransaction = async (work) => work(null);
paymentService.createInitialPayment = async ({ plan }) => {
  recordedPayments.push(plan);
  return { amount: plan.amountPaid, status: 'Paid' };
};

const FAKE_CASH = { paymentType: 'full_payment', paymentMethod: 'cash' };
const booking = (extra = {}) => ({
  childId: String(childId), pediatricianId: String(pediaId), appointmentDate: MONDAY, appointmentTime: '09:00', ...extra,
});
const reset = () => { created = []; recordedPayments = []; };
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. Parent-side roles: a forged cash payment is ignored; the booking is unpaid and pending.
  for (const role of ['parent', 'legal_guardian', 'foster_parent', 'court_appointed']) {
    reset();
    const user = { userId: String(new mongoose.Types.ObjectId()), role };
    const { status, body } = await quiet(() => call(user, booking({ payment: FAKE_CASH, overridePayment: true })));
    assert.strictEqual(status, 201, `${role}: booking should succeed, got ${status} ${JSON.stringify(body)}`);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].status, 'pending', `${role}: must stay pending`);
    assert.strictEqual(created[0].paymentStatus, 'Pending Payment', `${role}: must not be marked paid`);
    assert.strictEqual(created[0].amountPaid, 0, `${role}: nothing paid`);
    assert.strictEqual(created[0].balanceDue, 1000, `${role}: full fee still due`);
    assert.strictEqual(recordedPayments.length, 0, `${role}: no payment record written`);
    assert.match(body.redirectTo || '', /payment\.html\?appointmentId=/, `${role}: sent to the payment page`);
  }
  ok('parent, legal_guardian, foster_parent, court_appointed: forged cash payment ignored, booking pending and unpaid');

  // 2. Parent-side roles without a payment payload no longer fail.
  for (const role of ['legal_guardian', 'foster_parent', 'court_appointed']) {
    reset();
    const { status } = await quiet(() => call({ userId: String(new mongoose.Types.ObjectId()), role }, booking()));
    assert.strictEqual(status, 201, `${role}: plain booking should succeed`);
  }
  ok('guardian roles can book without a payment payload (previously rejected)');

  // 3. Admin still uses the clinic-staff upfront-payment path.
  reset();
  const { status, body } = await quiet(() => call({ userId: String(new mongoose.Types.ObjectId()), role: 'admin' }, booking({ payment: FAKE_CASH })));
  assert.strictEqual(status, 201);
  assert.strictEqual(created[0].status, 'approved');
  assert.strictEqual(created[0].amountPaid, 1000);
  assert.strictEqual(recordedPayments.length, 1, 'admin cash payment is recorded');
  assert.strictEqual(body.redirectTo, null);
  ok('admin booking still records the upfront payment (staff path unchanged)');

  console.log('\nBooking payment path tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
