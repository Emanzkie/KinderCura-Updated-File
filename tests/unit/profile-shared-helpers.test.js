// Regression test: the parent Profile page must use the shared helpers in
// /api.js instead of its own copies.
//
// The bug: js/parent/profile.js redefined API, KC, apiFetch, requireAuth,
// logout, initNav and toggleProfileMenu. Its logout() replaced the shared one
// and its KC.clear() removed only 4 kc_* keys, so logging out from Profile
// left the last viewed child's name and id, the preferred pediatrician and
// the Remember Me flag in the browser of a shared computer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const apiJs = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
const profileJs = fs.readFileSync(path.join(ROOT, 'js/parent/profile.js'), 'utf8');
const profileHtml = fs.readFileSync(path.join(ROOT, 'PARENT/profile.html'), 'utf8');
const ok = (m) => console.log('  ok -', m);

// 1. profile.js declares none of the shared globals.
const SHARED = ['API', 'KC', 'apiFetch', 'requireAuth', 'logout', 'initNav', 'toggleProfileMenu',
  'loadNotificationCount', 'openNotifications', 'closeNotifications', 'refreshCurrentUser'];
for (const name of SHARED) {
  const decl = new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(|^\\s*(?:const|let|var)\\s+${name}\\b`, 'm');
  assert.ok(!decl.test(profileJs), `js/parent/profile.js must not redeclare ${name} (it lives in /api.js)`);
}
ok('profile.js redeclares none of the api.js globals');

// 2. profile.html loads api.js before profile.js, so the shared helpers exist.
const apiAt = profileHtml.indexOf('<script src="/api.js"></script>');
const pageAt = profileHtml.indexOf('<script src="/js/parent/profile.js"></script>');
assert.ok(apiAt !== -1 && pageAt !== -1 && apiAt < pageAt, 'profile.html must load /api.js before /js/parent/profile.js');
ok('profile.html loads /api.js before profile.js');

// 3. The shared logout() the page now uses clears every kc_* key and the cookie.
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let cookie = 'kc_session=1';
const document = {
  get cookie() { return cookie; },
  set cookie(v) { if (/^kc_session=;/.test(v)) cookie = ''; },
  addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null,
};
// As in a browser, `window` is the global object, so api.js's window.KC is KC.
const window = {
  location: { hostname: 'kindercura.example', href: '/parent/profile', pathname: '/parent/profile' },
  document, localStorage, console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
window.window = window;
const ctx = vm.createContext(window);
vm.runInContext(apiJs, ctx, { filename: 'api.js' });

const KEYS = ['kc_token', 'kc_user', 'kc_childId', 'kc_assessmentId', 'kc_viewChildId', 'kc_viewChildName',
  'kc_prefPediaId', 'kc_preAssessmentRequired', 'kc_remember'];
KEYS.forEach((k) => localStorage.setItem(k, k === 'kc_user' ? '{"firstName":"A"}' : 'x'));
localStorage.setItem('kc_remember', '1');
vm.runInContext('logout()', ctx);
for (const k of KEYS) assert.strictEqual(localStorage.getItem(k), null, `logout must remove ${k}`);
assert.strictEqual(cookie, '', 'logout must expire the kc_session cookie');
assert.strictEqual(window.location.href, '/login', 'logout returns to the login page');
ok('shared logout() clears all 9 kc_* keys and the session cookie');

console.log('\nProfile shared helper tests OK');
