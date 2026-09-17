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

// Pediatrician Review & Next Follow-up. Two related but distinct pieces of
// stored data, shown together but never conflated:
//   (1) the INITIAL pediatrician review — the earliest completed assessment
//       that has actually been reviewed (not simply the latest assessment;
//       see window.KCReportInterpretations.findInitialReview), described
//       using only that one assessment's own recorded review fields.
//   (2) the most recently documented next-follow-up date/reason, which may
//       have been set at a LATER review than the initial one — this reuses
//       the server's own `followUp` (routes/parent-reports.js), which already
//       walks the timeline for the newest documented nextAssessmentDate.
// Nothing here is invented: every value is a stored Assessment field written
// by POST /api/assessments/diagnose/:childId, or explicitly says it is missing.
function renderPediatricianReview(reportData) {
    const assessments = reportData.assessments || [];
    const initial = window.KCReportInterpretations.findInitialReview(assessments);
    const followUp = reportData.followUp;

    if (!initial) {
        return `
            <div class="report-card">
                <h2>Pediatrician Review &amp; Next Follow-up</h2>
                <p class="card-sub">No pediatrician review has been documented yet for this child's completed assessments.</p>
                <button class="btn btn-primary" onclick="goToAppointments()">Book an appointment</button>
            </div>`;
    }

    const overall = initial.overallScore != null ? Math.round(initial.overallScore) : null;
    const screeningResult = overall != null
        ? `${overall}% &mdash; ${escapeHtml(window.KCScoring.parentOverallLabel(overall))}`
        : 'Not available for this assessment.';

    const followUpFromLaterReview = Boolean(
        followUp && followUp.fromAssessmentId && followUp.fromAssessmentId !== initial.id
    );

    const followUpFields = followUp && followUp.nextAssessmentDate
        ? `
            <div><dt>Next recommended follow-up</dt><dd>${escapeHtml(fmtScheduledDate(followUp.nextAssessmentDate))}</dd></div>
            <div class="review-field-wide"><dt>Reason</dt><dd>${followUp.reason ? escapeHtml(followUp.reason) : 'No reason was documented for this follow-up.'}</dd></div>`
        : `
            <div class="review-field-wide"><dt>Next recommended follow-up</dt><dd>No follow-up date has been documented by a pediatrician yet.</dd></div>`;

    return `
        <div class="report-card">
            <h2>Pediatrician Review &amp; Next Follow-up</h2>
            <p class="card-sub">What the pediatrician documented after reviewing this child's assessment results.</p>
            <dl class="review-fields">
                <div><dt>Initial assessment</dt><dd>${escapeHtml(fmtDate(initial.completedAt) || 'Date not recorded')}</dd></div>
                <div><dt>Initial screening result</dt><dd>${screeningResult}</dd></div>
                <div><dt>Reviewed by</dt><dd>${escapeHtml(initial.review.pediatricianName || 'Pediatrician')}</dd></div>
                <div><dt>Reviewed on</dt><dd>${escapeHtml(fmtDate(initial.review.reviewedAt) || 'Not recorded')}</dd></div>
                <div class="review-field-wide"><dt>Pediatrician recommendation</dt><dd>${initial.review.recommendations ? escapeHtml(initial.review.recommendations) : 'No recommendation has been documented for this review.'}</dd></div>
                ${followUpFields}
            </dl>
            ${followUpFromLaterReview
                ? '<p class="timeline-note">This follow-up date was documented at a later pediatrician review than the initial one shown above.</p>'
                : ''}
            <button class="followup-action" onclick="goToAppointments()" style="margin-top:1rem;">Appointments</button>
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

    const interpretation = window.KCReportInterpretations.getTrendInterpretation(assessments);

    return `
        <div class="report-card">
            <h2>Score over time</h2>
            <div class="trend-chart-wrap"><canvas id="trendChart"></canvas></div>
            <div class="interp-block">
                <p class="interp-label">What this shows</p>
                <p class="interp-text">
                    This chart compares your child's overall assessment score across completed
                    assessments, from the oldest result to the newest result.
                </p>
            </div>
            <div class="interp-block">
                <p class="interp-label">Interpretation</p>
                <p class="interp-text">${escapeHtml(interpretation)}</p>
            </div>
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

    const interp = window.KCReportInterpretations;
    const dateStr = fmtDate(latest.completedAt);
    const overall = Math.round(latest.overallScore ?? 0);
    const overallLabel = window.KCScoring.parentOverallLabel(overall);
    const overallInterpretation = interp.getAssessmentInterpretation(latest);

    const cards = latest.domains.map((d) => {
        const domainInterpretation = interp.getDomainInterpretation(d, latest.domains, latest.overallScore);

        if (d.score == null) {
            return `
                <div class="domain-card">
                    <div class="domain-card-head"><h3>${escapeHtml(d.label)}</h3></div>
                    <p class="domain-score">Score unavailable for this assessment.</p>
                    <div class="interp-block domain-interp">
                        <p class="interp-label">Interpretation</p>
                        <p class="interp-text">${escapeHtml(domainInterpretation)}</p>
                    </div>
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
                <div class="interp-block domain-interp">
                    <p class="interp-label">Interpretation</p>
                    <p class="interp-text">${escapeHtml(domainInterpretation)}</p>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="report-card">
            <h2>Most recent assessment${dateStr ? ` &mdash; ${escapeHtml(dateStr)}` : ''}</h2>
            <p class="card-sub">
                Overall score <strong>${overall}%</strong> (${escapeHtml(overallLabel)}).
                Each area shows how your child performed in that part of the assessment.
            </p>
            <div class="interp-block">
                <p class="interp-label">Interpretation</p>
                <p class="interp-text">${escapeHtml(overallInterpretation)}</p>
            </div>
            <div class="domain-grid">${cards}</div>
        </div>`;
}

// A supportive next step when the most recent screening lands in a lower band.
// No diagnosis, no alarm — the action offered is a conversation with a
// pediatrician, using the booking flow that already exists.
//
// Deliberately suppressed when it would duplicate the Pediatrician Review &
// Next Follow-up section below: if the LATEST assessment already has a
// documented pediatrician recommendation, the parent already has the actual
// professional guidance, and a generic "book an appointment to discuss this"
// nudge next to it would read as a second, less specific instruction rather
// than useful information. It still shows for a latest assessment that
// hasn't been reviewed yet — that's the one case where this really is the
// only next step on offer.
function renderDiscussPrompt(latest) {
    if (!latest || !latest.scoresAvailable || latest.overallScore == null) return '';

    const band = window.KCScoring.bandFor(latest.overallScore);
    if (band !== window.KCScoring.BAND.AT_RISK && band !== window.KCScoring.BAND.DELAYED) return '';

    const alreadyHasDocumentedRecommendation = Boolean(
        latest.review && latest.review.pediatricianId && latest.review.recommendations
    );
    if (alreadyHasDocumentedRecommendation) return '';

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

// Full history, most recent first. Each entry gets its OWN interpretation,
// tied to that specific date and compared against the immediately previous
// completed assessment (chronologically) — never one generic paragraph
// reused across every date.
function renderTimeline(assessments) {
    if (!assessments.length) return '';
    const interp = window.KCReportInterpretations;

    // assessments arrives oldest-first from the API — walk it in that order so
    // `previous` is always the assessment immediately before `a` in time, then
    // reverse the finished rows for most-recent-first display.
    const rows = assessments.map((a, i) => {
        const previous = i > 0 ? assessments[i - 1] : null;
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
                    <p class="timeline-note">${escapeHtml(interp.INCOMPLETE_MESSAGE)}</p>
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

        const historyInterpretation = interp.getHistoryInterpretation(a, previous);

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
                <div class="interp-block">
                    <p class="interp-label">Interpretation</p>
                    <p class="interp-text">${escapeHtml(historyInterpretation)}</p>
                </div>
                ${a.review.nextAssessmentDate
                    ? `<p class="timeline-note">Follow-up documented for ${escapeHtml(fmtScheduledDate(a.review.nextAssessmentDate))}.</p>`
                    : ''}
                ${pedia}
            </div>`;
    }).reverse().join('');

    return `
        <div class="report-card">
            <h2>Assessment history</h2>
            <p class="card-sub">
                Every completed assessment for this child, most recent first. Each entry is
                interpreted using only that assessment's own recorded scores.
            </p>
            <div class="timeline-list">${rows}</div>
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
            ${renderTrend(assessments, reportData.trendAvailable)}
            ${renderLatestDomains(latest)}
            ${renderDiscussPrompt(latest)}
            ${renderTimeline(assessments)}
            ${renderPediatricianReview(reportData)}
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
