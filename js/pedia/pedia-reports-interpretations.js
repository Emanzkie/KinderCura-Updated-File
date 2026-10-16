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

  // ── Assessment activity over time ─────────────────────────────────────────
  //
  // The activity chart counts assessments per day, week or month. Everything
  // below works on calendar-day keys ('YYYY-MM-DD') that the caller derives in
  // the viewer's time zone — the same time zone the page prints each
  // assessment's date in — so a point on the chart and the rows in the records
  // table always agree. Day arithmetic is done in UTC on those keys, which
  // makes these functions independent of the machine they run on.

  const SHORT_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  const DAY_MS = 86400000;

  // Auto interval: daily up to a month, weekly up to about six months,
  // monthly beyond that — enough points to show a shape, few enough to read.
  const DAILY_MAX_DAYS = 31;
  const WEEKLY_MAX_DAYS = 183;

  const INTERVAL_WORDS = Object.freeze({
    day: { unit: 'day', units: 'days', axis: 'Assessment Date' },
    week: { unit: 'week', units: 'weeks', axis: 'Assessment Week (weeks start Monday)' },
    month: { unit: 'month', units: 'months', axis: 'Assessment Month' },
  });

  function isDayKey(key) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(key || ''));
  }

  function dayKeyToUtc(key) {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function utcToDayKey(ms) {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }

  /** '2026-10-02' -> 'Oct 2, 2026'. */
  function formatDayLabel(key) {
    if (!isDayKey(key)) return String(key || '');
    const [y, m, d] = key.split('-').map(Number);
    return `${SHORT_MONTHS[m - 1]} ${d}, ${y}`;
  }

  /** The bucket a day falls in: itself, the Monday of its week, or 'YYYY-MM'. */
  function bucketKeyFor(dayKey, interval) {
    if (interval === 'month') return dayKey.slice(0, 7);
    if (interval === 'week') {
      const ms = dayKeyToUtc(dayKey);
      const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
      return utcToDayKey(ms - sinceMonday * DAY_MS);
    }
    return dayKey;
  }

  /** 'day' | 'week' | 'month' for an inclusive span of day keys. */
  function chooseActivityInterval(startKey, endKey) {
    if (!isDayKey(startKey) || !isDayKey(endKey)) return 'month';
    const days = Math.round((dayKeyToUtc(endKey) - dayKeyToUtc(startKey)) / DAY_MS) + 1;
    if (days <= DAILY_MAX_DAYS) return 'day';
    if (days <= WEEKLY_MAX_DAYS) return 'week';
    return 'month';
  }

  /**
   * Assessments per interval, oldest first, with every interval between the
   * first and last one present — an interval with no assessment is a 0 point,
   * not a missing one. The span is widened to cover every given day, so no
   * assessment can fall outside the series: the counts always sum to
   * dayKeys.length.
   *
   * Returns [{ key, label, rangeLabel, count }]. `label` is the axis label;
   * `rangeLabel` spells the interval out for tooltips ("Sep 28 – Oct 4, 2026").
   */
  function buildActivitySeries(dayKeys, interval, startKey, endKey) {
    const days = (Array.isArray(dayKeys) ? dayKeys : []).filter(isDayKey).sort();
    const bounds = [startKey, endKey, days[0], days[days.length - 1]].filter(isDayKey).sort();
    if (!bounds.length) return [];
    const first = bucketKeyFor(bounds[0], interval);
    const last = bucketKeyFor(bounds[bounds.length - 1], interval);

    const counts = new Map();
    for (const day of days) {
      const key = bucketKeyFor(day, interval);
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const series = [];
    let key = first;
    while (key <= last) {
      let label;
      let rangeLabel;
      let next;
      if (interval === 'month') {
        label = formatMonthLabel(key);
        rangeLabel = label;
        const [y, m] = key.split('-').map(Number);
        next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      } else if (interval === 'week') {
        const sunday = utcToDayKey(dayKeyToUtc(key) + 6 * DAY_MS);
        label = `Week of ${formatDayLabel(key)}`;
        rangeLabel = `${formatDayLabel(key)} – ${formatDayLabel(sunday)}`;
        next = utcToDayKey(dayKeyToUtc(key) + 7 * DAY_MS);
      } else {
        label = formatDayLabel(key);
        rangeLabel = label;
        next = utcToDayKey(dayKeyToUtc(key) + DAY_MS);
      }
      series.push({ key, label, rangeLabel, count: counts.get(key) || 0 });
      key = next;
    }
    return series;
  }

  /**
   * Assessment activity over time. Describes volume and when it happened —
   * a workload/coverage figure, carrying no clinical meaning at all.
   */
  function formatActivityTrendInterpretation(series, interval) {
    const rows = Array.isArray(series) ? series : [];
    const total = rows.reduce((sum, r) => sum + (r.count || 0), 0);
    if (!total) {
      return 'No assessments were recorded for your patients during the selected period, so there is no activity to describe.';
    }

    const words = INTERVAL_WORDS[interval] || INTERVAL_WORDS.month;
    const max = Math.max(...rows.map((r) => r.count || 0));
    const busiest = rows.filter((r) => r.count === max);
    const active = rows.filter((r) => r.count > 0).length;
    const on = interval === 'day' ? 'on' : 'in';
    const name = (r) => (interval === 'week' ? `the week of ${r.rangeLabel}` : r.rangeLabel);

    let text = `A total of ${total} ${plural(total, 'assessment')} ${plural(total, 'was', 'were')} recorded during the selected period`;
    text += rows.length > 1
      ? `, from ${rows[0].rangeLabel.split(' – ')[0]} to ${rows[rows.length - 1].rangeLabel.split(' – ').pop()}, shown per ${words.unit}. `
      : ` (${rows[0].rangeLabel}). `;

    if (rows.length > 1) {
      if (busiest.length === 1) {
        text += `The highest activity occurred ${on} ${name(busiest[0])}, with ${max} ${plural(max, 'assessment')}. `;
      } else if (busiest.length <= 3) {
        text += `The highest activity, ${max} ${plural(max, 'assessment')}, occurred ${on} ${formatList(busiest.map(name))}. `;
      } else {
        text += `The highest activity, ${max} ${plural(max, 'assessment')}, occurred in ${busiest.length} different ${words.units}. `;
      }
      text += `${active} of ${rows.length} ${words.units} had at least one assessment. `;
    }
    text += 'This counts assessment activity only: more assessments does not mean that any patient\'s development improved.';
    return text;
  }

  /**
   * Patient Development Progress — one patient's history in range.
   *
   * history: oldest first, [{ date: 'May 4, 2026', scores: { communication,
   * social, cognitive, motor }, overallScore }], every score the stored 0–100
   * value or null. The comparison is the one the progression table already
   * uses: the latest stored score minus the first, in points on the same
   * 0–100 scale. A missing score on either end is said to be missing, never
   * compared.
   */
  function formatDevelopmentProgressInterpretation(name, history) {
    const who = name || 'This patient';
    const list = Array.isArray(history) ? history : [];
    if (!list.length) {
      return `${who} has no recorded assessment in the selected period.`;
    }
    if (list.length === 1) {
      return `${who} has one recorded assessment in the selected period (${list[0].date}). There is insufficient historical data to determine a trend; at least two assessments are needed for a comparison.`;
    }

    const first = list[0];
    const latest = list[list.length - 1];
    let text = `Comparing ${who}'s first assessment in the selected period (${first.date}) with the latest (${latest.date}), out of ${list.length} recorded assessments. `;

    const missing = [];
    for (const key of DOMAIN_KEYS) {
      const a = first.scores ? first.scores[key] : null;
      const b = latest.scores ? latest.scores[key] : null;
      const label = DOMAIN_LABELS[key];
      if (a == null || b == null) missing.push(label);
      else if (b > a) text += `The recorded ${label} score increased from ${a} to ${b} (+${b - a} pts). `;
      else if (b < a) text += `The recorded ${label} score decreased from ${a} to ${b} (${b - a} pts). `;
      else text += `The recorded ${label} score remained unchanged at ${a}. `;
    }
    if (missing.length) {
      text += `${formatList(missing)} could not be compared because a score is missing from one of the two assessments. `;
    }

    const oa = first.overallScore;
    const ob = latest.overallScore;
    if (oa != null && ob != null) {
      text += ob === oa
        ? `The overall assessment score remained at ${oa}%. `
        : `The overall assessment score ${ob > oa ? 'increased' : 'decreased'} from ${oa}% to ${ob}%. `;
    }
    if (list.length > 2) {
      text += 'Assessments in between are shown in the chart and table and may not follow the same direction. ';
    }
    text += 'Score changes describe recorded assessment results only; they are not a diagnosis and do not show that a child has recovered. Assessment results support monitoring and do not replace professional clinical evaluation.';
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
    INTERVAL_WORDS,
    formatDayLabel,
    chooseActivityInterval,
    buildActivitySeries,
    formatActivityTrendInterpretation,
    formatDevelopmentProgressInterpretation,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCPediaReportsInterpretations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
