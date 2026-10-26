// Saving a check-up twice, and auditing an edit (PEDIATRICIAN_BUGS.md #25).
//
//   - submitCheckup() had no in-flight guard, so a double click sent two POSTs
//     and created two records and two parent notifications. The referral form
//     beside it already disables its button and tracks a saving flag.
//   - updateCheckupRecord() overwrites the record in place, and its audit entry
//     held only the child id, so what the edit changed (the old diagnosis text
//     included) was not recorded anywhere.
//
// No DB, no browser: models are stubbed and updateCheckupRecord is called from
// the router's test hooks; the real My Patients script runs in a node vm.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const AuditLog = require('../../models/AuditLog');
const Child = require('../../models/Child');
const PediatricianCheckup = require('../../models/PediatricianCheckup');
const checkupsRouter = require('../../routes/checkups');
const { updateCheckupRecord } = checkupsRouter.__testables;

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const pediaId = oid();
const childId = oid();
const recordId = oid();
const chainable = (value) => {
  const q = { select: () => q, sort: () => q, populate: () => q, lean: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

(async () => {
  // ── The audit entry says what changed ───────────────────────────────────
  let entries = [];
  let record;
  Child.findById = () => chainable({ _id: childId, parentId: oid(), firstName: 'Ana', lastName: 'Reyes' });
  Appointment.exists = async () => ({ _id: 1 });
  PediatricianCheckup.findOne = () => chainable(record);
  AuditLog.create = async (e) => { entries.push(e); return e; };
  const fresh = () => {
    entries = [];
    record = {
      _id: recordId, childId, pediatricianId: pediaId, visitType: 'follow_up_checkup', status: 'monitoring',
      diagnosis: 'Speech delay, monitoring', findings: 'Says 20 words', recommendations: null,
      nextFollowUpDate: new Date('2030-03-01T00:00:00Z'), nextFollowUpReason: null, checkupDate: new Date('2030-01-10T00:00:00Z'),
      save: async function save() {},
    };
  };
  const pedia = { userId: String(pediaId), role: 'pediatrician' };

  fresh();
  await updateCheckupRecord(String(childId), String(recordId), pedia, {
    diagnosis: 'Speech delay, improving with therapy', status: 'improving', findings: 'Says 20 words', recommendations: 'Continue therapy',
  });
  assert.strictEqual(entries.length, 1);
  const { changes, childId: loggedChild } = entries[0].details;
  assert.strictEqual(loggedChild, String(childId));
  assert.deepStrictEqual(Object.keys(changes).sort(), ['diagnosis', 'recommendations', 'status']);
  assert.deepStrictEqual(changes.diagnosis, { from: 'Speech delay, monitoring', to: 'Speech delay, improving with therapy' });
  assert.deepStrictEqual(changes.status, { from: 'monitoring', to: 'improving' });
  assert.deepStrictEqual(changes.recommendations, { from: null, to: 'Continue therapy' });
  assert.strictEqual(changes.findings, undefined, 'a field sent with the value it already had is not a change');
  ok('an edit is audited with the old and new value of every field that changed, and only those');

  fresh();
  await updateCheckupRecord(String(childId), String(recordId), pedia, { nextFollowUpDate: '2030-04-15' });
  const dateChange = entries[0].details.changes.nextFollowUpDate;
  assert(dateChange, 'a date change is recorded');
  assert.strictEqual(new Date(dateChange.from).toISOString().slice(0, 10), '2030-03-01');
  assert.strictEqual(new Date(dateChange.to).toISOString().slice(0, 10), '2030-04-15');

  fresh();
  await updateCheckupRecord(String(childId), String(recordId), pedia, { diagnosis: 'Speech delay, monitoring' });
  assert.deepStrictEqual(entries[0].details.changes, {}, 'an edit that changes nothing is still logged, with no changes');
  ok('date changes are recorded, and an edit that changes nothing is still logged with an empty change list');

  // ── The save button cannot be double-clicked ────────────────────────────
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', textContent: '', innerHTML: '', src: '', href: '', disabled: false, checked: false, style: {}, dataset: {},
        options: [], addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
        closest: () => null, querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return els.get(id);
  };
  const posts = [];
  let releasePost = null;
  let failNext = false;
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise, Date, Math, encodeURIComponent,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, confirm: () => false,
    alerts: [],
    alert(msg) { sandbox.alerts.push(String(msg)); },
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
      setItem() {}, removeItem() {}, clear() {},
    },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true } },
    fetch: (url, opts = {}) => {
      const u = new URL(url);
      if (opts.method === 'POST' && u.pathname === `/api/checkups/child/kid1`) {
        posts.push(opts.body);
        return new Promise((resolve) => {
          releasePost = () => resolve(failNext
            ? { ok: false, status: 500, json: async () => ({ error: 'Server unavailable' }) }
            : { ok: true, status: 200, json: async () => ({ success: true }) });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, checkups: [], referrals: [], patients: [], assessments: [], notes: [] }) });
    },
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    loadNotificationCount: async () => {},
  };
  sandbox.window = sandbox;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/shared/care-plan-labels.js', 'js/pedia/pediatrician-patients.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
  }
  const fill = () => {
    sandbox.currentProgressChildId = 'kid1';
    sandbox.editingCheckupId = null;
    el('checkup-visit-type').value = 'follow_up_checkup';
    el('checkup-date').value = '2030-01-10';
    el('checkup-diagnosis').value = 'Speech delay, improving with therapy';
    el('checkup-status').value = 'monitoring';
    el('checkupSubmitBtn').textContent = 'Save Check-up';
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  fill();
  const first = vm.runInContext('submitCheckup()', sandbox);
  await tick();
  assert.strictEqual(el('checkupSubmitBtn').disabled, true, 'the button is disabled while saving');
  assert.strictEqual(el('checkupSubmitBtn').textContent, 'Saving...');
  const second = vm.runInContext('submitCheckup()', sandbox);   // the double click
  const third = vm.runInContext('submitCheckup()', sandbox);
  await tick();
  assert.strictEqual(posts.length, 1, 'only one request was sent');
  releasePost();
  await Promise.all([first, second, third]);
  assert.strictEqual(posts.length, 1, 'and still only one after it finished');
  assert.strictEqual(el('checkupSubmitBtn').disabled, false, 'the button is usable again');
  assert.strictEqual(el('checkupSubmitBtn').textContent, 'Save Check-up');
  ok('a double click on Save Check-up sends one request, with the button disabled while it runs');

  // A failed save keeps the form usable, and a retry is allowed.
  fill();
  failNext = true;
  sandbox.alerts.length = 0;
  const failing = vm.runInContext('submitCheckup()', sandbox);
  await tick();
  releasePost();
  await failing;
  assert(sandbox.alerts.some((m) => /Failed to save check-up: Server unavailable/.test(m)), 'the error is shown');
  assert.strictEqual(el('checkupSubmitBtn').disabled, false);
  assert.strictEqual(el('checkupSubmitBtn').textContent, 'Save Check-up', 'the label is restored so the form can be submitted again');
  failNext = false;
  const retry = vm.runInContext('submitCheckup()', sandbox);
  await tick();
  assert.strictEqual(posts.length, 3, 'a retry after a failure is sent');
  releasePost();
  await retry;
  ok('after a failed save the button and its label come back and the retry goes through');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\ncheckup-save-guard.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
