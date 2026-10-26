// Reports and review-screen details (PEDIATRICIAN_BUGS.md #27).
//
//   - /pedia-reports read a date-only ?from= / ?to= as UTC and bucketed months
//     in UTC, while the clinic (Asia/Manila, UTC+8) and the page work in local
//     days, so a filter for "8 August" ran from 08:00 to 07:59 the next morning.
//   - loadReports() had no stale-response guard for the overview, progression
//     and patients requests, so a slow earlier answer could overwrite a later one.
//   - A "Recorded - not scored" answer (insightLevel 'neutral') was drawn as a
//     green positive card with a red concern dot.
//   - The suggested next-assessment date used its own 40 / `<= 60` cutoffs, so a
//     score of exactly 60 ("Developing" in constants/scoring.js) got the at-risk
//     interval.
//
// No DB, no browser: the route's range helpers are called directly, and the real
// page scripts run in node vms with a fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const { parseRange, assessmentsByMonth } = require('../../routes/pedia-reports')._internals;

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

// ── Clinic-day ranges and months ──────────────────────────────────────────
let range = parseRange({ from: '2030-01-08', to: '2030-01-08' });
assert.strictEqual(range.from.toISOString(), '2030-01-07T16:00:00.000Z', 'from: the clinic day begins at 00:00 Manila time');
assert.strictEqual(range.to.toISOString(), '2030-01-08T15:59:59.999Z', 'to: the clinic day ends at 23:59:59.999 Manila time');
range = parseRange({ from: '2030-01-08', to: '2030-02-28' });
assert.strictEqual(range.to.toISOString(), '2030-02-28T15:59:59.999Z');
range = parseRange({ to: '2030-12-31' });
assert.strictEqual(range.to.toISOString(), '2030-12-31T15:59:59.999Z', 'a year-end day rolls over correctly');
assert.strictEqual(range.from, null, 'an absent bound stays open');
range = parseRange({ from: '2030-01-08T05:30:00.000Z', to: '2030-01-09T05:30:00.000Z' });
assert.strictEqual(range.from.toISOString(), '2030-01-08T05:30:00.000Z', 'a full timestamp is honoured exactly as given');
assert.strictEqual(range.to.toISOString(), '2030-01-09T05:30:00.000Z');
assert(parseRange({ from: 'nonsense' }).error, 'an invalid date is still refused');
assert(parseRange({ from: '2030-02-01', to: '2030-01-01' }).error, 'from after to is still refused');
const noFilter = parseRange({});
assert.deepStrictEqual([noFilter.from, noFilter.to], [null, null], 'no filter means all time');

assert.deepStrictEqual(
  assessmentsByMonth([
    { generatedAt: '2030-01-31T15:59:00.000Z' },   // 23:59 on 31 Jan in Manila
    { generatedAt: '2030-01-31T16:01:00.000Z' },   // 00:01 on 1 Feb in Manila
    { generatedAt: '2030-02-10T00:00:00.000Z' },
  ]),
  [{ month: '2030-01', count: 1 }, { month: '2030-02', count: 2 }],
  'months follow the clinic calendar, not UTC'
);
ok("a date-only report filter covers the clinic's whole day, full timestamps are untouched, and months follow the clinic calendar");

// ── A fake DOM shared by the page scripts ─────────────────────────────────
function makeSandbox(extra = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', textContent: '', innerHTML: '', src: '', href: '', disabled: false, checked: false, style: {}, dataset: {}, options: [],
        addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        closest: () => null, querySelector: () => null, querySelectorAll: () => [], getContext: () => null, appendChild() {}, setAttribute() {},
      });
    }
    return els.get(id);
  };
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise, Math, Date, Intl, encodeURIComponent, decodeURIComponent, AbortController,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, alert() {}, confirm: () => false,
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
      setItem() {}, removeItem() {}, clear() {},
    },
    document: { cookie: '', getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true }, createElement: () => el('__created') },
    fetch: () => new Promise(() => {}),
    Chart: function Chart() { this.destroy = () => {}; this.update = () => {}; },
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    loadNotificationCount: async () => {},
    ...extra,
  };
  sandbox.window = sandbox;
  sandbox.location = { hostname: 'kindercura.example', origin: 'http://kindercura.example', pathname: '/pedia/pedia-reports.html', href: '', search: '', replace() {} };
  vm.createContext(sandbox);
  return { sandbox, el };
}
const load = (sandbox, files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox));

(async () => {
  // ── loadReports(): only the newest call may change the page ─────────────
  {
    const pending = [];
    const { sandbox, el } = makeSandbox({
      fetch: (url) => {
        const u = new URL(url, 'http://kindercura.example');
        return new Promise((resolve) => {
          pending.push({ url: u, resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }) });
        });
      },
    });
    // The page loads /api.js first: it supplies apiFetch.
    load(sandbox, ['api.js', 'constants/scoring.js', 'js/shared/care-plan-labels.js', 'js/pedia/pedia-reports-interpretations.js', 'js/pedia/pedia-reports.js']);
    const bodyFor = (patients) => ({ cohort: { patients, screenings: patients }, range: { from: null, to: null }, patients: [] });
    const answer = (call, patients) => call.resolve(call.url.pathname.endsWith('/overview') ? bodyFor(patients) : { patients: [], children: [], records: [] });

    const swallow = (p) => p.catch(() => {});
    el('rangeFrom').value = '2030-01-01';
    const first = swallow(vm.runInContext('loadReports()', sandbox));
    const firstCalls = pending.splice(0);
    el('rangeFrom').value = '2030-02-01';
    const second = swallow(vm.runInContext('loadReports()', sandbox));
    const secondCalls = pending.splice(0);
    for (const calls of [firstCalls, secondCalls]) {
      for (const name of ['overview', 'progression', 'patients']) {
        assert(calls.some((c) => c.url.pathname.endsWith(`/${name}`)), `each load asked for ${name}`);
      }
    }

    // The newer request answers first, then the older one limps in.
    secondCalls.forEach((c) => answer(c, 2));
    await second;
    assert.match(el('reportMeta').textContent, /^2 patients/, 'the newer load updated the page');
    firstCalls.forEach((c) => answer(c, 5));
    await first;
    assert.match(el('reportMeta').textContent, /^2 patients/, 'a slow older answer does not overwrite it');
    ok('a slow earlier report answer no longer overwrites a later one');
  }

  // ── The review screen and the suggested date ────────────────────────────
  {
    const { sandbox } = makeSandbox();
    load(sandbox, ['constants/scoring.js', 'js/shared/care-plan-labels.js', 'js/pedia/pediatrician-patients.js']);
    const icon = (level) => vm.runInContext(`insightIcon(${JSON.stringify(level)})`, sandbox);
    assert(icon('neutral').includes('ra-dot-neutral'), 'a neutral insight has its own dot');
    assert(!icon('neutral').includes('ra-dot-concern'));
    assert(icon('concern').includes('ra-dot-concern') && icon('positive').includes('ra-dot-positive') && icon('warning').includes('ra-dot-warning'));

    const css = fs.readFileSync(path.join(ROOT, 'CSS files', 'pedia-review.css'), 'utf8');
    for (const selector of ['.ra-answer-neutral', '.ra-dot-neutral']) {
      const block = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
      assert(block, `${selector} is styled`);
      assert(!/#[0-9a-f]{3,8}\b/i.test(block[1]), `${selector} uses colour tokens, not raw hex`);
    }
    assert(/ra-answer-neutral/.test(fs.readFileSync(path.join(ROOT, 'js/pedia/pediatrician-patients.js'), 'utf8')), 'the card class is applied');
    ok('a "recorded, not scored" answer gets a neutral card and dot instead of the positive card and concern dot');

    const suggested = (score) => vm.runInContext(`getSuggestedNextAssessmentDate(${JSON.stringify(score)})`, sandbox);
    const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const plus = ({ days = 0, months = 0 }) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); d.setMonth(d.getMonth() + months); return local(d); };
    for (const [score, expected] of [[0, { days: 14 }], [39, { days: 14 }], [40, { months: 1 }], [59, { months: 1 }], [60, { months: 3 }], [79, { months: 3 }], [80, { months: 3 }], [100, { months: 3 }]]) {
      assert.strictEqual(suggested(score), plus(expected), `a score of ${score} -> ${JSON.stringify(expected)}`);
    }
    assert.strictEqual(suggested(''), '');
    assert.strictEqual(suggested(null), '');
    ok('the suggested next-assessment interval follows the shared score bands, so exactly 60 (Developing) gets 3 months');
  }

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npedia-report-ui.test.js: ${results.length} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
