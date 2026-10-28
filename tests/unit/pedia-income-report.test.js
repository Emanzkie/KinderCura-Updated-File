// Pediatrician Reports, Section D: weekly and monthly income
// (GET /api/pedia-reports/income in routes/pedia-reports.js).
//
// Income is added up from the Payment records on every request, with the same
// "collected" rule as the admin pages (Paid, Down Payment, Partially Paid),
// on Manila calendar days and Monday-to-Sunday weeks. Older payments saved
// without pediatricianId are reached through their appointment.
//
// No DB: models are stubbed and the real handler is called from the router.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const router = require('../../routes/pedia-reports');
const { buildIncomeSummary, weekStartOf } = router._internals;

const results = [];
const ok = (m) => results.push(m);

// "Now" is Wednesday 28 Oct 2026, noon in Manila (04:00 UTC).
const NOW = new Date('2026-10-28T04:00:00Z');
const pay = (status, amount, when, extra = {}) => ({ status, amount, paidAt: when ? new Date(when) : null, ...extra });

// 1. Weeks run Monday to Sunday in Manila time, newest first, continuous.
assert.strictEqual(weekStartOf('2026-10-28'), '2026-10-26');
assert.strictEqual(weekStartOf('2026-11-01'), '2026-10-26', 'Sunday belongs to the week that started on Monday');
assert.strictEqual(weekStartOf('2026-10-26'), '2026-10-26');
let s = buildIncomeSummary([], NOW);
assert.strictEqual(s.weekly.length, 8);
assert.deepStrictEqual([s.weekly[0].start, s.weekly[0].end], ['2026-10-26', '2026-11-01']);
assert.deepStrictEqual([s.weekly[7].start, s.weekly[7].end], ['2026-09-07', '2026-09-13']);
for (let i = 1; i < s.weekly.length; i += 1) {
  const gapDays = (new Date(s.weekly[i - 1].start) - new Date(s.weekly[i].end)) / 86400000;
  assert.strictEqual(gapDays, 1, 'weeks follow each other with no gap or overlap');
}
assert.strictEqual(s.monthly.length, 12);
assert.deepStrictEqual([s.monthly[0].month, s.monthly[0].start, s.monthly[0].end], ['2026-10', '2026-10-01', '2026-10-31']);
assert.deepStrictEqual([s.monthly[1].start, s.monthly[1].end], ['2026-09-01', '2026-09-30']);
assert.deepStrictEqual([s.monthly[8].start, s.monthly[8].end], ['2026-02-01', '2026-02-28']);
assert.deepStrictEqual([s.monthly[11].month], ['2025-11']);
assert.ok(s.weekly.every((w) => w.total === 0 && w.count === 0), 'weeks with no money are listed at 0');
assert.strictEqual(s.thisWeek, s.weekly[0]);
assert.strictEqual(s.thisMonth, s.monthly[0]);
ok('date ranges: 8 Monday-Sunday weeks and 12 calendar months, continuous, current first');

// 2. Manila day boundaries, collected statuses only, no estimates.
s = buildIncomeSummary([
  pay('Paid', 1000, '2026-10-25T15:30:00Z'),          // Sun 25 Oct 23:30 Manila -> previous week
  pay('Paid', 500, '2026-10-25T16:30:00Z'),           // Mon 26 Oct 00:30 Manila -> this week
  pay('Down Payment', 300, '2026-10-27T02:00:00Z'),    // counts
  pay('Partially Paid', 200.5, '2026-10-27T03:00:00Z'), // counts
  pay('Pending', 999, '2026-10-27T03:00:00Z'),
  pay('Verification Pending', 999, '2026-10-27T03:00:00Z'),
  pay('Failed', 999, '2026-10-27T03:00:00Z'),
  pay('Refunded', 999, '2026-10-27T03:00:00Z'),
  pay('Cancelled', 999, '2026-10-27T03:00:00Z'),
  pay('Paid', 700, '2026-09-30T16:30:00Z'),           // 1 Oct 00:30 Manila -> October, not September
  pay('Paid', 400, null, { transactionDate: new Date('2026-09-10T09:00:00Z') }), // no paidAt: transactionDate
], NOW);
assert.deepStrictEqual([s.thisWeek.total, s.thisWeek.count], [1000.5, 3]);
assert.deepStrictEqual([s.weekly[1].total, s.weekly[1].count], [1000, 1]);
assert.deepStrictEqual([s.thisMonth.total, s.thisMonth.count], [2700.5, 5]);
assert.deepStrictEqual([s.monthly[1].total, s.monthly[1].count], [400, 1]);
const weeklySum = s.weekly.reduce((n, w) => n + w.total, 0);
assert.strictEqual(Math.round(weeklySum * 100) / 100, 3100.5, 'each payment lands in exactly one week');
ok('totals: Paid/Down Payment/Partially Paid only, Manila days, a payment without paidAt uses transactionDate');

// 2b. Mode of payment: online vs paid at the clinic, adding up to the total.
const { paymentModeFor } = router._internals;
for (const m of ['paymongo', 'ewallet', 'gcash', 'maya', 'card', 'bank_transfer', 'simulated_gateway']) assert.strictEqual(paymentModeFor(m), 'online', m);
for (const m of ['pay_at_clinic', 'cash', 'check']) assert.strictEqual(paymentModeFor(m), 'clinic', m);
for (const m of Payment.schema.path('paymentMethod').enumValues) assert.notStrictEqual(paymentModeFor(m), 'other', `${m} has a mode`);
s = buildIncomeSummary([
  pay('Paid', 1000, '2026-10-27T02:00:00Z', { paymentMethod: 'paymongo' }),
  pay('Paid', 400, '2026-10-27T03:00:00Z', { paymentMethod: 'pay_at_clinic' }),
  pay('Paid', 500, '2026-10-27T04:00:00Z', { paymentMethod: 'cash' }),
  pay('Refunded', 999, '2026-10-27T04:00:00Z', { paymentMethod: 'paymongo' }),
], NOW);
assert.deepStrictEqual(s.thisWeek.byMode.online, { total: 1000, count: 1 });
assert.deepStrictEqual(s.thisWeek.byMode.clinic, { total: 900, count: 2 });
assert.strictEqual(s.thisWeek.byMode.online.total + s.thisWeek.byMode.clinic.total, s.thisWeek.total);
assert.deepStrictEqual(s.thisMonth.byMode.clinic, { total: 900, count: 2 });
ok('mode of payment: every stored method is online or at clinic, and the two add up to the total');

// 3. The endpoint: scoped to the signed-in pediatrician, incl. older records
//    reached through their appointment; pediatricians only.
const handler = (() => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/income' && l.route.methods.get);
  return layer.route.stack.map((x) => x.handle);
})();
const call = (user) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  const req = { user, query: {} };
  // [authMiddleware, pediatriciansOnly, handler]: auth is set up by hand here.
  Promise.resolve(handler[1](req, res, () => handler[2](req, res))).catch(reject);
});

const pedId = String(new mongoose.Types.ObjectId());
const apptId = new mongoose.Types.ObjectId();
let paymentQuery = null;
Appointment.find = (q) => ({ distinct: async (field) => (q.pediatricianId === pedId && field === '_id' ? [apptId] : []) });
Payment.find = (q) => {
  paymentQuery = q;
  const chain = { select: () => chain, lean: async () => [pay('Paid', 1000, '2026-10-27T02:00:00Z')] };
  return chain;
};

(async () => {
  let r = await call({ userId: pedId, role: 'pediatrician' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(paymentQuery.status, { $in: ['Paid', 'Down Payment', 'Partially Paid'] });
  assert.deepStrictEqual(paymentQuery.$or, [
    { pediatricianId: pedId },
    { pediatricianId: null, appointmentId: { $in: [apptId] } },
  ]);
  assert.strictEqual(r.body.currency, 'PHP');
  assert.strictEqual(r.body.weekly.length, 8);
  ok('endpoint: collected payments of the signed-in pediatrician, older ones through their appointments');

  for (const role of ['parent', 'secretary', 'admin']) {
    r = await call({ userId: pedId, role });
    assert.strictEqual(r.status, 403, `${role} is refused`);
  }
  ok('endpoint: pediatricians only');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Pediatrician income report tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
