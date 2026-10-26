// A status change or reschedule does not overwrite the booking note
// (PEDIATRICIAN_BUGS.md #16).
//
// Appointment.notes is the parent's own note from booking. Rejecting,
// completing or cancelling with a note, and rescheduling with a note, replaced
// it with the clinic's text, so the parent's note was lost and the clinic's note
// then showed as if the parent had written it. The clinic's note now goes in
// Appointment.statusNote, and the status e-mail's "Note" is that field.
//
// No DB, no network: nodemailer's transport is replaced so the real e-mail body
// is captured, and models are monkey-patched.
const assert = require('assert');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const sent = [];
process.env.EMAIL_USER = 'clinic@example.invalid';
process.env.EMAIL_PASS = 'test-only';
nodemailer.createTransport = () => ({ sendMail: async (msg) => { sent.push(msg); return { messageId: 'm' }; } });

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const SystemSetting = require('../../models/SystemSetting');
const User = require('../../models/User');
const router = require('../../routes/appointments');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
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
  _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz', email: 'dr@example.invalid',
  availability: { days: ['Monday'], startTime: '08:00', endTime: '17:00', maxPatientsPerDay: 10, breaks: [] },
};

let appt;
function reset(fields = {}) {
  sent.length = 0;
  appt = {
    _id: oid(), id: 1, pediatricianId: pediaId, parentId, childId, status: 'pending',
    appointmentDate: new Date(monday), appointmentTime: '10:00', reason: 'Check', totalAmount: 0, amountPaid: 0,
    notes: 'Please use the side entrance, he is shy.', ...fields,
  };
  appt.save = async function save() {};
  appt.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
}

SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
User.findOne = () => chain(pediatrician);
User.findById = (id) => chain(String(id) === String(pediaId)
  ? pediatrician
  : { _id: parentId, firstName: 'Emman', lastName: 'D', email: 'parent@example.invalid' });
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
const call = (handler, { params = {}, body = {} } = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, setHeader() {} };
  Promise.resolve(handler({ user: { userId: String(pediaId), role: 'pediatrician' }, params, body, query: {} }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const setStatus = handlerFor('put', '/:appointmentId/status');
const reschedule = handlerFor('post', '/:appointmentId/reschedule');
const BOOKING_NOTE = 'Please use the side entrance, he is shy.';

(async () => {
  // ── Status changes ──────────────────────────────────────────────────────
  for (const [from, to] of [['pending', 'rejected'], ['approved', 'completed'], ['approved', 'cancelled']]) {
    reset({ status: from });
    const r = await quiet(() => call(setStatus, { params: { appointmentId: '1' }, body: { status: to, notes: 'Clinic closed that day.' } }));
    assert.strictEqual(r.status, 200, `${from} -> ${to}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(appt.status, to);
    assert.strictEqual(appt.notes, BOOKING_NOTE, `${to}: the parent's booking note is kept`);
    assert.strictEqual(appt.statusNote, 'Clinic closed that day.', `${to}: the clinic's note is stored separately`);
  }
  ok("rejecting, completing or cancelling with a note keeps the parent's booking note and stores the clinic's separately");

  reset({ status: 'pending', statusNote: 'Earlier note.' });
  await quiet(() => call(setStatus, { params: { appointmentId: '1' }, body: { status: 'rejected' } }));
  assert.strictEqual(appt.notes, BOOKING_NOTE, 'no note typed: the booking note is untouched');
  assert.strictEqual(appt.statusNote, 'Earlier note.', 'and an earlier status note is not blanked by a change with no note');
  ok('a status change with no note changes neither field');

  // ── The e-mail ──────────────────────────────────────────────────────────
  reset({ status: 'pending' });
  await quiet(() => call(setStatus, { params: { appointmentId: '1' }, body: { status: 'rejected', notes: 'Clinic closed that day.' } }));
  let mail = sent.find((m) => m.to === 'parent@example.invalid');
  assert(mail, 'the parent is e-mailed');
  assert(mail.html.includes('Clinic closed that day.'), "the clinic's note is the e-mail's Note");
  assert(!mail.html.includes('side entrance'), "the parent's own booking note is not sent back to them as a decision note");

  reset({ status: 'pending' });
  await quiet(() => call(setStatus, { params: { appointmentId: '1' }, body: { status: 'rejected' } }));
  mail = sent.find((m) => m.to === 'parent@example.invalid');
  assert(mail && !mail.html.includes('<strong>Note:</strong>'), 'no clinic note, no Note line');
  assert(!mail.html.includes('side entrance'));
  ok("the status e-mail's Note is the clinic's note only, never the parent's booking note");

  // ── Reschedule ──────────────────────────────────────────────────────────
  reset({ status: 'approved' });
  const r = await quiet(() => call(reschedule, {
    params: { appointmentId: '1' },
    body: { newDate: monday.toISOString().slice(0, 10), newTime: '11:00', reason: 'Doctor emergency', note: 'Sorry about the change.' },
  }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(appt.appointmentTime, '11:00');
  assert.strictEqual(appt.notes, BOOKING_NOTE, 'a reschedule note does not replace the booking note');
  assert.strictEqual(appt.statusNote, 'Sorry about the change.');
  ok('a reschedule note is stored as the status note and the booking note survives');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nappointment-status-note.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
