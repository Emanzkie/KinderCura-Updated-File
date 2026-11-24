// Parent and pediatrician chat: a link opens its own conversation, a late reply
// never appears under another chat, and a message goes to the chat it was sent
// from. Also: login's ?next= never leaves this site.
// The real page scripts run in a node vm with a tiny fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const apiSrc = read('api.js');
const escapeSrc = apiSrc.slice(apiSrc.indexOf('function escapeHtml('), apiSrc.indexOf('function formatDateTime('));
const tick = () => new Promise((r) => setImmediate(r));
const results = [];

const makeEl = (id) => ({
  id, innerHTML: '', textContent: '', value: '', style: {}, checked: true, listeners: {},
  classList: { add() {}, remove() {} }, focus() {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
});

function loadChat(file, role, search) {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const calls = [];
  const request = (url, opts = {}) => new Promise((resolve) => calls.push({ url, opts, reply: resolve }));
  const user = { id: 'u1', userId: 'u1', role, firstName: 'A', lastName: 'B' };
  const live = new Set();
  const KC = {
    user: () => user,
    token: () => 't',
    poll: () => { const t = { stop() { live.delete(t); } }; live.add(t); return t; },
  };
  const location = { href: '', search, origin: 'https://kc.test' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, location,
    window: { location, addEventListener() {}, KC },
    document: { getElementById: el, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: (k) => (k === 'kc_user' ? JSON.stringify(user) : 't'), setItem() {}, removeItem() {} },
    URLSearchParams, KC, requireAuth: () => true, setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, alert() {},
    apiFetch: request,
    fetch: async (url, opts) => { const body = await request(url, opts); return { ok: true, json: async () => body }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(escapeSrc, sandbox);
  vm.runInContext(read(file), sandbox);
  const pending = (part) => calls.filter((c) => c.url.endsWith(part) && !c.done);
  const reply = async (part, body) => {
    const c = pending(part)[0];
    assert.ok(c, `${file}: request ${part}`);
    c.done = true; c.reply(body); await tick(); await tick();
  };
  return { sandbox, el, calls, pending, reply, polls: () => live.size };
}

const msgs = (text) => ({ messages: [{ id: text, senderId: 'x', senderName: 'X', message: text, createdAt: new Date().toISOString() }], appointmentInfo: {} });
const THREADS = {
  threads: [7, 9].map((id) => ({ appointmentId: id, childId: `c${id}`, pediatricianId: `d${id}`, childName: 'Kid', parentName: 'Par', pediatricianName: 'Ped', appointmentDate: new Date().toISOString(), unread: 0 })),
};

async function chatPage(file, role) {
  const openList = async (search) => {
    const p = loadChat(file, role, search);
    if (!p.pending('/chat/threads').length) p.sandbox.loadThreads();
    await p.reply('/chat/threads', THREADS);
    return p;
  };

  // 1. ?appointmentId= (and the older ?apptId=) open that conversation.
  for (const id of [7, 9]) {
    for (const key of ['appointmentId', 'apptId']) {
      const p = await openList(`?${key}=${id}`);
      assert.strictEqual(p.pending(`/chat/${id}`).length, 1, `${file}: ?${key}=${id} opens appointment ${id}`);
      assert.strictEqual(p.pending(`/chat/${16 - id}`).length, 0, `${file}: and not the other conversation`);
    }
  }
  const first = await openList('');
  assert.strictEqual(first.pending('/chat/7').length + first.pending('/chat/9').length, 1, `${file}: without a link one conversation still opens`);
  results.push(`${file}: a chat link opens its own conversation`);

  // 2. Reply for chat 7 arrives after chat 9 was opened.
  const p = loadChat(file, role, '');
  const settleVideos = async () => { while (p.pending('/videos/appointment/9').length) await p.reply('/videos/appointment/9', { videos: [] }); };
  const shown = () => p.el('chatMessages').innerHTML;
  p.sandbox.openThread(7); await tick();
  p.sandbox.openThread(9); await tick();
  await p.reply('/chat/9', msgs('NINE')); await settleVideos();
  await p.reply('/chat/7', msgs('SEVEN'));
  assert.ok(shown().includes('NINE') && !shown().includes('SEVEN'), `${file}: late reply discarded`);
  assert.strictEqual(p.polls(), 1, `${file}: only the open chat is polled`);

  // A poll already on its way when the chat changes.
  p.sandbox.pollMessages(); await tick();
  p.sandbox.openThread(7); await tick();
  await p.reply('/chat/9', msgs('NINE-NEW'));
  assert.ok(!shown().includes('NINE-NEW'), `${file}: late poll discarded`);
  results.push(`${file}: late replies never show under another chat`);

  // 3. Send stays with the chat it was clicked in, even during a video upload.
  const s = loadChat(file, role, '');
  s.sandbox.openThread(7); await tick();
  s.el('msgInput').value = 'for seven';
  let uploaded;
  s.sandbox.upload = new Promise((r) => { uploaded = r; });
  vm.runInContext('pendingVideoFile = { size: 1 }; uploadChatVideo = () => upload;', s.sandbox);
  s.sandbox.sendMessage(); await tick();
  s.sandbox.openThread(9); await tick();
  uploaded({ path: '/uploads/v.mp4', fileName: 'v.mp4' }); await tick(); await tick();
  const posts = s.calls.filter((c) => c.opts.method === 'POST');
  assert.deepStrictEqual(posts.map((c) => c.url.split('/').pop()), ['7'], `${file}: sent to the original chat`);
  results.push(`${file}: a message goes to the chat it was sent from`);
}

async function loginGoesTo(search) {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const location = { href: '', search, origin: 'https://kc.test', protocol: 'https:', pathname: '/login' };
  const body = { success: true, token: 't', user: { role: 'parent' }, needsPreAssessment: false };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, location, URL, URLSearchParams,
    window: { location, addEventListener() {} },
    document: { getElementById: el, querySelector: el, querySelectorAll: () => [], addEventListener() {}, cookie: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => body }),
    apiFetch: async () => body,
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('js/auth/login.js'), sandbox);
  const form = [...els.values()].find((e) => e.listeners.submit && e.id !== 'prcResubmitForm');
  await form.listeners.submit({ preventDefault() {} });
  return location.href;
}

(async () => {
  await chatPage('js/parent/chat.js', 'parent');
  await chatPage('js/pedia/pedia-chat.js', 'pediatrician');

  for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com', 'https://kc.test.evil.com', 'javascript:alert(1)', '%2F%2Fevil.com', '//', '%']) {
    assert.strictEqual(await loginGoesTo(`?next=${encodeURIComponent(bad)}`), '/parent/dashboard', `refused: ${bad}`);
  }
  const good = '/secretary/secretary-cashier?ref=AB1';
  assert.strictEqual(await loginGoesTo(`?next=${encodeURIComponent(good)}`), good);
  assert.strictEqual(await loginGoesTo(''), '/parent/dashboard');
  results.push('login ?next= stays on this site');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Chat thread safety tests OK - ${results.length} groups`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
