// Scheduled reminders for parents, run once a day by the Vercel cron in
// vercel.json (GET /api/reminders/run, routes/reminders.js).
//
// Three reminders, all in-app bell notifications to the child's parent:
//   - an approved appointment that is tomorrow (Manila day);
//   - a next-assessment date the pediatrician set that has arrived (today or
//     in the last week, in case a daily run was missed), unless the child has
//     already been screened again since that review;
//   - the parent's own recurring assessment reminder for a child
//     (models/AssessmentReminder.js), on the due day or up to 7 days before;
//   - an active Follow-up Check-up plan (models/FollowUpPlan.js) with
//     assessments still to do, 7, 3 and 1 days before its deadline and on it.
//
// Each new reminder is also emailed to the parent unless they turned Reminder
// Emails off (User.notificationSettings.emailReminders).
//
// Each reminder carries a reminderKey with a unique index on Notification, so
// running the job again (or twice at once) never sends the same one twice. A
// rescheduled appointment gets a new key because the date is part of it.
const Appointment = require('../models/Appointment');
const Assessment = require('../models/Assessment');
const Child = require('../models/Child');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AssessmentReminder = require('../models/AssessmentReminder');
const FollowUpPlan = require('../models/FollowUpPlan');
const emailService = require('./emailService');
const { CLINIC_TIMEZONE, clinicDayStart, clinicDayEnd } = require('../constants/clinicTime');

const ASSESSMENT_LOOKBACK_DAYS = 7;

/** Today's date in clinic time, as YYYY-MM-DD. */
function clinicToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatYmd(ymd) {
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatTime(value) {
  const [rawH, rawM] = String(value || '').split(':');
  const h = parseInt(rawH, 10);
  if (Number.isNaN(h)) return String(value || '');
  return `${h % 12 || 12}:${String(rawM || '00').padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

const personName = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ');

async function namesById(Model, ids) {
  const docs = ids.length ? await Model.find({ _id: { $in: ids } }).select('firstName lastName parentId').lean() : [];
  return new Map(docs.map((d) => [String(d._id), d]));
}

// Creates the notification unless one with the same reminderKey exists.
// Returns true when a new one was created.
async function sendOnce(reminder) {
  try {
    await Notification.create({ ...reminder, isRead: false });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    throw err;
  }
}

// Approved appointments on tomorrow's Manila date. Appointment dates are
// stored as UTC midnight of the booked day (routes/appointments.js).
async function appointmentReminders(today) {
  const tomorrow = addDays(today, 1);
  const appts = await Appointment.find({
    status: 'approved',
    appointmentDate: { $gte: new Date(`${tomorrow}T00:00:00.000Z`), $lt: new Date(`${addDays(tomorrow, 1)}T00:00:00.000Z`) },
    parentId: { $ne: null },
    isSynthetic: { $ne: true },
  }).select('id parentId childId pediatricianId appointmentTime').lean();

  const children = await namesById(Child, appts.map((a) => a.childId));
  const doctors = await namesById(User, appts.filter((a) => a.pediatricianId).map((a) => a.pediatricianId));

  return appts.map((a) => {
    const child = personName(children.get(String(a.childId))) || 'your child';
    const doctor = personName(doctors.get(String(a.pediatricianId)));
    return {
      userId: a.parentId,
      title: 'Appointment Reminder',
      message: `Reminder: ${child} has an appointment tomorrow, ${formatYmd(tomorrow)}, at ${formatTime(a.appointmentTime)}${doctor ? ` with Dr. ${doctor}` : ''}.`,
      type: 'appointment',
      relatedPage: '/parent/appointments',
      relatedId: String(a.id),
      reminderKey: `appointment:${a.id}:${tomorrow}`,
    };
  });
}

// Next-assessment dates that have arrived. The diagnose route stores the date
// at noon server time, so the Manila-day window catches it on Vercel (UTC)
// and locally (Manila) alike. Only the child's latest reviewed date counts,
// and none is sent once the child has a newer completed screening.
async function assessmentReminders(today) {
  const due = await Assessment.find({
    nextAssessmentDate: { $gte: clinicDayStart(addDays(today, -ASSESSMENT_LOOKBACK_DAYS)), $lte: clinicDayEnd(today) },
    isSynthetic: { $ne: true },
  }).select('childId nextAssessmentDate completedAt createdAt').lean();
  if (!due.length) return [];

  const childIds = [...new Set(due.map((a) => String(a.childId)))];
  const latest = await Assessment.aggregate([
    { $match: { childId: { $in: due.map((a) => a.childId) }, status: 'complete' } },
    { $group: { _id: '$childId', at: { $max: { $ifNull: ['$completedAt', '$createdAt'] } } } },
  ]);
  const latestAt = new Map(latest.map((r) => [String(r._id), r.at]));
  const children = await namesById(Child, childIds);

  const byChild = new Map();
  for (const a of due) {
    const key = String(a.childId);
    const at = a.completedAt || a.createdAt;
    const current = byChild.get(key);
    if (!current || (current.completedAt || current.createdAt) < at) byChild.set(key, a);
  }

  const reminders = [];
  for (const [childId, a] of byChild) {
    const child = children.get(childId);
    if (!child || !child.parentId) continue;
    const reviewedAt = a.completedAt || a.createdAt;
    const newest = latestAt.get(childId);
    if (newest && reviewedAt && newest > reviewedAt) continue;
    const dueYmd = new Date(a.nextAssessmentDate).toISOString().slice(0, 10);
    reminders.push({
      userId: child.parentId,
      title: 'Assessment Reminder',
      message: `${personName(child) || 'Your child'} is due for the next developmental assessment (scheduled for ${formatYmd(dueYmd)}). Open Screening to start it.`,
      type: 'assessment_reminder',
      relatedPage: '/parent/screening',
      relatedId: String(a._id),
      reminderKey: `assessment:${a._id}:${dueYmd}`,
    });
  }
  return reminders;
}

// ── Parent-set recurring reminders (models/AssessmentReminder.js) ──────────
// Due dates are `dayOfMonth` in `startMonth` and every `frequencyMonths`
// after it, all as Manila YYYY-MM-DD strings.

const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

function addMonths(ym, n) {
  const i = monthIndex(ym) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

const dueOn = (ym, dayOfMonth) => `${ym}-${String(dayOfMonth).padStart(2, '0')}`;

/** Month of the first due date on or after today: this month if the day has not passed. */
function firstDueMonth(dayOfMonth, today) {
  const thisMonth = today.slice(0, 7);
  return Number(today.slice(8, 10)) <= dayOfMonth ? thisMonth : addMonths(thisMonth, 1);
}

function isPlanDueDate(setting, ymd) {
  if (Number(ymd.slice(8, 10)) !== setting.dayOfMonth) return false;
  const diff = monthIndex(ymd.slice(0, 7)) - monthIndex(setting.startMonth);
  return diff >= 0 && diff % setting.frequencyMonths === 0;
}

/** The first due date on or after today, and when its reminder goes out. */
function nextPlanDates(setting, today) {
  const f = setting.frequencyMonths;
  let ym = setting.startMonth;
  const behind = monthIndex(today.slice(0, 7)) - monthIndex(ym);
  if (behind > 0) ym = addMonths(ym, Math.ceil(behind / f) * f);
  let due = dueOn(ym, setting.dayOfMonth);
  if (due < today) due = dueOn(addMonths(ym, f), setting.dayOfMonth);
  const remindOn = addDays(due, -setting.leadDays);
  return { nextDueDate: due, nextReminderDate: remindOn < today ? today : remindOn };
}

// A due date within [today, today + leadDays] is announced. A missed daily run
// is caught up the next day; the key keeps each due date to one notification.
async function planReminders(today) {
  const settings = await AssessmentReminder.find({ status: 'active' }).lean();
  if (!settings.length) return [];
  const children = await namesById(Child, [...new Set(settings.map((s) => String(s.childId)))]);

  const reminders = [];
  for (const s of settings) {
    const child = children.get(String(s.childId));
    if (!child || String(child.parentId || '') !== String(s.parentId)) continue;
    for (let d = 0; d <= s.leadDays; d += 1) {
      const due = addDays(today, d);
      if (!isPlanDueDate(s, due)) continue;
      const name = personName(child) || 'Your child';
      reminders.push({
        userId: s.parentId,
        title: 'Assessment Reminder',
        message: d === 0
          ? `Reminder: ${name}'s developmental assessment is due today. Open Screening to start it.`
          : `Reminder: ${name}'s developmental assessment is due on ${formatYmd(due)} (in ${d} day${d === 1 ? '' : 's'}). Open Screening to start it.`,
        type: 'assessment_reminder',
        relatedPage: '/parent/screening',
        relatedId: String(s.childId),
        reminderKey: `assessment-plan:${s.childId}:${due}`,
      });
    }
  }
  return reminders;
}

// ── Follow-up Check-up assessments (models/FollowUpPlan.js) ────────────────
// An active plan's deadline is the end of a Manila day. While assessments are
// still missing, the parent is reminded 7, 3 and 1 days before it and on the
// day. Completed means the child's completed screenings since the plan became
// active, the same count services/followUpPlans.js shows.
const FOLLOW_UP_REMINDER_DAYS = [7, 3, 1, 0];

async function followUpReminders(today) {
  const plans = await FollowUpPlan.find({
    status: 'active',
    dueDate: { $gte: clinicDayStart(today), $lte: clinicDayEnd(addDays(today, Math.max(...FOLLOW_UP_REMINDER_DAYS))) },
  }).select('childId parentId appointmentId requiredAssessments activatedAt dueDate').lean();
  if (!plans.length) return [];

  // A cancelled appointment ends the plan; a completed one means the visit
  // already happened.
  const live = await Appointment.find({ _id: { $in: plans.map((p) => p.appointmentId) }, status: 'approved' }).select('_id').lean();
  const liveIds = new Set(live.map((a) => String(a._id)));
  const children = await namesById(Child, [...new Set(plans.map((p) => String(p.childId)))]);
  const reminders = [];
  for (const plan of plans) {
    if (!liveIds.has(String(plan.appointmentId))) continue;
    const dueYmd = clinicToday(new Date(plan.dueDate));
    const daysLeft = FOLLOW_UP_REMINDER_DAYS.find((d) => addDays(today, d) === dueYmd);
    if (daysLeft === undefined) continue;
    const child = children.get(String(plan.childId));
    const parentId = plan.parentId || child?.parentId;
    if (!parentId) continue;
    const completed = await Assessment.countDocuments({ childId: plan.childId, status: 'complete', completedAt: { $gte: plan.activatedAt } });
    const remaining = plan.requiredAssessments - completed;
    if (remaining <= 0) continue;
    const name = personName(child) || 'your child';
    reminders.push({
      userId: parentId,
      title: 'Follow-up Assessment Reminder',
      message: `${completed} of ${plan.requiredAssessments} follow-up assessments done for ${name}; ${remaining} left, `
        + (daysLeft === 0 ? 'due today.' : `due ${formatYmd(dueYmd)} (in ${daysLeft} day${daysLeft === 1 ? '' : 's'}).`)
        + ' Open Screening to continue.',
      type: 'assessment_reminder',
      relatedPage: '/parent/screening',
      relatedId: String(plan._id),
      reminderKey: `follow-up-plan:${plan._id}:${today}`,
    });
  }
  return reminders;
}

// Email copy of each reminder this run created (never one that was already
// sent), unless the parent turned Reminder Emails off. The run must answer
// inside Vercel's ~10 s limit, so emails go out together and the run waits at
// most EMAIL_BUDGET_MS for them; the bell reminder is the guaranteed copy.
const EMAIL_BUDGET_MS = 5000;

async function emailNewReminders(created) {
  const result = { emailed: 0, emailFailed: 0 };
  if (!created.length) return result;
  const ids = [...new Set(created.map((r) => String(r.userId)))];
  const parents = await User.find({ _id: { $in: ids } }).select('firstName email notificationSettings').lean();
  const byId = new Map(parents.map((p) => [String(p._id), p]));

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), EMAIL_BUDGET_MS); });
  const outcomes = await Promise.all(created.map((r) => {
    const parent = byId.get(String(r.userId));
    if (!parent || !parent.email || parent.notificationSettings?.emailReminders === false) return 'skipped';
    const send = emailService.sendReminderEmail({
      to: parent.email,
      name: parent.firstName,
      title: r.title,
      message: r.message,
      relatedPage: r.relatedPage,
    }).then((out) => (out && out.sent ? 'sent' : 'failed'), () => 'failed');
    return Promise.race([send, deadline]);
  }));
  clearTimeout(timer);

  for (const outcome of outcomes) {
    if (outcome === 'sent') result.emailed += 1;
    else if (outcome !== 'skipped') result.emailFailed += 1;
  }
  return result;
}

async function runReminders(now = new Date()) {
  const today = clinicToday(now);
  const summary = { date: today, appointments: 0, assessments: 0, planned: 0, followUps: 0, alreadySent: 0, emailed: 0, emailFailed: 0 };
  const groups = [
    ['appointments', await appointmentReminders(today)],
    ['assessments', await assessmentReminders(today)],
    ['planned', await planReminders(today)],
    ['followUps', await followUpReminders(today)],
  ];
  const created = [];
  for (const [field, reminders] of groups) {
    for (const reminder of reminders) {
      if (await sendOnce(reminder)) {
        summary[field] += 1;
        created.push(reminder);
      } else {
        summary.alreadySent += 1;
      }
    }
  }
  Object.assign(summary, await emailNewReminders(created));
  return summary;
}

module.exports = {
  runReminders,
  clinicToday,
  addDays,
  firstDueMonth,
  nextPlanDates,
  _internals: { appointmentReminders, assessmentReminders, planReminders, followUpReminders, isPlanDueDate, sendOnce, emailNewReminders, EMAIL_BUDGET_MS },
};
