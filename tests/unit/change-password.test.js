// Regression test: PUT /api/auth/change-password must require and check the
// current password.
//
// The bug: the route read only { password }, so anyone holding a session
// (a stolen token, or a computer left signed in) could set a new password and
// lock the real owner out.
//
// No DB and no network: User.findById is monkey-patched and the handler is
// called directly from the router stack. The two pages that change passwords
// are checked statically for the new field.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const router = require('../../routes/auth');

const ROOT = path.join(__dirname, '..', '..');
const ok = (m) => console.log('  ok -', m);

const layer = router.stack.find((l) => l.route && l.route.path === '/change-password' && l.route.methods.put);
assert(layer, 'PUT /change-password exists');
const change = layer.route.stack[layer.route.stack.length - 1].handle;

let user;
User.findById = async () => user;

async function call(body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await change({ user: { userId: 'u1', role: 'parent' }, body }, res);
  return res;
}

(async () => {
  const originalHash = await bcrypt.hash('old-password-1', 10);
  const fresh = () => { user = { passwordHash: originalHash, saves: 0, save: async function save() { this.saves += 1; } }; };

  // 1. No current password: refused, nothing saved.
  fresh();
  let r = await call({ password: 'new-password-1' });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.error, 'Enter your current password.');
  assert.strictEqual(user.saves, 0);
  ok('missing current password: 400, nothing saved');

  // 2. Wrong current password: refused, hash unchanged.
  fresh();
  r = await call({ currentPassword: 'guess', password: 'new-password-1' });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.error, 'Current password is incorrect.');
  assert.strictEqual(user.passwordHash, originalHash);
  assert.strictEqual(user.saves, 0);
  ok('wrong current password: 400, password unchanged');

  // 3. Short new password: still refused.
  fresh();
  r = await call({ currentPassword: 'old-password-1', password: 'short' });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(user.saves, 0);
  ok('new password under 8 characters: 400');

  // 4. Correct current password: the new one is saved as a bcrypt hash.
  fresh();
  r = await call({ currentPassword: 'old-password-1', password: 'new-password-1' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(user.saves, 1);
  assert.ok(await bcrypt.compare('new-password-1', user.passwordHash));
  assert.ok(!await bcrypt.compare('old-password-1', user.passwordHash));
  ok('correct current password: new password saved (bcrypt), old one no longer works');

  // 5. Both pages that change passwords ask for, and send, the current one.
  for (const [page, script] of [
    ['PARENT/profile.html', 'js/parent/profile.js'],
    ['PEDIA/pediatrician-profile.html', 'js/pedia/pediatrician-profile.js'],
  ]) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, script), 'utf8');
    assert.ok(/<input[^>]*type="password"[^>]*id="currentPw"/.test(html), `${page} has a current-password field`);
    assert.ok(/currentPassword:\s*current/.test(js), `${script} sends currentPassword`);
  }
  ok('parent and pediatrician profile pages ask for and send the current password');

  console.log('\nChange password tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
