// Regression test for resuming an unfinished screening.
//
// The bug: every visit to the screening page posted /assessments/initialize,
// which always created a new in_progress Assessment. Drafts saved by
// /save-draft were never read back, so reloading lost the parent's answers
// and left an orphan in_progress record per page load. The page also saved a
// draft only on every fifth answer.
//
// Server: /initialize now resumes the same user's latest in_progress screening
// for that child (started within 7 days) and returns its saved answers.
// Page: js/parent/screening.js restores those answers, continues at the first
// unanswered question, and saves each core answer as it is given.
//
// No DB and no network: models are monkey-patched against an in-memory store;
// the page script runs in a vm with stubbed browser globals.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const GuardianLink = require('../../models/GuardianLink');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const router = require('../../routes/assessments');

const ROOT = path.join(__dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;
const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => JSON.parse(JSON.stringify(v));
const chain = (value) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(value),
    then: (a, b) => Promise.resolve(clone(value)).then(a, b) };
  return o;
};
const ok = (m) => console.log('  ok -', m);

// ── Server: POST /initialize ──────────────────────────────────────────────
const parentId = oid();
const guardianId = oid();
const childId = oid();
const dob = new Date(); dob.setDate(1); dob.setMonth(dob.getMonth() - 50);

let db;
const reset = () => { db = { assessments: [], answers: [] }; };

Child.findById = () => chain({ _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: dob });
Appointment.exists = async () => null;
// The guardian is linked with permission to submit screenings.
GuardianLink.findOne = () => chain({ childId, guardianId, status: 'active', permissions: { submitAssessments: true } });
PediaCustomQuestionAssignment.find = () => chain([]);
CoreBankQuestion.find = () => chain([]);
Assessment.create = async (doc) => { const a = { _id: oid(), ...doc }; db.assessments.push(a); return a; };
Assessment.findOne = (filter) => {
  const hits = db.assessments.filter((a) => String(a.childId) === String(filter.childId)
    && String(a.createdBy) === String(filter.createdBy) && a.status === filter.status
    && new Date(a.startedAt) >= filter.startedAt.$gte)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const o = { sort: () => o, then: (res, rej) => Promise.resolve(hits[0] || null).then(res, rej) };
  return o;
};
AssessmentAnswer.find = (filter) => chain(db.answers.filter((r) =>
  String(r.assessmentId) === String(filter.assessmentId) && filter.origin.$in.includes(r.origin)));

const layer = router.stack.find((l) => l.route && l.route.path === '/initialize' && l.route.methods.post);
const initialize = layer.route.stack[layer.route.stack.length - 1].handle;
async function init(userId, role = 'parent') {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { await initialize({ user: { userId: String(userId), role }, body: { childId: String(childId) } }, res); }
  finally { Object.assign(console, { log, warn, error }); }
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function serverTests() {
  // 1. Reloading reuses the same unfinished screening instead of creating another.
  reset();
  const first = await init(parentId);
  assert.strictEqual(first.resumed, false);
  assert.deepStrictEqual(first.draftAnswers, []);
  const again = await init(parentId);
  assert.strictEqual(again.assessmentId, first.assessmentId, 'same assessment resumed');
  assert.strictEqual(db.assessments.length, 1, 'no orphan in_progress record');
  ok('a second visit resumes the same in_progress screening; no new record');

  // 2. Saved core and Dataset Question answers come back; others do not.
  db.answers.push(
    { assessmentId: first.assessmentId, questionId: 'Q01', answer: 'yes', origin: 'core_bank' },
    { assessmentId: first.assessmentId, questionId: 'Q05', answer: 'Sometimes', origin: 'core_bank' },
    { assessmentId: first.assessmentId, questionId: 'DQ01', answer: 'no', origin: 'dataset_question' },
    { assessmentId: first.assessmentId, questionId: 'Q07', answer: 'maybe', origin: 'core_bank' },
    { assessmentId: first.assessmentId, questionId: 'custom_9', answer: 'yes', origin: 'pedia_entry' },
  );
  const resumed = await init(parentId);
  assert.strictEqual(resumed.resumed, true);
  assert.deepStrictEqual(resumed.draftAnswers.map((a) => `${a.questionId}=${a.answer}`).sort(),
    ['DQ01=no', 'Q01=yes', 'Q05=sometimes']);
  ok('saved core and Dataset Question answers are returned (normalised); invalid and custom ones are not');

  // 3. A completed screening is never resumed.
  db.assessments[0].status = 'complete';
  const afterComplete = await init(parentId);
  assert.notStrictEqual(afterComplete.assessmentId, first.assessmentId);
  assert.strictEqual(afterComplete.resumed, false);
  ok('after completion, the next visit starts a new screening');

  // 4. A draft older than 7 days is not resumed.
  reset();
  db.assessments.push({ _id: oid(), childId, createdBy: parentId, status: 'in_progress', startedAt: new Date(Date.now() - 8 * DAY) });
  const stale = await init(parentId);
  assert.notStrictEqual(stale.assessmentId, String(db.assessments[0]._id));
  assert.strictEqual(db.assessments.length, 2);
  ok('a draft started more than 7 days ago is left alone; a new screening starts');

  // 5. Another user's draft for the same child is not resumed.
  reset();
  const parentDraft = await init(parentId);
  const guardianStart = await init(guardianId, 'legal_guardian');
  assert.notStrictEqual(guardianStart.assessmentId, parentDraft.assessmentId);
  ok("a linked guardian does not pick up the parent's unfinished screening");
}

// ── Page: js/parent/screening.js ──────────────────────────────────────────
function pageTests() {
  const src = fs.readFileSync(path.join(ROOT, 'js/parent/screening.js'), 'utf8');
  const posts = [];
  const ctx = vm.createContext({
    requireAuth() {}, KC: { childId: () => null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    window: {}, console: { log() {}, warn() {}, error() {} }, alert() {},
    apiFetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return {}; },
  });
  vm.runInContext(src, ctx, { filename: 'screening.js' });

  // A 50-month-old's core set plus one pediatrician question.
  vm.runInContext(`
    selectedChild = { id: 'c1', dateOfBirth: new Date(new Date().getFullYear() - 5, new Date().getMonth() - 2, 1) };
    QUESTION_SET = buildQuestionSet(selectedChild);
    CUSTOM_QUESTION_SET = [{ assignmentId: 9, questionText: 'Extra?', domain: 'Communication' }];
    buildFullSet();
    assessmentId = 'a1';`, ctx);
  const ids = vm.runInContext('FULL_SET.map(q => q.id)', ctx);

  // Restore: answers for questions in the set come back; the cursor moves to
  // the first unanswered question; unknown ids and bad values are ignored.
  const restored = vm.runInContext(`restoreDraftAnswers([
    { questionId: '${ids[0]}', answer: 'yes' },
    { questionId: '${ids[1]}', answer: 'sometimes' },
    { questionId: 'NOT_IN_SET', answer: 'yes' },
    { questionId: '${ids[2]}', answer: 'maybe' },
  ])`, ctx);
  assert.strictEqual(restored, 2);
  assert.strictEqual(vm.runInContext('currentQuestion', ctx), 2, 'continues at the first unanswered question');
  assert.strictEqual(vm.runInContext(`answers['${ids[0]}']`, ctx), 'yes');
  ok('page restores saved answers and continues at the first unanswered question');

  // Every core answer is saved as it is given, and only that answer is sent.
  return (async () => {
    vm.runInContext(`answers['${ids[2]}'] = 'no'; currentQuestion = 2;`, ctx);
    await vm.runInContext('saveDraftIfNeeded()', ctx);
    assert.strictEqual(posts.length, 1, 'the third answer is saved (not only every fifth)');
    assert.strictEqual(posts[0].url, '/assessments/save-draft');
    assert.deepStrictEqual(posts[0].body.answers.map((a) => a.questionId), [ids[2]]);
    assert.strictEqual(posts[0].body.answers[0].answer, 'no');

    // A pediatrician question is never drafted (it is saved only at submit).
    const customIndex = ids.indexOf('custom_9');
    vm.runInContext(`answers['custom_9'] = 'yes'; currentQuestion = ${customIndex};`, ctx);
    await vm.runInContext('saveDraftIfNeeded()', ctx);
    assert.strictEqual(posts.length, 1, 'no draft save for a custom question');
    ok('each core answer is drafted on its own; custom answers are not drafted');
  })();
}

(async () => {
  await serverTests();
  await pageTests();
  console.log('\nScreening draft resume tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
