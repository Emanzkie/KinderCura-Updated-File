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
    // UTC: the API applies the range in UTC (a date-only `to` becomes
    // 23:59:59.999Z), so local formatting showed "Sep 30" as "Oct 1" east of UTC.
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
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

// ── Shares, partial months and chart labelling ──────────────────────────────

/** part ÷ whole as "12.3%", "<0.1%" for a non-zero share under 0.05%, or null. */
function sharePct(part, whole) {
    const p = count(part);
    const w = count(whole);
    if (w <= 0 || p > w) return null;
    const pct = (p / w) * 100;
    if (pct > 0 && pct < 0.05) return '<0.1%';
    return `${pct.toFixed(1)}%`;
}

/** "12.3% of 1,720 <noun>", or "N/A (no <noun>)" when there is no denominator. */
function shareOf(part, whole, noun) {
    const s = sharePct(part, whole);
    return s == null ? `N/A (no ${noun})` : `${s} of ${fmtN(whole)} ${noun}`;
}

function fmtN(value) {
    return count(value).toLocaleString('en-US');
}

/**
 * Month keys ('YYYY-MM', UTC — the server buckets with $dateToString) that the
 * selected range covers only partly: the first month when the range starts
 * after the 1st, the last when it ends before the month does. Their bars and
 * points are drawn differently so a short month is not read as a drop.
 */
function partialMonthKeys(rows, filters) {
    const keys = new Set();
    if (!rows.length || !filters) return keys;
    const from = filters.from ? new Date(filters.from) : null;
    const to = filters.to ? new Date(filters.to) : null;
    if (from && !Number.isNaN(from.getTime()) && from.getUTCDate() !== 1) keys.add(rows[0].month);
    if (to && !Number.isNaN(to.getTime())) {
        const monthEnd = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0, 23, 59, 59, 999));
        if (to < monthEnd) keys.add(rows[rows.length - 1].month);
    }
    return keys;
}

function monthLabel(row, partial) {
    return partial.has(row.month) ? `${fmtMonth(row.month)} (partial)` : fmtMonth(row.month);
}

function partialNote(partial) {
    return partial.size
        ? ` Months marked "(partial)" are only partly inside the selected range, so they are not comparable with full months.`
        : '';
}

/** Axis title config for Chart.js. */
function axisTitle(text) {
    return { display: true, text, font: { size: 11 } };
}

/** Doughnut tooltip: "Label: 1,218 (80.9% of 1,506 <noun>)". */
function shareTooltip(noun) {
    return {
        callbacks: {
            label: (ctx) => {
                const total = ctx.dataset.data.reduce((a, b) => a + count(b), 0);
                return `${ctx.label}: ${fmtN(ctx.parsed)} (${shareOf(ctx.parsed, total, noun)})`;
            },
        },
    };
}

/** Score range for a band key from constants/scoring.js, e.g. "80–100". */
function bandRange(key) {
    const b = window.KCScoring && window.KCScoring.THRESHOLD_RANGES && window.KCScoring.THRESHOLD_RANGES[key];
    return b ? `${b.min}–${b.max}` : '';
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

    // routes/admin-reports.js GET /users: role, status and guardian totals are
    // CURRENT state and ignore every filter; only the registrations timeline
    // follows the date range. Sex/age filters never apply to accounts.
    const roleRows = (data.byRole || []).length
        ? (data.byRole || []).map((r) => `
            <tr>
                <td>${escapeHtml(roleLabel(r.role))}</td>
                <td class="num">${fmtN(r.count)}</td>
                <td class="num">${sharePct(r.count, total) ?? 'N/A'}</td>
            </tr>`).join('')
            + `<tr class="total-row"><td>All accounts</td><td class="num">${fmtN(total)}</td><td class="num">${total ? '100%' : 'N/A'}</td></tr>`
        : '<tr><td colspan="3" style="color:var(--text-light);">No user accounts on file.</td></tr>';

    const guardianTotal = count(guardians.withChildren) + count(guardians.withoutChildren);
    const statusText = (data.byStatus || [])
        .filter((s) => s.status !== (totals.activeValue || 'active') && count(s.count) > 0)
        .map((s) => `${fmtN(s.count)} ${escapeHtml(s.status)}`)
        .join(' · ');

    const reg = data.registrations || [];
    const regPartial = partialMonthKeys(reg, data.filters);
    const regTotal = reg.reduce((sum, r) => sum + count(r.count), 0);

    section.innerHTML = `
        <div class="insight-card">
            <h2>User Overview</h2>
            <p class="card-sub">Overview of registered KinderCura users.</p>
            <p class="scope-note">The four tiles, the role chart and the role table are <strong>current totals for every account</strong>; the date range does not change them, and the sex and age filters do not apply to user accounts. Only the registration chart follows the date range.</p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Total Users</p>
                    <p class="tile-value">${fmtN(total)}</p>
                    <p class="tile-sub">All registered accounts, every role and status.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Active Users</p>
                    <p class="tile-value">${fmtN(totals.active)}</p>
                    <p class="tile-sub">Account status active: ${shareOf(totals.active, total, 'accounts')}.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Inactive Users</p>
                    <p class="tile-value">${fmtN(totals.inactive)}</p>
                    <p class="tile-sub">Any status other than active${statusText ? ` (${statusText})` : ''}: ${shareOf(totals.inactive, total, 'accounts')}.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Guardians with Children</p>
                    <p class="tile-value">${fmtN(guardians.withChildren)}</p>
                    <p class="tile-sub">Parent and guardian-role accounts with at least one child record: ${shareOf(guardians.withChildren, guardianTotal, 'guardian accounts')}.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="usersRoleChart" role="img" aria-label="Doughnut chart: user accounts by role"></canvas></div>
                    <p class="chart-caption">Accounts by role (current, all ${fmtN(total)} accounts). Hover a slice for its share.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="usersRegistrationChart" role="img" aria-label="Line chart: new accounts per month"></canvas></div>
                    <p class="chart-caption">New accounts per month by account creation date (${fmtN(regTotal)} in the selected range).${partialNote(regPartial)}</p>
                </div>
            </div>

            <h3>Accounts by Role</h3>
            <p class="card-sub" style="margin-bottom:0.6rem;">Share = accounts with that role ÷ all ${fmtN(total)} accounts (current, every status).</p>
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
                // KinderCura palette only: greens, yellow, pink, red-brown,
                // light brown, gray (the former lavender was off-palette).
                backgroundColor: ['#6B8E6F', '#8BA98D', '#F4D89F', '#E8A5A5', '#A8C49D', '#D4897A', '#C9A27E'],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: shareTooltip('accounts'),
            },
        },
    });

    // Straight segments: a smoothed curve invents values between months and
    // can dip below zero. The segment into a partial month is dashed.
    drawChart('usersRegistrationChart', {
        type: 'line',
        data: {
            labels: reg.map((r) => monthLabel(r, regPartial)),
            datasets: [{
                label: 'New accounts',
                data: reg.map((r) => count(r.count)),
                borderColor: '#6B8E6F',
                backgroundColor: 'rgba(107,142,111,0.15)',
                fill: true,
                tension: 0,
                pointRadius: 2,
                segment: {
                    borderDash: (ctx) => ((regPartial.has(reg[ctx.p1DataIndex]?.month) || regPartial.has(reg[ctx.p0DataIndex]?.month)) ? [6, 4] : undefined),
                },
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: { callbacks: { label: (ctx) => `${fmtN(ctx.parsed.y)} new account${ctx.parsed.y === 1 ? '' : 's'}` } },
            },
            scales: {
                x: { title: axisTitle('Month account was created (UTC)') },
                y: { beginAtZero: true, ticks: { precision: 0 }, title: axisTitle('New accounts') },
            },
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
                <h2>Child Overview</h2>
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
            <p class="scope-note">The sex and age filters apply to every figure here, using each child's <strong>current age</strong> (today), not age at assessment. The date range applies only to Assessed / Not Assessed in Range.</p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Total Children</p>
                    <p class="tile-value">${fmtN(total)}</p>
                    <p class="tile-sub">Child records matching the sex and age filters (not narrowed by dates).</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Assessed in Range</p>
                    <p class="tile-value">${fmtN(coverage.withScreening)}</p>
                    <p class="tile-sub">Children with at least one completed assessment in the date range: ${shareOf(coverage.withScreening, total, 'children')}.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Not Assessed in Range</p>
                    <p class="tile-value">${fmtN(coverage.withoutScreening)}</p>
                    <p class="tile-sub">No completed assessment in the date range (they may have one outside it): ${shareOf(coverage.withoutScreening, total, 'children')}.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Sex Not Recorded</p>
                    <p class="tile-value">${fmtN(byGender[vocabUnknown()])}</p>
                    <p class="tile-sub">Child records with no sex on file.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="childrenGenderChart" role="img" aria-label="Doughnut chart: children by sex"></canvas></div>
                    <p class="chart-caption">Children by sex (${fmtN(total)} child records). Hover a slice for its share.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="childrenAgeChart" role="img" aria-label="Bar chart: children by current age band"></canvas></div>
                    <p class="chart-caption">Children by current age band (${fmtN(total)} child records).</p>
                </div>
            </div>

            <h3>Children per Guardian</h3>
            <p class="card-sub" style="margin-bottom:0.6rem;">How many child records share the same owner account, counted from the child records matching the filters.</p>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Children on the account</th><th class="num">Owner accounts</th></tr></thead>
                    <tbody>
                        <tr><td>1 child</td><td class="num">${fmtN(perParent['1'])}</td></tr>
                        <tr><td>2 children</td><td class="num">${fmtN(perParent['2'])}</td></tr>
                        <tr><td>3 or more</td><td class="num">${fmtN(perParent['3+'])}</td></tr>
                        <tr class="total-row"><td>All owner accounts</td><td class="num">${fmtN(count(perParent['1']) + count(perParent['2']) + count(perParent['3+']))}</td></tr>
                    </tbody>
                </table>
            </div>
            <p class="card-sub" id="guardianReconciliation" style="margin-top:0.6rem;"></p>
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
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: shareTooltip('children'),
            },
        },
    });

    drawChart('childrenAgeChart', {
        type: 'bar',
        data: {
            labels: ageKeys.map(ageBandLabel),
            datasets: [{
                label: 'Children (current age)',
                data: ageKeys.map((k) => count(byAge[k])),
                backgroundColor: '#8BA98D',
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: { callbacks: { label: (ctx) => `${fmtN(ctx.parsed.y)} children (${shareOf(ctx.parsed.y, total, 'children')})` } },
            },
            scales: {
                x: { title: axisTitle('Current age band') },
                y: { beginAtZero: true, ticks: { precision: 0 }, title: axisTitle('Children') },
            },
        },
    });
}

/**
 * "Guardians with Children" (users section: existing parent/guardian-role
 * accounts with a child) and Children per Guardian (children section: every
 * owner id on a child record) use different populations. Explains the gap
 * instead of forcing them to match. Only meaningful with no sex/age filter,
 * because those narrow the child records but not the accounts.
 */
function annotateGuardianReconciliation(usersData, childrenData) {
    const el = document.getElementById('guardianReconciliation');
    if (!el || !usersData || !childrenData) return;
    const f = currentFilters();
    const perParent = childrenData.childrenPerParent || {};
    const owners = count(perParent['1']) + count(perParent['2']) + count(perParent['3+']);
    const guardians = count(usersData.guardianAccounts?.withChildren);
    if ((f.gender && f.gender !== 'all') || (f.ageBand && f.ageBand !== 'all')) {
        el.textContent = 'With a sex or age filter applied, this table counts only the owners of the matching children, so it is not comparable with Guardians with Children above.';
        return;
    }
    el.textContent = owners === guardians
        ? `These ${fmtN(owners)} owner accounts match Guardians with Children above.`
        : `${fmtN(owners)} owner accounts here vs ${fmtN(guardians)} Guardians with Children above: this table counts every owner recorded on a child record, while the tile counts only existing parent and guardian-role accounts. The difference of ${fmtN(Math.abs(owners - guardians))} is owners recorded on child records that are not a current parent or guardian account.`;
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
                <h2>Assessment Overview</h2>
                ${emptyBlock('No assessments match these filters',
                    'No assessment falls inside the selected date range for the selected filters. Widen the range or reset the filters.')}
            </div>`;
        return;
    }

    const overTime = data.overTime || [];
    const overTimePartial = partialMonthKeys(overTime, data.filters);
    // Domain bars only show the four score bands; a result with no stored
    // band for a domain lands in the server's unknown bucket and is left out.
    const domainUnknown = DOMAINS.reduce((sum, d) => sum + count((data.domainBands || {})[d.key]?.[vocabUnknown()]), 0);
    const domainCaption = domainUnknown === 0
        ? `Each bar is all ${fmtN(withResult)} scored assessments split by that domain's own band, so every assessment appears once in every bar. Counts are assessments, not children.`
        : `Each bar splits the ${fmtN(withResult)} scored assessments by that domain's own band; ${fmtN(domainUnknown)} domain result(s) have no stored band and are not shown. Counts are assessments, not children.`;
    const overallBands = data.overallBands || {};
    const ageKeys = [...(vocab?.ageBands || []).map((b) => b.key), vocabUnknown()];
    const genderKeys = [...(vocab?.genders || []), vocabUnknown()];

    // The scored charts can only describe assessments that have a linked result.
    const scoredBlock = withResult === 0
        ? emptyBlock('No scored assessments in this selection',
            'No assessments in this range have assessment results available yet.')
        : `
            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="screeningsOverallChart" role="img" aria-label="Bar chart: scored assessments by overall score band"></canvas></div>
                    <p class="chart-caption">Scored assessments by overall score band (${fmtN(withResult)} with a result). Bands are screening ranges of the overall score, not diagnoses.</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="screeningsDomainChart" role="img" aria-label="Stacked bar chart: scored assessments by band in each developmental domain"></canvas></div>
                    <p class="chart-caption">${domainCaption}</p>
                </div>
            </div>

            <h3>Overall Results by Age Band</h3>
            <p class="card-sub" style="margin-bottom:0.6rem;">Scored assessments by overall band and the child's <strong>age at the assessment</strong> (unlike Child Overview, which uses current age).</p>
            <div class="insight-table-wrap">
                ${crossTabTable(data.bandByAgeBand, keys, ageKeys, ageBandLabel, 'Band')}
            </div>

            <h3>Overall Results by Sex</h3>
            <p class="card-sub" style="margin-bottom:0.6rem;">Scored assessments by overall band and the child's recorded sex. These are counts, not rates: they are not adjusted for how many children of each sex were assessed.</p>
            <div class="insight-table-wrap">
                ${crossTabTable(data.bandByGender, keys, genderKeys, genderLabel, 'Band')}
            </div>`;

    section.innerHTML = `
        <div class="insight-card">
            <h2>Assessment Overview</h2>
            <p class="card-sub">Overview of completed and ongoing child assessments.</p>
            <p class="scope-note">Counts <strong>assessment sessions of any status</strong> (in progress, submitted or complete) dated inside the range — by completion date, or start date if not completed — for children matching the sex filter and, for age, the child's age at the assessment. One child can have several sessions.</p>

            <div class="insight-tiles">
                <div class="insight-tile">
                    <p class="tile-label">Assessments</p>
                    <p class="tile-value">${fmtN(total)}</p>
                    <p class="tile-sub">Sessions of any status in the selected range.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">With Results</p>
                    <p class="tile-value">${fmtN(withResult)}</p>
                    <p class="tile-sub">Sessions with a scored result: ${shareOf(withResult, total, 'sessions')}.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Without Results</p>
                    <p class="tile-value">${fmtN(withoutResult)}</p>
                    <p class="tile-sub">
                        ${withoutResult > 0
                            ? `No scored result: sessions still in progress, or submitted without a stored result (${shareOf(withoutResult, total, 'sessions')}).`
                            : 'Every session in range has a scored result.'}
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Reviewed</p>
                    <p class="tile-value">${fmtN(review.reviewed)}</p>
                    <p class="tile-sub">Sessions with a recorded pediatrician review: ${shareOf(review.reviewed, total, 'sessions')}.</p>
                </div>
            </div>

            <div class="chart-row">
                <div>
                    <div class="chart-box"><canvas id="screeningsOverTimeChart" role="img" aria-label="Bar chart: assessment sessions per month"></canvas></div>
                    <p class="chart-caption">Assessment sessions per month, any status (${fmtN(total)} in range).${partialNote(overTimePartial)}</p>
                </div>
                <div>
                    <div class="chart-box"><canvas id="screeningsLinkageChart" role="img" aria-label="Doughnut chart: sessions with and without a scored result"></canvas></div>
                    <p class="chart-caption">Sessions with and without a scored result (${fmtN(total)} sessions). Hover a slice for its share.</p>
                </div>
            </div>

            ${scoredBlock}

            <h3>Review & Follow-up</h3>
            <div class="insight-tiles" style="margin-bottom:0;">
                <div class="insight-tile">
                    <p class="tile-label">Reviewed</p>
                    <p class="tile-value">${fmtN(review.reviewed)} / ${fmtN(total)}</p>
                    <p class="tile-sub">Sessions in range with a recorded pediatrician review, out of all sessions in range.</p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Median Review Time</p>
                    <p class="tile-value">${review.medianDaysToReview == null ? '—' : `${review.medianDaysToReview} days`}</p>
                    <p class="tile-sub">
                        ${count(review.medianSampleSize) === 0
                            ? 'No review data available yet.'
                            : `Median days from the session's completion (or start) date to its review, based on ${fmtN(review.medianSampleSize)} reviewed session${count(review.medianSampleSize) === 1 ? '' : 's'}${count(review.medianSampleSize) < 10 ? ' — too few to describe a typical review time' : ''}.`}
                    </p>
                </div>
                <div class="insight-tile">
                    <p class="tile-label">Follow-up Scheduled</p>
                    <p class="tile-value">${data.nextAssessment?.rate?.percent == null ? 'N/A' : `${data.nextAssessment.rate.percent}%`}</p>
                    <p class="tile-sub">${data.nextAssessment?.rate?.percent == null
                        ? 'No sessions in range to divide by.'
                        : `Sessions with a next-assessment date set: ${fmtN(data.nextAssessment.set)} of ${fmtN(total)} sessions in range.`}</p>
                </div>
            </div>

            <h3>Custom Questions</h3>
            <p class="card-sub" style="margin-bottom:0.8rem;">
                Pediatrician-written questions sent to a child, created in the selected range. One question sent to one child is one assignment; the sex and age filters do not apply here.
            </p>
            <div class="insight-table-wrap">
                <table class="insight-table">
                    <thead><tr><th>Question assignments</th><th class="num">Count</th></tr></thead>
                    <tbody>
                        <tr><td>Assigned</td><td class="num">${fmtN(custom.assigned)}</td></tr>
                        <tr><td>Answered</td><td class="num">${fmtN(custom.answered)}</td></tr>
                        <tr><td>Awaiting an Answer</td><td class="num">${fmtN(Math.max(0, count(custom.assigned) - count(custom.answered)))}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>`;

    drawChart('screeningsOverTimeChart', {
        type: 'bar',
        data: {
            labels: overTime.map((r) => monthLabel(r, overTimePartial)),
            datasets: [{
                label: 'Assessment sessions (any status)',
                data: overTime.map((r) => count(r.count)),
                // A partial month is drawn lighter so it is not read as a drop.
                backgroundColor: overTime.map((r) => (overTimePartial.has(r.month) ? 'rgba(107,142,111,0.4)' : '#6B8E6F')),
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: { callbacks: { label: (ctx) => `${fmtN(ctx.parsed.y)} session${ctx.parsed.y === 1 ? '' : 's'}` } },
            },
            scales: {
                x: { title: axisTitle('Month (completion date, or start date if not completed; UTC)') },
                y: { beginAtZero: true, ticks: { precision: 0 }, title: axisTitle('Assessment sessions') },
            },
        },
    });

    drawChart('screeningsLinkageChart', {
        type: 'doughnut',
        data: {
            labels: ['With a scored result', 'Without a scored result'],
            datasets: [{
                data: [withResult, withoutResult],
                backgroundColor: ['#6B8E6F', '#D4897A'],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: shareTooltip('sessions'),
            },
        },
    });

    if (withResult > 0) {
        drawChart('screeningsOverallChart', {
            type: 'bar',
            data: {
                labels: keys.map((k) => (bandRange(k) ? `${bandLabel(k)} (${bandRange(k)})` : bandLabel(k))),
                datasets: [{
                    label: 'Scored assessments',
                    data: keys.map((k) => count(overallBands[k])),
                    backgroundColor: keys.map(bandColor),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    // Categories are named on the x-axis with their score
                    // ranges; the bar colour repeats the band colour used in
                    // the tables below, so a single-series legend would add
                    // nothing.
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => `${fmtN(ctx.parsed.y)} assessments (${shareOf(ctx.parsed.y, withResult, 'scored')})` } },
                },
                scales: {
                    x: { title: axisTitle('Overall score band (score range)') },
                    y: { beginAtZero: true, ticks: { precision: 0 }, title: axisTitle('Scored assessments') },
                },
            },
        });

        const domainBands = data.domainBands || {};
        drawChart('screeningsDomainChart', {
            type: 'bar',
            data: {
                labels: DOMAINS.map((d) => d.label),
                datasets: keys.map((bandKey) => ({
                    label: bandRange(bandKey) ? `${bandLabel(bandKey)} (${bandRange(bandKey)})` : bandLabel(bandKey),
                    data: DOMAINS.map((d) => count(domainBands[d.key]?.[bandKey])),
                    backgroundColor: bandColor(bandKey),
                    borderWidth: 0,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtN(ctx.parsed.y)} (${shareOf(ctx.parsed.y, withResult, 'scored')})` } },
                },
                scales: {
                    x: { stacked: true, title: axisTitle('Developmental domain') },
                    y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: axisTitle('Scored assessments') },
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
            Assessment results are intended to support care planning and should be reviewed by a qualified pediatrician.
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
        <p class="card-sub">Summary of assessments reviewed by pediatricians.</p>
        <p class="scope-note">The four counts below are assessment sessions in the selected range at each stage: all sessions, those with a scored result, those reviewed, and those with a pediatrician-recorded outcome. Rates appear only once at least ${fmtN(minimum)} sessions can be compared.</p>`;

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
                    <p class="rate-label">Assessment result matched the pediatrician's conclusion.</p>
                </div>
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.adjacent, false)}</p>
                    <p class="rate-label">Within one band of the pediatrician's conclusion.</p>
                </div>
                <div class="rate-item rate-critical">
                    <p class="rate-value">${rateText(agreement.screeningRatedBetter, false)}</p>
                    <p class="rate-label">
                        <strong>Assessment showed lower concern than the pediatrician.</strong>
                    </p>
                </div>
                <div class="rate-item">
                    <p class="rate-value">${rateText(agreement.screeningRatedWorse, false)}</p>
                    <p class="rate-label">Assessment showed higher concern than the pediatrician.</p>
                </div>
            </div>
            <p class="card-sub" style="margin-top:0.6rem;">Each percentage is out of n = ${fmtN(comparable)} reviewed sessions in range that have both a scored overall band and a pediatrician-recorded outcome. They describe agreement in this recorded data, not the accuracy of either the assessment or the pediatrician.</p>`;

    section.innerHTML = `
        <div class="insight-card">
            ${header}
            ${pipelineStrip(totals)}
            ${ratesBlock}

            <h3>Assessment vs. Pediatrician Outcome</h3>
            <p class="card-sub" style="margin-bottom:0.8rem;">
                Assessment results compared with pediatrician-recorded outcomes. Highlighted cells show where both agree.
            </p>
            <div class="insight-table-wrap">
                <table class="insight-table crosstab">
                    <thead>
                        <tr>
                            <th>Assessment Result</th>
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
        loadSection('screenings', 'screeningsSection', renderScreenings, 'assessment reports'),
        loadSection('concordance', 'concordanceSection', renderConcordance, 'concordance'),
    ]);

    annotateGuardianReconciliation(results[0], results[1]);

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
    const f0 = currentFilters();
    const defaultRange = !f0.from && !f0.to;
    meta.innerHTML = `View system activity, child assessments, and assessment results.<br>
        <span style="font-size:0.85em; opacity:0.8; display:inline-block; margin-top:0.3rem;">
            Data for: ${escapeHtml(bits.join(' · '))}${defaultRange ? ' (default: last 12 months)' : ''} &nbsp;|&nbsp; Updated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
        </span><br>
        <span style="font-size:0.8em; opacity:0.75; display:inline-block; margin-top:0.2rem;">
            Each section states which filters apply to it. Analytics shows all-time totals, so its numbers can differ from a date-limited view here.
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
