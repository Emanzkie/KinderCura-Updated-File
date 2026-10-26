// The Assign Questions patient list uses completed assessments
// (PEDIATRICIAN_BUGS.md #14).
//
// GET /assessments/patients feeds the assign modal and its category/threshold
// filters. It took the child's latest STARTED assessment, so a newer unfinished
// reassessment (which has no result yet) dropped the child from the list and
// from every filter match; and it computed each domain status as
// getStatus(score || 0), so a missing domain score was labelled "delayed".
//
// No DB: models are stubbed in memory and the real route handler is called
// from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const Child = require('../../models/Child');
const User = require('../../models/User');
const assessmentsRouter = require('../../routes/assessments');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const pediaId = oid();
const parentId = oid();
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};

// Child 1: a completed screening plus a NEWER unfinished reassessment, and no motor score.
// Child 2: only an unfinished first screening (nothing to filter on yet).
const kid1 = oid();
const kid2 = oid();
const done1 = { _id: oid(), childId: kid1, status: 'complete', completedAt: new Date('2030-01-02'), startedAt: new Date('2030-01-01') };
const open1 = { _id: oid(), childId: kid1, status: 'in_progress', startedAt: new Date('2030-03-01') };
const open2 = { _id: oid(), childId: kid2, status: 'in_progress', startedAt: new Date('2030-03-01') };
const assessments = [done1, open1, open2];
const resultFor = {
  [String(done1._id)]: {
    assessmentId: done1._id, communicationScore: 45, socialScore: 85, cognitiveScore: 65, motorScore: null,
    overallScore: 65, generatedAt: new Date('2030-01-02'),
  },
};

Appointment.find = () => chain([
  { _id: oid(), id: 1, childId: kid1, parentId, pediatricianId: pediaId, status: 'approved', appointmentDate: new Date() },
  { _id: oid(), id: 2, childId: kid2, parentId, pediatricianId: pediaId, status: 'approved', appointmentDate: new Date() },
]);
Child.findById = (id) => chain({ _id: id, firstName: same(id, kid1) ? 'Kemri' : 'Isla', lastName: 'Soto', dateOfBirth: new Date('2021-01-01'), gender: 'male' });
User.findById = () => chain({ _id: parentId, firstName: 'Emman', lastName: 'D' });
// Newest started first, unless the query asks for completed ones.
Assessment.findOne = (f) => {
  const mine = assessments
    .filter((a) => same(a.childId, f.childId) && (!f.status || a.status === f.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  return chain(mine[0] || null);
};
AssessmentResult.findOne = (f) => chain(resultFor[String(f.assessmentId)] || null);

const layer = assessmentsRouter.stack.find((l) => l.route && l.route.path === '/patients' && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;
const list = (query = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
  Promise.resolve(handler({ user: { userId: String(pediaId), role: 'pediatrician' }, query, params: {}, body: {} }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  let r = await quiet(() => list());
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.patients.map((p) => p.childId);
  assert(ids.includes(String(kid1)), 'a child with a newer unfinished reassessment is still listed');
  assert(!ids.includes(String(kid2)), 'a child with no completed assessment has nothing to list or filter on');
  const p = r.body.patients.find((x) => x.childId === String(kid1));
  assert.strictEqual(p.communicationScore, 45, 'scores come from the completed assessment');
  assert.strictEqual(p.overallScore, 65);
  assert(new Date(p.lastAssessmentDate).getTime() === new Date('2030-01-02').getTime());
  ok('a child with a newer in-progress reassessment is listed with the scores of the completed one');

  r = await quiet(() => list({ category: 'communication', threshold: 'at-risk' }));
  assert.deepStrictEqual(r.body.patients.map((x) => x.childId), [String(kid1)], 'the filter matches on the completed scores');
  r = await quiet(() => list({ category: 'social', threshold: 'on-track' }));
  assert.deepStrictEqual(r.body.patients.map((x) => x.childId), [String(kid1)]);
  r = await quiet(() => list({ category: 'communication', threshold: 'on-track' }));
  assert.deepStrictEqual(r.body.patients, [], 'and still excludes non-matches');
  ok('category and threshold filters match against the completed assessment');

  r = await quiet(() => list());
  const q = r.body.patients.find((x) => x.childId === String(kid1));
  assert.strictEqual(q.motorScore, null);
  assert.strictEqual(q.motorStatus, null, 'a missing domain score has no status (it used to read as 0 -> delayed)');
  assert.strictEqual(q.communicationStatus, 'at-risk');
  assert.strictEqual(q.socialStatus, 'on-track');
  assert.strictEqual(q.cognitiveStatus, 'developing');
  ok('a domain with no score has no status instead of "delayed"; the others keep theirs');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nassign-patients-list.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
