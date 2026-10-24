// Regression test: only parent-side accounts may register a child
// (POST /api/children/register).
//
// The bug: the route had no role check, so a pediatrician, secretary or admin
// could create children under their own account (Child.parentId).
//
// No DB and no network: Child statics are monkey-patched and the handler is
// called directly from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
const Child = require('../../models/Child');
const router = require('../../routes/children');

let created = [];
Child.findOne = async () => null;
Child.create = async (doc) => { const c = { _id: new mongoose.Types.ObjectId(), ...doc }; created.push(c); return c; };

const layer = router.stack.find((l) => l.route && l.route.path === '/register' && l.route.methods.post);
assert(layer, 'POST /register exists');
const register = layer.route.stack[layer.route.stack.length - 1].handle;

async function call(role) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const body = { firstName: 'Luz', lastName: 'Soto', dateOfBirth: `${new Date().getFullYear() - 5}-01-15`, gender: 'female' };
  await register({ user: { userId: String(new mongoose.Types.ObjectId()), role }, body }, res);
  return res;
}
const ok = (m) => console.log('  ok -', m);

(async () => {
  for (const role of ['pediatrician', 'secretary', 'admin']) {
    created = [];
    const r = await call(role);
    assert.strictEqual(r.statusCode, 403, `${role}: expected 403`);
    assert.match(r.body.error, /Only parent accounts can register a child/);
    assert.strictEqual(created.length, 0, `${role}: no child created`);
  }
  ok('pediatrician, secretary and admin get 403; no child created');

  for (const role of ['parent', 'legal_guardian', 'foster_parent', 'court_appointed']) {
    created = [];
    const r = await call(role);
    assert.strictEqual(r.statusCode, 201, `${role}: expected 201, got ${r.statusCode} ${JSON.stringify(r.body)}`);
    assert.strictEqual(created.length, 1);
  }
  ok('every parent-side role can still register a child');

  console.log('\nChild register role tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
