// Email copies of the daily reminders (services/reminders.js emailNewReminders,
// services/emailService.js sendReminderEmail).
//
// - Every reminder the run creates is emailed once to the parent; a reminder
//   that was already sent is never emailed again.
// - Reminder Emails off (notificationSettings.emailReminders === false) or no
//   address: bell only. A failed or slow email never blocks the run.
// - The email repeats the bell's title and message with a link to the page.
//
// No DB, no network: models and the email provider are stubbed in memory.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.APP_URL = 'https://kindercura.test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const AssessmentReminder = require('../../models/AssessmentReminder');
const httpEmail = require('../../services/httpEmail');
const emailService = require('../../services/emailService');
const reminders = require('../../services/reminders');

const ok = (m) => console.log('  ok -', m);
const oid = () => new mongoose.Types.ObjectId();
const q = (v) => { const o = { select: () => o, lean: async () => v, sort: () => o, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
const same = (a, b) => String(a) === String(b);
const ROOT = path.join(__dirname, '..', '..');

const parentA = { _id: oid(), firstName: 'Ana', email: 'ana@example.invalid', notificationSettings: {} };
const parentB = { _id: oid(), firstName: 'Ben', email: 'ben@example.invalid', notificationSettings: { emailReminders: false } };
const parentC = { _id: oid(), firstName: 'Cy', email: '', notificationSettings: {} };
const kids = [parentA, parentB, parentC].map((p, i) => ({ _id: oid(), firstName: ['Kemri', 'Liam', 'Mia'][i], lastName: 'Soto', parentId: p._id }));
const plan = (child) => ({ _id: oid(), childId: child._id, parentId: child.parentId, frequencyMonths: 1, dayOfMonth: 1, leadDays: 3, status: 'active', startMonth: '2026-11' });

const sent = new Map();
let settings = [];
Appointment.find = () => q([]);
require('../../models/FollowUpPlan').find = () => q([]); // none here: tests/unit/follow-up-plans.test.js
// No scheduled home activities here (tests/unit/activity-scheduling.test.js).
require('../../models/ActivitySchedule').find = () => ({ select: () => ({ lean: async () => [] }) });
Assessment.find = () => q([]);
AssessmentReminder.find = () => q(settings);
Child.find = (f) => q(kids.filter((c) => f._id.$in.some((id) => same(id, c._id))));
User.find = (f) => q([parentA, parentB, parentC].filter((p) => f._id.$in.some((id) => same(id, p._id))));
Notification.create = async (doc) => {
  if (sent.has(doc.reminderKey)) throw Object.assign(new Error('dup'), { code: 11000 });
  sent.set(doc.reminderKey, doc);
  return doc;
};

const realSendReminderEmail = emailService.sendReminderEmail;
let emails = [];
let mode = 'ok';
emailService.sendReminderEmail = async (args) => {
  emails.push(args);
  if (mode === 'fail') return { sent: false, reason: 'SEND_FAILED' };
  if (mode === 'hang') return new Promise(() => {});
  return { sent: true };
};

const NOW = new Date('2026-10-30T00:00:00Z'); // 8:00 AM Manila, Nov 1 is 2 days away

(async () => {
  // 1. Each new reminder is emailed once; a repeat run emails nothing.
  settings = [plan(kids[0])];
  let summary = await reminders.runReminders(NOW);
  assert.deepStrictEqual([summary.planned, summary.emailed, summary.emailFailed], [1, 1, 0]);
  assert.strictEqual(emails.length, 1);
  const bell = [...sent.values()][0];
  assert.deepStrictEqual(emails[0], {
    to: 'ana@example.invalid', name: 'Ana', title: bell.title, message: bell.message, relatedPage: '/parent/screening',
  }, 'the email repeats the bell reminder');
  summary = await reminders.runReminders(NOW);
  assert.deepStrictEqual([summary.planned, summary.alreadySent, summary.emailed], [0, 1, 0]);
  assert.strictEqual(emails.length, 1, 'an already-sent reminder is never emailed again');
  ok('a new reminder is emailed to the parent once, with the same title and message as the bell');

  // 2. Reminder Emails off, or no address: bell only.
  sent.clear(); emails = [];
  settings = [plan(kids[1]), plan(kids[2])];
  summary = await reminders.runReminders(NOW);
  assert.deepStrictEqual([summary.planned, summary.emailed, summary.emailFailed, emails.length], [2, 0, 0, 0]);
  ok('Reminder Emails off, or no email address: the bell reminder only');

  // 3. A failed email is counted and never blocks the bell reminder.
  sent.clear(); emails = []; mode = 'fail';
  settings = [plan(kids[0])];
  summary = await reminders.runReminders(NOW);
  assert.deepStrictEqual([summary.planned, summary.emailed, summary.emailFailed], [1, 0, 1]);
  assert.strictEqual(sent.size, 1);
  ok('a failed email is counted; the bell reminder is still there');

  // 4. A stuck email provider cannot hold the run past the email budget.
  sent.clear(); emails = []; mode = 'hang';
  const started = Date.now();
  summary = await reminders.runReminders(NOW);
  const took = Date.now() - started;
  assert.ok(took >= reminders._internals.EMAIL_BUDGET_MS - 50 && took < reminders._internals.EMAIL_BUDGET_MS + 1500, `took ${took} ms`);
  assert.deepStrictEqual([summary.planned, summary.emailed, summary.emailFailed], [1, 0, 1]);
  ok(`a hanging email gives up after ${reminders._internals.EMAIL_BUDGET_MS / 1000} s, inside Vercel's time limit`);

  // 5. The email itself: subject, escaped message, link to the page, plain text.
  const delivered = [];
  httpEmail.httpEmailConfigured = () => true;
  httpEmail.sendViaHttp = async (msg) => { delivered.push(msg); };
  const out = await realSendReminderEmail({
    to: 'ana@example.invalid', name: 'Ana <b>', title: 'Assessment Reminder',
    message: "Reminder: Kemri Soto's developmental assessment is due on November 1, 2026 (in 2 days).", relatedPage: '/parent/screening',
  });
  assert.strictEqual(out.sent, true);
  assert.strictEqual(delivered[0].to, 'ana@example.invalid');
  assert.strictEqual(delivered[0].subject, 'KinderCura: Assessment Reminder');
  assert.ok(delivered[0].html.includes('href="https://kindercura.test/parent/screening"'), 'button links to the page');
  assert.ok(delivered[0].html.includes('Ana &lt;b&gt;') && !delivered[0].html.includes('Ana <b>'), 'names are escaped');
  assert.ok(delivered[0].html.includes("Kemri Soto's developmental assessment is due on November 1, 2026"));  assert.ok(/Reminder Emails is on in Settings/.test(delivered[0].html), 'says how to turn it off');
  ok('the email has the reminder text, a link to the page, and how to turn it off');

  // 6. The setting: stored on the user, saved and returned for parents, on the Settings page.
  assert.strictEqual(User.schema.path('notificationSettings.emailReminders').defaultValue, true, 'on by default');
  const auth = fs.readFileSync(path.join(ROOT, 'routes', 'auth.js'), 'utf8');
  assert.ok(auth.includes("const PARENT_NOTIFICATION_PREF_KEYS = ['emailAppointments', 'emailReminders'];"), 'parents can save it');
  assert.ok(auth.includes('emailReminders: Boolean(user.notificationSettings?.emailReminders ?? true)'), '/auth/me returns it');
  const page = fs.readFileSync(path.join(ROOT, 'PARENT', 'settings.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'js', 'parent', 'settings.js'), 'utf8');
  assert.ok(page.includes('id="prefEmailReminders"') && script.includes("prefEmailReminders: 'emailReminders'"));
  ok('Reminder Emails is a saved parent setting, on by default, on Settings > Notifications');

  console.log('Reminder email tests OK');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
