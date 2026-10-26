// Secretary permission flags are enforced on the appointment routes
// (PEDIATRICIAN_BUGS.md #12).
//
// A pediatrician sets four scheduling flags per secretary in Settings > Staff
// Access, but GET /appointments/pedia and /pedia-notifications ignored
// viewAppointments, and POST /:id/reschedule ignored rescheduleRequests (it
// checked manageBookings || approveSchedules instead).
//
// No DB: models are stubbed and the real route handlers are called from the
// router stack with req.user set as authMiddleware would set it.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const SystemSetting = require('../../models/SystemSetting');
const User = require('../../models/User');
const router = require('../../routes/appointments');
const { getSecretaryPermissions } = require('../../services/secretaryPermissions');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const secretaryId = oid();
const pediaId = oid();
const parentId = oid();
const childId = oid();
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};

const monday = (() => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
})();
const pediatrician = {
  _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz',
  availability: { days: ['Monday'], startTime: '08:00', endTime: '17:00', maxPatientsPerDay: 10, breaks: [] },
};

let storedPermissions; // what the secretary's User document holds
let permissionReads;
let appt;

function reset(permissions, apptFields = {}) {
  storedPermissions = permissions;
  permissionReads = 0;
  appt = {
    _id: oid(), id: 1, pediatricianId: pediaId, parentId, childId, status: 'pending',
    appointmentDate: new Date(monday), appointmentTime: '10:00', totalAmount: 0, amountPaid: 0, ...apptFields,
  };
  appt.save = async function save() {};
  appt.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
}

SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
User.findOne = () => chain(pediatrician);
User.findById = (id) => {
  if (String(id) === String(secretaryId)) {
    permissionReads += 1;
    return chain(storedPermissions === undefined ? { firstName: 'Sam', lastName: 'Sec' } : { firstName: 'Sam', lastName: 'Sec', secretaryPermissions: storedPermissions });
  }
  return chain(String(id) === String(pediaId) ? pediatrician : { _id: parentId, firstName: 'Emman', lastName: 'D', email: '' });
};
Child.findById = () => chain({ _id: childId, firstName: 'Kemri', lastName: 'Soto' });
Payment.find = () => chain([]);
Payment.findOne = () => chain(null);
Notification.create = async (n) => n;
Appointment.find = () => chain([]);
Appointment.findOne = () => chain(appt);

const handlerFor = (method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = (handler, user, { params = {}, body = {} } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    setHeader() {},
  };
  Promise.resolve(handler({ user, params, body, query: {} }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const secretary = { userId: String(secretaryId), role: 'secretary', linkedPediatricianId: String(pediaId) };
const pedia = { userId: String(pediaId), role: 'pediatrician' };
const ALL = { viewAppointments: true, manageBookings: true, rescheduleRequests: true, approveSchedules: true };

(async () => {
  // ── The shared read ─────────────────────────────────────────────────────
  reset(undefined);
  let perms = await getSecretaryPermissions(secretaryId);
  assert.deepStrictEqual(perms, { viewAppointments: true, manageBookings: true, rescheduleRequests: true, approveSchedules: true, managePayments: false });
  reset({ viewAppointments: false, rescheduleRequests: false });
  perms = await getSecretaryPermissions(secretaryId);
  assert.strictEqual(perms.viewAppointments, false);
  assert.strictEqual(perms.rescheduleRequests, false);
  assert.strictEqual(perms.manageBookings, true, 'a flag with no stored value falls back to its default');
  ok('stored flags win and missing ones fall back to the defaults, as in routes/secretary.js');

  // ── viewAppointments ────────────────────────────────────────────────────
  for (const route of ['/pedia', '/pedia-notifications']) {
    const handler = handlerFor('get', route);
    reset({ ...ALL, viewAppointments: false });
    let r = await quiet(() => call(handler, secretary));
    assert.strictEqual(r.status, 403, `${route}: viewAppointments off`);
    assert.match(r.body.error, /permission to view appointments/);
    reset(ALL);
    r = await quiet(() => call(handler, secretary));
    assert.strictEqual(r.status, 200, `${route}: viewAppointments on`);
    reset(undefined);
    r = await quiet(() => call(handler, secretary));
    assert.strictEqual(r.status, 200, `${route}: a secretary with no stored flags gets the defaults`);
    reset({ ...ALL, viewAppointments: false });
    r = await quiet(() => call(handler, pedia));
    assert.strictEqual(r.status, 200, `${route}: the pediatrician is never limited`);
    assert.strictEqual(permissionReads, 0, `${route}: no secretary lookup for a pediatrician`);
  }
  ok('the appointment lists refuse a secretary without viewAppointments and are unchanged for everyone else');

  // ── rescheduleRequests ──────────────────────────────────────────────────
  const reschedule = handlerFor('post', '/:appointmentId/reschedule');
  const move = (user = secretary) => quiet(() => call(reschedule, user, {
    params: { appointmentId: '1' },
    body: { newDate: monday.toISOString().slice(0, 10), newTime: '11:00', reason: 'Doctor emergency' },
  }));

  reset({ ...ALL, rescheduleRequests: false });
  let r = await move();
  assert.strictEqual(r.status, 403, 'manageBookings/approveSchedules no longer stand in for rescheduleRequests');
  assert.match(r.body.error, /permission to reschedule/);
  assert.strictEqual(appt.appointmentTime, '10:00', 'nothing moved');

  reset({ viewAppointments: true, manageBookings: false, approveSchedules: false, rescheduleRequests: true });
  r = await move();
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(appt.appointmentTime, '11:00', 'a reschedule-only secretary can move the slot');
  assert.strictEqual(appt.status, 'pending', 'but cannot approve the request by doing so');

  reset(ALL);
  r = await move();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(appt.status, 'approved', 'with approval permission the reschedule still confirms the request');

  reset({ ...ALL, manageBookings: false, approveSchedules: true });
  await move();
  assert.strictEqual(appt.status, 'approved', 'either approval flag is enough');

  reset(undefined);
  r = await move();
  assert.strictEqual(r.status, 200, 'a secretary with no stored flags gets the defaults');
  assert.strictEqual(appt.status, 'approved');

  reset({ viewAppointments: true, manageBookings: false, approveSchedules: false, rescheduleRequests: true }, { status: 'approved' });
  r = await move();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(appt.status, 'approved', 'an approved appointment stays approved');

  reset({ ...ALL, rescheduleRequests: false });
  r = await move(pedia);
  assert.strictEqual(r.status, 200, 'the pediatrician is never limited');
  ok('rescheduling needs rescheduleRequests, and only secretaries with an approval flag can confirm a pending request by it');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nsecretary-permissions.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
