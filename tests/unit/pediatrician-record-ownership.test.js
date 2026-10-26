// One pediatrician's work is not another's (PEDIATRICIAN_BUGS.md #10).
//
// A child can have bookings with more than one pediatrician (a second opinion,
// a change of clinic), yet an Assessment holds ONE set of diagnosis fields, so:
//   - the My Patients card showed another pediatrician's diagnosis as "Your
//     Diagnosis", and the history / results / review-answers reads returned it;
//   - POST /diagnose silently overwrote it, outcome label included;
//   - GET /questions/assigned/:childId returned every pediatrician's assigned
//     questions and the parent's answers to them;
//   - a new check-up could thread to another pediatrician's record.
//
// No DB: models are stubbed in memory and the real route handlers are called
// from their router stacks.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const AssessmentResult = require('../../models/AssessmentResult');
const AuditLog = require('../../models/AuditLog');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Notification = require('../../models/Notification');
const PediaCustomQuestion = require('../../models/PediaCustomQuestion');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const PediatricianCheckup = require('../../models/PediatricianCheckup');
const User = require('../../models/User');
const assessmentsRouter = require('../../routes/assessments');
const checkupsRouter = require('../../routes/checkups');
const questionsRouter = require('../../routes/custom-questions');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const pediaA = oid();
const pediaB = oid();
const parentId = oid();
const childId = oid();
const same = (a, b) => String(a) === String(b);

const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};

const child = { _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: new Date('2021-01-01'), gender: 'male' };
let assessment;
let auditEntries;
let saves;

// Pediatrician B reviewed this assessment: a diagnosis, an outcome label and an ML label.
function freshAssessment(fields = {}) {
  saves = 0;
  auditEntries = [];
  assessment = {
    _id: oid(), childId, status: 'complete', startedAt: new Date(), completedAt: new Date(),
    diagnosis: "B's diagnosis of speech delay", recommendations: "B's plan", nextAssessmentDate: new Date('2030-02-01'),
    nextAssessmentReason: 'B follow-up', reviewedByPediatrician: pediaB, reviewedAt: new Date('2030-01-01'),
    clinicalOutcome: 'developmental_delay', clinicalOutcomeDomains: ['Communication'], clinicalOutcomeBy: pediaB,
    clinicalOutcomeAt: new Date('2030-01-01'),
    mlLabel: { riskCategory: 'High', reviewedBy: pediaB, reviewedAt: new Date(), notes: 'B note' }, mlReviewStatus: 'reviewed',
    ...fields,
  };
  assessment.save = async function save() { saves += 1; };
  return assessment;
}

Appointment.exists = async (f) => (same(f.pediatricianId, pediaA) || same(f.pediatricianId, pediaB) ? { _id: 1 } : null);
Appointment.findOne = (f) => chain(same(f.pediatricianId, pediaA) || same(f.pediatricianId, pediaB)
  ? { _id: oid(), id: 1, childId, pediatricianId: f.pediatricianId, status: 'approved' } : null);
Appointment.find = (f) => chain(same(f.pediatricianId, pediaA) || same(f.pediatricianId, pediaB)
  ? [{ _id: oid(), id: 1, childId, parentId, pediatricianId: f.pediatricianId, status: 'approved', appointmentDate: new Date(), paymentStatus: 'Paid' }] : []);
Child.findById = () => chain(child);
User.findById = () => chain({ _id: parentId, firstName: 'Emman', lastName: 'D', email: 'parent@example.invalid' });
GuardianLink.findOne = () => chain(null);
Assessment.findOne = () => chain(assessment);
Assessment.find = () => chain([assessment]);
Assessment.findById = () => chain(assessment);
AssessmentResult.findOne = () => chain({
  _id: oid(), assessmentId: assessment && assessment._id, childId, communicationScore: 40, socialScore: 50, cognitiveScore: 60,
  motorScore: 70, overallScore: 55, generatedAt: new Date(),
});
AssessmentResult.find = () => chain([]);
AssessmentAnswer.find = () => chain([]);
AuditLog.create = async (e) => { auditEntries.push(e); return e; };
Notification.create = async (n) => n;

const handlerFor = (router, method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${route}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = (handler, user, { params = {}, body = {}, query = {} } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    setHeader() {},
  };
  Promise.resolve(handler({ user, params, body, query }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const asPedia = (id) => ({ userId: String(id), role: 'pediatrician' });
const asParent = { userId: String(parentId), role: 'parent' };

(async () => {
  const pediaPatients = handlerFor(assessmentsRouter, 'get', '/pedia-patients');
  const history = handlerFor(assessmentsRouter, 'get', '/:childId/history');
  const results_ = handlerFor(assessmentsRouter, 'get', '/:assessmentId/results');
  const reviewAnswers = handlerFor(assessmentsRouter, 'get', '/:childId/review-answers');
  const diagnose = handlerFor(assessmentsRouter, 'post', '/diagnose/:childId');

  // ── Another pediatrician's diagnosis is not shown ───────────────────────
  freshAssessment();
  let r = await quiet(() => call(pediaPatients, asPedia(pediaA)));
  let p = r.body.patients[0];
  assert.strictEqual(p.diagnosis, null);
  assert.strictEqual(p.recommendations, null);
  assert.strictEqual(p.nextAssessmentReason, null);
  assert.strictEqual(p.clinicalOutcome, null);
  assert.deepStrictEqual(p.clinicalOutcomeDomains, []);
  assert.strictEqual(p.mlLabel, null);
  assert.strictEqual(p.mlReviewStatus, 'unreviewed');
  assert.strictEqual(p.overallScore, 55, 'the scores themselves stay visible to a linked pediatrician');

  r = await quiet(() => call(pediaPatients, asPedia(pediaB)));
  p = r.body.patients[0];
  assert.strictEqual(p.diagnosis, "B's diagnosis of speech delay");
  assert.strictEqual(p.clinicalOutcome, 'developmental_delay');
  assert.strictEqual(p.mlLabel.riskCategory, 'High');
  ok('My Patients hides another pediatrician\'s diagnosis, outcome and ML label; the author still sees them');

  r = await quiet(() => call(history, asPedia(pediaA), { params: { childId: String(childId) } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.assessments[0].diagnosis, null);
  assert.strictEqual(r.body.assessments[0].recommendations, null);
  r = await quiet(() => call(history, asPedia(pediaB), { params: { childId: String(childId) } }));
  assert.strictEqual(r.body.assessments[0].diagnosis, "B's diagnosis of speech delay");
  r = await quiet(() => call(history, asParent, { params: { childId: String(childId) } }));
  assert.strictEqual(r.body.assessments[0].diagnosis, "B's diagnosis of speech delay", 'the parent still sees the diagnosis');
  ok('assessment history hides it from the other pediatrician and keeps it for the author and the parent');

  r = await quiet(() => call(results_, asPedia(pediaA), { params: { assessmentId: String(assessment._id) } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.results.diagnosis, null);
  assert.strictEqual(r.body.results.reviewedByPediatrician, null, 'the other doctor is not identified either');
  r = await quiet(() => call(results_, asParent, { params: { assessmentId: String(assessment._id) } }));
  assert.strictEqual(r.body.results.diagnosis, "B's diagnosis of speech delay");
  r = await quiet(() => call(reviewAnswers, asPedia(pediaA), { params: { childId: String(childId) } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.assessment.diagnosis, null);
  r = await quiet(() => call(reviewAnswers, asPedia(pediaB), { params: { childId: String(childId) } }));
  assert.strictEqual(r.body.assessment.diagnosis, "B's diagnosis of speech delay");
  ok('the results and review-answers reads follow the same rule');

  freshAssessment({ reviewedByPediatrician: null, mlLabel: null, mlReviewStatus: 'unreviewed' });
  r = await quiet(() => call(pediaPatients, asPedia(pediaA)));
  assert.strictEqual(r.body.patients[0].diagnosis, "B's diagnosis of speech delay", 'a record with no reviewer on file stays visible');
  ok('older records with no reviewer on file are not hidden');

  // ── Replacing another pediatrician's review keeps it ────────────────────
  const dx = { diagnosis: "A's independent assessment: typical for age", recommendations: "A's plan" };
  freshAssessment();
  r = await quiet(() => call(diagnose, asPedia(pediaA), { params: { childId: String(childId) }, body: dx }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(assessment.diagnosis, dx.diagnosis);
  assert(same(assessment.reviewedByPediatrician, pediaA));
  assert.strictEqual(assessment.clinicalOutcome, null, "B's outcome label does not stay attached to A's diagnosis");
  assert.deepStrictEqual(assessment.clinicalOutcomeDomains, []);
  assert.strictEqual(assessment.clinicalOutcomeBy, null);
  assert.strictEqual(auditEntries.length, 1, 'the replaced review is recorded');
  const entry = auditEntries[0];
  assert.strictEqual(entry.action, 'diagnosis_replaced');
  assert(same(entry.actorId, pediaA));
  assert.strictEqual(entry.details.replaced.diagnosis, "B's diagnosis of speech delay");
  assert.strictEqual(entry.details.replaced.reviewedBy, String(pediaB));
  assert.strictEqual(entry.details.replaced.clinicalOutcome, 'developmental_delay');
  ok("diagnosing over another pediatrician's review preserves it in the audit log and clears their outcome label");

  freshAssessment();
  r = await quiet(() => call(diagnose, asPedia(pediaA), {
    params: { childId: String(childId) }, body: { ...dx, clinicalOutcome: 'typical_development' },
  }));
  assert.strictEqual(assessment.clinicalOutcome, 'typical_development', 'an outcome supplied with the new review is kept');
  assert.strictEqual(auditEntries.length, 1);

  freshAssessment({ reviewedByPediatrician: pediaA, clinicalOutcomeBy: pediaA });
  r = await quiet(() => call(diagnose, asPedia(pediaA), { params: { childId: String(childId) }, body: dx }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(auditEntries.length, 0, 'editing your own review needs no replacement record');
  assert.strictEqual(assessment.clinicalOutcome, 'developmental_delay', 'your own outcome label is untouched by an edit');
  ok('your own review can still be edited normally, and a new outcome label supplied with a replacement is kept');

  // ── Assigned custom questions ───────────────────────────────────────────
  const ownQuestionId = oid();
  PediaCustomQuestion.find = (f) => chain(same(f.pediatricianId, pediaA) ? [{ _id: ownQuestionId }] : []);
  let assignmentFilter = null;
  PediaCustomQuestionAssignment.find = (f) => { assignmentFilter = f; return chain([]); };
  const assigned = handlerFor(questionsRouter, 'get', '/assigned/:childId');

  r = await quiet(() => call(assigned, asPedia(pediaA), { params: { childId: String(childId) } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(assignmentFilter.questionId.$in.map(String), [String(ownQuestionId)],
    "only the pediatrician's own questions are read");
  r = await quiet(() => call(assigned, asParent, { params: { childId: String(childId) } }));
  assert.strictEqual(assignmentFilter.questionId, undefined, "the parent still sees every question assigned to their child");
  ok('a pediatrician reads only their own assigned questions and answers; the parent still sees all');

  // ── Check-up threading ──────────────────────────────────────────────────
  const { resolvePreviousRecordRef } = checkupsRouter.__testables;
  const filters = [];
  PediatricianCheckup.findOne = (f) => { filters.push(f); return chain(same(f.pediatricianId, pediaA) ? { _id: oid(), pediatricianId: pediaA } : null); };
  const mine = await resolvePreviousRecordRef(undefined, child, pediaA);
  assert(mine, "A's own latest record is found");
  assert(same(filters[0].pediatricianId, pediaA) && same(filters[0].childId, childId));
  assert.strictEqual(await resolvePreviousRecordRef(undefined, child, pediaB), null, "B's first check-up does not thread to A's record");
  await assert.rejects(
    () => resolvePreviousRecordRef(String(oid()), child, pediaB),
    (err) => err.statusCode === 400 && /not one of your check-ups/.test(err.message),
    "an explicit previousRecordId from another pediatrician is refused"
  );
  assert(await resolvePreviousRecordRef(String(oid()), child, pediaA), 'your own record can still be named explicitly');
  ok("a new check-up only threads to the same pediatrician's own records");

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npediatrician-record-ownership.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
