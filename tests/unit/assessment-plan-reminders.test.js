// Parent-set recurring assessment reminders (models/AssessmentReminder.js,
// services/reminders.js planReminders, /api/reminders/assessment).
//
// - A schedule starts on the next matching day and repeats every 1, 2 or 3
//   months, across the year boundary.
// - The daily run sends one bell reminder on the due day or 1/3/7 days before,
//   catches up a missed day, and never sends the same due date twice.
// - Paused reminders send nothing; resuming keeps the cycle.
// - Only the child's parent can set one; values are validated.
//
// No DB: models are stubbed in memory.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const AssessmentReminder = require('../../models/AssessmentReminder');
const reminders = require('../../services/reminders');
const router = require('../../routes/reminders');

const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();
const q = (v) => { const o = { select: () => o, lean: async () => v, sort: () => o, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
const same = (a, b) => String(a) === String(b);
const at8am = (ymd) => new Date(`${ymd}T00:00:00Z`); // the cron time, 8:00 AM Manila

const parentId = oid();
const otherParent = oid();
const child = { _id: oid(), firstName: 'Kemri', lastName: 'Soto', parentId };
const otherChild = { _id: oid(), firstName: 'Liam', lastName: 'Cruz', parentId: otherParent };

let settings = [];
const sent = new Map();
Appointment.find = () => q([]);
require('../../models/FollowUpPlan').find = () => q([]); // none here: tests/unit/follow-up-plans.test.js
// No scheduled home activities here (tests/unit/activity-scheduling.test.js).
require('../../models/ActivitySchedule').find = () => ({ select: () => ({ lean: async () => [] }) });
Assessment.find = () => q([]);
Child.find = (f) => q([child, otherChild].filter((c) => (f._id ? f._id.$in.some((id) => same(id, c._id)) : same(f.parentId, c.parentId))));
Child.findById = (id) => q([child, otherChild].find((c) => same(c._id, id)) || null);
Notification.create = async (doc) => {
  if (sent.has(doc.reminderKey)) throw Object.assign(new Error('dup'), { code: 11000 });
  sent.set(doc.reminderKey, doc);
  return doc;
};
// Email copies are covered by tests/unit/reminder-emails.test.js.
User.find = () => q([]);
AssessmentReminder.find = (f) => q(settings.filter((s) => (f.status ? s.status === f.status : f.childId.$in.some((id) => same(id, s.childId)))));
AssessmentReminder.findOne = (f) => q(settings.find((s) => same(s.childId, f.childId)) || null);
AssessmentReminder.findOneAndUpdate = (f, u) => {
  let s = settings.find((x) => same(x.childId, f.childId));
  if (!s) { s = { _id: oid(), childId: f.childId }; settings.push(s); }
  Object.assign(s, u.$set);
  return q({ ...s });
};
AssessmentReminder.deleteOne = async (f) => { settings = settings.filter((s) => !same(s.childId, f.childId)); };

const run = async (ymd) => reminders.runReminders(at8am(ymd));
const plan = (over) => ({ _id: oid(), childId: child._id, parentId, frequencyMonths: 1, dayOfMonth: 15, leadDays: 0, status: 'active', startMonth: '2026-11', ...over });

(async () => {
  // 1. Schedule maths.
  assert.strictEqual(reminders.firstDueMonth(15, '2026-10-30'), '2026-11', 'the 15th has passed this month');
  assert.strictEqual(reminders.firstDueMonth(15, '2026-10-15'), '2026-10', 'today counts');
  assert.strictEqual(reminders.firstDueMonth(1, '2026-12-02'), '2027-01', 'across the year');
  const two = plan({ frequencyMonths: 2, dayOfMonth: 15, leadDays: 3, startMonth: '2026-12' });
  assert.deepStrictEqual(reminders.nextPlanDates(two, '2026-11-20'), { nextDueDate: '2026-12-15', nextReminderDate: '2026-12-12' });
  assert.deepStrictEqual(reminders.nextPlanDates(two, '2026-12-16'), { nextDueDate: '2027-02-15', nextReminderDate: '2027-02-12' }, 'Dec -> Feb');
  assert.deepStrictEqual(reminders.nextPlanDates(two, '2027-02-14'), { nextDueDate: '2027-02-15', nextReminderDate: '2027-02-14' }, 'inside the window: today');
  const three = plan({ frequencyMonths: 3, dayOfMonth: 28, startMonth: '2026-11' });
  const isDue = reminders._internals.isPlanDueDate;
  assert.ok(isDue(three, '2027-02-28') && isDue(three, '2027-05-28') && !isDue(three, '2027-01-28') && !isDue(three, '2026-08-28'));
  ok('schedules start on the next matching day and repeat every 1, 2 or 3 months, across years');

  // 2. Timing: on the day, and 1, 3, 7 days before — exactly once per due date.
  for (const lead of [0, 1, 3, 7]) {
    settings = [plan({ leadDays: lead })];
    sent.clear();
    const remindDay = reminders.addDays('2026-11-15', -lead);
    const before = await run(reminders.addDays(remindDay, -1));
    assert.strictEqual(before.planned, 0, `lead ${lead}: nothing the day before the reminder`);
    const first = await run(remindDay);
    assert.strictEqual(first.planned, 1, `lead ${lead}: sent on ${remindDay}`);
    const msg = [...sent.values()][0];
    assert.strictEqual(msg.reminderKey, `assessment-plan:${child._id}:2026-11-15`);
    assert.deepStrictEqual([String(msg.userId), msg.type, msg.relatedPage, msg.title], [String(parentId), 'assessment_reminder', '/parent/screening', 'Assessment Reminder']);
    assert.match(msg.message, lead === 0 ? /Kemri Soto's developmental assessment is due today/ : new RegExp(`due on November 15, 2026 \\(in ${lead} days?\\)`));
    for (let d = 1; d <= lead; d += 1) {
      const later = await run(reminders.addDays(remindDay, d));
      assert.strictEqual(later.planned, 0, `lead ${lead}: not again ${d} day(s) later`);
    }
    assert.strictEqual(sent.size, 1);
  }
  ok('a reminder is sent on the day, or 1, 3 or 7 days before, and never twice for one due date');

  // 3. A missed daily run is caught up inside the window; running twice adds nothing.
  settings = [plan({ leadDays: 3 })];
  sent.clear();
  let summary = await run('2026-11-13');
  assert.strictEqual(summary.planned, 1, 'the 12th was missed; sent on the 13th');
  summary = await run('2026-11-13');
  assert.deepStrictEqual([summary.planned, summary.alreadySent], [0, 1]);
  assert.strictEqual((await run('2026-12-12')).planned, 1, 'next month has its own reminder');
  ok('a missed day is caught up, and a repeated run sends nothing new');

  // 4. Paused sends nothing; a child moved to another parent is skipped.
  settings = [plan({ status: 'paused' })];
  sent.clear();
  assert.strictEqual((await run('2026-11-15')).planned, 0);
  settings = [plan({ parentId: otherParent })];
  assert.strictEqual((await run('2026-11-15')).planned, 0, 'not this parent\'s child any more');
  ok('paused reminders send nothing; a reminder never goes to someone who is not the child\'s parent');

  // 5. API: only the parent, validated, edit keeps the cycle, delete turns off.
  const handler = (method, path) => router.stack
    .find((l) => l.route && l.route.path === path && l.route.methods[method]).route.stack.slice(-1)[0].handle;
  const call = async (method, path, params, body, user = { userId: String(parentId), role: 'parent' }) => {
    let out = null;
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { out = { status: this.statusCode, body: b }; } };
    await handler(method, path)({ params, body, user }, res);
    return out;
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    settings = [];
    let r = await call('put', '/assessment/:childId', { childId: String(otherChild._id) }, { frequencyMonths: 1, dayOfMonth: 5, leadDays: 0 });
    assert.strictEqual(r.status, 403, 'another parent\'s child');
    for (const bad of [{ frequencyMonths: 4, dayOfMonth: 5, leadDays: 0 }, { frequencyMonths: 1, dayOfMonth: 29, leadDays: 0 }, { frequencyMonths: 1, dayOfMonth: 5, leadDays: 2 }]) {
      r = await call('put', '/assessment/:childId', { childId: String(child._id) }, bad);
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
    assert.strictEqual(settings.length, 0, 'nothing saved by refused requests');

    r = await call('put', '/assessment/:childId', { childId: String(child._id) }, { frequencyMonths: 2, dayOfMonth: 10, leadDays: 3 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const today = reminders.clinicToday();
    assert.strictEqual(settings[0].startMonth, reminders.firstDueMonth(10, today));
    assert.deepStrictEqual(
      [r.body.reminder.status, r.body.reminder.nextDueDate, r.body.reminder.nextReminderDate],
      ['active', ...Object.values(reminders.nextPlanDates(settings[0], today))]
    );
    const cycle = settings[0].startMonth;

    settings[0].startMonth = '2025-01'; // as if set up long ago
    r = await call('put', '/assessment/:childId', { childId: String(child._id) }, { frequencyMonths: 2, dayOfMonth: 10, leadDays: 7, status: 'paused' });
    assert.deepStrictEqual([r.body.reminder.status, settings[0].startMonth, settings[0].leadDays], ['paused', '2025-01', 7], 'pause / timing change keeps the cycle');
    r = await call('put', '/assessment/:childId', { childId: String(child._id) }, { frequencyMonths: 2, dayOfMonth: 10, leadDays: 7, status: 'active' });
    assert.strictEqual(settings[0].startMonth, '2025-01', 'resume keeps the cycle');
    r = await call('put', '/assessment/:childId', { childId: String(child._id) }, { frequencyMonths: 3, dayOfMonth: 10, leadDays: 7 });
    assert.strictEqual(settings[0].startMonth, cycle, 'a new frequency starts a new cycle from the next matching day');

    r = await call('get', '/assessment', {}, {});
    assert.deepStrictEqual(r.body.children.map((c) => [c.childName, c.reminder && c.reminder.frequencyMonths]), [['Kemri Soto', 3]], 'only this parent\'s children');

    r = await call('delete', '/assessment/:childId', { childId: String(child._id) }, {});
    assert.deepStrictEqual([r.status, r.body.reminder, settings.length], [200, null, 0], 'turned off');
    r = await call('delete', '/assessment/:childId', { childId: String(otherChild._id) }, {});
    assert.strictEqual(r.status, 403);
  } finally {
    console.error = quiet;
  }
  ok('API: only the child\'s parent; bad values refused; pause/resume/timing keep the cycle; turn off removes it');

  console.log('Assessment plan reminder tests OK');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
