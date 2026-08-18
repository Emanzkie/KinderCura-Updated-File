// scripts/migrate-custom-question-domains.js
// ============================================================================
// One-off migration: rewrites PediaCustomQuestion.domain from the old Custom-
// Question-only vocabulary (Gross Motor / Fine Motor / Language /
// Personal-Social / Other) to the four OFFICIAL assessment scoring domains
// (Communication / Social Skills / Cognitive / Motor Skills) — see
// constants/assessmentDomains.js for the mapping and the reasoning.
//
// WHY THIS IS NEEDED
// -------------------
// routes/assessments.js scores a reassessment into exactly those four domain
// buckets. A Custom Question saved under the old vocabulary can never match
// one of those buckets, so it silently never contributes to a domain score.
// The application code (models/PediaCustomQuestion.js pre-validate hook, and
// the normalizeDomain() calls in routes/custom-questions.js and
// routes/assessments.js) now normalizes on every read and every future save,
// so this script is not required for correctness going forward — but
// existing documents in the database still carry the old strings at rest
// until they're either re-saved through the app or migrated here directly.
//
// SAFETY
// ------
//   * --dry-run is the DEFAULT. Nothing is written without an explicit --apply.
//   * With --apply, every affected document is dumped to backups/ BEFORE any
//     write, and the run aborts if that dump cannot be written or verified.
//   * Idempotent: a document already holding one of the four official domain
//     strings is left untouched, so re-running is a no-op.
//   * Only the `domain` field is touched. Nothing else on the document
//     (questionText, options, assignments, etc.) is read or modified.
//
// USAGE
//   node scripts/migrate-custom-question-domains.js              # dry run (default)
//   node scripts/migrate-custom-question-domains.js --dry-run    # explicit dry run
//   node scripts/migrate-custom-question-domains.js --apply      # writes
// ============================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const PediaCustomQuestion = require('../models/PediaCustomQuestion');
const { ASSESSMENT_DOMAINS, normalizeDomain } = require('../constants/assessmentDomains');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const dryRunFlag = argv.includes('--dry-run');
  if (apply && dryRunFlag) {
    console.error('Refusing to run: --apply and --dry-run are mutually exclusive.');
    process.exit(1);
  }
  return { apply, dryRun: !apply };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function main() {
  const { apply, dryRun } = parseArgs(process.argv.slice(2));
  const mode = apply ? 'APPLY (writes)' : 'DRY RUN (no writes)';

  console.log('='.repeat(70));
  console.log('  KinderCura — custom question domain migration');
  console.log('  Mode:', mode);
  console.log('  Target domains:', ASSESSMENT_DOMAINS.join(', '));
  console.log('='.repeat(70));

  if (!process.env.MONGODB_URI) {
    console.error('\nMONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  // Read via the raw collection (not the Mongoose model) so this script sees
  // the domain string exactly as stored, unaffected by the model's own
  // pre('validate') normalization hook.
  const all = await mongoose.connection.collection('pedia_custom_questions').find({}).toArray();
  const total = all.length;

  const plans = [];
  const perLegacyValue = {};
  for (const doc of all) {
    const before = doc.domain;
    const after = normalizeDomain(before);
    if (before === after) continue;
    plans.push({ id: doc._id, before, after });
    const key = typeof before === 'string' && before.trim() ? before : '(blank/missing)';
    perLegacyValue[key] = (perLegacyValue[key] || 0) + 1;
  }

  console.log(`\nExamined ${total} custom question document(s).`);
  console.log(`  already an official domain: ${total - plans.length} (skipped)`);
  console.log(`  to migrate                : ${plans.length}\n`);

  if (plans.length) {
    console.log('Breakdown by legacy value:');
    for (const [value, count] of Object.entries(perLegacyValue)) {
      const mapped = normalizeDomain(value === '(blank/missing)' ? '' : value);
      console.log(`  "${value}" -> "${mapped}"  (${count} document${count === 1 ? '' : 's'})`);
    }
  }

  if (!plans.length) {
    console.log('\nNothing to do — every document already has an official domain.');
    await mongoose.disconnect();
    return;
  }

  if (dryRun) {
    console.log('\nDRY RUN — no documents were modified.');
    console.log('Re-run with --apply to write these changes.');
    await mongoose.disconnect();
    return;
  }

  // ── Backup BEFORE any write; abort if it fails ──────────────────────────
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `custom-question-domains-pre-migration-${timestamp()}.json`);
  const toBackUp = all.filter((d) => plans.some((p) => String(p.id) === String(d._id)));
  try {
    fs.writeFileSync(backupPath, JSON.stringify(toBackUp, null, 2), 'utf8');
  } catch (err) {
    console.error(`\nAborting: could not write backup to ${backupPath}\n${err.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const backedUp = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(backedUp) || backedUp.length !== plans.length) {
    console.error('\nAborting: backup verification failed (document count mismatch).');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Backup written & verified: ${path.relative(ROOT, backupPath)} (${backedUp.length} docs)`);

  // ── Apply ───────────────────────────────────────────────────────────────
  let written = 0;
  for (const p of plans) {
    await PediaCustomQuestion.updateOne({ _id: p.id }, { $set: { domain: p.after } });
    written += 1;
  }

  console.log(`\nApplied. ${written} document(s) migrated to an official domain.`);
  console.log('Re-run this script to confirm it reports nothing to do (idempotency check).');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
