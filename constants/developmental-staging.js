// constants/developmental-staging.js
// ============================================================================
// Step 8: THREE SEPARATE CONCEPTS. Steps 1-7 conflated all of them under one
// "stage" field — this module (and everything that reads it) now keeps them
// apart, both in code and in stored/API field names.
//
// A. DEVELOPMENTAL BAND — a screening-SCORE classification. Source of truth
//    is constants/scoring.js (BAND / bandFor()). Values: 'on-track',
//    'developing', 'at-risk', 'delayed'. The 80/60/40 cutoffs live ONLY in
//    constants/scoring.js — this module never redefines them, it only calls
//    scoring.bandFor() via getDevelopmentalBandFromScore() below.
//
// B. ML RISK CATEGORY — the raw output of ml/predict.py: 'Low' / 'Medium' /
//    'High'. This module never invents or derives a risk category from
//    scores; it only interprets one a trained model already produced (see
//    ml/trainer.py — labels are never auto-generated, Step 2).
//
// C. CARE STAGE — this module's OWN concept: the level of follow-up/
//    monitoring the adviser described. Values: 'low_concern',
//    'intermediate', 'severe'. It is derived from EITHER a risk category
//    (preferred, when a compatible active ML model exists) OR, as a
//    fallback, a developmental band (when no compatible model is active) —
//    never both at once. Callers track which happened via `source`: 'ml' |
//    'rule_based' (unchanged since Step 5).
//
// Care stage is a PROJECT CARE-PLAN CLASSIFICATION, not a medical diagnosis.
// Never describe it with words like "cured", "recovered", "diagnosed", or
// "medically normal" — see constants/scoring.js and this file's history for
// why over-claiming has already been a problem in this codebase.
//
// REMAINING AMBIGUITY — NEEDS ADVISER CONFIRMATION (carried over from Step 1):
// 1. The rule-based (developmental-band-based) fallback path collapses
//    'on-track' + 'developing' together into the same care stage
//    (LOW_CONCERN). Is that the right split?
// 2. constants/scoring.js's 80/60/40 cutoffs are themselves still
//    unconfirmed by the consultant pediatrician.
// 3. ml/trainer.py's fallback label derivation (dead code path — only used
//    if a training CSV somehow lacks risk_category, which Step 2 now
//    rejects outright) still contains a third, separate threshold set.
// ============================================================================

const scoring = require('./scoring');

// ═══════════════════════════════════════════════════════════════════════
// A. DEVELOPMENTAL BAND — adapter only. No thresholds live here.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Developmental band for a raw 0-100 score. Thin pass-through to
 * constants/scoring.js's bandFor() — the ONLY source of the 80/60/40
 * cutoffs. Returns scoring.BAND.* values verbatim ('on-track', 'developing',
 * 'at-risk', 'delayed') — never a second, differently-formatted copy.
 */
function getDevelopmentalBandFromScore(score) {
  return scoring.bandFor(score);
}

// ═══════════════════════════════════════════════════════════════════════
// B. ML RISK CATEGORY
// ═══════════════════════════════════════════════════════════════════════

// Exactly what ml/trainer.py trains on and ml/predict.py returns.
const RISK_CATEGORY = Object.freeze({
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
});

const RISK_CATEGORY_DEFINITIONS = Object.freeze({
  [RISK_CATEGORY.LOW]: Object.freeze({ riskCategory: RISK_CATEGORY.LOW, label: 'Low' }),
  [RISK_CATEGORY.MEDIUM]: Object.freeze({ riskCategory: RISK_CATEGORY.MEDIUM, label: 'Medium' }),
  [RISK_CATEGORY.HIGH]: Object.freeze({ riskCategory: RISK_CATEGORY.HIGH, label: 'High' }),
});

/** Normalizes and validates an ML-predicted risk category string. Returns null if unrecognized. */
function getRiskCategoryDefinition(riskCategory) {
  if (typeof riskCategory !== 'string') return null;
  const normalized = riskCategory.trim().toLowerCase();
  for (const key of Object.keys(RISK_CATEGORY_DEFINITIONS)) {
    if (key.toLowerCase() === normalized) return RISK_CATEGORY_DEFINITIONS[key];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// C. CARE STAGE
// ═══════════════════════════════════════════════════════════════════════

const CARE_STAGE = Object.freeze({
  LOW_CONCERN: 'low_concern',
  INTERMEDIATE: 'intermediate',
  SEVERE: 'severe',
});

// consultationLevel / monitoringLevel are internal vocabulary for
// recommendation logic to branch on — not user-facing strings. `label` is
// deliberately care-plan wording only (no "on track" / "developing" /
// "delayed" language) so it never gets mistaken for a developmental band.
const CARE_STAGE_DEFINITIONS = Object.freeze({
  [CARE_STAGE.LOW_CONCERN]: Object.freeze({
    careStage: CARE_STAGE.LOW_CONCERN,
    label: 'Low Concern',
    consultationLevel: 'as_needed',
    monitoringLevel: 'parent_monitoring',
  }),
  [CARE_STAGE.INTERMEDIATE]: Object.freeze({
    careStage: CARE_STAGE.INTERMEDIATE,
    label: 'Intermediate Concern',
    consultationLevel: 'scheduled',
    monitoringLevel: 'continued_parent_monitoring',
  }),
  [CARE_STAGE.SEVERE]: Object.freeze({
    careStage: CARE_STAGE.SEVERE,
    label: 'Severe Concern',
    consultationLevel: 'required',
    monitoringLevel: 'close_monitoring',
  }),
});

/** Full care-stage definition — label + consultation/monitoring levels. */
function getCareStageDefinition(careStage) {
  return CARE_STAGE_DEFINITIONS[careStage] || null;
}

/** Just the care-plan portion of a care-stage definition. */
function getCarePlanForCareStage(careStage) {
  const def = CARE_STAGE_DEFINITIONS[careStage];
  if (!def) return null;
  return {
    careStage: def.careStage,
    consultationLevel: def.consultationLevel,
    monitoringLevel: def.monitoringLevel,
  };
}

function isSevereCareStage(careStage) {
  return careStage === CARE_STAGE.SEVERE;
}

// ── B -> C: ML risk category -> care stage (the PREFERRED path) ──────────
const RISK_CATEGORY_TO_CARE_STAGE = Object.freeze({
  [RISK_CATEGORY.LOW]: CARE_STAGE.LOW_CONCERN,
  [RISK_CATEGORY.MEDIUM]: CARE_STAGE.INTERMEDIATE,
  [RISK_CATEGORY.HIGH]: CARE_STAGE.SEVERE,
});

/**
 * Map an ML-predicted risk category ("Low"/"Medium"/"High", case-insensitive)
 * to a care stage. Returns null for anything unrecognized so callers fall
 * back to the developmental-band path explicitly instead of guessing.
 */
function getCareStageFromRiskCategory(riskCategory) {
  const def = getRiskCategoryDefinition(riskCategory);
  return def ? RISK_CATEGORY_TO_CARE_STAGE[def.riskCategory] : null;
}

// ── A -> C: developmental band -> care stage (FALLBACK path only) ────────
// Used ONLY when no compatible ML prediction exists (see
// services/assessmentProgress.js getRuleBasedCareStage). Reuses the exact
// grouping already established in Step 1 (routes/assessments.js
// RISK_LEVEL_BY_BAND): {on-track, developing} -> low concern, at-risk ->
// intermediate, delayed -> severe. This is the ONLY place that mapping is
// defined — do not re-derive it elsewhere.
const DEVELOPMENTAL_BAND_TO_CARE_STAGE = Object.freeze({
  [scoring.BAND.ON_TRACK]: CARE_STAGE.LOW_CONCERN,
  [scoring.BAND.DEVELOPING]: CARE_STAGE.LOW_CONCERN,
  [scoring.BAND.AT_RISK]: CARE_STAGE.INTERMEDIATE,
  [scoring.BAND.DELAYED]: CARE_STAGE.SEVERE,
});

/**
 * Map a developmental band (a scoring.BAND.* value) to a care stage.
 * Unrecognized input fails toward CARE_STAGE.SEVERE, matching this
 * codebase's existing over-referral-over-under-referral bias (see
 * constants/scoring.js "WHY 80/60/40 WAS CHOSEN AS ACTIVE").
 */
function getCareStageFromDevelopmentalBand(developmentalBand) {
  return DEVELOPMENTAL_BAND_TO_CARE_STAGE[developmentalBand] || CARE_STAGE.SEVERE;
}

/** Convenience: care stage directly from a raw 0-100 score (fallback path — see above). */
function getCareStageFromScore(score) {
  return getCareStageFromDevelopmentalBand(getDevelopmentalBandFromScore(score));
}

// ── Technical care-stage ordering (reassessment comparison) ───────────────
// Purely a technical rank for comparing two assessments of the SAME child
// over time — "lower rank" means "this screening flagged less concern", not
// "healthier" or "cured" in any medical sense.
const CARE_STAGE_RANK = Object.freeze({
  [CARE_STAGE.LOW_CONCERN]: 0,
  [CARE_STAGE.INTERMEDIATE]: 1,
  [CARE_STAGE.SEVERE]: 2,
});

/** Technical rank for a care stage, or null if unrecognized. */
function getCareStageRank(careStage) {
  return Object.prototype.hasOwnProperty.call(CARE_STAGE_RANK, careStage) ? CARE_STAGE_RANK[careStage] : null;
}

/**
 * Compare two care stages and classify the direction of change between
 * them. This is the ONLY place that decides "improved" vs "worsened" for
 * care-plan progression — callers must not re-derive this from raw scores
 * or risk categories themselves.
 *
 * @param {string|null} previousCareStage  a CARE_STAGE.* value, or null/unrecognized
 * @param {string|null} currentCareStage   a CARE_STAGE.* value, or null/unrecognized
 * @returns {{direction: 'improved'|'no_change'|'worsened'|'unavailable',
 *            previousCareStage: string|null, currentCareStage: string|null,
 *            previousRank: number|null, currentRank: number|null}}
 */
function compareCareStages(previousCareStage, currentCareStage) {
  const previousRank = getCareStageRank(previousCareStage);
  const currentRank = getCareStageRank(currentCareStage);

  if (previousRank == null || currentRank == null) {
    return {
      direction: 'unavailable',
      previousCareStage: previousCareStage || null,
      currentCareStage: currentCareStage || null,
      previousRank,
      currentRank,
    };
  }

  let direction;
  if (currentRank < previousRank) direction = 'improved';
  else if (currentRank > previousRank) direction = 'worsened';
  else direction = 'no_change';

  return { direction, previousCareStage, currentCareStage, previousRank, currentRank };
}

module.exports = {
  // A. Developmental band
  getDevelopmentalBandFromScore,
  // B. ML risk category
  RISK_CATEGORY,
  RISK_CATEGORY_DEFINITIONS,
  getRiskCategoryDefinition,
  // C. Care stage
  CARE_STAGE,
  CARE_STAGE_DEFINITIONS,
  CARE_STAGE_RANK,
  getCareStageDefinition,
  getCarePlanForCareStage,
  isSevereCareStage,
  getCareStageRank,
  compareCareStages,
  // B -> C and A -> C mappings
  RISK_CATEGORY_TO_CARE_STAGE,
  DEVELOPMENTAL_BAND_TO_CARE_STAGE,
  getCareStageFromRiskCategory,
  getCareStageFromDevelopmentalBand,
  getCareStageFromScore,
};
