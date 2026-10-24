// Regression test for POST /api/assessments/submit completeness.
//
// The bug: /submit scored whatever arrived. A partial or empty submission was
// saved as a result, and a domain with no answers came out as 0% and was
// risk-flagged ("delay detected"), dragging the overall score down too.
//
// Now every age-appropriate core-bank question (CoreBankQuestion,
// minAgeMonths <= child's age as of 24 hours ago) must have a Yes / Sometimes
// / No answer, in the request or saved earlier as a draft, before anything is
// created or written.
//
// No DB and no network: model statics are monkey-patched against one
// in-memory store and the handler is called directly from the router stack,
// as in dataset-question-assessment.test.js.
const assert = require('assert');
const mongoose = require('mongoose');

const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const AssessmentResult = require('../../models/AssessmentResult');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const assessmentProgress = require('../../services/assessmentProgress');
const sse = require('../../sse');
const router = require('../../routes/assessments');

const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => JSON.parse(JSON.stringify(v));
const chain = (value) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(value),
    then: (a, b) => Promise.resolve(clone(value)).then(a, b) };
  return o;
};

// A child exactly `months` old today, mid-month so the 24-hour margin never
// changes the age (same arithmetic as js/parent/screening.js).
function dobForMonths(months) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  return d;
}

const parentId = oid();
const childId = oid();
// Four core questions at 36 months (one per domain) and one that unlocks at 48.
const BANK = [
  { questionId: 'Q01', domain: 'Motor Skills', minAgeMonths: 36 },
  { questionId: 'Q05', domain: 'Communication', minAgeMonths: 36 },
  { questionId: 'Q06', domain: 'Cognitive', minAgeMonths: 36 },
  { questionId: 'Q07', domain: 'Social Skills', minAgeMonths: 36 },
  { questionId: 'Q10', domain: 'Motor Skills', minAgeMonths: 48 },
].map((q) => ({ _id: oid(), origin: 'core_bank', text: q.questionId, isActive: true, ...q }));

let db;
function seed(childMonths) {
  db = {
    child: { _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: dobForMonths(childMonths) },
    assessments: [], answers: [], results: [],
  };
}

CoreBankQuestion.find = (filter) => chain(filter && filter.origin && filter.origin === 'dataset_question' ? [] : BANK);
Child.findById = () => chain(db.child);
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
AssessmentAnswer.find = (filter) => chain(db.answers.filter((r) =>
  String(r.assessmentId) === String(filter.assessmentId) && (!filter.origin || r.origin === filter.origin)));
AssessmentResult.findOneAndUpdate = async (filter, update) => { const r = { _id: oid(), ...update }; db.results.push(r); return r; };
assessmentProgress.buildPredictionForStorage = async () => ({ source: 'rule_based', riskCategory: 'Low', mlUnavailableReason: 'test' });
sse.broadcast = () => {};

const layer = router.stack.find((l) => l.route && l.route.path === '/submit' && l.route.methods.post);
assert(layer, 'POST /submit exists');
const submit = layer.route.stack[layer.route.stack.length - 1].handle;

async function call(body) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { await submit({ user: { userId: String(parentId), role: 'parent' }, body: { childId: String(childId), ...body } }, res); }
  finally { Object.assign(console, { log, warn, error }); }
  return res;
}
const answer = (questionId, value = 'yes') => {
  const q = BANK.find((b) => b.questionId === questionId);
  return { questionId, domain: q.domain, questionText: q.text, answer: value };
};
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. Empty submission: refused, nothing created or written.
  seed(40);
  let r = await call({ answers: [] });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.body.code, 'INCOMPLETE_ASSESSMENT');
  assert.deepStrictEqual(r.body.missingQuestionIds.sort(), ['Q01', 'Q05', 'Q06', 'Q07']);
  assert.strictEqual(db.assessments.length + db.answers.length + db.results.length, 0, 'nothing written');
  ok('empty submission: 400 INCOMPLETE_ASSESSMENT, no assessment, answer or result written');

  // 2. A missing domain is refused instead of scoring it 0% with a risk flag.
  seed(40);
  r = await call({ answers: [answer('Q01'), answer('Q05'), answer('Q06')] });
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(r.body.missingQuestionIds, ['Q07']);
  assert.strictEqual(db.results.length, 0, 'no result saved');
  ok('Social Skills unanswered: 400 naming Q07, no 0% result saved');

  // 3. An answer that is not Yes / Sometimes / No does not count.
  seed(40);
  r = await call({ answers: [answer('Q01'), answer('Q05'), answer('Q06'), answer('Q07', 'maybe')] });
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(r.body.missingQuestionIds, ['Q07']);
  ok("an invalid answer value ('maybe') is treated as unanswered");

  // 4. A complete submission is scored, with no 0% domain and no risk flags.
  seed(40);
  r = await call({ answers: ['Q01', 'Q05', 'Q06', 'Q07'].map((id) => answer(id)) });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  const result = db.results[0];
  assert.deepStrictEqual(
    [result.communicationScore, result.socialScore, result.cognitiveScore, result.motorScore], [100, 100, 100, 100]);
  assert.deepStrictEqual(result.riskFlags, []);
  ok('complete 40-month submission: saved, every domain 100%, no risk flags');

  // 5. Age decides what is required: a 50-month-old must also answer Q10.
  seed(50);
  r = await call({ answers: ['Q01', 'Q05', 'Q06', 'Q07'].map((id) => answer(id)) });
  assert.strictEqual(r.statusCode, 400);
  assert.deepStrictEqual(r.body.missingQuestionIds, ['Q10']);
  seed(50);
  r = await call({ answers: ['Q01', 'Q05', 'Q06', 'Q07', 'Q10'].map((id) => answer(id)) });
  assert.strictEqual(r.statusCode, 200);
  ok('a 50-month-old must answer the 48-month question too; then submit succeeds');

  // 6. Answers saved earlier as a draft for this assessment count.
  seed(40);
  const draft = { _id: oid(), childId, status: 'in_progress' };
  db.assessments.push(draft);
  db.answers.push({ _id: oid(), assessmentId: draft._id, questionId: 'Q07', answer: 'sometimes', origin: 'core_bank', domain: 'Social Skills' });
  r = await call({ assessmentId: String(draft._id), answers: ['Q01', 'Q05', 'Q06'].map((id) => answer(id)) });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  ok('a draft-saved answer completes the set');

  // 7. Timezone margin: on the day a question unlocks, it is accepted but not
  //    required (the parent's browser may still count the child a month younger).
  seed(40);
  const turnsToday = new Date();
  turnsToday.setHours(12, 0, 0, 0);
  turnsToday.setMonth(turnsToday.getMonth() - 48);
  db.child.dateOfBirth = turnsToday;
  r = await call({ answers: ['Q01', 'Q05', 'Q06', 'Q07'].map((id) => answer(id)) });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  ok('a child turning 48 months today may submit without the 48-month question');

  console.log('\nAssessment submit completeness tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
