// Account-status gate for pediatricians (PEDIATRICIAN_BUGS.md #2).
//
// A signed JWT used to be the whole check, so a pediatrician who was pending,
// rejected (the PRC check sets status back to 'pending') or suspended could
// still call every pediatrician API until the 48h token ran out, and
// POST /api/auth/register even handed a pending pediatrician a token.
//
// No DB, no network: User.findById is stubbed, and the register route runs
// against in-memory stubs with the file store faked.
const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const OtpCode = require('../../models/OtpCode');
const Notification = require('../../models/Notification');
const Child = require('../../models/Child');
const fileStorage = require('../../services/fileStorage');
const { authMiddleware } = require('../../middleware/auth');
const router = require('../../routes/auth');

const results = [];
const ok = (label) => results.push(label);

// Awaitable, chainable stand-in for a Mongoose query.
const query = (value) => {
  const q = { select: () => q, lean: () => q, sort: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

async function runMiddleware(role, lookup) {
  let lookups = 0;
  User.findById = (id) => { lookups += 1; return query(lookup(id)); };
  const token = jwt.sign({ userId: 'u1', role }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const out = { status: null, body: null, nextCalled: false };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  await new Promise((resolve) => {
    const done = () => setImmediate(resolve);
    const origJson = res.json;
    res.json = (b) => { origJson(b); done(); return res; };
    authMiddleware(req, res, () => { out.nextCalled = true; done(); });
  });
  return { ...out, lookups };
}

(async () => {
  // ── authMiddleware ──────────────────────────────────────────────────────
  for (const [status, pattern] of [['pending', /pending admin approval/], ['suspended', /suspended/]]) {
    const r = await runMiddleware('pediatrician', () => ({ status }));
    assert.strictEqual(r.status, 403, `${status} pediatrician must be refused`);
    assert.match(r.body.error, pattern);
    assert.strictEqual(r.nextCalled, false, `${status}: route must not run`);
  }
  ok('pending and suspended pediatricians are refused with 403 and the route never runs');

  for (const doc of [{ status: 'active' }, {}]) {
    const r = await runMiddleware('pediatrician', () => doc);
    assert.strictEqual(r.nextCalled, true, `${JSON.stringify(doc)} must pass`);
    assert.strictEqual(r.status, null);
  }
  ok('active pediatricians, and legacy accounts with no stored status, still pass');

  let r = await runMiddleware('pediatrician', () => null);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.nextCalled, false);
  ok('a token for a deleted pediatrician account is refused with 401');

  const savedErr = console.error;
  console.error = () => {};
  r = await runMiddleware('pediatrician', () => Promise.reject(new Error('db down')));
  console.error = savedErr;
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.nextCalled, false, 'a failed status lookup must not let the request through');
  ok('a failed status lookup refuses the request instead of letting it through');

  for (const role of ['parent', 'admin', 'secretary', 'legal_guardian']) {
    r = await runMiddleware(role, () => ({ status: 'pending' }));
    assert.strictEqual(r.nextCalled, true, `${role} must be unaffected`);
    assert.strictEqual(r.lookups, 0, `${role}: no extra database read`);
  }
  ok('other roles are unchanged and make no extra database read');

  // ── POST /api/auth/register ─────────────────────────────────────────────
  const layer = router.stack.find((l) => l.route && l.route.path === '/register' && l.route.methods.post);
  const register = layer.route.stack[layer.route.stack.length - 1].handle;

  User.findOne = () => query(null);
  OtpCode.findOne = () => query({ _id: 'otp', email: 'x', used: true });
  OtpCode.deleteMany = async () => ({});
  Notification.create = async () => ({});
  fileStorage.storeFile = async () => 'uploads/prc/prc_test.jpg';
  fileStorage.existsStored = async () => true;
  User.create = async (data) => ({ ...data, save: async () => {} });
  Child.create = async (data) => ({ ...data, _id: new mongoose.Types.ObjectId(), save: async () => {} });

  async function registerAs(role) {
    const body = {
      role, firstName: 'Dee', lastName: 'Doc', username: `u_${role}`, email: `${role}@example.invalid`,
      password: 'S3cret-Pass-Word', acceptTerms: 'true', acknowledgePrivacy: 'true',
      licenseNumber: 'PRC-1', phoneNumber: '09123456789', licenseExpiry: '2999-01-01',
      clinicName: 'Clinic', clinicAddress: 'Address', specialization: 'Pediatrics',
      childFirstName: 'Kid', childLastName: 'Test', dateOfBirth: new Date(Date.now() - 5 * 365.25 * 864e5).toISOString().slice(0, 10),
      gender: 'male', relationship: 'mother',
    };
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const saved = { ...console }; const errors = []; res.errors = errors;
    console.log = console.warn = () => {}; console.error = (...a) => errors.push(a.map(String).join(' '));
    try {
      await register({ body, files: undefined, file: { originalname: 'prc.jpg', filename: 'prc.jpg', path: 'x', mimetype: 'image/jpeg', size: 1 } }, res);
    } finally { Object.assign(console, saved); }
    return res;
  }

  const pedia = await registerAs('pediatrician');
  assert.strictEqual(pedia.statusCode, 201, JSON.stringify(pedia.body) + pedia.errors.join(' | '));
  assert.strictEqual(pedia.body.status, 'pending');
  assert.strictEqual(pedia.body.token, undefined, 'a pending pediatrician must not be given a token');
  ok('registering a pediatrician returns status pending and no token');

  const parent = await registerAs('parent');
  assert.strictEqual(parent.statusCode, 201, JSON.stringify(parent.body) + parent.errors.join(' | '));
  assert.strictEqual(typeof parent.body.token, 'string', 'parents still get a token');
  ok('registering a parent still returns a token');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npediatrician-account-status.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
