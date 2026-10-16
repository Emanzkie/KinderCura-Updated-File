// services/pediaClinicalStatus.js
//
// Pure, DB-free helpers behind the Pediatrician Reports "Clinical Status
// Summary" (routes/pedia-reports.js GET /clinical-status). READ-ONLY: this
// never writes a check-up, never changes a stored status, and never derives a
// status from an assessment score, band, or ML output.
//
// ── Source of the status ───────────────────────────────────────────────────
// PediatricianCheckup.status (models/PediatricianCheckup.js), chosen
// explicitly by the pediatrician on the My Patients check-up form. Only the
// requesting pediatrician's own check-ups are read, the same rule
// routes/checkups.js listCheckupsForChild applies to the check-up timeline.
//
// ── Category mapping (deliberately literal) ────────────────────────────────
// A status is placed in a summary category only when its stored label says
// exactly that:
//   resolved            "Resolved / Ruled Out"  -> resolved
//   needs_attention     "Needs Attention"       -> needs_follow_up
//   monitoring          "Monitoring"            -> monitoring
//   parent_monitoring   "Parent Monitoring"     -> monitoring
// Every other stored status (initial_review, improving, stable, referred) is
// shown as recorded under "other" until a clinical rule for it is confirmed.
// A status this file has never heard of also lands in "other" with its raw
// value, so it is displayed rather than hidden or misfiled.

// Display labels, identical to checkupStatusMeta() in
// js/pedia/pediatrician-patients.js so both pages name a status the same way.
const STATUS_LABELS = Object.freeze({
  initial_review: 'Initial Review',
  monitoring: 'Monitoring',
  improving: 'Improving',
  stable: 'Stable',
  needs_attention: 'Needs Attention',
  referred: 'Referred',
  resolved: 'Resolved / Ruled Out',
  parent_monitoring: 'Parent Monitoring',
});

const CATEGORY_BY_STATUS = Object.freeze({
  resolved: 'resolved',
  needs_attention: 'needs_follow_up',
  monitoring: 'monitoring',
  parent_monitoring: 'monitoring',
});

// Display order of the summary categories.
const CATEGORY_KEYS = Object.freeze(['resolved', 'needs_follow_up', 'monitoring', 'other', 'no_checkup']);

function statusLabel(status) {
  if (status == null || status === '') return null;
  return STATUS_LABELS[status] || String(status);
}

function categoryForStatus(status) {
  return CATEGORY_BY_STATUS[status] || 'other';
}

/** For each category, the labels of the stored statuses mapped to it. */
function categoryStatusLabels() {
  const out = CATEGORY_KEYS.reduce((acc, k) => { acc[k] = []; return acc; }, {});
  for (const [status, label] of Object.entries(STATUS_LABELS)) out[categoryForStatus(status)].push(label);
  return out;
}

function timeOf(value) {
  if (value == null) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * The check-up that sets a patient's current status.
 *
 * Ordered newest first by checkupDate, then createdAt — the same order the
 * check-up timeline uses (routes/checkups.js listCheckupsForChild), so the
 * record this summary reports is the one My Patients badges "LATEST".
 *
 * Never picks arbitrarily:
 *   - a record without a valid checkupDate cannot be placed in time and is
 *     not eligible; if no record is eligible the result is ambiguous;
 *   - if the newest records tie on BOTH checkupDate and createdAt (or the tie
 *     cannot be broken because createdAt is missing) and their statuses
 *     differ, the result is ambiguous rather than whichever came back first.
 *
 * Returns { latest, ambiguous, reason, recordCount, undatedCount }.
 */
function selectLatestCheckup(records) {
  const list = Array.isArray(records) ? records : [];
  const dated = list.filter((r) => timeOf(r.checkupDate) != null);
  const base = { recordCount: list.length, undatedCount: list.length - dated.length };

  if (!list.length) return { latest: null, ambiguous: false, reason: null, ...base };
  if (!dated.length) return { latest: null, ambiguous: true, reason: 'no_valid_date', ...base };

  const sorted = dated.slice().sort((a, b) => {
    const byDate = timeOf(b.checkupDate) - timeOf(a.checkupDate);
    if (byDate) return byDate;
    return (timeOf(b.createdAt) ?? -Infinity) - (timeOf(a.createdAt) ?? -Infinity);
  });

  const top = sorted[0];
  const topDate = timeOf(top.checkupDate);
  const topCreated = timeOf(top.createdAt);
  const tied = sorted.filter((r) => timeOf(r.checkupDate) === topDate
    && (topCreated == null || timeOf(r.createdAt) == null || timeOf(r.createdAt) === topCreated));
  if (tied.length > 1 && new Set(tied.map((r) => r.status)).size > 1) {
    return { latest: null, ambiguous: true, reason: 'same_timestamp', ...base };
  }
  return { latest: top, ambiguous: false, reason: null, ...base };
}

/**
 * One summary row per patient in scope, plus per-category counts computed from
 * those same rows (so a count can never disagree with the list beside it).
 *
 * patients: [{ childId, name, latestAssessmentAt, latestOverallBand }]
 * checkups: the requesting pediatrician's PediatricianCheckup records for
 *           those patients (any order).
 */
function buildClinicalStatusSummary(patients, checkups) {
  const byChild = new Map();
  for (const c of Array.isArray(checkups) ? checkups : []) {
    const key = String(c.childId);
    if (!byChild.has(key)) byChild.set(key, []);
    byChild.get(key).push(c);
  }

  const rows = (Array.isArray(patients) ? patients : []).map((p) => {
    const pick = selectLatestCheckup(byChild.get(String(p.childId)) || []);
    const latest = pick.latest;
    let category;
    if (pick.recordCount === 0) category = 'no_checkup';
    else if (pick.ambiguous) category = 'other';
    else category = categoryForStatus(latest.status);

    const next = latest ? timeOf(latest.nextFollowUpDate) : null;
    const recommendation = latest && typeof latest.recommendations === 'string'
      ? latest.recommendations.trim() : '';

    return {
      childId: String(p.childId),
      name: p.name,
      category,
      status: latest ? latest.status : null,
      statusLabel: latest ? statusLabel(latest.status) : null,
      ambiguity: pick.ambiguous ? pick.reason : null,
      checkupCount: pick.recordCount,
      undatedCheckups: pick.undatedCount,
      latestCheckupDate: latest ? new Date(latest.checkupDate).toISOString() : null,
      nextFollowUpDate: next != null ? new Date(next).toISOString() : null,
      latestRecommendation: recommendation ? recommendation.slice(0, 500) : null,
      latestAssessmentAt: p.latestAssessmentAt || null,
      latestOverallBand: p.latestOverallBand || null,
    };
  });

  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const counts = CATEGORY_KEYS.reduce((acc, k) => { acc[k] = 0; return acc; }, {});
  for (const r of rows) counts[r.category] += 1;

  return { total: rows.length, counts, patients: rows };
}

module.exports = {
  STATUS_LABELS,
  CATEGORY_BY_STATUS,
  CATEGORY_KEYS,
  statusLabel,
  categoryForStatus,
  categoryStatusLabels,
  selectLatestCheckup,
  buildClinicalStatusSummary,
};
