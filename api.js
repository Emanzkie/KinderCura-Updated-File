// api.js - shared helpers for KinderCura
// Important:
// - keeps login/session helpers in one place
// - keeps parent/pedia notification bell behavior consistent on every page
// - keeps parent child/assessment context in sync across dashboard, results, and recommendations
// - refreshes the saved user from /auth/me so the latest profile picture appears after signup/profile updates

const API = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    ? 'http://localhost:3001/api'
    : '/api';

// Shared local-storage helper used across parent, pediatrician, and admin pages
const KC = {
    token:        () => localStorage.getItem('kc_token'),
    user:         () => { try { return JSON.parse(localStorage.getItem('kc_user')); } catch { return null; } },
    childId:      () => localStorage.getItem('kc_childId'),
    assessmentId: () => localStorage.getItem('kc_assessmentId'),
    set: (token, user, childId) => {
        localStorage.setItem('kc_token', token);
        localStorage.setItem('kc_user', JSON.stringify(user));
        if (childId) localStorage.setItem('kc_childId', childId);
    },
    clear: () => {
        ['kc_token', 'kc_user', 'kc_childId', 'kc_assessmentId', 'kc_viewChildId']
            .forEach((k) => localStorage.removeItem(k));
    }
};

// Shared fetch helper that automatically sends the JWT token
async function apiFetch(endpoint, options = {}) {
    const res = await fetch(`${API}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(KC.token() ? { Authorization: `Bearer ${KC.token()}` } : {}),
            ...options.headers
        }
    });

    let data = {};
    try {
        data = await res.json();
    } catch {
        data = {};
    }

    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
}

function requireAuth() {
    if (!KC.token()) {
        window.location.href = '/login.html';
        return false;
    }
    return true;
}

function logout() {
    KC.clear();
    window.location.href = '/login.html';
}

function fmtDate(d) {
    if (!d) return 'N/A';
    return new Date(d).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function fmtTime(t) {
    if (!t) return '';
    const s = String(t);
    if (s.includes('T') || s.includes('Z') || s.length > 8) {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
    }
    const parts = s.split(':');
    const h = parseInt(parts[0], 10);
    const m = parts[1] || '00';
    if (isNaN(h)) return s;
    return `${h % 12 || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function formatDateTime(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('en-US', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

// Returns the first notification badge found on the current page.
// This keeps the unread count working on both parent and admin dashboards.
function getNotificationBadge() {
    return document.querySelector('.notification-badge') || document.getElementById('notificationBadge') || null;
}

// Returns the modal list container used to render notification items.
// Parent and admin pages both use the same .notifications-list container.
function getNotificationList(modal) {
    if (!modal) return null;
    return modal.querySelector('.notifications-list') || modal.querySelector('#notificationsList') || null;
}

// Parent pages use one selected child at a time.
// These helpers keep dashboard/results/recommendations in sync.
function setParentContext(childId, assessmentId = null) {
    if (childId) localStorage.setItem('kc_childId', childId);
    if (assessmentId) localStorage.setItem('kc_assessmentId', assessmentId);
    else localStorage.removeItem('kc_assessmentId');
}

async function fetchParentChildren() {
    const data = await apiFetch('/children');
    return Array.isArray(data.children) ? data.children : [];
}

function getRequestedChildId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('childId') || KC.childId();
}

function getRequestedAssessmentId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('assessmentId') || KC.assessmentId();
}

async function getLatestCompletedAssessment(childId) {
    if (!childId) return null;
    const hist = await apiFetch(`/assessments/${childId}/history`);
    const completed = (hist.assessments || [])
        .filter((a) => (a.status === 'complete' || a.status === 'completed') && a.overallScore != null)
        .sort((a, b) => new Date(b.completedAt || b.startedAt || 0) - new Date(a.completedAt || a.startedAt || 0));
    return completed[0] || null;
}

function calcAgeDisplay(dob) {
    if (!dob) return '-';
    const d = new Date(dob);
    const now = new Date();
    let y = now.getFullYear() - d.getFullYear();
    let m = now.getMonth() - d.getMonth();
    if (m < 0) {
        y -= 1;
        m += 12;
    }
    return y > 0
        ? `${y} year${y > 1 ? 's' : ''} ${m} month${m !== 1 ? 's' : ''}`
        : `${m} month${m !== 1 ? 's' : ''}`;
}

// Decide where a notification should send the current user.
// If the backend saved an exact relatedPage, use that first.
function notificationDestination(n) {
    const role = String(KC.user()?.role || '').toLowerCase();
    const path = window.location.pathname.toLowerCase();
    const title = String(n?.title || '').toLowerCase();
    const type = String(n?.type || '').toLowerCase();
    const msg = String(n?.message || '').toLowerCase();
    const relatedPage = String(n?.relatedPage || '').trim();

    if (relatedPage) {
        return relatedPage;
    }

    if (role === 'pediatrician') {
        if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
        if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
        if (title.includes('custom question') || title.includes('assessment question') || title.includes('question answered') || type === 'assessment') return '/pedia/pedia-questions.html';
        if (title.includes('diagnosis') || title.includes('review') || title.includes('recommendation')) return '/pedia/pediatrician-patients.html';
        return '/pedia/pediatrician-dashboard.html';
    }

    if (role === 'secretary') {
        if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) {
            return title.includes('request') || msg.includes('request')
                ? '/secretary/secretary-approval.html'
                : '/secretary/secretary-appointments.html';
        }
        if (title.includes('patient') || msg.includes('patient')) return '/secretary/secretary-patients.html';
        return '/secretary/secretary-dashboard.html';
    }

    // PRC Verification notifications route to the admin verification page
    if (role === 'admin' || path.includes('/admin/')) {
        if (title.includes('prc') || title.includes('verification') || title.includes('license') || type === 'prc_verification' || msg.includes('prc verification') || msg.includes('pediatrician registration')) {
            var pediaId = n && n.relatedId ? Number(n.relatedId) : null;
            return pediaId ? '/admin/prc-verification?pediatricianId=' + pediaId : '/admin/prc-verification';
        }
    }

    if (title.includes('review completed') || title.includes('diagnosis') || msg.includes('diagnosis') || msg.includes('open results')) {
        return '/parent/results.html';
    }
    if (title.includes('recommendation') || msg.includes('recommendation')) {
        return '/parent/recommendations.html';
    }
    if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) {
        return '/parent/appointments.html';
    }
    if (type === 'chat' || title.includes('message') || msg.includes('message from')) {
        return '/parent/chat.html';
    }
    if (type === 'assessment' || title.includes('assessment question') || title.includes('custom question') || title.includes('new assessment question') || title.includes('question assigned') || msg.includes('assigned a new custom question')) {
        return '/parent/custom-questions.html';
    }
    return '/parent/dashboard.html';
}

// When a notification already knows the exact child/assessment, store that context
// before navigation so the Results page opens the correct diagnosis immediately.
function applyNotificationContext(target) {
    const safeTarget = String(target || '').trim();
    if (!safeTarget) return;

    try {
        const url = new URL(safeTarget, window.location.origin);
        const childId = url.searchParams.get('childId');
        const assessmentId = url.searchParams.get('assessmentId');

        if (childId || assessmentId) {
            setParentContext(childId || KC.childId(), assessmentId || KC.assessmentId());
        }
    } catch {
        // If the target is not a parseable URL, navigation can still continue safely.
    }
}

// Applies one user object to all shared nav/profile UI.
function applyNavUser(user) {
    if (!user) return;

    const welcomeEl = document.getElementById('welcomeName') || document.getElementById('navWelcome') || document.querySelector('.menu-header p');
    if (welcomeEl) {
        welcomeEl.textContent = user.role === 'pediatrician'
            ? `Welcome, Dr. ${user.firstName || 'User'}`
            : `Welcome, ${user.firstName || 'User'}`;
    }

    const profileSrc = (user.profileIcon && String(user.profileIcon).startsWith('/uploads/'))
        ? user.profileIcon
        : '/icons/profile.png';

    document.querySelectorAll('.profile-icon').forEach((img) => {
        img.src = profileSrc;
        img.style.borderRadius = '50%';
        img.style.objectFit = 'cover';
    });
}

// Refreshes the saved user so the latest profile icon appears immediately
// after registration, profile edit, or redirects back to dashboard/results pages.
async function refreshCurrentUser() {
    if (!KC.token()) return KC.user();

    try {
        const data = await apiFetch('/auth/me');
        if (data && data.user) {
            const mergedUser = { ...(KC.user() || {}), ...data.user };
            localStorage.setItem('kc_user', JSON.stringify(mergedUser));
            return mergedUser;
        }
    } catch {
        // Keep cached user when the refresh endpoint is temporarily unavailable.
    }

    return KC.user();
}

async function initNav() {
    const cachedUser = KC.user();
    if (cachedUser) applyNavUser(cachedUser);

    const freshUser = await refreshCurrentUser();
    if (freshUser) applyNavUser(freshUser);

    loadNotificationCount();
}

// Keep the bell badge updated everywhere
async function loadNotificationCount() {
    const badge = getNotificationBadge();
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

async function markNotificationRead(id) {
    try {
        await apiFetch(`/notifications/${id}/read`, { method: 'PUT' });
        await loadNotificationCount();
    } catch {}
}

async function deleteNotification(id) {
    if (!confirm('Remove this notification?')) return;
    try {
        await apiFetch(`/notifications/${id}`, { method: 'DELETE' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not remove notification: ' + err.message);
    }
}

async function clearAllNotifications() {
    if (!confirm('Clear all notifications?')) return;
    try {
        await apiFetch('/notifications/clear-all', { method: 'DELETE' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not clear notifications: ' + err.message);
    }
}

async function markAllNotificationsRead() {
    try {
        await apiFetch('/notifications/read-all', { method: 'PUT' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not mark notifications as read: ' + err.message);
    }
}

// Mark read first, then move to the related page
async function goToNotificationTarget(id, target) {
    await markNotificationRead(id);
    applyNotificationContext(target);
    window.location.href = target;
}

// Shared notification modal renderer used by parent and pediatrician pages.
// The related-page action uses data attributes plus one delegated click handler
// so URLs with childId/assessmentId query params stay safe and clickable.
async function openNotifications() {
    const modal = document.getElementById('notificationsModal');
    const listEl = getNotificationList(modal);
    if (!modal || !listEl) return;

    modal.style.display = 'flex';
    listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Loading...</p>';
    listEl.onclick = null;

    try {
        const data = await apiFetch('/notifications');
        const notifications = Array.isArray(data.notifications) ? data.notifications : [];

        if (!notifications.length) {
            listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1.5rem;">No notifications yet.</p>';
            return;
        }

        const hasUnread = notifications.some((n) => !n.isRead);
        const tools = `
            <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:#c0392b;padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
            </div>`;

        const items = notifications.map((n) => {
            const dest = notificationDestination(n);
            const unreadStyle = n.isRead ? '' : 'background:#f0f7f0;border-left:3px solid var(--primary);';
            const safeId = escapeHtml(String(n.id ?? ''));
            const safeDest = escapeHtml(String(dest || ''));

            return `
                <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                    <div
                        data-notification-id="${safeId}"
                        ${dest ? `data-notification-target="${safeDest}"` : ''}
                        style="flex:1;cursor:${dest ? 'pointer' : 'default'};min-width:0;"
                    >
                        <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                        <p style="font-size:.82rem;color:#555;margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                        <p style="font-size:.75rem;color:#aaa;margin:0;">${formatDateTime(n.createdAt)}</p>
                        ${dest ? `
                            <button
                                type="button"
                                data-open-notification-id="${safeId}"
                                data-open-target="${safeDest}"
                                style="margin-top:.45rem;border:none;background:none;color:var(--primary);padding:0;cursor:pointer;font-size:.78rem;font-weight:600;"
                            >
                                Open related page ->
                            </button>` : ''}
                    </div>
                    <button
                        type="button"
                        data-delete-notification-id="${safeId}"
                        title="Remove notification"
                        style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;"
                    >
                        X
                    </button>
                </div>`;
        }).join('');

        listEl.innerHTML = tools + items;

        listEl.onclick = async (event) => {
            const deleteBtn = event.target.closest('[data-delete-notification-id]');
            if (deleteBtn) {
                event.preventDefault();
                event.stopPropagation();
                await deleteNotification(deleteBtn.getAttribute('data-delete-notification-id'));
                return;
            }

            const openBtn = event.target.closest('[data-open-notification-id]');
            if (openBtn) {
                event.preventDefault();
                event.stopPropagation();
                await goToNotificationTarget(
                    openBtn.getAttribute('data-open-notification-id'),
                    openBtn.getAttribute('data-open-target')
                );
                return;
            }

            const item = event.target.closest('[data-notification-id]');
            if (!item) return;

            const notificationId = item.getAttribute('data-notification-id');
            const target = item.getAttribute('data-notification-target');

            if (target) {
                await goToNotificationTarget(notificationId, target);
            } else {
                await markNotificationRead(notificationId);
                await openNotifications();
            }
        };
    } catch {
        listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Could not load notifications.</p>';
        listEl.onclick = null;
    }
}

function closeNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (modal) modal.style.display = 'none';
}

function toggleProfileMenu() {
    const menu = document.getElementById('profileMenu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

async function downloadWithAuth(endpoint, filename = 'export.json') {
    const res = await fetch(`${API}${endpoint}`, {
        headers: { Authorization: `Bearer ${KC.token()}` }
    });

    if (!res.ok) {
        let msg = `Error ${res.status}`;
        try {
            const data = await res.json();
            msg = data.error || msg;
        } catch {}
        throw new Error(msg);
    }

    const data = await res.json();
    const blob = new Blob([JSON.stringify(data.data ?? data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-btn')) {
        const menu = document.getElementById('profileMenu');
        if (menu) menu.style.display = 'none';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    initNav();
    document.querySelectorAll('a.logout').forEach((a) => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            logout();
        });
    });
});

// Close the notifications modal when clicking the dark backdrop.
document.addEventListener('click', (e) => {
    const modal = document.getElementById('notificationsModal');
    if (modal && e.target === modal) {
        closeNotifications();
    }
});
