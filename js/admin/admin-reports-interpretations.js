// js/admin/admin-reports-interpretations.js
// Pure, no-DB, no-network text generators for the "Demographic Profile of
// Late Development" and "Most Common Pediatrician Diagnosis" sections on
// ADMIN/admin-reports.html (js/admin/admin-reports.js). Mirrors the pattern
// established by js/pedia/pedia-reports-interpretations.js and
// js/admin/analytics-interpretations.js: every sentence is built from the
// counts the caller passes in — nothing here is a canned example.
//
// SCOPE — READ THIS BEFORE EDITING:
//   "Late development" here means the "Delayed" band ONLY
//   (constants/scoring.js BAND.DELAYED) — never a new category, never the
//   "Needs Support" grouping (At-Risk + Delayed) used elsewhere for
//   parent-facing labels. That decision was made deliberately (see the
//   adviser-revision plan); this file does not re-derive it, it only
//   describes whatever counts it is handed for the band the caller already
//   selected upstream.
//
// These are DESCRIPTIVE COUNTS ONLY. Nothing here may:
//   - claim a gender or age range CAUSES developmental delay
//   - claim a gender is more "biologically prone" to delay
//   - claim prevalence, incidence, or risk (this is a count of recorded
//     screenings/cases on file, not an epidemiological study)
//   - turn a tie into an arbitrary single winner
//
// Dual-mode like the files it mirrors: Node (tests) via require(), browser
// via window.KCAdminReportsInterpretations.
(function (global) {
  'use strict';

  function formatList(items) {
    const list = (items || []).filter(Boolean);
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
  }

  function plural(n, singular, pluralForm) {
    return n === 1 ? singular : (pluralForm || `${singular}s`);
  }

  /**
   * The MODE of a small, fully-enumerated counts object (e.g. gender or age-band
   * counts among Delayed cases — never more than a handful of keys). Returns
   * every key tied for the maximum, never an arbitrarily chosen single one.
   * `orderedKeys` controls both which keys are considered and their display
   * order when counts tie — callers pass the vocabulary's own key order so a
   * tie is reported in a stable, deterministic sequence.
   *
   * total === 0 is reported separately (`hasData: false`) rather than as a
   * meaningless N-way tie at zero.
   */
  function mostFrequentEntries(counts, orderedKeys) {
    const keys = orderedKeys || [];
    const total = keys.reduce((sum, k) => sum + (counts ? (counts[k] || 0) : 0), 0);
    if (total === 0) {
      return { hasData: false, total: 0, maxCount: 0, leaders: [] };
    }
    const maxCount = Math.max(...keys.map((k) => (counts ? (counts[k] || 0) : 0)));
    const leaders = keys.filter((k) => (counts ? (counts[k] || 0) : 0) === maxCount);
    return { hasData: true, total, maxCount, leaders };
  }

  /**
   * Gender-distribution interpretation for the Delayed population.
   *
   * @param {Object<string,number>} counts   e.g. { male: 12, female: 20, other: 1, unknown: 0 }
   * @param {string[]} orderedKeys           gender keys in display order (from vocabulary.genders), plus the unknown key
   * @param {Object<string,string>} labels   key -> human label (e.g. male -> "Male", unknown -> "Not recorded")
   */
  function formatGenderInterpretation(counts, orderedKeys, labels) {
    const mode = mostFrequentEntries(counts, orderedKeys);
    if (!mode.hasData) {
      return 'No assessments in the selected range are classified as Delayed, so a gender distribution cannot be shown.';
    }

    const nonZeroParts = orderedKeys
      .filter((k) => (counts[k] || 0) > 0)
      .map((k) => `${labels[k] || k} account${counts[k] === 1 ? 's' : ''} for ${counts[k]} ${plural(counts[k], 'case')}`);

    const leadSentence = mode.leaders.length > 1
      ? `${formatList(mode.leaders.map((k) => labels[k] || k))} are tied for the highest recorded count, each with ${mode.maxCount} ${plural(mode.maxCount, 'case')}.`
      : `The gender with the highest recorded count is ${labels[mode.leaders[0]] || mode.leaders[0]}, with ${mode.maxCount} ${plural(mode.maxCount, 'case')}.`;

    return `Among the ${mode.total} ${plural(mode.total, 'assessment')} classified as Delayed in this range, `
      + `${formatList(nonZeroParts)}. ${leadSentence} `
      + 'This is a descriptive count of recorded screenings only — it does not indicate that any gender causes, or is more biologically prone to, developmental delay.';
  }

  /**
   * Age-range interpretation for the Delayed population. Age is AT THE
   * ASSESSMENT (ageBasis: 'at_assessment' from the /screenings response),
   * never current age — the caller is responsible for using the right one
   * and this text always says so.
   *
   * @param {Object<string,number>} counts   e.g. { under_3: 2, age_3: 5, age_4: 9, ... , unknown: 0 }
   * @param {string[]} orderedKeys           age-band keys in display order (from vocabulary.ageBands), plus the unknown key
   * @param {Object<string,string>} labels   key -> human label (e.g. age_4 -> "4y", unknown -> "Age not available")
   */
  function formatAgeRangeInterpretation(counts, orderedKeys, labels) {
    const mode = mostFrequentEntries(counts, orderedKeys);
    if (!mode.hasData) {
      return 'No assessments in the selected range are classified as Delayed, so an age-range distribution cannot be shown.';
    }

    const nonZeroParts = orderedKeys
      .filter((k) => (counts[k] || 0) > 0)
      .map((k) => `${labels[k] || k}: ${counts[k]} ${plural(counts[k], 'case')}`);

    const leadSentence = mode.leaders.length > 1
      ? `${formatList(mode.leaders.map((k) => labels[k] || k))} are tied for the highest recorded count, each with ${mode.maxCount} ${plural(mode.maxCount, 'case')}.`
      : `The ${labels[mode.leaders[0]] || mode.leaders[0]} age range has the highest recorded count, with ${mode.maxCount} ${plural(mode.maxCount, 'case')}.`;

    return `Among the ${mode.total} ${plural(mode.total, 'assessment')} classified as Delayed in this range (age at the time of assessment), `
      + `${formatList(nonZeroParts)}. ${leadSentence} `
      + 'This is a descriptive count of recorded screenings only and does not indicate that any age range causes, or has a higher risk of, developmental delay.';
  }

  /**
   * Short interpretation line for the diagnosis-frequency table, from the
   * SAME diagnosisFrequency object the "Most Common Diagnosis" block itself
   * displays (routes/admin-reports.js computeDiagnosisMode). Never
   * recomputes the mode — only describes it.
   */
  function formatDiagnosisInterpretation(diagnosisFrequency) {
    const df = diagnosisFrequency || {};
    const total = df.totalConsidered || 0;
    if (total === 0 || !Array.isArray(df.rows) || df.rows.length === 0) {
      return 'No pediatrician diagnoses have been recorded in the selected report range.';
    }

    if (df.tie) {
      const pct = Math.round((df.topCount / total) * 100);
      return `${formatList(df.topDiagnoses)} are tied as the most frequently recorded diagnoses, each appearing in ${df.topCount} of ${total} `
        + `recorded ${plural(total, 'diagnosis', 'diagnoses')} (${pct}%). This reflects how often each diagnosis was recorded and is not a clinical conclusion on its own.`;
    }

    const pct = Math.round((df.topCount / total) * 100);
    return `${df.topDiagnoses[0]} is the most frequently recorded diagnosis, appearing in ${df.topCount} of ${total} `
      + `recorded ${plural(total, 'diagnosis', 'diagnoses')} (${pct}%). This reflects how often each diagnosis was recorded and is not a clinical conclusion on its own.`;
  }

  const api = {
    formatList,
    mostFrequentEntries,
    formatGenderInterpretation,
    formatAgeRangeInterpretation,
    formatDiagnosisInterpretation,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCAdminReportsInterpretations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
