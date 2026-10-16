// Unit tests for the Pediatrician Reports Clinical Status Summary:
// services/pediaClinicalStatus.js and GET /api/pedia-reports/clinical-status.
//
// What is locked in here:
//   - every stored check-up status has a label and a category; only the four
//     literal matches are mapped, the rest stay "other" as recorded;
//   - the latest check-up (checkupDate, then createdAt) sets the status, an
//     older Resolved never overrides a newer status, and a tie that cannot be
//     broken is reported as ambiguous instead of picked arbitrarily;
//   - counts equal the rows in each category, one row per patient;
//   - only the requesting pediatrician's patients and check-ups are read;
//   - assessment bands are reported beside the status, never used to set it.
//
// No DB and no network: the models the route reads are in-memory stand-ins.
const assert = require('assert');
const mongoose = require('mongoose');

const PediatricianCheckup = require('../../models/PediatricianCheckup');
const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const AssessmentResult = require('../../models/AssessmentResult');
const CS = require('../../services/pediaClinicalStatus');
const router = require('../../routes/pedia-reports');

const oid = () => new mongoose.Types.ObjectId();
const lean = (v) => ({ lean: async () => v, select: () => lean(v), sort: () => lean(v) });
const inIds = (filter, field) => (filter[field].$in || []).map(String);

// ── Pure helpers ────────────────────────────────────────────────────────────

function testEveryStoredStatusIsLabelledAndCategorised() {
  for (const s of PediatricianCheckup.STATUSES) {
    assert.ok(CS.STATUS_LABELS[s], `label for ${s}`);
    assert.ok(CS.CATEGORY_KEYS.includes(CS.categoryForStatus(s)), `category for ${s}`);
  }
  assert.deepStrictEqual(Object.keys(CS.STATUS_LABELS).sort(), PediatricianCheckup.STATUSES.slice().sort());
  assert.strictEqual(CS.categoryForStatus('resolved'), 'resolved');
  assert.strictEqual(CS.categoryForStatus('needs_attention'), 'needs_follow_up');
  assert.strictEqual(CS.categoryForStatus('monitoring'), 'monitoring');
  assert.strictEqual(CS.categoryForStatus('parent_monitoring'), 'monitoring');
  for (const s of ['initial_review', 'improving', 'stable', 'referred', 'something_new']) {
    assert.strictEqual(CS.categoryForStatus(s), 'other', s);
  }
  assert.strictEqual(CS.statusLabel('something_new'), 'something_new');
  assert.deepStrictEqual(CS.categoryStatusLabels(), {
    resolved: ['Resolved / Ruled Out'],
    needs_follow_up: ['Needs Attention'],
    monitoring: ['Monitoring', 'Parent Monitoring'],
    other: ['Initial Review', 'Improving', 'Stable', 'Referred'],
    no_checkup: [],
  });
}

function testNewerCheckupWins() {
  const pick = CS.selectLatestCheckup([
    { status: 'resolved', checkupDate: '2026-09-01', createdAt: '2026-09-01T10:00:00Z' },
    { status: 'needs_attention', checkupDate: '2026-10-01', createdAt: '2026-10-01T10:00:00Z' },
  ]);
  assert.strictEqual(pick.latest.status, 'needs_attention');
  assert.strictEqual(pick.ambiguous, false);
  assert.strictEqual(pick.recordCount, 2);

  // Same check-up date: the later-created record is the latest.
  const sameDay = CS.selectLatestCheckup([
    { status: 'monitoring', checkupDate: '2026-10-01', createdAt: '2026-10-01T12:00:00Z' },
    { status: 'resolved', checkupDate: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' },
  ]);
  assert.strictEqual(sameDay.latest.status, 'monitoring');
}

function testAmbiguousLatestIsNotPicked() {
  const tie = CS.selectLatestCheckup([
    { status: 'resolved', checkupDate: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' },
    { status: 'needs_attention', checkupDate: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' },
  ]);
  assert.strictEqual(tie.latest, null);
  assert.strictEqual(tie.ambiguous, true);
  assert.strictEqual(tie.reason, 'same_timestamp');

  // Missing createdAt on a same-date pair cannot be ordered either.
  const noCreated = CS.selectLatestCheckup([
    { status: 'resolved', checkupDate: '2026-10-01' },
    { status: 'monitoring', checkupDate: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' },
  ]);
  assert.strictEqual(noCreated.ambiguous, true);

  // A tie with the SAME status is not ambiguous about the status.
  const sameStatus = CS.selectLatestCheckup([
    { status: 'monitoring', checkupDate: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' },
    { status: 'monitoring', checkupDate: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' },
  ]);
  assert.strictEqual(sameStatus.latest.status, 'monitoring');

  // No record has a usable date.
  const undated = CS.selectLatestCheckup([{ status: 'resolved', checkupDate: null }]);
  assert.strictEqual(undated.ambiguous, true);
  assert.strictEqual(undated.reason, 'no_valid_date');
  assert.strictEqual(undated.undatedCount, 1);

  // An undated record never outranks a dated one.
  const mixed = CS.selectLatestCheckup([
    { status: 'resolved', checkupDate: 'not a date' },
    { status: 'stable', checkupDate: '2026-01-01', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.strictEqual(mixed.latest.status, 'stable');
  assert.strictEqual(mixed.undatedCount, 1);
}

function testSummaryCountsMatchRows() {
  const p = (id, name, band) => ({ childId: id, name, latestAssessmentAt: band ? '2026-10-01T00:00:00Z' : null, latestOverallBand: band || null });
  const summary = CS.buildClinicalStatusSummary(
    [p('a', 'Ana', 'on-track'), p('b', 'Ben', 'delayed'), p('c', 'Cy', null), p('d', 'Di', 'on-track'), p('e', 'Ed', null)],
    [
      { childId: 'a', status: 'needs_attention', checkupDate: '2026-10-02', createdAt: '2026-10-02T00:00:00Z', nextFollowUpDate: '2026-11-02', recommendations: '  Recheck speech.  ' },
      { childId: 'a', status: 'resolved', checkupDate: '2026-09-01', createdAt: '2026-09-01T00:00:00Z' },
      { childId: 'b', status: 'resolved', checkupDate: '2026-10-01', createdAt: '2026-10-01T00:00:00Z', nextFollowUpDate: 'garbage' },
      { childId: 'd', status: 'referred', checkupDate: '2026-10-01', createdAt: '2026-10-01T00:00:00Z' },
      { childId: 'e', status: 'parent_monitoring', checkupDate: '2026-10-01', createdAt: '2026-10-01T00:00:00Z' },
    ],
  );
  assert.strictEqual(summary.total, 5);
  assert.deepStrictEqual(summary.counts, { resolved: 1, needs_follow_up: 1, monitoring: 1, other: 1, no_checkup: 1 });
  for (const k of CS.CATEGORY_KEYS) {
    assert.strictEqual(summary.patients.filter((r) => r.category === k).length, summary.counts[k], k);
  }
  assert.strictEqual(new Set(summary.patients.map((r) => r.childId)).size, summary.total);

  const byId = Object.fromEntries(summary.patients.map((r) => [r.childId, r]));
  // Older Resolved does not override the newer Needs Attention.
  assert.strictEqual(byId.a.status, 'needs_attention');
  assert.strictEqual(byId.a.checkupCount, 2);
  assert.strictEqual(byId.a.latestRecommendation, 'Recheck speech.');
  assert.strictEqual(byId.a.nextFollowUpDate, new Date('2026-11-02').toISOString());
  // An On-Track band does not make a patient resolved, and a Delayed band
  // does not stop a recorded Resolved from being shown as recorded.
  assert.strictEqual(byId.a.latestOverallBand, 'on-track');
  assert.strictEqual(byId.b.category, 'resolved');
  assert.strictEqual(byId.b.latestOverallBand, 'delayed');
  // An invalid follow-up date is not shown.
  assert.strictEqual(byId.b.nextFollowUpDate, null);
  // Referred stays as recorded under "other".
  assert.strictEqual(byId.d.category, 'other');
  assert.strictEqual(byId.d.statusLabel, 'Referred');
  // No check-up: no status invented, regardless of the band.
  assert.strictEqual(byId.c.category, 'no_checkup');
  assert.strictEqual(byId.c.status, null);
  assert.strictEqual(byId.c.latestCheckupDate, null);
  // Sorted by name.
  assert.deepStrictEqual(summary.patients.map((r) => r.name), ['Ana', 'Ben', 'Cy', 'Di', 'Ed']);
}

// ── Route ───────────────────────────────────────────────────────────────────

const pediaA = String(oid());
const pediaB = String(oid());
const kid1 = oid();
const kid2 = oid();
const kid3 = oid();
const otherKid = oid();

const appointments = [
  { pediatricianId: pediaA, childId: kid1 },
  { pediatricianId: pediaA, childId: kid1 },
  { pediatricianId: pediaA, childId: kid2 },
  { pediatricianId: pediaA, childId: kid3 },
  { pediatricianId: pediaB, childId: otherKid },
  { pediatricianId: pediaB, childId: kid2 },
];
const children = [
  { _id: kid1, firstName: 'Kemri', lastName: 'Soto' },
  { _id: kid2, firstName: 'Chan', lastName: 'Dumaniel' },
  { _id: kid3, firstName: 'Ana', lastName: 'Cruz' },
  { _id: otherKid, firstName: 'Not', lastName: 'Mine' },
];
const results = [
  { _id: oid(), assessmentId: oid(), childId: kid1, generatedAt: new Date('2026-10-14T03:00:00Z'), communicationScore: 90, socialScore: 90, cognitiveScore: 90, motorScore: 90, overallScore: 90 },
  { _id: oid(), assessmentId: oid(), childId: kid2, generatedAt: new Date('2026-05-02T03:00:00Z'), communicationScore: 20, socialScore: 20, cognitiveScore: 20, motorScore: 20, overallScore: 20 },
];
const checkups = [
  { childId: kid1, pediatricianId: pediaA, status: 'needs_attention', checkupDate: new Date('2026-10-15'), createdAt: new Date('2026-10-15T01:00:00Z') },
  { childId: kid1, pediatricianId: pediaA, status: 'resolved', checkupDate: new Date('2026-08-01'), createdAt: new Date('2026-08-01T01:00:00Z') },
  // Another pediatrician's check-up for a shared patient is never read.
  { childId: kid2, pediatricianId: pediaB, status: 'resolved', checkupDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01T01:00:00Z') },
  { childId: otherKid, pediatricianId: pediaB, status: 'resolved', checkupDate: new Date('2026-10-01'), createdAt: new Date('2026-10-01T01:00:00Z') },
];

let lastCheckupFilter = null;
Appointment.find = (filter) => lean(appointments.filter((a) => a.pediatricianId === String(filter.pediatricianId)));
Child.find = (filter) => lean(children.filter((c) => inIds(filter, '_id').includes(String(c._id))));
AssessmentResult.find = (filter) => {
  const ids = inIds(filter, 'childId');
  const range = filter.generatedAt || {};
  return lean(results
    .filter((r) => ids.includes(String(r.childId)))
    .filter((r) => (!range.$gte || r.generatedAt >= range.$gte) && (!range.$lte || r.generatedAt <= range.$lte)));
};
PediatricianCheckup.find = (filter) => {
  lastCheckupFilter = filter;
  const ids = inIds(filter, 'childId');
  return lean(checkups.filter((c) => ids.includes(String(c.childId)) && String(c.pediatricianId) === String(filter.pediatricianId)));
};

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function call(query, user = { userId: pediaA, role: 'pediatrician' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/clinical-status' && l.route.methods.get);
  assert(layer, 'route GET /clinical-status exists');
  const stack = layer.route.stack.map((s) => s.handle);
  const handler = stack[stack.length - 1];
  const gate = stack[stack.length - 2];
  const req = { query, user };
  const res = fakeRes();
  let passed = false;
  gate(req, res, () => { passed = true; });
  if (passed) await handler(req, res);
  return res;
}

async function testRouteScopeAndCategories() {
  const res = await call({});
  assert.strictEqual(res.statusCode, 200);
  const { total, counts, patients } = res.body;
  assert.strictEqual(total, 3);
  assert.deepStrictEqual(patients.map((p) => p.name), ['Ana Cruz', 'Chan Dumaniel', 'Kemri Soto']);
  assert.ok(!patients.some((p) => p.childId === String(otherKid)));
  // Scope and author are both enforced in the query, not afterwards.
  assert.strictEqual(String(lastCheckupFilter.pediatricianId), pediaA);
  const kemri = patients.find((p) => p.name === 'Kemri Soto');
  assert.strictEqual(kemri.category, 'needs_follow_up');
  assert.strictEqual(kemri.statusLabel, 'Needs Attention');
  assert.strictEqual(kemri.latestOverallBand, 'on-track');
  // Chan's only check-up belongs to pediatrician B: no outcome for A.
  assert.strictEqual(patients.find((p) => p.name === 'Chan Dumaniel').category, 'no_checkup');
  assert.deepStrictEqual(counts, { resolved: 0, needs_follow_up: 1, monitoring: 0, other: 0, no_checkup: 2 });
}

async function testDateRangeDoesNotFilterCheckups() {
  // A range that excludes Kemri's assessment still reports Kemri's check-up.
  const res = await call({ from: '2026-01-01', to: '2026-06-30' });
  const kemri = res.body.patients.find((p) => p.name === 'Kemri Soto');
  assert.strictEqual(kemri.category, 'needs_follow_up');
  assert.strictEqual(kemri.latestAssessmentAt, null);
  assert.strictEqual(res.body.total, 3);
}

async function testPatientFilterAndGates() {
  const one = await call({ childId: String(kid1) });
  assert.deepStrictEqual(one.body.patients.map((p) => p.name), ['Kemri Soto']);
  // Another pediatrician's child id narrows to nothing; it cannot widen scope.
  const foreign = await call({ childId: String(otherKid) });
  assert.strictEqual(foreign.body.total, 0);
  assert.strictEqual((await call({}, { userId: pediaA, role: 'parent' })).statusCode, 403);
  assert.strictEqual((await call({ childId: 'nope' })).statusCode, 400);
}

async function testErrorDoesNotLeakDetails() {
  const original = PediatricianCheckup.find;
  PediatricianCheckup.find = () => { throw new Error('boom Kemri Soto'); };
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await call({});
    assert.strictEqual(res.statusCode, 500);
    assert.ok(!/Kemri/.test(JSON.stringify(res.body)));
  } finally {
    PediatricianCheckup.find = original;
    console.error = realError;
  }
}

async function run() {
  testEveryStoredStatusIsLabelledAndCategorised();
  testNewerCheckupWins();
  testAmbiguousLatestIsNotPicked();
  testSummaryCountsMatchRows();
  await testRouteScopeAndCategories();
  await testDateRangeDoesNotFilterCheckups();
  await testPatientFilterAndGates();
  await testErrorDoesNotLeakDetails();
  console.log('Pediatrician Reports clinical status OK — literal status mapping, latest-check-up rule and ambiguity, counts equal rows, pediatrician scope, date range leaves check-ups alone');
}

run().catch((err) => { console.error(err); process.exit(1); });
