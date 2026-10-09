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
    // With fewer than two reviews system-wide, no child can have two reviewed
    // assessments under one pediatrician — only then is that clause provably
    // true, so it is not stated otherwise.
    const repeatClause = n < 2
      ? ', so no child has two or more reviewed assessments under the same pediatrician yet'
      : '';
    return `Comparison based on recorded assessment monitoring data, not pediatrician performance or effectiveness. Pediatricians are listed in order of needs-support cases among their relevant children (most first). The order shows where monitoring demand is currently concentrated; it is not a ranking of clinical skill, accuracy or effectiveness. Because ${reviewedPhrase}${repeatClause}, there is not enough repeat-review history to calculate a score-change or outcome metric. The Reviewed Assessments column is shown instead as a descriptive count, not an outcome measure.`;
  }

  /** Per-row interpretation sentence for the Pediatrician Assessment Comparison table. */
  function formatPediatricianRowInterpretation(row) {
    const { relevantChildren, completedAssessments, needsSupportCases } = row;
    if (!completedAssessments) {
      return `${relevantChildren} relevant child${relevantChildren === 1 ? '' : 'ren'}, no completed assessments recorded yet.`;
    }
    return `${needsSupportCases} of ${completedAssessments} completed assessment${completedAssessments === 1 ? '' : 's'} among ${relevantChildren} relevant child${relevantChildren === 1 ? '' : 'ren'} fall in the needs-support range.`;
  }

  // ── Metric helpers (percentages, shares, month handling) ──────────────────
  // Pure arithmetic over fields /api/admin/analytics already returns. A share
  // is only produced when the part belongs to the whole's population;
  // otherwise null, which the page renders as "N/A".

  function isCount(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }

  /** part ÷ whole × 100, or null (missing value, empty population, part > whole). */
  function sharePercent(part, whole) {
    if (!isCount(part) || !isCount(whole) || whole === 0 || part > whole) return null;
    return (part / whole) * 100;
  }

  /** "70.2%", "<0.1%" for a non-zero share that would round to 0.0, "N/A" for null. */
  function formatPercent(percent) {
    if (percent == null || !Number.isFinite(percent)) return 'N/A';
    if (percent > 0 && percent < 0.05) return '<0.1%';
    return `${percent.toFixed(1)}%`;
  }

  /** "+12.5%", "−48.2%", "0.0%" — for a change, where the sign carries meaning. */
  function formatSignedPercent(change) {
    if (change == null || !Number.isFinite(change)) return 'N/A';
    const rounded = Math.round(change * 10) / 10;
    if (rounded === 0) return '0.0%';
    return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}%`;
  }

  function formatCount(value) {
    return isCount(value) ? value.toLocaleString('en-US') : '—';
  }

  /**
   * Month-over-month change in NEW sign-ups. monthlySignups is the API's
   * 6-month window, oldest first, whose last entry is the CURRENT month and
   * therefore only partly over. Comparing it with a full month is not like
   * for like, so the change is taken between the last two FULL months, with
   * the earlier one as the baseline. The current month is returned separately
   * as context only.
   *   available:false, reason:'zero-baseline' — the baseline month had no
   *     sign-ups, so a % change is undefined (never shown as +100% or ∞).
   *   A drop to zero from a non-zero baseline is a real −100%.
   */
  function computeSignupChange(monthlySignups) {
    const rows = Array.isArray(monthlySignups) ? monthlySignups : [];
    const partial = rows.length ? rows[rows.length - 1] : null;
    if (rows.length < 3) return { available: false, reason: 'not-enough-months', partial };
    const latest = rows[rows.length - 2];
    const previous = rows[rows.length - 3];
    if (!latest || !previous || !isCount(latest.count) || !isCount(previous.count)) {
      return { available: false, reason: 'missing', latest, previous, partial };
    }
    if (previous.count === 0) {
      return { available: false, reason: 'zero-baseline', latest, previous, partial };
    }
    return {
      available: true,
      change: ((latest.count - previous.count) / previous.count) * 100,
      latest,
      previous,
      partial,
    };
  }

  /**
   * Assessment completion rate over ONE population: every assessment session
   * ever started (summaryTotals.totalAssessments). Sessions are in_progress,
   * submitted or complete, so submitted = total − complete − in progress.
   */
  function computeCompletionRate(summary) {
    const s = summary || {};
    const total = isCount(s.totalAssessments) ? s.totalAssessments : null;
    const complete = isCount(s.completedScreenings) ? s.completedScreenings : null;
    const inProgress = isCount(s.inProgressScreenings) ? s.inProgressScreenings : null;
    const submitted = total != null && complete != null && inProgress != null && total - complete - inProgress >= 0
      ? total - complete - inProgress
      : null;
    return { rate: sharePercent(complete, total), total, complete, inProgress, submitted };
  }

  /** Adds share = count ÷ (sum of every row's count) — one denominator for all rows. */
  function withShares(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const total = list.reduce((sum, r) => sum + (isCount(r.count) ? r.count : 0), 0);
    return {
      total,
      rows: list.map((r) => ({ ...r, share: sharePercent(isCount(r.count) ? r.count : null, total) })),
    };
  }

  /**
   * Groups the 10-point histogram bins into score bands. bands: [{ key,
   * label, min, max }] (constants/scoring.js ACTIVE_BANDS + clinicalLabel).
   * The band edges (0/40/60/80) fall on bin edges, so every bin belongs to
   * exactly one band.
   */
  function summarizeScoreBands(bins, bands) {
    const binList = Array.isArray(bins) ? bins : [];
    const total = binList.reduce((sum, b) => sum + (isCount(b.count) ? b.count : 0), 0);
    return (bands || []).map((band) => {
      const count = binList
        .filter((b) => {
          const start = parseInt(String(b.range), 10);
          return Number.isFinite(start) && start >= band.min && start <= band.max;
        })
        .reduce((sum, b) => sum + (isCount(b.count) ? b.count : 0), 0);
      return { ...band, count, share: sharePercent(count, total) };
    });
  }

  function monthLabelFor(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  /**
   * Prepares domainMonthlyTrend (rows keyed 'YYYY-MM' by UTC completion month,
   * oldest first) for display:
   *   - months with no completed assessments between the first and last row
   *     are filled with zero rows, so the x-axis is evenly spaced in time;
   *   - the row for currentMonthKey (the month still in progress) is flagged
   *     isPartial and kept out of completeRows, so it is never compared with
   *     full months.
   */
  function prepareMonthlyTrend(monthlyTrend, currentMonthKey) {
    const KEY = /^\d{4}-\d{2}$/;
    const source = (Array.isArray(monthlyTrend) ? monthlyTrend : [])
      .filter((r) => r && KEY.test(r.month))
      .slice()
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    if (!source.length) return { rows: [], completeRows: [], partialRow: null };

    const byMonth = new Map(source.map((r) => [r.month, r]));
    const rows = [];
    let [y, m] = source[0].month.split('-').map(Number);
    const last = source[source.length - 1].month;
    for (let guard = 0; guard < 600; guard += 1) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const row = byMonth.get(key) || {
        month: key,
        monthLabel: monthLabelFor(key),
        totalAssessments: 0,
        communication: 0,
        social: 0,
        cognitive: 0,
        motor: 0,
      };
      rows.push({ ...row, isPartial: key === currentMonthKey });
      if (key === last) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return {
      rows,
      completeRows: rows.filter((r) => !r.isPartial),
      partialRow: rows.find((r) => r.isPartial) || null,
    };
  }

  const api = {
    DOMAIN_LABELS,
    DOMAIN_KEYS,
    isCount,
    sharePercent,
    formatPercent,
    formatSignedPercent,
    formatCount,
    computeSignupChange,
    computeCompletionRate,
    withShares,
    summarizeScoreBands,
    prepareMonthlyTrend,
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
