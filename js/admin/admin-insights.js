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
            <span class="section-label">Section 1</span>
            <h2>User demographics</h2>
            <p class="card-sub">
                Account totals are <strong>current state</strong> and are not affected by the date
                range — "how many pediatricians exist" is not a question a date window improves. Only
                the registrations timeline below is filtered by it. The sex and age filters do not
                apply to this section at all: those fields live on a child record, and a user account
                has neither.
            </p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Total users</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">All accounts of every role.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Active</p>
                    <p class="tile-value">${count(totals.active)}</p>
                    <p class="tile-sub">
                        Defined as <code>${escapeHtml(totals.activeField || 'User.status')}</code> =
                        <code>${escapeHtml(totals.activeValue || 'active')}</code>.
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Inactive</p>
                    <p class="tile-value">${count(totals.inactive)}</p>
                    <p class="tile-sub">Every account whose status is anything else (pending, suspended).</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Guardians with a child</p>
                    <p class="tile-value">${count(guardians.withChildren)}</p>
                    <p class="tile-sub">${guardianTotal
                        ? `${count(guardians.withoutChildren)} of ${guardianTotal} guardian ${plural(guardianTotal, 'account')} ${count(guardians.withoutChildren) === 1 ? 'has' : 'have'} no child record.`
                        : 'No guardian accounts on file.'}</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="usersRoleChart"></canvas></div>
                    <p class="chart-caption">Accounts by role (current state).</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="usersRegistrationChart"></canvas></div>
                    <p class="chart-caption">Registrations per month, within the selected date range.</p>
                </div>
            </div>

            <h3>Accounts by role</h3>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Role</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
                    <tbody>${roleRows}</tbody>
                </table>
            </div>

            <p class="card-footnote">
                "Guardian accounts" covers every non-staff role that can own a child record:
                ${escapeHtml((guardians.roles || []).map(roleLabel).join(', ') || '—')}. A guardian with
                no child has registered but not yet added one.
            </p>
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
            <span class="section-label">Section 2</span>
            <h2>Child demographics</h2>
            <p class="card-sub">
                Children currently on file matching the sex and age filters.
                <strong>Age here is current age</strong> — months from date of birth to today. This is a
                different quantity from the age band in Sections 3 and 4, which is age
                <em>at the assessment</em>. A child moves between bands as time passes, so the two will
                not always agree. There is no geographic breakdown: no location field exists on a child
                or a user record.
            </p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Total children</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">Matching the current sex and age filters.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Screened in range</p>
                    <p class="tile-value">${count(coverage.withScreening)}</p>
                    <p class="tile-sub">Has at least one completed screening inside the date range.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Not screened in range</p>
                    <p class="tile-value">${count(coverage.withoutScreening)}</p>
                    <p class="tile-sub">No completed screening inside the date range — not necessarily none ever.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Sex not recorded</p>
                    <p class="tile-value">${count(byGender[vocabUnknown()])}</p>
                    <p class="tile-sub">Children whose sex is absent from the record.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="childrenGenderChart"></canvas></div>
                    <p class="chart-caption">Sex distribution.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="childrenAgeChart"></canvas></div>
                    <p class="chart-caption">Age distribution — <strong>current age</strong>, not age at assessment.</p>
                </div>
            </div>

            <h3>Children per guardian</h3>
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

            <p class="card-footnote">
                Age bands follow the age gates the screening instrument itself uses — the question bank
                is served by minimum age in months, so a band boundary is a point where a child is asked
                a different set of questions. They are demographic strata only and never affect a score.
            </p>
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
                <span class="section-label">Section 3</span>
                <h2>Descriptive screening reports</h2>
                ${emptyBlock('No screenings match these filters',
                    'No assessment falls inside the selected date range for the selected sex and age band. Widen the range, or reset the filters.')}
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
            `All ${total} ${plural(total, 'assessment')} in range ${total === 1 ? 'is' : 'are'} missing a linked result document, so no band can be computed for any of them. The counts above still hold; there is simply nothing to band.`)
        : `
            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="screeningsOverallChart"></canvas></div>
                    <p class="chart-caption">Overall band — computed from the stored overall score (n = ${withResult}).</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="screeningsDomainChart"></canvas></div>
                    <p class="chart-caption">Per-domain bands, as stored on the result documents (each bar totals ${withResult}).</p>
                </div>
            </div>

            <h3>Overall band by age band <span style="font-weight:400;color:var(--text-light);font-size:0.85em;">(age at assessment)</span></h3>
            <div class="insight-table-wrap">
                ${crossTabTable(data.bandByAgeBand, keys, ageKeys, ageBandLabel, 'Band')}
            </div>

            <h3>Overall band by sex</h3>
            <div class="insight-table-wrap">
                ${crossTabTable(data.bandByGender, keys, genderKeys, genderLabel, 'Band')}
            </div>`;

    section.innerHTML = `
        <div class="insight-card">
            <span class="section-label">Section 3</span>
            <h2>Descriptive screening reports</h2>
            <p class="card-sub">
                Counts of the screenings on file. <strong>Age band here is age at the assessment</strong>,
                computed against each screening's own date rather than against today.
            </p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Assessments</p>
                    <p class="tile-value">${total}</p>
                    <p class="tile-sub">In range, matching the sex and age filters.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">With a scored result</p>
                    <p class="tile-value">${withResult}</p>
                    <p class="tile-sub">Has a linked result document carrying a score.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Without a result</p>
                    <p class="tile-value">${withoutResult}</p>
                    <p class="tile-sub">
                        ${withoutResult > 0
                            ? 'Cannot be banded. This caps every scored chart below.'
                            : 'Every assessment in range has a result.'}
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Reviewed</p>
                    <p class="tile-value">${count(review.reviewed)}</p>
                    <p class="tile-sub">
                        ${count(review.unreviewed)} ${plural(count(review.unreviewed), 'assessment')}
                        ${count(review.unreviewed) === 1 ? 'has' : 'have'} no review on record.
                    </p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="screeningsOverTimeChart"></canvas></div>
                    <p class="chart-caption">Assessments per month, by completion date (or start date when never completed).</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="screeningsLinkageChart"></canvas></div>
                    <p class="chart-caption">Assessments with vs without a linked result document.</p>
                </div>
            </div>

            ${scoredBlock}

            <h3>Review and follow-up</h3>
            <div class="insight-tiles" style="margin-bottom:0;">
                <div class="insight-tile">
                    <p class="tile-label">Reviewed</p>
                    <p class="tile-value">${count(review.reviewed)} / ${total}</p>
                    <p class="tile-sub">Counted from the review timestamp, not from whether an outcome was labelled.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Median time to review</p>
                    <p class="tile-value">${review.medianDaysToReview == null ? '—' : `${review.medianDaysToReview}d`}</p>
                    <p class="tile-sub">
                        ${count(review.medianSampleSize) === 0
                            ? 'No reviewed screening has both timestamps.'
                            : `From submission to review, over ${count(review.medianSampleSize)} reviewed ${plural(count(review.medianSampleSize), 'screening')}.`}
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Next assessment date set</p>
                    <p class="tile-value">${data.nextAssessment?.rate?.percent == null ? '—' : `${data.nextAssessment.rate.percent}%`}</p>
                    <p class="tile-sub">${rateText(data.nextAssessment?.rate, false)} of assessments carry a follow-up date.</p>
                </div>
            </div>

            <h3>Custom pediatrician questions <span class="unscored-chip">Unscored</span></h3>
            <p class="card-sub" style="margin-bottom:0.8rem;">
                Questions a pediatrician wrote and assigned to a specific child. These are counted here
                for volume only. <strong>They never enter any band computation</strong> — the screening
                score is built from the fixed core question bank alone, and nothing in this section's
                distributions above includes them.
            </p>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Custom questions</th><th class="num">Count</th></tr></thead>
                    <tbody>
                        <tr><td>Assigned in range</td><td class="num">${count(custom.assigned)}</td></tr>
                        <tr><td>Answered</td><td class="num">${count(custom.answered)}</td></tr>
                        <tr><td>Awaiting an answer</td><td class="num">${Math.max(0, count(custom.assigned) - count(custom.answered))}</td></tr>
                    </tbody>
                </table>
            </div>

            <p class="card-footnote">
                The per-domain chart shows the band strings <strong>as stored</strong> on each result
                document — it is not recomputed here, so it reflects exactly what other pages read. The
                overall band is not stored anywhere and is computed from the stored overall score using
                the shared band set.
            </p>
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

function methodsNote(data) {
    const mapping = data.mapping || {};
    const pairs = Object.entries(mapping.outcomeToBand || {});
    return `
        <div class="methods-note">
            <p>
                <strong>Method.</strong> ${escapeHtml(data.methodsNote || '')}
            </p>
            <p style="margin-top:0.6rem;">
                <strong>Outcome-to-band correspondence</strong>
                <span class="assumption-chip">Assumption — pending pediatrician confirmation</span><br>
                ${pairs.map(([outcome, band]) =>
                    `${escapeHtml(outcomeLabel(outcome))} &rarr; ${escapeHtml(bandLabel(band))}`).join(' &middot; ')}
                ${(mapping.excludedOutcomes || []).length
                    ? `<br><em>${escapeHtml((mapping.excludedOutcomes || []).map(outcomeLabel).join(', '))}</em>
                       ${(mapping.excludedOutcomes || []).length === 1 ? 'is' : 'are'} excluded from every rate and counted
                       separately: a reviewer recording that no conclusion was possible has not disagreed with anything.`
                    : ''}
            </p>
            <p style="margin-top:0.6rem;">
                Agreement here is not independent evidence. The reviewing pediatrician sees the
                screening scores on the same page as the form where the outcome is recorded, so these
                counts partly reflect the influence of the score on the reviewer.
            </p>
        </div>`;
}

/** The pipeline strip — shown in every state, so the section is always informative. */
function pipelineStrip(totals) {
    const steps = [
        { label: 'Assessments in range', value: count(totals.assessments), blocked: false },
        { label: 'With a computed band', value: count(totals.withBand), blocked: false },
        { label: 'Reviewed by a pediatrician', value: count(totals.reviewed), blocked: false },
        { label: 'With an outcome label', value: count(totals.labelled), blocked: count(totals.labelled) === 0 },
        { label: 'Usable (labelled + banded)', value: count(totals.usable), blocked: count(totals.usable) === 0 },
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
        <span class="section-label">Section 4</span>
        <h2>Screening bands vs recorded clinical outcome</h2>
        <p class="card-sub">
            How the rule-based screening classified each child, set against the structured conclusion
            the reviewing pediatrician recorded. Ground truth is the recorded clinical outcome and
            nothing else — the free-text diagnosis is never read, and neither is a progress note.
        </p>`;

    // ── Empty state: no usable labelled records. No chart shell is rendered.
    if (comparable === 0) {
        const labelled = count(totals.labelled);
        const explanation = labelled === 0
            ? `No assessment in this selection carries a recorded clinical outcome. Labelling begins when
               a pediatrician selects a structured conclusion in the diagnosis form; an outcome is never
               inferred from the written diagnosis. This section fills in automatically as that happens.`
            : `${labelled} ${plural(labelled, 'assessment')} in this selection ${labelled === 1 ? 'carries' : 'carry'} an
               outcome label, but ${count(totals.labelledWithoutBand) > 0
                    ? `${count(totals.labelledWithoutBand)} of them ${count(totals.labelledWithoutBand) === 1 ? 'has' : 'have'} no linked result document, so no band exists to compare against`
                    : 'none can be compared'}. Only outcomes with a corresponding band enter the matrix.`;

        section.innerHTML = `
            <div class="insight-card">
                ${header}
                ${emptyBlock(
                    `${labelled} labelled ${plural(labelled, 'review')} available — concordance cannot yet be reported.`,
                    explanation)}
                ${pipelineStrip(totals)}
                <p class="card-footnote">
                    The steps above read left to right: an assessment must be both scored and labelled
                    before it can appear in an agreement matrix. The highlighted step is where the
                    pipeline currently stops.
                </p>
                ${methodsNote(data)}
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
            `Only ${comparable} comparable ${plural(comparable, 'record')} — below the minimum of ${minimum}.`,
            `Rates are withheld until there are at least ${minimum} comparable records. At this sample size a
             single record moves a percentage by tens of points, so counts are shown instead. The matrix
             below is still shown, because a contingency table of ${comparable} ${plural(comparable, 'record')} is
             readable as counts without implying a rate.`)
        : `
            <div class="rate-grid">
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.exact, false)}</p>
                    <p class="rate-label">Exact agreement — screening band matches the outcome's corresponding band.</p>
                </div>
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.adjacent, false)}</p>
                    <p class="rate-label">Within one band — exact agreement plus neighbouring bands.</p>
                </div>
                <div class="rate-item rate-critical">
                    <p class="rate-value">${rateText(agreement.screeningRatedBetter, false)}</p>
                    <p class="rate-label">
                        <strong>Screening read healthier than the reviewer concluded.</strong>
                        This is the direction that matters: a concern the screening did not raise.
                    </p>
                </div>
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.screeningRatedWorse, false)}</p>
                    <p class="rate-label">Screening read more concerning than the reviewer concluded.</p>
                </div>
            </div>`;

    section.innerHTML = `
        <div class="insight-card">
            ${header}
            ${pipelineStrip(totals)}
            ${ratesBlock}

            <h3>Agreement matrix</h3>
            <p class="card-sub" style="margin-bottom:0.8rem;">
                Rows are the computed screening band; columns are the outcome recorded at review. Read
                as counts of assessments. Shaded cells are where the two agree under the stated
                correspondence.
                ${count(agreement.excluded) > 0
                    ? `<br>${count(agreement.excluded)} ${plural(count(agreement.excluded), 'record')} with an excluded outcome
                       ${count(agreement.excluded) === 1 ? 'is' : 'are'} shown in the table but left out of every rate above.`
                    : ''}
            </p>
            <div class="insight-table-wrap">
                <table class="insight-table crosstab">
                    <thead>
                        <tr>
                            <th>Screening band</th>
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
            ${methodsNote(data)}
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
    meta.textContent = `Aggregate counts · ${bits.join(' · ')} · generated ${new Date().toLocaleString()}`;
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
