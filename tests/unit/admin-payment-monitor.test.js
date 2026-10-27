// Admin Payments monitor (ADMIN bug scan C13, C24, C27, P6).
//
//   C13 "Total Collected" and the counts were added up from the newest 500
//       rows only; they now come from one $group over every matching payment.
//   P6  Down and partial payments hold money actually received, so they are
//       "collected" (services/adminOperationsAnalytics.js), here and on the
//       Analytics and Reports pages.
//   C27 The page had no admin check, offered Receipt on unpaid rows (the
//       receipt route refuses those) and its "no results" row spanned 7 of 12
//       columns. A bad ?from= date crashed the request; it is now a 400.
//
// No DB: Payment, User and Child are stubbed and the controller is called
// directly.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Payment = require('../../models/Payment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const { getAdminPaymentMonitor } = require('../../controllers/paymentController');

const results = [];
const ok = (label) => results.push(label);
const chain = (value) => { const q = { sort: () => q, limit: (n) => { q.limitN = n; return q; }, select: () => q, lean: () => q, then: (a, b) => Promise.resolve(value).then(a, b) }; return q; };

let lastAggregate = null;
let lastFind = null;
let aggregateRows = [];
let listed = [];
Payment.find = (q) => { lastFind = q; return chain(listed); };
Payment.aggregate = async (pipeline) => { lastAggregate = pipeline; return aggregateRows; };
User.find = () => chain([]);
Child.find = () => chain([]);

const call = async (query) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const saved = console.error;
  console.error = () => {};
  try { await getAdminPaymentMonitor({ user: { role: 'admin' }, query }, res); } finally { console.error = saved; }
  return res;
};

(async () => {
  // ── Totals cover every payment, not the 500 listed ──────────────────────
  listed = Array.from({ length: 500 }, (_, i) => ({ id: i, status: 'Paid', amount: 100, paymentMethod: 'paymongo' }));
  aggregateRows = [
    { _id: { status: 'Paid', method: 'paymongo' }, count: 700, amount: 70000 },
    { _id: { status: 'Paid', method: 'pay_at_clinic' }, count: 50, amount: 5000.25 },
    { _id: { status: 'Down Payment', method: 'cash' }, count: 10, amount: 1500 },
    { _id: { status: 'Partially Paid', method: 'cash' }, count: 2, amount: 400 },
    { _id: { status: 'Pending', method: 'paymongo' }, count: 30, amount: 0 },
    { _id: { status: 'Verification Pending', method: 'ewallet' }, count: 3, amount: 900 },
    { _id: { status: 'Expired', method: 'paymongo' }, count: 4, amount: 0 },
    { _id: { status: 'Refunded', method: 'paymongo' }, count: 1, amount: 100 },
    { _id: { status: 'Cancelled', method: 'cash' }, count: 5, amount: 0 },
  ];
  let r = await call({});
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const s = r.body.summary;
  assert.strictEqual(s.paid, 762, 'paid in full or in part, across all payments');
  assert.strictEqual(s.paidAmount, 76900.25, 'collected money includes down and partial payments, never pending ones');
  assert.strictEqual(s.pending, 33);
  assert.strictEqual(s.failed, 4);
  assert.strictEqual(s.refunded, 1);
  assert.strictEqual(s.online, 735);
  assert.strictEqual(s.payAtClinic, 50);
  assert.strictEqual(s.count, 805, 'count is every matching payment');
  assert.strictEqual(s.shown, 500, 'the table still lists the newest 500');
  assert.strictEqual(r.body.payments.length, 500);
  ok('totals and counts come from all matching payments, and down/partial payments count as collected');

  // ── Filters reach both the list and the totals ──────────────────────────
  r = await call({ from: '2026-09-01', to: '2026-09-30', method: 'cash', status: 'Down Payment' });
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(lastAggregate[0].$match, lastFind, 'the totals use the same filter as the list');
  assert.strictEqual(lastFind.paymentMethod, 'cash');
  assert.strictEqual(lastFind.status, 'Down Payment');
  assert(lastFind.createdAt.$gte instanceof Date && lastFind.createdAt.$lte instanceof Date);
  r = await call({ from: 'yesterday' });
  assert.strictEqual(r.statusCode, 400, 'a bad date is a 400, not a crash');
  r = await call({ from: '2026-10-02', to: '2026-10-01' });
  assert.strictEqual(r.statusCode, 400);
  r = await call({ method: { $ne: 'x' } });
  assert.strictEqual(typeof lastFind.paymentMethod, 'string', 'query objects are not passed to MongoDB');
  ok('the date range, method and status filter both the list and the totals; bad dates are refused');

  // ── Non-admins and errors ───────────────────────────────────────────────
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await getAdminPaymentMonitor({ user: { role: 'parent' }, query: {} }, res);
  assert.strictEqual(res.statusCode, 403);
  Payment.aggregate = async () => { throw new Error('secret driver detail'); };
  r = await call({});
  assert.strictEqual(r.statusCode, 500);
  assert(!JSON.stringify(r.body).includes('secret driver detail'));
  ok('non-admins are refused and internal errors stay on the server');

  // ── Page ────────────────────────────────────────────────────────────────
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'ADMIN', 'admin-payments.html'), 'utf8');
  assert.match(html, /function guardAdminPage\(\)[\s\S]*?user\.role !== 'admin'/, 'the page checks the admin role');
  assert(!/colspan="7"/.test(html), 'every full-width row spans all 12 columns');
  assert.match(html, /p\.status === 'Paid' && \(p\.paymentRef \|\| p\.receiptNumber\)/, 'Receipt is offered on Paid rows only');
  for (const st of ['Down Payment', 'Partially Paid']) assert(html.includes(`<option value="${st}">`), `${st} can be filtered`);
  ok('the page checks the admin role, offers Receipt on Paid rows only and spans all columns');

  console.log(results.map((m) => `  ok - ${m}`).join('\n'));
  console.log(`Admin payment monitor tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
