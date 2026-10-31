// Developmental task scheduling: a parent schedules a recommended home activity
// for a Manila date and time, marks it completed (optional 0-100% score) or
// missed, reschedules or removes it, and gets a bell reminder before it.
// Exercises routes/recommendations.js (POST /:recommendationId/schedule,
// PATCH and DELETE /schedule/:taskId, scheduledTasks on GET /:assessmentId)
// and services/reminders.js activityReminders against an in-memory store.
//
// No DB, no network: bufferCommands is off, so any model call this file does
// not stub fails immediately instead of waiting for a connection.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const Recommendation = require('../../models/Recommendation');
const ActivitySchedule = require('../../models/ActivitySchedule');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const recommendationsRouter = require('../../routes/recommendations');
const reminders = require('../../services/reminders');

const oid = () => new mongoose.Types.ObjectId();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const same = (a, b) => String(a) === String(b);
const chain = (get) => {
  const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => clone(get()),
    then: (a, b) => Promise.resolve(get()).then(a, b) };
  return o;
};

// ── In-memory store ───────────────────────────────────────────────────────
const db = { children: [], links: [], assessments: [], results: [], recs: [], tasks: [] };

Child.findById = (id) => chain(() => db.children.find((c) => same(c._id, id)) || null);
Child.find = (q) => chain(() => db.children.filter((c) => q._id.$in.some((id) => same(id, c._id))));
GuardianLink.findOne = (f) => chain(() => db.links.find((l) =>
  same(l.childId, f.childId) && same(l.guardianId, f.guardianId) && l.status === f.status) || null);
Appointment.countDocuments = async () => 0;
User.find = () => chain(() => []);
Assessment.findById = (id) => chain(() => db.assessments.find((a) => same(a._id, id)) || null);
AssessmentResult.findOne = (f) => chain(() => db.results.find((r) => same(r.assessmentId, f.assessmentId)) || null);
AssessmentResult.findById = (id) => chain(() => db.results.find((r) => same(r._id, id)) || null);

Recommendation.findById = (id) => chain(() => db.recs.find((r) => same(r._id, id)) || null);
Recommendation.find = (f) => chain(() => db.recs.filter((r) => same(r.assessmentResultId, f.assessmentResultId)));
Recommendation.insertMany = async (rows) => { db.recs.push(...rows.map((r) => ({ _id: oid(), completedActivities: [], ...r }))); };
// The $ne-guarded push the route sends when a session is completed.
Recommendation.updateOne = async (filter, update) => {
  const rec = db.recs.find((r) => same(r._id, filter._id));
  const notIn = filter['completedActivities.activity'] && filter['completedActivities.activity'].$ne;
  if (!rec || (notIn !== undefined && rec.completedActivities.some((c) => c.activity === notIn))) return { modifiedCount: 0 };
  if (update.$push) rec.completedActivities.push(clone(update.$push.completedActivities));
  if (update.$pull) rec.completedActivities = rec.completedActivities.filter((c) => c.activity !== update.$pull.completedActivities.activity);
  return { modifiedCount: 1 };
};

let writes = 0;
ActivitySchedule.find = (f) => chain(() => db.tasks.filter((t) => {
  if (f.recommendationId) return f.recommendationId.$in.some((id) => same(id, t.recommendationId));
  return t.status === f.status && f.scheduledDate.$in.includes(t.scheduledDate);
}));
ActivitySchedule.findById = (id) => chain(() => db.tasks.find((t) => same(t._id, id)) || null);
ActivitySchedule.create = async (doc) => {
  writes += 1;
  const task = { _id: oid(), status: 'pending', score: null, completedAt: null, ...doc };
  db.tasks.push(task);
  return clone(task);
};
ActivitySchedule.findByIdAndUpdate = (id, { $set }) => {
  writes += 1;
  const task = db.tasks.find((t) => same(t._id, id));
  if (task) Object.assign(task, $set);
  return chain(() => task || null);
};
ActivitySchedule.deleteOne = async (f) => {
  writes += 1;
  db.tasks = db.tasks.filter((t) => !same(t._id, f._id));
  return { deletedCount: 1 };
};

const sent = new Map();
Notification.create = async (doc) => {
  if (sent.has(doc.reminderKey)) { const e = new Error('dup'); e.code = 11000; throw e; }
  sent.set(doc.reminderKey, doc);
  return doc;
};

async function call(method, routePath, user, { params = {}, body = {} } = {}) {
  const layer = recommendationsRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `${method} ${routePath} exists`);
  const res = {
    statusCode: 200, body: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const req = { params, body, query: {}, user };
  try {
    for (const { handle } of layer.route.stack) {
      if (handle.name === 'authMiddleware') continue;
      let nextCalled = false;
      await handle(req, res, () => { nextCalled = true; });
      if (!nextCalled) break;
    }
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
  return res;
}

const person = (role) => ({ userId: String(oid()), role });
const parent = person('parent');
const otherParent = person('parent');
const guardian = person('legal_guardian');
const pediatrician = person('pediatrician');

const today = reminders.clinicToday();
const tomorrow = reminders.addDays(today, 1);
const yesterday = reminders.addDays(today, -1);

const getPlan = (user, assessmentId) => call('get', '/:assessmentId', user, { params: { assessmentId } });
const schedule = (user, rec, body) => call('post', '/:recommendationId/schedule', user, { params: { recommendationId: rec.id }, body });
const update = (user, taskId, body) => call('patch', '/schedule/:taskId', user, { params: { taskId }, body });
const remove = (user, taskId) => call('delete', '/schedule/:taskId', user, { params: { taskId } });

const results = [];
const ok = (m) => results.push(m);

async function run() {
  const child = { _id: oid(), parentId: parent.userId, firstName: 'Ana', lastName: 'Cruz' };
  db.children.push(child);
  const assessment = { _id: oid(), childId: child._id, status: 'complete' };
  db.assessments.push(assessment);
  db.results.push({ _id: oid(), assessmentId: assessment._id, childId: child._id,
    communicationScore: 30, socialScore: 65, cognitiveScore: 85, motorScore: 50, overallScore: 58 });
  const assessmentId = String(assessment._id);

  // 1. Activities are listed under their domains, each with its own (empty) schedule.
  let res = await getPlan(parent, assessmentId);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.recommendations.map((r) => r.skill), ['communication', 'social', 'cognitive', 'motor']);
  assert.ok(res.body.recommendations.every((r) => Array.isArray(r.scheduledTasks) && r.scheduledTasks.length === 0));
  const comm = res.body.recommendations.find((r) => r.skill === 'communication');
  const motor = res.body.recommendations.find((r) => r.skill === 'motor');
  ok('GET lists each domain\'s activities with an empty schedule');

  // 2. Scheduling validates the activity, date and time.
  for (const [body, label] of [
    [{ activity: 'Not a real activity', date: tomorrow, time: '16:00' }, 'foreign activity'],
    [{ activity: motor.activities[0], date: tomorrow, time: '16:00' }, 'activity of another domain'],
    [{ activity: comm.activities[0], date: yesterday, time: '16:00' }, 'past date'],
    [{ activity: comm.activities[0], date: '2026-02-30', time: '16:00' }, 'impossible date'],
    [{ activity: comm.activities[0], date: reminders.addDays(today, 366), time: '16:00' }, 'more than a year ahead'],
    [{ activity: comm.activities[0], date: tomorrow, time: '24:00' }, 'bad time'],
    [{ activity: comm.activities[0], date: tomorrow }, 'missing time'],
  ]) {
    res = await schedule(parent, comm, body);
    assert.strictEqual(res.statusCode, 400, `${label} is refused`);
  }
  res = await call('post', '/:recommendationId/schedule', parent, { params: { recommendationId: 'nope' }, body: {} });
  assert.strictEqual(res.statusCode, 400, 'invalid id');
  assert.strictEqual(writes, 0, 'refused requests never write');

  res = await schedule(parent, comm, { activity: comm.activities[0], date: tomorrow, time: '16:00' });
  assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
  const first = res.body.task;
  assert.deepStrictEqual(
    [first.skill, first.activity, first.scheduledDate, first.scheduledTime, first.status, first.score],
    ['communication', comm.activities[0], tomorrow, '16:00', 'pending', null]);
  const stored = db.tasks.find((t) => same(t._id, first.id));
  assert.ok(same(stored.childId, child._id) && same(stored.assessmentId, assessmentId) && same(stored.createdBy, parent.userId));
  res = await schedule(parent, comm, { activity: comm.activities[0], date: today, time: '23:59' });
  assert.strictEqual(res.statusCode, 201, 'today is allowed; one activity can have several sessions');
  const second = res.body.task;
  ok('scheduling validates activity, date and time and records child, assessment and creator');

  // 3. Authorization: only the parent or a guardian with viewRecommendations.
  const before = writes;
  for (const [who, label] of [[otherParent, 'another parent'], [pediatrician, 'pediatrician'], [guardian, 'unlinked guardian']]) {
    assert.strictEqual((await schedule(who, comm, { activity: comm.activities[1], date: tomorrow, time: '09:00' })).statusCode, 403, `${label} cannot schedule`);
    assert.strictEqual((await update(who, first.id, { status: 'missed' })).statusCode, 403, `${label} cannot update`);
    assert.strictEqual((await remove(who, first.id)).statusCode, 403, `${label} cannot remove`);
  }
  db.links.push({ childId: child._id, guardianId: guardian.userId, status: 'active', permissions: { viewRecommendations: false } });
  assert.strictEqual((await schedule(guardian, comm, { activity: comm.activities[1], date: tomorrow, time: '09:00' })).statusCode, 403);
  assert.strictEqual(writes, before, 'refused requests never write');
  db.links[0].permissions.viewRecommendations = true;
  res = await schedule(guardian, comm, { activity: comm.activities[1], date: tomorrow, time: '09:00' });
  assert.strictEqual(res.statusCode, 201, 'guardian with viewRecommendations may schedule');
  const guardianTask = res.body.task;
  assert.strictEqual((await update(parent, 'nope', { status: 'missed' })).statusCode, 400);
  assert.strictEqual((await update(parent, String(oid()), { status: 'missed' })).statusCode, 404);
  ok('only the parent or a permitted guardian schedules, updates or removes');

  // 4. Completed with a score ticks the activity; a bad score is refused.
  for (const score of [101, -1, 50.5, 'lots']) {
    assert.strictEqual((await update(parent, first.id, { status: 'completed', score })).statusCode, 400, `score ${score} refused`);
  }
  assert.strictEqual((await update(parent, first.id, { status: 'done' })).statusCode, 400, 'unknown status refused');
  res = await update(parent, first.id, { status: 'completed', score: 80 });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([res.body.task.status, res.body.task.score], ['completed', 80]);
  assert.ok(res.body.task.completedAt);
  assert.deepStrictEqual(res.body.completedActivities, [comm.activities[0]], 'completing a session ticks the activity');
  assert.strictEqual(res.body.activityProgress.completed, 1);
  res = await update(parent, second.id, { status: 'completed' });
  assert.deepStrictEqual([res.body.task.status, res.body.task.score], ['completed', null], 'score is optional');
  assert.strictEqual(res.body.activityProgress.completed, 1, 'the tick is never duplicated');
  res = await update(parent, second.id, { status: 'pending' });
  assert.deepStrictEqual([res.body.task.status, res.body.task.score, res.body.task.completedAt], ['pending', null, null]);
  assert.deepStrictEqual(res.body.completedActivities, [comm.activities[0]], 'reverting a session never unticks');
  ok('completed with an optional 0-100 score ticks the activity once, and never unticks');

  // 5. Missed: set by the parent, or derived once a pending session's day has passed.
  res = await update(parent, guardianTask.id, { status: 'missed' });
  assert.deepStrictEqual([res.body.task.status, res.body.activityProgress.completed], ['missed', 1]);
  db.tasks.push({ _id: oid(), childId: child._id, recommendationId: oid(), skill: 'motor', activity: 'x', scheduledDate: yesterday, scheduledTime: '10:00', status: 'pending', createdBy: parent.userId });
  const lapsed = db.tasks[db.tasks.length - 1];
  lapsed.recommendationId = db.recs.find((r) => r.skill === 'motor')._id;
  res = await getPlan(parent, assessmentId);
  const motorTasks = res.body.recommendations.find((r) => r.skill === 'motor').scheduledTasks;
  assert.deepStrictEqual(motorTasks.map((t) => t.status), ['missed'], 'a pending session from yesterday shows as missed');
  const commTasks = res.body.recommendations.find((r) => r.skill === 'communication').scheduledTasks;
  assert.deepStrictEqual(commTasks.map((t) => t.id), [second.id, guardianTask.id, first.id], 'sessions come soonest first');
  const { effectiveStatus } = recommendationsRouter.__testables;
  assert.strictEqual(effectiveStatus({ status: 'pending', scheduledDate: today }, today), 'pending', 'still pending on its own day');
  assert.strictEqual(effectiveStatus({ status: 'completed', scheduledDate: yesterday }, today), 'completed');
  ok('missed is set by the parent or derived after the day ends; GET lists sessions per domain, soonest first');

  // 6. Reschedule puts the session back to pending; remove deletes it.
  assert.strictEqual((await update(parent, guardianTask.id, { date: yesterday })).statusCode, 400, 'cannot move into the past');
  res = await update(parent, guardianTask.id, { date: reminders.addDays(today, 3), time: '10:30' });
  assert.deepStrictEqual([res.body.task.status, res.body.task.scheduledDate, res.body.task.scheduledTime], ['pending', reminders.addDays(today, 3), '10:30']);
  res = await remove(parent, lapsed._id.toString());
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!db.tasks.some((t) => same(t._id, lapsed._id)));
  assert.strictEqual((await remove(parent, String(lapsed._id))).statusCode, 404);
  ok('reschedule resets to pending (never into the past); remove deletes');

  // 7. Reminders: pending sessions today (still ahead) or tomorrow, once each,
  //    to whoever scheduled them; a rescheduled session is reminded again.
  db.tasks = [];
  const t = (date, time, extra = {}) => {
    const task = { _id: oid(), childId: child._id, assessmentId: assessment._id, skill: 'communication', activity: 'Read together 20 min/day',
      scheduledDate: date, scheduledTime: time, status: 'pending', createdBy: parent.userId, ...extra };
    db.tasks.push(task);
    return task;
  };
  // "Now" is the cron's run at 08:00 Manila on 2026-11-02.
  const runDay = '2026-11-02';
  const NOW = new Date('2026-11-02T00:00:00Z');
  const laterToday = t(runDay, '17:00');
  t(runDay, '07:30'); // already past at 08:00
  const tmrw = t('2026-11-03', '09:15', { createdBy: guardian.userId, skill: 'motor', activity: 'Outdoor play' });
  t('2026-11-04', '09:00'); // two days ahead: next run
  t('2026-11-03', '10:00', { status: 'completed' });
  t('2026-11-03', '11:00', { status: 'missed' });

  const { activityReminders, sendOnce } = reminders._internals;
  let list = await activityReminders(runDay, NOW);
  assert.deepStrictEqual(list.map((r) => r.relatedId).sort(), [String(laterToday._id), String(tmrw._id)].sort());
  const forToday = list.find((r) => r.relatedId === String(laterToday._id));
  assert.strictEqual(forToday.title, 'Activity Reminder');
  assert.strictEqual(forToday.type, 'activity_reminder');
  assert.ok(same(forToday.userId, parent.userId));
  assert.strictEqual(forToday.message, 'Reminder: Ana Cruz\'s Communication activity "Read together 20 min/day" is scheduled today, November 2, 2026, at 5:00 PM.');
  assert.strictEqual(forToday.relatedPage, `/parent/recommendations?childId=${child._id}&assessmentId=${assessment._id}`);
  const forTomorrow = list.find((r) => r.relatedId === String(tmrw._id));
  assert.ok(same(forTomorrow.userId, guardian.userId), 'the guardian who scheduled it is reminded');
  assert.ok(forTomorrow.message.includes('Motor Skills activity "Outdoor play" is scheduled tomorrow, November 3, 2026, at 9:15 AM'));

  for (const r of list) assert.strictEqual(await sendOnce(r), true);
  // Next day's run: tomorrow's session is now "today" but was already sent.
  list = await activityReminders('2026-11-03', new Date('2026-11-03T00:00:00Z'));
  const again = await Promise.all(list.map(sendOnce));
  assert.deepStrictEqual(list.map((r) => r.relatedId).sort(), [String(tmrw._id), db.tasks[3]._id.toString()].sort());
  assert.deepStrictEqual(list.map((r, i) => [r.relatedId, again[i]]).find(([id]) => id === String(tmrw._id)), [String(tmrw._id), false], 'never reminded twice');
  tmrw.scheduledTime = '15:00';
  list = await activityReminders('2026-11-03', new Date('2026-11-03T00:00:00Z'));
  assert.strictEqual(await sendOnce(list.find((r) => r.relatedId === String(tmrw._id))), true, 'a rescheduled session is reminded again');
  ok('reminders: today (still ahead) and tomorrow, pending only, once each, to the scheduler; reschedules re-remind');

  // 8. runReminders reports them in its summary.
  require('../../models/AssessmentReminder').find = () => ({ lean: async () => [] });
  require('../../models/FollowUpPlan').find = () => chain(() => []);
  Appointment.find = () => chain(() => []);
  Assessment.find = () => chain(() => []);
  sent.clear();
  const summary = await reminders.runReminders(NOW);
  assert.strictEqual(summary.activities, 2);
  ok('runReminders counts activity reminders');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Activity scheduling tests OK — ${results.length} groups`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
