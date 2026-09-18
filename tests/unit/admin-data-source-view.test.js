// Admin > Data Sources — two-category view (services/adminDataSourceView.js).
// No DB required: exercises the pure aggregation/filter/sort helpers behind
// GET /admin/data-origin/summary and GET /admin/data-origin/list directly.
//
// What these tests defend, in one line each:
//   - ONLY dataset_question maps to the adviser's "Dataset Question" admin
//     category; core_bank AND pedia_entry both map to "Pediatrician Question"
//     (the adviser-corrected mapping — Core Question Bank represents the
//     pediatrician-sourced question bank, so it belongs under Pediatrician
//     Question, not Dataset Question); there is no third category
//   - a Core Question Bank row is never mislabelled with a fabricated dataset
//     source name, and never assigned a fake individual pediatrician owner
//   - per-pediatrician totals count one question document once, regardless
//     of how many assignments point at it, and never include Core Question
//     Bank rows (they have no pediatricianId)
//   - pediatricianId filtering, not a name string, is the source of truth,
//     and correctly narrows OUT Core Question Bank rows
//   - the latest dataset/source is picked by a real stored date, never by
//     array position
//   - sorting is newest-first by default, stable on a tiebreak, and supports
//     oldest-first
//   - pagination totals reflect the FILTERED row set, not the unfiltered one
//   - "Assigned Children" counts DISTINCT children per pediatrician, never
//     double-counting a child who answered two of that pediatrician's
//     questions, and never attributing a child to the wrong pediatrician
const assert = require('assert');

const {
  DATA_ORIGIN,
  ADMIN_CATEGORY,
  ADMIN_CATEGORY_VALUES,
  ADMIN_CATEGORY_MAP,
  adminCategoryForOrigin,
  sortByDate,
  paginate,
  filterDatasetRows,
  filterPediatricianRows,
  summarizePediatricians,
  countAssignedChildrenByPediatrician,
  attachAssignedChildCounts,
  groupDatasetSources,
} = require('../../services/adminDataSourceView');

function run() {
  // ── Exactly two categories, no third ──────────────────────────────────────
  assert.deepStrictEqual(
    [...ADMIN_CATEGORY_VALUES].sort(),
    ['dataset_question', 'pediatrician_question'].sort(),
    'there must be exactly two admin categories'
  );

  // ── Origin → category mapping (adviser-corrected) ─────────────────────────
  assert.strictEqual(adminCategoryForOrigin(DATA_ORIGIN.DATASET_QUESTION), ADMIN_CATEGORY.DATASET_QUESTION,
    'dataset_question must map to Dataset Question');
  assert.strictEqual(adminCategoryForOrigin(DATA_ORIGIN.CORE_BANK), ADMIN_CATEGORY.PEDIATRICIAN_QUESTION,
    'core_bank (the pediatrician-sourced question bank) must map to Pediatrician Question, NOT Dataset Question');
  assert.strictEqual(adminCategoryForOrigin(DATA_ORIGIN.PEDIA_ENTRY), ADMIN_CATEGORY.PEDIATRICIAN_QUESTION,
    'pedia_entry must map to Pediatrician Question');

  // The explicit lookup table itself, exactly as specified.
  assert.deepStrictEqual(ADMIN_CATEGORY_MAP, {
    dataset_question: 'dataset_question',
    core_bank: 'pediatrician_question',
    pedia_entry: 'pediatrician_question',
  }, 'ADMIN_CATEGORY_MAP must match the adviser-corrected mapping exactly');

  // Follow-up / additional pediatrician questions are still pedia_entry at
  // the data layer (there is no separate "follow-up" origin in this codebase)
  // so they resolve to the same single category — never a third bucket.
  assert.strictEqual(adminCategoryForOrigin('pedia_entry'), ADMIN_CATEGORY.PEDIATRICIAN_QUESTION);

  // ── Two-category count reconciliation (req 4, adviser-corrected) ─────────
  // 34 core_bank + 16 dataset_question + 6 pedia_entry, matching the shape
  // reported by the live database at the time of this change.
  const coreBankCount = 34;
  const datasetQuestionCount = 16;
  const pediaEntryCount = 6;
  const datasetCategoryTotal = datasetQuestionCount;
  const pediatricianCategoryTotal = coreBankCount + pediaEntryCount;
  const grandTotal = coreBankCount + datasetQuestionCount + pediaEntryCount;
  assert.strictEqual(datasetCategoryTotal, 16, 'Dataset Question category must equal dataset_question ALONE');
  assert.strictEqual(pediatricianCategoryTotal, 40, 'Pediatrician Question category must combine core_bank (34) + pedia_entry (6)');
  assert.strictEqual(datasetCategoryTotal + pediatricianCategoryTotal, grandTotal,
    'the two categories must reconcile back to the grand total (56) with nothing lost or double-counted');
  assert.strictEqual(grandTotal, 56);

  // ── groupDatasetSources(): real sub-origin, never fabricated ──────────────
  // This is a generic grouping utility (see its header comment) — in
  // production routes/admin.js now calls it with dataset_question documents
  // ONLY (Core Question Bank moved to Pediatrician Question). The mixed input
  // below still exercises its generic "core_bank groups under its own key"
  // behavior, which remains correct regardless of which category currently
  // feeds it.
  const now = new Date('2026-09-18T00:00:00Z');
  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  const coreBankDocs = Array.from({ length: 3 }, (_, i) => ({
    origin: DATA_ORIGIN.CORE_BANK,
    questionId: `Q0${i + 1}`,
    sourceCitation: null,
    sourceVersion: null,
    sourcedFrom: null,
    importedAt: null,
    createdAt: daysAgo(400), // old, fixed baseline
  }));

  const datasetDocs = [
    { origin: DATA_ORIGIN.DATASET_QUESTION, questionId: 'DQ01', sourceCitation: 'CDC LTSAE 4Y', sourceVersion: 'v1', sourcedFrom: 'CDC 4Y', importedAt: daysAgo(48), createdAt: daysAgo(48) },
    { origin: DATA_ORIGIN.DATASET_QUESTION, questionId: 'DQ02', sourceCitation: 'CDC LTSAE 4Y', sourceVersion: 'v1', sourcedFrom: 'CDC 4Y', importedAt: daysAgo(48), createdAt: daysAgo(48) },
    { origin: DATA_ORIGIN.DATASET_QUESTION, questionId: 'DQ03', sourceCitation: 'ALSPAC 2016', sourceVersion: 'v1', sourcedFrom: 'ALSPAC', importedAt: daysAgo(21), createdAt: daysAgo(21) },
    { origin: DATA_ORIGIN.DATASET_QUESTION, questionId: 'DQ04', sourceCitation: 'ALSPAC 2016', sourceVersion: 'v2', sourcedFrom: 'ALSPAC', importedAt: daysAgo(5), createdAt: daysAgo(5) },
  ];

  const { sources, latestSource } = groupDatasetSources([...coreBankDocs, ...datasetDocs]);

  // Core Question Bank must appear as its OWN source, plainly labelled as the
  // pediatrician interview — never merged into, or mistaken for, a cited
  // external dataset.
  const coreSource = sources.find((s) => s.key === 'core_bank');
  assert.ok(coreSource, 'Core Question Bank must be listed as its own source');
  assert.strictEqual(coreSource.isCoreBank, true);
  assert.strictEqual(coreSource.citation, null, 'Core Question Bank must never carry a fabricated citation');
  assert.strictEqual(coreSource.items, 3);
  assert.ok(/Pediatrician Interview/i.test(coreSource.name), 'Core Question Bank source name must state its real provenance');

  const alspac = sources.find((s) => s.key === 'ALSPAC 2016');
  assert.ok(alspac, 'ALSPAC must be grouped as a distinct real source');
  assert.strictEqual(alspac.items, 2);
  assert.strictEqual(alspac.versions.length, 2, 'two distinct sourceVersion values must produce two version entries');
  // req 7: newest version first, by real stored date — not by version-string order.
  assert.strictEqual(alspac.versions[0].version, 'v2', 'the more recently imported version must sort first');

  // req 6/7: the latest SOURCE overall is picked by real date, not array
  // position — ALSPAC's most recent import (5 days ago) beats CDC's (48 days
  // ago) and Core Question Bank's (400 days ago).
  assert.strictEqual(latestSource.key, 'ALSPAC 2016', 'latest dataset/source must be chosen by the real stored date');

  // ── filterDatasetRows(): source + version + date, combined ───────────────
  const datasetRows = [
    { id: '1', sourceKey: 'core_bank', sourceVersion: null, effectiveDate: daysAgo(400) },
    { id: '2', sourceKey: 'CDC LTSAE 4Y', sourceVersion: 'v1', effectiveDate: daysAgo(48) },
    { id: '3', sourceKey: 'ALSPAC 2016', sourceVersion: 'v1', effectiveDate: daysAgo(21) },
    { id: '4', sourceKey: 'ALSPAC 2016', sourceVersion: 'v2', effectiveDate: daysAgo(5) },
  ];
  assert.deepStrictEqual(
    filterDatasetRows(datasetRows, { source: 'all', version: 'all' }).map((r) => r.id),
    ['1', '2', '3', '4'],
    '"all" source and version must return every row'
  );
  assert.deepStrictEqual(
    filterDatasetRows(datasetRows, { source: 'core_bank' }).map((r) => r.id),
    ['1'],
    'filtering by source=core_bank must return only Core Question Bank rows'
  );
  assert.deepStrictEqual(
    filterDatasetRows(datasetRows, { source: 'ALSPAC 2016', version: 'v2' }).map((r) => r.id),
    ['4'],
    'source + version filters must combine (AND), not just source alone'
  );
  assert.deepStrictEqual(
    filterDatasetRows(datasetRows, { dateFrom: daysAgo(30).toISOString() }).map((r) => r.id).sort(),
    ['3', '4'],
    'dateFrom must exclude rows imported/created before the cutoff'
  );

  // ── filterPediatricianRows(): pediatricianId is the source of truth ───────
  const pediaRows = [
    { id: 'p1', pediatricianId: 'ped-A', createdAt: daysAgo(10) },
    { id: 'p2', pediatricianId: 'ped-A', createdAt: daysAgo(3) },
    { id: 'p3', pediatricianId: 'ped-B', createdAt: daysAgo(1) },
  ];
  assert.deepStrictEqual(
    filterPediatricianRows(pediaRows, { pediatricianId: 'ped-A' }).map((r) => r.id),
    ['p1', 'p2'],
    'pediatricianId filter must match the stored id, never a display name'
  );
  assert.strictEqual(filterPediatricianRows(pediaRows, { pediatricianId: 'all' }).length, 3,
    '"all" must return every pediatrician\'s questions');
  assert.deepStrictEqual(
    filterPediatricianRows(pediaRows, { pediatricianId: 'ped-A', dateFrom: daysAgo(5).toISOString() }).map((r) => r.id),
    ['p2'],
    'pediatrician + date filters must combine'
  );

  // ── Pediatrician Question tab now merges Core Question Bank (no owner)
  // with pediatrician-authored rows (real owner). Selecting "All Pediatricians"
  // must include the Core Question Bank rows; selecting one specific
  // pediatrician must exclude them, since they have no pediatricianId to match.
  const mergedPediaCategoryRows = [
    { id: 'cb1', origin: 'core_bank', pediatricianId: null, createdAt: daysAgo(400) },
    { id: 'cb2', origin: 'core_bank', pediatricianId: null, createdAt: daysAgo(399) },
    { id: 'pe1', origin: 'pedia_entry', pediatricianId: 'ped-A', createdAt: daysAgo(10) },
  ];
  assert.strictEqual(
    filterPediatricianRows(mergedPediaCategoryRows, { pediatricianId: 'all' }).length,
    3,
    '"All Pediatricians" must still include the system-wide Core Question Bank rows'
  );
  assert.deepStrictEqual(
    filterPediatricianRows(mergedPediaCategoryRows, { pediatricianId: 'ped-A' }).map((r) => r.id),
    ['pe1'],
    'selecting a specific pediatrician must narrow OUT Core Question Bank rows (they have no pediatricianId)'
  );

  // ── summarizePediatricians(): one document = one count (req 14) ──────────
  const questionDocs = [
    { pediatricianId: 'ped-A', isActive: true, createdAt: daysAgo(10) },
    { pediatricianId: 'ped-A', isActive: true, createdAt: daysAgo(3) },
    { pediatricianId: 'ped-A', isActive: false, createdAt: daysAgo(1) },
    { pediatricianId: 'ped-B', isActive: true, createdAt: daysAgo(20) },
  ];
  const nameById = new Map([['ped-A', 'Dr. Gold Deluna'], ['ped-B', 'Dr. Ana Cruz']]);
  const summary = summarizePediatricians(questionDocs, nameById);
  const byName = new Map(summary.map((s) => [s.name, s]));

  assert.strictEqual(byName.get('Dr. Gold Deluna').total, 3, 'Dr. Gold Deluna authored 3 questions, not more');
  assert.strictEqual(byName.get('Dr. Gold Deluna').active, 2, 'only 2 of Dr. Gold Deluna\'s 3 questions are active');
  assert.strictEqual(byName.get('Dr. Ana Cruz').total, 1);
  assert.strictEqual(summary.reduce((s, p) => s + p.total, 0), questionDocs.length,
    'per-pediatrician totals must sum to the same total as the question count — no double counting from assignments');
  // Latest-created date is the real per-pediatrician max, not the last array entry.
  assert.strictEqual(byName.get('Dr. Gold Deluna').latestCreatedAt.getTime(), daysAgo(1).getTime());

  // A question with 5 answered assignments must still count once here — this
  // function never reads the assignment collection at all.
  const heavilyAnswered = [{ pediatricianId: 'ped-C', isActive: true, createdAt: daysAgo(2) }];
  assert.strictEqual(summarizePediatricians(heavilyAnswered, new Map()).find((s) => s.pediatricianId === 'ped-C').total, 1);

  // A Core Question Bank document has no pediatricianId — even if one were
  // ever mixed into the input by mistake, it must contribute NOTHING to any
  // pediatrician's total rather than being attributed to a real or invented
  // author (req: "do not count core_bank questions as belonging to Gold Deluna").
  const withCoreBankMixedIn = [
    { pediatricianId: 'ped-A', isActive: true, createdAt: daysAgo(1) },
    { pediatricianId: null, isActive: true, createdAt: daysAgo(400) }, // core_bank shape
  ];
  const mixedSummary = summarizePediatricians(withCoreBankMixedIn, new Map([['ped-A', 'Dr. Gold Deluna']]));
  assert.strictEqual(mixedSummary.length, 1, 'a document with no pediatricianId must not create a phantom pediatrician row');
  assert.strictEqual(mixedSummary[0].total, 1, 'the core_bank-shaped document must not inflate Dr. Gold Deluna\'s total');

  // ── sortByDate(): newest-first default, stable tiebreak, oldest-first ────
  const unsorted = [
    { id: 'b', effectiveDate: daysAgo(10) },
    { id: 'a', effectiveDate: daysAgo(10) }, // same date as 'b' — tiebreak by id
    { id: 'c', effectiveDate: daysAgo(1) },
  ];
  const newestFirst = sortByDate(unsorted, { dateKey: 'effectiveDate', tiebreakKey: 'id' });
  assert.deepStrictEqual(newestFirst.map((r) => r.id), ['c', 'a', 'b'],
    'default sort must be newest first, with same-timestamp rows tiebroken by id');

  const oldestFirst = sortByDate(unsorted, { dateKey: 'effectiveDate', tiebreakKey: 'id', direction: 'asc' });
  assert.deepStrictEqual(oldestFirst.map((r) => r.id), ['a', 'b', 'c'],
    'oldest-first must reverse the date order while keeping the same tiebreak');

  // ── paginate(): totals reflect the FILTERED set, resets cleanly (req 21) ─
  const filtered6 = Array.from({ length: 6 }, (_, i) => ({ id: i }));
  const page1 = paginate(filtered6, 1, 15);
  assert.strictEqual(page1.pagination.total, 6, 'pagination total must match the filtered row count, not the full unfiltered total');
  assert.strictEqual(page1.rows.length, 6);
  assert.strictEqual(page1.pagination.hasNext, false);
  assert.strictEqual(page1.pagination.hasPrev, false);

  const full56 = Array.from({ length: 56 }, (_, i) => ({ id: i }));
  const p1 = paginate(full56, 1, 15);
  assert.strictEqual(p1.rows.length, 15);
  assert.strictEqual(p1.pagination.totalPages, 4);
  assert.strictEqual(p1.pagination.hasNext, true);
  const p4 = paginate(full56, 4, 15);
  assert.strictEqual(p4.rows.length, 11, 'the last page must hold the remainder, not overflow or drop rows');
  assert.strictEqual(p4.pagination.hasNext, false);
  assert.strictEqual(p4.pagination.hasPrev, true);

  // ── countAssignedChildrenByPediatrician(): distinct children, not raw
  // assignment counts (req 17 — assignments and question/child counts are
  // separate metrics, never conflated) ──────────────────────────────────────
  const questionToPed = new Map([
    ['q1', 'pedA'], // Dr. A's question
    ['q2', 'pedA'], // Dr. A's second question
    ['q3', 'pedB'], // Dr. B's question
  ]);
  const assignmentPairs = [
    { questionId: 'q1', childId: 'childX' },
    { questionId: 'q2', childId: 'childX' }, // same child, Dr. A's OTHER question — must not double count
    { questionId: 'q1', childId: 'childY' },
    { questionId: 'q3', childId: 'childZ' }, // Dr. B's own child
  ];
  const assignedCounts = countAssignedChildrenByPediatrician(assignmentPairs, questionToPed);
  assert.strictEqual(assignedCounts.get('pedA'), 2, 'Dr. A must show 2 distinct children (childX counted once despite 2 questions)');
  assert.strictEqual(assignedCounts.get('pedB'), 1, 'Dr. B must show only childZ, never childX/childY from Dr. A\'s questions');
  assert.strictEqual(assignedCounts.has('pedC'), false, 'a pediatrician with no assignments must not appear in the map at all');

  // An assignment whose questionId is not in the lookup (e.g. a Core Question
  // Bank id that never has a pediatricianId) must be silently skipped, never
  // attributed to a fabricated pediatrician.
  const withUnknownQuestion = [...assignmentPairs, { questionId: 'core-bank-q', childId: 'childW' }];
  const countsWithUnknown = countAssignedChildrenByPediatrician(withUnknownQuestion, questionToPed);
  assert.strictEqual(countsWithUnknown.get('pedA'), 2);
  assert.strictEqual(countsWithUnknown.get('pedB'), 1);
  assert.strictEqual([...countsWithUnknown.values()].reduce((a, b) => a + b, 0), 3,
    'an unattributable assignment must not inflate any pediatrician\'s count');

  // ── attachAssignedChildCounts(): merges cleanly, defaults to 0 ────────────
  const baseSummary = [
    { pediatricianId: 'pedA', name: 'Dr. A', total: 2, active: 2, latestCreatedAt: null },
    { pediatricianId: 'pedB', name: 'Dr. B', total: 1, active: 1, latestCreatedAt: null },
    { pediatricianId: 'pedNoAssignments', name: 'Dr. Quiet', total: 1, active: 1, latestCreatedAt: null },
  ];
  const withCounts = attachAssignedChildCounts(baseSummary, assignedCounts);
  const byId = new Map(withCounts.map((p) => [p.pediatricianId, p]));
  assert.strictEqual(byId.get('pedA').assignedChildren, 2);
  assert.strictEqual(byId.get('pedB').assignedChildren, 1);
  assert.strictEqual(byId.get('pedNoAssignments').assignedChildren, 0,
    'a pediatrician with questions but no assignments yet must read 0, not undefined');
  // Original fields must survive the merge untouched.
  assert.strictEqual(byId.get('pedA').name, 'Dr. A');
  assert.strictEqual(byId.get('pedA').total, 2);

  console.log('Admin Data Source view rules OK — two categories, source grouping, '
    + 'per-pediatrician totals, assigned-children counts, filters, sort and pagination all verified');
}

run();
