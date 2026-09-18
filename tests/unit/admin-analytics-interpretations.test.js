// tests/unit/admin-analytics-interpretations.test.js
// Locks in the wording/decision rules for js/admin/analytics-interpretations.js
// (the Admin Analytics assessment-monitoring interpretation helpers) with
// pure, no-DB, no-network tests. Covers: histogram leader/tie/empty, domain
// leader/tie/all-zero, monthly-summary no-data/one-month/changed/unchanged/
// tie, and the pediatrician-comparison note/row text.

const assert = require('assert');
const KC = require('../../js/admin/analytics-interpretations.js');

function bins(counts) {
  const ranges = ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100'];
  return ranges.map((range, i) => ({ range, count: counts[i] || 0 }));
}

// ── formatHistogramInterpretation ───────────────────────────────────────────

function testHistogramLeader() {
  const b = bins([2, 2, 32, 60, 53, 96, 137, 169, 402, 250]);
  const text = KC.formatHistogramInterpretation(b, 1203);
  assert.ok(/80-89 score range/.test(text));
  assert.ok(/402 recorded assessments out of 1203 total/.test(text));
  assert.ok(/does not by itself indicate a diagnosis/.test(text));
}

function testHistogramTie() {
  const b = bins([0, 0, 0, 0, 0, 5, 0, 5, 0, 0]);
  const text = KC.formatHistogramInterpretation(b, 10);
  assert.ok(/50-59 and 70-79 score ranges \(tied\)/.test(text));
  assert.ok(/5 recorded assessments out of 10 total/.test(text));
}

function testHistogramEmpty() {
  const text = KC.formatHistogramInterpretation(bins([0,0,0,0,0,0,0,0,0,0]), 0);
  assert.ok(/No completed assessments with a recorded score/.test(text));
}

function testHistogramSingularCount() {
  const b = bins([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const text = KC.formatHistogramInterpretation(b, 1);
  assert.ok(/1 recorded assessment out of 1 total/.test(text), 'must use singular "assessment" for count 1');
}

// ── formatDomainInterpretation ──────────────────────────────────────────────

function testDomainLeader() {
  const text = KC.formatDomainInterpretation({ communication: 315, social: 271, cognitive: 330, motor: 253, total: 1203 });
  assert.ok(/Cognitive has the highest number of results/.test(text));
  assert.ok(/330 out of 1203 completed assessments/.test(text));
  assert.ok(/not a diagnosis/.test(text));
}

function testDomainTie() {
  const text = KC.formatDomainInterpretation({ communication: 10, social: 10, cognitive: 4, motor: 4, total: 50 });
  assert.ok(/Communication and Social Skills are tied for the highest number of results/.test(text));
}

function testDomainAllZero() {
  const text = KC.formatDomainInterpretation({ communication: 0, social: 0, cognitive: 0, motor: 0, total: 20 });
  assert.ok(/None of the 20 recorded completed assessments/.test(text));
}

function testDomainNoData() {
  const text = KC.formatDomainInterpretation({ communication: 0, social: 0, cognitive: 0, motor: 0, total: 0 });
  assert.ok(/No completed assessments are available yet/.test(text));
}

// ── computeMonitoringSummary ─────────────────────────────────────────────────

function month(label, key, counts) {
  return { month: key, monthLabel: label, totalAssessments: Object.values(counts).reduce((a,b)=>a+b,0),
    communication: counts.communication || 0, social: counts.social || 0, cognitive: counts.cognitive || 0, motor: counts.motor || 0 };
}

function testSummaryNoData() {
  const s = KC.computeMonitoringSummary([]);
  assert.strictEqual(s.hasData, false);
  assert.ok(/Not enough completed assessment data/.test(s.trendText));
}

function testSummaryOneMonth() {
  const rows = [month('September 2026', '2026-09', { communication: 5, social: 2, cognitive: 8, motor: 1 })];
  const s = KC.computeMonitoringSummary(rows);
  assert.strictEqual(s.hasData, true);
  assert.strictEqual(s.hasComparison, false);
  assert.strictEqual(s.latestLeadLabel, 'Cognitive');
  assert.strictEqual(s.latestLeadCount, 8);
  assert.strictEqual(s.latestTotal, 16);
  assert.ok(/Only one month of assessment data is available \(September 2026\)/.test(s.trendText));
}

function testSummaryChanged() {
  const rows = [
    month('August 2026', '2026-08', { communication: 30, social: 10, cognitive: 5, motor: 5 }),
    month('September 2026', '2026-09', { communication: 10, social: 5, cognitive: 42, motor: 8 }),
  ];
  const s = KC.computeMonitoringSummary(rows);
  assert.strictEqual(s.hasComparison, true);
  assert.strictEqual(s.previousLeadLabel, 'Communication');
  assert.strictEqual(s.latestLeadLabel, 'Cognitive');
  assert.strictEqual(s.latestLeadCount, 42);
  assert.strictEqual(s.changed, true);
  assert.ok(/Leading monitoring area changed from Communication in August 2026 to Cognitive in September 2026\./.test(s.trendText));
}

function testSummaryUnchanged() {
  const rows = [
    month('August 2026', '2026-08', { communication: 5, social: 5, cognitive: 20, motor: 5 }),
    month('September 2026', '2026-09', { communication: 10, social: 5, cognitive: 42, motor: 8 }),
  ];
  const s = KC.computeMonitoringSummary(rows);
  assert.strictEqual(s.changed, false);
  assert.ok(/Cognitive remained the leading monitoring area from August 2026 to September 2026\./.test(s.trendText));
}

function testSummaryTieCountsAsUnchangedOnlyWhenSameSet() {
  // Latest month has a two-way tie that includes the previous month's sole leader.
  const rows = [
    month('August 2026', '2026-08', { communication: 20, social: 5, cognitive: 5, motor: 5 }),
    month('September 2026', '2026-09', { communication: 20, social: 20, cognitive: 5, motor: 5 }),
  ];
  const s = KC.computeMonitoringSummary(rows);
  assert.strictEqual(s.latestLeadLabel, 'Communication and Social Skills');
  // The leader SET changed (Communication alone -> tie), so this counts as changed.
  assert.strictEqual(s.changed, true);
}

function testSummaryBothMonthsZero() {
  const rows = [
    month('July 2026', '2026-07', { communication: 0, social: 0, cognitive: 0, motor: 0 }),
    month('August 2026', '2026-08', { communication: 0, social: 0, cognitive: 0, motor: 0 }),
  ];
  const s = KC.computeMonitoringSummary(rows);
  assert.ok(/Neither July 2026 nor August 2026 recorded any needs-support results/.test(s.trendText));
}

// ── pediatrician comparison text ────────────────────────────────────────────

function testComparisonNoteZeroReviewed() {
  const text = KC.formatPediatricianComparisonNote(0);
  assert.ok(/no completed assessments have been reviewed by a pediatrician yet/.test(text));
  assert.ok(/not pediatrician performance or effectiveness/.test(text));
}

function testComparisonNoteSomeReviewed() {
  const text = KC.formatPediatricianComparisonNote(2);
  assert.ok(/only 2 completed assessments have been reviewed by a pediatrician/.test(text));
}

function testComparisonNoteOneReviewed() {
  const text = KC.formatPediatricianComparisonNote(1);
  assert.ok(/only 1 completed assessment has been reviewed by a pediatrician/.test(text));
}

function testRowInterpretationWithData() {
  const text = KC.formatPediatricianRowInterpretation({ relevantChildren: 25, completedAssessments: 31, needsSupportCases: 12 });
  assert.strictEqual(text, '12 of 31 completed assessments among 25 relevant children fall in the needs-support range.');
}

function testRowInterpretationNoAssessments() {
  const text = KC.formatPediatricianRowInterpretation({ relevantChildren: 1, completedAssessments: 0, needsSupportCases: 0 });
  assert.strictEqual(text, '1 relevant child, no completed assessments recorded yet.');
}

function run() {
  testHistogramLeader();
  testHistogramTie();
  testHistogramEmpty();
  testHistogramSingularCount();
  testDomainLeader();
  testDomainTie();
  testDomainAllZero();
  testDomainNoData();
  testSummaryNoData();
  testSummaryOneMonth();
  testSummaryChanged();
  testSummaryUnchanged();
  testSummaryTieCountsAsUnchangedOnlyWhenSameSet();
  testSummaryBothMonthsZero();
  testComparisonNoteZeroReviewed();
  testComparisonNoteSomeReviewed();
  testComparisonNoteOneReviewed();
  testRowInterpretationWithData();
  testRowInterpretationNoAssessments();
  console.log('Admin Analytics interpretation rules OK — histogram/domain leaders, ties, monthly trend change-detection, and pediatrician-comparison wording all verified');
}

run();
