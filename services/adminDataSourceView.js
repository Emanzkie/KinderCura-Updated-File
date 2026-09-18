// services/adminDataSourceView.js
//
// Pure, DB-free helpers behind the Admin > Data Sources "Questions by Data
// Source" panel (routes/admin.js GET /data-origin/summary and /data-origin/list,
// rendered by ADMIN/admin-data-sources.html + js/admin/admin-data-sources.js).
//
// ── Why this file exists, and what it is NOT allowed to do ──────────────────
// The KinderCura clinical adviser requires the Admin UI to show exactly TWO
// question categories — never three:
//
//   Dataset Question       — the actual dataset-derived origin, ONLY
//   Pediatrician Question  — the pediatrician-sourced question bank AND
//                            pediatrician-authored questions
//
// constants/dataOrigin.js defines THREE real origins — core_bank,
// dataset_question, pedia_entry — and says, in its own header and in
// tests/unit/dataset-questions.test.js, that they must NEVER be merged AT THE
// DATA LAYER. That rule is unchanged and this module still never touches
// `origin`, never writes to the database, and never fabricates a
// sourceCitation or a pediatricianId.
//
// The ADVISER-CORRECTED admin-facing mapping (superseding an earlier, wrong
// mapping that grouped core_bank under Dataset Question):
//
//   ADMIN_CATEGORY.DATASET_QUESTION      ← origin dataset_question ONLY
//   ADMIN_CATEGORY.PEDIATRICIAN_QUESTION ← origin core_bank OR pedia_entry
//
// Reasoning: for this Admin module, Core Question Bank represents the
// PEDIATRICIAN-SOURCED question bank (it came from our consultant
// pediatrician's interview — see constants/dataOrigin.js), so it belongs
// under Pediatrician Question, not Dataset Question. This does NOT mean every
// core_bank row gets a pediatricianId — it stays a system-wide question with
// no individual owner, and routes/admin.js labels it honestly as such
// ("Core Question Bank — Pediatrician-Sourced, system-wide") rather than
// assigning it to any real or invented pediatrician. The Pediatrician owner
// FILTER still only matches real pediatricianId values from PediaCustomQuestion
// — selecting a specific pediatrician narrows OUT the system-wide Core
// Question Bank rows, exactly as it should.
//
// dataset_question is unaffected: it still requires a checkable sourceCitation
// (models/CoreBankQuestion.js refuses to save one without it) and still goes
// through the pediatrician review workflow. Nothing here changes assessment
// scoring, AssessmentAnswer/AssessmentResult, question activation, or that
// review workflow.

const DATA_ORIGIN = Object.freeze({
  CORE_BANK: 'core_bank',
  DATASET_QUESTION: 'dataset_question',
  PEDIA_ENTRY: 'pedia_entry',
});

const ADMIN_CATEGORY = Object.freeze({
  DATASET_QUESTION: 'dataset_question',
  PEDIATRICIAN_QUESTION: 'pediatrician_question',
});

const ADMIN_CATEGORY_LABELS = Object.freeze({
  [ADMIN_CATEGORY.DATASET_QUESTION]: 'Dataset Question',
  [ADMIN_CATEGORY.PEDIATRICIAN_QUESTION]: 'Pediatrician Question',
});

const ADMIN_CATEGORY_VALUES = Object.freeze([
  ADMIN_CATEGORY.DATASET_QUESTION,
  ADMIN_CATEGORY.PEDIATRICIAN_QUESTION,
]);

// The one place this mapping is decided — the adviser-corrected version.
// Only dataset_question maps to Dataset Question; core_bank and pedia_entry
// both map to Pediatrician Question. Written as an explicit lookup table
// (not an if/else) so the mapping itself is inspectable and testable.
const ADMIN_CATEGORY_MAP = Object.freeze({
  [DATA_ORIGIN.DATASET_QUESTION]: ADMIN_CATEGORY.DATASET_QUESTION,
  [DATA_ORIGIN.CORE_BANK]: ADMIN_CATEGORY.PEDIATRICIAN_QUESTION,
  [DATA_ORIGIN.PEDIA_ENTRY]: ADMIN_CATEGORY.PEDIATRICIAN_QUESTION,
});

function adminCategoryForOrigin(origin) {
  return ADMIN_CATEGORY_MAP[origin] || ADMIN_CATEGORY.PEDIATRICIAN_QUESTION;
}

// Newest-first by default, with a stable secondary key so pagination can
// never repeat or skip a row when two share a timestamp (req 22).
function sortByDate(rows, { dateKey, tiebreakKey, direction = 'desc' } = {}) {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const diff = (new Date(a[dateKey] || 0).getTime() - new Date(b[dateKey] || 0).getTime()) * sign;
    if (diff !== 0) return diff;
    return String(a[tiebreakKey]).localeCompare(String(b[tiebreakKey]));
  });
}

function paginate(rows, page, limit) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || 20);
  const total = rows.length;
  const start = (safePage - 1) * safeLimit;
  return {
    rows: rows.slice(start, start + safeLimit),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      hasNext: start + safeLimit < total,
      hasPrev: safePage > 1,
    },
  };
}

// Dataset Question tab filters. Dataset Question now holds ONLY the
// dataset_question origin (Core Question Bank moved to Pediatrician Question
// — see the header comment), so `source` always matches a row's real
// sourceCitation. Never matched against a display name string, so a citation
// with special characters cannot accidentally under- or over-match.
function filterDatasetRows(rows, { source, version, dateFrom, dateTo } = {}) {
  return rows.filter((r) => {
    if (source && source !== 'all' && r.sourceKey !== source) return false;
    if (version && version !== 'all' && (r.sourceVersion || '') !== version) return false;
    if (dateFrom && new Date(r.effectiveDate || 0) < new Date(dateFrom)) return false;
    if (dateTo && new Date(r.effectiveDate || 0) > new Date(dateTo)) return false;
    return true;
  });
}

// Pediatrician Question tab filters. `pediatricianId` is matched against the
// stored ObjectId (req 10) — never against the displayed name string, so a
// pediatrician who changes their profile name still resolves correctly.
function filterPediatricianRows(rows, { pediatricianId, dateFrom, dateTo } = {}) {
  return rows.filter((r) => {
    if (pediatricianId && pediatricianId !== 'all' && String(r.pediatricianId) !== String(pediatricianId)) return false;
    if (dateFrom && new Date(r.createdAt || 0) < new Date(dateFrom)) return false;
    if (dateTo && new Date(r.createdAt || 0) > new Date(dateTo)) return false;
    return true;
  });
}

// Per-pediatrician totals (req 11 / req 14). Only ever called with
// PediaCustomQuestion documents — Core Question Bank rows have no
// pediatricianId and must never be attributed to a real or invented
// pediatrician here (the `if (!q.pediatricianId) continue` guard below is
// what enforces that even if a core_bank doc were ever passed in by mistake).
// One question document counts once, no matter how many
// PediaCustomQuestionAssignment rows point at it — answered-count is a
// separate metric computed elsewhere from the assignment collection, never
// folded into this total.
function summarizePediatricians(questionDocs, nameById) {
  const byId = new Map();
  for (const q of questionDocs) {
    if (!q.pediatricianId) continue;
    const id = String(q.pediatricianId);
    const entry = byId.get(id) || {
      pediatricianId: id,
      name: (nameById && nameById.get(id)) || 'Unknown Pediatrician',
      total: 0,
      active: 0,
      latestCreatedAt: null,
    };
    entry.total += 1;
    if (q.isActive !== false) entry.active += 1;
    if (q.createdAt && (!entry.latestCreatedAt || new Date(q.createdAt) > new Date(entry.latestCreatedAt))) {
      entry.latestCreatedAt = q.createdAt;
    }
    byId.set(id, entry);
  }
  return [...byId.values()].sort((a, b) => b.total - a.total);
}

// Groups documents by their REAL source and nests distinct sourceVersion
// values underneath. Sources and versions are both returned newest-first by
// a real stored date (importedAt, falling back to createdAt — never array
// position, an ObjectId, or a hardcoded label; req 6/7).
//
// In production this is called with dataset_question documents ONLY (the
// Dataset Question tab no longer includes Core Question Bank — see the
// header comment), so every row it sees normally carries a real
// sourceCitation. The `isCore`/'core_bank' branch below is a generic
// fallback for a document with no origin distinction assumed by the caller;
// it is not exercised by the current admin routes but is kept because this
// function makes no assumption about which collection its input came from.
function groupDatasetSources(docs) {
  const bySource = new Map();
  for (const d of docs) {
    const isCore = d.origin === DATA_ORIGIN.CORE_BANK;
    const key = isCore ? 'core_bank' : (d.sourceCitation || 'unknown_source');
    const effectiveDate = d.importedAt || d.createdAt || null;

    const src = bySource.get(key) || {
      key,
      isCoreBank: isCore,
      name: isCore ? 'Core Question Bank — Pediatrician Interview' : (d.sourcedFrom || d.sourceCitation || 'Unknown source'),
      citation: isCore ? null : (d.sourceCitation || null),
      items: 0,
      latestDate: null,
      versions: new Map(),
    };
    src.items += 1;
    if (effectiveDate && (!src.latestDate || new Date(effectiveDate) > new Date(src.latestDate))) {
      src.latestDate = effectiveDate;
    }

    const versionKey = d.sourceVersion || '';
    const vEntry = src.versions.get(versionKey) || { version: d.sourceVersion || null, items: 0, latestDate: null };
    vEntry.items += 1;
    if (effectiveDate && (!vEntry.latestDate || new Date(effectiveDate) > new Date(vEntry.latestDate))) {
      vEntry.latestDate = effectiveDate;
    }
    src.versions.set(versionKey, vEntry);

    bySource.set(key, src);
  }

  const sources = [...bySource.values()]
    .map((s) => ({
      ...s,
      versions: [...s.versions.values()].sort((a, b) => new Date(b.latestDate || 0) - new Date(a.latestDate || 0)),
    }))
    .sort((a, b) => new Date(b.latestDate || 0) - new Date(a.latestDate || 0));

  return {
    sources,
    latestSource: sources[0] || null,
  };
}

module.exports = {
  DATA_ORIGIN,
  ADMIN_CATEGORY,
  ADMIN_CATEGORY_LABELS,
  ADMIN_CATEGORY_VALUES,
  ADMIN_CATEGORY_MAP,
  adminCategoryForOrigin,
  sortByDate,
  paginate,
  filterDatasetRows,
  filterPediatricianRows,
  summarizePediatricians,
  groupDatasetSources,
};
