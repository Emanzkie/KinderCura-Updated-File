// Unit tests for Step 10: producing REAL labeled ML training data from
// pediatrician-reviewed KinderCura assessments (routes/assessments.js POST
// /:assessmentId/ml-label, routes/admin.js GET
// /training/reviewed-assessments/export).
//
// No live DB required — Assessment/AssessmentResult/AssessmentAnswer/Child/
// CoreBankQuestion's .find() are monkey-patched on their shared singleton
// models (Node's require cache guarantees routes/admin.js sees the same
// instances patched here), matching the pattern used throughout Steps 5-9.
const assert = require('assert');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const Child = require('../../models/Child');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const Appointment = require('../../models/Appointment');
const AuditLog = require('../../models/AuditLog');
const { DATA_ORIGIN } = require('../../constants/dataOrigin');

const adminRouter = require('../../routes/admin');
const { buildReviewedAssessmentFilter, buildReviewedAssessmentExportRows, rowsToCsv } = adminRouter.__testables;

const assessmentsRouter = require('../../routes/assessments');
const { ML_LABEL_VALUES, getMlLabelValidationError, reviewAssessmentMlLabel } = assessmentsRouter.__testables;

// Chainable mock for CoreBankQuestion.find({}).select().sort().lean()
function chainable(result) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    lean: async () => result,
  };
  return chain;
}

function withMockedModels({ assessments, results, answers, children, questions }) {
  const originals = {
    assessmentFind: Assessment.find,
    resultFind: AssessmentResult.find,
    answerFind: AssessmentAnswer.find,
    childFind: Child.find,
    questionFind: CoreBankQuestion.find,
  };
  const calls = {};

  Assessment.find = (query) => { calls.assessmentFilter = query; return { lean: async () => assessments }; };
  AssessmentResult.find = () => ({ lean: async () => results });
  AssessmentAnswer.find = (query) => { calls.answerFilter = query; return { lean: async () => answers }; };
  Child.find = () => ({ select: () => ({ lean: async () => children }) });
  CoreBankQuestion.find = () => chainable(questions);

  return {
    calls,
    restore() {
      Assessment.find = originals.assessmentFind;
      AssessmentResult.find = originals.resultFind;
      AssessmentAnswer.find = originals.answerFind;
      Child.find = originals.childFind;
      CoreBankQuestion.find = originals.questionFind;
    },
  };
}

async function run() {
  // A. Eligibility filter excludes unreviewed / incomplete / invalid label /
  // missing reviewer — proven structurally (Mongoose queries only execute
  // once awaited; inspecting the filter shape is the established pattern
  // from services/assessmentProgress.js buildPreviousAssessmentFilter).
  {
    const filter = buildReviewedAssessmentFilter();
    assert.strictEqual(filter.status, 'complete'); // G: incomplete assessments excluded
    assert.strictEqual(filter.mlReviewStatus, 'reviewed'); // A: unreviewed excluded
    assert.deepStrictEqual(filter['mlLabel.riskCategory'], { $in: ['Low', 'Medium', 'High'] }); // E: invalid label excluded
    assert.deepStrictEqual(filter['mlLabel.reviewedBy'], { $exists: true, $ne: null }); // F: missing reviewer excluded
  }

  // E. Invalid label rejected by the review endpoint's own validation.
  {
    assert.deepStrictEqual(ML_LABEL_VALUES, ['Low', 'Medium', 'High']);
    assert.ok(getMlLabelValidationError('Extreme'));
    assert.ok(getMlLabelValidationError(''));
    assert.ok(getMlLabelValidationError(undefined));
    assert.strictEqual(getMlLabelValidationError('Low'), null);
    assert.strictEqual(getMlLabelValidationError('  Medium  '), null); // trims before checking
  }
  // F. Missing reviewer: reviewedBy is never accepted from the request body
  // in routes/assessments.js POST /:assessmentId/ml-label — it is always
  // `req.user.userId` from the authenticated session, so a request cannot
  // omit it once past authMiddleware. Enforced structurally, not by a
  // separate validation branch; the export-side guard is covered by the
  // 'mlLabel.reviewedBy' filter clause asserted in test A above.

  const QUESTIONS = [{ questionId: 'Q01' }, { questionId: 'Q02' }, { questionId: 'Q03' }];

  const assessments = [
    { _id: 'a1', childId: 'child1', completedAt: new Date('2026-01-15'), startedAt: new Date('2026-01-10'), mlLabel: { riskCategory: 'Low', reviewedBy: 'ped1', reviewedAt: new Date('2026-01-16') } },
    { _id: 'a2', childId: 'child2', completedAt: new Date('2026-02-10'), startedAt: new Date('2026-02-05'), mlLabel: { riskCategory: 'High', reviewedBy: 'ped1', reviewedAt: new Date('2026-02-11') } },
    { _id: 'a3', childId: 'child3', completedAt: new Date('2026-03-01'), startedAt: new Date('2026-02-25'), mlLabel: { riskCategory: 'Medium', reviewedBy: 'ped2', reviewedAt: new Date('2026-03-02') } },
    // G. Reviewed + complete, but no matching AssessmentResult -> must be skipped, not exported with blanks.
    { _id: 'a4', childId: 'child4', completedAt: new Date('2026-03-15'), startedAt: new Date('2026-03-10'), mlLabel: { riskCategory: 'High', reviewedBy: 'ped1', reviewedAt: new Date('2026-03-16') } },
  ];
  const results = [
    { assessmentId: 'a1', communicationScore: 80, socialScore: 75, cognitiveScore: 70, motorScore: 85, overallScore: 78 },
    { assessmentId: 'a2', communicationScore: 20, socialScore: 25, cognitiveScore: 15, motorScore: 30, overallScore: 22 },
    { assessmentId: 'a3', communicationScore: 50, socialScore: 55, cognitiveScore: 45, motorScore: 52, overallScore: 50 },
    // (no result for a4)
  ];
  const answers = [
    // a1: Q03 not administered (age-gated) -> must be blank, not "0".
    { assessmentId: 'a1', questionId: 'Q01', answer: 'yes', origin: DATA_ORIGIN.CORE_BANK },
    { assessmentId: 'a1', questionId: 'Q02', answer: 'sometimes', origin: DATA_ORIGIN.CORE_BANK },
    // a2: fully answered.
    { assessmentId: 'a2', questionId: 'Q01', answer: 'no', origin: DATA_ORIGIN.CORE_BANK },
    { assessmentId: 'a2', questionId: 'Q02', answer: 'yes', origin: DATA_ORIGIN.CORE_BANK },
    { assessmentId: 'a2', questionId: 'Q03', answer: 'no', origin: DATA_ORIGIN.CORE_BANK },
    // a3: no core-bank answers at all -> every question blank.
  ];
  const children = [
    { _id: 'child1', dateOfBirth: new Date('2021-01-15') },
    { _id: 'child2', dateOfBirth: new Date('2020-06-10') },
    { _id: 'child3', dateOfBirth: new Date('2022-03-01') },
  ];

  const mocks = withMockedModels({ assessments, results, answers, children, questions: QUESTIONS });
  const { rows, total, skipped, byLabel, questionIds } = await buildReviewedAssessmentExportRows();
  mocks.restore();

  // Confirms the export queries CORE_BANK-origin answers only — a
  // pediatrician's custom per-child questions never leak into the
  // canonical export (they have no stable global column).
  assert.strictEqual(mocks.calls.answerFilter.origin, DATA_ORIGIN.CORE_BANK);

  // B/C/D. Low, Medium, and High reviewed assessments are all exported.
  assert.strictEqual(total, 3); // a4 excluded (G)
  assert.strictEqual(skipped.noResult, 1);
  assert.deepStrictEqual(byLabel, { Low: 1, Medium: 1, High: 1 });

  const rowA1 = rows.find((r) => r.risk_category === 'Low');
  const rowA2 = rows.find((r) => r.risk_category === 'High');
  const rowA3 = rows.find((r) => r.risk_category === 'Medium');
  assert.ok(rowA1 && rowA2 && rowA3);

  // I. Age-gated / unanswered question is blank, not 0.
  assert.strictEqual(rowA1.Q03, '');
  assert.strictEqual(rowA3.Q01, '');
  assert.strictEqual(rowA3.Q02, '');
  assert.strictEqual(rowA3.Q03, '');

  // J. yes/sometimes/no exported as 2/1/0.
  assert.strictEqual(rowA1.Q01, 2);
  assert.strictEqual(rowA1.Q02, 1);
  assert.strictEqual(rowA2.Q01, 0);
  assert.strictEqual(rowA2.Q02, 2);
  assert.strictEqual(rowA2.Q03, 0);

  // Scores pass through unchanged, and risk_category is the REVIEWED label
  // (never AssessmentResult.prediction, which was never even queried here).
  assert.strictEqual(rowA1.overall_score, 78);
  assert.strictEqual(rowA1.communication_score, 80);
  assert.strictEqual(rowA2.overall_score, 22);

  // Age computed at completedAt, not "now" — sanity check it's a positive number.
  assert.strictEqual(typeof rowA1.age_months, 'number');
  assert.ok(rowA1.age_months > 0);

  // assessment_ref is a synthetic sequential label, never a real Mongo _id.
  assert.match(rowA1.assessment_ref, /^REVIEWED-\d{3}$/);
  assert.notStrictEqual(rowA1.assessment_ref, 'a1');

  // K. Exported CSV columns exactly match the canonical dataset shape (Step 9).
  // Row objects also carry internal-only `_`-prefixed fields (Step 12:
  // duplicate detection / reviewer stats) that rowsToCsv() below never
  // serializes — asserted on the actual CSV output, not the in-memory object,
  // since the object is deliberately a superset now.
  const expectedColumns = ['assessment_ref', 'age_months', ...questionIds,
    'communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'risk_category'];
  const csv = rowsToCsv(rows, questionIds);
  const header = csv.split('\n')[0];
  assert.strictEqual(header, expectedColumns.join(','));
  assert.deepStrictEqual(header.split(','), expectedColumns);

  // L. No PII fields present in the actual exported CSV — the internal-only
  // `_assessmentId`/`_childId`/etc. fields (Step 12) never reach it.
  for (const line of csv.trim().split('\n')) {
    assert.ok(!/_assessmentId|_childId|_reviewedBy/.test(line));
  }
  const forbidden = ['childId', 'parentId', 'assessmentId', '_id', 'email', 'name', 'phone', 'address'];
  for (const field of forbidden) {
    assert.ok(!expectedColumns.includes(field), `forbidden field present in CSV columns: ${field}`);
  }

  // M. Synthetic dataset (ml/datasets/kindercura_assessment_dataset.csv)
  // remains untouched by this export — this test never writes to it, and
  // the export route (routes/admin.js) never reads from or merges into it.
  const fs = require('fs');
  const path = require('path');
  const syntheticPath = path.join(__dirname, '..', '..', 'ml', 'datasets', 'kindercura_assessment_dataset.csv');
  assert.ok(fs.existsSync(syntheticPath), 'synthetic dataset file should still exist, unmodified');

  // ── reviewAssessmentMlLabel: authorization + save behavior ──────────────
  {
    const origFindById = Assessment.findById;
    const origAppointmentExists = Appointment.exists;
    const origAuditCreate = AuditLog.create;

    // H. Unauthorized: pediatrician has no appointment for this child ->
    // rejected, and the assessment is never modified.
    {
      let saveCalled = false;
      Assessment.findById = async () => ({
        status: 'complete', mlLabel: null,
        save: async () => { saveCalled = true; },
      });
      Appointment.exists = async () => false; // not linked to this patient
      AuditLog.create = async () => { throw new Error('must not write an audit entry for a rejected review'); };

      let threw = null;
      try {
        await reviewAssessmentMlLabel('assessment-x', { userId: 'ped-outsider', role: 'pediatrician' }, { riskCategory: 'Low' });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw);
      assert.strictEqual(threw.statusCode, 403);
      assert.strictEqual(saveCalled, false);
    }

    // Non-pediatrician role rejected before any DB lookup.
    {
      let threw = null;
      try {
        await reviewAssessmentMlLabel('assessment-x', { userId: 'someone', role: 'parent' }, { riskCategory: 'Low' });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw);
      assert.strictEqual(threw.statusCode, 403);
    }

    // Incomplete assessment rejected (G, review-side).
    {
      Assessment.findById = async () => ({ status: 'in_progress', mlLabel: null, save: async () => {} });
      let threw = null;
      try {
        await reviewAssessmentMlLabel('assessment-x', { userId: 'ped1', role: 'pediatrician' }, { riskCategory: 'Low' });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw);
      assert.strictEqual(threw.statusCode, 400);
    }

    // Authorized + valid: saves the label, sets mlReviewStatus, writes an
    // audit entry preserving the previous label.
    {
      let savedDoc = null;
      let auditDetails = null;
      Assessment.findById = async () => ({
        _id: 'assessment-y',
        status: 'complete',
        childId: 'child-y',
        mlLabel: { riskCategory: 'Medium' }, // previous review being revised
        mlReviewStatus: 'reviewed',
        save: async function () { savedDoc = { ...this }; },
      });
      Appointment.exists = async () => true; // linked to this patient
      AuditLog.create = async (entry) => { auditDetails = entry; };

      const result = await reviewAssessmentMlLabel('assessment-y', { userId: 'ped1', role: 'pediatrician' }, { riskCategory: 'High', notes: 'Revised after follow-up' });

      assert.strictEqual(result.mlLabel.riskCategory, 'High');
      assert.strictEqual(result.mlLabel.reviewedBy, 'ped1');
      assert.strictEqual(result.mlLabel.reviewSource, 'pediatrician');
      assert.strictEqual(result.mlReviewStatus, 'reviewed');
      assert.strictEqual(savedDoc.mlLabel.riskCategory, 'High');
      // Previous label preserved via the audit entry, not silently erased.
      assert.strictEqual(auditDetails.action, 'ml_label_reviewed');
      assert.strictEqual(auditDetails.details.previousRiskCategory, 'Medium');
      assert.strictEqual(auditDetails.details.riskCategory, 'High');
    }

    Assessment.findById = origFindById;
    Appointment.exists = origAppointmentExists;
    AuditLog.create = origAuditCreate;
  }

  console.log('Reviewed assessment export tests OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
