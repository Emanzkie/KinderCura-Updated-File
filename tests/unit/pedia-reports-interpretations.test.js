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

// ── Assessment activity over time ──────────────────────────────────────────

function testActivityIntervalChoice() {
  assert.strictEqual(KC.chooseActivityInterval('2026-10-01', '2026-10-31'), 'day');
  assert.strictEqual(KC.chooseActivityInterval('2026-10-01', '2026-11-01'), 'week');
  assert.strictEqual(KC.chooseActivityInterval('2026-04-01', '2026-09-30'), 'week');
  assert.strictEqual(KC.chooseActivityInterval('2026-01-01', '2026-10-16'), 'month');
  assert.strictEqual(KC.chooseActivityInterval(null, '2026-10-16'), 'month');
}

function testActivitySeriesDailyZeroFilled() {
  const series = KC.buildActivitySeries(
    ['2026-10-04', '2026-10-02', '2026-10-04', '2026-10-04', '2026-10-02'],
    'day', '2026-10-02', '2026-10-05',
  );
  assert.deepStrictEqual(series.map((r) => [r.key, r.count]), [
    ['2026-10-02', 2], ['2026-10-03', 0], ['2026-10-04', 3], ['2026-10-05', 0],
  ]);
  assert.strictEqual(series[0].label, 'Oct 2, 2026');
}

function testActivitySeriesWeeklyAndMonthly() {
  // 2026-10-04 is a Sunday, 2026-10-05 a Monday: different weeks.
  const weekly = KC.buildActivitySeries(['2026-09-28', '2026-10-04', '2026-10-05'], 'week', null, null);
  assert.deepStrictEqual(weekly.map((r) => [r.key, r.count]), [['2026-09-28', 2], ['2026-10-05', 1]]);
  assert.strictEqual(weekly[0].label, 'Week of Sep 28, 2026');
  assert.strictEqual(weekly[0].rangeLabel, 'Sep 28, 2026 – Oct 4, 2026');

  const monthly = KC.buildActivitySeries(['2026-11-30', '2027-01-02'], 'month', null, null);
  assert.deepStrictEqual(monthly.map((r) => [r.label, r.count]), [
    ['November 2026', 1], ['December 2026', 0], ['January 2027', 1],
  ]);
}

function testActivitySeriesNeverDropsAnAssessment() {
  // A day outside the requested bounds widens the series instead of vanishing.
  const series = KC.buildActivitySeries(['2026-10-01', '2026-10-09'], 'day', '2026-10-02', '2026-10-08');
  assert.strictEqual(series.reduce((s, r) => s + r.count, 0), 2);
  assert.strictEqual(series[0].key, '2026-10-01');
  assert.strictEqual(series[series.length - 1].key, '2026-10-09');
  assert.deepStrictEqual(KC.buildActivitySeries([], 'day', null, null), []);
}

function testActivityTrendInterpretation() {
  const series = KC.buildActivitySeries(['2026-10-02', '2026-10-02', '2026-10-04', '2026-10-04', '2026-10-04'], 'day', '2026-10-02', '2026-10-04');
  const text = KC.formatActivityTrendInterpretation(series, 'day');
  assert.ok(/A total of 5 assessments were recorded during the selected period/.test(text), text);
  assert.ok(/from Oct 2, 2026 to Oct 4, 2026, shown per day/.test(text), text);
  assert.ok(/highest activity occurred on Oct 4, 2026, with 3 assessments/.test(text), text);
  assert.ok(/2 of 3 days had at least one assessment/.test(text), text);
  assert.ok(/does not mean that any patient's development improved/.test(text), text);

  const weekly = KC.buildActivitySeries(['2026-09-28', '2026-10-05'], 'week', null, null);
  const tie = KC.formatActivityTrendInterpretation(weekly, 'week');
  assert.ok(/1 assessment, occurred in the week of Sep 28, 2026 – Oct 4, 2026 and the week of Oct 5, 2026 – Oct 11, 2026/.test(tie), tie);

  assert.ok(/no activity to describe/.test(KC.formatActivityTrendInterpretation([], 'day')));
  assert.ok(/no activity to describe/.test(KC.formatActivityTrendInterpretation(null, 'day')));
}

// ── Patient Development Progress ───────────────────────────────────────────

function testDevelopmentProgressComparison() {
  const text = KC.formatDevelopmentProgressInterpretation('Kemri Soto', [
    { date: 'May 4, 2026', scores: { communication: 50, social: 83, cognitive: 63, motor: null }, overallScore: 56 },
    { date: 'Jun 1, 2026', scores: { communication: 40, social: 83, cognitive: 70, motor: 60 }, overallScore: 60 },
    { date: 'Oct 14, 2026', scores: { communication: 70, social: 83, cognitive: 55, motor: 60 }, overallScore: 67 },
  ]);
  assert.ok(/first assessment in the selected period \(May 4, 2026\) with the latest \(Oct 14, 2026\), out of 3/.test(text), text);
  assert.ok(/The recorded Communication score increased from 50 to 70 \(\+20 pts\)/.test(text), text);
  assert.ok(/The recorded Social Skills score remained unchanged at 83/.test(text), text);
  assert.ok(/The recorded Cognitive score decreased from 63 to 55 \(-8 pts\)/.test(text), text);
  // A missing score is reported as missing, never compared as 0.
  assert.ok(/Motor Skills could not be compared because a score is missing/.test(text), text);
  assert.ok(/overall assessment score increased from 56% to 67%/.test(text), text);
  assert.ok(/Assessments in between/.test(text), text);
  assert.ok(/do not replace professional clinical evaluation/.test(text), text);
  // Never claims a cure; the only mention of recovery is the disclaimer.
  assert.ok(!/cured/i.test(text), text);
  assert.ok(/do not show that a child has recovered/.test(text), text);
}

function testDevelopmentProgressNeedsTwo() {
  const one = KC.formatDevelopmentProgressInterpretation('Chan', [
    { date: 'May 4, 2026', scores: { communication: 50, social: 45, cognitive: 63, motor: 65 }, overallScore: 56 },
  ]);
  assert.ok(/insufficient historical data to determine a trend/.test(one), one);
  assert.ok(!/increased|decreased/.test(one), one);
  assert.ok(/no recorded assessment/.test(KC.formatDevelopmentProgressInterpretation('Chan', [])));
}

function testDevelopmentChangeSummary() {
  const summary = KC.buildDevelopmentChangeSummary([
    { date: 'May 4, 2026', scores: { communication: 50, social: 0, cognitive: 63, motor: 40 }, overallScore: 38 },
    { date: 'Jun 1, 2026', scores: { communication: 69, social: 83, cognitive: null, motor: null }, overallScore: 56 },
    { date: 'Oct 14, 2026', scores: { communication: 61, social: 83, cognitive: 0, motor: null }, overallScore: 48 },
  ]);
  const byKey = Object.fromEntries(summary.domains.map((d) => [d.key, d]));
  // Latest vs the assessment just before it.
  assert.deepStrictEqual(byKey.communication.latest, { date: 'Oct 14, 2026', score: 61 });
  assert.strictEqual(byKey.communication.change, -8);
  assert.strictEqual(KC.formatChangeSentence('Communication', byKey.communication),
    'Communication: 61/100, down 8 points from the previous recorded assessment (Jun 1, 2026).');
  assert.strictEqual(byKey.social.change, 0);
  // A stored 0 is a recorded score: it is compared, and a missing score in
  // between is skipped instead of being read as 0.
  assert.deepStrictEqual(byKey.cognitive.latest, { date: 'Oct 14, 2026', score: 0 });
  assert.deepStrictEqual(byKey.cognitive.previous, { date: 'May 4, 2026', score: 63 });
  assert.strictEqual(byKey.cognitive.change, -63);
  // Motor's last stored score is the first assessment; nothing earlier to compare.
  assert.deepStrictEqual(byKey.motor.latest, { date: 'May 4, 2026', score: 40 });
  assert.strictEqual(byKey.motor.previous, null);
  assert.strictEqual(byKey.motor.change, null);
  assert.ok(/no earlier recorded score/.test(KC.formatChangeSentence('Motor Skills', byKey.motor)));
  assert.strictEqual(summary.overall.change, -8);
  assert.strictEqual(KC.formatChangeSentence('Overall score', summary.overall, '%'),
    'Overall score: 48%, down 8 points from the previous recorded assessment (Jun 1, 2026).');
  assert.ok(/no score is stored/.test(KC.formatChangeSentence('Motor Skills', KC.buildDevelopmentChangeSummary([]).domains[3])));
}

function testClinicalPatientInterpretation() {
  const CS = require('../../services/pediaClinicalStatus');
  // One wording entry per server category, in the server's order.
  assert.deepStrictEqual(KC.CLINICAL_CATEGORIES.map((c) => c.key), CS.CATEGORY_KEYS);

  const resolved = KC.formatClinicalPatientInterpretation(
    { category: 'resolved', status: 'resolved', statusLabel: 'Resolved / Ruled Out' }, { checkup: 'Oct 1, 2026' });
  assert.ok(/recorded as Resolved \/ Ruled Out/.test(resolved.interpretation), resolved.interpretation);
  assert.ok(/does not make its own medical conclusion/.test(resolved.interpretation));
  assert.strictEqual(resolved.action, 'Review the patient\'s check-up history.');

  const attention = KC.formatClinicalPatientInterpretation(
    { category: 'needs_follow_up', statusLabel: 'Needs Attention', latestRecommendation: 'Recheck speech in 4 weeks.' }, { checkup: 'Oct 15, 2026' });
  assert.ok(/\(Oct 15, 2026\) is recorded as Needs Attention/.test(attention.interpretation), attention.interpretation);
  assert.strictEqual(attention.action, 'Recorded recommendation: Recheck speech in 4 weeks.');

  const other = KC.formatClinicalPatientInterpretation({ category: 'other', statusLabel: 'Referred' }, {});
  assert.ok(/recorded as Referred\. It is shown as documented/.test(other.interpretation), other.interpretation);

  const tie = KC.formatClinicalPatientInterpretation({ category: 'other', ambiguity: 'same_timestamp', checkupCount: 2 }, {});
  assert.ok(/cannot be determined automatically/.test(tie.interpretation));
  assert.ok(/confirm which record/.test(tie.action));

  const none = KC.formatClinicalPatientInterpretation({ category: 'no_checkup', latestAssessmentAt: '2026-10-01' }, {});
  assert.strictEqual(none.interpretation, 'No check-up outcome is currently recorded for this patient in the applicable report data.');
  assert.ok(/determine whether a check-up or further documentation is needed/.test(none.action));
  const empty = KC.formatClinicalPatientInterpretation({ category: 'no_checkup', latestAssessmentAt: null }, {});
  assert.ok(/no clinical information is available/.test(empty.interpretation));

  // Never claims recovery, cure or health for any category.
  for (const c of KC.CLINICAL_CATEGORIES) {
    const t = KC.formatClinicalPatientInterpretation({ category: c.key, statusLabel: 'X' }, {}).interpretation + c.meaning;
    assert.ok(!/recovered|cured|healthy|no developmental problem/i.test(t), t);
  }
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
  testActivityIntervalChoice();
  testActivitySeriesDailyZeroFilled();
  testActivitySeriesWeeklyAndMonthly();
  testActivitySeriesNeverDropsAnAssessment();
  testActivityTrendInterpretation();
  testDevelopmentProgressComparison();
  testDevelopmentProgressNeedsTwo();
  testDevelopmentChangeSummary();
  testClinicalPatientInterpretation();
  console.log('Pediatrician Reports interpretation rules OK — band leaders/ties, needs-support totals, cohort progression, per-domain counts, movement wording, per-patient history, roster totals, activity series/intervals/summaries, and per-patient development progress all verified');
}

run();
