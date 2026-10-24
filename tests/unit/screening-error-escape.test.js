// Regression test: the screening page shows error messages as text.
//
// The bug: js/parent/screening.js put e.message straight into innerHTML when
// loading or submitting a screening failed. An error message is server- or
// network-supplied text, so any markup in it would be rendered as live HTML.
//
// The page script runs in a vm with stubbed browser globals; apiFetch throws a
// message containing markup, and the rendered error is inspected.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'js/parent/screening.js'), 'utf8');
const HOSTILE = '<img src=x onerror="alert(1)">';
const ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
const ok = (m) => console.log('  ok -', m);

function makePage() {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', style: {} });
  const ctx = vm.createContext({
    requireAuth() {}, KC: { childId: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [] },
    window: { location: { href: '' } }, console: { log() {}, warn() {}, error() {} }, alert() {},
    apiFetch: async () => { throw new Error(HOSTILE); },
  });
  vm.runInContext(src, ctx, { filename: 'screening.js' });
  return { el, run: (code) => vm.runInContext(code, ctx) };
}

(async () => {
  // 1. Submit failure.
  {
    const p = makePage();
    p.run("selectedChild = { id: 'c1', dateOfBirth: '2021-01-01' }; assessmentId = 'a1';");
    await p.run('completeAssessment()');
    const html = p.el('assessmentContent').innerHTML;
    assert.ok(html.includes(`Submission failed: ${ESCAPED}`), 'submit error shown escaped');
    assert.ok(!html.includes('<img'), 'no live markup from the error');
    ok('a failed submit shows the error message as text');
  }

  // 2. Load failure.
  {
    const p = makePage();
    await p.run('initAssessment()');
    const html = p.el('assessmentContent').innerHTML;
    assert.ok(html.includes(`Failed to load the assessment: ${ESCAPED}`), 'load error shown escaped');
    assert.ok(!html.includes('<img'), 'no live markup from the error');
    ok('a failed load shows the error message as text');
  }

  // 3. No raw error message is interpolated anywhere in the page script.
  assert.ok(!/\$\{\s*(e|err|error)\.message\s*\}/.test(src), 'every ${e.message} is escaped');
  ok('screening.js never interpolates a raw error message');

  console.log('\nScreening error escape tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
