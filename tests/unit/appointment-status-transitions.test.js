// Appointment status transitions (PEDIATRICIAN_BUGS.md #4).
//
// PUT /:id/status, PUT /pedia-notifications/:id and POST /:id/cancel all end in
// updateAppointmentStatusById, which used to accept any status after any
// status: a cancelled, rejected or completed booking could be approved again,
// a pending one completed unseen, and a repeat call resent every notification.
//
// No live DB: model statics are stubbed and the route handlers are called
// directly from the router stack (auth middleware skipped; req.user supplied).
const assert = require('assert');
const mongoose = require('mongoose');

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');

delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const router = require('../../routes/appointments');

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function chain(value) {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}

function call(handler, { user, params = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() {},
    };
    Promise.resolve(handler({ user, params, body }, res)).catch(reject);
  });
}

const pediaId = new mongoose.Types.ObjectId();
const parentId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();

let appt;
let saves;
let notifications;

function reset(fields) {
  saves = 0;
  notifications = [];
  appt = {
    _id: new mongoose.Types.ObjectId(),
    id: 1,
    pediatricianId: pediaId,
    parentId,
    childId,
    status: 'pending',
    appointmentDate: new Date('2030-01-07T00:00:00Z'),
    appointmentTime: '09:00',
    reason: 'Check',
    totalAmount: 0,
    amountPaid: 0,
    paymentStatus: 'Unpaid',
    ...fields,
  };
  appt.save = async function save() { saves += 1; };
  appt.toObject = function toObject() { const { save, toObject, ...rest } = this; return { ...rest }; };
}

User.findOne = () => chain({ _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz' });
User.findById = (id) => chain(String(id) === String(pediaId)
  ? { _id: pediaId, firstName: 'Ana', lastName: 'Cruz' }
  : { _id: parentId, firstName: 'Emman', lastName: 'D', email: '' });
Child.findById = () => chain({ _id: childId, firstName: 'Kemri', lastName: 'Soto' });
Notification.create = async (payload) => { notifications.push(payload); return payload; };
Appointment.findOne = (q) => chain(q.id === appt.id ? appt : null);

const setStatus = handlerFor('put', '/:appointmentId/status');
const pediaNotification = handlerFor('put', '/pedia-notifications/:id');
const cancel = handlerFor('post', '/:appointmentId/cancel');
const pediaUser = { userId: String(pediaId), role: 'pediatrician' };
const adminUser = { userId: String(new mongoose.Types.ObjectId()), role: 'admin' };

const ALL = ['pending', 'approved', 'completed', 'cancelled', 'rejected'];
const TARGETS = ['approved', 'rejected', 'completed', 'cancelled'];
const ALLOWED = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  rejected: [],
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('PUT /:id/status follows the transition table for every from/to pair', async () => {
  for (const from of ALL) {
    for (const to of TARGETS) {
      reset({ status: from });
      const res = await call(setStatus, { user: pediaUser, params: { appointmentId: '1' }, body: { status: to } });
      const label = `${from} -> ${to}`;
      if (ALLOWED[from].includes(to)) {
        assert.strictEqual(res.status, 200, `${label} should be allowed: ${JSON.stringify(res.body)}`);
        assert.strictEqual(appt.status, to, label);
      } else {
        assert.strictEqual(res.status, 400, `${label} should be refused`);
        assert.match(res.body.error, new RegExp(`from ${from} to ${to}`), label);
        assert.strictEqual(appt.status, from, `${label}: status must not change`);
        assert.strictEqual(saves, 0, `${label}: nothing may be saved`);
        assert.strictEqual(notifications.length, 0, `${label}: nobody may be notified`);
      }
    }
  }
});

test('a repeated approve is refused and notifies the parent only once', async () => {
  reset({ status: 'pending' });
  const first = await call(setStatus, { user: pediaUser, params: { appointmentId: '1' }, body: { status: 'approved' } });
  assert.strictEqual(first.status, 200);
  const sent = notifications.length;
  assert.ok(sent >= 1);
  const second = await call(setStatus, { user: pediaUser, params: { appointmentId: '1' }, body: { status: 'approved' } });
  assert.strictEqual(second.status, 400);
  assert.strictEqual(notifications.length, sent, 'no second notification');
});

test('a cancelled booking cannot be revived, even by an admin overriding payment', async () => {
  reset({ status: 'cancelled', paymentStatus: 'Cancelled', totalAmount: 500 });
  const res = await call(setStatus, {
    user: adminUser, params: { appointmentId: '1' },
    body: { status: 'approved', overridePayment: true, overrideReason: 'x' },
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(appt.status, 'cancelled');
  assert.strictEqual(appt.paymentOverride, undefined, 'the override must not be written for a refused change');
  assert.strictEqual(saves, 0);
});

test('the dashboard accept/decline route refuses a closed appointment with 400', async () => {
  for (const [incoming, from] of [['declined', 'completed'], ['approved', 'cancelled'], ['approved', 'rejected']]) {
    reset({ status: from });
    const res = await call(pediaNotification, { user: pediaUser, params: { id: '1' }, body: { status: incoming } });
    assert.strictEqual(res.status, 400, `${incoming} on ${from}`);
    assert.strictEqual(appt.status, from);
  }
  reset({ status: 'pending' });
  const ok = await call(pediaNotification, { user: pediaUser, params: { id: '1' }, body: { status: 'declined' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(appt.status, 'rejected');
});

test('cancel still works on pending and approved bookings and is refused once closed', async () => {
  for (const from of ['pending', 'approved']) {
    reset({ status: from });
    const res = await call(cancel, { user: pediaUser, params: { appointmentId: '1' } });
    assert.strictEqual(res.status, 200, from);
    assert.strictEqual(appt.status, 'cancelled');
  }
  reset({ status: 'completed' });
  const res = await call(cancel, { user: pediaUser, params: { appointmentId: '1' } });
  assert.strictEqual(res.status, 400);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(`\nappointment-status-transitions: ${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
