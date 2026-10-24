// Regression test for GET /api/appointments/:userId (parent appointment list).
//
// The bug: the list matched parentId only, so a booking made by a linked
// guardian never showed on the primary parent's Appointments page, and a
// guardian allowed to manage appointments never saw the parent's bookings for
// the shared child (the payment page had the same blind spot).
//
// No DB and no network: model statics are monkey-patched (filters go through
// sift) and the handler is called directly from the router stack.
const assert = require('assert');
const mongoose = require('mongoose');
const sift = require('sift').default || require('sift');

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Payment = require('../../models/Payment');

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const router = require('../../routes/appointments');

function chain(value) {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

const layer = router.stack.find((l) => l.route && l.route.path === '/:userId' && l.route.methods.get);
assert(layer, 'GET /:userId exists');
const listFor = layer.route.stack[layer.route.stack.length - 1].handle;

function call(user, userId) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(listFor({ user, params: { userId: String(userId) }, query: {}, body: {} }, res)).catch(reject);
  });
}

const id = () => new mongoose.Types.ObjectId();
const owner = id();          // primary parent of sharedKid
const guardian = id();       // linked to sharedKid, may manage appointments
const viewer = id();         // linked to sharedKid, may NOT manage appointments
const stranger = id();       // another family
const pediaId = id();
const sharedKid = id();
const strangerKid = id();

// Plain documents compared with sift, so ObjectIds are matched by string.
const s = (v) => String(v);
const children = [
  { _id: s(sharedKid), parentId: s(owner), firstName: 'Shared', lastName: 'Kid' },
  { _id: s(strangerKid), parentId: s(stranger), firstName: 'Other', lastName: 'Kid' },
];
const links = [
  { childId: s(sharedKid), guardianId: s(guardian), status: 'active', permissions: { manageAppointments: true } },
  { childId: s(sharedKid), guardianId: s(viewer), status: 'active', permissions: { manageAppointments: false } },
];
const appointments = [
  { id: 1, _id: s(id()), childId: s(sharedKid), parentId: s(owner), pediatricianId: s(pediaId), status: 'pending', appointmentDate: new Date('2030-01-07') },
  { id: 2, _id: s(id()), childId: s(sharedKid), parentId: s(guardian), pediatricianId: s(pediaId), status: 'approved', appointmentDate: new Date('2030-01-08') },
  { id: 3, _id: s(id()), childId: s(strangerKid), parentId: s(stranger), pediatricianId: s(pediaId), status: 'pending', appointmentDate: new Date('2030-01-09') },
];

const norm = (f) => JSON.parse(JSON.stringify(f));
Child.find = (f) => chain(children.filter(sift(norm(f))));
Child.findById = (cid) => chain(children.find((c) => c._id === s(cid)) || null);
GuardianLink.find = (f) => chain(links.filter(sift(norm(f))));
Appointment.find = (f) => chain(appointments.filter(sift(norm(f))));
User.findById = (uid) => chain({ _id: uid, firstName: 'User', lastName: 'X' });
Payment.find = () => chain([]);
Payment.findOne = () => chain(null);

const ids = (r) => r.body.appointments.map((a) => a.id).sort();
const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. The primary parent also sees the booking the guardian made for their child.
  let r = await call({ userId: s(owner), role: 'parent' }, owner);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(ids(r), [1, 2]);
  ok("primary parent sees its own booking and the guardian's booking for the same child");

  // 2. A guardian who may manage appointments sees the parent's booking too.
  r = await call({ userId: s(guardian), role: 'parent' }, guardian);
  assert.deepStrictEqual(ids(r), [1, 2]);
  ok("guardian with manageAppointments sees the parent's booking and its own");

  // 3. A guardian without that permission sees nothing it did not book itself.
  r = await call({ userId: s(viewer), role: 'legal_guardian' }, viewer);
  assert.deepStrictEqual(ids(r), []);
  ok('guardian without manageAppointments gets no shared bookings');

  // 4. Another family never appears, and you cannot read someone else's list.
  r = await call({ userId: s(stranger), role: 'parent' }, stranger);
  assert.deepStrictEqual(ids(r), [3]);
  r = await call({ userId: s(stranger), role: 'parent' }, owner);
  assert.strictEqual(r.status, 403);
  ok("families stay separate, and reading another user's list is 403");

  // 5. Admin may still read any parent's list.
  r = await call({ userId: s(id()), role: 'admin' }, owner);
  assert.deepStrictEqual(ids(r), [1, 2]);
  ok("admin reads a parent's full list");

  console.log('\nAppointment list access tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
