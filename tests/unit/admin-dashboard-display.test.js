// tests/unit/admin-dashboard-display.test.js
//
// js/admin/admin-dashboard-metrics.js — the display-only helpers behind the
// Administrator Dashboard's role shares and assessment status breakdown.
// No DB, no network: feeds GET /api/admin/dashboard-shaped objects in.
//
// What this defends:
//   - every share is count ÷ the SAME population's total, never a mixed one
//   - the five user roles always add back up to totalUsers
//   - in_progress + submitted + complete add back up to every session
//   - division by zero, missing fields and contradictory counts give
//     null / N/A instead of NaN, Infinity or a made-up number
const assert = require('assert');
const M = require('../../js/admin/admin-dashboard-metrics');

// Shape of a real /api/admin/dashboard response (counts as of 2026-10-09).
const SAMPLE = {
  totalUsers: 1506,
  parentCount: 1218,
  pediatricianCount: 69,
  secretaryCount: 38,
  adminCount: 1,
  activeAssessments: 336,
  completedScreenings: 1384,
  completedAssessments: 1207,
  childCount: 1550,
  uptime: '99.9%',
};

function byKey(rows) {
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

function run() {
  // ---- share() / formatting -------------------------------------------------
  assert.strictEqual(M.share(1, 4), 25);
  assert.strictEqual(M.share(0, 0), null, 'no division by zero');
  assert.strictEqual(M.share(5, 4), null, 'a part larger than its whole is not a valid share');
  assert.strictEqual(M.share(null, 4), null);
  assert.strictEqual(M.formatShare(null), 'N/A');
  assert.strictEqual(M.formatShare(0), '0.0%');
  assert.strictEqual(M.formatShare(0.04), '<0.1%', 'non-zero but rounds to 0.0');
  assert.strictEqual(M.formatShare(0.066), '0.1%');
  assert.strictEqual(M.formatShare(80.876), '80.9%');
  assert.strictEqual(M.formatCount(1506), '1,506');
  assert.strictEqual(M.formatCount(null), '—');
  assert.strictEqual(M.toCount('12'), null, 'strings are not counts');
  assert.strictEqual(M.toCount(-1), null);
  assert.strictEqual(M.toCount(1.5), null);
  assert.strictEqual(M.toCount(0), 0);

  // ---- User distribution ----------------------------------------------------
  const dist = M.buildUserDistribution(SAMPLE);
  const roles = byKey(dist.rows);
  assert.strictEqual(dist.total, 1506);
  assert.strictEqual(roles.otherGuardian.count, 180,
    'other guardian roles = total − parent − pediatrician − secretary − admin');
  assert.strictEqual(dist.rows.reduce((s, r) => s + r.count, 0), SAMPLE.totalUsers,
    'the five roles must add up to Total Users');
  assert.strictEqual(M.formatShare(roles.parent.share), '80.9%');
  assert.strictEqual(M.formatShare(roles.admin.share), '0.1%');
  const shareSum = dist.rows.reduce((s, r) => s + r.share, 0);
  assert.ok(Math.abs(shareSum - 100) < 1e-9, 'role shares must total 100%');

  const noUsers = M.buildUserDistribution({
    totalUsers: 0, parentCount: 0, pediatricianCount: 0, secretaryCount: 0, adminCount: 0,
  });
  assert.ok(noUsers.rows.every((r) => r.share === null), 'zero users → every share N/A');
  assert.strictEqual(byKey(noUsers.rows).otherGuardian.count, 0);

  // An older API without secretaryCount cannot derive the remainder honestly.
  const { secretaryCount, ...noSecretary } = SAMPLE;
  const partial = byKey(M.buildUserDistribution(noSecretary).rows);
  assert.strictEqual(partial.secretary.count, null);
  assert.strictEqual(partial.otherGuardian.count, null);
  assert.strictEqual(partial.otherGuardian.share, null);
  assert.strictEqual(M.formatShare(partial.parent.share), '80.9%', 'known roles still get a share');

  // Role counts larger than the total are contradictory → no remainder.
  const contradictory = byKey(M.buildUserDistribution({ ...SAMPLE, totalUsers: 100 }).rows);
  assert.strictEqual(contradictory.otherGuardian.count, null);
  assert.strictEqual(contradictory.parent.share, null);

  assert.strictEqual(M.buildUserDistribution(undefined).total, null, 'missing payload does not throw');

  // ---- Assessment status breakdown ------------------------------------------
  const br = M.buildAssessmentBreakdown(SAMPLE);
  const seg = byKey(br.segments);
  assert.strictEqual(br.available, true);
  assert.strictEqual(seg.submitted.count, 177, 'submitted = completedScreenings − completedAssessments');
  assert.strictEqual(seg.complete.count, SAMPLE.completedAssessments, 'Completed segment = the Completed card');
  assert.strictEqual(seg.inProgress.count, SAMPLE.activeAssessments, 'In-progress segment = the In-Progress card');
  assert.strictEqual(br.total, 1720);
  assert.strictEqual(M.formatShare(seg.complete.share), '70.2%');
  assert.strictEqual(M.formatShare(seg.submitted.share), '10.3%');
  assert.strictEqual(M.formatShare(seg.inProgress.share), '19.5%');

  const empty = M.buildAssessmentBreakdown({ activeAssessments: 0, completedScreenings: 0, completedAssessments: 0 });
  assert.strictEqual(empty.available, true);
  assert.strictEqual(empty.total, 0);
  assert.ok(empty.segments.every((s) => s.share === null), 'no sessions → every share N/A');

  assert.strictEqual(M.buildAssessmentBreakdown({ ...SAMPLE, completedScreenings: undefined }).available, false);
  assert.strictEqual(M.buildAssessmentBreakdown({ ...SAMPLE, completedScreenings: 10 }).available, false,
    'complete cannot exceed submitted+complete');

  // ---- No fabricated uptime ---------------------------------------------------
  const exported = Object.keys(M).join(' ');
  assert.ok(!/uptime/i.test(exported), 'the metrics module must not produce an uptime value');

  console.log('Admin dashboard display metrics OK — role shares, status breakdown, N/A handling');
}

run();
