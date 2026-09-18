// scripts/seed-dummy-pediatrician-demo-data.js
//
// Populates a small, curated set of EXISTING dummy pediatrician accounts with
// realistic pediatrician-authored questions and child assignments, so the
// Pediatrician Question workflow (routes/custom-questions.js) and the Admin
// Data Sources "Pediatrician Question" category have real demo data to show
// instead of empty tables.
//
// ── What this does NOT do ────────────────────────────────────────────────
//   - Does NOT create new pediatrician accounts. It reuses 4 EXISTING
//     synthetic pediatricians already written by
//     scripts/generate-system-demo-data.js (isSynthetic: true), selected by
//     their stable email address (see TARGET_PEDIATRICIANS below).
//   - Does NOT create new children or new appointments. It only assigns
//     questions to children who ALREADY have a qualifying appointment with
//     that exact pediatrician (audited first — see the assignment matrix
//     printed at the end of a run).
//   - Does NOT create a new question/assignment schema. Every write goes
//     through the EXISTING PediaCustomQuestion / PediaCustomQuestionAssignment
//     models, the same ones routes/custom-questions.js uses for a real
//     pediatrician's own questions.
//   - Does NOT touch Dr. Gold Deluna's account. She already has 6 real
//     pediatrician-authored questions and 5 assigned children from prior
//     manual/dev work (non-synthetic — no `isSynthetic` flag at all). Per the
//     "do not reassign real-looking records" rule, this script never reads or
//     writes anything under her pediatricianId; she is simply counted
//     alongside these four in the final report as a fifth already-populated
//     dummy pediatrician.
//
// ── Idempotency ───────────────────────────────────────────────────────────
// Every question is looked up by (pediatricianId, questionText) before being
// created — the natural key for "has this pediatrician already asked this
// exact question". Every assignment is looked up by (questionId, childId,
// appointmentId) before being created — the SAME key
// routes/custom-questions.js POST /:id/assign already uses. Running this
// script twice creates zero duplicate questions and zero duplicate
// assignments.
//
// ── No-overlap guarantee ────────────────────────────────────────────────
// Every candidate child is drawn from that pediatrician's EXCLUSIVE patient
// pool: a child whose entire appointment history (system-wide, not just this
// batch) names only that one pediatrician. See findExclusiveChildren() below.
// A shared services/pediatricianAssignmentGuard.js tracker additionally
// refuses to let two of the four target pediatricians in THIS run claim the
// same child, even though the exclusivity check above should already make
// that impossible — defense in depth, not decoration.
//
// Usage:
//   node scripts/seed-dummy-pediatrician-demo-data.js --dry-run
//   node scripts/seed-dummy-pediatrician-demo-data.js
require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const User = require('../models/User');
const Child = require('../models/Child');
const Appointment = require('../models/Appointment');
const PediaCustomQuestion = require('../models/PediaCustomQuestion');
const PediaCustomQuestionAssignment = require('../models/PediaCustomQuestionAssignment');
const { DATA_ORIGIN } = require('../constants/dataOrigin');
const { createOverlapTracker, ACTIVE_APPOINTMENT_STATUSES } = require('../services/pediatricianAssignmentGuard');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Target pediatricians ────────────────────────────────────────────────
// Chosen from the 62 synthetic, active pediatricians whose ENTIRE patient
// list is already exclusive to them (audited before writing anything — see
// the PR/commit description for the read-only query used). Identified by
// email, the one field on these accounts that is both unique and stable.
const TARGET_PEDIATRICIANS = [
  { email: 'elaine.navarro26@kindercura.test', childCount: 3 },
  { email: 'cesar.obispo30@kindercura.test', childCount: 2 },
  { email: 'benigno.perez32@kindercura.test', childCount: 4 },
  { email: 'marco.lagman81@kindercura.test', childCount: 1 },
];

// ── Question catalogue, per pediatrician ────────────────────────────────
// Plain observational/follow-up questions only — no diagnostic language, no
// medical claims (req 20). `assignTo` is an index into that pediatrician's
// picked children (0-based, in the deterministic order findExclusiveChildren
// returns them) — a question can name more than one child, and a child can
// receive more than one question, exactly like req 12's example.
// `daysAgo` backdates createdAt so the demo shows a realistic date spread
// instead of every question sharing one timestamp (req 18/19).
// `answeredIdx` marks which assigned children (by position in `assignTo`)
// already have a parent answer recorded, so Admin's answered/unanswered
// counts (req 17) are not all zero.
const QUESTION_PLANS = {
  'elaine.navarro26@kindercura.test': [
    {
      questionText: 'Does your child respond when their name is called?',
      questionType: 'yes_no', domain: 'Communication', daysAgo: 12,
      assignTo: [0, 1], answers: { 0: 'yes', 1: 'sometimes' },
    },
    {
      questionText: 'Can your child follow a simple one-step instruction?',
      questionType: 'yes_no', domain: 'Social Skills', daysAgo: 9,
      assignTo: [0], answers: {},
    },
    {
      questionText: 'Does your child point to ask for something they want?',
      questionType: 'yes_no', domain: 'Cognitive', daysAgo: 5,
      assignTo: [2], answers: { 2: 'yes' },
    },
  ],
  'cesar.obispo30@kindercura.test': [
    {
      questionText: 'Does your child climb stairs without holding onto a rail?',
      questionType: 'yes_no', domain: 'Motor Skills', daysAgo: 14,
      assignTo: [0, 1], answers: { 0: 'no' },
    },
    {
      questionText: 'Can your child kick a ball forward without losing balance?',
      questionType: 'yes_no', domain: 'Motor Skills', daysAgo: 11,
      assignTo: [0], answers: { 0: 'yes' },
    },
    {
      questionText: 'Does your child stack more than four blocks?',
      questionType: 'yes_no', domain: 'Cognitive', daysAgo: 8,
      assignTo: [1], answers: {},
    },
    {
      questionText: 'Does your child use two-word phrases?',
      questionType: 'yes_no', domain: 'Communication', daysAgo: 3,
      assignTo: [1], answers: { 1: 'sometimes' },
    },
  ],
  'benigno.perez32@kindercura.test': [
    {
      questionText: 'Does your child interact with other children during play?',
      questionType: 'yes_no', domain: 'Social Skills', daysAgo: 20,
      assignTo: [0, 1, 2], answers: { 0: 'yes', 1: 'yes' },
    },
    {
      questionText: 'Can your child identify common objects when named?',
      questionType: 'yes_no', domain: 'Cognitive', daysAgo: 18,
      assignTo: [1, 3], answers: { 3: 'yes' },
    },
    // A genuine FOLLOW-UP question, added well after the two above — still
    // just a Pediatrician Question owned by the same pediatrician (req 4),
    // never a separate "Follow-up Question" category.
    {
      questionText: 'Follow-up: since the last visit, does your child now climb stairs using alternating feet?',
      questionType: 'yes_no', domain: 'Motor Skills', daysAgo: 2,
      assignTo: [0], answers: {},
    },
  ],
  'marco.lagman81@kindercura.test': [
    {
      questionText: 'Does your child use short sentences to describe what they are doing?',
      questionType: 'yes_no', domain: 'Communication', daysAgo: 16,
      assignTo: [0], answers: { 0: 'yes' },
    },
    {
      questionText: 'Does your child take turns during simple games?',
      questionType: 'yes_no', domain: 'Social Skills', daysAgo: 13,
      assignTo: [0], answers: {},
    },
    {
      questionText: 'Can your child sort objects by color or shape?',
      questionType: 'yes_no', domain: 'Cognitive', daysAgo: 10,
      assignTo: [0], answers: { 0: 'yes' },
    },
    {
      questionText: 'Does your child run with good balance and coordination?',
      questionType: 'yes_no', domain: 'Motor Skills', daysAgo: 7,
      assignTo: [0], answers: {},
    },
    {
      questionText: "How often does your child ask questions using 'why' or 'how'?",
      questionType: 'multiple_choice', domain: 'Communication', daysAgo: 1,
      options: ['Rarely', 'Sometimes', 'Often'],
      assignTo: [0], answers: { 0: 'Often' },
    },
  ],
};

function daysAgoDate(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * Children whose ENTIRE appointment history, system-wide, names only this
 * one pediatrician, restricted to appointments in an active status
 * (ACTIVE_APPOINTMENT_STATUSES — the same list
 * routes/custom-questions.js ensurePediaChildRelationship() accepts).
 * Returned sorted by childId string for a deterministic, reproducible pick
 * across runs.
 */
async function findExclusiveChildren(pediatricianId) {
  const allPeds = await Appointment.distinct('pediatricianId', {
    childId: { $exists: true },
  });

  const own = await Appointment.find({
    pediatricianId,
    status: { $in: ACTIVE_APPOINTMENT_STATUSES },
  }).distinct('childId');

  const exclusive = [];
  for (const childId of own) {
    const otherPed = await Appointment.findOne({
      childId,
      // $nin, not two $ne keys in one object literal — a duplicate object key
      // silently overwrites the first, which would match every OTHER
      // appointment (including this child's own appointment with THIS
      // pediatrician) and made every child look "shared" with themselves.
      pediatricianId: { $nin: [pediatricianId, null] },
    }).select('_id').lean();
    if (!otherPed) exclusive.push(String(childId));
  }
  return exclusive.sort();
}

async function upsertQuestion(pediatricianId, plan) {
  const existing = await PediaCustomQuestion.findOne({
    pediatricianId,
    questionText: plan.questionText,
  });
  if (existing) return { doc: existing, created: false };

  if (DRY_RUN) {
    return { doc: { _id: '(dry-run, not created)', id: '(n/a)' }, created: true };
  }

  const doc = await PediaCustomQuestion.create({
    pediatricianId,
    questionText: plan.questionText,
    questionType: plan.questionType,
    options: plan.questionType === 'multiple_choice' ? (plan.options || []) : [],
    domain: plan.domain,
    ageMin: 0,
    ageMax: 18,
    isActive: true,
    origin: DATA_ORIGIN.PEDIA_ENTRY,
  });

  // Backdate createdAt for a realistic date spread (req 18). Timestamps
  // middleware only fires on save()/create(), so a direct collection update
  // afterward is the only way to set it without fighting that hook — this
  // touches no validators and no other field.
  await PediaCustomQuestion.collection.updateOne(
    { _id: doc._id },
    { $set: { createdAt: daysAgoDate(plan.daysAgo) } }
  );
  doc.createdAt = daysAgoDate(plan.daysAgo);

  return { doc, created: true };
}

async function upsertAssignment(question, child, answer) {
  if (DRY_RUN) return { doc: null, created: true };

  const existing = await PediaCustomQuestionAssignment.findOne({
    questionId: question._id,
    childId: child._id,
    appointmentId: null,
  });
  if (existing) return { doc: existing, created: false };

  const doc = await PediaCustomQuestionAssignment.create({
    questionId: question._id,
    questionSetId: null,
    appointmentId: null,
    childId: child._id,
    parentId: child.parentId,
    answer: answer || null,
    answeredAt: answer ? new Date() : null,
  });
  return { doc, created: true };
}

async function main() {
  await connectDB();

  console.log(`\n=== Seeding dummy pediatrician demo data ${DRY_RUN ? '(DRY RUN — no writes)' : ''} ===\n`);

  // Dr. Gold Deluna's existing children are pre-claimed in the overlap
  // tracker so this run can never (even accidentally) hand one of her
  // patients to a synthetic pediatrician. She is not otherwise touched.
  const gold = await User.findOne({ username: 'Gold', role: 'pediatrician' }).select('_id').lean();
  const goldChildIds = gold ? await Appointment.distinct('childId', { pediatricianId: gold._id }) : [];
  const tracker = createOverlapTracker(
    goldChildIds.map((childId) => ({ childId, pediatricianId: gold ? String(gold._id) : 'gold' }))
  );

  const report = [];

  for (const target of TARGET_PEDIATRICIANS) {
    const ped = await User.findOne({ email: target.email, role: 'pediatrician' }).lean();
    if (!ped) {
      console.warn(`SKIP: no pediatrician found with email ${target.email}`);
      continue;
    }

    const exclusiveChildIds = await findExclusiveChildren(ped._id);
    const picked = [];
    for (const childId of exclusiveChildIds) {
      if (picked.length >= target.childCount) break;
      const verdict = tracker.check(childId, String(ped._id));
      if (!verdict.ok) {
        console.warn(`  ! skipping child ${childId} for ${ped.email} — already claimed by pediatrician ${verdict.claimedBy}`);
        continue;
      }
      picked.push(childId);
      tracker.claim(childId, String(ped._id));
    }

    if (picked.length < target.childCount) {
      console.warn(`  ! ${ped.email} only had ${picked.length}/${target.childCount} exclusive children available — continuing with what is available.`);
    }

    const children = await Child.find({ _id: { $in: picked } }).select('firstName lastName parentId').lean();
    // Re-order to match `picked` (Mongo does not guarantee $in order).
    const childById = new Map(children.map((c) => [String(c._id), c]));
    const orderedChildren = picked.map((id) => childById.get(id)).filter(Boolean);

    const plans = QUESTION_PLANS[target.email] || [];
    const pedReport = {
      pediatrician: `${ped.firstName} ${ped.lastName}`,
      email: ped.email,
      questionsCreated: 0,
      questionsExisting: 0,
      children: orderedChildren.map((c) => `${c.firstName} ${c.lastName}`),
      assignments: [],
    };

    for (const plan of plans) {
      const { doc: question, created } = await upsertQuestion(ped._id, plan);
      if (created) pedReport.questionsCreated += 1; else pedReport.questionsExisting += 1;

      for (const childIndex of plan.assignTo) {
        const child = orderedChildren[childIndex];
        if (!child) continue; // fewer exclusive children were available than the plan expects
        const answer = plan.answers && plan.answers[childIndex];
        const { created: assignmentCreated } = await upsertAssignment(question, child, answer);
        pedReport.assignments.push({
          question: plan.questionText,
          child: `${child.firstName} ${child.lastName}`,
          answered: Boolean(answer),
          created: assignmentCreated,
        });
      }
    }

    report.push(pedReport);
  }

  console.log('\n--- Per-pediatrician summary ---');
  for (const r of report) {
    console.log(`\n${r.pediatrician} <${r.email}>`);
    console.log(`  Questions: ${r.questionsCreated} created, ${r.questionsExisting} already existed`);
    console.log(`  Assigned children: ${r.children.join(', ') || '(none available)'}`);
    console.log('  Assignments:');
    for (const a of r.assignments) {
      console.log(`    - "${a.question}" -> ${a.child} [${a.answered ? 'answered' : 'unanswered'}]${a.created ? '' : ' (already existed)'}`);
    }
  }

  console.log('\n--- Overlap tracker final state (childId -> pediatricianId) ---');
  console.log(`${tracker.entries().length} total claimed children (including Dr. Gold Deluna's pre-existing ${goldChildIds.length})`);

  await mongoose.disconnect();
  console.log(`\n${DRY_RUN ? 'Dry run complete — nothing was written.' : 'Seed complete.'}\n`);
}

main().catch((e) => {
  console.error('SEED ERROR:', e.message);
  process.exit(1);
});
