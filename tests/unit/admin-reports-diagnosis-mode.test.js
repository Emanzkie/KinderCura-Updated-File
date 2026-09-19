// tests/unit/admin-reports-diagnosis-mode.test.js
// Locks in the wording/decision rules for routes/admin-reports.js's
// computeDiagnosisMode (the adviser's "most common pediatrician diagnosis"
// requirement). Pure, no-DB, no-network — exercises the function through
// router.__testables (see routes/assessments.js for the same exposure
// pattern) with fake pre-grouped rows shaped exactly like the `diagnosisRaw`
// $facet branch would produce.
//
// Covers: basic mode, case/whitespace normalization merging variants while
// picking the most-recorded ORIGINAL spelling as the display text, ties,
// zero records, and sort order.

const assert = require('assert');
const { computeDiagnosisMode } = require('../../routes/admin-reports.js').__testables;

/** One {key, text} variant row, shaped like the diagnosisRaw $group output. */
function variant(text, count, key) {
  return { _id: { key: key || text.trim().toLowerCase(), text }, count };
}

function testBasicMode() {
  const rows = [
    variant('Speech Delay', 18),
    variant('Developmental Delay', 12),
    variant('Language Delay', 9),
  ];
  const result = computeDiagnosisMode(rows);
  assert.strictEqual(result.totalConsidered, 39);
  assert.strictEqual(result.topCount, 18);
  assert.deepStrictEqual(result.topDiagnoses, ['Speech Delay']);
  assert.strictEqual(result.tie, false);
  assert.deepStrictEqual(result.rows, [
    { diagnosis: 'Speech Delay', count: 18 },
    { diagnosis: 'Developmental Delay', count: 12 },
    { diagnosis: 'Language Delay', count: 9 },
  ]);
}

function testCaseAndWhitespaceNormalizationMerges() {
  // Three variants of the same wording, all sharing the same normalized key
  // (as the $group stage in Mongo would already have produced).
  const rows = [
    variant('Speech Delay', 15, 'speech delay'),
    variant('speech delay', 3, 'speech delay'),
    variant(' Speech Delay ', 1, 'speech delay'),
    variant('Developmental Delay', 5, 'developmental delay'),
  ];
  const result = computeDiagnosisMode(rows);
  // All three "speech delay" variants merged into one row, total 15+3+1 = 19.
  assert.strictEqual(result.rows.length, 2);
  const speechRow = result.rows.find((r) => r.diagnosis === 'Speech Delay');
  assert.ok(speechRow, 'the most-recorded exact spelling ("Speech Delay") must be the display text');
  assert.strictEqual(speechRow.count, 19);
  assert.strictEqual(result.topCount, 19);
  assert.deepStrictEqual(result.topDiagnoses, ['Speech Delay']);
  assert.strictEqual(result.totalConsidered, 24);
}

function testDisplayTextNeverRewritten() {
  // The merged group's display text must be one of the ACTUAL recorded
  // strings, never a synthesized/lowercased canonical form.
  const rows = [
    variant('ADHD suspected', 4, 'adhd suspected'),
    variant('adhd suspected', 4, 'adhd suspected'),
  ];
  const result = computeDiagnosisMode(rows);
  assert.strictEqual(result.rows.length, 1);
  // Equal counts within the group: alphabetical tie-break ("ADHD..." < "adhd..." by localeCompare is unspecified case order,
  // so just assert the text is one of the two ACTUAL recorded variants — never invented.
  assert.ok(['ADHD suspected', 'adhd suspected'].includes(result.rows[0].diagnosis));
  assert.strictEqual(result.rows[0].count, 8);
}

function testTieAcrossDistinctDiagnoses() {
  const rows = [
    variant('Speech Delay', 10),
    variant('Motor Delay', 10),
    variant('Cognitive Concern', 4),
  ];
  const result = computeDiagnosisMode(rows);
  assert.strictEqual(result.tie, true);
  assert.strictEqual(result.topCount, 10);
  assert.deepStrictEqual(result.topDiagnoses.slice().sort(), ['Motor Delay', 'Speech Delay']);
  // Both tied rows must appear in the frequency table, not just one arbitrarily kept.
  assert.strictEqual(result.rows.filter((r) => r.count === 10).length, 2);
}

function testZeroRecords() {
  const result = computeDiagnosisMode([]);
  assert.strictEqual(result.totalConsidered, 0);
  assert.strictEqual(result.topCount, 0);
  assert.deepStrictEqual(result.topDiagnoses, []);
  assert.deepStrictEqual(result.rows, []);
  assert.strictEqual(result.tie, false);
}

function testNullOrUndefinedInput() {
  // Defensive: a caller passing null/undefined (e.g. an empty facet branch)
  // must not throw.
  assert.deepStrictEqual(computeDiagnosisMode(null), {
    totalConsidered: 0, rows: [], topCount: 0, topDiagnoses: [], tie: false,
  });
  assert.deepStrictEqual(computeDiagnosisMode(undefined), {
    totalConsidered: 0, rows: [], topCount: 0, topDiagnoses: [], tie: false,
  });
}

function testSortOrderIsFrequencyDescending() {
  const rows = [
    variant('C Diagnosis', 3),
    variant('A Diagnosis', 9),
    variant('B Diagnosis', 6),
  ];
  const result = computeDiagnosisMode(rows);
  assert.deepStrictEqual(result.rows.map((r) => r.diagnosis), ['A Diagnosis', 'B Diagnosis', 'C Diagnosis']);
}

function run() {
  testBasicMode();
  testCaseAndWhitespaceNormalizationMerges();
  testDisplayTextNeverRewritten();
  testTieAcrossDistinctDiagnoses();
  testZeroRecords();
  testNullOrUndefinedInput();
  testSortOrderIsFrequencyDescending();
  console.log('Admin Reports diagnosis-mode rules OK — normalization merging, display-text preservation, ties, zero-records, and sort order all verified');
}

run();
