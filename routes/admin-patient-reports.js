// routes/admin-patient-reports.js
//
// Admin-facing CENTRALIZED PATIENT REPORTS pivot — the backend for the new
// section on the EXISTING ADMIN/admin-reports.html page. It does not replace
// PARENT/reports.html or PEDIA/pedia-reports.html; it aggregates the SAME
// stored data those pages already read so an admin can pivot across
// pediatrician / parent / child / date without leaving one page.
//
// READ-ONLY BY DESIGN, AND NOT A SCORING PATH.
// ---------------------------------------------------------------------------
// Every score this file returns comes straight out of AssessmentResult
// (written once, by routes/assessments.js POST /submit) and every band comes
// from constants/scoring.js bandFor()/isRiskFlagged()/clinicalLabel() — the
// exact functions routes/pedia-reports.js and routes/admin-reports.js already
// call. Nothing here recomputes a score, invents a band cutoff, or generates
// a diagnosis. A stored pediatrician review is surfaced verbatim or not at
// all — never synthesized.
//
// RELATIONSHIPS ARE REUSED, NOT REINVENTED — see services/adminPatientReportsView.js
// header comment for the audited source of truth for each one:
//   Child -> Parent        : Child.parentId
//   Pediatrician -> Child  : Appointment.pediatricianId + Appointment.childId
//
// PERFORMANCE — see req 23. Every endpoint below is ONE aggregation pipeline
// (plus, where unavoidable, one small distinct() to resolve a pediatrician's
// patient-id list before building the pipeline's $match). None of them loop
// over patients issuing a query per row.
//
// ACCESS CONTROL — authMiddleware + adminOnly on every route, matching every
// other admin-only reporting router in this codebase (routes/admin-reports.js,
// the Data Sources endpoints in routes/admin.js). Never exposed to parents or
// pediatricians.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { authMiddleware, adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');
const scoring = require('../constants/scoring');
const {
  parsePatientReportQuery,
  filtersEcho,
  resolveChildIdConstraint,
  pivotTitle,
  paginationEnvelope,
} = require('../services/adminPatientReportsView');

const COL = Object.freeze({
  users: User.collection.name,
  children: Child.collection.name,
  assessments: Assessment.collection.name,
  results: AssessmentResult.collection.name,
  appointments: Appointment.collection.name,
});

function fullName(user) {
  if (!user) return null;
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || null;
}

function toObjectId(id) {
  return new mongoose.Types.ObjectId(id);
}

// The assessment-window match expression shared by every pipeline below.
// Uses completedAt ONLY (req 9) — never updatedAt, never a startedAt
// fallback, so a date filter means exactly "completed in this window".
function assessmentWindowExpr(dateFrom, dateTo) {
  const clauses = [{ $eq: ['$status', 'complete'] }];
  if (dateFrom) clauses.push({ $gte: ['$completedAt', dateFrom] });
  if (dateTo) clauses.push({ $lte: ['$completedAt', dateTo] });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/patient-reports/overview
//
// System-wide totals (always unfiltered — the fixed reference point req 15
// asks for) plus two roster summaries (req 5/7), each respecting ONLY the
// optional date range (a roster answers "who is active", not "who matches
// today's drill-down"). Capped at 25 rows per roster, newest activity first —
// this is a compact "at a glance" summary; the full, paginated browsing
// experience is GET /patients below.
// ═══════════════════════════════════════════════════════════════════════════
const ROSTER_CAP = 25;

router.get('/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filters = parsePatientReportQuery(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    const [
      totalPatients, totalParents, totalPediatricians,
      totalCompletedAssessments, totalAppointments, totalReviewed,
    ] = await Promise.all([
      Child.countDocuments(),
      User.countDocuments({ role: 'parent' }),
      User.countDocuments({ role: 'pediatrician' }),
      Assessment.countDocuments({ status: 'complete' }),
      Appointment.countDocuments(),
      Assessment.countDocuments({ status: 'complete', reviewedAt: { $ne: null } }),
    ]);

    const windowExpr = assessmentWindowExpr(filters.dateFrom, filters.dateTo);

    // ── Pediatrician roster — one aggregation over Appointment ──────────────
    const pediatricianSummary = await Appointment.aggregate([
      { $match: { pediatricianId: { $ne: null } } },
      { $group: { _id: { pediatricianId: '$pediatricianId', childId: '$childId' } } },
      { $group: { _id: '$_id.pediatricianId', childIds: { $addToSet: '$_id.childId' } } },
      {
        $lookup: {
          from: COL.assessments,
          let: { kids: '$childIds' },
          pipeline: [
            { $match: { $expr: { $and: [{ $in: ['$childId', '$$kids'] }, windowExpr] } } },
            { $project: { reviewedAt: 1, completedAt: 1 } },
          ],
          as: 'assessmentsInRange',
        },
      },
      {
        $addFields: {
          patients: { $size: '$childIds' },
          assessments: { $size: '$assessmentsInRange' },
          reviewed: {
            $size: { $filter: { input: '$assessmentsInRange', cond: { $ne: ['$$this.reviewedAt', null] } } },
          },
          latestActivity: { $max: '$assessmentsInRange.completedAt' },
        },
      },
      { $lookup: { from: COL.users, localField: '_id', foreignField: '_id', as: 'pedUser' } },
      { $unwind: '$pedUser' },
      {
        $project: {
          _id: 0,
          pediatricianId: { $toString: '$_id' },
          firstName: '$pedUser.firstName',
          lastName: '$pedUser.lastName',
          patients: 1, assessments: 1, reviewed: 1, latestActivity: 1,
        },
      },
      { $sort: { latestActivity: -1, pediatricianId: 1 } },
      { $limit: ROSTER_CAP },
    ]);

    // ── Parent roster — one aggregation over Child ──────────────────────────
    const parentSummary = await Child.aggregate([
      { $match: { parentId: { $ne: null } } },
      { $group: { _id: '$parentId', childIds: { $addToSet: '$_id' } } },
      {
        $lookup: {
          from: COL.assessments,
          let: { kids: '$childIds' },
          pipeline: [
            { $match: { $expr: { $and: [{ $in: ['$childId', '$$kids'] }, windowExpr] } } },
            { $project: { completedAt: 1 } },
          ],
          as: 'assessmentsInRange',
        },
      },
      {
        $addFields: {
          children: { $size: '$childIds' },
          assessments: { $size: '$assessmentsInRange' },
          latestActivity: { $max: '$assessmentsInRange.completedAt' },
        },
      },
      { $lookup: { from: COL.users, localField: '_id', foreignField: '_id', as: 'parentUser' } },
      { $unwind: '$parentUser' },
      {
        $project: {
          _id: 0,
          parentId: { $toString: '$_id' },
          firstName: '$parentUser.firstName',
          lastName: '$parentUser.lastName',
          children: 1, assessments: 1, latestActivity: 1,
        },
      },
      { $sort: { latestActivity: -1, parentId: 1 } },
      { $limit: ROSTER_CAP },
    ]);

    res.json({
      success: true,
      range: { from: filters.dateFrom ? filters.dateFrom.toISOString() : null, to: filters.dateTo ? filters.dateTo.toISOString() : null },
      systemTotals: {
        totalPatients, totalParents, totalPediatricians,
        totalCompletedAssessments, totalAppointments, totalReviewed,
      },
      pediatricianSummary: pediatricianSummary.map((p) => ({
        pediatricianId: p.pediatricianId,
        name: fullName(p) || 'Unknown Pediatrician',
        patients: p.patients, assessments: p.assessments, reviewed: p.reviewed,
        latestActivity: p.latestActivity || null,
      })),
      pediatricianSummaryCapped: pediatricianSummary.length >= ROSTER_CAP,
      parentSummary: parentSummary.map((p) => ({
        parentId: p.parentId,
        name: fullName(p) || 'Unknown Parent',
        children: p.children, assessments: p.assessments,
        latestActivity: p.latestActivity || null,
      })),
      parentSummaryCapped: parentSummary.length >= ROSTER_CAP,
    });
  } catch (err) {
    console.error('admin-patient-reports overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/patient-reports/patients
//
// The main pivot table: filtered, sorted, paginated patient rows, plus the
// FILTERED summary (req 15) for the currently-applied filter combination.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/patients', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filters = parsePatientReportQuery(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    // Resolve the pediatrician's patient-id list ONCE (a single distinct()),
    // then intersect with any childId filter (req 16) — never two competing
    // relationship definitions.
    let pediatricianChildIds = null;
    if (filters.pediatricianId) {
      pediatricianChildIds = await Appointment.distinct('childId', { pediatricianId: toObjectId(filters.pediatricianId) });
    }
    const childIdConstraint = resolveChildIdConstraint({
      childId: filters.childId,
      pediatricianId: filters.pediatricianId,
      pediatricianChildIds,
    });

    const childMatch = {};
    if (childIdConstraint !== null) {
      childMatch._id = { $in: childIdConstraint.length ? childIdConstraint.map((id) => toObjectId(id)) : [null] };
    }
    if (filters.parentId) childMatch.parentId = toObjectId(filters.parentId);

    // Resolved once, upfront, for the pivot title — never derived from
    // whichever row happens to land on the current page, which could be
    // empty (page 2 of an empty page 1) or, for the pediatrician case,
    // display a DIFFERENT pediatrician than the one filtered on if a child's
    // most recent appointment has since moved to someone else.
    const [pediatricianNameMap, parentNameMap, childNameMap] = await Promise.all([
      namesForIds(User, [filters.pediatricianId]),
      namesForIds(User, [filters.parentId]),
      namesForIds(Child, [filters.childId]),
    ]);

    const windowExpr = assessmentWindowExpr(filters.dateFrom, filters.dateTo);
    const sortDirection = filters.sort === 'oldest' ? 1 : -1;

    const pipeline = [
      { $match: childMatch },
      // ── Assessments within the active date window ─────────────────────
      {
        $lookup: {
          from: COL.assessments,
          let: { cid: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$childId', '$$cid'] }, windowExpr] } } },
            { $sort: { completedAt: -1, _id: -1 } },
          ],
          as: 'assessmentsInRange',
        },
      },
      {
        $addFields: {
          assessmentsCount: { $size: '$assessmentsInRange' },
          latestAssessment: { $arrayElemAt: ['$assessmentsInRange', 0] },
          reviewedCount: {
            $size: { $filter: { input: '$assessmentsInRange', cond: { $ne: ['$$this.reviewedAt', null] } } },
          },
          hasFollowUp: {
            $gt: [{
              $size: {
                $filter: {
                  input: '$assessmentsInRange',
                  cond: { $or: [{ $ne: ['$$this.nextAssessmentDate', null] }, { $ne: ['$$this.recommendations', null] }] },
                },
              },
            }, 0],
          },
        },
      },
      // ── Report Scope — narrows the POPULATION, unlike the date range ────
      ...(filters.scope === 'assessments' ? [{ $match: { assessmentsCount: { $gt: 0 } } }] : []),
      ...(filters.scope === 'reviewed' ? [{ $match: { reviewedCount: { $gt: 0 } } }] : []),
      ...(filters.scope === 'followup' ? [{ $match: { hasFollowUp: true } }] : []),
      // ── Latest score for the latest in-range assessment ─────────────────
      {
        $lookup: {
          from: COL.results,
          localField: 'latestAssessment._id',
          foreignField: 'assessmentId',
          as: 'latestResultArr',
        },
      },
      { $addFields: { latestResult: { $arrayElemAt: ['$latestResultArr', 0] } } },
      // ── Current pediatrician (most recent appointment) for DISPLAY ──────
      {
        $lookup: {
          from: COL.appointments,
          let: { cid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$childId', '$$cid'] } } },
            { $sort: { appointmentDate: -1, id: -1 } },
            { $limit: 1 },
            { $project: { pediatricianId: 1 } },
          ],
          as: 'latestAppt',
        },
      },
      { $addFields: { currentPediatricianId: { $arrayElemAt: ['$latestAppt.pediatricianId', 0] } } },
      { $lookup: { from: COL.users, localField: 'parentId', foreignField: '_id', as: 'parentUser' } },
      { $lookup: { from: COL.users, localField: 'currentPediatricianId', foreignField: '_id', as: 'pediatricianUser' } },
      {
        $project: {
          firstName: 1, lastName: 1, dateOfBirth: 1, parentId: 1,
          assessmentsCount: 1, reviewedCount: 1,
          latestAssessmentId: '$latestAssessment._id',
          latestCompletedAt: '$latestAssessment.completedAt',
          latestReviewedAt: '$latestAssessment.reviewedAt',
          latestReviewedBy: '$latestAssessment.reviewedByPediatrician',
          latestRecommendations: '$latestAssessment.recommendations',
          latestNextAssessmentDate: '$latestAssessment.nextAssessmentDate',
          latestOverallScore: '$latestResult.overallScore',
          currentPediatricianId: 1,
          parentUser: { $arrayElemAt: ['$parentUser', 0] },
          pediatricianUser: { $arrayElemAt: ['$pediatricianUser', 0] },
        },
      },
      { $sort: { latestCompletedAt: sortDirection, _id: 1 } },
      {
        $facet: {
          rows: [{ $skip: (filters.page - 1) * filters.limit }, { $limit: filters.limit }],
          totalMatched: [{ $count: 'n' }],
          aggregates: [
            {
              $group: {
                _id: null,
                totalAssessments: { $sum: '$assessmentsCount' },
                totalReviewed: { $sum: '$reviewedCount' },
                latestActivity: { $max: '$latestCompletedAt' },
              },
            },
          ],
        },
      },
    ];

    const [facet] = await Child.aggregate(pipeline);
    const totalMatched = facet.totalMatched[0]?.n || 0;
    const aggregates = facet.aggregates[0] || { totalAssessments: 0, totalReviewed: 0, latestActivity: null };

    const rows = facet.rows.map((c) => {
      const overallScore = c.latestOverallScore;
      const hasScore = typeof overallScore === 'number';
      const band = hasScore ? scoring.bandFor(overallScore) : null;
      return {
        childId: String(c._id),
        childName: fullName(c) || 'Unnamed Child',
        parentId: c.parentId ? String(c.parentId) : null,
        parentName: fullName(c.parentUser) || 'Unknown Parent',
        pediatricianId: c.currentPediatricianId ? String(c.currentPediatricianId) : null,
        pediatricianName: fullName(c.pediatricianUser),
        assessmentsCount: c.assessmentsCount,
        reviewedCount: c.reviewedCount,
        latestAssessmentId: c.latestAssessmentId ? String(c.latestAssessmentId) : null,
        latestAssessmentDate: c.latestCompletedAt || null,
        latestScore: hasScore ? Math.round(overallScore) : null,
        latestStatusLabel: band ? scoring.clinicalLabel(band) : null,
        hasReview: Boolean(c.latestReviewedAt),
        latestRecommendations: c.latestRecommendations || null,
        latestNextAssessmentDate: c.latestNextAssessmentDate || null,
      };
    });

    // "Patients" is the RELATIONSHIP+SCOPE-filtered population size — see the
    // header comment for why this does not shrink from the date range alone.
    res.json({
      success: true,
      title: pivotTitle({
        pediatricianName: filters.pediatricianId ? pediatricianNameMap.get(filters.pediatricianId) : null,
        parentName: filters.parentId ? parentNameMap.get(filters.parentId) : null,
        childName: filters.childId ? childNameMap.get(filters.childId) : null,
      }),
      filters: filtersEcho(filters),
      summary: {
        patients: totalMatched,
        assessments: aggregates.totalAssessments,
        reviewed: aggregates.totalReviewed,
        latestActivity: aggregates.latestActivity || null,
      },
      rows,
      pagination: paginationEnvelope(totalMatched, filters.page, filters.limit),
    });
  } catch (err) {
    console.error('admin-patient-reports patients error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Small helper: resolve a short list of User ids to display names in one query.
async function namesForIds(Model, ids) {
  const valid = ids.filter(Boolean);
  if (!valid.length) return new Map();
  const users = await Model.find({ _id: { $in: valid.map((id) => toObjectId(id)) } }).select('firstName lastName').lean();
  return new Map(users.map((u) => [String(u._id), fullName(u)]));
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/patient-reports/search?type=parent|child&q=&pediatricianId=&parentId=
//
// Lightweight typeahead so the Parent/Child filter dropdowns never load the
// whole User/Child collection into the browser (req 23). Returns at most 20
// matches, id + display name only.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/search', authMiddleware, adminOnly, async (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    if (!['parent', 'child'].includes(type)) {
      return res.status(400).json({ error: 'type must be "parent" or "child".' });
    }
    const q = String(req.query.q || '').trim();
    const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    if (type === 'parent') {
      const match = { role: 'parent' };
      if (rx) match.$or = [{ firstName: rx }, { lastName: rx }, { email: rx }];
      const users = await User.find(match).select('firstName lastName email').limit(20).lean();
      return res.json({ success: true, results: users.map((u) => ({ id: String(u._id), name: fullName(u) || u.email || 'Unknown Parent' })) });
    }

    // type === 'child'
    const match = {};
    if (rx) match.$or = [{ firstName: rx }, { lastName: rx }];
    if (req.query.parentId && mongoose.Types.ObjectId.isValid(req.query.parentId)) {
      match.parentId = toObjectId(req.query.parentId);
    }
    if (req.query.pediatricianId && mongoose.Types.ObjectId.isValid(req.query.pediatricianId)) {
      const ids = await Appointment.distinct('childId', { pediatricianId: toObjectId(req.query.pediatricianId) });
      match._id = { $in: ids };
    }
    const children = await Child.find(match).select('firstName lastName dateOfBirth').limit(20).lean();
    return res.json({ success: true, results: children.map((c) => ({ id: String(c._id), name: fullName(c) || 'Unnamed Child' })) });
  } catch (err) {
    console.error('admin-patient-reports search error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
