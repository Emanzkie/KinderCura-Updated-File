// scripts/backfill-answer-origin.js
// Sets `origin` (and `sourceQuestionRef`) on assessment_answers documents that
// predate the field.
//
// SCOPE: this script writes to assessment_answers ONLY. It never touches
// pedia_custom_question_assignments — those documents have no `origin` field by
// design. A pediatrician question's origin is implicit in which collection it
// lives in, and its answer is stored on the assignment document itself
// (answer / answeredAt), so it never enters assessment_answers at all.
//
// Classification, per document (never per questionId — see below):
//   1. questionId matches a CoreBankQuestion.questionId   → core_bank
//   2. else exact questionText match against the core bank → core_bank
//   3. else questionId matches a PediaCustomQuestion       → pedia_entry
//   4. else                                                → LEFT UNSET, listed
//
// Why per document: ids 1–5 each have two documents — one carrying real
// question text and one with blank questionText. Same id, different content, so
// any per-id rule is wrong in both directions.
//
// Why step 3 is a safety net rather than the main path: in this schema no
// pediatrician answer can reach assessment_answers. The check exists so that if
// that assumption is ever wrong, the script labels the document correctly
// instead of silently calling it core_bank.
//
// Unclassifiable documents are LISTED, never guessed. Leaving origin unset
// keeps them visibly unclassified rather than silently mislabelled.
//
// Usage:
//   node scripts/backfill-answer-origin.js --dry-run
//   node scripts/backfill-answer-origin.js
require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const PediaCustomQuestion = require('../models/PediaCustomQuestion');
const { DATA_ORIGIN } = require('../constants/dataOrigin');

// Origin values written by earlier revisions of this feature, before
// 'dataset' was renamed to 'core_bank'. Documents saved by the app between the
// schema change and the rename carry the old value. The enum rejects it on new
// writes, but stored documents are not retroactively corrected — so the
// backfill has to reclassify them alongside the never-set ones.
const LEGACY_ORIGIN_VALUES = ['dataset'];

function isDryRun() {
  return process.argv.includes('--dry-run');
}

function norm(value) {
  return String(value ?? '').trim();
}

async function run() {
  const dryRun = isDryRun();
  if (dryRun) console.log('DRY RUN — no writes will be made.\n');

  await connectDB();

  // ---- Load the core bank into lookup maps -------------------------------
  const bank = await CoreBankQuestion.find({}).select('questionId text').lean();
  if (bank.length === 0) {
    throw new Error('core_bank_questions is empty. Run scripts/seed-core-bank-questions.js first.');
  }
  const byQuestionId = new Map(bank.map((q) => [q.questionId, q]));
  const byText = new Map();
  for (const q of bank) {
    // If two questions ever shared text, prefer the lowest id deterministically
    // rather than whichever happened to load last.
    const key = norm(q.text);
    if (!byText.has(key) || q.questionId < byText.get(key).questionId) byText.set(key, q);
  }
  console.log(`Core bank loaded: ${bank.length} questions, ${byText.size} distinct texts`);

  // ---- Safety net: pedia question identifiers ----------------------------
  const pediaQs = await PediaCustomQuestion.find({}).select('_id id questionText').lean();
  const pediaByObjectId = new Set(pediaQs.map((q) => String(q._id)));
  const pediaByNumericId = new Map(pediaQs.filter((q) => q.id != null).map((q) => [String(q.id), q]));
  console.log(`Pedia questions loaded: ${pediaQs.length} (safety-net matching only)`);

  // ---- Target set --------------------------------------------------------
  const total = await AssessmentAnswer.countDocuments();
  // $in: [null, ''] deliberately, NOT { sourceQuestionRef: '' }. The latter only
  // matches documents where the field is literally an empty string; anything
  // written before the field existed has no key at all and would not match.
  // $in with null covers missing, null, and empty in one clause.
  const TARGET_FILTER = {
    $or: [
      { origin: { $exists: false } },
      { origin: null },
      { origin: { $in: LEGACY_ORIGIN_VALUES } },
      { sourceQuestionRef: { $in: [null, ''] } },
    ],
  };
  const targets = await AssessmentAnswer.find(TARGET_FILTER).lean();
  const legacyCount = await AssessmentAnswer.countDocuments({ origin: { $in: LEGACY_ORIGIN_VALUES } });

  console.log(`\nassessment_answers total       : ${total}`);
  console.log(`already correct                : ${total - targets.length}`);
  console.log(`to classify                    : ${targets.length}`);
  console.log(`  of which never set           : ${targets.length - legacyCount}`);
  console.log(`  of which legacy '${LEGACY_ORIGIN_VALUES.join("'/'")}'        : ${legacyCount}`);

  if (targets.length === 0) {
    console.log('\nNothing to backfill — every document already has an origin.');
    return;
  }

  // ---- Classify ----------------------------------------------------------
  const buckets = { byId: [], byText: [], pedia: [], unclassified: [] };

  for (const doc of targets) {
    const qid = norm(doc.questionId);
    const text = norm(doc.questionText);

    const coreById = byQuestionId.get(qid);
    if (coreById) {
      buckets.byId.push({ doc, origin: DATA_ORIGIN.CORE_BANK, ref: coreById.questionId });
      continue;
    }

    const coreByText = text ? byText.get(text) : null;
    if (coreByText) {
      buckets.byText.push({ doc, origin: DATA_ORIGIN.CORE_BANK, ref: coreByText.questionId });
      continue;
    }

    if (pediaByObjectId.has(qid)) {
      buckets.pedia.push({ doc, origin: DATA_ORIGIN.PEDIA_ENTRY, ref: qid });
      continue;
    }
    const pediaNum = pediaByNumericId.get(qid);
    if (pediaNum && norm(pediaNum.questionText) === text && text) {
      buckets.pedia.push({ doc, origin: DATA_ORIGIN.PEDIA_ENTRY, ref: String(pediaNum._id) });
      continue;
    }

    buckets.unclassified.push(doc);
  }

  // ---- Report before writing --------------------------------------------
  console.log('\nClassification');
  console.log(`  core_bank  (questionId match) : ${buckets.byId.length}`);
  console.log(`  core_bank  (exact text match) : ${buckets.byText.length}`);
  console.log(`  pedia_entry                   : ${buckets.pedia.length}`);
  console.log(`  UNCLASSIFIED (left unset)     : ${buckets.unclassified.length}`);

  if (buckets.byText.length) {
    console.log('\n  Resolved by text (legacy ids predating the Qnn scheme):');
    for (const m of buckets.byText) {
      console.log(`    _id=${m.doc._id} questionId="${m.doc.questionId}" → ${m.ref}  "${norm(m.doc.questionText).slice(0, 45)}"`);
    }
  }

  if (buckets.unclassified.length) {
    console.log('\n  UNCLASSIFIED — reported, not guessed:');
    for (const d of buckets.unclassified) {
      console.log(
        `    _id=${d._id} assessmentId=${d.assessmentId} questionId="${d.questionId}" ` +
        `domain="${d.domain}" answer="${d.answer}" questionText=${norm(d.questionText) ? `"${norm(d.questionText).slice(0, 40)}"` : '<blank>'}`
      );
    }
    console.log('    → origin left unset so these stay visibly unclassified.');
  }

  // ---- Write -------------------------------------------------------------
  const writes = [...buckets.byId, ...buckets.byText, ...buckets.pedia];

  if (dryRun) {
    console.log(`\n[dry-run] would update ${writes.length} document(s); ${buckets.unclassified.length} left untouched.`);
    return;
  }

  if (writes.length) {
    const ops = writes.map((w) => ({
      updateOne: {
        filter: { _id: w.doc._id },
        update: { $set: { origin: w.origin, sourceQuestionRef: w.ref } },
      },
    }));
    const result = await AssessmentAnswer.bulkWrite(ops, { ordered: false });
    console.log(`\nWrote ${result.modifiedCount} document(s) (matched ${result.matchedCount}).`);

    if (result.modifiedCount !== writes.length) {
      throw new Error(`Expected to modify ${writes.length} but modified ${result.modifiedCount}.`);
    }
  }

  // ---- Verify ------------------------------------------------------------
  // Group over every distinct origin value actually present, rather than
  // counting the values we expect. That is what caught the legacy 'dataset'
  // documents — a check that only counts known buckets cannot see an unknown one.
  const distribution = await AssessmentAnswer.aggregate([
    { $group: { _id: '$origin', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const withRef = await AssessmentAnswer.countDocuments({ sourceQuestionRef: { $nin: ['', null] } });

  console.log('\nFinal state of assessment_answers');
  let sum = 0;
  for (const row of distribution) {
    const label = row._id == null ? '<unset>' : row._id;
    console.log(`  origin = ${String(label).padEnd(16)} : ${row.count}`);
    sum += row.count;
  }
  console.log(`  sourceQuestionRef set    : ${withRef}`);
  console.log(`  total                    : ${sum} (expected ${total})`);

  const stillUnset = distribution.find((r) => r._id == null)?.count || 0;
  const leftoverLegacy = distribution.filter((r) => LEGACY_ORIGIN_VALUES.includes(r._id));
  const unknownValues = distribution.filter(
    (r) => r._id != null && r._id !== DATA_ORIGIN.CORE_BANK && r._id !== DATA_ORIGIN.PEDIA_ENTRY
  );

  if (sum !== total) {
    throw new Error(`Document counts (${sum}) do not add up to the collection total (${total}).`);
  }
  if (leftoverLegacy.length) {
    throw new Error(`Legacy origin values remain: ${leftoverLegacy.map((r) => `${r._id}=${r.count}`).join(', ')}`);
  }
  if (unknownValues.length) {
    throw new Error(`Unexpected origin values present: ${unknownValues.map((r) => `${r._id}=${r.count}`).join(', ')}`);
  }
  if (stillUnset !== buckets.unclassified.length) {
    throw new Error(`Expected ${buckets.unclassified.length} unset, found ${stillUnset}.`);
  }

  // Assert the declared scope: assignments must have been left alone.
  const assignmentsWithOrigin = await mongoose.connection.db
    .collection('pedia_custom_question_assignments')
    .countDocuments({ origin: { $exists: true } });
  console.log(`\nScope check — pedia_custom_question_assignments with an origin field: ${assignmentsWithOrigin}`);
  if (assignmentsWithOrigin !== 0) {
    throw new Error('Assignment documents unexpectedly carry an origin field.');
  }
  console.log('  ✓ assignment documents untouched, as intended');
}

run()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Backfill failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
