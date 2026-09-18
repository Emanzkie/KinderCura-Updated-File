// Admin > Reports — Centralized Patient Reports pivot (services/adminPatientReportsView.js).
// No DB required: exercises the pure filter-parsing/intersection helpers
// behind routes/admin-patient-reports.js directly.
//
// What these tests defend, in one line each:
//   - bad ids/dates are rejected with a clear error, never silently ignored
//   - a date-only `dateTo` is extended to end-of-day, not midnight
//   - childId + pediatricianId intersect (req 16); a mismatched pair matches
//     nothing rather than falling back to "all"
//   - the pivot title changes with the active filters, matching the
//     adviser's worked example
//   - pagination math matches the same envelope shape used elsewhere
const assert = require('assert');
const {
  REPORT_SCOPES,
  parsePatientReportQuery,
  resolveChildIdConstraint,
  pivotTitle,
  paginationEnvelope,
} = require('../../services/adminPatientReportsView');

function run() {
  // ── parsePatientReportQuery(): happy path ─────────────────────────────────
  const validId = '507f1f77bcf86cd799439011';
  const parsed = parsePatientReportQuery({
    pediatricianId: validId, dateFrom: '2026-09-01', dateTo: '2026-09-18', scope: 'reviewed', sort: 'oldest', page: '2', limit: '10',
  });
  assert.strictEqual(parsed.pediatricianId, validId);
  assert.strictEqual(parsed.scope, 'reviewed');
  assert.strictEqual(parsed.sort, 'oldest');
  assert.strictEqual(parsed.page, 2);
  assert.strictEqual(parsed.limit, 10);
  // dateTo extended to end of day, not left at midnight.
  assert.strictEqual(parsed.dateTo.getUTCHours(), 23);
  assert.strictEqual(parsed.dateTo.getUTCMinutes(), 59);

  // ── 'all' and blank are both "no filter", not a literal id lookup ────────
  const cleared = parsePatientReportQuery({ pediatricianId: 'all', parentId: '', childId: undefined });
  assert.strictEqual(cleared.pediatricianId, null);
  assert.strictEqual(cleared.parentId, null);
  assert.strictEqual(cleared.childId, null);

  // ── Invalid ids/dates/scope are rejected, never silently dropped (req 16) ─
  assert.ok(parsePatientReportQuery({ pediatricianId: 'not-an-id' }).error, 'a malformed pediatricianId must be an error, not ignored');
  assert.ok(parsePatientReportQuery({ dateFrom: 'not-a-date' }).error);
  assert.ok(parsePatientReportQuery({ scope: 'diagnosis' }).error, 'scope must be restricted to REPORT_SCOPES — no fabricated categories (req 10/21)');
  assert.ok(parsePatientReportQuery({ dateFrom: '2026-09-18', dateTo: '2026-09-01' }).error, 'dateFrom after dateTo must be rejected');

  // Exactly the four real scopes, nothing invented.
  assert.deepStrictEqual([...REPORT_SCOPES].sort(), ['all', 'assessments', 'followup', 'reviewed'].sort());

  // Defaults when nothing is supplied.
  const defaults = parsePatientReportQuery({});
  assert.strictEqual(defaults.scope, 'all');
  assert.strictEqual(defaults.sort, 'newest');
  assert.strictEqual(defaults.page, 1);
  assert.strictEqual(defaults.limit, 20);

  // ── resolveChildIdConstraint(): intersection semantics (req 16) ──────────
  assert.strictEqual(resolveChildIdConstraint({ childId: null, pediatricianId: null }), null,
    'no id filter at all must mean no _id constraint');

  assert.deepStrictEqual(resolveChildIdConstraint({ childId: 'c1', pediatricianId: null }), ['c1']);

  assert.deepStrictEqual(
    resolveChildIdConstraint({ childId: null, pediatricianId: 'p1', pediatricianChildIds: ['c1', 'c2'] }),
    ['c1', 'c2'],
    'pediatricianId alone must resolve to that pediatrician\'s full patient list'
  );

  // The requested child IS one of this pediatrician's patients: intersection keeps it.
  assert.deepStrictEqual(
    resolveChildIdConstraint({ childId: 'c1', pediatricianId: 'p1', pediatricianChildIds: ['c1', 'c2'] }),
    ['c1']
  );

  // The requested child is NOT one of this pediatrician's patients: match
  // NOTHING — never silently fall back to "all of this pediatrician's patients".
  assert.deepStrictEqual(
    resolveChildIdConstraint({ childId: 'c9', pediatricianId: 'p1', pediatricianChildIds: ['c1', 'c2'] }),
    [],
    'a child not belonging to the selected pediatrician must produce an empty result, never a silent fallback'
  );

  // ── pivotTitle(): matches the adviser's worked pivot example (req 14) ────
  assert.strictEqual(pivotTitle({}), 'All Patient Reports');
  assert.strictEqual(pivotTitle({ pediatricianName: 'Dr. Gold Deluna' }), "Dr. Gold Deluna's Patients");
  assert.strictEqual(pivotTitle({ parentName: 'Emmanuel Dumaniel' }), "Emmanuel Dumaniel's Children");
  assert.strictEqual(pivotTitle({ childName: 'Kemri Soto' }), "Kemri Soto's Assessment History");
  assert.strictEqual(
    pivotTitle({ pediatricianName: 'Dr. Gold Deluna', parentName: 'Emmanuel Dumaniel' }),
    "Dr. Gold Deluna's Patients — Emmanuel Dumaniel's Children"
  );

  // ── paginationEnvelope(): same shape/behavior as the Data Sources pivot ──
  const p1 = paginationEnvelope(24, 1, 10);
  assert.strictEqual(p1.totalPages, 3);
  assert.strictEqual(p1.hasNext, true);
  assert.strictEqual(p1.hasPrev, false);

  const p3 = paginationEnvelope(24, 3, 10);
  assert.strictEqual(p3.hasNext, false);
  assert.strictEqual(p3.hasPrev, true);

  const empty = paginationEnvelope(0, 1, 10);
  assert.strictEqual(empty.totalPages, 1, 'zero results must still report at least 1 page, not 0');
  assert.strictEqual(empty.hasNext, false);

  console.log('Admin Patient Reports pivot rules OK — filter parsing, id intersection, '
    + 'pivot titles and pagination all verified');
}

run();
