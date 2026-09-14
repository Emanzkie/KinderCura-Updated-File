// Dataset Question guarantees — schema rules + catalogue integrity.
// No DB required: every check runs through validateSync() or plain data.
//
// What these tests defend, in one line each:
//   - a question can never claim external provenance it does not have
//   - an adaptation can never be stored without saying it is an adaptation
//   - "pending pediatrician approval" is enforced, not decorative
//   - the three origins never merge
const assert = require('assert');

const CoreBankQuestion = require('../../models/CoreBankQuestion');
const {
  DATA_ORIGIN,
  APPROVAL_STATUS,
  GENERATION_METHOD,
} = require('../../constants/dataOrigin');
const {
  DATASET_SOURCES,
  DATASET_QUESTIONS,
  DATASET_REVIEW,
  SCORING_DOMAINS,
  toQuestionDoc,
} = require('../../constants/datasetQuestions');

// Field names that carry a validation error, so a test asserts on the RIGHT
// failure rather than on any failure.
function errorPaths(doc) {
  const err = doc.validateSync();
  return err ? Object.keys(err.errors) : [];
}

function base(extra) {
  return Object.assign({
    questionId: 'TEST01',
    text: 'Does your child do the thing?',
    domain: 'Communication',
    minAgeMonths: 48,
  }, extra);
}

function run() {
  // ── Catalogue shape ───────────────────────────────────────────────────────
  assert.strictEqual(DATASET_QUESTIONS.length, 16, 'expected exactly 16 dataset questions');

  for (const domain of SCORING_DOMAINS) {
    const n = DATASET_QUESTIONS.filter((q) => q.domain === domain).length;
    assert.strictEqual(n, 4, `expected 4 questions in ${domain}, got ${n}`);
  }

  const ids = DATASET_QUESTIONS.map((q) => q.questionId);
  assert.strictEqual(new Set(ids).size, 16, 'dataset question ids must be unique');
  // DQnn, so a dataset question id can never collide with a core-bank Qnn.
  ids.forEach((id) => assert.ok(/^DQ\d{2}$/.test(id), `${id} is not in DQnn form`));

  const texts = DATASET_QUESTIONS.map((q) => q.text.trim().toLowerCase());
  assert.strictEqual(new Set(texts).size, 16, 'dataset question text must be unique');

  // Every question points at a registered source, and every source is real
  // enough to name and version. An uncited item is the failure this origin
  // exists to prevent.
  for (const q of DATASET_QUESTIONS) {
    const src = DATASET_SOURCES[q.sourceKey];
    assert.ok(src, `${q.questionId}: unregistered sourceKey ${q.sourceKey}`);
    assert.ok(src.citation && src.citation.trim().length > 20, `${q.questionId}: citation too thin to check`);
    assert.ok(src.version && src.version.trim(), `${q.questionId}: no source version`);
    assert.ok(src.sourceType && src.sourceType.trim(), `${q.questionId}: source does not say what kind of source it is`);
    assert.ok(q.sourceItemVerbatim && q.sourceItemVerbatim.trim(),
      `${q.questionId}: no verbatim source item recorded — the mapping cannot be checked`);
    assert.ok(q.adaptationNote && q.adaptationNote.trim(),
      `${q.questionId}: no adaptationNote saying how our wording differs from the source`);
    assert.ok(q.sourceConstruct && q.sourceConstruct.trim(), `${q.questionId}: no sourceConstruct to review against`);
    assert.ok(SCORING_DOMAINS.includes(q.domain), `${q.questionId}: ${q.domain} is not a scoring domain`);
    assert.ok(Number.isFinite(q.minAgeMonths), `${q.questionId}: minAgeMonths not a number`);
    // Preschool focus: no infant items.
    assert.ok(q.minAgeMonths >= 36, `${q.questionId}: minAgeMonths ${q.minAgeMonths} is below the preschool range`);
  }

  // ── Reviewer decision record ──────────────────────────────────────────────
  // The completed content-review round. It approves WORDING only — it must
  // never leak into the pediatrician lifecycle or activate anything.
  assert.ok(DATASET_REVIEW && typeof DATASET_REVIEW === 'object', 'DATASET_REVIEW must be exported');
  assert.ok(['approve', 'revise', 'reject'].includes(DATASET_REVIEW.decision),
    'reviewer decision must be one of approve/revise/reject');
  assert.ok(DATASET_REVIEW.round && DATASET_REVIEW.decidedOn, 'reviewer round must be labelled and dated');
  const tally = DATASET_REVIEW.tally || {};
  assert.strictEqual(
    (tally.approved || 0) + (tally.revise || 0) + (tally.rejected || 0) + (tally.unmarked || 0),
    DATASET_QUESTIONS.length,
    'reviewer tally must account for every catalogue question',
  );
  for (const id of [...DATASET_REVIEW.revisedItems, ...DATASET_REVIEW.openMappingItems]) {
    assert.ok(ids.includes(id), `DATASET_REVIEW references unknown question id ${id}`);
  }
  // req 8: DQ09's open clinical mapping question must stay flagged for the
  // pediatrician even though its wording was approved.
  assert.ok(DATASET_REVIEW.openMappingItems.includes('DQ09'),
    'DQ09 must remain flagged with an open clinical mapping question');
  // req 9: DQ12's screen-time exclusion stays in the question text, verbatim.
  const dq12 = DATASET_QUESTIONS.find((q) => q.questionId === 'DQ12');
  assert.ok(/\(Do not count time spent on a phone, tablet, or TV\.\)$/.test(dq12.text.trim()),
    'DQ12 screen-time exclusion must stay in the question text exactly as written');
  // req 1 / req 6 / req 7: a reviewer "approve" changes nothing about the
  // stored lifecycle — every question is still a pending, inactive candidate.
  for (const q of DATASET_QUESTIONS) {
    const doc = toQuestionDoc(q);
    assert.strictEqual(doc.approvalStatus, APPROVAL_STATUS.PENDING,
      `${q.questionId}: reviewer approval must not change approvalStatus`);
    assert.strictEqual(doc.isActive, false, `${q.questionId}: reviewer approval must not activate`);
    assert.strictEqual(doc.approvedBy, null, `${q.questionId}: no pediatrician approver yet`);
    assert.strictEqual(doc.approvedAt, null, `${q.questionId}: no pediatrician approval date yet`);
  }

  // ── Wording rules ─────────────────────────────────────────────────────────

  // THE GUARD THAT MATTERS MOST.
  //
  // A question labelled "AI-generated adaptation" must not actually be the
  // source's own item text with a few words swapped. This is not hypothetical:
  // the first draft of DQ14 read "hold a crayon or pencil between their fingers
  // and thumb rather than in a fist", which is the CDC item verbatim except for
  // "not a fist" -> "rather than in a fist". That is a copied item wearing an
  // adaptation label, and it is exactly the misrepresentation this whole origin
  // exists to prevent.
  //
  // So: measure our wording against the source's, and fail when they are too
  // close to be called an adaptation. Content words only — every item shares
  // "does your child", which says nothing about copying.
  const WORDING_STOP = new Set(['does', 'do', 'can', 'is', 'are', 'has', 'have', 'your', 'child',
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'for', 'it', 'its',
    'they', 'their', 'them', 'he', 'she', 'his', 'her', 'when', 'that', 'this', 'as', 'such',
    'like', 'you', 'not', 'without', 'than', 'rather', 'instead', 'from', 'into', 'onto', 'by',
    'be', 'been', 'but', 'if', 'so', 'up', 'out', 'about', 'over', 'one', 'other', 'others']);

  const contentWords = (t) => new Set(String(t).toLowerCase().replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 2 && !WORDING_STOP.has(w)));

  function overlap(ours, theirs) {
    const A = contentWords(ours), B = contentWords(theirs);
    if (!A.size || !B.size) return 0;
    const inter = [...A].filter((w) => B.has(w)).length;
    return inter / new Set([...A, ...B]).size;
  }

  // ALSPAC entries append a locator — "(Appendix Table A4, item 30, ...)" —
  // to the quoted item. Those words are ours, not the source's, and leaving
  // them in inflates the union and quietly makes the guard more permissive for
  // exactly the items whose source text is shortest. Strip before comparing.
  const sourceTextOnly = (s) => String(s).replace(/\((?:Appendix|see)[^)]*\)\s*$/i, '').trim();

  // 0.55 is deliberately permissive — a short source item ("Counts to 10")
  // leaves little room to differ, so this catches copying, not paraphrase.
  const NEAR_VERBATIM = 0.55;
  for (const q of DATASET_QUESTIONS) {
    const sim = overlap(q.text, sourceTextOnly(q.sourceItemVerbatim));
    assert.ok(sim < NEAR_VERBATIM,
      `${q.questionId}: wording is ${sim.toFixed(2)} similar to the source item — too close to call an `
      + `AI-generated adaptation.\n    ours:   ${q.text}\n    source: ${q.sourceItemVerbatim}`);
  }


  // A frequency qualifier inside the stem collides with the Yes / Sometimes /
  // No answer scale — "sometimes catches it most of the time" has no reading.
  // Frequency belongs in the answer. Note this deliberately diverges from
  // source items that carry their own qualifier (see DQ13).
  const EMBEDDED_FREQUENCY = /\b(most of the time|usually|often|always|sometimes|occasionally|rarely|never)\b/i;
  for (const q of DATASET_QUESTIONS) {
    const hit = q.text.match(EMBEDDED_FREQUENCY);
    assert.ok(!hit, `${q.questionId}: stem embeds the frequency "${hit && hit[0]}" — it belongs in the answer, not the question`);
  }

  // Parent-report items describe OBSERVABLE BEHAVIOUR. They must never ask a
  // parent to label or diagnose their child.
  const DIAGNOSTIC_LANGUAGE = /\b(diagnos\w*|disorder|delay(ed|s)?|autis\w*|adhd|abnormal|impair\w*|deficit|syndrome|disab\w*)\b/i;
  for (const q of DATASET_QUESTIONS) {
    const hit = q.text.match(DIAGNOSTIC_LANGUAGE);
    assert.ok(!hit, `${q.questionId}: uses diagnostic language "${hit && hit[0]}" — parents must not be asked to diagnose`);
  }

  // Every question must be answerable on the existing scale, so each one is
  // phrased as a closed question about a behaviour.
  for (const q of DATASET_QUESTIONS) {
    // A trailing parenthetical is allowed AFTER the question mark — DQ12
    // carries the source's screen-time exclusion that way, as an instruction
    // to the parent rather than part of the question being asked.
    //
    // ⚠ THIS GUARD WAS DELIBERATELY WEAKENED ON 2026-08-28, AND THE WEAKENING
    // APPLIES TO EVERY QUESTION, NOT JUST DQ12.
    //
    // It previously required the text to end at "?" and nothing else. It now
    // accepts anything inside a single trailing "( ... )". So a stem that
    // trails off after the question mark — a second question, an unfinished
    // clause, a stray note — passes here where it used to fail. Only the
    // parenthesis balance is checked; the contents are not.
    //
    // If you are adding a question: this test will NOT catch a malformed stem
    // of that shape. Read the wording yourself. If a future item needs a
    // trailing parenthetical for a different reason, that is a signal the rule
    // deserves re-tightening (e.g. an explicit allow-list of ids), not another
    // widening. Kept loose on purpose so the relaxation stays visible rather
    // than being buried in a more permissive regex.
    assert.ok(/\?(\s*\([^)]*\))?$/.test(q.text.trim()), `${q.questionId}: not phrased as a question`);
    assert.ok(/^(does|can|is|has|do)\b/i.test(q.text.trim()),
      `${q.questionId}: not a closed question — may not fit the Yes/Sometimes/No scale`);
  }

  // ── toQuestionDoc(): candidates, never live questions ─────────────────────
  for (const q of DATASET_QUESTIONS) {
    const doc = toQuestionDoc(q);
    assert.strictEqual(doc.origin, DATA_ORIGIN.DATASET_QUESTION, `${q.questionId}: wrong origin`);
    assert.strictEqual(doc.approvalStatus, APPROVAL_STATUS.PENDING, `${q.questionId}: not pending`);
    assert.strictEqual(doc.generationMethod, GENERATION_METHOD.AI_ADAPTATION, `${q.questionId}: wrong generationMethod`);
    assert.strictEqual(doc.isActive, false, `${q.questionId}: created active`);
    assert.strictEqual(doc.approvedBy, null, `${q.questionId}: carries an approver it never had`);
    assert.strictEqual(doc.approvedAt, null, `${q.questionId}: carries an approval date it never had`);
    assert.ok(doc.sourceCitation && doc.sourceVersion, `${q.questionId}: provenance not filled`);

    // And the real thing: it must actually pass the schema.
    assert.deepStrictEqual(errorPaths(new CoreBankQuestion(doc)), [], `${q.questionId}: fails schema validation`);
  }

  // A malformed sourceKey must throw rather than produce an uncited row.
  assert.throws(
    () => toQuestionDoc({ questionId: 'DQ99', sourceKey: 'NOT_A_SOURCE' }),
    /unknown sourceKey/,
    'toQuestionDoc must refuse to build a question with no registered source'
  );

  // ── Schema: provenance is a claim the data must back up ───────────────────

  // dataset_question with no citation → rejected.
  assert.ok(
    errorPaths(new CoreBankQuestion(base({
      origin: DATA_ORIGIN.DATASET_QUESTION,
      approvalStatus: APPROVAL_STATUS.PENDING,
      generationMethod: GENERATION_METHOD.AI_ADAPTATION,
      isActive: false,
    }))).includes('origin'),
    'a dataset_question without a sourceCitation must be rejected'
  );

  // core_bank with a citation → rejected (it would really be a dataset question).
  assert.ok(
    errorPaths(new CoreBankQuestion(base({
      origin: DATA_ORIGIN.CORE_BANK,
      sourceCitation: 'Some external instrument, 2019',
    }))).includes('origin'),
    'a core_bank question must not carry a sourceCitation'
  );

  // ── Schema: the review lifecycle is enforced ──────────────────────────────
  const citedFields = {
    origin: DATA_ORIGIN.DATASET_QUESTION,
    sourceCitation: DATASET_SOURCES.CDC_LTSAE_4Y.citation,
    sourceVersion: DATASET_SOURCES.CDC_LTSAE_4Y.version,
  };

  // No approvalStatus → rejected. A dataset question is a candidate by nature.
  assert.ok(
    errorPaths(new CoreBankQuestion(base(Object.assign({}, citedFields, {
      generationMethod: GENERATION_METHOD.AI_ADAPTATION,
      isActive: false,
    })))).includes('approvalStatus'),
    'a dataset_question must record an approvalStatus'
  );

  // No generationMethod → rejected, so an adaptation is never mistakable for
  // the source instrument's own item text.
  assert.ok(
    errorPaths(new CoreBankQuestion(base(Object.assign({}, citedFields, {
      approvalStatus: APPROVAL_STATUS.PENDING,
      isActive: false,
    })))).includes('generationMethod'),
    'a dataset_question must record how its wording was produced'
  );

  // THE important one: pending + active → rejected. This is what makes
  // "pending pediatrician approval" mean the question cannot reach a parent.
  assert.ok(
    errorPaths(new CoreBankQuestion(base(Object.assign({}, citedFields, {
      approvalStatus: APPROVAL_STATUS.PENDING,
      generationMethod: GENERATION_METHOD.AI_ADAPTATION,
      isActive: true,
    })))).includes('isActive'),
    'a pending dataset_question must not be activatable'
  );

  // Rejected + active → also refused.
  assert.ok(
    errorPaths(new CoreBankQuestion(base(Object.assign({}, citedFields, {
      approvalStatus: APPROVAL_STATUS.REJECTED,
      generationMethod: GENERATION_METHOD.AI_ADAPTATION,
      isActive: true,
    })))).includes('isActive'),
    'a rejected dataset_question must not be activatable'
  );

  // Approved + active → allowed. The gate opens only after a real review.
  assert.deepStrictEqual(
    errorPaths(new CoreBankQuestion(base(Object.assign({}, citedFields, {
      approvalStatus: APPROVAL_STATUS.APPROVED,
      generationMethod: GENERATION_METHOD.AI_ADAPTATION,
      isActive: true,
    })))),
    [],
    'an approved dataset_question must be activatable'
  );

  // ── Schema: the workflow does not leak onto the other origins ─────────────
  // A core_bank row must not be stamped with a review that never happened.
  assert.ok(
    errorPaths(new CoreBankQuestion(base({
      origin: DATA_ORIGIN.CORE_BANK,
      approvalStatus: APPROVAL_STATUS.APPROVED,
    }))).includes('approvalStatus'),
    'a core_bank question must not carry an approvalStatus'
  );

  assert.ok(
    errorPaths(new CoreBankQuestion(base({
      origin: DATA_ORIGIN.CORE_BANK,
      generationMethod: GENERATION_METHOD.AI_ADAPTATION,
    }))).includes('generationMethod'),
    'a core_bank question must not carry a generationMethod'
  );

  // An untouched core_bank row — the shape all 34 existing rows have — still
  // validates cleanly. The new fields must not break historical records.
  assert.deepStrictEqual(
    errorPaths(new CoreBankQuestion(base({ origin: DATA_ORIGIN.CORE_BANK }))),
    [],
    'existing core_bank rows must still validate'
  );

  console.log(`Dataset Question rules OK — ${DATASET_QUESTIONS.length} candidates, `
    + `${Object.keys(DATASET_SOURCES).length} cited sources, approval gate enforced`);
}

run();
