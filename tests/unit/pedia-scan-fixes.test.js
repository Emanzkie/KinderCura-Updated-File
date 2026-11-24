// Pediatrician scan fixes: locked chat message, question form category and batch,
// expired session, license number lock, decline confirmation, future completion.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const loadApiFetch = require('../helpers/load-api-fetch');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const results = [];
const makeRes = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

// The category list of the real form: assigning a value it does not offer leaves it blank.
const DOMAINS = [...read('PEDIA/pedia-questions.html').match(/<select id="qDomain"[\s\S]*?<\/select>/)[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);

function loadPage(file, { fetch, confirm = () => true } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const e = { id, innerHTML: '', textContent: '', style: {}, children: [], classList: { add() {}, remove() {} }, focus() {}, addEventListener() {}, setAttribute() {}, appendChild() {} };
      let value = '';
      Object.defineProperty(e, 'value', { get: () => value, set: (v) => { value = id === 'qDomain' && !DOMAINS.includes(v) ? '' : v; } });
      els.set(id, e);
    }
    return els.get(id);
  };
  const store = { kc_token: 't', kc_user: JSON.stringify({ id: 'd1', role: 'pediatrician', firstName: 'A', lastName: 'B' }) };
  const location = { href: '', search: '', origin: 'https://kc.test', pathname: '/pedia/x' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, location, confirm, alert() {}, URLSearchParams, fetch,
    KC: { token: () => store.kc_token || null, clear() { delete store.kc_token; }, poll: () => ({ stop() {} }) },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: el('body'), createElement: () => el('new') },
    localStorage: { getItem: (k) => store[k] ?? null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, setInterval: () => 0, loadNotificationCount: async () => {},
  };
  sandbox.window = { location, KC: sandbox.KC, addEventListener() {} };
  vm.createContext(sandbox);
  loadApiFetch(sandbox);
  vm.runInContext(read(file), sandbox);
  return { sandbox, el, location, run: (code) => vm.runInContext(code, sandbox) };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

(async () => {
  // 1. Locked chat says so instead of "Loading…" forever.
  const chat = loadPage('js/pedia/pedia-chat.js', {
    fetch: async (url) => (/\/chat\/7$/.test(url) ? reply(403, { error: 'Chat is not yet available. Appointment status: pending' }) : reply(500, { error: 'Server <b>down</b>' })),
  });
  await chat.sandbox.openThread(7);
  assert.match(chat.el('chatMessages').innerHTML, /Chat is available once the appointment is approved/);
  assert.strictEqual(chat.el('chatInputArea').style.display, 'none');
  await chat.sandbox.openThread(8);
  assert.match(chat.el('chatMessages').innerHTML, /Server &lt;b&gt;down/);
  assert.strictEqual(chat.el('chatInputArea').style.display, 'block', 'a temporary failure keeps the message box');

  const User = require('../../models/User');
  const Child = require('../../models/Child');
  const Appointment = require('../../models/Appointment');
  const Assessment = require('../../models/Assessment');
  const oid = () => new mongoose.Types.ObjectId();
  const chain = (v) => ({ sort() { return this; }, select() { return this; }, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) });
  const kids = [oid(), oid(), oid()];
  Appointment.find = () => chain([
    { id: 30, childId: kids[0], status: 'pending' }, { id: 20, childId: kids[0], status: 'completed' }, { id: 10, childId: kids[0], status: 'approved' },
    { id: 31, childId: kids[1], status: 'cancelled' }, { id: 32, childId: kids[2], status: 'approved' },
  ]);
  Child.findById = (id) => chain({ _id: id, firstName: 'K', lastName: 'D' });
  User.findById = () => chain({ firstName: 'P', lastName: 'Q', email: 'p@example.invalid' });
  Assessment.findOne = () => chain(null);
  const handler = (router, method, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]).route.stack.at(-1).handle;
  let res = makeRes();
  await handler(require('../../routes/assessments'), 'get', '/pedia-patients')({ user: { role: 'pediatrician', userId: oid() } }, res);
  assert.deepStrictEqual(res.body.patients.map((p) => p.chatAppointmentId), [20, null, 32], 'only an approved or completed visit is offered for chat');
  assert.match(read('js/pedia/pediatrician-patients.js'), /\$\{p\.chatAppointmentId \? /);
  results.push('chat opens only where it is allowed and says when it is locked');

  // 2. Question form.
  assert.ok(DOMAINS.length === 4, 'form categories found');
  let bulk;
  const q = loadPage('js/pedia/pedia-questions.js', {
    fetch: async (url, opts = {}) => {
      if (/\/bulk$/.test(url)) { bulk = JSON.parse(opts.body); return reply(201, { createdCount: 1, errorCount: 1, errors: [{ index: 2, error: 'Question 2: bad.' }] }); }
      return reply(200, {});
    },
  });
  q.run('onTypeChange = () => {}; clearOptions = () => {}; refreshAll = async () => {};');
  q.run('openCreateModal()');
  assert.strictEqual(q.el('qDomain').value, 'Communication', 'a new question starts with a real category');
  for (const text of ['First', 'Second']) { q.el('qText').value = text; q.run('addToBatch()'); }
  assert.strictEqual(q.el('qDomain').value, 'Communication', 'and the next one too');
  q.el('qText').value = 'Third'; q.el('qDomain').value = 'Other';
  q.run('addToBatch()');
  assert.strictEqual(q.run('questionBatch.length'), 2, 'a blank category is refused before adding');
  assert.strictEqual(q.el('modalError').textContent, 'Choose a category.');
  q.run('closeModal(); openCreateModal()');
  assert.strictEqual(q.run('questionBatch.length'), 2, 'closing and reopening keeps the batch');
  await q.run('submitAllQuestions()');
  assert.deepStrictEqual(bulk.questions.map((x) => x.domain), ['Communication', 'Communication']);
  assert.strictEqual(q.run('questionBatch.map((x) => x.questionText).join()'), 'Second', 'only the refused question stays');
  assert.match(q.el('modalError').textContent, /Question 2: bad/);
  assert.strictEqual(q.el('questionModal').style.display, 'flex', 'the form stays open');
  results.push('question form: valid category, batch kept, refused questions kept');

  // 3. Expired session on every pediatrician page.
  for (const name of ['pediatrician-dashboard', 'pedia-chat', 'pediatrician-appointments', 'pediatrician-patients', 'pediatrician-profile', 'pedia-questions']) {
    assert.ok(!/function apiFetch/.test(read(`js/pedia/${name}.js`)), `${name} uses the shared apiFetch`);
    assert.ok(read(`PEDIA/${name}.html`).indexOf('/api.js"') < read(`PEDIA/${name}.html`).indexOf(`/js/pedia/${name}.js"`), `${name}: api.js loads first`);
  }
  const expired = loadPage('js/pedia/pediatrician-profile.js', { fetch: async () => reply(401, { error: 'Invalid token' }) });
  await expired.run('loadProfile()').catch(() => {});
  assert.strictEqual(expired.location.href, '/login');
  results.push('an expired session goes to the login page');

  // 4. License number.
  let saved = 0;
  const account = (role) => ({ _id: oid(), role, licenseNumber: 'PRC-1', institution: 'Old', save: async () => { saved += 1; }, set() {} });
  const update = handler(require('../../routes/auth'), 'put', '/update-profile');
  const put = async (role, body) => { const doc = account(role); User.findById = async () => doc; const r = makeRes(); await update({ user: { userId: 'x' }, body }, r); return { r, doc }; };
  let out = await put('pediatrician', { licenseNumber: 'PRC-2', institution: 'New' });
  assert.strictEqual(out.r.statusCode, 400);
  assert.deepStrictEqual([out.doc.licenseNumber, out.doc.institution, saved], ['PRC-1', 'Old', 0]);
  out = await put('pediatrician', { licenseNumber: 'PRC-1', institution: 'New' });
  assert.deepStrictEqual([out.r.statusCode, out.doc.institution, saved], [200, 'New', 1]);
  assert.match(read('PEDIA/pediatrician-profile.html'), /id="editLicense"[^>]* readonly/);
  results.push('an approved license number cannot be edited');

  // 5. Decline asks first; a future visit cannot be completed.
  let asked = 0; let sent = 0; let answer = false;
  const dash = loadPage('js/pedia/pediatrician-dashboard.js', { confirm: () => { asked += 1; return answer; }, fetch: async () => { sent += 1; return reply(200, {}); } });
  dash.run('loadDashboard = () => {}');
  await dash.run("respond(1,'declined')");
  assert.deepStrictEqual([asked, sent], [1, 0], 'No keeps the request');
  answer = true;
  await dash.run("respond(1,'declined')");
  assert.deepStrictEqual([asked, sent], [2, 1]);
  await dash.run("respond(1,'approved')");
  assert.deepStrictEqual([asked, sent], [2, 2], 'Accept does not ask');

  const day = (n) => { const d = new Date(Date.now() + 8 * 3600e3 + n * 86400e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
  const pedId = oid();
  let appt;
  Appointment.findOne = async () => appt;
  User.findById = () => chain(null);
  Child.findById = () => chain(null);
  const setStatus = handler(require('../../routes/appointments'), 'put', '/:appointmentId/status');
  const { error } = console; console.error = () => {};
  for (const [n, allowed] of [[1, false], [0, true], [-3, true]]) {
    let written = 0;
    appt = { id: 1, pediatricianId: pedId, childId: oid(), parentId: oid(), status: 'approved', appointmentDate: day(n), save: async () => { written += 1; }, toObject() { return { ...this }; } };
    res = makeRes();
    await setStatus({ user: { role: 'pediatrician', userId: pedId }, params: { appointmentId: '1' }, body: { status: 'completed' }, method: 'PUT', originalUrl: '/x' }, res);
    assert.strictEqual(written, allowed ? 1 : 0, `day ${n}`);
    assert.strictEqual(appt.status, allowed ? 'completed' : 'approved');
    if (!allowed) { assert.strictEqual(res.statusCode, 400); assert.match(res.body.error, /in the future/); }
  }
  console.error = error;
  results.push('decline asks first; a future visit cannot be marked completed');

  await tick();
  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Pediatrician scan fix tests OK - ${results.length} groups`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
