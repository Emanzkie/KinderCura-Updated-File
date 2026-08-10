// routes/pedia-reports.js
// Pediatrician-facing reporting: descriptive analytics over the screenings of
// the children this pediatrician actually sees.
//
// READ-ONLY BY DESIGN, and NOT A SCORING PATH.
// ---------------------------------------------------------------------------
// Every score in this file is read straight out of AssessmentResult, which is
// written by exactly one place — the submit handler in routes/assessments.js.
// Nothing here recomputes a score from assessment_answers. A second scoring
// path is how this codebase ended up with five disagreeing band sets in the
// first place (see constants/scoring.js and docs/SCORING.md §4).
//
// Band decisions likewise never happen here. Every band comes from
// scoring.bandFor() and every risk flag from scoring.isRiskFlagged(). There is
// not a single numeric cutoff in this file, and there must never be one.
//
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// Descriptive reporting over stored, rule-based screening scores. It counts
// what is on file. It does not model, predict, estimate, or infer anything.
// The system has never trained a model (docs/AUDIT-SUMMARY.md §2), and no
// wording in this file, its responses, or the page it feeds may suggest it has.
//
// Mirrors the structure and read-only discipline of routes/parent-reports.js.

const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/auth');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const PatientProgressNote = require('../models/PatientProgressNote');
const scoring = require('../constants/scoring');

// The four scoring domains, in the order the clinician-facing pages display
// them. Display order and field mapping only — never a scoring input.
// Mirrors the DOMAINS table in routes/parent-reports.js.
const DOMAINS = Object.freeze([
  Object.freeze({ key: 'communication', label: 'Communication', scoreField: 'communicationScore', outcomeDomain: 'Communication' }),
  Object.freeze({ key: 'social',        label: 'Social Skills', scoreField: 'socialScore',        outcomeDomain: 'Social Skills' }),
  Object.freeze({ key: 'cognitive',     label: 'Cognitive',     scoreField: 'cognitiveScore',     outcomeDomain: 'Cognitive' }),
  Object.freeze({ key: 'motor',         label: 'Motor Skills',  scoreField: 'motorScore',         outcomeDomain: 'Motor Skills' }),
]);

// Band keys, high → low, taken from the shared band set so this file cannot
// drift from constants/scoring.js if ACTIVE_BANDS is ever changed.
const BAND_KEYS = Object.freeze(scoring.ACTIVE_BANDS.map((b) => b.key));

// The outcome vocabulary is read off the schema rather than restated here, so
// adding a sixth clinical outcome cannot silently leave this report showing
// five. Same reason routes/assessments.js reads enumValues in the diagnose
// handler instead of keeping its own list.
const OUTCOME_KEYS = Object.freeze(Assessment.schema.path('clinicalOutcome').enumValues.slice());

/** Every band key at zero, ready to be counted into. */
function emptyBandCounts() {
  return BAND_KEYS.reduce((acc, key) => { acc[key] = 0; return acc; }, {});
}

/** Every clinical outcome at zero. An outcome nobody recorded reads as 0, not absent. */
function emptyOutcomeCounts() {
  return OUTCOME_KEYS.reduce((acc, key) => { acc[key] = 0; return acc; }, {});
}

/**
 * Position of a band in ACTIVE_BANDS, which is ordered high → low.
 * A LOWER index is a BETTER band. Band movement is compared on this index and
 * never on the raw score: a child moving 61 → 78 has gained 17 points without
 * leaving the `developing` band, and calling that "improved band" would be a
 * different claim from the one the number supports.
 */
function bandIndex(bandKey) {
  return BAND_KEYS.indexOf(bandKey);
}

/** 'improved' | 'unchanged' | 'declined' between two band keys. */
function bandMovement(fromBand, toBand) {
  const a = bandIndex(fromBand);
  const b = bandIndex(toBand);
  if (a < 0 || b < 0) return 'unchanged';
  if (b < a) return 'improved';
  if (b > a) return 'declined';
  return 'unchanged';
}

/**
 * Optional ?from=&to= filter over AssessmentResult.generatedAt.
 * Default is all time — an absent filter must not silently become "this year".
 *
 * A date-only `to` such as '2026-08-08' parses to midnight UTC, which would
 * exclude every screening generated during that day. It is extended to the end
 * of the day so "to 8 August" means what the clinician setting the filter
 * expects. A full ISO timestamp is honoured exactly as given.
 */
function parseRange(query) {
  const out = { from: null, to: null };

  const rawFrom = query.from == null ? '' : String(query.from).trim();
  if (rawFrom) {
    const d = new Date(rawFrom);
    if (Number.isNaN(d.getTime())) return { error: 'Query parameter `from` is not a valid ISO date.' };
    out.from = d;
  }

  const rawTo = query.to == null ? '' : String(query.to).trim();
  if (rawTo) {
    const d = new Date(rawTo);
    if (Number.isNaN(d.getTime())) return { error: 'Query parameter `to` is not a valid ISO date.' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) d.setUTCHours(23, 59, 59, 999);
    out.to = d;
  }

  if (out.from && out.to && out.from > out.to) {
    return { error: 'Query parameter `from` must not be later than `to`.' };
  }
  return out;
}

/** The `range` block echoed back on every response, so the caller can see what was applied. */
function rangeEcho(range) {
  return {
    from: range.from ? range.from.toISOString() : null,
    to: range.to ? range.to.toISOString() : null,
  };
}

function fullName(child) {
  if (!child) return 'Unknown child';
  const name = `${child.firstName || ''} ${child.lastName || ''}`.trim();
  return name || 'Unnamed child';
}

/**
 * Role gate. Applied to every handler in this router.
 *
 * Note what this does NOT do: it does not accept a pediatricianId from the
 * client. Scope is derived from req.user.userId in loadScope() below, so a
 * pediatrician cannot ask for another pediatrician's cohort by changing a
 * query parameter.
 */
function pediatriciansOnly(req, res, next) {
  if (req.user.role !== 'pediatrician') {
    return res.status(403).json({ error: 'Pediatricians only.' });
  }
  return next();
}

/**
 * PATIENT SCOPE — the single definition used by every endpoint here.
 *
 * A child is in scope if, and only if, an Appointment exists linking that child
 * to the requesting pediatrician. This is the same rule the ownership gate in
 * routes/assessments.js:776 and routes/parent-reports.js uses, so this router
 * cannot be more permissive than the endpoints it reports on.
 *
 * The uniqueByChild dedupe is the pattern from /pedia-patients; the N+1 loop
 * that follows it there is deliberately NOT copied. Every collection below is
 * read exactly once with an $in over the scoped child ids, so cost is a
 * function of collection count, not of patient count.
 */
async function loadScope(req, range) {
  const appointments = await Appointment.find({ pediatricianId: req.user.userId })
    .select('childId')
    .lean();

  const seen = new Set();
  const childIds = [];
  for (const appt of appointments) {
    if (!appt.childId) continue;
    const key = String(appt.childId);
    if (seen.has(key)) continue;
    seen.add(key);
    childIds.push(appt.childId);
  }

  const resultFilter = { childId: { $in: childIds } };
  if (range.from || range.to) {
    resultFilter.generatedAt = {};
    if (range.from) resultFilter.generatedAt.$gte = range.from;
    if (range.to) resultFilter.generatedAt.$lte = range.to;
  }

  const [children, results] = await Promise.all([
    Child.find({ _id: { $in: childIds } })
      .select('firstName lastName dateOfBirth gender')
      .lean(),
    // Ascending so "latest per child" is simply the last one seen while
    // walking the list. _id is the tiebreaker for two results stamped in the
    // same millisecond, so the choice is deterministic rather than incidental.
    AssessmentResult.find(resultFilter)
      .sort({ generatedAt: 1, _id: 1 })
      .lean(),
  ]);

  const childMap = new Map(children.map((c) => [String(c._id), c]));

  // Results grouped by child, still in ascending date order.
  const resultsByChild = new Map();
  for (const r of results) {
    const key = String(r.childId);
    if (!resultsByChild.has(key)) resultsByChild.set(key, []);
    resultsByChild.get(key).push(r);
  }

  return { childIds, childMap, results, resultsByChild };
}

/**
 * The Assessment documents behind a set of results, keyed by assessment id.
 * Read as one $in query. Only the fields this report needs are selected —
 * `diagnosis` is deliberately not among them, because nothing in this module
 * may read a clinical conclusion out of free prose (models/Assessment.js).
 */
async function loadAssessments(results) {
  const assessmentIds = results.map((r) => r.assessmentId).filter(Boolean);
  const assessments = await Assessment.find({ _id: { $in: assessmentIds } })
    .select('clinicalOutcome clinicalOutcomeDomains clinicalOutcomeAt reviewedByPediatrician reviewedAt completedAt')
    .lean();
  return new Map(assessments.map((a) => [String(a._id), a]));
}

/** One screening flattened to stored scores plus bands derived from them. */
function screeningView(result) {
  const domains = {};
  for (const d of DOMAINS) {
    const score = result[d.scoreField] ?? null;
    domains[d.key] = {
      score,
      band: score == null ? null : scoring.bandFor(score),
      riskFlagged: score == null ? false : scoring.isRiskFlagged(score),
    };
  }
  const overallScore = result.overallScore ?? null;
  return {
    assessmentId: result.assessmentId ? String(result.assessmentId) : null,
    generatedAt: result.generatedAt || null,
    domains,
    overallScore,
    overallBand: overallScore == null ? null : scoring.bandFor(overallScore),
    // null on a document written before constants/scoring.js existed. Surfaced
    // rather than defaulted, because "we do not know which ruler produced the
    // stored labels" is information the reader is entitled to.
    scoringBandsVersion: result.scoringBandsVersion ?? null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// GET /api/pedia-reports/overview
// ───────────────────────────────────────────────────────────────────────────
router.get('/overview', authMiddleware, pediatriciansOnly, async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });

    const { childIds, results, resultsByChild } = await loadScope(req, range);
    const assessmentMap = await loadAssessments(results);

    // ── Distribution counting rule ──────────────────────────────────────────
    // overallDistribution and domainDistribution count the LATEST screening
    // per child, NOT every screening in the range.
    //
    // This is stated here because it is the first thing a panelist will ask.
    // Counting every screening would double-count any child screened twice,
    // so a cohort of 5 children where one was re-screened four times would be
    // described mostly by that one child. One child, one vote — and the
    // denominator is therefore patientsWithScreening, which is what lets the
    // four band counts in each domain reconcile against it exactly.
    //
    // The full per-screening picture is not lost: /export.csv emits one row
    // per screening, and /progression walks every screening a child has.
    const latestPerChild = [];
    for (const list of resultsByChild.values()) {
      latestPerChild.push(list[list.length - 1]);
    }

    const overallDistribution = emptyBandCounts();
    const domainDistribution = {};
    const riskFlagged = {};
    for (const d of DOMAINS) {
      domainDistribution[d.key] = emptyBandCounts();
      riskFlagged[d.key] = 0;
    }
    // Counts each child once however many of their domains were flagged, so it
    // is never the sum of the four counts above. Declared last so the response
    // reads domains-then-total.
    riskFlagged.anyDomain = 0;

    for (const result of latestPerChild) {
      const view = screeningView(result);

      // A stored overallScore of null cannot be banded. AssessmentResult
      // defaults it to 0, so this is a defensive branch rather than an
      // expected one — but a missing score must never be counted as a 0%
      // `delayed` child, which is a clinical claim the data does not make.
      if (view.overallBand) overallDistribution[view.overallBand] += 1;

      let anyFlag = false;
      for (const d of DOMAINS) {
        const dom = view.domains[d.key];
        if (dom.band) domainDistribution[d.key][dom.band] += 1;
        if (dom.riskFlagged) {
          riskFlagged[d.key] += 1;
          anyFlag = true;
        }
      }
      if (anyFlag) riskFlagged.anyDomain += 1;
    }

    // ── Outcome labelling coverage ──────────────────────────────────────────
    // Counted per SCREENING, not per child: the question this answers is "how
    // many of the screenings on file carry a clinician's structured
    // conclusion", which is the count that governs whether the outcomes
    // cross-tab means anything yet.
    const byOutcome = emptyOutcomeCounts();
    let labelled = 0;
    for (const result of results) {
      const assessment = assessmentMap.get(String(result.assessmentId));
      const outcome = assessment?.clinicalOutcome || null;
      if (!outcome) continue;
      labelled += 1;
      // An outcome outside the schema enum cannot reach the database, but a
      // hand-edited document could carry one. Counting it into a bucket that
      // does not exist would silently vanish it.
      if (Object.prototype.hasOwnProperty.call(byOutcome, outcome)) byOutcome[outcome] += 1;
    }

    res.json({
      success: true,
      range: rangeEcho(range),
      cohort: {
        patients: childIds.length,
        screenings: results.length,
        patientsWithScreening: resultsByChild.size,
        // Documents with no band-version stamp. Their bands in this report are
        // derived from the stored SCORE under the current ACTIVE_BANDS, so the
        // report is internally consistent — but the *Status strings saved on
        // those documents, which other pages read, were assigned under the old
        // cutoffs and may disagree. Surfaced so the page can say so.
        legacyBandDocs: results.filter((r) => (r.scoringBandsVersion ?? null) === null).length,
      },
      overallDistribution,
      domainDistribution,
      riskFlagged,
      labelling: {
        labelled,
        unlabelled: results.length - labelled,
        byOutcome,
      },
    });
  } catch (err) {
    console.error('pedia-reports overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/pedia-reports/progression
// ───────────────────────────────────────────────────────────────────────────
router.get('/progression', authMiddleware, pediatriciansOnly, async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });

    const { childIds, childMap, resultsByChild } = await loadScope(req, range);

    // Progress notes are scoped to the requesting pediatrician, matching the
    // filter in routes/assessments.js:807. A count shown here must agree with
    // the timeline the same clinician sees in My Patients, or the two pages
    // report different numbers for the same child.
    const notes = await PatientProgressNote.find({
      childId: { $in: childIds },
      pediatricianId: req.user.userId,
    })
      .select('childId progressStatus createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const notesByChild = new Map();
    for (const n of notes) {
      const key = String(n.childId);
      if (!notesByChild.has(key)) notesByChild.set(key, []);
      notesByChild.get(key).push(n);
    }

    const cohortMovement = { improved: 0, unchanged: 0, declined: 0 };
    const children = [];

    for (const [childKey, list] of resultsByChild.entries()) {
      // A progression needs two points. One screening is a reading, not a
      // trend, and a single-row "progression" invites reading a slope that is
      // not there. Same rule the parent report applies (trendAvailable).
      if (list.length < 2) continue;

      const child = childMap.get(childKey);
      const screenings = list.map(screeningView);
      const first = screenings[0];
      const latest = screenings[screenings.length - 1];

      const delta = {};
      const movement = {};
      for (const d of DOMAINS) {
        const a = first.domains[d.key];
        const b = latest.domains[d.key];
        delta[d.key] = (a.score == null || b.score == null) ? null : Math.round(b.score - a.score);
        movement[d.key] = (a.band && b.band) ? bandMovement(a.band, b.band) : 'unchanged';
      }

      delta.overall = (first.overallScore == null || latest.overallScore == null)
        ? null
        : Math.round(latest.overallScore - first.overallScore);
      const overallMovement = (first.overallBand && latest.overallBand)
        ? bandMovement(first.overallBand, latest.overallBand)
        : 'unchanged';
      movement.overall = overallMovement;
      cohortMovement[overallMovement] += 1;

      const childNotes = notesByChild.get(childKey) || [];

      children.push({
        childId: childKey,
        name: fullName(child),
        dateOfBirth: child?.dateOfBirth || null,
        firstScreening: first,
        latestScreening: latest,
        // Every screening in the range, oldest first, so the row can be
        // expanded without a second request per child.
        screenings,
        screeningCount: screenings.length,
        delta,
        bandMovement: movement,
        progressNoteCount: childNotes.length,
        latestProgressStatus: childNotes.length ? childNotes[childNotes.length - 1].progressStatus : null,

        // ── Band comparability ────────────────────────────────────────────
        // True when the two endpoints of this row were stamped with different
        // band-set versions (or one was not stamped at all).
        //
        // Precisely what it means here: the bands shown in this row are
        // recomputed from the stored SCORES under the current ACTIVE_BANDS, so
        // the two ends ARE measured on one ruler and the movement itself is
        // sound. What is not sound is reconciling this row against the
        // *Status strings saved on those documents, which other pages read and
        // which were assigned under different cutoffs. The flag exists so the
        // UI can say that rather than let the reader assume agreement.
        bandComparabilityWarning:
          (first.scoringBandsVersion ?? null) !== (latest.scoringBandsVersion ?? null),
      });
    }

    // Most-changed first is not the right default — it would rank children by
    // volatility. Alphabetical keeps the table a roster the clinician can scan.
    children.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      success: true,
      range: rangeEcho(range),
      cohortMovement,
      // How many in-scope children were left out of the table for having only
      // one screening, so an apparently short table is explained rather than
      // just short.
      childrenWithSingleScreening: Array.from(resultsByChild.values()).filter((l) => l.length === 1).length,
      patientsWithScreening: resultsByChild.size,
      children,
    });
  } catch (err) {
    console.error('pedia-reports progression error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/pedia-reports/outcomes
// ───────────────────────────────────────────────────────────────────────────
//
// WHY THIS RETURNS COUNTS AND NOT VALIDATION METRICS
// ---------------------------------------------------------------------------
// This handler deliberately computes NO accuracy, sensitivity, specificity,
// PPV, NPV, F1, kappa, or any other validation statistic, and none may be
// added later. Three independent reasons, each sufficient on its own:
//
//  1. SAMPLE SIZE. docs/AUDIT-SUMMARY.md §4 records 11 completed screenings
//     across the whole system. A sensitivity computed on a handful of labelled
//     cases has a confidence interval wide enough to span "useless" and
//     "excellent", and quoting the point estimate hides that.
//
//  2. THE LABELS ARE NOT BLIND. The pediatrician recording clinicalOutcome has
//     already seen the screening scores on the same page — the diagnosis modal
//     shows them. So the label is not independent of the thing it would be
//     validating, and agreement between them partly measures the influence of
//     the score on the clinician, not the correctness of the score.
//
//  3. THE CUTOFFS ARE UNCONFIRMED. Band provenance is still pending the
//     consultant pediatrician (constants/scoring.js header). An accuracy figure
//     computed against unconfirmed boundaries measures agreement with an
//     arbitrary line, not with child development.
//
// So: return the cross-tab and let the reader read it. A panelist is entitled
// to say a computed accuracy figure here would be misleading, and they would
// be right. The honest artefact is the contingency table itself.
router.get('/outcomes', authMiddleware, pediatriciansOnly, async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });

    const { childMap, results } = await loadScope(req, range);
    const assessmentMap = await loadAssessments(results);

    // Fully enumerated so every band × outcome cell exists at zero. An empty
    // cell must render as 0, never as a gap the reader fills in themselves.
    const matrix = {};
    for (const band of BAND_KEYS) matrix[band] = emptyOutcomeCounts();

    const rows = [];
    for (const result of results) {
      const assessment = assessmentMap.get(String(result.assessmentId));
      // Only a non-null clinicalOutcome counts as a label. The free-text
      // `diagnosis` field is never consulted — models/Assessment.js forbids
      // inferring a label from it, and the one diagnosis that existed before
      // that field was added was the string "Yes please".
      const outcome = assessment?.clinicalOutcome || null;
      if (!outcome) continue;

      const view = screeningView(result);
      if (view.overallBand && matrix[view.overallBand]
          && Object.prototype.hasOwnProperty.call(matrix[view.overallBand], outcome)) {
        matrix[view.overallBand][outcome] += 1;
      }

      rows.push({
        childName: fullName(childMap.get(String(result.childId))),
        assessmentId: view.assessmentId,
        screeningBand: view.overallBand,
        overallScore: view.overallScore,
        clinicalOutcome: outcome,
        clinicalOutcomeDomains: Array.isArray(assessment.clinicalOutcomeDomains)
          ? assessment.clinicalOutcomeDomains
          : [],
        clinicalOutcomeAt: assessment.clinicalOutcomeAt || null,
        screenedAt: view.generatedAt,
      });
    }

    rows.sort((a, b) => new Date(b.clinicalOutcomeAt || 0) - new Date(a.clinicalOutcomeAt || 0));

    const payload = {
      success: true,
      range: rangeEcho(range),
      labelledCount: rows.length,
      screeningCount: results.length,
      matrix,
      rows,
    };

    // Zero labels is the expected state today, not an error. Say so explicitly
    // rather than returning an empty table the reader has to interpret.
    if (rows.length === 0) {
      payload.message = results.length === 0
        ? 'No screenings on file for your patients in this date range, so there is nothing to cross-tabulate yet.'
        : `None of the ${results.length} screening${results.length === 1 ? '' : 's'} in this range has a recorded clinical outcome yet. `
          + 'Outcome labelling starts when a pediatrician records a structured conclusion in the diagnosis form. '
          + 'Until then this table stays empty — an outcome is never inferred from the written diagnosis.';
    }

    res.json(payload);
  } catch (err) {
    console.error('pedia-reports outcomes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/pedia-reports/export.csv
// ───────────────────────────────────────────────────────────────────────────

/**
 * RFC 4180 cell. Every field is quoted, and an embedded double quote is
 * doubled. Quoting unconditionally rather than only when a comma is present
 * keeps the rule one line long and removes the class of bug where a clinician's
 * note containing a newline splits a row.
 */
function csvCell(value) {
  if (value == null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function isoOrBlank(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

router.get('/export.csv', authMiddleware, pediatriciansOnly, async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });

    const { childMap, results } = await loadScope(req, range);
    const assessmentMap = await loadAssessments(results);

    const header = [
      'child_name', 'date_of_birth', 'screened_at',
      ...DOMAINS.flatMap((d) => [`${d.key}_score`, `${d.key}_band`]),
      'overall_score', 'overall_band',
      'scoring_bands_version', 'clinical_outcome', 'clinical_outcome_domains',
      'clinical_outcome_at', 'assessment_id',
    ];

    const lines = [csvRow(header)];

    for (const result of results) {
      const view = screeningView(result);
      const assessment = assessmentMap.get(String(result.assessmentId));

      lines.push(csvRow([
        fullName(childMap.get(String(result.childId))),
        isoOrBlank(childMap.get(String(result.childId))?.dateOfBirth),
        isoOrBlank(view.generatedAt),
        // The stored score, exactly as AssessmentResult holds it. Never
        // recomputed, never re-rounded, never re-averaged from the domains.
        ...DOMAINS.flatMap((d) => [view.domains[d.key].score ?? '', view.domains[d.key].band ?? '']),
        view.overallScore ?? '',
        view.overallBand ?? '',
        // Blank means the document carries no band-version stamp.
        view.scoringBandsVersion ?? '',
        assessment?.clinicalOutcome || '',
        Array.isArray(assessment?.clinicalOutcomeDomains) ? assessment.clinicalOutcomeDomains.join('; ') : '',
        isoOrBlank(assessment?.clinicalOutcomeAt),
        view.assessmentId || '',
      ]));
    }

    // CRLF is the RFC 4180 record separator, and it is what Excel expects.
    const csv = `${lines.join('\r\n')}\r\n`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kindercura-screenings.csv"');
    res.send(csv);
  } catch (err) {
    console.error('pedia-reports export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
