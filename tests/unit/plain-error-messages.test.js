// Parents see plain error messages, never raw server text, and chat videos are
// limited to 4 MB. No DB: models are stubbed and real handlers are called.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const fileStorage = require('../../services/fileStorage');
fileStorage.makeStorage = () => multer.memoryStorage();
fileStorage.finalizeUploads = () => (req, res, next) => { if (req.file) req.file.filename = 'v.mp4'; next(); };

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Payment = require('../../models/Payment');
const paymongoService = require('../../services/paymongoService');
const payments = require('../../controllers/paymentController');

const RAW = 'E11000 duplicate key error collection: kindercura.users';
const PLAIN = 'Something went wrong on the server. Please try again.';
const results = [];
const silence = async (fn) => {
  const { error, log, warn } = console;
  const logged = [];
  console.error = (...a) => logged.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  console.log = console.warn = () => {};
  try { return [await fn(), logged.join('\n')]; } finally { Object.assign(console, { error, log, warn }); }
};
const makeRes = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

(async () => {
  // 1. A database error is logged, not shown.
  User.findById = async () => { throw new Error(RAW); };
  const authRouter = require('../../routes/auth');
  const me = authRouter.stack.find((l) => l.route && l.route.path === '/me').route.stack.at(-1).handle;
  const res = makeRes();
  const [, log] = await silence(() => me({ user: { userId: 'x' }, method: 'GET', originalUrl: '/api/auth/me' }, res));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.error, PLAIN);
  assert.ok(log.includes(RAW), 'the real error is in the server log');

  for (const name of ['appointments', 'assessments', 'auth', 'chat', 'checkups', 'children', 'custom-questions', 'notifications', 'parent-reports', 'recommendations', 'upload', 'videos']) {
    assert.ok(!/status\(500\)\.json\(\{ error: \w+\.message/.test(read(`routes/${name}.js`)), `routes/${name}.js: no raw error text`);
  }
  results.push('server errors are logged and shown as plain text');

  // 2. PayMongo's status and wording never reach the parent (401 signs them out).
  Payment.findOne = async () => { throw Object.assign(new Error('API key sk_test is invalid'), { statusCode: 401, paymongoErrors: null }); };
  const pay = makeRes();
  await silence(() => payments.reconcileCheckout({ params: { paymentRef: 'KC-1' }, user: { role: 'parent' } }, pay));
  assert.strictEqual(paymongoService.isConfigured ? [500, 503].includes(pay.statusCode) : pay.statusCode === 500, true);
  assert.ok(!/sk_test|PayMongo GET/.test(pay.body.error));
  results.push('PayMongo errors do not reach the parent or sign them out');

  // 3. apiFetch: no connection, and a reply with no message.
  const sandbox = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, cookie: '' },
    console: { log() {}, warn() {}, error() {} }, URL, URLSearchParams, setInterval: () => 0, clearInterval() {},
  };
  sandbox.window = sandbox;
  sandbox.location = { hostname: 'kc.test', pathname: '/', origin: 'https://kc.test', search: '' };
  vm.createContext(sandbox);
  vm.runInContext(read('api.js'), sandbox);
  const failsWith = async (fetchFn) => { sandbox.fetch = fetchFn; try { await sandbox.apiFetch('/x'); } catch (e) { return e.message; } return null; };
  assert.match(await failsWith(async () => { throw new TypeError('Failed to fetch'); }), /^Could not reach the server/);
  assert.match(await failsWith(async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } })), /^Something went wrong\. Please try again\. \(Error 502\)$/);
  assert.strictEqual(await failsWith(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Pick a date.' }) })), 'Pick a date.', 'helpful messages are unchanged');
  results.push('connection problems and empty replies read plainly; helpful messages are kept');

  // 4. Chat video limit: 4 MB, on both pages and the server.
  const userId = new mongoose.Types.ObjectId();
  const chain = (v) => ({ select() { return this; }, lean() { return this; }, then: (a, b) => Promise.resolve(v).then(a, b) });
  User.findById = () => chain({ _id: userId, role: 'parent', status: 'active' });
  Child.find = () => chain([]);
  const app = express();
  app.use('/api/videos', require('../../routes/videos'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const send = async (bytes) => {
    const form = new FormData();
    form.append('video', new Blob([Buffer.alloc(bytes)], { type: 'video/mp4' }), 'clip.mp4');
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/videos/chat`, {
      method: 'POST', body: form, headers: { Authorization: `Bearer ${jwt.sign({ userId: String(userId), role: 'parent' }, process.env.JWT_SECRET)}` },
    });
    return { status: r.status, body: await r.json() };
  };
  const LIMIT = 4 * 1024 * 1024;
  const [[fits, tooBig]] = await silence(async () => [await send(LIMIT), await send(LIMIT + 1)]);
  server.closeAllConnections();
  server.close();
  assert.strictEqual(fits.status, 200, JSON.stringify(fits.body));
  assert.strictEqual(tooBig.status, 400);
  assert.strictEqual(tooBig.body.error, 'Video must be 4 MB or smaller.');

  for (const file of ['js/parent/chat.js', 'js/pedia/pedia-chat.js']) {
    const src = read(file);
    const start = src.indexOf('function handleChatVideo');
    const fn = src.slice(start, src.indexOf('\n}', start) + 2);
    const alerts = [];
    const box = { alert: (m) => alerts.push(m), pendingVideoFile: null, document: { getElementById: () => ({ style: {} }) } };
    vm.createContext(box);
    vm.runInContext(fn, box);
    const pick = (size) => { const e = { target: { value: 'x', files: [{ size, name: 'a.mp4' }] } }; box.handleChatVideo(e); return e.target.value; };
    assert.strictEqual(pick(LIMIT + 1), '', `${file}: the refused file is cleared`);
    assert.deepStrictEqual(alerts, ['Video must be 4 MB or smaller.']);
    assert.strictEqual(box.pendingVideoFile, null);
    pick(LIMIT);
    assert.strictEqual(box.pendingVideoFile.size, LIMIT, `${file}: exactly 4 MB is accepted`);
  }
  results.push('chat videos: 4 MB accepted, larger refused by both pages and the server');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Plain error message tests OK - ${results.length} groups`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
