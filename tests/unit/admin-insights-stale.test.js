// Admin Insights: a slow older response never draws over newer results
// (ADMIN bug scan P10).
//
// Changing a filter twice quickly started two loads; whichever finished last
// was drawn, so the page could show the first filter's numbers under the
// second filter's controls. Each load now carries a generation and a stale
// response is dropped.
//
// The loading block of js/admin/admin-insights.js runs in a vm sandbox with
// stubbed render functions and a controllable apiFetch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'admin', 'admin-insights.js'), 'utf8');
const start = js.indexOf('// Bumped by every loadAll()');
const end = js.indexOf('// Back/forward through filter states');
assert(start > 0 && end > start, 'loading block found');

const pending = [];
const drawn = [];
const meta = { textContent: '', innerHTML: '' };
const sandbox = {
  console: { error() {} },
  document: { getElementById: (id) => (id === 'insightMeta' ? meta : { innerHTML: '' }) },
  filterQuery: () => sandbox.currentQuery,
  currentQuery: '?a',
  apiFetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
  renderUsers: (d) => drawn.push(['users', d.tag]),
  renderChildren: (d) => drawn.push(['children', d.tag]),
  renderScreenings: (d) => drawn.push(['screenings', d.tag]),
  renderConcordance: (d) => drawn.push(['concordance', d.tag]),
  annotateGuardianReconciliation: () => drawn.push(['annotate']),
  errorCard: () => '',
  buildFilterControls() {},
  currentFilters: () => ({}),
  fmtShortDate: () => '',
  genderLabel: (x) => x,
  ageBandLabel: (x) => x,
  escapeHtml: (x) => String(x),
};
vm.createContext(sandbox);
vm.runInContext(`${js.slice(start, end)}\nthis.loadAll = loadAll;`, sandbox);

(async () => {
  const first = sandbox.loadAll();              // filter A
  sandbox.currentQuery = '?b';
  const second = sandbox.loadAll();             // filter B, before A answered
  const reply = (q, tag) => pending.filter((p) => p.url.endsWith(q)).forEach((p) => p.resolve({ tag, filters: { from: null, to: null } }));
  reply('?b', 'B');
  await second;
  reply('?a', 'A');                             // the older request answers last
  await first;
  assert(drawn.length > 0);
  assert(drawn.filter((d) => d[0] !== 'annotate').every((d) => d[1] === 'B'), `only filter B was drawn: ${JSON.stringify(drawn)}`);
  assert.strictEqual(drawn.filter((d) => d[0] === 'annotate').length, 1, 'the summary line is written once, for B');
  console.log('Admin insights stale-response guard OK — an older response arriving last is dropped');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
