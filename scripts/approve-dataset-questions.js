// scripts/approve-dataset-questions.js
// Records a REAL pediatrician sign-off on the 16 Dataset Question candidates
// (origin = dataset_question, see constants/datasetQuestions.js) into the
// existing pediatrician review lifecycle on CoreBankQuestion — see
// "Pediatrician review lifecycle" in models/CoreBankQuestion.js.
//
// This is NOT the reviewer round recorded in DATASET_REVIEW (constants/
// datasetQuestions.js). That record approved WORDING only, on 2026-08-28, and
// is untouched by this script — see the comments there and in
// docs/dataset-questions-review-round2.md. This script records the separate,
// later fact that a licensed pediatrician reviewed the (already-approved)
// wording and the sourced construct, and signed off.
//
// PEDIATRICIAN DECISION — recorded 2026-09-02
// --------------------------------------------
// All 16 Dataset Questions (DQ01-DQ16) marked APPROVE, including DQ09's
// current wording and its "at least three" colors threshold (see DQ09's
// adaptationNote in constants/datasetQuestions.js — that threshold was our
// operational choice, not CDC's, and was the reason DQ09 carried an open
// clinical mapping question in the reviewer round). The pediatrician ruling on
// that number is what resolves it now; see routes/admin.js, which computes a
// Dataset Question's "open clinical mapping question" flag as
// DATASET_REVIEW.openMappingItems combined with the LIVE approvalStatus below
// — so DQ09 stops showing as open the moment this script approves it, without
// rewriting the reviewer round's historical record.
const PEDIATRICIAN_DECISIONS = Object.freeze({
  DQ01: 'approve', DQ02: 'approve', DQ03: 'approve', DQ04: 'approve',
  DQ05: 'approve', DQ06: 'approve', DQ07: 'approve', DQ08: 'approve',
  DQ09: 'approve', DQ10: 'approve', DQ11: 'approve', DQ12: 'approve',
  DQ13: 'approve', DQ14: 'approve', DQ15: 'approve', DQ16: 'approve',
});
const DECISION_DATE = '2026-09-02';

// Scope, stated as a promise this script keeps:
//   - It only ever touches rows whose questionId is a key of
//     PEDIATRICIAN_DECISIONS AND whose stored origin is dataset_question. A
//     core_bank or pedia_entry row is never read for writing, never updated.
//   - It writes ONLY approvalStatus, approvedBy, approvedAt. It never touches
//     isActive, text, domain, sourceCitation, generationMethod or any other
//     field — approval and activation are deliberately separate acts (see
//     models/CoreBankQuestion.js's isActive validator).
//   - It aborts before writing anything unless exactly the expected 16 rows
//     are found under origin=dataset_question — a partial match means the
//     catalogue and the database have drifted, and guessing is worse than
//     stopping.
//   - Re-running it is a no-op on a row that already carries this exact
//     decision (idempotent), and it never overwrites a DIFFERENT prior
//     decision silently — see assertNoConflictingDecision().
//
// Usage:
//   node scripts/approve-dataset-questions.js --dry-run
//   node scripts/approve-dataset-questions.js
//   node scripts/approve-dataset-questions.js --pediatrician-email=someone@example.com
require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const User = require('../models/User');
const { DATA_ORIGIN, APPROVAL_STATUS } = require('../constants/dataOrigin');
const { DATASET_QUESTIONS } = require('../constants/datasetQuestions');

const isDryRun = () => process.argv.includes('--dry-run');

function argValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : null;
}

/**
 * Resolve the approving pediatrician to an existing User document. Refuses to
 * guess: if more than one active pediatrician account exists, an explicit
 * --pediatrician-email is required rather than picking one.
 */
async function resolvePediatrician() {
  const email = argValue('pediatrician-email');
  if (email) {
    const user = await User.findOne({ email: String(email).toLowerCase().trim(), role: 'pediatrician' });
    if (!user) throw new Error(`No pediatrician account found with email "${email}".`);
    return user;
  }

  const pediatricians = await User.find({ role: 'pediatrician', status: 'active' }).lean();
  if (pediatricians.length === 0) {
    throw new Error('No active pediatrician account exists to attribute this approval to. Refusing to guess an approver.');
  }
  if (pediatricians.length > 1) {
    throw new Error(
      `${pediatricians.length} active pediatrician accounts exist — refusing to guess which one approved this. `
      + 'Re-run with --pediatrician-email=<email>.'
    );
  }
  return pediatricians[0];
}

/**
 * Refuse to run if the requested questionIds are not exactly the 16 in the
 * catalogue, or if the database does not hold exactly those 16 under
 * origin=dataset_question. A mismatch means the catalogue and the seeded
 * rows have drifted — this must be resolved by hand, not papered over.
 */
async function resolveTargets() {
  const decisionIds = Object.keys(PEDIATRICIAN_DECISIONS).sort();
  const catalogueIds = DATASET_QUESTIONS.map((q) => q.questionId).sort();
  if (JSON.stringify(decisionIds) !== JSON.stringify(catalogueIds)) {
    throw new Error(
      'PEDIATRICIAN_DECISIONS does not cover exactly the current DATASET_QUESTIONS catalogue.\n'
      + `  decisions : ${decisionIds.join(', ')}\n`
      + `  catalogue : ${catalogueIds.join(', ')}`
    );
  }

  const docs = await CoreBankQuestion.find({
    questionId: { $in: decisionIds },
    origin: DATA_ORIGIN.DATASET_QUESTION,
  });

  const foundIds = docs.map((d) => d.questionId).sort();
  const missing = decisionIds.filter((id) => !foundIds.includes(id));
  if (missing.length) {
    throw new Error(
      `Refusing to approve: ${missing.length} dataset_question row(s) not found in the database — `
      + `${missing.join(', ')}. Seed them first: npm run seed:dataset-questions`
    );
  }

  // Defense in depth against a stray duplicate — the schema's unique index on
  // questionId should already make this impossible.
  if (docs.length !== decisionIds.length) {
    throw new Error(`Expected ${decisionIds.length} dataset_question row(s), found ${docs.length} — possible duplicates.`);
  }

  return docs;
}

/**
 * A row already carrying a DIFFERENT decision (e.g. a prior rejection) is
 * never silently flipped. That would erase a real prior ruling.
 */
function assertNoConflictingDecision(doc, decision) {
  const wantStatus = decision === 'approve' ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.REJECTED;
  if (doc.approvalStatus && doc.approvalStatus !== APPROVAL_STATUS.PENDING && doc.approvalStatus !== wantStatus) {
    throw new Error(
      `${doc.questionId}: already carries approvalStatus="${doc.approvalStatus}", which conflicts with the new `
      + `decision "${decision}". Refusing to overwrite a prior ruling — resolve by hand.`
    );
  }
}

async function run() {
  const dryRun = isDryRun();
  if (dryRun) console.log('DRY RUN — no writes will be made.\n');

  await connectDB();

  const pediatrician = await resolvePediatrician();
  const pediatricianName = `${pediatrician.firstName || ''} ${pediatrician.lastName || ''}`.trim() || pediatrician.email;
  console.log(`Pediatrician decision date : ${DECISION_DATE}`);
  console.log(`Approving pediatrician     : ${pediatricianName} <${pediatrician.email}> (${pediatrician._id})`);

  const docs = await resolveTargets();
  console.log(`Found ${docs.length}/16 dataset_question rows matching the catalogue.\n`);

  const approvedAt = new Date();
  let approved = 0;
  let alreadyApproved = 0;
  const detail = [];

  for (const doc of docs) {
    const decision = PEDIATRICIAN_DECISIONS[doc.questionId];
    assertNoConflictingDecision(doc, decision);

    if (decision !== 'approve') {
      // Not reachable today (every decision is "approve"), kept so a future
      // mixed decision set fails loudly instead of being silently approved.
      throw new Error(`${doc.questionId}: unsupported decision "${decision}" — this script only implements "approve".`);
    }

    const alreadyRecorded = doc.approvalStatus === APPROVAL_STATUS.APPROVED
      && String(doc.approvedBy || '') === String(pediatrician._id)
      && doc.approvedAt != null;

    if (alreadyRecorded) {
      alreadyApproved += 1;
      detail.push(`= ${doc.questionId}  already approved by this pediatrician on ${doc.approvedAt.toISOString()}`);
      continue;
    }

    doc.approvalStatus = APPROVAL_STATUS.APPROVED;
    doc.approvedBy = pediatrician._id;
    doc.approvedAt = approvedAt;
    // Deliberately untouched: isActive. Pediatrician approval makes a
    // question ELIGIBLE for activation; it does not activate it. See
    // models/CoreBankQuestion.js's isActive validator.

    if (!dryRun) await doc.save();
    approved += 1;
    detail.push(`+ ${doc.questionId}  approvalStatus=approved  isActive=${doc.isActive}  (unchanged)`);
  }

  console.log(dryRun ? 'Approval summary (dry run: no writes attempted)' : 'Approval summary');
  console.log(`  newly approved   : ${approved}`);
  console.log(`  already recorded : ${alreadyApproved}   (idempotent re-run, no write)`);
  console.log(`  ${detail.join('\n  ')}`);

  if (!dryRun) {
    const failures = await verify(pediatrician._id);
    if (failures > 0) throw new Error(`${failures} verification failure(s) — see the report above.`);
  }

  if (dryRun) console.log('\nDRY RUN — nothing was written.');
  console.log(
    '\nPediatrician approval recorded. These 16 questions remain isActive: false — pediatrician\n'
    + 'approval makes a dataset question ELIGIBLE for activation, it does not activate it.\n'
    + 'The parent screening flow still renders the hardcoded DOCTOR_QUESTION_BANK in\n'
    + 'js/parent/screening.js and does not read this collection, so nothing changes for any parent.'
  );
}

async function verify(pediatricianId) {
  console.log('\n' + '='.repeat(66));
  console.log('PEDIATRICIAN APPROVAL VERIFICATION');
  console.log('='.repeat(66));

  const failures = [];
  const ok = (cond) => (cond ? '✓' : '✗ FAIL');

  const dsDocs = await CoreBankQuestion.find({ origin: DATA_ORIGIN.DATASET_QUESTION }).lean();
  const countOk = dsDocs.length === 16;
  if (!countOk) failures.push(`dataset_question rows ${dsDocs.length} != 16 (no duplicates expected)`);
  console.log(`  dataset_question rows        : ${dsDocs.length} (expected 16)  ${ok(countOk)}`);

  const notApproved = dsDocs.filter((d) => d.approvalStatus !== APPROVAL_STATUS.APPROVED).map((d) => d.questionId);
  const noApprover = dsDocs.filter((d) => !d.approvedBy).map((d) => d.questionId);
  const wrongApprover = dsDocs.filter((d) => d.approvedBy && String(d.approvedBy) !== String(pediatricianId)).map((d) => d.questionId);
  const noApprovedAt = dsDocs.filter((d) => !d.approvedAt).map((d) => d.questionId);
  const active = dsDocs.filter((d) => d.isActive === true).map((d) => d.questionId);

  if (notApproved.length) failures.push(`approvalStatus not approved: ${notApproved.join(',')}`);
  if (noApprover.length) failures.push(`approvedBy not set: ${noApprover.join(',')}`);
  if (wrongApprover.length) failures.push(`approvedBy set to a different user: ${wrongApprover.join(',')}`);
  if (noApprovedAt.length) failures.push(`approvedAt not set: ${noApprovedAt.join(',')}`);
  if (active.length) failures.push(`ACTIVE after approval — pediatrician approval must never auto-activate: ${active.join(',')}`);

  console.log(`  approvalStatus = approved    : ${dsDocs.length - notApproved.length}/${dsDocs.length}  ${ok(!notApproved.length)}`);
  console.log(`  approvedBy set (this pedia)  : ${dsDocs.length - noApprover.length - wrongApprover.length}/${dsDocs.length}  ${ok(!noApprover.length && !wrongApprover.length)}`);
  console.log(`  approvedAt set               : ${dsDocs.length - noApprovedAt.length}/${dsDocs.length}  ${ok(!noApprovedAt.length)}`);
  console.log(`  isActive = false (not live)  : ${dsDocs.length - active.length}/${dsDocs.length}  ${ok(!active.length)}`);

  // The other two origins must be exactly as we found them.
  const coreCount = await CoreBankQuestion.countDocuments({ origin: DATA_ORIGIN.CORE_BANK });
  const PediaCustomQuestion = require('../models/PediaCustomQuestion');
  const pediaCount = await PediaCustomQuestion.countDocuments({});
  const coreOk = coreCount === 34;
  const pediaOk = pediaCount === 6;
  if (!coreOk) failures.push(`core_bank rows ${coreCount} != 34 — must be untouched`);
  if (!pediaOk) failures.push(`pedia_custom_questions rows ${pediaCount} != 6 — must be untouched`);
  console.log(`  core_bank rows untouched     : ${coreCount} (expected 34)  ${ok(coreOk)}`);
  console.log(`  pedia_entry rows untouched   : ${pediaCount} (expected 6)  ${ok(pediaOk)}`);

  console.log('\n  Per-question:');
  for (const d of [...dsDocs].sort((a, b) => a.questionId.localeCompare(b.questionId))) {
    console.log(`    ${d.questionId}  approvalStatus=${d.approvalStatus}  approvedBy=${d.approvedBy}  `
      + `approvedAt=${d.approvedAt ? d.approvedAt.toISOString() : 'null'}  isActive=${d.isActive}`);
  }

  console.log('\n' + '-'.repeat(66));
  if (failures.length) {
    console.log(`RESULT: ✗ ${failures.length} failure(s)`);
    failures.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('RESULT: ✓ 16/16 Dataset Questions pediatrician-approved, none active, other origins untouched.');
  }
  console.log('-'.repeat(66));
  return failures.length;
}

run()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Pediatrician approval failed:', err.message);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
  });
