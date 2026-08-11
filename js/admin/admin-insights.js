// js/admin/admin-insights.js
// Admin Insights — system-wide demographic and descriptive analytics, served by
// /api/admin-reports.
//
// This page RENDERS stored values. It does not score anything, and it does not
// write anything. Every number comes from the server. Band keys, band labels,
// and band colours all come from window.KCScoring (constants/scoring.js, loaded
// by admin-insights.html before this file) — the same source the pediatrician
// and parent report pages use, so no two pages can disagree about what a score
// of 62 is called or what colour it is drawn in.
//
// Wording rule for anything added here: these are SCREENING scores produced by
// fixed rules. Nothing on this page may call them predicted, intelligent,
// learned, or a diagnosis. Section 4 reports AGREEMENT, never accuracy — see the
// header of routes/admin-reports.js for why that distinction is load-bearing.
//
// Shared helpers (apiFetch, the notification modal, toggleProfileMenu) come from
// /api.js and /assets/js/notifications.js, matching admin-reports.html. Only
// escapeHtml is redefined locally so the escaping this page relies on is visible
// in this file.

// ── Auth guard ──────────────────────────────────────────────────────────────
// Mirrors the guard on the other admin pages: a token alone is not enough, the
// role has to match. Server-side every endpoint here answers 403 to any
// non-admin regardless of what the browser does.
(function guardRole() {
    let user = null;
    try { user = JSON.parse(localStorage.getItem('kc_user')); } catch { user = null; }
    if (!localStorage.getItem('kc_token') || !user) {
        window.location.href = '/login.html';
        return;
    }
    if ((user.role || '').trim().toLowerCase() !== 'admin') {
        window.location.href = '/login.html';
    }
}());

// ── Local state ─────────────────────────────────────────────────────────────
const charts = {};

// Vocabulary (band keys, age bands, outcomes) is served by the API rather than
// restated here, so adding an age band or a clinical outcome server-side shows
// up on this page without a frontend edit.
let vocab = null;

// Display labels for the structured outcome enum in models/Assessment.js.
// Unknown keys are humanised rather than dropped, so a future sixth outcome
// renders readably instead of as a blank column.
const OUTCOME_LABELS = {
    typical_development: 'Typical development',
    monitor: 'Monitor',
    referred_for_evaluation: 'Referred for evaluation',
    confirmed_delay: 'Confirmed delay',
    inconclusive: 'Inconclusive',
};

const ROLE_LABELS = {
    parent: 'Parent',
    legal_guardian: 'Legal guardian',
    foster_parent: 'Foster parent',
    court_appointed: 'Court-appointed',
    pediatrician: 'Pediatrician',
    admin: 'Admin',
    secretary: 'Secretary',
};

const GENDER_LABELS = { male: 'Male', female: 'Female', other: 'Other' };

const DOMAINS = [
    { key: 'communication', label: 'Communication' },
    { key: 'social', label: 'Social Skills' },
    { key: 'cognitive', label: 'Cognitive' },
    { key: 'motor', label: 'Motor Skills' },
];

// Date presets. Values are month counts back from today; null means all time.
const PRESETS = [
    { key: '3m', label: 'Last 3 months', months: 3 },
    { key: '6m', label: 'Last 6 months', months: 6 },
    { key: '12m', label: 'Last 12 months', months: 12 },
    { key: '24m', label: 'Last 24 months', months: 24 },
    { key: 'all', label: 'All time', months: null },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/** 'YYYY-MM' → 'Aug 2026', for chart axes. */
function fmtMonth(key) {
    const [y, m] = String(key || '').split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    if (Number.isNaN(d.getTime())) return String(key || '');
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function outcomeLabel(key) {
    return OUTCOME_LABELS[key] || String(key || '').replace(/_/g, ' ');
}

function roleLabel(key) {
    return ROLE_LABELS[key] || String(key || '').replace(/_/g, ' ');
}

function genderLabel(key) {
    if (key === vocabUnknown()) return 'Not recorded';
    return GENDER_LABELS[key] || String(key || '').replace(/_/g, ' ');
}

function vocabUnknown() {
    return vocab?.unknownKey || 'unknown';
}

/** Band keys high → low, from the shared band set. */
function bandKeys() {
    return (vocab?.bands || []).map((b) => b.key);
}

function bandLabel(key) {
    const hit = (vocab?.bands || []).find((b) => b.key === key);
    if (hit) return hit.label;
    return window.KCScoring ? window.KCScoring.clinicalLabel(key) : String(key || '');
}

function bandColor(key) {
    const hit = (vocab?.bands || []).find((b) => b.key === key);
    if (hit) return hit.color;
    return window.KCScoring ? window.KCScoring.colorForBand(key) : '#b6bcc2';
}

function ageBandLabel(key) {
    if (key === vocabUnknown()) return 'Age not resolvable';
    const hit = (vocab?.ageBands || []).find((b) => b.key === key);
    return hit ? hit.label : String(key || '');
}

function bandChip(bandKey) {
    if (!bandKey) return '<span class="band-chip" style="background:#b6bcc2;">Not scored</span>';
    return `<span class="band-chip" style="background:${escapeHtml(bandColor(bandKey))};">${escapeHtml(bandLabel(bandKey))}</span>`;
}

/**
 * A rate, always with its denominator. `suppressed` hides the percentage and
 * shows the raw count instead — used below the minimum-n floor, so a sample too
 * small to support a rate never displays one.
 */
function rateText(rateObj, suppressed) {
    const n = count(rateObj?.count);
    const d = count(rateObj?.denominator);
    if (suppressed || rateObj?.percent == null || d === 0) {
        return `${n} of ${d}`;
    }
    return `${rateObj.percent}% (n = ${d})`;
}

function errorCard(title, message) {
    return `
        <div class="insight-card">
            <div class="insight-empty insight-error">
                <h3>${escapeHtml(title)}</h3>
                <p>${escapeHtml(message)}</p>
            </div>
        </div>`;
}

function emptyBlock(title, body) {
    return `
        <div class="insight-empty">
            <h3>${escapeHtml(title)}</h3>
            <p>${body}</p>
        </div>`;
}

/** Destroys a previous Chart instance before redrawing into the same canvas. */
function drawChart(canvasId, config) {
    if (typeof Chart === 'undefined') return;
    const el = document.getElementById(canvasId);
    if (!el) return;
    if (charts[canvasId]) {
        charts[canvasId].destroy();
        delete charts[canvasId];
    }
    charts[canvasId] = new Chart(el, config);
}

/** True when every value in a counts object is zero. */
function allZero(counts) {
    return Object.values(counts || {}).every((v) => count(v) === 0);
}

// ── Filter state (query string is the source of truth) ──────────────────────

function currentFilters() {
    const params = new URLSearchParams(window.location.search);
    return {
        from: params.get('from') || '',
        to: params.get('to') || '',
        gender: params.get('gender') || 'all',
        ageBand: params.get('ageBand') || 'all',
    };
}

/** The query string appended to every API call. */
function filterQuery() {
    const f = currentFilters();
    const params = new URLSearchParams();
    if (f.from) params.set('from', f.from);
    if (f.to) params.set('to', f.to);
    if (f.gender && f.gender !== 'all') params.set('gender', f.gender);
    if (f.ageBand && f.ageBand !== 'all') params.set('ageBand', f.ageBand);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

/**
 * Writes the filter state into the address bar and reloads the data.
 * pushState rather than a navigation, so the back button steps through filter
 * states and a drill-down keeps whatever was selected.
 */
function setFilters(next, { replace = false } = {}) {
    const params = new URLSearchParams();
    if (next.from) params.set('from', next.from);
    if (next.to) params.set('to', next.to);
    if (next.gender && next.gender !== 'all') params.set('gender', next.gender);
    if (next.ageBand && next.ageBand !== 'all') params.set('ageBand', next.ageBand);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (replace) window.history.replaceState({}, '', url);
    else window.history.pushState({}, '', url);
    syncControlsFromUrl();
    loadAll();
}

function applyFilters() {
    setFilters({
        from: document.getElementById('filterFrom').value,
        to: document.getElementById('filterTo').value,
        gender: document.getElementById('filterGender').value,
        ageBand: document.getElementById('filterAgeBand').value,
    });
}

function resetFilters() {
    setFilters({ from: '', to: '', gender: 'all', ageBand: 'all' });
}

function applyPreset(key) {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const f = currentFilters();
    if (preset.months == null) {
        // "All time" still needs a lower bound the API will accept; the earliest
        // plausible record date is used rather than leaving `from` blank, which
        // the API would fill with its own 12-month default.
        setFilters({ ...f, from: '2000-01-01', to: '' });
        return;
    }
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - preset.months);
    setFilters({ ...f, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
}

/** Mirrors the query string into the filter controls. */
function syncControlsFromUrl() {
    const f = currentFilters();
    const fromEl = document.getElementById('filterFrom');
    const toEl = document.getElementById('filterTo');
    const genderEl = document.getElementById('filterGender');
    const ageEl = document.getElementById('filterAgeBand');
    if (fromEl) fromEl.value = f.from;
    if (toEl) toEl.value = f.to;
    if (genderEl) genderEl.value = f.gender;
    if (ageEl) ageEl.value = f.ageBand;

    const presets = document.getElementById('filterPresets');
    if (presets) {
        presets.querySelectorAll('.preset-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.preset === activePresetKey(f));
        });
    }
}

/** Which preset, if any, the current from/to happens to match. */
function activePresetKey(f) {
    if (!f.from) return null;
    if (f.from === '2000-01-01' && !f.to) return 'all';
    for (const preset of PRESETS) {
        if (preset.months == null) continue;
        const from = new Date();
        from.setMonth(from.getMonth() - preset.months);
        if (from.toISOString().slice(0, 10) === f.from) return preset.key;
    }
    return null;
}

/** Fills the sex/age dropdowns and preset buttons from the served vocabulary. */
function buildFilterControls() {
    const presets = document.getElementById('filterPresets');
    if (presets && !presets.children.length) {
        presets.innerHTML = PRESETS.map((p) => `
            <button type="button" class="preset-btn" data-preset="${escapeHtml(p.key)}"
                    onclick="applyPreset('${escapeHtml(p.key)}')">${escapeHtml(p.label)}</button>`).join('');
    }

    const genderEl = document.getElementById('filterGender');
    if (genderEl && genderEl.options.length <= 1 && vocab) {
        genderEl.innerHTML = [
            '<option value="all">All</option>',
            ...(vocab.genders || []).map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(genderLabel(g))}</option>`),
            `<option value="${escapeHtml(vocabUnknown())}">Not recorded</option>`,
        ].join('');
    }

    const ageEl = document.getElementById('filterAgeBand');
    if (ageEl && ageEl.options.length <= 1 && vocab) {
        ageEl.innerHTML = [
            '<option value="all">All</option>',
            ...(vocab.ageBands || []).map((b) => `<option value="${escapeHtml(b.key)}">${escapeHtml(b.label)}</option>`),
            `<option value="${escapeHtml(vocabUnknown())}">Age not resolvable</option>`,
        ].join('');
    }

    syncControlsFromUrl();
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — User demographics
// ═══════════════════════════════════════════════════════════════════════════

function renderUsers(data) {
    const section = document.getElementById('usersSection');
    const totals = data.totals || {};
    const total = count(totals.users);
    const guardians = data.guardianAccounts || {};

    const roleRows = (data.byRole || []).length
        ? (data.byRole || []).map((r) => `
            <tr>
                <td>${escapeHtml(roleLabel(r.role))}</td>
                <td class="num">${count(r.count)}</td>
                <td class="num">${total ? Math.round((count(r.count) / total) * 100) : 0}%</td>
            </tr>`).join('')
        : '<tr><td colspan="3" style="color:var(--text-light);">No user accounts on file.</td></tr>';

    const guardianTotal = count(guardians.withChildren) + count(guardians.withoutChildren);

    section.innerHTML = `
        <div class="insight-card">
            <h2>User Overview</h2>
            <p class="card-sub">Overview of registered KinderCura users.</p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Total Users</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">All registered accounts.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Active Users</p>
                    <p class="tile-value">${count(totals.active)}</p>
                    <p class="tile-sub">Currently active accounts.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Inactive Users</p>
                    <p class="tile-value">${count(totals.inactive)}</p>
                    <p class="tile-sub">Currently inactive accounts.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Guardians with Children</p>
                    <p class="tile-value">${count(guardians.withChildren)}</p>
                    <p class="tile-sub">Guardian accounts with at least one child.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="usersRoleChart"></canvas></div>
                    <p class="chart-caption">Accounts by role.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="usersRegistrationChart"></canvas></div>
                    <p class="chart-caption">Registration trend.</p>
                </div>
            </div>

            <h3>Accounts by Role</h3>
            <p class="card-sub" style="margin-bottom:0.6rem;">Distribution of registered users by role.</p>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Role</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
                    <tbody>${roleRows}</tbody>
                </table>
            </div>
        </div>`;

    const roleData = data.byRole || [];
    drawChart('usersRoleChart', {
        type: 'doughnut',
        data: {
            labels: roleData.map((r) => roleLabel(r.role)),
            datasets: [{
                data: roleData.map((r) => count(r.count)),
                backgroundColor: ['#6B8E6F', '#8BA98D', '#F4D89F', '#E8A5A5', '#A8C49D', '#D4897A', '#B0A8C4'],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
        },
    });

    const reg = data.registrations || [];
    drawChart('usersRegistrationChart', {
        type: 'line',
        data: {
            labels: reg.map((r) => fmtMonth(r.month)),
            datasets: [{
                label: 'Registrations',
                data: reg.map((r) => count(r.count)),
                borderColor: '#6B8E6F',
                backgroundColor: 'rgba(107,142,111,0.15)',
                fill: true,
                tension: 0.3,
                pointRadius: 2,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Child demographics
// ═══════════════════════════════════════════════════════════════════════════

function renderChildren(data) {
    const section = document.getElementById('childrenSection');
    const total = count(data.totals?.children);
    const byGender = data.byGender || {};
    const byAge = data.byAgeBand || {};
    const perParent = data.childrenPerParent || {};
    const coverage = data.screeningCoverage || {};

    if (total === 0) {
        section.innerHTML = `
            <div class="insight-card">
                <span class="section-label">Section 2</span>
                <h2>Child demographics</h2>
                ${emptyBlock('No children match these filters',
                    'No child record matches the selected sex and age band. Widen the filters, or reset them, to see the full roster.')}
            </div>`;
        return;
    }

    const ageKeys = [...(vocab?.ageBands || []).map((b) => b.key), vocabUnknown()];
    const genderKeys = [...(vocab?.genders || []), vocabUnknown()];

    section.innerHTML = `
        <div class="insight-card">
            <h2>Child Overview</h2>
            <p class="card-sub">Overview of registered children and their assessment activity.</p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Total Children</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">Registered children matching current filters.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Screened in Range</p>
                    <p class="tile-value">${count(coverage.withScreening)}</p>
                    <p class="tile-sub">Children with at least one completed screening.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Not Screened in Range</p>
                    <p class="tile-value">${count(coverage.withoutScreening)}</p>
                    <p class="tile-sub">Children without a completed screening in this period.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Sex Not Recorded</p>
                    <p class="tile-value">${count(byGender[vocabUnknown()])}</p>
                    <p class="tile-sub">Children without sex information on file.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="childrenGenderChart"></canvas></div>
                    <p class="chart-caption">Sex distribution of registered children.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="childrenAgeChart"></canvas></div>
                    <p class="chart-caption">Age distribution of registered children.</p>
                </div>
            </div>

            <h3>Children per Guardian</h3>
            <p class="card-sub" style="margin-bottom:0.6rem;">Number of children associated with each guardian account.</p>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Children on the account</th><th class="num">Guardians</th></tr></thead>
                    <tbody>
                        <tr><td>1 child</td><td class="num">${count(perParent['1'])}</td></tr>
                        <tr><td>2 children</td><td class="num">${count(perParent['2'])}</td></tr>
                        <tr><td>3 or more</td><td class="num">${count(perParent['3+'])}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>`;

    drawChart('childrenGenderChart', {
        type: 'doughnut',
        data: {
            labels: genderKeys.map(genderLabel),
            datasets: [{
                data: genderKeys.map((k) => count(byGender[k])),
                backgroundColor: ['#6B8E6F', '#E8A5A5', '#F4D89F', '#C8C8C0'],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
        },
    });

    drawChart('childrenAgeChart', {
        type: 'bar',
        data: {
            labels: ageKeys.map(ageBandLabel),
            datasets: [{
                label: 'Children',
                data: ageKeys.map((k) => count(byAge[k])),
                backgroundColor: '#8BA98D',
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Descriptive screening reports
// ═══════════════════════════════════════════════════════════════════════════

function renderScreenings(data) {
    const section = document.getElementById('screeningsSection');
    const totals = data.totals || {};
    const total = count(totals.assessments);
    const withResult = count(totals.withResult);
    const withoutResult = count(totals.withoutResult);
    const review = data.review || {};
    const custom = data.customQuestions || {};
    const keys = bandKeys();

    if (total === 0) {
        section.innerHTML = `
            <div class="insight-card">
                <h2>Screening Overview</h2>
                ${emptyBlock('No screenings match these filters',
                    'No assessment falls inside the selected date range for the selected filters. Widen the range or reset the filters.')}
            </div>`;
        return;
    }

    const overTime = data.overTime || [];
    const overallBands = data.overallBands || {};
    const ageKeys = [...(vocab?.ageBands || []).map((b) => b.key), vocabUnknown()];
    const genderKeys = [...(vocab?.genders || []), vocabUnknown()];

    // The scored charts can only describe assessments that have a linked result.
    const scoredBlock = withResult === 0
        ? emptyBlock('No scored screenings in this selection',
            'No assessments in this range have screening results available yet.')
        : `
            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="screeningsOverallChart"></canvas></div>
                    <p class="chart-caption">Overall screening results (${withResult} assessed).</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="screeningsDomainChart"></canvas></div>
                    <p class="chart-caption">Results by developmental area.</p>
                </div>
            </div>

            <h3>Overall Results by Age Band</h3>
            <div class="insight-table-wrap">
                ${crossTabTable(data.bandByAgeBand, keys, ageKeys, ageBandLabel, 'Band')}
            </div>

            <h3>Overall Results by Sex</h3>
            <div class="insight-table-wrap">
                ${crossTabTable(data.bandByGender, keys, genderKeys, genderLabel, 'Band')}
            </div>`;

    section.innerHTML = `
        <div class="insight-card">
            <h2>Screening Overview</h2>
            <p class="card-sub">Overview of completed and ongoing child assessments.</p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Assessments</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">Assessments in the selected period.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">With Results</p>
                    <p class="tile-value">${withResult}</p>
                    <p class="tile-sub">Assessments with screening results.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Without Results</p>
                    <p class="tile-value">${withoutResult}</p>
                    <p class="tile-sub">
                        ${withoutResult > 0
                            ? 'Assessments still awaiting results.'
                            : 'Every assessment in range has a result.'}
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Reviewed</p>
                    <p class="tile-value">${count(review.reviewed)}</p>
                    <p class="tile-sub">Assessments reviewed by a pediatrician.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="screeningsOverTimeChart"></canvas></div>
                    <p class="chart-caption">Assessments per month.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="screeningsLinkageChart"></canvas></div>
                    <p class="chart-caption">Assessments with results.</p>
                </div>
            </div>

            ${scoredBlock}

            <h3>Review & Follow-up</h3>
            <div class="insight-tiles" style="margin-bottom:0;">
                <div class="insight-tile">
                    <p class="tile-label">Reviewed</p>
                    <p class="tile-value">${count(review.reviewed)} / ${total}</p>
                    <p class="tile-sub">Assessments reviewed by a pediatrician.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Median Review Time</p>
                    <p class="tile-value">${review.medianDaysToReview == null ? '—' : `${review.medianDaysToReview} days`}</p>
                    <p class="tile-sub">
                        ${count(review.medianSampleSize) === 0
                            ? 'No review data available yet.'
                            : `Typical time between submission and review.`}
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Follow-up Scheduled</p>
                    <p class="tile-value">${data.nextAssessment?.rate?.percent == null ? '—' : `${data.nextAssessment.rate.percent}%`}</p>
                    <p class="tile-sub">Assessments with a follow-up date.</p>
                </div>
            </div>

            <h3>Custom Questions</h3>
            <p class="card-sub" style="margin-bottom:0.8rem;">
                Track custom questions assigned by pediatricians.
            </p>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Custom Questions</th><th class="num">Count</th></tr></thead>
                    <tbody>
                        <tr><td>Assigned</td><td class="num">${count(custom.assigned)}</td></tr>
                        <tr><td>Answered</td><td class="num">${count(custom.answered)}</td></tr>
                        <tr><td>Awaiting an Answer</td><td class="num">${Math.max(0, count(custom.assigned) - count(custom.answered))}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>`;

    drawChart('screeningsOverTimeChart', {
        type: 'bar',
        data: {
            labels: overTime.map((r) => fmtMonth(r.month)),
            datasets: [{
                label: 'Assessments',
                data: overTime.map((r) => count(r.count)),
                backgroundColor: '#6B8E6F',
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
    });

    drawChart('screeningsLinkageChart', {
        type: 'doughnut',
        data: {
            labels: ['With a scored result', 'Without a result'],
            datasets: [{
                data: [withResult, withoutResult],
                backgroundColor: ['#6B8E6F', '#D4897A'],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
        },
    });

    if (withResult > 0) {
        drawChart('screeningsOverallChart', {
            type: 'bar',
            data: {
                labels: keys.map(bandLabel),
                datasets: [{
                    label: 'Screenings',
                    data: keys.map((k) => count(overallBands[k])),
                    backgroundColor: keys.map(bandColor),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
            },
        });

        const domainBands = data.domainBands || {};
        drawChart('screeningsDomainChart', {
            type: 'bar',
            data: {
                labels: DOMAINS.map((d) => d.label),
                datasets: keys.map((bandKey) => ({
                    label: bandLabel(bandKey),
                    data: DOMAINS.map((d) => count(domainBands[d.key]?.[bandKey])),
                    backgroundColor: bandColor(bandKey),
                    borderWidth: 0,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } },
                scales: {
                    x: { stacked: true },
                    y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
                },
            },
        });
    }
}

/**
 * Band × category cross-tab. Fully enumerated: an empty cell renders as 0 rather
 * than as a gap the reader fills in themselves.
 */
function crossTabTable(matrix, bandRows, colKeys, colLabelFn, rowHeading) {
    const safe = matrix || {};
    const colTotals = colKeys.map((c) => bandRows.reduce((sum, b) => sum + count(safe[b]?.[c]), 0));
    const grand = colTotals.reduce((a, b) => a + b, 0);

    const body = bandRows.map((band) => {
        const rowTotal = colKeys.reduce((sum, c) => sum + count(safe[band]?.[c]), 0);
        return `
            <tr>
                <td class="band-head">${bandChip(band)}</td>
                ${colKeys.map((c) => {
                    const n = count(safe[band]?.[c]);
                    return `<td class="cell${n === 0 ? ' cell-zero' : ''}">${n}</td>`;
                }).join('')}
                <td class="cell total">${rowTotal}</td>
            </tr>`;
    }).join('');

    return `
        <table class="insight-table crosstab">
            <thead>
                <tr>
                    <th>${escapeHtml(rowHeading)}</th>
                    ${colKeys.map((c) => `<th class="cell">${escapeHtml(colLabelFn(c))}</th>`).join('')}
                    <th class="cell total">Total</th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
            <tfoot>
                <tr>
                    <td>Total</td>
                    ${colTotals.map((n) => `<td class="cell">${n}</td>`).join('')}
                    <td class="cell">${grand}</td>
                </tr>
            </tfoot>
        </table>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Screening performance & pediatrician concordance
// ═══════════════════════════════════════════════════════════════════════════

function methodsNote() {
    return `
        <p class="card-sub" style="margin-top:1rem;font-size:0.82rem;">
            Screening results are intended to support assessment and should be reviewed by a qualified pediatrician.
        </p>`;
}

/** The pipeline strip — shown in every state, so the section is always informative. */
function pipelineStrip(totals) {
    const steps = [
        { label: 'Assessments', value: count(totals.assessments), blocked: false },
        { label: 'With Results', value: count(totals.withBand), blocked: false },
        { label: 'Reviewed', value: count(totals.reviewed), blocked: false },
        { label: 'With Outcome', value: count(totals.labelled), blocked: count(totals.labelled) === 0 },
    ];
    return `
        <div class="pipeline-strip">
            ${steps.map((s) => `
                <div class="pipeline-step${s.blocked ? ' pipeline-blocked' : ''}">
                    <p class="pipeline-count">${s.value}</p>
                    <p class="pipeline-label">${escapeHtml(s.label)}</p>
                </div>`).join('')}
        </div>`;
}

function renderConcordance(data) {
    const section = document.getElementById('concordanceSection');
    const totals = data.totals || {};
    const agreement = data.agreement || {};
    const comparable = count(agreement.comparable);
    const minimum = count(data.threshold?.minimum);
    const suppressed = Boolean(data.threshold?.suppressed);

    const header = `
        <h2>Pediatrician Review & Outcomes</h2>
        <p class="card-sub">Summary of assessments reviewed by pediatricians.</p>`;

    // ── Empty state: no usable labelled records.
    if (comparable === 0) {
        section.innerHTML = `
            <div class="insight-card">
                ${header}
                ${pipelineStrip(totals)}
                ${emptyBlock('No reviewed outcomes available yet.',
                    'This section will populate automatically as pediatricians complete reviews and record outcomes.')}
                ${methodsNote()}
            </div>`;
        return;
    }

    // ── Below the minimum: counts only, no percentages anywhere.
    const keys = bandKeys();
    const outcomeKeys = (vocab?.outcomes || []);
    const mapping = data.mapping?.outcomeToBand || {};
    const matrix = data.matrix || {};

    const colTotals = outcomeKeys.map((o) => keys.reduce((sum, b) => sum + count(matrix[b]?.[o]), 0));
    const grand = colTotals.reduce((a, b) => a + b, 0);

    const bodyRows = keys.map((band) => {
        const rowTotal = outcomeKeys.reduce((sum, o) => sum + count(matrix[band]?.[o]), 0);
        return `
            <tr>
                <td class="band-head">${bandChip(band)}</td>
                ${outcomeKeys.map((o) => {
                    const n = count(matrix[band]?.[o]);
                    // The diagonal: the cell where this band is the one the
                    // recorded outcome corresponds to under the stated mapping.
                    const isAgree = mapping[o] === band;
                    const cls = `cell${n === 0 ? ' cell-zero' : ''}${isAgree ? ' cell-agree' : ''}`;
                    return `<td class="${cls}">${n}</td>`;
                }).join('')}
                <td class="cell total">${rowTotal}</td>
            </tr>`;
    }).join('');

    const ratesBlock = suppressed
        ? emptyBlock(
            `Not enough data yet.`,
            `At least ${minimum} reviewed outcomes are needed to show rates. The table below still shows available counts.`)
        : `
            <div class="rate-grid">
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.exact, false)}</p>
                    <p class="rate-label">Screening result matched the pediatrician's conclusion.</p>
                </div>
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.adjacent, false)}</p>
                    <p class="rate-label">Within one band of the pediatrician's conclusion.</p>
                </div>
                <div class="rate-item rate-critical">
                    <p class="rate-value">${rateText(agreement.screeningRatedBetter, false)}</p>
                    <p class="rate-label">
                        <strong>Screening showed lower concern than the pediatrician.</strong>
                    </p>
                </div>
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.screeningRatedWorse, false)}</p>
                    <p class="rate-label">Screening showed higher concern than the pediatrician.</p>
                </div>
            </div>`;

    section.innerHTML = `
        <div class="insight-card">
            ${header}
            ${pipelineStrip(totals)}
            ${ratesBlock}

            <h3>Screening vs. Pediatrician Outcome</h3>
            <p class="card-sub" style="margin-bottom:0.8rem;">
                Screening results compared with pediatrician-recorded outcomes. Highlighted cells show where both agree.
            </p>
            <div class="insight-table-wrap">
                <table class="insight-table crosstab">
                    <thead>
                        <tr>
                            <th>Screening Result</th>
                            ${outcomeKeys.map((o) => `<th class="cell">${escapeHtml(outcomeLabel(o))}</th>`).join('')}
                            <th class="cell total">Total</th>
                        </tr>
                    </thead>
                    <tbody>${bodyRows}</tbody>
                    <tfoot>
                        <tr>
                            <td>Total</td>
                            ${colTotals.map((n) => `<td class="cell">${n}</td>`).join('')}
                            <td class="cell">${grand}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
            ${methodsNote()}
        </div>`;
}

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Each section loads independently and renders its own error card, so one
 * failing endpoint leaves the other three readable rather than blanking the page.
 */
async function loadSection(endpoint, sectionId, renderFn, label) {
    const section = document.getElementById(sectionId);
    try {
        const data = await apiFetch(`/admin-reports/${endpoint}${filterQuery()}`);
        if (data.vocabulary) {
            vocab = data.vocabulary;
            buildFilterControls();
        }
        renderFn(data);
        return data;
    } catch (err) {
        console.error(`admin-insights ${endpoint} error:`, err);
        section.innerHTML = errorCard(`Could not load ${label}`, err.message || 'Request failed.');
        return null;
    }
}

async function loadAll() {
    const meta = document.getElementById('insightMeta');
    if (meta) meta.textContent = 'Loading…';

    const results = await Promise.all([
        loadSection('users', 'usersSection', renderUsers, 'user demographics'),
        loadSection('children', 'childrenSection', renderChildren, 'child demographics'),
        loadSection('screenings', 'screeningsSection', renderScreenings, 'screening reports'),
        loadSection('concordance', 'concordanceSection', renderConcordance, 'concordance'),
    ]);

    if (!meta) return;
    const applied = results.find((r) => r && r.filters);
    if (!applied) {
        meta.textContent = 'Could not load. Check the connection and try again.';
        return;
    }
    const f = applied.filters;
    const bits = [`${fmtShortDate(f.from)} – ${fmtShortDate(f.to)}`];
    if (f.gender && f.gender !== 'all') bits.push(`sex: ${genderLabel(f.gender)}`);
    if (f.ageBand && f.ageBand !== 'all') bits.push(`age: ${ageBandLabel(f.ageBand)}`);
    meta.innerHTML = `View system activity, child assessments, and screening results.<br>
        <span style="font-size:0.85em; opacity:0.8; display:inline-block; margin-top:0.3rem;">
            Data for: ${bits.join(' · ')} &nbsp;|&nbsp; Updated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
        </span>`;
}

// Back/forward through filter states re-renders rather than refetching the page.
window.addEventListener('popstate', () => {
    syncControlsFromUrl();
    loadAll();
});

document.addEventListener('DOMContentLoaded', () => {
    buildFilterControls();
    syncControlsFromUrl();
    loadAll();
    if (typeof loadNotificationCount === 'function') loadNotificationCount();
});
