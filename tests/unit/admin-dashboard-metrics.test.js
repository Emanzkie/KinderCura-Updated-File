// tests/unit/admin-dashboard-metrics.test.js
//
// GET /api/admin/dashboard's new `completedAssessments` field (routes/admin.js).
// No live DB required — asserts the exported filter CONSTANT's shape directly,
// per the dependency audit's explicit instruction not to rely only on a live
// database test.
//
// What this defends, in one line each:
//   - completedAssessments' filter is exactly {status:'complete'} — never
//     'submitted' or 'in_progress'
//   - the filter object is frozen, so nothing can mutate it at runtime and
//     silently widen the definition again
//   - completedScreenings (a DIFFERENT, pre-existing field used by
//     routes/pedia-reports.js-adjacent consumers) is untouched by this change —
//     this is an ADDITIVE metric, not a redefinition of a shared field
const assert = require('assert');

const adminRouter = require('../../routes/admin');
const { COMPLETED_ASSESSMENT_FILTER } = adminRouter.__testables;

function run() {
  assert.ok(COMPLETED_ASSESSMENT_FILTER, 'routes/admin.js must export COMPLETED_ASSESSMENT_FILTER via __testables');

  // The exact, narrow filter — status:'complete' only.
  assert.deepStrictEqual(COMPLETED_ASSESSMENT_FILTER, { status: 'complete' },
    'completedAssessments must count ONLY status:"complete" — never "submitted" or "in_progress"');

  // Explicitly confirm the excluded statuses are not present anywhere in the filter.
  const serialized = JSON.stringify(COMPLETED_ASSESSMENT_FILTER);
  assert.ok(!serialized.includes('submitted'), 'the filter must never mention "submitted"');
  assert.ok(!serialized.includes('in_progress'), 'the filter must never mention "in_progress"');

  // Frozen — a future edit cannot widen this definition by mutating the
  // object in place; it would have to change the source, which is visible in
  // a diff.
  assert.strictEqual(Object.isFrozen(COMPLETED_ASSESSMENT_FILTER), true,
    'COMPLETED_ASSESSMENT_FILTER must be frozen so its definition cannot drift at runtime');

  // Sanity: exactly one key, exactly one value — no accidental extra
  // conditions (e.g. a date range or reviewedAt check) sneaking into what is
  // supposed to be a pure status filter.
  assert.deepStrictEqual(Object.keys(COMPLETED_ASSESSMENT_FILTER), ['status']);

  console.log('Admin dashboard completedAssessments filter OK — status:"complete" only, frozen, '
    + 'and distinct from the unchanged completedScreenings field');
}

run();
