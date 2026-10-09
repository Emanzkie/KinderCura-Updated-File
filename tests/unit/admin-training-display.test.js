// tests/unit/admin-training-display.test.js
//
// js/admin/training-display.js — display helpers for the Admin Training page.
// No DB, no network, no Python: nothing here trains, activates or predicts.
//
// Fixtures are values copied from stored records (read-only check on
// 2026-10-09): Model v4's recorded metrics and the pipeline dataset's
// ml/preprocess.py cleaning report. They also verify the claims the page's
// metric glossary makes about weighted averaging.
const assert = require('assert');
const TD = require('../../js/admin/training-display');

// Model v4 as recorded by ml/trainer.py (TEST split, average="weighted").
const V4 = {
  accuracy: 0.632,
  precision: 0.6287,
  recall: 0.632,
  f1Score: 0.6297,
  perClassMetrics: {
    High: { precision: 0.6744, recall: 0.7123, f1: 0.6928, support: 3027 },
    Low: { precision: 0.6638, recall: 0.6965, f1: 0.6797, support: 2942 },
    Medium: { precision: 0.5666, recall: 0.5208, f1: 0.5428, support: 3894 },
  },
  classDistribution: { Medium: 19469, High: 15133, Low: 14709 },
  testSamples: 9863,
};

// The 49,311-record pipeline dataset's stored cleaning report.
const CLEANING = {
  originalRecords: 50179,
  validRecords: 49528,
  invalidRecords: 651,
  duplicatesRemoved: 217,
  finalRecords: 49311,
  rejectionsByReason: {
    invalid_or_missing_risk_category: 163,
    missing_or_non_numeric_score: 152,
    score_out_of_range_0_100: 163,
    unrecognized_answer_value: 173,
  },
  missingValuesFilled: { age_months: { filled: 170, strategy: 'median', value: 66 } },
};

function weighted(rows, key) {
  const total = rows.reduce((s, r) => s + r.testRows, 0);
  return rows.reduce((s, r) => s + r[key] * r.testRows, 0) / total;
}

function testPerClassRows() {
  const rows = TD.perClassRows(V4.perClassMetrics, V4.classDistribution);
  assert.deepStrictEqual(rows.map((r) => r.cls), ['Low', 'Medium', 'High'], 'Low, Medium, High order');
  assert.strictEqual(rows.reduce((s, r) => s + r.testRows, 0), V4.testSamples, 'support sums to the test rows');
  assert.strictEqual(rows.find((r) => r.cls === 'Medium').allRows, 19469);
  assert.deepStrictEqual(TD.perClassRows(undefined, undefined), [], 'older models without per-class metrics');
  assert.strictEqual(TD.perClassRows({ Low: { precision: 1, recall: 1, f1: 1, support: 3 } }, null)[0].allRows, null);
}

// The glossary says: weighted recall always equals accuracy, and weighted F1
// is NOT the harmonic mean of the weighted precision and recall shown.
function testGlossaryClaimsHoldForStoredMetrics() {
  const rows = TD.perClassRows(V4.perClassMetrics, V4.classDistribution);
  assert.ok(Math.abs(weighted(rows, 'recall') - V4.accuracy) < 1e-3, 'weighted recall = accuracy');
  assert.ok(Math.abs(weighted(rows, 'recall') - V4.recall) < 1e-3, 'stored recall is the weighted average');
  assert.ok(Math.abs(weighted(rows, 'precision') - V4.precision) < 1e-3, 'stored precision is the weighted average');
  assert.ok(Math.abs(weighted(rows, 'f1') - V4.f1Score) < 1e-3, 'stored F1 is the weighted per-class average');
  const harmonic = (2 * V4.precision * V4.recall) / (V4.precision + V4.recall);
  assert.notStrictEqual(harmonic.toFixed(4), V4.f1Score.toFixed(4),
    'F1 shown differs from the harmonic mean of the weighted precision and recall');
}

function testDescribeCleaning() {
  const c = TD.describeCleaning(CLEANING);
  assert.strictEqual(c.reconciles, true, '50,179 − 217 − 651 = 49,311');
  assert.strictEqual(c.reasonsTotal, 651);
  assert.strictEqual(c.reasonsMatchInvalid, true, 'each invalid row is counted under one reason');
  assert.strictEqual(c.valid, 49528, 'valid = generated − invalid (duplicates still counted)');
  assert.ok(c.valid > c.final, 'valid is larger than training-ready');
  assert.strictEqual(c.reasons[0].label, 'Unrecognized question answer value', 'largest reason first');
  assert.deepStrictEqual(c.filled, [{ column: 'age_months', filled: 170, strategy: 'median', value: 66 }]);

  const broken = TD.describeCleaning({ ...CLEANING, finalRecords: 49000, rejectionsByReason: { score_out_of_range_0_100: 5 } });
  assert.strictEqual(broken.reconciles, false, 'a mismatch is surfaced, not hidden');
  assert.strictEqual(broken.reasonsMatchInvalid, false);

  const empty = TD.describeCleaning(undefined);
  assert.strictEqual(empty.generated, null);
  assert.strictEqual(empty.reconciles, null, 'unknown, not true or false');
  assert.strictEqual(empty.reasonsMatchInvalid, null);
}

function testFormatting() {
  assert.strictEqual(TD.formatFraction(0.6969), '69.7%');
  assert.strictEqual(TD.formatFraction(0.6969, 2), '69.69%');
  assert.strictEqual(TD.formatFraction(undefined), '—', 'no metric is not 0%');
  assert.strictEqual(TD.formatCount(40000), '40,000');
  assert.strictEqual(TD.formatCount(null), '—');
  assert.strictEqual(TD.rejectionLabel('age_months_implausible'), 'Implausible age (age_months)');
  assert.strictEqual(TD.rejectionLabel('some_new_reason'), 'some new reason', 'unknown reasons are kept, not dropped');
  assert.deepStrictEqual(TD.orderedClasses(['High', 'Low', 'Medium', 'Other']), ['Low', 'Medium', 'High', 'Other']);
}

function run() {
  testPerClassRows();
  testGlossaryClaimsHoldForStoredMetrics();
  testDescribeCleaning();
  testFormatting();
  console.log('Admin Training display helpers OK — per-class rows, weighted-metric glossary claims, cleaning accounting, formatting');
}

run();
