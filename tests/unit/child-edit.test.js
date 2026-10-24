// Regression test: the parent who registered a child can edit the child's
// name and gender (PUT /api/children/:childId and the Profile page form).
//
// The bug: child details could not be changed after registration. There was
// no update route and no edit form, so a typo in a child's name was permanent.
//
// No DB and no network: Child statics are monkey-patched and the handler is
// called directly from the router stack; the Profile page script runs in a vm.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
const Child = require('../../models/Child');
const router = require('../../routes/children');

const ROOT = path.join(__dirname, '..', '..');
const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();

const ownerId = oid();
const guardianId = oid();
const DOB = new Date('2021-03-04');
let children;
function makeChild(fields) {
  const c = { _id: oid(), parentId: ownerId, firstName: 'Kemri', middleName: null, lastName: 'Sotto', dateOfBirth: DOB, gender: null, relationship: 'mother', saves: 0, ...fields };
  c.save = async () => { c.saves += 1; return c; };
  return c;
}
Child.findById = async (id) => children.find((c) => String(c._id) === String(id)) || null;
Child.findOne = async (f) => children.find((c) => String(c._id) !== String(f._id.$ne)
  && String(c.parentId) === String(f.parentId) && f.firstName.test(c.firstName) && f.lastName.test(c.lastName)) || null;

const layer = router.stack.find((l) => l.route && l.route.path === '/:childId' && l.route.methods.put);
assert(layer, 'PUT /:childId exists');
const update = layer.route.stack[layer.route.stack.length - 1].handle;
async function put(userId, childId, body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await update({ user: { userId: String(userId), role: 'parent' }, params: { childId: String(childId) }, body }, res);
  return res;
}

async function serverTests() {
  // 1. The owner fixes a name typo and sets gender; date of birth cannot change.
  let kid = makeChild();
  children = [kid];
  let r = await put(ownerId, kid._id, { firstName: ' Kemri ', middleName: 'Ann', lastName: 'Soto', gender: 'Female', dateOfBirth: '2019-01-01' });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([kid.firstName, kid.middleName, kid.lastName, kid.gender], ['Kemri', 'Ann', 'Soto', 'female']);
  assert.strictEqual(kid.dateOfBirth, DOB, 'date of birth unchanged');
  assert.strictEqual(r.body.child.lastName, 'Soto');
  ok('owner edits first/middle/last name and gender; date of birth is ignored');

  // 2. Blank middle name and "not specified" gender clear those fields.
  r = await put(ownerId, kid._id, { middleName: '', gender: '' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(kid.middleName, null);
  assert.strictEqual(kid.gender, null);
  ok('blank middle name and gender clear them');

  // 3. A linked guardian (not the registering parent) cannot edit.
  kid = makeChild();
  children = [kid];
  r = await put(guardianId, kid._id, { firstName: 'Changed' });
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(kid.firstName, 'Kemri');
  assert.strictEqual(kid.saves, 0);
  ok("a linked guardian or another parent gets 403; nothing saved");

  // 4. Validation: required names, length, gender values, unknown ids.
  for (const [body, why] of [
    [{ firstName: '   ' }, 'blank first name'],
    [{ lastName: '' }, 'blank last name'],
    [{ firstName: 'x'.repeat(81) }, 'name over 80 characters'],
    [{ gender: 'unknown' }, 'invalid gender'],
  ]) {
    r = await put(ownerId, kid._id, body);
    assert.strictEqual(r.statusCode, 400, `${why}: expected 400`);
  }
  assert.strictEqual(kid.saves, 0);
  assert.strictEqual((await put(ownerId, 'not-an-id', { firstName: 'A' })).statusCode, 404);
  assert.strictEqual((await put(ownerId, oid(), { firstName: 'A' })).statusCode, 404);
  ok('blank or over-long names, bad gender and unknown ids are refused');

  // 5. Renaming into a sibling with the same name and birth date is refused.
  const sibling = makeChild({ firstName: 'Luz', lastName: 'Soto' });
  kid = makeChild({ firstName: 'Lux', lastName: 'Soto' });
  children = [sibling, kid];
  r = await put(ownerId, kid._id, { firstName: 'luz' });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(kid.firstName, 'Lux');
  ok('renaming into an identical sibling (same name and date of birth) is 409');
}

async function pageTests() {
  const src = fs.readFileSync(path.join(ROOT, 'js/parent/profile.js'), 'utf8');
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', value: '', textContent: '', disabled: false, style: {} });
  const calls = [];
  const kids = [
    { id: 'own1', parentId: 'me', firstName: 'Kemri', middleName: '', lastName: 'Sotto', dateOfBirth: '2021-03-04', gender: '' },
    { id: 'linked1', parentId: 'someoneElse', firstName: 'Luz', lastName: 'Cruz', dateOfBirth: '2020-01-01', gender: 'female' },
  ];
  const ctx = vm.createContext({
    requireAuth() {}, KC: { user: () => ({ id: 'me', firstName: 'Test', lastName: 'Parent', role: 'parent' }), token: () => 't' },
    escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [], querySelector: () => null },
    console: { log() {}, warn() {}, error() {} }, alert() {},
    apiFetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (url === '/auth/me') return { user: { id: 'me', firstName: 'Test', lastName: 'Parent', role: 'parent' } };
      if (url === '/children') return { children: kids };
      return { success: true };
    },
  });
  vm.runInContext(src, ctx, { filename: 'profile.js' });

  await vm.runInContext('loadProfile()', ctx);
  const html = el('childFields').innerHTML;
  assert.ok(html.includes("toggleEditChild('own1')"), 'own child has Edit Details');
  assert.ok(!html.includes("toggleEditChild('linked1')"), 'linked child has no Edit Details');
  assert.ok(/id="editChildLast_own1"[^>]*value="Sotto"/.test(html), 'form is prefilled');
  ok('Profile shows Edit Details only on the parent\'s own child, prefilled');

  el('editChildFirst_own1').value = 'Kemri';
  el('editChildMiddle_own1').value = '';
  el('editChildLast_own1').value = 'Soto';
  el('editChildGender_own1').value = 'female';
  calls.length = 0;
  await vm.runInContext("saveChild('own1')", ctx);
  assert.strictEqual(calls[0].method, 'PUT');
  assert.strictEqual(calls[0].url, '/children/own1');
  assert.deepStrictEqual(calls[0].body, { firstName: 'Kemri', middleName: '', lastName: 'Soto', gender: 'female' });
  assert.ok(calls.some((c) => c.url === '/children' && c.method === 'GET'), 'profile reloads after saving');
  ok('Save sends PUT /children/own1 with the edited fields and reloads the profile');
}

(async () => {
  await serverTests();
  await pageTests();
  console.log('\nChild edit tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
