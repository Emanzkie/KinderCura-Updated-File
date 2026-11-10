// Accepting a pending appointment needs verified payment
// (paymentService.summarizeConfirmationPayment / checkConfirmationPayment).
//
// - Accept needs at least 50% of the consultation fee in VERIFIED payment
//   records (Paid / Down Payment / Partially Paid). Pending, Verification
//   Pending, Failed, Expired, Cancelled and Refunded never count, and the
//   appointment's amountPaid snapshot alone is not trusted.
// - A booking whose parent chose Pay at Clinic may be accepted before payment
//   (the fee is collected at the counter); its payment is still unpaid.
// - The refusal says how much is needed, of which fee, and what is verified.
// - The pediatrician dashboard shows each pending request's payment, disables
//   Accept with a note when it cannot be accepted, and loads each child's
//   assessment history once instead of once per request.
//
// No DB, no network: models are stubbed in memory and the dashboard script runs
// in a node vm with a fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const FollowUpPlan = require('../../models/FollowUpPlan');
const paymentService = require('../../services/paymentService');
const receiptService = require('../../services/receiptService');
const router = require('../../routes/appointments');

const ROOT = path.join(__dirname, '..', '..');
const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();

const row = (status, amount, paymentMethod = 'paymongo', extra = {}) => ({ status, amount, paymentMethod, createdAt: new Date(), ...extra });
const summary = (rows, appt = {}) => paymentService.summarizeConfirmationPayment({ totalAmount: 400, ...appt }, rows);

// 1. The rule, one scenario at a time.
{
  let s = summary([row('Paid', 200, 'paymongo', { paymentType: 'down_payment' })]);
  assert.deepStrictEqual([s.canAccept, s.state, s.method, s.verifiedPaid, s.balanceDue, s.percentPaid], [true, 'Partially Paid', 'Online Payment', 200, 200, 50]);
  s = summary([row('Paid', 400)]);
  assert.deepStrictEqual([s.canAccept, s.state, s.balanceDue, s.percentPaid], [true, 'Fully Paid', 0, 100]);
  s = summary([row('Down Payment', 200, 'cash')]);
  assert.strictEqual(s.canAccept, true, 'a staff-recorded down payment is verified money');
  ok('accepted: 50% online deposit, full payment, staff-recorded 50% down payment');

  s = summary([row('Partially Paid', 150, 'cash')]);
  assert.deepStrictEqual([s.canAccept, s.state, s.verifiedPaid], [false, 'Partially Paid', 150]);
  assert.strictEqual(s.message, "This appointment can't be accepted yet: at least ₱200.00 (50% of the ₱400.00 consultation fee) must be paid. Verified payments so far: ₱150.00.");
  assert.strictEqual(s.acceptNote, 'Needs ₱200.00 (50%) paid to accept');
  ok('refused below 50%, with the amount needed, the fee, and what is verified');

  for (const status of ['Pending', 'Verification Pending', 'Failed', 'Expired', 'Cancelled', 'Refunded']) {
    s = summary([row(status, 400)]);
    assert.strictEqual(s.canAccept, false, `${status} is not a verified payment`);
    assert.strictEqual(s.verifiedPaid, 0, status);
  }
  assert.strictEqual(summary([row('Pending', 0)]).state, 'Payment Pending');
  assert.strictEqual(summary([]).state, 'Unpaid');
  s = summary([], { amountPaid: 200, paymentStatus: 'Down Payment' });
  assert.strictEqual(s.canAccept, false, 'the snapshot alone, with no verified record, is not trusted');
  ok('pending, verification pending, failed, expired, cancelled and refunded payments never count');

  s = summary([row('Pending', 0, 'pay_at_clinic')], { pendingPaymentMode: 'pay_at_clinic' });
  assert.deepStrictEqual([s.canAccept, s.reason, s.method, s.state, s.verifiedPaid], [true, 'pay_at_clinic', 'Pay at Clinic', 'Payment Pending', 0]);
  s = summary([row('Paid', 400, 'pay_at_clinic')], { pendingPaymentMode: 'pay_at_clinic' });
  assert.deepStrictEqual([s.canAccept, s.state, s.method], [true, 'Fully Paid', 'Pay at Clinic']);
  s = summary([row('Pending', 0, 'paymongo')], { pendingPaymentMode: 'paymongo' });
  assert.strictEqual(s.canAccept, false, 'an unpaid online checkout is not Pay at Clinic');
  ok('Pay at Clinic: acceptable before payment (still unpaid); a verified clinic payment counts');

  assert.strictEqual(summary([], { totalAmount: 0 }).canAccept, true, 'no fee');
  assert.strictEqual(summary([], { paymentOverride: { isOverridden: true } }).canAccept, true, 'admin override');
  ok('no fee, or an admin override, can still be accepted');
}

// 2. The dashboard Accept route uses the verified records.
function handlerFor(method, p) {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b), catch: (f) => Promise.resolve(value).catch(f),
  };
  return q;
};
const call = (handler, { user, params = {}, body = {} }) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, setHeader() {} };
  Promise.resolve(handler({ user, params, body, query: {} }, res)).catch(reject);
});

const pediaId = oid();
const parentId = oid();
const childId = oid();
let appts = [];
let payments = [];
const makeAppt = (id, fields = {}) => {
  const a = {
    _id: oid(), id, pediatricianId: pediaId, parentId, childId, status: 'pending',
    appointmentDate: new Date('2030-01-07T00:00:00Z'), appointmentTime: '09:00', reason: 'Check',
    totalAmount: 400, amountPaid: 0, paymentStatus: 'Pending Payment', createdAt: new Date(), ...fields,
  };
  a.save = async () => a;
  a.toObject = () => { const { save, toObject, ...rest } = a; return { ...rest }; };
  return a;
};
Appointment.findOne = (q) => chain(appts.find((a) => a.id === q.id && (!q.pediatricianId || String(a.pediatricianId) === String(q.pediatricianId))) || null);
Appointment.find = () => chain(appts.map((a) => a.toObject()));
Payment.find = (q) => {
  const ids = q.appointmentId && q.appointmentId.$in ? q.appointmentId.$in.map(String) : [String(q.appointmentId)];
  return chain(payments.filter((p) => ids.includes(String(p.appointmentId))));
};
User.findOne = () => chain({ _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Gold', lastName: 'Deluna' });
User.findById = (id) => chain(String(id) === String(pediaId) ? { _id: pediaId, firstName: 'Gold', lastName: 'Deluna' } : { _id: parentId, firstName: 'Emman', lastName: 'D', email: '' });
User.find = () => chain([{ _id: pediaId, firstName: 'Gold', lastName: 'Deluna' }, { _id: parentId, firstName: 'Emman', lastName: 'D' }]);
Child.findById = () => chain({ _id: childId, firstName: 'Kemri', lastName: 'Soto' });
Child.find = () => chain([{ _id: childId, firstName: 'Kemri', lastName: 'Soto' }]);
Notification.create = async (doc) => doc;

const pedia = { userId: String(pediaId), role: 'pediatrician' };
const accept = handlerFor('put', '/pedia-notifications/:id');
const list = handlerFor('get', '/pedia-notifications');

(async () => {
  const quiet = { log: console.log, error: console.error };
  console.error = () => {};
  try {
    appts = [makeAppt(109), makeAppt(110), makeAppt(111, { pendingPaymentMode: 'pay_at_clinic' })];
    payments = [
      { appointmentId: appts[0]._id, status: 'Pending', amount: 0, paymentMethod: 'paymongo', createdAt: new Date() },
      { appointmentId: appts[1]._id, status: 'Paid', amount: 200, paymentMethod: 'paymongo', createdAt: new Date() },
      { appointmentId: appts[2]._id, status: 'Pending', amount: 0, paymentMethod: 'pay_at_clinic', createdAt: new Date() },
    ];

    // 3. /pedia-notifications: each pending request carries its payment summary.
    const listed = await call(list, { user: pedia });
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    const byId = new Map(listed.body.notifications.map((n) => [n.id, n]));
    assert.strictEqual(byId.get(109).childId, String(childId), 'child id comes with each request');
    assert.deepStrictEqual(
      [109, 110, 111].map((id) => [byId.get(id).payment.state, byId.get(id).payment.canAccept, byId.get(id).payment.method]),
      [['Payment Pending', false, 'Online Payment'], ['Partially Paid', true, 'Online Payment'], ['Payment Pending', true, 'Pay at Clinic']]
    );
    ok('/pedia-notifications gives each pending request its payment summary and child id');

    // 4. Accept: refused while unpaid (400 with the message), allowed at 50% and for Pay at Clinic.
    let res = await call(accept, { user: pedia, params: { id: '109' }, body: { status: 'approved' } });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /at least ₱200\.00 \(50% of the ₱400\.00 consultation fee\).*Verified payments so far: ₱0\.00/);
    assert.strictEqual(appts[0].status, 'pending');
    res = await call(accept, { user: pedia, params: { id: '110' }, body: { status: 'approved' } });
    assert.deepStrictEqual([res.status, appts[1].status], [200, 'approved']);
    res = await call(accept, { user: pedia, params: { id: '111' }, body: { status: 'approved' } });
    assert.deepStrictEqual([res.status, appts[2].status, appts[2].paymentStatus], [200, 'approved', 'Pending Payment'], 'accepted; still unpaid');
    ok('Accept: an unpaid online request is refused (400, with ₱ amounts); 50% paid and Pay at Clinic are accepted');

    // 4b. A confirmed payment never approves a parent's request: it stays
    // pending, the dashboard shows the verified payment, and Accept approves it.
    const realEnsure = paymentService.ensureBalancePayment;
    paymentService.ensureBalancePayment = async () => {};
    FollowUpPlan.exists = async () => null;
    const deposit = makeAppt(123, { pendingPaymentMode: 'paymongo' });
    const full = makeAppt(124, { pendingPaymentMode: 'paymongo' });
    appts = [deposit, full];
    Appointment.findById = (id) => chain(appts.find((a) => String(a._id) === String(id)) || null);
    await receiptService.syncAppointmentAfterPayment({ appointmentId: deposit._id, paymentType: 'down_payment', amount: 200, totalAmount: 400 });
    await receiptService.syncAppointmentAfterPayment({ appointmentId: full._id, paymentType: 'full_payment', amount: 400, totalAmount: 400 });
    paymentService.ensureBalancePayment = realEnsure;
    assert.deepStrictEqual([deposit.status, deposit.amountPaid, deposit.paymentStatus], ['pending', 200, 'Down Payment'], '50% paid: still pending');
    assert.deepStrictEqual([full.status, full.amountPaid, full.paymentStatus], ['pending', 400, 'Paid'], 'fully paid: still pending');
    payments = [
      { appointmentId: deposit._id, status: 'Paid', amount: 200, paymentMethod: 'paymongo', paymentType: 'down_payment', createdAt: new Date(Date.now() - 1000) },
      { appointmentId: deposit._id, status: 'Pending', amount: 0, paymentMethod: 'pay_at_clinic', paymentType: 'balance_payment', createdAt: new Date() },
      { appointmentId: full._id, status: 'Paid', amount: 400, paymentMethod: 'paymongo', createdAt: new Date() },
    ];
    const again = await call(list, { user: pedia });
    const card = again.body.notifications.find((n) => n.id === 123);
    assert.ok(card && card.status === 'pending', 'the paid request is on the dashboard pending list');
    const p = card.payment;
    assert.deepStrictEqual([p.totalAmount, p.verifiedPaid, p.balanceDue, p.percentPaid, p.state, p.method, p.canAccept], [400, 200, 200, 50, 'Partially Paid', 'Online Payment', true]);
    let saved = 0;
    deposit.save = async () => { saved += 1; return deposit; };
    res = await call(accept, { user: pedia, params: { id: '123' }, body: { status: 'approved' } });
    assert.deepStrictEqual([res.status, deposit.status, saved], [200, 'approved', 1], 'Accept approves and saves it');
    ok('a confirmed 50% or full payment leaves the request pending; the dashboard shows ₱400/₱200/₱200/50%; Accept approves and saves');
  } finally {
    console.error = quiet.error;
  }

  // 5. The dashboard: one history request per child, no full-list call, Accept gated.
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: '', textContent: '', innerHTML: '', src: '', disabled: false, style: {}, dataset: {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return els.get(id);
  };
  const requests = [];
  const pay = (state, canAccept, extra = {}) => ({
    totalAmount: 400, requiredToAccept: 200, verifiedPaid: 0, balanceDue: 400, percentPaid: 0, method: 'Online Payment', state, canAccept,
    reason: canAccept ? 'paid' : 'unpaid', message: canAccept ? null : 'This appointment can\'t be accepted yet: at least ₱200.00 (50% of the ₱400.00 consultation fee) must be paid. Verified payments so far: ₱0.00.',
    acceptNote: canAccept ? null : 'Needs ₱200.00 (50%) paid to accept', ...extra,
  });
  const notifications = [
    { id: 1, appointmentId: 1, childId: 'kid1', status: 'pending', parentName: 'Emman', childName: 'Kemri', createdAt: '2030-01-07T00:00:00Z', payment: pay('Payment Pending', false) },
    { id: 2, appointmentId: 2, childId: 'kid1', status: 'pending', parentName: 'Emman', childName: 'Kemri', createdAt: '2030-01-06T00:00:00Z', payment: pay('Partially Paid', true, { verifiedPaid: 200, balanceDue: 200, percentPaid: 50 }) },
    { id: 3, appointmentId: 3, childId: 'kid2', status: 'pending', parentName: 'Ana', childName: 'Liam <b>', createdAt: '2030-01-05T00:00:00Z', payment: pay('Payment Pending', true, { method: 'Pay at Clinic', reason: 'pay_at_clinic' }) },
    { id: 4, appointmentId: 4, childId: 'kid1', status: 'approved', parentName: 'Emman', childName: 'Kemri', createdAt: '2030-01-04T00:00:00Z' },
  ];
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise, Math, Map, Set, Date, encodeURIComponent, Intl,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, alert() {}, confirm: () => false,
    localStorage: { getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Gold', lastName: 'Deluna', id: 'u1' }) }[k] ?? null), setItem() {}, removeItem() {} },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true } },
    fetch: async (url) => {
      const p = new URL(url).pathname;
      requests.push(p);
      let out = {};
      if (p === '/api/appointments/pedia-notifications') out = { notifications: JSON.parse(JSON.stringify(notifications)) };
      else if (/\/api\/assessments\/.+\/history/.test(p)) out = { assessments: [{ overallScore: 56, communicationScore: 50, socialScore: 44, cognitiveScore: 63, motorScore: 65, completedAt: '2030-01-02T00:00:00.000Z' }] };
      return { ok: true, status: 200, json: async () => out };
    },
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    loadNotificationCount: async () => {},
  };
  sandbox.window = sandbox;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/pedia/pediatrician-dashboard.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
  }
  requests.length = 0;
  await vm.runInContext('loadDashboard()', sandbox);
  const histories = requests.filter((p) => p.includes('/history'));
  assert.deepStrictEqual(histories.sort(), ['/api/assessments/kid1/history', '/api/assessments/kid2/history'], 'one history per distinct child');
  assert.ok(!requests.includes('/api/appointments/pedia'), 'no full appointment list is loaded');
  const html = el('pendingList').innerHTML;
  assert.ok(html.includes('Overall: <strong'), 'assessment results are still shown');
  for (const text of ['Consultation Fee', 'Amount Paid', 'Remaining Balance', 'Online Payment', 'Pay at Clinic', 'Payment Pending', 'Partially Paid', '₱400.00', '50%']) {
    assert.ok(html.includes(text), `card shows ${text}`);
  }
  const card1 = html.slice(html.indexOf('id="apt-1"'), html.indexOf('id="apt-2"'));
  assert.ok(/<button class="btn-approve" disabled/.test(card1) && card1.includes('Needs ₱200.00 (50%) paid to accept'), 'Accept disabled with a note');
  const card2 = html.slice(html.indexOf('id="apt-2"'), html.indexOf('id="apt-3"'));
  assert.ok(card2.includes(`onclick="respond(2,'approved')"`) && !card2.includes('accept-note'), '50% paid: Accept enabled');
  assert.ok(html.includes('Liam &lt;b&gt;'), 'names stay escaped');
  assert.ok(el('activityList').innerHTML.includes('Appointment Requested'), 'activity rendered');

  requests.length = 0;
  await vm.runInContext('loadDashboard()', sandbox);
  assert.deepStrictEqual(requests, ['/api/appointments/pedia-notifications'], 'the next poll reuses the cached histories');
  ok('dashboard: payment section and gated Accept on each card; histories loaded once per child and reused by the next poll');

  console.log('Appointment accept payment tests OK');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
