// js/pedia/pedia-reports-interpretations.js
// Pure, no-DB, no-network text generators for the pediatrician-facing
// Classification overview charts and cohort progression summary on
// PEDIA/pedia-reports.html (js/pedia/pedia-reports.js). Mirrors the pattern
// established by js/admin/analytics-interpretations.js and
// js/parent/report-interpretations.js: every sentence is built from the
// counts the caller passes in — nothing here is a canned example, and
// nothing here recomputes a band or care-stage decision. Band keys and the
// "needs support" grouping (at-risk + delayed) come straight from
// constants/scoring.js, the same definition routes/admin.js already uses
// for the Admin Analytics "Developmental Areas Requiring Monitoring" chart —
// this file does not invent a second one.
//
// Dual-mode like the files it mirrors: Node (tests) via require(), browser
// via window.KCPediaReportsInterpretations.
(function (global) {
  'use strict';

  const KCScoring = (typeof module !== 'undefined' && module.exports)
    ? require('../../constants/scoring')
    : (typeof window !== 'undefined' ? window.KCScoring : null);

  const DOMAIN_LABELS = Object.freeze({
    communication: 'Communication',
    social: 'Social Skills',
    cognitive: 'Cognitive',
    motor: 'Motor Skills',
  });
  const DOMAIN_KEYS = Object.freeze(['communication', 'social', 'cognitive', 'motor']);

  // Same pairing routes/admin.js NEEDS_SUPPORT_BANDS uses for the Admin
  // Analytics domain-monitoring chart (score < 60 = AT_RISK or DELAYED).
  const NEEDS_SUPPORT_BANDS = KCScoring
    ? Object.freeze([KCScoring.BAND.AT_RISK, KCScoring.BAND.DELAYED])
    : Object.freeze(['at-risk', 'delayed']);

  function formatList(labels) {
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  }

  function plural(n, singular, pluralForm) {
    return n === 1 ? singular : (pluralForm || `${singular}s`);
  }

  /** Sum of a per-band count object over the given band keys; missing bands treated as 0. */
  function sumBands(bandCounts, keys) {
    return keys.reduce((sum, k) => sum + (bandCounts ? (bandCounts[k] || 0) : 0), 0);
  }

  /**
   * Classification overview — band distribution PER DOMAIN (stacked bar
   * chart). domainDistribution: { communication: {on-track:N,...}, ... }
   * (routes/pedia-reports.js GET /overview). patientsWithScreening is the
   * chart's denominator — one vote per child, the latest screening only.
   */
  function formatDomainBandInterpretation(domainDistribution, patientsWithScreening) {
    const total = patientsWithScreening || 0;
    if (!total) {
      return 'None of your patients has a completed assessment in this range yet, so a per-domain band distribution cannot be shown.';
    }

    const values = DOMAIN_KEYS.map((key) => ({
      key,
      label: DOMAIN_LABELS[key],
      needsSupport: sumBands(domainDistribution ? domainDistribution[key] : null, NEEDS_SUPPORT_BANDS),
    }));
    const max = Math.max(...values.map((v) => v.needsSupport));

    if (max === 0) {
      return `Based on the latest assessment on file for each patient, none of your ${total} assessed ${plural(total, 'patient')} currently falls in the at-risk or delayed range for any developmental domain.`;
    }

    const leaders = values.filter((v) => v.needsSupport === max);
    const leadText = leaders.length === 1
      ? `${leaders[0].label} has the highest number of patients`
      : `${formatList(leaders.map((v) => v.label))} are tied for the highest number of patients`;

    return `Based on the latest assessment on file for each patient, ${leadText} in the at-risk or delayed range, with ${max} of ${total} assessed ${plural(total, 'patient')}. This shows where monitoring demand is currently concentrated among your patients and is not a diagnosis.`;
  }

  /**
   * Classification overview — OVERALL band distribution (doughnut chart).
   * overallDistribution: { 'on-track': N, developing: N, 'at-risk': N, delayed: N }
   * (routes/pedia-reports.js GET /overview).
   */
  function formatOverallBandInterpretation(overallDistribution, patientsWithScreening) {
    const total = patientsWithScreening || 0;
    if (!total || !KCScoring) {
      return 'None of your patients has a completed assessment in this range yet, so an overall band distribution cannot be shown.';
    }

    const keys = KCScoring.ACTIVE_BANDS.map((b) => b.key);
    const values = keys.map((key) => ({
      key,
      label: KCScoring.clinicalLabel(key),
      count: overallDistribution ? (overallDistribution[key] || 0) : 0,
    }));
    const max = Math.max(...values.map((v) => v.count));

    if (max === 0) {
      return `None of your ${total} assessed ${plural(total, 'patient')} has a recorded overall band yet.`;
    }

    const leaders = values.filter((v) => v.count === max);
    const leadPct = Math.round((max / total) * 100);
    const leadText = leaders.length === 1
      ? `the "${leaders[0].label}" range`
      : `the ${formatList(leaders.map((v) => `"${v.label}"`))} ranges (tied)`;

    const needsSupportTotal = sumBands(overallDistribution, NEEDS_SUPPORT_BANDS);
    let sentence = `${max} of your ${total} assessed ${plural(total, 'patient')} (${leadPct}%) — the largest group — falls in ${leadText} for their latest overall assessment score.`;

    if (needsSupportTotal > 0) {
      const needsPct = Math.round((needsSupportTotal / total) * 100);
      sentence += ` ${needsSupportTotal} of ${total} (${needsPct}%) fall in the at-risk or delayed range, which is the group KinderCura's existing scoring rules flag for closer monitoring or consultation.`;
    } else {
      sentence += ' None currently fall in the at-risk or delayed range under KinderCura\'s existing scoring rules.';
    }

    sentence += ' This describes recorded assessment results on file and is not a diagnosis.';
    return sentence;
  }

  /**
   * Assessment-to-assessment progression — cohort-level summary of band
   * movement between each patient's first and latest screening in range
   * (routes/pedia-reports.js GET /progression cohortMovement, already
   * computed from the SAME band-index comparison the per-row chips use —
   * this file only describes it, never recomputes it).
   */
  function formatProgressionCohortInterpretation(cohortMovement, childrenCompared) {
    const n = childrenCompared || 0;
    if (!n) {
      return 'None of your patients has two or more completed assessments in this range yet, so a progression direction cannot be described.';
    }

    const improved = (cohortMovement && cohortMovement.improved) || 0;
    const unchanged = (cohortMovement && cohortMovement.unchanged) || 0;
    const declined = (cohortMovement && cohortMovement.declined) || 0;

    const parts = [];
    if (improved) parts.push(`${improved} moved to a better overall band`);
    if (unchanged) parts.push(`${unchanged} stayed in the same overall band`);
    if (declined) parts.push(`${declined} moved to a band indicating more concern`);

    const partsText = parts.length ? formatList(parts) : 'no band movement was recorded';

    return `Comparing each patient's first and latest assessment in this range (${n} ${plural(n, 'patient')} with repeat assessments): ${partsText}. Band movement is based on KinderCura's existing scoring bands, and on its own does not indicate a medical diagnosis, cause, or a pediatrician's effectiveness.`;
  }

  const api = {
    DOMAIN_LABELS,
    DOMAIN_KEYS,
    NEEDS_SUPPORT_BANDS,
    formatList,
    sumBands,
    formatDomainBandInterpretation,
    formatOverallBandInterpretation,
    formatProgressionCohortInterpretation,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCPediaReportsInterpretations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
