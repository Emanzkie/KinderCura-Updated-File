// js/parent/reports.js
// Parent Progress Report — one child's screening history over time.
//
// This page RENDERS stored values. It does not score anything.
// Every number comes from GET /api/parent/children/:childId/report, which reads
// AssessmentResult directly. Band labels and colours come from window.KCScoring
// (constants/scoring.js, loaded by reports.html before this file), exactly as
// js/parent/results.js does them — so the two parent pages cannot disagree
// about what a score of 62 is called.
//
// Wording rule for anything added here: this is a SCREENING record. Nothing on
// this page may state or imply a diagnosis, and the scoring is rule-based
// against fixed cutoffs — it is not a prediction and must not be described as
// one.

requireAuth();

let allChildren = [];
let activeChild = null;
let reportData = null;
let trendChart = null;

// Small HTML escape helper so pediatrician-written text is safe in the page.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtDate(dateString) {
    if (!dateString) return null;
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

// Date-only strings are anchored locally so a '2026-09-01' follow-up date does
// not display as August 31 in a behind-UTC timezone. Mirrors
// fmtScheduledDate() in js/parent/results.js.
function fmtScheduledDate(dateString) {
    if (!dateString) return '';
    const match = String(dateString).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        const [, year, month, day] = match;
        return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric'
        });
    }
    return fmtDate(dateString) || '';
}

// Age at assessment arrives as whole months and is derived from the date of
// birth — no assessment record stores it. Rendered as "4y 2m" so a parent can
// see the child was younger at earlier screenings.
function fmtAge(months) {
    if (months == null || !Number.isFinite(Number(months))) return null;
    const m = Number(months);
    const years = Math.floor(m / 12);
    const rem = m % 12;
    if (years <= 0) return `${rem} month${rem === 1 ? '' : 's'} old`;
    return rem === 0 ? `${years} year${years === 1 ? '' : 's'} old` : `${years}y ${rem}m old`;
}

function getRequestedChildId() {
    try {
        return new URLSearchParams(window.location.search).get('childId')
            || localStorage.getItem('kc_childId');
    } catch {
        return localStorage.getItem('kc_childId');
    }
}

function switchChild(childId) {
    if (childId) localStorage.setItem('kc_childId', childId);
    window.location.href = `/parent/reports.html?childId=${encodeURIComponent(childId)}`;
}

function renderChildSwitcher() {
    const wrap = document.getElementById('childSwitchWrap');
    if (!wrap) return;
    if (allChildren.length <= 1) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = `
        <select id="childSwitch" class="child-select" onchange="switchChild(this.value)" aria-label="Choose a child">
            ${allChildren.map((c) => `
                <option value="${escapeHtml(c.id)}" ${String(c.id) === String(activeChild?.id) ? 'selected' : ''}>
                    ${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}
                </option>`).join('')}
        </select>`;
}

function goToAppointments() {
    window.location.href = '/parent/appointments.html';
}

function goToScreening() {
    window.location.href = '/parent/screening.html';
}

// ── Section renderers ───────────────────────────────────────────────────────

// Next follow-up. The report only ever shows a date a pediatrician actually
// entered. The system stores no recall interval, so when no date is set the
// page says so plainly rather than estimating one.
function renderFollowUp(followUp) {
    if (followUp && followUp.nextAssessmentDate) {
        const by = followUp.setByPediatricianName
            ? ` Set by ${escapeHtml(followUp.setByPediatricianName)}.`
            : '';
        return `
            <div class="followup-banner">
                <div>
                    <h3>Next recommended follow-up</h3>
                    <p><strong>${escapeHtml(fmtScheduledDate(followUp.nextAssessmentDate))}</strong>.${by}</p>
                    ${followUp.reason ? `<p class="timeline-note">${escapeHtml(followUp.reason)}</p>` : ''}
                </div>
                <button class="followup-action" onclick="goToAppointments()">Appointments</button>
            </div>`;
    }

    return `
        <div class="followup-banner followup-none">
            <div>
                <h3>Next recommended follow-up</h3>
                <p>No follow-up date has been scheduled by a pediatrician yet. You can book an appointment any time to discuss these results.</p>
            </div>
            <button class="followup-action" onclick="goToAppointments()">Book appointment</button>
        </div>`;
}

// Trend. Deliberately refuses to draw a chart from a single point — one score
// is not a trend, and a one-point line invites reading a slope that isn't there.
function renderTrend(assessments, trendAvailable) {
    const scored = assessments.filter((a) => a.overallScore != null);

    if (!trendAvailable || scored.length < 2) {
        return `
            <div class="report-card">
                <h2>Score over time</h2>
                <div class="trend-empty">
                    <h3>Not enough assessments yet to show a trend</h3>
                    <p>
                        A trend needs at least two completed assessments so the scores can be
                        compared. ${scored.length === 1
                            ? 'There is one completed assessment so far, shown below.'
                            : 'There are no completed assessments for this child yet.'}
                    </p>
                    <button class="btn btn-primary" onclick="goToScreening()">
                        ${scored.length === 1 ? 'Start another assessment' : 'Start an assessment'}
                    </button>
                </div>
            </div>`;
    }

    return `
        <div class="report-card">
            <h2>Score over time</h2>
            <p class="card-sub">
                Overall assessment score at each completed assessment, oldest to newest.
                Assessment results can change over time. A single result does not give a complete picture of your child's development.
            </p>
            <div class="trend-chart-wrap"><canvas id="trendChart"></canvas></div>
        </div>`;
}

// Chart.js is only initialised after the markup is in the DOM.
function drawTrendChart(assessments) {
    const canvas = document.getElementById('trendChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const scored = assessments.filter((a) => a.overallScore != null);
    if (scored.length < 2) return;

    if (trendChart) trendChart.destroy();

    trendChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: scored.map((a) => fmtShortDate(a.completedAt)),
            datasets: [{
                label: 'Overall score',
                data: scored.map((a) => a.overallScore),
                borderColor: '#6B8E6F',
                backgroundColor: 'rgba(107, 142, 111, 0.12)',
                // Each point is coloured by its own band, so the chart agrees
                // with the chips elsewhere on the page.
                pointBackgroundColor: scored.map((a) => window.KCScoring.colorForScore(a.overallScore)),
                pointRadius: 5,
                pointHoverRadius: 7,
                borderWidth: 2,
                fill: true,
                tension: 0.25,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    min: 0,
                    max: 100,
                    ticks: { callback: (v) => `${v}%` },
                    title: { display: true, text: 'Overall score' },
                },
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y}% — ${window.KCScoring.parentOverallLabel(ctx.parsed.y)}`,
                    },
                },
            },
        },
    });
}

// Per-domain breakdown for the most recent completed screening.
function renderLatestDomains(latest) {
    if (!latest) return '';

    if (!latest.scoresAvailable) {
        return `
            <div class="report-card">
                <h2>Most recent assessment</h2>
                <p class="card-sub">
                    The scores for the assessment on
                    ${escapeHtml(fmtDate(latest.completedAt) || 'an earlier date')}
                    are unavailable, so they are not shown here. Please mention this to
                    your pediatrician or contact support.
                </p>
            </div>`;
    }

    const dateStr = fmtDate(latest.completedAt);
    const overall = Math.round(latest.overallScore ?? 0);
    const overallLabel = window.KCScoring.parentOverallLabel(overall);

    const cards = latest.domains.map((d) => {
        if (d.score == null) {
            return `
                <div class="domain-card">
                    <div class="domain-card-head"><h3>${escapeHtml(d.label)}</h3></div>
                    <p class="domain-score">Score unavailable for this assessment.</p>
                </div>`;
        }
        const score = Math.round(d.score);
        const st = window.KCScoring.parentDomainStatus(score);
        return `
            <div class="domain-card" style="border-left-color:${st.color};">
                <div class="domain-card-head">
                    <h3>${escapeHtml(d.label)}</h3>
                    <span class="domain-chip" style="background:${st.color};">${escapeHtml(st.label)}</span>
                </div>
                <div class="domain-bar"><span style="width:${score}%;background:${st.color};"></span></div>
                <p class="domain-score">Score: <strong>${score}%</strong></p>
            </div>`;
    }).join('');

    return `
        <div class="report-card">
            <h2>Most recent assessment${dateStr ? ` &mdash; ${escapeHtml(dateStr)}` : ''}</h2>
            <p class="card-sub">
                Overall score <strong>${overall}%</strong> (${escapeHtml(overallLabel)}).
                Each area shows how your child performed in that part of the assessment.
            </p>
            <div class="domain-grid">${cards}</div>
        </div>`;
}

// A supportive next step when the most recent screening lands in a lower band.
// No diagnosis, no alarm — the action offered is a conversation with a
// pediatrician, using the booking flow that already exists.
function renderDiscussPrompt(latest) {
    if (!latest || !latest.scoresAvailable || latest.overallScore == null) return '';

    const band = window.KCScoring.bandFor(latest.overallScore);
    if (band !== window.KCScoring.BAND.AT_RISK && band !== window.KCScoring.BAND.DELAYED) return '';

    return `
        <div class="report-card">
            <h2>Worth talking through</h2>
            <p class="card-sub">
                This assessment highlighted some areas that would be worth discussing with
                your pediatrician. Assessment results point to what to look at more
                closely &mdash; they do not tell you what is causing it, and many children
                who assess this way turn out to be developing typically. A pediatrician
                can look at the full picture with you.
            </p>
            <button class="btn btn-primary" onclick="goToAppointments()">Book an appointment</button>
        </div>`;
}

// Full history, most recent first.
function renderTimeline(assessments) {
    if (!assessments.length) return '';

    const rows = assessments.slice().reverse().map((a) => {
        const dateStr = fmtDate(a.completedAt);
        const ageStr = fmtAge(a.ageAtAssessmentMonths);

        if (!a.scoresAvailable) {
            return `
                <div class="timeline-item timeline-unavailable">
                    <div class="timeline-top">
                        <div>
                            <div class="timeline-date">${escapeHtml(dateStr || 'Date not recorded')}</div>
                            ${ageStr ? `<div class="timeline-age">${escapeHtml(ageStr)}</div>` : ''}
                        </div>
                        <div class="timeline-overall" style="color:var(--text-light);">&mdash;</div>
                    </div>
                    <p class="timeline-note">Scores for this assessment are unavailable.</p>
                </div>`;
        }

        const overall = Math.round(a.overallScore ?? 0);
        const st = window.KCScoring.parentDomainStatus(overall);
        const domainBits = a.domains
            .filter((d) => d.score != null)
            .map((d) => `<span>${escapeHtml(d.label)}: <strong>${Math.round(d.score)}%</strong></span>`)
            .join('');

        const pedia = a.review.pediatricianName
            ? `<p class="timeline-pedia">Reviewed by ${escapeHtml(a.review.pediatricianName)}${
                a.review.reviewedAt ? ` on ${escapeHtml(fmtDate(a.review.reviewedAt) || '')}` : ''}.</p>`
            : '<p class="timeline-pedia">Not yet reviewed by a pediatrician.</p>';

        return `
            <div class="timeline-item" style="border-left-color:${st.color};">
                <div class="timeline-top">
                    <div>
                        <div class="timeline-date">${escapeHtml(dateStr || 'Date not recorded')}</div>
                        ${ageStr ? `<div class="timeline-age">${escapeHtml(ageStr)}</div>` : ''}
                    </div>
                    <div class="timeline-overall" style="color:${st.color};">${overall}%</div>
                </div>
                <div class="timeline-domains">${domainBits}</div>
                ${a.review.nextAssessmentDate
                    ? `<p class="timeline-note">Follow-up suggested for ${escapeHtml(fmtScheduledDate(a.review.nextAssessmentDate))}.</p>`
                    : ''}
                ${pedia}
            </div>`;
    }).join('');

    return `
        <div class="report-card">
            <h2>Assessment history</h2>
            <p class="card-sub">Every completed assessment for this child, most recent first.</p>
            <div class="timeline-list">${rows}</div>
        </div>`;
}

// Pediatrician follow-up questions. Kept in their own section and explicitly
// labelled: these are written by a pediatrician for this child, they are not
// part of the standard screening question set, and they are not scored.
function renderCustomQuestions(cq) {
    if (!cq || !cq.answeredCount) return '';

    const items = cq.items.map((q) => `
        <div class="custom-q-item">
            <p class="custom-q-text">${escapeHtml(q.questionText)}</p>
            <p class="custom-q-answer">Your answer: <strong>${escapeHtml(q.answer)}</strong></p>
            <p class="custom-q-source">
                <span class="origin-tag">Pediatrician Question</span>
                Asked by ${escapeHtml(q.pediatricianName)}${
                    q.answeredAt ? ` &middot; answered ${escapeHtml(fmtDate(q.answeredAt) || '')}` : ''}
            </p>
        </div>`).join('');

    return `
        <div class="report-card">
            <h2>Pediatrician follow-up questions</h2>
            <p class="card-sub">
                These are additional questions from your pediatrician about your child. They are shown separately from the main assessment results.
                ${cq.pendingCount ? `You have ${cq.pendingCount} unanswered question${cq.pendingCount === 1 ? '' : 's'}.` : ''}
            </p>
            ${items}
        </div>`;
}

// Shown only when something genuinely could not be rendered, so a gap in the
// page is never left unexplained.
function renderDataNote(unrenderable) {
    if (!unrenderable || !unrenderable.length) return '';
    const missingScores = unrenderable.filter((u) => u.reason === 'no_stored_result').length;
    const missingDates = unrenderable.filter((u) => u.reason === 'no_completed_date').length;

    const parts = [];
    if (missingScores) parts.push(`${missingScores} assessment${missingScores === 1 ? '' : 's'} with no saved scores`);
    if (missingDates) parts.push(`${missingDates} assessment${missingDates === 1 ? '' : 's'} with no completion date`);

    return `
        <div class="data-note">
            <strong>Note:</strong> this report found ${parts.join(' and ')}. Those entries are
            listed without the missing information rather than being estimated.
        </div>`;
}

// ── Page assembly ───────────────────────────────────────────────────────────

function renderEmptyState() {
    return `
        <div class="report-state">
            <h2>No completed assessments yet</h2>
            <p>
                Once you complete an assessment for this child, the results will appear here.
                A progress trend needs at least two completed assessments before it can be shown.
            </p>
            <button class="btn btn-primary" onclick="goToScreening()">Start an assessment</button>
        </div>`;
}

async function loadReport() {
    const content = document.getElementById('reportContent');
    const meta = document.getElementById('reportMeta');

    try {
        content.innerHTML = '<div class="report-state"><p>Loading your child\'s progress report…</p></div>';

        allChildren = await fetchParentChildren();
        if (!allChildren.length) {
            meta.textContent = 'No children registered';
            content.innerHTML = `
                <div class="report-state">
                    <h2>No child registered yet</h2>
                    <p>Add your child from the dashboard to start tracking assessment results.</p>
                    <button class="btn btn-primary" onclick="window.location.href='/parent/dashboard.html'">Go to dashboard</button>
                </div>`;
            return;
        }

        const requestedChildId = getRequestedChildId();
        activeChild = allChildren.find((c) => String(c.id) === String(requestedChildId)) || allChildren[0];
        localStorage.setItem('kc_childId', activeChild.id);
        renderChildSwitcher();

        reportData = await apiFetch(`/parent/children/${encodeURIComponent(activeChild.id)}/report`);

        const assessments = reportData.assessments || [];
        meta.textContent = `${activeChild.firstName} ${activeChild.lastName} • ${
            assessments.length} completed assessment${assessments.length === 1 ? '' : 's'}`;

        if (!assessments.length) {
            content.innerHTML = renderEmptyState();
            return;
        }

        // The most recent entry that actually has scores drives the breakdown.
        const latest = assessments.slice().reverse().find((a) => a.scoresAvailable)
            || assessments[assessments.length - 1];

        content.innerHTML = `
            ${renderFollowUp(reportData.followUp)}
            ${renderTrend(assessments, reportData.trendAvailable)}
            ${renderLatestDomains(latest)}
            ${renderDiscussPrompt(latest)}
            ${renderTimeline(assessments)}
            ${renderCustomQuestions(reportData.customQuestions)}
            ${renderDataNote(reportData.unrenderable)}`;

        drawTrendChart(assessments);
    } catch (e) {
        meta.textContent = 'Could not load report';
        content.innerHTML = `
            <div class="report-state report-error">
                <h2>We couldn't load this report</h2>
                <p>${escapeHtml(e.message)}</p>
                <button class="btn btn-secondary" onclick="loadReport()">Try again</button>
            </div>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof initNav === 'function') initNav();
    loadReport();
});
