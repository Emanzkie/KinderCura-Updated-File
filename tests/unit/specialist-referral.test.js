// Unit tests for "Refer to a Specialist" (models/SpecialistReferral.js +
// routes/checkups.js referral handlers + the parent history renderer).
//
// The adviser requirement: a pediatrician can record a referral to a
// specialist WITHOUT deleting, replacing, transferring or losing any earlier
// check-up, assessment or appointment. The parent finds the specialist outside
// KinderCura, so nothing is booked or sent.
//
// No live DB: the models are monkey-patched onto one in-memory store (matching
// tests/unit/pediatrician-checkups.test.js), and every write a referral must
// never make (check-up/assessment/appointment updates or deletes, new
// appointments, new user accounts) throws if it is ever called.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

const Child = require('../../models/Child');
const User = require('../../models/User');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const PediatricianCheckup = require('../../models/PediatricianCheckup');
const SpecialistReferral = require('../../models/SpecialistReferral');
const GuardianLink = require('../../models/GuardianLink');
const AuditLog = require('../../models/AuditLog');
const Notification = require('../../models/Notification');
const router = require('../../routes/checkups');

const { createReferralRecord, listReferralsForChild, shapeReferral, HttpError } = router.__testables;

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);
const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Fixture: Pediatrician A followed this child through an initial check-up
// and two follow-ups; another family and another pediatrician exist too. ──
const ids = {
  child: oid(), otherChild: oid(),
  parent: oid(), otherParent: oid(), guardian: oid(),
  pediaA: oid(), pediaB: oid(),
  assessment1: oid(), assessment2: oid(),
};

let db;
function seed() {
  const day = (d) => new Date(`2026-0${d}-15T12:00:00.000Z`);
  db = {
    children: [
      { _id: ids.child, parentId: ids.parent, firstName: 'Kemri', lastName: 'Soto' },
      { _id: ids.otherChild, parentId: ids.otherParent, firstName: 'Other', lastName: 'Kid' },
    ],
    appointments: [
      { id: 101, childId: ids.child, pediatricianId: ids.pediaA, status: 'completed' },
      { id: 102, childId: ids.otherChild, pediatricianId: ids.pediaB, status: 'completed' },
    ],
    assessments: [
      { _id: ids.assessment1, childId: ids.child, status: 'complete', overallScore: 41, completedAt: day(2) },
      { _id: ids.assessment2, childId: ids.child, status: 'complete', overallScore: 43, completedAt: day(6) },
    ],
    checkups: [
      { _id: oid(), childId: ids.child, pediatricianId: ids.pediaA, visitType: 'initial_checkup', checkupDate: day(2), diagnosis: 'Speech delay suspected', status: 'initial_review', assessmentId: ids.assessment1, previousRecordId: null, createdAt: day(2) },
      { _id: oid(), childId: ids.child, pediatricianId: ids.pediaA, visitType: 'follow_up_checkup', checkupDate: day(4), diagnosis: 'Speech delay, monitoring', status: 'monitoring', assessmentId: null, createdAt: day(4) },
      { _id: oid(), childId: ids.child, pediatricianId: ids.pediaA, visitType: 'follow_up_checkup', checkupDate: day(6), diagnosis: 'Not improving sufficiently', status: 'needs_attention', assessmentId: ids.assessment2, createdAt: day(6) },
      { _id: oid(), childId: ids.otherChild, pediatricianId: ids.pediaB, visitType: 'initial_checkup', checkupDate: day(3), diagnosis: 'Other family', status: 'monitoring', createdAt: day(3) },
    ],
    referrals: [],
    guardianLinks: [
      { childId: ids.child, guardianId: ids.guardian, status: 'active', permissions: { viewMedicalRecords: true } },
    ],
    audit: [],
    notifications: [],
  };
  db.checkups[1].previousRecordId = db.checkups[0]._id;
  db.checkups[2].previousRecordId = db.checkups[1]._id;
}

const same = (a, b) => String(a) === String(b);
const query = (rows, filter) => rows.filter((r) => Object.entries(filter).every(([k, v]) => same(r[k], v)));
const chain = (value) => {
  const o = { sort: () => o, populate: () => o, select: () => o, lean: async () => clone(value),
    then: (a, b) => Promise.resolve(clone(value)).then(a, b) };
  return o;
};

// ── Patch the models onto the store ───────────────────────────────────────
Child.findById = (id) => chain(db.children.find((c) => same(c._id, id)) || null);
Appointment.exists = async (f) => (query(db.appointments, f).length ? { _id: 1 } : null);
Appointment.findOne = (f) => chain(query(db.appointments, f)[0] || null);
Assessment.findOne = (f) => chain(query(db.assessments, f)[0] || null);
PediatricianCheckup.findOne = (f) => chain(query(db.checkups, f)[0] || null);
PediatricianCheckup.find = (f) => chain(query(db.checkups, f));
GuardianLink.findOne = (f) => chain(query(db.guardianLinks, f)[0] || null);
AuditLog.create = async (doc) => { db.audit.push(doc); return doc; };
Notification.create = async (doc) => { db.notifications.push(doc); return doc; };

let failNextReferralCreate = false;
SpecialistReferral.findOne = (f) => chain(query(db.referrals, f)[0] || null);
SpecialistReferral.find = (f) => {
  const pediaUsers = { [String(ids.pediaA)]: { _id: ids.pediaA, firstName: 'Ana', lastName: 'Cruz' } };
  const rows = query(db.referrals, f)
    .map((r) => ({ ...r, pediatricianId: pediaUsers[String(r.pediatricianId)] || r.pediatricianId }))
    .sort((a, b) => new Date(b.referredAt) - new Date(a.referredAt));
  return chain(rows);
};
SpecialistReferral.create = async (doc) => {
  if (failNextReferralCreate) { failNextReferralCreate = false; throw new Error('write failed'); }
  // Validate against the real schema, as Mongoose would before inserting.
  const err = new SpecialistReferral(doc).validateSync();
  if (err) throw err;
  // Emulates the unique partial index { pediatricianId, clientRequestId }.
  if (doc.clientRequestId && db.referrals.some((r) => same(r.pediatricianId, doc.pediatricianId) && r.clientRequestId === doc.clientRequestId)) {
    const dup = new Error('E11000 duplicate key'); dup.code = 11000; throw dup;
  }
  const saved = { _id: oid(), createdAt: new Date(), updatedAt: new Date(), ...doc };
  db.referrals.push(saved);
  return saved;
};

// Writes a referral must never make.
const forbidden = [];
const ban = (model, name, methods) => methods.forEach((m) => {
  model[m] = () => { forbidden.push(`${name}.${m}`); throw new Error(`${name}.${m} must not be called`); };
});
ban(PediatricianCheckup, 'PediatricianCheckup', ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne']);
ban(Assessment, 'Assessment', ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']);
ban(Appointment, 'Appointment', ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany']);
ban(User, 'User', ['create', 'insertMany', 'updateOne', 'findOneAndUpdate', 'findByIdAndUpdate']);
ban(SpecialistReferral, 'SpecialistReferral', ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']);

const pediaA = { userId: String(ids.pediaA), role: 'pediatrician' };
const pediaB = { userId: String(ids.pediaB), role: 'pediatrician' };
const parent = { userId: String(ids.parent), role: 'parent' };
const otherParent = { userId: String(ids.otherParent), role: 'parent' };
const guardian = { userId: String(ids.guardian), role: 'parent' };
const latestCheckup = () => db.checkups[2];
const validBody = (extra = {}) => ({
  sourceCheckupId: String(latestCheckup()._id),
  specialty: 'Developmental Pediatrics',
  reason: 'Speech is not improving sufficiently after two follow-ups; further evaluation recommended.',
  ...extra,
});

async function expectHttp(promise, status, label) {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof HttpError, `${label}: expected HttpError, got ${err && err.message}`);
    assert.strictEqual(err.statusCode, status, `${label}: status ${err.statusCode} (${err.message})`);
    return err;
  }
  assert.fail(`${label}: expected HTTP ${status}`);
}

// ── A + B + E ─────────────────────────────────────────────────────────────
async function createAndPreserveTests() {
  seed();
  const before = clone({ checkups: db.checkups, assessments: db.assessments, appointments: db.appointments, children: db.children });

  const { referral, duplicate } = await createReferralRecord(String(ids.child), pediaA, validBody({ specialistName: '', specialistContact: null }));
  assert.strictEqual(duplicate, false);
  assert(same(referral.childId, ids.child));
  assert(same(referral.pediatricianId, ids.pediaA));
  assert(same(referral.sourceCheckupId, latestCheckup()._id));
  assert(same(referral.assessmentId, ids.assessment2), 'links the assessment the source check-up was based on');
  assert.strictEqual(referral.specialty, 'Developmental Pediatrics');
  assert.strictEqual(referral.specialistName, null, 'blank optional name is stored as null, not invented');
  assert(referral.referredAt instanceof Date);
  ok('A: referral saved with the right child, referring pediatrician, source check-up and its assessment');

  assert.deepStrictEqual(clone({ checkups: db.checkups, assessments: db.assessments, appointments: db.appointments, children: db.children }), before);
  assert.strictEqual(db.referrals.length, 1);
  assert.deepStrictEqual(forbidden, []);
  ok('B: every earlier check-up, assessment, appointment and child record is byte-for-byte unchanged; the referral is one extra record');

  assert.strictEqual(db.appointments.length, 2);
  assert.strictEqual(db.notifications.length, 1);
  assert(same(db.notifications[0].userId, ids.parent));
  assert(/recommendation only/i.test(db.notifications[0].message) && /no appointment has been booked/i.test(db.notifications[0].message));
  assert.strictEqual(db.audit[0].action, 'specialist_referral_created');
  ok('E: no appointment, account, consultation or reassignment is created; the parent is told it is a recommendation only');

  const routes = router.stack.filter((l) => l.route && l.route.path.includes('referral'))
    .map((l) => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
  assert.deepStrictEqual(routes, ['POST /child/:childId/referrals'], 'no update or delete route exists for referrals');
  ok('E: referrals cannot be edited or deleted through the API (create-only)');
}

// ── C + G ─────────────────────────────────────────────────────────────────
async function visibilityTests() {
  seed();
  // Child with check-ups but no referral yet loads normally.
  assert.deepStrictEqual(await listReferralsForChild(String(ids.child), parent), []);
  ok('G: a child with history but no referral returns an empty referral list');

  await createReferralRecord(String(ids.child), pediaA, validBody({ specialistName: 'Dr. Lim', specialistContact: 'City Child Clinic' }));

  const forParent = (await listReferralsForChild(String(ids.child), parent)).map(shapeReferral);
  assert.strictEqual(forParent.length, 1);
  assert.strictEqual(forParent[0].pediatricianName, 'Ana Cruz');
  assert.strictEqual(forParent[0].specialistName, 'Dr. Lim');
  assert.strictEqual(forParent[0].specialistContact, 'City Child Clinic');
  assert.strictEqual((await listReferralsForChild(String(ids.child), guardian)).length, 1);
  assert.strictEqual((await listReferralsForChild(String(ids.child), pediaA)).length, 1);
  ok('C: the parent and a guardian with medical-record access see the referral with its details');

  assert.strictEqual((await listReferralsForChild(String(ids.child), { userId: String(ids.pediaB), role: 'pediatrician' }).catch((e) => e)).statusCode, 403);
  await expectHttp(listReferralsForChild(String(ids.child), otherParent), 403, 'other family');
  await expectHttp(listReferralsForChild(String(ids.child), { userId: String(oid()), role: 'parent' }), 403, 'stranger');
  ok("D: another family's parent and an unlinked pediatrician cannot read the referral");
}

// ── D ─────────────────────────────────────────────────────────────────────
async function authorizationTests() {
  seed();
  await expectHttp(createReferralRecord(String(ids.child), parent, validBody()), 403, 'parent create');
  await expectHttp(createReferralRecord(String(ids.child), pediaB, validBody()), 403, 'unlinked pediatrician');
  // Pediatrician B is linked to the other child; pointing at this child's check-up fails.
  await expectHttp(createReferralRecord(String(ids.otherChild), pediaB, validBody()), 400, 'check-up of a different child');
  // Pediatrician A is linked here, but cannot refer from pediatrician B's record.
  db.appointments.push({ id: 103, childId: ids.otherChild, pediatricianId: ids.pediaA });
  await expectHttp(createReferralRecord(String(ids.otherChild), pediaA, validBody({ sourceCheckupId: String(db.checkups[3]._id) })), 403, "another pediatrician's check-up");
  await expectHttp(createReferralRecord(String(oid()), pediaA, validBody()), 404, 'unknown child');
  await expectHttp(createReferralRecord('not-an-id', pediaA, validBody()), 404, 'malformed child id');
  assert.strictEqual(db.referrals.length, 0);
  assert.deepStrictEqual(forbidden, []);
  ok('D: parents, unlinked pediatricians and swapped child/check-up ids are rejected and nothing is written');
}

// ── F ─────────────────────────────────────────────────────────────────────
async function duplicateTests() {
  seed();
  const body = validBody({ clientRequestId: 'req-0001-abcdef' });
  const first = await createReferralRecord(String(ids.child), pediaA, body);
  const second = await createReferralRecord(String(ids.child), pediaA, body);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
  assert(same(first.referral._id, second.referral._id));
  assert.strictEqual(db.referrals.length, 1);
  assert.strictEqual(db.notifications.length, 1, 'the parent is notified once');
  ok('F: resubmitting the same form returns the saved referral instead of creating a second one');

  // Two clicks in flight at once: both pass the lookup, the unique index keeps one.
  seed();
  const racing = validBody({ clientRequestId: 'req-0002-race' });
  const [a, b] = await Promise.all([
    createReferralRecord(String(ids.child), pediaA, racing),
    createReferralRecord(String(ids.child), pediaA, racing),
  ]);
  assert.strictEqual(db.referrals.length, 1);
  assert.deepStrictEqual([a.duplicate, b.duplicate].sort(), [false, true]);
  ok('F: two simultaneous submissions still produce exactly one referral');

  db.appointments.push({ id: 104, childId: ids.otherChild, pediatricianId: ids.pediaA });
  await expectHttp(createReferralRecord(String(ids.otherChild), pediaA, validBody({ clientRequestId: 'req-0002-race' })), 409, 'request id reused for another child');
  assert.strictEqual(db.referrals.length, 1);
}

// ── H ─────────────────────────────────────────────────────────────────────
async function validationTests() {
  seed();
  const before = clone(db.checkups);
  const cases = [
    [{ specialty: '' }, 'missing specialty'],
    [{ specialty: 'ab' }, 'specialty too short'],
    [{ reason: '' }, 'missing reason'],
    [{ reason: 'too short' }, 'reason too short'],
    [{ reason: 'x'.repeat(2001) }, 'reason too long'],
    [{ specialistContact: 'x'.repeat(301) }, 'contact too long'],
    [{ sourceCheckupId: '' }, 'missing source check-up'],
    [{ sourceCheckupId: 'abc' }, 'malformed source check-up'],
    [{ sourceCheckupId: String(oid()) }, 'unknown source check-up'],
    [{ clientRequestId: 'bad id!' }, 'malformed request id'],
  ];
  for (const [patch, label] of cases) {
    await expectHttp(createReferralRecord(String(ids.child), pediaA, validBody(patch)), 400, label);
  }
  assert.strictEqual(db.referrals.length, 0);
  ok('H: missing, too-short, too-long and malformed fields are rejected by the backend');

  failNextReferralCreate = true;
  await assert.rejects(createReferralRecord(String(ids.child), pediaA, validBody()), /write failed/);
  assert.deepStrictEqual(clone(db.checkups), before);
  assert.strictEqual(db.referrals.length, 0);
  assert.strictEqual(db.notifications.length, 0, 'no notification for a referral that was not saved');
  assert.deepStrictEqual(forbidden, []);
  ok('H: a failed save leaves every earlier record intact and sends nothing');
}

// ── G + I: the existing GET history endpoint ──────────────────────────────
async function historyRouteTests() {
  seed();
  const layer = router.stack.find((l) => l.route && l.route.path === '/child/:childId' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = async (user) => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await handler({ params: { childId: String(ids.child) }, user }, res);
    return res;
  };

  let res = await call(parent);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.checkups.length, 3);
  assert.deepStrictEqual(res.body.referrals, []);
  assert.strictEqual(res.body.referralsError, null);

  await createReferralRecord(String(ids.child), pediaA, validBody());
  res = await call(parent);
  assert.strictEqual(res.body.checkups.length, 3, 'the three earlier visits are all still returned');
  assert.strictEqual(res.body.referrals.length, 1);
  assert.strictEqual(res.body.referrals[0].sourceCheckupId, String(latestCheckup()._id));
  ok('G: GET /checkups/child/:childId keeps its checkups array and adds referrals alongside it');

  const realFind = SpecialistReferral.find;
  const realError = console.error;
  SpecialistReferral.find = () => { throw new Error('collection unavailable'); };
  console.error = () => {};
  try {
    res = await call(parent);
  } finally {
    SpecialistReferral.find = realFind;
    console.error = realError;
  }
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.checkups.length, 3);
  assert.deepStrictEqual(res.body.referrals, []);
  assert(res.body.referralsError && !/collection unavailable/.test(res.body.referralsError), 'no internal detail leaks');
  ok('H: a referral lookup failure never hides the check-up history and does not leak internals');

  res = await call(otherParent);
  assert.strictEqual(res.statusCode, 403);
  ok("D: another family still gets 403 from the history endpoint");
}

// ── C (UI): the parent history renderer ───────────────────────────────────
function parentRendererTests() {
  const sandbox = {
    window: { location: { search: '' }, KCScoring: {}, KCReportInterpretations: {} },
    document: { addEventListener() {}, getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    requireAuth: () => true,
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/parent/reports.js'), 'utf8'), sandbox);

  const checkups = [
    { id: 'c3', visitType: 'follow_up_checkup', checkupDate: '2026-06-15T12:00:00.000Z', diagnosis: 'Not improving sufficiently', status: 'needs_attention', pediatricianName: 'Ana Cruz' },
    { id: 'c1', visitType: 'initial_checkup', checkupDate: '2026-02-15T12:00:00.000Z', diagnosis: 'Speech delay suspected', status: 'initial_review', pediatricianName: 'Ana Cruz' },
  ];
  const referral = { id: 'r1', sourceCheckupId: 'c3', specialty: 'Developmental Pediatrics', specialistName: null, specialistContact: null, reason: 'Further evaluation <needed>', referredAt: '2026-06-15T15:00:00.000Z', pediatricianName: 'Ana Cruz' };

  const html = sandbox.renderCheckupHistory(checkups, null, [referral], null);
  const order = ['Specialist Referral', 'Not improving sufficiently', 'Speech delay suspected'].map((t) => html.indexOf(t));
  assert(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], 'referral first, then the visits in order');
  assert(html.includes('Developmental Pediatrics') && html.includes('Based on:') && html.includes('Referred by Ana Cruz'));
  assert(html.includes('No appointment has been booked'));
  assert(!html.includes('Recommended specialist:') && !html.includes('Clinic / contact details:'), 'absent optional fields are simply left out');
  assert(html.includes('&lt;needed&gt;') && !html.includes('<needed>'), 'referral text is escaped');
  assert(!/accepted|has examined|transferred to/i.test(html.replace(/have not been sent anywhere/, '')));
  ok('C: the parent timeline shows the referral above the visits it follows, with its details and no claim of a booked visit');

  const noReferral = sandbox.renderCheckupHistory(checkups, null, [], null);
  assert(!noReferral.includes('Specialist Referral') && noReferral.includes('Speech delay suspected'));
  const legacyCall = sandbox.renderCheckupHistory(checkups, null);
  assert(legacyCall.includes('Not improving sufficiently'));
  const failed = sandbox.renderCheckupHistory(checkups, null, [], 'Referrals could not be loaded.');
  assert(failed.includes('could not be loaded right now') && failed.includes('Speech delay suspected'));
  ok('G: history without referrals (or with a referral lookup failure) still renders every visit');
}

(async () => {
  await createAndPreserveTests();
  await visibilityTests();
  await authorizationTests();
  await duplicateTests();
  await validationTests();
  await historyRouteTests();
  parentRendererTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Specialist referral tests OK — ${results.length} groups`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
