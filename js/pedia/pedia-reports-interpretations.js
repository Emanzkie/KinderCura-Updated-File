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

  /**
   * One sentence per developmental domain, naming the ACTUAL count in each
   * band, to sit beside the plain counts table. The chart shows the shape; this
   * says the numbers out loud for a reader who would rather not read a stacked
   * bar. Wording is deliberately "classified as" / "falls under" / "may warrant
   * closer review" — never a clinical claim about a child.
   *
   * Returns [{ key, label, text }] in display order, or [] when nothing is
   * assessed yet.
   */
  function formatDomainCountSentences(domainDistribution, patientsWithScreening) {
    const total = patientsWithScreening || 0;
    if (!total) return [];

    const bandKeys = KCScoring ? KCScoring.ACTIVE_BANDS.map((b) => b.key) : ['on-track', 'developing', 'at-risk', 'delayed'];
    const labelFor = (k) => (KCScoring ? KCScoring.clinicalLabel(k) : k);

    return DOMAIN_KEYS.map((key) => {
      const counts = (domainDistribution && domainDistribution[key]) || {};
      // "11 classified as On-Track, 3 as Developing, …" — the phrase is written
      // out once and then elided, which is how the sentence would be spoken.
      const present = bandKeys
        .map((b) => ({ band: b, n: counts[b] || 0 }))
        .filter((p) => p.n > 0);
      const parts = present.map((p, i) => (i === 0
        ? `${p.n} classified as ${labelFor(p.band)}`
        : `${p.n} as ${labelFor(p.band)}`));

      const needsSupport = sumBands(counts, NEEDS_SUPPORT_BANDS);
      let text = parts.length
        ? `Of the ${total} assessed ${plural(total, 'patient')}: ${formatList(parts)}.`
        : `None of the ${total} assessed ${plural(total, 'patient')} has a recorded band for this domain.`;

      if (needsSupport > 0) {
        text += ` ${needsSupport} of ${total} ${plural(needsSupport, 'falls', 'fall')} in the at-risk or delayed range and may warrant closer review.`;
      }

      return { key, label: DOMAIN_LABELS[key], text };
    });
  }

  /**
   * Plain-language gloss for a single child's band movement, replacing the bare
   * "Improved / Same / Declined Overall Band" label. Describes where the
   * recorded result moved, and says nothing about why.
   */
  function formatMovementDescription(movement) {
    if (movement === 'improved') {
      return 'Latest result moved to a classification indicating less concern compared with the first recorded assessment.';
    }
    if (movement === 'declined') {
      return 'Latest result moved to a classification indicating greater concern compared with the first recorded assessment.';
    }
    return 'Latest result remains in the same classification as the first recorded assessment.';
  }

  /**
   * The per-patient summary shown when a progression row is expanded. Every
   * value is passed in by the caller from the stored record; nothing is
   * recomputed here, and dates arrive pre-formatted so this stays locale-free
   * and unit-testable.
   */
  function formatPatientProgressionInterpretation(detail) {
    const d = detail || {};
    const name = d.name || 'This patient';
    const n = d.assessmentCount || 0;
    if (n < 2) {
      return `${name} has fewer than two recorded assessments in this range, so a change over time cannot be described.`;
    }

    const labelFor = (k) => (KCScoring && k ? KCScoring.clinicalLabel(k) : null);
    const firstBand = labelFor(d.firstBand);
    const latestBand = labelFor(d.latestBand);
    const pct = (v) => (v == null ? 'no recorded score' : `${v}%`);

    let text = `${name} has ${n} recorded ${plural(n, 'assessment')} in this range. `;
    text += `The first recorded overall result was ${pct(d.firstScore)}`;
    if (firstBand) text += ` (${firstBand})`;
    if (d.firstDate) text += ` on ${d.firstDate}`;
    text += `, and the latest is ${pct(d.latestScore)}`;
    if (latestBand) text += ` (${latestBand})`;
    if (d.latestDate) text += ` on ${d.latestDate}`;
    text += '. ';

    if (latestBand) {
      text += `Under KinderCura's existing classification rules the latest recorded result falls under the ${latestBand} band. `;
    }
    text += formatMovementDescription(d.movement);
    text += ' These are recorded assessment results, not a diagnosis.';
    return text;
  }

  /**
   * The patient roster table. Says what the table covers, including the
   * children it lists that have no assessment in range — they are part of the
   * cohort and omitting them from the sentence would misdescribe the table.
   */
  function formatPatientRosterInterpretation(totals) {
    const t = totals || {};
    const patients = t.patients || 0;
    if (!patients) {
      return 'No patients match the current filters, so there is nothing to list.';
    }

    const withAssessment = t.withAssessment || 0;
    const withoutAssessment = t.withoutAssessment || 0;
    const repeat = t.withRepeatAssessments || 0;
    const assessments = t.assessments || 0;

    let text = `This table lists ${patients} ${plural(patients, 'patient')} matching the current filters, covering ${assessments} recorded ${plural(assessments, 'assessment')}. `;
    text += `${withAssessment} ${plural(withAssessment, 'has', 'have')} at least one assessment in this range`;
    if (repeat > 0) {
      text += `, of which ${repeat} ${plural(repeat, 'has', 'have')} more than one`;
    }
    text += '. ';
    text += withoutAssessment > 0
      ? `${withoutAssessment} ${plural(withoutAssessment, 'patient')} ${plural(withoutAssessment, 'has', 'have')} no assessment in this range and ${plural(withoutAssessment, 'is', 'are')} listed without a result.`
      : 'Every listed patient has at least one assessment in this range.';
    return text;
  }

  const MONTH_NAMES = Object.freeze([
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]);

  /** '2026-08' -> 'August 2026'. Returns the input unchanged if it is not that shape. */
  function formatMonthLabel(month) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    if (!m) return String(month || '');
    const idx = Number(m[2]) - 1;
    if (idx < 0 || idx > 11) return String(month);
    return `${MONTH_NAMES[idx]} ${m[1]}`;
  }

  /**
   * Assessment activity over time. Describes volume and when it happened —
   * a workload/coverage figure, carrying no clinical meaning at all.
   */
  function formatActivityInterpretation(byMonth) {
    const rows = Array.isArray(byMonth) ? byMonth.filter((r) => r && r.count > 0) : [];
    if (!rows.length) {
      return 'No assessments were recorded for your patients in this range, so there is no activity to chart.';
    }

    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const months = rows.length;
    const busiest = rows.reduce((a, b) => (b.count > a.count ? b : a), rows[0]);
    const span = months === 1
      ? `in ${formatMonthLabel(rows[0].month)}`
      : `across ${months} months, from ${formatMonthLabel(rows[0].month)} to ${formatMonthLabel(rows[rows.length - 1].month)}`;

    let text = `${total} ${plural(total, 'assessment')} ${plural(total, 'was', 'were')} recorded ${span}. `;
    if (months > 1) {
      text += `The busiest month was ${formatMonthLabel(busiest.month)} with ${busiest.count}. `;
    }
    text += 'This counts assessment activity only and says nothing about the results themselves.';
    return text;
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
    formatDomainCountSentences,
    formatMovementDescription,
    formatPatientProgressionInterpretation,
    formatPatientRosterInterpretation,
    formatMonthLabel,
    formatActivityInterpretation,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCPediaReportsInterpretations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
