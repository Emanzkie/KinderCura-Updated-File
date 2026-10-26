// api.js - shared helpers for KinderCura
// Important:
// - keeps login/session helpers in one place
// - decides where a notification leads (notificationDestination) and keeps the bell badge count current
// - keeps parent child/assessment context in sync across dashboard, results, and recommendations
// - refreshes the saved user from /auth/me so the latest profile picture appears after signup/profile updates

// NOTE: API and KC are attached to window rather than declared with `const`.
// Several page scripts (the pediatrician pages, PARENT/profile.js) declare
// their own top-level `const API` / `const KC`. Two `const` declarations of the
// same name across two classic scripts is a SyntaxError that kills the whole
// page, which is why those pages could not include this file at all — and so
// never got the shared navbar/avatar/notification initialisation.
// Assigning to window keeps this file collision-free: a page that declares its
// own API/KC simply shadows these, exactly as it does today.
window.API = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    ? 'http://localhost:3001/api'
    : '/api';

// Shared local-storage helper used across parent, pediatrician, and admin pages
window.KC = {
    token:        () => localStorage.getItem('kc_token'),
    user:         () => { try { return JSON.parse(localStorage.getItem('kc_user')); } catch { return null; } },
    childId:      () => localStorage.getItem('kc_childId'),
    assessmentId: () => localStorage.getItem('kc_assessmentId'),
    set: (token, user, childId) => {
        localStorage.setItem('kc_token', token);
        localStorage.setItem('kc_user', JSON.stringify(user));
        if (childId) localStorage.setItem('kc_childId', childId);
    },
    // Every kc_* key the app writes must be listed here. kc_viewChildName in
    // particular used to survive logout, so the next user to sign in on a
    // shared computer could see the previous patient's name on the Results
    // page before their own data loaded.
    clear: () => {
        [
            'kc_token', 'kc_user', 'kc_childId', 'kc_assessmentId',
            'kc_viewChildId', 'kc_viewChildName', 'kc_prefPediaId',
            'kc_preAssessmentRequired', 'kc_remember',
        ].forEach((k) => localStorage.removeItem(k));
        document.cookie = 'kc_session=; path=/; max-age=0; SameSite=Lax';
    }
};

// "Remember me" left unchecked at login (kc_remember = '0') means the session
// should end when the browser closes. login.js then also sets kc_session, a
// cookie with no expiry, which the browser drops on close. Seeing kc_remember
// '0' without that cookie means the browser was closed since login, so the
// stored session is cleared before any page uses it.
if (localStorage.getItem('kc_remember') === '0' && !/(?:^|;\s*)kc_session=1(?:;|$)/.test(document.cookie)) {
    window.KC.clear();
}

// Parent pages (/parent/...) are for parent-side accounts. A signed-in
// pediatrician, secretary or admin who lands on one is sent to their own
// dashboard. Only three parent pages used to check this themselves, and none
// of them handled secretaries. The invitation page is left alone: an invited
// person may open it while signed in to another account. The server still
// enforces access on every API call; this only keeps staff off the wrong UI.
//
// Exception: the Results page has a pediatrician mode (js/parent/results.js)
// that "Open full report" on My Patients opens in a new tab, so a pediatrician
// is let through there. Secretaries and admins are not: nothing links them to it.
(function redirectStaffAwayFromParentPages() {
    const allowedParentPages = { pediatrician: ['/parent/results.html'] };
    const path = String((window.location && window.location.pathname) || '').toLowerCase();
    if (!path.startsWith('/parent/') || path.startsWith('/parent/accept-invitation')) return;
    const user = window.KC.user();
    if (!user || !window.KC.token()) return;
    if ((allowedParentPages[user.role] || []).includes(path)) return;
    const staffHome = {
        admin: '/admin/admin-dashboard.html',
        pediatrician: '/pedia/pediatrician-dashboard.html',
        secretary: '/secretary/secretary-dashboard.html',
    }[user.role];
    if (staffHome) window.location.replace(staffHome);
})();

// Repeats fn every intervalMs, but only while the tab is visible, and never
// starts a run while the previous one is still waiting on the server. A plain
// setInterval kept the dashboard firing its API calls every few seconds in
// background tabs that nobody was looking at. When the tab becomes visible
// again after missing at least one interval, fn runs once straight away so
// the page catches up. It does not run on start — callers already do their
// first load. Returns { stop() }.
window.KC.poll = function poll(fn, intervalMs) {
    let running = false;
    let stopped = false;
    let lastRun = Date.now();

    const tick = async () => {
        if (stopped || running || document.visibilityState === 'hidden') return;
        running = true;
        lastRun = Date.now();
        try {
            await fn();
        } catch (err) {
            console.error('[KC.poll]', err);
        } finally {
            running = false;
        }
    };
    const onVisibilityChange = () => {
        if (document.visibilityState === 'visible' && Date.now() - lastRun >= intervalMs) tick();
    };

    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return {
        stop() {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        },
    };
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

    if (!res.ok) {
        // 401 on a signed-in request means the session is over (expired, or the
        // account was removed). Sign-in itself also answers 401 for a wrong
        // password, so it and the sign-in page are left alone.
        if (res.status === 401 && KC.token() && !endpoint.startsWith('/auth/login') && !/login\.html$/.test(window.location.pathname)) {
            KC.clear();
            window.location.href = '/login.html';
        }
        // `error` can be an object (e.g. { code, message }); never show "[object Object]".
        const e = data.error;
        const text = typeof e === 'string' ? e
            : (e && typeof e === 'object' ? ([e.code, e.message].filter(Boolean).join(': ') || JSON.stringify(e)) : '');
        throw new Error(text || `Error ${res.status}`);
    }
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

// Appends the id a target page knows how to open. Only pages that actually read
// the parameter get one: the pediatrician appointments page focuses the card
// for ?appointmentId=, and the admin PRC page opens the review for
// ?pediatricianId= (the pediatrician's user _id, which auth.js stores as
// relatedId on "New PRC Verification Request").
// A page on this site: one leading slash, no scheme, no host ("//host" or
// "/\host" would leave the site), no whitespace or control characters.
function isSitePath(value) {
    return typeof value === 'string' && /^\/(?![\/\\])[^\s\u0000-\u001f]*$/.test(value);
}

function notificationDeepLink(page, relatedId) {
    if (!relatedId || page.includes('?')) return page;
    const path = page.split('#')[0].toLowerCase();
    if (path === '/pedia/pediatrician-appointments.html') return `${page}?appointmentId=${encodeURIComponent(relatedId)}`;
    if (path === '/admin/prc-verification') return `${page}?pediatricianId=${encodeURIComponent(relatedId)}`;
    return page;
}

// Decide where a notification should send the current user. The backend's
// relatedPage wins; otherwise the title/type decide, per role. Returns null
// when no page fits, and the bell then only marks the notification read
// instead of sending the user somewhere unrelated.
function notificationDestination(n) {
    const role = String(KC.user()?.role || '').toLowerCase();
    const title = String(n?.title || '').toLowerCase();
    const type = String(n?.type || '').toLowerCase();
    const msg = String(n?.message || '').toLowerCase();
    const relatedPage = String(n?.relatedPage || '').trim();
    const relatedId = String(n?.relatedId ?? '').trim();
    const says = (...words) => words.some((w) => title.includes(w) || msg.includes(w));

    // Only a page on this site is followed. Anything else ("javascript:...",
    // another host) is ignored, so a bad value stored earlier cannot run when
    // the notification is clicked; the bell then just marks it read.
    if (relatedPage) return isSitePath(relatedPage) ? notificationDeepLink(relatedPage, relatedId) : null;

    if (role === 'admin') {
        if (type === 'prc_verification' || title.includes('prc') || title.includes('license') || says('prc verification', 'pediatrician registration')) {
            return notificationDeepLink('/admin/prc-verification', relatedId);
        }
        if (title.includes('pending') || title.includes('registration') || says('approval')) return '/admin/admin-users.html';
        if (type === 'payment' || title.includes('payment')) return '/admin/payments';
        return null;
    }

    if (role === 'pediatrician') {
        if (type === 'payment' || title.includes('payment')) return notificationDeepLink('/pedia/pediatrician-appointments.html', relatedId);
        if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
        if (type === 'appointment' || says('appointment')) return '/pedia/pediatrician-appointments.html';
        if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question answered') || title.includes('question set')) return '/pedia/pedia-questions.html';
        if (says('diagnosis', 'recommendation') || title.includes('review')) return '/pedia/pediatrician-patients.html';
        return null;
    }

    if (role === 'secretary') {
        if (type === 'appointment' || says('appointment')) {
            return says('request') ? '/secretary/secretary-approval.html' : '/secretary/secretary-appointments.html';
        }
        if (says('patient')) return '/secretary/secretary-patients.html';
        return null;
    }

    // Parent and the other guardian roles share the /parent pages.
    if (title.includes('review completed') || says('diagnosis', 'open results') || title.includes('result')) return '/parent/results.html';
    if (says('recommendation')) return '/parent/recommendations.html';
    if (type === 'payment' || type === 'appointment' || says('appointment')) return '/parent/appointments.html';
    if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/parent/chat.html';
    if (type === 'assessment' || title.includes('assessment question') || title.includes('custom question') || title.includes('question assigned') || msg.includes('assigned a new custom question')) {
        return '/parent/custom-questions.html';
    }
    return null;
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

    const hasUpload = user.profileIcon && String(user.profileIcon).startsWith('/uploads/');
    const profileSrc = hasUpload ? user.profileIcon : '/icons/profile.png';
    const srcSuffix = hasUpload ? `?t=${Date.now()}` : '';

    const navPic = document.getElementById('navProfilePic');
    if (navPic) {
        navPic.src = profileSrc + srcSuffix;
        navPic.style.objectFit = 'cover';
    }

    // Admin and secretary pages have no #navProfilePic — they mark the avatar
    // with .profile-icon only, so both selectors are always applied.
    document.querySelectorAll('.profile-icon').forEach((img) => {
        if (img.id === 'navProfilePic') return;
        if (img.tagName !== 'IMG') return;
        img.src = profileSrc + srcSuffix;
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
            const cached = KC.user() || {};
            const mergedUser = { ...cached, ...data.user };
            // Preserve uploaded avatar if server returns default/non-uploaded icon
            if (
                cached.profileIcon &&
                String(cached.profileIcon).startsWith('/uploads/') &&
                (
                    !mergedUser.profileIcon ||
                    !String(mergedUser.profileIcon).startsWith('/uploads/')
                )
            ) {
                mergedUser.profileIcon = cached.profileIcon;
            }
            localStorage.setItem('kc_user', JSON.stringify(mergedUser));
            return mergedUser;
        }
    } catch {
        // Keep cached user when the refresh endpoint is temporarily unavailable.
    }

    return KC.user();
}

// Ten pages call initNav() themselves AND get the DOMContentLoaded call at the
// bottom of this file, so every one of them used to hit /auth/me twice and
// repaint the avatar four times. The in-flight promise is shared so concurrent
// callers collapse into a single round trip; a later call (e.g. after a photo
// upload) still refreshes, because the latch is cleared once it settles.
let navInitPromise = null;

// Marks the navbar item that points at the page you are currently on.
//
// Every page hardcodes its own `class="nav-link active"`, and several were
// simply missing it — the pediatrician Dashboard highlighted nothing at all,
// so there was no way to tell where you were. The admin pages already solved
// this with assets/js/admin-nav.js; this does the same for every role from the
// one shared file, and stays idempotent so running after admin-nav.js is safe.
//
// Only ADDS the class, and only on an exact path match, so pages that are not
// navbar destinations (Profile, Settings, Screening) correctly highlight
// nothing.
function highlightActiveNavLink() {
    const links = document.querySelectorAll('.main-nav .nav-link');
    if (!links.length) return;

    const here = window.location.pathname.replace(/\/+$/, '').toLowerCase();
    const hereFile = here.split('/').pop();

    links.forEach((link) => {
        const href = (link.getAttribute('href') || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
        if (!href || href.startsWith('http')) return;
        const linkFile = href.split('/').pop();
        if (href === here || (linkFile && linkFile === hereFile)) {
            link.classList.add('active');
            link.setAttribute('aria-current', 'page');
        }
    });
}

async function initNav() {
    if (navInitPromise) return navInitPromise;

    navInitPromise = (async () => {
        highlightActiveNavLink();

        const cachedUser = KC.user();
        if (cachedUser) applyNavUser(cachedUser);

        const freshUser = await refreshCurrentUser();
        if (freshUser) applyNavUser(freshUser);

        await loadNotificationCount();
    })();

    try {
        return await navInitPromise;
    } finally {
        navInitPromise = null;
    }
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

// The bell modal itself (open, close, dismiss, mark all read, clear all) lives
// in /notifications-card-ui.js, which every page with a bell loads after this file.

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
