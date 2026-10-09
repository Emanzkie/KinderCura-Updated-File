// Unit tests for pediatrician rescheduling against configured availability:
// GET /api/appointments/availability/check (excludeAppointmentId, availableDays)
// and POST /api/appointments/:appointmentId/reschedule server-side validation.
//
// No live DB required — the shared mongoose models' statics are monkey-patched,
// and the route handlers are called directly from the router stack (auth
// middleware is skipped; req.user is supplied by each test).
const assert = require('assert');
const mongoose = require('mongoose');

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Payment = require('../../models/Payment');
const Notification = require('../../models/Notification');
const SystemSetting = require('../../models/SystemSetting');

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const router = require('../../routes/appointments');

// ── Helpers ────────────────────────────────────────────────────────────────
function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

// Thenable query stub: .select/.sort/.lean/.populate all chain, await resolves.
function chain(value) {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

function call(handler, { user, query = {}, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() {},
    };
    Promise.resolve(handler({ user, query, params, body }, res)).catch(reject);
  });
}

function ymd(date) { return date.toISOString().slice(0, 10); }
// Next occurrence (at least 7 days out, so it is never "today") of a UTC weekday.
function upcoming(weekday) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const MONDAY = upcoming(1);
const TUESDAY = upcoming(2);
const WEDNESDAY = upcoming(3);

// ── Fixtures ───────────────────────────────────────────────────────────────
const pediaId = new mongoose.Types.ObjectId();
const otherPediaId = new mongoose.Types.ObjectId();
const parentId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();

const pediatrician = {
  _id: pediaId,
  role: 'pediatrician',
  status: 'active',
  firstName: 'Ana',
  lastName: 'Cruz',
  availability: {
    days: ['Monday', 'Wednesday'],
    startTime: '08:00',
    endTime: '12:00',
    maxPatientsPerDay: 2,
    breaks: [],
  },
};

let appointments;
let saves;
let notificationsCreated;

function makeAppt(fields) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    pediatricianId: pediaId,
    parentId,
    childId,
    status: 'pending',
    reason: 'Development Check',
    ...fields,
  };
  doc.save = async function save() { saves.push({ id: this.id, date: this.appointmentDate, time: this.appointmentTime }); };
  doc.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
  return doc;
}

function matches(doc, query) {
  if (query.id != null && doc.id !== query.id) return false;
  if (query.pediatricianId && String(doc.pediatricianId) !== String(query.pediatricianId)) return false;
  if (query._id && query._id.$ne && String(doc._id) === String(query._id.$ne)) return false;
  if (query.status && query.status.$in && !query.status.$in.includes(doc.status)) return false;
  if (query.appointmentDate) {
    const t = new Date(doc.appointmentDate).getTime();
    if (t < query.appointmentDate.$gte.getTime() || t >= query.appointmentDate.$lt.getTime()) return false;
  }
  return true;
}

function reset({ ownDate = MONDAY, ownTime = '10:00' } = {}) {
  saves = [];
  notificationsCreated = [];
  appointments = [
    makeAppt({ id: 1, appointmentDate: new Date(ownDate), appointmentTime: ownTime }),   // the one being moved
    makeAppt({ id: 2, appointmentDate: new Date(MONDAY), appointmentTime: '09:00', status: 'approved' }), // conflict
    makeAppt({ id: 3, appointmentDate: new Date(MONDAY), appointmentTime: '08:00', pediatricianId: otherPediaId }), // other doctor
  ];
}

SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
User.findOne = (q) => chain(String(q._id) === String(pediaId) ? pediatrician : null);
User.findById = (id) => chain(String(id) === String(pediaId) ? pediatrician : { _id: parentId, firstName: 'Emman', lastName: 'D', email: '' });
Child.findById = () => chain({ _id: childId, firstName: 'Kemri', lastName: 'Soto' });
Payment.find = () => chain([]);
Payment.findOne = () => chain(null);
Notification.create = async (payload) => { notificationsCreated.push(payload); return payload; };
Appointment.find = (q) => chain(appointments.filter((a) => matches(a, q)));
Appointment.findOne = (q) => chain(appointments.find((a) => matches(a, q)) || null);

const check = handlerFor('get', '/availability/check');
const reschedule = handlerFor('post', '/:appointmentId/reschedule');
const pediaUser = { userId: String(pediaId), role: 'pediatrician' };

// ── Tests ──────────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('one-hour start times stay inside the configured window (no 12:00 start)', async () => {
  reset({ ownDate: WEDNESDAY });
  const { status, body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(WEDNESDAY) } });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.availability.generatedSlots, ['08:00', '09:00', '10:00', '11:00']);
});

test('availableDays are returned from the configured availability', async () => {
  reset();
  const { body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(MONDAY) } });
  assert.deepStrictEqual(body.availability.availableDays, ['Monday', 'Wednesday']);
});

test('a day outside the configured days offers no slots', async () => {
  reset();
  const { body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(TUESDAY), excludeAppointmentId: '1' } });
  assert.strictEqual(body.availability.available, false);
  assert.strictEqual(body.availability.isDayAvailable, false);
  assert.deepStrictEqual(body.availability.availableSlots, []);
});

test('a slot held by another appointment is not offered; another doctor\'s booking does not block', async () => {
  reset({ ownDate: WEDNESDAY });
  const { body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(MONDAY), excludeAppointmentId: '1' } });
  assert.deepStrictEqual(body.availability.availableSlots, ['08:00', '10:00', '11:00']);
});

test('without excludeAppointmentId the appointment being moved fills the day (old behaviour)', async () => {
  reset();
  const { body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(MONDAY) } });
  assert.deepStrictEqual(body.availability.availableSlots, []);
});

test('with excludeAppointmentId the appointment does not block its own alternatives', async () => {
  reset();
  const { body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(MONDAY), excludeAppointmentId: '1' } });
  assert.deepStrictEqual(body.availability.availableSlots, ['08:00', '10:00', '11:00']);
});

test('excludeAppointmentId is ignored for an appointment the pediatrician does not own', async () => {
  reset();
  appointments[0].pediatricianId = otherPediaId; // id 1 now belongs to someone else
  appointments.push(makeAppt({ id: 4, appointmentDate: new Date(MONDAY), appointmentTime: '10:00' }));
  const { body } = await call(check, { user: pediaUser, query: { pediatricianId: String(pediaId), date: ymd(MONDAY), excludeAppointmentId: '1' } });
  assert.deepStrictEqual(body.availability.availableSlots, []);
});

test('excludeAppointmentId is ignored for parent callers', async () => {
  reset();
  const { body } = await call(check, { user: { userId: String(parentId), role: 'parent' }, query: { pediatricianId: String(pediaId), date: ymd(MONDAY), excludeAppointmentId: '1' } });
  assert.deepStrictEqual(body.availability.availableSlots, []);
});

async function rejected(body, expectedPattern) {
  reset();
  const before = { date: appointments[0].appointmentDate, time: appointments[0].appointmentTime, status: appointments[0].status };
  const res = await call(reschedule, { user: pediaUser, params: { appointmentId: '1' }, body });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  if (expectedPattern) assert.match(res.body.error, expectedPattern);
  assert.strictEqual(saves.length, 0, 'appointment must not be saved');
  assert.deepStrictEqual(
    { date: appointments[0].appointmentDate, time: appointments[0].appointmentTime, status: appointments[0].status },
    before,
    'original appointment must be untouched'
  );
}

test('backend rejects a manually submitted unavailable weekday', () => rejected({ newDate: ymd(TUESDAY), newTime: '09:00' }, /not available on Tuesday/));
test('backend rejects a start time outside the configured window', () => rejected({ newDate: ymd(WEDNESDAY), newTime: '12:00' }, /available start times/));
test('backend rejects a start time before the configured window', () => rejected({ newDate: ymd(WEDNESDAY), newTime: '07:00' }, /available start times/));
test('backend rejects an off-interval start time', () => rejected({ newDate: ymd(WEDNESDAY), newTime: '09:30' }, /valid appointment start time/));
test('backend rejects a slot held by another appointment', () => rejected({ newDate: ymd(MONDAY), newTime: '09:00' }, /already booked/));
test('backend rejects a past date', () => rejected({ newDate: '2020-01-06', newTime: '09:00' }, /today or a future date/));
test('backend rejects a malformed time', () => rejected({ newDate: ymd(WEDNESDAY), newTime: 'abc' }, /valid appointment time/));

test('valid reschedule updates the right appointment, approves it and notifies the parent', async () => {
  reset();
  const res = await call(reschedule, {
    user: pediaUser,
    params: { appointmentId: '1' },
    body: { newDate: ymd(MONDAY), newTime: '11:00', reason: 'Doctor emergency' },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(saves.length, 1);
  assert.strictEqual(saves[0].id, 1);
  const appt = appointments[0];
  assert.strictEqual(appt.appointmentTime, '11:00');
  assert.strictEqual(ymd(appt.appointmentDate), ymd(MONDAY));
  assert.strictEqual(appt.status, 'approved');
  assert.strictEqual(appt.reschedule.isRescheduled, true);
  assert.strictEqual(appt.reschedule.originalTime, '10:00');
  assert.strictEqual(appt.reschedule.reason, 'Doctor emergency');
  assert.strictEqual(appointments[1].appointmentTime, '09:00', 'other appointments untouched');
  assert.ok(notificationsCreated.some((n) => String(n.userId) === String(parentId) && n.title === 'Appointment Rescheduled'));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(`\npediatrician-reschedule-availability: ${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
