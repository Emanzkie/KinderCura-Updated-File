// Follow-up Check-up (models/FollowUpPlan.js, routes/checkups.js,
// services/followUpPlans.js, services/reminders.js).
//
//   Pediatrician creates a follow-up → a pending, unpaid appointment on their
//   schedule plus a plan → the parent is notified with a link to the payment
//   page → payment is confirmed (online / Cashier through
//   receiptService.syncAppointmentAfterPayment, or a staff-confirmed walk-in
//   through paymentController.confirmWalkIn) → the appointment is approved and
//   the plan's assessments are assigned exactly once → progress and reminders.
//
// No DB, no network: models are stubbed in memory and the business logic is
// called directly.
const assert = require('assert');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Child = require('../../models/Child');
const User = require('../../models/User');
const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const AssessmentReminder = require('../../models/AssessmentReminder');
const PediatricianCheckup = require('../../models/PediatricianCheckup');
const FollowUpPlan = require('../../models/FollowUpPlan');
const Notification = require('../../models/Notification');
const AuditLog = require('../../models/AuditLog');
const Payment = require('../../models/Payment');
const paymentService = require('../../services/paymentService');
const followUpPlans = require('../../services/followUpPlans');
const receiptService = require('../../services/receiptService');
const reminders = require('../../services/reminders');
const paymentController = require('../../controllers/paymentController');
const appointmentsRouter = require('../../routes/appointments');
const { createFollowUpPlan, listFollowUpPlansForChild, parseFee } = require('../../routes/checkups').__testables;

const results = [];
const ok = (m) => results.push(m);
const oid = () => new mongoose.Types.ObjectId();
const q = (v) => { const o = { select: () => o, sort: () => o, populate: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
const same = (a, b) => String(a) === String(b);
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

const pediaId = oid();
const otherPediaId = oid();
const parentId = oid();
const child = { _id: oid(), firstName: 'Kemri', lastName: 'Soto', parentId };
const pediatrician = { _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Gold', lastName: 'Deluna', clinicId: oid(), clinicAddress: 'GenSan', consultationFee: 800 };
const pediaUser = { userId: String(pediaId), role: 'pediatrician' };

// ── In-memory stores ──────────────────────────────────────────────────────
let appointments = [];
let plans = [];
let notifications = [];
let audits = [];
let linked = true;
let availability = { available: true, requestedTime: '10:00' };

Child.findById = (id) => q(same(id, child._id) ? { ...child } : null);
User.findOne = (f) => q(same(f._id, pediaId) ? { ...pediatrician } : null);
User.findById = (id) => q(same(id, pediaId) ? { ...pediatrician } : null);
Appointment.exists = async (f) => (linked && same(f.pediatricianId, pediaId) && same(f.childId, child._id) ? { _id: oid() } : null);
Appointment.countDocuments = async (f) => appointments.filter((a) => f._id.$in.some((id) => same(id, a._id)) && f.status.$in.includes(a.status)).length;
Appointment.find = (f) => q(appointments.filter((a) => (f._id && f._id.$in ? f._id.$in.some((id) => same(id, a._id)) : true) && (!f.status || (typeof f.status === 'string' ? a.status === f.status : true))));
let nextApptId = 500;
let slotTaken = false;
Appointment.create = async ([row]) => {
  if (slotTaken) throw Object.assign(new Error(`E11000 duplicate key ${Appointment.SLOT_INDEX_NAME}`), { code: 11000 });
  const doc = { _id: oid(), id: ++nextApptId, ...row };
  appointments.push(doc);
  return [doc];
};
PediatricianCheckup.findOne = () => q(null);
FollowUpPlan.findOne = (f) => {
  const found = plans.find((p) => (!f.pediatricianId || same(p.pediatricianId, f.pediatricianId))
    && (!f.clientRequestId || p.clientRequestId === f.clientRequestId)
    && (!f.appointmentId || same(p.appointmentId, f.appointmentId))
    && (!f.status || p.status === f.status));
  return q(found ? { ...found } : null);
};
FollowUpPlan.find = (f) => q(plans.filter((p) => (!f.childId || same(p.childId, f.childId))
  && (!f.pediatricianId || same(p.pediatricianId, f.pediatricianId))
  && (!f.status || (f.status.$in ? f.status.$in.includes(p.status) : p.status === f.status))));
FollowUpPlan.create = async ([row]) => {
  if (row.clientRequestId && plans.some((p) => same(p.pediatricianId, row.pediatricianId) && p.clientRequestId === row.clientRequestId)) {
    throw Object.assign(new Error('E11000 dup clientRequestId'), { code: 11000 });
  }
  const doc = { _id: oid(), createdAt: new Date(), activatedAt: null, dueDate: null, ...row };
  plans.push(doc);
  return [doc];
};
FollowUpPlan.findOneAndUpdate = (f, { $set }) => {
  const plan = plans.find((p) => same(p._id, f._id) && p.status === f.status);
  if (plan) Object.assign(plan, $set);
  return q(plan ? { ...plan } : null);
};
Notification.create = async (n) => { notifications.push(n); return n; };
AuditLog.create = async (a) => { audits.push(a); return a; };
paymentService.withPaymentTransaction = async (work) => work(null);
appointmentsRouter.bookingHelpers.evaluateAvailability = async () => availability;

const validBody = (extra = {}) => ({
  fee: 800, requiredAssessments: 10, monitoringDays: 30, appointmentDate: '2026-12-05', appointmentTime: '10:00',
  instructions: 'One assessment every 3 days.', clientRequestId: `req-${Math.random().toString(36).slice(2, 12)}`, ...extra,
});
const expectHttp = async (promise, status, pattern) => {
  try { await promise; } catch (err) {
    assert.strictEqual(err.statusCode, status, `${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return;
  }
  assert.fail(`expected HTTP ${status}`);
};

(async () => {
  // ── 1. Create: validation and access ─────────────────────────────────────
  assert.strictEqual(parseFee('800.555'), 800.56);
  await expectHttp(createFollowUpPlan(child._id, { userId: String(parentId), role: 'parent' }, validBody()), 403, /Pediatricians only/);
  linked = false;
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody()), 403, /not linked/);
  linked = true;
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ fee: 0 })), 400, /fee/);
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ fee: '' })), 400, /fee/);
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ requiredAssessments: 31 })), 400, /Required assessments/);
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ requiredAssessments: 2.5 })), 400, /Required assessments/);
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ monitoringDays: 3 })), 400, /Monitoring period/);
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ appointmentDate: '' })), 400, /date/);
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ appointmentTime: '' })), 400, /time/);
  availability = { available: false, message: 'This pediatrician is not available on Sunday.' };
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody()), 400, /not available on Sunday/);
  availability = { available: true, requestedTime: '10:00' };
  slotTaken = true;
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody()), 409, /just booked/);
  slotTaken = false;
  assert.strictEqual(appointments.length, 0);
  assert.strictEqual(plans.length, 0);
  ok('create refuses non-pediatricians, unlinked pediatricians, bad fee/count/period/date/time, an unavailable slot and a taken slot');

  // ── 2. Create: appointment + plan + parent notification ──────────────────
  const body = validBody();
  const created = await createFollowUpPlan(child._id, pediaUser, body);
  assert.strictEqual(created.duplicate, false);
  assert.strictEqual(appointments.length, 1);
  const appt = appointments[0];
  assert.strictEqual(appt.status, 'pending', 'the appointment waits for payment');
  assert.strictEqual(appt.paymentStatus, 'Pending Payment');
  assert.strictEqual(appt.totalAmount, 800);
  assert.strictEqual(appt.balanceDue, 800);
  assert.strictEqual(appt.amountPaid, 0);
  assert.strictEqual(appt.reason, 'Follow-up Check-up');
  assert(same(appt.parentId, parentId) && same(appt.pediatricianId, pediaId) && same(appt.clinicId, pediatrician.clinicId));
  assert.strictEqual(appt.appointmentTime, '10:00');
  const plan = plans[0];
  assert.strictEqual(plan.status, 'awaiting_payment');
  assert(same(plan.appointmentId, appt._id) && plan.appointmentNumericId === appt.id);
  assert.deepStrictEqual([plan.fee, plan.requiredAssessments, plan.monitoringDays], [800, 10, 30]);
  assert.strictEqual(plan.activatedAt, null);
  const note = notifications.at(-1);
  assert(same(note.userId, parentId));
  assert.strictEqual(note.type, 'payment');
  assert.strictEqual(note.relatedPage, `/parent/payment?appointmentId=${appt.id}`, 'clicking it opens the payment page for this appointment');
  assert.match(note.message, /10 assessments will be assigned/);
  assert.strictEqual(audits.at(-1).action, 'follow_up_plan_created');
  ok('create makes a pending, unpaid appointment with the fee, an awaiting-payment plan, and notifies the parent with the payment link');

  // ── 3. No duplicates ─────────────────────────────────────────────────────
  const again = await createFollowUpPlan(child._id, pediaUser, body);
  assert.strictEqual(again.duplicate, true, 'the same submission returns the saved plan');
  await expectHttp(createFollowUpPlan(child._id, pediaUser, validBody({ appointmentTime: '11:00' })), 409, /already has an open follow-up/);
  assert.strictEqual(appointments.length, 1);
  assert.strictEqual(plans.length, 1);
  ok('a resubmitted form or a second open follow-up for the same child creates nothing');

  // ── 4. Payment confirmation assigns assessments once ─────────────────────
  notifications = [];
  assert.strictEqual(await followUpPlans.activateForAppointment({ ...appt }), null, 'nothing while the appointment is pending');
  assert.strictEqual(plan.status, 'awaiting_payment');

  // Online 50% deposit through the shared settlement path.
  const apptDoc = Object.assign({}, appt, { async save() { Object.assign(appt, { status: this.status, paymentStatus: this.paymentStatus, amountPaid: this.amountPaid, balanceDue: this.balanceDue, paymentType: this.paymentType }); } });
  Appointment.findById = async () => apptDoc;
  const savedEnsure = paymentService.ensureBalancePayment;
  let balanceRows = 0;
  paymentService.ensureBalancePayment = async () => { balanceRows += 1; };
  const now = new Date('2026-10-30T02:00:00Z'); // 10:00 Manila
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now.getTime()])); } static now() { return now.getTime(); } };
  await receiptService.syncAppointmentAfterPayment({ appointmentId: appt._id, paymentType: 'down_payment', amount: 400, totalAmount: 800 });
  global.Date = RealDate;
  paymentService.ensureBalancePayment = savedEnsure;
  assert.strictEqual(appt.status, 'approved', 'the payment confirms the appointment');
  assert.strictEqual(appt.paymentStatus, 'Down Payment');
  assert.strictEqual(balanceRows, 1, 'the clinic balance is still set up as before');
  assert.strictEqual(plan.status, 'active');
  assert.strictEqual(new Date(plan.dueDate).toISOString(), '2026-11-29T15:59:59.999Z', 'due at the end of the Manila day 30 days later');
  const parentNote = notifications.find((n) => same(n.userId, parentId));
  const pediaNote = notifications.find((n) => same(n.userId, pediaId));
  assert(parentNote && parentNote.relatedPage === '/parent/dashboard' && /complete 10 developmental assessments/.test(parentNote.message));
  assert(pediaNote && pediaNote.relatedPage === '/pedia/pediatrician-patients');

  // Balance paid later, a webhook retry, or a second confirmation: no second assignment.
  notifications = [];
  const firstActivatedAt = plan.activatedAt;
  assert.strictEqual(await followUpPlans.activateForAppointment({ ...appt, status: 'approved' }), null);
  assert.strictEqual(plan.activatedAt, firstActivatedAt);
  assert.strictEqual(notifications.length, 0);
  ok('online payment confirmation approves the appointment and assigns the assessments once; later confirmations assign nothing');

  // ── 5. Walk-in confirmed by staff ────────────────────────────────────────
  const walkInAppt = { _id: oid(), id: 777, childId: child._id, parentId, pediatricianId: pediaId, status: 'pending', paymentStatus: 'Pending Payment', pendingPaymentMode: 'walk_in', totalAmount: 600, appointmentDate: new Date('2026-12-07T00:00:00Z'), appointmentTime: '09:00' };
  const walkInPlan = { _id: oid(), childId: child._id, parentId, pediatricianId: pediaId, appointmentId: walkInAppt._id, appointmentNumericId: 777, fee: 600, requiredAssessments: 4, monitoringDays: 14, status: 'awaiting_payment', activatedAt: null, dueDate: null, createdAt: new Date() };
  plans.push(walkInPlan);
  Appointment.findOne = () => { const p = Promise.resolve(Object.assign({}, walkInAppt, { async save() { walkInAppt.status = this.status; } })); p.lean = async () => ({ ...walkInAppt }); return p; };
  Appointment.findOneAndUpdate = async (f, { $set }) => { Object.assign(walkInAppt, $set); return { ...walkInAppt }; };
  Payment.create = async (rows) => rows;
  notifications = [];
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await quiet(() => paymentController.confirmWalkIn({ user: { userId: String(oid()), role: 'admin' }, params: { appointmentId: '777' }, body: {} }, res));
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(walkInAppt.status, 'approved');
  assert.strictEqual(walkInPlan.status, 'active', 'staff confirmation of a walk-in assigns the assessments');
  assert(notifications.some((n) => n.title === 'Follow-up assessments assigned'));
  ok('a walk-in payment confirmed by clinic staff approves the appointment and assigns the assessments');

  // ── 6. Progress: completed, remaining, deadline, state ───────────────────
  plans.splice(plans.indexOf(walkInPlan), 1);
  const a1 = { _id: oid(), childId: child._id, status: 'complete', completedAt: new Date('2026-11-02T03:00:00Z') };
  const a2 = { _id: oid(), childId: child._id, status: 'complete', completedAt: new Date('2026-11-10T03:00:00Z') };
  const before = { _id: oid(), childId: child._id, status: 'complete', completedAt: new Date('2026-10-01T03:00:00Z') };
  Assessment.find = (f) => q([before, a1, a2].filter((a) => a.completedAt >= f.completedAt.$gte));
  AssessmentResult.find = () => q([{ assessmentId: a1._id, overallScore: 62 }, { assessmentId: a2._id, overallScore: 70 }]);
  Appointment.find = (f) => q(appointments.filter((a) => f._id.$in.some((id) => same(id, a._id))));

  let [progress] = await followUpPlans.planProgress([plan], new Date('2026-11-15T00:00:00Z'));
  assert.deepStrictEqual([progress.state, progress.completed, progress.remaining], ['active', 2, 8], 'only screenings since activation count');
  assert.deepStrictEqual(progress.assessments.map((a) => a.overallScore), [62, 70]);
  assert.strictEqual(progress.appointment.paymentStatus, 'Down Payment');
  [progress] = await followUpPlans.planProgress([plan], new Date('2026-12-01T00:00:00Z'));
  assert.strictEqual(progress.state, 'overdue');
  [progress] = await followUpPlans.planProgress([{ ...plan, requiredAssessments: 2 }], new Date('2026-12-01T00:00:00Z'));
  assert.strictEqual(progress.state, 'assessments_complete');
  [progress] = await followUpPlans.planProgress([{ ...plan, status: 'awaiting_payment', activatedAt: null }], new Date('2026-11-15T00:00:00Z'));
  assert.deepStrictEqual([progress.state, progress.completed], ['awaiting_payment', 0]);
  appt.status = 'cancelled';
  [progress] = await followUpPlans.planProgress([plan], new Date('2026-11-15T00:00:00Z'));
  assert.strictEqual(progress.state, 'cancelled');
  appt.status = 'completed';
  [progress] = await followUpPlans.planProgress([plan], new Date('2026-11-15T00:00:00Z'));
  assert.strictEqual(progress.state, 'visit_completed');
  appt.status = 'approved';
  ok('progress counts completed screenings since assignment with their scores, and shows awaiting payment, overdue, complete, cancelled and visit completed');

  // ── 7. Who can read the progress ─────────────────────────────────────────
  plans.push({ ...plan, _id: oid(), pediatricianId: otherPediaId, appointmentId: appt._id, clientRequestId: null });
  const pediaView = await listFollowUpPlansForChild(child._id, pediaUser);
  assert.strictEqual(pediaView.length, 1, 'a pediatrician sees only their own follow-ups');
  const parentView = await listFollowUpPlansForChild(child._id, { userId: String(parentId), role: 'parent' });
  assert.strictEqual(parentView.length, 2, 'the parent sees every follow-up for the child');
  require('../../models/GuardianLink').findOne = () => q(null);
  await expectHttp(listFollowUpPlansForChild(child._id, { userId: String(oid()), role: 'parent' }), 403);
  plans.pop();
  ok('the pediatrician sees their own plans, the parent sees all, a stranger is refused');

  // ── 8. Reminders before the deadline ─────────────────────────────────────
  // Only the follow-up lookup (by _id) finds anything; no appointment is tomorrow.
  Appointment.find = (f) => q(f._id ? appointments.filter((a) => a.status === f.status && f._id.$in.some((id) => same(id, a._id))) : []);
  Assessment.find = () => q([]);
  AssessmentReminder.find = () => q([]);
  Child.find = () => q([child]);
  Assessment.countDocuments = async () => 2;
  const sent = new Map();
  Notification.create = async (doc) => {
    if (sent.has(doc.reminderKey)) throw Object.assign(new Error('dup'), { code: 11000 });
    sent.set(doc.reminderKey, doc);
    return doc;
  };
  User.find = () => q([]);
  FollowUpPlan.find = (f) => q(plans.filter((p) => p.status === f.status && p.dueDate >= f.dueDate.$gte && p.dueDate <= f.dueDate.$lte));
  const at8 = (ymd) => new Date(`${ymd}T00:00:00Z`);
  let summary = await reminders.runReminders(at8('2026-11-22'));
  assert.strictEqual(summary.followUps, 1, '7 days before the deadline');
  const reminder = [...sent.values()].find((r) => r.reminderKey.startsWith('follow-up-plan:'));
  assert.match(reminder.message, /2 of 10 follow-up assessments done for Kemri Soto; 8 left/);
  assert.strictEqual(reminder.relatedPage, '/parent/screening');
  summary = await reminders.runReminders(at8('2026-11-22'));
  assert.deepStrictEqual([summary.followUps, summary.alreadySent], [0, 1], 'never sent twice');
  summary = await reminders.runReminders(at8('2026-11-23'));
  assert.strictEqual(summary.followUps, 0, '6 days before: no reminder');
  summary = await reminders.runReminders(at8('2026-11-29'));
  assert.strictEqual(summary.followUps, 1, 'on the deadline');
  Assessment.countDocuments = async () => 10;
  summary = await reminders.runReminders(at8('2026-11-28'));
  assert.strictEqual(summary.followUps, 0, 'nothing once every assessment is done');
  Assessment.countDocuments = async () => 2;
  appt.status = 'cancelled';
  summary = await reminders.runReminders(at8('2026-11-28'));
  assert.strictEqual(summary.followUps, 0, 'nothing for a cancelled appointment');
  ok('reminders go out 7, 3, 1 and 0 days before the deadline while assessments remain, once each, and stop when done or cancelled');

  // ── 9. Catch-up: paid somewhere that did not assign the plan ─────────────
  // e.g. the PayMongo webhook was handled by a server running older code:
  // the appointment is approved with a deposit, the plan is still waiting.
  const missedAppt = { _id: oid(), id: 117, childId: child._id, parentId, pediatricianId: pediaId, status: 'approved', paymentStatus: 'Down Payment', appointmentDate: new Date('2026-11-30T00:00:00Z'), appointmentTime: '13:00' };
  const pendingAppt = { _id: oid(), id: 118, childId: child._id, parentId, pediatricianId: pediaId, status: 'pending', paymentStatus: 'Pending Payment', appointmentDate: new Date('2026-12-01T00:00:00Z'), appointmentTime: '13:00' };
  const unpaidApproved = { _id: oid(), id: 119, childId: child._id, parentId, pediatricianId: pediaId, status: 'approved', paymentStatus: 'Pending Payment', appointmentDate: new Date('2026-12-02T00:00:00Z'), appointmentTime: '13:00' };
  appointments.push(missedAppt, pendingAppt, unpaidApproved);
  const waitingPlan = (a) => ({ _id: oid(), childId: child._id, parentId, pediatricianId: pediaId, appointmentId: a._id, appointmentNumericId: a.id, fee: 500, requiredAssessments: 10, monitoringDays: 30, status: 'awaiting_payment', activatedAt: null, dueDate: null, createdAt: new Date() });
  const missedPlan = waitingPlan(missedAppt);
  const stillPending = waitingPlan(pendingAppt);
  const notPaid = waitingPlan(unpaidApproved);
  plans.length = 0;
  plans.push(missedPlan, stillPending, notPaid);

  Appointment.find = (f) => q(appointments.filter((a) => f._id.$in.some((id) => same(id, a._id))
    && (!f.status || a.status === f.status)
    && (!f.paymentStatus || f.paymentStatus.$in.includes(a.paymentStatus))));
  FollowUpPlan.find = (f) => q(plans.filter((p) => same(p.childId, f.childId) && (!f.pediatricianId || same(p.pediatricianId, f.pediatricianId))));
  const paidAt = new Date('2026-10-30T12:42:37Z');
  Payment.findOne = (f) => q(same(f.appointmentId, missedAppt._id) && f.status === 'Paid' ? { verifiedAt: paidAt } : null);
  Assessment.find = () => q([]);
  notifications = [];
  Notification.create = async (n) => { notifications.push(n); return n; };

  const parentUser = { userId: String(parentId), role: 'parent' };
  let view = await listFollowUpPlansForChild(child._id, parentUser);
  const byAppt = (id) => view.find((p) => p.appointment && p.appointment.id === id);
  assert.strictEqual(missedPlan.status, 'active', 'the paid plan is caught up when the page is opened');
  assert.strictEqual(missedPlan.activatedAt.toISOString(), paidAt.toISOString(), 'the period starts at the payment, not at the page view');
  assert.strictEqual(new Date(missedPlan.dueDate).toISOString(), '2026-11-29T15:59:59.999Z');
  assert.deepStrictEqual([byAppt(117).state, byAppt(117).completed, byAppt(117).remaining], ['active', 0, 10]);
  assert.strictEqual(stillPending.status, 'awaiting_payment', 'an unpaid appointment is not activated');
  assert.strictEqual(notPaid.status, 'awaiting_payment', 'approved without a recorded payment is not activated');
  assert.strictEqual(notifications.filter((n) => n.title === 'Follow-up assessments assigned').length, 1);
  view = await listFollowUpPlansForChild(child._id, pediaUser);
  assert.strictEqual(byAppt(117).state, 'active');
  assert.strictEqual(notifications.filter((n) => n.title === 'Follow-up assessments assigned').length, 1, 'nothing is assigned or sent twice');
  ok('a payment confirmed without assigning its plan is caught up on the next page view, from the payment time, once');

  console.log(results.map((m) => `  ok - ${m}`).join('\n'));
  console.log(`Follow-up plan tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
