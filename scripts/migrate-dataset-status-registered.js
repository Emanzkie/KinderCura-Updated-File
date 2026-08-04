// scripts/migrate-dataset-status-registered.js
// ============================================================================
// Migrates TrainingDataset.status from 'trained' to 'registered' for datasets
// that never produced a model artifact.
//
// WHY THIS IS NEEDED
// ------------------
// TrainingDataset.status was set to 'trained' by a code path that only
// REGISTERS an uploaded file — its own trainingSummary says so: "…were
// registered by the admin page". No model was produced. The admin page counted
// that flag and reported "Models Trained: 3" while the trained_models
// collection held 0 documents.
//
// The counter has been fixed to read trained_models directly, but the stored
// value still says 'trained', which is false. This corrects the data.
//
// SAFETY
// ------
//   * --dry-run is the DEFAULT. Nothing is written without an explicit --apply.
//   * Every affected document is dumped to backups/ BEFORE any write, and the
//     run aborts if that dump cannot be written or verified.
//   * CONSERVATIVE: a dataset is migrated ONLY if it has no modelId AND no
//     corresponding TrainedModel document. A dataset that genuinely produced a
//     model is left alone and reported as skipped.
//   * Idempotent: documents already 'registered' are skipped.
//   * Only the `status` field is touched. Nothing else is modified, and no
//     uploaded file is deleted or moved.
//
// USAGE
//   node scripts/migrate-dataset-status-registered.js              # dry run
//   node scripts/migrate-dataset-status-registered.js --dry-run    # explicit
//   node scripts/migrate-dataset-status-registered.js --apply      # writes
// ============================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const TrainingDataset = require('../models/TrainingDataset');
const TrainedModel = require('../models/TrainedModel');

const FROM_STATUS = 'trained';
const TO_STATUS = 'registered';

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');
const DOCS_DIR = path.join(ROOT, 'docs');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) {
    console.error('Refusing to run: --apply and --dry-run are mutually exclusive.');
    process.exit(1);
  }
  return { apply, dryRun: !apply };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function buildReport({ mode, examined, candidates, skipped, migrated }) {
  const rows = candidates.length
    ? candidates.map((c) =>
        `| \`${c.name}\` | ${c.rowCount} | \`${FROM_STATUS}\` | \`${TO_STATUS}\` | ${c.reason} |`
      ).join('\n')
    : '| _none_ | — | — | — | — |';

  const skippedRows = skipped.length
    ? skipped.map((s) => `| \`${s.name}\` | ${s.reason} |`).join('\n')
    : '| _none_ | — |';

  return `# Dataset Status Migration Report

**Generated:** ${new Date().toISOString()}
**Mode:** ${mode}
**Change:** \`status: '${FROM_STATUS}'\` → \`status: '${TO_STATUS}'\`

## Why

\`TrainingDataset.status\` was set to \`'${FROM_STATUS}'\` by a code path that only
registers an uploaded file. No model artifact was produced. Keeping the value as
\`'${FROM_STATUS}'\` makes the database assert something untrue.

A dataset is migrated **only** when it has no \`modelId\` and no corresponding
\`TrainedModel\` document. Anything that genuinely produced a model is left alone.

## Summary

| Metric | Value |
|---|---:|
| Datasets examined | ${examined} |
| Migrated to \`${TO_STATUS}\` | ${migrated} |
| Skipped (kept \`${FROM_STATUS}\`) | ${skipped.length} |

## Migrated

| Dataset | Rows | From | To | Reason |
|---|---:|---|---|---|
${rows}

## Skipped

| Dataset | Reason |
|---|---|
${skippedRows}

## Not touched

- Every uploaded file in \`uploads/datasets/\` — nothing deleted or moved.
- All other \`TrainingDataset\` fields, including \`trainedAt\` and
  \`trainingSummary\`, which remain as the historical record of what happened.
- The \`ml/\` directory and every \`TrainedModel\` document.
`;
}

async function main() {
  const { apply, dryRun } = parseArgs(process.argv.slice(2));
  const mode = apply ? 'APPLY (writes)' : 'DRY RUN (no writes)';

  console.log('='.repeat(70));
  console.log('  KinderCura — dataset status migration');
  console.log(`  Mode: ${mode}`);
  console.log(`  Change: '${FROM_STATUS}' -> '${TO_STATUS}'`);
  console.log('='.repeat(70));

  if (!process.env.MONGODB_URI) {
    console.error('\nMONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const all = await TrainingDataset.find({ status: FROM_STATUS }).lean();
  const examined = await TrainingDataset.countDocuments({});

  console.log(`\nExamined ${examined} dataset(s); ${all.length} currently '${FROM_STATUS}'.\n`);

  const candidates = [];
  const skipped = [];

  for (const d of all) {
    // Conservative check: does a real model exist for this dataset?
    const modelCount = await TrainedModel.countDocuments({
      datasetId: d._id,
      status: 'completed',
    });

    if (d.modelId || modelCount > 0) {
      skipped.push({
        _id: d._id,
        name: d.name,
        reason: d.modelId
          ? 'has modelId — a model artifact is recorded'
          : `has ${modelCount} completed TrainedModel document(s)`,
      });
      continue;
    }

    candidates.push({
      _id: d._id,
      name: d.name,
      rowCount: d.rowCount || 0,
      reason: 'no modelId and no completed TrainedModel — nothing was trained',
    });
  }

  for (const c of candidates) {
    console.log(`  MIGRATE  ${c.name}`);
    console.log(`           ${c.reason}`);
  }
  for (const s of skipped) {
    console.log(`  SKIP     ${s.name}`);
    console.log(`           ${s.reason}`);
  }

  if (!candidates.length) {
    console.log('\nNothing to migrate — no dataset falsely claims to be trained.');
    await mongoose.disconnect();
    return;
  }

  // ── Evidence trail (both modes) ─────────────────────────────────────────
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const reportPath = path.join(DOCS_DIR, 'DATASET-STATUS-MIGRATION.md');
  fs.writeFileSync(
    reportPath,
    buildReport({ mode, examined, candidates, skipped, migrated: candidates.length }),
    'utf8'
  );
  console.log(`\nReport written: ${path.relative(ROOT, reportPath)}`);

  if (dryRun) {
    console.log('\nDRY RUN — no documents were modified.');
    console.log('Re-run with --apply to write these changes.');
    await mongoose.disconnect();
    return;
  }

  // ── Backup BEFORE any write; abort if it fails ──────────────────────────
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `training_datasets-pre-registered-${timestamp()}.json`);
  try {
    fs.writeFileSync(backupPath, JSON.stringify(all, null, 2), 'utf8');
  } catch (err) {
    console.error(`\nAborting: could not write backup to ${backupPath}\n${err.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const backedUp = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(backedUp) || backedUp.length !== all.length) {
    console.error('\nAborting: backup verification failed (document count mismatch).');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Backup written & verified: ${path.relative(ROOT, backupPath)} (${backedUp.length} docs)`);

  // ── Apply ───────────────────────────────────────────────────────────────
  let written = 0;
  for (const c of candidates) {
    await TrainingDataset.updateOne({ _id: c._id }, { $set: { status: TO_STATUS } });
    written += 1;
  }

  console.log(`\nApplied. ${written} dataset(s) moved to '${TO_STATUS}'.`);
  console.log('Re-run this script to confirm it reports nothing to migrate.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
