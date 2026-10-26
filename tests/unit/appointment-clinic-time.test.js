// Booking uses the clinic's own date and clock (PEDIATRICIAN_BUGS.md #17).
//
// evaluateAvailability(), behind booking, reschedule and the availability
// preview, compared the requested date with the server's UTC date and never
// looked at the time of day. The clinic runs on Asia/Manila (UTC+8), so for the
// first 8 hours of every clinic day yesterday still counted as "today", a start
// time that had already passed today was accepted, and the preview listed it
// (only the browser filtered those out).
//
// The clock is pinned by replacing Date while a request runs. No DB: models are
// stubbed and the real GET /availability/check handler is called.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const Appointment = require('../../models/Appointment');
const SystemSetting = require('../../models/SystemSetting');
const User = require('../../models/User');
const router = require('../../routes/appointments');

const results = [];
const ok = (m) => results.push(m);

const pediaId = new mongoose.Types.ObjectId();
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};
// Mon-Wed, 01:00-12:00: one-hour start times 01:00 ... 11:00.
const pediatrician = {
  _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz',
  availability: { days: ['Monday', 'Tuesday', 'Wednesday'], startTime: '01:00', endTime: '12:00', maxPatientsPerDay: 20, breaks: [] },
};
SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
User.findOne = () => chain(pediatrician);
Appointment.find = () => chain([]);
Appointment.findOne = () => chain(null);

const layer = router.stack.find((l) => l.route && l.route.path === '/availability/check' && l.route.methods.get);
const check = layer.route.stack[layer.route.stack.length - 1].handle;

// Run fn with "now" pinned to an instant (new Date() with no arguments).
const RealDate = Date;
async function withNow(iso, fn) {
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
    static now() { return new RealDate(iso).getTime(); }
  };
  try { return await fn(); } finally { global.Date = RealDate; }
}
const ask = (query) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b.availability); return this; } };
  Promise.resolve(check({ user: { userId: String(pediaId), role: 'parent' }, query: { pediatricianId: String(pediaId), ...query } }, res)).catch(reject);
});

// 2030-01-07 20:30 UTC is already Tuesday 2030-01-08 04:30 in Manila.
const MANILA_0430 = '2030-01-07T20:30:00.000Z';
const MANILA_0500 = '2030-01-07T21:00:00.000Z';

(async () => {
  // ── The date ────────────────────────────────────────────────────────────
  let a = await withNow(MANILA_0430, () => ask({ date: '2030-01-07' }));
  assert.strictEqual(a.available, false, "Manila's yesterday is not bookable even though it is still today in UTC");
  assert.match(a.message, /today or a future date/);
  a = await withNow(MANILA_0430, () => ask({ date: '2030-01-08' }));
  assert.strictEqual(a.isDayAvailable, true, "the clinic's today is a valid day");
  ok("a date that is already yesterday on the clinic's calendar is refused, though it is still today in UTC");

  // ── The preview offers only times still to come ─────────────────────────
  assert.deepStrictEqual(a.availableSlots, ['05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00'],
    'the 01:00-04:00 starts have passed at 04:30 clinic time');
  assert(a.generatedSlots.includes('01:00'), 'the schedule itself is unchanged');
  const future = await withNow(MANILA_0430, () => ask({ date: '2030-01-09' }));
  assert.strictEqual(future.availableSlots[0], '01:00', 'a later day offers every start time');
  ok('today\'s availability preview drops start times that have passed; other days are unaffected');

  // ── A passed start time cannot be booked ────────────────────────────────
  for (const time of ['01:00', '04:00']) {
    a = await withNow(MANILA_0430, () => ask({ date: '2030-01-08', time }));
    assert.strictEqual(a.available, false, `${time} has passed at 04:30`);
    assert.match(a.message, /already passed/, time);
  }
  a = await withNow(MANILA_0430, () => ask({ date: '2030-01-08', time: '05:00' }));
  assert.strictEqual(a.available, true, 'a later start time today is fine');
  a = await withNow(MANILA_0430, () => ask({ date: '2030-01-09', time: '01:00' }));
  assert.strictEqual(a.available, true, 'the same early time is fine on a future day');
  ok('a start time that has already passed today is refused; later times and other days are accepted');

  // ── The start of the current hour is also too late ──────────────────────
  a = await withNow(MANILA_0500, () => ask({ date: '2030-01-08', time: '05:00' }));
  assert.strictEqual(a.available, false, 'a start time that is right now has begun');
  a = await withNow(MANILA_0500, () => ask({ date: '2030-01-08', time: '06:00' }));
  assert.strictEqual(a.available, true);
  const slots = (await withNow(MANILA_0500, () => ask({ date: '2030-01-08' }))).availableSlots;
  assert.strictEqual(slots[0], '06:00');
  ok('a start time equal to the current minute counts as already begun');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nappointment-clinic-time.test.js: ${results.length} checks passed`);
})().catch((err) => {
  global.Date = RealDate;
  console.error(err);
  process.exit(1);
});
