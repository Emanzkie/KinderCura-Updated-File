// Regression test: POST /api/auth/register must only trust a RECENT email
// verification, and must use it up.
//
// The bug: register accepted any signup code ever marked used for the email,
// with no time limit, and never consumed it. A verification from long ago
// still counted, and the same verification could back more than one attempt.
//
// Now /verify-otp stamps verifiedAt, register requires verifiedAt within the
// last 30 minutes, and a successful registration deletes the email's signup
// codes. Password-reset codes are never touched.
//
// No DB and no network: models are monkey-patched against in-memory lists
// (filters matched with sift) and the handlers are called directly.
const assert = require('assert');
const mongoose = require('mongoose');
const sift = require('sift').default || require('sift');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || `unit-test-only-${Math.random()}`;
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const Child = require('../../models/Child');
const OtpCode = require('../../models/OtpCode');
const router = require('../../routes/auth');

const EMAIL = 'fresh.parent@example.invalid';
const MIN = 60 * 1000;
let otps = [];
let created = [];
const plain = (f) => JSON.parse(JSON.stringify(f));
const matches = (f) => (r) => sift(plain(f))(plain(r));
const q = (value) => { const o = { sort: () => o, select: () => o, lean: () => o, then: (a, b) => Promise.resolve(value).then(a, b) }; return o; };

OtpCode.findOne = (f) => q(otps.filter(matches(f)).sort((a, b) => b.createdAt - a.createdAt)[0] || null);
OtpCode.deleteMany = async (f) => { const m = matches(f); otps = otps.filter((r) => !m(r)); };
User.findOne = () => q(null);
User.create = async (doc) => { created.push(doc); return { ...doc, save: async () => {} }; };
Child.create = async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId(), save: async () => {} });

function handler(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.post);
  assert(layer, `POST ${path} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const register = handler('/register');
const verify = handler('/verify-otp');

async function call(fn, body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { await fn({ body, files: undefined, file: undefined }, res); } finally { Object.assign(console, saved); }
  return res;
}
const account = {
  role: 'parent', firstName: 'Fresh', lastName: 'Parent', username: 'fresh_parent', email: EMAIL, password: 'a-long-enough-pw',
  childFirstName: 'Luz', childLastName: 'Parent', dateOfBirth: `${new Date().getFullYear() - 5}-01-15`, gender: 'female', relationship: 'mother',
  acceptTerms: true, acknowledgePrivacy: true,
};
const row = (fields) => ({ email: EMAIL, code: '4821', used: false, attempts: 0, createdAt: new Date(),
  expiresAt: new Date(Date.now() + 10 * MIN), save: async () => {}, ...fields });
const reset = () => { otps = []; created = []; };
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. /verify-otp stamps verifiedAt, and a fresh verification registers.
  reset();
  const pending = row();
  pending.save = async () => pending;
  otps.push(pending);
  let r = await call(verify, { email: EMAIL, code: '4821' });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(pending.verifiedAt instanceof Date && Date.now() - pending.verifiedAt < 5000, 'verifiedAt stamped');
  r = await call(register, account);
  assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  assert.strictEqual(created.length, 1);
  ok('verify stamps verifiedAt; a fresh verification lets the account be created');

  // 2. The verification is used up: signup codes for the email are deleted,
  //    and a password-reset code for the same email is left alone.
  reset();
  otps.push(row({ used: true, verifiedAt: new Date() }));
  otps.push(row({ purpose: 'password_reset', code: 'f'.repeat(64) }));
  r = await call(register, account);
  assert.strictEqual(r.statusCode, 201);
  assert.deepStrictEqual(otps.map((o) => o.purpose), ['password_reset'], 'only the reset code remains');
  r = await call(register, { ...account, username: 'second_try' });
  assert.strictEqual(r.statusCode, 400, 'the same verification cannot back a second registration');
  ok('a successful registration uses the verification up; reset codes are untouched');

  // 3. A verification older than 30 minutes is refused, with a clear message.
  reset();
  otps.push(row({ used: true, verifiedAt: new Date(Date.now() - 31 * MIN) }));
  r = await call(register, account);
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.body.error, /Please verify your email first.*30 minutes/);
  assert.strictEqual(created.length, 0);
  ok('a verification older than 30 minutes is refused');

  // 4. A used code from before verifiedAt existed is never trusted.
  reset();
  otps.push(row({ used: true }));
  r = await call(register, account);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(created.length, 0);
  ok('an old used code with no verifiedAt is not accepted');

  console.log('\nRegister verification window tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
