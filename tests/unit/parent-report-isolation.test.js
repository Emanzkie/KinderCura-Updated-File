// GET /api/parent/children/:childId/report returns one child's records only.
// The parent Progress Report page prints and downloads (PDF) exactly what this
// route returns, so a sibling's assessments must never appear in it, and only
// people allowed to see the child may read it.
//
// No DB, no network: bufferCommands is off and every model call the route
// makes is stubbed over an in-memory store.
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
const User = require('../../models/User');
const PediaCustomQuestionAssignment = require('../../models/PediaCustomQuestionAssignment');
const router = require('../../routes/parent-reports');

const results = [];
const ok = (label) => results.push(label);
const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const same = (a, b) => String(a) === String(b);
const chain = (get) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(get()) };
  return o;
};
const inIds = (cond, id) => (cond && cond.$in ? cond.$in.some((x) => same(x, id)) : same(cond, id));

// ── In-memory store ───────────────────────────────────────────────────────
const parentId = oid();
const otherParentId = oid();
const guardianId = oid();
const childA = { _id: oid(), parentId, firstName: 'Ana', lastName: 'Cruz', dateOfBirth: '2021-03-10', gender: 'female' };
const childB = { _id: oid(), parentId, firstName: 'Ben', lastName: 'Cruz', dateOfBirth: '2022-06-01', gender: 'male' };

const assessment = (child, completedAt) => ({ _id: oid(), childId: child._id, status: 'complete', completedAt, startedAt: completedAt });
const result = (a, overall) => ({
  _id: oid(), assessmentId: a._id, overallScore: overall,
  communicationScore: overall, socialScore: overall, cognitiveScore: overall, motorScore: overall,
});

const a1 = assessment(childA, '2026-05-01T02:00:00Z');
const a2 = assessment(childA, '2026-08-01T02:00:00Z');
const b1 = assessment(childB, '2026-07-15T02:00:00Z');
const draftA = { ...assessment(childA, null), status: 'in_progress' };

const db = {
  children: [childA, childB],
  assessments: [a1, a2, b1, draftA],
  results: [result(a1, 55), result(a2, 70), result(b1, 90)],
  links: [{ childId: childA._id, guardianId, status: 'active', permissions: { viewAssessments: false } }],
};

const calls = { assessmentFind: [], resultFind: [] };

Child.findById = (id) => chain(() => db.children.find((c) => same(c._id, id)) || null);
GuardianLink.findOne = (f) => chain(() => db.links.find((l) =>
  same(l.childId, f.childId) && same(l.guardianId, f.guardianId) && l.status === f.status) || null);
Appointment.exists = async () => null;
Assessment.find = (f) => {
  calls.assessmentFind.push(f);
  return chain(() => db.assessments.filter((a) => same(a.childId, f.childId) && a.status === f.status));
};
AssessmentResult.find = (f) => {
  calls.resultFind.push(f);
  return chain(() => db.results.filter((r) => inIds(f.assessmentId, r.assessmentId)));
};
AssessmentAnswer.aggregate = async () => [];
User.find = () => chain(() => []);
PediaCustomQuestionAssignment.find = () => chain(() => []);

// ── Fake req/res (authMiddleware skipped: req.user stands in for the token) ─
async function getReport(childId, user) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/children/:childId/report');
  assert(layer, 'GET /children/:childId/report exists');
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const req = { params: { childId: String(childId) }, user };
  for (const { handle } of layer.route.stack) {
    if (handle.name === 'authMiddleware') continue;
    let nextCalled = false;
    await handle(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

const parent = { userId: String(parentId), role: 'parent' };
const otherParent = { userId: String(otherParentId), role: 'parent' };
const guardian = { userId: String(guardianId), role: 'legal_guardian' };

(async () => {
  // 1. Child A's report holds only child A's completed assessments.
  calls.assessmentFind.length = 0; calls.resultFind.length = 0;
  const resA = await getReport(childA._id, parent);
  assert.strictEqual(resA.statusCode, 200);
  assert.strictEqual(resA.body.child.id, String(childA._id));
  assert.deepStrictEqual(resA.body.assessments.map((a) => a.id), [String(a1._id), String(a2._id)]);
  assert.deepStrictEqual(resA.body.assessments.map((a) => a.overallScore), [55, 70]);
  assert(!resA.body.assessments.some((a) => a.id === String(b1._id)), 'sibling B assessment never in A report');
  assert(!resA.body.assessments.some((a) => a.id === String(draftA._id)), 'in-progress draft not in report');
  ok('child A report contains only A completed assessments');

  // The queries themselves are scoped to child A.
  assert.strictEqual(calls.assessmentFind.length, 1);
  assert(same(calls.assessmentFind[0].childId, childA._id));
  const queriedIds = calls.resultFind[0].assessmentId.$in.map(String);
  assert.deepStrictEqual(queriedIds.sort(), [String(a1._id), String(a2._id)].sort());
  ok('assessment and result queries filtered by child A id and A assessment ids');

  // 2. Switching to sibling B gives B's records only.
  const resB = await getReport(childB._id, parent);
  assert.strictEqual(resB.statusCode, 200);
  assert.strictEqual(resB.body.child.id, String(childB._id));
  assert.deepStrictEqual(resB.body.assessments.map((a) => a.id), [String(b1._id)]);
  assert.deepStrictEqual(resB.body.assessments.map((a) => a.overallScore), [90]);
  assert.strictEqual(resB.body.trendAvailable, false);
  ok('child B report contains only B records');

  // 3. People without access are refused.
  assert.strictEqual((await getReport(childA._id, otherParent)).statusCode, 403);
  ok('another parent gets 403');
  assert.strictEqual((await getReport(childA._id, guardian)).statusCode, 403);
  ok('guardian without viewAssessments gets 403');
  db.links[0].permissions.viewAssessments = true;
  const resG = await getReport(childA._id, guardian);
  assert.strictEqual(resG.statusCode, 200);
  assert.deepStrictEqual(resG.body.assessments.map((a) => a.id), [String(a1._id), String(a2._id)]);
  ok('guardian with viewAssessments gets child A records only');
  assert.strictEqual((await getReport(childB._id, guardian)).statusCode, 403);
  ok('guardian linked to A cannot read sibling B');

  // 4. Bad ids.
  assert.strictEqual((await getReport('not-an-id', parent)).statusCode, 404);
  assert.strictEqual((await getReport(oid(), parent)).statusCode, 404);
  ok('malformed and unknown child ids get 404');

  results.forEach((r) => console.log('ok -', r));
  console.log(`\nparent-report-isolation: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
