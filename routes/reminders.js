// routes/reminders.js
// GET /api/reminders/run, called once a day by the Vercel cron in vercel.json.
// Vercel sends "Authorization: Bearer <CRON_SECRET>" when the CRON_SECRET
// environment variable is set; without it the job refuses to run, so nobody
// else can trigger it. The work itself is in services/reminders.js.
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { authMiddleware } = require('../middleware/auth');
const Child = require('../models/Child');
const AssessmentReminder = require('../models/AssessmentReminder');
const { runReminders, clinicToday, firstDueMonth, nextPlanDates } = require('../services/reminders');

const router = express.Router();

function hasCronSecret(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(String(req.headers.authorization || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

router.get('/run', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Reminders are not configured (CRON_SECRET is not set).' });
  }
  if (!hasCronSecret(req)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const summary = await runReminders();
    console.log('[reminders]', JSON.stringify(summary));
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error('[reminders] run failed:', err);
    res.status(500).json({ error: 'Reminder run failed.' });
  }
});

// ── Parent's recurring assessment reminders, one per child ─────────────────
// Only the child's own parent (Child.parentId) can see or change them; the
// daily run above sends them.

const FREQUENCIES = [1, 2, 3];
const LEAD_DAYS = [0, 1, 3, 7];

function serialize(child, setting, today) {
  return {
    childId: String(child._id),
    childName: `${child.firstName || ''} ${child.lastName || ''}`.trim(),
    reminder: setting
      ? {
        frequencyMonths: setting.frequencyMonths,
        dayOfMonth: setting.dayOfMonth,
        leadDays: setting.leadDays,
        status: setting.status,
        ...(setting.status === 'active' ? nextPlanDates(setting, today) : {}),
      }
      : null,
  };
}

async function ownChild(req, res) {
  const { childId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(childId))) {
    res.status(404).json({ error: 'Child not found.' });
    return null;
  }
  const child = await Child.findById(childId).select('firstName lastName parentId').lean();
  if (!child) {
    res.status(404).json({ error: 'Child not found.' });
    return null;
  }
  if (String(child.parentId || '') !== String(req.user.userId)) {
    res.status(403).json({ error: 'Only the child\'s parent can set assessment reminders.' });
    return null;
  }
  return child;
}

// GET /api/reminders/assessment — every child of this parent, with its reminder.
router.get('/assessment', authMiddleware, async (req, res) => {
  try {
    const children = await Child.find({ parentId: req.user.userId }).select('firstName lastName parentId').lean();
    const settings = children.length
      ? await AssessmentReminder.find({ childId: { $in: children.map((c) => c._id) } }).lean()
      : [];
    const byChild = new Map(settings.map((s) => [String(s.childId), s]));
    const today = clinicToday();
    res.json({ success: true, today, children: children.map((c) => serialize(c, byChild.get(String(c._id)), today)) });
  } catch (err) {
    console.error('[reminders] list failed:', err);
    res.status(500).json({ error: 'Could not load assessment reminders.' });
  }
});

// PUT /api/reminders/assessment/:childId — create or edit; status pauses/resumes.
router.put('/assessment/:childId', authMiddleware, async (req, res) => {
  try {
    const child = await ownChild(req, res);
    if (!child) return;

    const frequencyMonths = Number(req.body?.frequencyMonths);
    const dayOfMonth = Number(req.body?.dayOfMonth);
    const leadDays = Number(req.body?.leadDays);
    const status = req.body?.status === 'paused' ? 'paused' : 'active';
    if (!FREQUENCIES.includes(frequencyMonths)) return res.status(400).json({ error: 'Frequency must be every 1, 2 or 3 months.' });
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) return res.status(400).json({ error: 'Day of the month must be from 1 to 28.' });
    if (!LEAD_DAYS.includes(leadDays)) return res.status(400).json({ error: 'Reminder timing must be on the day, or 1, 3 or 7 days before.' });

    const today = clinicToday();
    const existing = await AssessmentReminder.findOne({ childId: child._id }).lean();
    // A new schedule starts from the next matching day; pausing, resuming or
    // changing only the timing keeps the current cycle.
    const scheduleChanged = !existing
      || existing.frequencyMonths !== frequencyMonths
      || existing.dayOfMonth !== dayOfMonth;
    const startMonth = scheduleChanged ? firstDueMonth(dayOfMonth, today) : existing.startMonth;

    const setting = await AssessmentReminder.findOneAndUpdate(
      { childId: child._id },
      { $set: { parentId: child.parentId, frequencyMonths, dayOfMonth, leadDays, status, startMonth } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    res.json({ success: true, today, ...serialize(child, setting, today) });
  } catch (err) {
    console.error('[reminders] save failed:', err);
    res.status(500).json({ error: 'Could not save the assessment reminder.' });
  }
});

// DELETE /api/reminders/assessment/:childId — turn the reminder off.
router.delete('/assessment/:childId', authMiddleware, async (req, res) => {
  try {
    const child = await ownChild(req, res);
    if (!child) return;
    await AssessmentReminder.deleteOne({ childId: child._id });
    res.json({ success: true, ...serialize(child, null, clinicToday()) });
  } catch (err) {
    console.error('[reminders] turn off failed:', err);
    res.status(500).json({ error: 'Could not turn off the assessment reminder.' });
  }
});

module.exports = router;
