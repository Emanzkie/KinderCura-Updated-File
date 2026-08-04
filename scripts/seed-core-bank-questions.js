// scripts/seed-core-bank-questions.js
// Seeds the fixed core screening bank (Q01–Q34) into MongoDB.
//
// Source of truth is the DOCTOR_QUESTION_BANK array literal inside
// js/parent/screening.js. We PARSE that file rather than copy the list, so the
// seed can never drift from what parents are actually asked. The frontend list
// is deliberately left in place — see the note printed at the end of a run.
//
// Idempotent: upserts by questionId. Safe to run repeatedly.
//
// Usage:
//   node scripts/seed-core-bank-questions.js --dry-run
//   node scripts/seed-core-bank-questions.js
//   MONGODB_URI=... node scripts/seed-core-bank-questions.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { connectDB, mongoose } = require('../db');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const { DATA_ORIGIN } = require('../constants/dataOrigin');

const SCREENING_JS = path.join(__dirname, '..', 'js', 'parent', 'screening.js');
const BANK_NAME = 'DOCTOR_QUESTION_BANK';

// Scoring buckets in routes/assessments.js. A question scoring into anything
// else would silently never be counted, so we check rather than assume.
const SCORING_DOMAINS = ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'];

// Fields we compare to decide inserted vs updated vs unchanged.
const SYNCED_FIELDS = ['text', 'domain', 'displayDomain', 'minAgeMonths', 'difficulty'];

function isDryRun() {
  return process.argv.includes('--dry-run');
}

/**
 * Pull the DOCTOR_QUESTION_BANK array literal out of screening.js.
 * Bracket-matches to the closing ']' so a ']' inside question text can't
 * truncate the parse.
 */
function extractBankLiteral(source) {
  const marker = new RegExp(`const\\s+${BANK_NAME}\\s*=\\s*\\[`);
  const match = source.match(marker);
  if (!match) {
    throw new Error(`Could not find "const ${BANK_NAME} = [" in ${SCREENING_JS}. Did the frontend change?`);
  }

  const start = match.index + match[0].length - 1; // position of the opening '['
  let depth = 0;
  let inString = null;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];

    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`Unbalanced brackets while reading ${BANK_NAME}.`);
}

/**
 * Evaluate the literal. It contains only plain object literals — no function
 * calls, no identifiers — which we assert before evaluating.
 */
function parseBank() {
  const source = fs.readFileSync(SCREENING_JS, 'utf8').replace(/^﻿/, '');
  const literal = extractBankLiteral(source);

  if (/\b(require|process|eval|Function|import)\b/.test(literal)) {
    throw new Error('Refusing to evaluate: question bank literal contains executable identifiers.');
  }

  let bank;
  try {
    bank = new Function(`return ${literal};`)();
  } catch (err) {
    throw new Error(`Failed to parse ${BANK_NAME}: ${err.message}`);
  }

  if (!Array.isArray(bank) || bank.length === 0) {
    throw new Error(`${BANK_NAME} parsed to an empty array.`);
  }
  return bank;
}

/**
 * Reject a malformed bank before touching the database. A partial seed is worse
 * than no seed, because step 4's backfill trusts this collection.
 */
function validateBank(bank) {
  const problems = [];
  const seen = new Set();

  bank.forEach((q, i) => {
    const at = `${BANK_NAME}[${i}]`;
    if (!q || typeof q !== 'object') return problems.push(`${at}: not an object`);
    if (!/^Q\d+$/.test(String(q.id || ''))) problems.push(`${at}: id "${q.id}" is not in Qnn form`);
    if (seen.has(q.id)) problems.push(`${at}: duplicate id ${q.id}`);
    seen.add(q.id);
    if (!String(q.text || '').trim()) problems.push(`${at} (${q.id}): empty text`);
    if (!String(q.scoreDomain || '').trim()) problems.push(`${at} (${q.id}): missing scoreDomain`);
    else if (!SCORING_DOMAINS.includes(q.scoreDomain)) {
      problems.push(`${at} (${q.id}): scoreDomain "${q.scoreDomain}" is not a scoring bucket — answers would never be scored`);
    }
    if (!Number.isFinite(q.minAgeMonths)) problems.push(`${at} (${q.id}): minAgeMonths is not a number`);
  });

  if (problems.length) {
    throw new Error(`Question bank failed validation:\n  - ${problems.join('\n  - ')}`);
  }
  return bank;
}

function toDoc(q) {
  return {
    questionId: q.id,
    text: String(q.text).trim(),
    domain: q.scoreDomain,
    displayDomain: q.displayDomain || '',
    minAgeMonths: q.minAgeMonths,
    difficulty: q.difficulty || '',
    origin: DATA_ORIGIN.CORE_BANK,
  };
}

function changedFields(existing, next) {
  return SYNCED_FIELDS.filter((f) => String(existing[f] ?? '') !== String(next[f] ?? ''));
}

/**
 * Parity check: how much of the real answer history this bank actually covers.
 * Step 4's backfill depends on this, so we surface it before that runs.
 */
async function reportParity(bank) {
  const bankIds = new Set(bank.map((q) => q.id));
  const bankTexts = new Set(bank.map((q) => String(q.text).trim()));

  const distinctIds = await AssessmentAnswer.distinct('questionId');
  const byId = distinctIds.filter((id) => bankIds.has(id));
  const notById = distinctIds.filter((id) => !bankIds.has(id));

  console.log('\nParity against existing assessment_answers');
  console.log(`  distinct questionIds stored : ${distinctIds.length}`);
  console.log(`  matched by questionId       : ${byId.length}`);
  console.log(`  NOT matched by questionId   : ${notById.length}${notById.length ? ` → ${notById.join(', ')}` : ''}`);

  if (notById.length) {
    // Legacy ids (numeric 1–8) predate the Qnn scheme. They are still core-bank
    // answers; step 4 resolves them by exact questionText.
    //
    // Important: classify PER DOCUMENT, not per id. Documents sharing a
    // questionId can carry different questionText — some blank — so sampling a
    // single doc per id both under- and over-reports. Step 4 must do the same.
    let docsResolvable = 0;
    let docsUnresolvable = 0;
    const detail = [];

    for (const id of notById) {
      const total = await AssessmentAnswer.countDocuments({ questionId: id });
      const texts = await AssessmentAnswer.distinct('questionText', { questionId: id });
      const known = texts.filter((t) => bankTexts.has(String(t || '').trim()));
      const unknown = texts.filter((t) => !bankTexts.has(String(t || '').trim()));

      const resolvableDocs = known.length
        ? await AssessmentAnswer.countDocuments({ questionId: id, questionText: { $in: known } })
        : 0;
      docsResolvable += resolvableDocs;
      docsUnresolvable += total - resolvableDocs;

      const sample = known[0] || unknown[0] || '';
      detail.push(
        `${id}: ${total} doc(s) — ${resolvableDocs} by text, ${total - resolvableDocs} not` +
        `${unknown.length ? ` [unmatched text variants: ${unknown.map((t) => (String(t).trim() ? `"${String(t).slice(0, 30)}"` : '<blank>')).join(', ')}]` : ''}` +
        `${sample ? `\n        → "${String(sample).slice(0, 50)}"` : ''}`
      );
    }

    console.log(`  legacy-id documents         : ${docsResolvable + docsUnresolvable}`);
    console.log(`    resolvable by exact text  : ${docsResolvable}`);
    console.log(`    NOT resolvable            : ${docsUnresolvable}`);
    console.log(`  per-id breakdown:\n     ${detail.join('\n     ')}`);
    if (docsUnresolvable > 0) {
      console.log('  ⚠ Unresolvable documents will be listed, not guessed, by the step 4 backfill.');
    }
  }
}

/**
 * Full parity verification of what actually landed in MongoDB against the
 * DOCTOR_QUESTION_BANK source. Structural assertions first, then a
 * field-by-field diff — a matching row count proves very little on its own.
 * Returns the number of failures so the caller can exit non-zero.
 */
async function verifyAgainstSource(bank) {
  console.log('\n' + '='.repeat(62));
  console.log('PARITY VERIFICATION — DB vs DOCTOR_QUESTION_BANK');
  console.log('='.repeat(62));

  const docs = await CoreBankQuestion.find({}).lean();
  const byId = new Map(docs.map((d) => [d.questionId, d]));
  const failures = [];
  const ok = (cond) => (cond ? '✓' : '✗ FAIL');

  // Expectations derived from the source, not hardcoded, so this stays a real
  // parity check rather than a second place to keep in sync.
  const bankIds = bank.map((q) => q.id).sort();
  const expectedAges = [...new Set(bank.map((q) => q.minAgeMonths))].sort((a, b) => a - b);

  console.log('\nStructural checks');

  const countOk = docs.length === bank.length;
  if (!countOk) failures.push(`doc count ${docs.length} != bank ${bank.length}`);
  console.log(`  total docs                 : ${docs.length} (expected ${bank.length})  ${ok(countOk)}`);

  // Contiguous Q01..Qnn with no gaps and no duplicates.
  const nums = docs.map((d) => Number(String(d.questionId).replace(/^Q/, ''))).sort((a, b) => a - b);
  const dupes = nums.filter((n, i) => i > 0 && n === nums[i - 1]);
  const expectedSeq = Array.from({ length: bank.length }, (_, i) => i + 1);
  const contiguous = nums.length === expectedSeq.length && nums.every((n, i) => n === expectedSeq[i]);
  const gaps = expectedSeq.filter((n) => !nums.includes(n));
  if (!contiguous) failures.push(`questionId sequence not contiguous; gaps: ${gaps.join(',') || 'none'}`);
  if (dupes.length) failures.push(`duplicate questionIds: ${dupes.join(',')}`);
  console.log(`  questionId range           : Q${String(nums[0]).padStart(2, '0')}–Q${String(nums[nums.length - 1]).padStart(2, '0')}, ` +
    `${contiguous ? 'contiguous, no gaps' : `GAPS: ${gaps.join(',')}`}  ${ok(contiguous)}`);
  console.log(`  duplicates                 : ${dupes.length ? dupes.join(',') : 'none'}  ${ok(!dupes.length)}`);

  const idsMatch = JSON.stringify(docs.map((d) => d.questionId).sort()) === JSON.stringify(bankIds);
  if (!idsMatch) failures.push('questionId set differs from bank');
  console.log(`  questionId set == bank     : ${idsMatch}  ${ok(idsMatch)}`);

  // Both domain axes must be populated on every row.
  const noDomain = docs.filter((d) => !String(d.domain || '').trim()).map((d) => d.questionId);
  const noDisplay = docs.filter((d) => !String(d.displayDomain || '').trim()).map((d) => d.questionId);
  if (noDomain.length) failures.push(`missing scoring domain: ${noDomain.join(',')}`);
  if (noDisplay.length) failures.push(`missing displayDomain: ${noDisplay.join(',')}`);
  console.log(`  domain (scoring) populated : ${docs.length - noDomain.length}/${docs.length}  ${ok(!noDomain.length)}` +
    `${noDomain.length ? ` → ${noDomain.join(',')}` : ''}`);
  console.log(`  displayDomain populated    : ${docs.length - noDisplay.length}/${docs.length}  ${ok(!noDisplay.length)}` +
    `${noDisplay.length ? ` → ${noDisplay.join(',')}` : ''}`);

  const distinctDomains = [...new Set(docs.map((d) => d.domain))].sort();
  const domainsExact = JSON.stringify(distinctDomains) === JSON.stringify([...SCORING_DOMAINS].sort());
  if (!domainsExact) failures.push(`distinct domains ${distinctDomains.join('|')} != required ${SCORING_DOMAINS.join('|')}`);
  console.log(`  distinct scoring domains   : ${distinctDomains.join(', ')}  ${ok(domainsExact)}`);

  const actualAges = [...new Set(docs.map((d) => d.minAgeMonths))].sort((a, b) => a - b);
  const agesMatch = JSON.stringify(actualAges) === JSON.stringify(expectedAges);
  if (!agesMatch) failures.push(`minAgeMonths ${actualAges.join(',')} != source ${expectedAges.join(',')}`);
  console.log(`  minAgeMonths values        : ${actualAges.join(', ')}  ${ok(agesMatch)}`);
  console.log(`    (derived from source; note 84 is present via Q33/Q34)`);

  // Provenance is REPORTED, never asserted. An empty sourcedFrom is a true
  // statement about a question we cannot trace — failing the run on it would
  // pressure someone into filling the field with a guess, which is the exact
  // failure mode we are trying to avoid. Report the counts and move on.
  const noSourced = docs.filter((d) => !String(d.sourcedFrom || '').trim()).map((d) => d.questionId);
  const noCitation = docs.filter((d) => !String(d.sourceCitation || '').trim()).length;
  const notManaged = docs.filter((d) => d.isSystemManaged !== true).map((d) => d.questionId);
  if (notManaged.length) failures.push(`isSystemManaged not true: ${notManaged.join(',')}`);
  console.log(`  sourcedFrom set            : ${docs.length - noSourced.length}/${docs.length}  (attribution, unverified)`);
  console.log(`  sourceCitation set         : ${docs.length - noCitation}/${docs.length}  (checkable external source)`);
  if (noCitation === docs.length) {
    console.log('    → no question has a recorded external source; the admin');
    console.log('      Dataset tab will correctly show 0. This is accurate, not a defect.');
  }
  console.log(`  isSystemManaged true       : ${docs.length - notManaged.length}/${docs.length}  ${ok(!notManaged.length)}`);

  const wrongOrigin = docs.filter((d) => d.origin !== DATA_ORIGIN.CORE_BANK).map((d) => d.questionId);
  if (wrongOrigin.length) failures.push(`origin != core_bank: ${wrongOrigin.join(',')}`);
  console.log(`  origin == core_bank        : ${docs.length - wrongOrigin.length}/${docs.length}  ${ok(!wrongOrigin.length)}`);

  // Field-by-field, every question, against the parsed source.
  console.log('\nField-by-field diff vs DOCTOR_QUESTION_BANK');
  let identical = 0;
  for (const q of [...bank].sort((a, b) => a.id.localeCompare(b.id))) {
    const doc = byId.get(q.id);
    if (!doc) {
      failures.push(`${q.id}: MISSING from DB`);
      console.log(`  ${q.id}  ✗ MISSING FROM DB`);
      continue;
    }
    const want = toDoc(q);
    const diffs = [];
    for (const f of SYNCED_FIELDS) {
      if (String(doc[f] ?? '') !== String(want[f] ?? '')) {
        diffs.push(`${f}: db="${doc[f]}" src="${want[f]}"`);
      }
    }
    if (diffs.length) {
      failures.push(`${q.id}: ${diffs.join('; ')}`);
      console.log(`  ${q.id}  ✗ ${diffs.join(' | ')}`);
    } else {
      identical += 1;
      console.log(`  ${q.id}  ✓  ${String(doc.domain).padEnd(14)} ${String(doc.displayDomain).padEnd(16)} ${String(doc.minAgeMonths).padStart(2)}mo  ${doc.difficulty}`);
    }
  }
  console.log(`\n  ${identical}/${bank.length} rows byte-identical to source across ${SYNCED_FIELDS.join(', ')}`);

  const extras = docs.filter((d) => !bank.some((q) => q.id === d.questionId)).map((d) => d.questionId);
  if (extras.length) {
    failures.push(`rows in DB not in bank: ${extras.join(',')}`);
    console.log(`  ✗ extra rows not in source: ${extras.join(', ')}`);
  }

  console.log('\n' + '-'.repeat(62));
  if (failures.length) {
    console.log(`RESULT: ✗ ${failures.length} parity failure(s)`);
    failures.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('RESULT: ✓ full parity — DB matches DOCTOR_QUESTION_BANK exactly');
  }
  console.log('-'.repeat(62));

  return failures.length;
}

async function run() {
  const dryRun = isDryRun();
  const verifyOnly = process.argv.includes('--verify-only');
  const bank = validateBank(parseBank());

  console.log(`Parsed ${bank.length} questions from ${path.relative(process.cwd(), SCREENING_JS)}`);
  if (dryRun) console.log('DRY RUN — no writes will be made.\n');

  await connectDB();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const updateDetail = [];

  if (verifyOnly) console.log('VERIFY ONLY — skipping all writes.');

  for (const q of (verifyOnly ? [] : bank)) {
    const next = toDoc(q);
    const existing = await CoreBankQuestion.findOne({ questionId: next.questionId }).lean();

    if (!existing) {
      if (!dryRun) await CoreBankQuestion.create(next);
      inserted += 1;
      continue;
    }

    const diff = changedFields(existing, next);
    if (diff.length === 0) {
      skipped += 1;
      continue;
    }

    // Only the synced content fields are overwritten. isActive, sourcedFrom and
    // isSystemManaged are left alone so admin/operator changes survive a re-run.
    if (!dryRun) await CoreBankQuestion.updateOne({ questionId: next.questionId }, { $set: next });
    updated += 1;
    updateDetail.push(`${next.questionId}: ${diff.join(', ')}`);
  }

  console.log(verifyOnly ? '\nSeed summary (verify-only: no writes attempted)' : '\nSeed summary');
  console.log(`  inserted : ${inserted}`);
  console.log(`  updated  : ${updated}${updateDetail.length ? `\n     ${updateDetail.join('\n     ')}` : ''}`);
  console.log(`  skipped  : ${skipped}  (already identical)`);
  console.log(`  total in bank : ${bank.length}`);

  const inDb = await CoreBankQuestion.countDocuments();
  console.log(`  total in core_bank_questions : ${inDb}`);

  const extra = await CoreBankQuestion.find({ questionId: { $nin: bank.map((q) => q.id) } })
    .select('questionId')
    .lean();
  if (extra.length) {
    console.log(`  ⚠ ${extra.length} row(s) in the DB are no longer in the frontend bank: ${extra.map((e) => e.questionId).join(', ')}`);
    console.log('    Left untouched — remove by hand if a question was retired on purpose.');
  }

  await reportParity(bank);

  // Verify what actually landed. Skipped on a dry run, where the DB was
  // intentionally not written and a diff would be meaningless.
  if (!dryRun) {
    const failures = await verifyAgainstSource(bank);
    if (failures > 0) {
      throw new Error(`${failures} parity failure(s) — see the verification report above.`);
    }
  }

  if (dryRun) console.log('\nDRY RUN — nothing was written.');
  console.log(
    '\nNote: js/parent/screening.js still holds the hardcoded list and remains the\n' +
    'source of truth. This collection is read-only reporting data until the\n' +
    'frontend is switched over to the API.'
  );
}

run()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Seed failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
