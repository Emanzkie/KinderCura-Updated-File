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
                suc.innerHTML = '<img src="/icons/approve_completed_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Professional info updated!'; suc.style.display = 'block';
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
                suc.innerHTML = '<img src="/icons/approve_completed_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Name updated!'; suc.style.display = 'block';
                loadProfile();
            } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
        }

        async function changePassword() {
            const err = document.getElementById('pwErr');
            const suc = document.getElementById('pwSuc');
            err.style.display = 'none'; suc.style.display = 'none';
            const current = document.getElementById('currentPw').value;
            const pw  = document.getElementById('newPw').value;
            const cpw = document.getElementById('confirmPw').value;
            if (!current) { err.textContent = 'Enter your current password.'; err.style.display='block'; return; }
            if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display='block'; return; }
            if (pw !== cpw)    { err.textContent = 'Passwords do not match.'; err.style.display='block'; return; }
            try {
                await apiFetch('/auth/change-password', { method:'PUT', body:JSON.stringify({ currentPassword: current, password: pw }) });
                document.getElementById('currentPw').value = '';
                suc.innerHTML = '<img src="/icons/approve_completed_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Password updated!'; suc.style.display = 'block';
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


function toggleProfileMenu() {
            const m = document.getElementById('profileMenu');
            m.style.display = m.style.display === 'none' ? 'block' : 'none';
        }


        document.addEventListener('click', e => {
            if (!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display = 'none';
        });

        document.addEventListener('DOMContentLoaded', loadProfile);
