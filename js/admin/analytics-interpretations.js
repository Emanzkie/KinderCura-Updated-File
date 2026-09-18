// js/admin/analytics-interpretations.js
// ============================================================================
// Pure, no-DB, no-network text generators for the Admin Analytics assessment-
// monitoring sections (score distribution, developmental-domain breakdown,
// monthly trend, monitoring summary, pediatrician comparison). Every sentence
// is built from the numbers the caller passes in — nothing here is hardcoded
// per the adviser's requirement that interpretations be generated from actual
// values, never canned examples like "Communication is always highest."
//
// Mirrors the dual-mode load pattern of js/parent/report-interpretations.js:
// Node (tests) via require(), browser via window.KCAnalyticsInterpretations.
// ============================================================================

(function (global) {
  'use strict';

  const DOMAIN_LABELS = Object.freeze({
    communication: 'Communication',
    social: 'Social Skills',
    cognitive: 'Cognitive',
    motor: 'Motor Skills',
  });
  const DOMAIN_KEYS = Object.freeze(['communication', 'social', 'cognitive', 'motor']);

  function formatList(labels) {
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  }

  /** { range, count }[] -> the bin(s) with the highest count, or [] if every bin is 0/empty. */
  function topBins(bins) {
    const nonEmpty = (bins || []).filter((b) => (b.count || 0) > 0);
    if (!nonEmpty.length) return [];
    const max = Math.max(...nonEmpty.map((b) => b.count));
    return nonEmpty.filter((b) => b.count === max);
  }

  /**
   * Assessment Score Distribution interpretation.
   * bins: [{ range: '80-89', count: 402 }, ...] (10 bins, 0-9 .. 90-100)
   */
  function formatHistogramInterpretation(bins, total) {
    const t = total != null ? total : (bins || []).reduce((s, b) => s + (b.count || 0), 0);
    if (!t) {
      return 'No completed assessments with a recorded score are available yet, so a score distribution cannot be shown.';
    }
    const top = topBins(bins);
    if (!top.length) {
      return 'No completed assessments with a recorded score are available yet, so a score distribution cannot be shown.';
    }
    const rangeText = top.length === 1
      ? `the ${top[0].range} score range`
      : `the ${formatList(top.map((b) => b.range))} score ranges (tied)`;
    const count = top[0].count;
    const plural = count === 1 ? 'assessment' : 'assessments';
    return `The largest group of completed assessments falls within ${rangeText}, with ${count} recorded ${plural} out of ${t} total. This chart describes the distribution of recorded assessment scores and does not by itself indicate a diagnosis.`;
  }

  /**
   * Developmental Areas Requiring Monitoring interpretation.
   * counts: { communication, social, cognitive, motor, total }
   */
  function formatDomainInterpretation(counts) {
    const total = counts.total || 0;
    if (!total) {
      return 'No completed assessments are available yet, so developmental-domain monitoring counts cannot be shown.';
    }
    const values = DOMAIN_KEYS.map((key) => ({ key, label: DOMAIN_LABELS[key], count: counts[key] || 0 }));
    const max = Math.max(...values.map((v) => v.count));
    if (max === 0) {
      return `None of the ${total} recorded completed assessments currently fall in the system's needs-support range for any developmental domain.`;
    }
    const leaders = values.filter((v) => v.count === max);
    const leadText = leaders.length === 1
      ? `${leaders[0].label} has the highest number of results`
      : `${formatList(leaders.map((v) => v.label))} are tied for the highest number of results`;
    return `Based on the recorded assessments, ${leadText} in the system's needs-support range, with ${max} out of ${total} completed assessments. This indicates where monitoring demand is currently more concentrated in the recorded assessment data, and is not a diagnosis.`;
  }

  /** Domain with the highest count in a single monthly-trend row; null if the row has no needs-support cases at all. */
  function leadingDomainForMonth(row) {
    const values = DOMAIN_KEYS.map((key) => ({ key, label: DOMAIN_LABELS[key], count: row[key] || 0 }));
    const max = Math.max(...values.map((v) => v.count));
    if (max === 0) return { leaders: [], max: 0 };
    return { leaders: values.filter((v) => v.count === max), max };
  }

  /**
   * Computes the Current Monitoring Summary panel data from the monthly
   * domain-trend rows (ascending by month). Returns a plain object the caller
   * renders — never fabricates a month that isn't in the data.
   */
  function computeMonitoringSummary(monthlyTrend) {
    const rows = monthlyTrend || [];
    if (!rows.length) {
      return {
        hasData: false,
        hasComparison: false,
        trendText: 'Not enough completed assessment data is available yet to compute a developmental monitoring trend.',
      };
    }

    const latest = rows[rows.length - 1];
    const latestLead = leadingDomainForMonth(latest);
    const latestTotal = DOMAIN_KEYS.reduce((s, k) => s + (latest[k] || 0), 0);
    const latestLeadLabel = latestLead.leaders.length
      ? formatList(latestLead.leaders.map((v) => v.label))
      : 'None';

    if (rows.length === 1) {
      return {
        hasData: true,
        hasComparison: false,
        latest,
        latestLeadLabel,
        latestLeadCount: latestLead.max,
        latestTotal,
        trendText: `Only one month of assessment data is available (${latest.monthLabel}), so a month-over-month trend cannot be determined yet.`,
      };
    }

    const previous = rows[rows.length - 2];
    const previousLead = leadingDomainForMonth(previous);
    const previousLeadLabel = previousLead.leaders.length
      ? formatList(previousLead.leaders.map((v) => v.label))
      : 'None';

    const sameLeaders = latestLead.leaders.length === previousLead.leaders.length
      && latestLead.leaders.every((v) => previousLead.leaders.some((p) => p.key === v.key));
    const changed = !(latestLead.leaders.length && previousLead.leaders.length && sameLeaders);

    let trendText;
    if (!latestLead.leaders.length && !previousLead.leaders.length) {
      trendText = `Neither ${previous.monthLabel} nor ${latest.monthLabel} recorded any needs-support results in the tracked domains.`;
    } else if (changed) {
      trendText = `Leading monitoring area changed from ${previousLeadLabel} in ${previous.monthLabel} to ${latestLeadLabel} in ${latest.monthLabel}.`;
    } else {
      trendText = `${latestLeadLabel} remained the leading monitoring area from ${previous.monthLabel} to ${latest.monthLabel}.`;
    }

    return {
      hasData: true,
      hasComparison: true,
      latest,
      previous,
      latestLeadLabel,
      latestLeadCount: latestLead.max,
      latestTotal,
      previousLeadLabel,
      previousLeadCount: previousLead.max,
      changed,
      trendText,
    };
  }

  /**
   * One-paragraph note explaining why the Pediatrician Assessment Comparison
   * ranks by needs-support cases rather than claiming an outcome/effectiveness
   * metric. reviewedAssessmentsSystemWide is the live count so the wording
   * never states a stale number.
   */
  function formatPediatricianComparisonNote(reviewedAssessmentsSystemWide) {
    const n = reviewedAssessmentsSystemWide || 0;
    const reviewedPhrase = n === 0
      ? 'no completed assessments have been reviewed by a pediatrician yet'
      : `only ${n} completed assessment${n === 1 ? ' has' : 's have'} been reviewed by a pediatrician`;
    return `Comparison based on recorded assessment monitoring data, not pediatrician performance or effectiveness. Pediatricians are ranked by needs-support cases among their relevant children, which shows where monitoring demand is currently concentrated. Because ${reviewedPhrase}, and no child has two or more reviewed assessments under the same pediatrician yet, there is not enough repeat-review history to calculate a score-change or outcome metric. The Reviewed Assessments column is shown instead as a descriptive count, not an outcome measure.`;
  }

  /** Per-row interpretation sentence for the Pediatrician Assessment Comparison table. */
  function formatPediatricianRowInterpretation(row) {
    const { relevantChildren, completedAssessments, needsSupportCases } = row;
    if (!completedAssessments) {
      return `${relevantChildren} relevant child${relevantChildren === 1 ? '' : 'ren'}, no completed assessments recorded yet.`;
    }
    return `${needsSupportCases} of ${completedAssessments} completed assessment${completedAssessments === 1 ? '' : 's'} among ${relevantChildren} relevant child${relevantChildren === 1 ? '' : 'ren'} fall in the needs-support range.`;
  }

  const api = {
    DOMAIN_LABELS,
    DOMAIN_KEYS,
    formatList,
    topBins,
    formatHistogramInterpretation,
    formatDomainInterpretation,
    leadingDomainForMonth,
    computeMonitoringSummary,
    formatPediatricianComparisonNote,
    formatPediatricianRowInterpretation,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCAnalyticsInterpretations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
