// Patient Case Files (js/pedia/pedia-case-files.js) on the pediatrician
// Reports page: a case file shows only the selected child's records, a late
// response for a previously selected child is dropped, the progress comparison
// is plain arithmetic on stored scores, and every name and clinician note is
// escaped.
//
// Runs the real browser scripts (constants/scoring.js, js/pedia/pedia-reports.js
// for its shared helpers, then pedia-case-files.js) in a vm sandbox with stub
// DOM elements. No server, no DB, no network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

function element() {
  return { innerHTML: '', hidden: false, value: '', dataset: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {} };
}

function loadSandbox() {
  const elements = {};
  const sandbox = {
    window: { location: { href: '/pedia/pedia-reports', hash: '', pathname: '/pedia/pedia-reports', search: '' } },
    document: {
      body: { dataset: {} },
      addEventListener() {},
      getElementById: (id) => (elements[id] = elements[id] || element()),
    },
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Gold', lastName: 'Deluna' }) }[k] || null),
      setItem() {}, removeItem() {},
    },
    history: { replaceState() {} },
    URLSearchParams,
    console,
    setTimeout,
  };
  sandbox.window.KC = { user: () => ({ firstName: 'Gold', lastName: 'Deluna', role: 'pediatrician' }) };
  sandbox.KC = sandbox.window.KC;
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/pedia/pedia-reports.js', 'js/pedia/pedia-case-files.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  return { sandbox, elements };
}

const assessment = (id, childId, completedAt, scores, extra = {}) => ({
  id, childId, status: 'complete', completedAt, startedAt: completedAt,
  communicationScore: scores[0], socialScore: scores[1], cognitiveScore: scores[2], motorScore: scores[3],
  overallScore: Math.round(scores.reduce((a, b) => a + b, 0) / 4),
  ...extra,
});

const KEMRI = { childId: 'cA', name: 'Kemri <b>Soto</b>', dateOfBirth: '2022-01-05T00:00:00.000Z', gender: 'male', assessmentCount: 2 };
const LIA = { childId: 'cB', name: 'Lia Soto', dateOfBirth: '2023-04-20T00:00:00.000Z', gender: 'female', assessmentCount: 1 };

(async () => {
  const { sandbox, elements } = loadSandbox();

  // 1. Only the selected child's completed assessments appear.
  const history = [
    assessment('K2', 'cA', '2026-06-10T02:00:00Z', [65, 70, 60, 72], { recommendations: 'Read aloud <daily>' }),
    assessment('K1', 'cA', '2026-03-02T02:00:00Z', [50, 60, 55, 62]),
    assessment('L1', 'cB', '2026-05-01T02:00:00Z', [20, 20, 20, 20]),
    { ...assessment('K3', 'cA', '2026-09-01T02:00:00Z', [90, 90, 90, 90]), status: 'in_progress' },
  ];
  const list = sandbox.caseFileAssessments(history, 'cA');
  assert.deepStrictEqual(Array.from(list, (a) => a.id), ['K1', 'K2'], 'oldest first, sibling and draft dropped');
  ok('case file keeps only the selected child, completed assessments, oldest first');

  const html = sandbox.renderCaseFile({
    patient: KEMRI,
    parent: { name: 'Emmanuel <i>Soto</i>', email: 'parent@example.test' },
    history,
    checkups: { checkups: [{ checkupDate: '2026-06-12T00:00:00Z', visitType: 'initial_checkup', status: 'monitoring', findings: 'Needs <script>x</script>' }], referrals: [], referralsError: null, error: null },
  });
  assert(!html.includes('L1') && !html.includes('20%'), 'no sibling scores in the case file');
  assert(!html.includes('90%'), 'no in-progress assessment in the case file');
  assert(html.includes('Mar 2, 2026') && html.includes('Jun 10, 2026'));
  ok('rendered case file contains no sibling or in-progress records');

  // 2. Escaping of names and clinician text.
  assert(html.includes('Kemri &lt;b&gt;Soto&lt;/b&gt;') && !html.includes('<b>Soto</b>'));
  assert(html.includes('Emmanuel &lt;i&gt;Soto&lt;/i&gt;'));
  assert(html.includes('Read aloud &lt;daily&gt;'));
  assert(html.includes('Needs &lt;script&gt;') && !html.includes('<script>'));
  ok('child, parent and clinician text is escaped');

  // 3. Progress comparison: first vs latest, in points.
  const cmp = sandbox.caseFileComparison(list);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cmp.rows.map((r) => [r.label, r.diff]))), [
    ['Communication', 15], ['Social Skills', 10], ['Cognitive', 5], ['Motor Skills', 10], ['Overall', 10],
  ]);
  assert(html.includes('the overall score increased 10 pts'));
  assert.strictEqual(sandbox.caseFileComparison(list.slice(0, 1)), null);
  const single = sandbox.renderCaseFile({ patient: LIA, parent: null, history, checkups: { checkups: [], referrals: [], referralsError: null, error: null } });
  assert(single.includes('Not enough assessments to compare yet'));
  assert(single.includes('No check-up visits have been recorded'));
  assert(!single.includes('K1') && !single.includes('Kemri'));
  ok('comparison is first vs latest in points; one assessment says not enough to compare');

  // 4. A failed check-up request is not shown as "none".
  const failed = sandbox.renderCaseFile({ patient: LIA, parent: null, history, checkups: { checkups: [], referrals: [], error: new Error('x') } });
  assert(failed.includes('could not be loaded') && !failed.includes('No check-up visits have been recorded'));
  ok('check-up load failure is stated, not shown as empty');

  // 5. Search narrows by name, case-insensitively, all words.
  const patients = [KEMRI, LIA, { childId: 'cC', name: 'Ana Cruz' }];
  assert.deepStrictEqual(Array.from(sandbox.filterCaseFilePatients(patients, 'soto'), (p) => p.childId), ['cA', 'cB']);
  assert.deepStrictEqual(Array.from(sandbox.filterCaseFilePatients(patients, 'LIA so'), (p) => p.childId), ['cB']);
  assert.strictEqual(sandbox.filterCaseFilePatients(patients, '').length, 3);
  ok('patient search filters by name, case-insensitively');

  // 6. Switching patients quickly: the earlier child's late response is dropped.
  let releaseKemri;
  const kemriHistory = new Promise((resolve) => { releaseKemri = resolve; });
  sandbox.apiFetch = async (ep) => {
    if (ep === '/pedia-reports/patients') return { patients: [KEMRI, LIA] };
    if (ep === '/assessments/pedia-patients') return { patients: [{ childId: 'cA', parentFirstName: 'E', parentLastName: 'Soto', parentEmail: 'e@example.test' }] };
    if (ep === '/assessments/cA/history') return kemriHistory;
    if (ep === '/assessments/cB/history') return { assessments: history };
    if (ep.startsWith('/checkups/child/')) return { checkups: [], referrals: [] };
    throw new Error(`unexpected ${ep}`);
  };
  await vm.runInContext('loadCaseFilePatients()', sandbox);
  const first = sandbox.openCaseFile('cA');
  await sandbox.openCaseFile('cB');
  const afterLia = elements.caseFileContent.innerHTML;
  assert(afterLia.includes('Lia Soto') && afterLia.includes('May 1, 2026'));
  releaseKemri({ assessments: history });
  await first;
  assert.strictEqual(elements.caseFileContent.innerHTML, afterLia, 'late Kemri response does not replace Lia');
  assert(!elements.caseFileContent.innerHTML.includes('Kemri'));
  assert.strictEqual(elements.printCaseFileBtn.hidden, false);
  ok('a late response for the previously selected child is ignored');

  // 7. Print only after a case file is open.
  let printed = 0;
  sandbox.window.print = () => { printed += 1; };
  sandbox.print = sandbox.window.print;
  vm.runInContext('printCaseFile()', sandbox);
  assert.strictEqual(printed, 1);
  ok('Print Case File prints the open case file');

  results.forEach((r) => console.log('ok -', r));
  console.log(`\npedia-case-files: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
