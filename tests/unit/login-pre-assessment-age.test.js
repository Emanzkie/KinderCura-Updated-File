// Login requires the first assessment only for an own child aged 3 to 8, and
// opens it for that child. No DB and no network: models are stubbed.
const assert = require('assert');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || `unit-test-only-${Math.random()}`;
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Assessment = require('../../models/Assessment');
const childAge = require('../../js/shared/child-age');
const router = require('../../routes/auth');

const layer = router.stack.find((l) => l.route && l.route.path === '/login' && l.route.methods.post);
const login = layer.route.stack[layer.route.stack.length - 1].handle;

const today = childAge.todayInTimeZone(childAge.CLINIC_TIME_ZONE);
// A birthday `years` ago today, moved by `days`.
const born = (years, days = 0) => new Date(Date.UTC(today.year - years, today.month - 1, today.day + days));

const parentId = new mongoose.Types.ObjectId();
let own; let linked; let completed;
const chain = (rows) => ({ sort() { return this; }, select() { return this; }, lean: async () => rows });
Child.find = (q) => chain(q.parentId ? own : [...own, ...linked]);
GuardianLink.find = () => ({ lean: async () => linked.map((c) => ({ childId: c._id })) });
Assessment.exists = async () => completed;

async function run(setup) {
  ({ own = [], linked = [], completed = false } = setup);
  const passwordHash = await bcrypt.hash('right-password-1', 4);
  User.findOne = async () => ({ _id: parentId, role: 'parent', status: 'active', passwordHash });
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const { log } = console;
  console.log = () => {};
  try { await login({ body: { email: 'p@example.invalid', password: 'right-password-1' } }, res); } finally { console.log = log; }
  assert.strictEqual(res.statusCode, 200);
  return res.body;
}
const kid = (dateOfBirth) => ({ _id: new mongoose.Types.ObjectId(), dateOfBirth });

(async () => {
  const five = kid(born(5)); const nine = kid(born(9)); const almostNine = kid(born(9, 1)); const two = kid(born(2));

  let r = await run({ own: [five] });
  assert.strictEqual(r.needsPreAssessment, true);
  assert.strictEqual(r.preAssessmentChildId, String(five._id));

  for (const c of [nine, two]) {
    r = await run({ own: [c] });
    assert.strictEqual(r.needsPreAssessment, false, 'not sent to a page that refuses the child');
    assert.strictEqual(r.preAssessmentChildId, null);
    assert.strictEqual(r.childId, String(c._id), 'the child is still the default child');
  }
  assert.strictEqual((await run({ own: [almostNine] })).needsPreAssessment, true, 'still 8 the day before turning 9');

  // Newest child is too old: the eligible one is opened instead.
  r = await run({ own: [nine, five] });
  assert.strictEqual(r.needsPreAssessment, true);
  assert.strictEqual(r.preAssessmentChildId, String(five._id));
  assert.strictEqual(r.childId, String(nine._id));

  assert.strictEqual((await run({ own: [five], completed: true })).needsPreAssessment, false, 'already completed one');
  assert.strictEqual((await run({ linked: [five] })).needsPreAssessment, false, 'linked guardians are never required');
  assert.strictEqual((await run({ own: [nine], linked: [five] })).needsPreAssessment, false);

  // GET /auth/me reports the same rule, for the parent-page gate in api.js.
  const meLayer = router.stack.find((l) => l.route && l.route.path === '/me' && l.route.methods.get);
  const me = meLayer.route.stack[meLayer.route.stack.length - 1].handle;
  const runMe = async (role, setup) => {
    ({ own = [], linked = [], completed = false } = setup);
    User.findById = async () => ({ _id: parentId, role, status: 'active' });
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await me({ user: { userId: String(parentId) }, method: 'GET', originalUrl: '/api/auth/me' }, res);
    assert.strictEqual(res.statusCode, 200);
    return res.body;
  };
  r = await runMe('parent', { own: [five] });
  assert.strictEqual(r.needsPreAssessment, true);
  assert.strictEqual(r.preAssessmentChildId, String(five._id));
  assert.ok(!('needsPreAssessment' in r.user), 'not mixed into the stored user');
  assert.strictEqual((await runMe('parent', { own: [five], completed: true })).needsPreAssessment, false);
  assert.strictEqual((await runMe('parent', { own: [nine] })).needsPreAssessment, false);
  assert.strictEqual((await runMe('parent', { linked: [five] })).needsPreAssessment, false);
  assert.ok(!('needsPreAssessment' in await runMe('pediatrician', { own: [five] })), 'staff get no gate fields');
  const { exists } = Assessment;
  const { error } = console;
  Assessment.exists = async () => { throw new Error('db down'); };
  console.error = () => {};
  r = await runMe('parent', { own: [five] });
  console.error = error;
  Assessment.exists = exists;
  assert.ok(r.user && !('needsPreAssessment' in r), 'a failed lookup never fails /auth/me');

  console.log('Login pre-assessment age tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
