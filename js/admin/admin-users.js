// === Extracted from ADMIN\admin-users.html (script block 1) ===
// ── Authentication & Role Guard ──────────────────────────────────────────
        // Require a valid session before this page can load.
        requireAuth();
        // Admin-only page guard: redirect non-admin users away immediately.
        const _u = KC.user();
        if (_u && _u.role !== 'admin') window.location.href = '/parent/dashboard.html';

        // Small debounce so search does not fire every keystroke instantly
        let searchTimer;
        function debounceFilter() { clearTimeout(searchTimer); searchTimer = setTimeout(loadUsers, 400); }

        function formatDateTime(ts) {
            if (!ts) return '—';
            return new Date(ts).toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            });
        }

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[ch]));
        }

        // ── loadUsers ────────────────────────────────────────────────────────────
        // Fetches all users from the backend using the current search/filter values
        // and re-renders both the main table and the pending approvals section.
        async function loadUsers() {
            const search = document.getElementById('searchInput').value.trim();
            const role   = document.getElementById('roleFilter').value;
            const status = document.getElementById('statusFilter').value;
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (role)   params.append('role', role);
            if (status) params.append('status', status);

            try {
                const data = await apiFetch(`/admin/users?${params}`);
                renderUsers(data.users || []);
                renderPending((data.users || []).filter(u => u.status === 'pending'));
                document.getElementById('userCount').textContent = `(${(data.users || []).length})`;
            } catch (e) {
                document.getElementById('usersList').innerHTML = `<tr><td colspan="6" style="padding:2rem;color:red;text-align:center;">Error: ${e.message}</td></tr>`;
            }
        }

        // ── renderUsers ──────────────────────────────────────────────────────────
        // Builds and injects the HTML rows for the main Users table.
        // Status badge colors: active = brand green (--success), suspended = warm red (--accent-red).
        function renderUsers(users) {
            const statusColor = { active:'var(--success)', pending:'var(--accent)', suspended:'var(--accent-red)' };
            document.getElementById('usersList').innerHTML = users.length
                ? users.map(u => `
                    <tr style="border-bottom:1px solid var(--border);">
                        <td style="padding:1rem;font-weight:600;">${u.firstName} ${u.lastName}</td>
                        <td style="padding:1rem;color:var(--text-light);">${u.email}</td>
                        <td style="padding:1rem;"><span style="background:var(--bg-primary);padding:0.3rem 0.8rem;border-radius:4px;font-size:0.85rem;text-transform:capitalize;">${u.role}</span></td>
                        <td style="padding:1rem;"><span style="background:${statusColor[u.status]||'var(--border)'};color:#3D4738;padding:0.3rem 0.8rem;border-radius:4px;font-size:0.85rem;text-transform:capitalize;">${u.status}</span></td>
                        <td style="padding:1rem;color:var(--text-light);">${u.createdAt}</td>
                        <td style="padding:1rem;text-align:center;">
                            ${u.status === 'pending' ? `
                                <button onclick="approveUser('${u.id}')" style="padding:0.4rem 0.8rem;background:var(--success);color:#3D4738;border:none;border-radius:4px;cursor:pointer;margin-right:0.3rem;">Approve</button>
                                <button onclick="rejectUser('${u.id}')" style="padding:0.4rem 0.8rem;background:var(--accent-red);color:#3D4738;border:none;border-radius:4px;cursor:pointer;">Reject</button>
                            ` : u.status === 'active' ? `
                                <button onclick="suspendUser('${u.id}')" style="padding:0.4rem 0.8rem;background:var(--accent-red);color:#3D4738;border:none;border-radius:4px;cursor:pointer;">Suspend</button>
                            ` : `
                                <button onclick="approveUser('${u.id}')" style="padding:0.4rem 0.8rem;background:var(--success);color:#3D4738;border:none;border-radius:4px;cursor:pointer;">Re-activate</button>
                            `}
                        </td>
                    </tr>`).join('')
                : '<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--text-light);">No users found</td></tr>';
        }

        // ── renderPending ────────────────────────────────────────────────────────
        // Builds the Pending Approvals section. Each card shows the user details
        // with Approve / Reject action buttons.
        function renderPending(pending) {
            const badge = document.getElementById('pendingCount');
            badge.textContent = pending.length > 0 ? pending.length : '';
            document.getElementById('pendingList').innerHTML = pending.length
                ? pending.map(u => `
                    <div style="background:var(--bg-primary);padding:1.5rem;border-radius:10px;border-left:4px solid #f4d89f;">
                        <p style="font-weight:600;">${u.firstName} ${u.lastName}</p>
                        <p style="color:var(--text-light);font-size:0.85rem;margin:0.3rem 0;">${u.email}</p>
                        <p style="font-size:0.8rem;color:var(--text-light);margin-bottom:1rem;text-transform:capitalize;">Role: ${u.role}</p>
                        <div style="display:flex;gap:0.5rem;">
                            <button onclick="approveUser('${u.id}')" style="flex:1;padding:0.5rem;background:var(--success);color:#3D4738;border:none;border-radius:4px;cursor:pointer;">Approve</button>
                            <button onclick="rejectUser('${u.id}')" style="flex:1;padding:0.5rem;background:var(--accent-red);color:#3D4738;border:none;border-radius:4px;cursor:pointer;">Reject</button>
                        </div>
                    </div>`).join('')
                : '<p style="color:var(--text-light);text-align:center;grid-column:1/-1;">No pending approvals</p>';
        }

        async function approveUser(userId) {
            try { await apiFetch('/admin/users/approve', { method:'POST', body: JSON.stringify({ userId }) }); loadUsers(); }
            catch (e) { alert(e.message); }
        }
        async function suspendUser(userId) {
            if (!confirm('Suspend this user?')) return;
            try { await apiFetch('/admin/users/suspend', { method:'POST', body: JSON.stringify({ userId, reason:'Suspended by admin' }) }); loadUsers(); }
            catch (e) { alert(e.message); }
        }
        async function rejectUser(userId) {
            if (!confirm('Permanently delete this user?')) return;
            try { await apiFetch(`/admin/users/${userId}`, { method:'DELETE' }); loadUsers(); }
            catch (e) { alert(e.message); }
        }

        // Export current admin data using authenticated download helper
        async function exportUsers() {
            try {
                await downloadWithAuth('/admin/export-data', 'users-export.json');
            } catch (e) {
                alert('Export failed: ' + e.message);
            }
        }

        // ── Secretary Audit View (read-only) ────────────────────────────────────
        // The admin can only VIEW and RE-LINK secretaries here for audit purposes.
        // Secretaries are created by Pediatricians via Settings > Staff Access.
        // The "Update Link" button uses KinderCura's primary brand green (--primary: #6B8E6F)
        // to stay consistent with the overall color system.

        async function loadSecretaries() {
            try {
                const data = await apiFetch('/secretary/list');
                const list = data.secretaries || [];
                // Update the count badge next to the section heading
                document.getElementById('secCount').textContent = `(${list.length})`;
                document.getElementById('secList').innerHTML = list.length
                    ? list.map(s => `
                        <div style="background:var(--bg-primary);padding:1rem;border-radius:8px;margin-bottom:0.8rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
                            <div>
                                <p style="font-weight:600;margin:0 0 0.2rem;">${s.firstName} ${s.lastName}</p>
                                <p class="mini" style="margin:0;">${s.email} | Status: <span style="text-transform:capitalize;">${s.status}</span></p>
                                <p class="mini" style="margin:0.2rem 0 0;">Linked to: <strong style="color:var(--text-dark);">${s.linkedPediatricianName}</strong></p>
                            </div>
                            <div style="display:flex;gap:0.5rem;align-items:center;">
                                <!-- Dropdown to re-assign or unlink the secretary from a pediatrician -->
                                <select id="linkSelect_${s.id}" style="padding:0.4rem;border-radius:4px;border:1px solid var(--border);font-size:0.85rem;">
                                    <option value="">Unlink</option>
                                    ${pediaOptions.map(p => `<option value="${p.id}" ${s.linkedPediatricianId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
                                </select>
                                <!-- Update Link button: uses KinderCura primary green (#6B8E6F) instead of off-brand teal -->
                                <button onclick="linkSecretary('${s.id}')" style="padding:0.4rem 0.8rem;background:var(--primary);color:#FAFAF6;border:none;border-radius:4px;cursor:pointer;font-size:0.85rem;">Update Link</button>
                            </div>
                        </div>`).join('')
                    : '<p style="color:var(--text-light);text-align:center;">No assistant/secretary accounts created yet.</p>';
            } catch(e) {
                document.getElementById('secList').innerHTML = `<p style="color:red;">Error loading secretaries: ${e.message}</p>`;
            }
        }

        // Options for the per-secretary re-assign dropdowns rendered by
        // loadSecretaries(). Declared (not implicit-global) and defaulted to []
        // so a failed fetch degrades to "Unlink only" instead of throwing
        // "pediaOptions is not defined" while rendering the list.
        let pediaOptions = [];

        async function loadSecretaryFormDependencies() {
            try {
                const data = await apiFetch('/secretary/pediatricians');
                pediaOptions = data.pediatricians || [];

                // The admin-side "create secretary" form was removed when
                // secretary creation moved to the pediatrician's Settings page,
                // but this population step stayed behind and threw
                // "Cannot set properties of null" on every page load. The
                // element is optional now.
                const sel = document.getElementById('secPediaSelect');
                if (sel) {
                    sel.innerHTML = `<option value="">-- Do not link yet --</option>`
                        + pediaOptions.map(p => `<option value="${p.id}">${p.name} (${p.clinic})</option>`).join('');
                }
            } catch(e) {
                console.error("Failed to load pedia dropdown", e);
            }
        }

        async function createSecretary() {
            const errEl = document.getElementById('secCreateError');
            const sucEl = document.getElementById('secCreateSuccess');
            errEl.style.display = 'none'; sucEl.style.display = 'none';

            const payload = {
                firstName: document.getElementById('secFirstName').value.trim(),
                lastName: document.getElementById('secLastName').value.trim(),
                username: document.getElementById('secUsername').value.trim(),
                email: document.getElementById('secEmail').value.trim(),
                password: document.getElementById('secPassword').value,
                linkedPediatricianId: document.getElementById('secPediaSelect').value
            };

            try {
                const res = await apiFetch('/secretary/create', { method: 'POST', body: JSON.stringify(payload) });
                sucEl.textContent = res.message || 'Assistant/Secretary account created!';
                sucEl.style.display = 'block';
                // Clear form
                ['secFirstName','secLastName','secUsername','secEmail','secPassword'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('secPediaSelect').value = '';
                
                loadSecretaries();
                loadUsers();
            } catch(e) {
                errEl.textContent = e.message;
                errEl.style.display = 'block';
            }
        }

        async function linkSecretary(secId) {
            const pedId = document.getElementById(`linkSelect_${secId}`).value;
            try {
                const res = await apiFetch(`/secretary/${secId}/link`, { method: 'PUT', body: JSON.stringify({ linkedPediatricianId: pedId || null }) });
                alert(res.message);
                loadSecretaries();
            } catch(e) {
                alert('Error updating link: ' + e.message);
            }
        }

        // ── Page Initialization ──────────────────────────────────────────────────
        // On page load: fetch all users first, then load the secretary dropdown
        // dependencies before rendering the Secretary Audit View list.
        document.addEventListener('DOMContentLoaded', () => {
            loadUsers();
            loadSecretaryFormDependencies().then(loadSecretaries);
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                loadUsers();
            }, 30000);
        });
