// Regression test for GET /api/children (routes/children.js).
//
// The bug: a user's own children (Child.parentId) were listed only when the
// role was exactly 'parent'. A legal_guardian who registered their child at
// sign-up (routes/auth.js creates it for that role) saw an empty list, so the
// dashboard, screening and booking pages had no child to work with.
//
// No DB and no network: Child and GuardianLink statics are monkey-patched and
// the handler is called directly from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');

const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const router = require('../../routes/children');

function chain(value) {
  const q = {
    select: () => q, sort: () => q, lean: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
assert(layer, 'GET / exists');
const list = layer.route.stack[layer.route.stack.length - 1].handle;

function call(user) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(list({ user, params: {}, query: {}, body: {} }, res)).catch(reject);
  });
}

const id = () => new mongoose.Types.ObjectId();
const owner = id();
const stranger = id();
const linkedGuardian = id();
const ownChild = { _id: id(), parentId: owner, firstName: 'Own', lastName: 'Child', dateOfBirth: new Date('2021-01-01') };
const linkedChild = { _id: id(), parentId: id(), firstName: 'Linked', lastName: 'Child', dateOfBirth: new Date('2020-01-01') };
const otherChild = { _id: id(), parentId: stranger, firstName: 'Other', lastName: 'Child', dateOfBirth: new Date('2019-01-01') };
const children = [ownChild, linkedChild, otherChild];
const links = [{ childId: linkedChild._id, guardianId: linkedGuardian, status: 'active' }];

const same = (a, b) => String(a) === String(b);
Child.find = (f) => chain(children.filter((c) =>
  (f.parentId && same(c.parentId, f.parentId))
  || (f._id && f._id.$in && f._id.$in.some((x) => same(x, c._id)))));
GuardianLink.find = (f) => chain(links.filter((l) => same(l.guardianId, f.guardianId) && l.status === f.status));

const names = (r) => r.body.children.map((c) => c.firstName).sort();
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. Every parent-side role sees its own registered child.
  for (const role of ['parent', 'legal_guardian', 'foster_parent', 'court_appointed']) {
    const r = await call({ userId: String(owner), role });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(names(r), ['Own'], `${role}: must list its own child only`);
  }
  ok('parent, legal_guardian, foster_parent, court_appointed all list their own child');

  // 2. Linked children still come through the guardian link, for any role.
  for (const role of ['parent', 'legal_guardian']) {
    const r = await call({ userId: String(linkedGuardian), role });
    assert.deepStrictEqual(names(r), ['Linked'], `${role}: linked child listed`);
  }
  ok('children reached through an active guardian link are still listed');

  // 3. Non-parent roles do not pick up children by parentId.
  for (const role of ['pediatrician', 'secretary']) {
    const r = await call({ userId: String(owner), role });
    assert.deepStrictEqual(names(r), [], `${role}: no children by parentId`);
  }
  ok('pediatrician and secretary get no children by parentId');

  // 4. Nobody sees another family's child.
  const r = await call({ userId: String(owner), role: 'legal_guardian' });
  assert.ok(!names(r).includes('Other'), "another family's child is never listed");
  ok("another family's child is never listed");

  console.log('\nChildren list role tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
