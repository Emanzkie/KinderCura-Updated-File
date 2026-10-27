// Regression tests for the shared notification bell.
//
// Every role's bell is driven by /notifications-card-ui.js. Most admin and
// pediatrician pages used to stop that from happening: their page script
// declared its own top-level openNotifications()/clearAllNotifications()…,
// and a later classic script's function declaration silently replaces the
// shared one. That is how those pages ended up with a second "Clear all", and
// how the pediatrician dashboard bell stopped opening (its copy looked for a
// #notifList element that the page does not have).
//
// No DB, no network, no browser: pages are read as text and api.js runs in a
// node vm with a minimal window/localStorage.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

const PAGE_DIRS = ['ADMIN', 'PARENT', 'PEDIA', 'SECRETARY'];
const SHARED_NAMES = [
  'openNotifications', 'closeNotifications', 'clearAllNotifications', 'deleteNotification',
  'markAllNotificationsRead', 'notificationDestination', 'loadNotificationCount',
];

function walk(dir, ext, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

function pagesWithBell() {
  const pages = [];
  for (const dir of PAGE_DIRS) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      if (!file.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
      if (html.includes('notification-btn')) pages.push({ name: `${dir}/${file}`, html });
    }
  }
  return pages;
}

function pageTests() {
  const pages = pagesWithBell();
  assert(pages.length >= 30, `expected every role's pages, found ${pages.length}`);

  for (const { name, html } of pages) {
    const api = html.indexOf('<script src="/api.js"></script>');
    const ui = html.indexOf('<script src="/notifications-card-ui.js"></script>');
    assert(api !== -1, `${name}: loads /api.js`);
    assert(ui > api, `${name}: loads /notifications-card-ui.js after /api.js`);
    assert(html.includes('href="/notifications-card-ui.css"'), `${name}: loads /notifications-card-ui.css`);
    assert(!html.includes('/assets/js/notifications.js'), `${name}: no longer loads the removed PRC patch`);

    assert.strictEqual((html.match(/id="notificationsModal"/g) || []).length, 1, `${name}: one #notificationsModal`);
    for (const id of ['notificationsList', 'notificationsTitle', 'clearNotificationsBtn', 'markAllNotificationsReadBtn']) {
      assert.strictEqual((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${name}: one #${id}`);
    }
    const modal = html.slice(html.indexOf('id="notificationsModal"'));
    assert.strictEqual((modal.match(/>Clear all</g) || []).length, 1, `${name}: exactly one Clear all control`);
  }
  ok(`all ${pages.length} pages with a bell load the shared script/styles and the same modal markup`);
}

function scriptTests() {
  const files = walk(path.join(ROOT, 'js'), '.js');
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const name of SHARED_NAMES) {
      if (new RegExp(`^\\s*(async\\s+)?function\\s+${name}\\s*\\(`, 'm').test(src)) {
        offenders.push(`${path.relative(ROOT, file)}: ${name}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], 'page scripts must not redeclare the shared bell functions');
  ok('no page script redeclares a shared bell function');
}

function loadApi(role) {
  const store = { kc_user: JSON.stringify({ role }), kc_token: 't' };
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    URL,
    URLSearchParams,
    console,
  };
  sandbox.window = sandbox;
  sandbox.window.location = { hostname: 'kindercura.com', pathname: '/', origin: 'https://kindercura.com', search: '' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8'), sandbox);
  return sandbox;
}

function destinationTests() {
  const admin = loadApi('admin');
  assert.strictEqual(
    admin.notificationDestination({ title: 'New PRC Verification Request', relatedPage: '/admin/prc-verification', relatedId: '66f0a1b2c3d4e5f601234567' }),
    '/admin/prc-verification?pediatricianId=66f0a1b2c3d4e5f601234567'
  );
  assert.strictEqual(admin.notificationDestination({ title: 'New pending registration', message: '' }), '/admin/admin-users.html');
  assert.strictEqual(admin.notificationDestination({ title: 'Something else', message: 'hello' }), null);
  ok('admin: PRC requests open that pediatrician\'s review (ObjectId kept intact), unknown ones have no link');

  const pedia = loadApi('pediatrician');
  assert.strictEqual(
    pedia.notificationDestination({ title: 'Payment Received', type: 'payment', relatedPage: '/pedia/pediatrician-appointments.html', relatedId: '108' }),
    '/pedia/pediatrician-appointments.html?appointmentId=108'
  );
  assert.strictEqual(
    pedia.notificationDestination({ title: 'Walk-in Payment Confirmed', type: 'payment', message: 'x' }),
    '/pedia/pediatrician-appointments.html'
  );
  assert.strictEqual(
    pedia.notificationDestination({ title: 'Question Set Answered', type: 'assessment', relatedPage: '/pedia/pedia-questions.html', relatedId: 'abc' }),
    '/pedia/pedia-questions.html',
    'relatedId is only appended where the page reads it'
  );
  assert.strictEqual(pedia.notificationDestination({ title: '💬 New message from Pat', type: 'chat', message: 'Pat: hi' }), '/pedia/pedia-chat.html');
  ok('pediatrician: appointment/payment links focus the appointment card; chat and questions route by type');

  const parent = loadApi('parent');
  assert.strictEqual(
    parent.notificationDestination({ title: 'Pediatrician diagnosis updated', relatedPage: '/parent/results.html?childId=c1&assessmentId=a1', relatedId: 'zzz' }),
    '/parent/results.html?childId=c1&assessmentId=a1'
  );
  assert.strictEqual(parent.notificationDestination({ title: 'Online Payment Expired', type: 'payment', message: 'did not complete' }), '/parent/appointments');
  assert.strictEqual(loadApi('legal_guardian').notificationDestination({ title: 'Appointment Approved', type: 'appointment', message: '' }), '/parent/appointments');
  ok('parent and guardian roles: stored relatedPage wins, payment/appointment notices open Appointments');

  const secretary = loadApi('secretary');
  assert.strictEqual(secretary.notificationDestination({ title: 'New Appointment Request', type: 'appointment', message: 'requested' }), '/secretary/secretary-approval.html');
  assert.strictEqual(secretary.notificationDestination({ title: 'Notice', type: 'system', message: 'x' }), null);
  ok('secretary: appointment requests open Approvals; unknown ones have no link');

  assert.strictEqual(typeof admin.openNotifications, 'undefined', 'the modal lives in notifications-card-ui.js only');
  ok('api.js no longer carries a second modal renderer');
}

(() => {
  pageTests();
  scriptTests();
  destinationTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Notification UI tests OK — ${results.length} groups`);
})();
