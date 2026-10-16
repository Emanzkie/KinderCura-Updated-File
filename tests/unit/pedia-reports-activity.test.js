// Unit tests for GET /api/pedia-reports/activity (routes/pedia-reports.js).
//
// The endpoint behind the Assessment Activity Records table, the activity line
// chart and Patient Development Progress. What is locked in here:
//   - one record per stored assessment result, never duplicated by the
//     Assessment lookup, newest first;
//   - only children linked to the requesting pediatrician by an appointment;
//   - the same date-range and classification filters as every other section;
//   - status is the stored Assessment.status, or null — never invented;
//   - stored scores pass through unchanged, bands from constants/scoring.js.
//
// No DB and no network: the four models the route reads are replaced by
// in-memory stand-ins that honour the exact filters the route sends.
const assert = require('assert');
const mongoose = require('mongoose');

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const scoring = require('../../constants/scoring');
const router = require('../../routes/pedia-reports');

const oid = () => new mongoose.Types.ObjectId();
const lean = (v) => ({ lean: async () => v, select: () => lean(v), sort: () => lean(v) });
const inIds = (filter, field) => (filter[field].$in || []).map(String);

const pediaA = String(oid());
const pediaB = String(oid());
const kid1 = oid();
const kid2 = oid();
const otherKid = oid();

const appointments = [
  { pediatricianId: pediaA, childId: kid1 },
  { pediatricianId: pediaA, childId: kid1 },
  { pediatricianId: pediaA, childId: kid2 },
  { pediatricianId: pediaB, childId: otherKid },
];
const children = [
  { _id: kid1, firstName: 'Kemri', lastName: 'Soto' },
  { _id: kid2, firstName: 'Chan', lastName: 'Dumaniel' },
  { _id: otherKid, firstName: 'Not', lastName: 'Mine' },
];

const a1 = oid();
const a2 = oid();
const a3 = oid();
const a4 = oid();
const aOther = oid();
const results = [
  { _id: oid(), assessmentId: a1, childId: kid1, generatedAt: new Date('2026-05-04T03:00:00Z'), communicationScore: 50, socialScore: 45, cognitiveScore: 63, motorScore: 65, overallScore: 56 },
  { _id: oid(), assessmentId: a2, childId: kid1, generatedAt: new Date('2026-10-14T03:00:00Z'), communicationScore: 70, socialScore: 83, cognitiveScore: 55, motorScore: 60, overallScore: 67 },
  { _id: oid(), assessmentId: a3, childId: kid2, generatedAt: new Date('2026-10-02T03:00:00Z'), communicationScore: 90, socialScore: 85, cognitiveScore: 88, motorScore: 81, overallScore: 86 },
  // Assessment document missing: status must come back null, not "complete".
  { _id: oid(), assessmentId: a4, childId: kid2, generatedAt: new Date('2026-10-03T03:00:00Z'), communicationScore: 40, socialScore: null, cognitiveScore: 50, motorScore: 50, overallScore: 47 },
  { _id: oid(), assessmentId: aOther, childId: otherKid, generatedAt: new Date('2026-10-05T03:00:00Z'), communicationScore: 10, socialScore: 10, cognitiveScore: 10, motorScore: 10, overallScore: 10 },
];
const assessments = [
  { _id: a1, status: 'complete' },
  { _id: a2, status: 'complete' },
  { _id: a3, status: 'submitted' },
  { _id: aOther, status: 'complete' },
];

Appointment.find = (filter) => lean(appointments.filter((a) => a.pediatricianId === String(filter.pediatricianId)));
Child.find = (filter) => lean(children.filter((c) => inIds(filter, '_id').includes(String(c._id))));
Assessment.find = (filter) => lean(assessments.filter((a) => inIds(filter, '_id').includes(String(a._id))));
AssessmentResult.find = (filter) => {
  const ids = inIds(filter, 'childId');
  const range = filter.generatedAt || {};
  return lean(results
    .filter((r) => ids.includes(String(r.childId)))
    .filter((r) => (!range.$gte || r.generatedAt >= range.$gte) && (!range.$lte || r.generatedAt <= range.$lte))
    .slice()
    .sort((x, y) => x.generatedAt - y.generatedAt));
};

function routeStack(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  assert(layer, `route GET ${path} exists`);
  return layer.route.stack.map((s) => s.handle);
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function call(query, user = { userId: pediaA, role: 'pediatrician' }) {
  const stack = routeStack('/activity');
  const handler = stack[stack.length - 1];
  const gate = stack[stack.length - 2];
  const req = { query, user };
  const res = fakeRes();
  let passed = false;
  gate(req, res, () => { passed = true; });
  if (passed) await handler(req, res);
  return res;
}

async function testOneRecordPerAssessmentNewestFirst() {
  const res = await call({});
  assert.strictEqual(res.statusCode, 200);
  const { records, totals } = res.body;
  assert.deepStrictEqual(records.map((r) => r.assessmentId), [a2, a4, a3, a1].map(String));
  assert.deepStrictEqual(totals, { assessments: 4, patientsAssessed: 2 });
  // Two appointments for kid1 must not duplicate kid1's assessments.
  assert.strictEqual(records.filter((r) => r.childId === String(kid1)).length, 2);
  // Another pediatrician's patient never appears.
  assert.ok(!records.some((r) => r.childId === String(otherKid)));
}

async function testStoredValuesPassThrough() {
  const { records } = (await call({})).body;
  const latest = records[0];
  assert.strictEqual(latest.name, 'Kemri Soto');
  assert.strictEqual(latest.status, 'complete');
  assert.strictEqual(latest.overallScore, 67);
  assert.strictEqual(latest.overallBand, scoring.bandFor(67));
  assert.deepStrictEqual(latest.domains.social, { score: 83, band: scoring.bandFor(83) });

  const noAssessmentDoc = records.find((r) => r.assessmentId === String(a4));
  assert.strictEqual(noAssessmentDoc.status, null);
  // A missing score stays missing; it is never banded as a 0.
  assert.deepStrictEqual(noAssessmentDoc.domains.social, { score: null, band: null });
}

async function testDateRangeFilter() {
  const { records } = (await call({ from: '2026-10-01', to: '2026-10-03' })).body;
  assert.deepStrictEqual(records.map((r) => r.assessmentId), [a4, a3].map(String));
}

async function testClassificationAndPatientFilters() {
  // Classification keeps a child by their LATEST result, then returns all of
  // that child's results — the same rule as the rest of the report.
  const band = scoring.bandFor(67);
  const byBand = (await call({ classification: band })).body.records;
  assert.ok(byBand.length >= 2);
  assert.ok(byBand.every((r) => r.childId === String(kid1)));

  const byPatient = (await call({ childId: String(kid2) })).body.records;
  assert.deepStrictEqual(byPatient.map((r) => r.childId), [String(kid2), String(kid2)]);

  // Asking for a child outside scope returns nothing, never that child.
  const outside = (await call({ childId: String(otherKid) })).body.records;
  assert.deepStrictEqual(outside, []);
}

async function testRejectsBadInputAndOtherRoles() {
  assert.strictEqual((await call({ from: 'not-a-date' })).statusCode, 400);
  assert.strictEqual((await call({ classification: 'cured' })).statusCode, 400);
  const parent = await call({}, { userId: pediaA, role: 'parent' });
  assert.strictEqual(parent.statusCode, 403);
}

(async () => {
  await testOneRecordPerAssessmentNewestFirst();
  await testStoredValuesPassThrough();
  await testDateRangeFilter();
  await testClassificationAndPatientFilters();
  await testRejectsBadInputAndOtherRoles();
  console.log('Pediatrician Reports activity endpoint OK — one record per assessment, newest first, pediatrician scope, range/classification/patient filters, stored status and scores only');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
