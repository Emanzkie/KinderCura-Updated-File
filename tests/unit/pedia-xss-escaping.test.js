// Stored XSS on the pediatrician pages (PEDIATRICIAN_BUGS.md #1).
//
// Child/parent names, appointment reason/notes, chat text, photo/video paths,
// diagnoses and progress notes are all typed by parents, yet were interpolated
// into innerHTML unescaped, and the appointment buttons put the child's name
// inside inline onclick strings. These tests run the real page scripts in a
// node vm with a tiny fake DOM, feed them hostile data, and check that nothing
// reaches the markup unescaped and that the buttons no longer use onclick.
//
// No browser, no network, no database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

const EVIL = '<img src=x onerror=alert(1)>';
const EVIL_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
const EVIL_ATTR = '/uploads/a" onerror="alert(1)';

function loadPage(file, extra = {}) {
  const els = new Map();
  const makeEl = (id) => ({
    id, value: '', textContent: '', innerHTML: '', title: '', src: '', href: '',
    disabled: false, checked: false, scrollTop: 0, scrollHeight: 0,
    style: {}, dataset: {}, options: [],
    addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  });
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

  const listeners = {};
  const confirms = [];
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
    alert() {},
    confirm: (msg) => { confirms.push(msg); return false; },
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
      setItem() {}, removeItem() {}, clear() {},
    },
    document: {
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      body: { contains: () => true },
    },
    // Never settles, so the page's own start-up loads stay inert.
    fetch: extra.fetch || (() => new Promise(() => {})),
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    // Shared helpers that the real pages get from /api.js.
    loadNotificationCount: async () => {},
    ...extra.globals,
  };
  sandbox.window = sandbox;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'constants/scoring.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/pedia', file), 'utf8'), sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  return { run, el, listeners, confirms, sandbox };
}

// The attacker-controlled text must appear only in its escaped form.
function assertEscaped(html, label) {
  assert(!html.includes('<img src=x'), `${label}: raw <img> injected`);
  assert(!html.includes('<script'), `${label}: raw <script> injected`);
  assert(!html.includes('" onerror="alert(1)'), `${label}: attribute breakout`);
  assert(html.includes(EVIL_ESCAPED), `${label}: escaped text missing`);
}

(async () => {
  // ── Appointments page ───────────────────────────────────────────────────
  {
    const page = loadPage('pediatrician-appointments.js');
    const appt = (status) => JSON.stringify({
      id: 7, status, appointmentDate: '2026-11-02', appointmentTime: '09:00',
      childName: `O'Brien ${EVIL}`, parentName: EVIL, childAge: EVIL,
      reason: EVIL, notes: EVIL,
    });
    page.run(`renderUpcoming([${appt('pending')}, ${appt('approved')}])`);
    page.run(`renderCompleted([${appt('completed')}])`);
    page.run(`renderCancelled([${appt('cancelled')}])`);

    for (const pane of ['upcoming-pane', 'completed-pane', 'cancelled-pane']) {
      assertEscaped(page.el(pane).innerHTML, `appointments ${pane}`);
    }
    const upcoming = page.el('upcoming-pane').innerHTML;
    assert(!/onclick="(updateStatus|openStatusModal|openReschedule|cancelConfirm)/.test(upcoming),
      'card buttons must not use inline onclick handlers');
    assert(!/onclick="window\.location/.test(upcoming), 'chat button must not use inline onclick');
    assert(upcoming.includes('data-appt-act="approve"') && upcoming.includes('data-appt-act="cancel"'));
    assert(upcoming.includes(`data-child="O&#39;Brien ${EVIL_ESCAPED}"`), 'apostrophe name must be attribute-escaped');
    ok('appointments: names, reason and notes escaped in all three tabs; buttons use data-* not onclick');

    // The delegated listener must still drive the original handlers, with the
    // name arriving as plain text (what the browser decodes the attribute to).
    const click = (dataset) => page.listeners.click.forEach((fn) =>
      fn({ target: { closest: (sel) => (sel === '[data-appt-act]' ? { dataset } : null) } }));
    click({ apptAct: 'reject', apptId: '7', child: "O'Brien" });
    assert.strictEqual(page.el('statusModalSub').textContent, "Patient: O'Brien");
    click({ apptAct: 'cancel', apptId: '7', child: "O'Brien" });
    assert(page.confirms[0].includes("O'Brien"), 'cancel confirm should name the patient');
    click({ apptAct: 'reschedule', apptId: '7', child: "O'Brien", parent: 'Mom' });
    assert.strictEqual(page.el('rSub').textContent, "Patient: O'Brien  |  Parent: Mom");
    click({ apptAct: 'chat', apptId: '7' });
    assert.strictEqual(page.sandbox.location.href, '/pedia/pedia-chat.html?appointmentId=7');
    ok('appointments: delegated click handler still reaches reject / cancel / reschedule / chat');
  }

  // ── Dashboard ───────────────────────────────────────────────────────────
  {
    const page = loadPage('pediatrician-dashboard.js');
    page.run(`renderPending([{ id: 3, parentName: ${JSON.stringify(EVIL)}, childName: ${JSON.stringify(EVIL)},
      reason: ${JSON.stringify(EVIL)}, appointmentDate: '2026-11-02', appointmentTime: '09:00',
      overallScore: 50, communicationScore: 50, communicationStatus: ${JSON.stringify(EVIL)} }])`);
    assertEscaped(page.el('pendingList').innerHTML, 'dashboard pending');
    page.run(`renderActivity([{ status: 'pending', childName: ${JSON.stringify(EVIL)}, parentName: ${JSON.stringify(EVIL)}, createdAt: new Date().toISOString() }])`);
    assertEscaped(page.el('activityList').innerHTML, 'dashboard activity');
    ok('dashboard: pending requests and recent activity escaped');
  }

  // ── My Patients ─────────────────────────────────────────────────────────
  {
    const page = loadPage('pediatrician-patients.js');
    page.run(`renderPatients([{ childId: 'c1', childFirstName: ${JSON.stringify(EVIL)}, childLastName: 'Test',
      parentFirstName: ${JSON.stringify(EVIL)}, parentLastName: '', parentEmail: '"><script>x</script>',
      childGender: 'male', childDateOfBirth: '2024-01-01', childProfileIcon: ${JSON.stringify(EVIL_ATTR)},
      appointmentStatus: 'approved', appointmentDate: '2026-11-02',
      scores: { communication: 50 }, overallScore: 50,
      diagnosis: ${JSON.stringify(EVIL)}, progressNotesCount: 1, latestProgressNote: ${JSON.stringify(EVIL)} }])`);
    const html = page.el('patientsList').innerHTML;
    assertEscaped(html, 'patients list');
    assert(!html.includes('"><script>'), 'parentEmail data attribute must be escaped');
    page.run(`renderProgressNotes([{ note: ${JSON.stringify(EVIL)}, progressStatus: 'stable', createdAt: new Date().toISOString() }])`);
    assertEscaped(page.el('progressTimeline').innerHTML, 'patients progress notes');
    ok('patients: names, avatar, data attributes, diagnosis and progress notes escaped');
  }

  // ── Chat ────────────────────────────────────────────────────────────────
  {
    const fetchStub = async (url) => {
      const u = new URL(url);
      const body = u.pathname === '/api/chat/threads'
        ? { threads: [{ appointmentId: 5, childId: 'c', parentId: 'p', childName: EVIL, parentName: EVIL,
            parentPhoto: EVIL_ATTR, appointmentDate: '2026-11-02', unread: 0 }] }
        : {};
      return { ok: true, status: 200, json: async () => body };
    };
    const page = loadPage('pedia-chat.js', { fetch: fetchStub });
    await page.run('loadThreads()');
    assertEscaped(page.el('threadsList').innerHTML, 'chat threads');

    page.run(`renderMessages([{ id: 1, senderId: 'other', senderName: ${JSON.stringify(EVIL)},
      senderPhoto: ${JSON.stringify(EVIL_ATTR)}, message: ${JSON.stringify(EVIL)},
      videoPath: ${JSON.stringify('x" onerror="alert(1)')}, videoName: ${JSON.stringify(EVIL)},
      createdAt: new Date().toISOString() }])`);
    const html = page.el('chatMessages').innerHTML;
    assertEscaped(html, 'chat messages');
    // The initials are embedded in a JS string inside onerror, so they must hold only letters/digits.
    page.run(`renderMessages([{ id: 2, senderId: 'other', senderName: "'+alert(1)+'", senderPhoto: '/uploads/a.png', message: 'hi', createdAt: new Date().toISOString() }])`);
    assert(!/onerror="[^"]*alert\(1\)/.test(page.el('chatMessages').innerHTML), 'initials must not break out of the onerror string');
    ok('chat: thread list, sender, message, photo and video values escaped; initials cannot break out of onerror');
  }

  console.log(results.map((r) => `  ✓ ${r}`).join('\n'));
  console.log(`\npedia-xss-escaping.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
