// scripts/improve-synthetic-user-profiles.js
// ============================================================================
// Rewrites the IDENTITY FIELDS of existing synthetic accounts so they look like
// ordinary KinderCura records, without changing what they are.
//
// This does NOT generate accounts, delete accounts, or change how many exist.
// It updates five fields on rows that are already there:
//
//     firstName, lastName, username, email, phoneNumber   (all synthetic users)
//     bio                                                  (pediatricians only)
//
// Everything else is left exactly as found — role, status, createdAt,
// updatedAt, passwordHash, profileIcon, clinic/PRC fields, linkedPediatricianId,
// isSynthetic and syntheticBatch.
//
// ---------------------------------------------------------------------------
// WHY EACH FIELD CHANGES
// ---------------------------------------------------------------------------
//   username/email  kc_demo_00001@synthetic.kindercura.test announces itself as
//                   a dummy row. The replacement is first.lastNN@kindercura.test
//                   — natural-looking, and still on an RFC 2606 `.test` domain
//                   that cannot resolve, so it can never reach a real mailbox.
//   firstName/lastName  the old 30x30 pool repeated heavily across 1,500 rows.
//   phoneNumber     the old numbers were fully random 09XXXXXXXXX, which can
//                   land on a live subscriber. The replacement uses the 555
//                   fictional-subscriber block inside a real-looking prefix.
//   bio             68 pediatricians carried the literal string "Synthetic demo
//                   pediatrician account for KinderCura analytics testing." in a
//                   field parents can read.
//
// ---------------------------------------------------------------------------
// SAFETY
// ---------------------------------------------------------------------------
//   * Every write is filtered { _id: <derived>, isSynthetic: true }. The _ids
//     come from syntheticObjectId(batch, 'user:i') — a real user's _id is not
//     in that set, and the isSynthetic guard means even a wrong _id could not
//     touch one.
//   * Relationships are untouched because _id never changes. Children,
//     assessments, results and appointments reference users by _id.
//   * passwordHash is never written, so accounts stay non-loginable exactly as
//     they were.
//   * createdAt/updatedAt are preserved (bulkWrite runs with timestamps:false),
//     so the Monthly Signups distribution is bit-for-bit unchanged.
//   * Deterministic: the same batch always produces the same identities, so
//     re-running is a no-op rather than a reshuffle.
//   * Pre-flight aborts if any generated username/email collides with a REAL
//     account, before a single row is written.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   node scripts/improve-synthetic-user-profiles.js --dry-run
//   node scripts/improve-synthetic-user-profiles.js
//   node scripts/improve-synthetic-user-profiles.js --verify
//
//   --batch=LABEL   which batch to improve (default demo-2026)
//   --dry-run       report what would change, write nothing
//   --verify        report the current state only
//   --samples=N     how many before/after examples to print (default 5)
// ============================================================================

require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const Appointment = require('../models/Appointment');

const { DEFAULT_SYNTHETIC_BATCH, syntheticObjectId } = require('../constants/syntheticData');
const {
  buildSyntheticIdentities,
  syntheticPediatricianBio,
  SYNTHETIC_EMAIL_DOMAIN,
} = require('../constants/syntheticIdentity');

const CHUNK_SIZE = 500;

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] === undefined) flags.add(m[1]);
    else opts[m[1]] = m[2];
  }
  return {
    batch: String(opts.batch || DEFAULT_SYNTHETIC_BATCH).trim() || DEFAULT_SYNTHETIC_BATCH,
    samples: Number.isFinite(Number(opts.samples)) ? Math.max(0, Math.floor(Number(opts.samples))) : 5,
    dryRun: flags.has('dry-run'),
    verify: flags.has('verify'),
  };
}

/**
 * Map every synthetic account in `batch` back to the index it was generated at.
 *
 * The account's _id is syntheticObjectId(batch, 'user:i'), so the index is
 * recoverable by deriving ids forward and matching — which is what makes this
 * script safe to run AFTER the username has already been rewritten (the
 * username no longer encodes the index, the _id always does).
 */
async function resolveIndexedUsers(batch) {
  const stored = await User.find({ isSynthetic: true, syntheticBatch: batch })
    .select('firstName lastName username email phoneNumber role bio')
    .lean();
  const byId = new Map(stored.map((u) => [String(u._id), u]));

  const matched = [];
  const unmatched = [];
  // Probe well past the stored count so a batch with gaps still resolves fully.
  const probeLimit = stored.length + 500;
  const seen = new Set();
  for (let i = 0; i < probeLimit && matched.length < stored.length; i += 1) {
    const id = syntheticObjectId(batch, `user:${i}`);
    const doc = byId.get(String(id));
    if (doc) {
      matched.push({ index: i, id, doc });
      seen.add(String(id));
    }
  }
  for (const u of stored) if (!seen.has(String(u._id))) unmatched.push(u);
  return { stored, matched, unmatched };
}

function buildChangeSet(batch, matched) {
  // Identities are built for the full index span, so suffix resolution is
  // identical to what a fresh generation of the same batch would produce.
  const span = matched.length ? Math.max(...matched.map((m) => m.index)) + 1 : 0;
  const identities = buildSyntheticIdentities(batch, span);

  const updates = [];
  for (const { index, id, doc } of matched) {
    const ident = identities[index];
    const next = {
      firstName: ident.firstName,
      lastName: ident.lastName,
      username: ident.username,
      email: ident.email,
      phoneNumber: ident.phoneNumber,
    };
    // Only pediatricians carry a bio; every other role leaves it null, which is
    // what the real records do.
    if (doc.role === 'pediatrician') next.bio = syntheticPediatricianBio(batch, index);

    const changed = Object.keys(next).some((k) => String(doc[k] ?? '') !== String(next[k] ?? ''));
    updates.push({ index, id, before: doc, after: next, changed });
  }
  return updates;
}

/**
 * Abort before writing if any generated value would collide with a REAL
 * account. username and email both carry unique indexes, so a collision would
 * fail the bulk write partway through and leave the batch half-renamed.
 */
async function assertNoCollisionsWithRealUsers(updates) {
  const emails = updates.map((u) => u.after.email.toLowerCase());
  const usernames = updates.map((u) => u.after.username);

  const dupEmails = emails.length !== new Set(emails).size;
  const dupUsernames = usernames.length !== new Set(usernames).size;
  if (dupEmails || dupUsernames) {
    throw new Error('Generated identities are not internally unique. Nothing was written.');
  }

  const clashes = await User.find({
    isSynthetic: { $ne: true },
    $or: [{ email: { $in: emails } }, { username: { $in: usernames } }],
  }).select('email username').lean();

  if (clashes.length) {
    throw new Error(
      `Refusing to write: ${clashes.length} generated identity/identities collide with REAL accounts ` +
      `(e.g. ${clashes.slice(0, 3).map((c) => `${c.username} / ${c.email}`).join('; ')}). Nothing was written.`
    );
  }
}

/**
 * Keep synthetic children's surnames in step with their renamed guardian.
 *
 * scripts/generate-system-demo-data.js gives each child its guardian's
 * lastName. Renaming the guardians without this step would leave 1,530
 * children carrying their OLD parent's surname — a "Rivera" child belonging to
 * "Sarah Bernardo" — which is a worse realism problem than the one this script
 * exists to fix.
 *
 * Scope is deliberately minimal: ONE field (lastName) on children that are
 * already synthetic AND already belong to one of the accounts being renamed.
 * No child is created, deleted or re-parented; parentId is never written, so
 * every parent -> child relationship is untouched.
 */
function buildChildSurnameOps(updates) {
  const ops = [];
  for (const u of updates) {
    if (!u.changed) continue;
    if (u.before.lastName === u.after.lastName) continue;
    ops.push({
      updateMany: {
        filter: { parentId: u.id, isSynthetic: true },
        update: { $set: { lastName: u.after.lastName } },
      },
    });
  }
  return ops;
}

function printSamples(updates, n) {
  const shown = updates.filter((u) => u.changed).slice(0, n);
  if (!shown.length) {
    console.log('\n  (no changes to show — the batch already matches the current identity scheme)');
    return;
  }
  console.log(`\n=== BEFORE / AFTER — ${shown.length} synthetic user(s) ===`);
  for (const u of shown) {
    console.log(`\n  [index ${u.index}] role=${u.before.role}  _id=${u.id}`);
    const rows = [
      ['name', `${u.before.firstName} ${u.before.lastName}`, `${u.after.firstName} ${u.after.lastName}`],
      ['username', u.before.username, u.after.username],
      ['email', u.before.email, u.after.email],
      ['phoneNumber', u.before.phoneNumber, u.after.phoneNumber],
    ];
    if ('bio' in u.after) rows.push(['bio', u.before.bio, u.after.bio]);
    for (const [field, before, after] of rows) {
      console.log(`      ${field.padEnd(12)} OLD: ${String(before ?? 'null')}`);
      console.log(`      ${''.padEnd(12)} NEW: ${String(after ?? 'null')}`);
    }
  }
}

async function reportState(batch) {
  const [total, real, synthetic, inBatch] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isSynthetic: { $ne: true } }),
    User.countDocuments({ isSynthetic: true }),
    User.countDocuments({ isSynthetic: true, syntheticBatch: batch }),
  ]);
  const legacyEmails = await User.countDocuments({ isSynthetic: true, email: /@synthetic\.kindercura\.test$/ });
  const newEmails = await User.countDocuments({ isSynthetic: true, email: new RegExp(`@${SYNTHETIC_EMAIL_DOMAIN.replace('.', '\\.')}$`) });
  const legacyUsernames = await User.countDocuments({ isSynthetic: true, username: /^kc_demo_/ });
  const giveawayBios = await User.countDocuments({ isSynthetic: true, bio: /synthetic demo/i });

  console.log('\n=== CURRENT STATE ===');
  console.log(`  users: total=${total}  real=${real}  synthetic=${synthetic}  (batch "${batch}"=${inBatch})`);
  console.log(`  synthetic emails on the legacy domain : ${legacyEmails}`);
  console.log(`  synthetic emails on ${SYNTHETIC_EMAIL_DOMAIN.padEnd(22)}: ${newEmails}`);
  console.log(`  usernames still kc_demo_*             : ${legacyUsernames}`);
  console.log(`  pediatrician bios with dummy text     : ${giveawayBios}`);

  const distinctNames = (await User.aggregate([
    { $match: { isSynthetic: true } },
    { $group: { _id: { f: '$firstName', l: '$lastName' } } },
    { $count: 'n' },
  ]))[0];
  console.log(`  distinct full names                   : ${distinctNames ? distinctNames.n : 0} of ${synthetic}`);

  const [emailsUnique, usernamesUnique] = await Promise.all([
    User.distinct('email', { isSynthetic: true }),
    User.distinct('username', { isSynthetic: true }),
  ]);
  console.log(`  unique synthetic emails / usernames   : ${emailsUnique.length} / ${usernamesUnique.length}`);

  console.log('\n  relationships (must never change):');
  console.log(`    children      ${await Child.countDocuments({ isSynthetic: true })}`);
  console.log(`    assessments   ${await Assessment.countDocuments({ isSynthetic: true })}`);
  console.log(`    results       ${await AssessmentResult.countDocuments({ isSynthetic: true })}`);
  console.log(`    appointments  ${await Appointment.countDocuments({ isSynthetic: true })}`);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('KinderCura — improve EXISTING synthetic user profiles');
  console.log('Updates identity fields in place. Creates nothing, deletes nothing.');

  await connectDB();
  try {
    if (args.verify) {
      await reportState(args.batch);
      return;
    }

    await reportState(args.batch);

    const { stored, matched, unmatched } = await resolveIndexedUsers(args.batch);
    console.log(`\n  resolved ${matched.length}/${stored.length} account(s) back to their generation index`);
    if (unmatched.length) {
      console.log(`  WARNING: ${unmatched.length} synthetic account(s) could not be matched and will be LEFT ALONE:`);
      unmatched.slice(0, 5).forEach((u) => console.log(`    ${u.username} (${u.email})`));
    }
    if (!matched.length) {
      console.log('\n  Nothing to do.');
      return;
    }

    const updates = buildChangeSet(args.batch, matched);
    const changed = updates.filter((u) => u.changed);
    console.log(`\n  ${changed.length} account(s) would change; ${updates.length - changed.length} already current.`);

    await assertNoCollisionsWithRealUsers(updates);
    console.log('  collision pre-flight: PASS (no generated identity matches a real account)');

    // Children inherit their guardian's surname — see buildChildSurnameOps.
    const childOps = buildChildSurnameOps(updates);
    const affectedChildren = childOps.length
      ? await Child.countDocuments({ isSynthetic: true, parentId: { $in: childOps.map((o) => o.updateMany.filter.parentId) } })
      : 0;
    console.log(`  children whose surname will follow their renamed guardian: ${affectedChildren} (lastName only; parentId never written)`);

    printSamples(updates, args.samples);

    if (args.dryRun) {
      console.log('\n--dry-run: nothing was written.');
      return;
    }
    if (!changed.length) {
      console.log('\nAlready up to date; nothing written.');
      return;
    }

    console.log(`\nWriting ${changed.length} account(s)...`);
    let modified = 0;
    for (let i = 0; i < changed.length; i += CHUNK_SIZE) {
      const slice = changed.slice(i, i + CHUNK_SIZE);
      const ops = slice.map((u) => ({
        updateOne: {
          // isSynthetic:true in the FILTER, not just the derivation — a real
          // account cannot be reached even if an _id were somehow wrong.
          filter: { _id: u.id, isSynthetic: true },
          update: { $set: u.after },
        },
      }));
      // timestamps:false — createdAt drives Monthly Signups and must not move,
      // and updatedAt is left as found so the change is invisible to analytics.
      const res = await User.bulkWrite(ops, { ordered: false, timestamps: false });
      modified += res.modifiedCount || 0;
      process.stdout.write(`   ${Math.min(i + CHUNK_SIZE, changed.length)}/${changed.length}\r`);
    }
    console.log(`   ${changed.length}/${changed.length}   `);
    console.log(`\nModified ${modified} account(s).`);

    if (childOps.length) {
      let childModified = 0;
      for (let i = 0; i < childOps.length; i += CHUNK_SIZE) {
        const res = await Child.bulkWrite(childOps.slice(i, i + CHUNK_SIZE), { ordered: false, timestamps: false });
        childModified += res.modifiedCount || 0;
      }
      console.log(`Synced ${childModified} child surname(s) to their guardian.`);
    }

    await reportState(args.batch);
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

module.exports = { buildChangeSet, resolveIndexedUsers, parseArgs };
