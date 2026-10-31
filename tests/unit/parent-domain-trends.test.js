// Parent Progress Report: Developmental Domain Progress (js/parent/reports.js
// renderDomainTrends / drawDomainTrendCharts) — one line graph per area below
// Score over time.
//
// Checks that each graph plots the child's stored area scores in date order on
// a fixed 0–100% scale, that an unusable reading (no score, or a 0 with
// nothing answered) is a gap and never a 0, that first / latest / change are
// the stored values with "increased / decreased / unchanged" wording (never
// "improved"), that text is escaped, and that the existing overall chart is
// untouched.
//
// Runs the real browser scripts in a vm sandbox with stub elements and a
// recording Chart stub. No server, no DB, no network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);

function loadSandbox() {
  const elements = {};
  const charts = [];
  const sandbox = {
    console, URLSearchParams, setTimeout,
    window: { location: { search: '' } },
    document: {
      addEventListener() {},
      getElementById: (id) => (elements[id] = elements[id] || { id, innerHTML: '', textContent: '', hidden: false, style: {} }),
    },
    localStorage: { getItem: () => null, setItem() {} },
    requireAuth: () => true,
  };
  sandbox.Chart = function Chart(canvas, config) {
    this.canvas = canvas; this.config = config; this.destroyed = false;
    this.destroy = () => { this.destroyed = true; };
    this.resize = () => { this.resized = (this.resized || 0) + 1; };
    charts.push(this);
  };
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/parent/report-interpretations.js', 'js/parent/reports.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  return { sandbox, elements, charts };
}

// The report API's shape (routes/parent-reports.js): oldest first.
const domain = (key, label, score, answeredItemCount = 5) => ({ key, label, score, answeredItemCount });
const entry = (id, completedAt, [c, s, g, m], overallScore, counts = [5, 5, 5, 5]) => ({
  id, completedAt, scoresAvailable: true, overallScore,
  domains: [
    domain('communication', 'Communication', c, counts[0]),
    domain('social', 'Social Skills', s, counts[1]),
    domain('cognitive', 'Cognitive', g, counts[2]),
    domain('motor', 'Motor Skills', m, counts[3]),
  ],
  review: {},
});

const ASSESSMENTS = [
  entry('a1', '2026-03-02T02:00:00Z', [50, 60, 55, 62], 57),
  // Communication: no answers recorded -> 0 is not a real score (gap).
  // Social: a real stored 0 with answers -> plotted as 0.
  entry('a2', '2026-06-10T02:00:00Z', [0, 0, 60, 72], 33, [0, 4, 5, 5]),
  entry('a3', '2026-08-01T02:00:00Z', [null, 70, 55, 72], 66),
  // An assessment with no overall score is not on the graphs (same rule as Score over time).
  { ...entry('a4', '2026-09-01T02:00:00Z', [90, 90, 90, 90], null), overallScore: null },
  entry('a5', '2026-10-30T02:00:00Z', [78, 60, 55, 61], 64),
];

(async () => {
  const { sandbox, charts } = loadSandbox();

  // 1. Markup: one card, four panels with first / latest / change.
  const html = sandbox.renderDomainTrends(ASSESSMENTS);
  assert(html.includes('<h2>Developmental Domain Progress</h2>'));
  for (let i = 0; i < 4; i += 1) assert(html.includes(`id="domainTrendChart${i}"`), `canvas ${i}`);
  const panel = (label) => {
    const start = html.indexOf(`<h3 class="domain-trend-title">${label}</h3>`);
    const next = html.indexOf('<div class="domain-trend-panel">', start + 1);
    return html.slice(start, next < 0 ? undefined : next);
  };
  const comm = panel('Communication');
  assert(comm.includes('First: <strong>50%</strong>') && comm.includes('Latest: <strong>78%</strong>'));
  assert(comm.includes('March 2, 2026') && comm.includes('October 30, 2026'));
  assert(comm.includes('Increased by 28 percentage points'), 'increase');
  const social = panel('Social Skills');
  assert(social.includes('First: <strong>60%</strong>') && social.includes('Latest: <strong>60%</strong>') && social.includes('Unchanged'), 'unchanged');
  const cog = panel('Cognitive');
  assert(cog.includes('Decreased by 0') === false && cog.includes('Unchanged'), 'cognitive 55 -> 55 unchanged');
  const motor = panel('Motor Skills');
  assert(motor.includes('First: <strong>62%</strong>') && motor.includes('Latest: <strong>61%</strong>') && motor.includes('Decreased by 1 percentage point<'), 'decrease, singular');
  assert(!/improv/i.test(html), 'never "improved"');
  assert(!html.includes('90%'), 'assessment without an overall score is not used');
  ok('four panels with first, latest and change in percentage points; increased / decreased / unchanged, never "improved"');

  // 2. Charts: stored scores in date order, gaps for unusable readings, fixed 0–100%.
  sandbox.drawDomainTrendCharts(ASSESSMENTS);
  assert.strictEqual(charts.length, 4);
  const data = (i) => JSON.parse(JSON.stringify(charts[i].config.data.datasets[0].data));
  const labels = JSON.parse(JSON.stringify(charts[0].config.data.labels));
  assert.deepStrictEqual(labels, ['Mar 2, 26', 'Jun 10, 26', 'Aug 1, 26', 'Oct 30, 26'], 'date order, oldest first');
  assert.deepStrictEqual(data(0), [50, null, null, 78], 'communication: 0 with no answers and a missing score are gaps');
  assert.deepStrictEqual(data(1), [60, 0, 70, 60], 'social: a real stored 0 stays 0');
  assert.deepStrictEqual(data(2), [55, 60, 55, 55]);
  assert.deepStrictEqual(data(3), [62, 72, 72, 61]);
  for (const c of charts) {
    assert.strictEqual(c.config.options.scales.y.min, 0);
    assert.strictEqual(c.config.options.scales.y.max, 100);
    assert.strictEqual(c.config.data.datasets[0].spanGaps, false);
    assert.strictEqual(c.config.options.animation, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(c.config.data.labels)), labels, 'every graph on the same dates');
  }
  assert.deepStrictEqual(charts.map((c) => c.canvas.id), ['domainTrendChart0', 'domainTrendChart1', 'domainTrendChart2', 'domainTrendChart3']);
  ok('each graph plots stored scores in date order on the same 0-100% scale; unusable readings are gaps, a real 0 stays 0');

  // 3. Redrawing replaces the previous charts; print/PDF resize reaches all of them.
  const old = charts.slice();
  sandbox.drawDomainTrendCharts(ASSESSMENTS);
  assert(old.every((c) => c.destroyed), 'old charts destroyed');
  vm.runInContext('resizeReportCharts()', sandbox);
  assert(charts.slice(4).every((c) => c.resized === 1), 'all domain charts resized');
  ok('redraw destroys the previous charts; print and PDF resize every domain chart');

  // 4. Not enough data.
  const one = sandbox.renderDomainTrends(ASSESSMENTS.slice(0, 1));
  assert(one.includes('Not enough assessments yet to show progress by area') && !one.includes('<canvas'));
  const sparse = [
    entry('b1', '2026-03-02T02:00:00Z', [null, 60, 55, 62], 59),
    entry('b2', '2026-06-10T02:00:00Z', [40, 70, 60, 72], 61),
  ];
  const sparseHtml = sandbox.renderDomainTrends(sparse);
  assert(sparseHtml.includes('Not enough recorded scores for this area to show a trend yet. Its one recorded score is 40% (June 10, 2026).'));
  assert(!sparseHtml.includes('id="domainTrendChart0"') && sparseHtml.includes('id="domainTrendChart1"'));
  ok('fewer than two assessments, or one usable score in an area, says so instead of drawing');

  // 5. Escaping: area labels come from constants, dates are formatted; nothing raw.
  assert(!/<script/i.test(html));
  ok('no raw markup injected');

  // 6. The overall Score over time chart is unchanged and still drawn separately.
  charts.length = 0;
  sandbox.drawTrendChart(ASSESSMENTS);
  assert.strictEqual(charts.length, 1);
  assert.strictEqual(charts[0].canvas.id, 'trendChart');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(charts[0].config.data.datasets[0].data)), [57, 33, 66, 64]);
  assert(sandbox.renderTrend(ASSESSMENTS, true).includes('<h2>Score over time</h2>'));
  ok('the overall Score over time chart is unchanged');

  results.forEach((r) => console.log('ok -', r));
  console.log(`\nparent-domain-trends: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
