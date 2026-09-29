// tests/unit/pedia-reports-interpretations.test.js
// Locks in the wording/decision rules for js/pedia/pedia-reports-interpretations.js
// (the pediatrician Classification-overview chart interpretations and the
// cohort progression summary on PEDIA/pedia-reports.html). Pure, no-DB,
// no-network tests — mirrors tests/unit/admin-analytics-interpretations.test.js.

const assert = require('assert');
const KC = require('../../js/pedia/pedia-reports-interpretations.js');

function emptyBandCounts() {
  return { 'on-track': 0, developing: 0, 'at-risk': 0, delayed: 0 };
}

// ── formatDomainBandInterpretation ──────────────────────────────────────────

function testDomainBandNoPatients() {
  const text = KC.formatDomainBandInterpretation({}, 0);
  assert.ok(/None of your patients has a completed assessment/.test(text));
}

function testDomainBandAllZeroNeedsSupport() {
  const dist = {
    communication: { 'on-track': 5, developing: 3, 'at-risk': 0, delayed: 0 },
    social: { 'on-track': 8, developing: 0, 'at-risk': 0, delayed: 0 },
    cognitive: { 'on-track': 6, developing: 2, 'at-risk': 0, delayed: 0 },
    motor: { 'on-track': 8, developing: 0, 'at-risk': 0, delayed: 0 },
  };
  const text = KC.formatDomainBandInterpretation(dist, 8);
  assert.ok(/none of your 8 assessed patients currently falls in the at-risk or delayed range/.test(text));
}

function testDomainBandLeader() {
  const dist = {
    communication: { 'on-track': 2, developing: 1, 'at-risk': 4, delayed: 3 },
    social: { 'on-track': 5, developing: 2, 'at-risk': 2, delayed: 1 },
    cognitive: { 'on-track': 4, developing: 3, 'at-risk': 1, delayed: 2 },
    motor: { 'on-track': 6, developing: 2, 'at-risk': 1, delayed: 1 },
  };
  const text = KC.formatDomainBandInterpretation(dist, 10);
  // Communication: 4+3=7 needs-support, the highest.
  assert.ok(/Communication has the highest number of patients/.test(text));
  assert.ok(/7 of 10 assessed patients/.test(text));
  assert.ok(/not a diagnosis/.test(text));
}

function testDomainBandTie() {
  const dist = {
    communication: { 'on-track': 0, developing: 0, 'at-risk': 2, delayed: 0 },
    social: { 'on-track': 0, developing: 0, 'at-risk': 2, delayed: 0 },
    cognitive: { 'on-track': 2, developing: 0, 'at-risk': 0, delayed: 0 },
    motor: { 'on-track': 2, developing: 0, 'at-risk': 0, delayed: 0 },
  };
  const text = KC.formatDomainBandInterpretation(dist, 2);
  assert.ok(/Communication and Social Skills are tied for the highest number of patients/.test(text));
}

// ── formatOverallBandInterpretation ─────────────────────────────────────────

function testOverallBandNoPatients() {
  const text = KC.formatOverallBandInterpretation(emptyBandCounts(), 0);
  assert.ok(/None of your patients has a completed assessment/.test(text));
}

function testOverallBandLeaderWithNeedsSupport() {
  const dist = { 'on-track': 2, developing: 5, 'at-risk': 2, delayed: 1 };
  const text = KC.formatOverallBandInterpretation(dist, 10);
  assert.ok(/5 of your 10 assessed patients \(50%\) — the largest group — falls in the "Developing" range/.test(text));
  assert.ok(/3 of 10 \(30%\) fall in the at-risk or delayed range/.test(text));
  assert.ok(/not a diagnosis/.test(text));
}

function testOverallBandNoneNeedSupport() {
  const dist = { 'on-track': 6, developing: 4, 'at-risk': 0, delayed: 0 };
  const text = KC.formatOverallBandInterpretation(dist, 10);
  assert.ok(/None currently fall in the at-risk or delayed range/.test(text));
}

// ── formatProgressionCohortInterpretation ───────────────────────────────────

function testProgressionCohortNoRepeats() {
  const text = KC.formatProgressionCohortInterpretation({ improved: 0, unchanged: 0, declined: 0 }, 0);
  assert.ok(/None of your patients has two or more completed assessments/.test(text));
}

function testProgressionCohortMixed() {
  const text = KC.formatProgressionCohortInterpretation({ improved: 3, unchanged: 2, declined: 1 }, 6);
  assert.ok(/6 patients with repeat assessments/.test(text));
  assert.ok(/3 moved to a better overall band/.test(text));
  assert.ok(/2 stayed in the same overall band/.test(text));
  assert.ok(/1 moved to a band indicating more concern/.test(text));
  assert.ok(/does not indicate a medical diagnosis, cause, or a pediatrician's effectiveness/.test(text));
}

function testProgressionCohortSinglePatientWording() {
  const text = KC.formatProgressionCohortInterpretation({ improved: 1, unchanged: 0, declined: 0 }, 1);
  assert.ok(/\(1 patient with repeat assessments\)/.test(text));
}

// ── Revised reports: per-domain counts, movement wording, roster, activity ──

// The counts table's sentences must name the ACTUAL numbers, and must never
// describe a child as having a condition.
function testDomainCountSentences() {
  const dist = {
    communication: { 'on-track': 11, developing: 3, 'at-risk': 3, delayed: 4 },
    social: { 'on-track': 8, developing: 4, 'at-risk': 6, delayed: 3 },
    cognitive: { 'on-track': 21, developing: 0, 'at-risk': 0, delayed: 0 },
    motor: { 'on-track': 7, developing: 6, 'at-risk': 5, delayed: 3 },
  };
  const rows = KC.formatDomainCountSentences(dist, 21);
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.key), ['communication', 'social', 'cognitive', 'motor']);

  const comms = rows[0].text;
  assert.ok(/11 classified as On-Track/.test(comms), comms);
  assert.ok(/3 as Developing/.test(comms), comms);
  assert.ok(/4 as Delayed/.test(comms), comms);
  // 3 at-risk + 4 delayed = 7 needing closer review
  assert.ok(/7 of 21/.test(comms), comms);
  assert.ok(/may warrant closer review/.test(comms), comms);

  // A domain with nobody in at-risk/delayed gets no concern clause.
  assert.ok(!/may warrant closer review/.test(rows[2].text), rows[2].text);
  assert.ok(/21 classified as On-Track/.test(rows[2].text), rows[2].text);

  // Bands nobody is in are omitted rather than printed as zero.
  assert.ok(!/ 0 /.test(rows[2].text), rows[2].text);

  // No diagnostic language anywhere.
  for (const r of rows) {
    assert.ok(!/(disorder|diagnos|condition|autis)/i.test(r.text), r.text);
  }
}

function testDomainCountSentencesEmpty() {
  assert.deepStrictEqual(KC.formatDomainCountSentences({}, 0), []);
}

function testDomainCountSingularWording() {
  const rows = KC.formatDomainCountSentences(
    { communication: { 'on-track': 0, developing: 0, 'at-risk': 0, delayed: 1 } }, 1);
  assert.ok(/1 classified as Delayed/.test(rows[0].text), rows[0].text);
  assert.ok(/Of the 1 assessed patient/.test(rows[0].text), rows[0].text);
  assert.ok(/1 of 1 falls in the at-risk or delayed range/.test(rows[0].text), rows[0].text);
}

// The plain-language gloss replacing "Improved / Same / Declined Overall Band".
function testMovementDescriptions() {
  assert.ok(/less concern/.test(KC.formatMovementDescription('improved')));
  assert.ok(/greater concern/.test(KC.formatMovementDescription('declined')));
  assert.ok(/remains in the same classification/.test(KC.formatMovementDescription('unchanged')));
  // Anything unrecognised is treated as no change rather than throwing.
  assert.ok(/remains in the same classification/.test(KC.formatMovementDescription(undefined)));
}

function testPatientProgressionInterpretation() {
  const text = KC.formatPatientProgressionInterpretation({
    name: 'Kenmri Soto',
    assessmentCount: 5,
    firstScore: 100, firstBand: 'on-track', firstDate: '25 May 2026',
    latestScore: 0, latestBand: 'delayed', latestDate: '10 Sep 2026',
    movement: 'declined',
  });
  assert.ok(/Kenmri Soto has 5 recorded assessments/.test(text), text);
  assert.ok(text.includes('first recorded overall result was 100% (On-Track) on 25 May 2026'), text);
  assert.ok(text.includes('latest is 0% (Delayed) on 10 Sep 2026'), text);
  assert.ok(/falls under the Delayed band/.test(text), text);
  assert.ok(/greater concern/.test(text), text);
  assert.ok(/not a diagnosis/.test(text), text);
}

function testPatientProgressionNeedsTwo() {
  const text = KC.formatPatientProgressionInterpretation({ name: 'Ana Reyes', assessmentCount: 1 });
  assert.ok(/fewer than two recorded assessments/.test(text), text);
}

function testPatientProgressionMissingScore() {
  const text = KC.formatPatientProgressionInterpretation({
    name: 'Ana Reyes', assessmentCount: 2,
    firstScore: null, firstBand: null, latestScore: 55, latestBand: 'at-risk', movement: 'unchanged',
  });
  // A missing score must not be printed as 0%.
  assert.ok(/no recorded score/.test(text), text);
  assert.ok(!/0%/.test(text), text);
}

function testRosterInterpretation() {
  const text = KC.formatPatientRosterInterpretation({
    patients: 25, withAssessment: 21, withoutAssessment: 4, withRepeatAssessments: 8, assessments: 31,
  });
  assert.ok(/lists 25 patients/.test(text), text);
  assert.ok(/31 recorded assessments/.test(text), text);
  assert.ok(/21 have at least one assessment/.test(text), text);
  assert.ok(/8 have more than one/.test(text), text);
  // Patients with no assessment must be acknowledged, not quietly dropped.
  assert.ok(/4 patients have no assessment in this range/.test(text), text);
}

function testRosterInterpretationAllAssessed() {
  const text = KC.formatPatientRosterInterpretation({
    patients: 3, withAssessment: 3, withoutAssessment: 0, withRepeatAssessments: 0, assessments: 3,
  });
  assert.ok(/Every listed patient has at least one assessment/.test(text), text);
}

function testRosterInterpretationEmpty() {
  assert.ok(/No patients match/.test(KC.formatPatientRosterInterpretation({ patients: 0 })));
}

function testMonthLabel() {
  assert.strictEqual(KC.formatMonthLabel('2026-08'), 'August 2026');
  assert.strictEqual(KC.formatMonthLabel('2026-01'), 'January 2026');
  assert.strictEqual(KC.formatMonthLabel('nonsense'), 'nonsense');
}

function testActivityInterpretation() {
  const text = KC.formatActivityInterpretation([
    { month: '2026-06', count: 1 },
    { month: '2026-07', count: 5 },
    { month: '2026-08', count: 19 },
    { month: '2026-09', count: 6 },
  ]);
  assert.ok(/31 assessments were recorded across 4 months/.test(text), text);
  assert.ok(/from June 2026 to September 2026/.test(text), text);
  assert.ok(/busiest month was August 2026 with 19/.test(text), text);
  // Activity says nothing clinical.
  assert.ok(/says nothing about the results/.test(text), text);
}

function testActivitySingleMonthAndEmpty() {
  const one = KC.formatActivityInterpretation([{ month: '2026-08', count: 1 }]);
  assert.ok(/1 assessment was recorded in August 2026/.test(one), one);
  assert.ok(!/busiest/.test(one), one);
  assert.ok(/no activity to chart/.test(KC.formatActivityInterpretation([])));
  assert.ok(/no activity to chart/.test(KC.formatActivityInterpretation(null)));
}

function run() {
  testDomainBandNoPatients();
  testDomainBandAllZeroNeedsSupport();
  testDomainBandLeader();
  testDomainBandTie();
  testOverallBandNoPatients();
  testOverallBandLeaderWithNeedsSupport();
  testOverallBandNoneNeedSupport();
  testProgressionCohortNoRepeats();
  testProgressionCohortMixed();
  testProgressionCohortSinglePatientWording();
  testDomainCountSentences();
  testDomainCountSentencesEmpty();
  testDomainCountSingularWording();
  testMovementDescriptions();
  testPatientProgressionInterpretation();
  testPatientProgressionNeedsTwo();
  testPatientProgressionMissingScore();
  testRosterInterpretation();
  testRosterInterpretationAllAssessed();
  testRosterInterpretationEmpty();
  testMonthLabel();
  testActivityInterpretation();
  testActivitySingleMonthAndEmpty();
  console.log('Pediatrician Reports interpretation rules OK — band leaders/ties, needs-support totals, cohort progression, per-domain counts, movement wording, per-patient history, roster totals, and activity summaries all verified');
}

run();
