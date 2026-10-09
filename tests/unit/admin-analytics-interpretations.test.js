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

function testComparisonNoteNotARanking() {
  const text = KC.formatPediatricianComparisonNote(0);
  assert.ok(!/ranked by/.test(text), 'the order must not be described as a ranking');
  assert.ok(/not a ranking of clinical skill, accuracy or effectiveness/.test(text));
  assert.ok(/no child has two or more reviewed assessments/.test(text), 'provably true with 0 reviews');
  const many = KC.formatPediatricianComparisonNote(5);
  assert.ok(!/no child has two or more reviewed assessments/.test(many),
    'with 2+ reviews the "no repeat review" claim is not verified, so it must not be stated');
}

// ── percentages and shares ──────────────────────────────────────────────────

function testPercentFormatting() {
  assert.strictEqual(KC.sharePercent(1207, 1720).toFixed(4), '70.1744');
  assert.strictEqual(KC.sharePercent(1, 0), null, 'no division by zero');
  assert.strictEqual(KC.sharePercent(5, 4), null, 'part larger than whole is not a share');
  assert.strictEqual(KC.sharePercent(undefined, 4), null);
  assert.strictEqual(KC.formatPercent(KC.sharePercent(1207, 1720)), '70.2%');
  assert.strictEqual(KC.formatPercent(null), 'N/A');
  assert.strictEqual(KC.formatPercent(Infinity), 'N/A');
  assert.strictEqual(KC.formatPercent(0.04), '<0.1%');
  assert.strictEqual(KC.formatSignedPercent(-48.249), '−48.2%');
  assert.strictEqual(KC.formatSignedPercent(12.46), '+12.5%');
  assert.strictEqual(KC.formatSignedPercent(-100), '−100.0%');
  assert.strictEqual(KC.formatSignedPercent(0.01), '0.0%');
  assert.strictEqual(KC.formatSignedPercent(null), 'N/A');
  assert.strictEqual(KC.formatCount(1506), '1,506');
  assert.strictEqual(KC.formatCount(undefined), '—');
}

// ── New sign-ups, month over month ──────────────────────────────────────────

function signupMonths(counts) {
  const labels = ['May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026'];
  return counts.map((count, i) => ({ month: labels[i], count }));
}

function testSignupChangeUsesFullMonths() {
  // Real shape on 2026-10-09: October (in progress) has 0 so far.
  const g = KC.computeSignupChange(signupMonths([166, 174, 169, 257, 133, 0]));
  assert.strictEqual(g.available, true);
  assert.strictEqual(g.latest.month, 'Sep 2026', 'latest FULL month, not the partial current one');
  assert.strictEqual(g.previous.month, 'Aug 2026', 'baseline is the month before it');
  assert.strictEqual(g.partial.month, 'Oct 2026');
  assert.strictEqual(KC.formatSignedPercent(g.change), '−48.2%', '(133 − 257) ÷ 257');
}

function testSignupChangeZeroBaseline() {
  const g = KC.computeSignupChange(signupMonths([0, 0, 0, 0, 7, 2]));
  assert.strictEqual(g.available, false);
  assert.strictEqual(g.reason, 'zero-baseline', 'never +100% or Infinity from a zero baseline');
}

function testSignupChangeRealDropToZero() {
  const g = KC.computeSignupChange(signupMonths([1, 1, 1, 10, 0, 3]));
  assert.strictEqual(g.available, true);
  assert.strictEqual(g.change, -100, 'a drop to zero from a non-zero baseline is a real −100%');
}

function testSignupChangeNotEnoughData() {
  assert.strictEqual(KC.computeSignupChange([]).reason, 'not-enough-months');
  assert.strictEqual(KC.computeSignupChange(undefined).reason, 'not-enough-months');
  assert.strictEqual(KC.computeSignupChange([{ month: 'a', count: 1 }, { month: 'b', count: 2 }]).reason, 'not-enough-months');
  assert.strictEqual(KC.computeSignupChange(signupMonths([1, 1, 1, null, 2, 0])).reason, 'missing');
}

// ── Assessment completion rate ───────────────────────────────────────────────

function testCompletionRate() {
  const c = KC.computeCompletionRate({ totalAssessments: 1720, completedScreenings: 1207, inProgressScreenings: 336 });
  assert.strictEqual(KC.formatPercent(c.rate), '70.2%', 'completed ÷ all sessions started');
  assert.strictEqual(c.submitted, 177, 'the remainder is the submitted sessions');
  const none = KC.computeCompletionRate({ totalAssessments: 0, completedScreenings: 0, inProgressScreenings: 0 });
  assert.strictEqual(none.rate, null, 'no sessions → N/A, not 0%');
  assert.strictEqual(KC.computeCompletionRate({}).rate, null);
}

// ── One denominator per table ────────────────────────────────────────────────

function testWithShares() {
  const appts = [
    { status: 'pending', count: 232 }, { status: 'approved', count: 291 }, { status: 'completed', count: 413 },
    { status: 'cancelled', count: 123 }, { status: 'rejected', count: 65 },
  ];
  const { total, rows } = KC.withShares(appts);
  assert.strictEqual(total, 1124, 'denominator includes cancelled and rejected');
  assert.strictEqual(KC.formatPercent(rows[0].share), '20.6%');
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.share, 0) - 100) < 1e-9, 'shares total 100%');
  const empty = KC.withShares([]);
  assert.strictEqual(empty.total, 0);
  assert.deepStrictEqual(KC.withShares([{ status: 'pending', count: 0 }]).rows[0].share, null, 'zero total → N/A');
}

// ── Score bands under the histogram ──────────────────────────────────────────

function testScoreBands() {
  const BANDS = [
    { key: 'on-track', label: 'On-Track', min: 80, max: 100 },
    { key: 'developing', label: 'Developing', min: 60, max: 79 },
    { key: 'at-risk', label: 'At-Risk', min: 40, max: 59 },
    { key: 'delayed', label: 'Delayed', min: 0, max: 39 },
  ];
  const b = bins([2, 2, 32, 60, 53, 97, 139, 169, 403, 250]);
  const bands = KC.summarizeScoreBands(b, BANDS);
  assert.deepStrictEqual(bands.map((x) => x.count), [653, 308, 150, 96]);
  assert.strictEqual(bands.reduce((s, x) => s + x.count, 0), 1207, 'every plotted assessment is in exactly one band');
  assert.strictEqual(KC.formatPercent(bands[0].share), '54.1%');
  assert.ok(KC.summarizeScoreBands(bins([]), BANDS).every((x) => x.share === null), 'empty → N/A');
}

// ── Monthly trend: gaps and the month in progress ───────────────────────────

function trendRow(month, total, c) {
  return { month, monthLabel: month, totalAssessments: total, communication: c, social: 0, cognitive: 0, motor: 0 };
}

function testPrepareMonthlyTrend() {
  const rows = [trendRow('2026-10', 4, 1), trendRow('2026-07', 174, 40), trendRow('2026-09', 295, 60)];
  const p = KC.prepareMonthlyTrend(rows, '2026-10');
  assert.deepStrictEqual(p.rows.map((r) => r.month), ['2026-07', '2026-08', '2026-09', '2026-10'],
    'sorted, with the missing month filled in');
  assert.strictEqual(p.rows[1].totalAssessments, 0, 'a filled month is a real zero');
  assert.strictEqual(p.rows[1].monthLabel, 'August 2026');
  assert.strictEqual(p.partialRow.month, '2026-10');
  assert.deepStrictEqual(p.completeRows.map((r) => r.month), ['2026-07', '2026-08', '2026-09'],
    'the month in progress is never compared');

  const summary = KC.computeMonitoringSummary(p.completeRows);
  assert.strictEqual(summary.latest.month, '2026-09', 'summary compares full months only');

  const yearWrap = KC.prepareMonthlyTrend([trendRow('2025-12', 2, 0), trendRow('2026-02', 7, 1)], '2026-10');
  assert.deepStrictEqual(yearWrap.rows.map((r) => r.month), ['2025-12', '2026-01', '2026-02']);
  assert.strictEqual(yearWrap.partialRow, null);

  assert.deepStrictEqual(KC.prepareMonthlyTrend(undefined, '2026-10').rows, []);
  assert.deepStrictEqual(KC.prepareMonthlyTrend([{ month: 'bad' }], '2026-10').rows, [], 'malformed keys are skipped');
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
  testComparisonNoteNotARanking();
  testPercentFormatting();
  testSignupChangeUsesFullMonths();
  testSignupChangeZeroBaseline();
  testSignupChangeRealDropToZero();
  testSignupChangeNotEnoughData();
  testCompletionRate();
  testWithShares();
  testScoreBands();
  testPrepareMonthlyTrend();
  console.log('Admin Analytics interpretation rules OK — histogram/domain leaders, ties, monthly trend change-detection, pediatrician-comparison wording, percentages/shares, sign-up change and month handling all verified');
}

run();
