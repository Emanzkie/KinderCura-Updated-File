// Regression test: staff accounts are sent away from parent pages.
//
// The bug: only three parent page scripts redirected pediatricians and admins,
// and none handled secretaries, so a signed-in secretary (or a pediatrician on
// most pages) could open the parent UI. /api.js, which every parent page loads
// first, now sends pediatrician, secretary and admin accounts to their own
// dashboard. Parent-side accounts stay; the invitation page is never redirected.
//
// /api.js runs in a vm whose global object plays the browser's `window`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const apiJs = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
const ok = (m) => console.log('  ok -', m);

function load(pathname, user) {
  const store = new Map();
  if (user) {
    store.set('kc_token', 'fake-test-token');
    store.set('kc_user', JSON.stringify(user));
  }
  const replaced = [];
  const window = {
    location: { hostname: 'kindercura.example', pathname, href: pathname, replace: (u) => replaced.push(u) },
    document: { cookie: '', addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  window.window = window;
  vm.runInContext(apiJs, vm.createContext(window), { filename: 'api.js' });
  return replaced;
}

const STAFF = {
  secretary: '/secretary/secretary-dashboard.html',
  pediatrician: '/pedia/pediatrician-dashboard.html',
  admin: '/admin/admin-dashboard.html',
};

// 1. Every staff role is sent to its own dashboard from parent pages,
//    including the pages that never checked before.
for (const page of ['/parent/dashboard.html', '/parent/results.html', '/parent/appointments.html', '/parent/settings.html', '/PARENT/payment.html', '/parent/guardians']) {
  for (const [role, home] of Object.entries(STAFF)) {
    assert.deepStrictEqual(load(page, { id: 'u1', role }), [home], `${role} on ${page}`);
  }
}
ok('secretary, pediatrician and admin are redirected to their dashboards from parent pages');

// 2. Parent-side roles stay on parent pages.
for (const role of ['parent', 'legal_guardian', 'foster_parent', 'court_appointed']) {
  assert.deepStrictEqual(load('/parent/dashboard.html', { id: 'u1', role }), [], role);
}
ok('parent-side roles stay on parent pages');

// 3. No redirect on the invitation page, for signed-out visitors, or off the parent area.
assert.deepStrictEqual(load('/parent/accept-invitation', { id: 'u1', role: 'secretary' }), []);
assert.deepStrictEqual(load('/parent/accept-invitation.html', { id: 'u1', role: 'pediatrician' }), []);
assert.deepStrictEqual(load('/parent/dashboard.html', null), []);
assert.deepStrictEqual(load('/secretary/secretary-dashboard.html', { id: 'u1', role: 'secretary' }), []);
assert.deepStrictEqual(load('/pedia/pediatrician-dashboard.html', { id: 'u1', role: 'pediatrician' }), []);
ok('invitation page, signed-out visitors and non-parent pages are left alone');

console.log('\nParent page role guard tests OK');
