// api.js — KinderCura shared helpers
const API = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    ? 'http://localhost:3000/api'
    : '/api';

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
        ['kc_token','kc_user','kc_childId','kc_assessmentId'].forEach(k => localStorage.removeItem(k));
    }
};

// Base fetch with auth header
async function apiFetch(endpoint, options = {}) {
    const res = await fetch(`${API}${endpoint}`, {
        ...options,
        headers: { 'Content-Type':'application/json', ...(KC.token() ? { Authorization:`Bearer ${KC.token()}` } : {}), ...options.headers }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
}

function requireAuth() {
    if (!KC.token()) { window.location.href = 'login.html'; return false; }
    return true;
}

function logout() {
    KC.clear();
    window.location.href = 'login.html';
}

// ── Format helpers ────────────────────────────────────────────
function fmtDate(d) {
    if (!d) return 'N/A';
    const str = String(d).split('T')[0];
    const parts = str.split('-');
    if (parts.length === 3) {
        const months = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        return `${months[parseInt(parts[1])-1]} ${parseInt(parts[2])}, ${parts[0]}`;
    }
    return str;
}

function fmtTime(t) {
    if (!t) return '';
    const parts = String(t).split(':');
    const h = parseInt(parts[0]);
    const m = parts[1] || '00';
    if (isNaN(h)) return String(t);
    return `${h%12||12}:${m} ${h>=12?'PM':'AM'}`;
}

// ── Nav init: name + profile photo ───────────────────────────
function initNav() {
    const user = KC.user();
    if (!user) return;

    // Welcome text
    const namedEl = document.getElementById('welcomeName');
    if (!namedEl) {
        const w = document.querySelector('.menu-header p');
        if (w) w.textContent = `Welcome, ${user.firstName}`;
    }

    // Profile picture
    if (user.profileIcon && user.profileIcon.startsWith('/uploads/')) {
        document.querySelectorAll('.profile-icon').forEach(img => {
            img.src = user.profileIcon;
            img.style.borderRadius = '50%';
            img.style.objectFit = 'cover';
        });
    }

    loadNotificationCount();
}

// ── Notification count badge ──────────────────────────────────
async function loadNotificationCount() {
    try {
        const res  = await fetch(`${API}/notifications/count`, {
            headers: { Authorization: `Bearer ${KC.token()}` }
        });
        const data = await res.json();
        const badge = document.querySelector('.notification-badge');
        if (badge) badge.textContent = data.unread || 0;
    } catch(e) { /* silent */ }
}

// ── Open notifications modal — newest first ───────────────────
async function openNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (!modal) return;
    modal.style.display = 'flex';

    const listEl = modal.querySelector('.notifications-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Loading...</p>';

    try {
        // Fetch notifications — backend returns ORDER BY createdAt DESC (newest first)
        const res  = await fetch(`${API}/notifications`, {
            headers: { Authorization: `Bearer ${KC.token()}` }
        });
        const data = await res.json();

        if (!data.success || !data.notifications || data.notifications.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1.5rem;">No notifications yet.</p>';
            return;
        }

        // Render newest first (already sorted by backend)
        listEl.innerHTML = data.notifications.map(n => `
            <div class="notification-item" style="${n.isRead ? '' : 'background:#f0f7f0;border-left:3px solid var(--primary);'}">
                <div style="flex:1;">
                    <p style="font-weight:${n.isRead?'400':'700'};font-size:.9rem;margin:0 0 .2rem;">${n.title}</p>
                    <p style="font-size:.82rem;color:#555;margin:0 0 .2rem;">${n.message}</p>
                    <p style="font-size:.75rem;color:#aaa;margin:0;">${fmtDate(n.createdAt)}</p>
                </div>
            </div>
        `).join('');

        // Mark all as read
        await fetch(`${API}/notifications/read-all`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${KC.token()}` }
        });
        const badge = document.querySelector('.notification-badge');
        if (badge) badge.textContent = 0;

    } catch(e) {
        listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Could not load notifications.</p>';
    }
}

function closeNotifications() {
    const m = document.getElementById('notificationsModal');
    if (m) m.style.display = 'none';
}

function toggleProfileMenu() {
    const menu = document.getElementById('profileMenu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Close profile menu on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-btn')) {
        const m = document.getElementById('profileMenu');
        if (m) m.style.display = 'none';
    }
});

// Wire logout + init on load
document.addEventListener('DOMContentLoaded', () => {
    initNav();
    document.querySelectorAll('a.logout').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); logout(); });
    });
});
