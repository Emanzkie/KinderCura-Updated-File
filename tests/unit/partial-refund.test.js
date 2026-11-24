// The 50% refund rule (Terms of Service section 16, constants/refundPolicy.js):
// who cancelled is recorded, the server sets the refund amount, staff may raise a
// parent-cancelled refund to 100% with a reason, and totals count the kept half.
//
// No DB, no network: models and PayMongo are stubbed in memory.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
const Ops = require('../../services/adminOperationsAnalytics');
const { refundFor, REFUND_POLICY } = require('../../constants/refundPolicy');
const { buildStatement } = require('../../services/statementOfAccount');
const { summarizeConfirmationPayment } = require('../../services/paymentService');
const appointmentsRouter = require('../../routes/appointments');

const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const same = (a, b) => String(a) === String(b);
const query = (value) => {
  const q = { lean: () => q, sort: () => q, limit: () => q, select: () => q, then: (a, b) => Promise.resolve(value).then(a, b), catch: (f) => Promise.resolve(value).catch(f) };
  return q;
};
const matches = (doc, f) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && '$in' in v
  ? v.$in.some((x) => same(x, doc[k])) : same(v, doc[k])));
const applyUpdate = (doc, u) => { Object.assign(doc, u.$set || {}); for (const k of Object.keys(u.$unset || {})) delete doc[k]; };

const parent = { userId: String(oid()), role: 'parent' };
const guardian = { userId: String(oid()), role: 'legal_guardian' };
const pediaId = oid();
const childId = oid();
const staff = { userId: String(pediaId), role: 'pediatrician' };
let appt; let payment; let rows; let created; let provider; let notes; let existing; let guardianAllowed;

function reset({ cancelledBy = 'family', status = 'cancelled', amount = 400, ...extra } = {}) {
  appt = { _id: oid(), id: 1, status, cancelledBy, parentId: new mongoose.Types.ObjectId(parent.userId), childId, pediatricianId: pediaId, totalAmount: 400, appointmentDate: new Date(), appointmentTime: '09:00', paymentStatus: 'Paid', amountPaid: amount };
  appt.save = async () => appt; appt.toObject = () => appt;
  payment = { _id: oid(), appointmentId: appt._id, appointmentNumericId: 1, paymentMethod: 'paymongo', status: 'Paid', amount, paidAt: new Date(Date.now() - 2 * DAY), paymongoPaymentId: 'pay_1', paymongoSourceType: 'gcash', receiptNumber: 'KC-RCPT-1', ...extra };
  rows = []; created = []; provider = {}; notes = []; existing = []; guardianAllowed = false;
}

Appointment.findOne = () => query(appt);
Appointment.find = () => query([appt]);
Payment.findOne = (f) => query(matches(payment, f) ? payment : null);
Payment.find = () => query([payment]);
Payment.findById = () => query(payment);
Payment.exists = async () => null;
Payment.updateOne = async (f, u) => { if (matches(payment, f)) applyUpdate(payment, u); };
Child.findById = () => query({ _id: childId, firstName: 'Kemri', lastName: 'Soto', parentId: new mongoose.Types.ObjectId(parent.userId) });
User.findById = () => query({ firstName: 'Ana', lastName: 'Soto' });
User.findOne = () => query(null);
Notification.create = async (d) => { notes.push(d); return d; };
GuardianLink.findOne = () => query(guardianAllowed ? { status: 'active', permissions: { manageAppointments: true } } : null);
Refund.create = async (d) => {
  if (rows.some((r) => r.activeKey === d.activeKey)) throw Object.assign(new Error('dup'), { code: 11000 });
  const r = { _id: oid(), ...d }; rows.push(r); return r;
};
Refund.findById = (id) => { const r = rows.find((x) => same(x._id, id)); return query(r ? { ...r } : null); };
Refund.find = () => query(rows.map((r) => ({ ...r })));
Refund.findOneAndUpdate = (f, u) => { const r = rows.find((x) => matches(x, f)); if (r) applyUpdate(r, u); return query(r ? { ...r } : null); };
Refund.updateOne = async (f, u) => { const r = rows.find((x) => matches(x, f)); if (r) applyUpdate(r, u); };
paymongo.isConfigured = () => true;
paymongo.retrievePaymentRefunds = async () => existing;
paymongo.createRefund = async (a) => { created.push(a); const r = { id: `ref_${created.length}`, status: 'pending', amount: a.amount }; provider[r.id] = r; return r; };
paymongo.retrieveRefund = async (id) => provider[id];

const request = () => refunds.requestRefund({ user: parent, appointmentNumericId: 1, reason: 'Change of plans' });
const review = (id, extra = {}) => refunds.reviewRefund({ user: staff, scopePediatricianId: pediaId, refundId: id, decision: 'approve', ...extra });
const rejects = (p, status, re) => assert.rejects(p, (e) => e.statusCode === status && re.test(e.message));
const settle = async () => { provider.ref_1.status = 'succeeded'; return refunds.syncRefund(rows.find((r) => r.status === 'processing') || rows[0]); };

async function call(method, routePath, user, body = {}) {
  const layer = appointmentsRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ params: { appointmentId: '1', id: '1' }, user, body }, res);
  return res;
}

(async () => {
  // 1. Amounts
  assert.deepStrictEqual(refundFor({ status: 'cancelled', cancelledBy: 'family' }, 400), { paidAmount: 400, refundPercent: 50, amount: 200 });
  assert.strictEqual(refundFor({ status: 'cancelled', cancelledBy: 'family' }, 333.33).amount, 166.67);
  for (const a of [{ status: 'cancelled', cancelledBy: 'clinic' }, { status: 'cancelled', cancelledBy: null }, { status: 'cancelled' }, { status: 'rejected', cancelledBy: 'family' }]) {
    assert.deepStrictEqual(refundFor(a, 400), { paidAmount: 400, refundPercent: 100, amount: 400 }, JSON.stringify(a));
  }
  assert.ok(REFUND_POLICY.points.some((p) => /50%/.test(p)) && REFUND_POLICY.points.some((p) => /100%/.test(p)));
  ok('50% only when the family cancelled; clinic, rejected and older records are 100%');

  // 2. Who cancelled
  const cancelled = async (user, setup = () => {}) => {
    reset({ status: 'approved', cancelledBy: null }); setup();
    const r = await call('post', '/:appointmentId/cancel', user);
    return [r.statusCode, appt.status, appt.cancelledBy];
  };
  assert.deepStrictEqual(await cancelled(parent), [200, 'cancelled', 'family']);
  assert.deepStrictEqual(await cancelled(guardian, () => { guardianAllowed = true; }), [200, 'cancelled', 'family']);
  assert.deepStrictEqual(await cancelled(staff), [200, 'cancelled', 'clinic']);
  assert.deepStrictEqual(await cancelled({ userId: String(oid()), role: 'admin' }), [200, 'cancelled', 'clinic']);
  for (const [status, by] of [['cancelled', 'clinic'], ['rejected', null]]) {
    reset({ status: 'pending', cancelledBy: null });
    const r = await call('put', '/:appointmentId/status', staff, { status });
    assert.deepStrictEqual([r.statusCode, appt.status, appt.cancelledBy], [200, status, by]);
  }
  // A secretary goes through the same staff route, so it is the clinic too.
  reset({ status: 'pending', cancelledBy: null });
  User.findById = () => query({ firstName: 'Sec', lastName: 'Retary', secretaryPermissions: { manageBookings: true } });
  const sec = await call('put', '/:appointmentId/status', { userId: String(oid()), role: 'secretary', linkedPediatricianId: String(pediaId) }, { status: 'cancelled' });
  assert.deepStrictEqual([sec.statusCode, appt.cancelledBy], [200, 'clinic']);
  ok('parent and guardian cancellations are recorded as family; pediatrician, secretary and admin as clinic');

  // 3. 50%: request, approve, PayMongo confirms, payment keeps the rest
  reset();
  assert.deepStrictEqual((await refunds.listForParent(parent)).eligible, [{ appointmentId: 1, paidAmount: 400, refundPercent: 50, amount: 200 }]);
  const r1 = await request();
  assert.deepStrictEqual([r1.amount, r1.paidAmount, r1.refundPercent], [200, 400, 50]);
  const both = await Promise.allSettled([review(r1._id), review(r1._id)]);
  assert.strictEqual(created.length, 1, 'double approve sends one refund');
  assert.ok(both.some((x) => x.status === 'rejected'));
  assert.strictEqual(created[0].amount, 200);
  assert.strictEqual(payment.refundedAmount, undefined, 'nothing recorded before PayMongo confirms');
  await settle();
  assert.deepStrictEqual([rows[0].status, payment.status, payment.amount, payment.refundedAmount, payment.receiptNumber], ['refunded', 'Paid', 400, 200, 'KC-RCPT-1']);
  const sent = notes.length;
  await refunds.applyProviderRefund(rows[0]._id, provider.ref_1);
  assert.deepStrictEqual([notes.length, payment.refundedAmount], [sent, 200], 'a replay changes nothing');
  await rejects(request(), 409, /already been requested/);
  assert.deepStrictEqual((await refunds.listForParent(parent)).eligible, [], 'the other half cannot be requested');
  ok('a 50% refund sends half once, records it on confirmation, keeps the payment Paid, and cannot be repeated');

  // 4. Full refund by staff, with a reason; the browser never sets an amount
  reset();
  const r2 = await request();
  await rejects(review(r2._id, { full: true, note: '  ' }), 400, /reason/);
  assert.strictEqual(rows[0].status, 'pending_review');
  await review(r2._id, { full: true, note: 'System was down' });
  assert.deepStrictEqual([created[0].amount, rows[0].amount, rows[0].refundPercent, rows[0].reviewNote], [400, 400, 100, 'System was down']);
  await settle();
  assert.deepStrictEqual([payment.status, payment.refundedAmount], ['Refunded', undefined]);
  reset({ cancelledBy: 'clinic' });
  const r3 = await request();
  await review(r3._id, { full: false });
  assert.strictEqual(created[0].amount, 400, 'a clinic cancellation is always 100%');
  reset();
  const r4 = await request();
  const passed = [];
  const original = refunds.reviewRefund;
  refunds.reviewRefund = async (a) => { passed.push(a); return { status: 'approved' }; };
  for (const body of [{ decision: 'approve', full: 'yes', amount: 9999 }, { decision: 'approve', full: true, note: 'x' }]) {
    await controller.reviewRefund({ user: staff, params: { refundId: String(r4._id) }, body }, { status() { return this; }, json() {} });
  }
  refunds.reviewRefund = original;
  assert.deepStrictEqual(passed.map((p) => [p.full, 'amount' in p]), [[false, false], [true, false]]);
  ok('staff give 100% only with a reason; clinic cancellations stay 100%; client amounts are ignored');

  // 5. Requests filed before the rule keep their stored amount
  reset();
  rows.push({ _id: oid(), appointmentNumericId: 1, paymentId: payment._id, pediatricianId: pediaId, amount: 400, status: 'pending_review', activeKey: String(payment._id) });
  await review(rows[0]._id);
  assert.strictEqual(created[0].amount, 400);
  ok('an already filed request keeps its amount');

  // 6. Maya same day
  for (const [source, paidAt, blocked] of [['paymaya', new Date(), true], ['maya', new Date(Date.now() - 2 * DAY), false], ['gcash', new Date(), false]]) {
    reset({ paymongoSourceType: source, paidAt });
    const r = await request();
    if (blocked) {
      await rejects(review(r._id), 409, /tomorrow/);
      assert.deepStrictEqual([rows[0].status, created.length], ['pending_review', 0]);
      await review(r._id, { full: true, note: 'Service problem' });
      assert.strictEqual(created[0].amount, 400, 'a full Maya refund is allowed the same day');
    } else {
      await review(r._id);
      assert.strictEqual(created[0].amount, 200, source);
    }
  }
  ok('a 50% Maya refund waits for the next day and stays pending; GCash does not');

  // 7. Failed and adopted
  reset();
  const r5 = await request();
  await review(r5._id);
  provider.ref_1.status = 'failed';
  await refunds.syncRefund(rows[0]);
  assert.deepStrictEqual([rows[0].status, payment.status, payment.refundedAmount], ['failed', 'Paid', undefined]);
  await request();
  reset();
  existing = [{ id: 'ref_old', status: 'succeeded', amount: 200 }];
  const r6 = await request();
  await review(r6._id, { full: true, note: 'Retry' });
  assert.deepStrictEqual([created.length, rows[0].amount, payment.status, payment.refundedAmount], [0, 200, 'Paid', 200], 'the real amount of an adopted refund is recorded');
  ok('a failed 50% refund changes nothing and can be requested again; an adopted refund records its real amount');

  // 8. Totals, income, statement, status
  const half = { status: 'Paid', amount: 400, refundedAmount: 200, paymentMethod: 'paymongo', paymentType: 'full_payment', paidAt: new Date() };
  const closed = { id: 1, status: 'cancelled', totalAmount: 400 };
  assert.strictEqual(summarizeConfirmationPayment(closed, [half]).verifiedPaid, 200);
  const s = buildStatement(closed, [half]);
  assert.deepStrictEqual([s.totalPaid, s.totalRefunded, s.balanceDue, s.payments[0].amount, s.payments[0].refundedAmount], [200, 200, 0, 400, 200]);
  const fullRow = buildStatement(closed, [{ ...half, status: 'Refunded', refundedAmount: 0 }]);
  assert.deepStrictEqual([fullRow.totalPaid, fullRow.totalRefunded], [0, 400]);
  assert.deepStrictEqual(Ops.NET_AMOUNT, { $subtract: [{ $ifNull: ['$amount', 0] }, { $ifNull: ['$refundedAmount', 0] }] });
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  for (const [f, n] of [['routes/admin.js', 2], ['routes/admin-clinics.js', 1], ['controllers/paymentController.js', 1]]) {
    assert.strictEqual(src(f).split('adminOps.NET_AMOUNT').length - 1, n, f);
    assert.ok(!/\$sum: \{ \$ifNull: \['\$amount'/.test(src(f)), `${f} sums net amounts only`);
  }
  const { buildIncomeSummary } = require('../../routes/pedia-reports')._internals;
  assert.strictEqual(buildIncomeSummary([half]).thisWeek.total, 200);
  ok('collected totals, income and the statement count only the kept half');

  // 9. Staff panel
  const vm = require('vm');
  const posts = [];
  let typed = '  ';
  const ctx = vm.createContext({
    apiFetch: async (url, o = {}) => { if (o.body) posts.push(JSON.parse(o.body)); return { refunds: [] }; },
    escapeHtml: (v) => String(v ?? ''), fmtDate: String, fmtTime: String,
    document: { getElementById: () => ({ innerHTML: '' }), querySelectorAll: () => [] },
    window: { prompt: () => typed, confirm: () => true }, alert() {}, KC: { poll() {} },
  });
  vm.runInContext(src('js/shared/refund-requests.js'), ctx);
  const row = (o) => vm.runInContext(`renderRefundRequestRow(${JSON.stringify({ id: 'r1', status: 'pending_review', statusLabel: 'Pending', reason: 'x', appointmentId: 1, ...o })})`, ctx);
  const partial = row({ amount: 200, paidAmount: 400, refundPercent: 50 });
  assert.ok(partial.includes('Refund 50% ₱200.00') && partial.includes('Refund 100% ₱400.00') && partial.includes('Paid ₱400.00'));
  assert.ok(!row({ amount: 400, paidAmount: 400, refundPercent: 100 }).includes('data-refund-full'));
  await vm.runInContext("reviewRefundRequest('r1', 'approve', true)", ctx);
  assert.deepStrictEqual(posts, [], 'a blank reason sends nothing');
  typed = 'System problem';
  await vm.runInContext("reviewRefundRequest('r1', 'approve', true)", ctx);
  await vm.runInContext("reviewRefundRequest('r1', 'approve')", ctx);
  assert.deepStrictEqual(posts, [{ decision: 'approve', note: 'System problem', full: true }, { decision: 'approve', note: '', full: false }]);
  ok('the staff panel offers 50% and, for parent cancellations, 100% with a reason');

  console.log('Partial refund tests OK');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
