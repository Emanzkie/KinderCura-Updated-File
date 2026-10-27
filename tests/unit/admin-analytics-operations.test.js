// Unit tests for the Admin Analytics operations figures:
// services/adminOperationsAnalytics.js and GET /api/admin/analytics/operations.
//
// Locked in here:
//   - payment status groups match the Admin Payments monitor exactly, and only
//     'Paid' amounts count as collected; unknown statuses stay "other";
//   - counts and amounts are separate measures;
//   - the period is whole UTC days, validated, and applied only to
//     registrations and transactions;
//   - real and synthetic accounts are split, never merged silently;
//   - admin-only, no clinical field in the response, and no write to the
//     clinic settings document.
//
// No DB: the models the route reads are replaced by in-memory stand-ins.
const assert = require('assert');

const Ops = require('../../services/adminOperationsAnalytics');
const User = require('../../models/User');
const Payment = require('../../models/Payment');
const SystemSetting = require('../../models/SystemSetting');
const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');
const { adminOnly } = require('../../middleware/auth');

function testPaymentGroupsMatchMonitor() {
  assert.strictEqual(Ops.paymentGroupFor('Paid'), 'collected');
  // A down or partial payment record holds money actually received.
  assert.strictEqual(Ops.paymentGroupFor('Down Payment'), 'collected');
  assert.strictEqual(Ops.paymentGroupFor('Partially Paid'), 'collected');
  assert.strictEqual(Ops.paymentGroupFor('Pending'), 'pending');
  assert.strictEqual(Ops.paymentGroupFor('Verification Pending'), 'pending');
  assert.strictEqual(Ops.paymentGroupFor('Failed'), 'failed');
  assert.strictEqual(Ops.paymentGroupFor('Expired'), 'failed');
  assert.strictEqual(Ops.paymentGroupFor('Refunded'), 'refunded');
  for (const s of ['Cancelled', 'Something New']) {
    assert.strictEqual(Ops.paymentGroupFor(s), 'other', s);
  }
  // Every status the Payment schema allows is either grouped or "other".
  for (const s of Payment.schema.path('status').enumValues) {
    assert.ok(['collected', 'pending', 'failed', 'refunded', 'other'].includes(Ops.paymentGroupFor(s)), s);
  }
}

function testSummarizePayments() {
  const t = Ops.summarizePayments([
    { _id: { status: 'Paid', currency: 'PHP' }, count: 12, amount: 10650 },
    { _id: { status: 'Paid' }, count: 4, amount: 2000 },
    { _id: { status: 'Pending', currency: 'PHP' }, count: 8, amount: 0 },
    { _id: { status: 'Verification Pending' }, count: 2, amount: 500 },
    { _id: { status: 'Failed', currency: 'PHP' }, count: 1, amount: 0 },
    { _id: { status: 'Expired', currency: 'PHP' }, count: 1, amount: 0 },
    { _id: { status: 'Down Payment', currency: 'PHP' }, count: 3, amount: 1500.5 },
    { _id: { status: 'Cancelled', currency: 'PHP' }, count: 2, amount: 300 },
  ]);
  const g = Object.fromEntries(t.groups.map((x) => [x.key, x]));
  assert.strictEqual(t.totalCount, 33);
  // Down payments are money received, so they count as collected.
  assert.deepStrictEqual([g.collected.count, g.collected.amount], [19, 14150.5]);
  // A pending record's amount is never added to collected money.
  assert.deepStrictEqual([g.pending.count, g.pending.amount], [10, 500]);
  assert.strictEqual(g.failed.count, 2);
  assert.strictEqual(g.refunded.count, 0);
  assert.deepStrictEqual(g.other.statuses, ['Cancelled']);
  assert.deepStrictEqual([g.other.count, g.other.amount], [2, 300]);
  assert.strictEqual(t.groups.reduce((n, x) => n + x.count, 0), t.totalCount);
  assert.deepStrictEqual(t.currencies, ['PHP']);
  assert.strictEqual(t.recordsWithoutCurrency, 6);
  assert.strictEqual(t.statuses.find((s) => s.status === 'Paid').count, 16);
}

function testParsePeriod() {
  assert.deepStrictEqual(Ops.parsePeriod({}), { from: null, to: null });
  const p = Ops.parsePeriod({ from: '2026-09-01', to: '2026-09-30' });
  assert.strictEqual(p.from.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.strictEqual(p.to.toISOString(), '2026-09-30T23:59:59.999Z');
  assert.ok(Ops.parsePeriod({ from: '09/01/2026' }).error);
  assert.ok(Ops.parsePeriod({ from: '2026-10-02', to: '2026-10-01' }).error);
  assert.deepStrictEqual(Ops.periodMatch('createdAt', { from: null, to: null }), {});
  assert.deepStrictEqual(Object.keys(Ops.periodMatch('createdAt', p).createdAt), ['$gte', '$lte']);
}

function testBuildMonthlySignups() {
  const rows = [{ _id: { year: 2026, month: 9 }, count: 133, syntheticCount: 133 }, { _id: { year: 2026, month: 8 }, count: 257, syntheticCount: 256 }];
  const months = Ops.buildMonthlySignups(rows, new Date(2026, 9, 16));
  assert.deepStrictEqual(months.map((m) => m.month), ['May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026']);
  assert.deepStrictEqual(months[3], { month: 'Aug 2026', count: 257, syntheticCount: 256 });
  // A month with no accounts is a real 0, not missing.
  assert.deepStrictEqual(months[5], { month: 'Oct 2026', count: 0, syntheticCount: 0 });
  assert.ok(Ops.monthlySignupsPipeline()[0].$group.syntheticCount);
}

function testSplitBySynthetic() {
  const rows = Ops.splitBySynthetic([
    { _id: { key: 'parent', synthetic: true }, count: 1082 },
    { _id: { key: 'parent', synthetic: false }, count: 5 },
    { _id: { key: 'admin', synthetic: false }, count: 1 },
    { _id: { key: null, synthetic: false }, count: 2 },
  ]);
  assert.deepStrictEqual(rows[0], { key: 'parent', real: 5, synthetic: 1082, total: 1087 });
  assert.deepStrictEqual(rows.find((r) => r.key === null), { key: null, real: 2, synthetic: 0, total: 2 });
}

// ── Route ───────────────────────────────────────────────────────────────────

const aggregateCalls = { users: [], payments: [] };
User.aggregate = async (pipeline) => {
  aggregateCalls.users.push(pipeline);
  const groupId = pipeline.find((st) => st.$group).$group._id;
  if (groupId.year) return [{ _id: { year: 2026, month: 9 }, count: 133, syntheticCount: 133 }, { _id: { year: 2026, month: 8 }, count: 257, syntheticCount: 256 }];
  const group = groupId.key;
  if (group === '$role') {
    return [
      { _id: { key: 'parent', synthetic: true }, count: 10 },
      { _id: { key: 'parent', synthetic: false }, count: 2 },
      { _id: { key: 'pediatrician', synthetic: false }, count: 1 },
    ];
  }
  if (group === '$status') return [{ _id: { key: 'active', synthetic: false }, count: 3 }, { _id: { key: 'pending', synthetic: true }, count: 10 }];
  return [{ _id: { key: 'verified', synthetic: false }, count: 1 }];
};
Payment.aggregate = async (pipeline) => {
  aggregateCalls.payments.push(pipeline);
  return [{ _id: { status: 'Paid', currency: 'PHP' }, count: 2, amount: 1000 }, { _id: { status: 'Pending', currency: 'PHP' }, count: 1, amount: 0 }];
};
Child.countDocuments = async () => 1554;
Appointment.aggregate = async () => [{ _id: 'pending', count: 233 }, { _id: 'approved', count: 292 }, { _id: 'cancelled', count: 10 }];
let settingsWrites = 0;
let storedSettings = null;
SystemSetting.findOne = () => ({ select: () => ({ lean: async () => storedSettings }) });
SystemSetting.findOneAndUpdate = () => { settingsWrites += 1; throw new Error('must not write'); };

const router = require('../../routes/admin');

async function call(query, user = { userId: 'a1', role: 'admin' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/analytics/operations' && l.route.methods.get);
  assert(layer, 'route GET /analytics/operations exists');
  const stack = layer.route.stack.map((s) => s.handle);
  assert.strictEqual(stack[stack.length - 2], adminOnly, 'guarded by adminOnly');
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { query, user };
  let passed = false;
  await stack[stack.length - 2](req, res, () => { passed = true; });
  if (passed) await stack[stack.length - 1](req, res);
  return res;
}

async function testRoute() {
  const res = await call({ from: '2026-09-01', to: '2026-09-30' });
  assert.strictEqual(res.statusCode, 200);
  const b = res.body;
  assert.deepStrictEqual(b.accounts.total, { real: 3, synthetic: 10, total: 13 });
  assert.strictEqual(b.clinic.profileSaved, false);
  assert.strictEqual(settingsWrites, 0);
  // Non-clinical figures the page needs, so it never calls GET /analytics.
  assert.strictEqual(b.childRecords, 1554);
  assert.strictEqual(b.appointments.active, 525, 'pending + approved');
  assert.deepStrictEqual(b.appointments.byStatus.find((a) => a.status === 'pending'), { status: 'pending', count: 233 });
  assert.strictEqual(b.monthlySignups.length, 6);
  assert.strictEqual(b.transactions.groups.find((g) => g.key === 'collected').amount, 1000);
  // The period reaches registrations and payments only.
  const periodUserPipelines = aggregateCalls.users.filter((p) => p[0].$match && p[0].$match.createdAt);
  assert.strictEqual(periodUserPipelines.length, 1);
  assert.ok(aggregateCalls.payments[0][0].$match.createdAt);
  // No clinical field anywhere in the response.
  assert.ok(!/score|band|diagnos|outcome|assessment/i.test(JSON.stringify(b)), JSON.stringify(b));

  // A settings document whose clinic subdocument has no name (the reported
  // "Not set"): the name stays null — never the schema default — and the
  // payment switches shown are flagged as defaults rather than saved choices.
  storedSettings = { clinic: { paymongoMethods: ['gcash'] }, updatedAt: new Date('2026-09-01') };
  let c = (await call({})).body.clinic;
  assert.strictEqual(c.profileSaved, true);
  assert.strictEqual(c.name, null);
  assert.deepStrictEqual(c.unsavedFields, ['clinicName', 'active', 'onlinePaymentEnabled', 'payAtClinicEnabled']);
  assert.strictEqual(c.onlinePaymentEnabled, true);
  storedSettings = { clinic: { clinicName: 'Sta. Rosa Pediatrics', active: true, onlinePaymentEnabled: false, payAtClinicEnabled: true } };
  c = (await call({})).body.clinic;
  assert.strictEqual(c.name, 'Sta. Rosa Pediatrics');
  assert.strictEqual(c.onlinePaymentEnabled, false);
  assert.deepStrictEqual(c.unsavedFields, []);
  storedSettings = null;
  assert.deepStrictEqual((await call({})).body.clinic.unsavedFields, []);
  assert.strictEqual(settingsWrites, 0);

  assert.strictEqual((await call({ from: 'bad' })).statusCode, 400);
  assert.strictEqual((await call({}, { userId: 'p1', role: 'pediatrician' })).statusCode, 403);
}

// The page and its script must agree. The reported failure was a script
// writing to elements the page no longer had ("Cannot set properties of
// null") and calling Chart.js on a page that no longer loads it.
function testPageScriptContract() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'ADMIN', 'admin-analytics.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'js', 'admin', 'admin-analytics.js'), 'utf8');
  const ids = new Set();
  for (const m of js.matchAll(/(?:byId|setText|getElementById)\('([A-Za-z0-9_-]+)'/g)) ids.add(m[1]);
  for (const m of js.matchAll(/\[((?:'[A-Za-z0-9_-]+'(?:, )?)+)\]\.forEach/g)) {
    for (const id of m[1].match(/[A-Za-z0-9_-]+/g)) ids.add(id);
  }
  assert.ok(ids.size > 20, `found ${ids.size} ids`);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [], `script writes to ids the page does not have: ${missing.join(', ')}`);
  const loadsChart = /chart\.js@|chart\.umd/i.test(html);
  assert.ok(loadsChart || !/\bnew Chart\(|\bChart\./.test(js), 'the script uses Chart.js but the page does not load it');
  // One data source: the admin-only operations endpoint, never GET /analytics.
  assert.ok(js.includes('/admin/analytics/operations'));
  assert.ok(!/apiFetch\('\/admin\/analytics'\)/.test(js), 'the page must not poll GET /api/admin/analytics');
}

async function run() {
  testPaymentGroupsMatchMonitor();
  testSummarizePayments();
  testParsePeriod();
  testPageScriptContract();
  testBuildMonthlySignups();
  testSplitBySynthetic();
  await testRoute();
  console.log('Admin analytics operations OK — payment groups match the payments monitor, collected = money received (paid, down and partial), period on registrations and transactions only, real/synthetic split, admin-only, no clinical fields, no settings write');
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
