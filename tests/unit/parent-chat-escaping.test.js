// Parent chat (js/parent/chat.js) and the child pickers / profile name:
// every value typed by someone else is escaped before it reaches innerHTML.
//
// The bug: the Parent chat put the pediatrician's message, video name,
// pediatrician and child names and photo paths into the page raw (the
// Pediatrician chat already escaped them), so a message such as
// `<img src=x onerror=...>` ran script in the parent's session, where the
// sign-in token lives. Child names, set by the registering parent, were also
// raw on Profile, Appointments and Recommendations, which a linked guardian
// sees.
//
// No browser: the real chat script runs in a node vm with a tiny fake DOM,
// using the real escapeHtml from /api.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const results = [];
const ok = (m) => results.push(m);

const EVIL = '<img src=x onerror=alert(1)>';
const noRawTag = (html) => !/<img src=x/i.test(html) && !/onerror=alert\(1\)>/.test(html.replace(/&[a-z#0-9]+;/gi, ''));

// The real escapeHtml from api.js (the global every page script uses).
const apiSrc = read('api.js');
const escapeSrc = apiSrc.slice(apiSrc.indexOf('function escapeHtml('), apiSrc.indexOf('function formatDateTime('));

function loadChat(responses) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', value: '', style: {}, scrollTop: 0, scrollHeight: 0 });
    return els.get(id);
  };
  const KC = { user: () => ({ id: 'p1', userId: 'p1', role: 'parent' }), token: () => 't', poll: () => ({ stop() {} }) };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: { location: { href: '', search: '' }, addEventListener() {}, KC },
    document: { getElementById: el, addEventListener() {}, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams,
    KC,
    requireAuth: () => true,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    alert() {},
    // chatFetch() goes through the shared apiFetch from api.js.
    apiFetch: async (url) => {
      const key = Object.keys(responses).find((k) => String(url).includes(k));
      return key ? responses[key] : {};
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(escapeSrc, sandbox);
  vm.runInContext(read('js/parent/chat.js'), sandbox);
  return { sandbox, el };
}

(async () => {
  // 1. Messages, video names and sender photos from the other side.
  const page = loadChat({});
  page.sandbox.renderMessages([
    { id: 1, senderId: 'ped1', senderName: EVIL, senderPhoto: `/uploads/x" onerror="alert(1)`, message: EVIL, createdAt: new Date().toISOString() },
    { id: 2, senderId: 'ped1', senderName: 'Dr A', message: 'Hello & welcome', videoPath: `/uploads/v.mp4" onerror="alert(1)`, videoName: EVIL, createdAt: new Date().toISOString() },
  ]);
  const html = page.el('chatMessages').innerHTML;
  assert.ok(noRawTag(html), 'no raw tag from a message or video name');
  assert.ok(!html.includes('" onerror="'), 'a photo or video path cannot break out of its attribute');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the message is shown as text');
  assert.ok(html.includes('Hello &amp; welcome'), 'ordinary text still shows');
  ok('chat messages, video names and photo paths are shown as text');

  // 2. The conversation list: pediatrician and child names, photo path.
  const list = loadChat({
    '/chat/threads': { threads: [{ appointmentId: 7, childId: 'c1', pediatricianId: 'd1', childName: EVIL, pediatricianName: EVIL, pedPhoto: `/uploads/p.png" onerror="alert(1)`, appointmentDate: new Date().toISOString(), unread: 0 }] },
  });
  await list.sandbox.loadThreads();
  const threads = list.el('threadsList').innerHTML;
  assert.ok(threads.includes('thread-item'), 'the thread rendered');
  assert.ok(noRawTag(threads) && !threads.includes('" onerror="'), 'names and photo path are escaped');
  ok('conversation list names and photo are escaped');

  // 3. Child names on the pages a linked guardian sees.
  const profile = read('js/parent/profile.js');
  assert.ok(profile.includes("field('Name', escapeHtml([c.firstName, c.middleName, c.lastName]"), 'profile child name escaped');
  for (const f of ['js/parent/appointments.js', 'js/parent/recommendations.js']) {
    const src = read(f);
    assert.ok(!/>\$\{c\.firstName\} \$\{c\.lastName\}<\/option>/.test(src), `${f}: no raw child name in the picker`);
    assert.ok(/>\$\{escapeHtml\(c\.firstName\)\} \$\{escapeHtml\(c\.lastName\)\}<\/option>/.test(src), `${f}: child name escaped`);
  }
  ok('child names are escaped on Profile, Appointments and Recommendations');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Parent chat escaping tests OK — ${results.length} groups`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
