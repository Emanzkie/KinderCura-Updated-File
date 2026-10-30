// === Extracted from PARENT\dashboard.html (script block 1) ===
// Require login before this page can load
        requireAuth();
// Staff accounts are redirected away from parent pages by /api.js.

function calcAge(dob) {
    const d = new Date(dob), now = new Date();
    let y = now.getFullYear() - d.getFullYear(), m = now.getMonth() - d.getMonth();
    if (m < 0) { y--; m += 12; }
    return y > 0 ? `${y} year${y>1?'s':''} ${m} month${m!==1?'s':''}` : `${m} month${m!==1?'s':''}`;
}

// -------------------- Child switcher state & helpers --------------------
// Mirrors the pattern used in /parent/results so the dashboard supports
// parents with multiple children.
let allChildren = [];
let activeChild = null;
// Signature of the last rendered switcher so we can skip redundant re-renders
// (loadDashboard re-runs every 30s via KC.poll and we don't want the dropdown
// to visibly flicker when the list of children has not actually changed).
let _switcherSignature = null;
let _dashboardLoadCounter = 0;
let _lastRenderedChildId = null;

// HTML escape helper so child names render safely inside generated markup.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function fetchParentChildren() {
    try {
        const data = await apiFetch('/children');
        return data.children || [];
    } catch (error) {
        console.error('Error fetching parent children:', error);
        return [];
    }
}

// Switch the active child on this page without a full reload: persist the
// selection, clear the now-stale assessment id, then re-run loadDashboard().
function switchChild(childId) {
    if (!childId) return;
    const next = allChildren.find(c => String(c.id) === String(childId));
    if (!next) return;
    localStorage.setItem('kc_childId', String(childId));
    localStorage.removeItem('kc_assessmentId');
    activeChild = next;
    loadDashboard();
}

// Only render the <select> when the parent has more than one child.
function renderChildSwitcher() {
    const wrap = document.getElementById('childSwitchWrap');
    if (!wrap) return;

    if (!allChildren || allChildren.length <= 1) {
        if (_switcherSignature !== '') {
            wrap.innerHTML = '';
            _switcherSignature = '';
        }
        return;
    }

    const signature = allChildren.map(c => c.id).join(',') + '|' + (activeChild?.id ?? '');
    if (signature === _switcherSignature) return;
    _switcherSignature = signature;

    wrap.innerHTML = `
        <select id="childSwitch" class="child-select" onchange="switchChild(this.value)">
            ${allChildren.map(c => `<option value="${escapeHtml(c.id)}"${String(c.id) === String(activeChild?.id) ? ' selected' : ''}>${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}</option>`).join('')}
        </select>`;
}

// ── Follow-up Assessment Plan ────────────────────────────────────────────────
// A Follow-up Check-up the pediatrician scheduled (GET /checkups/child/:id/follow-ups).
// Before payment it offers Pay Now; once payment is confirmed it shows the
// assigned assessments, how many are done and the deadline. Assessments are the
// ordinary Screening ones — nothing here scores anything.
const FOLLOW_UP_OPEN_STATES = ['awaiting_payment', 'active', 'overdue', 'assessments_complete'];

function followUpDateText(value, utc) {
    if (!value) return '—';
    return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', ...(utc ? { timeZone: 'UTC' } : {}) });
}

function followUpTimeText(value) {
    const [h, m] = String(value || '').split(':');
    const hour = parseInt(h, 10);
    if (Number.isNaN(hour)) return String(value || '');
    return `${hour % 12 || 12}:${String(m || '00').padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function renderFollowUpPlan(plan) {
    const card = document.getElementById('followUpCard');
    const body = document.getElementById('followUpPlanBody');
    if (!card || !body) return;
    if (!plan) { card.style.display = 'none'; body.innerHTML = ''; return; }
    card.style.display = '';

    const appt = plan.appointment;
    const visit = appt ? `${followUpDateText(appt.date, true)} at ${followUpTimeText(appt.time)}` : '—';
    const fee = `₱${Number(plan.fee || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const doctor = plan.pediatricianName ? `Dr. ${escapeHtml(plan.pediatricianName)}` : 'Your pediatrician';
    const instructions = plan.instructions ? `<p class="kc-card-note"><strong>Instructions:</strong> ${escapeHtml(plan.instructions)}</p>` : '';

    if (plan.state === 'awaiting_payment') {
        body.innerHTML = `
            <p>${doctor} scheduled a follow-up check-up on <strong>${escapeHtml(visit)}</strong>. Fee: <strong>${escapeHtml(fee)}</strong>.</p>
            <p class="kc-card-note">Once your payment is confirmed, ${escapeHtml(plan.requiredAssessments)} developmental assessment${plan.requiredAssessments === 1 ? '' : 's'} will be assigned to complete within ${escapeHtml(plan.monitoringDays)} days, and the appointment will be confirmed.</p>
            ${instructions}
            <button class="btn btn-primary" onclick="window.location.href='/parent/payment?appointmentId=${encodeURIComponent(appt ? appt.id : '')}'">Pay Now</button>`;
        return;
    }

    const pct = plan.requiredAssessments ? Math.min(100, Math.round((plan.completed / plan.requiredAssessments) * 100)) : 0;
    const statusText = plan.state === 'assessments_complete'
        ? 'All assigned assessments are done. Thank you!'
        : plan.state === 'overdue'
            ? `The deadline (${followUpDateText(plan.dueDate)}) has passed. Please finish the remaining assessments before the check-up.`
            : `Due ${followUpDateText(plan.dueDate)}.`;
    body.innerHTML = `
        <p><strong>${escapeHtml(plan.completed)}</strong> of <strong>${escapeHtml(plan.requiredAssessments)}</strong> assessments completed · <strong>${escapeHtml(plan.remaining)}</strong> remaining</p>
        <div style="height:10px;background:var(--bg-primary);border-radius:999px;overflow:hidden;margin:0.5rem 0;"><div style="height:100%;width:${pct}%;background:var(--primary);"></div></div>
        <p class="kc-card-note">${escapeHtml(statusText)} Follow-up check-up with ${doctor}: <strong>${escapeHtml(visit)}</strong>${appt ? ` (${escapeHtml(appt.paymentStatus)})` : ''}.</p>
        ${instructions}
        ${plan.remaining > 0 ? `<button class="btn btn-primary" onclick="window.location.href='/parent/screening'">Start Assessment</button>` : ''}`;
}

// Never throws; a stale response for a previously selected child is ignored.
async function loadFollowUpPlan(childId, loadId) {
    if (!childId) { renderFollowUpPlan(null); return; }
    try {
        const data = await apiFetch(`/checkups/child/${childId}/follow-ups`);
        if (loadId !== _dashboardLoadCounter) return;
        const open = (data.plans || []).filter((p) => FOLLOW_UP_OPEN_STATES.includes(p.state));
        renderFollowUpPlan(open[0] || null);
    } catch (err) {
        if (loadId !== _dashboardLoadCounter) return;
        console.warn('[PARENT_DASHBOARD] Follow-up plan could not be loaded:', err && err.message);
        renderFollowUpPlan(null);
    }
}

// Load parent dashboard summary, child info, and latest results.
// Order of operations (per spec):
//   1. Fetch children list.
//   2. Determine the currently active child id.
//   3. Render the child switcher (only when >1 child).
//   4. Load and populate dashboard data for the active child.
async function loadDashboard() {
    _dashboardLoadCounter++;
    const loadId = _dashboardLoadCounter;
    console.log('[PARENT_DASHBOARD] Load start', { loadId });

    // 1. Fetch children list
    allChildren = await fetchParentChildren();

    // 2. Determine active child id (honor existing localStorage selection)
    let childId = null;
    if (allChildren.length > 0) {
        const stored = localStorage.getItem('kc_childId');
        activeChild = allChildren.find(c => String(c.id) === String(stored)) || allChildren[0];
        childId = activeChild.id;
        localStorage.setItem('kc_childId', String(childId));
    } else {
        activeChild = null;
    }

    // 3. Render the child switcher (hidden automatically when <=1 child)
    renderChildSwitcher();

    // 4. Populate the dashboard for the active child
    if (activeChild) {
        const c = activeChild;
        document.getElementById('childName').textContent = `${c.firstName} ${c.lastName}`;
        const dob = new Date(c.dateOfBirth);
        document.getElementById('childMeta').textContent = `Age: ${calcAge(c.dateOfBirth)} | Birthdate: ${dob.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}`;
    } else {
        document.getElementById('childName').textContent = 'No child registered';
        document.getElementById('childMeta').textContent = 'Go to Profile to add a child';
    }

    loadFollowUpPlan(childId, loadId);

    // Clear stale data only when the active child changed — avoids flicker on
    // the 5-second interval poll when the same child is still selected.
    const childChanged = String(childId) !== String(_lastRenderedChildId);
    if (childChanged) {
        document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">Loading assessment data...</p>';
        document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">Loading assessment data...</p>';
        document.getElementById('recList').innerHTML = '<p class="text-center text-muted">Loading recommendations...</p>';
    }

    if (childId) {
        console.log('[PARENT_DASHBOARD] Fetch latest assessment', { childId, loadId });
        try {
            const hist = await apiFetch(`/assessments/${childId}/history`);
            console.log('[PARENT_DASHBOARD] Response received', { childId, loadId });

            // Ignore stale response from a previous loadDashboard call
            if (loadId !== _dashboardLoadCounter) {
                console.log('[PARENT_DASHBOARD] Stale response ignored', { loadId, current: _dashboardLoadCounter });
                return;
            }

            const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
            if (assessments.length > 0) {
                const latest = assessments[0];
                localStorage.setItem('kc_assessmentId', latest.id);
                renderSkills(latest);
                renderAssessment(latest);
                _lastRenderedChildId = String(childId);
                console.log('[PARENT_DASHBOARD] Valid assessment rendered', { childId, assessmentId: latest.id, loadId });
                try {
                    const recs = await apiFetch(`/recommendations/${latest.id}`);
                    renderRecs(recs.recommendations || [], recs.activityProgress);
                } catch {}
            } else {
                _lastRenderedChildId = String(childId);
                if (childChanged) {
                    document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">No assessment yet</p>';
                    document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No assessment yet</p>';
                }
                localStorage.removeItem('kc_assessmentId');
                console.log('[PARENT_DASHBOARD] Empty response handled', { childId, loadId });
            }
        } catch (err) {
            console.log('[PARENT_DASHBOARD] Fetch error', { childId, loadId, error: err.message });
            if (loadId === _dashboardLoadCounter && childChanged) {
                document.getElementById('skillList').innerHTML = '<p class="text-center text-muted">No assessment yet</p>';
                document.getElementById('assessmentBox').innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No assessment yet</p>';
                _lastRenderedChildId = String(childId);
            }
        }
    }

    await loadNotifPreview();
}

function renderSkills(a) {
    const scores = [
        { label:'Communication', val: a.communicationScore },
        { label:'Social Skills',  val: a.socialScore },
        { label:'Cognitive',      val: a.cognitiveScore },
        { label:'Motor Skills',   val: a.motorScore }
    ];
    document.getElementById('skillList').innerHTML = scores.map(s => `
        <div class="skill-item">
            <div class="skill-name"><span>${s.label}</span><span class="skill-percent">${s.val}%</span></div>
            <div class="skill-bar"><div class="skill-fill" style="width:${s.val}%"></div></div>
        </div>`).join('');
    renderSkillScoreGuide();
}

// Score ranges + labels come straight from constants/scoring.js (the same
// ranges and per-area labels the Results page chips use). Nothing is scored
// here — this only lists the existing ranges so the percentages have context.
function renderSkillScoreGuide() {
    const guide = document.getElementById('skillScoreGuide');
    const S = window.KCScoring;
    if (!guide || !S || !Array.isArray(S.ACTIVE_BANDS)) return;
    guide.innerHTML = `
        <p class="kc-score-guide-title">Score guide</p>
        <ul class="kc-score-guide-list">
            ${S.ACTIVE_BANDS.map(b => `<li>${b.min}&ndash;${b.max}%: <strong>${escapeHtml(S.PARENT_DOMAIN_LABELS[b.key])}</strong></li>`).join('')}
        </ul>
        <p>These are the labels shown for each area on the Results page. They describe the assessment score only and are not a medical diagnosis.</p>`;
    guide.hidden = false;
}

function renderAssessment(a) {
    const childId = localStorage.getItem('kc_childId') || '';
    const date = a.completedAt ? new Date(a.completedAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'Recent';
    document.getElementById('assessmentBox').innerHTML = `
        <p class="assessment-date">${date}</p>
        <div class="assessment-scores">
            <div class="score-item"><div class="score-num">${a.communicationScore}%</div><div class="score-label">Communication</div></div>
            <div class="score-item"><div class="score-num">${a.socialScore}%</div><div class="score-label">Social</div></div>
            <div class="score-item"><div class="score-num">${a.cognitiveScore}%</div><div class="score-label">Cognitive</div></div>
            <div class="score-item"><div class="score-num">${a.motorScore}%</div><div class="score-label">Motor</div></div>
        </div>
        <button class="btn btn-primary btn-full" onclick="window.location.href='/parent/results?childId=${childId}&assessmentId=${a.id}'">View Detailed Results</button>`;
}

// Home-activity completion for the latest assessment's recommendations, as
// counted by the server (routes/recommendations.js buildActivityProgress).
// Refreshed with the rest of the dashboard on load and on every KC.poll tick.
function renderActivityProgress(progress) {
    if (!progress || !progress.total) return '';
    return `
        <div style="margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border);">
            <p style="font-weight:600;margin-bottom:0.3rem;">Home activities completed</p>
            <p style="color:var(--text-light);font-size:0.9rem;margin-bottom:0.5rem;">${progress.completed} of ${progress.total} (${progress.percentage}%)</p>
            <div role="progressbar" aria-label="Home activities completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percentage}" style="height:8px;background:var(--border);border-radius:4px;overflow:hidden;">
                <div style="height:100%;width:${progress.percentage}%;background:var(--primary);"></div>
            </div>
        </div>`;
}

function renderRecs(recs, activityProgress) {
    if (!recs || !recs.length) return;
    const icons = { communication:'<img src="/icons/communication.png" alt="" aria-hidden="true" class="icon-inline">', social:'<img src="/icons/social.png" alt="" aria-hidden="true" class="icon-inline">', cognitive:'<img src="/icons/cognitive.png" alt="" aria-hidden="true" class="icon-inline">', motor:'<img src="/icons/motor.png" alt="" aria-hidden="true" class="icon-inline">' };
    document.getElementById('recList').innerHTML = renderActivityProgress(activityProgress) + recs.slice(0,3).map((r, i, arr) => `
        <div style="margin-bottom:${i<arr.length-1?'1.5rem':'0'};padding-bottom:${i<arr.length-1?'1.5rem':'0'};border-bottom:${i<arr.length-1?'1px solid var(--border)':'none'}">
            <p style="font-weight:600;margin-bottom:0.3rem;">${icons[r.skill]||'<img src="/icons/recommendations.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'} ${r.skill.charAt(0).toUpperCase()+r.skill.slice(1)}</p>
            <p style="color:var(--text-light);font-size:0.9rem;">${r.suggestion}</p>
        </div>`).join('');
}

// The bell modal (notifications-card-ui.js) announces dismiss / clear / mark
// read, so this preview never keeps showing a notification that is gone.
document.addEventListener('kc:notifications-changed', () => { loadNotifPreview(); });

async function loadNotifPreview() {
    try {
        const data = await apiFetch('/notifications');
        const notifications = data.notifications || [];
        const preview = document.getElementById('notifPreview');
        if (!notifications.length) {
            preview.innerHTML = `<div style="padding:1rem;background:var(--bg-primary);border-radius:8px;border-left:4px solid var(--primary);">
                <div style="font-weight:600;margin-bottom:0.3rem;">Welcome to KinderCura!</div>
                <div style="font-size:0.85rem;color:var(--text-light);">Your account is set up and ready.</div>
            </div>`;
            return;
        }

        preview.innerHTML = notifications.slice(0,3).map(n => {
            // No related page: the card is informational and not clickable.
            const target = notificationDestination(n);
            const link = target ? `onclick="window.location.href=this.dataset.href" data-href="${escapeHtml(target)}" ` : '';
            return `<div ${link}style="cursor:${target ? 'pointer' : 'default'};padding:1rem;background:var(--bg-primary);border-radius:8px;border-left:4px solid ${n.isRead ? 'var(--border)' : 'var(--primary)'};">
                <div style="font-weight:600;margin-bottom:0.3rem;">${escapeHtml(n.title)}</div>
                <div style="font-size:0.85rem;color:var(--text-light);">${escapeHtml(n.message || '')}</div>
            </div>`;
        }).join('');

        loadNotificationCount();
    } catch {
        document.getElementById('notifPreview').innerHTML = '<p style="color:var(--text-light);text-align:center;">Could not load notifications.</p>';
    }
}

let parentApptChart, parentChildrenChart;

// Plain-language key for the Appointment Overview chart. Statuses are exactly
// the three /admin/analytics/parent counts (routes/admin.js) — cancelled and
// rejected appointments are not part of that data, so they are not listed.
// Wording follows the parent Appointments page ("being reviewed by the clinic
// staff" / "Confirmed by clinic staff").
// Completed uses the brand pink (--accent-red) instead of the previous light
// green, which was almost indistinguishable from Approved in the legend.
const APPT_STATUS_LEGEND = [
    { label: 'Pending',   key: 'pendingAppointments',   color: '#F4D89F', desc: 'Appointment requests still waiting to be confirmed by the clinic.' },
    { label: 'Approved',  key: 'approvedAppointments',  color: '#6B8E6F', desc: 'Appointments confirmed by the clinic and scheduled to take place.' },
    { label: 'Completed', key: 'completedAppointments', color: '#E8A5A5', desc: 'Appointments that have already taken place and were marked as completed.' },
];
const CHILDREN_CHART_COLOR = '#6B8E6F';
// Skip re-rendering the legends on the 5-second poll when nothing changed.
let _apptLegendSignature = null;
let _childrenLegendSignature = null;

function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

function renderApptLegend(summary) {
    const list = document.getElementById('parentApptLegend');
    if (!list) return;
    const counts = APPT_STATUS_LEGEND.map(s => Number(summary[s.key]) || 0);
    const signature = counts.join(',');
    if (signature === _apptLegendSignature) return;
    _apptLegendSignature = signature;

    const total = counts.reduce((a, b) => a + b, 0);
    list.innerHTML = APPT_STATUS_LEGEND.map((s, i) => `
        <li>
            <span class="kc-swatch" style="background:${s.color};" aria-hidden="true"></span>
            <span>
                <span class="kc-chart-legend-label">${s.label}</span>:
                <span class="kc-chart-legend-count">${plural(counts[i], 'appointment', 'appointments')}</span>
                <span class="kc-chart-legend-desc">${s.desc}</span>
            </span>
        </li>`).join('')
        + (total === 0 ? '<li><span></span><span class="kc-chart-legend-desc">There are no pending, approved, or completed appointments yet, so the chart is empty.</span></li>' : '');
}

function renderChildrenLegend(summary) {
    const list = document.getElementById('parentChildrenLegend');
    if (!list) return;
    const total = Number(summary.totalChildren) || 0;
    if (String(total) === _childrenLegendSignature) return;
    _childrenLegendSignature = String(total);

    list.innerHTML = total > 0 ? `
        <li>
            <span class="kc-swatch" style="background:${CHILDREN_CHART_COLOR};" aria-hidden="true"></span>
            <span>
                <span class="kc-chart-legend-label">Registered children</span>:
                <span class="kc-chart-legend-count">${plural(total, 'child', 'children')}</span>
                <span class="kc-chart-legend-desc">The full circle represents ${total === 1 ? 'your one registered child' : `all ${total} of your registered children together`}. It is a count, not a percentage or a score.</span>
            </span>
        </li>` : `
        <li><span></span><span class="kc-chart-legend-desc">No children are registered under your account yet. Add a child from your Profile page.</span></li>`;
}

        function initParentCharts() {
            parentApptChart = new Chart(document.getElementById('parentApptChart'), {
                type: 'doughnut',
                data: { labels: APPT_STATUS_LEGEND.map(s => s.label), datasets: [{ data: [0,0,0], backgroundColor: APPT_STATUS_LEGEND.map(s => s.color) }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        // The always-visible HTML legend under the chart (with counts
                        // and meanings) replaces Chart.js's colour-only legend.
                        legend: { display: false },
                        tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${plural(ctx.parsed, 'appointment', 'appointments')}` } }
                    }
                }
            });
            parentChildrenChart = new Chart(document.getElementById('parentChildrenChart'), {
                type: 'pie',
                // borderWidth 0: a single-slice pie otherwise shows a stray white
                // seam at 12 o'clock that reads like a second, empty slice.
                data: { labels: ['Registered children'], datasets: [{ data: [0], backgroundColor: [CHILDREN_CHART_COLOR], borderWidth: 0 }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: (ctx) => ` ${plural(ctx.parsed, 'registered child', 'registered children')}` } }
                    }
                }
            });
        }

        function updateParentCharts(summary) {
            if (parentApptChart) {
                parentApptChart.data.datasets[0].data = [summary.pendingAppointments || 0, summary.approvedAppointments || 0, summary.completedAppointments || 0];
                parentApptChart.update();
            }
            if (parentChildrenChart) {
                parentChildrenChart.data.datasets[0].data = [summary.totalChildren || 0];
                parentChildrenChart.update();
            }
            renderApptLegend(summary);
            renderChildrenLegend(summary);
        }

        async function loadParentAnalytics() {
            try {
                const data = await apiFetch('/admin/analytics/parent');
                console.log('[Parent Analytics] Response:', data);
                updateParentCharts(data.summaryTotals || {});
            } catch (err) {
                console.error('[Parent Analytics] Error:', err);
            }
        }

        // Start dashboard data load after page is ready
        document.addEventListener('DOMContentLoaded', () => { initNav(); initParentCharts(); loadDashboard(); loadParentAnalytics(); window.KC.poll(() => Promise.all([loadDashboard(), loadParentAnalytics()]), 30000); });
