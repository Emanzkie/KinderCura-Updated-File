// Regression test: POST /api/auth/login checks the password before it reports
// a pending or suspended account.
//
// The bug: the status checks ran first, so anyone who typed an email or
// username with ANY password learned that the account existed and whether it
// was pending or suspended.
//
// No DB and no network: User.findOne is monkey-patched and the handler is
// called directly from the router stack.
const assert = require('assert');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || `unit-test-only-${Math.random()}`;
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const router = require('../../routes/auth');

const layer = router.stack.find((l) => l.route && l.route.path === '/login' && l.route.methods.post);
assert(layer, 'POST /login exists');
const login = layer.route.stack[layer.route.stack.length - 1].handle;

let account;
User.findOne = async () => account;

async function call(password) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const { log } = console;
  console.log = () => {};
  try { await login({ body: { email: 'someone@example.invalid', password } }, res); } finally { console.log = log; }
  return res;
}
const ok = (m) => console.log('  ok -', m);

(async () => {
  const passwordHash = await bcrypt.hash('right-password-1', 10);
  const GENERIC = 'Invalid email/username or password.';

  for (const [status, role, message] of [
    ['pending', 'pediatrician', /pending admin approval/],
    ['pending', 'parent', /not yet active/],
    ['suspended', 'parent', /suspended/],
  ]) {
    account = { _id: new mongoose.Types.ObjectId(), role, status, passwordHash };

    // Wrong password: the same generic 401 as an unknown account.
    let r = await call('wrong-password');
    assert.strictEqual(r.statusCode, 401, `${status} ${role}, wrong password: 401`);
    assert.strictEqual(r.body.error, GENERIC, `${status} ${role}: status not revealed`);

    // Right password: the real status message.
    r = await call('right-password-1');
    assert.strictEqual(r.statusCode, 403, `${status} ${role}, right password: 403`);
    assert.match(r.body.error, message);
  }
  ok('pending and suspended accounts give the generic 401 for a wrong password');
  ok('the pending/suspended message appears only with the correct password');

  // An unknown account gives exactly the same answer as a wrong password.
  account = null;
  const r = await call('anything');
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(r.body.error, GENERIC);
  ok('an unknown account answers identically');

  console.log('\nLogin status order tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
