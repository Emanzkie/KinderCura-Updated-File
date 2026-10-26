// Chat access and the pediatrician thread list (PEDIATRICIAN_BUGS.md #22).
//
//   - GET/POST /api/chat/:appointmentId checked a guardian's viewMessages /
//     sendMessages against whichever child the caller put in ?childId= or the
//     body, not the appointment's own child, so a guardian could read or post in
//     a chat they had no messaging permission for.
//   - An admin (or secretary) passed every check and could read a conversation
//     and post into it as the pediatrician.
//   - The pediatrician chat page merged all appointments of a child into one
//     row that opened only the newest, so older conversations were unreachable
//     and the row's unread badge never cleared.
//
// No DB: models are stubbed and the real handlers run with their permission
// middleware; the real page script runs in a node vm for the thread list.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const ChatMessage = require('../../models/ChatMessage');
const GuardianLink = require('../../models/GuardianLink');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const chatRouter = require('../../routes/chat');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const same = (a, b) => String(a) === String(b);
const primaryParent = oid();
const guardian = oid();
const pediaId = oid();
const otherPedia = oid();
const kidA = oid(); // the chat under attack; the guardian may NOT message here
const kidB = oid(); // a different child the guardian MAY message about
const chain = (value) => {
  const q = { select: () => q, sort: () => q, lean: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

const appts = {
  1: { id: 1, childId: kidA, parentId: primaryParent, pediatricianId: pediaId, status: 'approved', appointmentDate: new Date('2030-01-08') },
  2: { id: 2, childId: kidB, parentId: primaryParent, pediatricianId: pediaId, status: 'approved', appointmentDate: new Date('2030-01-09') },
};
const links = [
  { childId: kidA, guardianId: guardian, status: 'active', permissions: { viewMessages: false, sendMessages: false } },
  { childId: kidB, guardianId: guardian, status: 'active', permissions: { viewMessages: true, sendMessages: true } },
];
let sent;
Appointment.findOne = (f) => chain(appts[f.id] || null);
Child.findById = (id) => chain({ _id: id, parentId: primaryParent, firstName: 'Kid', lastName: String(id).slice(-4) });
User.findById = (id) => chain({ _id: id, firstName: same(id, pediaId) ? 'Ana' : 'Pat', lastName: 'Cruz' });
GuardianLink.findOne = (f) => chain(links.find((l) => same(l.childId, f.childId) && same(l.guardianId, f.guardianId) && l.status === f.status) || null);
ChatMessage.find = () => chain([]);
ChatMessage.updateMany = async () => ({});
ChatMessage.create = async (m) => { sent.push(m); return { _id: oid(), ...m }; };
Notification.create = async (n) => n;

const layerFor = (method, route) => chatRouter.stack.find((l) => l.route && l.route.path === route && l.route.methods[method]);
// Everything after authMiddleware, run in order like Express would.
function run(method, route, user, { params, query = {}, body = {} }) {
  const handlers = layerFor(method, route).route.stack.slice(1).map((s) => s.handle);
  return new Promise((resolve, reject) => {
    const req = { user, params, query, body };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    let i = 0;
    const next = () => {
      const h = handlers[i++];
      if (!h) return resolve({ status: 200, body: null, passed: true });
      Promise.resolve(h(req, res, next)).catch(reject);
    };
    next();
  });
}
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
const asGuardian = { userId: String(guardian), role: 'legal_guardian' };

(async () => {
  // ── The guardian cannot name a different child ──────────────────────────
  sent = [];
  let r = await quiet(() => run('get', '/:appointmentId', asGuardian, { params: { appointmentId: '1' } }));
  assert.strictEqual(r.status, 403, 'no viewMessages for the appointment\'s own child');
  r = await quiet(() => run('get', '/:appointmentId', asGuardian, { params: { appointmentId: '1' }, query: { childId: String(kidB) } }));
  assert.strictEqual(r.status, 403, '?childId= must not swap in a child the guardian may message about');
  r = await quiet(() => run('post', '/:appointmentId', asGuardian, { params: { appointmentId: '1' }, query: { childId: String(kidB) }, body: { message: 'hi' } }));
  assert.strictEqual(r.status, 403);
  r = await quiet(() => run('post', '/:appointmentId', asGuardian, { params: { appointmentId: '1' }, body: { message: 'hi', childId: String(kidB) } }));
  assert.strictEqual(r.status, 403, 'nor may the body');
  assert.strictEqual(sent.length, 0, 'nothing was posted');
  ok("a guardian's messaging permission is judged on the appointment's own child, whatever childId they add");

  r = await quiet(() => run('get', '/:appointmentId', asGuardian, { params: { appointmentId: '2' } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await quiet(() => run('post', '/:appointmentId', asGuardian, { params: { appointmentId: '2' }, body: { message: 'hello' } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(sent.length, 1);
  r = await quiet(() => run('get', '/:appointmentId', { userId: String(primaryParent), role: 'parent' }, { params: { appointmentId: '1' } }));
  assert.strictEqual(r.status, 200, 'the primary parent is unaffected');
  r = await quiet(() => run('get', '/:appointmentId', { userId: String(pediaId), role: 'pediatrician' }, { params: { appointmentId: '1' } }));
  assert.strictEqual(r.status, 200, "the appointment's pediatrician is unaffected");
  r = await quiet(() => run('get', '/:appointmentId', { userId: String(otherPedia), role: 'pediatrician' }, { params: { appointmentId: '1' } }));
  assert.strictEqual(r.status, 403, 'another pediatrician is still refused');
  ok('a guardian with permission, the primary parent and the right pediatrician still get in; another pediatrician does not');

  // ── Admins and secretaries are not part of the conversation ─────────────
  sent = [];
  for (const role of ['admin', 'secretary']) {
    const user = { userId: String(oid()), role };
    r = await quiet(() => run('get', '/:appointmentId', user, { params: { appointmentId: '1' } }));
    assert.strictEqual(r.status, 403, `${role} must not read a chat`);
    r = await quiet(() => run('post', '/:appointmentId', user, { params: { appointmentId: '1' }, body: { message: 'as the doctor' } }));
    assert.strictEqual(r.status, 403, `${role} must not post in a chat`);
  }
  assert.strictEqual(sent.length, 0, 'no message was created');
  ok('an admin or secretary can neither read nor post in a conversation');

  // ── The pediatrician thread list ────────────────────────────────────────
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', textContent: '', innerHTML: '', src: '', href: '', disabled: false, style: {}, dataset: {},
        addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, closest: () => null,
        querySelector: () => null, querySelectorAll: () => [], scrollTop: 0, scrollHeight: 0,
      });
    }
    return els.get(id);
  };
  const threadRows = ['2030-01-05', '2030-01-12', '2030-01-20'].map((date, i) => ({
    appointmentId: 11 + i, childId: 'kidX', parentId: 'parentX', childName: 'Kemri Soto', parentName: 'Emman Dela Cruz',
    appointmentDate: `${date}T00:00:00.000Z`, unread: [2, 0, 3][i], parentPhoto: null,
  }));
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise, Date,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, alert() {}, confirm: () => false,
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
      setItem() {}, removeItem() {}, clear() {},
    },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true } },
    fetch: async (url) => {
      const body = new URL(url).pathname === '/api/chat/threads' ? { threads: threadRows } : {};
      return { ok: true, status: 200, json: async () => body };
    },
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    loadNotificationCount: async () => {},
  };
  sandbox.window = sandbox;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/pedia/pedia-chat.js'), 'utf8'), sandbox);
  await vm.runInContext('loadThreads()', sandbox);
  const html = el('threadsList').innerHTML;
  const opens = [...html.matchAll(/openThread\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(opens, [13, 12, 11], 'every appointment is its own thread, newest first');
  const badges = [...html.matchAll(/class="thread-badge">(\d+)</g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(badges, [3, 2], "each thread keeps its own unread count (they are no longer summed into 5)");
  ok("the pediatrician chat page lists each appointment as its own thread, so older conversations and their unread counts stay reachable");

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nchat-access.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
