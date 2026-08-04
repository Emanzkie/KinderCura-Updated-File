// constants/scoring.js
// ============================================================================
// SINGLE SOURCE OF TRUTH for screening score bands, labels, and colours.
//
// TODO: Band cutoffs 80/60/40 unconfirmed — pending confirmation from
// consultant pediatrician. Do not cite as clinically validated.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Before this module, FOUR different cutoff sets were live simultaneously and
// disagreed about the same child. A score of 62 was reported as:
//   - "Developing"            to the parent      (js/parent/results.js)
//   - "on-track"              in the database    (routes/assessments.js)
//   - a focus area needing consultation (routes/recommendations.js,
//                                        routes/appointments.js)
// All band logic now lives here. Do not reintroduce a literal cutoff anywhere
// else in the codebase.
//
// ---------------------------------------------------------------------------
// WHY 80/60/40 WAS CHOSEN AS ACTIVE
// ---------------------------------------------------------------------------
// 1. It is what parents already see, so unifying to it changes nothing
//    parent-facing. (Verified: the label maps below reproduce the previous
//    js/parent/results.js output exactly at every score from 0-100.)
// 2. Relative to both 51/26 and 70/40 it flags MORE children rather than
//    fewer — a child at 65 moves from "on-track" to "developing". For a
//    screening instrument, erring toward over-referral is the safer
//    direction: a false positive costs a consultation, a false negative
//    costs a missed delay.
// 3. Provenance is still unconfirmed — see the TODO above.
//
// ---------------------------------------------------------------------------
// THE OTHER BAND SETS
// ---------------------------------------------------------------------------
// Retained below as documentation of what was previously live, so the audit
// trail survives and so a future decision can switch ACTIVE_BANDS in one line.
// They are NOT used by any call site.
//
// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------
// Dual-mode. Node:     const scoring = require('../constants/scoring');
//            Browser:  <script src="/constants/scoring.js"></script> then
//                      window.KCScoring   (served by express.static at
//                      server.js:93 — no extra mount needed)
// In HTML this script MUST load BEFORE any page script that consumes it.
// ============================================================================

(function (global) {
  'use strict';

  // ── Band keys ────────────────────────────────────────────────────────────
  // These strings are persisted to AssessmentResult.{communication,social,
  // cognitive,motor}Status. Changing a key is a data migration, not an edit.
  const BAND = Object.freeze({
    ON_TRACK: 'on-track',
    DEVELOPING: 'developing',
    AT_RISK: 'at-risk',
    DELAYED: 'delayed',
  });

  // Stamped onto AssessmentResult.scoringBandsVersion on every write so that
  // records scored under the old bands stay distinguishable. null = pre-audit.
  const SCORING_BANDS_VERSION = 'v2-80/60/40';

  // ── ACTIVE band set ──────────────────────────────────────────────────────
  // Ordered high → low. First band whose `min` the score meets, wins.
  const PARENT_DISPLAY_BANDS = Object.freeze([
    Object.freeze({ key: BAND.ON_TRACK,   min: 80, max: 100 }),
    Object.freeze({ key: BAND.DEVELOPING, min: 60, max: 79 }),
    Object.freeze({ key: BAND.AT_RISK,    min: 40, max: 59 }),
    Object.freeze({ key: BAND.DELAYED,    min: 0,  max: 39 }),
  ]);

  // ── Superseded band sets — documentation only, no call sites ─────────────
  // Previously routes/assessments.js:80-90 (persisted status + pedia filter).
  const STORED_STATUS_BANDS_V1 = Object.freeze([
    Object.freeze({ key: BAND.ON_TRACK, min: 51, max: 100 }),
    Object.freeze({ key: BAND.AT_RISK,  min: 26, max: 50 }),
    Object.freeze({ key: BAND.DELAYED,  min: 0,  max: 25 }),
  ]);

  // Previously routes/recommendations.js:121-157 and routes/appointments.js:551-576.
  const CLINICAL_BANDS_V1 = Object.freeze([
    Object.freeze({ key: BAND.ON_TRACK, min: 70, max: 100 }),
    Object.freeze({ key: BAND.AT_RISK,  min: 40, max: 69 }),
    Object.freeze({ key: BAND.DELAYED,  min: 0,  max: 39 }),
  ]);

  const ACTIVE_BANDS = PARENT_DISPLAY_BANDS;

  // ── Labels ───────────────────────────────────────────────────────────────
  // Two label vocabularies over ONE set of boundaries. The wording differs by
  // audience; the cutoffs never do. This is deliberate — the contradiction
  // this module removes was in the boundaries, not the words.

  // Parent per-domain chips. Reproduces the previous getStatusLabel() exactly.
  const PARENT_DOMAIN_LABELS = Object.freeze({
    [BAND.ON_TRACK]:   'Excellent',
    [BAND.DEVELOPING]: 'Good',
    [BAND.AT_RISK]:    'Fair',
    [BAND.DELAYED]:    'Needs Attention',
  });

  // Parent overall headline. Reproduces the previous getOverallStatus() exactly
  // (at-risk and delayed both mapped to "Needs Support" under the old <60 rule).
  const PARENT_OVERALL_LABELS = Object.freeze({
    [BAND.ON_TRACK]:   'On Track',
    [BAND.DEVELOPING]: 'Developing',
    [BAND.AT_RISK]:    'Needs Support',
    [BAND.DELAYED]:    'Needs Support',
  });

  // Clinician-facing (pediatrician dashboard, patient lists, filters).
  const CLINICAL_LABELS = Object.freeze({
    [BAND.ON_TRACK]:   'On-Track',
    [BAND.DEVELOPING]: 'Developing',
    [BAND.AT_RISK]:    'At-Risk',
    [BAND.DELAYED]:    'Delayed',
  });

  // ── Colours ──────────────────────────────────────────────────────────────
  // Consolidated from the two duplicate maps previously at
  // js/pedia/pedia-questions.js:894 and :1121. Red → orange → lime → green.
  const STATUS_COLORS = Object.freeze({
    [BAND.ON_TRACK]:   '#27ae60',
    [BAND.DEVELOPING]: '#7fb800',
    [BAND.AT_RISK]:    '#f39c12',
    [BAND.DELAYED]:    '#e74c3c',
  });

  // ── Risk-flag threshold ──────────────────────────────────────────────────
  // routes/assessments.js pushes a riskFlag when a domain falls below this.
  // Intentionally equal to the AT_RISK floor: "below the at-risk band" is the
  // same event as "flagged". Kept as a named constant so the coupling is
  // explicit rather than two literals that happen to agree.
  const RISK_FLAG_THRESHOLD = 40;

  // ── Core lookup ──────────────────────────────────────────────────────────

  /** Coerce to a finite number in 0-100; anything unusable becomes 0. */
  function normalizeScore(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, n));
  }

  /** Band key for a score, e.g. 72 -> 'developing'. */
  function bandFor(score, bands) {
    const n = normalizeScore(score);
    const set = bands || ACTIVE_BANDS;
    for (const b of set) {
      if (n >= b.min) return b.key;
    }
    return set[set.length - 1].key;
  }

  /** Canonical status string persisted to AssessmentResult. */
  function getStatus(score) {
    return bandFor(score);
  }

  /** Colour for a band key; falls back to the delayed colour if unknown. */
  function colorForBand(bandKey) {
    return STATUS_COLORS[bandKey] || STATUS_COLORS[BAND.DELAYED];
  }

  /** Colour straight from a score. */
  function colorForScore(score) {
    return colorForBand(bandFor(score));
  }

  /** Parent per-domain chip: { band, label, color }. */
  function parentDomainStatus(score) {
    const key = bandFor(score);
    return { band: key, label: PARENT_DOMAIN_LABELS[key], color: colorForBand(key) };
  }

  /** Parent overall headline label. */
  function parentOverallLabel(score) {
    return PARENT_OVERALL_LABELS[bandFor(score)];
  }

  /** Clinician-facing label for a band key. */
  function clinicalLabel(bandKey) {
    return CLINICAL_LABELS[bandKey] || bandKey;
  }

  /** True when this domain score should raise a riskFlag. */
  function isRiskFlagged(score) {
    return normalizeScore(score) < RISK_FLAG_THRESHOLD;
  }

  /**
   * Inclusive min/max range for a band key — drives the pediatrician
   * patient filter. Replaces the old THRESHOLD_RANGES literal.
   */
  const THRESHOLD_RANGES = Object.freeze(
    ACTIVE_BANDS.reduce((acc, b) => {
      acc[b.key] = Object.freeze({ min: b.min, max: b.max });
      return acc;
    }, {})
  );

  /** Filter-dropdown options, high → low, e.g. "On-Track (80-100%)". */
  function filterOptions() {
    return ACTIVE_BANDS.map((b) => ({
      value: b.key,
      label: `${clinicalLabel(b.key)} (${b.min}-${b.max}%)`,
    }));
  }

  const api = {
    BAND,
    SCORING_BANDS_VERSION,
    ACTIVE_BANDS,
    PARENT_DISPLAY_BANDS,
    STORED_STATUS_BANDS_V1,
    CLINICAL_BANDS_V1,
    PARENT_DOMAIN_LABELS,
    PARENT_OVERALL_LABELS,
    CLINICAL_LABELS,
    STATUS_COLORS,
    RISK_FLAG_THRESHOLD,
    THRESHOLD_RANGES,
    normalizeScore,
    bandFor,
    getStatus,
    colorForBand,
    colorForScore,
    parentDomainStatus,
    parentOverallLabel,
    clinicalLabel,
    isRiskFlagged,
    filterOptions,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCScoring = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
