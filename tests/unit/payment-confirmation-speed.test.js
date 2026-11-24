// A confirmed payment is shown quickly, however slow the receipt email is.
//
// The bug: the receipt went out over Gmail SMTP only, which the host blocks, and
// settlePayment awaited it: two minutes on "Confirming your payment…" after the
// payment had already been saved. The page also waited for that request before
// reading the saved status. No DB and no network: everything is stubbed.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Payment = require('../../models/Payment');
const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const SystemSetting = require('../../models/SystemSetting');
const FollowUpPlan = require('../../models/FollowUpPlan');
const emailService = require('../../services/emailService');
const receiptService = require('../../services/receiptService');

const results = [];
const oid = () => new mongoose.Types.ObjectId();
const query = (v) => { const q = { lean: () => q, select: () => q, sort: () => q, session: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
const asDoc = (row) => Object.assign(row, { save: async () => row, toObject: () => ({ ...row }) });

let payment; let appointment;
function reset() {
  payment = asDoc({ _id: oid(), status: 'Pending', paymentType: 'full_payment', totalAmount: 400, paymentMethod: 'paymongo', paymentRef: 'KC-PAY-1', receiptEmail: 'parent@example.invalid', receiptSentAt: null });
  appointment = asDoc({ _id: oid(), id: 9, status: 'pending', totalAmount: 400, amountPaid: 0, appointmentDate: new Date(), appointmentTime: '09:00' });
  payment.appointmentId = appointment._id;
}
Payment.findById = () => query(payment);
Payment.nextReceiptNumber = async () => 'KC-RCPT-1';
Payment.findOneAndUpdate = (f, u) => {
  if ('receiptSentAt' in f && payment.receiptSentAt) return query(null);
  if (f.status && payment.status === 'Paid') return query(null);
  Object.assign(payment, u.$set);
  return query(payment);
};
Payment.updateOne = async (f, u) => { Object.assign(payment, u.$set); };
Appointment.findById = () => query(appointment);
User.findById = () => query({ firstName: 'Ana', lastName: 'S', email: 'parent@example.invalid' });
Child.findById = () => query({ firstName: 'Kid', lastName: 'S' });
SystemSetting.getClinic = async () => ({ clinicName: 'Clinic' });
FollowUpPlan.exists = async () => null;
FollowUpPlan.findOne = () => query(null);
FollowUpPlan.findOneAndUpdate = () => query(null);

const realSend = emailService.sendPaymentReceiptEmail;
const settle = () => receiptService.settlePayment({ paymentId: payment._id, method: 'paymongo' });
const quietly = async (fn) => {
  const { error, warn, log } = console; console.error = console.warn = console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, { error, warn, log }); }
};

// The payment page's real resolver, with fake timers that only record waits.
async function page({ check, statuses, result = 'success', appts = [] }) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'parent', 'payment.js'), 'utf8');
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { id, style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} } }); return els.get(id); };
  let checks = 0; let reads = 0; let waited = 0; let apptReads = 0;
  const sandbox = {
    requireAuth() {}, location: { search: '?appointmentId=9' }, URLSearchParams, console: { warn() {}, error() {}, log() {} },
    document: { getElementById: el, addEventListener() {} }, sessionStorage: { removeItem() {}, getItem: () => null }, KC: { user: () => ({ id: 'u' }) },
    setTimeout: (fn, ms) => { waited += ms; setImmediate(fn); },
    apiFetch: async (url) => {
      if (url.endsWith('/reconcile')) { checks += 1; return check(checks); }
      if (url.endsWith('/status')) { reads += 1; return statuses[Math.min(reads, statuses.length) - 1]; }
      if (url.endsWith('/receipt')) return { receipt: { receiptNumber: 'KC-RCPT-1', amount: 200 } };
      if (url.startsWith('/appointments/')) { apptReads += 1; return { appointments: [appts[Math.min(apptReads, appts.length) - 1]].filter(Boolean) }; }
      return {};
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  await sandbox.resolveOnlineResult(result, 'KC-PAY-1');
  const panel = ['onlineSuccessPanel', 'onlineFailedPanel', 'onlinePendingPanel'].find((id) => el(id).style.display === 'block');
  return { panel, checks, reads, waited, el };
}

// A hang must fail, not end quietly.
setTimeout(() => { console.error('FAILED: timed out'); process.exit(1); }, 20000);

(async () => {
  // 1. A mail server that never answers.
  reset();
  emailService.sendPaymentReceiptEmail = () => new Promise(() => {});
  const t0 = Date.now();
  let out = await settle();
  const took = Date.now() - t0;
  assert.ok(took >= 2900 && took < 4500, `settled after ${took} ms`);
  assert.deepStrictEqual([out.payment.status, out.alreadySettled, out.emailed], ['Paid', false, false]);
  assert.deepStrictEqual([appointment.paymentStatus, appointment.amountPaid], ['Paid', 400], 'the appointment is updated before the email');
  out = await settle();
  assert.strictEqual(out.alreadySettled, true, 'still settles only once');
  results.push('a hanging email delays settlement by 3 seconds at most');

  // 2. Sent, not sent, failed.
  for (const [send, emailed] of [
    [async () => ({ sent: true }), true],
    [async () => ({ sent: false, reason: 'SEND_FAILED' }), false],
    [async () => { throw new Error('down'); }, false],
  ]) {
    reset();
    let tries = 0;
    emailService.sendPaymentReceiptEmail = (c) => { tries += 1; return send(c); };
    out = await quietly(settle);
    assert.deepStrictEqual([out.emailed, Boolean(payment.receiptSentAt), tries], [emailed, emailed, 1], 'recorded as sent only when it was');
    assert.strictEqual(payment.status, 'Paid', 'a failed email never undoes the payment');
  }
  results.push('a receipt is recorded as sent only when it really was');

  // 3. The HTTPS email API is used when configured; nothing configured is not "sent".
  emailService.sendPaymentReceiptEmail = realSend;
  const realFetch = global.fetch;
  const mails = [];
  global.fetch = async (url, init) => { mails.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ id: 'm1' }) }; };
  const context = { parentEmail: 'parent@example.invalid', receiptNumber: 'KC-RCPT-1', amount: 200 };
  assert.strictEqual((await quietly(() => realSend(context))).sent, false);
  assert.strictEqual(mails.length, 0);
  process.env.EMAIL_API_KEY = 're_test'; process.env.EMAIL_FROM = 'clinic@example.invalid';
  assert.strictEqual((await realSend(context)).sent, true);
  assert.ok(mails[0].url.startsWith('https://api.resend.com'));
  assert.match(mails[0].body.subject, /KC-RCPT-1/);
  global.fetch = realFetch; process.env.EMAIL_API_KEY = ''; process.env.EMAIL_FROM = '';
  results.push('the receipt goes out over the HTTPS email API when it is configured');

  // 4. The page.
  const PAID = { paid: true, status: 'Paid' }; const PENDING = { paid: false, status: 'Pending' };
  let p = await page({ check: () => new Promise(() => {}), statuses: [PAID], appts: [{ id: 9, paymentStatus: 'Paid' }] });
  assert.deepStrictEqual([p.panel, p.waited, p.checks], ['onlineSuccessPanel', 1500, 1], 'Paid shows while the check is still hanging');
  p = await page({ check: async () => PENDING, statuses: [PENDING, PENDING, PAID], appts: [{ id: 9, paymentStatus: 'Paid' }] });
  assert.deepStrictEqual([p.panel, p.checks], ['onlineSuccessPanel', 3], 'an early "not yet" is asked again');
  p = await page({ check: async () => { throw new Error('down'); }, statuses: [PENDING] });
  assert.strictEqual(p.panel, 'onlineFailedPanel');
  assert.match(p.el('onlineFailedReason').innerHTML, /not received confirmation yet/);
  p = await page({ check: () => new Promise(() => {}), statuses: [PENDING] });
  assert.deepStrictEqual([p.panel, p.checks, p.waited < 25000], ['onlineFailedPanel', 1, true], 'one check at a time, and it never waits forever');
  p = await page({ check: async () => PENDING, statuses: [{ paid: false, status: 'Failed' }] });
  assert.strictEqual(p.panel, 'onlineFailedPanel');
  p = await page({ check: async () => PENDING, statuses: [], result: 'cancelled' });
  assert.deepStrictEqual([p.panel, p.checks], ['onlineFailedPanel', 0]);
  const before = { id: 9, paymentStatus: 'Pending Payment', amountPaid: 0, balanceDue: 400 };
  p = await page({ check: async () => PAID, statuses: [PAID], appts: [before, before, { id: 9, paymentStatus: 'Down Payment', amountPaid: 200, balanceDue: 200, totalAmount: 400 }] });
  assert.match(p.el('successTitle').textContent, /Deposit Paid/, 'a deposit still reads as a deposit when its appointment is saved a moment later');
  results.push('the page shows the saved status without waiting for the check');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Payment confirmation speed tests OK - ${results.length} groups`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
