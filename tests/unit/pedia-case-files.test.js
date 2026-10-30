// Patient Case Files (js/pedia/pedia-case-files.js) on the pediatrician
// Reports page: a case file shows only the selected child's records, a late
// response for a previously selected child is dropped, its Developmental
// progress is Section B's own rendering of that child's stored records, and
// every name and clinician note is escaped.
//
// Runs the real browser scripts (constants/scoring.js,
// js/pedia/pedia-reports-interpretations.js and js/pedia/pedia-reports.js for
// the shared helpers and Section B, then pedia-case-files.js) in a vm sandbox
// with stub DOM elements. No server, no DB, no network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

function element() {
  return { innerHTML: '', textContent: '', hidden: false, value: '', style: {}, dataset: {}, setAttribute() {}, removeAttribute() {}, addEventListener() {} };
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
  for (const file of ['constants/scoring.js', 'js/pedia/pedia-reports-interpretations.js', 'js/pedia/pedia-reports.js', 'js/pedia/pedia-case-files.js']) {
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

// Activity records (/pedia-reports/activity), as Section B receives them.
const band = (v) => (v == null ? null : v >= 80 ? 'on_track' : v >= 60 ? 'developing' : v >= 40 ? 'at_risk' : 'delayed');
const record = (assessmentId, childId, assessedAt, scores, name = 'Kemri <b>Soto</b>') => {
  const overallScore = Math.round(scores.reduce((a, b) => a + b, 0) / 4);
  const [communication, social, cognitive, motor] = scores;
  const d = (score) => ({ score, band: band(score) });
  return {
    assessmentId, childId, name, assessedAt, status: 'complete',
    domains: { communication: d(communication), social: d(social), cognitive: d(cognitive), motor: d(motor) },
    overallScore, overallBand: band(overallScore),
  };
};
// Newest first, as the API sends them, with a sibling's record among them.
const RECORDS = [
  record('K2', 'cA', '2026-06-10T02:00:00Z', [65, 70, 60, 72]),
  record('L1', 'cB', '2026-05-01T02:00:00Z', [20, 20, 20, 20], 'Lia Soto'),
  record('K1', 'cA', '2026-03-02T02:00:00Z', [50, 60, 55, 62]),
];

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
  assert.deepStrictEqual(Array.from(sandbox.caseFileDevHistory(RECORDS, 'cA'), (r) => r.assessmentId), ['K1', 'K2'],
    'Section B records: oldest first, sibling dropped');
  ok('case file keeps only the selected child, completed assessments, oldest first');

  const html = sandbox.renderCaseFile({
    patient: KEMRI,
    parent: { name: 'Emmanuel <i>Soto</i>', email: 'parent@example.test' },
    history,
    checkups: { checkups: [{ checkupDate: '2026-06-12T00:00:00Z', visitType: 'initial_checkup', status: 'monitoring', findings: 'Needs <script>x</script>' }], referrals: [], referralsError: null, error: null },
    devProgress: { records: RECORDS, error: null },
  });
  assert(!html.includes('L1') && !html.includes('20 / 100'), 'no sibling scores in the case file');
  assert(!html.includes('90 / 100') && !html.includes('90%'), 'no in-progress assessment in the case file');
  assert(html.includes('Mar 2, 2026') && html.includes('Jun 10, 2026'));
  ok('rendered case file contains no sibling or in-progress records');

  // 2. Escaping of names and clinician text.
  assert(html.includes('Kemri &lt;b&gt;Soto&lt;/b&gt;') && !html.includes('<b>Soto</b>'));
  assert(html.includes('Emmanuel &lt;i&gt;Soto&lt;/i&gt;'));
  assert(html.includes('Read aloud &lt;daily&gt;'));
  assert(html.includes('Needs &lt;script&gt;') && !html.includes('<script>'));
  ok('child, parent and clinician text is escaped');

  // 3. Developmental progress is Section B's rendering of this child's records.
  const progress = html.slice(html.indexOf('<h3>Developmental progress</h3>'), html.indexOf('Pediatrician reviews'));
  assert(progress.length > 0, 'Developmental progress section present');
  for (const part of ['Latest recorded change', 'Interpretation', 'Developmental domains', 'Overall assessment score', 'All recorded assessments']) {
    assert(progress.includes(part), `includes ${part}`);
  }
  assert(progress.includes('65 / 100') && progress.includes('50 / 100') && progress.includes('67%'), 'stored scores as recorded');
  assert(progress.includes('<th scope="col">Age</th>') && progress.includes('4 y 1 mo') && progress.includes('4 y 5 mo'), 'age at each assessment');
  assert(/Communication<\/th>[\s\S]*?65 \/ 100[\s\S]*?50 \/ 100[\s\S]*?\+15 pts/.test(progress), 'latest vs previous: Communication 50 -> 65');
  for (const id of ['cfDevDomainChart0', 'cfDevDomainChart1', 'cfDevDomainChart2', 'cfDevDomainChart3', 'cfDevOverallChart']) {
    assert(progress.includes(`id="${id}"`), `canvas ${id}`);
  }
  assert(!/id="dev(Domain|Overall)Chart/.test(html), "never Section B's own canvas ids");
  assert(!html.includes('Developmental progress comparison') && !html.includes('<h3>Assessment history</h3>'), 'the duplicated sections are gone');

  const single = sandbox.renderCaseFile({ patient: LIA, parent: null, history, checkups: { checkups: [], referrals: [], referralsError: null, error: null },
    visits: { visits: [], error: null }, devProgress: { records: RECORDS, error: null } });
  assert(single.includes('Not enough assessments for a trend') && !single.includes('<canvas'), 'one assessment: no chart');
  assert(single.includes('20 / 100'));
  assert(single.includes('No clinic visits or check-ups are on record'));
  assert(!single.includes('K1') && !single.includes('Kemri') && !single.includes('65 / 100'));

  const progressFailed = sandbox.renderCaseFile({ patient: LIA, parent: null, history, checkups: { checkups: [], referrals: [], referralsError: null, error: null },
    visits: { visits: [], error: null }, devProgress: { records: [], error: new Error('x') } });
  assert(progressFailed.includes('Developmental progress could not be loaded') && !progressFailed.includes('No completed assessments are on record'));
  ok("developmental progress is Section B for this child only, with age; one assessment draws no chart; a failed load is stated");

  // 4. A failed check-up request is not shown as "none".
  const failed = sandbox.renderCaseFile({ patient: LIA, parent: null, history, checkups: { checkups: [], referrals: [], error: new Error('x') }, visits: { visits: [], error: null } });
  assert(failed.includes('Check-up history could not be loaded') && !failed.includes('No clinic visits or check-ups are on record'));
  ok('check-up load failure is stated, not shown as empty');

  // 4b. Clinic visits: only this child's approved/completed appointments,
  // newest first, each paired with the check-ups recorded for it.
  const appointments = [
    { id: 11, childId: 'cA', status: 'completed', appointmentDate: '2026-03-02T00:00:00.000Z', appointmentTime: '09:00', reason: 'Initial visit' },
    { id: 12, childId: 'cA', status: 'completed', appointmentDate: '2026-06-12T00:00:00.000Z', appointmentTime: '14:30', reason: 'Check-up' },
    { id: 13, childId: 'cA', status: 'approved', appointmentDate: '2026-11-20T00:00:00.000Z', appointmentTime: '10:00', reason: 'Follow-up Check-up' },
    { id: 14, childId: 'cA', status: 'cancelled', appointmentDate: '2026-05-01T00:00:00.000Z', appointmentTime: '10:00' },
    { id: 15, childId: 'cA', status: 'pending', appointmentDate: '2026-12-01T00:00:00.000Z', appointmentTime: '10:00' },
    { id: 21, childId: 'cB', status: 'completed', appointmentDate: '2026-06-12T00:00:00.000Z', appointmentTime: '15:00', reason: 'SIBLING VISIT' },
  ];
  const visits = sandbox.caseFileVisits(appointments, 'cA', '2026-12-31');
  assert.deepStrictEqual(Array.from(visits, (v) => v.id), [13, 12, 11], 'approved/completed only, this child only, newest first');
  assert.deepStrictEqual(Array.from(sandbox.caseFileVisits(appointments, 'cA', '2026-10-31'), (v) => v.id), [12, 11],
    'a visit booked for a later day is not listed yet');

  const checkupsForA = [
    { id: 'x1', appointmentId: 12, checkupDate: '2026-06-12T04:00:00Z', visitType: 'initial_checkup', status: 'monitoring', findings: 'Speech <delay> noted' },
    { id: 'x2', appointmentId: null, checkupDate: '2026-04-01T04:00:00Z', visitType: 'follow_up_checkup', status: 'stable', findings: 'UNLINKED RECORD' },
    { id: 'x3', appointmentId: 14, checkupDate: '2026-05-01T04:00:00Z', visitType: 'follow_up_checkup', status: 'stable', findings: 'LINKED TO CANCELLED' },
  ];
  const paired = sandbox.pairVisitsWithCheckups(visits, checkupsForA);
  assert.deepStrictEqual(Array.from(paired.visits, (v) => [v.visit.id, v.checkups.length]), [[13, 0], [12, 1], [11, 0]].map((x) => x));
  assert.deepStrictEqual(Array.from(paired.unlinked, (c) => c.id), ['x2', 'x3'], 'records not tied to a listed visit are kept, not dropped');

  const withVisits = sandbox.renderCaseFile({
    patient: KEMRI, parent: null, history,
    checkups: { checkups: checkupsForA, referrals: [], referralsError: null, error: null },
    visits: { visits, error: null },
  });
  assert(withVisits.includes('3 clinic visits: 1 with a check-up recorded, 2 without.'));
  const v12 = withVisits.indexOf('Appointment #12');
  const v11 = withVisits.indexOf('Appointment #11');
  assert(v12 > 0 && v11 > v12, 'newest visit first');
  const block12 = withVisits.slice(v12, v11);
  assert(block12.includes('Speech &lt;delay&gt; noted') && !block12.includes('No check-up recorded for this visit'), 'visit #12 shows its own check-up');
  assert(withVisits.slice(v11).includes('No check-up recorded for this visit'), 'visit #11 is flagged as missing a record');
  assert(withVisits.includes('June 12, 2026, 2:30 PM') && withVisits.includes('Appointment #13'));
  assert(withVisits.includes('Check-ups not linked to a visit') && withVisits.includes('UNLINKED RECORD') && withVisits.includes('LINKED TO CANCELLED'));
  assert(!withVisits.includes('SIBLING VISIT') && !withVisits.includes('#21') && !withVisits.includes('#14') && !withVisits.includes('#15'));
  ok('clinic visits pair each visit with its check-ups, flag visits without one, and keep unlinked records');

  // 4c. Visit list failed to load: check-ups still listed, not shown as unlinked.
  const visitsFailed = sandbox.renderCaseFile({
    patient: KEMRI, parent: null, history,
    checkups: { checkups: checkupsForA, referrals: [], referralsError: null, error: null },
    visits: { visits: [], error: new Error('down') },
  });
  assert(visitsFailed.includes('Clinic visits could not be loaded right now') && visitsFailed.includes('UNLINKED RECORD'));
  assert(!visitsFailed.includes('Check-ups not linked to a visit') && !visitsFailed.includes('No check-up recorded for this visit'));
  ok('a failed visit list keeps the check-ups and does not mislabel them');

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
    if (ep === '/appointments/pedia') return { appointments: [] };
    // Section B's records are requested for the selected child only.
    if (ep === '/pedia-reports/activity?childId=cA') return { records: RECORDS.filter((r) => r.childId === 'cA') };
    if (ep === '/pedia-reports/activity?childId=cB') return { records: RECORDS.filter((r) => r.childId === 'cB') };
    throw new Error(`unexpected ${ep}`);
  };
  await vm.runInContext('loadCaseFilePatients()', sandbox);
  const first = sandbox.openCaseFile('cA');
  await sandbox.openCaseFile('cB');
  const afterLia = elements.caseFileContent.innerHTML;
  assert(afterLia.includes('Lia Soto') && afterLia.includes('May 1, 2026'));
  assert(afterLia.includes('20 / 100') && afterLia.includes('All recorded assessments'), "Lia's developmental progress is shown");
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

  // 8. Download PDF file names: from the patient's name, unsafe characters removed.
  const day = new Date(2026, 9, 31);
  assert.strictEqual(sandbox.caseFilePdfName('Kemri <b>Soto</b>', day), 'KinderCura-Case-File-Kemri-b-Soto-b-2026-10-31.pdf');
  assert.strictEqual(sandbox.caseFilePdfName('Ñiño  O\'Neil/../x', day), 'KinderCura-Case-File-i-o-O-Neil-x-2026-10-31.pdf');
  assert.strictEqual(sandbox.caseFilePdfName('', day), 'KinderCura-Case-File-Patient-2026-10-31.pdf');
  assert.strictEqual(sandbox.practiceReportPdfName(day), 'KinderCura-Practice-Report-2026-10-31.pdf');
  ok('PDF file names come from the patient name with unsafe characters removed');

  // 9. Download PDF / Print do nothing while no case file is fully shown.
  {
    const fresh = loadSandbox();
    let captured = 0;
    fresh.sandbox.downloadElementPdf = () => { captured += 1; };
    let freshPrinted = 0;
    fresh.sandbox.window.print = () => { freshPrinted += 1; };
    fresh.sandbox.print = fresh.sandbox.window.print;
    vm.runInContext('downloadCaseFilePdf(); printCaseFile();', fresh.sandbox);
    assert.strictEqual(captured, 0);
    assert.strictEqual(freshPrinted, 0);
  }
  ok('Download PDF and Print do nothing before a case file is open');

  // 10. The practice print/PDF heading copies the on-screen scope and filters.
  const el = sandbox.document.getElementById;
  el('reportMeta').textContent = '6 patients • 18 assessments • all time';
  el('activeFilterNote').textContent = 'Showing 2 of 6 patients: latest classification At-Risk.';
  el('activeFilterNote').style.display = 'block';
  sandbox.fillPracticePrintHeading(day);
  assert(elements.practicePrintMeta.textContent.startsWith('6 patients • 18 assessments • all time · Generated October 31, 2026'));
  assert(elements.practicePrintMeta.textContent.endsWith('Prepared by Dr. Gold Deluna'));
  assert.strictEqual(elements.practicePrintFilters.textContent, 'Showing 2 of 6 patients: latest classification At-Risk.');
  el('activeFilterNote').style.display = 'none';
  sandbox.fillPracticePrintHeading(day);
  assert.strictEqual(elements.practicePrintFilters.textContent, '', 'a hidden filter note is not printed');
  ok('practice print heading copies the scope line and the active filter note');

  // 11. Section B on Practice Reports is unchanged by the reuse: same card,
  // dropdown and canvas ids; the case file draws its own cfDev* charts.
  {
    const fresh = loadSandbox();
    const drawn = [];
    fresh.sandbox.Chart = function Chart(canvas) { drawn.push(canvas.id); this.destroy = () => {}; };
    fresh.sandbox.Chart.defaults = { font: { family: 'x' } };
    const getEl = fresh.sandbox.document.getElementById;
    fresh.sandbox.document.getElementById = (id) => { const el = getEl(id); el.id = id; return el; };
    vm.runInContext('renderDevProgress', fresh.sandbox)({ records: RECORDS }, { patients: [] });
    const section = fresh.elements.devProgressSection.innerHTML;
    assert(section.includes('<h2>Assessment history</h2>') && section.includes('id="devProgressPatient"'));
    assert(section.includes('Only your own patients are listed.') && !section.includes('<th scope="col">Age</th>'));
    assert.deepStrictEqual(drawn, ['devDomainChart0', 'devDomainChart1', 'devDomainChart2', 'devDomainChart3', 'devOverallChart']);
    drawn.length = 0;
    vm.runInContext(`caseFileChartHistory = caseFileDevHistory(${JSON.stringify(RECORDS)}, 'cA'); drawCaseFileCharts();`, fresh.sandbox);
    assert.deepStrictEqual(drawn, ['cfDevDomainChart0', 'cfDevDomainChart1', 'cfDevDomainChart2', 'cfDevDomainChart3', 'cfDevOverallChart']);
  }
  ok('Section B still draws into its own canvases; the case file draws cfDev* charts');

  results.forEach((r) => console.log('ok -', r));
  console.log(`\npedia-case-files: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
