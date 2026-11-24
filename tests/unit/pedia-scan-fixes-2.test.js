// Pediatrician: unsaved-text prompt, double-click guards, local reschedule date,
// escaped batch preview, and the hidden unfinished controls.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const loadApiFetch = require('../helpers/load-api-fetch');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const results = [];

function loadPage(file, { fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }), confirm = () => true, NewDate = Date } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: '', textContent: '', value: '', type: 'textarea', style: {}, dataset: {}, children: [], offsetParent: {}, modal: null,
        classList: { add() {}, remove() {} }, focus() {}, addEventListener() {}, setAttribute() {}, querySelector: () => null,
        contains(x) { return x.modal === id; }, closest() { return this.modal ? this : null; },
      });
    }
    return els.get(id);
  };
  const listeners = {};
  const location = { href: '', search: '', origin: 'https://kc.test', pathname: '/pedia/x' };
  const user = JSON.stringify({ id: 'd1', role: 'pediatrician', firstName: 'A', lastName: 'B' });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, location, confirm, alert() {}, URLSearchParams, fetch, Date: NewDate,
    KC: { token: () => 't', clear() {}, poll: () => ({ stop() {} }) },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, body: el('body'), createElement: () => el('new') },
    localStorage: { getItem: (k) => (k === 'kc_user' ? user : 't'), setItem() {}, removeItem() {} },
    setTimeout: () => 0, setInterval: () => 0, loadNotificationCount: async () => {},
  };
  sandbox.window = { location, KC: sandbox.KC, addEventListener() {} };
  vm.createContext(sandbox);
  loadApiFetch(sandbox);
  vm.runInContext(read(file), sandbox);
  const type = (id, value, modal) => { const e = el(id); e.modal = modal; e.value = value; (listeners.input || []).forEach((fn) => fn({ target: e })); };
  return { el, type, run: (code) => vm.runInContext(code, sandbox), sandbox };
}

(async () => {
  const F = 'js/pedia/pediatrician-patients.js';
  // 8. Unsaved text.
  let asked = 0; let answer = false;
  const page = loadPage(F, { confirm: () => { asked += 1; return answer; } });
  const shown = (id) => page.el(id).style.display;
  const openDiag = () => page.run("openDiagnosis('c1','Kid','','','','','','a1')");
  openDiag(); page.run('closeDiagnosisModal()');
  assert.deepStrictEqual([asked, shown('diagnosisModal')], [0, 'none'], 'nothing typed: closes without asking');
  openDiag(); page.type('diagnosis-text', 'Speech delay', 'diagnosisModal');
  page.run('closeDiagnosisModal()');
  assert.deepStrictEqual([asked, shown('diagnosisModal'), page.el('diagnosis-text').value], [1, 'flex', 'Speech delay'], 'No keeps the text');
  answer = true; page.run('closeDiagnosisModal()');
  assert.deepStrictEqual([asked, shown('diagnosisModal')], [2, 'none']);
  openDiag(); page.run('closeDiagnosisModal()');
  assert.strictEqual(asked, 2, 'a reopened window starts clean');

  answer = false;
  const progress = page.el('progressModal');
  page.run("window.currentProgressChildId = 'c1'"); progress.style.display = 'flex';
  page.type('checkup-diagnosis', 'Finding', 'progressModal');
  page.run('closeProgressModal()');
  assert.deepStrictEqual([asked, progress.style.display], [3, 'flex']);
  page.el('checkup-diagnosis').offsetParent = null; // the form was saved or cancelled, so it is hidden
  page.run('closeProgressModal()');
  assert.deepStrictEqual([asked, progress.style.display], [3, 'none']);
  results.push('Diagnosis and Check-up windows ask before discarding typed text');

  // 9. Double click.
  let release; const posts = [];
  const slow = loadPage(F, {
    fetch: (url, opts = {}) => {
      if (opts.method !== 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      posts.push(url);
      return new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({}) }); });
    },
  });
  slow.run("openDiagnosis('c1','Kid','','','','','','a1')");
  slow.type('diagnosis-text', 'A long enough finding', 'diagnosisModal');
  let first = slow.run('submitDiagnosis()'); slow.run('submitDiagnosis()');
  slow.run('closeDiagnosisModal()');
  assert.strictEqual(slow.el('diagnosisModal').style.display, 'flex', 'cannot be closed while saving');
  assert.strictEqual(posts.length, 1, 'diagnosis sent once');
  release(); await first;
  assert.strictEqual(slow.el('diagnosisModal').style.display, 'none', 'closes by itself after saving');
  slow.run("window.currentProgressChildId = 'c1'; loadProgressData = async () => {}; loadPatients = async () => {};");
  slow.el('progress-note').value = 'Better';
  first = slow.run('submitProgressNote()'); slow.run('submitProgressNote()');
  assert.strictEqual(posts.length, 2, 'note sent once');
  release(); await first;
  slow.el('progress-note').value = 'Next'; first = slow.run('submitProgressNote()');
  assert.strictEqual(posts.length, 3, 'a later note still saves');
  release(); await first;
  results.push('a double click saves a diagnosis or note once');

  // 10. 6 AM local is still yesterday in UTC for Manila.
  const local = new Date(2030, 0, 8, 6, 0);
  class Early extends Date { constructor(...a) { super(...(a.length ? a : [local.getTime()])); } toISOString() { return '2030-01-07T22:00:00.000Z'; } }
  const appts = loadPage('js/pedia/pediatrician-appointments.js', { NewDate: Early });
  appts.run("openReschedule(1,'Kid','Par')");
  assert.strictEqual(appts.el('rDate').min, '2030-01-08');
  const dash = loadPage('js/pedia/pediatrician-dashboard.js', { NewDate: Early });
  dash.run("pendingById = { 1: { id: 1, appointmentDate: '2030-01-09' } }; openReschedule(1)");
  assert.strictEqual(dash.el('rsDate').min, '2030-01-08');
  results.push('reschedule calendars start at the local date');

  // 11. Batch preview.
  const q = loadPage('js/pedia/pedia-questions.js');
  q.run("questionBatch = [{ questionText: 'Is 2 <b>less', questionType: 'yes_no', domain: 'Cognitive' }]; updateBatchPreview()");
  assert.ok(q.el('batchPreviewList').innerHTML.includes('Is 2 &lt;b&gt;less'));
  results.push('symbols show as typed in the batch preview');

  // 6 and 7. Hidden controls.
  const settings = read('PEDIA/pediatrician-settings.html').replace(/\r\n/g, '\n');
  assert.match(settings, /data-tab="notifications"\s+style="display:none;/);
  for (const id of ['privacyShowProfile', 'privacyShowAvailability', 'privacyShareRecs']) {
    assert.match(settings, new RegExp(`<div style="display:none;"><label[^>]*><input\\s+type="checkbox" id="${id}"`), `${id} hidden`);
  }
  assert.match(settings, /onclick="savePrivacySettings\(\)"\s+style="display:none;/);
  for (const id of [...read('js/pedia/pediatrician-settings.js').matchAll(/getElementById\('((?:notif|privacy)\w+)'\)/g)].map((m) => m[1])) {
    assert.ok(settings.includes(`id="${id}"`), `${id} is still in the page for loadSettings`);
  }
  for (const f of ['PEDIA/pedia-questions.html', 'js/pedia/pedia-questions.js']) assert.ok(!/editSetBtn|editQuestionSet|editQuestionInSet|removeQuestionFromSet|coming soon/.test(read(f)), f);
  results.push('switches that do nothing and unfinished set buttons are not shown');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Pediatrician scan fix tests (2) OK - ${results.length} groups`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
