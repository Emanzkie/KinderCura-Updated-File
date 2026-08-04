// scripts/backfill-scoring-bands.js
// ============================================================================
// Rescores the persisted *Status fields on AssessmentResult documents under the
// ACTIVE_BANDS defined in constants/scoring.js, and stamps scoringBandsVersion.
//
// WHY THIS IS NEEDED
// ------------------
// AssessmentResult persists communicationStatus / socialStatus / cognitiveStatus
// / motorStatus, written at routes/assessments.js using the old 51/26 bands.
// Some endpoints serve those persisted strings verbatim
// (assessments.js GET /:assessmentId/results) while others recompute at read
// time (GET /pedia-patients). Changing the band constant alone would make the
// two disagree for the same child. This script closes that gap.
//
// SAFETY
// ------
//   * --dry-run is the DEFAULT. Nothing is written without an explicit --apply.
//   * With --apply, every affected document is dumped to backups/ BEFORE any
//     write, and the run aborts if that dump cannot be written.
//   * Idempotent: documents already stamped with the current version are
//     skipped, so re-running is a no-op.
//   * Only the four *Status fields and scoringBandsVersion are touched.
//     Scores, riskFlags, childId, assessmentId, and generatedAt are never
//     modified.
//
// NOTE ON riskFlags: not rewritten. They are generated from a <40 threshold
// (scoring.RISK_FLAG_THRESHOLD), which is unchanged by the move to 80/60/40,
// so existing values remain correct. Verified against live data before this
// script was written: 1 document has riskFlags, and its flags are unaffected.
//
// USAGE
//   node scripts/backfill-scoring-bands.js              # dry run (default)
//   node scripts/backfill-scoring-bands.js --dry-run    # explicit dry run
//   node scripts/backfill-scoring-bands.js --apply      # writes
// ============================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const AssessmentResult = require('../models/AssessmentResult');
const scoring = require('../constants/scoring');

const TARGET_VERSION = scoring.SCORING_BANDS_VERSION;

const DOMAINS = [
  { key: 'communication', scoreField: 'communicationScore', statusField: 'communicationStatus' },
  { key: 'social',        scoreField: 'socialScore',        statusField: 'socialStatus' },
  { key: 'cognitive',     scoreField: 'cognitiveScore',     statusField: 'cognitiveStatus' },
  { key: 'motor',         scoreField: 'motorScore',         statusField: 'motorStatus' },
];

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');
const DOCS_DIR = path.join(ROOT, 'docs');

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const dryRunFlag = argv.includes('--dry-run');
  if (apply && dryRunFlag) {
    console.error('Refusing to run: --apply and --dry-run are mutually exclusive.');
    process.exit(1);
  }
  // Dry run is the default: only an explicit --apply writes.
  return { apply, dryRun: !apply };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Work out what would change for one document, without mutating it. */
function planForDoc(doc) {
  const changes = [];
  for (const d of DOMAINS) {
    const score = doc[d.scoreField] ?? 0;
    const before = doc[d.statusField] ?? null;
    const after = scoring.getStatus(score);
    if (before !== after) {
      changes.push({ domain: d.key, statusField: d.statusField, score, before, after });
    }
  }
  return changes;
}

function renderTable(plans) {
  const rows = [];
  rows.push('| Result _id (tail) | Domain | Score | Before | After |');
  rows.push('|---|---|---:|---|---|');
  for (const p of plans) {
    for (const c of p.changes) {
      rows.push(
        `| \`…${String(p.id).slice(-6)}\` | ${c.domain} | ${c.score}% | ` +
        `${c.before === null ? '_(null)_' : '`' + c.before + '`'} | \`${c.after}\` |`
      );
    }
  }
  if (plans.every((p) => !p.changes.length)) {
    rows.push('| _no status changes_ | — | — | — | — |');
  }
  return rows.join('\n');
}

function buildReport({ plans, total, skipped, mode, changedDocs, changedFields }) {
  const bands = scoring.ACTIVE_BANDS
    .map((b) => `  ${String(b.min).padStart(3)}-${String(b.max).padEnd(3)} → ${b.key}`)
    .join('\n');

  return `# Scoring Bands Backfill Report

**Generated:** ${new Date().toISOString()}
**Mode:** ${mode}
**Target version stamp:** \`${TARGET_VERSION}\`

## Active bands

\`\`\`
${bands}
\`\`\`

> Band cutoffs 80/60/40 unconfirmed — pending confirmation from consultant
> pediatrician. Do not cite as clinically validated.

## Summary

| Metric | Value |
|---|---:|
| Result documents examined | ${total} |
| Already stamped \`${TARGET_VERSION}\` (skipped) | ${skipped} |
| Documents with ≥1 status change | ${changedDocs} |
| Individual status fields changed | ${changedFields} |
| Documents restamped | ${plans.length} |

## Per-document changes

${renderTable(plans)}

## What was not touched

- \`riskFlags\` — generated from a <${scoring.RISK_FLAG_THRESHOLD}% threshold, unchanged by the move to 80/60/40.
- All score fields, \`childId\`, \`assessmentId\`, \`generatedAt\`.
- Every \`Assessment\`, \`AssessmentAnswer\`, and \`CoreBankQuestion\` document.
`;
}

async function main() {
  const { apply, dryRun } = parseArgs(process.argv.slice(2));
  const mode = apply ? 'APPLY (writes)' : 'DRY RUN (no writes)';

  console.log('='.repeat(70));
  console.log('  KinderCura — scoring bands backfill');
  console.log('  Mode:', mode);
  console.log('  Target stamp:', TARGET_VERSION);
  console.log('='.repeat(70));

  if (!process.env.MONGODB_URI) {
    console.error('\nMONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const all = await AssessmentResult.find({}).lean();
  const total = all.length;

  // Idempotency: anything already at the target version is left alone.
  const pending = all.filter((d) => d.scoringBandsVersion !== TARGET_VERSION);
  const skipped = total - pending.length;

  const plans = pending.map((doc) => ({ id: doc._id, doc, changes: planForDoc(doc) }));
  const changedDocs = plans.filter((p) => p.changes.length).length;
  const changedFields = plans.reduce((n, p) => n + p.changes.length, 0);

  console.log(`\nExamined ${total} result document(s).`);
  console.log(`  already stamped ${TARGET_VERSION}: ${skipped} (skipped)`);
  console.log(`  to restamp                      : ${plans.length}`);
  console.log(`  with >=1 status change          : ${changedDocs}`);
  console.log(`  individual status fields changed: ${changedFields}\n`);

  for (const p of plans) {
    if (!p.changes.length) continue;
    const detail = p.changes
      .map((c) => `${c.domain} ${c.score}%: ${c.before ?? '(null)'} -> ${c.after}`)
      .join(' | ');
    console.log(`  …${String(p.id).slice(-6)} | ${detail}`);
  }

  if (!plans.length) {
    console.log('\nNothing to do — every document is already at the current version.');
    await mongoose.disconnect();
    return;
  }

  // ── Write the evidence trail (both modes) ───────────────────────────────
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const reportPath = path.join(DOCS_DIR, 'BACKFILL-REPORT.md');
  fs.writeFileSync(
    reportPath,
    buildReport({ plans, total, skipped, mode, changedDocs, changedFields }),
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
  const backupPath = path.join(BACKUP_DIR, `results-pre-v2-${timestamp()}.json`);
  try {
    fs.writeFileSync(backupPath, JSON.stringify(pending, null, 2), 'utf8');
  } catch (err) {
    console.error(`\nAborting: could not write backup to ${backupPath}\n${err.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const backedUp = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(backedUp) || backedUp.length !== pending.length) {
    console.error('\nAborting: backup verification failed (document count mismatch).');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Backup written & verified: ${path.relative(ROOT, backupPath)} (${backedUp.length} docs)`);

  // ── Apply ───────────────────────────────────────────────────────────────
  let written = 0;
  for (const p of plans) {
    const $set = { scoringBandsVersion: TARGET_VERSION };
    for (const c of p.changes) $set[c.statusField] = c.after;
    await AssessmentResult.updateOne({ _id: p.id }, { $set });
    written += 1;
  }

  console.log(`\nApplied. ${written} document(s) restamped, ${changedFields} status field(s) rewritten.`);
  console.log('Re-run this script to confirm it reports nothing to do (idempotency check).');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nBackfill failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
