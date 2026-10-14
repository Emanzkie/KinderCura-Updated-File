// Tests for the pediatrician "Assign Question / Question Set to Patient"
// modal (PEDIA/pedia-questions.html + js/pedia/pedia-questions.js).
//
// The redesign is a table, but it also had to keep — and in set mode, fix —
// the existing behaviour: in Question Set mode the filters, Select All and
// "Assign Selected" used to fall back to the single-question renderer and
// posted to /questions/null/assign, and a filter overwrote the page-wide
// patientList the Answer Tracker reads. These tests pin the behaviour down.
//
// No browser, no network: the real page script runs in a node vm with a tiny
// fake DOM and a fake fetch that records every request.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

// ── Fake DOM ──────────────────────────────────────────────────────────────
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', title: '', src: '',
    disabled: false, checked: false, indeterminate: false,
    style: {}, options: [], dataset: {},
    addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
  };
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const footerCount = makeEl('footer-count');

const requests = [];
let respond = () => ({ success: true });
const sandbox = {
  console,
  URLSearchParams,
  setTimeout: () => 0,
  setInterval: () => 0,
  alert() {},
  confirm: () => true,
  localStorage: {
    getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana' }) }[k] ?? null),
    setItem() {}, removeItem() {},
  },
  document: {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '#assignModal .assign-selected-count' ? [footerCount] : []),
    addEventListener() {},
    body: { contains: () => true },
  },
  fetch: async (url, options = {}) => {
    const u = new URL(url);
    const entry = { method: options.method || 'GET', path: u.pathname.replace(/^\/api/, ''), query: u.search, body: options.body ? JSON.parse(options.body) : null };
    requests.push(entry);
    const out = respond(entry);
    return { ok: !out.__fail, status: out.__fail ? 500 : 200, json: async () => out };
  },
};
sandbox.window = sandbox;
sandbox.location = { origin: 'http://localhost', href: '', search: '' };
sandbox.window.location = sandbox.location;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'constants/scoring.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/pedia/pedia-questions.js'), 'utf8'), sandbox);
const run = (code) => vm.runInContext(code, sandbox);
// Values built inside the vm have that realm's prototypes; compare as JSON.
const runJ = (code) => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', sandbox));

// ── Fixture ───────────────────────────────────────────────────────────────
const SET_ID = 'set1';
const kid = (n, first, appt) => ({ childId: `c${n}`, childName: `${first} Test`, parentName: `Parent ${n}`, appointmentId: appt });
const PATIENTS = [kid(1, 'Lucas', 11), kid(2, 'Isla', 12), kid(3, 'Noah', 13), kid(4, 'Zoe', 14)];
const serverPatient = (n, first, appt, s, statuses) => ({
  childId: `c${n}`, childFirstName: first, childLastName: 'Test', parentFirstName: 'Parent', parentLastName: String(n), appointmentId: appt,
  communicationScore: s, socialScore: s, cognitiveScore: s, motorScore: s,
  communicationStatus: statuses, socialStatus: statuses, cognitiveStatus: statuses, motorStatus: statuses,
  lastAssessmentDate: '2026-10-12T08:00:00Z',
});
const ALL_SCORED = [serverPatient(1, 'Lucas', 11, 82, 'on-track'), serverPatient(2, 'Isla', 12, 45, 'at-risk'), serverPatient(4, 'Zoe', 14, 90, 'on-track')];

function setup() {
  requests.length = 0;
  run(`
    allQuestionSets = [{ setId: '${SET_ID}', title: 'Set A', questions: [{ id: 101 }, { id: 102 }] }];
    allQuestions = [{ id: 201, questionText: 'Single question?' }];
    patientList = ${JSON.stringify(PATIENTS)};
    trackerAssignments = [
      { childId: 'c1', questionId: 101, appointmentId: 11 }, { childId: 'c1', questionId: 102, appointmentId: 11 },
      { childId: 'c2', questionId: 101, appointmentId: 12 },
      { childId: 'c4', questionId: 101, appointmentId: 99 }, { childId: 'c4', questionId: 102, appointmentId: 99 },
      { childId: 'c3', questionId: 201, appointmentId: 13 },
    ];
  `);
  respond = (r) => {
    if (r.path === '/assessments/patients') {
      const q = new URLSearchParams(r.query);
      if (q.get('category') === 'communication' && q.get('threshold') === 'at-risk') return { success: true, patients: [ALL_SCORED[1]] };
      return { success: true, patients: ALL_SCORED };
    }
    if (r.path === '/appointments/pedia') {
      return { success: true, appointments: PATIENTS.map((p) => ({
        id: p.appointmentId, childId: p.childId,
        childFirstName: p.childName.split(' ')[0], childLastName: 'Test',
        parentFirstName: 'Parent', parentLastName: p.parentName.split(' ')[1],
      })) };
    }
    if (r.path === '/questions' || r.path.startsWith('/questions/assigned')) return { success: true, assignments: [], questionSets: [], questions: [] };
    return { success: true };
  };
}
const statusOf = (childId) => run(`assignmentStatusFor(assignVisibleRows().find(r => r.childId === '${childId}')).key`);
const html = () => el('assignPatientList').innerHTML;

(async () => {
  // ── Set mode: statuses mirror the server's duplicate rule ──
  setup();
  await run(`openAssignSetModal('${SET_ID}')`);
  assert.strictEqual(el('assignModalTitle').textContent, 'Assign Question Set to Patient');
  assert.strictEqual(el('assignModalSub').textContent, 'Set: "Set A" (2 questions)');
  assert.strictEqual(statusOf('c1'), 'assigned');
  assert.strictEqual(statusOf('c2'), 'partial');
  assert.strictEqual(statusOf('c3'), 'none');
  assert.strictEqual(statusOf('c4'), 'none', 'assigned under another appointment: the server would create it, so it is still assignable');
  assert(html().includes('Partly assigned (1/2)') && html().includes('Already assigned') && html().includes('Not assigned'));
  assert.strictEqual(el('assignVisibleCount').textContent, '4 patients shown');
  ok('set mode: title/subtitle from the real set; status per patient follows question + child + appointment');

  // Real data only: dates and scores come from /assessments/patients as sent.
  assert(requests.some((r) => r.path === '/assessments/patients' && r.query === ''));
  assert(html().includes('Oct 12, 2026'));
  assert(html().includes('No assessment result yet') && html().includes('No score'), 'Noah has no result');
  assert(html().includes('Communication 82%') && html().includes('Motor 90%'));
  ok('table shows each patient\'s real latest-assessment date and domain scores; missing data is labelled, not invented');

  // Already-assigned rows cannot be selected or assigned again.
  assert(/value="c1"[^>]*disabled/.test(html()));
  run(`togglePatientSelection('c1')`);
  assert.strictEqual(run('selectedPatients.size'), 0);
  el('selectAllPatients').checked = true;
  run('toggleSelectAllPatients()');
  assert.deepStrictEqual(runJ('[...selectedPatients].sort()'), ['c2', 'c3', 'c4']);
  assert.strictEqual(el('selectedCount').textContent, 3);
  assert.strictEqual(footerCount.textContent, 3, 'footer count matches');
  assert.strictEqual(el('assignSelectedBtn').disabled, false);
  ok('Select All Visible picks only assignable patients; both Assign Selected counts stay in sync');

  // ── Filters ──
  assert.strictEqual(el('filterThreshold').disabled, true, 'status waits for a category');
  el('filterCategory').value = 'communication';
  await run('filterPatientsByAssessment()');
  const last = requests[requests.length - 1];
  assert.strictEqual(last.path, '/assessments/patients');
  assert.strictEqual(last.query, '', 'category alone calls the endpoint unfiltered (with only a category it returns no one)');
  assert.strictEqual(el('filterThreshold').disabled, false);
  assert.strictEqual(el('assignVisibleCount').textContent, '3 patients shown');
  assert(html().includes('On-Track 82%') && html().includes('At-Risk 45%'), 'single badge for the chosen domain');
  assert.deepStrictEqual(runJ('[...selectedPatients].sort()'), ['c2', 'c4'], 'Noah (hidden by the filter) left the selection');
  ok('category filter: one badge per patient for that domain, hidden patients drop out of the selection');

  el('filterThreshold').value = 'at-risk';
  await run('filterPatientsByAssessment()');
  assert.strictEqual(requests[requests.length - 1].query, '?category=communication&threshold=at-risk');
  assert.strictEqual(el('assignVisibleCount').textContent, '1 patient shown');
  assert.deepStrictEqual(runJ('[...selectedPatients]'), ['c2']);
  assert.strictEqual(run('patientList.length'), 4, 'the page-wide patient list is not overwritten by a filter');
  ok('category + status filter uses the existing endpoint unchanged and never overwrites patientList');

  // Bulk in set mode now posts to the SET endpoint for exactly the visible selection.
  requests.length = 0;
  await run('assignToSelectedPatients()');
  const posts = requests.filter((r) => r.method === 'POST');
  assert.deepStrictEqual(posts.map((r) => [r.path, r.body]), [[`/questions/set/${SET_ID}/assign`, { childId: 'c2', appointmentId: 12 }]]);
  assert(/Question set assigned to 1 patient/.test(el('successFlash').textContent));
  assert.strictEqual(el('assignModal').style.display, 'none');
  ok('Assign Selected in set mode posts the set to the selected visible patients only (was /questions/null/assign)');

  // Clear Filters restores defaults.
  setup();
  await run(`openAssignSetModal('${SET_ID}')`);
  el('filterCategory').value = 'communication';
  el('filterThreshold').value = 'at-risk';
  await run('filterPatientsByAssessment()');
  await run('clearAssessmentFilters()');
  assert.strictEqual(el('filterCategory').value, '');
  assert.strictEqual(el('filterThreshold').value, '');
  assert.strictEqual(el('filterThreshold').disabled, true);
  assert.strictEqual(el('assignVisibleCount').textContent, '4 patients shown');
  ok('Clear Filters resets both controls and shows every patient again');

  // ── Question mode keeps its endpoints ──
  setup();
  await run('openAssignModal(201)');
  assert.strictEqual(el('assignModalTitle').textContent, 'Assign Question to Patient');
  assert.strictEqual(statusOf('c3'), 'assigned');
  assert.strictEqual(statusOf('c1'), 'none');
  requests.length = 0;
  await run(`assignRowAction(null, 'c1', 11)`);
  assert.deepStrictEqual(requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body]), [['/questions/201/assign', { childId: 'c1', appointmentId: 11 }]]);
  ok('question mode: single Assign still calls POST /questions/:id/assign with the same payload');

  // Failed bulk: reported as a failure, nothing claimed.
  setup();
  await run('openAssignModal(201)');
  el('selectAllPatients').checked = true;
  run('toggleSelectAllPatients()');
  respond = (r) => (r.method === 'POST' ? { __fail: true, error: 'Simulated' } : { success: true, patients: ALL_SCORED });
  await run('assignToSelectedPatients()');
  assert(/Assigned to 0 patient\(s\)\. 3 failed\./.test(el('errorFlash').textContent));
  ok('a failed bulk assignment is reported as failed');

  // ── Display never recalculates a classification ──
  setup();
  respond = (r) => (r.path === '/assessments/patients'
    ? { success: true, patients: [serverPatient(1, 'Lucas', 11, 90, 'delayed')] }
    : { success: true });
  await run(`openAssignSetModal('${SET_ID}')`);
  el('filterCategory').value = 'motor';
  await run('filterPatientsByAssessment()');
  assert(html().includes('Delayed 90%'), 'the server\'s stored status is shown as-is, even if it disagrees with today\'s bands');
  ok('score badges show the server\'s score and status without recomputing them');

  // ── Untrusted text is escaped ──
  setup();
  run(`patientList = [{ childId: 'c9', childName: '<img src=x onerror=alert(1)>', parentName: 'A & B', appointmentId: 1 }]`);
  respond = (r) => (r.path === '/assessments/patients' ? { success: true, patients: [] } : { success: true });
  await run(`openAssignSetModal('${SET_ID}')`);
  assert(!html().includes('<img src=x') && html().includes('&lt;img src=x') && html().includes('A &amp; B'));
  ok('patient and parent names are escaped');

  // Markup keeps every id the page script relies on.
  const page = fs.readFileSync(path.join(ROOT, 'PEDIA/pedia-questions.html'), 'utf8');
  for (const id of ['assignModal', 'assignModalTitle', 'assignModalSub', 'filterCategory', 'filterThreshold', 'selectAllPatients',
    'assignVisibleCount', 'assignSelectedBtn', 'selectedCount', 'assignPatientList', 'assignScoreNote', 'assignSelectedFooterBtn']) {
    assert.strictEqual((page.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} exactly once`);
  }
  ok('modal markup keeps every element id the script uses, each exactly once');

  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Pediatrician assign modal tests OK — ${results.length} groups`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
