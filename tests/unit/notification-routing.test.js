// Cancel notifications and notification links (PEDIATRICIAN_BUGS.md #18).
//
//   - A parent cancelling an appointment never told the pediatrician: /cancel
//     passed no pediatrician to the shared helper, which only notified the parent.
//   - pushNotification built an ObjectId from the recipient outside its try, so a
//     booking whose parent record was gone made a status change that had already
//     been saved answer 500.
//   - POST /notifications/send stored any relatedPage, the bell followed it with
//     location.href, and "javascript:..." ran when a co-guardian clicked it.
//
// No DB: models are stubbed, the real handlers run from their router stacks, and
// api.js runs in a node vm for the bell's destination check.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const User = require('../../models/User');
const appointmentsRouter = require('../../routes/appointments');
const notificationsRouter = require('../../routes/notifications');

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
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const handlerFor = (router, method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = (handler, user, { params = {}, body = {} } = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, setHeader() {} };
  Promise.resolve(handler({ user, params, body, query: {} }, res)).catch(reject);
});

let appt;
let created;     // notifications created through the model
let inserted;    // notifications created through /notifications/send

function reset(fields = {}) {
  created = [];
  inserted = [];
  appt = {
    _id: oid(), id: 1, pediatricianId: pediaId, parentId, childId, status: 'approved',
    appointmentDate: new Date('2030-01-08T00:00:00Z'), appointmentTime: '10:00', reason: 'Check', totalAmount: 0, amountPaid: 0,
    ...fields,
  };
  appt.save = async function save() {};
  appt.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
}

User.findById = (id) => {
  if (id == null) return chain(null);
  if (String(id) === String(pediaId)) return chain({ _id: pediaId, firstName: 'Ana', lastName: 'Cruz' });
  return chain({ _id: parentId, firstName: 'Emman', lastName: 'Dela Cruz', email: '' });
};
User.findOne = () => chain({ _id: pediaId, role: 'pediatrician', status: 'active' });
Child.findById = () => chain({ _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto' });
GuardianLink.findOne = () => chain(null);
GuardianLink.find = () => chain([]);
Payment.find = () => chain([]);
Payment.findOne = () => chain(null);
Appointment.findOne = () => chain(appt);
Notification.create = async (n) => { created.push(n); return n; };
Notification.insertMany = async (rows) => { inserted.push(...rows); return rows; };

const toUser = (id) => created.filter((n) => String(n.userId) === String(id));
const cancel = handlerFor(appointmentsRouter, 'post', '/:appointmentId/cancel');
const setStatus = handlerFor(appointmentsRouter, 'put', '/:appointmentId/status');
const send = handlerFor(notificationsRouter, 'post', '/send');

(async () => {
  // ── A parent's cancellation tells the pediatrician ──────────────────────
  reset();
  let r = await quiet(() => call(cancel, { userId: String(parentId), role: 'parent' }, { params: { appointmentId: '1' } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(appt.status, 'cancelled');
  const toPedia = toUser(pediaId);
  assert.strictEqual(toPedia.length, 1, 'the pediatrician is notified');
  assert.strictEqual(toPedia[0].title, 'Appointment Cancelled');
  assert.match(toPedia[0].message, /Emman Dela Cruz cancelled the appointment for Kemri Soto/);
  assert.strictEqual(toPedia[0].relatedPage, '/pedia/pediatrician-appointments.html');
  assert.strictEqual(toPedia[0].relatedId, '1');
  assert.strictEqual(toUser(parentId).length, 1, 'the parent still gets their confirmation');
  ok('a parent cancelling notifies the pediatrician, with a link to their appointments, and the parent still gets theirs');

  for (const [label, user] of [['the pediatrician', { userId: String(pediaId), role: 'pediatrician' }], ['an admin', { userId: String(oid()), role: 'admin' }]]) {
    reset();
    r = await quiet(() => call(cancel, user, { params: { appointmentId: '1' } }));
    assert.strictEqual(r.status, 200, label);
    assert.strictEqual(toUser(pediaId).length, 0, `${label} cancelling does not notify the pediatrician about their own action`);
    assert.strictEqual(toUser(parentId).length, 1, `${label} cancelling still notifies the parent`);
  }
  ok('a cancellation by the pediatrician or an admin notifies only the parent, as before');

  // ── A booking with no parent record ─────────────────────────────────────
  reset({ status: 'pending', parentId: null });
  r = await quiet(() => call(setStatus, { userId: String(pediaId), role: 'pediatrician' }, { params: { appointmentId: '1' }, body: { status: 'rejected' } }));
  assert.strictEqual(r.status, 200, `a status change on a booking with no parent must not 500: ${JSON.stringify(r.body)}`);
  assert.strictEqual(appt.status, 'rejected');
  assert.strictEqual(toUser(parentId).length, 0, 'there is nobody to notify');
  ok('a status change on a booking whose parent record is missing succeeds instead of answering 500 after saving');

  // ── relatedPage on /notifications/send ──────────────────────────────────
  const owner = { userId: String(parentId), role: 'parent' };
  const sendWith = (relatedPage) => quiet(() => call(send, owner, {
    body: { childId: String(childId), title: 'Hello', message: 'Hi', ...(relatedPage === undefined ? {} : { relatedPage }) },
  }));
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'https://evil.example/x', '//evil.example/x', '/\\evil.example', 'data:text/html,x', ' /parent/appointments.html', '/parent/ appointments', ['/a'], { a: 1 }]) {
    reset();
    r = await sendWith(bad);
    assert.strictEqual(r.status, 400, `relatedPage ${JSON.stringify(bad)} must be refused`);
    assert.strictEqual(inserted.length, 0, 'nothing was stored');
  }
  for (const good of ['/parent/appointments.html', '/pedia/pediatrician-appointments.html?appointmentId=5', '/admin/prc-verification', null, undefined, '']) {
    reset();
    r = await sendWith(good);
    assert.strictEqual(r.status, 200, `relatedPage ${JSON.stringify(good)} must be accepted: ${JSON.stringify(r.body)}`);
    assert(inserted.length >= 1);
  }
  ok('/notifications/send refuses a relatedPage that is not a path on this site and still accepts real pages or none');

  // ── The bell ignores a bad stored value ─────────────────────────────────
  const store = new Map([['kc_token', 't'], ['kc_user', JSON.stringify({ id: 'u1', role: 'parent' })]]);
  const window = {
    location: { hostname: 'kindercura.example', pathname: '/parent/dashboard.html', href: '', replace() {} },
    document: { cookie: '', addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  window.window = window;
  const ctx = vm.createContext(window);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8'), ctx, { filename: 'api.js' });
  const dest = (n) => { ctx.__n = n; return vm.runInContext('notificationDestination(__n)', ctx); };
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', '//evil.example/x', '/\\evil.example', 'https://evil.example', 'data:text/html,x']) {
    assert.strictEqual(dest({ title: 'x', relatedPage: bad }), null, `${bad} must not be followed`);
  }
  assert.strictEqual(dest({ title: 'x', relatedPage: '/parent/appointments.html' }), '/parent/appointments.html');
  assert.strictEqual(dest({ title: 'x', relatedPage: '/pedia/pediatrician-appointments.html', relatedId: 5 }), '/pedia/pediatrician-appointments.html?appointmentId=5');
  assert.strictEqual(dest({ title: 'Appointment Approved', type: 'appointment' }), '/parent/appointments', 'notifications with no relatedPage still route by title');
  ok('the bell follows only site paths: a stored javascript: or other-host link is ignored, real links and title routing are unchanged');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nnotification-routing.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
