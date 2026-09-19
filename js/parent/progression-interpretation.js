// js/parent/progression-interpretation.js
// Pure, deterministic text for the "Assessment Progression" chart on
// PARENT/results.html (js/parent/results.js renderComparisonSection). The
// same page and script also render for a pediatrician/admin viewing one
// child's results (see results.js resolveContext), so this file is shared
// by both audiences rather than duplicated per role.
//
// Reads only values the caller already resolved from
// GET /api/assessments/:id/compare (services/assessmentProgress.js) and from
// window.KCScoring / window.KCCarePlan. This file never looks up a band,
// consultation level, or monitoring level itself, and never recomputes a
// score — it only turns already-decided values into a sentence. That keeps
// it testable with plain objects (see tests/unit/progression-interpretation.test.js)
// and keeps scoring/care-plan decisions in exactly one place each
// (constants/scoring.js, constants/developmental-staging.js).
//
// Wording rules (same as js/parent/report-interpretations.js):
//   - never call a score increase "improvement" as a medical claim
//   - never state or imply a diagnosis
//   - only name a consultation/monitoring level that was actually passed in
(function (global) {
  'use strict';

  /** "+N" / "-N" / "0" — never null; callers must not call this with a null diff. */
  function formatSignedPoints(diff) {
    if (diff > 0) return `+${diff}`;
    if (diff < 0) return `${diff}`;
    return '0';
  }

  /**
   * The score's own raw-point direction between two overall scores.
   * Independent of band or care-stage movement — a score can move several
   * points without crossing a band boundary.
   */
  function scoreDirection(current, previous) {
    if (current == null || previous == null) return 'unavailable';
    const diff = Math.round(current) - Math.round(previous);
    if (diff > 0) return 'positive';
    if (diff < 0) return 'negative';
    return 'none';
  }

  /** Short label for the at-a-glance "Direction" stat. */
  function directionWord(direction) {
    if (direction === 'positive') return 'Positive change';
    if (direction === 'negative') return 'Negative change';
    if (direction === 'none') return 'No change';
    return 'Not available';
  }

  /**
   * Full interpretation paragraph for the Previous-vs-Current overall score.
   *
   * @param {object} params
   *   current, previous {number|null}     overall scores, 0-100
   *   currentBandLabel, previousBandLabel {string|null}  already resolved via
   *     window.KCScoring.clinicalLabel — never recomputed here
   *   careStageDirection {string}  'improved'|'worsened'|'no_change'|'unavailable'
   *     from the SAME /compare response (constants/developmental-staging.js
   *     compareCareStages) — this file never re-derives it from the score
   *   consultationLabel, monitoringLabel {string|null}  the CURRENT side's
   *     already-decided care plan, already resolved via window.KCCarePlan —
   *     named ONLY when careStageDirection is 'worsened', so a stable or
   *     improved result never leads with a consultation callout
   * @returns {string}
   */
  function buildOverallProgressionInterpretation(params) {
    const {
      current, previous,
      currentBandLabel, previousBandLabel,
      careStageDirection,
      consultationLabel, monitoringLabel,
    } = params || {};

    if (current == null || previous == null) {
      return 'Not enough recorded score data is available to describe how this assessment changed from the previous one.';
    }

    const cur = Math.round(current);
    const prev = Math.round(previous);
    const diff = cur - prev;
    const bandChanged = Boolean(currentBandLabel && previousBandLabel && currentBandLabel !== previousBandLabel);

    let sentence;
    if (diff > 0) {
      sentence = `The child's recorded overall assessment score increased from ${prev}% to ${cur}%, a change of +${diff} point${diff === 1 ? '' : 's'} compared with the previous assessment.`;
    } else if (diff < 0) {
      sentence = `The child's recorded overall assessment score decreased from ${prev}% to ${cur}%, a change of ${diff} point${diff === -1 ? '' : 's'} compared with the previous assessment.`;
    } else {
      sentence = `The child's recorded overall assessment score remained stable at ${cur}%, unchanged from the previous assessment.`;
    }

    if (bandChanged) {
      sentence += ` This moved the result from the previous "${previousBandLabel}" range to the current "${currentBandLabel}" range, using KinderCura's existing scoring bands.`;
    } else if (currentBandLabel) {
      sentence += ` The result stays within the "${currentBandLabel}" range under KinderCura's existing scoring bands.`;
    }

    const planBits = [consultationLabel, monitoringLabel].filter(Boolean).join(' and ');
    if (careStageDirection === 'worsened' && planBits) {
      sentence += ` Based on KinderCura's existing scoring and care-plan rules, the current result now corresponds to ${planBits}. This reflects the recorded assessment result only and is not a medical diagnosis.`;
    } else if (diff < 0 || bandChanged) {
      sentence += ' This describes a change in the recorded screening result only, and does not by itself indicate a medical diagnosis or its cause.';
    } else if (diff === 0 && !bandChanged) {
      sentence += ' A single unchanged result is not by itself a sign of improvement or concern — it describes the recorded screening only.';
    }

    return sentence;
  }

  const api = {
    formatSignedPoints,
    scoreDirection,
    directionWord,
    buildOverallProgressionInterpretation,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCProgressionInterpretation = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
