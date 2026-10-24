// Regression test for the signup email-code wrong-guess limit
// (POST /api/auth/verify-otp).
//
// The bug: the route looked a code up by email AND code, so a wrong guess
// matched nothing and could be repeated without limit; all 10,000 four-digit
// codes could be tried within a code's 10-minute life, letting someone verify
// (and then register) an email address they do not own.
//
// Now each wrong guess is counted on the newest unused signup code, and the
// fifth wrong guess deletes it. It is deleted rather than marked used, because
// /register treats a used signup code as proof the email was verified.
//
// No DB and no network: OtpCode statics are monkey-patched against an
// in-memory list and the handler is called directly from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');
const sift = require('sift').default || require('sift');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const OtpCode = require('../../models/OtpCode');
const router = require('../../routes/auth');

let rows = [];
const lastFilters = [];
function addRow(fields) {
  const row = { _id: new mongoose.Types.ObjectId(), email: 'new@example.invalid', code: '4821', used: false,
    attempts: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000), ...fields };
  row.save = async () => row;
  rows.push(row);
  return row;
}
const plain = (f) => JSON.parse(JSON.stringify(f));
OtpCode.findOne = (filter) => {
  lastFilters.push(filter);
  const hits = rows.filter(sift(plain(filter))).sort((a, b) => b.createdAt - a.createdAt);
  const q = { sort: () => q, then: (ok, ko) => Promise.resolve(hits[0] || null).then(ok, ko) };
  return q;
};
OtpCode.deleteOne = async (filter) => { rows = rows.filter((r) => String(r._id) !== String(filter._id)); };

const layer = router.stack.find((l) => l.route && l.route.path === '/verify-otp' && l.route.methods.post);
assert(layer, 'POST /verify-otp exists');
const verify = layer.route.stack[layer.route.stack.length - 1].handle;

async function call(code, email = 'new@example.invalid') {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const { log, error } = console;
  console.log = console.error = () => {};
  try { await verify({ body: { email, code } }, res); } finally { Object.assign(console, { log, error }); }
  return res;
}
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. The right code verifies once.
  rows = [];
  let row = addRow();
  let r = await call('4821');
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(row.used, true);
  assert.strictEqual((await call('4821')).statusCode, 400, 'a used code cannot be reused');
  ok('the correct code verifies once and cannot be reused');

  // 2. Wrong guesses are counted; four wrong then the right code still works.
  rows = [];
  row = addRow();
  for (let i = 1; i <= 4; i += 1) {
    r = await call('0000');
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.error, 'Invalid OTP.');
    assert.strictEqual(row.attempts, i, `attempt ${i} counted`);
  }
  r = await call('4821');
  assert.strictEqual(r.statusCode, 200);
  ok('each wrong guess is counted; after 4 the correct code still verifies');

  // 3. The fifth wrong guess voids the code: even the right code then fails,
  //    and the voided code is deleted, never left as "used".
  rows = [];
  row = addRow();
  for (let i = 1; i <= 4; i += 1) await call('1111');
  r = await call('1111');
  assert.strictEqual(r.statusCode, 429);
  assert.strictEqual(r.body.code, 'OTP_LOCKED');
  assert.match(r.body.error, /request a new verification code/);
  assert.strictEqual(rows.length, 0, 'voided code is deleted');
  assert.strictEqual(row.used, false, 'voided code is never marked used');
  r = await call('4821');
  assert.strictEqual(r.statusCode, 400, 'the correct code no longer works');
  assert.strictEqual(rows.filter(sift({ email: 'new@example.invalid', used: true })).length, 0,
    '/register finds no verified code for this email');
  ok('the 5th wrong guess voids (deletes) the code; register sees no verified code');

  // 4. An expired code is refused even when correct.
  rows = [];
  addRow({ expiresAt: new Date(Date.now() - 1000) });
  r = await call('4821');
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.error, 'OTP expired.');
  ok('an expired code is refused');

  // 5. Password-reset codes are never matched by signup verification.
  rows = [];
  addRow({ purpose: 'password_reset', code: 'f'.repeat(64) });
  r = await call('4821');
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(plain(lastFilters.at(-1).purpose), { $ne: 'password_reset' });
  ok('signup verification ignores password-reset codes');

  console.log('\nSignup OTP attempt-limit tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
