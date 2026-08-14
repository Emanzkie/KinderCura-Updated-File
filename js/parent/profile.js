// === Extracted from PARENT\profile.html (script block 1) ===
/* ─────────────────────────────────────────────
   api.js — KinderCura shared helpers (inlined)
───────────────────────────────────────────── */
// Backend API base URL used by this page
const API = window.location.origin + '/api';
// Uses the current site origin so the same code works on localhost and when deployed.

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

// Shared fetch helper for this page
// Automatically sends the JWT token in Authorization header
async function apiFetch(endpoint, options = {}) {
    const res = await fetch(`${API}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(KC.token() ? { Authorization: `Bearer ${KC.token()}` } : {}),
            ...options.headers
        }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
}

// Redirect to login if there is no saved token
function requireAuth() {
    if (!KC.token()) { window.location.href = '/login.html'; return false; }
    return true;
}

function logout() {
    KC.clear();
    window.location.href = '/login.html';
}

// Fill the top-right nav with the logged-in user's name and profile photo
function initNav() {
    const user = KC.user();
    if (!user) return;
    const w = document.querySelector('.menu-header p');
    if (w) w.textContent = `Welcome, ${user.firstName}`;

    const hasUpload = user.profileIcon && String(user.profileIcon).startsWith('/uploads/');
    const profileSrc = hasUpload ? user.profileIcon : '/icons/profile.png';
    const srcSuffix = hasUpload ? `?t=${Date.now()}` : '';

    const navPic = document.getElementById('navProfilePic');
    if (navPic) {
        navPic.src = profileSrc + srcSuffix;
        navPic.style.objectFit = 'cover';
    }

    document.querySelectorAll('.profile-icon').forEach(img => {
        if (img.id === 'navProfilePic') return;
        img.src = profileSrc + srcSuffix;
        img.style.borderRadius = '50%';
        img.style.objectFit = 'cover';
    });

    document.querySelectorAll('.nav-user-name').forEach(el => { el.textContent = user.firstName; });
    loadNotificationCount();
}

async function loadNotificationCount() {
    try {
        const data = await apiFetch('/notifications/count');
        const badge = document.querySelector('.notification-badge');
        if (badge) {
            badge.textContent = data.unread || 0;
            badge.style.display = data.unread > 0 ? 'flex' : 'none';
        }
    } catch (e) {}
}

async function openNotifications() {
    const m = document.getElementById('notificationsModal');
    if (m) {
        m.style.display = 'flex';
        const list = document.querySelector('.notifications-list');
        if (list) {
            list.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading…</p>';
            try {
                const data = await apiFetch('/notifications');
                const notifs = data.notifications || [];
                if (notifs.length === 0) {
                    list.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:2rem;">No notifications yet.</p>';
                } else {
                    list.innerHTML = notifs.map(n => `
                        <div style="padding:1rem;border-bottom:1px solid var(--border);${n.isRead?'':'background:#f0f7f1;'}" onclick="markRead(${n.id},this)">
                            <p style="font-weight:${n.isRead?'400':'600'};margin:0 0 .3rem;color:var(--text-dark);">${n.title}</p>
                            <p style="font-size:.82rem;color:var(--text-light);margin:0 0 .3rem;">${n.message||''}</p>
                            <p style="font-size:.75rem;color:#aaa;margin:0;">${new Date(n.createdAt).toLocaleString()}</p>
                        </div>`).join('');
                    apiFetch('/notifications/read-all', { method: 'PUT' }).then(() => loadNotificationCount());
                }
            } catch (e) {
                list.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Could not load notifications.</p>';
            }
        }
    }
}

async function markRead(id, el) {
    try {
        await apiFetch(`/notifications/${id}/read`, { method: 'PUT' });
        el.style.background = '';
        el.querySelector('p').style.fontWeight = '400';
        loadNotificationCount();
    } catch (e) {}
}

function closeNotifications() {
    const m = document.getElementById('notificationsModal');
    if (m) m.style.display = 'none';
}

function toggleProfileMenu() {
    const menu = document.getElementById('profileMenu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-btn')) {
        const m = document.getElementById('profileMenu');
        if (m) m.style.display = 'none';
    }
});

/* ─────────────────────────────────────────────
   profile.html page logic
───────────────────────────────────────────── */
requireAuth();

// Upload parent or child profile picture
// type = 'parent' or 'child'
// childId is only needed when uploading a child's photo
async function uploadProfilePhoto(input, type, childId) {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photo', file);
    const url = type === 'child' ? `/upload/child/${childId}` : '/upload/profile';
    try {
        const res  = await fetch(`${API}${url}`, { method:'POST', headers:{Authorization:`Bearer ${KC.token()}`}, body:fd });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Upload failed');

        if (type === 'child') {
            const childPic = document.getElementById(`childProfilePic_${childId}`);
            if (childPic) childPic.src = data.path;
        } else {
            const parentPic = document.getElementById('parentProfilePic');
            if (parentPic) parentPic.src = data.path;
            const user = KC.user() || {};
            user.profileIcon = data.path;
            localStorage.setItem('kc_user', JSON.stringify(user));
            document.querySelectorAll('.profile-icon').forEach(img => {
                img.src = data.path;
                img.style.borderRadius = '50%';
                img.style.objectFit = 'cover';
            });
        }

        await loadProfile();
        if (typeof initNav === 'function') initNav();
        alert('Photo updated successfully!');
    } catch(e) {
        alert('Upload failed: ' + e.message);
    }
}

// Small helper to render one read-only info row
function field(label, value) {
    return `<div class="field-row">
        <p class="field-label">${label}</p>
        <p class="field-value">${value || '—'}</p>
    </div>`;
}

function calcAge(dob) {
    const d = new Date(dob), now = new Date();
    let y = now.getFullYear() - d.getFullYear(), m = now.getMonth() - d.getMonth();
    if (m < 0) { y--; m += 12; }
    return y > 0 ? `${y} yr${y>1?'s':''} ${m} mo` : `${m} month${m!==1?'s':''}`;
}

// Load parent profile + child list from MongoDB routes
// This is the main function that fills the page after login
async function loadProfile() {
    console.log('[loadProfile] Starting...');
    let user = KC.user();
    try {
        const userData = await apiFetch('/auth/me');
        console.log('[loadProfile] User data from API:', userData);
        if (userData && userData.user) {
            const cached = KC.user() || {};
            const mergedUser = { ...cached, ...userData.user };
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
            user = mergedUser;
            localStorage.setItem('kc_user', JSON.stringify(mergedUser));
        }
    } catch(e) { 
        console.error('[loadProfile] Could not fetch fresh user data:', e.message); 
    }

    if (user) {
        console.log('[loadProfile] Setting parent fields for user:', user.firstName, user.lastName);
        const hasUpload = user.profileIcon && String(user.profileIcon).startsWith('/uploads/');
        const profileSrc = hasUpload ? user.profileIcon : '/icons/profile.png';
        const srcSuffix = hasUpload ? `?t=${Date.now()}` : '';

        if (hasUpload) {
            const pic = document.getElementById('parentProfilePic');
            if (pic) pic.src = user.profileIcon;
        }

        const navPic = document.getElementById('navProfilePic');
        if (navPic) {
            navPic.src = profileSrc + srcSuffix;
            navPic.style.objectFit = 'cover';
        }

        document.querySelectorAll('.profile-icon').forEach(img => {
            if (img.id === 'navProfilePic') return;
            img.src = profileSrc + srcSuffix;
            img.style.borderRadius = '50%';
            img.style.objectFit = 'cover';
        });
        document.getElementById('parentFields').innerHTML =
            field('Name', [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ')) +
            field('Email', user.email) +
            field('Username', user.username) +
            field('Account Type', user.role.charAt(0).toUpperCase()+user.role.slice(1));
        document.getElementById('editFirst').value = user.firstName || '';
        document.getElementById('editLast').value  = user.lastName || '';
    } else {
        console.warn('[loadProfile] No user data available');
    }

    try {
        console.log('[loadProfile] Fetching children...');
        const data = await apiFetch('/children');
        console.log('[loadProfile] Children data from API:', data);
        const children = data.children;
        if (children && children.length) {
            // Keep the currently selected child if it still exists.
            const savedChildId = localStorage.getItem('kc_childId');
            const hasSavedChild = children.some(c => c.id === savedChildId);
            if (!hasSavedChild) {
                localStorage.setItem('kc_childId', children[0].id);
            }
            let html = '';
            children.forEach((c) => {
                const dob = new Date(c.dateOfBirth);
                const childPic = c.profileIcon && c.profileIcon.startsWith('/uploads/') ? c.profileIcon : '/icons/profile.png';
                html += `
                <div class="child-card">
                    <div class="child-card-left">
                        <div class="child-photo-upload">
                            <img id="childProfilePic_${c.id}" src="${childPic}">
                            <label for="childPhotoUpload_${c.id}" class="child-photo-edit" title="Change photo">📷</label>
                            <input type="file" id="childPhotoUpload_${c.id}" accept="image/*" style="display:none;" onchange="uploadProfilePhoto(this,'child','${c.id}')">
                        </div>
                        <p class="child-photo-hint">Click 📷 to update</p>
                    </div>
                    <div class="child-card-right">
                        <div class="fields-grid">
                            ${field('Name', [c.firstName, c.middleName, c.lastName].filter(Boolean).join(' '))}
                            ${field('Date of Birth', dob.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}))}
                            ${field('Age', calcAge(c.dateOfBirth))}
                            ${field('Gender', c.gender ? c.gender.charAt(0).toUpperCase()+c.gender.slice(1) : '—')}
                            ${field('Relationship', c.relationship || '—')}
                        </div>
                        <button class="btn btn-primary btn-full-small" onclick="localStorage.setItem('kc_childId','${c.id}');window.location.href='/parent/screening.html'">Start Screening</button>
                    </div>
                </div>`;
            });
            document.getElementById('childFields').innerHTML = html;
        } else {
            document.getElementById('childFields').innerHTML = '<p class="hint-text" style="text-align:center;">No child registered yet.</p>';
        }
    } catch (e) {
        console.error('Child load error:', e);
        document.getElementById('childFields').innerHTML = `<p style="color:var(--text-light);text-align:center;padding:1rem;">Could not load child info.</p>`;
    }
}

function toggleEditParent() {
    const form = document.getElementById('editParentForm');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
}
function toggleChangePassword() {
    const form = document.getElementById('changePasswordForm');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
}
function showAddChildForm() {
    document.getElementById('addChildForm').style.display = 'block';
}

// Save edited parent name fields to /api/auth/update-profile
async function saveParentProfile() {
    const err = document.getElementById('editErr');
    err.style.display = 'none';
    const firstName = document.getElementById('editFirst').value.trim();
    const lastName  = document.getElementById('editLast').value.trim();
    if (!firstName || !lastName) { err.textContent='Name is required.'; err.style.display='block'; return; }
    try {
        const data = await apiFetch('/auth/update-profile', {
            method:'PUT',
            body: JSON.stringify({ firstName, lastName })
        });
        if (data.user) {
            localStorage.setItem('kc_user', JSON.stringify(data.user));
        }
        toggleEditParent();
        await loadProfile();
        alert('Profile updated!');
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
    }
}

// Save a new password to /api/auth/change-password
async function changePassword() {
    const err = document.getElementById('pwErr');
    err.style.display = 'none';
    const pw  = document.getElementById('newPw').value;
    const cpw = document.getElementById('confirmPw').value;
    if (pw.length < 8) { err.textContent='Password must be at least 8 characters.'; err.style.display='block'; return; }
    if (pw !== cpw)    { err.textContent='Passwords do not match.'; err.style.display='block'; return; }
    try {
        await apiFetch('/auth/change-password', {
            method:'PUT',
            body: JSON.stringify({ password: pw })
        });
        document.getElementById('newPw').value = '';
        document.getElementById('confirmPw').value = '';
        alert('Password changed successfully!');
        toggleChangePassword();
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
    }
}

// Add another child using the MongoDB children route
// After saving the new child, immediately open that child's pre-assessment.
async function addChild() {
    const err = document.getElementById('addChildErr');
    err.style.display = 'none';

    const firstName    = document.getElementById('newChildFirst').value.trim();
    const middleName   = document.getElementById('newChildMiddle').value.trim();
    const lastName     = document.getElementById('newChildLast').value.trim();
    const dateOfBirth  = document.getElementById('newChildDob').value;
    const gender       = document.getElementById('newChildGender').value;
    const relationship = document.getElementById('newChildRelationship').value.trim();

    if (!firstName || !lastName || !dateOfBirth) {
        err.textContent = 'First name, last name and date of birth are required.';
        err.style.display = 'block';
        return;
    }

    try {
        const data = await apiFetch('/children/register', {
            method: 'POST',
            body: JSON.stringify({
                firstName,
                middleName: middleName || null,
                lastName,
                dateOfBirth,
                gender: gender || null,
                relationship: relationship || null
            })
        });

        // Save the new child as the active child, then go straight to screening.
        if (data.childId) {
            localStorage.setItem('kc_childId', data.childId);
            localStorage.setItem('kc_viewChildId', data.childId);
        }
        localStorage.removeItem('kc_assessmentId');
        window.location.href = '/parent/screening.html';
    } catch (e) {
        err.textContent = e.message;
        err.style.display = 'block';
    }
}

// Page startup
// 1) check login
// 2) fill nav
// 3) load profile data
document.addEventListener('DOMContentLoaded', () => {
    initNav();
    document.querySelectorAll('a.logout').forEach(a => {
        a.addEventListener('click', e => { e.preventDefault(); logout(); });
    });
    loadProfile();
});
