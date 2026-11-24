// Appointment emails use the HTTPS email API when it is configured (the host
// blocks SMTP), and a receipt is called "emailed" only when it was.
// No DB and no network: models, Gmail and the email API are stubbed.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';
process.env.EMAIL_FROM = '';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

mongoose.set('bufferCommands', false);

const smtp = [];
nodemailer.createTransport = () => ({ sendMail: async (m) => { smtp.push(m); return { messageId: 'm' }; } });

const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const paymongo = require('../../services/paymongoService');
const receiptService = require('../../services/receiptService');
const controller = require('../../controllers/paymentController');
const router = require('../../routes/appointments');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const oid = () => new mongoose.Types.ObjectId();
const query = (v) => { const q = { lean: () => q, select: () => q, sort: () => q, populate: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
const makeRes = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const quietly = async (fn) => {
  const { error, warn, log } = console; console.error = console.warn = console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, { error, warn, log }); }
};
const results = [];

let http = []; let httpStatus = 200;
global.fetch = async (url, init) => {
  http.push({ url, body: JSON.parse(init.body) });
  return { ok: httpStatus < 400, status: httpStatus, json: async () => ({ id: 'm1' }), text: async () => 'refused' };
};

const pedId = oid(); const parentId = oid();
let appt; let prefs = {};
const notes = [];
Notification.create = async (n) => { notes.push(n); return n; };
User.findById = () => query({ _id: parentId, firstName: 'Ana <b>', lastName: 'S', email: 'parent@example.invalid', notificationSettings: prefs });
Child.findById = () => query({ firstName: 'Kid', lastName: 'S' });
Appointment.findOne = () => query(appt);
Appointment.findById = () => query(appt);
Payment.find = () => query([]);
const setStatus = router.stack.find((l) => l.route && l.route.path === '/:appointmentId/status' && l.route.methods.put).route.stack.at(-1).handle;

async function reject() {
  http = []; smtp.length = 0; notes.length = 0;
  appt = { _id: oid(), id: 5, pediatricianId: pedId, parentId, childId: oid(), status: 'pending', appointmentDate: new Date('2030-01-07'), appointmentTime: '09:00', save: async () => {}, toObject() { return { ...this }; } };
  const res = makeRes();
  await quietly(() => setStatus({ user: { role: 'pediatrician', userId: String(pedId) }, params: { appointmentId: '5' }, body: { status: 'rejected', notes: 'Fully booked' }, method: 'PUT', originalUrl: '/x' }, res));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(appt.status, 'rejected');
}

(async () => {
  // 1. Appointment emails.
  process.env.EMAIL_API_KEY = 're_test'; process.env.EMAIL_FROM = 'clinic@example.invalid';
  await reject();
  assert.deepStrictEqual([http.length, smtp.length], [1, 0], 'HTTPS API used, Gmail not touched');
  assert.ok(http[0].url.startsWith('https://api.resend.com'));
  assert.deepStrictEqual(http[0].body.to, ['parent@example.invalid']);
  assert.match(http[0].body.subject, /Appointment Rejected/);
  assert.ok(http[0].body.html.includes('Kinder') && http[0].body.html.includes('Fully booked'), 'same branded email');
  assert.ok(http[0].body.html.includes('Ana &lt;b&gt;') && !http[0].body.html.includes('Ana <b>'), 'still escaped');

  httpStatus = 500;
  await reject();
  assert.ok(notes.length > 0, 'a failing email API never fails the change or its notification');
  httpStatus = 200;

  prefs = { emailAppointments: false };
  await reject();
  assert.deepStrictEqual([http.length, smtp.length], [0, 0], 'the parent\'s email setting still decides');
  prefs = {};

  process.env.EMAIL_API_KEY = ''; process.env.EMAIL_FROM = '';
  process.env.EMAIL_USER = 'clinic@example.invalid'; process.env.EMAIL_PASS = 'test-only';
  await reject();
  assert.deepStrictEqual([http.length, smtp.length], [0, 1], 'without a key Gmail is used as before');
  process.env.EMAIL_USER = ''; process.env.EMAIL_PASS = '';
  await reject();
  assert.deepStrictEqual([http.length, smtp.length], [0, 0], 'nothing configured sends nothing');
  results.push('appointment emails go out over the HTTPS email API when it is configured');

  // 2. The parent's payment notification.
  paymongo.isConfigured = () => true;
  paymongo.retrieveCheckoutSession = async () => ({ data: { attributes: { payments: [{ id: 'pay_1', attributes: { status: 'paid' } }] } } });
  const payment = { _id: oid(), status: 'Pending', paymongoCheckoutSessionId: 'cs_1', paymentRef: 'KC-PAY-1', appointmentId: oid() };
  Payment.findOne = () => query(payment);
  appt = { _id: payment.appointmentId, id: 5, parentId, childId: oid(), pediatricianId: pedId, paymentStatus: 'Down Payment', balanceDue: 200 };
  for (const [emailed, wanted, refused] of [
    [true, /Receipt KC-RCPT-9 has been emailed to you\./, /in Appointments/],
    [false, /You can view receipt KC-RCPT-9 in Appointments\./, /emailed/],
  ]) {
    notes.length = 0;
    receiptService.settlePayment = async () => ({ alreadySettled: false, emailed, payment: { ...payment, status: 'Paid', amount: 200, receiptNumber: 'KC-RCPT-9' } });
    const res = makeRes();
    await quietly(() => controller.reconcileCheckout({ user: { role: 'parent', userId: String(parentId) }, params: { paymentRef: 'KC-PAY-1' } }, res));
    assert.strictEqual(res.body.paid, true, JSON.stringify(res.body));
    const note = notes.find((n) => /Payment Received —/.test(n.title));
    assert.match(note.message, wanted);
    assert.ok(!refused.test(note.message), note.message);
    assert.match(note.message, /₱200\.00 is due at the clinic/, 'the rest of the message is unchanged');
  }
  assert.strictEqual((read('controllers/paymentController.js').match(/notifyPaymentSettled\(result\.payment, result\.emailed\)/g) || []).length, 3, 'webhook, check and cashier all pass it');
  results.push('the parent is told the receipt was emailed only when it was');

  // 3. Pages.
  assert.ok(!/emailed to:/.test(read('js/parent/payment.js')));
  assert.match(read('js/parent/payment.js'), /Receipt email: <strong>/);
  assert.match(read('js/secretary/secretary-cashier.js'), /created \(email not confirmed\)/);
  const src = read('js/pedia/pediatrician-appointments.js');
  const start = src.indexOf('async function collectBalance(');
  const fn = src.slice(start, src.indexOf('\n}', start) + 2);
  for (const [reply, text] of [
    [{ receiptNumber: 'R-1', receiptEmailed: true }, 'Balance recorded. Receipt R-1 was emailed to the parent.'],
    [{ receiptNumber: 'R-1', receiptEmailed: false }, "Balance recorded. Receipt R-1 is ready in the parent's Appointments."],
    [{}, 'Balance recorded.'],
  ]) {
    const alerts = [];
    const box = { confirm: () => true, alert: (m) => alerts.push(m), apiFetch: async () => reply, loadAppointments: async () => {} };
    vm.createContext(box);
    vm.runInContext(fn, box);
    await box.collectBalance({}, 1, '₱200');
    assert.deepStrictEqual(alerts, [text]);
  }
  results.push('pediatrician, cashier and receipt card wording matches what happened');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Email delivery and wording tests OK - ${results.length} groups`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
