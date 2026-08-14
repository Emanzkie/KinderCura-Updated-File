// === Extracted from PEDIA\pediatrician-profile.html (script block 1) ===
const API = window.location.origin + '/api';
// Uses the current site origin so the same code works on localhost and when deployed.
        function getToken() { return localStorage.getItem('kc_token'); }
        function getUser()  { try { return JSON.parse(localStorage.getItem('kc_user')); } catch { return null; } }
        function doLogout() {
            ['kc_token','kc_user','kc_childId','kc_assessmentId'].forEach(k => localStorage.removeItem(k));
            window.location.href = '/login.html';
        }

        // Auth + role guard
        const _u = getUser();
        if (!getToken() || !_u) { window.location.href = '/login.html'; }
        else if (_u.role !== 'pediatrician') {
            if(_u.role==='admin') window.location.href='/admin/admin-dashboard.html'; else if(_u.role==='parent') window.location.href='/parent/dashboard.html'; else window.location.href='/login.html';
        }

        async function apiFetch(endpoint, options = {}) {
            const res = await fetch(`${API}${endpoint}`, {
                ...options,
                headers: { 'Content-Type':'application/json', Authorization:`Bearer ${getToken()}`, ...options.headers }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
            return data;
        }

        async function loadProfile() {
            try {
                // Always fetch fresh from server
                const data = await apiFetch('/auth/me');
                const u = data.user;

                // Update localStorage with fresh data
                localStorage.setItem('kc_user', JSON.stringify(u));

                // Nav
                document.getElementById('navWelcome').textContent = `Welcome, Dr. ${u.firstName}`;
                if (u.profileIcon && u.profileIcon.startsWith('/uploads/')) {
                    document.getElementById('navProfilePic').src = u.profileIcon;
                    document.getElementById('profilePic').src    = u.profileIcon;
                }

                // Display fields
                document.getElementById('infoName').textContent          = `Dr. ${u.firstName}${u.middleName ? ' ' + u.middleName : ''} ${u.lastName}`;
                document.getElementById('infoEmail').textContent         = u.email;
                document.getElementById('infoUsername').textContent      = u.username;
                document.getElementById('infoLicense').textContent       = u.licenseNumber    || '—';
                document.getElementById('infoInstitution').textContent   = u.institution      || '—';
                document.getElementById('infoSpecialization').textContent= u.specialization   || '—';

                // Pre-fill edit fields
                document.getElementById('editFirst').value        = u.firstName    || '';
                document.getElementById('editLast').value         = u.lastName     || '';
                document.getElementById('editLicense').value      = u.licenseNumber   || '';
                document.getElementById('editInstitution').value  = u.institution     || '';
                document.getElementById('editSpecialization').value = u.specialization || '';

            } catch (e) {
                // Fall back to localStorage
                const u = getUser();
                if (u) {
                    document.getElementById('navWelcome').textContent = `Welcome, Dr. ${u.firstName}`;
                    document.getElementById('infoName').textContent   = `Dr. ${u.firstName} ${u.lastName}`;
                    document.getElementById('infoEmail').textContent  = u.email;
                    document.getElementById('editFirst').value        = u.firstName;
                    document.getElementById('editLast').value         = u.lastName;
                }
            }

            // Load the shared unread notification count for the bell
            await loadNotificationCount();
        }

        async function uploadPhoto(input) {
            const file = input.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('photo', file);
            try {
                const res  = await fetch(`${API}/upload/profile`, { method:'POST', headers:{ Authorization:`Bearer ${getToken()}` }, body:fd });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('profilePic').src    = data.path;
                    document.getElementById('navProfilePic').src = data.path;
                    const u = getUser(); u.profileIcon = data.path;
                    localStorage.setItem('kc_user', JSON.stringify(u));
                } else { alert('Upload failed: ' + (data.error || 'Unknown error')); }
            } catch (e) { alert('Upload failed: ' + e.message); }
        }

        function toggleEditProf() {
            const f = document.getElementById('editProfForm');
            f.style.display = f.style.display === 'none' ? 'block' : 'none';
        }

        async function saveProfInfo() {
            const err = document.getElementById('editProfErr');
            const suc = document.getElementById('editProfSuc');
            err.style.display = 'none'; suc.style.display = 'none';
            try {
                await apiFetch('/auth/update-profile', {
                    method: 'PUT',
                    body: JSON.stringify({
                        licenseNumber:  document.getElementById('editLicense').value.trim(),
                        institution:    document.getElementById('editInstitution').value.trim(),
                        specialization: document.getElementById('editSpecialization').value.trim()
                    })
                });
                suc.textContent = '✅ Professional info updated!'; suc.style.display = 'block';
                loadProfile();
            } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
        }

        async function savePersonalInfo() {
            const err = document.getElementById('editProfErr2');
            const suc = document.getElementById('editProfSuc2');
            err.style.display = 'none'; suc.style.display = 'none';
            const firstName = document.getElementById('editFirst').value.trim();
            const lastName  = document.getElementById('editLast').value.trim();
            if (!firstName || !lastName) { err.textContent = 'Name is required.'; err.style.display='block'; return; }
            try {
                await apiFetch('/auth/update-profile', {
                    method: 'PUT',
                    body: JSON.stringify({ firstName, lastName })
                });
                const u = getUser(); u.firstName = firstName; u.lastName = lastName;
                localStorage.setItem('kc_user', JSON.stringify(u));
                suc.textContent = '✅ Name updated!'; suc.style.display = 'block';
                loadProfile();
            } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
        }

        async function changePassword() {
            const err = document.getElementById('pwErr');
            const suc = document.getElementById('pwSuc');
            err.style.display = 'none'; suc.style.display = 'none';
            const pw  = document.getElementById('newPw').value;
            const cpw = document.getElementById('confirmPw').value;
            if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display='block'; return; }
            if (pw !== cpw)    { err.textContent = 'Passwords do not match.'; err.style.display='block'; return; }
            try {
                await apiFetch('/auth/change-password', { method:'PUT', body:JSON.stringify({ password: pw }) });
                suc.textContent = '✅ Password updated!'; suc.style.display = 'block';
                document.getElementById('newPw').value = '';
                document.getElementById('confirmPw').value = '';
            } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
        }

        
// Format notification timestamps in one consistent style
function formatDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

// Small escape helper so notification text is safe to render in HTML
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

// Decide where a notification should open based on the current user role
function notificationDestination(n) {
    let role = '';
    try {
        role = String((JSON.parse(localStorage.getItem('kc_user')) || {}).role || '').toLowerCase();
    } catch {}

    const title = String(n?.title || '').toLowerCase();
    const type  = String(n?.type  || '').toLowerCase();
    const msg   = String(n?.message || '').toLowerCase();

    if (role === 'pediatrician') {
        if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
        if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
        if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question answered')) return '/pedia/pedia-questions.html';
        if (title.includes('diagnosis') || msg.includes('diagnosis') || title.includes('recommendation') || msg.includes('recommendation')) return '/pedia/pediatrician-patients.html';
        return '/pedia/pediatrician-dashboard.html';
    }

    if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/parent/chat.html';
    if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/parent/appointments.html';
    if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question assigned') || title.includes('question answered')) return '/parent/custom-questions.html';
    if (title.includes('recommendation') || msg.includes('recommendation')) return '/parent/recommendations.html';
    if (title.includes('result') || title.includes('diagnosis') || msg.includes('diagnosis')) return '/parent/results.html';
    return '/parent/dashboard.html';
}

// Keep the bell badge in sync on every page that uses the shared modal
async function loadNotificationCount() {
    try {
        const data = await apiFetch('/notifications/count');
        const badge = document.querySelector('.notification-badge');
        if (!badge) return;
        const unread = data.unread || 0;
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'flex' : 'none';
    } catch {
        const badge = document.querySelector('.notification-badge');
        if (badge) {
            badge.textContent = '0';
            badge.style.display = 'none';
        }
    }
}

// Mark only one notification as read when the user opens or clicks it
async function markNotificationRead(id) {
    try {
        await apiFetch(`/notifications/${id}/read`, { method: 'PUT' });
        await loadNotificationCount();
    } catch {}
}

// Remove one notification from the user's list
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

// Delete every notification so old items do not stay in the modal forever
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

// Optional helper so users can mark everything as seen without deleting them
async function markAllNotificationsRead() {
    try {
        await apiFetch('/notifications/read-all', { method: 'PUT' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not mark notifications as read: ' + err.message);
    }
}

// Mark read first, then send the user to the related page
async function goToNotificationTarget(id, target) {
    await markNotificationRead(id);
    window.location.href = target;
}

// Shared notification modal renderer used by both parent and pediatrician pages
async function openNotifications() {
    const modal = document.getElementById('notificationsModal');
    const listEl = modal ? modal.querySelector('.notifications-list') : null;
    if (!modal || !listEl) return;

    modal.style.display = 'flex';
    listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading...</p>';

    try {
        const data = await apiFetch('/notifications');
        const notifications = Array.isArray(data.notifications) ? data.notifications : [];

        if (!notifications.length) {
            listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1.5rem;">No notifications yet.</p>';
            return;
        }

        const hasUnread = notifications.some(n => !n.isRead);
        const tools = `
            <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:var(--status-attention-fg);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
            </div>`;

        const items = notifications.map((n) => {
            const dest = notificationDestination(n);
            const unreadStyle = n.isRead ? '' : 'background:var(--surface-tint);border-left:3px solid var(--primary);';
            const click = dest
                ? `goToNotificationTarget(${n.id}, '${dest}')`
                : `markNotificationRead(${n.id})`;

            return `
                <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                    <div onclick="${click}" style="flex:1;cursor:pointer;min-width:0;">
                        <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                        <p style="font-size:.82rem;color:var(--text-dark);margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                        <p style="font-size:.75rem;color:var(--text-light);margin:0;">${formatDateTime(n.createdAt)}</p>
                        ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                    </div>
                    <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:var(--status-attention-fg);cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                </div>`;
        }).join('');

        listEl.innerHTML = tools + items;
    } catch {
        listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Could not load notifications.</p>';
    }
}

function closeNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (modal) modal.style.display = 'none';
}


function toggleProfileMenu() {
            const m = document.getElementById('profileMenu');
            m.style.display = m.style.display === 'none' ? 'block' : 'none';
        }


        document.addEventListener('click', e => {
            if (!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display = 'none';
        });

        document.addEventListener('DOMContentLoaded', loadProfile);
