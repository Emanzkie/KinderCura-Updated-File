// === Extracted from PARENT\dashboard.html (script block 1) ===
// Require login before this page can load
        requireAuth();
const _user = KC.user();
if (_user?.role === 'pediatrician') window.location.href = '/pedia/pediatrician-dashboard.html';
else if (_user?.role === 'admin') window.location.href = '/admin/admin-dashboard.html';

function calcAge(dob) {
    const d = new Date(dob), now = new Date();
    let y = now.getFullYear() - d.getFullYear(), m = now.getMonth() - d.getMonth();
    if (m < 0) { y--; m += 12; }
    return y > 0 ? `${y} year${y>1?'s':''} ${m} month${m!==1?'s':''}` : `${m} month${m!==1?'s':''}`;
}

// -------------------- Child switcher state & helpers --------------------
// Mirrors the pattern used in /parent/results.html so the dashboard supports
// parents with multiple children.
let allChildren = [];
let activeChild = null;
// Signature of the last rendered switcher so we can skip redundant re-renders
// (loadDashboard runs every 5s via setInterval and we don't want the dropdown
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
                    renderRecs(recs.recommendations || []);
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
        <button class="btn btn-primary btn-full" onclick="window.location.href='/parent/results.html?childId=${childId}&assessmentId=${a.id}'">View Detailed Results</button>`;
}

function renderRecs(recs) {
    if (!recs || !recs.length) return;
    const icons = { communication:'<img src="/icons/communication.png" alt="" aria-hidden="true" class="icon-inline">', social:'<img src="/icons/social.png" alt="" aria-hidden="true" class="icon-inline">', cognitive:'<img src="/icons/cognitive.png" alt="" aria-hidden="true" class="icon-inline">', motor:'<img src="/icons/motor.png" alt="" aria-hidden="true" class="icon-inline">' };
    document.getElementById('recList').innerHTML = recs.slice(0,3).map((r, i, arr) => `
        <div style="margin-bottom:${i<arr.length-1?'1.5rem':'0'};padding-bottom:${i<arr.length-1?'1.5rem':'0'};border-bottom:${i<arr.length-1?'1px solid var(--border)':'none'}">
            <p style="font-weight:600;margin-bottom:0.3rem;">${icons[r.skill]||'<img src="/icons/recommendations.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'} ${r.skill.charAt(0).toUpperCase()+r.skill.slice(1)}</p>
            <p style="color:var(--text-light);font-size:0.9rem;">${r.suggestion}</p>
        </div>`).join('');
}

function notificationDestination(n) {
    const relatedPage = String(n?.relatedPage || '').trim();
    if (relatedPage) return relatedPage;

    const title = String(n?.title || '').toLowerCase();
    const type = String(n?.type || '').toLowerCase();
    const msg = String(n?.message || '').toLowerCase();

    if (title.includes('review completed') || title.includes('diagnosis') || msg.includes('diagnosis') || msg.includes('open results')) return '/parent/results.html';
    if (title.includes('recommendation') || msg.includes('recommendation')) return '/parent/recommendations.html';
    if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/parent/appointments.html';
    if (type === 'chat' || title.includes('chat') || title.includes('message') || msg.includes('message from')) return '/parent/chat.html';
    if (type === 'assessment' || title.includes('assessment question') || title.includes('custom question') || title.includes('new assessment question') || title.includes('question assigned') || msg.includes('assigned a new custom question')) return '/parent/custom-questions.html';
    return '/parent/dashboard.html';
}

async function loadNotificationCount() {
    const badge = document.getElementById('notifCount');
    if (!badge) return;

    try {
        const data = await apiFetch('/notifications/count');
        const unread = data.unread || 0;
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'flex' : 'none';
    } catch {
        badge.textContent = '0';
        badge.style.display = 'none';
    }
}

async function deleteNotification(id) {
    if (!id) return;

    try {
        await apiFetch(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadNotificationCount();
        await loadNotifPreview();
        await openNotifications();
    } catch (err) {
        alert('Could not delete notification: ' + err.message);
    }
}

async function clearAllNotifications() {
    const button = document.getElementById('clearNotificationsBtn');
    if (button) button.disabled = true;

    try {
        await apiFetch('/notifications/all', { method: 'DELETE' });
        await loadNotificationCount();
        await loadNotifPreview();
        await openNotifications();
    } catch (err) {
        alert('Could not clear notifications: ' + err.message);
        if (button) button.disabled = false;
    }
}

async function openNotificationTarget(id, target) {
    if (id) {
        try {
            await apiFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' });
            await loadNotificationCount();
        } catch {}
    }

    if (!target) return;
    if (typeof applyNotificationContext === 'function') applyNotificationContext(target);
    window.location.href = target;
}

async function openNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (!modal) return;

    modal.style.display = 'flex';

    const list = document.getElementById('notificationsList');
    const clearButton = document.getElementById('clearNotificationsBtn');
    if (!list) return;

    list.innerHTML = '<p class="notifications-empty">Loading...</p>';
    list.onclick = null;
    list.onkeydown = null;

    try {
        const data = await apiFetch('/notifications');
        const notifications = Array.isArray(data.notifications) ? data.notifications : [];
        if (clearButton) clearButton.disabled = notifications.length === 0;

        if (!notifications.length) {
            list.innerHTML = '<p class="notifications-empty">No notifications yet.</p>';
            await loadNotificationCount();
            return;
        }

        const esc = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value ?? '');
        const format = typeof formatDateTime === 'function'
            ? formatDateTime
            : (value) => value ? new Date(value).toLocaleString() : '';

        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        list.innerHTML = notifications.map(n => {
            const target = notificationDestination(n);
            const id = String(n.id ?? '');
            const cardClass = n.isRead ? 'notification-card' : 'notification-card unread';
            return `
                <div class="${cardClass}" role="listitem">
                    <div class="notification-card-main" data-notification-id="${esc(id)}" data-notification-target="${esc(target)}" tabindex="0" role="button" aria-label="Open notification">
                        <span class="notification-card-icon" aria-hidden="true">!</span>
                        <div class="notification-card-copy">
                            <p class="notification-card-title">${esc(n.title || 'Notification')}</p>
                            <p class="notification-card-message">${esc(n.message || '')}</p>
                            <p class="notification-card-time">${esc(format(n.createdAt))}</p>
                            <span class="notification-open-link" data-open-notification-id="${esc(id)}" data-open-target="${esc(target)}">Open related page -&gt;</span>
                        </div>
                    </div>
                    <button type="button" class="notification-delete-btn" data-delete-notification-id="${esc(id)}" aria-label="Delete notification">X</button>
                </div>`;
        }).join('');

        const handleNotificationOpen = async (item) => {
            if (!item) return;

            const id = item.getAttribute('data-notification-id');
            const target = item.getAttribute('data-notification-target');
            await openNotificationTarget(id, target);
        };

        list.onclick = async (event) => {
            const deleteButton = event.target.closest('[data-delete-notification-id]');
            if (deleteButton) {
                event.preventDefault();
                event.stopPropagation();
                await deleteNotification(deleteButton.getAttribute('data-delete-notification-id'));
                return;
            }

            const openLink = event.target.closest('[data-open-notification-id]');
            if (openLink) {
                event.preventDefault();
                event.stopPropagation();
                await openNotificationTarget(
                    openLink.getAttribute('data-open-notification-id'),
                    openLink.getAttribute('data-open-target')
                );
                return;
            }

            await handleNotificationOpen(event.target.closest('[data-notification-id]'));
        };

        list.onkeydown = async (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const item = event.target.closest('[data-notification-id]');
            if (!item) return;
            event.preventDefault();
            await handleNotificationOpen(item);
        };

        apiFetch('/notifications/read-all', { method: 'PUT' }).then(() => loadNotificationCount()).catch(() => {});
    } catch {
        if (clearButton) clearButton.disabled = true;
        list.innerHTML = '<p class="notifications-empty">Could not load notifications.</p>';
    }
}

function closeNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (!modal) return;

    modal.style.display = 'none';
}

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
            const target = notificationDestination(n) || '/parent/appointments.html';
            return `<div onclick="window.location.href='${target}'" style="cursor:pointer;padding:1rem;background:var(--bg-primary);border-radius:8px;border-left:4px solid ${n.isRead ? 'var(--border)' : 'var(--primary)'};">
                <div style="font-weight:600;margin-bottom:0.3rem;">${n.title}</div>
                <div style="font-size:0.85rem;color:var(--text-light);">${n.message || ''}</div>
            </div>`;
        }).join('');

        loadNotificationCount();
    } catch {
        document.getElementById('notifPreview').innerHTML = '<p style="color:var(--text-light);text-align:center;">Could not load notifications.</p>';
    }
}

let parentApptChart, parentChildrenChart;

        function initParentCharts() {
            parentApptChart = new Chart(document.getElementById('parentApptChart'), {
                type: 'doughnut',
                data: { labels: ['Pending', 'Approved', 'Completed'], datasets: [{ data: [0,0,0], backgroundColor: ['#F4D89F','#6B8E6F','#8BA98D'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
            });
            parentChildrenChart = new Chart(document.getElementById('parentChildrenChart'), {
                type: 'pie',
                data: { labels: ['Children'], datasets: [{ data: [0], backgroundColor: ['#6B8E6F'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
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
        document.addEventListener('DOMContentLoaded', () => { initNav(); initParentCharts(); loadDashboard(); loadParentAnalytics(); setInterval(()=>{loadDashboard();loadParentAnalytics();},5000); });
