// tests/unit/admin-reports-interpretations.test.js
// Locks in the wording/decision rules for js/admin/admin-reports-interpretations.js
// (the "Demographic Profile of Late Development" and "Most Common
// Pediatrician Diagnosis" sections on ADMIN/admin-reports.html). Pure,
// no-DB, no-network tests — mirrors tests/unit/pedia-reports-interpretations.test.js.

const assert = require('assert');
const KC = require('../../js/admin/admin-reports-interpretations.js');

const GENDER_KEYS = ['male', 'female', 'other', 'unknown'];
const GENDER_LABELS = { male: 'Male', female: 'Female', other: 'Other', unknown: 'Not recorded' };

const AGE_KEYS = ['under_3', 'age_3', 'age_4', 'age_5', 'age_6', 'age_7_plus', 'unknown'];
const AGE_LABELS = {
  under_3: 'Under 3y', age_3: '3y', age_4: '4y', age_5: '5y', age_6: '6y',
  age_7_plus: '7y and older', unknown: 'Age not available',
};

// ── mostFrequentEntries ──────────────────────────────────────────────────────

function testModeNoData() {
  const mode = KC.mostFrequentEntries({ male: 0, female: 0 }, ['male', 'female']);
  assert.strictEqual(mode.hasData, false);
  assert.strictEqual(mode.total, 0);
  assert.deepStrictEqual(mode.leaders, []);
}

function testModeSingleLeader() {
  const mode = KC.mostFrequentEntries({ male: 5, female: 12 }, ['male', 'female']);
  assert.strictEqual(mode.hasData, true);
  assert.strictEqual(mode.total, 17);
  assert.strictEqual(mode.maxCount, 12);
  assert.deepStrictEqual(mode.leaders, ['female']);
}

function testModeTie() {
  const mode = KC.mostFrequentEntries({ male: 10, female: 10, other: 2 }, ['male', 'female', 'other']);
  assert.deepStrictEqual(mode.leaders, ['male', 'female']);
  assert.strictEqual(mode.maxCount, 10);
}

// ── formatGenderInterpretation ───────────────────────────────────────────────

function testGenderInterpretationZeroData() {
  const counts = { male: 0, female: 0, other: 0, unknown: 0 };
  const text = KC.formatGenderInterpretation(counts, GENDER_KEYS, GENDER_LABELS);
  assert.ok(/No assessments in the selected range are classified as Delayed/.test(text));
}

function testGenderInterpretationSingleLeader() {
  const counts = { male: 15, female: 20, other: 1, unknown: 0 };
  const text = KC.formatGenderInterpretation(counts, GENDER_KEYS, GENDER_LABELS);
  assert.ok(/Among the 36 assessments classified as Delayed/.test(text));
  assert.ok(/Female account/.test(text));
  assert.ok(/Male account/.test(text));
  assert.ok(/The gender with the highest recorded count is Female, with 20 cases\./.test(text));
  assert.ok(!/tied/.test(text));
  assert.ok(/does not indicate that any gender causes, or is more biologically prone to, developmental delay/.test(text));
}

function testGenderInterpretationTie() {
  const counts = { male: 10, female: 10, other: 0, unknown: 0 };
  const text = KC.formatGenderInterpretation(counts, GENDER_KEYS, GENDER_LABELS);
  assert.ok(/Male and Female are tied for the highest recorded count, each with 10 cases\./.test(text));
}

function testGenderInterpretationSingularWording() {
  const counts = { male: 1, female: 0, other: 0, unknown: 0 };
  const text = KC.formatGenderInterpretation(counts, GENDER_KEYS, GENDER_LABELS);
  assert.ok(/Among the 1 assessment classified as Delayed/.test(text));
  assert.ok(/The gender with the highest recorded count is Male, with 1 case\./.test(text));
}

function testGenderInterpretationIncludesUnrecorded() {
  const counts = { male: 3, female: 2, other: 0, unknown: 5 };
  const text = KC.formatGenderInterpretation(counts, GENDER_KEYS, GENDER_LABELS);
  assert.ok(/Not recorded account/.test(text));
  assert.ok(/The gender with the highest recorded count is Not recorded, with 5 cases\./.test(text));
}

// ── formatAgeRangeInterpretation ─────────────────────────────────────────────

function testAgeInterpretationZeroData() {
  const counts = Object.fromEntries(AGE_KEYS.map((k) => [k, 0]));
  const text = KC.formatAgeRangeInterpretation(counts, AGE_KEYS, AGE_LABELS);
  assert.ok(/No assessments in the selected range are classified as Delayed/.test(text));
}

function testAgeInterpretationSingleLeader() {
  const counts = { under_3: 1, age_3: 4, age_4: 9, age_5: 3, age_6: 2, age_7_plus: 0, unknown: 0 };
  const text = KC.formatAgeRangeInterpretation(counts, AGE_KEYS, AGE_LABELS);
  assert.ok(/The 4y age range has the highest recorded count, with 9 cases\./.test(text));
  assert.ok(/age at the time of assessment/.test(text));
  // Regression: the per-band breakdown clause must end its own sentence with
  // a period before the capitalized lead sentence starts — not a comma
  // splice like "...2 cases), The 4y age range...".
  assert.ok(!/\),\s*The\s/.test(text), 'must not comma-splice into the capitalized lead sentence');
  assert.ok(/cases\. The 4y age range/.test(text));
}

function testAgeInterpretationTie() {
  const counts = { under_3: 0, age_3: 5, age_4: 5, age_5: 0, age_6: 0, age_7_plus: 0, unknown: 0 };
  const text = KC.formatAgeRangeInterpretation(counts, AGE_KEYS, AGE_LABELS);
  assert.ok(/3y and 4y are tied for the highest recorded count, each with 5 cases\./.test(text));
}

// ── formatDiagnosisInterpretation ────────────────────────────────────────────

function testDiagnosisInterpretationZero() {
  const text = KC.formatDiagnosisInterpretation({ totalConsidered: 0, rows: [], topCount: 0, topDiagnoses: [], tie: false });
  assert.strictEqual(text, 'No pediatrician diagnoses have been recorded in the selected report range.');
}

function testDiagnosisInterpretationSingleMode() {
  const df = {
    totalConsidered: 39,
    rows: [{ diagnosis: 'Speech Delay', count: 18 }, { diagnosis: 'Developmental Delay', count: 12 }, { diagnosis: 'Language Delay', count: 9 }],
    topCount: 18,
    topDiagnoses: ['Speech Delay'],
    tie: false,
  };
  const text = KC.formatDiagnosisInterpretation(df);
  assert.ok(/Speech Delay is the most frequently recorded diagnosis, appearing in 18 of 39 recorded diagnoses \(46%\)/.test(text));
  assert.ok(/is not a clinical conclusion on its own/.test(text));
}

function testDiagnosisInterpretationTie() {
  const df = {
    totalConsidered: 20,
    rows: [{ diagnosis: 'Speech Delay', count: 10 }, { diagnosis: 'Motor Delay', count: 10 }],
    topCount: 10,
    topDiagnoses: ['Motor Delay', 'Speech Delay'],
    tie: true,
  };
  const text = KC.formatDiagnosisInterpretation(df);
  assert.ok(/Motor Delay and Speech Delay are tied as the most frequently recorded diagnoses, each appearing in 10 of 20 recorded diagnoses \(50%\)/.test(text));
}

function run() {
  testModeNoData();
  testModeSingleLeader();
  testModeTie();
  testGenderInterpretationZeroData();
  testGenderInterpretationSingleLeader();
  testGenderInterpretationTie();
  testGenderInterpretationSingularWording();
  testGenderInterpretationIncludesUnrecorded();
  testAgeInterpretationZeroData();
  testAgeInterpretationSingleLeader();
  testAgeInterpretationTie();
  testDiagnosisInterpretationZero();
  testDiagnosisInterpretationSingleMode();
  testDiagnosisInterpretationTie();
  console.log('Admin Reports demographic/diagnosis interpretation rules OK — gender/age mode, ties, zero-data, singular wording, and diagnosis summary all verified');
}

run();
