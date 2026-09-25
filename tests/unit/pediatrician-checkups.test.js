// Unit tests for the longitudinal pediatrician check-up / medical-history
// feature: models/PediatricianCheckup.js + routes/checkups.js.
//
// No live DB required — Child/Appointment/Assessment/PediatricianCheckup/
// GuardianLink/AuditLog/Notification's .find()/.findOne()/.exists()/.create()
// are monkey-patched on their shared singleton models, matching the pattern
// established in tests/unit/reviewed-assessment-export.test.js and
// tests/unit/dataset-quality.test.js. Route business logic is exercised
// directly via routes/checkups.js `router.__testables`, not over HTTP.
const assert = require('assert');
const mongoose = require('mongoose');

const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const PediatricianCheckup = require('../../models/PediatricianCheckup');
const GuardianLink = require('../../models/GuardianLink');
const AuditLog = require('../../models/AuditLog');
const Notification = require('../../models/Notification');

const checkupsRouter = require('../../routes/checkups');
const {
  loadChildAndAccess,
  createCheckupRecord,
  listCheckupsForChild,
  getCheckupRecord,
  updateCheckupRecord,
  parseCheckupDate,
  parseFollowUpDate,
  validateVisitType,
  validateStatus,
  validateDiagnosisText,
} = checkupsRouter.__testables;

// ── Fixture ids (real ObjectId hex strings — the route validates format
// before querying, so an arbitrary string like 'child-1' fails that check
// before ever reaching the logic under test). ──────────────────────────────
const childId = new mongoose.Types.ObjectId().toString();
const otherChildId = new mongoose.Types.ObjectId().toString();
const pediaId = new mongoose.Types.ObjectId().toString();
const otherPediaId = new mongoose.Types.ObjectId().toString();
const parentId = new mongoose.Types.ObjectId().toString();
const otherParentId = new mongoose.Types.ObjectId().toString();
const assessmentId = new mongoose.Types.ObjectId().toString();
const otherAssessmentId = new mongoose.Types.ObjectId().toString();
const prevRecordId = new mongoose.Types.ObjectId().toString();
const recordId = new mongoose.Types.ObjectId().toString();

function chainable(result) {
  const obj = {
    sort: () => obj,
    populate: () => obj,
    select: () => obj,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  return obj;
}

const child = { _id: childId, parentId, firstName: 'Ana', lastName: 'Reyes' };

function withMocks(overrides, fn) {
  return async () => {
    const originals = {
      childFindById: Child.findById,
      apptExists: Appointment.exists,
      apptFindOne: Appointment.findOne,
      assessmentFindOne: Assessment.findOne,
      checkupFindOne: PediatricianCheckup.findOne,
      checkupFind: PediatricianCheckup.find,
      checkupCreate: PediatricianCheckup.create,
      guardianLinkFindOne: GuardianLink.findOne,
      auditCreate: AuditLog.create,
      notifCreate: Notification.create,
    };

    Child.findById = overrides.childFindById || (() => chainable(child));
    Appointment.exists = overrides.apptExists || (async () => false);
    Appointment.findOne = overrides.apptFindOne || (() => chainable(null));
    Assessment.findOne = overrides.assessmentFindOne || (() => chainable(null));
    PediatricianCheckup.findOne = overrides.checkupFindOne || (() => chainable(null));
    PediatricianCheckup.find = overrides.checkupFind || (() => chainable([]));
    PediatricianCheckup.create = overrides.checkupCreate || (async (data) => ({
      ...data, _id: new mongoose.Types.ObjectId().toString(), createdAt: new Date(), updatedAt: new Date(),
    }));
    GuardianLink.findOne = overrides.guardianLinkFindOne || (() => chainable(null));
    AuditLog.create = overrides.auditCreate || (async () => {});
    Notification.create = overrides.notifCreate || (async () => {});

    try {
      await fn();
    } finally {
      Child.findById = originals.childFindById;
      Appointment.exists = originals.apptExists;
      Appointment.findOne = originals.apptFindOne;
      Assessment.findOne = originals.assessmentFindOne;
      PediatricianCheckup.findOne = originals.checkupFindOne;
      PediatricianCheckup.find = originals.checkupFind;
      PediatricianCheckup.create = originals.checkupCreate;
      GuardianLink.findOne = originals.guardianLinkFindOne;
      AuditLog.create = originals.auditCreate;
      Notification.create = originals.notifCreate;
    }
  };
}

async function expectHttpError(promise, statusCode, messageIncludes) {
  let threw = null;
  try { await promise; } catch (err) { threw = err; }
  assert.ok(threw, 'expected an HttpError to be thrown');
  assert.strictEqual(threw.statusCode, statusCode);
  if (messageIncludes) assert.ok(threw.message.includes(messageIncludes), `expected "${threw.message}" to include "${messageIncludes}"`);
}

async function run() {
  // ── Field validators (pure) ──────────────────────────────────────────
  {
    assert.strictEqual(validateVisitType('initial_checkup'), 'initial_checkup');
    assert.strictEqual(validateVisitType('follow_up_checkup'), 'follow_up_checkup');
    assert.throws(() => validateVisitType('made_up'), /visitType must be one of/);
    assert.throws(() => validateVisitType(''), /visitType must be one of/);

    // 15. Resolved / Parent Monitoring statuses are accepted, not rejected as
    // "invented" values — these are the adviser's described ending states.
    assert.strictEqual(validateStatus('resolved'), 'resolved');
    assert.strictEqual(validateStatus('parent_monitoring'), 'parent_monitoring');
    assert.strictEqual(validateStatus('monitoring'), 'monitoring');
    assert.throws(() => validateStatus('cured'), /status must be one of/);

    assert.strictEqual(validateDiagnosisText('Communication concern noted.'), 'Communication concern noted.');
    assert.throws(() => validateDiagnosisText(''), /Diagnosis is required/);
    assert.throws(() => validateDiagnosisText('  '), /Diagnosis is required/);
    assert.throws(() => validateDiagnosisText('ok'), /Diagnosis must describe/);
  }

  // ── Date parsing ──────────────────────────────────────────────────────
  {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const past = `${today.getFullYear() - 1}-01-01`;
    const future = `${today.getFullYear() + 1}-01-01`;

    assert.ok(parseCheckupDate('').value instanceof Date, 'omitted check-up date defaults to now');
    assert.ok(parseCheckupDate(past).value instanceof Date, 'a past check-up date is allowed');
    assert.ok(parseCheckupDate(future).error, 'a future check-up date is rejected');
    assert.ok(parseCheckupDate('not-a-date').error);

    assert.strictEqual(parseFollowUpDate('').value, null, 'omitted follow-up date is null, never invented');
    assert.ok(parseFollowUpDate(future).value instanceof Date, 'a future follow-up date is allowed');
    assert.ok(parseFollowUpDate(past).error, 'a follow-up date in the past is rejected');
  }

  // ── 6. childId validation ─────────────────────────────────────────────
  await withMocks({}, async () => {
    await expectHttpError(loadChildAndAccess('not-an-object-id', { userId: pediaId, role: 'pediatrician' }), 404);
  })();

  await withMocks({ childFindById: () => chainable(null) }, async () => {
    await expectHttpError(loadChildAndAccess(childId, { userId: pediaId, role: 'pediatrician' }), 404);
  })();

  // ── 7. Pediatrician authorization ─────────────────────────────────────
  await withMocks({ apptExists: async () => true }, async () => {
    const access = await loadChildAndAccess(childId, { userId: pediaId, role: 'pediatrician' });
    assert.strictEqual(access.isPediaLinked, true);
    assert.strictEqual(access.canWrite, true);
    assert.strictEqual(access.canRead, true);
  })();

  await withMocks({ apptExists: async () => false }, async () => {
    const access = await loadChildAndAccess(childId, { userId: otherPediaId, role: 'pediatrician' });
    assert.strictEqual(access.isPediaLinked, false);
    assert.strictEqual(access.canWrite, false, 'a pediatrician with no appointment for this child must not be able to write');
    assert.strictEqual(access.canRead, false, 'nor read — this is what stops one pediatrician browsing an unrelated patient');
  })();

  // ── 8/9. Parent read-only access ──────────────────────────────────────
  await withMocks({}, async () => {
    const access = await loadChildAndAccess(childId, { userId: parentId, role: 'parent' });
    assert.strictEqual(access.isParentOwner, true);
    assert.strictEqual(access.canRead, true);
    assert.strictEqual(access.canWrite, false, 'a parent must never be able to write a check-up record');
  })();

  // Unrelated parent, no guardian link at all -> denied.
  await withMocks({ guardianLinkFindOne: () => chainable(null) }, async () => {
    const access = await loadChildAndAccess(childId, { userId: otherParentId, role: 'parent' });
    assert.strictEqual(access.canRead, false);
  })();

  // Unrelated parent WITH an active guardian link granting viewMedicalRecords
  // -> allowed to read, never to write. Exercises the REAL hasPermission()
  // (middleware/guardianAccess.js), not a mock of it, via mocked
  // GuardianLink.findOne.
  await withMocks({
    guardianLinkFindOne: () => chainable({ status: 'active', permissions: { viewMedicalRecords: 'full' } }),
  }, async () => {
    const access = await loadChildAndAccess(childId, { userId: otherParentId, role: 'parent' });
    assert.strictEqual(access.canRead, true);
    assert.strictEqual(access.canWrite, false);
  })();

  // Admin can read, never write.
  await withMocks({}, async () => {
    const access = await loadChildAndAccess(childId, { userId: 'admin-1', role: 'admin' });
    assert.strictEqual(access.canRead, true);
    assert.strictEqual(access.canWrite, false);
  })();

  // ── 1. Create initial check-up ─────────────────────────────────────────
  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable(null), // no previous record for this child
  }, async () => {
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup',
      status: 'initial_review',
      diagnosis: 'Communication concern identified during screening.',
      findings: 'Limited two-word phrases observed.',
      recommendations: 'Continue developmental activities and return for follow-up.',
      nextFollowUpDate: (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); })(),
      nextFollowUpReason: 'Routine follow-up.',
    });

    assert.strictEqual(created.childId, childId);
    assert.strictEqual(created.pediatricianId, pediaId);
    assert.strictEqual(created.visitType, 'initial_checkup');
    assert.strictEqual(created.diagnosis, 'Communication concern identified during screening.');
    assert.strictEqual(created.status, 'initial_review');
    // 10. appointmentId omitted by the caller -> auto-attached from the
    // pediatrician's own linked appointment for this child.
    assert.strictEqual(created.appointmentId, 501);
    // 5. No previous record exists yet -> previousRecordId is null, not invented.
    assert.strictEqual(created.previousRecordId, null);
  })();

  // ── 2/5. Create follow-up check-up, auto-chained to the latest record ──
  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable({ _id: prevRecordId, childId }),
  }, async () => {
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'follow_up_checkup',
      status: 'improving',
      diagnosis: 'Improvement observed since the initial visit.',
      recommendations: 'Continue monitoring.',
    });
    assert.strictEqual(created.visitType, 'follow_up_checkup');
    assert.strictEqual(created.previousRecordId, prevRecordId, 'a follow-up must auto-thread to the most recent existing record');
  })();

  // ── 15/16. Resolved / Parent Monitoring preserves prior diagnoses ──────
  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable({ _id: prevRecordId, childId }),
  }, async () => {
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'follow_up_checkup',
      status: 'parent_monitoring',
      diagnosis: 'No further concern recorded at this visit.',
      recommendations: 'Continue monitoring at home and return if new concerns arise.',
    });
    assert.strictEqual(created.status, 'parent_monitoring');
    // The new record links back rather than erasing what came before — the
    // previous record itself is a separate, untouched document (see the
    // "editing one record" block below).
    assert.strictEqual(created.previousRecordId, prevRecordId);
  })();

  // ── Explicit previousRecordId that does not belong to this child -> rejected ─
  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable(null), // simulates "not found for this child"
  }, async () => {
    await expectHttpError(createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'follow_up_checkup',
      status: 'monitoring',
      diagnosis: 'Valid diagnosis text.',
      previousRecordId: new mongoose.Types.ObjectId().toString(),
    }), 400, 'previousRecordId');
  })();

  // ── 11. Optional assessmentId — omitted stays null, explicit mismatch rejected ──
  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable(null),
  }, async () => {
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
    });
    assert.strictEqual(created.assessmentId, null, 'a follow-up check-up with no new assessment must not invent one');
  })();

  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable(null),
    assessmentFindOne: () => chainable(null), // assessment not found for THIS child
  }, async () => {
    await expectHttpError(createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
      assessmentId: otherAssessmentId,
    }), 400, 'assessment');
  })();

  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 501, childId, pediatricianId: pediaId }),
    checkupFindOne: () => chainable(null),
    assessmentFindOne: () => chainable({ _id: assessmentId, childId }),
  }, async () => {
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
      assessmentId,
    });
    assert.strictEqual(created.assessmentId, assessmentId);
  })();

  // ── Explicit appointmentId belonging to a different child/pediatrician ──
  await withMocks({
    apptExists: async () => true,
    apptFindOne: () => chainable({ id: 999, childId: otherChildId, pediatricianId: otherPediaId }),
    checkupFindOne: () => chainable(null),
  }, async () => {
    await expectHttpError(createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
      appointmentId: 999,
    }), 400, 'appointment');
  })();

  // ── 9. Unauthorized create rejected (not linked to this patient) ───────
  await withMocks({ apptExists: async () => false }, async () => {
    await expectHttpError(createCheckupRecord(childId, { userId: otherPediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
    }), 403, 'not linked');
  })();

  await withMocks({}, async () => {
    await expectHttpError(createCheckupRecord(childId, { userId: parentId, role: 'parent' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
    }), 403, 'Pediatricians only');
  })();

  // ── 14. Next follow-up in the past rejected ─────────────────────────────
  await withMocks({ apptExists: async () => true, apptFindOne: () => chainable(null), checkupFindOne: () => chainable(null) }, async () => {
    await expectHttpError(createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
      nextFollowUpDate: '2000-01-01',
    }), 400, 'past');
  })();

  // ── 12/13. Diagnosis and recommendation storage round-trip ─────────────
  await withMocks({ apptExists: async () => true, apptFindOne: () => chainable(null), checkupFindOne: () => chainable(null) }, async () => {
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review',
      diagnosis: 'Communication concern.',
      recommendations: 'Continue developmental activities and return for follow-up.',
    });
    assert.strictEqual(created.diagnosis, 'Communication concern.');
    assert.strictEqual(created.recommendations, 'Continue developmental activities and return for follow-up.');
  })();

  // ── AuditLog is written on create, and a notification failure never
  // blocks the save (19: nothing here fabricates history — a failed
  // side-effect must not silently mutate what was actually saved) ────────
  await withMocks({
    apptExists: async () => true, apptFindOne: () => chainable(null), checkupFindOne: () => chainable(null),
    notifCreate: async () => { throw new Error('mail server down'); },
  }, async () => {
    let auditEntrySeen = null;
    AuditLog.create = async (entry) => { auditEntrySeen = entry; };
    const created = await createCheckupRecord(childId, { userId: pediaId, role: 'pediatrician' }, {
      visitType: 'initial_checkup', status: 'initial_review', diagnosis: 'Valid diagnosis text.',
    });
    assert.ok(created, 'creation must succeed even if the notification write fails');
    assert.strictEqual(auditEntrySeen.action, 'checkup_created');
  })();

  // ── 18. Empty history state ──────────────────────────────────────────
  await withMocks({ checkupFind: () => chainable([]) }, async () => {
    const list = await listCheckupsForChild(childId, { userId: parentId, role: 'parent' });
    assert.deepStrictEqual(list, []);
  })();

  // ── 3/4. Multiple records, chronological (newest-first) ordering ───────
  await withMocks({}, async () => {
    let lastFilter = null;
    PediatricianCheckup.find = (filter) => {
      lastFilter = filter;
      return chainable([
        { _id: 'r3', childId, checkupDate: new Date('2026-11-10'), status: 'parent_monitoring' },
        { _id: 'r2', childId, checkupDate: new Date('2026-10-10'), status: 'improving' },
        { _id: 'r1', childId, checkupDate: new Date('2026-09-10'), status: 'initial_review' },
      ]);
    };

    const list = await listCheckupsForChild(childId, { userId: parentId, role: 'parent' });
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[0]._id, 'r3', 'newest record must come first');
    assert.strictEqual(list[2]._id, 'r1', 'oldest (initial) record must come last');
    // A parent reading full history is never scoped to one pediatrician.
    assert.strictEqual(lastFilter.pediatricianId, undefined);
  })();

  // A pediatrician's own list is scoped to their own authored records only.
  await withMocks({ apptExists: async () => true }, async () => {
    let lastFilter = null;
    PediatricianCheckup.find = (filter) => { lastFilter = filter; return chainable([]); };
    await listCheckupsForChild(childId, { userId: pediaId, role: 'pediatrician' });
    assert.strictEqual(lastFilter.pediatricianId, pediaId);
  })();

  // ── 9. Unauthorized read rejected ───────────────────────────────────────
  await withMocks({ guardianLinkFindOne: () => chainable(null) }, async () => {
    await expectHttpError(listCheckupsForChild(childId, { userId: otherParentId, role: 'parent' }), 403);
  })();

  // ── getCheckupRecord: a pediatrician cannot read another pediatrician's
  // record for a shared patient ───────────────────────────────────────────
  await withMocks({
    apptExists: async () => true,
    checkupFindOne: () => chainable({ _id: recordId, childId, pediatricianId: { _id: otherPediaId, firstName: 'Other', lastName: 'Doc' } }),
  }, async () => {
    await expectHttpError(getCheckupRecord(childId, recordId, { userId: pediaId, role: 'pediatrician' }), 403);
  })();

  // A parent CAN read any pediatrician's record for their own child.
  await withMocks({
    checkupFindOne: () => chainable({ _id: recordId, childId, pediatricianId: { _id: pediaId, firstName: 'Doc', lastName: 'One' } }),
  }, async () => {
    const record = await getCheckupRecord(childId, recordId, { userId: parentId, role: 'parent' });
    assert.strictEqual(record._id, recordId);
  })();

  // ── 17. Editing one record does not alter any other ─────────────────────
  await withMocks({ apptExists: async () => true }, async () => {
    let savedCallCount = 0;
    const target = {
      _id: recordId,
      childId,
      pediatricianId: pediaId,
      diagnosis: 'Original diagnosis',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      save: async function () { savedCallCount += 1; },
    };
    PediatricianCheckup.findOne = () => chainable(target);

    const updated = await updateCheckupRecord(childId, recordId, { userId: pediaId, role: 'pediatrician' }, {
      diagnosis: 'Corrected diagnosis text.',
    });

    assert.strictEqual(updated.diagnosis, 'Corrected diagnosis text.');
    assert.strictEqual(savedCallCount, 1);
    // createdAt is never reassigned by the update path.
    assert.strictEqual(updated.createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.ok(updated.editedAt instanceof Date);
    assert.strictEqual(updated.editedBy, pediaId);
  })();

  // ── F2: the follow-up date on EDIT. An older record's follow-up date is
  // legitimately in the past by the time it is corrected, so re-sending the
  // SAME stored date must be allowed, while a NEWLY entered past date must
  // still be rejected. ──────────────────────────────────────────────────────
  {
    const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const storedPast = new Date(); storedPast.setDate(storedPast.getDate() - 30); storedPast.setHours(12, 0, 0, 0);
    const otherPast = new Date(); otherPast.setDate(otherPast.getDate() - 10); otherPast.setHours(12, 0, 0, 0);
    const future = new Date(); future.setDate(future.getDate() + 20); future.setHours(12, 0, 0, 0);
    const pedia = { userId: pediaId, role: 'pediatrician' };

    const makeTarget = (nextFollowUpDate) => {
      const t = { _id: recordId, childId, pediatricianId: pediaId, diagnosis: 'Original', nextFollowUpDate, saves: 0 };
      t.save = async function () { t.saves += 1; };
      return t;
    };
    const edit = (target, body) => withMocks({ apptExists: async () => true }, async () => {
      PediatricianCheckup.findOne = () => chainable(target);
      return updateCheckupRecord(childId, recordId, pedia, body);
    })();
    const editExpecting = (target, body, status, includes) => withMocks({ apptExists: async () => true }, async () => {
      PediatricianCheckup.findOne = () => chainable(target);
      await expectHttpError(updateCheckupRecord(childId, recordId, pedia, body), status, includes);
    })();

    // 1. Unchanged existing PAST follow-up date is allowed — as a date-only string
    //    (what the edit form sends) and as the full ISO string the API returned.
    for (const resent of [dayStr(storedPast), storedPast.toISOString()]) {
      const target = makeTarget(storedPast);
      await edit(target, { diagnosis: 'Typo corrected here.', nextFollowUpDate: resent });
      assert.strictEqual(target.saves, 1, 'an edit that keeps the old follow-up date must save');
      assert.strictEqual(target.diagnosis, 'Typo corrected here.');
      assert.strictEqual(target.nextFollowUpDate.getTime(), storedPast.getTime(), 'the stored follow-up date must be kept exactly');
    }

    // 2. A NEWLY changed past follow-up date is still rejected, and nothing is saved.
    {
      const target = makeTarget(storedPast);
      await editExpecting(target, { nextFollowUpDate: dayStr(otherPast) }, 400, 'past');
      assert.strictEqual(target.saves, 0);
      assert.strictEqual(target.nextFollowUpDate.getTime(), storedPast.getTime());
    }
    // ...including when the record has no follow-up date at all (nothing to retain).
    {
      const target = makeTarget(null);
      await editExpecting(target, { nextFollowUpDate: dayStr(otherPast) }, 400, 'past');
      assert.strictEqual(target.saves, 0);
    }
    // ...and when a FUTURE stored date is replaced with a past one.
    {
      const target = makeTarget(future);
      await editExpecting(target, { nextFollowUpDate: dayStr(otherPast) }, 400, 'past');
      assert.strictEqual(target.saves, 0);
    }

    // Unchanged behaviour: a new future date is accepted, null clears it, and an
    // omitted field leaves the stored (past) date untouched.
    {
      const t1 = makeTarget(storedPast);
      await edit(t1, { nextFollowUpDate: dayStr(future) });
      assert.strictEqual(dayStr(t1.nextFollowUpDate), dayStr(future));
      const t2 = makeTarget(storedPast);
      await edit(t2, { nextFollowUpDate: null });
      assert.strictEqual(t2.nextFollowUpDate, null);
      const t3 = makeTarget(storedPast);
      await edit(t3, { diagnosis: 'Only the text changed.' });
      assert.strictEqual(t3.nextFollowUpDate.getTime(), storedPast.getTime());
    }

    const { isRetainedFollowUpDate } = checkupsRouter.__testables;
    assert.strictEqual(isRetainedFollowUpDate(storedPast, dayStr(storedPast)), true);
    assert.strictEqual(isRetainedFollowUpDate(storedPast, dayStr(otherPast)), false);
    assert.strictEqual(isRetainedFollowUpDate(null, dayStr(storedPast)), false);
    assert.strictEqual(isRetainedFollowUpDate(storedPast, ''), false);
    assert.strictEqual(isRetainedFollowUpDate(storedPast, 'not-a-date'), false);
  }

  // 16 (edit-authorization half): a different pediatrician cannot edit.
  await withMocks({ apptExists: async () => true }, async () => {
    PediatricianCheckup.findOne = () => chainable({
      _id: recordId, childId, pediatricianId: otherPediaId, diagnosis: 'x',
      save: async () => { throw new Error('must never be called'); },
    });
    await expectHttpError(
      updateCheckupRecord(childId, recordId, { userId: pediaId, role: 'pediatrician' }, { diagnosis: 'Hijacked text.' }),
      403,
      'own check-up records'
    );
  })();

  // A parent may never edit, even their own child's record.
  await withMocks({}, async () => {
    await expectHttpError(
      updateCheckupRecord(childId, recordId, { userId: parentId, role: 'parent' }, { diagnosis: 'Parent trying to edit.' }),
      403
    );
  })();

  console.log('Pediatrician check-up history tests OK — creation, follow-up chaining, id verification, '
    + 'authorization (pediatrician/parent/guardian/admin), resolved/parent-monitoring statuses, '
    + 'and controlled single-record edits all behave as specified.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
