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
const { adminOnly } = require('../../middleware/auth');

function testPaymentGroupsMatchMonitor() {
  assert.strictEqual(Ops.paymentGroupFor('Paid'), 'collected');
  assert.strictEqual(Ops.paymentGroupFor('Pending'), 'pending');
  assert.strictEqual(Ops.paymentGroupFor('Verification Pending'), 'pending');
  assert.strictEqual(Ops.paymentGroupFor('Failed'), 'failed');
  assert.strictEqual(Ops.paymentGroupFor('Expired'), 'failed');
  assert.strictEqual(Ops.paymentGroupFor('Refunded'), 'refunded');
  for (const s of ['Down Payment', 'Partially Paid', 'Cancelled', 'Something New']) {
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
  ]);
  const g = Object.fromEntries(t.groups.map((x) => [x.key, x]));
  assert.strictEqual(t.totalCount, 31);
  assert.deepStrictEqual([g.collected.count, g.collected.amount], [16, 12650]);
  // A pending record's amount is never added to collected money.
  assert.deepStrictEqual([g.pending.count, g.pending.amount], [10, 500]);
  assert.strictEqual(g.failed.count, 2);
  assert.strictEqual(g.refunded.count, 0);
  assert.deepStrictEqual(g.other.statuses, ['Down Payment']);
  assert.deepStrictEqual([g.other.count, g.other.amount], [3, 1500.5]);
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
  const group = pipeline.find((st) => st.$group).$group._id.key;
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
let settingsWrites = 0;
SystemSetting.findOne = () => ({ select: () => ({ lean: async () => null }) });
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
  assert.strictEqual(b.transactions.groups.find((g) => g.key === 'collected').amount, 1000);
  // The period reaches registrations and payments only.
  const periodUserPipelines = aggregateCalls.users.filter((p) => p[0].$match && p[0].$match.createdAt);
  assert.strictEqual(periodUserPipelines.length, 1);
  assert.ok(aggregateCalls.payments[0][0].$match.createdAt);
  // No clinical field anywhere in the response.
  assert.ok(!/score|band|diagnos|outcome|assessment/i.test(JSON.stringify(b)), JSON.stringify(b));

  assert.strictEqual((await call({ from: 'bad' })).statusCode, 400);
  assert.strictEqual((await call({}, { userId: 'p1', role: 'pediatrician' })).statusCode, 403);
}

async function run() {
  testPaymentGroupsMatchMonitor();
  testSummarizePayments();
  testParsePeriod();
  testSplitBySynthetic();
  await testRoute();
  console.log('Admin analytics operations OK — payment groups match the payments monitor, collected = Paid only, period on registrations and transactions only, real/synthetic split, admin-only, no clinical fields, no settings write');
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
