// scripts/generate-system-demo-data.js
// ============================================================================
// REQUIREMENT A — synthetic KinderCura SYSTEM data.
//
// Generates 1,000+ synthetic user accounts and the related application records
// (children, assessments, results, appointments, optionally answers) inside the
// NORMAL KinderCura collections, so the EXISTING Admin Analytics page has
// enough real documents to aggregate. Nothing here is displayed by a special
// code path: /api/admin/analytics keeps doing the same $group/$avg/countDocuments
// it always did, over the documents this script writes.
//
// This is NOT the ML training dataset. That is REQUIREMENT B — a flat CSV of
// ~50,000 rows produced by ml/pipeline.py, which never becomes user accounts.
// See docs/synthetic-data-and-model-pipeline.md.
//
// ---------------------------------------------------------------------------
// SAFETY — this script writes to the same Atlas database production uses
// ---------------------------------------------------------------------------
//   * Every document it writes carries isSynthetic:true + syntheticBatch.
//   * Every _id is DERIVED from a namespaced hash (constants/syntheticData.js),
//     so a second run UPSERTS the same documents. Running it twice does not
//     double the data.
//   * Before each write phase it verifies that no _id it is about to write
//     already belongs to a non-synthetic document, and aborts if one does.
//   * --purge deletes on { isSynthetic: true } and nothing else. It is
//     structurally incapable of reaching a real record.
//   * It never updates, deletes or reads-for-writing any real document.
//
// ---------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT FABRICATE
// ---------------------------------------------------------------------------
//   * No admin accounts. The role exists; synthetic data never creates one.
//   * No clinical judgements. clinicalOutcome, mlLabel, mlReviewStatus,
//     diagnosis and reviewedByPediatrician are left at their defaults, so a
//     synthetic screening can NEVER be exported as reviewed training data by
//     GET /api/admin/training/reviewed-assessments/export.
//   * No Payment documents. Synthetic appointments record what they were
//     BILLED (totalAmount, from the pediatrician's consultationFee) and stay
//     Unpaid, because no money actually moved. Analytics' "total collected"
//     therefore keeps reflecting real payments only.
//   * No login-capable passwords by default. Accounts get a bcrypt hash of a
//     discarded random secret, so they cannot be signed into. Pass
//     --demo-password=<pw> if the team needs to demo a synthetic login.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   node scripts/generate-system-demo-data.js --dry-run
//   node scripts/generate-system-demo-data.js --users=1500
//   node scripts/generate-system-demo-data.js --users=1500 --with-answers
//   node scripts/generate-system-demo-data.js --verify
//   node scripts/generate-system-demo-data.js --purge --yes
//
// Options
//   --users=N           how many synthetic accounts to generate (default 1500)
//   --seed=N            PRNG seed; same seed => byte-identical plan (default 20260903)
//   --batch=LABEL       batch label stored on every document (default demo-2026)
//   --months=N          spread signups over the last N months (default 12)
//   --with-answers      also write per-question AssessmentAnswer rows (see below)
//   --demo-password=PW  make the synthetic accounts loginable with PW
//   --now=ISO           pin the clock signup dates are placed relative to.
//                       Required to reproduce an EXISTING batch byte-for-byte;
//                       omit it when generating a fresh one.
//                       The live demo-2026 batch was generated at
//                       --now=2026-09-03T01:49:44.495Z
//   --dry-run           plan and report, write nothing
//   --verify            report synthetic vs real counts, write nothing
//   --purge             delete synthetic documents (requires --yes). Removes
//                       EVERY synthetic batch unless --batch is given, in which
//                       case it removes only that one.
//   --yes               confirm a destructive purge
//
// BATCHES are independent datasets. The batch label is part of every derived
// _id, username, email and appointment id, so two batches can coexist and be
// purged separately. Generating batch B never touches batch A's documents.
//
// --with-answers is OPT-IN on purpose. The Question Origin page
// (ADMIN/admin-data-sources.html) reports how many times each question has
// actually been answered; writing tens of thousands of synthetic answers would
// make that page describe demo traffic instead of real usage. The scores stored
// on AssessmentResult are computed from the simulated answers either way, so
// the numbers analytics reports are identical with or without this flag — the
// flag only decides whether the individual answer rows are persisted.
// ============================================================================

require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const { connectDB, mongoose } = require('../db');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const AssessmentAnswer = require('../models/AssessmentAnswer');
const Appointment = require('../models/Appointment');
const CoreBankQuestion = require('../models/CoreBankQuestion');

const scoring = require('../constants/scoring');
const staging = require('../constants/developmental-staging');
const { DATA_ORIGIN } = require('../constants/dataOrigin');
const {
  DEFAULT_SYNTHETIC_BATCH,
  syntheticOnlyFilter,
  syntheticObjectId,
  assertNoRealCollisions,
  syntheticAppointmentId,
  assertAppointmentIdsAvailable,
} = require('../constants/syntheticData');
const {
  buildSyntheticIdentities,
  syntheticPediatricianBio,
} = require('../constants/syntheticIdentity');

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  users: 1500,
  seed: 20260903,
  batch: DEFAULT_SYNTHETIC_BATCH,
  months: 12,
});

// Role mix. Deliberately clinic-shaped: overwhelmingly guardians, a realistic
// professional minority, and ZERO admins (the adviser asked for demo volume,
// not for a database full of privileged accounts).
const ROLE_MIX = Object.freeze([
  { role: 'parent', share: 0.810 },
  { role: 'legal_guardian', share: 0.070 },
  { role: 'foster_parent', share: 0.030 },
  { role: 'court_appointed', share: 0.020 },
  { role: 'pediatrician', share: 0.045 },
  { role: 'secretary', share: 0.025 },
]);

// Roles that can own a Child record — i.e. the caregiver roles the parent
// portal is built for. Mirrors how routes/children.js treats account owners.
const GUARDIAN_ROLES = Object.freeze(['parent', 'legal_guardian', 'foster_parent', 'court_appointed']);

// Account status mix. 'pending' and 'suspended' exist in the real schema and
// the admin Users page filters on them, so demo data has to contain some.
const STATUS_MIX = Object.freeze([
  { value: 'active', share: 0.88 },
  { value: 'pending', share: 0.08 },
  { value: 'suspended', share: 0.04 },
]);

const PRC_STATUS_MIX = Object.freeze([
  { value: 'verified', share: 0.80 },
  { value: 'pending', share: 0.15 },
  { value: 'rejected', share: 0.05 },
]);

const APPOINTMENT_STATUS_MIX = Object.freeze([
  { value: 'completed', share: 0.38 },
  { value: 'approved', share: 0.25 },
  { value: 'pending', share: 0.20 },
  { value: 'cancelled', share: 0.11 },
  { value: 'rejected', share: 0.06 },
]);

const ASSESSMENT_STATUS_MIX = Object.freeze([
  { value: 'complete', share: 0.72 },
  { value: 'in_progress', share: 0.18 },
  { value: 'submitted', share: 0.10 },
]);

// Developmental profile of a synthetic child, expressed as the probability of
// each answer value. These are the ONLY place a "how well is this child doing"
// assumption lives; the domain/overall percentages are then computed with the
// exact same arithmetic routes/assessments.js POST /submit uses, and banded by
// constants/scoring.js. Deliberately overlapping, so the resulting score
// distribution is a spread rather than three separable clumps.
const CHILD_PROFILE_MIX = Object.freeze([
  { value: 'typical', share: 0.62 },
  { value: 'watch', share: 0.26 },
  { value: 'concern', share: 0.12 },
]);
const ANSWER_PROBS = Object.freeze({
  typical: { yes: 0.78, sometimes: 0.16, no: 0.06 },
  watch: { yes: 0.48, sometimes: 0.32, no: 0.20 },
  concern: { yes: 0.22, sometimes: 0.28, no: 0.50 },
});

// routes/assessments.js scoreAnswer(): yes=2, sometimes=1, anything else=0.
const ANSWER_POINTS = Object.freeze({ yes: 2, sometimes: 1, no: 0 });

// The four scored domain buckets, exactly as routes/assessments.js names them.
const SCORED_DOMAINS = Object.freeze(['Communication', 'Social Skills', 'Cognitive', 'Motor Skills']);

// Name pools. Ordinary Philippine given/family names — realistic enough that
// the admin lists look like a real system, and identifiable as demo data
// because every one of these accounts carries a @synthetic.kindercura.test
// address and isSynthetic:true.
const FIRST_NAMES_F = ['Maria', 'Andrea', 'Sofia', 'Bianca', 'Camille', 'Danica', 'Elaine', 'Fatima', 'Grace', 'Hannah', 'Isabel', 'Jasmine', 'Kristine', 'Lorna', 'Michelle', 'Nadine', 'Olivia', 'Patricia', 'Queenie', 'Rowena', 'Sarah', 'Trisha', 'Ursula', 'Vanessa', 'Wilma', 'Ximena', 'Yolanda', 'Zenaida', 'Angelica', 'Beatriz'];
const FIRST_NAMES_M = ['Jose', 'Antonio', 'Carlo', 'Daniel', 'Emilio', 'Francis', 'Gabriel', 'Hector', 'Ignacio', 'Julius', 'Kevin', 'Lorenzo', 'Marco', 'Nathan', 'Oscar', 'Paulo', 'Quirino', 'Rafael', 'Samuel', 'Teodoro', 'Ulysses', 'Vicente', 'Wilfredo', 'Xavier', 'Yusuf', 'Zacarias', 'Alfonso', 'Benigno', 'Cristian', 'Dominic'];
const LAST_NAMES = ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Ocampo', 'Garcia', 'Mendoza', 'Torres', 'Tomas', 'Andrada', 'Castillo', 'Flores', 'Villanueva', 'Ramos', 'Aquino', 'Del Rosario', 'Gonzales', 'Fernandez', 'Rivera', 'Navarro', 'Domingo', 'Salazar', 'Alvarez', 'Pascual', 'Marquez', 'Ibarra', 'Lucero', 'Espiritu', 'Manalo', 'Sarmiento'];

const SPECIALIZATIONS = ['General Pediatrics', 'Developmental Pediatrics', 'Neonatology', 'Pediatric Neurology', 'Adolescent Medicine'];
const CLINIC_SUFFIX = ['Children\'s Clinic', 'Pediatric Center', 'Family Health Clinic', 'Wellness Center', 'Medical Clinic'];
const CITIES = ['Iloilo City', 'Bacolod City', 'Cebu City', 'Davao City', 'Quezon City', 'Cagayan de Oro', 'Baguio City', 'Legazpi City'];

const APPOINTMENT_REASONS = [
  'Developmental screening follow-up',
  'Routine well-child check-up',
  'Discuss screening results',
  'Speech and language concern',
  'Motor development concern',
  'Behavioural consultation',
  'Re-assessment consultation',
];

// ── Deterministic randomness ────────────────────────────────────────────────
// mulberry32: a small, fast, well-distributed PRNG. Used instead of Math.random
// so the same --seed always produces the same plan — that is what makes the
// whole dataset reproducible and reviewable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }

  /** Uniform float in [0, 1). */
  float() {
    return this.next();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform element of arr. */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /**
   * Pick from [{ value, share }] using the shares as weights. Shares need not
   * sum to exactly 1 — the last entry absorbs any rounding remainder, so a
   * mix table can be edited without recomputing the others.
   */
  weighted(mix) {
    const roll = this.next();
    let acc = 0;
    for (const entry of mix) {
      acc += entry.share;
      if (roll < acc) return entry.value ?? entry.role;
    }
    const last = mix[mix.length - 1];
    return last.value ?? last.role;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] === undefined) flags.add(m[1]);
    else opts[m[1]] = m[2];
  }
  const intOpt = (name, fallback) => {
    if (opts[name] === undefined) return fallback;
    const n = Number(opts[name]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number.`);
    return Math.floor(n);
  };
  return {
    users: intOpt('users', DEFAULTS.users),
    seed: intOpt('seed', DEFAULTS.seed),
    months: Math.max(1, intOpt('months', DEFAULTS.months)),
    batch: String(opts.batch || DEFAULTS.batch).trim() || DEFAULTS.batch,
    // Whether --batch was actually TYPED, as distinct from having defaulted.
    // --purge uses this to decide its scope: with no --batch it removes every
    // synthetic document (what "purge the demo data" means to a reader), and
    // with an explicit --batch it removes only that batch. Without this
    // distinction the default batch label silently narrowed every purge, so
    // `--purge --yes` left other batches behind while reporting success.
    batchExplicit: Object.prototype.hasOwnProperty.call(opts, 'batch'),
    demoPassword: opts['demo-password'] || null,
    // Pins the clock buildPlan() places signups relative to. Omitted, it is
    // new Date() — fine for a fresh batch, but it means "same seed" alone does
    // NOT reproduce a historical batch's createdAt values (pickSignupDate
    // anchors months on `now`, and clamps future dates to `now - k hours`).
    // Pass --now to reproduce an existing batch exactly.
    now: (() => {
      if (!opts.now) return null;
      const d = new Date(opts.now);
      if (Number.isNaN(d.getTime())) throw new Error(`--now="${opts.now}" is not a valid date.`);
      return d;
    })(),
    withAnswers: flags.has('with-answers'),
    dryRun: flags.has('dry-run'),
    verify: flags.has('verify'),
    purge: flags.has('purge'),
    confirmed: flags.has('yes'),
  };
}

// ── Date helpers ────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A signup timestamp inside the last `months` months, biased toward recent
 * months so the Admin Analytics "Monthly Signups" line shows growth rather
 * than a flat bar. Weight for the k-th month back from oldest is 1 + 0.30k.
 */
function pickSignupDate(rng, now, months) {
  const weights = [];
  let total = 0;
  for (let k = 0; k < months; k += 1) {
    const w = 1 + 0.30 * k; // k = 0 is the OLDEST month
    weights.push(w);
    total += w;
  }
  let roll = rng.float() * total;
  let chosen = months - 1;
  for (let k = 0; k < months; k += 1) {
    roll -= weights[k];
    if (roll <= 0) { chosen = k; break; }
  }
  // chosen counts forward from the oldest month, so convert to "months ago".
  const monthsAgo = months - 1 - chosen;
  const anchor = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const d = new Date(anchor);
  d.setDate(rng.int(1, daysInMonth));
  d.setHours(rng.int(7, 21), rng.int(0, 59), rng.int(0, 59), 0);
  return d.getTime() > now.getTime() ? new Date(now.getTime() - rng.int(1, 72) * 3600 * 1000) : d;
}

/** A random moment strictly inside [from, to]; returns `to` if the range is empty. */
function between(rng, from, to) {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return new Date(b);
  return new Date(a + Math.floor(rng.float() * (b - a)));
}

/** 30-minute clinic slot label, matching the app's HH:mm appointment times. */
function pickSlotTime(rng) {
  const slot = rng.int(0, 15); // 09:00 .. 16:30
  const hour = 9 + Math.floor(slot / 2);
  const minute = slot % 2 === 0 ? '00' : '30';
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

// ── Scoring simulation ──────────────────────────────────────────────────────

/**
 * Simulate one screening for a child of `ageMonths` on the given question bank
 * and return BOTH the per-question answers and the resulting scores.
 *
 * The scores are computed with exactly the arithmetic routes/assessments.js
 * POST /submit uses — 2 points possible per administered question, domain
 * percentage = round(earned / total * 100), overall = round(mean of the four
 * domain percentages) — and banded through constants/scoring.js rather than a
 * second copy of the cutoffs. That is what makes the averages Admin Analytics
 * reports a truthful aggregate of these documents.
 *
 * Age gating is real: a question whose minAgeMonths exceeds the child's age is
 * NOT administered, so it contributes nothing to either earned or total. A
 * younger child answers fewer questions, exactly as in the live screening.
 */
function simulateScreening(rng, profile, ageMonths, questionBank) {
  const probs = ANSWER_PROBS[profile];
  const totals = {};
  SCORED_DOMAINS.forEach((d) => { totals[d] = { earned: 0, total: 0 }; });

  const answers = [];
  for (const q of questionBank) {
    if (ageMonths < q.minAgeMonths) continue; // not administered (age gate)
    if (!totals[q.domain]) continue;          // defensive: unscored domain

    const roll = rng.float();
    let answer;
    if (roll < probs.yes) answer = 'yes';
    else if (roll < probs.yes + probs.sometimes) answer = 'sometimes';
    else answer = 'no';

    totals[q.domain].total += 2;
    totals[q.domain].earned += ANSWER_POINTS[answer];
    answers.push({ questionId: q.questionId, domain: q.domain, questionText: q.text, answer });
  }

  const pct = (d) => (totals[d].total ? Math.round((totals[d].earned / totals[d].total) * 100) : 0);
  const communicationScore = pct('Communication');
  const socialScore = pct('Social Skills');
  const cognitiveScore = pct('Cognitive');
  const motorScore = pct('Motor Skills');
  const overallScore = Math.round((communicationScore + socialScore + cognitiveScore + motorScore) / 4);

  const riskFlags = [];
  if (scoring.isRiskFlagged(communicationScore)) riskFlags.push('Communication delay detected');
  if (scoring.isRiskFlagged(socialScore)) riskFlags.push('Social skills concern detected');
  if (scoring.isRiskFlagged(cognitiveScore)) riskFlags.push('Cognitive development concern');
  if (scoring.isRiskFlagged(motorScore)) riskFlags.push('Motor skills delay detected');

  return {
    answers,
    scores: { communicationScore, socialScore, cognitiveScore, motorScore, overallScore },
    riskFlags,
  };
}

/**
 * The historical prediction snapshot a real submission stores.
 *
 * Deliberately rule_based with riskCategory null and modelVersion null — the
 * honest record of what happened, because no ML model was consulted for these
 * rows. (It is also what the live code produces today: the only active
 * TrainedModel still lists the removed `gender_encoded` feature, so
 * ml/model_manager.js isModelCompatible() rejects it and
 * services/assessmentProgress.js falls back to rule-based.) Computed here
 * directly rather than through buildPredictionForStorage() so generation never
 * spawns Python once per row.
 */
function buildRuleBasedPrediction(overallScore, generatedAt) {
  const careStage = staging.getCareStageFromScore(overallScore);
  const definition = staging.getCareStageDefinition(careStage);
  const carePlan = staging.getCarePlanForCareStage(careStage);
  return {
    source: 'rule_based',
    modelVersion: null,
    riskCategory: null,
    careStage,
    careStageLabel: definition ? definition.label : null,
    consultationLevel: carePlan ? carePlan.consultationLevel : null,
    monitoringLevel: carePlan ? carePlan.monitoringLevel : null,
    probabilities: null,
    generatedAt,
  };
}

// ── Plan builder ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// STREAM COMPATIBILITY — read before touching anything that draws from `rng`
// ────────────────────────────────────────────────────────────────────────────
// buildPlan() walks ONE sequential PRNG. Every value it produces depends on
// its position in that stream, so ADDING OR REMOVING A DRAW ANYWHERE SHIFTS
// EVERY VALUE AFTER IT — including ones in unrelated sections further down.
//
// That is not hypothetical. When user identities moved to
// constants/syntheticIdentity.js, four draws per user disappeared from the
// loop below (isFemale, firstName, lastName, phoneNumber). The _ids are
// derived from (batch, index) and so did not move, but everything drawn
// afterwards did: signup dates, how many children each guardian got, the
// simulated answers, and therefore the scores. A re-run of `demo-2026` would
// have UPSERT-ed the same 1,500 _ids with different dates and different
// scores — silently rewriting a batch the team had already verified, and
// changing the Monthly Signups chart with it.
//
// The two helpers below re-consume exactly those four draws and throw the
// values away, which pins the stream back to where it was. They look like
// dead code and are not: deleting either one re-breaks reproducibility for
// the stored batch. tests/unit/synthetic-data.test.js pins concrete expected
// values so any future shift fails loudly instead of silently.
//
// Adding a NEW draw is fine as long as it goes after everything that already
// exists, or is given its own seeded stream the way syntheticIdentity.js does.

/**
 * Consume the three draws the user loop used to make for a name, and discard
 * them. Must be called at the TOP of the loop body, before pickSignupDate().
 */
function reserveLegacyNameDraws(rng) {
  const legacyIsFemale = rng.chance(0.55);                          // was: isFemale
  rng.pick(legacyIsFemale ? FIRST_NAMES_F : FIRST_NAMES_M);         // was: firstName
  rng.pick(LAST_NAMES);                                             // was: lastName
}

/**
 * Consume the single draw the user object literal used to make for a phone
 * number, and discard it. Must be called immediately AFTER that literal.
 */
function reserveLegacyPhoneDraw(rng) {
  rng.int(100000000, 999999999);                                    // was: phoneNumber
}

/**
 * Build the complete set of documents to write. PURE with respect to the
 * database: given the same seed, counts, question bank and `now`, it produces
 * the same plan every time. Nothing here touches MongoDB, which is what makes
 * --dry-run a genuine preview of what a real run would write.
 *
 * `now` is part of that contract, not an incidental argument: pickSignupDate()
 * places signups relative to it, so two runs with the same seed but different
 * `now` produce different createdAt values. The CLI passes new Date(), which
 * is why --now exists for reproducing a specific historical batch.
 */
function buildPlan({ seed, users: userCount, months, batch, questionBank, passwordHash, now }) {
  const rng = new Rng(seed);
  const mark = { isSynthetic: true, syntheticBatch: batch };

  const users = [];
  const pediatricians = [];
  const guardians = [];

  // ── Users ────────────────────────────────────────────────────────────────
  // Roles are assigned by exact quota rather than by rolling the mix per user,
  // so a run of N users always yields the same documented breakdown instead of
  // a slightly different one each seed.
  const roleQuota = [];
  let assigned = 0;
  ROLE_MIX.forEach((entry, i) => {
    const n = i === ROLE_MIX.length - 1
      ? userCount - assigned
      : Math.round(userCount * entry.share);
    assigned += n;
    for (let k = 0; k < n; k += 1) roleQuota.push(entry.role);
  });
  // Interleave so signup order is not grouped by role.
  for (let i = roleQuota.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [roleQuota[i], roleQuota[j]] = [roleQuota[j], roleQuota[i]];
  }

  // Realistic identities come from constants/syntheticIdentity.js — the SAME
  // module scripts/improve-synthetic-user-profiles.js uses. Sharing it is what
  // stops a regenerated batch from reverting improved accounts back to
  // kc_demo_00001, and guarantees both paths resolve name collisions
  // identically. Deterministic for a given (batch, count), and — importantly —
  // it draws from its OWN seeded streams, not from `rng` below.
  const identities = buildSyntheticIdentities(batch, userCount);

  for (let i = 0; i < userCount; i += 1) {
    const role = roleQuota[i];
    const identity = identities[i];
    // See STREAM COMPATIBILITY above reserveLegacyNameDraws(). These two calls
    // hold the position of draws this loop used to make, and must stay exactly
    // where they are, on either side of the fields between them.
    reserveLegacyNameDraws(rng);
    const createdAt = pickSignupDate(rng, now, months);
    const status = rng.weighted(STATUS_MIX);

    const doc = {
      _id: syntheticObjectId(batch, `user:${i}`),
      firstName: identity.firstName,
      // Left null: every real KinderCura account has a null middleName, so
      // populating it would make synthetic rows stand out, not blend in.
      middleName: null,
      lastName: identity.lastName,
      username: identity.username,
      email: identity.email,
      passwordHash,
      role,
      status,
      emailVerified: status === 'active' ? rng.chance(0.92) : rng.chance(0.35),
      profileIcon: `avatar${rng.int(1, 6)}`,
      // 555 fictional-subscriber block inside a real-looking PH prefix — a
      // fully random 09XXXXXXXXX can land on a live subscriber number.
      phoneNumber: identity.phoneNumber,
      createdAt,
      updatedAt: createdAt,
      ...mark,
    };

    // Holds the position of the phone draw the object literal above used to
    // make. It was the LAST draw in that literal, so consuming it here — after
    // the literal, before the pediatrician block — lands on exactly the same
    // stream position. See STREAM COMPATIBILITY.
    reserveLegacyPhoneDraw(rng);

    if (role === 'pediatrician') {
      const city = rng.pick(CITIES);
      doc.licenseNumber = `PRC-${rng.int(1000000, 9999999)}`;
      doc.prcLicenseNumber = doc.licenseNumber;
      doc.specialization = rng.pick(SPECIALIZATIONS);
      doc.clinicName = `${identity.lastName} ${rng.pick(CLINIC_SUFFIX)}`;
      doc.clinicAddress = `${rng.int(1, 400)} ${rng.pick(LAST_NAMES)} St., ${city}`;
      doc.institution = `${city} Medical Center`;
      doc.consultationFee = rng.int(6, 30) * 50; // PHP 300 - 1500
      // A natural short practice description, or null (the real pediatrician
      // record leaves this blank). Never dummy text: this field is shown to
      // parents, so "Synthetic demo account..." used to leak straight into the
      // booking UI.
      doc.bio = syntheticPediatricianBio(batch, i);
      doc.prcVerificationStatus = rng.weighted(PRC_STATUS_MIX);
      doc.prcSubmittedAt = createdAt;
      doc.prcVerifiedAt = doc.prcVerificationStatus === 'verified'
        ? between(rng, createdAt, now)
        : null;
      doc.licenseExpiry = new Date(now.getFullYear() + rng.int(1, 4), rng.int(0, 11), rng.int(1, 28));
      doc.availability = {
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        startTime: '09:00',
        endTime: '17:00',
        maxPatientsPerDay: rng.int(8, 20),
        breaks: [],
      };
      pediatricians.push(doc);
    }

    if (GUARDIAN_ROLES.includes(role)) guardians.push(doc);
    users.push(doc);
  }

  // Link each secretary to a synthetic pediatrician. Done after the loop so
  // every pediatrician already exists — a secretary must never point at a real
  // pediatrician's account.
  if (pediatricians.length) {
    for (const doc of users) {
      if (doc.role !== 'secretary') continue;
      doc.linkedPediatricianId = rng.pick(pediatricians)._id;
    }
  }

  // ── Children ─────────────────────────────────────────────────────────────
  const children = [];
  guardians.forEach((guardian, gi) => {
    if (!rng.chance(0.78)) return; // not every caregiver has registered a child yet
    const howMany = rng.chance(0.68) ? 1 : (rng.chance(0.8) ? 2 : 3);
    for (let c = 0; c < howMany; c += 1) {
      // 36-95 months: the age range the core question bank actually covers
      // (minAgeMonths 36 at the youngest, 84 at the oldest gate).
      const ageMonths = rng.int(36, 95);
      const dob = new Date(now.getFullYear(), now.getMonth() - ageMonths, rng.int(1, 28));
      const createdAt = between(rng, guardian.createdAt, now);
      const isFemale = rng.chance(0.5);
      children.push({
        _id: syntheticObjectId(batch, `child:${gi}:${c}`),
        parentId: guardian._id,
        firstName: rng.pick(isFemale ? FIRST_NAMES_F : FIRST_NAMES_M),
        middleName: null,
        lastName: guardian.lastName,
        dateOfBirth: dob,
        gender: isFemale ? 'female' : 'male',
        relationship: guardian.role === 'parent' ? 'Child' : 'Ward',
        profileIcon: `child${rng.int(1, 6)}`,
        createdAt,
        updatedAt: createdAt,
        ...mark,
        // Carried on the plan only, never written: the simulation needs them.
        _ageMonths: ageMonths,
        _profile: rng.weighted(CHILD_PROFILE_MIX),
        _guardian: guardian,
      });
    }
  });

  // ── Assessments, results and answers ─────────────────────────────────────
  const assessments = [];
  const results = [];
  const answers = [];

  children.forEach((child, ci) => {
    if (!rng.chance(0.74)) return; // some children have not been screened yet
    const howMany = rng.chance(0.62) ? 1 : (rng.chance(0.75) ? 2 : 3);

    for (let a = 0; a < howMany; a += 1) {
      const assessmentId = syntheticObjectId(batch, `assessment:${ci}:${a}`);
      const status = rng.weighted(ASSESSMENT_STATUS_MIX);
      const startedAt = between(rng, child.createdAt, now);
      const completedAt = status === 'in_progress'
        ? null
        : new Date(Math.min(now.getTime(), startedAt.getTime() + rng.int(4, 45) * 60 * 1000));

      assessments.push({
        _id: assessmentId,
        childId: child._id,
        createdBy: child.parentId,
        status,
        currentProgress: status === 'in_progress' ? rng.int(15, 85) : 100,
        startedAt,
        completedAt,
        // clinicalOutcome / mlLabel / mlReviewStatus / diagnosis /
        // reviewedByPediatrician are intentionally left at their schema
        // defaults. Demo data must never manufacture a clinical judgement,
        // and leaving mlReviewStatus 'unreviewed' guarantees these rows can
        // never be exported as reviewed ML training data.
        createdAt: startedAt,
        updatedAt: completedAt || startedAt,
        ...mark,
      });

      // A result document exists only for a screening that actually finished,
      // matching routes/assessments.js: the result is written by POST /submit.
      if (status !== 'complete') continue;

      // Older screenings for the same child score slightly lower, so a child's
      // history shows plausible progress rather than noise.
      const ageAtScreening = Math.max(36, child._ageMonths - Math.round((now - completedAt) / (DAY_MS * 30.44)));
      const sim = simulateScreening(rng, child._profile, ageAtScreening, questionBank);
      const { scores } = sim;

      results.push({
        _id: syntheticObjectId(batch, `result:${ci}:${a}`),
        assessmentId,
        childId: child._id,
        communicationScore: scores.communicationScore,
        socialScore: scores.socialScore,
        cognitiveScore: scores.cognitiveScore,
        motorScore: scores.motorScore,
        overallScore: scores.overallScore,
        communicationStatus: scoring.getStatus(scores.communicationScore),
        socialStatus: scoring.getStatus(scores.socialScore),
        cognitiveStatus: scoring.getStatus(scores.cognitiveScore),
        motorStatus: scoring.getStatus(scores.motorScore),
        riskFlags: sim.riskFlags,
        scoringBandsVersion: scoring.SCORING_BANDS_VERSION,
        prediction: buildRuleBasedPrediction(scores.overallScore, completedAt),
        generatedAt: completedAt,
        ...mark,
      });

      sim.answers.forEach((ans, qi) => {
        answers.push({
          _id: syntheticObjectId(batch, `answer:${ci}:${a}:${qi}`),
          assessmentId,
          questionId: ans.questionId,
          domain: ans.domain,
          questionText: ans.questionText,
          answer: ans.answer,
          origin: DATA_ORIGIN.CORE_BANK,
          sourceQuestionRef: ans.questionId,
          createdAt: completedAt,
          updatedAt: completedAt,
          ...mark,
        });
      });
    }
  });

  // ── Appointments ─────────────────────────────────────────────────────────
  const appointments = [];
  let apptSeq = 0;
  children.forEach((child) => {
    if (!pediatricians.length) return;
    if (!rng.chance(0.55)) return;
    const howMany = rng.chance(0.7) ? 1 : 2;

    for (let k = 0; k < howMany; k += 1) {
      const ped = rng.pick(pediatricians);
      const status = rng.weighted(APPOINTMENT_STATUS_MIX);
      // Past appointments for completed/cancelled/rejected, upcoming for the rest.
      const isPast = ['completed', 'cancelled', 'rejected'].includes(status);
      const offsetDays = isPast ? -rng.int(1, 150) : rng.int(1, 60);
      const appointmentDate = new Date(now.getTime() + offsetDays * DAY_MS);
      const createdAt = between(rng, child.createdAt, isPast ? appointmentDate : now);
      const fee = ped.consultationFee || 500;
      const settled = status === 'cancelled' || status === 'rejected';

      appointments.push({
        _id: syntheticObjectId(batch, `appointment:${apptSeq}`),
        id: syntheticAppointmentId(batch, apptSeq),
        childId: child._id,
        parentId: child.parentId,
        pediatricianId: ped._id,
        appointmentDate,
        appointmentTime: pickSlotTime(rng),
        reason: rng.pick(APPOINTMENT_REASONS),
        location: ped.clinicName,
        // Billed, never collected: this script writes no Payment documents, so
        // recording money as received would be a fabricated transaction. See
        // the header note.
        totalAmount: fee,
        amountPaid: 0,
        balanceDue: settled ? 0 : fee,
        paymentStatus: settled ? 'Cancelled' : 'Unpaid',
        status,
        createdAt,
        updatedAt: createdAt,
        ...mark,
      });
      apptSeq += 1;
    }
  });

  // Strip the plan-only helper fields before anything can write them.
  const childDocs = children.map(({ _ageMonths, _profile, _guardian, ...doc }) => doc);

  return { users, children: childDocs, assessments, results, answers, appointments };
}

// ── Database writing ────────────────────────────────────────────────────────

const CHUNK_SIZE = 500;

/**
 * Upsert a batch of planned documents.
 *
 * `timestamps: false` is essential: Mongoose would otherwise stamp createdAt
 * with "now" on insert and flatten the twelve months of signup history the
 * Monthly Signups chart depends on. The explicit createdAt/updatedAt in each
 * planned document is the real value.
 */
async function upsertAll(Model, docs, label) {
  if (!docs.length) return { matched: 0, upserted: 0 };
  await assertNoRealCollisions(Model, docs.map((d) => d._id));

  let matched = 0;
  let upserted = 0;
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const slice = docs.slice(i, i + CHUNK_SIZE);
    const ops = slice.map((doc) => {
      const { _id, ...rest } = doc;
      return { updateOne: { filter: { _id }, update: { $set: rest }, upsert: true } };
    });
    const res = await Model.bulkWrite(ops, { ordered: false, timestamps: false });
    matched += res.matchedCount || 0;
    upserted += res.upsertedCount || 0;
    process.stdout.write(`   ${label}: ${Math.min(i + CHUNK_SIZE, docs.length)}/${docs.length}\r`);
  }
  process.stdout.write(`   ${label}: ${docs.length}/${docs.length}   \n`);
  return { matched, upserted };
}

// ── Reporting ───────────────────────────────────────────────────────────────

const COUNTED_MODELS = [
  ['Users', User],
  ['Children', Child],
  ['Assessments', Assessment],
  ['Assessment results', AssessmentResult],
  ['Assessment answers', AssessmentAnswer],
  ['Appointments', Appointment],
];

/**
 * Report synthetic vs real counts.
 *
 * Counts ALL synthetic documents, never one batch: a verification report that
 * silently excluded a batch would understate what is actually in the database,
 * which is the opposite of what a verification report is for. The per-batch
 * breakdown is printed separately below.
 */
async function reportCounts() {
  const filter = syntheticOnlyFilter();
  const rows = [];
  for (const [label, Model] of COUNTED_MODELS) {
    const [total, synthetic] = await Promise.all([
      Model.countDocuments({}),
      Model.countDocuments(filter),
    ]);
    rows.push({ label, total, synthetic, real: total - synthetic });
  }

  console.log('');
  console.log('  Collection             Total     Synthetic   Real');
  console.log('  ' + '-'.repeat(52));
  for (const r of rows) {
    console.log(
      '  ' + r.label.padEnd(22) +
      String(r.total).padStart(6) +
      String(r.synthetic).padStart(12) +
      String(r.real).padStart(7)
    );
  }

  const roleRows = await User.aggregate([
    { $group: { _id: { role: '$role', synthetic: { $ifNull: ['$isSynthetic', false] } }, count: { $sum: 1 } } },
    { $sort: { '_id.role': 1 } },
  ]);
  console.log('');
  console.log('  User roles (synthetic / real)');
  const byRole = {};
  roleRows.forEach((r) => {
    const key = r._id.role || 'unknown';
    byRole[key] = byRole[key] || { synthetic: 0, real: 0 };
    if (r._id.synthetic === true) byRole[key].synthetic += r.count;
    else byRole[key].real += r.count;
  });
  Object.keys(byRole).sort().forEach((role) => {
    console.log(`    ${role.padEnd(18)} ${String(byRole[role].synthetic).padStart(6)} / ${byRole[role].real}`);
  });

  // Per-batch breakdown. Printed because the counts above are deliberately
  // batch-agnostic — this is what says which datasets those totals are made of,
  // and therefore what a scoped `--purge --batch=<label>` would remove.
  const batchRows = await User.aggregate([
    { $match: filter },
    { $group: { _id: '$syntheticBatch', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log('');
  console.log('  Synthetic batches (users per batch)');
  if (!batchRows.length) console.log('    none');
  batchRows.forEach((b) => console.log(`    ${String(b._id || 'unlabelled').padEnd(18)} ${b.count}`));

  const totalUsers = rows[0].total;
  console.log('');
  console.log(`  Adviser requirement A (> 1,000 system users): ${totalUsers} user record(s) — ${totalUsers > 1000 ? 'MET' : 'NOT MET'}`);
  return rows;
}

// ── Modes ───────────────────────────────────────────────────────────────────

async function runPurge(args) {
  // Scope: every synthetic document by default, one batch when --batch was
  // explicitly typed. Both filters keep isSynthetic:true, so neither can reach
  // a real record — --batch only changes how much demo data is removed.
  // Before this distinction existed, the default batch label silently narrowed
  // every purge, so `--purge --yes` left other batches behind while reporting
  // success.
  const filter = syntheticOnlyFilter(args.batchExplicit ? args.batch : null);

  if (!args.confirmed) {
    console.error('Refusing to purge without --yes.');
    console.error(`This would delete every document matching ${JSON.stringify(filter)}.`);
    console.error(args.batchExplicit
      ? `Scope: the "${args.batch}" batch only.`
      : 'Scope: EVERY synthetic batch. Pass --batch=<label> to remove just one.');
    console.error('Re-run with --yes once you are sure. Real records are never matched by this filter.');
    process.exitCode = 1;
    return;
  }
  console.log(`\nPurging synthetic documents matching ${JSON.stringify(filter)} ...`);
  // Deleted child-first so a partial failure never leaves an orphaned parent
  // pointing at nothing the app can resolve.
  const order = [
    ['Assessment answers', AssessmentAnswer],
    ['Assessment results', AssessmentResult],
    ['Assessments', Assessment],
    ['Appointments', Appointment],
    ['Children', Child],
    ['Users', User],
  ];
  for (const [label, Model] of order) {
    const res = await Model.deleteMany(filter);
    console.log(`  ${label.padEnd(22)} deleted ${res.deletedCount}`);
  }
  await reportCounts();
}

async function loadQuestionBank() {
  const bank = await CoreBankQuestion.find({ origin: DATA_ORIGIN.CORE_BANK, isActive: true })
    .select('questionId text domain minAgeMonths')
    .sort({ minAgeMonths: 1, questionId: 1 })
    .lean();

  if (bank.length < 8) {
    throw new Error(
      `Only ${bank.length} active core-bank question(s) found. The screening simulation needs the real ` +
      'question bank so the generated scores use the real age gates and domains. ' +
      'Run `npm run seed:core-bank` first.'
    );
  }
  const domains = new Set(bank.map((q) => q.domain));
  const missing = SCORED_DOMAINS.filter((d) => !domains.has(d));
  if (missing.length) {
    throw new Error(`Core-bank question bank is missing scored domain(s): ${missing.join(', ')}.`);
  }
  return bank;
}

async function runGenerate(args) {
  // args.now when the caller pinned it (reproducing an existing batch),
  // otherwise the real clock (generating a fresh one).
  const now = args.now || new Date();
  if (args.now) console.log(`
Clock pinned to ${now.toISOString()} (--now) — signup dates will reproduce exactly.`);
  const questionBank = await loadQuestionBank();
  console.log(`\nQuestion bank: ${questionBank.length} active core-bank questions (age gates ${Math.min(...questionBank.map((q) => q.minAgeMonths))}-${Math.max(...questionBank.map((q) => q.minAgeMonths))} months).`);

  // One bcrypt hash reused across every synthetic account. Without
  // --demo-password the hashed secret is random and immediately discarded, so
  // no synthetic account can be signed into by anyone, including us.
  const secret = args.demoPassword || crypto.randomBytes(32).toString('hex');
  const passwordHash = bcrypt.hashSync(secret, 10);

  const plan = buildPlan({
    seed: args.seed,
    users: args.users,
    months: args.months,
    batch: args.batch,
    questionBank,
    passwordHash,
    now,
  });

  const answerNote = args.withAnswers
    ? `${plan.answers.length} (writing — Question Origin answer counts will include these)`
    : `${plan.answers.length} simulated, NOT written (pass --with-answers to persist them)`;

  console.log('\nPlanned documents');
  console.log(`  Users              ${plan.users.length}`);
  console.log(`  Children           ${plan.children.length}`);
  console.log(`  Assessments        ${plan.assessments.length}`);
  console.log(`  Assessment results ${plan.results.length}`);
  console.log(`  Appointments       ${plan.appointments.length}`);
  console.log(`  Assessment answers ${answerNote}`);

  const roleCounts = {};
  plan.users.forEach((u) => { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });
  console.log('\n  Role breakdown');
  Object.keys(roleCounts).sort().forEach((r) => console.log(`    ${r.padEnd(18)} ${roleCounts[r]}`));

  if (plan.results.length) {
    const avg = (key) => Math.round(plan.results.reduce((s, r) => s + r[key], 0) / plan.results.length);
    console.log('\n  Simulated average scores (what Admin Analytics will average over)');
    console.log(`    communication ${avg('communicationScore')}%  social ${avg('socialScore')}%  cognitive ${avg('cognitiveScore')}%  motor ${avg('motorScore')}%  overall ${avg('overallScore')}%`);
  }

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was written.');
    return;
  }

  console.log(`\nWriting (batch "${args.batch}", seed ${args.seed}) ...`);
  // Numeric Appointment.id carries its own unique index, separate from _id, so
  // it needs its own pre-flight check: abort if any id we are about to claim
  // already belongs to a real booking or to a different synthetic batch.
  await assertAppointmentIdsAvailable(Appointment, plan.appointments.map((a) => a.id), args.batch);

  await upsertAll(User, plan.users, 'users');
  await upsertAll(Child, plan.children, 'children');
  await upsertAll(Assessment, plan.assessments, 'assessments');
  await upsertAll(AssessmentResult, plan.results, 'results');
  await upsertAll(Appointment, plan.appointments, 'appointments');
  if (args.withAnswers) await upsertAll(AssessmentAnswer, plan.answers, 'answers');

  console.log(
    args.demoPassword
      ? `\nSynthetic accounts are loginable with the password you supplied (e.g. ${plan.users[0].email}).`
      : '\nSynthetic accounts have no usable password and cannot be signed into.'
  );

  await reportCounts();
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  console.log('KinderCura — synthetic SYSTEM data generator (Requirement A)');
  console.log('This does NOT generate the 50,000-row ML dataset; see ml/pipeline.py.');

  await connectDB();

  try {
    if (args.purge) await runPurge(args);
    else if (args.verify) await reportCounts();
    else await runGenerate(args);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildPlan,
  simulateScreening,
  pickSignupDate,
  Rng,
  parseArgs,
  ROLE_MIX,
  GUARDIAN_ROLES,
  SCORED_DOMAINS,
};
