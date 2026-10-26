// Rejected pediatricians can see why and resubmit (PEDIATRICIAN_BUGS.md #8).
//
// A rejected PRC check leaves the account pending, so login refused it with the
// same message as a new applicant: no reason, and /api/prc/upload needed a
// session token the pediatrician could not get. Now login explains the
// rejection and hands over a one-purpose token, and POST /api/prc/resubmit
// accepts it.
//
// No DB and no disk: models are stubbed, the file store is in memory, and the
// real routers run in a local express app.
const assert = require('assert');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

// Keep uploads in memory, and count how often a file would have been stored.
const fileStorage = require('../../services/fileStorage');
let storeCalls = 0;
fileStorage.makeStorage = () => multer.memoryStorage();
fileStorage.finalizeUploads = () => (req, res, next) => {
  storeCalls += 1;
  if (req.file) req.file.filename = `prc_${req.user.userId}_test.jpg`;
  next();
};
fileStorage.deleteStored = () => {};

const User = require('../../models/User');
const Notification = require('../../models/Notification');
const { authMiddleware, prcResubmitAuth, signPrcResubmitToken } = require('../../middleware/auth');
const authRouter = require('../../routes/auth');
const prcRouter = require('../../routes/prc-verification');

const results = [];
const ok = (m) => results.push(m);

const chain = (value) => {
  const q = { select: () => q, lean: () => q, sort: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

const userId = new mongoose.Types.ObjectId();
let account;
let notifications;

function reset(fields = {}) {
  notifications = [];
  account = {
    _id: userId, role: 'pediatrician', status: 'pending', firstName: 'Dee', lastName: 'Doc',
    email: 'dee@example.invalid', passwordHash: bcrypt.hashSync('correct-horse', 4),
    prcVerificationStatus: 'rejected', prcAdminNotes: 'The ID photo is blurry.', prcLicenseNumber: 'PRC-1234',
    prcIdDocumentPath: 'old.jpg', ...fields,
  };
  account.save = async function save() { this.saved = true; };
}

User.findOne = () => chain(account);
User.findById = () => chain(account);
User.find = () => chain([{ _id: new mongoose.Types.ObjectId() }]);
Notification.create = async (n) => { notifications.push(n); return n; };

function run(handler, { headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const out = { status: 200, body: null, nextCalled: false };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; resolve(out); return res; } };
    const req = { headers, body, params: {}, query: {} };
    Promise.resolve(handler(req, res, () => { out.nextCalled = true; out.req = req; resolve(out); })).catch(reject);
  });
}

const loginLayer = authRouter.stack.find((l) => l.route && l.route.path === '/login' && l.route.methods.post);
const login = loginLayer.route.stack[loginLayer.route.stack.length - 1].handle;
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  // ── Login ───────────────────────────────────────────────────────────────
  reset();
  let r = await quiet(() => run(login, { body: { email: account.email, password: 'correct-horse' } }));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'PRC_REJECTED');
  assert.match(r.body.error, /not approved/);
  assert.match(r.body.error, /The ID photo is blurry\./, 'the admin reason is shown');
  assert.strictEqual(r.body.prcLicenseNumber, 'PRC-1234');
  assert.strictEqual(typeof r.body.resubmitToken, 'string');
  const resubmitToken = r.body.resubmitToken;
  ok('a rejected pediatrician who logs in is told the admin reason and given a resubmit token');

  r = await quiet(() => run(login, { body: { email: account.email, password: 'wrong' } }));
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.resubmitToken, undefined, 'nothing is revealed without the password');
  ok('a wrong password still gets the generic 401 and no token');

  reset({ prcVerificationStatus: 'pending', prcAdminNotes: null });
  r = await quiet(() => run(login, { body: { email: account.email, password: 'correct-horse' } }));
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /pending admin approval/);
  assert.strictEqual(r.body.resubmitToken, undefined, 'an applicant awaiting review is unchanged');
  ok('a pediatrician still awaiting review gets the original pending message');

  // ── The token is good for resubmission only ─────────────────────────────
  reset();
  r = await run(authMiddleware, { headers: { authorization: `Bearer ${resubmitToken}` } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.nextCalled, false, 'the resubmit token is not a session token');
  const sessionToken = jwt.sign({ userId: String(userId), role: 'pediatrician' }, process.env.JWT_SECRET);
  r = await run(prcResubmitAuth, { headers: { authorization: `Bearer ${sessionToken}` } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.nextCalled, false, 'a session token cannot be used to resubmit');
  r = await run(prcResubmitAuth, { headers: {} });
  assert.strictEqual(r.status, 401);
  ok('the resubmit token fails authMiddleware, and a session token fails prcResubmitAuth');

  r = await run(prcResubmitAuth, { headers: { authorization: `Bearer ${signPrcResubmitToken(account)}` } });
  assert.strictEqual(r.nextCalled, true);
  assert.deepStrictEqual(r.req.user, { userId: String(userId), role: 'pediatrician' });
  for (const [label, fields] of [
    ['already resubmitted', { prcVerificationStatus: 'pending' }],
    ['approved', { prcVerificationStatus: 'verified', status: 'active' }],
    ['not a pediatrician', { role: 'parent' }],
  ]) {
    reset(fields);
    r = await run(prcResubmitAuth, { headers: { authorization: `Bearer ${signPrcResubmitToken(account)}` } });
    assert.strictEqual(r.status, 403, label);
    assert.strictEqual(r.nextCalled, false, label);
  }
  ok('only an account that is still rejected and pending is let through');

  // ── POST /api/prc/resubmit end to end ───────────────────────────────────
  const app = express();
  app.use('/api/prc', prcRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = async (token, license = 'PRC-9999') => {
    const form = new FormData();
    form.append('prcLicenseNumber', license);
    form.append('prcDocument', new Blob([Buffer.from('fake image')], { type: 'image/jpeg' }), 'prc.jpg');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/prc/resubmit`, {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    reset();
    storeCalls = 0;
    let out = await quiet(() => post(null));
    assert.strictEqual(out.status, 401);
    out = await quiet(() => post(sessionToken));
    assert.strictEqual(out.status, 401);
    assert.strictEqual(storeCalls, 0, 'an unauthorised request never reaches the file store');
    ok('a request without a valid resubmit token is refused before any file is stored');

    out = await quiet(() => post(resubmitToken));
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));
    assert.strictEqual(out.body.verificationStatus, 'pending');
    assert.strictEqual(account.prcVerificationStatus, 'pending');
    assert.strictEqual(account.prcAdminNotes, null, 'the old rejection reason is cleared');
    assert.strictEqual(account.prcLicenseNumber, 'PRC-9999');
    assert.strictEqual(account.status, 'pending', 'the account stays pending until an admin approves');
    assert.strictEqual(account.saved, true);
    assert(notifications.some((n) => /PRC Verification Request/.test(n.title)), 'admins are notified');
    ok('a valid resubmission stores the document, returns the account to review and notifies admins');

    out = await quiet(() => post(resubmitToken));
    assert.strictEqual(out.status, 403, 'the token stops working once the account is back under review');
    ok('the same token cannot be reused after a successful resubmission');
  } finally {
    server.close();
  }

  // ── The login page wires it up ──────────────────────────────────────────
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'SIGN-UP,LOGIN', 'login.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'js', 'auth', 'login.js'), 'utf8');
  for (const id of ['prcResubmitForm', 'prcLicenseNumber', 'prcDocument', 'prcResubmitMsg', 'prcResubmitBtn']) {
    assert(html.includes(`id="${id}"`), `login.html has #${id}`);
    assert(js.includes(`'${id}'`), `login.js uses #${id}`);
  }
  assert(js.includes("data.code === 'PRC_REJECTED'") && js.includes('/prc/resubmit'));
  ok('login.html and login.js agree on the resubmit form');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nprc-resubmit.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
