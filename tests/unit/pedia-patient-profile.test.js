// Pediatrician Patient Profile (PEDIA/patient-profile.html,
// js/pedia/patient-profile.js): each child's own page with a Case File tab and
// a Patient History tab, reusing js/pedia/pedia-case-files.js and
// js/pedia/patient-history.js.
//
// Runs the page's real scripts in a vm sandbox with stub elements and a
// recording apiFetch. Checks that only the requested child's records are
// requested and shown (never a sibling's), that a child outside the
// pediatrician's list is refused without requesting anything about them, that
// the tabs switch and scope printing, and that pedia-reports.js /
// pedia-case-files.js start no report loading or polling on this page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

const KEMRI = { childId: 'cA', name: 'Kemri Soto', dateOfBirth: '2022-01-05T00:00:00.000Z', gender: 'male', assessmentCount: 2 };
const LIA = { childId: 'cB', name: 'Lia Soto', dateOfBirth: '2023-04-20T00:00:00.000Z', gender: 'female', assessmentCount: 1 };

const DATA = {
  cA: {
    history: [{ id: 'KA1', childId: 'cA', status: 'complete', completedAt: '2026-06-10T02:00:00Z', overallScore: 67, communicationScore: 65, socialScore: 70, cognitiveScore: 60, motorScore: 72, recommendations: 'KEMRI RECOMMENDATION' }],
    checkups: [{ id: 'KC1', childId: 'cA', appointmentId: 11, checkupDate: '2026-06-12T04:00:00Z', visitType: 'initial_checkup', status: 'monitoring', findings: 'KEMRI FINDINGS' }],
    notes: [{ id: 1, mongoId: 'KN1', childId: 'cA', createdAt: '2026-06-20T00:00:00Z', progressStatus: 'improving', note: 'KEMRI NOTE' }],
  },
  cB: {
    history: [{ id: 'LB1', childId: 'cB', status: 'complete', completedAt: '2026-09-15T02:00:00Z', overallScore: 40, communicationScore: 35, socialScore: 40, cognitiveScore: 45, motorScore: 38, recommendations: 'LIA RECOMMENDATION' }],
    checkups: [{ id: 'LC1', childId: 'cB', appointmentId: 21, checkupDate: '2026-09-16T04:00:00Z', visitType: 'initial_checkup', status: 'stable', findings: 'LIA FINDINGS' }],
    notes: [{ id: 2, mongoId: 'LN1', childId: 'cB', createdAt: '2026-09-20T00:00:00Z', progressStatus: 'stable', note: 'LIA NOTE' }],
  },
};
const APPOINTMENTS = [
  { id: 11, childId: 'cA', status: 'completed', appointmentDate: '2026-06-12T00:00:00.000Z', appointmentTime: '14:30', reason: 'KEMRI VISIT' },
  { id: 21, childId: 'cB', status: 'completed', appointmentDate: '2026-09-16T00:00:00.000Z', appointmentTime: '10:00', reason: 'LIA VISIT' },
];

const REPORTS_ONLY = new Set(['practiceReportsPanel', 'caseFilePanel', 'caseFileSearch', 'caseFileResults', 'filterClassification', 'reportMeta', 'exportBtn']);

function element(id) {
  return {
    id, innerHTML: '', textContent: '', hidden: false, value: '', style: {}, dataset: {},
    _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    removeAttribute() {}, addEventListener() {},
  };
}

function loadPage(search, { hash = '' } = {}) {
  const elements = {};
  const listeners = [];
  const calls = [];
  let polls = 0;
  const location = { href: '/pedia/patient-profile', pathname: '/pedia/patient-profile', search, hash };
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, Promise, Date, Intl, Math, JSON, encodeURIComponent,
    document: {
      body: { dataset: { reportTab: 'case-files' }, classList: { add() {}, remove() {} } },
      title: '',
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') listeners.push(fn); },
      // Elements that exist only on the Reports page are absent here.
      getElementById: (id) => (REPORTS_ONLY.has(id) ? null : (elements[id] = elements[id] || element(id))),
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Gold', lastName: 'Deluna' }) }[k] || null),
      setItem() {}, removeItem() {},
    },
    KC: { user: () => ({ role: 'pediatrician', firstName: 'Gold', lastName: 'Deluna' }), poll: () => { polls += 1; return { stop() {} }; } },
  };
  sandbox.window = sandbox;
  sandbox.location = location;
  sandbox.history = { replaceState: (s, t, url) => { location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } };
  sandbox.apiFetch = async (ep) => {
    calls.push(ep);
    if (ep === '/pedia-reports/patients') return { patients: [KEMRI, LIA] };
    if (ep === '/assessments/pedia-patients') return { patients: [{ childId: 'cA', parentFirstName: 'Emmanuel', parentLastName: 'Soto', parentEmail: 'parent@example.test' }, { childId: 'cB', parentFirstName: 'Emmanuel', parentLastName: 'Soto', parentEmail: 'parent@example.test' }] };
    if (ep === '/appointments/pedia') return { appointments: APPOINTMENTS };
    // Section B's records for the case file's Developmental progress.
    const activity = ep.match(/^\/pedia-reports\/activity\?childId=(c[AB])$/);
    if (activity) {
      return { records: DATA[activity[1]].history.map((h) => ({
        assessmentId: h.id, childId: h.childId, name: h.childId === 'cA' ? 'Kemri Soto' : 'Lia Soto', assessedAt: h.completedAt, status: 'complete',
        domains: {
          communication: { score: h.communicationScore, band: null }, social: { score: h.socialScore, band: null },
          cognitive: { score: h.cognitiveScore, band: null }, motor: { score: h.motorScore, band: null },
        },
        overallScore: h.overallScore, overallBand: null,
      })) };
    }
    const m = ep.match(/^\/(assessments|checkups\/child)\/(c[AB])(\/.*)?$/) || ep.match(/^\/(assessments\/child|questions\/assigned|chat\/summary\/child)\/(c[AB])(\/.*)?$/);
    if (!m) throw new Error(`unexpected ${ep}`);
    const d = DATA[m[2]];
    if (ep.endsWith('/history')) return { assessments: d.history };
    if (ep.endsWith('/progress-notes')) return { notes: d.notes };
    if (ep.endsWith('/follow-ups')) return { plans: [] };
    if (ep.startsWith('/checkups/child/')) return { checkups: d.checkups, referrals: [] };
    if (ep.startsWith('/questions/assigned/')) return { assignments: [] };
    if (ep.startsWith('/chat/summary/child/')) return { conversations: [] };
    throw new Error(`unexpected ${ep}`);
  };
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/pedia/pedia-reports-interpretations.js', 'js/pedia/pedia-reports.js', 'js/pedia/pedia-case-files.js', 'js/pedia/patient-history.js', 'js/pedia/patient-profile.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  return { sandbox, elements, listeners, calls, polls: () => polls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
// Requests naming a child: by path (/…/cA/…) or by query (?childId=cA).
const childEndpoints = (calls) => calls.filter((c) => /\/c[AB](\/|$)|childId=c[AB]/.test(c));
const forChild = (c, id) => c.includes(`/${id}`) || c.includes(`childId=${id}`);

(async () => {
  // 1. Kemri's profile: only Kemri's records requested and shown.
  {
    const page = loadPage('?childId=cA');
    page.listeners.forEach((fn) => fn());
    await settle();
    assert.strictEqual(page.polls(), 0, 'no report polling on the profile page');
    // Only the patient list and this child's own records: no practice-wide reports.
    assert.deepStrictEqual(page.calls.filter((c) => c.startsWith('/pedia-reports/')).sort(),
      ['/pedia-reports/activity?childId=cA', '/pedia-reports/patients'], 'no practice reports loaded');
    assert(page.elements.caseFileContent.innerHTML.includes('All recorded assessments'), 'developmental progress in the case file');
    assert(childEndpoints(page.calls).length > 0 && childEndpoints(page.calls).every((c) => forChild(c, 'cA')), 'only Kemri\'s endpoints');
    const caseFile = page.elements.caseFileContent.innerHTML;
    assert(caseFile.includes('KEMRI RECOMMENDATION') && caseFile.includes('KEMRI FINDINGS') && caseFile.includes('KEMRI VISIT'));
    assert(!/LIA|Lia Soto/.test(caseFile), 'no sibling data in the case file');
    assert.strictEqual(page.elements.profileName.textContent, 'Kemri Soto');
    assert(page.elements.profileMeta.textContent.includes('Born January 5, 2022') && page.elements.profileMeta.textContent.includes('Parent: Emmanuel Soto'));
    assert.strictEqual(page.elements.profileTabs.hidden, false);
    assert.strictEqual(page.elements.printCaseFileBtn.hidden, false);
    assert.strictEqual(page.elements.caseFilePdfBtn.hidden, false);
    assert.strictEqual(page.sandbox.document.body.dataset.reportTab, 'case-files');
    ok('Kemri\'s profile requests and shows only Kemri\'s records; Reports start-up code stays idle');

    // 2. Patient History tab: loaded once, for Kemri only; print scope moves off the case file.
    page.calls.length = 0;
    page.sandbox.showProfileTab('history');
    await settle();
    assert.strictEqual(page.sandbox.document.body.dataset.reportTab, 'patient-history');
    assert.strictEqual(page.elements.profileHistoryPanel.hidden, false);
    assert.strictEqual(page.elements.profileCaseFilePanel.hidden, true);
    assert.strictEqual(page.elements.profileCaseActions.style.display, 'none');
    assert.strictEqual(page.sandbox.location.hash, '#history');
    assert(childEndpoints(page.calls).every((c) => forChild(c, 'cA')));
    const historyHtml = page.elements.patientHistoryList.innerHTML;
    assert(historyHtml.includes('KEMRI NOTE') && historyHtml.includes('Progress note'));
    assert(!/LIA/.test(historyHtml), 'no sibling data in the history');
    page.calls.length = 0;
    page.sandbox.showProfileTab('case-file');
    page.sandbox.showProfileTab('history');
    await settle();
    assert.strictEqual(page.calls.length, 0, 'history is loaded once per page');
    assert.strictEqual(page.sandbox.document.body.dataset.reportTab, 'patient-history');
    page.sandbox.showProfileTab('case-file');
    assert.strictEqual(page.sandbox.document.body.dataset.reportTab, 'case-files');
    assert.strictEqual(page.elements.profileCaseActions.style.display, '');
    ok('Patient History tab loads this child only, once; printing stays scoped to the Case File tab');
  }

  // 3. Lia's profile, opened straight on #history: only Lia.
  {
    const page = loadPage('?childId=cB', { hash: '#history' });
    page.listeners.forEach((fn) => fn());
    await settle();
    assert(childEndpoints(page.calls).every((c) => forChild(c, 'cB')));
    assert(page.elements.patientHistoryList.innerHTML.includes('LIA NOTE'));
    assert(page.elements.caseFileContent.innerHTML.includes('LIA FINDINGS'));
    assert(!/KEMRI/.test(page.elements.patientHistoryList.innerHTML + page.elements.caseFileContent.innerHTML));
    ok('a sibling\'s profile shows only that sibling\'s records');
  }

  // 4. Not this pediatrician's patient, or no child given: nothing requested.
  for (const search of ['?childId=cZ', '']) {
    const page = loadPage(search);
    page.listeners.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(childEndpoints(page.calls), [], 'no record endpoints called');
    assert(/not one of your patients|No patient was selected/.test(page.elements.caseFileContent.innerHTML));
    // The tabs start hidden in the HTML; the script never touched them.
    assert.strictEqual(page.elements.profileTabs, undefined, 'tabs stay hidden');
    page.sandbox.showProfileTab('history');
    await settle();
    assert.deepStrictEqual(childEndpoints(page.calls), []);
  }
  ok('a child outside the pediatrician\'s list (or none) is refused without requesting their records');

  results.forEach((r) => console.log('ok -', r));
  console.log(`\npedia-patient-profile: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
