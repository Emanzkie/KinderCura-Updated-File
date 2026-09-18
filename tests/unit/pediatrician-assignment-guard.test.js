// services/pediatricianAssignmentGuard.js — the in-memory overlap tracker
// behind the dummy pediatrician demo seed (scripts/seed-dummy-pediatrician-demo-data.js).
// No DB required: exercises createOverlapTracker() directly.
//
// What these tests defend, in one line each:
//   - a child claimed by one pediatrician cannot be claimed by a different one
//   - the same pediatrician re-claiming their own child is a no-op, not a conflict
//   - claims made earlier in a run are visible to every later check
//   - an empty/no-conflict tracker allows any first claim
const assert = require('assert');
const { createOverlapTracker, ACTIVE_APPOINTMENT_STATUSES } = require('../../services/pediatricianAssignmentGuard');

function run() {
  // ── Fresh tracker: first claim on any child always succeeds ───────────────
  const t1 = createOverlapTracker();
  assert.deepStrictEqual(t1.check('childA', 'pedX'), { ok: true });
  t1.claim('childA', 'pedX');

  // ── Same pediatrician re-checking/re-claiming their own child: fine ───────
  assert.deepStrictEqual(t1.check('childA', 'pedX'), { ok: true },
    'the SAME pediatrician must be able to re-claim a child they already hold');
  t1.claim('childA', 'pedX'); // idempotent

  // ── A DIFFERENT pediatrician claiming an already-held child: rejected ─────
  const conflict = t1.check('childA', 'pedY');
  assert.strictEqual(conflict.ok, false, 'a second pediatrician must never be able to claim the same child');
  assert.strictEqual(conflict.claimedBy, 'pedX', 'the rejection must name who already holds the child');

  // Claiming anyway (a caller ignoring the check) must not silently rewrite
  // the map to look consistent — that would defeat the whole point. We only
  // assert here that check() keeps failing until the caller does not call
  // claim() for the conflicting pediatrician; the tracker itself never
  // auto-resolves a conflict.
  assert.deepStrictEqual(t1.check('childA', 'pedY'), { ok: false, claimedBy: 'pedX' });

  // ── Multiple children, multiple pediatricians, no cross-contamination ────
  const t2 = createOverlapTracker();
  t2.claim('c1', 'A');
  t2.claim('c2', 'A');
  t2.claim('c3', 'B');
  assert.deepStrictEqual(t2.check('c1', 'B'), { ok: false, claimedBy: 'A' });
  assert.deepStrictEqual(t2.check('c3', 'A'), { ok: false, claimedBy: 'B' });
  assert.deepStrictEqual(t2.check('c4', 'A'), { ok: true }, 'an unclaimed child must always be claimable');

  // ── Seeding the tracker with pre-existing assignments (e.g. Dr. Gold
  // Deluna's existing 5 children) must make them immediately protected,
  // without the caller having to call claim() for each one first.
  const t3 = createOverlapTracker([
    { childId: 'goldChild1', pediatricianId: 'gold-ped-id' },
    { childId: 'goldChild2', pediatricianId: 'gold-ped-id' },
  ]);
  assert.deepStrictEqual(t3.check('goldChild1', 'new-synthetic-ped'), { ok: false, claimedBy: 'gold-ped-id' },
    'pre-existing real assignments must block a new pediatrician from claiming the same child');
  assert.deepStrictEqual(t3.check('someOtherChild', 'new-synthetic-ped'), { ok: true });

  // ── entries() reflects every claim made, for reporting/verification ──────
  const t4 = createOverlapTracker();
  t4.claim('x', 'P1');
  t4.claim('y', 'P2');
  const snapshot = t4.entries().sort((a, b) => a.childId.localeCompare(b.childId));
  assert.deepStrictEqual(snapshot, [
    { childId: 'x', pediatricianId: 'P1' },
    { childId: 'y', pediatricianId: 'P2' },
  ]);

  // ── The active-status list mirrors ensurePediaChildRelationship() exactly
  // (routes/custom-questions.js) — a seed-time check must never be looser
  // than the real authorization check a live assignment would face.
  assert.deepStrictEqual([...ACTIVE_APPOINTMENT_STATUSES].sort(), ['approved', 'completed', 'pending']);

  console.log('Pediatrician assignment guard rules OK — no child can be claimed by two pediatricians, '
    + 'same-pediatrician reclaims are safe, pre-seeded claims are respected');
}

run();
