// tests/unit/progression-interpretation.test.js
// Locks in the wording/decision rules for js/parent/progression-interpretation.js
// (the "Assessment Progression" chart interpretation shown on
// PARENT/results.html for both the parent and the pediatrician/admin view of
// the same page). Pure, no-DB, no-network tests — mirrors the structure of
// tests/unit/report-interpretations.test.js and
// tests/unit/admin-analytics-interpretations.test.js.

const assert = require('assert');
const KC = require('../../js/parent/progression-interpretation.js');

// ── scoreDirection / formatSignedPoints / directionWord ─────────────────────

function testScoreDirectionPositive() {
  assert.strictEqual(KC.scoreDirection(68, 55), 'positive');
}

function testScoreDirectionNegative() {
  assert.strictEqual(KC.scoreDirection(50, 65), 'negative');
}

function testScoreDirectionNone() {
  assert.strictEqual(KC.scoreDirection(60, 60), 'none');
}

function testScoreDirectionUnavailable() {
  assert.strictEqual(KC.scoreDirection(null, 60), 'unavailable');
  assert.strictEqual(KC.scoreDirection(60, null), 'unavailable');
}

function testFormatSignedPoints() {
  assert.strictEqual(KC.formatSignedPoints(13), '+13');
  assert.strictEqual(KC.formatSignedPoints(-7), '-7');
  assert.strictEqual(KC.formatSignedPoints(0), '0');
}

function testDirectionWord() {
  assert.strictEqual(KC.directionWord('positive'), 'Positive change');
  assert.strictEqual(KC.directionWord('negative'), 'Negative change');
  assert.strictEqual(KC.directionWord('none'), 'No change');
  assert.strictEqual(KC.directionWord('unavailable'), 'Not available');
}

// ── buildOverallProgressionInterpretation ────────────────────────────────────

function testMissingScores() {
  const text = KC.buildOverallProgressionInterpretation({ current: null, previous: 55 });
  assert.ok(/Not enough recorded score data/.test(text));
}

function testScoreIncreasedSameBand() {
  const text = KC.buildOverallProgressionInterpretation({
    current: 68, previous: 62,
    currentBandLabel: 'Developing', previousBandLabel: 'Developing',
    careStageDirection: 'no_change',
  });
  assert.ok(/increased from 62% to 68%, a change of \+6 point/.test(text));
  assert.ok(/stays within the "Developing" range/.test(text));
  assert.ok(!/worsened|Based on KinderCura's existing scoring and care-plan rules/.test(text));
}

function testScoreIncreasedBandChanged() {
  const text = KC.buildOverallProgressionInterpretation({
    current: 68, previous: 55,
    currentBandLabel: 'Developing', previousBandLabel: 'At-Risk',
    careStageDirection: 'improved',
  });
  assert.ok(/increased from 55% to 68%, a change of \+13 points/.test(text));
  assert.ok(/moved the result from the previous "At-Risk" range to the current "Developing" range/.test(text));
}

function testScoreDecreased() {
  const text = KC.buildOverallProgressionInterpretation({
    current: 50, previous: 65,
    currentBandLabel: 'At-Risk', previousBandLabel: 'Developing',
    careStageDirection: 'worsened',
    consultationLabel: 'Scheduled pediatric consultation',
    monitoringLabel: 'Continued parent monitoring',
  });
  assert.ok(/decreased from 65% to 50%, a change of -15 points/.test(text));
  assert.ok(/moved the result from the previous "Developing" range to the current "At-Risk" range/.test(text));
  assert.ok(/current result now corresponds to Scheduled pediatric consultation and Continued parent monitoring/.test(text));
  assert.ok(/not a medical diagnosis/.test(text));
}

function testWorsenedWithoutCarePlanLabelsFallsBackToGenericCaution() {
  const text = KC.buildOverallProgressionInterpretation({
    current: 50, previous: 65,
    currentBandLabel: 'At-Risk', previousBandLabel: 'Developing',
    careStageDirection: 'worsened',
    consultationLabel: null,
    monitoringLabel: null,
  });
  assert.ok(!/now corresponds to/.test(text));
  assert.ok(/does not by itself indicate a medical diagnosis or its cause/.test(text));
}

function testSameScoreSameBand() {
  const text = KC.buildOverallProgressionInterpretation({
    current: 72, previous: 72,
    currentBandLabel: 'Developing', previousBandLabel: 'Developing',
    careStageDirection: 'no_change',
  });
  assert.ok(/remained stable at 72%, unchanged/.test(text));
  assert.ok(/not by itself a sign of improvement or concern/.test(text));
}

function testSingularPointWording() {
  const text = KC.buildOverallProgressionInterpretation({
    current: 61, previous: 60,
    currentBandLabel: 'Developing', previousBandLabel: 'Developing',
    careStageDirection: 'no_change',
  });
  assert.ok(/a change of \+1 point compared/.test(text), 'must use singular "point" for a 1-point change');
}

function run() {
  testScoreDirectionPositive();
  testScoreDirectionNegative();
  testScoreDirectionNone();
  testScoreDirectionUnavailable();
  testFormatSignedPoints();
  testDirectionWord();
  testMissingScores();
  testScoreIncreasedSameBand();
  testScoreIncreasedBandChanged();
  testScoreDecreased();
  testWorsenedWithoutCarePlanLabelsFallsBackToGenericCaution();
  testSameScoreSameBand();
  testSingularPointWording();
  console.log('Assessment Progression interpretation rules OK — direction, band-change wording, care-plan callout, and stable/singular-point edge cases all verified');
}

run();
