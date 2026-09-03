// scripts/seed-dataset-questions.js
// Seeds the Dataset Question candidates (origin = dataset_question) from
// constants/datasetQuestions.js into core_bank_questions.
//
// Scope, stated as a promise this script keeps:
//   - It only ever touches rows whose questionId is in the catalogue AND whose
//     stored origin is dataset_question. A core_bank or pedia_entry row is
//     never read for writing, never updated and never deleted.
//   - If a catalogue questionId collides with an existing non-dataset row, the
//     run ABORTS before writing anything rather than overwriting it.
//   - Every row is created PENDING and isActive:false. The model refuses to
//     activate an unapproved dataset question, so this script cannot put a
//     question in front of a parent even by mistake.
//   - It writes questions only. No answers, no assessments, no ML rows.
//
// Idempotent: upserts by questionId, via .save() so every schema validator
// (citation required, approval required, activation gate) actually runs.
//
// Usage:
//   node scripts/seed-dataset-questions.js --dry-run
//   node scripts/seed-dataset-questions.js
//   node scripts/seed-dataset-questions.js --verify-only
require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const { DATA_ORIGIN, APPROVAL_STATUS, GENERATION_METHOD } = require('../constants/dataOrigin');
const {
  DATASET_SOURCES,
  DATASET_QUESTIONS,
  SCORING_DOMAINS,
  toQuestionDoc,
} = require('../constants/datasetQuestions');

// Content fields re-synced on a re-run. Deliberately excludes approvalStatus,
// approvedBy, approvedAt and isActive: once a pediatrician has reviewed a
// question, re-running the seed must not undo that decision or silently
// re-activate/deactivate it.
const SYNCED_FIELDS = [
  'text', 'domain', 'displayDomain', 'minAgeMonths',
  'sourceCitation', 'sourceVersion', 'sourcedFrom', 'generationMethod',
];

const isDryRun = () => process.argv.includes('--dry-run');
const isVerifyOnly = () => process.argv.includes('--verify-only');

/**
 * Reject a malformed catalogue before touching the database. A half-seeded
 * batch of provenance records is worse than none, because the admin page then
 * reports a source that was never checked.
 */
function validateCatalogue() {
  const problems = [];
  const seen = new Set();

  DATASET_QUESTIONS.forEach((q, i) => {
    const at = `DATASET_QUESTIONS[${i}] (${q.questionId})`;
    if (!/^DQ\d{2}$/.test(String(q.questionId || ''))) {
      problems.push(`${at}: questionId is not in DQnn form`);
    }
    if (seen.has(q.questionId)) problems.push(`${at}: duplicate questionId`);
    seen.add(q.questionId);

    if (!String(q.text || '').trim()) problems.push(`${at}: empty text`);
    if (!SCORING_DOMAINS.includes(q.domain)) {
      problems.push(`${at}: domain "${q.domain}" is not a scoring bucket — answers would never be scored`);
    }
    if (!Number.isFinite(q.minAgeMonths)) problems.push(`${at}: minAgeMonths is not a number`);

    // The whole point of this origin: no verifiable source, no question.
    const source = DATASET_SOURCES[q.sourceKey];
    if (!source) problems.push(`${at}: sourceKey "${q.sourceKey}" is not a registered external source`);
    else {
      if (!String(source.citation || '').trim()) problems.push(`${at}: source ${q.sourceKey} has no citation`);
      if (!String(source.version || '').trim()) problems.push(`${at}: source ${q.sourceKey} has no version`);
    }
    if (!String(q.sourceConstruct || '').trim()) {
      problems.push(`${at}: no sourceConstruct recorded — a reviewer could not check the adaptation`);
    }
  });

  // Four domains, evenly covered. A lopsided set would quietly bias whichever
  // domain got extra items.
  for (const domain of SCORING_DOMAINS) {
    const n = DATASET_QUESTIONS.filter((q) => q.domain === domain).length;
    if (n !== 4) problems.push(`domain "${domain}" has ${n} question(s); expected 4`);
  }
  if (DATASET_QUESTIONS.length !== 16) {
    problems.push(`catalogue has ${DATASET_QUESTIONS.length} question(s); expected 16`);
  }

  if (problems.length) {
    throw new Error(`Dataset question catalogue failed validation:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Refuse to run if a catalogue id already belongs to a row of a different
 * origin. Upserting over it would rewrite a core-bank or legacy question as a
 * dataset question — exactly the origin merge this whole design forbids.
 */
async function assertNoOriginCollision() {
  const ids = DATASET_QUESTIONS.map((q) => q.questionId);
  const clashes = await CoreBankQuestion.find({
    questionId: { $in: ids },
    origin: { $ne: DATA_ORIGIN.DATASET_QUESTION },
  }).select('questionId origin').lean();

  if (clashes.length) {
    throw new Error(
      'Refusing to seed: these questionIds already exist under a different origin — '
      + clashes.map((c) => `${c.questionId} (origin=${c.origin || 'unset'})`).join(', ')
    );
  }
}

async function verify() {
  console.log('\n' + '='.repeat(66));
  console.log('DATASET QUESTION VERIFICATION');
  console.log('='.repeat(66));

  const docs = await CoreBankQuestion.find({ origin: DATA_ORIGIN.DATASET_QUESTION }).lean();
  const failures = [];
  const ok = (cond) => (cond ? '✓' : '✗ FAIL');

  const countOk = docs.length === DATASET_QUESTIONS.length;
  if (!countOk) failures.push(`dataset_question rows ${docs.length} != catalogue ${DATASET_QUESTIONS.length}`);
  console.log(`  dataset_question rows        : ${docs.length} (expected ${DATASET_QUESTIONS.length})  ${ok(countOk)}`);

  for (const domain of SCORING_DOMAINS) {
    const n = docs.filter((d) => d.domain === domain).length;
    if (n !== 4) failures.push(`${domain}: ${n} row(s), expected 4`);
    console.log(`    ${domain.padEnd(15)}          : ${n} (expected 4)  ${ok(n === 4)}`);
  }

  const noCitation = docs.filter((d) => !String(d.sourceCitation || '').trim()).map((d) => d.questionId);
  const noVersion = docs.filter((d) => !String(d.sourceVersion || '').trim()).map((d) => d.questionId);
  const wrongGen = docs.filter((d) => d.generationMethod !== GENERATION_METHOD.AI_ADAPTATION).map((d) => d.questionId);
  const notPending = docs.filter((d) => d.approvalStatus !== APPROVAL_STATUS.PENDING).map((d) => d.questionId);
  const active = docs.filter((d) => d.isActive === true).map((d) => d.questionId);
  const preApproved = docs.filter((d) => d.approvedBy || d.approvedAt).map((d) => d.questionId);

  if (noCitation.length) failures.push(`missing sourceCitation: ${noCitation.join(',')}`);
  if (noVersion.length) failures.push(`missing sourceVersion: ${noVersion.join(',')}`);
  if (wrongGen.length) failures.push(`generationMethod not ai_generated_adaptation: ${wrongGen.join(',')}`);
  if (notPending.length) failures.push(`approvalStatus not pending: ${notPending.join(',')}`);
  if (active.length) failures.push(`ACTIVE without approval: ${active.join(',')}`);
  if (preApproved.length) failures.push(`carries a review stamp but was never reviewed: ${preApproved.join(',')}`);

  console.log(`  sourceCitation set           : ${docs.length - noCitation.length}/${docs.length}  ${ok(!noCitation.length)}`);
  console.log(`  sourceVersion set            : ${docs.length - noVersion.length}/${docs.length}  ${ok(!noVersion.length)}`);
  console.log(`  generationMethod = adaptation: ${docs.length - wrongGen.length}/${docs.length}  ${ok(!wrongGen.length)}`);
  console.log(`  approvalStatus = pending     : ${docs.length - notPending.length}/${docs.length}  ${ok(!notPending.length)}`);
  console.log(`  isActive = false (not live)  : ${docs.length - active.length}/${docs.length}  ${ok(!active.length)}`);
  console.log(`  no approval stamp            : ${docs.length - preApproved.length}/${docs.length}  ${ok(!preApproved.length)}`);

  // The other two origins must be exactly as we found them.
  const coreCount = await CoreBankQuestion.countDocuments({ origin: DATA_ORIGIN.CORE_BANK });
  const coreWithCitation = await CoreBankQuestion.countDocuments({
    origin: DATA_ORIGIN.CORE_BANK,
    sourceCitation: { $nin: [null, ''] },
  });
  const coreWithApproval = await CoreBankQuestion.countDocuments({
    origin: DATA_ORIGIN.CORE_BANK,
    approvalStatus: { $ne: null },
  });
  if (coreWithCitation) failures.push(`${coreWithCitation} core_bank row(s) gained a sourceCitation`);
  if (coreWithApproval) failures.push(`${coreWithApproval} core_bank row(s) gained an approvalStatus`);
  console.log(`\n  core_bank rows untouched     : ${coreCount} rows, ${coreWithCitation} with citation, `
    + `${coreWithApproval} with approvalStatus  ${ok(!coreWithCitation && !coreWithApproval)}`);

  console.log('\n  Per-question:');
  for (const d of [...docs].sort((a, b) => a.questionId.localeCompare(b.questionId))) {
    console.log(`    ${d.questionId}  ${String(d.domain).padEnd(14)} ${String(d.sourcedFrom).padEnd(42)} `
      + `${d.approvalStatus}  active=${d.isActive}`);
  }

  console.log('\n' + '-'.repeat(66));
  if (failures.length) {
    console.log(`RESULT: ✗ ${failures.length} failure(s)`);
    failures.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('RESULT: ✓ 16 Dataset Questions, all cited, all pending review, none active.');
  }
  console.log('-'.repeat(66));
  return failures.length;
}

async function run() {
  const dryRun = isDryRun();
  const verifyOnly = isVerifyOnly();

  validateCatalogue();
  console.log(`Catalogue OK: ${DATASET_QUESTIONS.length} dataset questions across `
    + `${SCORING_DOMAINS.length} domains, ${Object.keys(DATASET_SOURCES).length} external sources.`);
  for (const key of Object.keys(DATASET_SOURCES)) {
    const s = DATASET_SOURCES[key];
    const n = DATASET_QUESTIONS.filter((q) => q.sourceKey === key).length;
    console.log(`  ${String(n).padStart(2)} × ${s.shortName}  [${s.version}]`);
  }
  if (dryRun) console.log('\nDRY RUN — no writes will be made.');

  await connectDB();
  await assertNoOriginCollision();

  // One batch id per run, so this import can be traced or reversed as a unit:
  //   db.core_bank_questions.deleteMany({ importBatchId: '<id>' })
  const importedAt = new Date();
  const importBatchId = `dataset-questions-${importedAt.toISOString().replace(/[:.]/g, '-')}`;

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const detail = [];

  for (const entry of (verifyOnly ? [] : DATASET_QUESTIONS)) {
    const next = toQuestionDoc(entry, { importBatchId, importedAt });

    // Scoped to dataset_question — assertNoOriginCollision() has already proved
    // no other origin holds this id, and this keeps that true at write time.
    const existing = await CoreBankQuestion.findOne({
      questionId: next.questionId,
      origin: DATA_ORIGIN.DATASET_QUESTION,
    });

    if (!existing) {
      if (!dryRun) await new CoreBankQuestion(next).save();
      inserted += 1;
      detail.push(`+ ${next.questionId}  ${next.domain}`);
      continue;
    }

    const changed = SYNCED_FIELDS.filter((f) => String(existing[f] ?? '') !== String(next[f] ?? ''));
    if (!changed.length) {
      skipped += 1;
      continue;
    }
    // Content only. The review decision on this row is left exactly as it is.
    for (const f of changed) existing[f] = next[f];
    if (!dryRun) await existing.save();
    updated += 1;
    detail.push(`~ ${next.questionId}  ${changed.join(', ')}`);
  }

  console.log(verifyOnly ? '\nSeed summary (verify-only: no writes attempted)' : '\nSeed summary');
  console.log(`  inserted : ${inserted}`);
  console.log(`  updated  : ${updated}   (content only; approval decisions preserved)`);
  console.log(`  skipped  : ${skipped}   (already identical)`);
  if (detail.length) console.log(`     ${detail.join('\n     ')}`);
  if (!dryRun && inserted) console.log(`  batch id : ${importBatchId}`);

  if (!dryRun) {
    const failures = await verify();
    if (failures > 0) throw new Error(`${failures} verification failure(s) — see the report above.`);
  }

  if (dryRun) console.log('\nDRY RUN — nothing was written.');
  console.log(
    '\nThese 16 questions are CANDIDATES pending pediatrician review. They are not\n'
    + 'active and are not shown to any parent: the parent screening flow renders the\n'
    + 'hardcoded DOCTOR_QUESTION_BANK in js/parent/screening.js and does not read this\n'
    + 'collection. The model refuses to activate a dataset question until its\n'
    + 'approvalStatus is "approved".'
  );
}

run()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Dataset question seed failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
