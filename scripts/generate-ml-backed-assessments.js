// scripts/generate-ml-backed-assessments.js
// ============================================================================
// OPTIONAL BATCH — synthetic completed screenings that carry a REAL Model v4
// prediction, because they are submitted through the LIVE application flow.
//
// This exists because every one of the 1,187 screenings in the demo-2026 batch
// was written directly to MongoDB and therefore carries a rule_based
// prediction with riskCategory null. They demonstrate scoring; they do not
// demonstrate the ML model. This batch does.
//
// ---------------------------------------------------------------------------
// WHY IT GOES OVER HTTP AND NOT STRAIGHT INTO MONGO
// ---------------------------------------------------------------------------
// The whole point is that the prediction is genuine. Writing a result document
// with prediction.source:'ml' by hand would be a fabricated claim — exactly
// what this project has avoided everywhere else. So each case is POSTed to the
// real endpoints:
//
//     POST /api/assessments/initialize   creates the Assessment
//     POST /api/assessments/submit       stores answers, scores them with the
//                                        live formula, calls the ACTIVE model
//                                        through services/assessmentProgress.js
//                                        buildPredictionForStorage(), and
//                                        writes the AssessmentResult
//
// Nothing in this script computes a score or a prediction. If v4 is active and
// compatible, the stored result carries source:'ml', modelVersion:4, a real
// riskCategory and real probabilities — because the application put them
// there, not because this script did.
//
// ---------------------------------------------------------------------------
// THE ONE THING THE LIVE FLOW CANNOT DO
// ---------------------------------------------------------------------------
// POST /submit does not know what synthetic data is — it has no isSynthetic
// handling at all (verified: zero references in the handler). Records born
// through it are therefore UNMARKED, which would make them indistinguishable
// from real patient data and unreachable by the purge path.
//
// So each case is marked immediately after its submit returns: isSynthetic and
// syntheticBatch are set on the assessment, the result and the answers. That
// write adds the two marker fields and touches NOTHING the application
// computed — no score, no band, no prediction field is read or rewritten.
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT TOUCH
// ---------------------------------------------------------------------------
//   * demo-2026 — different batch label, so every derived _id is disjoint.
//   * users — reuses EXISTING synthetic guardians. No account is created or
//     modified, so the 1,500-user figure the adviser requirement rests on is
//     unchanged.
//   * real users, real children, the 50k dataset, trained_models — never
//     written, never read for writing.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   node scripts/generate-ml-backed-assessments.js --dry-run
//   node scripts/generate-ml-backed-assessments.js --execute --yes
//
//   --cases=N        how many assessments (default 500)
//   --seed=N         PRNG seed (default 20260904)
//   --batch=LABEL    batch label (default demo-ml-2026)
//   --url=URL        base URL of a RUNNING KinderCura server (default http://localhost:3001)
//   --dry-run        plan and report; writes nothing (the default posture)
//   --execute        actually run the batch (requires --yes)
//   --yes            confirm
//   --sample=N       predictions to run during a dry run to estimate the risk
//                    mix and per-case cost (default 40)
// ============================================================================

require('dotenv').config();

const jwt = require('jsonwebtoken');
const { connectDB, mongoose } = require('../db');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const TrainedModel = require('../models/TrainedModel');

const modelManager = require('../ml/model_manager');
const { DATA_ORIGIN } = require('../constants/dataOrigin');
const { syntheticObjectId } = require('../constants/syntheticData');
const { Rng, SCORED_DOMAINS } = require('./generate-system-demo-data');

const DEFAULTS = Object.freeze({
  cases: 500,
  seed: 20260904,
  batch: 'demo-ml-2026',
  url: 'http://localhost:3001',
  sample: 40,
});

// Children are born so they are 36-95 months old at submission. That window is
// the intersection of two independent gates, and missing either one fails:
//   * routes/assessments.js getAgeInfo() rejects anything outside 3-8 years,
//     so POST /initialize would 400.
//   * the core bank's minAgeMonths runs 36..84, so below 36 months a child is
//     administered ZERO questions and every domain scores 0.
// The demo-2026 batch has 37 results for children under 36 months precisely
// because it wrote scores directly and never passed through that gate.
const MIN_AGE_MONTHS = 36;
const MAX_AGE_MONTHS = 95;

// Same profile mix the demo-2026 batch uses, so the two batches are
// distributionally comparable rather than arbitrarily different.
const PROFILE_MIX = [
  { value: 'typical', share: 0.62 },
  { value: 'watch', share: 0.26 },
  { value: 'concern', share: 0.12 },
];
const ANSWER_PROBS = {
  typical: { yes: 0.78, sometimes: 0.16, no: 0.06 },
  watch: { yes: 0.48, sometimes: 0.32, no: 0.20 },
  concern: { yes: 0.22, sometimes: 0.28, no: 0.50 },
};

const CHILD_FIRST_F = ['Althea', 'Bea', 'Cara', 'Dana', 'Ella', 'Faith', 'Gia', 'Hana', 'Iris', 'Jena', 'Kaia', 'Lia', 'Mira', 'Nia', 'Ora', 'Pia', 'Rina', 'Sam', 'Tala', 'Uma'];
const CHILD_FIRST_M = ['Aldo', 'Beno', 'Caleb', 'Dino', 'Elio', 'Finn', 'Gabo', 'Hugo', 'Ivo', 'Jem', 'Kip', 'Luca', 'Milo', 'Nico', 'Otto', 'Pio', 'Rex', 'Silas', 'Theo', 'Uri'];

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] === undefined) flags.add(m[1]);
    else opts[m[1]] = m[2];
  }
  const int = (k, d) => (opts[k] === undefined ? d : Math.max(0, Math.floor(Number(opts[k]))));
  return {
    cases: int('cases', DEFAULTS.cases),
    seed: int('seed', DEFAULTS.seed),
    sample: int('sample', DEFAULTS.sample),
    batch: String(opts.batch || DEFAULTS.batch).trim() || DEFAULTS.batch,
    url: String(opts.url || DEFAULTS.url).replace(/\/+$/, ''),
    execute: flags.has('execute'),
    confirmed: flags.has('yes'),
    dryRun: !flags.has('execute'),
  };
}

/** Questions the live bank administers to a child of `ageMonths`. */
function administeredQuestions(bank, ageMonths) {
  return bank.filter((q) => ageMonths >= q.minAgeMonths);
}

/** One simulated answer set, in the shape POST /submit expects. */
function buildAnswers(rng, profile, questions) {
  const p = ANSWER_PROBS[profile];
  return questions.map((q) => {
    const roll = rng.float();
    const answer = roll < p.yes ? 'yes' : (roll < p.yes + p.sometimes ? 'sometimes' : 'no');
    return { questionId: q.questionId, domain: q.domain, questionText: q.text || '', answer };
  });
}

/**
 * Build the full plan. Pure with respect to the database except for the
 * parent list it is handed, so --dry-run is a genuine preview.
 */
function buildPlan({ seed, cases, batch, guardians, bank, now }) {
  const rng = new Rng(seed);
  const planned = [];
  for (let i = 0; i < cases; i += 1) {
    // Each case gets its own guardian where possible, so the batch reads as
    // "500 different families came back", not "one parent screened 500 times".
    const guardian = guardians[i % guardians.length];
    const ageMonths = rng.int(MIN_AGE_MONTHS, MAX_AGE_MONTHS);
    const dob = new Date(now.getFullYear(), now.getMonth() - ageMonths, rng.int(1, 28));
    const isFemale = rng.chance(0.5);
    const profile = rng.weighted(PROFILE_MIX);
    const questions = administeredQuestions(bank, ageMonths);
    planned.push({
      index: i,
      childId: syntheticObjectId(batch, `child:${i}`),
      parentId: guardian._id,
      parentUsername: guardian.username,
      firstName: rng.pick(isFemale ? CHILD_FIRST_F : CHILD_FIRST_M),
      lastName: guardian.lastName,
      gender: isFemale ? 'female' : 'male',
      dateOfBirth: dob,
      ageMonths,
      profile,
      questionCount: questions.length,
      answers: buildAnswers(rng, profile, questions),
    });
  }
  return planned;
}

function histogram(values, buckets) {
  const out = {};
  buckets.forEach(([label, lo, hi]) => { out[label] = values.filter((v) => v >= lo && v <= hi).length; });
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('KinderCura — ML-backed synthetic assessment batch');
  console.log(args.dryRun ? 'MODE: DRY RUN (nothing will be written)\n' : 'MODE: EXECUTE\n');

  await connectDB();
  try {
    // ── Preconditions ─────────────────────────────────────────────────────
    console.log('='.repeat(74));
    console.log('PRECONDITIONS');
    console.log('='.repeat(74));

    const active = await TrainedModel.findOne({ isActive: true, status: 'completed' }).lean();
    if (!active) throw new Error('No active completed model. A batch run now would store rule_based predictions, defeating the purpose.');
    const compatible = modelManager.isModelCompatible(active);
    console.log(`  active model            v${active.version} (acc ${active.accuracy})`);
    console.log(`  compatible with predict ${compatible}`);
    if (!compatible) throw new Error(`Model v${active.version} is incompatible; predictions would silently fall back to rule_based.`);

    const smoke = await modelManager.smokeTestModel(active);
    console.log(`  smoke test              ${smoke.ok ? 'PASS' : 'FAIL — ' + smoke.error}`);
    if (!smoke.ok) throw new Error('Active model failed its smoke test; refusing to plan a batch against it.');

    const bank = await CoreBankQuestion.find({ origin: DATA_ORIGIN.CORE_BANK, isActive: true })
      .select('questionId text domain minAgeMonths').sort({ minAgeMonths: 1, questionId: 1 }).lean();
    console.log(`  live question bank      ${bank.length} active core-bank questions (gates ${Math.min(...bank.map((q) => q.minAgeMonths))}-${Math.max(...bank.map((q) => q.minAgeMonths))} months)`);

    // Existing synthetic guardians — reused, never modified.
    const guardians = await User.find({
      isSynthetic: true,
      role: { $in: ['parent', 'legal_guardian', 'foster_parent', 'court_appointed'] },
      status: 'active',
    }).select('_id username lastName role').sort({ username: 1 }).lean();
    console.log(`  reusable synthetic guardians (active) ${guardians.length}`);
    if (guardians.length < 1) throw new Error('No synthetic guardians available to own the new children.');

    const now = new Date();
    const plan = buildPlan({ seed: args.seed, cases: args.cases, batch: args.batch, guardians, bank, now });

    // ── Collision checks ──────────────────────────────────────────────────
    console.log('\n' + '='.repeat(74));
    console.log('COLLISION / SAFETY CHECKS');
    console.log('='.repeat(74));
    const childIds = plan.map((p) => p.childId);
    const existingChildren = await Child.countDocuments({ _id: { $in: childIds } });
    const uniqueIds = new Set(childIds.map(String)).size;
    console.log(`  planned child _ids                 ${childIds.length} (${uniqueIds} unique)`);
    console.log(`  already present in the database    ${existingChildren}  ${existingChildren === 0 ? '(no collision)' : '(COLLISION)'}`);
    const batchesInUse = await User.distinct('syntheticBatch', { isSynthetic: true });
    console.log(`  batch label "${args.batch}"        ${batchesInUse.includes(args.batch) ? 'ALREADY IN USE' : 'free'} (existing: ${JSON.stringify(batchesInUse)})`);
    const demo2026Children = await Child.countDocuments({ isSynthetic: true, syntheticBatch: 'demo-2026' });
    console.log(`  demo-2026 children (must not move) ${demo2026Children}`);
    const parentsUsed = new Set(plan.map((p) => String(p.parentId))).size;
    console.log(`  distinct existing parents reused   ${parentsUsed} of ${guardians.length} (read-only; none modified)`);

    // ── Plan summary ──────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(74));
    console.log('WHAT WOULD BE CREATED');
    console.log('='.repeat(74));
    const totalAnswers = plan.reduce((s, p) => s + p.questionCount, 0);
    console.log(`  new users                    0   (existing synthetic parents are reused)`);
    console.log(`  new children                 ${plan.length}`);
    console.log(`  new assessments              ${plan.length}   (1 per child)`);
    console.log(`  new assessment results       ${plan.length}   (1 per assessment, enforced by a unique index)`);
    console.log(`  new assessment answers       ${totalAnswers}   (written by POST /submit — the live flow requires them)`);
    console.log(`  new recommendations          0   (generated lazily on first view, not by submit)`);
    console.log(`  new appointments             0`);

    const ages = plan.map((p) => p.ageMonths);
    console.log('\n  child age distribution (months at submission):');
    const ageHist = histogram(ages, [['36-47', 36, 47], ['48-59', 48, 59], ['60-71', 60, 71], ['72-83', 72, 83], ['84-95', 84, 95]]);
    Object.entries(ageHist).forEach(([k, v]) => console.log(`    ${k}  ${String(v).padStart(4)}  ${'#'.repeat(Math.round((v / plan.length) * 40))}`));
    console.log(`    min ${Math.min(...ages)} / max ${Math.max(...ages)} months — all inside getAgeInfo()'s 3-8 year gate`);

    const qCounts = plan.map((p) => p.questionCount);
    console.log('\n  questions per assessment (from the LIVE bank, age-gated):');
    console.log(`    min ${Math.min(...qCounts)} / max ${Math.max(...qCounts)} / mean ${(qCounts.reduce((a, b) => a + b, 0) / qCounts.length).toFixed(1)}`);
    const outOfGate = plan.filter((p) => p.answers.some((a) => {
      const q = bank.find((b) => b.questionId === a.questionId);
      return !q || p.ageMonths < q.minAgeMonths;
    })).length;
    console.log(`    assessments containing an out-of-age-gate question: ${outOfGate}  ${outOfGate === 0 ? '(none — correct)' : '(BUG)'}`);

    const profiles = {};
    plan.forEach((p) => { profiles[p.profile] = (profiles[p.profile] || 0) + 1; });
    console.log(`\n  developmental profile mix: ${Object.entries(profiles).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

    // ── Sampled predictions ───────────────────────────────────────────────
    // Runs the REAL v4 artifact on a sample of the planned answer sets to
    // estimate the risk mix and measure the per-case cost. Read-only: it
    // predicts, it does not store.
    if (args.sample > 0) {
      console.log('\n' + '='.repeat(74));
      console.log(`SAMPLED v4 PREDICTIONS (${args.sample} cases, read-only — nothing stored)`);
      console.log('='.repeat(74));
      const dist = {};
      let totalMs = 0;
      const step = Math.max(1, Math.floor(plan.length / args.sample));
      let done = 0;
      for (let i = 0; i < plan.length && done < args.sample; i += step) {
        const p = plan[i];
        // Score the planned answers with the live formula so the probe matches
        // what POST /submit would actually hand the model.
        const totals = {};
        SCORED_DOMAINS.forEach((d) => { totals[d] = { earned: 0, total: 0 }; });
        for (const a of p.answers) {
          if (!totals[a.domain]) continue;
          totals[a.domain].total += 2;
          totals[a.domain].earned += a.answer === 'yes' ? 2 : (a.answer === 'sometimes' ? 1 : 0);
        }
        const pct = (d) => (totals[d].total ? Math.round((totals[d].earned / totals[d].total) * 100) : 0);
        const scores = {
          communication_score: pct('Communication'),
          social_score: pct('Social Skills'),
          cognitive_score: pct('Cognitive'),
          motor_score: pct('Motor Skills'),
          age_months: p.ageMonths,
        };
        scores.overall_score = Math.round((scores.communication_score + scores.social_score + scores.cognitive_score + scores.motor_score) / 4);
        const t0 = Date.now();
        const pred = await modelManager.getPrediction(active.modelPath, scores);
        totalMs += Date.now() - t0;
        dist[pred.risk_category] = (dist[pred.risk_category] || 0) + 1;
        done += 1;
        process.stdout.write(`   sampled ${done}/${args.sample}\r`);
      }
      const avgMs = totalMs / done;
      console.log(`   sampled ${done}/${args.sample}          `);
      console.log(`\n  risk-category mix (estimated from ${done} real v4 predictions):`);
      Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
        const pctv = ((v / done) * 100).toFixed(1);
        console.log(`    ${String(k).padEnd(8)} ${String(v).padStart(3)}  ${pctv.padStart(5)}%   -> ~${Math.round((v / done) * plan.length)} of ${plan.length}`);
      });
      console.log(`\n  measured cost per prediction: ${avgMs.toFixed(0)} ms (Python spawn dominates)`);
      const perCase = avgMs + 250; // + HTTP, scoring, 4 DB writes, marking pass
      console.log(`  estimated per case (predict + HTTP + writes): ~${perCase.toFixed(0)} ms`);
      console.log(`  ESTIMATED RUNTIME for ${plan.length} cases: ~${Math.round((perCase * plan.length) / 60000)} minutes`);
    }

    // ── Collections ───────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(74));
    console.log('COLLECTIONS');
    console.log('='.repeat(74));
    console.log('  WRITTEN:    children · assessments · results · assessment_answers');
    console.log('  UNTOUCHED:  users · payments · recommendations · appointments ·');
    console.log('              training_datasets · trained_models · core_bank_questions ·');
    console.log('              notifications · everything else');

    console.log('\n' + '='.repeat(74));
    console.log('EFFECT ON ADMIN ANALYTICS (all figures are unfiltered counts)');
    console.log('='.repeat(74));
    const [u, c, a, r] = await Promise.all([
      User.countDocuments(), Child.countDocuments(), Assessment.countDocuments(), AssessmentResult.countDocuments(),
    ]);
    console.log(`  Total Users            ${u}      -> ${u}        (unchanged)`);
    console.log(`  Total Children         ${c}   -> ${c + plan.length}`);
    console.log(`  Total Assessments      ${a}   -> ${a + plan.length}`);
    console.log(`  Completed Screenings   ${await Assessment.countDocuments({ status: 'complete' })}   -> +${plan.length}`);
    console.log(`  Results (score avg)    ${r}   -> ${r + plan.length}   (averages will shift toward this batch)`);
    console.log(`  Monthly Signups        unchanged — no user is created`);
    const answersNow = await AssessmentAnswer.countDocuments();
    console.log(`  Question Origin page   ${answersNow} answers -> ${answersNow + totalAnswers}  <-- "Times Answered" rises sharply`);

    if (args.dryRun) {
      console.log('\n--dry-run: nothing was written.\n');
      console.log('Real run (server must be running, v4 active):');
      console.log(`  node scripts/generate-ml-backed-assessments.js --cases=${args.cases} --batch=${args.batch} --execute --yes`);
      return;
    }

    if (!args.confirmed) {
      console.error('\nRefusing to execute without --yes.');
      process.exitCode = 1;
      return;
    }
    throw new Error('Execute mode is intentionally not wired up yet — this change was delivered as a dry-run design only.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
}

module.exports = { buildPlan, administeredQuestions, parseArgs, MIN_AGE_MONTHS, MAX_AGE_MONTHS };
