// services/adminPatientReportsView.js
//
// Pure, DB-free helpers behind the Admin > Reports "Centralized Patient
// Reports" pivot (routes/admin-patient-reports.js). This is a READ-ONLY
// aggregation/reporting layer over data that already exists — it never
// scores, never writes, and never invents a relationship.
//
// ── Source-of-truth relationships (audited, not reinvented) ────────────────
//   Child -> Parent        : Child.parentId (models/Child.js) — the only
//                             ownership field this codebase defines.
//   Pediatrician -> Child  : Appointment.pediatricianId + Appointment.childId
//                             (models/Appointment.js) — the SAME relationship
//                             routes/custom-questions.js ensurePediaChildRelationship()
//                             and routes/pedia-reports.js loadScope() already
//                             use. No second relationship is introduced here.
//   Assessment scores      : AssessmentResult, written once by
//                             routes/assessments.js POST /submit. Never
//                             recomputed here — see bandFor()/isRiskFlagged()
//                             in constants/scoring.js, called directly.
//
// ── Filter policy (documented because it is a judgment call) ───────────────
// "Patients" always counts the RELATIONSHIP-filtered population (pediatrician
// / parent / child / scope) — a date range narrows which of a patient's
// assessments are counted, but it never removes an otherwise-matching patient
// from the roster (a pediatrician's patient count should not fluctuate just
// because an unrelated date window was typed in). "Assessments", "Reviewed"
// and "Latest Activity" DO respect the date range on top of that same
// relationship-filtered population. Report Scope (assessments / reviewed /
// follow-up) DOES narrow the patient population, because it is itself a
// statement about which patients are of interest, not an incidental filter.

const mongoose = require('mongoose');

const REPORT_SCOPES = Object.freeze(['all', 'assessments', 'reviewed', 'followup']);
const SORT_DIRECTIONS = Object.freeze(['newest', 'oldest']);

function isValidObjectId(value) {
  return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value;
}

/**
 * Parses and validates the shared filter query params. Never throws — a bad
 * value comes back as `{ error }` so the route can return 400 with a clear
 * message instead of a stack trace or a silently-ignored filter (req 16: a
 * conflicting/invalid filter must never be silently dropped).
 */
function parsePatientReportQuery(query = {}) {
  const out = {
    pediatricianId: null,
    parentId: null,
    childId: null,
    dateFrom: null,
    dateTo: null,
    scope: 'all',
    sort: 'newest',
    page: 1,
    limit: 20,
  };

  for (const [key, field] of [['pediatricianId', 'pediatricianId'], ['parentId', 'parentId'], ['childId', 'childId']]) {
    const raw = query[key];
    if (raw != null && String(raw).trim() !== '' && String(raw).trim() !== 'all') {
      const trimmed = String(raw).trim();
      if (!isValidObjectId(trimmed)) return { error: `${key} must be a valid id.` };
      out[field] = trimmed;
    }
  }

  const rawFrom = query.dateFrom == null ? '' : String(query.dateFrom).trim();
  if (rawFrom) {
    const d = new Date(rawFrom);
    if (Number.isNaN(d.getTime())) return { error: 'dateFrom is not a valid date.' };
    out.dateFrom = d;
  }

  const rawTo = query.dateTo == null ? '' : String(query.dateTo).trim();
  if (rawTo) {
    const d = new Date(rawTo);
    if (Number.isNaN(d.getTime())) return { error: 'dateTo is not a valid date.' };
    // A date-only `to` (e.g. "2026-09-18") parses to midnight UTC, which would
    // exclude every assessment completed during that day. Extended to the end
    // of day so "to Sep 18" behaves the way an admin picking that date expects
    // — same rule routes/pedia-reports.js parseRange() uses.
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) d.setUTCHours(23, 59, 59, 999);
    out.dateTo = d;
  }

  if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo) {
    return { error: 'dateFrom must not be later than dateTo.' };
  }

  const rawScope = query.scope == null ? 'all' : String(query.scope).trim().toLowerCase();
  if (rawScope && !REPORT_SCOPES.includes(rawScope)) {
    return { error: `scope must be one of: ${REPORT_SCOPES.join(', ')}.` };
  }
  out.scope = rawScope || 'all';

  const rawSort = query.sort == null ? 'newest' : String(query.sort).trim().toLowerCase();
  out.sort = SORT_DIRECTIONS.includes(rawSort) ? rawSort : 'newest';

  out.page = Math.max(1, parseInt(query.page, 10) || 1);
  out.limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

  return out;
}

/** The `filters` block echoed back on every response, so the caller (and a
 * test) can see exactly what was applied — never left implicit. */
function filtersEcho(filters) {
  return {
    pediatricianId: filters.pediatricianId,
    parentId: filters.parentId,
    childId: filters.childId,
    dateFrom: filters.dateFrom ? filters.dateFrom.toISOString() : null,
    dateTo: filters.dateTo ? filters.dateTo.toISOString() : null,
    scope: filters.scope,
    sort: filters.sort,
  };
}

/**
 * Resolves the childId + pediatricianId filters into a single intersected
 * `_id` constraint (req 16 — conflicting filters intersect, they are never
 * silently ignored). `pediatricianChildIds` is the caller's already-fetched
 * distinct child list for the requested pediatrician (from Appointment),
 * kept as a parameter so this function stays DB-free and testable.
 *
 * Returns:
 *   null                — no _id constraint at all (neither filter given)
 *   []                  — the filters are mutually exclusive; match nothing
 *   [ObjectId-ish, ...] — the intersected set of allowed child ids
 */
function resolveChildIdConstraint({ childId, pediatricianId, pediatricianChildIds }) {
  if (!childId && !pediatricianId) return null;

  if (childId && !pediatricianId) return [childId];

  if (!childId && pediatricianId) return [...(pediatricianChildIds || [])];

  // Both given: the child must actually be one of this pediatrician's
  // patients, or the combination names an empty set (req 16).
  const allowed = new Set((pediatricianChildIds || []).map(String));
  return allowed.has(String(childId)) ? [childId] : [];
}

/**
 * Builds a human "you are viewing" label for the pivot header, matching the
 * adviser's worked example (req 14): no filters -> "All Patient Reports";
 * one filter -> named after it; more than one -> a combined label.
 */
function pivotTitle({ pediatricianName, parentName, childName }) {
  const parts = [];
  if (pediatricianName) parts.push(`${pediatricianName}'s Patients`);
  if (parentName) parts.push(`${parentName}'s Children`);
  if (childName) parts.push(`${childName}'s Assessment History`);
  if (!parts.length) return 'All Patient Reports';
  return parts.join(' — ');
}

/** Pagination envelope, identical shape to services/adminDataSourceView.js
 * so the two admin pivots behave consistently. */
function paginationEnvelope(total, page, limit) {
  const start = (page - 1) * limit;
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNext: start + limit < total,
    hasPrev: page > 1,
  };
}

module.exports = {
  REPORT_SCOPES,
  SORT_DIRECTIONS,
  isValidObjectId,
  parsePatientReportQuery,
  filtersEcho,
  resolveChildIdConstraint,
  pivotTitle,
  paginationEnvelope,
};
