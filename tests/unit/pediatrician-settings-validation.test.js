// Pediatrician settings are validated before they are saved
// (PEDIATRICIAN_BUGS.md #19).
//
// PUT /auth/pediatrician/settings stored whatever it was sent:
//   - a blank fee box cleared the fee, and with no fee every new booking is free
//     (the fee is copied into each booking's total);
//   - times such as "25:99" were saved, after which every booking failed with
//     "schedule incomplete"; an end before the start was read as an overnight shift;
//   - capacity could be a fraction and was silently clamped;
//   - breaks were never checked for format, order or overlap.
//
// No DB: User.findById is stubbed and the real handler runs from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const User = require('../../models/User');
const router = require('../../routes/auth');

const results = [];
const ok = (m) => results.push(m);

const pediaId = new mongoose.Types.ObjectId();
const layer = router.stack.find((l) => l.route && l.route.path === '/pediatrician/settings' && l.route.methods.put);
const save = layer.route.stack[layer.route.stack.length - 1].handle;

let doc;
let saves;
function reset(fields = {}) {
  saves = 0;
  doc = {
    _id: pediaId, role: 'pediatrician', email: 'dr@example.invalid', consultationFee: 500,
    availability: { days: ['Monday'], startTime: '09:00', endTime: '17:00', maxPatientsPerDay: 10, breaks: [{ label: 'Lunch', startTime: '12:00', endTime: '13:00' }] },
    ...fields,
  };
  doc.save = async function save() { saves += 1; };
}
User.findById = () => Promise.resolve(doc);

const put = (body) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, setHeader() {} };
  Promise.resolve(save({ user: { userId: String(pediaId), role: 'pediatrician' }, body }, res)).catch(reject);
});
const avail = (over = {}) => ({ availability: { days: ['Monday', 'Tuesday'], startTime: '09:00', endTime: '17:00', maxPatientsPerDay: '10', ...over } });

(async () => {
  // ── Consultation fee ────────────────────────────────────────────────────
  reset({ consultationFee: 500 });
  let r = await put({ consultationFee: '' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /cannot be cleared/);
  assert.strictEqual(doc.consultationFee, 500, 'the fee is kept');
  assert.strictEqual(saves, 0);
  r = await put({ consultationFee: null });
  assert.strictEqual(r.status, 400, 'null is a clear too');

  reset({ consultationFee: null });
  r = await put({ consultationFee: '', bio: 'Hello' });
  assert.strictEqual(r.status, 200, 'a blank box when no fee was ever set does not block other settings');
  assert.strictEqual(doc.consultationFee, null);
  assert.strictEqual(doc.bio, 'Hello');

  reset({ consultationFee: 500 });
  r = await put({ consultationFee: '750' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(doc.consultationFee, 750, 'a fee can still be changed');
  for (const bad of ['0', '-5', 'abc']) {
    reset({ consultationFee: 500 });
    r = await put({ consultationFee: bad });
    assert.strictEqual(r.status, 400, `fee ${bad}`);
    assert.strictEqual(doc.consultationFee, 500);
  }
  ok('an existing fee cannot be cleared (a bad or blank value keeps it), while changing it and saving with no fee ever set still work');

  // ── Working hours ───────────────────────────────────────────────────────
  for (const [label, over] of [
    ['an impossible time', { startTime: '25:99' }],
    ['a non-time end', { endTime: 'abc' }],
    ['a time without a leading zero', { startTime: '9:00' }],
    ['an end before the start (an overnight shift)', { startTime: '17:00', endTime: '09:00' }],
    ['an end equal to the start', { startTime: '09:00', endTime: '09:00' }],
  ]) {
    reset();
    r = await put(avail(over));
    assert.strictEqual(r.status, 400, `${label} must be refused`);
    assert.strictEqual(saves, 0, `${label}: nothing saved`);
    assert.strictEqual(doc.availability.startTime, '09:00');
  }
  reset();
  r = await put(avail({ startTime: '08:30', endTime: '16:45' }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(doc.availability.startTime, '08:30');
  assert.strictEqual(doc.availability.endTime, '16:45');
  reset();
  r = await put({ availability: { days: [], startTime: '09:00', endTime: '17:00' } });
  assert.strictEqual(r.status, 400, 'at least one day is still required');
  ok('working hours must be HH:mm with the end after the start');

  // ── Capacity ────────────────────────────────────────────────────────────
  for (const bad of ['2.5', '0', '-1', '51', 'abc']) {
    reset();
    r = await put(avail({ maxPatientsPerDay: bad }));
    assert.strictEqual(r.status, 400, `capacity ${bad} must be refused`);
    assert.strictEqual(doc.availability.maxPatientsPerDay, 10);
  }
  for (const [input, stored] of [['12', 12], [7, 7], ['', 10], [undefined, 10], ['1', 1], ['50', 50]]) {
    reset();
    r = await put(avail({ maxPatientsPerDay: input }));
    assert.strictEqual(r.status, 200, `capacity ${JSON.stringify(input)}`);
    assert.strictEqual(doc.availability.maxPatientsPerDay, stored);
  }
  ok('capacity must be a whole number from 1 to 50; blank keeps the default of 10');

  // ── Breaks ──────────────────────────────────────────────────────────────
  reset();
  r = await put(avail());
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(doc.availability.breaks, [{ label: 'Lunch', startTime: '12:00', endTime: '13:00' }], 'breaks not sent are kept as stored');

  for (const [label, breaks] of [
    ['a bad time', [{ startTime: '12:99', endTime: '13:00' }]],
    ['an end before the start', [{ startTime: '13:00', endTime: '12:00' }]],
    ['overlapping breaks', [{ startTime: '12:00', endTime: '13:00' }, { startTime: '12:30', endTime: '14:00' }]],
  ]) {
    reset();
    r = await put(avail({ breaks }));
    assert.strictEqual(r.status, 400, `${label} must be refused`);
    assert.strictEqual(saves, 0);
  }
  reset();
  r = await put(avail({ breaks: [{ label: 'Snack', startTime: '15:00', endTime: '15:15' }, { label: 'Lunch', startTime: '12:00', endTime: '13:00' }] }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(doc.availability.breaks.length, 2, 'valid, touching-free breaks are saved');
  reset();
  r = await put(avail({ breaks: [{ startTime: '12:00', endTime: '13:00' }, { startTime: '13:00', endTime: '14:00' }] }));
  assert.strictEqual(r.status, 200, 'back-to-back breaks do not overlap');
  reset();
  r = await put(avail({ breaks: [] }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(doc.availability.breaks, [], 'an empty list removes the breaks');
  ok('breaks sent with the request must be valid, ordered and non-overlapping; stored breaks are kept when none are sent');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npediatrician-settings-validation.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
