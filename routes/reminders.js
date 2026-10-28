// routes/reminders.js
// GET /api/reminders/run, called once a day by the Vercel cron in vercel.json.
// Vercel sends "Authorization: Bearer <CRON_SECRET>" when the CRON_SECRET
// environment variable is set; without it the job refuses to run, so nobody
// else can trigger it. The work itself is in services/reminders.js.
const crypto = require('crypto');
const express = require('express');
const { runReminders } = require('../services/reminders');

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

module.exports = router;
