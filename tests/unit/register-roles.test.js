// Regression test: public sign-up (POST /api/auth/register) must never create
// an admin. It used to accept role 'admin' and save the account as active,
// so anyone with a verified email could become an administrator.
//
// No DB and no network: every model method the route could reach throws, so a
// rejected role is proven to stop before anything is looked up or written.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const OtpCode = require('../../models/OtpCode');
const router = require('../../routes/auth');

const touched = [];
const trap = (name) => () => { touched.push(name); throw new Error(`${name} must not be called`); };
User.findOne = trap('User.findOne');
User.create = trap('User.create');
OtpCode.findOne = trap('OtpCode.findOne');

const layer = router.stack.find((l) => l.route && l.route.path === '/register' && l.route.methods.post);
assert(layer, 'POST /register exists');
const register = layer.route.stack[layer.route.stack.length - 1].handle;

async function call(role) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const body = {
    role, firstName: 'Test', lastName: 'User', username: `u_${role}`,
    email: `${role}@example.invalid`, password: 'long-enough-pw',
  };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { await register({ body, files: undefined, file: undefined }, res); } finally { Object.assign(console, saved); }
  return res;
}

const ok = (m) => console.log('  ok -', m);

(async () => {
  for (const role of ['admin', 'secretary', 'legal_guardian', 'foster_parent', 'court_appointed', 'superuser']) {
    touched.length = 0;
    const res = await call(role);
    assert.strictEqual(res.statusCode, 400, `${role}: expected 400, got ${res.statusCode}`);
    assert.match(res.body.error, /Only parent and pediatrician accounts can sign up/, `${role}: role error`);
    assert.deepStrictEqual(touched, [], `${role}: nothing may be looked up or written`);
  }
  ok('admin, secretary, other guardian roles and unknown roles are refused with 400 before any database call');

  // The two sign-up roles get past the role check (they then stop at the next
  // rule, the required consent, which proves the role itself was accepted).
  for (const role of ['parent', 'pediatrician']) {
    const res = await call(role);
    assert.strictEqual(res.statusCode, 400);
    assert.doesNotMatch(res.body.error, /Invalid user role/, `${role} must pass the role check`);
  }
  ok('parent and pediatrician still pass the role check');

  console.log('\nRegister role tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
