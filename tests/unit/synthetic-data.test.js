// Synthetic data guarantees — the safety and reproducibility contract.
// No DB required: every check runs against pure helpers or plain data.
//
// What these tests defend, in one line each:
//   - the purge filter can never match a real record
//   - synthetic ids are stable, so re-running the generator upserts
//   - the same seed always produces the same plan
//   - synthetic accounts never include an admin
//   - synthetic screenings never carry a clinical judgement or an ML label
//   - the scores written are the ones the real scoring formula produces
//   - the two requirements stay separate: no dataset row becomes a user
const assert = require('assert');

const {
  SYNTHETIC_ONLY_FILTER,
  SYNTHETIC_EMAIL_DOMAIN,
  SYNTHETIC_APPOINTMENT_ID_BASE,
  SYNTHETIC_APPOINTMENT_IDS_PER_BATCH,
  DEFAULT_SYNTHETIC_BATCH,
  syntheticOnlyFilter,
  syntheticObjectId,
  syntheticAppointmentId,
  syntheticUsername,
  syntheticEmail,
  isSyntheticEmail,
} = require('../../constants/syntheticData');

const generator = require('../../scripts/generate-system-demo-data');
const scoring = require('../../constants/scoring');

const User = require('../../models/User');
const Child = require('../../models/Child');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const Appointment = require('../../models/Appointment');

// A stand-in question bank with the same shape as core_bank_questions, so the
// plan builder can run without a database.
const BANK = [];
const DOMAINS = ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'];
for (let i = 1; i <= 34; i += 1) {
  BANK.push({
    questionId: `Q${String(i).padStart(2, '0')}`,
    text: `Sample question ${i}`,
    domain: DOMAINS[i % 4],
    minAgeMonths: [36, 36, 42, 48, 60, 72, 84][i % 7],
  });
}

const NOW = new Date('2026-09-03T12:00:00.000Z');

function buildSmallPlan(seed = 4242, users = 300) {
  return generator.buildPlan({
    seed,
    users,
    months: 12,
    batch: 'unit-test',
    questionBank: BANK,
    passwordHash: 'not-a-real-hash',
    now: NOW,
  });
}

function run() {
  // ── The purge filter ──────────────────────────────────────────────────
  // This is the single most important guarantee in the whole feature: a
  // cleanup run must be structurally incapable of touching a real record.
  assert.deepStrictEqual(
    SYNTHETIC_ONLY_FILTER,
    { isSynthetic: true },
    'the purge filter must match isSynthetic:true and nothing else'
  );
  assert.deepStrictEqual(syntheticOnlyFilter(), { isSynthetic: true });
  assert.deepStrictEqual(
    syntheticOnlyFilter('demo-2026'),
    { isSynthetic: true, syntheticBatch: 'demo-2026' },
    'narrowing by batch must ADD a condition, never relax isSynthetic'
  );
  // A batch filter must never widen the match. Every key beyond isSynthetic
  // can only ever reduce the result set.
  const narrowed = syntheticOnlyFilter('anything');
  assert.strictEqual(narrowed.isSynthetic, true, 'isSynthetic:true must survive narrowing');

  // ── Every participating schema can express the marker ─────────────────
  // Without these paths Mongoose would silently DROP isSynthetic on write,
  // producing synthetic documents that the purge can never find again.
  for (const Model of [User, Child, Assessment, AssessmentResult, Appointment]) {
    assert.ok(Model.schema.path('isSynthetic'), `${Model.modelName} must have an isSynthetic path`);
    assert.ok(Model.schema.path('syntheticBatch'), `${Model.modelName} must have a syntheticBatch path`);
    assert.strictEqual(
      Model.schema.path('isSynthetic').defaultValue,
      false,
      `${Model.modelName}.isSynthetic must default to false so existing records read as real`
    );
  }

  // ── Deterministic addressing ──────────────────────────────────────────
  assert.strictEqual(
    String(syntheticObjectId('demo-2026', 'user:1')),
    String(syntheticObjectId('demo-2026', 'user:1')),
    'the same (batch, reference) must always derive the same _id (this is what makes the generator idempotent)'
  );
  assert.notStrictEqual(
    String(syntheticObjectId('demo-2026', 'user:1')),
    String(syntheticObjectId('demo-2026', 'user:2')),
    'different references must derive different _ids'
  );

  // ── Batch isolation ───────────────────────────────────────────────────
  // The batch MUST be part of the address. Without it, `user:0` names the same
  // document in every batch, so generating a second batch silently overwrites
  // the first batch's users with different people while their children and
  // assessments keep pointing at those ids — which is exactly what happened
  // before the batch parameter was added.
  assert.notStrictEqual(
    String(syntheticObjectId('demo-2026', 'user:0')),
    String(syntheticObjectId('other-batch', 'user:0')),
    'two batches must never derive the same _id for the same reference'
  );
  assert.notStrictEqual(
    syntheticUsername(0, 'demo-2026'),
    syntheticUsername(0, 'other-batch'),
    'two batches must never derive the same username — the field carries a unique index'
  );
  assert.notStrictEqual(
    syntheticEmail(0, 'demo-2026'),
    syntheticEmail(0, 'other-batch'),
    'two batches must never derive the same email — the field carries a unique index'
  );
  assert.throws(() => syntheticObjectId('', 'user:0'), /non-empty batch/);
  assert.throws(() => syntheticObjectId('demo-2026', ''), /non-empty string/);

  // Appointment ids are sliced per batch for the same reason: Appointment.id
  // carries its own unique index, separate from _id.
  const apptA = syntheticAppointmentId('demo-2026', 0);
  const apptB = syntheticAppointmentId('other-batch', 0);
  assert.notStrictEqual(apptA, apptB, 'two batches must not claim the same appointment id');
  assert.ok(apptA >= SYNTHETIC_APPOINTMENT_ID_BASE, 'appointment ids must sit in the reserved block');
  assert.throws(
    () => syntheticAppointmentId('demo-2026', SYNTHETIC_APPOINTMENT_IDS_PER_BATCH),
    /reserved appointment ids/,
    'overrunning a batch slice must fail loudly rather than bleed into the next batch'
  );

  assert.strictEqual(syntheticUsername(0, DEFAULT_SYNTHETIC_BATCH), 'kc_demo_00001');
  assert.strictEqual(syntheticEmail(0, DEFAULT_SYNTHETIC_BATCH), `kc_demo_00001@${SYNTHETIC_EMAIL_DOMAIN}`);
  assert.ok(isSyntheticEmail(syntheticEmail(41, DEFAULT_SYNTHETIC_BATCH)));
  assert.ok(!isSyntheticEmail('parent@gmail.com'), 'a real address must never read as synthetic');
  assert.ok(
    SYNTHETIC_EMAIL_DOMAIN.endsWith('.test'),
    'the reserved domain must be under .test (RFC 2606) so it can never be a deliverable address'
  );

  // ── Reproducibility ───────────────────────────────────────────────────
  const planA = buildSmallPlan(4242);
  const planB = buildSmallPlan(4242);
  const planC = buildSmallPlan(9999);
  assert.strictEqual(
    JSON.stringify(planA), JSON.stringify(planB),
    'the same seed must produce a byte-identical plan'
  );
  assert.notStrictEqual(
    JSON.stringify(planA), JSON.stringify(planC),
    'a different seed must produce a different plan'
  );

  // Two batches built from the SAME seed must still be completely disjoint on
  // disk — same people, different documents — or the second run would
  // overwrite the first instead of sitting alongside it.
  const planOtherBatch = generator.buildPlan({
    seed: 4242, users: 300, months: 12, batch: 'other-batch',
    questionBank: BANK, passwordHash: 'not-a-real-hash', now: NOW,
  });
  for (const key of ['users', 'children', 'assessments', 'results', 'appointments']) {
    const idsA = new Set(planA[key].map((d) => String(d._id)));
    const overlap = planOtherBatch[key].filter((d) => idsA.has(String(d._id)));
    assert.strictEqual(overlap.length, 0, `batches must not share any ${key} _id (found ${overlap.length})`);
  }
  const apptIdsA = new Set(planA.appointments.map((a) => a.id));
  assert.strictEqual(
    planOtherBatch.appointments.filter((a) => apptIdsA.has(a.id)).length, 0,
    'batches must not share any numeric appointment id'
  );

  // ── Every planned document is marked ──────────────────────────────────
  for (const [key, docs] of Object.entries(planA)) {
    assert.ok(docs.length > 0, `plan.${key} must not be empty`);
    for (const doc of docs) {
      assert.strictEqual(doc.isSynthetic, true, `every planned ${key} document must be marked synthetic`);
      assert.strictEqual(doc.syntheticBatch, 'unit-test', `every planned ${key} document must record its batch`);
    }
  }

  // ── No synthetic admins ───────────────────────────────────────────────
  assert.strictEqual(
    planA.users.filter((u) => u.role === 'admin').length,
    0,
    'synthetic data must never create an admin account'
  );
  const validRoles = User.schema.path('role').enumValues;
  for (const user of planA.users) {
    assert.ok(validRoles.includes(user.role), `role "${user.role}" is not in the User schema enum`);
    assert.ok(isSyntheticEmail(user.email), 'every synthetic account must use the reserved email domain');
    assert.ok(user.createdAt <= NOW, 'a signup date must never be in the future');
  }

  // Usernames and emails must be unique — they carry unique indexes, so a
  // collision would abort the write halfway through a batch.
  assert.strictEqual(new Set(planA.users.map((u) => u.username)).size, planA.users.length, 'usernames must be unique');
  assert.strictEqual(new Set(planA.users.map((u) => u.email)).size, planA.users.length, 'emails must be unique');
  assert.strictEqual(
    new Set(planA.users.map((u) => String(u._id))).size, planA.users.length,
    'derived user _ids must be unique'
  );

  // ── Referential consistency ───────────────────────────────────────────
  const userIds = new Set(planA.users.map((u) => String(u._id)));
  const childIds = new Set(planA.children.map((c) => String(c._id)));
  const assessmentIds = new Set(planA.assessments.map((a) => String(a._id)));

  for (const child of planA.children) {
    assert.ok(userIds.has(String(child.parentId)), 'every child must belong to a synthetic user in the same plan');
    assert.ok(child.dateOfBirth < NOW, 'a date of birth must be in the past');
  }
  for (const assessment of planA.assessments) {
    assert.ok(childIds.has(String(assessment.childId)), 'every assessment must reference a planned child');
    assert.ok(userIds.has(String(assessment.createdBy)), 'every assessment must be created by a planned user');
  }
  for (const result of planA.results) {
    assert.ok(assessmentIds.has(String(result.assessmentId)), 'every result must reference a planned assessment');
  }
  for (const appointment of planA.appointments) {
    assert.ok(childIds.has(String(appointment.childId)), 'every appointment must reference a planned child');
    assert.ok(userIds.has(String(appointment.pediatricianId)), 'every appointment must reference a planned pediatrician');
    assert.ok(
      appointment.id >= SYNTHETIC_APPOINTMENT_ID_BASE,
      'synthetic appointment ids must come from the reserved block, never the shared counter'
    );
  }
  assert.strictEqual(
    new Set(planA.appointments.map((a) => a.id)).size, planA.appointments.length,
    'appointment ids must be unique — the field carries a unique index'
  );

  // ── A result exists only for a COMPLETED assessment ───────────────────
  const completedIds = new Set(
    planA.assessments.filter((a) => a.status === 'complete').map((a) => String(a._id))
  );
  for (const result of planA.results) {
    assert.ok(
      completedIds.has(String(result.assessmentId)),
      'a result must never exist for an assessment that was not completed'
    );
  }

  // ── No fabricated clinical judgements ─────────────────────────────────
  // This is what stops synthetic screenings from ever being exported as
  // reviewed ML training data by GET /training/reviewed-assessments/export.
  for (const assessment of planA.assessments) {
    assert.strictEqual(assessment.mlLabel, undefined, 'a synthetic assessment must carry no ML training label');
    assert.strictEqual(assessment.clinicalOutcome, undefined, 'a synthetic assessment must carry no clinical outcome');
    assert.strictEqual(assessment.diagnosis, undefined, 'a synthetic assessment must carry no diagnosis');
    assert.strictEqual(assessment.reviewedByPediatrician, undefined, 'a synthetic assessment must not claim a review');
    assert.strictEqual(assessment.mlReviewStatus, undefined, 'mlReviewStatus must stay at its unreviewed default');
  }

  // ── Scores obey the real scoring rules ────────────────────────────────
  for (const result of planA.results) {
    for (const key of ['communicationScore', 'socialScore', 'cognitiveScore', 'motorScore', 'overallScore']) {
      assert.ok(
        Number.isInteger(result[key]) && result[key] >= 0 && result[key] <= 100,
        `${key} must be an integer percentage, got ${result[key]}`
      );
    }
    // overall is the rounded mean of the four domain percentages, exactly as
    // routes/assessments.js POST /submit computes it.
    const expectedOverall = Math.round(
      (result.communicationScore + result.socialScore + result.cognitiveScore + result.motorScore) / 4
    );
    assert.strictEqual(result.overallScore, expectedOverall, 'overallScore must be the rounded mean of the four domains');

    // Statuses must come from constants/scoring.js, not a second copy of the cutoffs.
    assert.strictEqual(result.communicationStatus, scoring.getStatus(result.communicationScore));
    assert.strictEqual(result.socialStatus, scoring.getStatus(result.socialScore));
    assert.strictEqual(result.cognitiveStatus, scoring.getStatus(result.cognitiveScore));
    assert.strictEqual(result.motorStatus, scoring.getStatus(result.motorScore));
    assert.strictEqual(result.scoringBandsVersion, scoring.SCORING_BANDS_VERSION);

    // The stored prediction must be an honest record: no ML model was consulted.
    assert.strictEqual(result.prediction.source, 'rule_based');
    assert.strictEqual(result.prediction.riskCategory, null, 'a rule-based prediction must not claim an ML risk category');
    assert.strictEqual(result.prediction.modelVersion, null, 'a rule-based prediction must not claim a model version');
  }

  // ── Age gating actually applies ───────────────────────────────────────
  // A child too young for a question must not answer it. Verified through the
  // simulator directly, because the plan does not carry per-answer detail.
  const rng = new generator.Rng(7);
  const young = generator.simulateScreening(rng, 'typical', 36, BANK);
  const old = generator.simulateScreening(rng, 'typical', 95, BANK);
  assert.ok(
    young.answers.length < old.answers.length,
    'a younger child must be asked fewer questions than an older one (the age gate must be real)'
  );
  for (const answer of young.answers) {
    const question = BANK.find((q) => q.questionId === answer.questionId);
    assert.ok(question.minAgeMonths <= 36, 'a question above the child\'s age must never be answered');
  }

  // ── The two requirements stay separate ────────────────────────────────
  // Requirement B's dataset is a CSV of assessment rows. Nothing in the system
  // data plan may originate from it, and no plan document may look like one.
  for (const user of planA.users) {
    assert.strictEqual(user.risk_category, undefined, 'a user document must never carry an ML dataset field');
    assert.ok(user.passwordHash, 'every synthetic account must carry a password hash (the field is required)');
  }

  // ── Realistic identities ──────────────────────────────────────────────
  // The accounts have to LOOK like ordinary records without BEING reachable,
  // impersonable, or mistakable for real people.
  {
    const identity = require('../../constants/syntheticIdentity');
    const ids = identity.buildSyntheticIdentities('demo-2026', 400);

    assert.strictEqual(ids.length, 400);
    assert.strictEqual(new Set(ids.map((i) => i.username)).size, 400, 'usernames must be unique — the field is unique-indexed');
    assert.strictEqual(new Set(ids.map((i) => i.email)).size, 400, 'emails must be unique — the field is unique-indexed');

    // Deterministic: the improvement script must be re-runnable as a no-op.
    assert.deepStrictEqual(ids, identity.buildSyntheticIdentities('demo-2026', 400), 'same batch+count must give the same identities');
    assert.notDeepStrictEqual(ids, identity.buildSyntheticIdentities('other-batch', 400), 'a different batch must give different identities');

    for (const i of ids) {
      // Unresolvable by design (RFC 2606) — cannot reach a real mailbox.
      assert.ok(i.email.endsWith('@kindercura.test'), `email must sit on the reserved .test domain, got ${i.email}`);
      assert.ok(!/kc_demo|synthetic|dummy|test-user|user\d{3}/i.test(i.username), `username must not read as a dummy id, got ${i.username}`);
      assert.ok(/^[a-z]+\.[a-z]+\d*$/.test(i.username), `username must be first.last[N], got ${i.username}`);
      // 555 fictional-subscriber block: a fully random 09XXXXXXXXX can land on
      // a live subscriber, which is exactly what this replaced.
      assert.ok(/^09\d{2}555\d{4}$/.test(i.phoneNumber), `phone must use the 555 fictional block, got ${i.phoneNumber}`);
      assert.strictEqual(i.phoneNumber.length, 11, 'PH mobile numbers are 11 digits');
      assert.ok(i.firstName && i.lastName, 'both name parts must be present');
    }

    // Name variety: the previous 30x30 pool repeated heavily at volume.
    const distinctNames = new Set(ids.map((i) => `${i.firstName} ${i.lastName}`)).size;
    assert.ok(distinctNames > 350, `expected varied names, got only ${distinctNames} distinct of 400`);

    // Both namespaces are recognised, and a real address never is.
    assert.ok(identity.isSyntheticEmailAddress('a.b12@kindercura.test'));
    assert.ok(identity.isSyntheticEmailAddress('kc_demo_00001@synthetic.kindercura.test'), 'legacy addresses must still be recognised');
    assert.ok(!identity.isSyntheticEmailAddress('someone@gmail.com'), 'a real address must never read as synthetic');
    assert.ok(!identity.isSyntheticEmailAddress('admin@kindercura.com'), 'the real .com domain must never read as synthetic');

    // A pediatrician bio is either a natural sentence or null — never dummy text.
    for (let i = 0; i < 60; i += 1) {
      const bio = identity.syntheticPediatricianBio('demo-2026', i);
      if (bio !== null) {
        assert.ok(!/synthetic|demo|dummy|test/i.test(bio), `bio must not announce itself as demo data, got: ${bio}`);
      }
    }

    // The generator must issue these same identities, or a regeneration would
    // silently revert an improved batch.
    const planned = buildSmallPlan(4242, 50);
    for (const user of planned.users) {
      assert.ok(user.email.endsWith('@kindercura.test'), 'generated accounts must use the realistic domain');
      assert.ok(/^09\d{2}555\d{4}$/.test(user.phoneNumber), 'generated accounts must use the 555 phone block');
      assert.strictEqual(user.middleName, null, 'middleName stays null — every real account has it null');
    }
  }

  // ── PRNG STREAM REPRODUCIBILITY ───────────────────────────────────────
  // buildPlan() walks ONE sequential PRNG, so adding or removing a draw
  // anywhere shifts every value after it. That is not hypothetical: moving
  // user identities into constants/syntheticIdentity.js silently removed four
  // draws per user, which changed signup dates, child counts and every score —
  // while the _ids stayed put, so a re-run would have UPSERT-ed the same
  // documents with different data.
  //
  // The GOLDEN VECTOR below pins the stream to concrete values. If a future
  // change shifts it, these assertions fail loudly instead of the damage only
  // showing up as a quietly-rewritten batch. Regenerate the numbers ONLY when
  // a stream change is deliberate and the stored batches are being reissued.
  {
    const NOW = new Date('2026-09-03T12:00:00.000Z');
    const golden = generator.buildPlan({
      seed: 4242, users: 300, months: 12, batch: 'unit-test',
      questionBank: BANK, passwordHash: 'not-a-real-hash', now: NOW,
    });

    assert.deepStrictEqual(
      {
        users: golden.users.length, children: golden.children.length,
        assessments: golden.assessments.length, results: golden.results.length,
        appointments: golden.appointments.length,
      },
      { users: 300, children: 290, assessments: 306, results: 204, appointments: 183 },
      'PRNG STREAM SHIFTED: document counts changed. See the STREAM COMPATIBILITY note in the generator.'
    );

    assert.strictEqual(golden.users[0].role, 'parent', 'stream shifted: user 0 role');
    assert.strictEqual(golden.users[0].status, 'active', 'stream shifted: user 0 status');
    assert.strictEqual(golden.users[0].profileIcon, 'avatar3', 'stream shifted: user 0 profileIcon');
    assert.strictEqual(
      new Date(golden.users[0].createdAt).toISOString(), '2026-05-01T06:13:18.000Z',
      'PRNG STREAM SHIFTED: signup dates changed — a re-run would rewrite Monthly Signups.'
    );
    assert.strictEqual(
      new Date(golden.users[299].createdAt).toISOString(), '2025-10-21T01:44:11.000Z',
      'stream shifted: the LAST user drifted, so the shift is cumulative across the run'
    );

    const r0 = golden.results[0];
    assert.deepStrictEqual(
      { c: r0.communicationScore, s: r0.socialScore, g: r0.cognitiveScore, m: r0.motorScore, o: r0.overallScore },
      { c: 38, s: 22, g: 50, m: 38, o: 37 },
      'PRNG STREAM SHIFTED: simulated scores changed — a re-run would rewrite stored results.'
    );
    const rN = golden.results[golden.results.length - 1];
    assert.deepStrictEqual(
      { c: rN.communicationScore, s: rN.socialScore, g: rN.cognitiveScore, m: rN.motorScore, o: rN.overallScore },
      { c: 57, s: 94, g: 100, m: 79, o: 83 },
      'stream shifted: the last result drifted'
    );
    assert.strictEqual(golden.appointments[0].id, 71600000, 'stream shifted: appointment id block');

    // The stream must be driven ONLY by the seed — never by Math.random or any
    // other global source, or two runs on the same machine could differ.
    const realRandom = Math.random;
    Math.random = () => { throw new Error('buildPlan must never call Math.random'); };
    try {
      const noGlobal = generator.buildPlan({
        seed: 4242, users: 300, months: 12, batch: 'unit-test',
        questionBank: BANK, passwordHash: 'not-a-real-hash', now: NOW,
      });
      assert.strictEqual(JSON.stringify(noGlobal), JSON.stringify(golden),
        'buildPlan must not depend on any randomness outside its own seeded Rng');
    } finally {
      Math.random = realRandom;
    }

    // `now` is part of the reproducibility contract, not incidental: signup
    // dates are placed relative to it. This is why the CLI has --now.
    const laterNow = generator.buildPlan({
      seed: 4242, users: 300, months: 12, batch: 'unit-test',
      questionBank: BANK, passwordHash: 'not-a-real-hash', now: new Date('2027-02-01T00:00:00.000Z'),
    });
    assert.notStrictEqual(
      new Date(laterNow.users[0].createdAt).toISOString(),
      new Date(golden.users[0].createdAt).toISOString(),
      'a different `now` must move signup dates — otherwise --now would be pointless'
    );

    // Byte-equivalence across repeated runs, at every level.
    const again = generator.buildPlan({
      seed: 4242, users: 300, months: 12, batch: 'unit-test',
      questionBank: BANK, passwordHash: 'not-a-real-hash', now: NOW,
    });
    for (const key of ['users', 'children', 'assessments', 'results', 'appointments']) {
      assert.strictEqual(JSON.stringify(again[key]), JSON.stringify(golden[key]),
        `${key} must be byte-identical across runs with identical inputs`);
    }
  }

  // ── CLI parsing ───────────────────────────────────────────────────────
  // --now must parse, and must reject nonsense rather than silently using
  // the wall clock (which would defeat reproducing an existing batch).
  assert.strictEqual(generator.parseArgs(['n', 's']).now, null, '--now defaults to null (use the real clock)');
  assert.strictEqual(
    generator.parseArgs(['n', 's', '--now=2026-09-03T01:49:44.495Z']).now.toISOString(),
    '2026-09-03T01:49:44.495Z',
    '--now must parse an ISO timestamp'
  );
  assert.throws(() => generator.parseArgs(['n', 's', '--now=not-a-date']), /not a valid date/,
    'an unparseable --now must fail loudly, never fall back to the wall clock');

  const args = generator.parseArgs(['node', 'script', '--users=1500', '--seed=7', '--purge', '--yes']);
  assert.strictEqual(args.users, 1500);
  assert.strictEqual(args.seed, 7);
  assert.strictEqual(args.purge, true);
  assert.strictEqual(args.confirmed, true);
  assert.strictEqual(
    generator.parseArgs(['node', 'script', '--purge']).confirmed, false,
    'a purge must not be confirmed without an explicit --yes'
  );
  assert.throws(() => generator.parseArgs(['node', 'script', '--users=-5']), /non-negative/);

  console.log(
    `Synthetic data rules OK — plan of ${planA.users.length} users, ${planA.children.length} children, ` +
    `${planA.assessments.length} assessments, ${planA.results.length} results, ` +
    `${planA.appointments.length} appointments; purge filter is isSynthetic-only; 0 synthetic admins`
  );
}

run();
