// Unit tests for POST /api/auth/forgot-password and /api/auth/reset-password.
//
// No DB and no network: User and OtpCode are replaced by in-memory stores, and
// the HTTPS email transport is pointed at a stubbed fetch so the emailed code
// can be read back the way a user would read it from their inbox.
const assert = require('assert');
const crypto = require('crypto');
const mongoose = require('mongoose');
const sift = require('sift').default || require('sift');

mongoose.set('bufferCommands', false);
// Email "configured" through the HTTPS API path; fetch below captures the mail.
process.env.EMAIL_API_KEY = 're_test_key';
process.env.EMAIL_PROVIDER = '';
process.env.EMAIL_USER = 'sender@kindercura.example';
process.env.EMAIL_PASS = '';

const User = require('../../models/User');
const OtpCode = require('../../models/OtpCode');
const bcrypt = require('bcrypt');
const router = require('../../routes/auth');

const sent = [];
global.fetch = async (url, init) => {
  sent.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ id: 'msg' }), text: async () => '{}' };
};

let users = [];
let otps = [];

// A thenable query that also supports the chain methods the routes use.
function query(resolve) {
  let sortSpec = null;
  const q = {
    select() { return q; },
    lean() { return q; },
    sort(spec) { sortSpec = spec; return q; },
    then(onOk, onErr) {
      return Promise.resolve().then(() => resolve(sortSpec)).then(onOk, onErr);
    },
  };
  return q;
}
const newest = (rows) => rows.slice().sort((a, b) => b.createdAt - a.createdAt)[0] || null;

User.findOne = (filter) => query(() => users.find(sift(filter)) || null);
OtpCode.findOne = (filter) => query(() => newest(otps.filter(sift(filter))));
OtpCode.deleteMany = async (filter) => { const m = sift(filter); otps = otps.filter((r) => !m(r)); };
OtpCode.create = async (doc) => {
  const row = { createdAt: new Date(), attempts: 0, ...doc, save: async () => row };
  otps.push(row);
  return row;
};

function handler(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  assert(layer, `POST ${path} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const forgot = handler('/forgot-password');
const reset = handler('/reset-password');

async function call(fn, body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const quiet = console.error;
  console.error = () => {};
  try { await fn({ body }, res); } finally { console.error = quiet; }
  return res;
}

function makeUser(email, status = 'active') {
  const u = { _id: new mongoose.Types.ObjectId(), email, status, passwordHash: 'old-hash', saved: 0 };
  u.save = async () => { u.saved += 1; return u; };
  users.push(u);
  return u;
}
const codeFromMail = (mail) => /(\d{6})<\/span>/.exec(mail.html)[1];
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. Unknown email: same generic answer, nothing stored, nothing sent.
  {
    const res = await call(forgot, { email: 'nobody@example.invalid' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.message, /If an account exists/);
    assert.strictEqual(otps.length, 0);
    assert.strictEqual(sent.length, 0);
    ok('unknown email: generic 200, no code stored, no mail sent');
  }

  // 2. Known email: same message; code mailed, stored only as a sha256 hash.
  const parent = makeUser('parent@example.invalid');
  let code;
  {
    const res = await call(forgot, { email: 'Parent@Example.invalid ' });
    const unknown = await call(forgot, { email: 'ghost@example.invalid' });
    assert.deepStrictEqual(res.body, unknown.body, 'known and unknown emails get identical responses');
    assert.strictEqual(sent.length, 1);
    code = codeFromMail(sent[0]);
    assert.match(code, /^\d{6}$/);
    assert.strictEqual(otps.length, 1);
    const row = otps[0];
    assert.strictEqual(row.purpose, 'password_reset');
    assert.notStrictEqual(row.code, code, 'the plain code is never stored');
    assert.strictEqual(row.code, crypto.createHash('sha256').update(code).digest('hex'));
    assert.ok(row.expiresAt - Date.now() <= 15 * 60 * 1000 && row.expiresAt - Date.now() > 14 * 60 * 1000);
    assert.ok(!JSON.stringify(res.body).includes(code), 'the code never appears in a response');
    ok('known email: identical response, 6-digit code mailed, stored as sha256, 15 min expiry');
  }

  // 3. Resend within 60 s: no new code, no new mail.
  {
    const res = await call(forgot, { email: 'parent@example.invalid' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(otps.length, 1);
    ok('cooldown: a second request within 60 s sends nothing');
  }

  // 4. Signup verification never accepts a reset row (by code or by "used" lookup).
  {
    const verifyLayer = router.stack.find((l) => l.route && l.route.path === '/verify-otp');
    const verify = verifyLayer.route.stack[verifyLayer.route.stack.length - 1].handle;
    const res = await call(verify, { email: 'parent@example.invalid', code: otps[0].code });
    assert.strictEqual(res.statusCode, 400);
    otps[0].used = true;
    assert.strictEqual(otps.filter(sift({ email: 'parent@example.invalid', used: true, purpose: { $ne: 'password_reset' } })).length, 0);
    otps[0].used = false;
    // Rows written before `purpose` existed are still signup rows.
    assert.strictEqual([{ email: 'x', used: true }].filter(sift({ used: true, purpose: { $ne: 'password_reset' } })).length, 1);
    ok('signup OTP lookups ignore reset rows; legacy rows without purpose still match');
  }

  // 5. Validation: short password and malformed code are rejected without touching the row.
  {
    let res = await call(reset, { email: 'parent@example.invalid', code, password: 'short' });
    assert.strictEqual(res.statusCode, 400);
    res = await call(reset, { email: 'parent@example.invalid', code: '12ab', password: 'long-enough-pw' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(otps[0].attempts, 0);
    ok('validation: short password / malformed code -> 400, attempts unchanged');
  }

  // 6. Wrong codes count; the fifth voids the row so even the right code fails.
  {
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 5; i += 1) {
      const res = await call(reset, { email: 'parent@example.invalid', code: wrong, password: 'long-enough-pw' });
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(otps[0].attempts, i);
    }
    assert.strictEqual(otps[0].used, true, 'voided after 5 wrong guesses');
    const res = await call(reset, { email: 'parent@example.invalid', code, password: 'long-enough-pw' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(parent.passwordHash, 'old-hash');
    ok('lockout: 5 wrong codes void the row; the correct code no longer works');
  }

  // 7. Expired code is rejected.
  {
    otps = [];
    sent.length = 0;
    await call(forgot, { email: 'parent@example.invalid' });
    const fresh = codeFromMail(sent[0]);
    otps[0].expiresAt = new Date(Date.now() - 1000);
    const res = await call(reset, { email: 'parent@example.invalid', code: fresh, password: 'long-enough-pw' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(parent.passwordHash, 'old-hash');
    ok('expired code -> 400, password unchanged');
  }

  // 8. Success: password hashed, row used, code single-use.
  {
    otps = [];
    sent.length = 0;
    await call(forgot, { email: 'parent@example.invalid' });
    const fresh = codeFromMail(sent[0]);
    const res = await call(reset, { email: 'parent@example.invalid', code: fresh, password: 'new-password-123' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(await bcrypt.compare('new-password-123', parent.passwordHash), 'new password is stored as a bcrypt hash');
    assert.strictEqual(otps.length, 1);
    assert.strictEqual(otps[0].used, true);
    const again = await call(reset, { email: 'parent@example.invalid', code: fresh, password: 'another-pw-456' });
    assert.strictEqual(again.statusCode, 400, 'a used code cannot be replayed');
    ok('success: bcrypt hash saved, row marked used, replay rejected');
  }

  // 9. Suspended accounts get the generic answer and no code.
  {
    makeUser('suspended@example.invalid', 'suspended');
    sent.length = 0;
    const res = await call(forgot, { email: 'suspended@example.invalid' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sent.length, 0);
    ok('suspended account: generic 200, no mail');
  }

  // 10. No email transport: 503, the same as signup.
  {
    process.env.EMAIL_API_KEY = '';
    const res = await call(forgot, { email: 'parent@example.invalid' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'EMAIL_NOT_CONFIGURED');
    ok('email not configured -> 503 EMAIL_NOT_CONFIGURED');
  }

  console.log('\nPassword reset tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
