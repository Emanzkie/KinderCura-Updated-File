// js/admin/training-display.js
// ============================================================================
// Pure, no-DB, no-network display helpers for the Admin Training page
// (ADMIN/admin-training.html). They only label and arrange values the server
// already returns — ml/preprocess.py's stored cleaning report and the metrics
// ml/trainer.py recorded on each TrainedModel. Nothing here trains, scores,
// recalculates a metric, or changes which model is active.
//
// Verified definitions this file describes (do not change without changing
// the Python that produces the numbers):
//   ml/trainer.py  — stratified train_test_split (test_size 0.2, or 0.3 below
//                    20 rows; random_state 42); accuracy_score, and
//                    precision/recall/f1 with average="weighted" on the TEST
//                    split only.
//   ml/preprocess.py — duplicates removed first; each later check drops a row
//                    once, under the first reason it fails, so
//                    final = original − duplicates − invalid and the reasons
//                    sum to invalid. valid = original − invalid (duplicates
//                    are still counted as valid). age_months gaps are filled
//                    with the median and the rows are kept.
//
// Dual-mode like js/admin/analytics-interpretations.js: Node (tests) via
// require(), browser via window.KCTrainingDisplay.
// ============================================================================

(function (global) {
  'use strict';

  const CLASS_ORDER = Object.freeze(['Low', 'Medium', 'High']);

  // Reason keys written by ml/preprocess.py reject(); anything else is shown
  // as its own key rather than dropped.
  const REJECTION_LABELS = Object.freeze({
    invalid_or_missing_risk_category: 'Missing or invalid risk category label',
    missing_or_non_numeric_score: 'Missing or non-numeric domain/overall score',
    score_out_of_range_0_100: 'Score outside 0–100',
    age_months_implausible: 'Implausible age (age_months)',
    overall_score_inconsistent_with_domain_scores: 'Overall score inconsistent with the domain scores',
    unrecognized_answer_value: 'Unrecognized question answer value',
  });

  function isCount(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }

  function formatCount(value) {
    return isCount(value) ? value.toLocaleString('en-US') : '—';
  }

  /** A stored 0–1 metric as "69.7%"; '—' when no metric was recorded. */
  function formatFraction(value, digits) {
    return typeof value === 'number' && Number.isFinite(value)
      ? `${(value * 100).toFixed(digits == null ? 1 : digits)}%`
      : '—';
  }

  function rejectionLabel(key) {
    return REJECTION_LABELS[key] || String(key || 'Unspecified reason').replace(/_/g, ' ');
  }

  /** Low, Medium, High first (in that order), then any other class names. */
  function orderedClasses(names) {
    const list = Array.isArray(names) ? names.filter(Boolean) : [];
    const known = CLASS_ORDER.filter((c) => list.includes(c));
    const rest = list.filter((c) => !CLASS_ORDER.includes(c));
    return [...known, ...rest];
  }

  /**
   * Rows for a per-class results table from a TrainedModel's perClassMetrics
   * ({ High: { precision, recall, f1, support }, ... }) and classDistribution
   * ({ Low: 15121, ... } — every row the model was trained and tested on).
   * support is the class's number of TEST rows.
   */
  function perClassRows(perClassMetrics, classDistribution) {
    const metrics = perClassMetrics && typeof perClassMetrics === 'object' ? perClassMetrics : {};
    const dist = classDistribution && typeof classDistribution === 'object' ? classDistribution : {};
    return orderedClasses(Object.keys(metrics)).map((cls) => ({
      cls,
      precision: metrics[cls].precision,
      recall: metrics[cls].recall,
      f1: metrics[cls].f1,
      testRows: isCount(metrics[cls].support) ? metrics[cls].support : null,
      allRows: isCount(dist[cls]) ? dist[cls] : null,
    }));
  }

  /**
   * The cleaning report as labelled, reconciled figures. Every count is read
   * from the stored report; the only arithmetic is the two checks the
   * preprocessing contract guarantees, so a mismatch is surfaced, not hidden.
   */
  function describeCleaning(cleaning) {
    const c = cleaning || {};
    const generated = isCount(c.originalRecords) ? c.originalRecords : null;
    const duplicates = isCount(c.duplicatesRemoved) ? c.duplicatesRemoved : null;
    const invalid = isCount(c.invalidRecords) ? c.invalidRecords : null;
    const final = isCount(c.finalRecords) ? c.finalRecords : null;
    const valid = isCount(c.validRecords) ? c.validRecords : null;

    const reasonsSource = c.rejectionsByReason && typeof c.rejectionsByReason === 'object' ? c.rejectionsByReason : {};
    const reasons = Object.entries(reasonsSource)
      .filter(([, count]) => isCount(count))
      .map(([key, count]) => ({ key, label: rejectionLabel(key), count }))
      .sort((a, b) => b.count - a.count);
    const reasonsTotal = reasons.reduce((sum, r) => sum + r.count, 0);

    const filledSource = c.missingValuesFilled && typeof c.missingValuesFilled === 'object' ? c.missingValuesFilled : {};
    const filled = Object.entries(filledSource)
      .filter(([, info]) => info && isCount(info.filled))
      .map(([column, info]) => ({ column, filled: info.filled, strategy: info.strategy || null, value: info.value ?? null }));

    const allKnown = generated != null && duplicates != null && invalid != null && final != null;
    return {
      generated,
      duplicates,
      invalid,
      valid,
      final,
      reasons,
      reasonsTotal,
      // Only meaningful when reasons were recorded at all.
      reasonsMatchInvalid: reasons.length ? reasonsTotal === invalid : null,
      filled,
      reconciles: allKnown ? generated - duplicates - invalid === final : null,
    };
  }

  const api = {
    CLASS_ORDER,
    REJECTION_LABELS,
    isCount,
    formatCount,
    formatFraction,
    rejectionLabel,
    orderedClasses,
    perClassRows,
    describeCleaning,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.KCTrainingDisplay = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
