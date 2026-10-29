// Refund requests for online payments (services/refundService.js and the
// /api/payments refund routes).
//
// - Only a cancelled/rejected appointment with a PayMongo payment inside the
//   refund window can be requested; clinic payments are refused with a reason.
// - One live request per payment; reject needs a reason; approve sends ONE
//   PayMongo refund even when clicked twice.
// - 'Refunded' only when PayMongo reports succeeded; approval alone never.
// - The payment.refunded webhook re-fetches the refund before applying it.
// - Only the appointment's pediatrician, or their secretary with Manage
//   Payments, can list or review.
//
// No DB, no network: models and PayMongo are stubbed in memory.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Refund = require('../../models/Refund');
const Payment = require('../../models/Payment');
const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const GuardianLink = require('../../models/GuardianLink');
const paymongo = require('../../services/paymongoService');
const refunds = require('../../services/refundService');
const controller = require('../../controllers/paymentController');

const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-29T03:00:00Z');

// ── In-memory query helpers ────────────────────────────────────────────────
const query = (value) => {
  const q = { lean: () => q, sort: () => q, limit: () => q, select: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};
const same = (a, b) => String(a) === String(b);
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId) && !(v instanceof Date)) {
    if ('$in' in v) return v.$in.some((x) => same(x, doc[k]));
    if ('$ne' in v) return !same(v.$ne, doc[k]);
  }
  return same(v, doc[k]);
});
const applyUpdate = (doc, update) => {
  Object.assign(doc, update.$set || {});
  for (const k of Object.keys(update.$unset || {})) delete doc[k];
};

// ── World ──────────────────────────────────────────────────────────────────
const parent = { userId: String(oid()), role: 'parent' };
const otherParent = { userId: String(oid()), role: 'parent' };
const pediaId = oid();
const otherPedia = oid();
const childId = oid();

let state;
function reset() {
  const appt = (id, status) => ({ _id: oid(), id, status, parentId: new mongoose.Types.ObjectId(parent.userId), childId, pediatricianId: pediaId });
  const appointments = [appt(1, 'cancelled'), appt(2, 'completed'), appt(3, 'rejected'), appt(4, 'cancelled'), appt(5, 'cancelled')];
  const pay = (a, method, extra = {}) => ({
    _id: oid(), appointmentId: a._id, appointmentNumericId: a.id, paymentMethod: method, status: 'Paid',
    amount: 950, currency: 'PHP', paidAt: new Date(NOW - 2 * DAY), paymentRef: `KC-PAY-${a.id}`,
    paymongoCheckoutSessionId: method === 'paymongo' ? `cs_${a.id}` : null, paymongoPaymentId: null, ...extra,
  });
  const payments = [
    pay(appointments[0], 'paymongo'),
    pay(appointments[1], 'paymongo'),
    pay(appointments[2], 'paymongo', { paymongoPaymentId: 'pay_3' }),
    pay(appointments[3], 'pay_at_clinic'),
    pay(appointments[4], 'paymongo', { paidAt: new Date(NOW - 181 * DAY) }),
  ];
  state = { appointments, payments, refunds: [], notifications: [], created: [], fetched: [], providerRefunds: {}, existingOnPayment: [] };
}

Appointment.findOne = (f) => query(state.appointments.find((a) => matches(a, f)) || null);
Appointment.find = (f) => query(state.appointments.filter((a) => matches(a, f)));
Payment.findOne = (f) => query(state.payments.find((p) => matches(p, f)) || null);
Payment.exists = async (f) => state.payments.some((p) => matches(p, f)) || null;
Payment.find = (f) => query(state.payments.filter((p) => matches(p, f)));
Payment.findById = (id) => query(state.payments.find((p) => same(p._id, id)) || null);
Payment.updateOne = async (f, u) => { const p = state.payments.find((x) => matches(x, f)); if (p) applyUpdate(p, u); };
Child.findById = () => query({ _id: childId, parentId: new mongoose.Types.ObjectId(parent.userId) });
Child.find = () => query([{ _id: childId, firstName: 'Kemri', lastName: 'Soto' }]);
User.find = () => query([{ _id: new mongoose.Types.ObjectId(parent.userId), firstName: 'Ana', lastName: 'Soto' }]);
Notification.create = async (doc) => { state.notifications.push(doc); return doc; };
GuardianLink.findOne = () => query(null); // no guardian links: only the parent may request

Refund.create = async (doc) => {
  if (doc.activeKey && state.refunds.some((r) => r.activeKey === doc.activeKey)) {
    throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  }
  const row = { _id: oid(), createdAt: new Date(), ...doc };
  state.refunds.push(row);
  return row;
};
Refund.findById = (id) => query(state.refunds.find((r) => same(r._id, id)) ? { ...state.refunds.find((r) => same(r._id, id)) } : null);
Refund.findOne = (f) => query(state.refunds.find((r) => matches(r, f)) || null);
Refund.find = (f) => query(state.refunds.filter((r) => matches(r, f)).map((r) => ({ ...r })));
Refund.findOneAndUpdate = (f, u) => {
  const r = state.refunds.find((x) => matches(x, f));
  if (r) applyUpdate(r, u);
  return query(r ? { ...r } : null);
};
Refund.updateOne = async (f, u) => { const r = state.refunds.find((x) => matches(x, f)); if (r) applyUpdate(r, u); };

// PayMongo: createRefund answers `pending`; retrieveRefund answers whatever
// the test put in providerRefunds.
paymongo.isConfigured = () => true;
paymongo.retrieveCheckoutSession = async (id) => ({ id });
paymongo.readSessionOutcome = (s) => ({ paymentId: `pay_${String(s.id).slice(3)}` });
paymongo.retrievePaymentRefunds = async () => state.existingOnPayment;
paymongo.createRefund = async (args) => {
  state.created.push(args);
  if (state.failCreate) throw Object.assign(new Error(state.failCreate), { statusCode: 400 });
  const id = `ref_${state.created.length}`;
  state.providerRefunds[id] = { id, status: 'pending', amount: args.amount };
  return state.providerRefunds[id];
};
paymongo.retrieveRefund = async (id) => { state.fetched.push(id); return state.providerRefunds[id]; };

const request = (id, user = parent, reason = 'Child is unwell') => refunds.requestRefund({ user, appointmentNumericId: id, reason, now: NOW });
const staff = { userId: String(pediaId), role: 'pediatrician' };
const review = (refundId, decision, note) => refunds.reviewRefund({ user: staff, scopePediatricianId: pediaId, refundId, decision, note });
const rejects = async (p, status, pattern) => {
  await assert.rejects(p, (err) => err.statusCode === status && (!pattern || pattern.test(err.message)));
};

(async () => {
  // 1. Eligibility
  reset();
  await rejects(request(2), 400, /cancelled or rejected/);
  await rejects(request(4), 400, /paid at the clinic.*clinic counter/);
  await rejects(request(5), 400, /within 180 days/);
  await rejects(request(1, otherParent), 403);
  await rejects(request(1, parent, '  '), 400, /why/);
  const r1 = await request(1);
  assert.strictEqual(r1.status, 'pending_review');
  assert.strictEqual(r1.amount, 950, 'amount comes from the payment, not the client');
  assert.ok(state.notifications.some((n) => same(n.userId, pediaId) && n.title === 'Refund Requested'), 'pediatrician notified');
  ok('only a cancelled/rejected online payment within 180 days can be requested, by its parent, with a reason');

  // 2. One live request per payment
  await rejects(request(1), 409, /already been requested/);
  ok('a second request for the same payment is refused (409)');

  // 3. Reject needs a reason, frees the payment for a new request
  await rejects(review(r1._id, 'reject', ''), 400, /reason/);
  await review(r1._id, 'reject', 'Visit was rebooked for free');
  assert.strictEqual(state.refunds[0].status, 'rejected');
  assert.ok(state.notifications.some((n) => n.title === 'Refund Request Rejected' && /rebooked for free/.test(n.message)));
  await rejects(review(r1._id, 'approve'), 409, /already Rejected/);
  assert.strictEqual(state.created.length, 0, 'a rejected request never reaches PayMongo');
  ok('reject requires a reason, tells the parent why, and cannot be approved afterwards');

  // 4. Approve: one PayMongo call, Processing, never Refunded on approval
  const r2 = await request(1);
  const [a, b] = await Promise.allSettled([review(r2._id, 'approve'), review(r2._id, 'approve')]);
  assert.strictEqual(state.created.length, 1, 'double approve sends one refund');
  assert.ok([a, b].some((x) => x.status === 'rejected' && x.reason.statusCode === 409));
  assert.deepStrictEqual(
    { paymentId: state.created[0].paymentId, amount: state.created[0].amount },
    { paymentId: 'pay_1', amount: 950 },
    'pay_ id resolved from the checkout session; full amount'
  );
  let row = state.refunds.find((r) => same(r._id, r2._id));
  assert.strictEqual(row.status, 'processing', 'PayMongo pending -> Processing');
  assert.strictEqual(state.payments[0].status, 'Paid', 'payment untouched until PayMongo confirms');
  ok('approve sends exactly one PayMongo refund; pending shows Processing, not Refunded');

  // 5. Status re-check: succeeded -> Refunded, payment Refunded
  state.providerRefunds.ref_1.status = 'succeeded';
  row.lastProviderSyncAt = new Date(Date.now() - 5 * 60 * 1000);
  const listed = await refunds.listForParent(parent, NOW);
  assert.strictEqual(listed.refunds.find((r) => r.id === String(r2._id)).statusLabel, 'Refunded');
  assert.strictEqual(state.payments[0].status, 'Refunded');
  assert.ok(state.notifications.some((n) => n.title === 'Refund Completed'));
  assert.ok(!listed.eligible.some((e) => e.appointmentId === 1), 'refunded booking cannot be requested again');
  assert.deepStrictEqual(listed.eligible.map((e) => e.appointmentId), [3]);
  assert.deepStrictEqual(listed.clinicPaidAppointmentIds, [4]);
  assert.strictEqual(listed.policy.title, 'Refund Policy');
  ok('PayMongo succeeded (via status re-check) -> Refunded and the payment becomes Refunded');

  // 6. Webhook: re-fetches, and a replay changes nothing
  reset();
  const r3 = await request(3);
  await review(r3._id, 'approve', 'Clinic rejected the visit');
  assert.strictEqual(state.created[0].paymentId, 'pay_3', 'stored PayMongo payment id used directly');
  state.providerRefunds.ref_1.status = 'succeeded';
  paymongo.verifyWebhookSignature = () => ({ ok: true });
  const hook = async () => {
    let out;
    const req = { get: () => 'sig', rawBody: Buffer.from('{}'), body: { data: { id: 'evt_1', attributes: { type: 'payment.refunded', data: { id: 'pay_3', attributes: { refunds: [{ id: 'ref_1', attributes: { status: 'succeeded' } }] } } } } } };
    await controller.handlePaymongoWebhook(req, { status(c) { out = { status: c }; return this; }, json(b) { out.body = b; } });
    return out;
  };
  const first = await hook();
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(state.fetched, ['ref_1'], 'webhook re-fetched the refund from PayMongo');
  assert.strictEqual(state.refunds[0].status, 'refunded');
  const completed = state.notifications.filter((n) => n.title === 'Refund Completed').length;
  await hook();
  assert.strictEqual(state.notifications.filter((n) => n.title === 'Refund Completed').length, completed, 'replay is a no-op');
  ok('payment.refunded webhook re-fetches before applying; a replay changes nothing');

  // 7. Failures: PayMongo refusal and a failed refund both end Failed and free the payment
  reset();
  state.failCreate = 'livemode_mismatched: test payment';
  const r4 = await request(1);
  const failed = await review(r4._id, 'approve');
  assert.strictEqual(failed.status, 'failed');
  assert.match(failed.failureReason, /livemode_mismatched/);
  assert.strictEqual(state.refunds[0].activeKey, undefined);
  assert.strictEqual(state.payments[0].status, 'Paid');
  state.failCreate = null;
  const r5 = await request(1);
  await review(r5._id, 'approve');
  state.providerRefunds.ref_2.status = 'failed';
  const synced = await refunds.syncRefund(state.refunds[1]);
  assert.strictEqual(synced.status, 'failed');
  assert.strictEqual(state.payments[0].status, 'Paid', 'a failed refund never marks the payment refunded');
  assert.ok(state.notifications.some((n) => n.title === 'Refund Failed'));
  ok('a PayMongo refusal or failed refund ends Failed, keeps the payment Paid, and allows a new request');

  // 8. An earlier PayMongo refund on the payment is adopted, not duplicated
  reset();
  state.existingOnPayment = [{ id: 'ref_old', status: 'succeeded', amount: 950 }];
  const r6 = await request(1);
  const adopted = await review(r6._id, 'approve');
  assert.strictEqual(state.created.length, 0, 'no second refund created');
  assert.strictEqual(adopted.status, 'refunded');
  assert.strictEqual(adopted.paymongoRefundId, 'ref_old');
  ok('a refund PayMongo already holds for the payment is adopted instead of created again');

  // 9. Staff scope: other clinic, admin, and secretaries without Manage Payments
  reset();
  const r7 = await request(1);
  await rejects(refunds.reviewRefund({ user: staff, scopePediatricianId: otherPedia, refundId: r7._id, decision: 'approve' }), 403);
  const call = async (handler, user, params = {}, body = {}) => {
    let out;
    await handler({ user, params, body }, { status(c) { out = { status: c }; return this; }, json(b) { out = { status: out?.status || 200, body: b }; } });
    return out;
  };
  const secretary = { userId: String(oid()), role: 'secretary', linkedPediatricianId: String(pediaId) };
  User.findById = () => query({ secretaryPermissions: { managePayments: false } });
  assert.strictEqual((await call(controller.getClinicRefunds, secretary)).status, 403);
  assert.strictEqual((await call(controller.reviewRefund, secretary, { refundId: String(r7._id) }, { decision: 'approve' })).status, 403);
  assert.strictEqual((await call(controller.getClinicRefunds, { userId: String(oid()), role: 'admin' })).status, 403);
  User.findById = () => query({ secretaryPermissions: { managePayments: true } });
  const list = await call(controller.getClinicRefunds, secretary);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.refunds[0].childName, 'Kemri Soto');
  assert.strictEqual(list.body.refunds[0].statusLabel, 'Pending Review');
  assert.strictEqual(state.created.length, 0);
  ok('other clinics, admins and secretaries without Manage Payments are refused; a permitted secretary sees the list');

  // 10. Wiring
  const fs = require('fs');
  const path = require('path');
  const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'payments.js'), 'utf8');
  for (const r of ["get('/refunds/mine'", "post('/appointments/:appointmentId/refund-request'", "get('/refunds/clinic'", "post('/refunds/:refundId/review'"]) {
    assert.ok(routes.includes(r), `route ${r}`);
  }
  const idx = Refund.schema.indexes().find(([fields]) => fields.activeKey === 1);
  assert.ok(idx && idx[1].unique, 'activeKey is unique');
  ok('routes mounted and Refund.activeKey is a unique index');

  // 11. Parent page: status badge, Request Refund only when eligible, policy, one submit
  {
    const vm = require('vm');
    const root = path.join(__dirname, '..', '..');
    const calls = [];
    const els = {};
    const el = (id) => (els[id] ||= { id, value: '', innerHTML: '', textContent: '', disabled: false, style: {} });
    let release;
    const ctx = vm.createContext({
      requireAuth() {}, KC: { user: () => ({ id: 'u1' }), childId: () => null },
      apiFetch: async (url, opts = {}) => {
        calls.push(`${opts.method || 'GET'} ${url}`);
        if (url.endsWith('/refund-request')) await new Promise((r) => { release = r; });
        return { appointments: [], refunds: [], eligible: [], clinicPaidAppointmentIds: [] };
      },
      fmtDate: (d) => String(d), fmtTime: (t) => String(t),
      escapeHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [], querySelector: () => null },
      console: { log() {}, warn() {}, error() {} },
    });
    ctx.window = { addEventListener() {}, location: { href: '' } };
    vm.runInContext(fs.readFileSync(path.join(root, 'js/parent/appointments.js'), 'utf8'), ctx);
    const run = (code) => vm.runInContext(code, ctx);
    run(`refundInfo = ${JSON.stringify({
      refunds: [{ appointmentId: 7, status: 'rejected', statusLabel: 'Rejected', amount: 950, reviewNote: 'Rebooked <free>' }],
      eligible: [{ appointmentId: 8, amount: 950 }],
      clinicPaidAppointmentIds: [9],
      policy: { title: 'Refund Policy', points: ['Only online payments.'] },
    })}`);
    const rejected = run('renderRefundSection({ id: 7 })');
    assert.ok(rejected.includes('Refund: Rejected') && rejected.includes('Rebooked &lt;free&gt;'), 'status and escaped clinic note');
    assert.ok(!rejected.includes('Request Refund'));
    assert.ok(run('renderRefundSection({ id: 8 })').includes('openRefundRequest(8)'));
    assert.ok(/clinic counter/.test(run('renderRefundSection({ id: 9 })')));
    assert.strictEqual(run('renderRefundSection({ id: 10 })'), '');
    run('openRefundRequest(8)');
    assert.strictEqual(el('refundModal').style.display, 'flex');
    assert.strictEqual(el('refundRequestForm').style.display, 'block');
    assert.match(el('refundPolicyBody').innerHTML, /Only online payments/);
    assert.strictEqual(el('refundAmount').textContent, '₱950.00');
    await run('submitRefundRequest()');
    assert.strictEqual(calls.length, 0, 'empty reason is not sent');
    el('refundReason').value = 'Child was unwell';
    const first = run('submitRefundRequest()');
    run('submitRefundRequest()');
    release();
    await first;
    assert.deepStrictEqual(calls.filter((c) => c.startsWith('POST')), ['POST /payments/appointments/8/refund-request'], 'one request per submit');
    const html = fs.readFileSync(path.join(root, 'PARENT/appointments.html'), 'utf8');
    assert.ok(html.includes('onclick="openRefundPolicy()">Refund Policy</button>'), 'policy link on the page');
    ok('parent page: refund badge and note, Request Refund only when eligible, policy shown, one request per submit');
  }

  // 12. Staff pages load the shared panel; it escapes and requires a reject reason
  {
    const root = path.join(__dirname, '..', '..');
    const pedia = fs.readFileSync(path.join(root, 'PEDIA/pediatrician-appointments.html'), 'utf8');
    const cashier = fs.readFileSync(path.join(root, 'SECRETARY/secretary-cashier.html'), 'utf8');
    for (const page of [pedia, cashier]) {
      assert.ok(page.indexOf('/js/shared/refund-requests.js') > page.indexOf('/api.js'), 'shared panel loads after api.js');
      assert.ok(page.includes('id="refundRequestsList"'));
    }
    const vm = require('vm');
    const posts = [];
    const ctx = vm.createContext({
      apiFetch: async (url, opts = {}) => { if (opts.method) posts.push(url); return { refunds: [] }; },
      escapeHtml: (v) => String(v ?? '').replace(/</g, '&lt;'), fmtDate: String, fmtTime: String,
      document: { getElementById: () => ({ innerHTML: '' }), querySelectorAll: () => [] },
      window: { prompt: () => '  ', confirm: () => false }, alert() {}, KC: { poll() {} },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/shared/refund-requests.js'), 'utf8'), ctx);
    const row = vm.runInContext(`renderRefundRequestRow(${JSON.stringify({ id: 'r1', status: 'pending_review', statusLabel: 'Pending Review', amount: 950, reason: '<b>x</b>', childName: 'Kemri', appointmentId: 3 })})`, ctx);
    assert.ok(row.includes('&lt;b>x') && row.includes('data-refund-approve="r1"'));
    await vm.runInContext("reviewRefundRequest('r1', 'reject')", ctx);
    await vm.runInContext("reviewRefundRequest('r1', 'approve')", ctx);
    assert.deepStrictEqual(posts, [], 'blank reject reason or a declined approve sends nothing');
    ok('staff panel is on both staff pages, escapes parent text, and needs a reason or confirmation before acting');
  }

  console.log('Refund workflow tests OK');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
