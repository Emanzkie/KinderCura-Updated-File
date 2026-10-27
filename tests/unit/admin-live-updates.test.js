// Admin Analytics live updates (ADMIN bug scan C12, P11).
//
//   C12 The page opened an EventSource to /api/admin/sse and, on any error,
//       retried every 5 s forever. On Vercel the route always answers 501, so
//       every open Analytics tab kept calling the server.
//   P11 On a local server the stream needed no login.
//
// The stream now requires an admin token (sent by a fetch-based reader), a
// refusal ends the attempts, and a dropped connection is retried a few times.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

// ── Page: the initSSE block, run in a sandbox ─────────────────────────────
function loadInitSSE({ fetchImpl }) {
  const js = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'admin-analytics.js'), 'utf8');
  const start = js.indexOf('const SSE_RETRY_MS');
  const end = js.indexOf("document.addEventListener('DOMContentLoaded'");
  assert(start > 0 && end > start, 'initSSE block found');
  const timers = [];
  const sandbox = {
    window: {},
    fetch: fetchImpl,
    TextDecoder,
    KC: { token: () => 'tok' },
    activeController: null,
    loads: 0,
    loadAnalytics() { sandbox.loads += 1; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  };
  sandbox.window.fetch = fetchImpl;
  sandbox.window.TextDecoder = TextDecoder;
  vm.createContext(sandbox);
  vm.runInContext(`${js.slice(start, end)}\nthis.initSSE = initSSE;`, sandbox);
  return { sandbox, timers };
}

const streamOf = (chunks) => {
  const queue = chunks.map((c) => new TextEncoder().encode(c));
  return { getReader: () => ({ read: async () => (queue.length ? { value: queue.shift(), done: false } : { done: true }) }) };
};

async function pageTests() {
  // Vercel: 501 → one request, no retry.
  let calls = 0;
  let sentAuth = null;
  let page = loadInitSSE({ fetchImpl: async (_url, opts) => { calls += 1; sentAuth = opts.headers.Authorization; return { ok: false, status: 501 }; } });
  await page.sandbox.initSSE();
  assert.strictEqual(calls, 1);
  assert.strictEqual(sentAuth, 'Bearer tok', 'the admin token is sent');
  assert.strictEqual(page.timers.length, 0, 'a 501 is not retried');
  ok('a refused stream (501 on Vercel, or an auth error) is not retried');

  // Local: events refresh the page; a dropped stream is retried, at most 5 times.
  page = loadInitSSE({ fetchImpl: async () => ({ ok: true, status: 200, body: streamOf([': connected\n\n', 'event: analytics:update\ndata: {}\n\nevent: analytics:up', 'date\ndata: {}\n\n']) }) });
  await page.sandbox.initSSE();
  assert.strictEqual(page.sandbox.loads, 2, 'each analytics:update event (even split across chunks) refreshes once');
  assert.strictEqual(page.timers.length, 1);
  assert.strictEqual(page.timers[0].ms, 30000);

  page = loadInitSSE({ fetchImpl: async () => { throw new Error('offline'); } });
  await page.sandbox.initSSE();
  for (let i = 0; i < 10 && page.timers.length; i += 1) {
    const t = page.timers.shift();
    await t.fn();
  }
  assert.strictEqual(page.timers.length, 0, 'retries stop');
  ok('events refresh the page, and a dropped connection is retried every 30 s, at most 5 times');
}

// ── Server: admins only, 501 on Vercel ────────────────────────────────────
async function serverTests() {
  const User = require('../../models/User');
  const adminId = String(new mongoose.Types.ObjectId());
  const parentId = String(new mongoose.Types.ObjectId());
  const chain = (v) => { const q = { select: () => q, lean: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
  User.findById = (id) => chain(String(id) === adminId ? { _id: adminId, role: 'admin', status: 'active' } : { _id: parentId, role: 'parent', status: 'active' });

  const app = require('../../server.js');
  const sse = require('../../sse');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/sse`;
  try {
    let res = await fetch(url);
    assert.strictEqual(res.status, 401, 'no token, no stream');
    res = await fetch(url, { headers: { Authorization: `Bearer ${jwt.sign({ userId: parentId, role: 'parent' }, process.env.JWT_SECRET)}` } });
    assert.strictEqual(res.status, 403, 'non-admins are refused');

    const controller = new AbortController();
    res = await fetch(url, { headers: { Authorization: `Bearer ${jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET)}` }, signal: controller.signal });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    let text = new TextDecoder().decode((await reader.read()).value);
    sse.broadcast('analytics:update', { type: 'test' });
    while (!text.includes('analytics:update')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    ok('the stream is for signed-in admins only, and still delivers events');
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

(async () => {
  await pageTests();
  await serverTests();
  console.log(results.map((m) => `  ok - ${m}`).join('\n'));
  console.log(`Admin live updates tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
