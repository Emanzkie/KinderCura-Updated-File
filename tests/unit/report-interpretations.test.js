// tests/unit/report-interpretations.test.js
// Locks in the wording/decision rules for js/parent/report-interpretations.js
// (the Parent Reports interpretation helpers) with pure, no-DB, no-network
// tests. Covers the edge cases the Parent Reports audit called out:
// no/one/two/many assessments, missing previous score, missing domain score,
// zero score with and without recorded answers, fluctuating scores, tied
// domain scores, and the initial-pediatrician-review lookup.

const assert = require('assert');
const KC = require('../../js/parent/report-interpretations.js');

// ── Fixtures ─────────────────────────────────────────────────────────────

let nextId = 1;
function domain(key, label, score, answeredItemCount) {
  return { key, label, score, answeredItemCount: answeredItemCount == null ? (score == null ? 0 : 8) : answeredItemCount };
}

function entry({
  completedAt, overallScore, scoresAvailable = true, domains, review = {},
} = {}) {
  return {
    id: String(nextId++),
    completedAt,
    overallScore,
    scoresAvailable,
    domains: domains || [
      domain('communication', 'Communication', overallScore),
      domain('social', 'Social Skills', overallScore),
      domain('cognitive', 'Cognitive', overallScore),
      domain('motor', 'Motor Skills', overallScore),
    ],
    review: {
      reviewedAt: review.reviewedAt || null,
      pediatricianId: review.pediatricianId || null,
      pediatricianName: review.pediatricianName || null,
      recommendations: review.recommendations || null,
      nextAssessmentDate: review.nextAssessmentDate || null,
      nextAssessmentReason: review.nextAssessmentReason || null,
    },
  };
}

// ── pointsDiffText ─────────────────────────────────────────────────────────

function testPointsDiffText() {
  assert.strictEqual(KC.pointsDiffText(75, 70).direction, 'increased');
  assert.strictEqual(KC.pointsDiffText(75, 70).text, 'increased by 5 percentage points');
  assert.strictEqual(KC.pointsDiffText(70, 75).direction, 'decreased');
  assert.strictEqual(KC.pointsDiffText(70, 75).text, 'decreased by 5 percentage points');
  assert.strictEqual(KC.pointsDiffText(70, 70).direction, 'same');
  assert.strictEqual(KC.pointsDiffText(70, 70).text, 'stayed the same');
  // Never the word "improved"/"improvement" anywhere in generated text.
  assert.ok(!/improv/i.test(KC.pointsDiffText(90, 10).text));
}

// ── formatDomainList ─────────────────────────────────────────────────────

function testFormatDomainList() {
  assert.strictEqual(KC.formatDomainList(['A']), 'A');
  assert.strictEqual(KC.formatDomainList(['A', 'B']), 'A and B');
  assert.strictEqual(KC.formatDomainList(['A', 'B', 'C']), 'A, B, and C');
}

// ── isEntryDataIncomplete / zero-score handling ───────────────────────────

function testZeroScoreWithRecordedAnswersIsNotIncomplete() {
  // A real 0% — every question was answered "no". Must NOT be flagged incomplete.
  const e = entry({
    completedAt: '2026-08-17', overallScore: 0,
    domains: [
      domain('communication', 'Communication', 0, 10),
      domain('social', 'Social Skills', 0, 10),
      domain('cognitive', 'Cognitive', 0, 10),
      domain('motor', 'Motor Skills', 0, 10),
    ],
  });
  assert.strictEqual(KC.isEntryDataIncomplete(e), false);
}

function testZeroScoreWithNoRecordedAnswersIsIncomplete() {
  // 0% purely because nothing was ever answered — must be flagged incomplete.
  const e = entry({
    completedAt: '2026-08-17', overallScore: 0,
    domains: [
      domain('communication', 'Communication', 0, 0),
      domain('social', 'Social Skills', 0, 0),
      domain('cognitive', 'Cognitive', 0, 0),
      domain('motor', 'Motor Skills', 0, 0),
    ],
  });
  assert.strictEqual(KC.isEntryDataIncomplete(e), true);
  assert.strictEqual(KC.getHistoryInterpretation(e, null), KC.INCOMPLETE_MESSAGE);
}

function testMissingResultIsIncomplete() {
  const e = entry({ completedAt: '2026-08-17', overallScore: null, scoresAvailable: false, domains: [] });
  assert.strictEqual(KC.isEntryDataIncomplete(e), true);
  assert.strictEqual(KC.getHistoryInterpretation(e, null), KC.INCOMPLETE_MESSAGE);
  assert.strictEqual(KC.getAssessmentInterpretation(e), KC.INCOMPLETE_MESSAGE);
}

// ── getBaselineInterpretation / oldest assessment ─────────────────────────

function testBaselineHasNoComparison() {
  const e = entry({
    completedAt: '2026-08-17',
    overallScore: 72,
    domains: [
      domain('communication', 'Communication', 90),
      domain('social', 'Social Skills', 70),
      domain('cognitive', 'Cognitive', 50),
      domain('motor', 'Motor Skills', 78),
    ],
  });
  const text = KC.getBaselineInterpretation(e);
  assert.ok(/Baseline assessment/i.test(text));
  assert.ok(/no earlier assessment/i.test(text));
  assert.ok(/72%/.test(text));
  assert.ok(/Communication had the highest/.test(text));
  assert.ok(/Cognitive.*lowest/.test(text));
  // getHistoryInterpretation with no previous must delegate to the baseline wording.
  assert.strictEqual(KC.getHistoryInterpretation(e, null), text);
}

// ── getHistoryInterpretation: two assessments, decrease ───────────────────

function testHistoryInterpretationDecrease() {
  const prev = entry({ completedAt: '2026-08-17', overallScore: 72 });
  const cur = entry({ completedAt: '2026-09-03', overallScore: 69 });
  const text = KC.getHistoryInterpretation(cur, prev);
  assert.ok(/overall score of 69%/.test(text));
  assert.ok(/August 17, 2026/.test(text));
  assert.ok(/decreased by 3 percentage points/.test(text));
}

function testHistoryInterpretationIncrease() {
  const prev = entry({ completedAt: '2026-08-17', overallScore: 60 });
  const cur = entry({ completedAt: '2026-09-03', overallScore: 68 });
  const text = KC.getHistoryInterpretation(cur, prev);
  assert.ok(/increased by 8 percentage points/.test(text));
  assert.ok(!/improv/i.test(text), 'must never say "improved"/"improvement"');
}

function testHistoryInterpretationSameScore() {
  const prev = entry({ completedAt: '2026-08-17', overallScore: 69 });
  const cur = entry({ completedAt: '2026-09-03', overallScore: 69 });
  const text = KC.getHistoryInterpretation(cur, prev);
  assert.ok(/stayed the same/.test(text));
}

function testHistoryInterpretationMissingPreviousScore() {
  // Edge case: a previous entry exists chronologically but its own scores
  // were incomplete — must not fabricate a numeric comparison.
  const prev = entry({ completedAt: '2026-08-17', overallScore: 0, scoresAvailable: false, domains: [] });
  const cur = entry({ completedAt: '2026-09-03', overallScore: 69 });
  const text = KC.getHistoryInterpretation(cur, prev);
  assert.ok(/previous assessment's scores were incomplete/i.test(text));
  assert.ok(!/percentage point/.test(text), 'must not invent a point difference from incomplete data');
}

// ── describeDomainHighlights: tied domain scores ──────────────────────────

function testTiedDomainScores() {
  const domains = [
    domain('communication', 'Communication', 70),
    domain('social', 'Social Skills', 70),
    domain('cognitive', 'Cognitive', 70),
    domain('motor', 'Motor Skills', 70),
  ];
  const highlights = KC.describeDomainHighlights(domains);
  assert.ok(/tied at 70%/.test(highlights.text));

  const commInterp = KC.getDomainInterpretation(domains[0], domains, 70);
  assert.ok(/tied with the other measured areas/.test(commInterp));
}

function testTiedHighest() {
  const domains = [
    domain('communication', 'Communication', 90),
    domain('social', 'Social Skills', 90),
    domain('cognitive', 'Cognitive', 50),
    domain('motor', 'Motor Skills', 60),
  ];
  const highlights = KC.describeDomainHighlights(domains);
  assert.deepStrictEqual(highlights.highestLabels.sort(), ['Communication', 'Social Skills'].sort());
  const commInterp = KC.getDomainInterpretation(domains[0], domains, 72);
  assert.ok(/tied for the highest/.test(commInterp));
}

// ── getDomainInterpretation: above/below/close to overall ─────────────────

function testDomainAboveOverall() {
  const domains = [
    domain('communication', 'Communication', 83),
    domain('social', 'Social Skills', 70),
    domain('cognitive', 'Cognitive', 50),
    domain('motor', 'Motor Skills', 72),
  ];
  // Motor (72) is neither the max (83) nor the min (50) -> compared to overall.
  const motorInterp = KC.getDomainInterpretation(domains[3], domains, 69);
  assert.ok(/above the overall assessment score/.test(motorInterp));

  const socialInterp = KC.getDomainInterpretation(domains[1], domains, 69);
  assert.ok(/close to the overall score/.test(socialInterp));

  const commInterp = KC.getDomainInterpretation(domains[0], domains, 69);
  assert.ok(/highest recorded score/.test(commInterp));

  const cogInterp = KC.getDomainInterpretation(domains[2], domains, 69);
  assert.ok(/lowest recorded score/.test(cogInterp));
}

function testDomainMissingScore() {
  const domains = [
    domain('communication', 'Communication', null, 0),
    domain('social', 'Social Skills', 70),
    domain('cognitive', 'Cognitive', 50),
    domain('motor', 'Motor Skills', 72),
  ];
  const text = KC.getDomainInterpretation(domains[0], domains, 64);
  assert.ok(/may be incomplete or unavailable/.test(text));
}

function testDomainZeroWithNoAnswers() {
  const domains = [
    domain('communication', 'Communication', 0, 0), // zero score, zero answers -> incomplete
    domain('social', 'Social Skills', 70),
    domain('cognitive', 'Cognitive', 50),
    domain('motor', 'Motor Skills', 72),
  ];
  const text = KC.getDomainInterpretation(domains[0], domains, 48);
  assert.ok(/may be incomplete or unavailable/.test(text));

  // The highlights sentence for the OTHER domains must call out the
  // incomplete one rather than silently including it in the comparison.
  const highlights = KC.describeDomainHighlights(domains);
  assert.ok(/Communication.*may be incomplete/.test(highlights.text));
  assert.ok(!highlights.lowestLabels.includes('Communication'));
}

// ── getTrendInterpretation ─────────────────────────────────────────────────

function testTrendNotEnoughData() {
  assert.ok(/not enough completed assessments/i.test(KC.getTrendInterpretation([])));
  const one = [entry({ completedAt: '2026-08-17', overallScore: 72 })];
  assert.ok(/only one completed assessment/i.test(KC.getTrendInterpretation(one)));
}

function testTrendTwoAssessments() {
  const list = [
    entry({ completedAt: '2026-08-17', overallScore: 62 }),
    entry({ completedAt: '2026-09-03', overallScore: 70 }),
  ];
  const text = KC.getTrendInterpretation(list);
  assert.ok(/September 3, 2026/.test(text));
  assert.ok(/increased by 8 percentage points/.test(text));
  assert.ok(/from 62% to 70%/.test(text));
  assert.ok(/screening result/i.test(text), 'must include the "does not explain cause" disclaimer');
}

function testTrendManyAssessmentsIncreasing() {
  const list = [
    entry({ completedAt: '2026-06-01', overallScore: 50 }),
    entry({ completedAt: '2026-07-01', overallScore: 60 }),
    entry({ completedAt: '2026-08-01', overallScore: 65 }),
    entry({ completedAt: '2026-09-01', overallScore: 75 }),
  ];
  const text = KC.getTrendInterpretation(list);
  assert.ok(/generally increased over time/.test(text));
  assert.ok(/from 50% to 75%/.test(text));
}

function testTrendFluctuating() {
  const list = [
    entry({ completedAt: '2026-06-01', overallScore: 70 }),
    entry({ completedAt: '2026-07-01', overallScore: 55 }),
    entry({ completedAt: '2026-08-01', overallScore: 80 }),
    entry({ completedAt: '2026-09-01', overallScore: 60 }),
  ];
  const text = KC.getTrendInterpretation(list);
  assert.ok(/changed over time rather than moving consistently/.test(text));
  // Must not force a spurious "increased"/"decreased" characterization of the whole series.
  assert.ok(!/generally increased/.test(text));
  assert.ok(!/generally decreased/.test(text));
}

function testTrendExcludesIncompleteEntries() {
  const list = [
    entry({ completedAt: '2026-06-01', overallScore: 60 }),
    // Phantom zero: overallScore is non-null but nothing was ever answered.
    entry({
      completedAt: '2026-07-01', overallScore: 0,
      domains: [
        domain('communication', 'Communication', 0, 0),
        domain('social', 'Social Skills', 0, 0),
        domain('cognitive', 'Cognitive', 0, 0),
        domain('motor', 'Motor Skills', 0, 0),
      ],
    }),
    entry({ completedAt: '2026-08-01', overallScore: 65 }),
  ];
  const text = KC.getTrendInterpretation(list);
  // Compares the two REAL points (60 -> 65), not the phantom zero.
  assert.ok(/from 60% to 65%/.test(text));
  assert.ok(/1 assessment.*incomplete or unavailable/i.test(text));
}

// ── findInitialReview ──────────────────────────────────────────────────────

function testFindInitialReviewPicksEarliestReviewed() {
  const list = [
    entry({ completedAt: '2026-06-01', overallScore: 60 }), // never reviewed
    entry({
      completedAt: '2026-07-01', overallScore: 65,
      review: { reviewedAt: '2026-07-05', pediatricianId: 'ped1', pediatricianName: 'Dr. Cruz', recommendations: 'Monitor.' },
    }),
    entry({
      completedAt: '2026-08-01', overallScore: 70,
      review: { reviewedAt: '2026-08-05', pediatricianId: 'ped1', pediatricianName: 'Dr. Cruz', recommendations: 'Re-screen in 3 months.' },
    }),
  ];
  const initial = KC.findInitialReview(list);
  assert.strictEqual(initial.completedAt, '2026-07-01');
  assert.strictEqual(initial.review.recommendations, 'Monitor.');
}

function testFindInitialReviewNoneReviewed() {
  const list = [
    entry({ completedAt: '2026-06-01', overallScore: 60 }),
    entry({ completedAt: '2026-07-01', overallScore: 65 }),
  ];
  assert.strictEqual(KC.findInitialReview(list), null);
}

function run() {
  testPointsDiffText();
  testFormatDomainList();
  testZeroScoreWithRecordedAnswersIsNotIncomplete();
  testZeroScoreWithNoRecordedAnswersIsIncomplete();
  testMissingResultIsIncomplete();
  testBaselineHasNoComparison();
  testHistoryInterpretationDecrease();
  testHistoryInterpretationIncrease();
  testHistoryInterpretationSameScore();
  testHistoryInterpretationMissingPreviousScore();
  testTiedDomainScores();
  testTiedHighest();
  testDomainAboveOverall();
  testDomainMissingScore();
  testDomainZeroWithNoAnswers();
  testTrendNotEnoughData();
  testTrendTwoAssessments();
  testTrendManyAssessmentsIncreasing();
  testTrendFluctuating();
  testTrendExcludesIncompleteEntries();
  testFindInitialReviewPicksEarliestReviewed();
  testFindInitialReviewNoneReviewed();
  console.log('Report interpretation rules OK — baseline/history/trend/domain wording, tie handling, and incomplete-data fallbacks all verified');
}

run();
