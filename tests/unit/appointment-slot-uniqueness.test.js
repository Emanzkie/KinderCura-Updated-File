// One live booking per pediatrician slot (PEDIATRICIAN_BUGS.md #5).
//
// POST /create checked availability and then inserted as two separate steps,
// and nothing in the database refused a second booking for the same
// pediatrician, date and time, so two parents picking the same slot at the same
// moment both succeeded. The Appointment model now carries a partial unique
// index for pending/approved bookings, and the routes turn the resulting
// duplicate-key error into a 409.
//
// No DB: the model's schema is inspected directly, and the create handler is
// called from the router stack with the model statics stubbed. (The unique
// index itself is enforced by MongoDB, so what is verified here is its
// definition, the field it relies on, and how the routes react to its error.)
const assert = require('assert');
const mongoose = require('mongoose');

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const SystemSetting = require('../../models/SystemSetting');
const paymentService = require('../../services/paymentService');

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const router = require('../../routes/appointments');

const results = [];
const ok = (label) => results.push(label);

const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q, session: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
};

const pediaId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();

(async () => {
  // ── The index and the field behind it ───────────────────────────────────
  const [fields, options] = Appointment.schema.indexes()
    .find(([, opts]) => opts && opts.name === Appointment.SLOT_INDEX_NAME) || [];
  assert(fields, 'the one-live-booking-per-slot index is defined');
  assert.deepStrictEqual(fields, { pediatricianId: 1, appointmentDate: 1, appointmentTime: 1 });
  assert.strictEqual(options.unique, true);
  assert.deepStrictEqual(options.partialFilterExpression, { slotHeld: true });
  ok('a partial unique index covers pediatrician + date + time for slotHeld bookings');

  for (const [status, held] of [['pending', true], ['approved', true], ['completed', false], ['cancelled', false], ['rejected', false]]) {
    const doc = new Appointment({
      id: 1, childId, pediatricianId: pediaId, appointmentDate: new Date('2030-01-07T00:00:00Z'),
      appointmentTime: '09:00', status,
    });
    await doc.validate();
    assert.strictEqual(doc.slotHeld, held, `${status} -> slotHeld ${held}`);
  }
  const reopened = new Appointment({ id: 2, childId, appointmentDate: new Date(), appointmentTime: '09:00', status: 'pending' });
  await reopened.validate();
  reopened.status = 'cancelled';
  await reopened.validate();
  assert.strictEqual(reopened.slotHeld, false, 'cancelling releases the slot on the next save');
  ok('slotHeld follows the status: pending/approved hold the slot, closed bookings release it');

  // ── POST /create ────────────────────────────────────────────────────────
  const pediatrician = {
    _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz', email: '',
    consultationFee: 0,
    availability: { days: ['Monday'], startTime: '08:00', endTime: '17:00', maxPatientsPerDay: 50, breaks: [] },
  };
  const monday = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 7);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  let notifications = [];
  SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
  Child.findById = () => chain({ _id: childId, parentId: ownerId, firstName: 'Kemri', lastName: 'Soto' });
  User.findById = (id) => chain({ _id: id, firstName: 'Caller', lastName: 'X', email: '' });
  User.findOne = (q) => chain(String(q._id) === String(pediaId) ? pediatrician : null);
  Appointment.find = () => chain([]);
  Notification.create = async (n) => { notifications.push(n); return n; };
  paymentService.withPaymentTransaction = async (work) => work(null);

  const createLayer = router.stack.find((l) => l.route && l.route.path === '/create' && l.route.methods.post);
  const create = createLayer.route.stack[createLayer.route.stack.length - 1].handle;
  const book = () => new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    const body = { childId: String(childId), pediatricianId: String(pediaId), appointmentDate: monday, appointmentTime: '09:00' };
    Promise.resolve(create({ user: { userId: String(ownerId), role: 'parent' }, body, params: {}, query: {} }, res)).catch(reject);
  });
  const quiet = async (fn) => {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try { return await fn(); } finally { Object.assign(console, saved); }
  };
  const dupError = (index) => Object.assign(
    new Error(`E11000 duplicate key error collection: kindercura.appointments index: ${index} dup key: { x: 1 }`),
    { code: 11000 }
  );

  Appointment.create = async () => { throw dupError(Appointment.SLOT_INDEX_NAME); };
  let r = await quiet(book);
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /just booked by someone else/);
  assert.strictEqual(notifications.length, 0, 'nobody is notified of a booking that did not happen');
  ok('creating a booking whose slot was just taken returns 409 and notifies no one');

  Appointment.create = async () => { throw dupError('id_1'); };
  r = await quiet(book);
  assert.strictEqual(r.status, 500, 'an unrelated duplicate key is not reported as a taken slot');
  ok('a duplicate on another index is still a server error, not a taken-slot 409');

  Appointment.create = async (docs) => docs.map((d) => ({ ...d, id: 1 }));
  r = await quiet(book);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  ok('a normal booking still succeeds');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nappointment-slot-uniqueness.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
