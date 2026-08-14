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
let outcomesData = null;

let bandDomainChart = null;
let overallBandChart = null;

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

// Clinician-facing wording for the structured outcome enum in
// models/Assessment.js. Unknown keys are humanised rather than dropped, so a
// future sixth outcome renders readably instead of as a blank column.
const OUTCOME_LABELS = {
    typical_development: 'Typical development',
    monitor: 'Monitor',
    referred_for_evaluation: 'Referred for evaluation',
    confirmed_delay: 'Confirmed delay',
    inconclusive: 'Inconclusive',
};

const PROGRESS_STATUS_LABELS = {
    initial_review: 'Initial Review',
    monitoring: 'Monitoring',
    follow_up: 'Follow-up',
    improving: 'Improving',
    stable: 'Stable',
    needs_attention: 'Needs Attention',
    referred: 'Referred',
    completed: 'Completed',
};

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

function outcomeLabel(key) {
    return OUTCOME_LABELS[key] || String(key || '').replace(/_/g, ' ');
}

function progressStatusLabel(key) {
    if (!key) return 'No notes yet';
    return PROGRESS_STATUS_LABELS[key] || String(key).replace(/_/g, ' ');
}

/** Band keys high → low, straight from the shared band set. */
function bandKeys() {
    return window.KCScoring.ACTIVE_BANDS.map((b) => b.key);
}

function bandChip(bandKey) {
    if (!bandKey) return '<span class="band-chip" style="background:#b6bcc2;">Not scored</span>';
    const color = window.KCScoring.colorForBand(bandKey);
    const label = window.KCScoring.clinicalLabel(bandKey);
    return `<span class="band-chip" style="background:${escapeHtml(color)};">${escapeHtml(label)}</span>`;
}

function movementChip(movement) {
    const m = movement === 'improved' || movement === 'declined' ? movement : 'unchanged';
    const label = m === 'improved' ? 'Improved band'
        : m === 'declined' ? 'Declined band'
        : 'Same band';
    return `<span class="move-chip move-${escapeHtml(m)}">${escapeHtml(label)}</span>`;
}

/** Signed point change between two stored scores. Absent values stay absent. */
function deltaHtml(value) {
    if (value == null) return '<span class="delta delta-flat">—</span>';
    const n = Number(value);
    if (!Number.isFinite(n)) return '<span class="delta delta-flat">—</span>';
    if (n > 0) return `<span class="delta delta-up">&#9650; +${n}</span>`;
    if (n < 0) return `<span class="delta delta-down">&#9660; ${n}</span>`;
    return '<span class="delta delta-flat">0</span>';
}

/** The ?from=&to= the filter inputs currently describe. */
function currentRangeQuery() {
    const from = document.getElementById('rangeFrom').value;
    const to = document.getElementById('rangeTo').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
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
            <p class="tile-label">Historical Assessments</p>
            <p class="tile-value">${legacy}</p>
            <p class="tile-sub">${legacy === 0
                ? 'Every assessment in range uses the standard scoring baseline.'
                : `${plural(legacy, 'assessment')} using historical scoring baseline.`}</p>
        </div>`;
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
                    n > 0 ? window.KCScoring.colorForBand(window.KCScoring.BAND.DELAYED) : '#8a949c')};">${n}</p>
                <p class="risk-label">${escapeHtml(d.label)}</p>
            </div>`;
    }).join('');

    const anyDomain = count(riskFlagged.anyDomain);

    section.innerHTML = `
        <div class="report-card">
            <h2>Classification overview</h2>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="bandDomainChart"></canvas></div>
                    <p class="chart-caption">Band distribution per domain (${withScreening} ${plural(withScreening, 'child', 'children')}).</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="overallBandChart"></canvas></div>
                    <p class="chart-caption">Overall band, latest assessment per child.</p>
                </div>
            </div>

            <div class="risk-strip">
                ${riskItems}
                <div class="risk-item">
                    <p class="risk-count" style="color:${escapeHtml(
                        anyDomain > 0 ? window.KCScoring.colorForBand(window.KCScoring.BAND.DELAYED) : '#8a949c')};">${anyDomain}</p>
                    <p class="risk-label"><strong>Any domain</strong></p>
                </div>
            </div>
        </div>`;

    drawClassificationCharts(overview);
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
                    x: { stacked: true },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: { precision: 0 },
                        title: { display: true, text: 'Children' },
                    },
                },
                plugins: { legend: { position: 'bottom' } },
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
                    legend: { position: 'bottom' },
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
                <h2>Assessment-to-assessment progression</h2>
                <div class="report-empty">
                    <h3>Not enough repeat assessments yet</h3>
                    <p>
                        Progression requires at least two assessments for the same child.
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

    section.innerHTML = `
        <div class="report-card">
            <h2>Assessment-to-assessment progression</h2>
            <p class="card-sub">
                Select a row to see each assessment in detail.
            </p>

            <div class="report-tiles" style="margin-bottom:1.4rem;">
                <div class="report-tile">
                    <p class="tile-label">Improved overall band</p>
                    <p class="tile-value" style="color:#15803d;">${count(movement.improved)}</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">Same overall band</p>
                    <p class="tile-value" style="color:#55606a;">${count(movement.unchanged)}</p>
                </div>
                <div class="report-tile">
                    <p class="tile-label">Declined overall band</p>
                    <p class="tile-value" style="color:#b91c1c;">${count(movement.declined)}</p>
                </div>
            </div>

            <div class="report-table-wrap">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Patient</th>
                            <th class="num">Assessments</th>
                            <th>First</th>
                            <th>Latest</th>
                            <th class="num">Change</th>
                            <th>Overall band</th>
                            <th>Progress notes</th>
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
        ? '<span class="warn-chip" title="These screenings use different scoring baselines. Scores are presented consistently based on recorded data.">historical baseline</span>'
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
            <td>${bandChip(latest.overallBand)} ${movementChip(child.bandMovement?.overall)}</td>
            <td>
                ${count(child.progressNoteCount)} ${plural(child.progressNoteCount, 'note')}<br>
                <span style="font-size:0.76rem;color:var(--text-light);">${escapeHtml(progressStatusLabel(child.latestProgressStatus))}</span>
            </td>
        </tr>
        <tr class="prog-detail" id="prog-detail-${index}" ${expanded ? '' : 'hidden'}>
            <td colspan="7">${progressionDetailHtml(child)}</td>
        </tr>`;
}

function progressionDetailHtml(child) {
    const screenings = Array.isArray(child.screenings) ? child.screenings : [];

    const perDomain = DOMAINS.map((d) => `
        <tr>
            <td>${escapeHtml(d.label)}</td>
            <td class="num">${scoreText(child.firstScreening?.domains?.[d.key]?.score)}</td>
            <td class="num">${scoreText(child.latestScreening?.domains?.[d.key]?.score)}</td>
            <td class="num">${deltaHtml(child.delta?.[d.key])}</td>
            <td>${bandChip(child.latestScreening?.domains?.[d.key]?.band)} ${movementChip(child.bandMovement?.[d.key])}</td>
        </tr>`).join('');

    const history = screenings.map((s) => `
        <tr>
            <td>${escapeHtml(fmtShortDate(s.generatedAt))}</td>
            ${DOMAINS.map((d) => `<td class="num">${scoreText(s.domains?.[d.key]?.score)}</td>`).join('')}
            <td class="num"><strong>${scoreText(s.overallScore)}</strong></td>
            <td>${bandChip(s.overallBand)}</td>
            <td style="font-size:0.76rem;color:var(--text-light);">${escapeHtml(s.scoringBandsVersion || 'standard')}</td>
        </tr>`).join('');

    return `
        <h4>Per-domain, first vs latest — ${escapeHtml(child.name)}</h4>
        <table>
            <thead>
                <tr>
                    <th>Domain</th><th class="num">First</th><th class="num">Latest</th>
                    <th class="num">Change</th><th>Latest band / movement</th>
                </tr>
            </thead>
            <tbody>${perDomain}</tbody>
        </table>

        <h4 style="margin-top:1.1rem;">Every assessment in range (${count(child.screeningCount)})</h4>
        <table>
            <thead>
                <tr>
                    <th>Assessed</th>
                    ${DOMAINS.map((d) => `<th class="num">${escapeHtml(d.label)}</th>`).join('')}
                    <th class="num">Overall</th><th>Band</th><th>Baseline</th>
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

// ── Section 4: outcome labelling ────────────────────────────────────────────

function renderOutcomes(outcomes) {
    const section = document.getElementById('outcomesSection');
    const labelled = count(outcomes?.labelledCount);
    const screenings = count(outcomes?.screeningCount);

    const methodNote = '';

    const coverage = `
        <div class="coverage-line">
            <strong>${labelled} of ${screenings}</strong> ${plural(screenings, 'assessment')} in this
            range ${labelled === 1 ? 'has' : 'have'} a recorded clinical outcome.
        </div>`;

    if (labelled === 0) {
        section.innerHTML = `
            <div class="report-card">
                <h2>Assessment band vs recorded clinical outcome</h2>
                <p class="card-sub">
                    Compare assessment results with clinical outcomes recorded by the pediatrician.
                </p>
                ${coverage}
                <div class="report-empty">
                    <h3>No clinical outcomes recorded yet</h3>
                    <p>${escapeHtml(outcomes?.message
                        || 'No assessment in this range has a recorded clinical outcome.')}</p>
                </div>
            </div>`;
        return;
    }

    const matrix = outcomes.matrix || {};
    const keys = bandKeys();
    // Outcome columns come from the server's enumeration of the schema enum, so
    // this table cannot fall behind a change to models/Assessment.js.
    const outcomeKeys = Object.keys(matrix[keys[0]] || {});

    const colTotals = outcomeKeys.map((oKey) =>
        keys.reduce((sum, band) => sum + count(matrix[band]?.[oKey]), 0));

    const bodyRows = keys.map((band) => {
        const rowTotal = outcomeKeys.reduce((sum, oKey) => sum + count(matrix[band]?.[oKey]), 0);
        return `
            <tr>
                <td class="band-head">${bandChip(band)}</td>
                ${outcomeKeys.map((oKey) => {
                    const n = count(matrix[band]?.[oKey]);
                    return `<td class="cell${n === 0 ? ' cell-zero' : ''}">${n}</td>`;
                }).join('')}
                <td class="cell total">${rowTotal}</td>
            </tr>`;
    }).join('');

    const detailRows = (outcomes.rows || []).map((row) => `
        <tr>
            <td>${escapeHtml(row.childName)}</td>
            <td>${escapeHtml(fmtShortDate(row.screenedAt))}</td>
            <td class="num">${scoreText(row.overallScore)}</td>
            <td>${bandChip(row.screeningBand)}</td>
            <td>${escapeHtml(outcomeLabel(row.clinicalOutcome))}</td>
            <td>${Array.isArray(row.clinicalOutcomeDomains) && row.clinicalOutcomeDomains.length
                ? escapeHtml(row.clinicalOutcomeDomains.join(', '))
                : '<span style="color:var(--text-light);">—</span>'}</td>
            <td>${escapeHtml(fmtShortDate(row.clinicalOutcomeAt))}</td>
        </tr>`).join('');

    section.innerHTML = `
        <div class="report-card">
            <h2>Assessment band vs recorded clinical outcome</h2>
            <p class="card-sub">
                Compare assessment results with clinical outcomes recorded by the pediatrician.
            </p>
            ${coverage}

            <div class="report-table-wrap">
                <table class="report-table crosstab">
                    <thead>
                        <tr>
                            <th>Assessment band</th>
                            ${outcomeKeys.map((oKey) => `<th class="rot">${escapeHtml(outcomeLabel(oKey))}</th>`).join('')}
                            <th class="total">Total</th>
                        </tr>
                    </thead>
                    <tbody>${bodyRows}</tbody>
                    <tfoot>
                        <tr>
                            <td>Total</td>
                            ${colTotals.map((n) => `<td class="cell">${n}</td>`).join('')}
                            <td class="cell">${labelled}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            <h2 style="margin-top:1.8rem;font-size:1rem;">Labelled assessments</h2>
            <div class="report-table-wrap">
                <table class="report-table">
                    <thead>
                        <tr>
                            <th>Patient</th><th>Assessed</th><th class="num">Overall</th>
                            <th>Assessment band</th><th>Clinical outcome</th>
                            <th>Domains concerned</th><th>Outcome recorded</th>
                        </tr>
                    </thead>
                    <tbody>${detailRows}</tbody>
                </table>
            </div>
        </div>`;
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
    document.getElementById('progressionSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading progression…</div></div>';
    document.getElementById('outcomesSection').innerHTML =
        '<div class="report-card"><div class="report-loading">Loading outcome labelling…</div></div>';
    meta.textContent = 'Loading…';

    try {
        [overviewData, progressionData, outcomesData] = await Promise.all([
            apiFetch(`/pedia-reports/overview${query}`),
            apiFetch(`/pedia-reports/progression${query}`),
            apiFetch(`/pedia-reports/outcomes${query}`),
        ]);
    } catch (err) {
        meta.textContent = 'Could not load reports';
        document.getElementById('cohortTiles').innerHTML = '';
        document.getElementById('classificationSection').innerHTML =
            errorCard('We could not load this report', err.message);
        document.getElementById('progressionSection').innerHTML = '';
        document.getElementById('outcomesSection').innerHTML = '';
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

    renderCohortTiles(overviewData);
    renderClassification(overviewData);
    renderProgression(progressionData);
    renderOutcomes(outcomesData);
}

// ── Filter actions ──────────────────────────────────────────────────────────
// This page loads on demand and on filter change only. There is deliberately no
// polling interval: these are aggregate queries over several collections, and
// nothing on this page changes second to second.

function applyRange() {
    const from = document.getElementById('rangeFrom').value;
    const to = document.getElementById('rangeTo').value;
    if (from && to && from > to) {
        alert('The "from" date cannot be later than the "to" date.');
        return;
    }
    loadReports();
}

function clearRange() {
    document.getElementById('rangeFrom').value = '';
    document.getElementById('rangeTo').value = '';
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
        a.download = 'kindercura-screenings.csv';
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
    loadReports();
});
