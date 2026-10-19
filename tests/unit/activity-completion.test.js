// Home-activity completion on recommendations (Objective 2): a parent ticks a
// recommended activity as done, can undo it, and sees completed / total / %.
// Exercises routes/recommendations.js PATCH /:recommendationId/activities and
// the additive fields on GET /:assessmentId against an in-memory store.
//
// No DB, no network: bufferCommands is off, so any model call this file does
// not stub fails immediately instead of waiting for a connection. The real
// Mongo behaviour of the conditional $push/$pull is not covered here.
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
const AssessmentResult = require('../../models/AssessmentResult');
const Recommendation = require('../../models/Recommendation');
const User = require('../../models/User');
const recommendationsRouter = require('../../routes/recommendations');

const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const same = (a, b) => String(a) === String(b);
const chain = (get) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(get()),
    then: (a, b) => Promise.resolve(get()).then(a, b) };
  return o;
};

// ── In-memory store ───────────────────────────────────────────────────────
const db = { children: [], links: [], assessments: [], results: [], recs: [] };

Child.findById = (id) => chain(() => db.children.find((c) => same(c._id, id)) || null);
GuardianLink.findOne = (f) => chain(() => db.links.find((l) =>
  same(l.childId, f.childId) && same(l.guardianId, f.guardianId) && l.status === f.status) || null);
Appointment.exists = async () => null;
Appointment.countDocuments = async () => 0;
User.find = () => chain(() => []);
Assessment.findById = (id) => chain(() => db.assessments.find((a) => same(a._id, id)) || null);
AssessmentResult.findOne = (f) => chain(() => db.results.find((r) => same(r.assessmentId, f.assessmentId)) || null);

Recommendation.findById = (id) => chain(() => db.recs.find((r) => same(r._id, id)) || null);
Recommendation.find = (f) => chain(() => db.recs.filter((r) => same(r.assessmentResultId, f.assessmentResultId)));
Recommendation.insertMany = async (rows) => { db.recs.push(...rows.map((r) => ({ _id: oid(), completedActivities: [], ...r }))); };
// Mirrors the two update shapes the route sends, including the $ne guard.
let updateCalls = 0;
Recommendation.updateOne = async (filter, update) => {
  updateCalls += 1;
  const rec = db.recs.find((r) => same(r._id, filter._id));
  if (!rec) return { matchedCount: 0, modifiedCount: 0 };
  rec.completedActivities = rec.completedActivities || [];
  const notIn = filter['completedActivities.activity'] && filter['completedActivities.activity'].$ne;
  if (notIn !== undefined && rec.completedActivities.some((c) => c.activity === notIn)) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  if (update.$push) rec.completedActivities.push(clone(update.$push.completedActivities));
  if (update.$pull) {
    const before = rec.completedActivities.length;
    rec.completedActivities = rec.completedActivities.filter((c) => c.activity !== update.$pull.completedActivities.activity);
    return { matchedCount: 1, modifiedCount: before - rec.completedActivities.length };
  }
  return { matchedCount: 1, modifiedCount: 1 };
};

async function call(method, routePath, user, { params = {}, body = {} } = {}) {
  const layer = recommendationsRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `${method} ${routePath} exists`);
  const res = {
    statusCode: 200, body: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const req = { params, body, query: {}, user };
  try {
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
const blockedGuardian = person('legal_guardian');
const pediatrician = person('pediatrician');
const admin = person('admin');

// One child with a completed screening whose four recommendations are generated
// by the real GET handler (buildRecommendationSet), so the activity strings are
// exactly the ones parents see.
async function childWithPlan(owner, scores) {
  const child = { _id: oid(), parentId: owner.userId, firstName: 'Kid', lastName: 'Test' };
  db.children.push(child);
  const assessment = { _id: oid(), childId: child._id, status: 'complete' };
  db.assessments.push(assessment);
  db.results.push({ _id: oid(), assessmentId: assessment._id, childId: child._id, ...scores });
  const res = await call('get', '/:assessmentId', owner, { params: { assessmentId: String(assessment._id) } });
  assert.strictEqual(res.statusCode, 200, `GET plan: ${JSON.stringify(res.body)}`);
  return { child, assessmentId: String(assessment._id), plan: res.body };
}

const mark = (user, rec, activity, completed) =>
  call('patch', '/:recommendationId/activities', user, { params: { recommendationId: rec.id }, body: { activity, completed } });

async function run() {
  const scores = { communicationScore: 30, socialScore: 65, cognitiveScore: 85, motorScore: 50, overallScore: 58 };
  const a = await childWithPlan(parent, scores);
  const b = await childWithPlan(parent, scores); // sibling: same parent, separate plan

  // GET keeps every existing field and adds the progress fields.
  for (const key of ['success', 'consultationNeeded', 'suggestedPediatricians', 'recommendations', 'developmentalBand', 'overallCarePlan', 'prediction']) {
    assert.ok(key in a.plan, `GET still returns ${key}`);
  }
  assert.strictEqual(a.plan.recommendations.length, 4);
  assert.deepStrictEqual(a.plan.activityProgress, { completed: 0, total: 12, percentage: 0 });
  assert.ok(a.plan.recommendations.every((r) => Array.isArray(r.completedActivities) && r.completedActivities.length === 0));

  const comm = a.plan.recommendations.find((r) => r.skill === 'communication');
  const motor = a.plan.recommendations.find((r) => r.skill === 'motor');

  // Mark, then mark again: one record, not two.
  let res = await mark(parent, comm, comm.activities[0], true);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.completedActivities, [comm.activities[0]]);
  assert.deepStrictEqual(res.body.activityProgress, { completed: 1, total: 12, percentage: 8 });
  res = await mark(parent, comm, comm.activities[0], true);
  assert.strictEqual(res.statusCode, 200);
  const stored = db.recs.find((r) => same(r._id, comm.id));
  assert.strictEqual(stored.completedActivities.length, 1, 'repeat mark does not duplicate');
  assert.ok(same(stored.completedActivities[0].completedBy, parent.userId), 'records who completed it');
  assert.ok(stored.completedActivities[0].completedAt, 'records when');

  // Counts come from the stored records across the whole plan.
  await mark(parent, comm, comm.activities[1], true);
  await mark(parent, motor, motor.activities[2], true);
  res = await call('get', '/:assessmentId', parent, { params: { assessmentId: a.assessmentId } });
  assert.deepStrictEqual(res.body.activityProgress, { completed: 3, total: 12, percentage: 25 });
  assert.deepStrictEqual(res.body.recommendations.find((r) => r.skill === 'motor').completedActivities, [motor.activities[2]]);

  // Undo, and undo again (no error, no negative count).
  res = await mark(parent, comm, comm.activities[0], false);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.completedActivities, [comm.activities[1]]);
  assert.deepStrictEqual(res.body.activityProgress, { completed: 2, total: 12, percentage: 17 });
  res = await mark(parent, comm, comm.activities[0], false);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.activityProgress.completed, 2);

  // The sibling's plan is untouched.
  res = await call('get', '/:assessmentId', parent, { params: { assessmentId: b.assessmentId } });
  assert.deepStrictEqual(res.body.activityProgress, { completed: 0, total: 12, percentage: 0 });

  // A stray stored entry that is not one of the activities never counts.
  stored.completedActivities.push({ activity: 'Not a real activity' });
  res = await call('get', '/:assessmentId', parent, { params: { assessmentId: a.assessmentId } });
  assert.strictEqual(res.body.activityProgress.completed, 2);
  stored.completedActivities.pop();

  // Validation.
  res = await mark(parent, comm, 'Not a real activity', true);
  assert.strictEqual(res.statusCode, 400, 'unknown activity');
  res = await mark(parent, comm, comm.activities[2], 'yes');
  assert.strictEqual(res.statusCode, 400, 'completed must be boolean');
  res = await call('patch', '/:recommendationId/activities', parent, { params: { recommendationId: 'nope' }, body: { activity: 'x', completed: true } });
  assert.strictEqual(res.statusCode, 400, 'invalid id');
  res = await call('patch', '/:recommendationId/activities', parent, { params: { recommendationId: String(oid()) }, body: { activity: 'x', completed: true } });
  assert.strictEqual(res.statusCode, 404, 'missing recommendation');

  // Authorization: only the owner or a guardian granted viewRecommendations.
  const callsBefore = updateCalls;
  for (const [who, label] of [[otherParent, 'another parent'], [pediatrician, 'pediatrician'], [admin, 'admin'], [blockedGuardian, 'guardian without permission']]) {
    res = await mark(who, comm, comm.activities[2], true);
    assert.strictEqual(res.statusCode, 403, `${label} is refused`);
  }
  db.links.push({ childId: a.child._id, guardianId: blockedGuardian.userId, status: 'active', permissions: { viewRecommendations: false } });
  res = await mark(blockedGuardian, comm, comm.activities[2], true);
  assert.strictEqual(res.statusCode, 403, 'guardian with viewRecommendations=false is refused');
  // An unauthorized caller cannot probe activity names either: 403 before 400.
  res = await mark(otherParent, comm, 'Not a real activity', true);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(updateCalls, callsBefore, 'refused requests never write');

  db.links.push({ childId: a.child._id, guardianId: guardian.userId, status: 'active', permissions: { viewRecommendations: true } });
  res = await mark(guardian, comm, comm.activities[2], true);
  assert.strictEqual(res.statusCode, 200, 'guardian with viewRecommendations may mark');
  assert.strictEqual(res.body.activityProgress.completed, 3);
  // The guardian's link is for child A only.
  const bComm = b.plan.recommendations.find((r) => r.skill === 'communication');
  res = await mark(guardian, bComm, bComm.activities[0], true);
  assert.strictEqual(res.statusCode, 403, 'guardian cannot mark another child');

  // Helper edge case: no activities at all.
  assert.deepStrictEqual(recommendationsRouter.__testables.buildActivityProgress([]), { completed: 0, total: 0, percentage: 0 });

  console.log('Activity completion tests OK — mark/undo, no duplicates, counts from records, per-child separation, authorization');
}

run().catch((err) => { console.error(err); process.exit(1); });
