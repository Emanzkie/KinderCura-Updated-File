// Custom question locking and assignment (PEDIATRICIAN_BUGS.md #15).
//
//   - Edit and delete only locked a set while it was 'assigned', so the
//     questions of an ANSWERED set could be edited or deleted; deleting removed
//     the answered assignments, taking the parent's answers with them; a
//     standalone question was never locked.
//   - Assigning one question skipped the isActive check that assigning a set
//     applies, and did not freeze the question's set.
//   - appointmentId came from the request body into query filters unchecked, so
//     an object such as { $ne: null } became a query operator.
//   - Deleting a question left its set's stored questionCount stale.
//   - The assign modal picked the newest appointment of ANY status, so a
//     cancelled newest booking caused a false 403 even with an older live one.
//
// No DB: models are stubbed, the real handlers run from the router stack, and
// the real modal script runs in a node vm for the last check.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const PediaCustomQuestion = require('../../models/PediaCustomQuestion');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const QuestionSet = require('../../models/QuestionSet');
const User = require('../../models/User');
const router = require('../../routes/custom-questions');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const pediaId = oid();
const childId = oid();
const parentId = oid();
const setId = oid();
const same = (a, b) => String(a) === String(b);
const chain = (value) => {
  const q = { select: () => q, sort: () => q, lean: () => q, populate: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

let question;      // the question under test
let setStatus;     // null when the question is standalone
let assignments;   // existing assignments for it
let setUpdates;
let deletedFor;
let apptFilters;

function reset({ inSet = false, status = 'draft', assigned = [], isActive = true } = {}) {
  setStatus = inSet ? status : null;
  assignments = assigned;
  setUpdates = [];
  deletedFor = null;
  apptFilters = [];
  question = {
    _id: oid(), id: 7, pediatricianId: pediaId, questionText: 'Original?', questionType: 'yes_no', options: [], domain: 'Communication',
    isActive, questionSetId: inSet ? setId : null,
  };
  question.save = async function save() {};
  question.toObject = function toObject() { const { save, toObject, deleteOne, ...rest } = this; return { ...rest }; };
  question.deleteOne = async function deleteOne() { deletedFor = this._id; };
}

PediaCustomQuestion.findOne = () => chain(question);
PediaCustomQuestion.countDocuments = async () => 2;
QuestionSet.findById = () => chain(setStatus ? { _id: setId, status: setStatus } : null);
QuestionSet.findOne = () => chain({ _id: setId, status: setStatus || 'draft', title: 'Set', save: async function save() {} });
QuestionSet.updateOne = async (filter, update) => { setUpdates.push({ filter, update }); return { modifiedCount: 1 }; };
PediaCustomQuestionAssignment.exists = async (f) => (assignments.some((a) => (f.answeredAt ? a.answeredAt != null : true)) ? { _id: 1 } : null);
PediaCustomQuestionAssignment.deleteMany = async (f) => { deletedFor = deletedFor || f.questionId; assignments = []; return {}; };
PediaCustomQuestionAssignment.find = () => chain([]);
PediaCustomQuestionAssignment.findOne = () => chain(null);
PediaCustomQuestionAssignment.create = async (d) => ({ ...d, id: 1 });
PediaCustomQuestionAssignment.insertMany = async (d) => d;
Child.findById = () => chain({ _id: childId, parentId, firstName: 'Kemri' });
User.findById = () => chain({ firstName: 'Ana', lastName: 'Cruz' });
Appointment.findOne = (f) => { apptFilters.push(f); return chain({ _id: oid(), id: f.id || 1 }); };
Notification.create = async (n) => n;

const handlerFor = (method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${route}`);
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

const edit = handlerFor('put', '/:id');
const remove = handlerFor('delete', '/:id');
const assignOne = handlerFor('post', '/:id/assign');
const assignSet = handlerFor('post', '/set/:setId/assign');
const answered = [{ answeredAt: new Date(), answer: 'yes' }];
const unanswered = [{ answeredAt: null }];

(async () => {
  // ── Editing ─────────────────────────────────────────────────────────────
  for (const [label, opts, locked] of [
    ['a question in a draft set', { inSet: true, status: 'draft' }, false],
    ['a question in an assigned set', { inSet: true, status: 'assigned' }, true],
    ['a question in an ANSWERED set', { inSet: true, status: 'answered' }, true],
    ['a standalone question nobody has', {}, false],
    ['a standalone question with an assignment', { assigned: unanswered }, true],
  ]) {
    reset(opts);
    const r = await quiet(() => call(edit, { params: { id: '7' }, body: { questionText: 'Changed?' } }));
    assert.strictEqual(r.status, locked ? 403 : 200, `${label}: edit ${locked ? 'locked' : 'allowed'} (${r.status})`);
    assert.strictEqual(question.questionText, locked ? 'Original?' : 'Changed?', label);
    if (locked) {
      reset(opts);
      const toggle = await quiet(() => call(edit, { params: { id: '7' }, body: { isActive: false } }));
      assert.strictEqual(toggle.status, 200, `${label}: the active flag can still be switched`);
      assert.strictEqual(question.isActive, false);
    }
  }
  ok('edits are locked once a set is assigned or answered, and for an assigned standalone question; isActive can still be toggled');

  // ── Deleting ────────────────────────────────────────────────────────────
  for (const [label, opts, locked] of [
    ['a question in an answered set', { inSet: true, status: 'answered' }, true],
    ['a question in an assigned set', { inSet: true, status: 'assigned' }, true],
    ['a standalone question a parent answered', { assigned: answered }, true],
    ['a draft-set question a parent answered', { inSet: true, status: 'draft', assigned: answered }, true],
    ['a standalone question assigned but unanswered', { assigned: unanswered }, false],
    ['a question nobody has', {}, false],
  ]) {
    reset(opts);
    const r = await quiet(() => call(remove, { params: { id: '7' } }));
    assert.strictEqual(r.status, locked ? 403 : 200, `${label}: delete ${locked ? 'refused' : 'allowed'} (${r.status})`);
    assert.strictEqual(deletedFor == null, locked, `${label}: nothing is removed when refused`);
    if (locked) assert.strictEqual(assignments.length, opts.assigned ? opts.assigned.length : 0, `${label}: the parent's answers survive`);
  }
  ok("a question a parent answered, or one in an assigned/answered set, cannot be deleted and the parent's answers survive");

  reset({ inSet: true, status: 'draft' });
  await quiet(() => call(remove, { params: { id: '7' } }));
  const countUpdate = setUpdates.find((u) => u.update.$set && u.update.$set.questionCount != null);
  assert(countUpdate && countUpdate.update.$set.questionCount === 2, "the set's questionCount is recomputed from what remains");
  ok("deleting a question refreshes its set's questionCount");

  // ── Assigning ───────────────────────────────────────────────────────────
  for (const bad of [{ $ne: null }, ['5'], 'abc', -3, 1.5, 0]) {
    reset();
    const r = await quiet(() => call(assignOne, { params: { id: '7' }, body: { childId: String(childId), appointmentId: bad } }));
    assert.strictEqual(r.status, 400, `appointmentId ${JSON.stringify(bad)} must be refused`);
    assert.match(r.body.error, /appointmentId/);
    assert.strictEqual(apptFilters.length, 0, 'nothing was queried with it');
    reset({ inSet: true });
    const s = await quiet(() => call(assignSet, { params: { setId: String(setId) }, body: { childId: String(childId), appointmentId: bad } }));
    assert.strictEqual(s.status, 400, `set assign: ${JSON.stringify(bad)}`);
  }
  reset();
  let r = await quiet(() => call(assignOne, { params: { id: '7' }, body: { childId: String(childId), appointmentId: '5' } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(apptFilters[0].id, 5, 'a numeric string is accepted and used as a number');
  reset();
  r = await quiet(() => call(assignOne, { params: { id: '7' }, body: { childId: String(childId) } }));
  assert.strictEqual(r.status, 200, 'no appointmentId is still fine');
  ok('appointmentId must be a positive whole number; objects and junk never reach a query');

  reset({ isActive: false });
  r = await quiet(() => call(assignOne, { params: { id: '7' }, body: { childId: String(childId) } }));
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /inactive/);
  reset({ inSet: true, status: 'draft' });
  r = await quiet(() => call(assignOne, { params: { id: '7' }, body: { childId: String(childId) } }));
  assert.strictEqual(r.status, 200);
  assert(setUpdates.some((u) => same(u.filter._id, setId) && u.update.$set.status === 'assigned'), 'the set is frozen once one of its questions is assigned');
  ok('assigning one question refuses an inactive question and freezes its set, as assigning a set does');

  // ── The modal's appointment pick ────────────────────────────────────────
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', textContent: '', innerHTML: '', title: '', src: '', disabled: false, checked: false, indeterminate: false,
        style: {}, options: [], dataset: {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
      });
    }
    return els.get(id);
  };
  const sandbox = {
    console, URLSearchParams, setTimeout: () => 0, setInterval: () => 0, alert() {}, confirm: () => true,
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana' }) }[k] ?? null),
      setItem() {}, removeItem() {},
    },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true } },
    fetch: async (url) => {
      const u = new URL(url);
      const body = u.pathname === '/api/appointments/pedia'
        ? {
            appointments: [
              // newest first, as the server sorts them
              { id: 30, childId: 'kidA', status: 'cancelled', childFirstName: 'Ana' },
              { id: 20, childId: 'kidA', status: 'approved', childFirstName: 'Ana' },
              { id: 10, childId: 'kidA', status: 'completed', childFirstName: 'Ana' },
              { id: 31, childId: 'kidB', status: 'rejected', childFirstName: 'Bo' },
              { id: 40, childId: 'kidC', status: 'pending', childFirstName: 'Cy' },
              { id: 41, childId: 'kidC', status: 'cancelled', childFirstName: 'Cy' },
            ],
          }
        : {};
      return { ok: true, status: 200, json: async () => body };
    },
  };
  sandbox.window = sandbox;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'constants/scoring.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/pedia/pedia-questions.js'), 'utf8'), sandbox);
  await vm.runInContext('loadPatientsOnly()', sandbox);
  const byChild = Object.fromEntries(JSON.parse(vm.runInContext('JSON.stringify(patientList)', sandbox)).map((p) => [p.childId, p.appointmentId]));
  assert.strictEqual(byChild.kidA, 20, 'the newest LIVE appointment is chosen over a newer cancelled one');
  assert.strictEqual(byChild.kidB, null, 'a child with no live appointment sends none (the server then decides)');
  assert.strictEqual(byChild.kidC, 40, 'a live appointment is kept over a cancelled one that came later in the list');
  ok('the assign modal picks the newest live appointment, so a cancelled newest booking no longer causes a false 403');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\ncustom-question-rules.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
