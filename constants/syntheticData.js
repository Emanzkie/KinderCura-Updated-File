// constants/syntheticData.js
// ============================================================================
// SINGLE SOURCE OF TRUTH for how KinderCura marks, addresses and cleans up
// SYNTHETIC (demo / test) APPLICATION records.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR — and what it is NOT for
// ---------------------------------------------------------------------------
// This file covers REQUIREMENT A only: synthetic *system users* and their
// related application records (children, assessments, results, appointments)
// that populate the normal KinderCura collections so the existing Admin
// Analytics page has enough real documents to aggregate.
//
// It has NOTHING to do with the ML training dataset (REQUIREMENT B). That is
// a flat CSV of ~50,000 rows produced by ml/datasets/generate_kindercura_dataset.py
// and cleaned by ml/preprocess.py; it never becomes login accounts, never
// enters `users`, and is registered only as a TrainingDataset document. The
// two must never be conflated — see docs/synthetic-data-and-model-pipeline.md.
//
// ---------------------------------------------------------------------------
// THE SAFETY CONTRACT (read before changing anything here)
// ---------------------------------------------------------------------------
// KinderCura's local .env and its production deployment point at the SAME
// Atlas database. Every synthetic write therefore lands next to real patient
// records, so this module exists to make three promises mechanically true
// rather than merely intended:
//
//   1. MARKED  — every synthetic document carries `isSynthetic: true` plus the
//                batch that produced it. A document without that flag is real,
//                full stop.
//   2. ADDRESSABLE — a synthetic document's _id is DERIVED from a namespaced
//                hash of a stable reference string (syntheticObjectId below),
//                so re-running the generator upserts the same documents rather
//                than inserting duplicates. No new unique index is needed and
//                no counter is consumed.
//   3. REVERSIBLE — SYNTHETIC_ONLY_FILTER is the ONLY filter any cleanup path
//                is allowed to use. It matches `isSynthetic: true` and nothing
//                else, so a purge can never reach a real record even if the
//                caller passes a wrong batch id.
//
// The derived-_id scheme has one theoretical failure mode: a derived _id could
// collide with a real document's _id. assertNoRealCollisions() below turns
// that from a silent overwrite into a hard abort, and the generator calls it
// before every write phase.
// ============================================================================

const crypto = require('crypto');
const mongoose = require('mongoose');

// ── Namespace ───────────────────────────────────────────────────────────────
// Mixed into every derived _id. Changing this string re-addresses the entire
// synthetic dataset (old documents become unreachable by the generator and can
// only be removed by a flag-based purge), so treat it as frozen.
const SYNTHETIC_ID_NAMESPACE = 'kindercura-synthetic-v1';

// Reserved identity space. Nothing outside the generator may use these.
// A real signup can never produce them: the signup form has no way to enter an
// address at a .test TLD reserved by RFC 2606, and usernames are user-chosen.
const SYNTHETIC_EMAIL_DOMAIN = 'synthetic.kindercura.test';
const SYNTHETIC_USERNAME_PREFIX = 'kc_demo_';

// Appointment.id is a NUMBER allocated from the shared `counters` document, so
// synthetic appointments cannot use it without permanently inflating the real
// sequence and breaking idempotency. They are allocated from a reserved block
// far above anything the counter will reach instead, addressed deterministically
// as BASE + index. assertAppointmentIdBlockFree() guards the assumption.
const SYNTHETIC_APPOINTMENT_ID_BASE = 9000000;

// Default batch label recorded on every document. Overridable per run so a
// team can generate, inspect and purge one batch without touching another.
const DEFAULT_SYNTHETIC_BATCH = 'demo-2026';

// ── Schema fields ───────────────────────────────────────────────────────────
// Spread into each participating schema. Deliberately two plain scalar fields
// rather than a sub-document: `isSynthetic: true` stays a trivially readable,
// trivially indexable predicate that a reviewer can check in Compass, and the
// default of `false` means every pre-existing document already reads correctly
// as real without a migration.
const SYNTHETIC_FIELDS = Object.freeze({
  // The ONLY thing that makes a document deletable by the purge path.
  isSynthetic: { type: Boolean, default: false, index: true },
  // Which generator run wrote it, e.g. 'demo-2026'. null on real documents.
  syntheticBatch: { type: String, default: null, index: true },
});

/**
 * The ONLY filter any cleanup/purge path may use.
 *
 * Matches `isSynthetic: true` and nothing else, optionally narrowed to one
 * batch. A caller that passes a nonexistent batch deletes nothing; a caller
 * that passes no batch deletes every synthetic document — but in neither case
 * can it reach a real one, because a real document has `isSynthetic: false`
 * (schema default) or no such field at all, and `{ isSynthetic: true }`
 * matches neither.
 *
 * @param {string|null} batch  optional batch label to narrow to
 */
function syntheticOnlyFilter(batch = null) {
  const filter = { isSynthetic: true };
  if (batch) filter.syntheticBatch = batch;
  return filter;
}

// Frozen convenience export for the un-narrowed case, so call sites read as a
// stated intent ("synthetic only") rather than an inline object literal that
// someone could later "helpfully" extend with an $or.
const SYNTHETIC_ONLY_FILTER = Object.freeze({ isSynthetic: true });

/**
 * Derive a stable ObjectId from a batch label and a reference string.
 *
 * Same (batch, ref) -> same _id, forever. That is what makes the generator
 * idempotent: a second run upserts the same documents instead of inserting a
 * second copy, and child/assessment/appointment documents can reference their
 * parent's _id without a round-trip to the database to look it up.
 *
 * THE BATCH IS PART OF THE ADDRESS, and must be. Without it, `user:0` means
 * the same document in every batch, so generating a second batch silently
 * OVERWRITES the first batch's first N users with different people — different
 * names, different roles, a different batch label — while their children and
 * assessments keep pointing at those ids. (This is not hypothetical: it is
 * exactly what happened before this parameter existed, which is why it is now
 * required rather than optional.) Two batches are two independent datasets
 * that must be able to coexist and be purged separately.
 *
 * SHA-1 is used as a fast, well-distributed hash for ADDRESSING only — there
 * is nothing secret here and nothing is authenticated by it.
 *
 * @param {string} batch  the batch label, e.g. 'demo-2026'
 * @param {string} ref    e.g. 'user:42' or 'child:42:1'
 * @returns {mongoose.Types.ObjectId}
 */
function syntheticObjectId(batch, ref) {
  if (!batch || typeof batch !== 'string') {
    throw new Error('syntheticObjectId(batch, ref) requires a non-empty batch label.');
  }
  if (!ref || typeof ref !== 'string') {
    throw new Error('syntheticObjectId(batch, ref) requires a non-empty string reference.');
  }
  const hex = crypto
    .createHash('sha1')
    .update(`${SYNTHETIC_ID_NAMESPACE}:${batch}:${ref}`)
    .digest('hex')
    .slice(0, 24);
  return new mongoose.Types.ObjectId(hex);
}

/**
 * Deterministic synthetic username for user index i (0-based) in a batch.
 *
 * Namespaced by batch for the same reason the _id is: `username` and `email`
 * both carry UNIQUE indexes, so two batches sharing a username would not
 * quietly overwrite — they would abort the second batch's write halfway
 * through with a duplicate-key error. The default batch keeps the short
 * `kc_demo_00001` form so the common case stays readable.
 */
function syntheticUsername(index, batch = DEFAULT_SYNTHETIC_BATCH) {
  const suffix = String(index + 1).padStart(5, '0');
  if (batch === DEFAULT_SYNTHETIC_BATCH) return `${SYNTHETIC_USERNAME_PREFIX}${suffix}`;
  const slug = String(batch).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${SYNTHETIC_USERNAME_PREFIX}${slug}_${suffix}`;
}

/** Deterministic synthetic email for user index i (0-based) in a batch. */
function syntheticEmail(index, batch = DEFAULT_SYNTHETIC_BATCH) {
  return `${syntheticUsername(index, batch)}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

/** True when an email address belongs to the reserved synthetic namespace. */
function isSyntheticEmail(email) {
  return String(email || '').toLowerCase().endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`);
}

/**
 * Abort if any _id we are about to write is already held by a REAL document.
 *
 * This is the guard that makes the derived-_id scheme safe. Without it, an
 * (astronomically unlikely) hash collision — or, far more plausibly, a future
 * edit that changes how refs are built while old data is still present —
 * would silently overwrite a real patient record via upsert. With it, the run
 * stops before writing anything and names the offending _ids.
 *
 * @param {import('mongoose').Model} Model
 * @param {mongoose.Types.ObjectId[]} ids
 * @returns {Promise<void>} resolves when clear, throws otherwise
 */
async function assertNoRealCollisions(Model, ids) {
  if (!ids.length) return;
  const clashes = await Model.find({ _id: { $in: ids }, isSynthetic: { $ne: true } })
    .select('_id')
    .limit(5)
    .lean();
  if (clashes.length) {
    throw new Error(
      `Refusing to write: ${clashes.length}+ generated _id(s) already belong to NON-synthetic ` +
      `${Model.modelName} document(s) (e.g. ${clashes.map((d) => String(d._id)).join(', ')}). ` +
      'No documents were written. This must be investigated before re-running.'
    );
  }
}

// Each batch gets its own slice of the reserved appointment-id block, so two
// batches can coexist. 100,000 ids per batch, 1,000 slices.
const SYNTHETIC_APPOINTMENT_IDS_PER_BATCH = 100000;
const SYNTHETIC_APPOINTMENT_BATCH_SLICES = 1000;

/** Deterministic slice index for a batch label. */
function syntheticAppointmentSlice(batch) {
  const digest = crypto.createHash('sha1').update(`${SYNTHETIC_ID_NAMESPACE}:appt:${batch}`).digest();
  return digest.readUInt32BE(0) % SYNTHETIC_APPOINTMENT_BATCH_SLICES;
}

/**
 * Deterministic numeric Appointment.id for the seq-th synthetic appointment
 * in a batch.
 *
 * Appointment.id normally comes from the shared `counters` document. Synthetic
 * appointments must not consume it — that would permanently inflate the real
 * booking sequence and make re-running the generator allocate fresh ids every
 * time instead of upserting. They are allocated from a reserved high block
 * instead, sliced per batch so two batches never claim the same id.
 */
function syntheticAppointmentId(batch, seq) {
  if (seq >= SYNTHETIC_APPOINTMENT_IDS_PER_BATCH) {
    throw new Error(
      `Batch "${batch}" exceeded its ${SYNTHETIC_APPOINTMENT_IDS_PER_BATCH} reserved appointment ids.`
    );
  }
  return SYNTHETIC_APPOINTMENT_ID_BASE
    + syntheticAppointmentSlice(batch) * SYNTHETIC_APPOINTMENT_IDS_PER_BATCH
    + seq;
}

/**
 * Abort unless every numeric appointment id we are about to write is free for
 * THIS batch.
 *
 * Appointment.id carries a unique index, so an id already held by a real
 * booking — or by a different synthetic batch whose slice happened to collide
 * — would fail the write partway through and leave the run half-applied. This
 * turns both cases into a clear abort before anything is written.
 *
 * @param {import('mongoose').Model} AppointmentModel
 * @param {number[]} ids    the numeric ids about to be written
 * @param {string} batch    the batch claiming them
 */
async function assertAppointmentIdsAvailable(AppointmentModel, ids, batch) {
  if (!ids.length) return;
  const clash = await AppointmentModel.findOne({
    id: { $in: ids },
    $or: [{ isSynthetic: { $ne: true } }, { syntheticBatch: { $ne: batch } }],
  })
    .select('id isSynthetic syntheticBatch')
    .lean();
  if (clash) {
    const owner = clash.isSynthetic ? `synthetic batch "${clash.syntheticBatch}"` : 'a REAL appointment';
    throw new Error(
      `Refusing to write appointments: id ${clash.id} already belongs to ${owner}. ` +
      `No documents were written. Choose a different --batch label, or raise ` +
      `SYNTHETIC_APPOINTMENT_ID_BASE if a real booking has reached the reserved block.`
    );
  }
}

module.exports = {
  SYNTHETIC_ID_NAMESPACE,
  SYNTHETIC_EMAIL_DOMAIN,
  SYNTHETIC_USERNAME_PREFIX,
  SYNTHETIC_APPOINTMENT_ID_BASE,
  SYNTHETIC_APPOINTMENT_IDS_PER_BATCH,
  DEFAULT_SYNTHETIC_BATCH,
  SYNTHETIC_FIELDS,
  SYNTHETIC_ONLY_FILTER,
  syntheticOnlyFilter,
  syntheticObjectId,
  syntheticAppointmentId,
  syntheticAppointmentSlice,
  syntheticUsername,
  syntheticEmail,
  isSyntheticEmail,
  assertNoRealCollisions,
  assertAppointmentIdsAvailable,
};
