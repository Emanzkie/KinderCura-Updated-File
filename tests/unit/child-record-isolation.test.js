// One parent, several children: each child's screenings, results and
// recommendations stay that child's own, and only people allowed to see a
// child reach its records. Exercises routes/children.js, routes/assessments.js
// (initialize/save-draft/submit/results/history/diagnose) and
// routes/recommendations.js against one in-memory store.
//
// Regressions defended here:
//   B1 - POST /submit authorised on childId but wrote to whatever assessmentId
//        it was given, so a sibling's (or another family's) result could be
//        overwritten and re-pointed at the wrong child.
//   B2 - POST /save-draft had no access check at all.
//   B3 - GET /:assessmentId/results had no access check at all.
//   B4 - GET /api/recommendations/:assessmentId only checked role 'parent'.
//   B5 - POST /diagnose/:childId let any pediatrician diagnose any child.
//   B6 - DELETE /api/appointments/:id let any logged-in user hard-delete.
//   B7 - POST /api/children/register built a regex from the raw name, so a
//        name with "(" crashed (500) and "." matched any character.
//
//   B8 - POST /diagnose/:childId wrote to the newest STARTED screening, which
//        may be an unfinished reassessment the parent never sees.
//   B9 - PUT /api/appointments/:id let a parent set any status (e.g. approve
//        an unpaid booking), bypassing /status and /cancel.
//
// No DB, no network: bufferCommands is off, so any model call this file does
// not stub fails immediately instead of waiting for a connection. Email
// credentials are blanked before any route loads (dotenv never overrides a
// variable that is already set), so no status update can send real mail.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const AssessmentResult = require('../../models/AssessmentResult');
const Recommendation = require('../../models/Recommendation');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const User = require('../../models/User');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const assessmentProgress = require('../../services/assessmentProgress');
const datasetEligibility = require('../../services/datasetQuestionEligibility');
const staging = require('../../constants/developmental-staging');
const sse = require('../../sse');
const childrenRouter = require('../../routes/children');
const assessmentsRouter = require('../../routes/assessments');
const recommendationsRouter = require('../../routes/recommendations');
const appointmentsRouter = require('../../routes/appointments');

const results = [];
const ok = (label) => results.push(label);
const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const same = (a, b) => String(a) === String(b);
const chain = (get) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(get()),
    then: (a, b) => Promise.resolve(get()).then(a, b) };
  return o;
};

// ── In-memory store ───────────────────────────────────────────────────────
const db = { children: [], links: [], appts: [], assessments: [], answers: [], results: [], recs: [] };

const BANK = [
  ['Q1', 'Communication'], ['Q2', 'Communication'],
  ['Q3', 'Social Skills'], ['Q4', 'Social Skills'],
  ['Q5', 'Cognitive'], ['Q6', 'Cognitive'],
  ['Q7', 'Motor Skills'], ['Q8', 'Motor Skills'],
];
CoreBankQuestion.find = () => chain(() => BANK.map(([questionId]) => ({ questionId })));
datasetEligibility.loadDatasetQuestionIndex = async () => new Map();

Child.find = (f) => chain(() => db.children.filter((c) =>
  (!f.parentId || same(c.parentId, f.parentId)) && (!f._id || f._id.$in.map(String).includes(String(c._id)))));
Child.findOne = (f) => chain(() => db.children.find((c) => same(c.parentId, f.parentId)
  && f.firstName.test(c.firstName) && f.lastName.test(c.lastName)) || null);
Child.findById = (id) => chain(() => db.children.find((c) => same(c._id, id)) || null);
Child.create = async (doc) => { const c = { _id: oid(), ...doc }; db.children.push(c); return c; };

GuardianLink.find = (f) => chain(() => db.links.filter((l) => same(l.guardianId, f.guardianId) && l.status === f.status));
GuardianLink.findOne = (f) => chain(() => db.links.find((l) =>
  same(l.childId, f.childId) && same(l.guardianId, f.guardianId) && l.status === f.status) || null);

Appointment.exists = async (f) => (db.appts.some((a) => same(a.childId, f.childId) && same(a.pediatricianId, f.pediatricianId)) ? { _id: oid() } : null);
Appointment.countDocuments = async () => 0;
Appointment.find = (f) => chain(() => db.appts.filter((a) => same(a.pediatricianId, f.pediatricianId)));
Appointment.findOne = (f) => chain(() => withSave(db.appts.find((a) => a.id === f.id
  && (!f.pediatricianId || same(a.pediatricianId, f.pediatricianId))) || null));
Payment.find = () => chain(() => []);
Appointment.deleteOne = async (f) => { db.appts = db.appts.filter((a) => !same(a._id, f._id)); };
PediaCustomQuestionAssignment.find = () => chain(() => []);

const withSave = (a) => {
  if (a) {
    Object.defineProperty(a, 'save', { value: async function save() { return this; }, enumerable: false, configurable: true });
    Object.defineProperty(a, 'toObject', { value: function toObject() { return clone(this); }, enumerable: false, configurable: true });
  }
  return a;
};
Assessment.create = async (doc) => { const a = { _id: oid(), ...doc }; db.assessments.push(a); return a; };
Assessment.findById = (id) => chain(() => withSave(db.assessments.find((a) => same(a._id, id)) || null));
// Store order is start order, and screenings here complete in that order, so
// the last match is both the newest started and the newest completed.
Assessment.findOne = (f) => chain(() => withSave(db.assessments.filter((a) =>
  same(a.childId, f.childId) && (!f.status || a.status === f.status)).at(-1) || null));
Assessment.find = (f) => chain(() => db.assessments.filter((a) => same(a.childId, f.childId)));
Assessment.findByIdAndUpdate = async (id, update) => {
  const a = db.assessments.find((x) => same(x._id, id));
  if (a) Object.assign(a, update);
  return a;
};

AssessmentAnswer.findOneAndUpdate = async (f, update) => {
  let row = db.answers.find((r) => same(r.assessmentId, f.assessmentId) && r.questionId === f.questionId);
  if (!row) { row = { _id: oid() }; db.answers.push(row); }
  Object.assign(row, update);
  return row;
};
AssessmentAnswer.find = (f) => chain(() => db.answers.filter((r) => same(r.assessmentId, f.assessmentId) && (!f.origin || r.origin === f.origin)));

// Upsert keyed on assessmentId, like the real unique index.
AssessmentResult.findOneAndUpdate = async (f, update) => {
  let row = db.results.find((r) => same(r.assessmentId, f.assessmentId));
  if (!row) { row = { _id: oid() }; db.results.push(row); }
  Object.assign(row, update);
  return row;
};
AssessmentResult.findOne = (f) => chain(() => db.results.find((r) => same(r.assessmentId, f.assessmentId)) || null);
AssessmentResult.find = (f) => chain(() => db.results.filter((r) => f.assessmentId.$in.map(String).includes(String(r.assessmentId))));

Recommendation.find = (f) => chain(() => db.recs.filter((r) => same(r.assessmentResultId, f.assessmentResultId)));
Recommendation.insertMany = async (rows) => { db.recs.push(...rows); };
User.find = () => chain(() => []);
User.findById = (id) => chain(() => ({ _id: id, firstName: 'Test', lastName: 'User', email: null }));
Notification.create = async () => ({});
sse.broadcast = () => {};

// Rule-based snapshot from the project's own staging module (no ML here).
assessmentProgress.buildPredictionForStorage = async (scores) => {
  const careStage = staging.getCareStageFromScore(scores.overallScore);
  const plan = staging.getCarePlanForCareStage(careStage) || {};
  const def = staging.getCareStageDefinition(careStage) || {};
  return {
    source: 'rule_based', modelVersion: null, riskCategory: null, careStage,
    careStageLabel: def.label || careStage, consultationLevel: plan.consultationLevel,
    monitoringLevel: plan.monitoringLevel, probabilities: null, mlUnavailableReason: 'test', generatedAt: new Date(),
  };
};

// ── Fake req/res ──────────────────────────────────────────────────────────
async function call(router, method, routePath, user, { params = {}, body = {}, query = {} } = {}) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `${method} ${routePath} exists`);
  const res = {
    statusCode: 200, body: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const req = { params, body, query, user };
  try {
    // Runs the route's own guards (e.g. adminOnly) and handler in order. Only
    // authMiddleware is skipped: req.user stands in for the verified token.
    for (const { handle } of layer.route.stack) {
      if (handle.name === 'authMiddleware') continue;
      let nextCalled = false;
      await handle(req, res, () => { nextCalled = true; });
      if (!nextCalled) break;
    }
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
  return res;
}

const person = (role) => ({ userId: String(oid()), role });
const parent = person('parent');
const otherParent = person('parent');
const guardian = person('legal_guardian');
const pedA = person('pediatrician');
const pedB = person('pediatrician');
const secretary = person('secretary');
const admin = person('admin');

// A child `years` (and two months) old today — inside the 3-8 screening range.
function dob(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setMonth(d.getMonth() - 2);
  return d.toISOString().slice(0, 10);
}
const answersWithConcerns = (concernDomains) => BANK.map(([questionId, domain]) => ({
  questionId, domain, questionText: questionId, answer: concernDomains.includes(domain) ? 'No' : 'Yes',
}));

async function screen(user, childId, concernDomains) {
  const init = await call(assessmentsRouter, 'post', '/initialize', user, { body: { childId } });
  assert.strictEqual(init.statusCode, 200, 'initialize succeeds');
  const sub = await call(assessmentsRouter, 'post', '/submit', user, {
    body: { assessmentId: init.body.assessmentId, childId, answers: answersWithConcerns(concernDomains) },
  });
  assert.strictEqual(sub.statusCode, 200, 'submit succeeds');
  return sub.body.assessmentId;
}
const resultFor = (assessmentId) => db.results.find((r) => same(r.assessmentId, assessmentId));
const snapshot = (rows) => JSON.stringify(clone(rows));

async function run() {
  // ── One parent, four children ───────────────────────────────────────────
  const kids = [];
  for (const [firstName, age] of [['Alpha', 4], ['Bravo', 5], ['Charlie', 6], ['Delta', 7]]) {
    const r = await call(childrenRouter, 'post', '/register', parent, { body: { firstName, lastName: 'Testfam', dateOfBirth: dob(age) } });
    assert.strictEqual(r.statusCode, 201);
    kids.push(r.body.childId);
  }
  assert.strictEqual(new Set(kids).size, 4);
  const listed = await call(childrenRouter, 'get', '/', parent);
  assert.strictEqual(listed.body.children.length, 4);
  ok('one parent registers four children, each with its own id, and sees all four');

  // ── Different concerns per child; one with two, one with none ────────────
  const concerns = [['Communication'], ['Motor Skills'], ['Social Skills', 'Cognitive'], []];
  const aIds = [];
  for (let i = 0; i < 4; i++) aIds.push(await screen(parent, kids[i], concerns[i]));
  for (let i = 0; i < 4; i++) assert(same(resultFor(aIds[i]).childId, kids[i]), `child ${i + 1} result is linked to child ${i + 1}`);
  assert.deepStrictEqual(aIds.map((id) => resultFor(id).riskFlags.length), [1, 1, 2, 0]);
  ok('each child gets its own result: different concerns, one child with two, one with none');

  // ── Recommendation priorities differ per child ──────────────────────────
  const priorities = [];
  for (const id of aIds) {
    const r = await call(recommendationsRouter, 'get', '/:assessmentId', parent, { params: { assessmentId: id } });
    assert.strictEqual(r.statusCode, 200);
    priorities.push(r.body.recommendations.map((x) => `${x.skill}:${x.priority}`).join(' '));
  }
  assert.strictEqual(new Set(priorities).size, 4, 'four distinct priority sets');
  for (let i = 0; i < 4; i++) assert.strictEqual(db.recs.filter((r) => same(r.childId, kids[i])).length, 4);
  ok('recommendation priorities follow each child\'s own scores and are stored against that child');

  // ── Pediatricians: A sees siblings 1 and 2, B sees sibling 3 ─────────────
  let nextId = 1;
  for (const [i, ped] of [[0, pedA], [1, pedA], [2, pedB]]) {
    db.appts.push({ _id: oid(), id: nextId++, childId: kids[i], parentId: parent.userId, pediatricianId: ped.userId, status: 'approved' });
  }
  const historyStatus = async (user, i) => (await call(assessmentsRouter, 'get', '/:childId/history', user, { params: { childId: kids[i] } })).statusCode;
  assert.strictEqual(await historyStatus(pedA, 0), 200);
  assert.strictEqual(await historyStatus(pedA, 1), 200);
  assert.strictEqual(await historyStatus(pedA, 2), 403);
  assert.strictEqual(await historyStatus(pedB, 2), 200);
  assert.strictEqual(await historyStatus(pedB, 0), 403);
  ok('one pediatrician reaches both siblings it sees; two pediatricians each reach only their own sibling');

  // ── Diagnosis and reassessment touch only their own child ───────────────
  const othersBefore = snapshot(db.assessments.filter((a) => !same(a.childId, kids[0])));
  const dx = await call(assessmentsRouter, 'post', '/diagnose/:childId', pedA, {
    params: { childId: kids[0] },
    body: { diagnosis: 'Expressive language delay noted on review.', clinicalOutcome: 'monitor', clinicalOutcomeDomains: ['Communication'] },
  });
  assert.strictEqual(dx.statusCode, 200);
  assert(db.assessments.find((a) => same(a._id, aIds[0])).diagnosis);
  assert.strictEqual(snapshot(db.assessments.filter((a) => !same(a.childId, kids[0]))), othersBefore);

  const siblingResultsBefore = snapshot(db.results.filter((r) => !same(r.childId, kids[0])));
  await screen(parent, kids[0], []);
  assert.strictEqual(snapshot(db.results.filter((r) => !same(r.childId, kids[0]))), siblingResultsBefore);
  const history = await call(assessmentsRouter, 'get', '/:childId/history', parent, { params: { childId: kids[0] } });
  assert.strictEqual(history.body.assessments.length, 2);
  assert.strictEqual(resultFor(aIds[0]).riskFlags.length, 1, 'the first screening keeps its original result');
  ok('a diagnosis and a reassessment for one child leave every sibling\'s records unchanged');

  // ── B1: submit refuses another child's assessment ───────────────────────
  const siblingResult = snapshot(resultFor(aIds[1]));
  const siblingAnswers = snapshot(db.answers.filter((a) => same(a.assessmentId, aIds[1])));
  const crossed = await call(assessmentsRouter, 'post', '/submit', parent, {
    body: { assessmentId: aIds[1], childId: kids[3], answers: answersWithConcerns([]) },
  });
  assert.strictEqual(crossed.statusCode, 400);
  assert.strictEqual(snapshot(resultFor(aIds[1])), siblingResult, 'sibling result untouched');
  assert.strictEqual(snapshot(db.answers.filter((a) => same(a.assessmentId, aIds[1]))), siblingAnswers, 'sibling answers untouched');

  const otherKid = await call(childrenRouter, 'post', '/register', otherParent, { body: { firstName: 'Echo', lastName: 'Otherfam', dateOfBirth: dob(5) } });
  const crossFamily = await call(assessmentsRouter, 'post', '/submit', otherParent, {
    body: { assessmentId: aIds[2], childId: otherKid.body.childId, answers: answersWithConcerns([]) },
  });
  assert.strictEqual(crossFamily.statusCode, 400);
  assert.strictEqual(resultFor(aIds[2]).riskFlags.length, 2, 'other family\'s child result untouched');

  const resubmit = await call(assessmentsRouter, 'post', '/submit', parent, {
    body: { assessmentId: aIds[3], childId: kids[3], answers: answersWithConcerns([]) },
  });
  assert.strictEqual(resubmit.statusCode, 200, 'resubmitting the same child\'s assessment still works');
  ok('B1: submit refuses an assessment that belongs to a sibling or another family; same-child resubmit unchanged');

  // ── B2: save-draft is limited to people who may screen that child ───────
  const draftInit = await call(assessmentsRouter, 'post', '/initialize', parent, { body: { childId: kids[1] } });
  const draftId = draftInit.body.assessmentId;
  const draftBody = (answer) => ({ assessmentId: draftId, progress: 25, answers: [{ questionId: 'Q3', domain: 'Social Skills', answer }] });
  const draftAnswer = () => (db.answers.find((a) => same(a.assessmentId, draftId) && a.questionId === 'Q3') || {}).answer;

  let r = await call(assessmentsRouter, 'post', '/save-draft', parent, { body: draftBody('Sometimes') });
  assert.strictEqual(r.statusCode, 200, 'owner can save a draft');
  assert.strictEqual(draftAnswer(), 'Sometimes');

  r = await call(assessmentsRouter, 'post', '/save-draft', otherParent, { body: draftBody('No') });
  assert.strictEqual(r.statusCode, 403);
  r = await call(assessmentsRouter, 'post', '/save-draft', pedB, { body: draftBody('No') });
  assert.strictEqual(r.statusCode, 403, 'a pediatrician not linked to the child is refused');
  assert.strictEqual(draftAnswer(), 'Sometimes', 'refused drafts change nothing');

  r = await call(assessmentsRouter, 'post', '/save-draft', pedA, { body: draftBody('Yes') });
  assert.strictEqual(r.statusCode, 200, 'the linked pediatrician can save a draft');

  r = await call(assessmentsRouter, 'post', '/save-draft', parent, { body: { ...draftBody('No'), assessmentId: aIds[1] } });
  assert.strictEqual(r.statusCode, 409, 'a completed screening cannot be redrafted');
  assert.strictEqual(snapshot(db.answers.filter((a) => same(a.assessmentId, aIds[1]))), siblingAnswers);

  r = await call(assessmentsRouter, 'post', '/save-draft', parent, { body: { ...draftBody('No'), assessmentId: String(oid()) } });
  assert.strictEqual(r.statusCode, 404);
  ok('B2: save-draft works for the owner and linked pediatrician, refuses others, completed and unknown screenings');

  // ── B3: results are limited to people who may view that child ───────────
  const resultsStatus = async (user, id) => (await call(assessmentsRouter, 'get', '/:assessmentId/results', user, { params: { assessmentId: id } }));
  const own = await resultsStatus(parent, aIds[0]);
  assert.strictEqual(own.statusCode, 200);
  assert.strictEqual(own.body.results.childId, kids[0]);
  assert.strictEqual(own.body.results.diagnosis, 'Expressive language delay noted on review.');
  assert.strictEqual((await resultsStatus(pedA, aIds[0])).statusCode, 200, 'linked pediatrician');
  assert.strictEqual((await resultsStatus(admin, aIds[0])).statusCode, 200, 'admin');

  const foreign = await resultsStatus(otherParent, aIds[0]);
  assert.strictEqual(foreign.statusCode, 403);
  assert.strictEqual(foreign.body.results, undefined, 'no scores or diagnosis leak');
  assert.strictEqual((await resultsStatus(pedB, aIds[0])).statusCode, 403, 'unlinked pediatrician');

  db.links.push({ _id: oid(), childId: kids[0], guardianId: guardian.userId, status: 'active', permissions: { viewAssessments: true } });
  assert.strictEqual((await resultsStatus(guardian, aIds[0])).statusCode, 200, 'guardian with viewAssessments');
  db.links[0].permissions.viewAssessments = false;
  assert.strictEqual((await resultsStatus(guardian, aIds[0])).statusCode, 403, 'guardian without viewAssessments');
  ok('B3: results reach the owner, linked pediatrician, admin and permitted guardian only');

  // ── B4: recommendations are checked for every role ──────────────────────
  const recStatus = async (user) => (await call(recommendationsRouter, 'get', '/:assessmentId', user, { params: { assessmentId: aIds[0] } })).statusCode;
  assert.strictEqual(await recStatus(parent), 200, 'owner');
  assert.strictEqual(await recStatus(pedA), 200, 'linked pediatrician');
  assert.strictEqual(await recStatus(admin), 200, 'admin');
  assert.strictEqual(await recStatus(otherParent), 403, 'other parent');
  assert.strictEqual(await recStatus(pedB), 403, 'unlinked pediatrician');
  assert.strictEqual(await recStatus(secretary), 403, 'secretary with no link to the child');
  db.links[0].permissions.viewRecommendations = true;
  assert.strictEqual(await recStatus(guardian), 200, 'guardian with viewRecommendations');
  db.links[0].permissions.viewRecommendations = false;
  assert.strictEqual(await recStatus(guardian), 403, 'guardian without viewRecommendations');
  ok('B4: recommendations reach the owner, linked pediatrician, admin and permitted guardian only');

  // ── B5: only a pediatrician linked to the child may diagnose ────────────
  const diagnosisBefore = db.assessments.filter((a) => same(a.childId, kids[0])).at(-1).diagnosis;
  const unlinkedDx = await call(assessmentsRouter, 'post', '/diagnose/:childId', pedB, {
    params: { childId: kids[0] }, body: { diagnosis: 'Unlinked pediatrician diagnosis text.' },
  });
  assert.strictEqual(unlinkedDx.statusCode, 403);
  assert.strictEqual(db.assessments.filter((a) => same(a.childId, kids[0])).at(-1).diagnosis, diagnosisBefore, 'nothing written');
  const linkedDx = await call(assessmentsRouter, 'post', '/diagnose/:childId', pedA, {
    params: { childId: kids[1] }, body: { diagnosis: 'Gross motor delay, refer for physiotherapy review.' },
  });
  assert.strictEqual(linkedDx.statusCode, 200, 'linked pediatrician can diagnose their other sibling patient');
  const notPedia = await call(assessmentsRouter, 'post', '/diagnose/:childId', parent, {
    params: { childId: kids[0] }, body: { diagnosis: 'Parent-written diagnosis text.' },
  });
  assert.strictEqual(notPedia.statusCode, 403, 'non-pediatricians still refused');
  ok('B5: diagnose requires a pediatrician with an appointment for that child');

  // ── B6: hard delete is admin-only ───────────────────────────────────────
  const target = db.appts[0];
  for (const user of [parent, otherParent, pedA, secretary, guardian]) {
    const r = await call(appointmentsRouter, 'delete', '/:appointmentId', user, { params: { appointmentId: String(target.id) } });
    assert.strictEqual(r.statusCode, 403, `${user.role} cannot hard-delete`);
  }
  assert(db.appts.some((a) => same(a._id, target._id)), 'appointment still present');
  const adminDelete = await call(appointmentsRouter, 'delete', '/:appointmentId', admin, { params: { appointmentId: String(target.id) } });
  assert.strictEqual(adminDelete.statusCode, 200);
  assert(!db.appts.some((a) => same(a._id, target._id)), 'admin delete removes it');
  ok('B6: only an admin can hard-delete an appointment');

  // ── B7: names with regex characters register and match literally ────────
  const register = (firstName) => call(childrenRouter, 'post', '/register', parent, { body: { firstName, lastName: 'Testfam', dateOfBirth: dob(5) } });
  for (const name of ['Ma(ry', "D'Angelo", 'Anne-Marie', 'Jo.', 'Zoë [Li]', 'A+B*?']) {
    assert.strictEqual((await register(name)).statusCode, 201, `"${name}" registers`);
  }
  assert.strictEqual(db.children.find((c) => c.firstName === 'Zoë [Li]').firstName, 'Zoë [Li]', 'name stored unchanged');
  assert.strictEqual((await register('ma(RY')).statusCode, 409, 'same name, any case, same birthday is still a duplicate');
  assert.strictEqual((await register('Mary')).statusCode, 201);
  assert.strictEqual((await register('M.ry')).statusCode, 201, '"." is literal, so M.ry is not a duplicate of Mary');
  ok('B7: names with special characters register intact; duplicate check matches them literally');

  // ── B8: a diagnosis lands on the latest COMPLETED screening ─────────────
  const byId = (id) => db.assessments.find((a) => same(a._id, id));
  // Child 2 already has an unfinished draft (B2 block) newer than its only
  // completed screening; the B5 diagnosis above must have gone to the latter.
  assert.strictEqual(byId(aIds[1]).diagnosis, 'Gross motor delay, refer for physiotherapy review.');
  assert.strictEqual(byId(draftId).diagnosis, undefined, 'the unfinished draft got no diagnosis');

  // The B6 block deleted pediatrician A's appointment with child 1; a new
  // booking re-links them (diagnose still requires that link — B5).
  db.appts.push({ _id: oid(), id: 800, childId: kids[0], parentId: parent.userId, pediatricianId: pedA.userId, status: 'approved' });
  const reInit = await call(assessmentsRouter, 'post', '/initialize', parent, { body: { childId: kids[0] } });
  const unfinishedId = reInit.body.assessmentId;
  const completedKid0 = db.assessments.filter((a) => same(a.childId, kids[0]) && a.status === 'complete').at(-1);
  const unfinishedBefore = snapshot(byId(unfinishedId));
  const othersBeforeDx = snapshot(db.assessments.filter((a) => !same(a.childId, kids[0])));
  const reviewDx = await call(assessmentsRouter, 'post', '/diagnose/:childId', pedA, {
    params: { childId: kids[0] },
    body: { diagnosis: 'Language now age-appropriate on re-screening.', clinicalOutcome: 'typical_development' },
  });
  assert.strictEqual(reviewDx.statusCode, 200);
  assert.strictEqual(completedKid0.diagnosis, 'Language now age-appropriate on re-screening.', 'saved on the completed screening');
  assert.strictEqual(completedKid0.clinicalOutcome, 'typical_development');
  assert.strictEqual(snapshot(byId(unfinishedId)), unfinishedBefore, 'unfinished reassessment untouched');
  assert.strictEqual(snapshot(db.assessments.filter((a) => !same(a.childId, kids[0]))), othersBeforeDx, 'siblings untouched');
  assert.strictEqual(byId(aIds[0]).diagnosis, 'Expressive language delay noted on review.', 'the older screening keeps its own diagnosis');

  const patients = await call(assessmentsRouter, 'get', '/pedia-patients', pedA);
  assert.strictEqual(patients.statusCode, 200);
  const card0 = patients.body.patients.find((p) => p.childId === kids[0]);
  const card1 = patients.body.patients.find((p) => p.childId === kids[1]);
  assert.strictEqual(card0.diagnosis, 'Language now age-appropriate on re-screening.', 'the card shows the saved diagnosis');
  assert.strictEqual(card0.clinicalOutcome, 'typical_development');
  assert.strictEqual(card0.resultAssessmentId, String(completedKid0._id));
  assert.strictEqual(card0.assessmentId, unfinishedId, 'assessmentId (newest started) is unchanged');
  assert.strictEqual(card1.diagnosis, 'Gross motor delay, refer for physiotherapy review.', 'each sibling card shows its own diagnosis');

  const fox = await call(childrenRouter, 'post', '/register', parent, { body: { firstName: 'Foxtrot', lastName: 'Testfam', dateOfBirth: dob(6) } });
  const foxId = fox.body.childId;
  db.appts.push({ _id: oid(), id: 900, childId: foxId, parentId: parent.userId, pediatricianId: pedA.userId, status: 'pending', paymentStatus: 'Unpaid' });
  const foxInit = await call(assessmentsRouter, 'post', '/initialize', parent, { body: { childId: foxId } });
  const noCompleted = await call(assessmentsRouter, 'post', '/diagnose/:childId', pedA, {
    params: { childId: foxId }, body: { diagnosis: 'Should not be saved anywhere.' },
  });
  assert.strictEqual(noCompleted.statusCode, 404);
  assert.strictEqual(byId(foxInit.body.assessmentId).diagnosis, undefined, 'nothing written to the in-progress screening');
  ok('B8: diagnoses land on each child\'s latest completed screening, never an unfinished one; the card reads them back');

  // ── B9: the legacy PUT /:id no longer changes status ────────────────────
  const appt = db.appts.find((a) => same(a.childId, kids[1]));
  Object.assign(appt, { status: 'pending', paymentStatus: 'Unpaid', notes: null });
  db.links.push({ _id: oid(), childId: kids[1], guardianId: guardian.userId, status: 'active', permissions: { manageAppointments: true } });
  const put = (user, body) => call(appointmentsRouter, 'put', '/:appointmentId', user, { params: { appointmentId: String(appt.id) }, body });

  for (const user of [parent, guardian, pedA, admin]) {
    for (const status of ['approved', 'completed', 'cancelled']) {
      const r = await put(user, { status });
      assert.strictEqual(r.statusCode, 400, `${user.role} cannot set ${status} through PUT /:id`);
    }
  }
  assert.strictEqual(appt.status, 'pending', 'status unchanged');
  assert.strictEqual(appt.paymentStatus, 'Unpaid', 'payment unchanged');
  assert.strictEqual((await put(parent, { status: 'approved', notes: 'sneak' })).statusCode, 400);
  assert.strictEqual(appt.notes, null, 'a refused request writes nothing, notes included');

  assert.strictEqual((await put(otherParent, { status: 'approved' })).statusCode, 403);
  assert.strictEqual((await put(otherParent, { notes: 'not mine' })).statusCode, 403);
  assert.strictEqual(appt.notes, null);

  assert.strictEqual((await put(parent, { notes: 'Bring vaccination card' })).statusCode, 200, 'owner can still edit notes');
  assert.strictEqual(appt.notes, 'Bring vaccination card');
  assert.strictEqual((await put(pedA, { notes: 'Fasting not needed' })).statusCode, 200, 'pediatrician can still edit notes');
  assert.strictEqual(appt.notes, 'Fasting not needed');
  assert.strictEqual(appt.status, 'pending');

  // The dedicated routes keep working for the roles they serve.
  const statusPut = (user, status) => call(appointmentsRouter, 'put', '/:appointmentId/status', user, { params: { appointmentId: String(appt.id) }, body: { status } });
  assert.strictEqual((await statusPut(parent, 'completed')).statusCode, 403, 'parents cannot use /status');
  assert.strictEqual((await statusPut(pedB, 'completed')).statusCode, 404, 'another pediatrician cannot reach it');
  assert.strictEqual(appt.status, 'pending');
  const completed = await statusPut(pedA, 'completed');
  assert.strictEqual(completed.statusCode, 200, `the linked pediatrician can complete it: ${JSON.stringify(completed.body)}`);
  assert.strictEqual(appt.status, 'completed');

  const foxAppt = db.appts.find((a) => a.id === 900);
  const cancel = await call(appointmentsRouter, 'post', '/:appointmentId/cancel', parent, { params: { appointmentId: '900' } });
  assert.strictEqual(cancel.statusCode, 200, 'the owning parent can still cancel');
  assert.strictEqual(foxAppt.status, 'cancelled');
  ok('B9: PUT /:id refuses status changes from every role and writes nothing; notes, /status and /cancel still work');
}

run()
  .then(() => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.log(`Child record isolation tests OK — ${results.length} groups`);
    process.exit(0);
  })
  .catch((err) => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.error(err);
    process.exit(1);
  });
