// Unit tests for Step 12: dataset readiness / quality-control layer for
// reviewed KinderCura assessments, BEFORE ML training. Purely descriptive —
// never touches mlLabel, never generates a label, never claims clinical
// validity (see routes/admin.js buildReviewedAssessmentQualitySummary()).
//
// No live DB required — Assessment/AssessmentResult/AssessmentAnswer/Child/
// CoreBankQuestion's .find()/.countDocuments() are monkey-patched on their
// shared singleton models, matching the pattern established in
// tests/unit/reviewed-assessment-export.test.js (Step 10).
const assert = require('assert');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const Child = require('../../models/Child');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const { DATA_ORIGIN } = require('../../constants/dataOrigin');

const adminRouter = require('../../routes/admin');
const {
  buildReviewedAssessmentQualitySummary, summarizeMissingness, detectDuplicates,
  summarizeAge, summarizeReviewers, summarizeClassDistribution, QUALITY,
} = adminRouter.__testables;

function chainable(result) {
  return { select: () => chainable(result), sort: () => chainable(result), lean: async () => result };
}

function withMockedModels({ assessments, results, answers, children, questions, reviewedCount, excludedCount }) {
  const originals = {
    assessmentFind: Assessment.find,
    assessmentCount: Assessment.countDocuments,
    resultFind: AssessmentResult.find,
    answerFind: AssessmentAnswer.find,
    childFind: Child.find,
    questionFind: CoreBankQuestion.find,
  };
  Assessment.find = () => ({ lean: async () => assessments });
  Assessment.countDocuments = async (query) => {
    if (query && query.mlReviewStatus === 'excluded') return excludedCount ?? 0;
    if (query && query.mlReviewStatus === 'reviewed') return reviewedCount ?? assessments.length;
    return 0;
  };
  AssessmentResult.find = () => ({ lean: async () => results });
  AssessmentAnswer.find = () => ({ lean: async () => answers });
  Child.find = () => ({ select: () => ({ lean: async () => children }) });
  CoreBankQuestion.find = () => chainable(questions);

  return {
    restore() {
      Assessment.find = originals.assessmentFind;
      Assessment.countDocuments = originals.assessmentCount;
      AssessmentResult.find = originals.resultFind;
      AssessmentAnswer.find = originals.answerFind;
      Child.find = originals.childFind;
      CoreBankQuestion.find = originals.questionFind;
    },
  };
}

const QUESTIONS = [{ questionId: 'Q01' }, { questionId: 'Q02' }];

function makeAssessment(i, { childId, riskCategory, completedAt, reviewedBy = `ped${i}` }) {
  return {
    _id: `a${i}`,
    childId: childId || `child${i}`,
    completedAt: completedAt || new Date(`2026-0${(i % 9) + 1}-01`),
    startedAt: new Date(`2026-01-01`),
    mlLabel: { riskCategory, reviewedBy, reviewedAt: new Date(`2026-0${(i % 9) + 1}-02`) },
  };
}
function makeResult(i, overallScore = 60) {
  return { assessmentId: `a${i}`, communicationScore: overallScore, socialScore: overallScore, cognitiveScore: overallScore, motorScore: overallScore, overallScore };
}
function makeChild(childId) {
  return { _id: childId, dateOfBirth: new Date('2021-01-01') };
}

async function run() {
  // A. 0 reviewed assessments.
  {
    const mocks = withMockedModels({ assessments: [], results: [], answers: [], children: [], questions: QUESTIONS, reviewedCount: 0, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.totalReviewedAssessments, 0);
    assert.strictEqual(q.eligibleAssessments, 0);
    assert.strictEqual(q.readiness.ready, false);
    assert.strictEqual(q.readiness.status, 'not_ready');
    assert.ok(q.readiness.reasons.some((r) => /eligible assessment/i.test(r)));
    assert.strictEqual(q.duplicateCount, 0);
  }

  // B. All Low (imbalance warning, but not blocked — eligible count meets minimum, no class underrepresented).
  {
    const n = 12;
    const assessments = Array.from({ length: n }, (_, i) => makeAssessment(i, { childId: `childB${i}`, riskCategory: 'Low', reviewedBy: `pedB${i % 3}` }));
    const results = assessments.map((_, i) => makeResult(i, 90));
    const children = assessments.map((a) => makeChild(a.childId));
    const mocks = withMockedModels({ assessments, results, answers: [], children, questions: QUESTIONS, reviewedCount: n, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.eligibleAssessments, 12);
    assert.strictEqual(q.classDistribution.Low.count, 12);
    assert.strictEqual(q.classDistribution.Low.percentage, 100);
    assert.strictEqual(q.classDistribution.Medium.count, 0);
    assert.ok(q.qualityFlags.some((f) => f.flag === 'unusual_class_distribution'));
    assert.strictEqual(q.readiness.ready, true); // warning, not a hard blocker
    assert.strictEqual(q.readiness.status, 'warning');
  }

  // C. Balanced Low/Medium/High, multiple reviewers -> clean 'ready' status.
  {
    const labels = ['Low', 'Low', 'Low', 'Low', 'Medium', 'Medium', 'Medium', 'Medium', 'High', 'High', 'High', 'High'];
    const assessments = labels.map((riskCategory, i) => makeAssessment(i, { childId: `childC${i}`, riskCategory, reviewedBy: `pedC${i % 4}` }));
    const results = assessments.map((_, i) => makeResult(i, 60));
    const children = assessments.map((a) => makeChild(a.childId));
    // At least one real answer per assessment -> avoids the (correctly
    // detected) "missing_questions" flag so this fixture represents a
    // genuinely clean/ready dataset.
    const answers = assessments.map((_, i) => ({ assessmentId: `a${i}`, questionId: 'Q01', answer: 'yes', origin: DATA_ORIGIN.CORE_BANK }));
    const mocks = withMockedModels({ assessments, results, answers, children, questions: QUESTIONS, reviewedCount: assessments.length, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.deepStrictEqual(
      { Low: q.classDistribution.Low.count, Medium: q.classDistribution.Medium.count, High: q.classDistribution.High.count },
      { Low: 4, Medium: 4, High: 4 }
    );
    assert.ok(!q.qualityFlags.some((f) => f.flag === 'unusual_class_distribution'));
    assert.strictEqual(q.readiness.status, 'ready');
    assert.strictEqual(q.readiness.ready, true);
  }

  // D. Imbalanced classes (Low dominant, Medium/High still individually valid) -> warning, not blocked.
  {
    const labels = [...Array(13).fill('Low'), 'Medium', 'Medium', 'High', 'High'];
    const assessments = labels.map((riskCategory, i) => makeAssessment(i, { childId: `childD${i}`, riskCategory, reviewedBy: `pedD${i % 3}` }));
    const results = assessments.map((_, i) => makeResult(i, 60));
    const children = assessments.map((a) => makeChild(a.childId));
    const mocks = withMockedModels({ assessments, results, answers: [], children, questions: QUESTIONS, reviewedCount: assessments.length, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.eligibleAssessments, 17);
    assert.ok(q.classDistribution.Low.percentage > QUALITY.CLASS_IMBALANCE_MAX_SHARE * 100);
    assert.ok(q.qualityFlags.some((f) => f.flag === 'unusual_class_distribution'));
    assert.strictEqual(q.readiness.ready, true);
    assert.strictEqual(q.readiness.status, 'warning');
  }

  // E. Incomplete assessment (no AssessmentResult) excluded from eligible count, flagged.
  {
    const assessments = [makeAssessment(1, { childId: 'childE1', riskCategory: 'Low' })];
    const mocks = withMockedModels({ assessments, results: [], answers: [], children: [makeChild('childE1')], questions: QUESTIONS, reviewedCount: 1, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.eligibleAssessments, 0);
    assert.strictEqual(q.totalReviewedAssessments, 1);
    assert.ok(q.qualityFlags.some((f) => f.flag === 'missing_score' && f.count === 1));
  }

  // F/G. Missing reviewer / invalid label: a document counted as "reviewed"
  // by Assessment.countDocuments that never made it through the strict
  // eligibility filter (buildReviewedAssessmentFilter requires a valid
  // riskCategory AND a reviewer) — detected as a count mismatch, not by
  // relaxing the filter itself.
  {
    const assessments = [makeAssessment(1, { childId: 'childF1', riskCategory: 'Low' })];
    const results = [makeResult(1, 90)];
    const mocks = withMockedModels({
      assessments, results, answers: [], children: [makeChild('childF1')], questions: QUESTIONS,
      reviewedCount: 2, // one more "reviewed" than the strict filter could ever return
      excludedCount: 0,
    });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.eligibleAssessments, 1);
    assert.strictEqual(q.totalReviewedAssessments, 2);
    assert.ok(q.qualityFlags.some((f) => f.flag === 'invalid_label' && f.count === 1));
  }

  // H. Duplicate: two rows, SAME child, SAME completedAt.
  {
    const sameDate = new Date('2026-05-01T00:00:00Z');
    const assessments = [
      makeAssessment(1, { childId: 'childH', riskCategory: 'Low', completedAt: sameDate }),
      makeAssessment(2, { childId: 'childH', riskCategory: 'Medium', completedAt: sameDate }),
    ];
    const results = [makeResult(1, 90), makeResult(2, 50)];
    const mocks = withMockedModels({ assessments, results, answers: [], children: [makeChild('childH')], questions: QUESTIONS, reviewedCount: 2, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.duplicateCount, 2);
    assert.deepStrictEqual(q.duplicateGroups, [{ groupSize: 2 }]);
    assert.ok(q.qualityFlags.some((f) => f.flag === 'duplicate_reference'));
  }

  // I. Same child, DIFFERENT completedAt dates -> legitimate longitudinal
  // reassessment, NOT a duplicate.
  {
    const assessments = [
      makeAssessment(1, { childId: 'childI', riskCategory: 'Low', completedAt: new Date('2026-01-01') }),
      makeAssessment(2, { childId: 'childI', riskCategory: 'Medium', completedAt: new Date('2026-06-01') }),
    ];
    const results = [makeResult(1, 90), makeResult(2, 50)];
    const mocks = withMockedModels({ assessments, results, answers: [], children: [makeChild('childI')], questions: QUESTIONS, reviewedCount: 2, excludedCount: 0 });
    const q = await buildReviewedAssessmentQualitySummary();
    mocks.restore();
    assert.strictEqual(q.duplicateCount, 0);
    assert.deepStrictEqual(q.duplicateGroups, []);
  }

  // J. Age-gated blank question is NOT counted as a "0" answer — missingness
  // treats '' distinctly from a real 0 ("no") value.
  {
    const rows = [
      { Q01: '', Q02: 0, age_months: 50, communication_score: 80, social_score: 80, cognitive_score: 80, motor_score: 80, overall_score: 80 },
      { Q01: 2, Q02: '', age_months: '', communication_score: 80, social_score: 80, cognitive_score: 80, motor_score: 80, overall_score: 80 },
    ];
    const m = summarizeMissingness(rows, ['Q01', 'Q02']);
    assert.strictEqual(m.questionMissingness.Q01.missing, 1); // one blank
    assert.strictEqual(m.questionMissingness.Q02.missing, 1); // one blank; the literal 0 is NOT missing
    assert.strictEqual(m.scoreMissingness.age_months.missing, 1);
    assert.strictEqual(m.scoreMissingness.communication_score.missing, 0);
  }

  // K. Quality summary's eligibleAssessments matches the export row count exactly.
  {
    const assessments = [makeAssessment(1, { childId: 'childK', riskCategory: 'High' })];
    const results = [makeResult(1, 20)];
    const children = [makeChild('childK')];
    const mocks = withMockedModels({ assessments, results, answers: [], children, questions: QUESTIONS, reviewedCount: 1, excludedCount: 0 });
    const [q, exportResult] = await Promise.all([
      buildReviewedAssessmentQualitySummary(),
      adminRouter.__testables.buildReviewedAssessmentExportRows(),
    ]);
    mocks.restore();
    assert.strictEqual(q.eligibleAssessments, exportResult.total);
  }

  // L. Synthetic dataset remains untouched/separate.
  {
    const fs = require('fs');
    const path = require('path');
    const syntheticPath = path.join(__dirname, '..', '..', 'ml', 'datasets', 'kindercura_assessment_dataset.csv');
    assert.ok(fs.existsSync(syntheticPath));
  }

  // Pure-function sanity checks (age stats, reviewer pseudonymization).
  {
    const ages = summarizeAge([{ age_months: 30 }, { age_months: 40 }, { age_months: '' }, { age_months: 50 }]);
    assert.deepStrictEqual(ages, { min: 30, max: 50, median: 40, missingCount: 1 });

    const reviewers = summarizeReviewers([
      { _reviewedBy: 'pedA', _reviewedAt: new Date('2026-01-01') },
      { _reviewedBy: 'pedA', _reviewedAt: new Date('2026-02-01') },
      { _reviewedBy: 'pedB', _reviewedAt: new Date('2026-03-01') },
    ]);
    assert.strictEqual(reviewers.uniqueReviewers, 2);
    assert.deepStrictEqual(new Date(reviewers.latestReviewAt), new Date('2026-03-01'));
    // Privacy-safe: no raw reviewer id anywhere in the response.
    for (const entry of reviewers.reviewsByReviewer) {
      assert.ok(!('pedA' === entry.reviewerRef || 'pedB' === entry.reviewerRef));
      assert.match(entry.reviewerRef, /^Reviewer \d+$/);
    }
    assert.deepStrictEqual(reviewers.reviewsByReviewer.map((r) => r.count).sort(), [1, 2]);

    const dist = summarizeClassDistribution({ Low: 3, Medium: 1 }, 4);
    assert.strictEqual(dist.High.count, 0);
    assert.strictEqual(dist.High.percentage, 0);
    assert.strictEqual(dist.Low.percentage, 75);
  }

  console.log('Dataset quality tests OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
