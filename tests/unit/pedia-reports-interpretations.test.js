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
  console.log('Pediatrician Reports interpretation rules OK — domain/overall band leaders, ties, needs-support totals, and cohort progression wording all verified');
}

run();
