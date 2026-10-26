// A slow mail relay cannot hold a request open, and the dashboard poll cannot
// pile up (PEDIATRICIAN_BUGS.md #23).
//
//   - PUT /:id/status and POST /:id/reschedule awaited the e-mail send after the
//     change was saved. Gmail's default timeouts run to about two minutes, so on
//     a slow relay the request could pass the platform limit (9.5 s on Vercel)
//     and fail although the change was already stored.
//   - The pediatrician dashboard ran setInterval(..., 5000) and started three
//     loaders every tick without waiting for the last tick's, so a slow load
//     piled up on itself and kept running in a background tab.
//
// No DB, no network: nodemailer's transport is replaced so each case controls
// how the "relay" behaves, and models are stubbed. The slow cases really wait
// for the 4 s limit, so the test takes about ten seconds.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = 'clinic@example.invalid';
process.env.EMAIL_PASS = 'test-only';

let relay = () => Promise.resolve({ messageId: 'm' });
let relayCalls = 0;
nodemailer.createTransport = () => ({ sendMail: (msg) => { relayCalls += 1; return relay(msg); } });

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const SystemSetting = require('../../models/SystemSetting');
const User = require('../../models/User');
const router = require('../../routes/appointments');

const ROOT = path.join(__dirname, '..', '..');
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
  relayCalls = 0;
  appt = {
    _id: oid(), id: 1, pediatricianId: pediaId, parentId, childId, status: 'pending', appointmentDate: new Date(monday),
    appointmentTime: '10:00', reason: 'Check', totalAmount: 0, amountPaid: 0, ...fields,
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
const timed = async (fn) => { const t = Date.now(); const value = await fn(); return { value, ms: Date.now() - t }; };
const setStatus = handlerFor('put', '/:appointmentId/status');
const reschedule = handlerFor('post', '/:appointmentId/reschedule');
const move = () => call(reschedule, {
  params: { appointmentId: '1' },
  body: { newDate: monday.toISOString().slice(0, 10), newTime: '11:00', reason: 'Doctor emergency' },
});

(async () => {
  // ── A relay that never answers ──────────────────────────────────────────
  relay = () => new Promise(() => {});
  reset();
  let { value: r, ms } = await timed(() => quiet(() => call(setStatus, { params: { appointmentId: '1' }, body: { status: 'rejected' } })));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(appt.status, 'rejected', 'the change is saved');
  assert.strictEqual(relayCalls, 1, 'the e-mail was handed to the relay');
  assert(ms >= 3500 && ms < 8000, `the request waited for the limit and no longer (${ms} ms)`);
  ok('a status change answers within the limit even when the mail relay never responds');

  reset({ status: 'approved' });
  ({ value: r, ms } = await timed(() => quiet(move)));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(appt.appointmentTime, '11:00', 'the reschedule is saved');
  assert.strictEqual(r.body.emailPending, true);
  assert.strictEqual(r.body.emailSent, null, 'not reported as failed: it may still go through');
  assert(ms >= 3500 && ms < 8000, `the reschedule waited for the limit and no longer (${ms} ms)`);
  ok('a reschedule answers within the limit and reports the e-mail as pending, not failed');

  // ── A normal relay is still waited for ──────────────────────────────────
  relay = () => Promise.resolve({ messageId: 'm' });
  reset({ status: 'approved' });
  ({ value: r, ms } = await timed(() => quiet(move)));
  assert.strictEqual(r.body.emailSent, true);
  assert.strictEqual(r.body.emailPending, false);
  assert(ms < 1500, `a fast relay costs no wait (${ms} ms)`);

  relay = () => Promise.reject(new Error('SMTP down'));
  reset({ status: 'approved' });
  r = await quiet(move);
  assert.strictEqual(r.status, 200, 'a failing relay never fails the reschedule');
  assert.strictEqual(r.body.emailSent, false);
  assert.strictEqual(r.body.emailPending, false);
  ok('a fast relay is waited for and reported as sent; a failing one is reported as failed without failing the change');

  // ── The dashboard poll ──────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(ROOT, 'js/pedia/pediatrician-dashboard.js'), 'utf8');
  assert(!/setInterval\s*\(/.test(src), 'no bare setInterval');
  const poll = src.match(/window\.KC\.poll\(\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*(\d+)\s*\)/);
  assert(poll, 'the dashboard polls through KC.poll');
  assert(Number(poll[2]) >= 15000, `the interval is no shorter than 15 s (${poll[2]} ms)`);
  for (const loader of ['loadDashboard', 'loadPediaAnalytics', 'loadNotificationCount']) {
    assert(poll[1].includes(`${loader}()`), `${loader} runs on each poll`);
  }
  assert(/await\s+Promise\.all\(/.test(poll[1]), 'each run waits for all of them');
  ok('the dashboard polls through KC.poll (no overlap, paused in a hidden tab) every 15 s and waits for its loaders');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nappointment-email-wait.test.js: ${results.length} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
