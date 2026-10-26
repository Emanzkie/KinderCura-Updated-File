// A pediatrician's access to a child depends on the booking status
// (PEDIATRICIAN_BUGS.md #9).
//
// Routes decided "is this my patient?" with Appointment.exists({ childId,
// pediatricianId }), which matched cancelled and rejected bookings too. After a
// parent cancelled, or the doctor declined, the doctor kept reading the child's
// scores, answers and parent e-mail and could still write diagnoses and
// check-ups. Only pending, approved and completed bookings count now
// (services/patientAccess.js); pending stays in because the dashboard shows a
// child's scores on a request that has not been answered yet.
//
// No DB: Appointment is replaced by an in-memory store that understands the
// { status: { $in: [...] } } filter, and the real route handlers are called
// from the router stacks.
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
const GuardianLink = require('../../models/GuardianLink');
const PediatricianCheckup = require('../../models/PediatricianCheckup');
const SpecialistReferral = require('../../models/SpecialistReferral');
const { pediatricianHasPatient, ACCESS_APPOINTMENT_STATUSES } = require('../../services/patientAccess');
const { canViewChild } = require('../../middleware/guardianAccess');
const assessmentsRouter = require('../../routes/assessments');
const checkupsRouter = require('../../routes/checkups');
const pediaReportsRouter = require('../../routes/pedia-reports');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const pediaId = oid();
const parentId = oid();
const childId = oid();
const otherChildId = oid();

const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};

// In-memory appointments honouring equality and { $in } filters.
let appointments = [];
let findFilters = [];
const same = (a, b) => String(a) === String(b);
const matches = (row, filter) => Object.entries(filter).every(([k, v]) => (
  v && Array.isArray(v.$in) ? v.$in.some((x) => same(row[k], x)) : same(row[k], v)
));
Appointment.exists = async (f) => (appointments.some((a) => matches(a, f)) ? { _id: 1 } : null);
Appointment.findOne = (f) => chain(appointments.find((a) => matches(a, f)) || null);
Appointment.find = (f) => { findFilters.push(f); return chain(appointments.filter((a) => matches(a, f))); };

const child = { _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: new Date('2021-01-01'), gender: 'male' };
Child.findById = (id) => chain(same(id, childId) ? child : null);
User.findById = () => chain({ _id: parentId, firstName: 'Emman', lastName: 'D', email: 'parent@example.invalid' });
Assessment.findOne = () => chain({
  _id: oid(), childId, status: 'complete', diagnosis: 'Speech delay', completedAt: new Date(), startedAt: new Date(),
});
AssessmentResult.findOne = () => chain({
  communicationScore: 40, socialScore: 50, cognitiveScore: 60, motorScore: 70, overallScore: 55, generatedAt: new Date(),
});
GuardianLink.findOne = () => chain(null);
PediatricianCheckup.find = () => chain([]);
SpecialistReferral.find = () => chain([]);

function setAppointments(...statuses) {
  appointments = statuses.map((status, i) => ({ _id: oid(), id: i + 1, childId, parentId, pediatricianId: pediaId, status }));
}

const handlerFor = (router, method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${route}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = (handler, { params = {}, body = {}, query = {} } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    setHeader() {},
  };
  const user = { userId: String(pediaId), role: 'pediatrician' };
  Promise.resolve(handler({ user, params, body, query }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  // ── The shared rule ─────────────────────────────────────────────────────
  assert.deepStrictEqual([...ACCESS_APPOINTMENT_STATUSES].sort(), ['approved', 'completed', 'pending']);
  for (const [status, expected] of [['pending', true], ['approved', true], ['completed', true], ['cancelled', false], ['rejected', false]]) {
    setAppointments(status);
    assert.strictEqual(await pediatricianHasPatient(pediaId, childId), expected, status);
  }
  setAppointments('cancelled', 'rejected', 'approved');
  assert.strictEqual(await pediatricianHasPatient(pediaId, childId), true, 'one live booking is enough');
  assert.strictEqual(await pediatricianHasPatient(oid(), childId), false, 'another pediatrician has no access');
  ok('pending, approved and completed bookings link a pediatrician to a child; cancelled and rejected do not');

  setAppointments('cancelled');
  assert.strictEqual(await canViewChild({ userId: String(pediaId), role: 'pediatrician' }, child, 'viewAssessments'), false);
  setAppointments('approved');
  assert.strictEqual(await canViewChild({ userId: String(pediaId), role: 'pediatrician' }, child, 'viewAssessments'), true);
  ok('canViewChild follows the same rule');

  // ── Record routes ───────────────────────────────────────────────────────
  const reviewAnswers = handlerFor(assessmentsRouter, 'get', '/:childId/review-answers');
  const diagnose = handlerFor(assessmentsRouter, 'post', '/diagnose/:childId');
  const checkupList = handlerFor(checkupsRouter, 'get', '/child/:childId');
  const progressNotes = handlerFor(assessmentsRouter, 'get', '/child/:childId/progress-notes');

  const probes = [
    ['review-answers', () => call(reviewAnswers, { params: { childId: String(childId) } })],
    ['diagnose', () => call(diagnose, { params: { childId: String(childId) }, body: { diagnosis: 'Test diagnosis' } })],
    ['check-up history', () => call(checkupList, { params: { childId: String(childId) } })],
    ['progress notes', () => call(progressNotes, { params: { childId: String(childId) } })],
  ];
  for (const [label, probe] of probes) {
    for (const status of ['cancelled', 'rejected']) {
      setAppointments(status);
      const r = await quiet(probe);
      assert.strictEqual(r.status, 403, `${label}: a ${status} booking must not open the record (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    for (const status of ['pending', 'approved', 'completed']) {
      setAppointments(status);
      const r = await quiet(probe);
      assert.notStrictEqual(r.status, 403, `${label}: a ${status} booking must still open the record`);
    }
  }
  ok('review-answers, diagnose, check-ups and progress notes refuse cancelled/rejected bookings and still serve pending/approved/completed');

  // ── My Patients list ────────────────────────────────────────────────────
  const pediaPatients = handlerFor(assessmentsRouter, 'get', '/pedia-patients');
  setAppointments('approved');
  let r = await quiet(() => call(pediaPatients));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.patients.length, 1);
  assert.strictEqual(r.body.patients[0].parentEmail, 'parent@example.invalid');
  assert.strictEqual(r.body.patients[0].overallScore, 55);
  assert.strictEqual(r.body.patients[0].diagnosis, 'Speech delay');
  assert(r.body.patients[0].assessmentId, 'a live booking returns the full record');

  for (const status of ['rejected', 'cancelled']) {
    setAppointments(status);
    r = await quiet(() => call(pediaPatients));
    assert.strictEqual(r.body.patients.length, 1, `a ${status} booking is still listed`);
    const p = r.body.patients[0];
    assert.strictEqual(p.appointmentStatus, status);
    assert.strictEqual(p.childFirstName, 'Kemri');
    assert.strictEqual(p.parentEmail, '', `${status}: parent e-mail withheld`);
    assert.strictEqual(p.overallScore, null, `${status}: scores withheld`);
    assert.deepStrictEqual(p.scores, {});
    assert.strictEqual(p.diagnosis, null, `${status}: diagnosis withheld`);
    assert.strictEqual(p.assessmentId, null);
    assert.strictEqual(p.mlLabel, null);
  }
  setAppointments('rejected', 'approved');
  r = await quiet(() => call(pediaPatients));
  assert.strictEqual(r.body.patients[0].parentEmail, 'parent@example.invalid', 'a live booking elsewhere keeps the record open');
  ok('My Patients still lists declined/cancelled bookings, but only live ones carry scores, diagnosis and parent e-mail');

  // ── Lists that define who the "patients" are ────────────────────────────
  const assignList = handlerFor(assessmentsRouter, 'get', '/patients');
  findFilters = [];
  setAppointments('approved');
  await quiet(() => call(assignList));
  assert.deepStrictEqual(findFilters[0].status, { $in: ACCESS_APPOINTMENT_STATUSES }, 'the assign list only reads live bookings');
  findFilters = [];
  await quiet(() => call(handlerFor(pediaReportsRouter, 'get', '/overview'), { query: {} }));
  assert(findFilters.some((f) => f.status && Array.isArray(f.status.$in) && f.status.$in.length === 3),
    'the reports scope only reads live bookings');
  ok('the assign list and the reports scope only include children with a live booking');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npediatrician-patient-access.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
