// services/pediatricianAssignmentGuard.js
//
// Enforces "one child -> one active pediatrician" for the CURATED dummy
// pediatrician demo dataset built by scripts/seed-dummy-pediatrician-demo-data.js.
//
// ── Why this exists, and what it deliberately does NOT do ───────────────────
// The existing pediatrician <-> child relationship is derived entirely from
// Appointment (childId + pediatricianId + status) — see
// routes/custom-questions.js `ensurePediaChildRelationship()` and
// routes/assessments.js GET /pedia-patients. There is no separate assignment
// collection, and this module does not add one (reuse, not duplicate).
//
// The live system already allows a real child to have appointments with more
// than one pediatrician over time (second opinions, referrals, switching
// clinics) — auditing the database before this change found 252 such
// children already in the existing demo dataset. Retroactively BANNING that
// everywhere would change real booking behavior far beyond this task's scope
// and could break a legitimate flow. So this guard is opt-in: callers (the
// seed script, and any future assignment code that wants it) ask it a
// question before writing; nothing here hooks into the live appointment
// booking route automatically.
//
// What it guarantees for whoever DOES call it: a child will never be handed
// to a second pediatrician while it is still exclusively considered another
// pediatrician's in the caller's own bookkeeping.

const mongoose = require('mongoose');

// Appointment statuses that make a pediatrician<->child link "active" for
// this purpose — mirrors ensurePediaChildRelationship() in
// routes/custom-questions.js exactly, so a seed-time check can never be
// looser than the real authorization check a live assignment would face.
const ACTIVE_APPOINTMENT_STATUSES = Object.freeze(['approved', 'completed', 'pending']);

/**
 * True if `childId` has an ACTIVE appointment with any pediatrician OTHER
 * than `pediatricianId`. Read-only — never writes, never assigns.
 *
 * @param {import('mongoose').Model} AppointmentModel
 * @param {string|mongoose.Types.ObjectId} childId
 * @param {string|mongoose.Types.ObjectId} pediatricianId
 * @returns {Promise<{overlaps: boolean, otherPediatricianId: string|null}>}
 */
async function findConflictingPediatrician(AppointmentModel, childId, pediatricianId) {
  const conflict = await AppointmentModel.findOne({
    childId,
    // $nin, not two $ne keys in one object literal — a duplicate key would
    // silently overwrite the first and match every OTHER appointment,
    // including this child's own appointment with THIS pediatrician.
    pediatricianId: { $nin: [pediatricianId, null] },
    status: { $in: ACTIVE_APPOINTMENT_STATUSES },
  }).select('pediatricianId').lean();

  return {
    overlaps: Boolean(conflict),
    otherPediatricianId: conflict ? String(conflict.pediatricianId) : null,
  };
}

/**
 * In-memory guard for a single seeding/assignment run: tracks which children
 * have already been claimed by which pediatrician SO FAR IN THIS RUN, so two
 * pediatricians processed in the same batch can never both claim the same
 * child even before either write hits the database.
 *
 * This is the pure, DB-free part — fully unit-testable without a connection.
 */
function createOverlapTracker(initialAssignments = []) {
  // childId (string) -> pediatricianId (string)
  const claimedBy = new Map();
  for (const { childId, pediatricianId } of initialAssignments) {
    claimedBy.set(String(childId), String(pediatricianId));
  }

  return {
    /**
     * Returns { ok: true } if this child may be claimed by this pediatrician,
     * or { ok: false, claimedBy: <pediatricianId> } if another pediatrician
     * already holds it in this tracker.
     */
    check(childId, pediatricianId) {
      const key = String(childId);
      const holder = claimedBy.get(key);
      if (holder && holder !== String(pediatricianId)) {
        return { ok: false, claimedBy: holder };
      }
      return { ok: true };
    },
    /** Records the claim. Idempotent for the same (childId, pediatricianId) pair. */
    claim(childId, pediatricianId) {
      claimedBy.set(String(childId), String(pediatricianId));
    },
    /** Snapshot for reporting/testing. */
    entries() {
      return [...claimedBy.entries()].map(([childId, pediatricianId]) => ({ childId, pediatricianId }));
    },
  };
}

module.exports = {
  ACTIVE_APPOINTMENT_STATUSES,
  findConflictingPediatrician,
  createOverlapTracker,
};
