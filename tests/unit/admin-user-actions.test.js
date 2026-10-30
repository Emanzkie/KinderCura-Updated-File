// Users page account actions (ADMIN bug scan C6, C7, C9, C11).
//
//   C6  Approve activated a pediatrician whose PRC license was never verified
//       and re-sent "Account approved" on re-activation; Reject hard-deleted any
//       account (yourself, the last admin, a parent with children); Suspend let
//       an admin suspend themselves or the last admin and dropped the reason.
//   C7  None of these actions reached the audit log (admin Logs page).
//   C9  The search box was used as a raw regex, so "(" crashed the request.
//   C11 Error responses leaked err.message.
//
// No DB: models are stubbed and the real admin router runs in-process.
const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const User = require('../../models/User');
const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');
const Notification = require('../../models/Notification');
const AuditLog = require('../../models/AuditLog');
const adminRouter = require('../../routes/admin');

const results = [];
const ok = (label) => results.push(label);
const chain = (value) => { const q = { select: () => q, lean: () => q, sort: () => q, limit: () => q, skip: () => q, then: (a, b) => Promise.resolve(value).then(a, b) }; return q; };
const newId = () => String(new mongoose.Types.ObjectId());

const accounts = new Map();
const logs = [];
const notifications = [];
const deletedNotificationsFor = [];
let childCount = 0;
let appointmentCount = 0;
let lastFindFilter = null;

const matchesStatusFilter = (status, filter) => !filter || !filter.$nin || !filter.$nin.includes(status);
// A copy, like a real .lean() read: later updates do not change what was read.
User.findById = (id) => { const u = accounts.get(String(id)); return chain(u ? { ...u } : null); };
User.updateOne = async ({ _id }, { $set }) => { Object.assign(accounts.get(String(_id)), $set); return { modifiedCount: 1 }; };
User.deleteOne = async ({ _id }) => { accounts.delete(String(_id)); return { deletedCount: 1 }; };
User.countDocuments = async (q) => [...accounts.values()].filter((u) =>
  (!q.role || u.role === q.role) && matchesStatusFilter(u.status, q.status) && (!q._id || String(u._id) !== String(q._id.$ne))).length;
User.find = (q) => { lastFindFilter = q; return chain([...accounts.values()]); };
Child.countDocuments = async () => childCount;
Appointment.countDocuments = async () => appointmentCount;
Notification.create = async (n) => { notifications.push(n); return n; };
Notification.deleteMany = async ({ userId }) => { deletedNotificationsFor.push(String(userId)); return { deletedCount: 0 }; };
AuditLog.create = async (entry) => { logs.push(entry); return entry; };
AuditLog.find = () => chain([]);

const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  const adminId = newId();
  accounts.set(adminId, { _id: adminId, role: 'admin', status: 'active', firstName: 'Ada', lastName: 'Admin' });

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET);
  const call = (method, url, body) => quiet(async () => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  const add = (data) => { const id = newId(); accounts.set(id, { _id: id, firstName: 'T', lastName: 'User', ...data }); return id; };

  try {
    // ── Approve ───────────────────────────────────────────────────────────
    const unverifiedPedia = add({ role: 'pediatrician', status: 'pending', prcVerificationStatus: 'pending' });
    let r = await call('POST', '/api/admin/users/approve', { userId: unverifiedPedia });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /PRC Verification page/);
    const rejectedPedia = add({ role: 'pediatrician', status: 'suspended', prcVerificationStatus: 'rejected' });
    r = await call('POST', '/api/admin/users/approve', { userId: rejectedPedia });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(accounts.get(unverifiedPedia).status, 'pending');
    assert.strictEqual(accounts.get(rejectedPedia).status, 'suspended');
    ok('Approve refuses a pediatrician whose PRC license is unverified or rejected');

    const pendingParent = add({ role: 'parent', status: 'pending' });
    r = await call('POST', '/api/admin/users/approve', { userId: pendingParent });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(accounts.get(pendingParent).status, 'active');
    assert.strictEqual(r.body.message, 'User approved.');
    assert.deepStrictEqual(logs.at(-1), { actorId: adminId, action: 'user_approved', targetType: 'User', targetId: pendingParent, details: { role: 'parent', previousStatus: 'pending' }, ip: null, device: null });

    const verifiedPedia = add({ role: 'pediatrician', status: 'suspended', prcVerificationStatus: 'verified' });
    notifications.length = 0;
    r = await call('POST', '/api/admin/users/approve', { userId: verifiedPedia });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.message, 'User re-activated.');
    assert.strictEqual(logs.at(-1).action, 'user_reactivated');
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].title, 'Account re-activated', 'a re-activation is not announced as a first approval');

    const logCount = logs.length;
    r = await call('POST', '/api/admin/users/approve', { userId: pendingParent });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.message, 'User is already active.');
    assert.strictEqual(logs.length, logCount, 'a no-op is not logged');
    r = await call('POST', '/api/admin/users/approve', { userId: 'not-an-id' });
    assert.strictEqual(r.status, 404);
    ok('Approve and Re-activate work, say which one happened, and are logged');

    // ── Suspend ───────────────────────────────────────────────────────────
    r = await call('POST', '/api/admin/users/suspend', { userId: adminId });
    assert.strictEqual(r.status, 400, 'you cannot suspend yourself');
    const otherAdmin = add({ role: 'admin', status: 'active' });
    r = await call('POST', '/api/admin/users/suspend', { userId: otherAdmin, reason: '  Left the clinic  ' });
    assert.strictEqual(r.status, 200, 'another admin can be suspended while you remain');
    assert.deepStrictEqual(logs.at(-1).details, { role: 'admin', previousStatus: 'active', reason: 'Left the clinic' });
    ok('Suspend refuses your own account and saves the reason in the audit log');

    // The caller is always an active admin, so "last admin" can only happen in
    // a race (e.g. the caller was suspended a moment ago): make the count say
    // no other admin can sign in.
    const soleAdmin = add({ role: 'admin', status: 'active' });
    const savedCount = User.countDocuments;
    User.countDocuments = async (q) => (q.role === 'admin' ? 0 : savedCount(q));
    r = await call('POST', '/api/admin/users/suspend', { userId: soleAdmin });
    User.countDocuments = savedCount;
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /last active admin/);
    assert.strictEqual(accounts.get(soleAdmin).status, 'active');
    ok('Suspend refuses the last admin who can still sign in');

    // ── Reject (delete) ───────────────────────────────────────────────────
    r = await call('DELETE', `/api/admin/users/${adminId}`);
    assert.strictEqual(r.status, 400);
    r = await call('DELETE', `/api/admin/users/${soleAdmin}`);
    assert.strictEqual(r.status, 409, 'admins are never deleted here');
    r = await call('DELETE', `/api/admin/users/${pendingParent}`);
    assert.strictEqual(r.status, 409, 'an active account is suspended, not deleted');
    assert(accounts.has(pendingParent));

    const pendingWithChild = add({ role: 'parent', status: 'pending' });
    childCount = 1;
    r = await call('DELETE', `/api/admin/users/${pendingWithChild}`);
    assert.strictEqual(r.status, 409);
    childCount = 0;
    appointmentCount = 1;
    r = await call('DELETE', `/api/admin/users/${pendingWithChild}`);
    assert.strictEqual(r.status, 409);
    appointmentCount = 0;
    assert(accounts.has(pendingWithChild), 'records with children or appointments are kept');

    r = await call('DELETE', `/api/admin/users/${pendingWithChild}`);
    assert.strictEqual(r.status, 200);
    assert(!accounts.has(pendingWithChild));
    assert(deletedNotificationsFor.includes(pendingWithChild), 'its notifications are cleaned up');
    assert.strictEqual(logs.at(-1).action, 'user_rejected');
    r = await call('DELETE', '/api/admin/users/not-an-id');
    assert.strictEqual(r.status, 404);
    ok('Reject only deletes an empty pending sign-up, never yourself, an admin or an account with records');

    // ── Search and errors ─────────────────────────────────────────────────
    r = await call('GET', '/api/admin/users?search=' + encodeURIComponent('(a+)+$'));
    assert.strictEqual(r.status, 200, 'regex symbols no longer crash the search');
    const rx = lastFindFilter.$or[0].firstName;
    assert(rx instanceof RegExp);
    assert(rx.test('x(a+)+$y') && !rx.test('aaa'), 'the search text is matched literally');
    const pediaRow = r.body.users.find((u) => u.id === unverifiedPedia || String(u._id) === unverifiedPedia);
    if (pediaRow) assert.strictEqual(pediaRow.prcVerificationStatus, 'pending');

    const savedFind = User.find;
    User.find = () => { throw new Error('secret driver detail'); };
    r = await call('GET', '/api/admin/users');
    User.find = savedFind;
    assert.strictEqual(r.status, 500);
    assert(!JSON.stringify(r.body).includes('secret driver detail'), 'internal errors are not sent to the page');
    ok('search is literal, pediatrician rows carry their PRC status, and errors stay generic');

    // ── Active / Suspended Users ──────────────────────────────────────────
    // Suspend then Re-activate only flips the status; the record stays.
    const roundTrip = add({ role: 'parent', status: 'active' });
    r = await call('POST', '/api/admin/users/suspend', { userId: roundTrip, reason: 'test' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(accounts.get(roundTrip).status, 'suspended');
    assert.strictEqual(logs.at(-1).action, 'user_suspended');
    assert.strictEqual(String(logs.at(-1).targetId), roundTrip, 'the suspension is logged against the account');
    r = await call('POST', '/api/admin/users/approve', { userId: roundTrip });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.message, 'User re-activated.');
    assert.strictEqual(accounts.get(roundTrip).status, 'active');
    assert(accounts.has(roundTrip), 'a suspended account is never deleted');
    ok('Suspend then Re-activate flips the status, logs the suspension and keeps the account');

    // The suspension date comes from the newest user_suspended audit entry.
    const suspendedWithLog = add({ role: 'parent', status: 'suspended' });
    const suspendedNoLog = add({ role: 'pediatrician', status: 'suspended' });
    let auditQuery = null;
    const savedAuditFind = AuditLog.find;
    AuditLog.find = (q) => {
      auditQuery = q;
      return chain([
        { targetId: new mongoose.Types.ObjectId(suspendedWithLog), createdAt: new Date('2026-10-20T04:00:00Z') },
        { targetId: suspendedWithLog, createdAt: new Date('2026-09-01T04:00:00Z') },
      ]);
    };
    r = await call('GET', '/api/admin/users');
    AuditLog.find = savedAuditFind;
    assert.strictEqual(r.status, 200);
    assert.strictEqual(auditQuery.action, 'user_suspended');
    assert(auditQuery.targetId.$in.map(String).includes(suspendedWithLog), 'looks up the suspended accounts');
    const row = (id) => r.body.users.find((u) => u.id === id);
    assert.strictEqual(row(suspendedWithLog).suspendedAt, 'Oct 20, 2026', 'newest suspension wins');
    assert.strictEqual(row(suspendedNoLog).suspendedAt, null, 'no log entry: no date');
    assert(!('suspendedAt' in row(roundTrip)), 'active accounts carry no suspension date');
    assert(!('status' in lastFindFilter), 'the list is not filtered by status: the page splits it');
    ok('GET /admin/users gives suspended accounts their suspension date from the audit log');
  } finally {
    server.closeAllConnections();
    server.close();
  }

  console.log(results.map((m) => `  ok - ${m}`).join('\n'));
  console.log(`Admin user action tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
