// routes/parent-reports.js
// Parent-facing progress report: one child's screening history over time.
//
// READ-ONLY BY DESIGN. This router never writes, and it never scores.
// ---------------------------------------------------------------------------
// Every number it returns is read straight out of AssessmentResult, which is
// written by exactly one place — the submit handler in routes/assessments.js.
// If a result document is missing for a completed assessment, the entry is
// returned with scoresAvailable:false and null scores. Do NOT add a fallback
// that recomputes from assessment_answers: a second scoring path is how this
// codebase ended up with four disagreeing band sets in the first place
// (see constants/scoring.js and docs/SCORING.md).
//
// Band labels are likewise NOT decided here. The client derives them from the
// stored score via window.KCScoring, the same way js/parent/results.js does,
// so the report and the Results page cannot drift apart.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { authMiddleware } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianAccess');
const Assessment = require('../models/Assessment');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const User = require('../models/User');
const PediaCustomQuestionAssignment = require('../models/PediaCustomQuestionAssignment');
const { DATA_ORIGIN } = require('../constants/dataOrigin');

// The four scoring domains, in the order the parent pages display them.
// Mirrors the buckets in routes/assessments.js — kept as a display order only,
// never as a scoring input.
const DOMAINS = Object.freeze([
  Object.freeze({ key: 'communication', label: 'Communication', scoreField: 'communicationScore', statusField: 'communicationStatus' }),
  Object.freeze({ key: 'social',        label: 'Social Skills', scoreField: 'socialScore',        statusField: 'socialStatus' }),
  Object.freeze({ key: 'cognitive',     label: 'Cognitive',     scoreField: 'cognitiveScore',     statusField: 'cognitiveStatus' }),
  Object.freeze({ key: 'motor',         label: 'Motor Skills',  scoreField: 'motorScore',         statusField: 'motorStatus' }),
]);

/**
 * Whole months between two dates, clamped at 0.
 *
 * Age at assessment is DERIVED, not stored — no assessment record carries the
 * child's age at the time it was taken. getAgeInfo() in routes/assessments.js
 * measures against `now`, which is correct for "can this child be screened?"
 * but wrong for a historical timeline: it would relabel every past assessment
 * with the child's age today. Returns null when either date is unusable, so a
 * missing age reads as unknown rather than as zero.
 */
function ageInMonths(dateOfBirth, atDate) {
  if (!dateOfBirth || !atDate) return null;
  const dob = new Date(dateOfBirth);
  const at = new Date(atDate);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(at.getTime())) return null;

  let months = (at.getFullYear() - dob.getFullYear()) * 12 + (at.getMonth() - dob.getMonth());
  if (at.getDate() < dob.getDate()) months -= 1;
  return Math.max(0, months);
}

function formatPersonName(user, fallback) {
  if (!user) return fallback;
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || fallback;
}

/**
 * Ownership gate. Copied deliberately from the check at
 * routes/assessments.js:775-778 so this endpoint cannot be more permissive
 * than the history endpoint it reports on.
 *
 * The child is loaded by the :childId in the URL and the owner is read off
 * that document. No parentId is ever accepted from the client.
 */
async function loadPermittedChild(req) {
  const { childId } = req.params;

  // An unparseable id would otherwise throw a CastError and surface as a 500.
  // A malformed id is a "no such child" case, not a server fault.
  if (!mongoose.Types.ObjectId.isValid(childId)) return { child: null, allowed: false };

  const child = await Child.findById(childId).lean();
  if (!child) return { child: null, allowed: false };

  const isParentOwner = String(child.parentId) === String(req.user.userId);
  const isPediaLinked = req.user.role === 'pediatrician'
    && await Appointment.exists({ childId: child._id, pediatricianId: req.user.userId });
  const allowed = isParentOwner
    || isPediaLinked
    || req.user.role === 'admin'
    || await hasPermission(req.user.userId, child._id, 'viewAssessments');

  return { child, allowed };
}

// GET /api/parent/children/:childId/report
// Chronological screening history for one child, oldest first.
router.get('/children/:childId/report', authMiddleware, async (req, res) => {
  try {
    const { child, allowed } = await loadPermittedChild(req);
    if (!child) return res.status(404).json({ error: 'Child not found.' });
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    // Only completed screenings belong on a progress timeline. Abandoned
    // in_progress drafts have no result document and would render as gaps.
    const assessments = await Assessment.find({ childId: child._id, status: 'complete' })
      .sort({ completedAt: 1, startedAt: 1 })
      .lean();

    const assessmentIds = assessments.map((a) => a._id);

    // One query per collection rather than per assessment — the history helper
    // in routes/assessments.js uses the same $in shape.
    const [results, answerCounts, domainAnswerCounts, reviewers] = await Promise.all([
      AssessmentResult.find({ assessmentId: { $in: assessmentIds } }).lean(),

      // Provenance is preserved by counting answers per origin rather than
      // merging them. A core-bank item and a pediatrician-authored item must
      // never become indistinguishable in this response.
      AssessmentAnswer.aggregate([
        { $match: { assessmentId: { $in: assessmentIds } } },
        { $group: { _id: { assessmentId: '$assessmentId', origin: '$origin' }, count: { $sum: 1 } } },
      ]),

      // Per-domain answer counts. This is a COUNT, not a score — it exists so
      // the report can tell "0% because every answer scored 0" apart from
      // "0% because nothing was ever recorded for this domain", per the
      // adviser requirement that a 0% must never be presented as a
      // developmental finding when it is actually a missing-data artifact.
      // routes/assessments.js POST /submit writes `domain` as one of the same
      // four full labels used in DOMAINS[].label above, so this counts
      // straight into that vocabulary with no translation step.
      AssessmentAnswer.aggregate([
        { $match: { assessmentId: { $in: assessmentIds } } },
        { $group: { _id: { assessmentId: '$assessmentId', domain: '$domain' }, count: { $sum: 1 } } },
      ]),

      User.find({
        _id: { $in: assessments.map((a) => a.reviewedByPediatrician).filter(Boolean) },
      }).select('firstName lastName').lean(),
    ]);

    const resultMap = new Map(results.map((r) => [String(r.assessmentId), r]));
    const reviewerMap = new Map(reviewers.map((u) => [String(u._id), u]));

    const originMap = new Map();
    for (const row of answerCounts) {
      const key = String(row._id.assessmentId);
      if (!originMap.has(key)) originMap.set(key, {});
      // A legacy answer written before constants/dataOrigin.js existed may have
      // no origin at all. Label it 'unknown' rather than assuming core bank.
      originMap.get(key)[row._id.origin || 'unknown'] = row.count;
    }

    const domainCountMap = new Map();
    for (const row of domainAnswerCounts) {
      const key = String(row._id.assessmentId);
      if (!domainCountMap.has(key)) domainCountMap.set(key, {});
      domainCountMap.get(key)[row._id.domain] = row.count;
    }

    // Records the report could not fully render, so the caller can see what was
    // incomplete instead of silently receiving a shorter list.
    const unrenderable = [];

    const timeline = assessments.map((a) => {
      const r = resultMap.get(String(a._id));
      const scoresAvailable = Boolean(r);
      const assessedAt = a.completedAt || null;

      if (!scoresAvailable) {
        unrenderable.push({ assessmentId: String(a._id), reason: 'no_stored_result' });
      }
      if (!assessedAt) {
        unrenderable.push({ assessmentId: String(a._id), reason: 'no_completed_date' });
      }

      const reviewer = a.reviewedByPediatrician
        ? reviewerMap.get(String(a.reviewedByPediatrician))
        : null;

      return {
        id: String(a._id),
        startedAt: a.startedAt || null,
        completedAt: assessedAt,

        // Derived from dateOfBirth and completedAt — see ageInMonths().
        ageAtAssessmentMonths: ageInMonths(child.dateOfBirth, assessedAt),
        ageIsDerived: true,

        scoresAvailable,

        // Stored values only. `status` is the string persisted at submit time;
        // `scoringBandsVersion` says which band set produced it (null means the
        // document predates constants/scoring.js).
        domains: DOMAINS.map((d) => ({
          key: d.key,
          label: d.label,
          score: r ? (r[d.scoreField] ?? null) : null,
          storedStatus: r ? (r[d.statusField] ?? null) : null,
          // How many answers this domain actually has on record for this
          // assessment — lets the client tell a genuine 0% apart from a
          // domain nothing was ever answered for. Not used for scoring.
          answeredItemCount: domainCountMap.get(String(a._id))?.[d.label] ?? 0,
        })),
        overallScore: r ? (r.overallScore ?? null) : null,
        riskFlags: r && Array.isArray(r.riskFlags) ? r.riskFlags : [],
        scoringBandsVersion: r ? (r.scoringBandsVersion ?? null) : null,
        generatedAt: r ? (r.generatedAt ?? null) : null,

        // Item counts keyed by origin, e.g. { core_bank: 34 }.
        itemsByOrigin: originMap.get(String(a._id)) || {},

        review: {
          reviewedAt: a.reviewedAt || null,
          pediatricianId: a.reviewedByPediatrician ? String(a.reviewedByPediatrician) : null,
          pediatricianName: reviewer ? formatPersonName(reviewer, 'Pediatrician') : null,
          recommendations: a.recommendations || null,
          nextAssessmentDate: a.nextAssessmentDate || null,
          nextAssessmentReason: a.nextAssessmentReason || null,
        },
      };
    });

    // ── Follow-up ──────────────────────────────────────────────────────────
    // There is no stored recall INTERVAL anywhere in this system — only the
    // absolute nextAssessmentDate a pediatrician entered in the diagnose
    // endpoint. The suggestion helper at js/pedia/pediatrician-patients.js:136
    // is a form prefill and is never persisted, and docs/SCORING.md §8 lists
    // its band mapping as an open clinical question. So: surface the date when
    // one exists, and say plainly that none is scheduled when it does not.
    // Never derive one from a score.
    let followUp = null;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      if (timeline[i].review.nextAssessmentDate) {
        followUp = {
          nextAssessmentDate: timeline[i].review.nextAssessmentDate,
          reason: timeline[i].review.nextAssessmentReason,
          setByPediatricianName: timeline[i].review.pediatricianName,
          fromAssessmentId: timeline[i].id,
        };
        break;
      }
    }

    // ── Pediatrician follow-up questions ───────────────────────────────────
    // Kept in their OWN section, never folded into the timeline above.
    //
    // PediaCustomQuestionAssignment.assessmentId is set ONLY when a question
    // was explicitly folded into a reassessment's submission (see
    // routes/assessments.js POST /submit, "Custom Question answers" block) —
    // at that point it was scored under the SAME 2/0 scale as a core-bank
    // item and is already reflected in that assessment's own AssessmentResult
    // and, therefore, in the timeline above. Surfacing it again here would
    // present already-scored assessment content as if it were separate,
    // unscored pediatrician data — exactly the mixing this section exists to
    // avoid. Only assignments still unclaimed by any assessment (assessmentId
    // still null — answered standalone via routes/custom-questions.js, which
    // never touches Assessment/AssessmentResult) belong here.
    const assignments = await PediaCustomQuestionAssignment.find({ childId: child._id })
      .populate({
        path: 'questionId',
        populate: { path: 'pediatricianId', select: 'firstName lastName' },
      })
      .sort({ answeredAt: -1, createdAt: -1 })
      .lean();

    const hasMeaningfulAnswer = (a) => a.answer != null && String(a.answer).trim() !== '';
    const answeredAssignments = assignments.filter((a) => hasMeaningfulAnswer(a) && !a.assessmentId);
    // Genuinely still open — unanswered AND not already folded into a
    // reassessment (a folded-but-answered row is neither "pending" here nor
    // shown above; it already has its own place in the timeline).
    const pendingAssignments = assignments.filter((a) => !hasMeaningfulAnswer(a) && !a.assessmentId);
    const scoredElsewhereCount = assignments.filter((a) => Boolean(a.assessmentId)).length;

    const customQuestions = {
      origin: DATA_ORIGIN.PEDIA_ENTRY,
      answeredCount: answeredAssignments.length,
      pendingCount: pendingAssignments.length,
      // Answered but already scored as part of a specific completed
      // assessment (see the comment above) — not shown in `items` below,
      // surfaced only as a count so this section's totals stay honest.
      scoredElsewhereCount,
      // Not scored, and not attributable to any single screening session.
      isScored: false,
      items: answeredAssignments.map((a) => ({
        assignmentId: a.id,
        questionText: a.questionId?.questionText || '(Question text not recorded)',
        domain: a.questionId?.domain || 'Other',
        answer: a.answer,
        answeredAt: a.answeredAt || null,
        pediatricianName: formatPersonName(a.questionId?.pediatricianId, 'Pediatrician'),
      })),
    };

    res.json({
      success: true,
      child: {
        id: String(child._id),
        firstName: child.firstName || '',
        lastName: child.lastName || '',
        dateOfBirth: child.dateOfBirth || null,
        gender: child.gender || null,
      },
      // Oldest first. The page reverses this for its most-recent-first list;
      // the chart consumes it in this order.
      assessments: timeline,
      completedCount: timeline.length,
      // A trend needs two points. Stated by the server so the page and any
      // future consumer agree on what counts as "not enough data yet".
      trendAvailable: timeline.filter((t) => t.overallScore != null).length >= 2,
      followUp,
      customQuestions,
      // Non-empty when a completed assessment was missing a score or a date.
      unrenderable,
    });
  } catch (err) {
    console.error('parent-reports report error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
