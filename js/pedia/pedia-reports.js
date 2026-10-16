// js/pedia/pedia-reports.js
// Pediatrician Reports — descriptive analytics over this pediatrician's own
// patients, served by /api/pedia-reports.
//
// This page RENDERS stored values. It does not score anything, and it does not
// write anything. Every number comes from the server, which reads
// AssessmentResult directly. Band keys, band labels, and band colours all come
// from window.KCScoring (constants/scoring.js, loaded by pedia-reports.html
// before this file) — the same source js/parent/reports.js and
// js/pedia/pediatrician-patients.js use, so no two pages can disagree about
// what a score of 62 is called or what colour it is drawn in.
//
// Wording rule for anything added here: these are SCREENING scores produced by
// fixed rules. Nothing on this page may call them predicted, intelligent,
// learned, or a diagnosis, and nothing may state a validation claim — see the
// comment above the /outcomes handler in routes/pedia-reports.js for why.
//
// Shared helpers (apiFetch, initNav, the notification modal, toggleProfileMenu)
// come from /api.js, matching PARENT/reports.html. Only escapeHtml is redefined
// locally, as js/parent/reports.js does, so the escaping this page relies on is
// visible in this file.

// ── Auth guard ──────────────────────────────────────────────────────────────
// Mirrors the guard on the other pediatrician pages: a token alone is not
// enough, the role has to match. Server-side every endpoint here answers 403 to
// any non-pediatrician regardless of what the browser does.
function doLogout() {
    ['kc_token', 'kc_user', 'kc_childId', 'kc_assessmentId'].forEach((k) => localStorage.removeItem(k));
    window.location.href = '/login.html';
}

(function guardRole() {
    let user = null;
    try { user = JSON.parse(localStorage.getItem('kc_user')); } catch { user = null; }
    if (!localStorage.getItem('kc_token') || !user) {
        window.location.href = '/login.html';
        return;
    }
    if ((user.role || '').trim().toLowerCase() !== 'pediatrician') {
        window.location.href = '/login.html';
    }
}());

// ── Local state ─────────────────────────────────────────────────────────────
let overviewData = null;
let progressionData = null;
let patientsData = null;
let activityData = null;

let bandDomainChart = null;
let overallBandChart = null;
let activityChart = null;
let devProgressChart = null;

// Activity chart interval: 'auto' picks day/week/month from the period length.
let activityInterval = 'auto';
// Records table shows the newest ACTIVITY_RECORDS_PAGE rows until expanded.
let activityShowAll = false;
// Patient shown in Patient Development Progress; kept across filter changes
// while that patient is still in the filtered set.
let devProgressChildId = null;

// Populated once from the patient roster so the patient filter can list names
// without a second endpoint. Rebuilt only when the filter is not itself
// narrowing to one patient, so selecting a patient cannot empty the dropdown
// that produced the selection.
let patientFilterOptions = [];

// Row indexes currently expanded in the progression table.
const expandedRows = new Set();

// Display order and labels for the four scoring domains. The keys match the
// server response; the labels match docs/SCORING.md. Presentation only — never
// a scoring input. Note there are FOUR scoring domains: the Gross Motor / Fine
// Motor / Language / Personal-Social split shown during screening is a display
// subdomain and is never scored separately.
const DOMAINS = [
    { key: 'communication', label: 'Communication' },
    { key: 'social',        label: 'Social Skills' },
    { key: 'cognitive',     label: 'Cognitive' },
    { key: 'motor',         label: 'Motor Skills' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

// Local escape helper so parent-entered child names and clinician-entered text
// are safe in this page's markup. Applied to every interpolated value below
// without exception.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Counts render as a number or as 0 — never as undefined or NaN. */
function count(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function plural(n, singular, pluralForm) {
    return count(n) === 1 ? singular : (pluralForm || `${singular}s`);
}

function fmtShortDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Score cell: a percentage, or an em dash when the stored score is absent. */
function scoreText(value) {
    if (value == null) return '—';
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)}%` : '—';
}

/** Band keys high → low, straight from the shared band set. */
function bandKeys() {
    return window.KCScoring.ACTIVE_BANDS.map((b) => b.key);
}

function bandChip(bandKey) {
    if (!bandKey) return '<span class="band-chip" style="background:#ddd9cc;">Not scored</span>';
    const color = window.KCScoring.colorForBand(bandKey);
    const label = window.KCScoring.clinicalLabel(bandKey);
    return `<span class="band-chip" style="background:${escapeHtml(color)};">${escapeHtml(label)}</span>`;
}

/**
 * The colour key every chart and chip on this page shares: band colour, label,
 * and the score range it covers — straight from KCScoring, so the legend can
 * never disagree with the bands the server applied.
 */
function scoreGuideHtml() {
    const S = window.KCScoring;
    return `
        <div class="score-guide-box">
            <p class="score-guide-box-title">Score guide &mdash; colours and classifications used in this report</p>
            <ul class="score-guide-list">
                ${S.ACTIVE_BANDS.map((b) => `
                    <li><span class="count-dot" style="background:${escapeHtml(S.colorForBand(b.key))};"></span><strong>${escapeHtml(S.clinicalLabel(b.key))}</strong> = score ${b.min}&ndash;${b.max}%</li>`).join('')}
            </ul>
            <p class="score-guide-box-note">
                A <strong>score</strong> is a stored assessment score: the share of possible points earned on the
                assessment questions (Yes = 2, Sometimes = 1, No = 0) for one domain, or the average of the four
                domain scores for the overall score. Classifications are KinderCura's existing scoring bands
                &mdash; not probabilities and not diagnoses.
            </p>
        </div>`;
}

// Wording chosen so the chip can be read without knowing what a "band" is.
// The full sentence behind each one comes from
// KCPediaReportsInterpretations.formatMovementDescription().
function movementChip(movement) {
    const m = movement === 'improved' || movement === 'declined' ? movement : 'unchanged';
    const label = m === 'improved' ? 'Less concern'
        : m === 'declined' ? 'More concern'
        : 'No change';
    return `<span class="move-chip move-${escapeHtml(m)}">${escapeHtml(label)}</span>`;
}

/** Signed point change between two stored scores. Absent values stay absent. */
function deltaHtml(value) {
    if (value == null) return '<span class="delta delta-flat">—</span>';
    const n = Number(value);
    if (!Number.isFinite(n)) return '<span class="delta delta-flat">—</span>';
    // "pts" = percentage points: the difference between two stored scores
    // (latest minus first), never a relative % change.
    if (n > 0) return `<span class="delta delta-up">&#9650; +${n} pts</span>`;
    if (n < 0) return `<span class="delta delta-down">&#9660; ${n} pts</span>`;
    return '<span class="delta delta-flat">0 pts</span>';
}

/**
 * The query string every request on this page uses — the four report endpoints
 * and the CSV export alike. Built in ONE place on purpose: the moment two
 * callers assemble their own filters, a chart and its export start describing
 * different patients.
 */
function currentRangeQuery() {
    const from = document.getElementById('rangeFrom').value;
    const to = document.getElementById('rangeTo').value;
    const classification = document.getElementById('filterClassification')?.value || 'all';
    const childId = document.getElementById('filterPatient')?.value || 'all';

    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (classification && classification !== 'all') params.set('classification', classification);
    if (childId && childId !== 'all') params.set('childId', childId);

    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

/** Fills the classification dropdown from the shared band set, once. */
function initClassificationFilter() {
    const select = document.getElementById('filterClassification');
    if (!select || select.dataset.ready === '1') return;
    for (const band of bandKeys()) {
        const opt = document.createElement('option');
        opt.value = band;
        opt.textContent = window.KCScoring.clinicalLabel(band);
        select.appendChild(opt);
    }
    select.dataset.ready = '1';
}

/**
 * Fills the patient dropdown from the roster. Skipped while a patient filter is
 * active, because that response contains only the selected patient and
 * rebuilding from it would drop every other name from the list.
 */
function syncPatientFilter(patients) {
    const select = document.getElementById('filterPatient');
    if (!select) return;
    const selected = select.value;

    if (select.value === 'all' && Array.isArray(patients)) {
        patientFilterOptions = patients.map((p) => ({ id: p.childId, name: p.name }));
    }
    if (!patientFilterOptions.length) return;

    select.innerHTML = '<option value="all">All patients</option>';
    for (const p of patientFilterOptions) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    }
    select.value = selected;
    // The previously selected patient may not exist under a new date range.
    if (!select.value) select.value = 'all';
}

/** A one-line statement of what the numbers below are filtered to. */
function renderActiveFilterNote(overview) {
    const note = document.getElementById('activeFilterNote');
    if (!note) return;
    const filters = overview?.filters || {};
    const parts = [];

    if (filters.classification) {
        parts.push(`latest classification is ${window.KCScoring.clinicalLabel(filters.classification)}`);
    }
    if (filters.childId) {
        const match = patientFilterOptions.find((p) => p.id === filters.childId);
        parts.push(`patient is ${match ? match.name : 'the selected patient'}`);
    }

    if (!parts.length) {
        note.style.display = 'none';
        note.textContent = '';
        return;
    }

    const shown = count(overview?.cohort?.patients);
    const scope = count(overview?.cohort?.patientsInScope);
    note.style.display = '';
    note.textContent = `Showing ${shown} of your ${scope} ${plural(scope, 'patient')}: ${parts.join(' and ')}. `
        + 'Every section and the CSV export below use this same filtered set.';
}

function errorCard(title, message) {
    return `
        <div class="report-card">
            <div class="report-empty report-error">
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(message)}</p>
            </div>
        </div>`;
}

// ── Section 1: cohort tiles ─────────────────────────────────────────────────

function renderCohortTiles(overview) {
    const wrap = document.getElementById('cohortTiles');
    const cohort = overview?.cohort || {};

    const patients = count(cohort.patients);
    const screenings = count(cohort.screenings);
    const withScreening = count(cohort.patientsWithScreening);
    const legacy = count(cohort.legacyBandDocs);
    const repeat = count(cohort.patientsWithRepeatAssessments);
    const single = count(cohort.patientsWithSingleAssessment);

    wrap.innerHTML = `
        <div class="report-tile">
            <p class="tile-label">Patients</p>
            <p class="tile-value">${patients}</p>
            <p class="tile-sub">${patients === 0
                ? 'No children are linked to you by an appointment yet.'
                : `${plural(patients, 'child', 'children')} you have an appointment with.`}</p>
        </div>
        <div class="report-tile">
            <p class="tile-label">Assessments</p>
            <p class="tile-value">${screenings}</p>
            <p class="tile-sub">${screenings === 0
                ? 'No assessment results in this date range.'
                : `Completed ${plural(screenings, 'assessment')} in range.`}</p>
        </div>
        <div class="report-tile">
            <p class="tile-label">Patients assessed</p>
            <p class="tile-value">${withScreening}</p>
            <p class="tile-sub">${patients === 0
                ? '—'
                : `${patients - withScreening} of your ${patients} ${plural(patients, 'patient')} ${
                    patients - withScreening === 1 ? 'has' : 'have'} no assessment in range.`}</p>
        </div>
        <div class="report-tile">
            <p class="tile-label">Assessed more than once</p>
            <p class="tile-value">${repeat}</p>
            <p class="tile-sub">${withScreening === 0
                ? 'No assessments in range.'
                : `${single} assessed once; ${repeat} ${plural(repeat, 'has', 'have')} a repeat assessment to compare.`}</p>
        </div>`;

    // Only shown when it is non-zero. This used to be a permanent tile labelled
    // "Historical Assessments", which reads as "assessments from the past" —
    // it actually counts documents carrying no scoring-band version stamp, and
    // is 0 for every record currently on file. A tile that always reads 0 and
    // means something other than its label is worse than no tile.
    if (legacy > 0) {
        wrap.insertAdjacentHTML('beforeend', `
            <div class="report-tile">
                <p class="tile-label">Older scoring baseline</p>
                <p class="tile-value">${legacy}</p>
                <p class="tile-sub">${plural(legacy, 'assessment')} saved before the current scoring baseline. Bands here are recomputed from the stored score, so this report stays consistent.</p>
            </div>`);
    }
}

// ── Section 2: classification overview ──────────────────────────────────────

function renderClassification(overview) {
    const section = document.getElementById('classificationSection');
    const withScreening = count(overview?.cohort?.patientsWithScreening);
    const patients = count(overview?.cohort?.patients);
    const legacy = count(overview?.cohort?.legacyBandDocs);
    const screenings = count(overview?.cohort?.screenings);

    if (patients === 0) {
        section.innerHTML = `
            <div class="report-card">
                <h2>Classification overview</h2>
                <div class="report-empty">
                    <h3>No patients yet</h3>
                    <p>A child will appear here once a parent books an appointment with you.</p>
                </div>
            </div>`;
        return;
    }

    if (withScreening === 0) {
        section.innerHTML = `
            <div class="report-card">
                <h2>Classification overview</h2>
                <div class="report-empty">
                    <h3>No assessments in this date range</h3>
                    <p>
                        You have ${patients} ${plural(patients, 'patient')}, but none of them has a
                        completed assessment within the selected dates. Widen the range or
                        choose "All time".
                    </p>
                </div>
            </div>`;
        return;
    }

    const riskFlagged = overview.riskFlagged || {};
    const riskItems = DOMAINS.map((d) => {
        const n = count(riskFlagged[d.key]);
        return `
            <div class="risk-item">
                <p class="risk-count" style="color:${escapeHtml(
                    n > 0 ? '#6B8E6F' : '#6B7967')};">${n}</p>
                <p class="risk-label">${escapeHtml(d.label)}</p>
            </div>`;
    }).join('');

    const anyDomain = count(riskFlagged.anyDomain);
    // Same constant routes/pedia-reports.js flags with (scoring.isRiskFlagged).
    const flagThreshold = window.KCScoring.RISK_FLAG_THRESHOLD;

    // Dynamic, data-driven interpretation for each chart — built from the
    // SAME counts the chart itself renders (js/pedia/pedia-reports-interpretations.js),
    // never a static caption. See that file's header for why the "needs
    // support" grouping matches Admin Analytics rather than the stricter
    // risk-flag threshold used by the strip below.
    const KCPI = window.KCPediaReportsInterpretations;
    const domainInterpretation = KCPI.formatDomainBandInterpretation(overview.domainDistribution, withScreening);
    const overallInterpretation = KCPI.formatOverallBandInterpretation(overview.overallDistribution, withScreening);
    const domainSentences = KCPI.formatDomainCountSentences(overview.domainDistribution, withScreening);

    // The numbers, written out. The stacked bar shows the shape of the cohort;
    // this table answers "how many children are Delayed in Social Skills?"
    // without anyone having to read a bar segment against an axis.
    const keys = bandKeys();
    const dist = overview.domainDistribution || {};
    // Wrapped in a scroll container like the other tables: the four band columns
    // plus a label do not fit a phone, and without this the whole PAGE scrolls
    // sideways instead of just the table.
    const countsTable = `
        <div class="table-scroll">
        <table class="report-table counts-table">
            <thead>
                <tr>
                    <th scope="col">Developmental domain</th>
                    ${keys.map((k) => `<th scope="col" class="num">${escapeHtml(window.KCScoring.clinicalLabel(k))}</th>`).join('')}
                    <th scope="col" class="num">Total</th>
                </tr>
            </thead>
            <tbody>
                ${DOMAINS.map((d) => {
                    const row = dist[d.key] || {};
                    const total = keys.reduce((sum, k) => sum + count(row[k]), 0);
                    return `
                        <tr>
                            <th scope="row">${escapeHtml(d.label)}</th>
                            ${keys.map((k) => `<td class="num"><span class="count-dot" style="background:${escapeHtml(window.KCScoring.colorForBand(k))};"></span>${count(row[k])}</td>`).join('')}
                            <td class="num"><strong>${total}</strong></td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>`;

    section.innerHTML = `
        <div class="report-card">
            <h2>Classification overview</h2>
            <p class="section-lead">
                Counts the most recent assessment for each of your ${withScreening}
                assessed ${plural(withScreening, 'patient', 'patients')} — one patient, one count.
                A patient assessed several times is counted once, on their latest result.
                The numbers in the table and charts are <strong>counts of patients</strong>, not percentages.
            </p>

            ${scoreGuideHtml()}

            ${countsTable}

            <div class="domain-notes">
                ${domainSentences.map((s) => `
                    <p class="domain-note"><strong>${escapeHtml(s.label)}:</strong> ${escapeHtml(s.text)}</p>
                `).join('')}
            </div>

            <div class="chart-row">
                <div>
                    <p class="chart-title">Domain classification (number of patients)</p>
                    <div class="chart-box"><canvas id="bandDomainChart" role="img"
                        aria-label="Stacked bar chart: number of patients in each classification for each developmental domain. The same counts are in the table above."></canvas></div>
                    <p class="chart-caption">One bar per developmental domain. Bar height = number of assessed patients (${withScreening}); each coloured segment = how many of them fall in that classification for the domain, on their latest assessment. Same counts as the table above.</p>
                    <div class="chart-interp">
                        <p class="chart-interp-label">Interpretation</p>
                        <p class="chart-interp-text">${escapeHtml(domainInterpretation)}</p>
                    </div>
                </div>
                <div>
                    <p class="chart-title">Overall classification (number of patients)</p>
                    <div class="chart-box"><canvas id="overallBandChart" role="img"
                        aria-label="Doughnut chart: number of patients in each overall classification. The counts are listed below."></canvas></div>
                    <ul class="kc-chart-legend overall-legend" aria-label="Overall classification legend">${overallLegendHtml(overview.overallDistribution, withScreening)}</ul>
                    <p class="chart-caption">Overall classification based on the latest assessment for each patient. Each slice is a count of patients; its size is their share of the ${withScreening} assessed ${plural(withScreening, 'patient')}.</p>
                    <div class="chart-interp">
                        <p class="chart-interp-label">Interpretation</p>
                        <p class="chart-interp-text">${escapeHtml(overallInterpretation)}</p>
                    </div>
                </div>
            </div>

            <h3 class="sub-heading">Patients scoring below ${flagThreshold}% in a domain</h3>
            <p class="section-lead">
                A domain score under ${flagThreshold}% is what KinderCura's existing rules flag for closer review.
                Each number is a <strong>count of patients</strong> whose latest assessment has a domain
                assessment score below ${flagThreshold}% (the Delayed range) &mdash; a flag for closer review, not a
                medical diagnosis. "Any domain" counts each patient once, however many domains are flagged.
            </p>
            <div class="risk-strip">
                ${riskItems}
                <div class="risk-item">
                    <p class="risk-count" style="color:${escapeHtml(
                        anyDomain > 0 ? '#6B8E6F' : '#6B7967')};">${anyDomain}</p>
                    <p class="risk-label"><strong>Any domain</strong></p>
                </div>
            </div>
        </div>`;

    drawClassificationCharts(overview);
}

/** Doughnut legend with each band's count and its share of assessed patients. */
function overallLegendHtml(dist, total) {
    const d = dist || {};
    return bandKeys().map((k) => {
        const n = count(d[k]);
        const pct = total > 0 ? Math.round((n / total) * 100) : 0;
        return `
            <li>
                <span class="kc-swatch" style="background:${escapeHtml(window.KCScoring.colorForBand(k))};" aria-hidden="true"></span>
                <span><span class="kc-chart-legend-label">${escapeHtml(window.KCScoring.clinicalLabel(k))}</span>:
                    ${n} of ${total} ${plural(total, 'patient')} (${pct}%)</span>
            </li>`;
    }).join('');
}

function drawClassificationCharts(overview) {
    if (typeof Chart === 'undefined') return;

    const keys = bandKeys();
    const domainDistribution = overview.domainDistribution || {};

    // Stacked bar: one bar per domain, one segment per band.
    const domainCanvas = document.getElementById('bandDomainChart');
    if (domainCanvas) {
        if (bandDomainChart) bandDomainChart.destroy();
        bandDomainChart = new Chart(domainCanvas, {
            type: 'bar',
            data: {
                labels: DOMAINS.map((d) => d.label),
                datasets: keys.map((bandKey) => ({
                    label: window.KCScoring.clinicalLabel(bandKey),
                    data: DOMAINS.map((d) => count(domainDistribution[d.key]?.[bandKey])),
                    backgroundColor: window.KCScoring.colorForBand(bandKey),
                    stack: 'bands',
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, title: { display: true, text: 'Developmental domain' } },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: { precision: 0 },
                        title: { display: true, text: 'Number of patients' },
                    },
                },
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} ${ctx.parsed.y === 1 ? 'patient' : 'patients'}`,
                        },
                    },
                },
            },
        });
    }

    const overallCanvas = document.getElementById('overallBandChart');
    if (overallCanvas) {
        if (overallBandChart) overallBandChart.destroy();
        const dist = overview.overallDistribution || {};
        overallBandChart = new Chart(overallCanvas, {
            type: 'doughnut',
            data: {
                labels: keys.map((k) => window.KCScoring.clinicalLabel(k)),
                datasets: [{
                    data: keys.map((k) => count(dist[k])),
                    backgroundColor: keys.map((k) => window.KCScoring.colorForBand(k)),
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    // The HTML legend under the chart lists each band with its
                    // count and share, so Chart.js's colour-only legend is off.
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.label}: ${ctx.parsed} ${ctx.parsed === 1 ? 'child' : 'children'}`,
                        },
                    },
                },
            },
        });
    }
}

// ── Section 3: progression ──────────────────────────────────────────────────

function renderProgression(progression) {
    const section = document.getElementById('progressionSection');
    const children = Array.isArray(progression?.children) ? progression.children : [];
    const single = count(progression?.childrenWithSingleScreening);
    const withScreening = count(progression?.patientsWithScreening);

    if (!children.length) {
        section.innerHTML = `
            <div class="report-card">
                <h2>How results changed over time &mdash; all patients</h2>
                <div class="report-empty">
                    <h3>Not enough repeat assessments yet</h3>
                    <p>
                        Comparing results over time needs at least two assessments for the same patient.
                        ${withScreening === 0
                            ? 'None of your patients has an assessment in this date range yet.'
                            : `${single} of your ${withScreening} assessed ${plural(withScreening, 'patient')}
                               ${single === 1 ? 'has' : 'have'} only one assessment in range.`}
                    </p>
                </div>
            </div>`;
        return;
    }

    const movement = progression.cohortMovement || {};
    const rows = children.map((child, index) => progressionRowHtml(child, index)).join('');
    const cohortInterpretation = window.KCPediaReportsInterpretations
        .formatProgressionCohortInterpretation(movement, children.length);

    section.innerHTML = `
        <div class="report-card">
            <h2>How results changed over time &mdash; all patients</h2>
            <p class="section-lead">
                Only patients with two or more assessments in this range appear here — a single
                assessment is one reading, not a change. Each row compares a patient's
                <strong>first</strong> assessment in range with their <strong>latest</strong>.
                Select a row to see every assessment in between.
            </p>
            <p class="section-lead">
                <strong>Score change</strong> is the latest overall assessment score minus the first, in
                <strong>percentage points (pts)</strong>: 100% &rarr; 50% is &minus;50 pts, a drop of 50 points on the
                0&ndash;100 score scale. &#9650; = score went up, &#9660; = score went down. It is a change in an
                assessment score, not a probability or a diagnosis.
            </p>

            <div class="report-tiles" style="margin-bottom:1.4rem;">
                <div class="report-tile">
                    <p class="tile-label">Moved to less concern</p>
                    <p class="tile-value" style="color:var(--status-positive-fg);">${count(movement.improved)}</p>
                    <p class="tile-sub">Latest result is in a better classification than the first.</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">No change in classification</p>
                    <p class="tile-value" style="color:var(--text-light);">${count(movement.unchanged)}</p>
                    <p class="tile-sub">The score may still have moved within the same band.</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">Moved to more concern</p>
                    <p class="tile-value" style="color:var(--status-attention-fg);">${count(movement.declined)}</p>
                    <p class="tile-sub">Latest result is in a classification indicating greater concern.</p>
                </div>
            </div>

            <div class="chart-interp" style="margin-bottom:1.4rem;">
                <p class="chart-interp-label">Interpretation</p>
                <p class="chart-interp-text">${escapeHtml(cohortInterpretation)}</p>
            </div>

            <div class="report-table-wrap">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Patient</th>
                            <th class="num">Assessments</th>
                            <th>First assessment<br><span class="th-sub">overall score &amp; date</span></th>
                            <th>Latest assessment<br><span class="th-sub">overall score &amp; date</span></th>
                            <th class="num">Score change<br><span class="th-sub">percentage points</span></th>
                            <th>Current classification</th>
                            <th>What changed</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${single > 0 ? `
            <p class="card-footnote">
                ${single} additional ${plural(single, 'patient')} with only one assessment in this range ${single === 1 ? 'is' : 'are'}
                not listed.
            </p>` : ''}
        </div>`;
}

function progressionRowHtml(child, index) {
    const expanded = expandedRows.has(index);
    const first = child.firstScreening || {};
    const latest = child.latestScreening || {};

    const warn = child.bandComparabilityWarning
        ? '<span class="warn-chip" title="These assessments use different scoring baselines. Scores are presented consistently based on recorded data.">historical baseline</span>'
        : '';

    return `
        <tr class="prog-row" tabindex="0" role="button" aria-expanded="${expanded ? 'true' : 'false'}"
            onclick="toggleProgressionRow(${index})"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleProgressionRow(${index});}">
            <td>
                <span class="prog-toggle">${expanded ? '&#9662;' : '&#9656;'}</span>
                <span class="prog-name">${escapeHtml(child.name)}</span>${warn}
            </td>
            <td class="num">${count(child.screeningCount)}</td>
            <td>
                ${scoreText(first.overallScore)}<br>
                <span style="font-size:0.76rem;color:var(--text-light);">${escapeHtml(fmtShortDate(first.generatedAt))}</span>
            </td>
            <td>
                ${scoreText(latest.overallScore)}<br>
                <span style="font-size:0.76rem;color:var(--text-light);">${escapeHtml(fmtShortDate(latest.generatedAt))}</span>
            </td>
            <td class="num">${deltaHtml(child.delta?.overall)}</td>
            <td>${bandChip(latest.overallBand)}</td>
            <td>${movementChip(child.bandMovement?.overall)}</td>
        </tr>
        <tr class="prog-detail" id="prog-detail-${index}" ${expanded ? '' : 'hidden'}>
            <td colspan="7">${progressionDetailHtml(child)}</td>
        </tr>`;
}

function progressionDetailHtml(child) {
    const screenings = Array.isArray(child.screenings) ? child.screenings : [];

    // The plain-language summary of this patient's own history, built from the
    // stored values already in the row — nothing is recomputed here.
    const summary = window.KCPediaReportsInterpretations.formatPatientProgressionInterpretation({
        name: child.name,
        assessmentCount: child.screeningCount,
        firstScore: child.firstScreening?.overallScore ?? null,
        firstBand: child.firstScreening?.overallBand ?? null,
        firstDate: child.firstScreening?.generatedAt ? fmtShortDate(child.firstScreening.generatedAt) : null,
        latestScore: child.latestScreening?.overallScore ?? null,
        latestBand: child.latestScreening?.overallBand ?? null,
        latestDate: child.latestScreening?.generatedAt ? fmtShortDate(child.latestScreening.generatedAt) : null,
        movement: child.bandMovement?.overall,
    });

    const perDomain = DOMAINS.map((d) => `
        <tr>
            <td>${escapeHtml(d.label)}</td>
            <td class="num">${scoreText(child.firstScreening?.domains?.[d.key]?.score)}</td>
            <td class="num">${scoreText(child.latestScreening?.domains?.[d.key]?.score)}</td>
            <td class="num">${deltaHtml(child.delta?.[d.key])}</td>
            <td>${bandChip(child.latestScreening?.domains?.[d.key]?.band)}</td>
            <td>${movementChip(child.bandMovement?.[d.key])}</td>
        </tr>`).join('');

    const history = screenings.map((s) => `
        <tr>
            <td>${escapeHtml(fmtShortDate(s.generatedAt))}</td>
            ${DOMAINS.map((d) => `<td class="num">${scoreText(s.domains?.[d.key]?.score)}</td>`).join('')}
            <td class="num"><strong>${scoreText(s.overallScore)}</strong></td>
            <td>${bandChip(s.overallBand)}</td>
        </tr>`).join('');

    return `
        <div class="chart-interp" style="margin-bottom:1.1rem;">
            <p class="chart-interp-label">What this patient's record shows</p>
            <p class="chart-interp-text">${escapeHtml(summary)}</p>
        </div>

        <h4>Each domain, first vs latest — ${escapeHtml(child.name)}</h4>
        <table>
            <thead>
                <tr>
                    <th>Domain</th><th class="num">First score</th><th class="num">Latest score</th>
                    <th class="num">Change (pts)</th><th>Current classification</th><th>What changed</th>
                </tr>
            </thead>
            <tbody>${perDomain}</tbody>
        </table>

        <h4 style="margin-top:1.1rem;">Every assessment in range (${count(child.screeningCount)}) &mdash; domain and overall assessment scores</h4>
        <table>
            <thead>
                <tr>
                    <th>Assessed</th>
                    ${DOMAINS.map((d) => `<th class="num">${escapeHtml(d.label)}</th>`).join('')}
                    <th class="num">Overall score</th><th>Classification</th>
                </tr>
            </thead>
            <tbody>${history}</tbody>
        </table>`;
}

function toggleProgressionRow(index) {
    const detail = document.getElementById(`prog-detail-${index}`);
    if (!detail) return;

    const nowExpanded = !expandedRows.has(index);
    if (nowExpanded) expandedRows.add(index);
    else expandedRows.delete(index);

    detail.hidden = !nowExpanded;

    const row = detail.previousElementSibling;
    if (row) {
        row.setAttribute('aria-expanded', nowExpanded ? 'true' : 'false');
        const toggle = row.querySelector('.prog-toggle');
        if (toggle) toggle.innerHTML = nowExpanded ? '&#9662;' : '&#9656;';
    }
}

// ── Section 4: patient roster ───────────────────────────────────────────────
//
// The only section that names individual patients. The distributions collapse
// each patient into a band count and the progression table deliberately
// excludes anyone without two assessments, so without this a pediatrician can
// see that three patients are At-Risk but never which three.

// A stored domain score is round(points earned / points possible × 100) —
// routes/assessments.js, docs/SCORING.md §2.2 — so 100 is its maximum. Raw
// points are not stored, so the stored score on its own 0–100 scale is what
// the domain cells show.
const DOMAIN_SCORE_MAX = 100;

/** Domain score as "N / 100", or N/A when no score is stored. Never a fabricated 0. */
function domainScoreText(value) {
    if (value == null) return 'N/A';
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)} / ${DOMAIN_SCORE_MAX}` : 'N/A';
}

// Every cell in a row comes from the same latest assessment: the server builds
// latestDomains, latestOverallScore and latestOverallBand from one result.
function patientRowHtml(p) {
    const domains = p.latestDomains || {};
    return `
        <tr>
            <th scope="row">${escapeHtml(p.name)}</th>
            <td class="num">${count(p.assessmentCount)}</td>
            <td>${p.latestAssessmentAt ? escapeHtml(fmtShortDate(p.latestAssessmentAt)) : '<span class="muted">No assessment in range</span>'}</td>
            ${DOMAINS.map((d) => {
                const dom = domains[d.key] || {};
                return `<td><span class="domain-score">${escapeHtml(domainScoreText(dom.score))}</span>${bandChip(dom.band)}</td>`;
            }).join('')}
            <td class="num">${p.latestOverallScore == null ? '—' : escapeHtml(scoreText(p.latestOverallScore))}</td>
            <td>${bandChip(p.latestOverallBand)}</td>
        </tr>`;
}

function renderPatients(data) {
    const section = document.getElementById('patientsSection');
    const patients = Array.isArray(data?.patients) ? data.patients : [];
    const totals = data?.totals || {};

    if (patients.length === 0) {
        section.innerHTML = `
            <div class="report-card">
                <h2>Patient list</h2>
                <div class="report-empty">
                    <h3>No patients match these filters</h3>
                    <p>Widen the date range, or reset the classification and patient filters.</p>
                </div>
            </div>`;
        return;
    }

    const interpretation = window.KCPediaReportsInterpretations.formatPatientRosterInterpretation(totals);

    section.innerHTML = `
        <div class="report-card">
            <h2>Patient list</h2>
            <p class="section-lead">
                Every patient matching the current filters, with their most recent assessment.
                Patients with no assessment in the selected range are listed too, so this table
                always reconciles with the Patients tile above.
            </p>

            <div class="chart-interp">
                <p class="chart-interp-label">Interpretation</p>
                <p class="chart-interp-text">${escapeHtml(interpretation)}</p>
            </div>

            <div class="table-scroll">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th scope="col">Patient</th>
                            <th scope="col" class="num">Assessments</th>
                            <th scope="col">Latest assessment</th>
                            ${DOMAINS.map((d) => `<th scope="col">${escapeHtml(d.label)}<br><span class="th-sub">score out of ${DOMAIN_SCORE_MAX}</span></th>`).join('')}
                            <th scope="col" class="num">Overall score<br><span class="th-sub">latest assessment</span></th>
                            <th scope="col">Overall classification</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${patients.map(patientRowHtml).join('')}
                    </tbody>
                </table>
            </div>
            <p class="table-note">
                The domain columns show each domain's stored score (out of ${DOMAIN_SCORE_MAX}) from the latest
                assessment, with the classification that score falls in under the Score guide above. N/A means no
                score is stored for that domain. <strong>Overall score</strong> is that same assessment's overall
                assessment score (average of the four domain scores).
                Classifications come from KinderCura's existing scoring rules applied to the stored
                score. They describe recorded assessment results and are not medical diagnoses.
            </p>
        </div>`;
}

// ── Section A: Assessment Activity Report ───────────────────────────────────
//
// Built from /pedia-reports/activity: one record per assessment, already
// scoped and filtered by the server exactly like every other section. The
// chart, the summary tiles, the interpretation and the records table all read
// that same list, so their totals always agree.
//
// Days are taken in the viewer's time zone — the same one fmtShortDate prints
// each assessment's date in — so a point on the chart and the dates in the
// records table cannot disagree.

/** Calendar day 'YYYY-MM-DD' of a timestamp, in the viewer's time zone. */
function localDayKey(value) {
    // new Date(null) is 1 Jan 1970, not an invalid date; a missing timestamp
    // must not become a 1970 point on the chart.
    if (value == null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The date the clinician typed into a range filter, from the server's echo. */
function rangeDayKey(iso) {
    return iso ? String(iso).slice(0, 10) : null;
}

// Stored Assessment.status values (models/Assessment.js). Anything else is
// shown as stored; a missing Assessment document is shown as not recorded.
const ASSESSMENT_STATUS_LABELS = Object.freeze({
    complete: 'Complete',
    submitted: 'Submitted',
    in_progress: 'In progress',
});

function statusHtml(status) {
    if (!status) return '<span class="muted">Not recorded</span>';
    return escapeHtml(ASSESSMENT_STATUS_LABELS[status] || status);
}

/** Short, readable form of an assessment id; the full id is in the tooltip. */
function assessmentIdHtml(id) {
    if (!id) return '<span class="muted">Not recorded</span>';
    return `<code class="record-id" title="${escapeHtml(id)}">…${escapeHtml(String(id).slice(-8))}</code>`;
}

const ACTIVITY_RECORDS_PAGE = 25;

/** The activity series for the current records and interval choice. */
function activitySeries(activity) {
    const KCPI = window.KCPediaReportsInterpretations;
    const records = Array.isArray(activity?.records) ? activity.records : [];
    const dayKeys = records.map((r) => localDayKey(r.assessedAt)).filter(Boolean);
    const sorted = dayKeys.slice().sort();

    // The period is the applied date range; an open end runs to the first
    // assessment or to today.
    const startKey = rangeDayKey(activity?.range?.from) || sorted[0] || null;
    const endKey = rangeDayKey(activity?.range?.to) || (sorted.length || startKey ? localDayKey(new Date()) : null);

    const autoInterval = KCPI.chooseActivityInterval(startKey, endKey);
    const interval = activityInterval === 'auto' ? autoInterval : activityInterval;
    return { interval, autoInterval, series: KCPI.buildActivitySeries(dayKeys, interval, startKey, endKey) };
}

function setActivityInterval(value) {
    activityInterval = ['day', 'week', 'month'].includes(value) ? value : 'auto';
    renderActivity(activityData);
}

function showAllActivityRecords() {
    activityShowAll = true;
    renderActivity(activityData);
}

function renderActivity(activity) {
    const section = document.getElementById('activitySection');
    const KCPI = window.KCPediaReportsInterpretations;
    const records = Array.isArray(activity?.records) ? activity.records : [];

    if (records.length === 0) {
        section.innerHTML = `
            <div class="report-card">
                <h2>Assessment Activity Over Time</h2>
                <div class="report-empty">
                    <h3>No assessments in this range</h3>
                    <p>No assessment was recorded for your patients under the current filters, so there is no
                        activity to chart and no record to list. Widen the date range or reset the filters.</p>
                </div>
            </div>`;
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        return;
    }

    const { interval, autoInterval, series } = activitySeries(activity);
    const words = KCPI.INTERVAL_WORDS[interval];
    const total = records.length;
    const patientsAssessed = count(activity?.totals?.patientsAssessed);
    const max = Math.max(...series.map((r) => r.count));
    const busiest = series.filter((r) => r.count === max);
    const active = series.filter((r) => r.count > 0).length;
    const intervalOption = (value, label) =>
        `<option value="${value}" ${activityInterval === value ? 'selected' : ''}>${label}</option>`;

    const shown = activityShowAll ? records : records.slice(0, ACTIVITY_RECORDS_PAGE);
    const rows = shown.map((r) => `
        <tr>
            <td>${escapeHtml(fmtShortDate(r.assessedAt))}</td>
            <th scope="row">${escapeHtml(r.name)}</th>
            <td>${assessmentIdHtml(r.assessmentId)}</td>
            <td>${statusHtml(r.status)}</td>
            <td class="num">${r.overallScore == null ? '—' : escapeHtml(scoreText(r.overallScore))}</td>
            <td>${bandChip(r.overallBand)}</td>
        </tr>`).join('');

    section.innerHTML = `
        <div class="report-card">
            <h2>Assessment activity summary</h2>
            <p class="section-lead">Totals for the assessments that match the current filters.</p>

            <div class="report-tiles activity-tiles">
                <div class="report-tile">
                    <p class="tile-label">Assessments recorded</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">Distinct assessment records in the selected period.</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">Patients assessed</p>
                    <p class="tile-value">${patientsAssessed}</p>
                    <p class="tile-sub">Different patients with at least one of those assessments.</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">Busiest ${escapeHtml(words.unit)}</p>
                    <p class="tile-value">${max}</p>
                    <p class="tile-sub">${busiest.length === 1
                        ? escapeHtml(busiest[0].rangeLabel)
                        : `Reached in ${busiest.length} different ${escapeHtml(words.units)}.`}</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">${escapeHtml(words.units)} with activity</p>
                    <p class="tile-value">${active}</p>
                    <p class="tile-sub">of ${series.length} ${escapeHtml(series.length === 1 ? words.unit : words.units)} in the period had an assessment.</p>
                </div>
            </div>

            <div class="activity-controls">
                <label for="activityInterval">Show assessments per</label>
                <select id="activityInterval" onchange="setActivityInterval(this.value)">
                    ${intervalOption('auto', `Automatic (${escapeHtml(KCPI.INTERVAL_WORDS[autoInterval].unit)})`)}
                    ${intervalOption('day', 'Day')}
                    ${intervalOption('week', 'Week')}
                    ${intervalOption('month', 'Month')}
                </select>
            </div>

            <p class="chart-title">Assessment Activity Over Time</p>
            <p class="chart-subtitle">Number of assessments recorded during each time interval. Each point is one ${escapeHtml(words.unit)}${
                interval === 'week' ? ' (Monday to Sunday)' : ''}.</p>
            <div class="chart-box chart-box-wide"><canvas id="activityChart" role="img"
                aria-label="Line chart: number of assessments recorded per ${escapeHtml(words.unit)}. The same assessments are listed in the Assessment Activity Records table."></canvas></div>
            <ul class="kc-chart-legend activity-legend" aria-label="Assessment activity legend">
                <li>
                    <span class="kc-swatch" style="background:var(--primary);" aria-hidden="true"></span>
                    <span><span class="kc-chart-legend-label">Number of assessments</span>
                        <span class="kc-chart-legend-desc">Each point is how many assessments were recorded for your patients in that ${escapeHtml(words.unit)}; a point at 0 means none were. The line shows activity, not results.</span></span>
                </li>
            </ul>
            <div class="chart-interp">
                <p class="chart-interp-label">Interpretation</p>
                <p class="chart-interp-text">${escapeHtml(KCPI.formatActivityTrendInterpretation(series, interval))}</p>
            </div>
        </div>

        <div class="report-card">
            <h2>Assessment Activity Records</h2>
            <p class="section-lead">A chronological list of assessments conducted for your patients, newest first.
                One row is one assessment record.</p>
            <div class="table-scroll">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th scope="col">Assessment date</th>
                            <th scope="col">Patient name</th>
                            <th scope="col">Assessment ID</th>
                            <th scope="col">Assessment status</th>
                            <th scope="col" class="num">Overall score</th>
                            <th scope="col">Overall classification</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${records.length > shown.length ? `
            <div class="table-more">
                <span>Showing the ${shown.length} most recent of ${records.length} assessments.</span>
                <button type="button" class="btn btn-secondary" onclick="showAllActivityRecords()">Show all ${records.length}</button>
            </div>` : ''}
            <p class="table-note">
                Assessment ID shows the last 8 characters of the stored record id; hover it for the full id.
                Assessment status is the status stored on the assessment record. Overall score and classification
                are that assessment's stored result, classified with the Score guide above.
            </p>
        </div>`;

    if (typeof Chart === 'undefined') return;
    const canvas = document.getElementById('activityChart');
    if (!canvas) return;
    if (activityChart) activityChart.destroy();
    const unitTitle = words.unit.charAt(0).toUpperCase() + words.unit.slice(1);
    activityChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: series.map((r) => r.label),
            datasets: [{
                label: 'Number of assessments',
                data: series.map((r) => r.count),
                borderColor: '#6B8E6F',
                backgroundColor: 'rgba(107, 142, 111, 0.15)',
                pointBackgroundColor: '#6B8E6F',
                pointRadius: series.length > 60 ? 0 : 3,
                pointHoverRadius: 5,
                borderWidth: 2,
                tension: 0,
                fill: true,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    title: { display: true, text: words.axis },
                    ticks: { autoSkip: true, maxRotation: 45 },
                },
                y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Number of Assessments' } },
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => `${unitTitle}: ${series[items[0].dataIndex].rangeLabel}`,
                        label: (ctx) => ` ${ctx.parsed.y} ${ctx.parsed.y === 1 ? 'assessment' : 'assessments'} recorded`,
                    },
                },
            },
        },
    });
}

// ── Section B: Patient Development Progress ─────────────────────────────────
//
// One patient's assessments in the selected period, oldest first, from the
// same activity records. Only patients this pediatrician can see are listed,
// because the records come from the server's appointment-scoped cohort.

// Line styles for the score chart: palette colours only, and a distinct point
// shape and dash per series so the lines stay apart without relying on colour.
const DEV_SERIES = Object.freeze([
    { key: 'communication', color: '#6B8E6F', pointStyle: 'circle',   dash: [] },
    { key: 'social',        color: '#E8A5A5', pointStyle: 'triangle', dash: [] },
    { key: 'cognitive',     color: '#6B7967', pointStyle: 'rectRot',  dash: [2, 3] },
    { key: 'motor',         color: '#F4D89F', pointStyle: 'rect',     dash: [] },
]);
const DEV_OVERALL_COLOR = '#3D4738';

function setDevProgressPatient(childId) {
    devProgressChildId = childId || null;
    renderDevProgress(activityData, patientsData);
}

/** Patients with at least one assessment in range, each with their history oldest first. */
function devProgressPatients(activity, roster) {
    const records = Array.isArray(activity?.records) ? activity.records : [];
    const byChild = new Map();
    for (const r of records) {
        if (!byChild.has(r.childId)) byChild.set(r.childId, { childId: r.childId, name: r.name, history: [] });
        byChild.get(r.childId).history.push(r);
    }
    const dob = new Map((roster?.patients || []).map((p) => [p.childId, p.dateOfBirth]));
    const list = Array.from(byChild.values());
    for (const p of list) p.history.reverse();
    list.sort((a, b) => a.name.localeCompare(b.name));

    // Two children can share a name; the date of birth tells them apart.
    const nameCounts = list.reduce((m, p) => m.set(p.name, (m.get(p.name) || 0) + 1), new Map());
    for (const p of list) {
        const born = dob.get(p.childId);
        p.label = nameCounts.get(p.name) > 1 && born ? `${p.name} (born ${fmtShortDate(born)})` : p.name;
    }
    return list;
}

function devScoreCell(score, band) {
    return `<td><span class="domain-score">${escapeHtml(domainScoreText(score))}</span>${bandChip(band)}</td>`;
}

function renderDevProgress(activity, roster) {
    const section = document.getElementById('devProgressSection');
    const KCPI = window.KCPediaReportsInterpretations;
    const patients = devProgressPatients(activity, roster);

    if (!patients.length) {
        section.innerHTML = `
            <div class="report-card">
                <h2>Assessment history</h2>
                <div class="report-empty">
                    <h3>No patient development progress records are available for the selected date range.</h3>
                    <p>None of your patients has an assessment under the current filters.</p>
                </div>
            </div>`;
        if (devProgressChart) { devProgressChart.destroy(); devProgressChart = null; }
        return;
    }

    // Keep the current choice while it is still listed; otherwise follow the
    // page's patient filter, then the first patient with a history to compare.
    const globalPatient = document.getElementById('filterPatient')?.value;
    const has = (id) => patients.some((p) => p.childId === id);
    if (!has(devProgressChildId)) {
        devProgressChildId = has(globalPatient) ? globalPatient
            : (patients.find((p) => p.history.length >= 2) || patients[0]).childId;
    }
    const patient = patients.find((p) => p.childId === devProgressChildId);
    const history = patient.history;

    const dates = history.map((r) => fmtShortDate(r.assessedAt));
    const sameDay = new Set(dates).size !== dates.length;
    // Two assessments on one day get their time too, so the chart's points stay distinguishable.
    const pointLabels = history.map((r, i) => (sameDay
        ? `${dates[i]}, ${new Date(r.assessedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : dates[i]));

    const roundOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
    const interpretation = KCPI.formatDevelopmentProgressInterpretation(patient.name, history.map((r, i) => ({
        date: dates[i],
        scores: DOMAINS.reduce((acc, d) => { acc[d.key] = roundOrNull(r.domains?.[d.key]?.score); return acc; }, {}),
        overallScore: roundOrNull(r.overallScore),
    })));

    const rows = history.map((r, i) => `
        <tr>
            <th scope="row">${escapeHtml(pointLabels[i])}</th>
            ${DOMAINS.map((d) => devScoreCell(r.domains?.[d.key]?.score, r.domains?.[d.key]?.band)).join('')}
            <td class="num">${r.overallScore == null ? '—' : escapeHtml(scoreText(r.overallScore))}</td>
            <td>${bandChip(r.overallBand)}</td>
        </tr>`).join('');

    const canChart = history.length >= 2;

    section.innerHTML = `
        <div class="report-card">
            <h2>Assessment history</h2>
            <div class="activity-controls">
                <label for="devProgressPatient">Patient</label>
                <select id="devProgressPatient" onchange="setDevProgressPatient(this.value)">
                    ${patients.map((p) => `<option value="${escapeHtml(p.childId)}" ${p.childId === patient.childId ? 'selected' : ''}>${
                        escapeHtml(p.label)} — ${p.history.length} ${plural(p.history.length, 'assessment')}</option>`).join('')}
                </select>
            </div>
            <p class="section-lead">
                Every assessment ${escapeHtml(patient.name)} has in the selected period, oldest first. Domain scores
                are the stored scores out of ${DOMAIN_SCORE_MAX}; the overall score is the average of the four.
                Only your own patients are listed.
            </p>

            <div class="chart-interp" style="margin-bottom:1.2rem;">
                <p class="chart-interp-label">Interpretation</p>
                <p class="chart-interp-text">${escapeHtml(interpretation)}</p>
            </div>

            ${canChart ? `
            <p class="chart-title">Developmental Assessment Progress</p>
            <p class="chart-subtitle">${escapeHtml(patient.name)}'s recorded scores at each assessment. All four domains and the overall score use the same 0&ndash;${DOMAIN_SCORE_MAX} scale. A gap in a line means no score is stored for that assessment.</p>
            <div class="chart-box chart-box-wide dev-progress-chart"><canvas id="devProgressChart" role="img"
                aria-label="Line chart of ${escapeHtml(patient.name)}'s recorded Communication, Social Skills, Cognitive, Motor Skills and overall scores at each assessment. The same values are in the table below."></canvas></div>
            ` : `
            <div class="report-empty">
                <h3>Not enough assessments for a trend</h3>
                <p>${escapeHtml(patient.name)} has one recorded assessment in this period. Its result is shown below;
                    a progress chart needs at least two assessments.</p>
            </div>`}

            <div class="table-scroll">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th scope="col">Assessment date</th>
                            ${DOMAINS.map((d) => `<th scope="col">${escapeHtml(d.label)}<br><span class="th-sub">score out of ${DOMAIN_SCORE_MAX}</span></th>`).join('')}
                            <th scope="col" class="num">Overall score</th>
                            <th scope="col">Overall classification</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <p class="table-note">
                Each row is one stored assessment record. Scores and classifications come from KinderCura's existing
                scoring rules and are not recomputed here. N/A means no score is stored for that domain. Assessment
                results support monitoring and do not replace professional clinical evaluation.
            </p>
        </div>`;

    if (devProgressChart) { devProgressChart.destroy(); devProgressChart = null; }
    if (!canChart || typeof Chart === 'undefined') return;
    const canvas = document.getElementById('devProgressChart');
    if (!canvas) return;

    const scoreOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    devProgressChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: pointLabels,
            datasets: [
                ...DEV_SERIES.map((s) => ({
                    label: DOMAINS.find((d) => d.key === s.key).label,
                    data: history.map((r) => scoreOrNull(r.domains?.[s.key]?.score)),
                    borderColor: s.color,
                    backgroundColor: s.color,
                    pointStyle: s.pointStyle,
                    borderDash: s.dash,
                    pointRadius: 4,
                    borderWidth: 2,
                    spanGaps: false,
                    tension: 0,
                })),
                {
                    label: 'Overall score',
                    data: history.map((r) => scoreOrNull(r.overallScore)),
                    borderColor: DEV_OVERALL_COLOR,
                    backgroundColor: DEV_OVERALL_COLOR,
                    pointStyle: 'star',
                    borderDash: [8, 4],
                    pointRadius: 5,
                    borderWidth: 3,
                    spanGaps: false,
                    tension: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { title: { display: true, text: 'Assessment Date' } },
                y: {
                    min: 0,
                    max: DOMAIN_SCORE_MAX,
                    ticks: { stepSize: 20 },
                    title: { display: true, text: 'Assessment Score' },
                },
            },
            plugins: {
                legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
                tooltip: {
                    callbacks: {
                        title: (items) => `Assessment: ${pointLabels[items[0].dataIndex]}`,
                        label: (ctx) => (ctx.parsed.y == null
                            ? ` ${ctx.dataset.label}: no score stored`
                            : ctx.dataset.label === 'Overall score'
                                ? ` Overall score: ${Math.round(ctx.parsed.y)}%`
                                : ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y)} / ${DOMAIN_SCORE_MAX}`),
                    },
                },
            },
        },
    });
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadReports() {
    const meta = document.getElementById('reportMeta');
    const query = currentRangeQuery();

    // Expansion state belongs to the rows that were on screen; a new filter
    // produces a different set of rows, so it is dropped rather than reapplied
    // to whichever children happen to land at those indexes.
    expandedRows.clear();

    document.getElementById('classificationSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading classification overview…</div></div>';
    document.getElementById('patientsSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading patient list…</div></div>';
    document.getElementById('progressionSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading progression…</div></div>';
    document.getElementById('activitySection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading assessment activity…</div></div>';
    document.getElementById('devProgressSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading patient development progress…</div></div>';
    meta.textContent = 'Loading…';
    // A new filter is a new list of records; start it collapsed again.
    activityShowAll = false;

    // One query string for all four, so the sections cannot disagree about
    // which patients they are describing. The activity request (Sections A
    // and B) starts alongside the other three but settles on its own, with
    // its own timeout and error state, so it can neither block nor be blocked
    // by them.
    lastReportQuery = query;
    const activityTask = requestActivity(query);
    try {
        [overviewData, progressionData, patientsData] = await Promise.all([
            apiFetch(`/pedia-reports/overview${query}`),
            apiFetch(`/pedia-reports/progression${query}`),
            apiFetch(`/pedia-reports/patients${query}`),
        ]);
    } catch (err) {
        meta.textContent = 'Could not load reports';
        document.getElementById('cohortTiles').innerHTML = '';
        document.getElementById('classificationSection').innerHTML =
            errorCard('We could not load this report', err.message);
        document.getElementById('patientsSection').innerHTML = '';
        document.getElementById('progressionSection').innerHTML = '';
        applyActivityResult(await activityTask);
        return;
    }

    const patients = count(overviewData?.cohort?.patients);
    const screenings = count(overviewData?.cohort?.screenings);
    const rangeLabel = (overviewData?.range?.from || overviewData?.range?.to)
        ? `${overviewData.range.from ? fmtShortDate(overviewData.range.from) : 'the beginning'} – ${
            overviewData.range.to ? fmtShortDate(overviewData.range.to) : 'today'}`
        : 'all time';
    meta.textContent = `${patients} ${plural(patients, 'patient')} • ${screenings} ${
        plural(screenings, 'assessment')} • ${rangeLabel}`;

    syncPatientFilter(patientsData?.patients);
    renderActiveFilterNote(overviewData);
    renderCohortTiles(overviewData);
    renderClassification(overviewData);
    renderPatients(patientsData);
    renderProgression(progressionData);
    // Rendered after the roster arrives, so same-name patients in Section B
    // can be told apart by date of birth.
    applyActivityResult(await activityTask);
}

// ── Sections A and B: the activity request ──────────────────────────────────
//
// Both sections read /pedia-reports/activity. The request has a time limit
// and is aborted when a newer one starts (a filter change or Retry), and only
// the newest request may change the page, so a slow earlier response can
// never overwrite a later one. Every outcome — data, no data, error, timeout,
// or a rendering failure — replaces the loading placeholders.

const ACTIVITY_REQUEST_TIMEOUT_MS = 20000;
let activityRequestSeq = 0;
let activityController = null;
// The query the page last loaded with, so Retry asks for exactly what the
// other sections are showing even if the filter inputs were edited since.
let lastReportQuery = '';

/** Resolves (never rejects) to { seq, ok, data } or { seq, ok: false, timedOut, error }. */
async function requestActivity(query) {
    const seq = ++activityRequestSeq;
    if (activityController) activityController.abort();
    const controller = new AbortController();
    activityController = controller;

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ACTIVITY_REQUEST_TIMEOUT_MS);
    try {
        const data = await apiFetch(`/pedia-reports/activity${query}`, { signal: controller.signal });
        // apiFetch has already rejected any non-2xx status; this rejects a
        // 2xx body that is not the documented shape rather than drawing an
        // empty report from it.
        if (!data || !Array.isArray(data.records)) throw new Error('Unexpected response from /pedia-reports/activity.');
        return { seq, ok: true, data };
    } catch (error) {
        return { seq, ok: false, timedOut, error };
    } finally {
        clearTimeout(timer);
        if (activityController === controller) activityController = null;
    }
}

function devProgressErrorHtml(timedOut) {
    return `
        <div class="report-card">
            <h2>Assessment history</h2>
            <div class="report-empty report-error" role="alert">
                <h3>Unable to load patient development progress. Please try again.</h3>
                <p>${timedOut
                    ? `The request took longer than ${ACTIVITY_REQUEST_TIMEOUT_MS / 1000} seconds and was stopped.`
                    : 'The report could not be loaded. No data is shown rather than an incomplete history.'}</p>
                <button type="button" class="btn btn-secondary" onclick="retryActivityAndProgress()">Retry</button>
            </div>
        </div>`;
}

function applyActivityResult(result) {
    if (result.seq !== activityRequestSeq) return;

    if (!result.ok) {
        // Details go to the console only; the server's message is not shown.
        console.error('Pediatrician Reports: activity request failed', result.error);
        activityData = null;
        if (activityChart) { activityChart.destroy(); activityChart = null; }
        if (devProgressChart) { devProgressChart.destroy(); devProgressChart = null; }
        document.getElementById('activitySection').innerHTML = errorCard(
            'We could not load assessment activity',
            result.timedOut ? 'The request took too long and was stopped. Use Retry below to try again.'
                : 'Use Retry below to try again.');
        document.getElementById('devProgressSection').innerHTML = devProgressErrorHtml(result.timedOut);
        return;
    }

    activityData = result.data;
    try {
        renderActivity(activityData);
    } catch (err) {
        console.error('Pediatrician Reports: could not render assessment activity', err);
        document.getElementById('activitySection').innerHTML =
            errorCard('We could not display assessment activity', 'Reload the page to try again.');
    }
    try {
        renderDevProgress(activityData, patientsData);
    } catch (err) {
        console.error('Pediatrician Reports: could not render patient development progress', err);
        if (devProgressChart) { devProgressChart.destroy(); devProgressChart = null; }
        document.getElementById('devProgressSection').innerHTML = devProgressErrorHtml(false);
    }
}

/** Retry: a new request for the same filters, then Sections A and B again. */
async function retryActivityAndProgress() {
    document.getElementById('activitySection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading assessment activity…</div></div>';
    document.getElementById('devProgressSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading patient development progress…</div></div>';
    applyActivityResult(await requestActivity(lastReportQuery));
}

// ── Filter actions ──────────────────────────────────────────────────────────
// This page loads on demand and on filter change only. There is deliberately no
// polling interval: these are aggregate queries over several collections, and
// nothing on this page changes second to second.

function applyFilters() {
    const from = document.getElementById('rangeFrom').value;
    const to = document.getElementById('rangeTo').value;
    if (from && to && from > to) {
        alert('The "from" date cannot be later than the "to" date.');
        return;
    }
    loadReports();
}

function clearFilters() {
    document.getElementById('rangeFrom').value = '';
    document.getElementById('rangeTo').value = '';
    const band = document.getElementById('filterClassification');
    const patient = document.getElementById('filterPatient');
    if (band) band.value = 'all';
    if (patient) patient.value = 'all';
    loadReports();
}

/**
 * CSV export. The endpoint needs the bearer token, so a plain link cannot be
 * used — the file is fetched with the auth header and handed to the browser as
 * a blob. downloadWithAuth() in api.js is JSON-only and would parse the CSV
 * body as JSON, so it is not reused here.
 */
async function exportScreeningsCsv() {
    const btn = document.getElementById('exportBtn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }

    try {
        const res = await fetch(`${API}/pedia-reports/export.csv${currentRangeQuery()}`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('kc_token')}` },
        });
        if (!res.ok) {
            let msg = `Error ${res.status}`;
            try { msg = (await res.json()).error || msg; } catch { /* body was not JSON */ }
            throw new Error(msg);
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kindercura-assessments.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
        alert(`Could not export: ${err.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = original; }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof initNav === 'function') initNav();
    initClassificationFilter();
    loadReports();
});
