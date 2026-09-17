// js/parent/report-interpretations.js
// Pure, deterministic text-generation helpers for the Parent Progress Report.
//
// These functions turn stored AssessmentResult values into short, factual,
// parent-facing sentences. They do not compute or alter any score — they
// only describe scores that already exist in the /api/parent/children/:id/report
// response (see routes/parent-reports.js). No function here may:
//   - invent a cause for a score ("scored low because...")
//   - call an increase "improvement" (the scoring is rule-based cutoffs, not
//     a validated clinical measure — see constants/scoring.js)
//   - state or imply a diagnosis
//   - recompute a score from raw answers (a second scoring path is exactly
//     how this codebase previously ended up with disagreeing band sets)
//
// Dual-mode like constants/scoring.js: `window.KCReportInterpretations` in
// the browser, `module.exports` in Node (so this file is unit-testable
// without a DOM — see tests/unit/report-interpretations.test.js).
(function (global) {
  'use strict';

  const KCScoring = (typeof module !== 'undefined' && module.exports)
    ? require('../../constants/scoring')
    : (typeof window !== 'undefined' ? window.KCScoring : null);

  const INCOMPLETE_MESSAGE =
    'Scores for this assessment may be incomplete or unavailable, so a detailed interpretation cannot be provided.';

  // How close a domain score has to be to the overall score to be described
  // as "close to" rather than "above"/"below". Not a scoring cutoff — purely
  // a wording threshold for this page's prose.
  const CLOSE_TO_OVERALL_THRESHOLD = 2;

  /** "long" English date, anchored to local time so a date-only value never shifts a day. */
  function formatDate(dateString) {
    if (!dateString) return null;
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  /** Sum of recorded answer counts across a domain list; missing counts treated as 0. */
  function sumAnsweredItems(entry) {
    if (!entry || !Array.isArray(entry.domains)) return 0;
    return entry.domains.reduce((sum, d) => sum + (Number(d.answeredItemCount) || 0), 0);
  }

  /**
   * True when an assessment's stored result cannot be responsibly interpreted:
   * no AssessmentResult document at all, no overall score, or a result document
   * that exists but has zero recorded answers behind it (e.g. an assessment
   * marked complete with nothing actually answered). A domain/overall value of
   * exactly 0 with real recorded answers is NOT incomplete — it is a real score.
   */
  function isEntryDataIncomplete(entry) {
    if (!entry) return true;
    if (!entry.scoresAvailable) return true;
    if (entry.overallScore == null) return true;
    return sumAnsweredItems(entry) === 0;
  }

  /** A single domain reading is unusable for comparison: no score, or a 0 with nothing recorded behind it. */
  function isDomainUnusable(domain) {
    if (!domain || domain.score == null) return true;
    const count = Number(domain.answeredItemCount) || 0;
    return domain.score === 0 && count === 0;
  }

  /** "A" | "A and B" | "A, B, and C" */
  function formatDomainList(labels) {
    const list = (labels || []).filter(Boolean);
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
  }

  /**
   * Describe the numeric change from `previous` to `current` (both 0-100).
   * Deliberately never uses the word "improved"/"improvement" — see file header.
   */
  function pointsDiffText(current, previous) {
    const cur = Math.round(Number(current));
    const prev = Math.round(Number(previous));
    const diff = cur - prev;
    if (diff === 0) {
      return { direction: 'same', points: 0, text: 'stayed the same' };
    }
    if (diff > 0) {
      return { direction: 'increased', points: diff, text: `increased by ${diff} percentage point${diff === 1 ? '' : 's'}` };
    }
    return { direction: 'decreased', points: -diff, text: `decreased by ${-diff} percentage point${-diff === 1 ? '' : 's'}` };
  }

  /**
   * Which domain(s) scored highest/lowest in one assessment, worded as a
   * single sentence. Domains with no usable score are named separately
   * rather than silently dropped, so a parent is told when a comparison
   * could not fully be made instead of seeing an unexplained gap.
   */
  function describeDomainHighlights(domains) {
    const list = Array.isArray(domains) ? domains : [];
    const usable = list.filter((d) => !isDomainUnusable(d));
    const incomplete = list.filter((d) => isDomainUnusable(d));
    const incompleteNote = incomplete.length
      ? ` Score${incomplete.length === 1 ? '' : 's'} for ${formatDomainList(incomplete.map((d) => d.label))} may be incomplete, since no answers were recorded for ${incomplete.length === 1 ? 'that area' : 'those areas'} in this assessment.`
      : '';

    if (usable.length === 0) {
      return {
        text: `Domain scores for this assessment may be incomplete or unavailable, so an area-by-area comparison cannot be provided.`,
        highestLabels: [],
        lowestLabels: [],
        incompleteLabels: incomplete.map((d) => d.label),
      };
    }

    if (usable.length === 1) {
      return {
        text: `${usable[0].label} was the only measured area with a recorded score in this assessment.${incompleteNote}`,
        highestLabels: [usable[0].label],
        lowestLabels: [usable[0].label],
        incompleteLabels: incomplete.map((d) => d.label),
      };
    }

    const scores = usable.map((d) => d.score);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    const highestLabels = usable.filter((d) => d.score === max).map((d) => d.label);
    const lowestLabels = usable.filter((d) => d.score === min).map((d) => d.label);

    let text;
    if (max === min) {
      text = `All measured areas with recorded scores were tied at ${max}% in this assessment.`;
    } else {
      text = `${formatDomainList(highestLabels)} had the highest recorded domain score, while ${formatDomainList(lowestLabels)} had the lowest.`;
    }

    return { text: text + incompleteNote, highestLabels, lowestLabels, incompleteLabels: incomplete.map((d) => d.label) };
  }

  /**
   * One domain's card interpretation — how it compares with the OTHER
   * domains in the same assessment, and with the overall score when the
   * domain is not itself an extreme.
   */
  function getDomainInterpretation(domain, allDomains, overallScore) {
    if (isDomainUnusable(domain)) {
      return `Score for ${domain ? domain.label : 'this area'} may be incomplete or unavailable for this assessment.`;
    }

    const usable = (allDomains || []).filter((d) => !isDomainUnusable(d));
    if (usable.length < 2) {
      return `${domain.label} recorded a score of ${Math.round(domain.score)}% in this assessment.`;
    }

    const max = Math.max(...usable.map((d) => d.score));
    const min = Math.min(...usable.map((d) => d.score));

    if (max === min) {
      return `${domain.label} was tied with the other measured areas at ${max}% in this assessment.`;
    }
    if (domain.score === max) {
      const tied = usable.filter((d) => d.score === max).length > 1;
      return tied
        ? `${domain.label} was tied for the highest recorded score among the measured areas in this assessment.`
        : `${domain.label} had the highest recorded score among the measured areas in this assessment.`;
    }
    if (domain.score === min) {
      const tied = usable.filter((d) => d.score === min).length > 1;
      return tied
        ? `${domain.label} was tied for the lowest recorded score among the measured areas in this assessment.`
        : `${domain.label} had the lowest recorded score among the measured areas in this assessment.`;
    }

    if (overallScore != null) {
      const diff = domain.score - overallScore;
      if (diff > CLOSE_TO_OVERALL_THRESHOLD) return `${domain.label} was above the overall assessment score.`;
      if (diff < -CLOSE_TO_OVERALL_THRESHOLD) return `${domain.label} was below the overall assessment score.`;
      return `${domain.label} was close to the overall score for this assessment.`;
    }
    return `${domain.label} recorded a score of ${Math.round(domain.score)}% in this assessment.`;
  }

  /** The oldest assessment in the report — there is nothing earlier to compare it with. */
  function getBaselineInterpretation(entry) {
    if (isEntryDataIncomplete(entry)) return INCOMPLETE_MESSAGE;
    const overall = Math.round(entry.overallScore);
    const highlights = describeDomainHighlights(entry.domains);
    return `Baseline assessment: this is the earliest completed assessment currently available for this child, so there is no earlier assessment in this report to compare it with. This assessment recorded an overall score of ${overall}%. ${highlights.text}`;
  }

  /**
   * Per-date interpretation for the Assessment History timeline. Always tied
   * to THAT entry's own data and, when one exists, the immediately previous
   * completed assessment — never a generic paragraph reused across dates.
   */
  function getHistoryInterpretation(entry, previousEntry) {
    if (isEntryDataIncomplete(entry)) return INCOMPLETE_MESSAGE;

    const overall = Math.round(entry.overallScore);
    const highlights = describeDomainHighlights(entry.domains);

    if (!previousEntry) return getBaselineInterpretation(entry);

    if (isEntryDataIncomplete(previousEntry)) {
      return `This assessment recorded an overall score of ${overall}%. The previous assessment's scores were incomplete or unavailable, so a comparison could not be made. ${highlights.text}`;
    }

    const prevDateLabel = formatDate(previousEntry.completedAt) || 'the previous assessment';
    const delta = pointsDiffText(entry.overallScore, previousEntry.overallScore);
    return `This assessment recorded an overall score of ${overall}%. Compared with the assessment on ${prevDateLabel}, the overall score ${delta.text}. ${highlights.text}`;
  }

  /**
   * Overall interpretation for the "Most recent assessment" section. Reuses
   * the same domain-highlight logic as the history entries, worded for the
   * single latest result rather than as a comparison.
   */
  function getAssessmentInterpretation(latestEntry) {
    if (isEntryDataIncomplete(latestEntry)) return INCOMPLETE_MESSAGE;

    const overall = Math.round(latestEntry.overallScore);
    const bandLabel = KCScoring ? KCScoring.parentOverallLabel(overall) : null;
    const highlights = describeDomainHighlights(latestEntry.domains);
    const bandClause = bandLabel ? `, within the system's current "${bandLabel}" screening range` : '';
    return `The latest completed assessment had an overall score of ${overall}%${bandClause}. ${highlights.text}`;
  }

  /**
   * Score-over-time narrative. Takes the FULL chronological (oldest-first)
   * entry list, not a pre-filtered one, so it can apply the same "was this
   * actually usable data" check the other helpers use rather than trusting a
   * non-null overallScore alone.
   */
  function getTrendInterpretation(allEntries) {
    const entries = Array.isArray(allEntries) ? allEntries : [];
    const withAnyScore = entries.filter((e) => e && e.overallScore != null);
    const usable = entries.filter((e) => !isEntryDataIncomplete(e));

    if (usable.length < 2) {
      if (usable.length === 0) {
        return 'There are not enough completed assessments with usable scores yet to describe a trend.';
      }
      return 'There is only one completed assessment with a usable score so far, so a trend cannot be described yet. A trend needs at least two completed assessments to compare.';
    }

    const latest = usable[usable.length - 1];
    const previous = usable[usable.length - 2];
    const latestDateLabel = formatDate(latest.completedAt) || 'the most recent assessment';
    const delta = pointsDiffText(latest.overallScore, previous.overallScore);

    let text = `The most recent completed assessment was on ${latestDateLabel}, with an overall score of ${Math.round(latest.overallScore)}%. `
      + `Compared with the previous completed assessment, the overall score ${delta.text} `
      + `(from ${Math.round(previous.overallScore)}% to ${Math.round(latest.overallScore)}%).`;

    if (usable.length >= 3) {
      const scores = usable.map((e) => Math.round(e.overallScore));
      let nonDecreasing = true;
      let nonIncreasing = true;
      for (let i = 1; i < scores.length; i += 1) {
        if (scores[i] < scores[i - 1]) nonDecreasing = false;
        if (scores[i] > scores[i - 1]) nonIncreasing = false;
      }
      if (nonDecreasing && nonIncreasing) {
        text += ` Across all ${scores.length} completed assessments with usable scores, the overall score has stayed at ${scores[0]}% with no change.`;
      } else if (nonDecreasing) {
        text += ` Across all ${scores.length} completed assessments with usable scores, the overall score has generally increased over time, from ${scores[0]}% to ${scores[scores.length - 1]}%.`;
      } else if (nonIncreasing) {
        text += ` Across all ${scores.length} completed assessments with usable scores, the overall score has generally decreased over time, from ${scores[0]}% to ${scores[scores.length - 1]}%.`;
      } else {
        text += ` Across all ${scores.length} completed assessments with usable scores, the overall score has changed over time rather than moving consistently in one direction (${scores.map((s) => `${s}%`).join(', ')}).`;
      }
    }

    const excluded = withAnyScore.length - usable.length;
    if (excluded > 0) {
      text += ` Note: ${excluded} assessment${excluded === 1 ? '' : 's'} in this child's history had incomplete or unavailable scores and ${excluded === 1 ? 'is' : 'are'} not included in this comparison.`;
    }

    text += ' An assessment score is a screening result on its own — it does not by itself explain what may be causing a change.';
    return text;
  }

  /**
   * The earliest entry (list must be oldest-first) that has a documented
   * pediatrician review. Returns null when none of the child's completed
   * assessments have been reviewed yet — callers must not imply a review
   * exists in that case.
   */
  function findInitialReview(entriesOldestFirst) {
    const list = Array.isArray(entriesOldestFirst) ? entriesOldestFirst : [];
    for (const entry of list) {
      if (entry && entry.review && entry.review.pediatricianId) return entry;
    }
    return null;
  }

  const api = {
    formatDate,
    sumAnsweredItems,
    isEntryDataIncomplete,
    isDomainUnusable,
    formatDomainList,
    pointsDiffText,
    describeDomainHighlights,
    getDomainInterpretation,
    getBaselineInterpretation,
    getHistoryInterpretation,
    getAssessmentInterpretation,
    getTrendInterpretation,
    findInitialReview,
    INCOMPLETE_MESSAGE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCReportInterpretations = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
