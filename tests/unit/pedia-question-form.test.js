// Question form, chat upload, settings avatar and session expiry
// (PEDIATRICIAN_BUGS.md #29).
//
//   - An option typed with a double quote was written into the input's value
//     attribute as markup, so editing the question dropped the rest of it.
//   - Nothing checked a question's age window (server or form), and a typed 0
//     for the maximum age silently became 18.
//   - A malformed id in the URL reached Mongoose as NaN or a bad ObjectId and
//     came back as a 500.
//   - A chat video that failed to upload was dropped silently: the text still
//     went out and the attachment was cleared.
//   - The settings page put any profileIcon into the avatar's src.
//   - apiFetch left the user on the page when the session had ended (401).
//
// No DB, no browser: the real route handlers run with stubbed models, and the
// real page scripts run in node vms with a fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const PediaCustomQuestion = require('../../models/PediaCustomQuestion');
const QuestionSet = require('../../models/QuestionSet');
const router = require('../../routes/custom-questions');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);
const oid = () => new mongoose.Types.ObjectId();
const pediaId = oid();

// ── Server: malformed ids ─────────────────────────────────────────────────
const idParam = (name, value) => {
  let nexted = false;
  let sent = null;
  const res = { status(c) { this.code = c; return this; }, json(b) { sent = { status: this.code, body: b }; return this; } };
  assert(router.params[name] && router.params[name].length, `the router validates :${name}`);
  router.params[name][0]({}, res, () => { nexted = true; }, value);
  return { nexted, sent };
};
for (const [name, good, bad] of [
  ['id', ['7', '123456'], ['abc', 'NaN', '-3', '1.5', '', '7; drop', '1234567890123456789']],
  ['assignmentId', ['4'], ['x', 'NaN', '-1']],
  ['setId', [String(oid())], ['abc', '12345', 'zzzzzzzzzzzzzzzzzzzzzzzz', String(oid()) + '0']],
  ['childId', [String(oid())], ['undefined', 'null', '5']],
]) {
  for (const v of good) assert.strictEqual(idParam(name, v).nexted, true, `:${name} accepts ${v}`);
  for (const v of bad) {
    const r = idParam(name, v);
    assert.strictEqual(r.nexted, false, `:${name} must refuse ${JSON.stringify(v)}`);
    assert.strictEqual(r.sent.status, 400);
  }
}
// Every URL parameter the router declares is covered.
const used = new Set();
router.stack.forEach((l) => { if (l.route) for (const m of l.route.path.matchAll(/:(\w+)/g)) used.add(m[1]); });
for (const name of used) assert(router.params[name], `:${name} is used by a route and must be validated`);
ok('a malformed question, assignment, set or child id is a 400 instead of a 500 CastError, and every route parameter is covered');

// ── Server: age window ────────────────────────────────────────────────────
let created;
PediaCustomQuestion.create = async (d) => { created.push(d); return { ...d, toObject() { return { ...d, id: 1 }; } }; };
const questionSet = { _id: oid(), title: 'Set', questionCount: 0, save: async () => {}, toObject() { return { _id: this._id, title: 'Set' }; } };
QuestionSet.create = async () => questionSet;
QuestionSet.deleteOne = async () => ({});
const handlerFor = (method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = (handler, { params = {}, body = {} } = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
  Promise.resolve(handler({ user: { userId: String(pediaId), role: 'pediatrician' }, params, body, query: {} }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const createOne = handlerFor('post', '/');
const createBulk = handlerFor('post', '/bulk');
const editOne = handlerFor('put', '/:id');
const base = { questionText: 'Does the child wave?', questionType: 'yes_no' };

(async () => {
  for (const [ageMin, ageMax] of [[30, 40], [-1, 5], [0, 19], [10, 5], ['x', 5], [1.5, 5], [{ $gt: 0 }, 5], [3, [4]]]) {
    created = [];
    const r = await quiet(() => call(createOne, { body: { ...base, ageMin, ageMax } }));
    assert.strictEqual(r.status, 400, `create ${JSON.stringify([ageMin, ageMax])} must be refused (${r.status})`);
    assert.match(r.body.error, /age/i);
    assert.strictEqual(created.length, 0, 'nothing was stored');
  }
  for (const [ageMin, ageMax, wantMin, wantMax] of [[undefined, undefined, 0, 18], [2, 5, 2, 5], ['3', '4', 3, 4], [0, 0, 0, 0], [18, 18, 18, 18], [null, 6, 0, 6]]) {
    created = [];
    const r = await quiet(() => call(createOne, { body: { ...base, ageMin, ageMax } }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual([created[0].ageMin, created[0].ageMax], [wantMin, wantMax]);
  }

  created = [];
  let r = await quiet(() => call(createBulk, { body: { questions: [{ ...base, ageMin: 9, ageMax: 2 }, { ...base, ageMin: 40 }] } }));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.details.length, 2, 'both bad windows are reported');
  assert.match(r.body.details[0].error, /Question 1: .*age/i);
  assert.strictEqual(created.length, 0);
  created = [];
  r = await quiet(() => call(createBulk, { body: { questions: [{ ...base, ageMin: 9, ageMax: 2 }, { ...base, ageMin: 1, ageMax: 4 }] } }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.createdCount, 1, 'the good question is still created');
  assert.strictEqual(r.body.errorCount, 1);
  assert.deepStrictEqual([created[0].ageMin, created[0].ageMax], [1, 4]);

  // Editing judges the window the question would end up with.
  const stored = { _id: oid(), id: 7, pediatricianId: pediaId, questionText: 'Q?', questionType: 'yes_no', options: [], isActive: true, ageMin: 4, ageMax: 8, questionSetId: null };
  stored.save = async () => {};
  stored.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
  PediaCustomQuestion.findOne = () => ({ then: (a, b) => Promise.resolve(stored).then(a, b) });
  require('../../models/PediaCustomQuestionAssignment').exists = async () => null;
  for (const body of [{ ageMin: 9 }, { ageMax: 3 }, { ageMin: -1 }, { ageMax: 'abc' }]) {
    r = await quiet(() => call(editOne, { params: { id: '7' }, body }));
    assert.strictEqual(r.status, 400, `edit ${JSON.stringify(body)} must be refused`);
    assert.deepStrictEqual([stored.ageMin, stored.ageMax], [4, 8], 'the stored window is untouched');
  }
  r = await quiet(() => call(editOne, { params: { id: '7' }, body: { ageMin: 6 } }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([stored.ageMin, stored.ageMax], [6, 8]);
  r = await quiet(() => call(editOne, { params: { id: '7' }, body: { questionText: 'Changed?' } }));
  assert.strictEqual(r.status, 200, 'an edit that does not touch the ages is unaffected');
  assert.deepStrictEqual([stored.ageMin, stored.ageMax], [6, 8]);
  ok('a question age window must be whole years 0-18 with min not above max, on create, bulk create and edit');

  // ── A fake DOM shared by the page scripts ───────────────────────────────
  function makeSandbox(extra = {}) {
    const els = new Map();
    const make = (id) => ({
      id, value: '', textContent: '', innerHTML: '', src: '', href: '', className: '', placeholder: '', type: '', disabled: false, checked: false,
      style: {}, dataset: {}, options: [], children: [], handlers: {}, removed: false, scrollTop: 0, scrollHeight: 0,
      addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      closest: () => null, querySelector: () => null, querySelectorAll: () => [], focus() {}, setAttribute() {},
      append(...kids) { this.children.push(...kids); }, appendChild(kid) { this.children.push(kid); return kid; }, remove() { this.removed = true; },
    });
    const el = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
    const removals = [];
    const sandbox = {
      console, URLSearchParams, URL, JSON, Number, String, Promise, Math, Date, Intl, encodeURIComponent, decodeURIComponent,
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, alert(m) { sandbox.alerts.push(m); }, confirm: () => true,
      alerts: [], removals, fetchCalls: [],
      localStorage: {
        getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
        setItem() {}, removeItem(k) { removals.push(k); }, clear() { removals.push('*'); },
      },
      document: { cookie: '', getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => make('__created'), body: { contains: () => true } },
      fetch: async (url, opts) => { sandbox.fetchCalls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; },
      KC: undefined,
      addEventListener() {},
      loadNotificationCount: async () => {},
      FormData: class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } },
      ...extra,
    };
    delete sandbox.KC;
    sandbox.window = sandbox;
    sandbox.location = { hostname: 'kindercura.example', origin: 'http://kindercura.example', pathname: '/pedia/x.html', href: '', search: '', replace() {} };
    vm.createContext(sandbox);
    return { sandbox, el };
  }
  const load = (sandbox, files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox));

  // ── The question form ───────────────────────────────────────────────────
  {
    const { sandbox, el } = makeSandbox();
    load(sandbox, ['api.js', 'constants/scoring.js', 'js/pedia/pedia-questions.js']);
    const tricky = `Says "mama" & <b>more</b> 'ok'`;
    vm.runInContext('clearOptions()', sandbox);
    sandbox.__opt = tricky;
    vm.runInContext('addOption(__opt)', sandbox);
    const row = el('optionsContainer').children[0];
    const input = row.children[0];
    assert.strictEqual(input.value, tricky, 'the option comes back exactly as stored, quotes and all');
    assert.strictEqual(row.innerHTML, '', 'the row is built from elements, not markup');
    const addOptionSource = fs.readFileSync(path.join(ROOT, 'js/pedia/pedia-questions.js'), 'utf8').split('function addOption')[1].split('function readAgeRange')[0];
    assert(!/onclick|innerHTML/.test(addOptionSource), 'addOption writes no markup and no inline handler');
    row.children[1].handlers.click();
    assert.strictEqual(row.removed, true, 'the remove button still removes its row');
    ok('an option containing quotes or markup is kept exactly when a question is edited, and its remove button still works');

    const setAges = (min, max) => { el('qAgeMin').value = min; el('qAgeMax').value = max; };
    const age = (min, max) => { setAges(min, max); return JSON.parse(vm.runInContext('JSON.stringify(readAgeRange())', sandbox)); };
    assert.deepStrictEqual(age('', ''), { ageMin: 0, ageMax: 18 }, 'empty fields take their defaults');
    assert.deepStrictEqual(age('2', '5'), { ageMin: 2, ageMax: 5 });
    assert.deepStrictEqual(age('0', '0'), { ageMin: 0, ageMax: 0 }, 'a typed 0 is kept (it used to become 18)');
    for (const [min, max] of [['9', '3'], ['-1', '5'], ['0', '19'], ['1.5', '4'], ['abc', '4'], ['1e1', '4x']]) {
      assert(age(min, max).error, `the form refuses ${min}-${max}`);
    }

    // saveQuestion stops before any request when the window is wrong.
    el('qText').value = 'Does the child wave?';
    el('qType').value = 'yes_no';
    el('qDomain').value = 'Other';
    setAges('12', '3');
    const before = sandbox.fetchCalls.length;
    await vm.runInContext('saveQuestion()', sandbox);
    assert.strictEqual(sandbox.fetchCalls.length, before, 'nothing is sent');
    assert.match(el('modalError').textContent, /minimum age/i);
    assert.strictEqual(el('modalError').style.display, 'block');
    vm.runInContext('addToBatch()', sandbox);
    assert.strictEqual(vm.runInContext('questionBatch.length', sandbox), 0, 'a bad window is not added to the batch either');
    setAges('1', '4');
    vm.runInContext('addToBatch()', sandbox);
    const batch = JSON.parse(vm.runInContext('JSON.stringify(questionBatch)', sandbox));
    assert.deepStrictEqual([batch[0].ageMin, batch[0].ageMax], [1, 4]);
    ok('the question form validates the age window before saving or batching and keeps a typed 0');
  }

  // ── Chat: a failed video upload must not send the message ───────────────
  {
    let xhrOutcome;
    class FakeXHR {
      constructor() { this.upload = {}; }
      open() {}
      setRequestHeader() {}
      send() { Promise.resolve().then(() => xhrOutcome(this)); }
    }
    const { sandbox, el } = makeSandbox({ XMLHttpRequest: FakeXHR });
    load(sandbox, ['js/pedia/pedia-chat.js']);
    el('sendBtn');
    const attach = () => vm.runInContext(`activeApptId = 5; pendingVideoFile = { name: 'v.mp4', size: 1000 };`, sandbox);

    // Network failure
    xhrOutcome = (x) => x.onerror();
    attach();
    el('msgInput').value = 'Please see this clip';
    sandbox.fetchCalls.length = 0;
    await vm.runInContext('sendMessage()', sandbox);
    assert.strictEqual(sandbox.fetchCalls.filter((c) => /\/chat\/5$/.test(c.url)).length, 0, 'no message is posted');
    assert.strictEqual(sandbox.alerts.length, 1);
    assert.match(sandbox.alerts[0], /video could not be uploaded/i);
    assert.strictEqual(vm.runInContext('pendingVideoFile !== null', sandbox), true, 'the attachment stays so it can be retried');
    assert.strictEqual(el('msgInput').value, 'Please see this clip', 'the typed text stays');
    assert.strictEqual(el('sendBtn').disabled, false, 'Send works again');

    // Server refusal
    xhrOutcome = (x) => { x.responseText = JSON.stringify({ error: 'too big' }); x.onload(); };
    sandbox.alerts.length = 0;
    await vm.runInContext('sendMessage()', sandbox);
    assert.strictEqual(sandbox.fetchCalls.filter((c) => /\/chat\/5$/.test(c.url)).length, 0);
    assert.strictEqual(sandbox.alerts.length, 1);

    // Success still sends text and video together.
    xhrOutcome = (x) => { x.responseText = JSON.stringify({ success: true, path: '/uploads/chat/v.mp4', fileName: 'v.mp4' }); x.onload(); };
    sandbox.alerts.length = 0;
    await vm.runInContext('sendMessage()', sandbox);
    const post = sandbox.fetchCalls.find((c) => /\/chat\/5$/.test(c.url) && c.opts && c.opts.method === 'POST');
    assert(post, 'the message is posted when the upload worked');
    const sent = JSON.parse(post.opts.body);
    assert.deepStrictEqual([sent.message, sent.videoPath, sent.videoName, sent.videoSize], ['Please see this clip', '/uploads/chat/v.mp4', 'v.mp4', 1000]);
    assert.strictEqual(sandbox.alerts.length, 0);
    assert.strictEqual(vm.runInContext('pendingVideoFile', sandbox), null, 'the attachment is cleared after a good send');
    ok('a failed chat video upload stops the send and keeps the text and attachment, instead of sending without the video');
  }

  // ── Settings avatar ─────────────────────────────────────────────────────
  {
    const avatarFor = async (profileIcon) => {
      const { sandbox, el } = makeSandbox({
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ user: { firstName: 'Ana', profileIcon, availability: {} } }) }),
      });
      load(sandbox, ['api.js']);
      sandbox.currentSettings = null;
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/pedia/pediatrician-settings.js'), 'utf8'), sandbox);
      el('navProfilePic').src = '/icons/profile.png';
      await vm.runInContext('loadSettings()', sandbox);
      return el('navProfilePic').src;
    };
    assert.strictEqual(await avatarFor('/uploads/profile/a.png'), '/uploads/profile/a.png', 'an uploaded photo is shown');
    for (const bad of ['default', 'javascript:alert(1)', 'https://elsewhere.example/a.png', '', null]) {
      assert.strictEqual(await avatarFor(bad), '/icons/profile.png', `${JSON.stringify(bad)} keeps the default avatar`);
    }
    ok('the settings page only swaps in an uploaded photo, otherwise the default avatar stays');
  }

  // ── apiFetch: an ended session returns to sign in ───────────────────────
  {
    const run = async ({ status, endpoint = '/children', token = 't', pathname = '/pedia/x.html' }) => {
      const { sandbox } = makeSandbox({
        fetch: async () => ({ ok: status < 400, status, json: async () => (status < 400 ? {} : { error: 'Token expired. Please log in again.' }) }),
        localStorage: {
          getItem: (k) => ({ kc_token: token || null }[k] ?? null), setItem() {}, removeItem() {}, clear() {},
        },
      });
      sandbox.location.pathname = pathname;
      load(sandbox, ['api.js']);
      const cleared = [];
      vm.runInContext('KC.clear = () => { __cleared.push(1); }', Object.assign(sandbox, { __cleared: cleared }));
      let error = null;
      try { await vm.runInContext(`apiFetch(${JSON.stringify(endpoint)})`, sandbox); } catch (e) { error = e; }
      return { href: sandbox.location.href, cleared: cleared.length, error };
    };
    let r = await run({ status: 401 });
    assert.strictEqual(r.href, '/login', 'an expired session goes back to sign in');
    assert.strictEqual(r.cleared, 1, 'the dead session is cleared');
    assert.match(r.error.message, /expired/i, 'the caller still gets the error');
    r = await run({ status: 401, endpoint: '/auth/login' });
    assert.deepStrictEqual([r.href, r.cleared], ['', 0], 'a wrong password is not a session ending');
    r = await run({ status: 401, token: '' });
    assert.deepStrictEqual([r.href, r.cleared], ['', 0], 'no token, nothing to end');
    for (const pathname of ['/login', '/login.html']) {
      r = await run({ status: 401, pathname });
      assert.deepStrictEqual([r.href, r.cleared], ['', 0], `no redirect loop on the sign-in page (${pathname})`);
    }
    r = await run({ status: 403 });
    assert.deepStrictEqual([r.href, r.cleared], ['', 0], 'a 403 is not a session ending');
    r = await run({ status: 200 });
    assert.strictEqual(r.error, null);
    ok('a 401 on a signed-in request clears the session and returns to sign in, except for sign-in itself and the sign-in page');
  }

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npedia-question-form.test.js: ${results.length} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
