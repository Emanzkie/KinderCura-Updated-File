// Daily parent reminders (services/reminders.js, GET /api/reminders/run).
//
// - An approved appointment tomorrow (Manila day) gets one bell reminder.
// - A next-assessment date that has arrived gets one, unless the child was
//   screened again after that review; only the latest review counts.
// - Running the job again sends nothing new (reminderKey is unique).
// - The endpoint only runs with the cron secret.
//
// No DB: models are stubbed in memory.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const AssessmentReminder = require('../../models/AssessmentReminder');
const reminders = require('../../services/reminders');
const router = require('../../routes/reminders');

const results = [];
const ok = (m) => results.push(m);
const oid = () => new mongoose.Types.ObjectId();
const chain = (rows) => ({ select: () => ({ lean: async () => rows }) });

// "Now" is 28 Oct 2026, 08:00 Manila (00:00 UTC), when the cron runs.
const NOW = new Date('2026-10-28T00:00:00Z');

// 1. Dates are Manila days.
assert.strictEqual(reminders.clinicToday(NOW), '2026-10-28');
assert.strictEqual(reminders.clinicToday(new Date('2026-10-27T16:30:00Z')), '2026-10-28', '00:30 Manila is already the next day');
assert.strictEqual(reminders.addDays('2026-10-31', 1), '2026-11-01');
ok('today is the Manila date');

const parentA = oid();
const parentB = oid();
const childA = { _id: oid(), firstName: 'Ana', lastName: 'Cruz', parentId: parentA };
const childB = { _id: oid(), firstName: 'Ben', lastName: 'Reyes', parentId: parentB };
const doctor = { _id: oid(), firstName: 'Maria', lastName: 'Santos' };

let apptQuery = null;
Appointment.find = (q) => {
  apptQuery = q;
  return chain([{ id: 101, parentId: parentA, childId: childA._id, pediatricianId: doctor._id, appointmentTime: '14:30' }]);
};
Child.find = (q) => chain([childA, childB].filter((c) => q._id.$in.some((id) => String(id) === String(c._id))));
User.find = () => chain([doctor]);
// No parent-set recurring reminders here (tests/unit/assessment-plan-reminders.test.js).
AssessmentReminder.find = () => ({ lean: async () => [] });
// No Follow-up Check-up plans here (tests/unit/follow-up-plans.test.js).
require('../../models/FollowUpPlan').find = () => chain([]);
// No scheduled home activities here (tests/unit/activity-scheduling.test.js).
require('../../models/ActivitySchedule').find = () => ({ select: () => ({ lean: async () => [] }) });

// childA: reviewed on 1 Oct with a due date of today, no newer screening.
// childB: due 3 days ago, but screened again on 20 Oct, after the review.
const reviewA = { _id: oid(), childId: childA._id, nextAssessmentDate: new Date('2026-10-28T12:00:00Z'), completedAt: new Date('2026-10-01T02:00:00Z') };
const olderA = { _id: oid(), childId: childA._id, nextAssessmentDate: new Date('2026-10-25T12:00:00Z'), completedAt: new Date('2026-09-01T02:00:00Z') };
const reviewB = { _id: oid(), childId: childB._id, nextAssessmentDate: new Date('2026-10-25T12:00:00Z'), completedAt: new Date('2026-09-10T02:00:00Z') };
let dueQuery = null;
Assessment.find = (q) => { dueQuery = q; return chain([olderA, reviewA, reviewB]); };
Assessment.aggregate = async () => [
  { _id: childA._id, at: reviewA.completedAt },
  { _id: childB._id, at: new Date('2026-10-20T02:00:00Z') },
];

const stored = new Map();
Notification.create = async (doc) => {
  if (stored.has(doc.reminderKey)) { const e = new Error('dup'); e.code = 11000; throw e; }
  stored.set(doc.reminderKey, doc);
  return doc;
};

(async () => {
  // 2. First run: one appointment reminder, one assessment reminder.
  let summary = await reminders.runReminders(NOW);
  assert.deepStrictEqual(summary, { date: '2026-10-28', appointments: 1, assessments: 1, planned: 0, followUps: 0, activities: 0, alreadySent: 0, emailed: 0, emailFailed: 0 });
  assert.strictEqual(apptQuery.status, 'approved', 'only approved appointments');
  assert.deepStrictEqual(
    [apptQuery.appointmentDate.$gte.toISOString(), apptQuery.appointmentDate.$lt.toISOString()],
    ['2026-10-29T00:00:00.000Z', '2026-10-30T00:00:00.000Z'],
    'tomorrow, as the stored UTC-midnight booking date'
  );
  assert.deepStrictEqual(apptQuery.isSynthetic, { $ne: true }, 'demo records are skipped');

  const appt = stored.get('appointment:101:2026-10-29');
  assert.ok(appt, 'appointment reminder keyed by appointment and date');
  assert.strictEqual(String(appt.userId), String(parentA));
  assert.strictEqual(appt.message, 'Reminder: Ana Cruz has an appointment tomorrow, October 29, 2026, at 2:30 PM with Dr. Maria Santos.');
  assert.strictEqual(appt.relatedPage, '/parent/appointments');
  assert.strictEqual(appt.isRead, false);
  ok('approved appointment tomorrow: one reminder to the parent with child, time and doctor');

  assert.deepStrictEqual(
    [dueQuery.nextAssessmentDate.$gte.toISOString(), dueQuery.nextAssessmentDate.$lte.toISOString()],
    ['2026-10-20T16:00:00.000Z', '2026-10-28T15:59:59.999Z'],
    'due dates from the last 7 Manila days up to the end of today'
  );
  const due = stored.get(`assessment:${reviewA._id}:2026-10-28`);
  assert.ok(due, 'reminder comes from the latest review, not the older one');
  assert.ok(![...stored.keys()].some((k) => k.includes(String(olderA._id))), 'older review ignored');
  assert.ok(![...stored.values()].some((n) => String(n.userId) === String(parentB)), 'child screened again since the review: no reminder');
  assert.strictEqual(String(due.userId), String(parentA));
  assert.strictEqual(due.relatedPage, '/parent/screening');
  assert.ok(due.message.startsWith('Ana Cruz is due for the next developmental assessment (scheduled for October 28, 2026)'));
  ok('next assessment due: latest review only, none after a newer screening');

  // 3. Second run the same day: nothing new.
  summary = await reminders.runReminders(NOW);
  assert.deepStrictEqual(summary, { date: '2026-10-28', appointments: 0, assessments: 0, planned: 0, followUps: 0, activities: 0, alreadySent: 2, emailed: 0, emailFailed: 0 });
  assert.strictEqual(stored.size, 2);
  ok('running again sends nothing twice');

  // 4. The endpoint needs the cron secret.
  const handler = router.stack.find((l) => l.route && l.route.path === '/run').route.stack[0].handle;
  const call = (authorization) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    handler({ headers: authorization ? { authorization } : {} }, res);
  });
  const log = console.log;
  console.log = () => {};
  try {
    delete process.env.CRON_SECRET;
    assert.strictEqual((await call('Bearer anything')).status, 503, 'no secret configured: refuses to run');
    process.env.CRON_SECRET = 'test-cron-secret';
    assert.strictEqual((await call()).status, 401);
    assert.strictEqual((await call('Bearer wrong')).status, 401);
    const r = await call('Bearer test-cron-secret');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
  } finally {
    console.log = log;
    delete process.env.CRON_SECRET;
  }
  ok('endpoint: runs only with Authorization: Bearer CRON_SECRET');

  // 5. Wiring: mounted, scheduled, and the key is unique.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  assert.ok(fs.readFileSync(path.join(root, 'server.js'), 'utf8').includes("app.use('/api/reminders', require('./routes/reminders'))"));
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.deepStrictEqual(vercel.crons, [{ path: '/api/reminders/run', schedule: '0 0 * * *' }], 'daily at 8:00 AM Manila');
  const idx = Notification.schema.indexes().find(([fields]) => fields.reminderKey === 1);
  assert.ok(idx && idx[1].unique, 'reminderKey has a unique index');
  ok('mounted at /api/reminders, Vercel cron daily, reminderKey unique');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Parent reminder tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
