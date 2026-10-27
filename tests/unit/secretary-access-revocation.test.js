// A secretary's access follows their account, not their login-time token
// (PEDIATRICIAN_BUGS.md #11).
//
// The secretary JWT carries linkedPediatricianId from login and authMiddleware
// only verified its signature, so a secretary a pediatrician deactivated, or an
// admin unlinked or re-linked, kept full access to the old pediatrician's
// appointments for up to 48 hours. authMiddleware now re-reads a secretary's
// status and link on every request.
//
// No DB: User.findById is stubbed. The final check runs the real
// GET /api/appointments/pedia route stack behind authMiddleware.
const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const User = require('../../models/User');
const Appointment = require('../../models/Appointment');
const { authMiddleware } = require('../../middleware/auth');
const appointmentsRouter = require('../../routes/appointments');

const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const secretaryId = oid();
const pediaA = oid(); // the pediatrician named in the token
const pediaB = oid();
const query = (value) => {
  const q = { select: () => q, lean: () => q, sort: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

let account;
let lookups;
User.findById = () => { lookups += 1; return query(typeof account === 'function' ? account() : account); };

const tokenFor = (payload) => jwt.sign(payload, process.env.JWT_SECRET);
const secretaryToken = tokenFor({ userId: String(secretaryId), role: 'secretary', linkedPediatricianId: String(pediaA) });

// Express-like: runs a list of handlers in order; resolves when one responds or the chain ends.
function runChain(handlers, headers) {
  return new Promise((resolve, reject) => {
    const req = { headers, params: {}, query: {}, body: {} };
    const out = { status: 200, body: null, req, reachedEnd: false };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; resolve(out); return res; } };
    let i = 0;
    const next = () => {
      const handler = handlers[i++];
      if (!handler) { out.reachedEnd = true; return resolve(out); }
      try { Promise.resolve(handler(req, res, next)).catch(reject); } catch (e) { reject(e); }
    };
    next();
  });
}
const viaAuth = (headers) => runChain([authMiddleware], headers);
const bearer = (token) => ({ authorization: `Bearer ${token}` });

(async () => {
  // ── authMiddleware refreshes a secretary from the database ──────────────
  lookups = 0;
  account = { status: 'active', linkedPediatricianId: pediaA };
  let r = await viaAuth(bearer(secretaryToken));
  assert.strictEqual(r.reachedEnd, true);
  assert.strictEqual(r.req.user.linkedPediatricianId, String(pediaA));
  assert.strictEqual(lookups, 1);
  ok('an active, still-linked secretary passes with their current link');

  account = { status: 'active', linkedPediatricianId: pediaB };
  r = await viaAuth(bearer(secretaryToken));
  assert.strictEqual(r.req.user.linkedPediatricianId, String(pediaB), 're-linking takes effect immediately');
  ok('a secretary an admin re-linked is treated as linked to the new pediatrician, not the one in the token');

  account = { status: 'active', linkedPediatricianId: null };
  r = await viaAuth(bearer(secretaryToken));
  assert.strictEqual(r.reachedEnd, true);
  assert.strictEqual(r.req.user.linkedPediatricianId, undefined, 'an unlinked secretary has no link at all');
  ok('an unlinked secretary loses the link from their token');

  account = { status: 'suspended', linkedPediatricianId: pediaA };
  r = await viaAuth(bearer(secretaryToken));
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /suspended/);
  assert.strictEqual(r.reachedEnd, false);
  account = { status: 'pending', linkedPediatricianId: pediaA };
  r = await viaAuth(bearer(secretaryToken));
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /not yet active/);
  ok('a deactivated (suspended) or pending secretary is refused with 403');

  account = null;
  r = await viaAuth(bearer(secretaryToken));
  assert.strictEqual(r.status, 401);
  const savedErr = console.error;
  console.error = () => {};
  account = () => { throw new Error('db down'); };
  r = await viaAuth(bearer(secretaryToken));
  console.error = savedErr;
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.reachedEnd, false, 'a failed lookup never lets the request through');
  ok('a deleted secretary gets 401 and a failed lookup gets 503, never a pass');

  // Every role is re-checked now (ADMIN bug scan C3): a suspended parent,
  // admin or guardian is refused like a secretary, and only a secretary's
  // link is refreshed onto req.user.
  for (const role of ['parent', 'admin', 'legal_guardian']) {
    lookups = 0;
    account = { role, status: 'suspended' };
    r = await viaAuth(bearer(tokenFor({ userId: String(oid()), role })));
    assert.strictEqual(r.status, 403, `suspended ${role} is refused`);
    assert.strictEqual(r.reachedEnd, false, role);
    assert.strictEqual(lookups, 1, `${role}: one account read`);
    account = { role, status: 'active', linkedPediatricianId: pediaA };
    r = await viaAuth(bearer(tokenFor({ userId: String(oid()), role })));
    assert.strictEqual(r.reachedEnd, true, `active ${role} passes`);
    assert.strictEqual(r.req.user.linkedPediatricianId, undefined, `${role} never gets a secretary link`);
  }
  ok('parents, admins and guardians are re-checked too: suspended refused, active pass, no secretary link added');

  // ── The real appointment route sees the refreshed link ──────────────────
  const layer = appointmentsRouter.stack.find((l) => l.route && l.route.path === '/pedia' && l.route.methods.get);
  const chainFor = layer.route.stack.map((s) => s.handle);
  let readFor = null;
  Appointment.find = (f) => { readFor = f.pediatricianId; return query([]); };

  account = { status: 'active', linkedPediatricianId: pediaA };
  r = await runChain(chainFor, bearer(secretaryToken));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(String(readFor), String(pediaA));

  readFor = null;
  account = { status: 'active', linkedPediatricianId: null };
  r = await runChain(chainFor, bearer(secretaryToken));
  assert.strictEqual(r.status, 403, 'an unlinked secretary can no longer read the old pediatrician\'s appointments');
  assert.match(r.body.error, /not linked/);
  assert.strictEqual(readFor, null, 'nothing was queried');

  account = { status: 'active', linkedPediatricianId: pediaB };
  r = await runChain(chainFor, bearer(secretaryToken));
  assert.strictEqual(String(readFor), String(pediaB), 'a re-linked secretary reads the new pediatrician\'s appointments, not the old one\'s');

  readFor = null;
  account = { status: 'suspended', linkedPediatricianId: pediaA };
  r = await runChain(chainFor, bearer(secretaryToken));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(readFor, null, 'a deactivated secretary reads nothing');
  ok('GET /appointments/pedia follows the secretary\'s current link and refuses a deactivated one');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nsecretary-access-revocation.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
