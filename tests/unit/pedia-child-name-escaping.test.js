// Pediatrician pages: a child's name (typed by the parent) is escaped before
// it reaches innerHTML.
//
// The bug: the patient filter on My Questions (js/pedia/pedia-questions.js,
// renderTrackerChildOptions) put the child's name into the <select> raw, so a
// parent who booked with a pediatrician and named the child
// `<img src=x onerror=...>` ran script in the pediatrician's session, where
// the sign-in token lives.
//
// No browser: the real function runs in a node vm with the real escapeHtml
// from /api.js and a fake <select>.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const results = [];
const ok = (m) => results.push(m);

const EVIL = '<img src=x onerror=alert(1)>';

const apiSrc = read('api.js');
const escapeSrc = apiSrc.slice(apiSrc.indexOf('function escapeHtml('), apiSrc.indexOf('function formatDateTime('));

// 1. The My Questions patient filter.
const questionsSrc = read('js/pedia/pedia-questions.js');
const start = questionsSrc.indexOf('function renderTrackerChildOptions(');
const end = questionsSrc.indexOf('// Load assigned questions per patient', start);
assert.ok(start > 0 && end > start, 'renderTrackerChildOptions found');

const select = { value: '', innerHTML: '', options: [] };
const sandbox = {
  document: { getElementById: () => select },
  patientList: [
    { childId: 'c1', childName: EVIL },
    { childId: 'c2', childName: 'Ana & Ben' },
  ],
};
vm.createContext(sandbox);
vm.runInContext(escapeSrc, sandbox);
vm.runInContext(questionsSrc.slice(start, end), sandbox);
sandbox.renderTrackerChildOptions();

assert.ok(!select.innerHTML.includes('<img'), 'no raw tag from a child name');
assert.ok(select.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the name is shown as text');
assert.ok(select.innerHTML.includes('>Ana &amp; Ben</option>'), 'ordinary names still show');
assert.ok(select.innerHTML.includes('<option value="all">All patients</option>'), 'the All option is kept');
ok('My Questions patient filter escapes child names');

// 2. Error text on My Questions and My Patients is escaped too.
const patientsSrc = read('js/pedia/pediatrician-patients.js');
for (const [file, src] of [['pedia-questions.js', questionsSrc], ['pediatrician-patients.js', patientsSrc]]) {
  assert.ok(!/innerHTML[^\n]*\$\{err\.message\}/.test(src), `${file}: no raw err.message in innerHTML`);
  assert.ok(!/^\s*<p[^\n]*>\$\{err\.message\}<\/p>/m.test(src), `${file}: no raw err.message in a template`);
}
ok('error messages are escaped on My Questions and My Patients');

results.forEach((m) => console.log(`  ok - ${m}`));
console.log(`Pediatrician child-name escaping tests OK — ${results.length} groups`);
