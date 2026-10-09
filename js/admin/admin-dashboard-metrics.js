// js/admin/admin-dashboard-metrics.js
// ============================================================================
// Pure, no-DB, no-network helpers for the Administrator Dashboard
// (ADMIN/admin-dashboard.html). They only rearrange the counts that
// GET /api/admin/dashboard already returns — no query, filter or API field is
// changed, and nothing here invents a value. A share is only produced when its
// numerator and denominator come from the same population; otherwise the
// helper returns null and the page shows "N/A".
//
// Source of every input (routes/admin.js, GET /dashboard), all-time, no date
// filter:
//   totalUsers           User.countDocuments()                — every role, every status
//   parentCount          User.countDocuments({role:'parent'})
//   pediatricianCount    User.countDocuments({role:'pediatrician'})
//   secretaryCount       User.countDocuments({role:'secretary'})
//   adminCount           User.countDocuments({role:'admin'})
//   activeAssessments    Assessment.countDocuments({status:'in_progress'})
//   completedScreenings  Assessment.countDocuments({status:{$in:['submitted','complete']}})
//   completedAssessments Assessment.countDocuments({status:'complete'})
//
// Two values are derived from those, never fetched:
//   other guardian roles = totalUsers − (parent + pediatrician + secretary + admin)
//     User.role is a required enum, so the remainder is exactly the
//     legal_guardian, foster_parent and court_appointed accounts.
//   submitted            = completedScreenings − completedAssessments
//     Assessment.status is an enum of in_progress | submitted | complete, so
//     in_progress + submitted + complete is every assessment session.
//
// Dual-mode like js/admin/analytics-interpretations.js: Node (tests) via
// require(), browser via window.KCAdminDashboardMetrics.
// ============================================================================

(function (global) {
  'use strict';

  // A count from the API, or null when it is missing or not a usable count.
  function toCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
      ? value
      : null;
  }

  // part ÷ whole × 100, or null when it cannot be calculated honestly:
  // a missing value, an empty population (no division by zero) or a part
  // larger than its whole (the two counts cannot be the same population).
  function share(part, whole) {
    if (part == null || whole == null || whole <= 0 || part > whole) return null;
    return (part / whole) * 100;
  }

  function formatCount(value) {
    return value == null ? '—' : value.toLocaleString('en-US');
  }

  function formatShare(percent) {
    if (percent == null) return 'N/A';
    // A non-zero share that would round to "0.0%" is shown as "<0.1%" instead.
    if (percent > 0 && percent < 0.05) return '<0.1%';
    return `${percent.toFixed(1)}%`;
  }

  // Role rows for the User Distribution card. Each share is the role's count
  // ÷ totalUsers — the same all-roles, all-statuses population.
  function buildUserDistribution(data) {
    const d = data || {};
    const total = toCount(d.totalUsers);
    const named = [
      { key: 'parent', label: 'Parents', count: toCount(d.parentCount) },
      { key: 'pediatrician', label: 'Pediatricians', count: toCount(d.pediatricianCount) },
      { key: 'secretary', label: 'Secretaries', count: toCount(d.secretaryCount) },
      { key: 'admin', label: 'Admins', count: toCount(d.adminCount) },
    ];

    const allNamedKnown = named.every((row) => row.count != null);
    const namedSum = allNamedKnown ? named.reduce((sum, row) => sum + row.count, 0) : null;
    const otherCount = total != null && namedSum != null && total >= namedSum ? total - namedSum : null;

    const rows = [
      ...named,
      { key: 'otherGuardian', label: 'Other guardian roles', count: otherCount },
    ].map((row) => ({ ...row, share: share(row.count, total) }));

    return { total, rows };
  }

  // Status breakdown of every assessment session. Shares are sessions in a
  // status ÷ all sessions. available:false when any input is missing or the
  // counts contradict each other, so the page never draws a misleading bar.
  function buildAssessmentBreakdown(data) {
    const d = data || {};
    const inProgress = toCount(d.activeAssessments);
    const complete = toCount(d.completedAssessments);
    const submittedOrComplete = toCount(d.completedScreenings);

    if (inProgress == null || complete == null || submittedOrComplete == null || submittedOrComplete < complete) {
      return { available: false, total: null, segments: [] };
    }

    const submitted = submittedOrComplete - complete;
    const total = inProgress + submitted + complete;
    const segments = [
      { key: 'complete', label: 'Completed', count: complete },
      { key: 'submitted', label: 'Submitted, awaiting result', count: submitted },
      { key: 'inProgress', label: 'In progress', count: inProgress },
    ].map((segment) => ({ ...segment, share: share(segment.count, total) }));

    return { available: true, total, segments };
  }

  const api = {
    toCount,
    share,
    formatCount,
    formatShare,
    buildUserDistribution,
    buildAssessmentBreakdown,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCAdminDashboardMetrics = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
