// routes/admin-reports.js
// Admin-facing reporting: demographic and descriptive analytics across the
// whole system, plus concordance instrumentation between the rule-based
// screening bands and the outcome a pediatrician recorded at review.
//
// READ-ONLY BY DESIGN, AND NOT A SCORING PATH.
// ---------------------------------------------------------------------------
// Nothing here writes, and nothing here scores. Every score is read out of
// AssessmentResult, which is written by exactly one place — the submit handler
// in routes/assessments.js. A second scoring path is how this codebase ended up
// with disagreeing band sets in the first place (constants/scoring.js §WHY).
//
// NO CUTOFF LIVES IN THIS FILE. The band boundaries are never restated here.
// bandStageExpr() below transcribes scoring.bandFor() into an aggregation
// $switch that is GENERATED FROM scoring.ACTIVE_BANDS at require time, so if
// ACTIVE_BANDS is ever changed this file follows automatically and cannot drift.
// The only way to change a cutoff is still to edit constants/scoring.js.
//
// WORDING RULE
// ---------------------------------------------------------------------------
// The screening is fixed arithmetic over parent answers, placed into a band by a
// fixed cutoff. Nothing in this file, its responses, or the page it feeds may
// describe that as predicted, learned, intelligent, or as an accuracy figure.
// Section 4 reports AGREEMENT between two recorded judgements — never accuracy,
// which would claim one of them is the truth.
//
// Structure, auth shape, range parsing, and response envelope mirror
// routes/pedia-reports.js. The aggregation discipline does not: that router
// reads collections and folds them in Node, which is fine at one clinician's
// caseload. This one covers the whole system, so every count below is produced
// by a MongoDB pipeline and Node only assembles the already-grouped output.

const express = require('express');
const router = express.Router();

const { authMiddleware, adminOnly } = require('../middleware/auth');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const PediaCustomQuestionAssignment = require('../models/PediaCustomQuestionAssignment');
const scoring = require('../constants/scoring');

// Collection names are read off the models rather than typed as strings, so a
// `collection:` option change in models/ cannot silently break a $lookup here.
const COL = Object.freeze({
  users: User.collection.name,
  children: Child.collection.name,
  assessments: Assessment.collection.name,
  results: AssessmentResult.collection.name,
  customAssignments: PediaCustomQuestionAssignment.collection.name,
});

// ── Vocabularies, all derived rather than restated ──────────────────────────

// Band keys high → low. A LOWER index is a BETTER band; every directional
// comparison in this file depends on that ordering.
const BAND_KEYS = Object.freeze(scoring.ACTIVE_BANDS.map((b) => b.key));

// Read off the schema so a sixth clinical outcome cannot leave this report
// silently showing five. Same technique routes/assessments.js uses in the
// diagnose handler and routes/pedia-reports.js uses for its cross-tab.
const OUTCOME_KEYS = Object.freeze(Assessment.schema.path('clinicalOutcome').enumValues.slice());

// Child.gender is an enum with a null member; the null is dropped here because
// "not recorded" is handled as its own bucket rather than as a value.
const GENDER_KEYS = Object.freeze(
  Child.schema.path('gender').enumValues.filter((g) => g != null)
);

// Staff roles. Everything else in the role enum is a guardian-type account that
// can own a Child through Child.parentId.
const STAFF_ROLES = Object.freeze(['pediatrician', 'admin', 'secretary']);
const GUARDIAN_ROLES = Object.freeze(
  User.schema.path('role').enumValues.filter((r) => !STAFF_ROLES.includes(r))
);

// The field that defines "active". models/User.js status enum is
// ['active', 'pending', 'suspended'] — `active` is the only value that means a
// usable account, so inactive is every other value. This is deliberately NOT
// emailVerified, which records a mail round-trip rather than account standing.
const ACTIVE_STATUS = 'active';

/**
 * ── AGE BANDS ───────────────────────────────────────────────────────────────
 * DEMOGRAPHIC STRATA, NOT SCORING THRESHOLDS. These never touch a score, never
 * enter bandFor(), and never adjust a band. They exist only to slice counts.
 *
 * The boundaries are not invented: they are the age gates the screening
 * instrument itself uses. models/CoreBankQuestion.js gates every question by
 * `minAgeMonths`, and the distinct strata in the live bank are
 * 36 / 42 / 48 / 60 / 72 / 84 months. The bands below are those gates expressed
 * in whole years, so a band boundary always coincides with a point where the
 * child is asked a different set of questions. (The lone 42-month stratum is not
 * given its own band — it would produce a six-month bucket between twelve-month
 * ones, which reads as noise in a distribution.)
 *
 * `min` is inclusive, `max` is exclusive, null max means open-ended.
 */
const AGE_BANDS = Object.freeze([
  Object.freeze({ key: 'under_3', label: 'Under 3y', minMonths: 0, maxMonths: 36 }),
  Object.freeze({ key: 'age_3', label: '3y', minMonths: 36, maxMonths: 48 }),
  Object.freeze({ key: 'age_4', label: '4y', minMonths: 48, maxMonths: 60 }),
  Object.freeze({ key: 'age_5', label: '5y', minMonths: 60, maxMonths: 72 }),
  Object.freeze({ key: 'age_6', label: '6y', minMonths: 72, maxMonths: 84 }),
  Object.freeze({ key: 'age_7_plus', label: '7y and older', minMonths: 84, maxMonths: null }),
]);
const AGE_BAND_KEYS = Object.freeze(AGE_BANDS.map((b) => b.key));

// Bucket for a child whose date of birth cannot be resolved, or whose age at
// the reference date is negative. Kept distinct from every real band so an
// unresolvable age is visible rather than absorbed into the youngest bucket.
const AGE_UNKNOWN = 'unknown';

/**
 * ── OUTCOME → EXPECTED BAND ─────────────────────────────────────────────────
 * ASSUMPTION, PENDING PEDIATRICIAN CONFIRMATION. This is the single mapping the
 * whole of Section 4 rests on, and it is not a clinical fact — it is a stated
 * correspondence that lets two different vocabularies be compared at all. The
 * API echoes it on every response (`mapping.assumed: true`) so the page can
 * label it as unconfirmed rather than presenting it as settled.
 *
 * Band values come from scoring.BAND, never from a literal, so a renamed band
 * key breaks loudly here instead of silently producing an all-disagreement
 * matrix.
 *
 * `inconclusive` is deliberately absent: "reviewed, no conclusion possible" has
 * no expected band, so it is EXCLUDED from every rate and counted separately.
 * Folding it in as a disagreement would count a clinician's honest abstention
 * as the screening being wrong.
 */
const OUTCOME_TO_EXPECTED_BAND = Object.freeze({
  typical_development: scoring.BAND.ON_TRACK,
  monitor: scoring.BAND.DEVELOPING,
  referred_for_evaluation: scoring.BAND.AT_RISK,
  confirmed_delay: scoring.BAND.DELAYED,
});

// Outcomes with no expected band. Derived so adding an outcome to the schema
// without mapping it here lands it in this list rather than being dropped.
const UNMAPPED_OUTCOMES = Object.freeze(
  OUTCOME_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(OUTCOME_TO_EXPECTED_BAND, k))
);

/**
 * Below this many usable labelled records, Section 4 reports counts only and
 * suppresses every percentage.
 *
 * Not a statistical test — it is a floor chosen so a single record cannot move a
 * headline figure by tens of percentage points. At n = 4, one disagreement is
 * 25%. Quoting that as a rate invites a conclusion the sample cannot support,
 * so the API returns `suppressed: true` and the page shows n instead.
 */
const MIN_CONCORDANCE_N = 30;

// ── Aggregation expression builders ─────────────────────────────────────────

/**
 * scoring.normalizeScore() as an aggregation expression: coerce to a number,
 * anything unusable becomes 0, then clamp into 0-100.
 */
function normalizedScoreExpr(scorePath) {
  return {
    $min: [100, {
      $max: [0, {
        $convert: { input: scorePath, to: 'double', onError: 0, onNull: 0 },
      }],
    }],
  };
}

/**
 * scoring.bandFor() as an aggregation expression.
 *
 * GENERATED FROM scoring.ACTIVE_BANDS — there is no cutoff written here. The
 * branch order and the >= comparison reproduce bandFor exactly: ACTIVE_BANDS is
 * ordered high → low and the first band whose `min` the score meets wins, with
 * the last band as the default. Adding, removing, or renumbering a band in
 * constants/scoring.js changes this expression on the next require with no edit
 * to this file.
 */
function bandStageExpr(scorePath) {
  const normalized = normalizedScoreExpr(scorePath);
  return {
    $switch: {
      branches: scoring.ACTIVE_BANDS.map((b) => ({
        case: { $gte: [normalized, b.min] },
        then: b.key,
      })),
      default: BAND_KEYS[BAND_KEYS.length - 1],
    },
  };
}

/**
 * Whole months elapsed from `dobPath` to `refPath`, or null if either is
 * missing. Calendar months rather than milliseconds/30.44, so a child screened
 * the day before their birthday is not rounded up into the next age band.
 */
function ageMonthsExpr(dobPath, refPath) {
  return {
    $cond: [
      { $or: [{ $not: [{ $ifNull: [dobPath, false] }] }, { $not: [{ $ifNull: [refPath, false] }] }] },
      null,
      {
        $add: [
          { $multiply: [{ $subtract: [{ $year: refPath }, { $year: dobPath }] }, 12] },
          { $subtract: [{ $month: refPath }, { $month: dobPath }] },
          { $cond: [{ $lt: [{ $dayOfMonth: refPath }, { $dayOfMonth: dobPath }] }, -1, 0] },
        ],
      },
    ],
  };
}

/** AGE_BANDS as a $switch over a months expression. Unresolvable → AGE_UNKNOWN. */
function ageBandExpr(monthsPath) {
  return {
    $switch: {
      branches: [
        // Null or negative age is not a band, it is missing information.
        { case: { $eq: [{ $ifNull: [monthsPath, null] }, null] }, then: AGE_UNKNOWN },
        { case: { $lt: [monthsPath, 0] }, then: AGE_UNKNOWN },
        ...AGE_BANDS.map((b) => ({
          case: b.maxMonths == null
            ? { $gte: [monthsPath, b.minMonths] }
            : { $and: [{ $gte: [monthsPath, b.minMonths] }, { $lt: [monthsPath, b.maxMonths] }] },
          then: b.key,
        })),
      ],
      default: AGE_UNKNOWN,
    },
  };
}

/**
 * The date a screening is attributed to: when it was completed, falling back to
 * when it was started. Assessment.completedAt is null until submission, so
 * without the fallback every in-progress screening would drop out of the
 * timeline entirely rather than appearing on the day work began on it.
 */
const SCREENED_AT_EXPR = { $ifNull: ['$completedAt', '$startedAt'] };

/** "Is this field present and not an empty string" as an expression. */
function isSetExpr(path) {
  return { $not: [{ $in: [{ $ifNull: [path, null] }, [null, '']] }] };
}

// ── Filters ─────────────────────────────────────────────────────────────────

const DEFAULT_RANGE_MONTHS = 12;

/**
 * Parses the global filters. Every branch either produces a usable value or an
 * error string — nothing here can throw on hostile input, which is what lets the
 * page guarantee that no filter combination breaks a chart.
 *
 * Date range defaults to the last 12 months. That default is applied here rather
 * than in the page so a direct API call gets the same window the UI shows.
 */
function parseFilters(query) {
  const out = {};

  const rawFrom = query.from == null ? '' : String(query.from).trim();
  const rawTo = query.to == null ? '' : String(query.to).trim();

  if (rawTo) {
    const d = new Date(rawTo);
    if (Number.isNaN(d.getTime())) return { error: 'Query parameter `to` is not a valid ISO date.' };
    // A date-only `to` parses to midnight, which would exclude everything that
    // happened during that day. Extend to end of day so "to 8 August" means what
    // the person setting the filter expects. Matches routes/pedia-reports.js.
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) d.setUTCHours(23, 59, 59, 999);
    out.to = d;
  } else {
    out.to = new Date();
  }

  if (rawFrom) {
    const d = new Date(rawFrom);
    if (Number.isNaN(d.getTime())) return { error: 'Query parameter `from` is not a valid ISO date.' };
    out.from = d;
  } else {
    const d = new Date(out.to.getTime());
    d.setUTCMonth(d.getUTCMonth() - DEFAULT_RANGE_MONTHS);
    out.from = d;
  }

  if (out.from > out.to) {
    return { error: 'Query parameter `from` must not be later than `to`.' };
  }

  const rawGender = query.gender == null ? '' : String(query.gender).trim().toLowerCase();
  if (!rawGender || rawGender === 'all') {
    out.gender = null;
  } else if (GENDER_KEYS.includes(rawGender) || rawGender === AGE_UNKNOWN) {
    out.gender = rawGender;
  } else {
    return { error: `Query parameter \`gender\` must be one of: all, ${GENDER_KEYS.join(', ')}, ${AGE_UNKNOWN}.` };
  }

  const rawAge = query.ageBand == null ? '' : String(query.ageBand).trim();
  if (!rawAge || rawAge === 'all') {
    out.ageBand = null;
  } else if (AGE_BAND_KEYS.includes(rawAge) || rawAge === AGE_UNKNOWN) {
    out.ageBand = rawAge;
  } else {
    return { error: `Query parameter \`ageBand\` must be one of: all, ${AGE_BAND_KEYS.join(', ')}, ${AGE_UNKNOWN}.` };
  }

  return out;
}

/** Echoed on every response so the caller can see exactly what was applied. */
function filtersEcho(filters) {
  return {
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
    gender: filters.gender || 'all',
    ageBand: filters.ageBand || 'all',
  };
}

/**
 * $match fragment for the sex/age filters, given the field paths that hold the
 * resolved gender and age band. Returns null when neither filter is set, so the
 * caller can skip the stage entirely.
 */
function demographicMatch(filters, genderPath, ageBandPath) {
  const match = {};
  if (filters.gender) {
    match[genderPath] = filters.gender === AGE_UNKNOWN ? { $in: [null, ''] } : filters.gender;
  }
  if (filters.ageBand) {
    match[ageBandPath] = filters.ageBand;
  }
  return Object.keys(match).length ? match : null;
}

// ── Shaping helpers (assembly of already-grouped output, never aggregation) ──

/** [{_id, count}] → { key: count } with every expected key present at zero. */
function countsByKey(rows, keys, { includeOther = false } = {}) {
  const out = {};
  for (const k of keys) out[k] = 0;
  for (const row of rows || []) {
    const key = row._id == null ? AGE_UNKNOWN : String(row._id);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = row.count;
    } else if (includeOther) {
      out[key] = (out[key] || 0) + row.count;
    }
  }
  return out;
}

/** First element of a $facet count branch, or 0. */
function facetCount(rows) {
  return rows && rows.length ? (rows[0].n || 0) : 0;
}

/**
 * Fills month gaps in a timeline so a quiet month renders as a zero column
 * rather than vanishing and making the series look continuous.
 */
function fillMonths(rows, from, to) {
  const counts = new Map((rows || []).map((r) => [String(r._id), r.count]));
  const out = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  // Guard against a pathological range producing an unbounded series.
  let guard = 0;
  while (cursor <= end && guard < 600) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ month: key, count: counts.get(key) || 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    guard += 1;
  }
  return out;
}

/** Band index in ACTIVE_BANDS; lower is a better band. -1 when unknown. */
function bandIndex(bandKey) {
  return BAND_KEYS.indexOf(bandKey);
}

/** A rate that always carries its denominator, and is null when there is none. */
function rate(numerator, denominator) {
  const d = Number(denominator) || 0;
  const n = Number(numerator) || 0;
  return {
    count: n,
    denominator: d,
    percent: d > 0 ? Math.round((n / d) * 1000) / 10 : null,
  };
}

/** The metadata block every response carries, so the page never hardcodes it. */
function vocabulary() {
  return {
    bands: BAND_KEYS.map((key) => ({
      key,
      label: scoring.clinicalLabel(key),
      color: scoring.colorForBand(key),
    })),
    ageBands: AGE_BANDS.map((b) => ({ key: b.key, label: b.label })),
    genders: GENDER_KEYS.slice(),
    outcomes: OUTCOME_KEYS.slice(),
    unknownKey: AGE_UNKNOWN,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin-reports/users — Section 1
// ═══════════════════════════════════════════════════════════════════════════
//
// Stock vs flow: role totals, account status, and guardian-with-children are
// CURRENT STATE and ignore the date range — "how many pediatricians exist" is
// not a question a date window improves. Only the registrations timeline is a
// flow, so only it is filtered. The response says which is which via
// `rangeApplies` so the page can label each block rather than implying the
// filter bit everywhere.
//
// The sex and age filters do not apply at all here: those fields live on Child,
// and a user account has neither.
router.get('/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filters = parseFilters(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    const [facet] = await User.aggregate([
      {
        $facet: {
          total: [{ $count: 'n' }],
          byRole: [
            { $group: { _id: '$role', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          byStatus: [
            { $group: { _id: { $ifNull: ['$status', null] }, count: { $sum: 1 } } },
          ],
          registrations: [
            { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          guardians: [
            { $match: { role: { $in: GUARDIAN_ROLES } } },
            {
              $lookup: {
                from: COL.children,
                localField: '_id',
                foreignField: 'parentId',
                as: 'kids',
              },
            },
            {
              $group: {
                _id: { $cond: [{ $gt: [{ $size: '$kids' }, 0] }, 'withChildren', 'withoutChildren'] },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const statusRows = facet.byStatus || [];
    const total = facetCount(facet.total);
    const active = statusRows
      .filter((r) => r._id === ACTIVE_STATUS)
      .reduce((sum, r) => sum + r.count, 0);

    const guardianCounts = countsByKey(facet.guardians, ['withChildren', 'withoutChildren']);

    res.json({
      success: true,
      filters: filtersEcho(filters),
      // Which of the global filters actually bit on this section.
      filtersApplied: { dateRange: 'registrations only', gender: false, ageBand: false },
      vocabulary: vocabulary(),
      totals: {
        users: total,
        // Stated explicitly in the payload so the page never has to guess which
        // field defines "active" — see ACTIVE_STATUS above.
        activeField: 'User.status',
        activeValue: ACTIVE_STATUS,
        active,
        inactive: total - active,
      },
      byRole: (facet.byRole || []).map((r) => ({ role: r._id || 'unknown', count: r.count })),
      byStatus: statusRows.map((r) => ({ status: r._id || 'unset', count: r.count })),
      registrations: fillMonths(facet.registrations, filters.from, filters.to),
      guardianAccounts: {
        roles: GUARDIAN_ROLES.slice(),
        withChildren: guardianCounts.withChildren,
        withoutChildren: guardianCounts.withoutChildren,
      },
    });
  } catch (err) {
    console.error('admin-reports users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin-reports/children — Section 2
// ═══════════════════════════════════════════════════════════════════════════
//
// Age here is CURRENT age — months from date of birth to now — and the response
// says so in `ageBasis`. This is a different quantity from the age band used in
// Sections 3 and 4, which is age AT THE ASSESSMENT. Both are legitimate; showing
// them without saying which is which is not, because the same child moves
// between bands as time passes.
//
// No geographic distribution: neither Child nor User carries a residential
// location field. Nothing is proxied in its place.
router.get('/children', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filters = parseFilters(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    const now = new Date();
    const demoMatch = demographicMatch(filters, 'genderKey', 'ageBand');

    const pipeline = [
      {
        $addFields: {
          genderKey: { $ifNull: ['$gender', null] },
          ageMonths: ageMonthsExpr('$dateOfBirth', now),
        },
      },
      { $addFields: { ageBand: ageBandExpr('$ageMonths') } },
      ...(demoMatch ? [{ $match: demoMatch }] : []),
      {
        $facet: {
          total: [{ $count: 'n' }],
          byGender: [
            { $group: { _id: { $ifNull: ['$gender', AGE_UNKNOWN] }, count: { $sum: 1 } } },
          ],
          byAgeBand: [
            { $group: { _id: '$ageBand', count: { $sum: 1 } } },
          ],
          perParent: [
            { $group: { _id: '$parentId', kids: { $sum: 1 } } },
            {
              $group: {
                _id: {
                  $switch: {
                    branches: [
                      { case: { $eq: ['$kids', 1] }, then: '1' },
                      { case: { $eq: ['$kids', 2] }, then: '2' },
                    ],
                    default: '3+',
                  },
                },
                count: { $sum: 1 },
              },
            },
          ],
          // "Completed screening" means an Assessment with status 'complete'
          // whose attributed date falls inside the selected range. A child with
          // screenings only outside the window counts as zero here, which is why
          // the label on this tile names the range.
          screeningCoverage: [
            {
              $lookup: {
                from: COL.assessments,
                let: { childId: '$_id' },
                pipeline: [
                  { $match: { $expr: { $eq: ['$childId', '$$childId'] } } },
                  { $addFields: { screenedAt: SCREENED_AT_EXPR } },
                  {
                    $match: {
                      status: 'complete',
                      screenedAt: { $gte: filters.from, $lte: filters.to },
                    },
                  },
                  { $count: 'n' },
                ],
                as: 'screenings',
              },
            },
            {
              $group: {
                _id: {
                  $cond: [{ $gt: [{ $size: '$screenings' }, 0] }, 'withScreening', 'withoutScreening'],
                },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ];

    const [facet] = await Child.aggregate(pipeline);

    const coverage = countsByKey(facet.screeningCoverage, ['withScreening', 'withoutScreening']);

    res.json({
      success: true,
      filters: filtersEcho(filters),
      filtersApplied: { dateRange: 'screening coverage only', gender: true, ageBand: true },
      vocabulary: vocabulary(),
      ageBasis: 'current',
      totals: { children: facetCount(facet.total) },
      byGender: countsByKey(facet.byGender, [...GENDER_KEYS, AGE_UNKNOWN]),
      byAgeBand: countsByKey(facet.byAgeBand, [...AGE_BAND_KEYS, AGE_UNKNOWN]),
      childrenPerParent: countsByKey(facet.perParent, ['1', '2', '3+']),
      screeningCoverage: {
        withScreening: coverage.withScreening,
        withoutScreening: coverage.withoutScreening,
      },
    });
  } catch (err) {
    console.error('admin-reports children error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin-reports/screenings — Section 3
// ═══════════════════════════════════════════════════════════════════════════
//
// Age band here is age AT THE ASSESSMENT, computed against the screening's own
// attributed date rather than against today.
//
// The linked-result count is not a footnote. Half the assessments on file have
// no result document, and every scored chart in this section is drawn from
// results only — so `withResult` is the true denominator for the band charts
// while `total` is the denominator for the timeline and the review counts. Both
// are returned so the page can show the gap instead of quietly shrinking.
router.get('/screenings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filters = parseFilters(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    const demoMatch = demographicMatch(filters, 'childGender', 'ageBand');

    const [facet] = await Assessment.aggregate([
      { $addFields: { screenedAt: SCREENED_AT_EXPR } },
      { $match: { screenedAt: { $gte: filters.from, $lte: filters.to } } },
      {
        $lookup: {
          from: COL.children,
          localField: 'childId',
          foreignField: '_id',
          as: 'child',
        },
      },
      { $unwind: { path: '$child', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          childGender: { $ifNull: ['$child.gender', null] },
          ageMonths: ageMonthsExpr('$child.dateOfBirth', '$screenedAt'),
        },
      },
      { $addFields: { ageBand: ageBandExpr('$ageMonths') } },
      ...(demoMatch ? [{ $match: demoMatch }] : []),
      // results.assessmentId -> assessments._id. unique:true on the FK makes
      // this one-to-at-most-one, so $first is the whole story, not a sample.
      {
        $lookup: {
          from: COL.results,
          localField: '_id',
          foreignField: 'assessmentId',
          as: 'result',
        },
      },
      { $addFields: { result: { $first: '$result' } } },
      {
        $addFields: {
          // $isNumber, not a $type equality check: a stored score may be an int
          // or a double depending on how it was written, and testing for one
          // BSON type silently drops the other.
          hasResult: { $isNumber: { $ifNull: ['$result.overallScore', null] } },
          overallBand: bandStageExpr('$result.overallScore'),
          reviewed: isSetExpr('$reviewedAt'),
        },
      },
      {
        $facet: {
          total: [{ $count: 'n' }],
          overTime: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m', date: '$screenedAt' } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
          resultLinkage: [
            {
              $group: {
                _id: { $cond: ['$hasResult', 'withResult', 'withoutResult'] },
                count: { $sum: 1 },
              },
            },
          ],
          overallBands: [
            { $match: { hasResult: true } },
            { $group: { _id: '$overallBand', count: { $sum: 1 } } },
          ],
          // The four stored band strings, counted as stored. These are NOT
          // recomputed from the domain scores: the point of this chart is to
          // show what is actually persisted on the documents other pages read.
          domainBands: [
            { $match: { hasResult: true } },
            {
              $group: {
                _id: null,
                communication: { $push: '$result.communicationStatus' },
                social: { $push: '$result.socialStatus' },
                cognitive: { $push: '$result.cognitiveStatus' },
                motor: { $push: '$result.motorStatus' },
              },
            },
          ],
          bandByAgeBand: [
            { $match: { hasResult: true } },
            { $group: { _id: { band: '$overallBand', ageBand: '$ageBand' }, count: { $sum: 1 } } },
          ],
          bandByGender: [
            { $match: { hasResult: true } },
            {
              $group: {
                _id: { band: '$overallBand', gender: { $ifNull: ['$childGender', AGE_UNKNOWN] } },
                count: { $sum: 1 },
              },
            },
          ],
          reviewStatus: [
            {
              $group: {
                _id: { $cond: ['$reviewed', 'reviewed', 'unreviewed'] },
                count: { $sum: 1 },
              },
            },
          ],
          // Median days from submission to review, over reviewed screenings that
          // have both timestamps. Median rather than mean: one screening
          // reviewed months late would drag a mean far from anything typical.
          reviewLatency: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: [{ $ifNull: ['$reviewedAt', null] }, null] },
                    { $ne: [{ $ifNull: ['$screenedAt', null] }, null] },
                  ],
                },
              },
            },
            {
              $addFields: {
                daysToReview: {
                  $divide: [{ $subtract: ['$reviewedAt', '$screenedAt'] }, 1000 * 60 * 60 * 24],
                },
              },
            },
            // A review timestamped before the screening date is a data fault,
            // not a negative wait. Excluded rather than allowed to pull the
            // median below zero.
            { $match: { daysToReview: { $gte: 0 } } },
            {
              $group: {
                _id: null,
                n: { $sum: 1 },
                medianDays: { $median: { input: '$daysToReview', method: 'approximate' } },
              },
            },
          ],
          nextAssessment: [
            {
              $group: {
                _id: { $cond: [isSetExpr('$nextAssessmentDate'), 'set', 'unset'] },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const total = facetCount(facet.total);
    const linkage = countsByKey(facet.resultLinkage, ['withResult', 'withoutResult']);
    const review = countsByKey(facet.reviewStatus, ['reviewed', 'unreviewed']);
    const nextAssessment = countsByKey(facet.nextAssessment, ['set', 'unset']);

    // Domain band counts, assembled from the pushed arrays of stored strings.
    const domainRow = (facet.domainBands || [])[0] || {};
    const domainBands = {};
    for (const key of ['communication', 'social', 'cognitive', 'motor']) {
      const counts = {};
      for (const b of BAND_KEYS) counts[b] = 0;
      counts[AGE_UNKNOWN] = 0;
      for (const stored of domainRow[key] || []) {
        const k = stored == null || stored === '' ? AGE_UNKNOWN : String(stored);
        if (Object.prototype.hasOwnProperty.call(counts, k)) counts[k] += 1;
        else counts[AGE_UNKNOWN] += 1;
      }
      domainBands[key] = counts;
    }

    // Cross-tabs, fully enumerated so an empty cell renders as 0 rather than a
    // gap the reader fills in themselves.
    const bandByAgeBand = {};
    for (const b of BAND_KEYS) {
      bandByAgeBand[b] = {};
      for (const a of [...AGE_BAND_KEYS, AGE_UNKNOWN]) bandByAgeBand[b][a] = 0;
    }
    for (const row of facet.bandByAgeBand || []) {
      const band = row._id?.band;
      const age = row._id?.ageBand || AGE_UNKNOWN;
      if (bandByAgeBand[band] && Object.prototype.hasOwnProperty.call(bandByAgeBand[band], age)) {
        bandByAgeBand[band][age] = row.count;
      }
    }

    const bandByGender = {};
    for (const b of BAND_KEYS) {
      bandByGender[b] = {};
      for (const g of [...GENDER_KEYS, AGE_UNKNOWN]) bandByGender[b][g] = 0;
    }
    for (const row of facet.bandByGender || []) {
      const band = row._id?.band;
      const gender = row._id?.gender || AGE_UNKNOWN;
      if (bandByGender[band] && Object.prototype.hasOwnProperty.call(bandByGender[band], gender)) {
        bandByGender[band][gender] = row.count;
      }
    }

    const latencyRow = (facet.reviewLatency || [])[0] || null;

    // ── Custom pediatrician questions ──────────────────────────────────────
    // A SEPARATE, UNSCORED BLOCK. Pediatrician-authored questions are never part
    // of any band computation: routes/assessments.js scores the core bank only,
    // and these answers live in their own collection with their own answer
    // field. Counted here so the volume is visible, and deliberately kept out of
    // every distribution above.
    const [customFacet] = await PediaCustomQuestionAssignment.aggregate([
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      {
        $facet: {
          assigned: [{ $count: 'n' }],
          answered: [
            { $match: { $expr: isSetExpr('$answer') } },
            { $count: 'n' },
          ],
        },
      },
    ]);

    res.json({
      success: true,
      filters: filtersEcho(filters),
      filtersApplied: { dateRange: true, gender: true, ageBand: true },
      vocabulary: vocabulary(),
      ageBasis: 'at_assessment',
      totals: {
        assessments: total,
        withResult: linkage.withResult,
        withoutResult: linkage.withoutResult,
      },
      overTime: fillMonths(facet.overTime, filters.from, filters.to),
      overallBands: countsByKey(facet.overallBands, BAND_KEYS),
      domainBands,
      bandByAgeBand,
      bandByGender,
      review: {
        reviewed: review.reviewed,
        unreviewed: review.unreviewed,
        medianDaysToReview: latencyRow ? Math.round(latencyRow.medianDays * 10) / 10 : null,
        medianSampleSize: latencyRow ? latencyRow.n : 0,
      },
      nextAssessment: {
        set: nextAssessment.set,
        unset: nextAssessment.unset,
        rate: rate(nextAssessment.set, total),
      },
      // Never enters a band computation. See the comment above.
      customQuestions: {
        assigned: facetCount(customFacet.assigned),
        answered: facetCount(customFacet.answered),
        scored: false,
      },
    });
  } catch (err) {
    console.error('admin-reports screenings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin-reports/concordance — Section 4
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// Agreement between two recorded judgements: the rule-based screening band, and
// the outcome the reviewing pediatrician recorded. It is NOT a validation
// against a diagnostic reference standard, and the numbers below are not an
// accuracy. Three reasons this distinction is load-bearing:
//
//  1. The labels are not blind. The pediatrician recording clinicalOutcome has
//     already seen the screening scores on the same page — the diagnosis modal
//     shows them. Agreement therefore partly measures the influence of the score
//     on the reviewer.
//  2. The cutoffs are unconfirmed, pending the consultant pediatrician
//     (constants/scoring.js header).
//  3. The outcome→band correspondence is an assumption, not a clinical fact.
//
// GROUND TRUTH IS assessments.clinicalOutcome AND NOTHING ELSE. The free-text
// `diagnosis` is never read — models/Assessment.js forbids inferring a label
// from it, and the only diagnosis that existed before that field was added was
// the string "Yes please". PatientProgressNote.progressStatus is likewise never
// read: it defaults to 'monitoring', so its presence records that a note was
// written, not that a judgement was made.
router.get('/concordance', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filters = parseFilters(req.query);
    if (filters.error) return res.status(400).json({ error: filters.error });

    const demoMatch = demographicMatch(filters, 'childGender', 'ageBand');

    const [facet] = await Assessment.aggregate([
      // ── Scope: same window and same demographic filters as Section 3, so the
      // pipeline counts below reconcile against that section exactly.
      { $addFields: { screenedAt: SCREENED_AT_EXPR } },
      { $match: { screenedAt: { $gte: filters.from, $lte: filters.to } } },
      {
        $lookup: {
          from: COL.children,
          localField: 'childId',
          foreignField: '_id',
          as: 'child',
        },
      },
      { $unwind: { path: '$child', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          childGender: { $ifNull: ['$child.gender', null] },
          ageMonths: ageMonthsExpr('$child.dateOfBirth', '$screenedAt'),
        },
      },
      { $addFields: { ageBand: ageBandExpr('$ageMonths') } },
      ...(demoMatch ? [{ $match: demoMatch }] : []),
      {
        $lookup: {
          from: COL.results,
          localField: '_id',
          foreignField: 'assessmentId',
          as: 'result',
        },
      },
      { $addFields: { result: { $first: '$result' } } },
      {
        $addFields: {
          // A band exists only when a linked result carries a numeric score.
          // The overall band is NOT stored anywhere — it is derived here from
          // overallScore by the same rule bandFor() applies.
          // $isNumber accepts int and double alike; see the note in /screenings.
          hasBand: { $isNumber: { $ifNull: ['$result.overallScore', null] } },
          overallBand: bandStageExpr('$result.overallScore'),
          hasOutcome: isSetExpr('$clinicalOutcome'),
          reviewed: isSetExpr('$reviewedAt'),
        },
      },
      {
        $facet: {
          // ── Pipeline counts. These render even when nothing is labelled, so
          // the empty state is still informative rather than just empty.
          total: [{ $count: 'n' }],
          withBand: [{ $match: { hasBand: true } }, { $count: 'n' }],
          reviewed: [{ $match: { reviewed: true } }, { $count: 'n' }],
          labelled: [{ $match: { hasOutcome: true } }, { $count: 'n' }],
          // Labelled AND scored — the only records that can enter the matrix.
          usable: [{ $match: { hasOutcome: true, hasBand: true } }, { $count: 'n' }],
          // Labelled but with no linked result: cannot be placed in the matrix
          // because there is no band to compare against. Surfaced so a shrinking
          // denominator is always explained.
          labelledNoBand: [{ $match: { hasOutcome: true, hasBand: false } }, { $count: 'n' }],

          // ── The matrix itself: computed band × recorded outcome.
          matrix: [
            { $match: { hasOutcome: true, hasBand: true } },
            {
              $group: {
                _id: { band: '$overallBand', outcome: '$clinicalOutcome' },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const totals = {
      assessments: facetCount(facet.total),
      withBand: facetCount(facet.withBand),
      reviewed: facetCount(facet.reviewed),
      labelled: facetCount(facet.labelled),
      usable: facetCount(facet.usable),
      labelledWithoutBand: facetCount(facet.labelledNoBand),
    };

    // Fully enumerated band × outcome grid, every cell present at zero.
    const matrix = {};
    for (const band of BAND_KEYS) {
      matrix[band] = {};
      for (const outcome of OUTCOME_KEYS) matrix[band][outcome] = 0;
    }
    for (const row of facet.matrix || []) {
      const band = row._id?.band;
      const outcome = row._id?.outcome;
      if (matrix[band] && Object.prototype.hasOwnProperty.call(matrix[band], outcome)) {
        matrix[band][outcome] = row.count;
      }
    }

    // ── Agreement arithmetic ────────────────────────────────────────────────
    // Over the grouped cells only — a handful of integers, not a collection.
    //
    // Unmapped outcomes (today: `inconclusive`) are excluded from every
    // denominator and reported on their own. A clinician recording "no
    // conclusion possible" has not disagreed with anything.
    let exact = 0;
    let adjacent = 0;
    let screeningRatedBetter = 0; // screening said healthier than the reviewer
    let screeningRatedWorse = 0;  // screening said more concerning than reviewer
    let comparable = 0;
    let excluded = 0;

    for (const band of BAND_KEYS) {
      for (const outcome of OUTCOME_KEYS) {
        const n = matrix[band][outcome];
        if (!n) continue;

        const expectedBand = OUTCOME_TO_EXPECTED_BAND[outcome];
        if (!expectedBand) {
          excluded += n;
          continue;
        }

        comparable += n;

        const actualIdx = bandIndex(band);
        const expectedIdx = bandIndex(expectedBand);
        if (actualIdx < 0 || expectedIdx < 0) continue;

        const distance = actualIdx - expectedIdx;
        if (distance === 0) exact += n;
        if (Math.abs(distance) <= 1) adjacent += n;

        // BAND_KEYS runs high → low, so a LOWER index is a better band.
        // distance < 0 means the screening placed the child in a BETTER band
        // than the reviewer's conclusion implies — the screening under-flagged.
        if (distance < 0) screeningRatedBetter += n;
        if (distance > 0) screeningRatedWorse += n;
      }
    }

    // Below the floor, the page shows counts and no percentages. The rates are
    // still computed and returned so the payload shape never changes shape on
    // the caller — `suppressed` is the flag to respect, not the absence of data.
    const suppressed = comparable < MIN_CONCORDANCE_N;

    res.json({
      success: true,
      filters: filtersEcho(filters),
      filtersApplied: { dateRange: true, gender: true, ageBand: true },
      vocabulary: vocabulary(),
      totals,
      matrix,
      mapping: {
        // Echoed so the page labels this as unconfirmed rather than settled.
        assumed: true,
        outcomeToBand: OUTCOME_TO_EXPECTED_BAND,
        excludedOutcomes: UNMAPPED_OUTCOMES.slice(),
      },
      agreement: {
        comparable,
        excluded,
        exact: rate(exact, comparable),
        adjacent: rate(adjacent, comparable),
        // The direction that matters clinically: a screening that reads as
        // healthier than the reviewer's conclusion is a missed concern, which
        // costs more than the opposite error.
        screeningRatedBetter: rate(screeningRatedBetter, comparable),
        screeningRatedWorse: rate(screeningRatedWorse, comparable),
      },
      threshold: {
        minimum: MIN_CONCORDANCE_N,
        suppressed,
      },
      methodsNote:
        'This measures agreement between the rule-based screening bands and the '
        + 'reviewing pediatrician\'s recorded outcome. It is not a validation against a '
        + 'diagnostic reference standard.',
    });
  } catch (err) {
    console.error('admin-reports concordance error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
