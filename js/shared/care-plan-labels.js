// js/shared/care-plan-labels.js
// ============================================================================
// Browser-only PRESENTATION helper for the care-plan fields the backend
// already decided (constants/developmental-staging.js via
// services/assessmentProgress.js). This file only formats enum strings
// (careStage, consultationLevel, monitoringLevel, source, developmentalBand,
// riskCategory) into parent/pediatrician-facing text and a badge tone.
//
// It NEVER decides a developmentalBand, riskCategory, careStage,
// consultationLevel, or monitoringLevel from scores — those values always
// come from the API response (results/compare/recommendations/pedia-patients
// endpoints). See Step 14 task section 11 "Consistency Check" — this is
// deliberately not a second decision layer, only shared wording so the
// parent, pediatrician, and reassessment views never disagree on how the
// same backend value is displayed.
//
// Loaded via <script src="/js/shared/care-plan-labels.js"></script> — must
// load before any page script that calls window.KCCarePlan.
// ============================================================================

(function (global) {
  'use strict';

  // Internal vocabulary (constants/developmental-staging.js CARE_STAGE_DEFINITIONS)
  // -> parent/pediatrician-facing text. Matches the exact wording given in the
  // Step 14 task ("Scheduled pediatric consultation", "Continued parent
  // monitoring", etc.).
  const CONSULTATION_LEVEL_LABELS = Object.freeze({
    as_needed: 'Consultation as needed',
    scheduled: 'Scheduled pediatric consultation',
    required: 'Pediatric consultation required',
  });

  const MONITORING_LEVEL_LABELS = Object.freeze({
    parent_monitoring: 'Parent monitoring',
    continued_parent_monitoring: 'Continued parent monitoring',
    close_monitoring: 'Close monitoring',
  });

  // Never claims clinical validation — see constants/scoring.js and
  // constants/developmental-staging.js headers for why.
  const SOURCE_LABELS = Object.freeze({
    ml: 'ML prediction',
    rule_based: 'Standard scoring fallback',
  });

  // Same band keys as constants/scoring.js BAND — kept as a local copy
  // (display text only) rather than requiring that isomorphic file here, to
  // avoid a second load-order dependency on this page set.
  const DEVELOPMENTAL_BAND_LABELS = Object.freeze({
    'on-track': 'On-Track',
    developing: 'Developing',
    'at-risk': 'At-Risk',
    delayed: 'Delayed',
  });

  const NOT_AVAILABLE = 'Not available';

  function consultationLevelLabel(level) {
    return CONSULTATION_LEVEL_LABELS[level] || NOT_AVAILABLE;
  }

  function monitoringLevelLabel(level) {
    return MONITORING_LEVEL_LABELS[level] || NOT_AVAILABLE;
  }

  function sourceLabel(source) {
    return SOURCE_LABELS[source] || NOT_AVAILABLE;
  }

  function developmentalBandLabel(band) {
    return DEVELOPMENTAL_BAND_LABELS[band] || (band ? String(band) : NOT_AVAILABLE);
  }

  // riskCategory ('Low'/'Medium'/'High') already arrives human-readable from
  // the API. A rule_based record has no ML classification by design, so say
  // that rather than a generic "Not available".
  const NO_ML_PREDICTION = 'No ML prediction';

  function riskCategoryLabel(riskCategory, source) {
    if (riskCategory) return riskCategory;
    return source === 'rule_based' ? NO_ML_PREDICTION : NOT_AVAILABLE;
  }

  function careStageLabel(label) {
    return label || NOT_AVAILABLE;
  }

  // "Assessment interpretation: ML prediction" / "... standard scoring
  // fallback" — the exact wording the Step 14 task specifies. Never says
  // "ML prediction failed" to a parent (section 9).
  function interpretationLine(source) {
    return `Assessment interpretation: ${sourceLabel(source)}`;
  }

  // Badge tone only — reuses the site-wide .kc-badge system
  // (CSS files/dashboard-new-styles.css) so these chips look identical to
  // every other status badge in the app instead of inventing new colors.
  function toneForDevelopmentalBand(band) {
    if (band === 'on-track' || band === 'developing') return 'positive';
    if (band === 'at-risk') return 'caution';
    if (band === 'delayed') return 'attention';
    return 'neutral';
  }

  function toneForRiskCategory(riskCategory) {
    const key = String(riskCategory || '').toLowerCase();
    if (key === 'low') return 'positive';
    if (key === 'medium') return 'caution';
    if (key === 'high') return 'attention';
    return 'neutral';
  }

  function toneForCareStage(careStage) {
    if (careStage === 'low_concern') return 'positive';
    if (careStage === 'intermediate') return 'caution';
    if (careStage === 'severe') return 'attention';
    return 'neutral';
  }

  function toneForDirection(direction) {
    if (direction === 'improved') return 'positive';
    if (direction === 'worsened') return 'attention';
    if (direction === 'no_change') return 'neutral';
    return 'neutral';
  }

  // "Improved" / "Increased concern" / "No change" — matches the wording
  // already used by js/parent/results.js stageComparisonBadge, kept here so
  // every page that shows a progress direction agrees on the words.
  function directionLabel(direction) {
    if (direction === 'improved') return 'Improved';
    if (direction === 'worsened') return 'Increased concern';
    if (direction === 'no_change') return 'No change';
    return 'Not available';
  }

  // Plain-language "what is this?" line for each field of the Developmental
  // Assessment & Care Plan card (parent Results + Recommendations pages share
  // it so they never word the same field differently). Describes how the
  // backend ALREADY decided each value (constants/developmental-staging.js) —
  // it never derives one. Plain text: callers escape it.
  function fieldHints(riskCategory, source) {
    const risk = riskCategory
      ? 'Low, Medium or High — generated by KinderCura\'s assessment prediction model from this assessment. It supports follow-up discussion with your pediatrician and is not a medical diagnosis.'
      : (source === 'rule_based'
        ? 'No prediction-model result was available for this assessment, so the Care Stage follows the standard scoring rules instead.'
        : 'Not available for this assessment.');
    const stage = source === 'rule_based'
      ? 'Follow-up level from KinderCura\'s care-plan rules, based on the Developmental Band (On-Track or Developing → Low Concern, At-Risk → Intermediate Concern, Delayed → Severe Concern).'
      : 'Follow-up level from KinderCura\'s care-plan rules, based on the risk category (Low → Low Concern, Medium → Intermediate Concern, High → Severe Concern).';
    // Ranges are read from constants/scoring.js (window.KCScoring) when the
    // page loads it — never re-typed here, so they cannot drift.
    const S = global.KCScoring;
    const ranges = S && Array.isArray(S.ACTIVE_BANDS)
      ? ` (${S.ACTIVE_BANDS.map((b) => `${b.min}–${b.max}% ${developmentalBandLabel(b.key)}`).join(', ')})`
      : '';
    return {
      band: `Set from the overall assessment score using KinderCura's score ranges${ranges}.`,
      risk,
      stage,
      consultation: 'Suggested consultation level for this Care Stage.',
      monitoring: 'Suggested monitoring level for this Care Stage.',
      disclaimer: 'These results support follow-up discussion with your pediatrician and are not a medical diagnosis.',
    };
  }

  const api = {
    fieldHints,
    consultationLevelLabel,
    monitoringLevelLabel,
    sourceLabel,
    developmentalBandLabel,
    riskCategoryLabel,
    careStageLabel,
    interpretationLine,
    toneForDevelopmentalBand,
    toneForRiskCategory,
    toneForCareStage,
    toneForDirection,
    directionLabel,
    NOT_AVAILABLE,
  };

  if (typeof window !== 'undefined') window.KCCarePlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
