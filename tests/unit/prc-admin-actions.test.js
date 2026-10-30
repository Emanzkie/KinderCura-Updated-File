// Admin PRC verification page fixes (ADMIN bug scan C2, C4, C10, C27, C28).
//
//   C2  The review pop-up wrote the pediatrician's name, clinic, address,
//       phone and specialization into innerHTML unescaped.
//   C4  Approve/Reject called POST /api/admin/pediatricians/prc-verify, which
//       accepted ANY account, never notified the pediatrician, kept a stale
//       rejection note and re-activated suspended accounts. It now uses
//       PUT /api/prc/verifications/:id/approve|reject, and the old route is gone.
//   C10 The ID document was loaded as <img src="...?token=<admin JWT>">. It is
//       now fetched with the Authorization header; ?token= is refused.
//
// No DB, no network: models are stubbed, routes run in-process, and the page
// script runs in a node vm with a small fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const User = require('../../models/User');
const Notification = require('../../models/Notification');
const prcRouter = require('../../routes/prc-verification');
const adminRouter = require('../../routes/admin');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);
const chain = (value) => { const q = { select: () => q, lean: () => q, sort: () => q, then: (a, b) => Promise.resolve(value).then(a, b) }; return q; };

// ── Backend ───────────────────────────────────────────────────────────────
async function backendTests() {
  const { statusAfterPrcDecision } = prcRouter.__testables;
  assert.strictEqual(statusAfterPrcDecision('pending', true), 'active');
  assert.strictEqual(statusAfterPrcDecision('pending', false), 'pending');
  assert.strictEqual(statusAfterPrcDecision('active', false), 'pending');
  assert.strictEqual(statusAfterPrcDecision('suspended', true), 'suspended');
  assert.strictEqual(statusAfterPrcDecision('suspended', false), 'suspended');
  ok('a PRC decision activates or blocks the account, but never lifts a suspension');

  assert(!adminRouter.stack.some((l) => l.route && l.route.path === '/pediatricians/prc-verify'), 'old prc-verify route removed');
  ok('the unsafe POST /api/admin/pediatricians/prc-verify route no longer exists');

  const adminId = String(new mongoose.Types.ObjectId());
  const accounts = new Map();
  const notifications = [];
  const doc = (data) => ({ ...data, saved: 0, async save() { this.saved += 1; accounts.set(String(this._id), this); } });
  accounts.set(adminId, { _id: adminId, role: 'admin', status: 'active' });
  User.findById = (id) => {
    const found = accounts.get(String(id)) || null;
    // findById(...).select().lean() for authMiddleware, plain await for the routes.
    const q = chain(found);
    return q;
  };
  Notification.create = async (n) => { notifications.push(n); return n; };

  const app = express();
  app.use(express.json());
  app.use('/api/prc', prcRouter);
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET);
  const call = async (method, url, body, headers = { Authorization: `Bearer ${token}` }) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    const parentId = String(new mongoose.Types.ObjectId());
    accounts.set(parentId, doc({ _id: parentId, role: 'parent', status: 'active', firstName: 'Pat', lastName: 'Parent' }));
    let r = await call('PUT', `/api/prc/verifications/${parentId}/approve`);
    assert.strictEqual(r.status, 400);
    r = await call('PUT', `/api/prc/verifications/${parentId}/reject`, { reason: 'no' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(accounts.get(parentId).status, 'active', 'a parent account is never touched');
    ok('approve/reject refuse any account that is not a pediatrician');

    const pediaId = String(new mongoose.Types.ObjectId());
    accounts.set(pediaId, doc({ _id: pediaId, role: 'pediatrician', status: 'pending', prcVerificationStatus: 'pending', prcAdminNotes: 'old note', firstName: 'Ana', lastName: 'Cruz' }));
    r = await call('PUT', `/api/prc/verifications/${pediaId}/reject`, { reason: '   ' });
    assert.strictEqual(r.status, 400, 'a rejection needs a reason');
    r = await call('PUT', `/api/prc/verifications/${pediaId}/reject`, { reason: 'Blurry photo' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(accounts.get(pediaId).prcVerificationStatus, 'rejected');
    assert.strictEqual(accounts.get(pediaId).prcAdminNotes, 'Blurry photo');
    assert.strictEqual(accounts.get(pediaId).status, 'pending');
    r = await call('PUT', `/api/prc/verifications/${pediaId}/approve`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(accounts.get(pediaId).status, 'active');
    assert.strictEqual(accounts.get(pediaId).prcAdminNotes, null, 'approval clears the old rejection note');
    assert.strictEqual(notifications.length, 2, 'the pediatrician is notified of each decision');
    assert(notifications.every((n) => String(n.userId) === pediaId));
    ok('reject records the reason, approve activates and clears it, and the pediatrician is notified each time');

    accounts.get(pediaId).status = 'suspended';
    r = await call('PUT', `/api/prc/verifications/${pediaId}/approve`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(accounts.get(pediaId).status, 'suspended', 'approval does not lift a suspension');
    ok('approving a suspended pediatrician\'s PRC keeps the account suspended');

    // The manual PRC record check is separate from approval.
    accounts.get(pediaId).status = 'pending';
    accounts.get(pediaId).prcVerificationStatus = 'pending';
    const notifsBefore = notifications.length;
    r = await call('PUT', `/api/prc/verifications/${pediaId}/record-check`, { status: 'approved' });
    assert.strictEqual(r.status, 400, 'an unknown check status is refused');
    r = await call('PUT', `/api/prc/verifications/${parentId}/record-check`, { status: 'verified' });
    assert.strictEqual(r.status, 400, 'a parent account cannot be checked');
    assert.strictEqual(accounts.get(parentId).prcRecordCheckStatus, undefined);
    for (const status of ['verified', 'needs_review', 'unable_to_verify', 'pending_verification']) {
      r = await call('PUT', `/api/prc/verifications/${pediaId}/record-check`, { status });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(accounts.get(pediaId).prcRecordCheckStatus, status);
    }
    assert.strictEqual(String(accounts.get(pediaId).prcRecordCheckedBy), adminId, 'the checking admin is recorded');
    assert(accounts.get(pediaId).prcRecordCheckedAt instanceof Date);
    assert.strictEqual(accounts.get(pediaId).prcVerificationStatus, 'pending', 'approval status untouched');
    assert.strictEqual(accounts.get(pediaId).status, 'pending', 'account status untouched');
    assert.strictEqual(notifications.length, notifsBefore, 'no notification for a PRC check');
    ok('the PRC record check saves one of 4 statuses and never changes approval, account status or notifications');

    // The document route: header only.
    r = await call('GET', `/api/prc/document/${pediaId}?token=${encodeURIComponent(token)}`, null, {});
    assert.strictEqual(r.status, 401, 'a token in the query string is no longer accepted');
    const parentToken = jwt.sign({ userId: parentId, role: 'parent' }, process.env.JWT_SECRET);
    r = await call('GET', `/api/prc/document/${pediaId}`, null, { Authorization: `Bearer ${parentToken}` });
    assert.strictEqual(r.status, 403, 'non-admins are refused');
    accounts.get(adminId).status = 'suspended';
    r = await call('GET', `/api/prc/document/${pediaId}`);
    assert.strictEqual(r.status, 403, 'a suspended admin is refused');
    accounts.get(adminId).status = 'active';
    ok('the PRC document route only accepts an active admin\'s token in the Authorization header');
  } finally {
    // Close keep-alive sockets too, so the process can end on its own
    // (process.exit with sockets still closing aborts libuv on Windows).
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// ── Page script ───────────────────────────────────────────────────────────
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', style: {}, src: '', href: '', download: '',
    listeners: {}, onclick: null, onerror: null, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild() {}, querySelectorAll: () => [],
  };
  return el;
}

async function pageTests() {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  let onReady = null;
  const apiCalls = [];
  const fetchCalls = [];
  const alerts = [];
  let promptAnswer = null;
  const EVIL = '<img src=x onerror="alert(1)">';
  const pedia = {
    _id: 'p1', fullName: `Dr. ${EVIL}`, email: `${EVIL}@x.com`, phone: EVIL, clinicName: EVIL,
    clinicAddress: EVIL, prcLicenseNumber: EVIL, licenseExpiry: EVIL, specialization: EVIL,
    accountStatus: 'pending', hasPrcDocument: true, prcDocumentUrl: '/api/prc/document/p1',
  };

  const sandbox = {
    console: { ...console, log() {}, warn() {} },
    URLSearchParams,
    setTimeout: (fn) => { fn(); return 0; },
    requireAuth: () => true,
    KC: { user: () => ({ role: 'admin' }), token: () => 'ADMIN.JWT.TOKEN' },
    alert: (m) => alerts.push(m),
    confirm: () => true,
    prompt: () => promptAnswer,
    location: { search: '', reload() {} },
    URL: { createObjectURL: () => 'blob:doc-1', revokeObjectURL() {} },
    bootstrap: { Modal: Object.assign(function Modal() { this.show = () => {}; this.hide = () => {}; }, { getInstance: () => ({ hide() {} }) }) },
    document: {
      getElementById: el,
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') onReady = fn; },
      createElement: () => makeEl('created'),
    },
    apiFetch: async (url, opts = {}) => {
      apiCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (url.startsWith('/prc/verifications?') || url === '/prc/verifications') return { users: [] };
      if (url.includes('/prc-details')) return { success: true, pediatrician: pedia };
      return { success: true, message: 'done' };
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      return { ok: true, status: 200, blob: async () => ({ type: 'image/png' }) };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/prc-verification.js'), 'utf8'), sandbox);
  assert(onReady, 'page waits for DOMContentLoaded');
  await onReady();

  await sandbox.openPrcVerification('p1');
  await new Promise((r) => setImmediate(r));
  const html = el('prcModalBody').innerHTML;
  assert(!/<img src=x/i.test(html), 'no raw tag from pediatrician data');
  assert(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert(html.includes(`handlePrcAction('p1', 'verified')`) && html.includes(`handlePrcAction('p1', 'rejected')`));
  ok('the review pop-up shows pediatrician-typed fields as text, never HTML');

  const docFetch = fetchCalls.find((c) => c.url === '/api/prc/document/p1');
  assert(docFetch, 'the document is fetched from the secure endpoint');
  assert.strictEqual(docFetch.opts.headers.Authorization, 'Bearer ADMIN.JWT.TOKEN', 'token sent in the header');
  assert.strictEqual(el('prcDocumentImage').src, 'blob:doc-1');
  assert(![...els.values()].some((e) => /token=/.test(String(e.src)) || /token=/.test(String(e.href))), 'no token in any URL');
  assert.strictEqual(el('prcDocumentDownloadLink').download, 'prc-id-p1.png');
  ok('the ID document is fetched with the Authorization header and shown from a blob: URL; no token in any URL');

  apiCalls.length = 0;
  await sandbox.handlePrcAction('p1', 'verified');
  assert.deepStrictEqual(apiCalls.map((c) => [c.method, c.url]), [['PUT', '/prc/verifications/p1/approve']]);
  apiCalls.length = 0;
  promptAnswer = null;
  await sandbox.handlePrcAction('p1', 'rejected');
  promptAnswer = '   ';
  await sandbox.handlePrcAction('p1', 'rejected');
  assert.strictEqual(apiCalls.length, 0, 'cancelled or blank reason sends nothing');
  promptAnswer = 'Blurry photo';
  await sandbox.handlePrcAction('p1', 'rejected');
  assert.deepStrictEqual(apiCalls.map((c) => [c.method, c.url, c.body]), [['PUT', '/prc/verifications/p1/reject', { reason: 'Blurry photo' }]]);
  ok('Approve/Reject call the PRC verification routes; Reject asks for a reason and sends nothing without one');

  assert(html.includes('href="https://verification.prc.gov.ph/Verification" target="_blank" rel="noopener noreferrer">Verify on PRC Website</a>'));
  for (const label of ['Pending Verification', 'Verified', 'Needs Review', 'Unable to Verify']) {
    assert(html.includes(`>${label}</option>`), `check option ${label}`);
  }
  assert(/does not verify licenses automatically/.test(html), 'no claim of automatic verification');
  el('prcCheckSelect').value = 'needs_review';
  apiCalls.length = 0;
  await sandbox.savePrcRecordCheck('p1');
  assert.deepStrictEqual(apiCalls.map((c) => [c.method, c.url, c.body]), [['PUT', '/prc/verifications/p1/record-check', { status: 'needs_review' }]]);
  assert(el('prcCheckBadge').innerHTML.includes('Needs Review'));
  ok('the pop-up links to the official PRC site in a new tab and saves the PRC check on its own route');

  const page = fs.readFileSync(path.join(ROOT, 'ADMIN/admin-prc-verification.html'), 'utf8');
  assert(page.includes('href="https://verification.prc.gov.ph/Verification" target="_blank" rel="noopener noreferrer">'));
  assert(/>\s*Verify PRC License\s*</.test(page) && !page.includes('Open PRC Portal'));
  ok('the header button is "Verify PRC License" and opens the official PRC site in a new tab');
}

(async () => {
  await backendTests();
  await pageTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`PRC admin action tests OK — ${results.length} groups`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
