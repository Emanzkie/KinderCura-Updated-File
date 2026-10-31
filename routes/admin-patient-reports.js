// routes/admin-patient-reports.js
//
// Admin-facing CENTRALIZED PATIENT REPORTS pivot — the backend for the new
// section on the EXISTING ADMIN/admin-reports.html page. It does not replace
// PARENT/reports.html or PEDIA/pedia-reports.html; it aggregates the SAME
// stored data those pages already read, as aggregated statistics by date
// range and report scope.
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
//
// CONFIDENTIALITY — Admin Reports shows aggregated statistics only. No
// response here carries a child, parent or pediatrician name or id, the
// pediatrician/parent/child filters are ignored so no request can narrow the
// figures to one family, and a status group of 1-4 patients is hidden
// (suppressSmallCounts). Individual records stay in the database untouched.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { authMiddleware, adminOnly } = require('../middleware/auth');
const { sendServerError } = require('../middleware/serverError');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');
const scoring = require('../constants/scoring');
const { parsePatientReportQuery, filtersEcho } = require('../services/adminPatientReportsView');
const { suppressSmallCounts, SMALL_COUNT_MIN } = require('../js/admin/admin-reports-interpretations');

const COL = Object.freeze({
  users: User.collection.name,
  children: Child.collection.name,
  assessments: Assessment.collection.name,
  results: AssessmentResult.collection.name,
  appointments: Appointment.collection.name,
});

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
// System-wide totals, always unfiltered — the fixed reference point req 15
// asks for. Counts only; the per-pediatrician and per-parent name rosters
// that used to be here were removed for patient confidentiality.
// ═══════════════════════════════════════════════════════════════════════════
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

    res.json({
      success: true,
      range: { from: filters.dateFrom ? filters.dateFrom.toISOString() : null, to: filters.dateTo ? filters.dateTo.toISOString() : null },
      systemTotals: {
        totalPatients, totalParents, totalPediatricians,
        totalCompletedAssessments, totalAppointments, totalReviewed,
      },
    });
  } catch (err) {
    console.error('admin-patient-reports overview error:', err);
    res.status(500).json({ error: 'Could not load the patient report overview.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/patient-reports/patients
//
// The FILTERED summary (req 15) for the date range and report scope, plus how
// many of those patients' latest in-range assessment falls in each score
// band. Aggregates only: no patient rows. The pediatrician, parent and child
// filters are ignored, so the figures can never describe one family.
// ═══════════════════════════════════════════════════════════════════════════
const NO_ASSESSMENT_KEY = 'none';

router.get('/patients', authMiddleware, adminOnly, async (req, res) => {
  try {
    const parsed = parsePatientReportQuery(req.query);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const filters = { ...parsed, pediatricianId: null, parentId: null, childId: null };

    const windowExpr = assessmentWindowExpr(filters.dateFrom, filters.dateTo);

    const pipeline = [
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
      {
        $project: {
          assessmentsCount: 1, reviewedCount: 1,
          latestCompletedAt: '$latestAssessment.completedAt',
          latestOverallScore: '$latestResult.overallScore',
        },
      },
      {
        $facet: {
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
          // One row per distinct latest score, so bands are assigned below by
          // constants/scoring.js bandFor() — never a second set of cutoffs.
          latestScores: [{ $group: { _id: '$latestOverallScore', n: { $sum: 1 } } }],
        },
      },
    ];

    const [facet] = await Child.aggregate(pipeline);
    const totalMatched = facet.totalMatched[0]?.n || 0;
    const aggregates = facet.aggregates[0] || { totalAssessments: 0, totalReviewed: 0, latestActivity: null };

    const keys = [...scoring.ACTIVE_BANDS.map((b) => b.key), NO_ASSESSMENT_KEY];
    const counts = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const { _id: score, n } of facet.latestScores || []) {
      const key = typeof score === 'number' ? scoring.bandFor(score) : NO_ASSESSMENT_KEY;
      counts[key in counts ? key : NO_ASSESSMENT_KEY] += n;
    }
    // Fewer than SMALL_COUNT_MIN patients: no breakdown at all. Otherwise a
    // hidden group is sent as null, never as its count.
    const breakdownHidden = totalMatched < SMALL_COUNT_MIN;
    const hidden = breakdownHidden ? keys : suppressSmallCounts(counts, keys);

    // "Patients" is the SCOPE-filtered population size — see the header
    // comment for why this does not shrink from the date range alone.
    res.json({
      success: true,
      filters: filtersEcho(filters),
      summary: {
        patients: totalMatched,
        assessments: aggregates.totalAssessments,
        reviewed: aggregates.totalReviewed,
        latestActivity: aggregates.latestActivity || null,
      },
      bandDistribution: {
        minimumShown: SMALL_COUNT_MIN,
        breakdownHidden,
        rows: keys.map((key) => ({
          key,
          label: key === NO_ASSESSMENT_KEY ? 'No scored assessment in range' : scoring.clinicalLabel(key),
          patients: hidden.includes(key) ? null : counts[key],
        })),
      },
    });
  } catch (err) {
    sendServerError(req, res, err);
  }
});

module.exports = router;
