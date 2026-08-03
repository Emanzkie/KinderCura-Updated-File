// scripts/migrate-rename-pedia-collections.js
// One-time migration for the PediaCustomQuestion rename.
//
//   customquestions            → pedia_custom_questions
//   customquestionassignments  → pedia_custom_question_assignments
//
// Why this is needed: models/PediaCustomQuestion.js and
// models/PediaCustomQuestionAssignment.js now point at the new collection
// names. Until this runs, the app cannot see the existing records.
//
// Safety properties:
// - _id values are preserved exactly. The assignments reference questions by
//   _id, so regenerating them would break the link. Verified after migrating.
// - Prefers renameCollection (atomic). Falls back to copy-then-drop, which
//   verifies the copy BEFORE dropping the source — never the other way round.
// - Idempotent: re-running after success exits cleanly.
// - Aborts loudly on any count mismatch rather than continuing.
// - Does NOT touch the Counter documents (_id 'custom_questions' seq 39 and
//   'custom_question_assignments' seq 33). Those keep numeric id continuity.
//
// Usage:
//   node scripts/migrate-rename-pedia-collections.js --dry-run
//   node scripts/migrate-rename-pedia-collections.js
require('dotenv').config();

const { connectDB, mongoose } = require('../db');

// Verified against the live `kindercura` Atlas DB on 2026-08-03.
// The migration aborts if reality disagrees with these numbers.
const MIGRATIONS = [
  { from: 'customquestions', to: 'pedia_custom_questions', expected: 3 },
  { from: 'customquestionassignments', to: 'pedia_custom_question_assignments', expected: 3 },
];

function isDryRun() {
  return process.argv.includes('--dry-run');
}

async function collectionExists(db, name) {
  const found = await db.listCollections({ name }).toArray();
  return found.length > 0;
}

async function countOf(db, name) {
  if (!(await collectionExists(db, name))) return null;
  return db.collection(name).countDocuments();
}

/**
 * Copy-then-drop fallback for tiers/roles where renameCollection is blocked.
 * Inserts the raw documents (including _id) and only drops the source once the
 * destination count matches exactly.
 */
async function copyThenDrop(db, from, to, dryRun) {
  const docs = await db.collection(from).find({}).toArray();
  console.log(`    read ${docs.length} document(s) from ${from}`);

  if (dryRun) {
    console.log(`    [dry-run] would insert ${docs.length} into ${to}, verify, then drop ${from}`);
    return docs.length;
  }

  if (docs.length) {
    // ordered:false so one duplicate cannot silently halt the rest.
    await db.collection(to).insertMany(docs, { ordered: false });
  }

  const copied = await db.collection(to).countDocuments();
  if (copied !== docs.length) {
    throw new Error(
      `Copy verification FAILED for ${from} → ${to}: expected ${docs.length}, found ${copied}. ` +
      `Source has NOT been dropped — nothing is lost. Investigate before retrying.`
    );
  }

  console.log(`    verified ${copied} document(s) in ${to} — safe to drop source`);
  await db.collection(from).drop();
  console.log(`    dropped ${from}`);
  return copied;
}

async function migrateOne(db, { from, to, expected }, dryRun) {
  console.log(`\n${from} → ${to}`);

  const fromExists = await collectionExists(db, from);
  const toExists = await collectionExists(db, to);
  const fromCount = fromExists ? await db.collection(from).countDocuments() : null;
  const toCount = toExists ? await db.collection(to).countDocuments() : null;

  console.log(`  before: ${from}=${fromExists ? fromCount : 'ABSENT'}  ${to}=${toExists ? toCount : 'ABSENT'}`);

  // Already migrated — the idempotent exit.
  if (!fromExists && toExists) {
    console.log(`  ✓ already migrated (source absent, target present with ${toCount}) — nothing to do`);
    return { skipped: true, finalCount: toCount };
  }

  if (!fromExists && !toExists) {
    console.log('  ⚠ neither collection exists — nothing to migrate');
    return { skipped: true, finalCount: 0 };
  }

  // Source still present. Refuse to merge into a target that holds data.
  if (toExists && toCount > 0) {
    throw new Error(
      `Both ${from} (${fromCount}) and ${to} (${toCount}) contain documents. ` +
      `Refusing to merge — this needs a human decision. Nothing has been changed.`
    );
  }

  if (fromCount !== expected) {
    throw new Error(
      `${from} holds ${fromCount} document(s) but ${expected} was expected. ` +
      `Aborting so an unexpected data state is never migrated silently.`
    );
  }

  // Target exists but is empty (mongoose autoIndex created it). Drop the empty
  // shell so renameCollection has a clear destination.
  if (toExists && toCount === 0) {
    if (dryRun) {
      console.log(`    [dry-run] would drop empty ${to} to clear the rename target`);
    } else {
      await db.collection(to).drop();
      console.log(`    dropped empty ${to} (index shell created by mongoose)`);
    }
  }

  let finalCount;
  try {
    if (dryRun) {
      console.log(`    [dry-run] would renameCollection ${from} → ${to}`);
      finalCount = fromCount;
    } else {
      await db.admin().command({
        renameCollection: `${db.databaseName}.${from}`,
        to: `${db.databaseName}.${to}`,
      });
      finalCount = await db.collection(to).countDocuments();
      console.log(`    renameCollection succeeded (${finalCount} document(s))`);
    }
  } catch (err) {
    console.log(`    renameCollection unavailable (${err.codeName || err.message.slice(0, 60)})`);
    console.log('    falling back to copy-then-drop');
    finalCount = await copyThenDrop(db, from, to, dryRun);
  }

  return { skipped: false, finalCount };
}

/**
 * The whole point of preserving _id: every assignment must still resolve to a
 * question. Checked against the migrated collections, not the originals.
 */
async function verifyReferentialIntegrity(db, dryRun) {
  if (dryRun) {
    console.log('\n[dry-run] skipping referential integrity check');
    return;
  }

  const assignments = await db.collection('pedia_custom_question_assignments').find({}).toArray();
  const questionIds = new Set(
    (await db.collection('pedia_custom_questions').find({}).project({ _id: 1 }).toArray()).map((q) => String(q._id))
  );

  const broken = assignments.filter((a) => !questionIds.has(String(a.questionId)));
  console.log('\nReferential integrity');
  console.log(`  assignments            : ${assignments.length}`);
  console.log(`  questions              : ${questionIds.size}`);
  console.log(`  assignments resolving  : ${assignments.length - broken.length}`);

  if (broken.length) {
    throw new Error(
      `${broken.length} assignment(s) no longer resolve to a question: ` +
      broken.map((b) => `id=${b.id} questionId=${b.questionId}`).join('; ')
    );
  }
  console.log('  ✓ every assignment still resolves to its question by _id');
}

async function run() {
  const dryRun = isDryRun();
  if (dryRun) console.log('DRY RUN — no writes will be made.');

  await connectDB();
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);

  const results = [];
  for (const m of MIGRATIONS) {
    results.push({ ...m, ...(await migrateOne(db, m, dryRun)) });
  }

  console.log('\nAfter');
  for (const m of MIGRATIONS) {
    const fromCount = await countOf(db, m.from);
    const toCount = await countOf(db, m.to);
    console.log(`  ${m.from.padEnd(28)} ${fromCount === null ? 'ABSENT (expected)' : fromCount}`);
    console.log(`  ${m.to.padEnd(28)} ${toCount === null ? 'ABSENT' : toCount}`);
  }

  if (!dryRun) {
    const mismatches = results.filter((r) => r.finalCount !== r.expected);
    if (mismatches.length) {
      throw new Error(
        'Post-migration count mismatch:\n' +
        mismatches.map((r) => `  ${r.to}: got ${r.finalCount}, expected ${r.expected}`).join('\n')
      );
    }
    console.log('\n✓ Post-migration counts match expectations (3 and 3).');
  }

  await verifyReferentialIntegrity(db, dryRun);

  console.log('\nCounter documents left untouched by design:');
  const counters = await db.collection('counters')
    .find({ _id: { $in: ['custom_questions', 'custom_question_assignments'] } }).toArray();
  counters.forEach((c) => console.log(`  ${c._id} = ${c.seq}`));

  if (dryRun) console.log('\nDRY RUN — nothing was written.');
}

run()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Migration aborted:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
