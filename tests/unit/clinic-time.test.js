// Admin date filters and month groupings use clinic (Manila) time
// (ADMIN bug scan C25, constants/clinicTime.js).
//
// They used UTC, so anything done between midnight and 7:59 AM Manila time
// was counted on the previous day or month.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);

const { clinicDayStart, clinicDayEnd, CLINIC_TIMEZONE } = require('../../constants/clinicTime');
const { parseFilters } = require('../../routes/admin-reports').__testables;
const Ops = require('../../services/adminOperationsAnalytics');

assert.strictEqual(CLINIC_TIMEZONE, 'Asia/Manila');
assert.strictEqual(clinicDayStart('2026-10-01').toISOString(), '2026-09-30T16:00:00.000Z');
assert.strictEqual(clinicDayEnd('2026-10-01').toISOString(), '2026-10-01T15:59:59.999Z');
assert(Number.isNaN(clinicDayStart('2026-13-40').getTime()), 'a malformed date stays invalid');

// A visit at 06:30 on 1 Oct in Manila is 30 Sep 22:30 UTC: inside "1 Oct".
const earlyMorning = new Date('2026-09-30T22:30:00.000Z');
const insights = parseFilters({ from: '2026-10-01', to: '2026-10-01' });
assert(!insights.error, insights.error);
assert(earlyMorning >= insights.from && earlyMorning <= insights.to, 'Insights/Reports: an early-morning record is on its Manila day');
const ops = Ops.parsePeriod({ from: '2026-10-01', to: '2026-10-01' });
assert(earlyMorning >= ops.from && earlyMorning <= ops.to, 'Analytics/Payments: same day boundaries');

// Full ISO timestamps are still taken as given.
assert.strictEqual(parseFilters({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }).from.toISOString(), '2026-10-01T00:00:00.000Z');
assert(parseFilters({ to: 'nope' }).error);

console.log('Clinic time OK — admin date filters and month groupings use whole Manila days');
