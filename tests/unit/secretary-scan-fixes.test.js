// Secretary-side fixes from SECRETARY_BUGS.md.
//
// 1-2. PUT /appointments/:id/status: rejecting or cancelling needs "Manage
//      Booking Requests" (approving still takes either flag), and a secretary
//      with no stored flags gets the defaults instead of a 403.
// 3.   Payments: managePayments is off unless stored true. It used to fall back
//      to manageBookings/approveSchedules, so a secretary could take payments
//      while the Staff Access settings said they could not.
// 4-5. GET /payments/clinic/today uses the Manila day, not the server's, and
//      leaves cancelled bookings out.
// 6.   GET /secretary/approvals carries the payment status; /me fills in
//      missing permission flags from the defaults.
// 11.  GET /appointments/pedia hydrates the whole list with one query per
//      collection, not four per appointment, with the same output.
//
// No DB: models are stubbed and the real handlers are called from the router
// stacks with req.user set as authMiddleware would set it.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const Payment = require('../../models/Payment');
const User = require('../../models/User');
const appointmentsRouter = require('../../routes/appointments');
const secretaryRouter = require('../../routes/secretary');
const paymentController = require('../../controllers/paymentController');
const { clinicDayStart, clinicDayEnd } = require('../../constants/clinicTime');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const secretaryId = oid();
const pediaId = oid();
const parentId = oid();
const childId = oid();
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
    catch: (b) => Promise.resolve(value).catch(b),
  };
  return q;
};

const pediatrician = { _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz' };
const parent = { _id: parentId, role: 'parent', firstName: 'Emman', lastName: 'D', email: '' };
const child = { _id: childId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: new Date('2022-01-05') };

let storedPermissions; // the secretary's stored secretaryPermissions (undefined = none)
let appt;
const secretaryDoc = () => ({
  _id: secretaryId, role: 'secretary', status: 'active', firstName: 'Sam', lastName: 'Sec',
  linkedPediatricianId: pediaId,
  ...(storedPermissions === undefined ? {} : { secretaryPermissions: storedPermissions }),
});

function reset(permissions, apptFields = {}) {
  storedPermissions = permissions;
  appt = {
    _id: oid(), id: 1, pediatricianId: pediaId, parentId, childId, status: 'pending',
    appointmentDate: new Date(), appointmentTime: '10:00', totalAmount: 0, amountPaid: 0, ...apptFields,
  };
  appt.save = async function save() {};
  appt.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
}

User.findById = (id) => {
  if (String(id) === String(secretaryId)) return chain(secretaryDoc());
  return chain(String(id) === String(pediaId) ? pediatrician : parent);
};
User.findOne = () => chain(pediatrician);
Child.findById = () => chain(child);
Payment.find = () => chain([]);
Payment.findOne = () => chain(null);
Notification.create = async (n) => n;
Appointment.findOne = () => chain(appt);

const handlerFor = (router, method, route) => {
  const layer = router.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const call = (handler, user, { params = {}, body = {}, query = {} } = {}) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
    setHeader() {},
  };
  Promise.resolve(handler({ user, params, body, query, method: 'GET', originalUrl: '/test' }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const secretary = { userId: String(secretaryId), role: 'secretary', linkedPediatricianId: String(pediaId) };

(async () => {
  // ── 1-2. Status changes follow the permission for that action ──────────
  const setStatus = handlerFor(appointmentsRouter, 'put', '/:appointmentId/status');
  const act = (status, user = secretary) => quiet(() => call(setStatus, user, { params: { appointmentId: '1' }, body: { status } }));

  reset({ manageBookings: false, approveSchedules: true });
  let r = await act('rejected');
  assert.strictEqual(r.status, 403, 'turning off Manage Booking Requests stops rejecting');
  assert.strictEqual(appt.status, 'pending');
  r = await act('approved');
  assert.strictEqual(r.status, 200, 'Approve Schedules still allows approving');
  assert.strictEqual(appt.status, 'approved');
  r = await act('cancelled');
  assert.strictEqual(r.status, 403, 'turning off Manage Booking Requests stops cancelling');

  reset({ manageBookings: true, approveSchedules: false });
  r = await act('rejected');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(appt.status, 'rejected');

  reset({ manageBookings: false, approveSchedules: false });
  r = await act('approved');
  assert.strictEqual(r.status, 403, 'with both off nothing changes');

  reset(undefined);
  r = await act('approved');
  assert.strictEqual(r.status, 200, 'a secretary with no stored flags gets the defaults, not a 403');

  reset({ manageBookings: false, approveSchedules: false });
  r = await act('rejected', { userId: String(pediaId), role: 'pediatrician' });
  assert.strictEqual(r.status, 200, 'the pediatrician is never limited');
  ok('status changes: reject/cancel need Manage Booking Requests, approve takes either flag, missing flags use the defaults');

  // ── 3-5. Cashier: payment permission and the clinic's day ───────────────
  let lastQuery = null;
  Appointment.find = (q) => { lastQuery = q; return chain([]); };
  User.find = () => chain([]);
  Child.find = () => chain([]);
  const today = (user) => quiet(() => call(paymentController.getClinicToday, user));

  reset({ manageBookings: true, approveSchedules: true });
  r = await today(secretary);
  assert.strictEqual(r.status, 403, 'no stored managePayments means no payment access, as Staff Access shows');
  reset({ managePayments: false, manageBookings: true });
  assert.strictEqual((await today(secretary)).status, 403);
  reset({ managePayments: true, manageBookings: false, approveSchedules: false });
  r = await today(secretary);
  assert.strictEqual(r.status, 200, 'managePayments: true allows it');
  ok('payments: managePayments is off unless stored true, with no fallback to the scheduling flags');

  const manilaToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  assert.strictEqual(r.body.date, manilaToday);
  assert.strictEqual(lastQuery.appointmentDate.$gte.getTime(), clinicDayStart(manilaToday).getTime());
  assert.strictEqual(lastQuery.appointmentDate.$lte.getTime(), clinicDayEnd(manilaToday).getTime());
  // A booking for today is stored as UTC midnight of that date: inside the range.
  const storedToday = new Date(`${manilaToday}T00:00:00.000Z`);
  assert.ok(storedToday >= lastQuery.appointmentDate.$gte && storedToday <= lastQuery.appointmentDate.$lte);
  assert.deepStrictEqual(lastQuery.status.$nin.sort(), ['cancelled', 'rejected']);
  ok("cashier today: the Manila day's bookings, cancelled and rejected left out");

  // ── 6. Secretary routes: payment status on approvals, merged permissions ─
  reset({ managePayments: true });
  const approvalDoc = {
    _id: oid(), id: 7, pediatricianId: pediaId, parentId, childId, status: 'pending',
    appointmentDate: new Date(), appointmentTime: '09:00', paymentStatus: 'Pending Payment', pendingPaymentMode: 'walk_in',
  };
  Appointment.find = () => chain([approvalDoc]);
  Child.find = () => chain([child]);
  User.find = () => chain([parent]);
  r = await quiet(() => call(handlerFor(secretaryRouter, 'get', '/approvals'), secretary));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.approvals[0].paymentStatus, 'Pending Payment');
  assert.strictEqual(r.body.approvals[0].pendingPaymentMode, 'walk_in');

  r = await quiet(() => call(handlerFor(secretaryRouter, 'get', '/me'), secretary));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.secretary.permissions, {
    viewAppointments: true, manageBookings: true, rescheduleRequests: true, approveSchedules: true, managePayments: true,
  }, 'stored flags win and missing ones come from the defaults the server checks');
  ok('secretary routes: approvals show the payment status; /me fills in missing permission flags');

  // ── 11. The clinic list is hydrated in a few queries, same output ────────
  const docA = { _id: oid(), id: 11, pediatricianId: pediaId, parentId, childId, status: 'approved', appointmentDate: new Date(), appointmentTime: '08:00', totalAmount: 500, paymentStatus: 'Paid' };
  const docB = { _id: oid(), id: 12, pediatricianId: pediaId, parentId, childId, status: 'pending', appointmentDate: new Date(), appointmentTime: '09:00', totalAmount: 500 };
  const counts = { child: 0, user: 0, payment: 0 };
  Appointment.find = () => chain([docA, docB]);
  Child.find = () => { counts.child += 1; return chain([child]); };
  User.find = () => { counts.user += 1; return chain([parent, pediatrician]); };
  // Newest first, as the route sorts them: a newer open row and an older Paid
  // row for docA. The Paid one must win, as in findRelevantPayment.
  Payment.find = () => { counts.payment += 1; return chain([
    { appointmentId: docA._id, status: 'Pending', paymentRef: 'NEW', createdAt: new Date(2026, 9, 2) },
    { appointmentId: docA._id, status: 'Paid', paymentRef: 'PAID', receiptNumber: 'R-1', createdAt: new Date(2026, 9, 1) },
  ]); };
  Child.findById = () => { throw new Error('per-appointment lookup used'); };

  r = await quiet(() => call(handlerFor(appointmentsRouter, 'get', '/pedia'), { userId: String(pediaId), role: 'pediatrician' }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(counts, { child: 1, user: 1, payment: 1 }, 'one query per collection for the whole list');
  const [a, b] = r.body.appointments;
  assert.strictEqual(a.id, 11);
  assert.strictEqual(a.childName, 'Kemri Soto');
  assert.strictEqual(a.parentName, 'Emman D');
  assert.strictEqual(a.pediatricianName, 'Ana Cruz');
  assert.strictEqual(a.paymentRef, 'PAID', 'the Paid row is chosen over a newer open one');
  assert.strictEqual(a.receiptNumber, 'R-1');
  assert.strictEqual(b.id, 12);
  assert.strictEqual(b.paymentRef, null, 'an appointment with no payment row has none');
  ok('clinic appointment list: hydrated with one query per collection, Paid row preferred');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Secretary scan fix tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
