// Tests for activating approved Dataset Questions and using them in child
// screenings: services/datasetQuestionEligibility.js, the admin activation
// route (routes/admin.js), /api/assessments initialize/save-draft/submit
// (routes/assessments.js), the admin page control and the screening page's
// question set.
//
// Root cause being fixed: approved Dataset Questions could not be activated
// from the admin page (there was no control or endpoint), and even an active
// one could never reach a parent, because the screening page only rendered its
// hardcoded core checklist and /submit labelled every answer core_bank.
//
// No DB, no network: models run against one in-memory store (matched with
// sift after Mongoose's own casting), real CoreBankQuestion documents are used
// so the model's own approval/activation validators run, and route handlers
// are called with fake req/res.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');
const sift = require('sift').default || require('sift');

mongoose.set('strictQuery', true);

const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const AssessmentResult = require('../../models/AssessmentResult');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const PediaCustomQuestion = require('../../models/PediaCustomQuestion');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const AuditLog = require('../../models/AuditLog');
const assessmentProgress = require('../../services/assessmentProgress');
const sse = require('../../sse');
const { DATASET_QUESTIONS, toQuestionDoc } = require('../../constants/datasetQuestions');
const { adminOnly } = require('../../middleware/auth');
const eligibility = require('../../services/datasetQuestionEligibility');
const adminRouter = require('../../routes/admin');
const assessmentsRouter = require('../../routes/assessments');

const { setDatasetQuestionActivation } = adminRouter.__testables;
const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);
const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── In-memory store ───────────────────────────────────────────────────────
let db;
const realFind = { cbq: CoreBankQuestion.find, answer: AssessmentAnswer.find };
const casted = (Model, filter) => { const q = realFind[Model === CoreBankQuestion ? 'cbq' : 'answer'].call(Model, filter); q.cast(Model); return q.getFilter(); };
const match = (Model, filter) => sift(casted(Model, filter || {}));
const chain = (value) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(value),
    then: (a, b) => Promise.resolve(clone(value)).then(a, b) };
  return o;
};

const parentId = oid();
const childId = oid();
const DAY = 24 * 3600 * 1000;
// A child exactly `months` old today (same arithmetic as screening.js).
function dobForMonths(months) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  return d;
}

function datasetRow(questionId, patch = {}) {
  const entry = DATASET_QUESTIONS.find((q) => q.questionId === questionId);
  return { _id: oid(), ...toQuestionDoc(entry), createdAt: new Date(Date.now() - DAY), ...patch };
}

function seed({ childMonths = 50 } = {}) {
  db = {
    children: [{ _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: dobForMonths(childMonths) }],
    questions: [
      // Core bank (no citation, no approval workflow).
      { _id: oid(), questionId: 'Q01', text: 'Does your child ride a tricycle?', domain: 'Motor Skills', minAgeMonths: 36, origin: 'core_bank', approvalStatus: null, generationMethod: null, isActive: true },
      { _id: oid(), questionId: 'Q05', text: 'Does your child speak using 3–4 word sentences?', domain: 'Communication', minAgeMonths: 36, origin: 'core_bank', approvalStatus: null, generationMethod: null, isActive: true },
      // Dataset Questions in each lifecycle state.
      datasetRow('DQ01', { approvalStatus: 'approved', approvedAt: new Date(), isActive: true }),   // live, 48 mo
      datasetRow('DQ02', { approvalStatus: 'approved', approvedAt: new Date(), isActive: false }),  // approved, inactive, 48 mo
      datasetRow('DQ03', { approvalStatus: 'approved', approvedAt: new Date(), isActive: true }),   // live, 60 mo
      datasetRow('DQ05', { approvalStatus: 'pending_pediatrician_approval', isActive: false }),     // pending
      datasetRow('DQ06', { approvalStatus: 'rejected', isActive: false }),                         // rejected
    ],
    pediaQuestions: [{ _id: oid(), questionText: 'Does your child name 5 animals?', domain: 'Communication', isActive: true, pediatricianId: oid() }],
    assessments: [],
    answers: [],
    results: [],
    audit: [],
  };
}
const q = (questionId) => db.questions.find((r) => r.questionId === questionId);

// CoreBankQuestion: real documents, real validators, persisted into the store.
let failNextSave = false;
CoreBankQuestion.find = (filter) => chain(db.questions.filter(match(CoreBankQuestion, filter)));
CoreBankQuestion.findOne = async (filter) => {
  const row = db.questions.find(match(CoreBankQuestion, filter));
  if (!row) return null;
  const doc = CoreBankQuestion.hydrate(clone(row));
  doc.save = async function save() {
    if (failNextSave) { failNextSave = false; throw new Error('write failed'); }
    const err = this.validateSync();
    if (err) throw err;
    Object.assign(row, { isActive: this.isActive });
    return this;
  };
  return doc;
};
AuditLog.create = async (entry) => { db.audit.push(entry); return entry; };

Child.findById = (id) => chain(db.children.find((c) => String(c._id) === String(id)) || null);
Appointment.exists = async () => null;
PediaCustomQuestionAssignment.find = () => chain([]);
Assessment.create = async (doc) => { const a = { _id: oid(), ...doc }; db.assessments.push(a); return a; };
Assessment.findById = (id) => {
  const a = db.assessments.find((x) => String(x._id) === String(id)) || null;
  const o = chain(a);
  o.then = (res, rej) => Promise.resolve(a).then(res, rej);
  return o;
};
Assessment.findByIdAndUpdate = async (id, update) => { const a = db.assessments.find((x) => String(x._id) === String(id)); if (a) Object.assign(a, update); return a; };
AssessmentAnswer.findOneAndUpdate = async (filter, update) => {
  let row = db.answers.find((r) => String(r.assessmentId) === String(filter.assessmentId) && r.questionId === filter.questionId);
  if (!row) { row = { _id: oid() }; db.answers.push(row); }
  Object.assign(row, update);
  return row;
};
AssessmentAnswer.find = (filter) => chain(db.answers.filter(match(AssessmentAnswer, filter)));
AssessmentResult.findOneAndUpdate = async (filter, update) => { const r = { _id: oid(), ...update }; db.results.push(r); return r; };

let lastCoreAnswersForMl = null;
assessmentProgress.buildPredictionForStorage = async (scores, cid, coreAnswersByQuestion) => {
  lastCoreAnswersForMl = coreAnswersByQuestion;
  return { source: 'rule_based', riskCategory: 'Low', mlUnavailableReason: 'test' };
};
sse.broadcast = () => {};

const quietly = async (fn) => {
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
};
function handler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `${method} ${routePath} exists`);
  return { handle: layer.route.stack[layer.route.stack.length - 1].handle, stack: layer.route.stack };
}
async function call(router, method, routePath, req) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await quietly(() => handler(router, method, routePath).handle({ params: {}, body: {}, ...req }, res));
  return res;
}
const parent = { userId: String(parentId), role: 'parent' };
const initialize = () => call(assessmentsRouter, 'post', '/initialize', { user: parent, body: { childId: String(childId) } });
const offeredIds = (res) => res.body.datasetQuestions.map((x) => x.id);
const activate = (questionId, isActive) => quietly(() => setDatasetQuestionActivation(String(q(questionId)._id), isActive, String(oid())));

// ── Tests 1 & 3: activation workflow ──────────────────────────────────────
async function activationTests() {
  seed();
  let init = await initialize();
  assert.deepStrictEqual(offeredIds(init), ['DQ01'], 'only the approved+active, age-appropriate question is offered');
  ok('1: an approved but inactive Dataset Question (DQ02) is not offered to a new screening');

  const r = await activate('DQ02', true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.changed, true);
  assert.strictEqual(r.body.question.isActive, true);
  assert.strictEqual(r.body.question.isUsableInAssessment, true);
  assert.strictEqual(q('DQ02').isActive, true, 'persisted in the store');
  assert.strictEqual(db.audit.at(-1).action, 'dataset_question_activated');
  init = await initialize();
  assert.deepStrictEqual(offeredIds(init), ['DQ01', 'DQ02']);
  const again = await activate('DQ02', true);
  assert.strictEqual(again.body.changed, false, 'activating twice is a no-op');
  assert.strictEqual(db.audit.length, 1);
  ok('1: the admin activates DQ02, it is saved and offered to the next screening with no deploy');

  for (const id of ['DQ05', 'DQ06']) {
    const before = clone(q(id));
    const res = await activate(id, true);
    assert.strictEqual(res.status, 409, `${id} refused`);
    assert(/pediatrician approval/i.test(res.body.error));
    assert.deepStrictEqual(clone(q(id)), before, `${id} unchanged`);
  }
  assert(!offeredIds(await initialize()).some((x) => ['DQ05', 'DQ06'].includes(x)));
  ok('3: pending and rejected Dataset Questions cannot be activated and are never offered');

  // The model refuses too, even if a caller bypassed the route check.
  const pendingDoc = CoreBankQuestion.hydrate(clone(q('DQ05')));
  pendingDoc.isActive = true;
  assert(pendingDoc.validateSync() && pendingDoc.validateSync().errors.isActive);
  ok('3: the model\'s own validator also refuses to activate an unapproved question');

  assert.strictEqual((await quietly(() => setDatasetQuestionActivation(String(q('Q01')._id), false, 'x'))).status, 404);
  assert.strictEqual(q('Q01').isActive, true);
  assert.strictEqual((await quietly(() => setDatasetQuestionActivation('not-an-id', true, 'x'))).status, 404);
  assert.strictEqual((await quietly(() => setDatasetQuestionActivation(String(q('DQ02')._id), 'yes', 'x'))).status, 400);
  ok('5: the activation route never touches core-bank rows and rejects malformed input');
}

// ── Test 8: authorization and failed persistence ──────────────────────────
async function authorizationTests() {
  seed();
  const { stack } = handler(adminRouter, 'patch', '/data-origin/dataset-questions/:id/activation');
  assert(stack.some((l) => l.handle === adminOnly), 'route is guarded by adminOnly');
  for (const role of ['parent', 'pediatrician', 'secretary']) {
    const res = { status(c) { this.code = c; return this; }, json() { return this; } };
    let reached = false;
    adminOnly({ user: { role } }, res, () => { reached = true; });
    assert.strictEqual(res.code, 403);
    assert.strictEqual(reached, false);
  }
  ok('8: only admins reach the activation route');

  failNextSave = true;
  const res = await call(adminRouter, 'patch', '/data-origin/dataset-questions/:id/activation', {
    user: { userId: String(oid()), role: 'admin' }, params: { id: String(q('DQ02')._id) }, body: { isActive: true },
  });
  assert.strictEqual(res.statusCode, 500);
  assert(!/write failed/.test(res.body.error), 'no internal detail in the message');
  assert.strictEqual(q('DQ02').isActive, false);
  assert.strictEqual(db.audit.length, 0);
  ok('8: a failed save returns an error, changes nothing and logs nothing');
}

// ── Tests 2, 6, 7: screening answers, scoring, age ────────────────────────
async function screeningTests() {
  seed({ childMonths: 50 });
  await activate('DQ02', true);
  const init = await initialize();
  const offered = init.body.datasetQuestions;
  assert.deepStrictEqual(offered.map((x) => x.id), ['DQ01', 'DQ02']);
  const dq1 = offered[0];
  assert.strictEqual(dq1.scoreDomain, 'Communication');
  assert.strictEqual(dq1.origin, 'dataset_question');
  assert.strictEqual(dq1.text, q('DQ01').text);
  assert(dq1.sourcedFrom && /CDC/.test(dq1.sourcedFrom));
  ok('2: an offered Dataset Question carries its id, scoring domain, wording and source');

  assert(!offeredIds(init).includes('DQ03'));
  seed({ childMonths: 62 });
  assert(offeredIds(await initialize()).includes('DQ03'));
  seed({ childMonths: 50 });
  q('DQ01').domain = 'Other';
  assert(!offeredIds(await initialize()).includes('DQ01'));
  ok('7: a question is offered only when the child is old enough and its domain is a scored domain');

  // Submit: core answers + two eligible Dataset answers + forged ones.
  seed({ childMonths: 50 });
  await activate('DQ02', true);
  const assessmentId = (await initialize()).body.assessmentId;
  const answers = [
    { questionId: 'Q01', domain: 'Motor Skills', questionText: 'Does your child ride a tricycle?', answer: 'yes' },
    { questionId: 'Q05', domain: 'Communication', questionText: 'Does your child speak using 3–4 word sentences?', answer: 'no' },
    { questionId: 'DQ01', domain: 'Motor Skills', questionText: 'tampered text', answer: 'sometimes' },
    { questionId: 'DQ02', domain: 'Communication', questionText: '', answer: 'yes' },
    { questionId: 'DQ03', domain: 'Communication', questionText: '', answer: 'yes' },   // too young for it
    { questionId: 'DQ05', domain: 'Communication', questionText: '', answer: 'yes' },   // pending
  ];
  const submit = () => call(assessmentsRouter, 'post', '/submit', { user: parent, body: { assessmentId, childId: String(childId), answers } });
  let res = await submit();
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));

  const byId = Object.fromEntries(db.answers.map((a) => [a.questionId, a]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ['DQ01', 'DQ02', 'Q01', 'Q05']);
  assert.strictEqual(byId.DQ01.origin, 'dataset_question');
  assert.strictEqual(byId.DQ01.sourceQuestionRef, 'DQ01');
  assert.strictEqual(byId.DQ01.domain, 'Communication', 'domain comes from the question record, not the client');
  assert.strictEqual(byId.DQ01.questionText, q('DQ01').text, 'wording comes from the question record');
  assert.strictEqual(byId.Q01.origin, 'core_bank');
  assert.strictEqual(byId.Q01.sourceQuestionRef, 'Q01');
  ok('2: Dataset answers are saved against the right question with origin dataset_question and their source id');
  ok('3/7: answers for a pending or too-advanced Dataset Question are refused, not stored as core-bank answers');

  const result = db.results.at(-1);
  // Communication: Q05 no (0/2) + DQ01 sometimes (1/2) + DQ02 yes (2/2) = 3/6 = 50%.
  assert.strictEqual(result.communicationScore, 50);
  assert.strictEqual(result.motorScore, 100);
  assert.strictEqual(result.socialScore, 0);
  assert.strictEqual(result.overallScore, Math.round((50 + 0 + 0 + 100) / 4));
  assert.deepStrictEqual(Object.keys(lastCoreAnswersForMl).sort(), ['Q01', 'Q05'], 'ML still receives core-bank answers only');
  ok('6: Dataset answers count in their domain with the existing 2/1/0 scale; the ML features stay core-only');

  const answerCount = db.answers.length;
  res = await submit();
  assert.strictEqual(db.answers.length, answerCount, 'resubmitting does not duplicate answers');
  ok('6: submitting again updates the same answer records instead of duplicating them');

  // Test 1 via the admin Times Answered count: it reads origin + sourceQuestionRef.
  const counted = db.answers.filter(sift({ sourceQuestionRef: { $nin: [null, ''] }, origin: 'dataset_question' }));
  assert.deepStrictEqual(counted.map((a) => a.sourceQuestionRef).sort(), ['DQ01', 'DQ02']);
  ok('2: the admin "Times Answered" query now counts these answers');

  // ── Test 4: deactivation ──
  const recorded = clone({ answers: db.answers, results: db.results });
  const off = await activate('DQ01', false);
  assert.strictEqual(off.body.question.isActive, false);
  assert.strictEqual(db.audit.at(-1).action, 'dataset_question_deactivated');
  assert(!offeredIds(await initialize()).includes('DQ01'));
  assert.deepStrictEqual(clone({ answers: db.answers, results: db.results }), recorded);
  ok('4: a deactivated question leaves new screenings; recorded answers and results are untouched');

  // Save-draft takes the same path.
  const draftAssessment = (await initialize()).body.assessmentId;
  await call(assessmentsRouter, 'post', '/save-draft', {
    user: parent,
    body: { assessmentId: draftAssessment, progress: 20, answers: [
      { questionId: 'DQ02', domain: 'X', questionText: 'x', answer: 'yes' },
      { questionId: 'DQ01', domain: 'Communication', questionText: '', answer: 'yes' },
    ] },
  });
  const drafts = db.answers.filter((a) => String(a.assessmentId) === String(draftAssessment));
  assert.deepStrictEqual(drafts.map((a) => [a.questionId, a.origin, a.domain]), [['DQ02', 'dataset_question', 'Communication']]);
  ok('2/4: draft saving applies the same rule (deactivated DQ01 refused, DQ02 stored with its real domain)');
}

// ── Test 5: pediatrician questions unaffected ─────────────────────────────
async function pediatricianQuestionTests() {
  seed();
  const before = clone(db.pediaQuestions);
  await activate('DQ02', true);
  await activate('DQ02', false);
  assert.deepStrictEqual(clone(db.pediaQuestions), before);
  assert.strictEqual(PediaCustomQuestion.modelName, 'PediaCustomQuestion');
  ok('5: activating/deactivating Dataset Questions never touches pediatrician questions');
}

// ── Browser code: admin control and the screening question set ───────────
async function browserTests() {
  // Admin page.
  const alerts = [];
  let reloads = 0;
  let nextResult = 'ok';
  const admin = {
    window: {}, document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    requireAuth: () => true, KC: { user: () => ({ role: 'admin' }) },
    alert: (m) => alerts.push(m), confirm: () => true, console, URLSearchParams, setInterval: () => 0,
    apiFetch: async () => { if (nextResult === 'fail') throw new Error('Server error'); return { success: true }; },
  };
  vm.createContext(admin);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/admin/admin-data-sources.js'), 'utf8'), admin);
  admin.loadSummary = async () => { reloads += 1; };
  admin.loadList = async () => { reloads += 1; };

  const row = (patch) => ({ category: 'dataset_question', id: 'abc123', questionId: 'DQ02', approvalStatus: 'approved', approvalStatusLabel: 'Approved', isActive: false, canActivate: true, ...patch });
  assert(admin.approvalCell(row({})).includes('>Activate</button>'));
  assert(admin.approvalCell(row({ isActive: true })).includes('>Deactivate</button>'));
  const pending = admin.approvalCell(row({ approvalStatus: 'pending_pediatrician_approval', canActivate: false }));
  assert(!pending.includes('<button') && /requires pediatrician approval/.test(pending));
  assert(!admin.approvalCell({ category: 'pediatrician_question', approvalStatus: null, isActive: true }).includes('<button'));
  ok('Admin page: Activate/Deactivate is offered only for approved Dataset Questions');

  const btn = { disabled: false, textContent: 'Activate' };
  nextResult = 'fail';
  await admin.setDatasetQuestionActive('abc123', true, btn);
  assert.strictEqual(reloads, 0);
  assert(/Could not change the activation status/.test(alerts.at(-1)) && !alerts.some((m) => /activated\./.test(m)));
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.textContent, 'Activate');
  nextResult = 'ok';
  await admin.setDatasetQuestionActive('abc123', true, btn);
  assert.strictEqual(reloads, 2, 'success reloads the list and the source counts from the server');
  assert.strictEqual(alerts.at(-1), 'Dataset Question activated.');
  ok('8: the admin page never reports success when saving fails, and reloads from the server when it succeeds');

  // Screening page.
  const screening = {
    window: {}, document: { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    requireAuth: () => true, KC: { childId: () => null }, localStorage: { getItem: () => null, setItem() {} }, console,
  };
  vm.createContext(screening);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/parent/screening.js'), 'utf8'), screening);
  const child = { dateOfBirth: dobForMonths(50).toISOString() };
  const coreOnly = screening.buildQuestionSet(child);
  const extra = [
    { id: 'DQ01', minAgeMonths: 48, scoreDomain: 'Communication', displayDomain: 'Language', text: 'DQ01 text', difficulty: '', origin: 'dataset_question' },
    { id: 'DQ01', minAgeMonths: 48, scoreDomain: 'Communication', displayDomain: 'Language', text: 'duplicate', difficulty: '', origin: 'dataset_question' },
    { id: 'Q05', minAgeMonths: 36, scoreDomain: 'Communication', text: 'clash with core id', origin: 'dataset_question' },
    { id: 'DQ03', minAgeMonths: 60, scoreDomain: 'Communication', text: 'too old', origin: 'dataset_question' },
  ];
  const withDataset = screening.buildQuestionSet(child, extra);
  assert.strictEqual(withDataset.length, coreOnly.length + 1, 'one new item: no duplicate, no id clash, no age-ineligible item');
  assert.strictEqual(withDataset.filter((x) => x.id === 'Q05')[0].text, coreOnly.find((x) => x.id === 'Q05').text);
  const ids = withDataset.map((x) => x.id);
  assert.deepStrictEqual(ids.filter((x) => x !== 'DQ01'), coreOnly.map((x) => x.id), 'core order unchanged');
  assert(ids.indexOf('DQ01') > ids.lastIndexOf(coreOnly.filter((x) => x.minAgeMonths <= 48).at(-1).id) - 1);
  assert.deepStrictEqual(screening.buildQuestionSet(child, undefined).map((x) => x.id), coreOnly.map((x) => x.id));
  ok('7: the screening page adds Dataset Questions through the same age filter and order, without duplicates');

  assert.strictEqual(eligibility.ageInMonths(dobForMonths(50)), screening.getAgeInMonths(dobForMonths(50).toISOString()));
  ok('7: server and screening page compute the child\'s age in months the same way');
}

(async () => {
  await activationTests();
  await authorizationTests();
  await screeningTests();
  await pediatricianQuestionTests();
  await browserTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Dataset Question assessment tests OK — ${results.length} groups`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
