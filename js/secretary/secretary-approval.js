// === Extracted from SECRETARY\secretary-approval.html (script block 1) ===
requireAuth();

        const currentUser = KC.user();
        if (!currentUser) {
            window.location.href = '/login.html';
        } else if (currentUser.role !== 'secretary') {
            const roleMap = {
                admin: '/admin/admin-dashboard.html',
                pediatrician: '/pedia/pediatrician-dashboard.html',
                parent: '/parent/dashboard.html'
            };
            window.location.href = roleMap[currentUser.role] || '/login.html';
        }

        let approvals = [];
        let permissions = {};
        const selectedIds = new Set();

        function canManageBookings() {
            return Boolean(permissions.manageBookings || permissions.approveSchedules);
        }

        function shortDate(value) {
            if (!value) return '-';
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return '-';
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        function shortDateTime(dateValue, timeValue) {
            return `${shortDate(dateValue)} at ${fmtTime(timeValue || '')}`;
        }

        function appointmentTimestamp(item) {
            const base = item.appointmentDate ? new Date(item.appointmentDate).getTime() : 0;
            const parts = String(item.appointmentTime || '00:00').split(':');
            const h = Number.parseInt(parts[0], 10);
            const m = Number.parseInt(parts[1] || '0', 10);
            return base + ((Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)) * 60000;
        }

        function searchText(item) {
            return [
                item.childName,
                item.parentName,
                item.parentEmail,
                item.parentPhoneNumber,
                item.reason,
                item.notes
            ].join(' ').toLowerCase();
        }

        function visibleApprovals() {
            const q = document.getElementById('searchInput').value.trim().toLowerCase();
            const sort = document.getElementById('sortSelect').value;
            let list = approvals.filter((item) => !q || searchText(item).includes(q));

            if (sort === 'newest') {
                list = list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            } else if (sort === 'child') {
                list = list.sort((a, b) => String(a.childName || '').localeCompare(String(b.childName || '')));
            } else {
                list = list.sort((a, b) => appointmentTimestamp(a) - appointmentTimestamp(b));
            }
            return list;
        }

        function syncSummary() {
            document.getElementById('pendingCount').textContent = approvals.length;
            document.getElementById('selectedCount').textContent = selectedIds.size;
            document.getElementById('nextRequest').textContent = approvals.length
                ? shortDate(approvals.slice().sort((a, b) => appointmentTimestamp(a) - appointmentTimestamp(b))[0].appointmentDate)
                : '-';
            document.getElementById('batchApproveBtn').disabled = !selectedIds.size || !canManageBookings();
            document.getElementById('permissionNote').style.display = canManageBookings() ? 'none' : 'block';
        }

        function renderRows() {
            const list = visibleApprovals();
            const body = document.getElementById('approvalsBody');
            document.getElementById('tableMeta').textContent = `${list.length} shown`;

            if (!list.length) {
                body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><strong>No pending requests</strong><span>The approval queue is clear.</span></div></td></tr>`;
                document.getElementById('selectAll').checked = false;
                syncSummary();
                return;
            }

            const manage = canManageBookings();
            body.innerHTML = list.map((item) => `
                <tr>
                    <td>
                        <input type="checkbox" ${selectedIds.has(item.id) ? 'checked' : ''} onchange="toggleSelect(${item.id}, this.checked)" aria-label="Select appointment ${item.id}">
                    </td>
                    <td>
                        <p class="primary-line">${escapeHtml(item.childName || 'Unknown Child')}</p>
                        <p class="sub-line">${escapeHtml(item.childGender || 'Gender not set')}</p>
                    </td>
                    <td>
                        <p class="primary-line">${escapeHtml(item.parentName || 'Unknown Parent')}</p>
                        <p class="sub-line">${escapeHtml(item.parentEmail || 'No email')}</p>
                        <p class="sub-line">${escapeHtml(item.parentPhoneNumber || 'No phone on file')}</p>
                    </td>
                    <td>
                        <p class="primary-line">${shortDateTime(item.appointmentDate, item.appointmentTime)}</p>
                        <span class="status-chip status-pending">Pending</span>
                    </td>
                    <td>
                        <p class="sub-line">${escapeHtml(item.reason || 'General checkup')}</p>
                        ${item.notes ? `<p class="sub-line">${escapeHtml(item.notes)}</p>` : ''}
                    </td>
                    <td>
                        <div class="row-actions">
                            <button class="action-btn primary" onclick="updateStatus(${item.id}, 'approved')" ${manage ? '' : 'disabled'}>
                                <img src="/icons/appointment.png" alt="" aria-hidden="true"> Approve
                            </button>
                            <button class="action-btn danger" onclick="rejectAppointment(${item.id})" ${manage ? '' : 'disabled'}>
                                X Reject
                            </button>
                        </div>
                    </td>
                </tr>`).join('');

            const visibleIds = list.map((item) => item.id);
            document.getElementById('selectAll').checked = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
            syncSummary();
        }

        function toggleSelect(id, checked) {
            if (checked) selectedIds.add(id);
            else selectedIds.delete(id);
            renderRows();
        }

        function toggleSelectAll(checked) {
            visibleApprovals().forEach((item) => {
                if (checked) selectedIds.add(item.id);
                else selectedIds.delete(item.id);
            });
            renderRows();
        }

        async function updateStatus(appointmentId, status, notes = null) {
            if (!canManageBookings()) return;
            const verb = status === 'approved' ? 'Approve' : 'Reject';
            if (!confirm(`${verb} this appointment?`)) return;

            try {
                await saveStatus(appointmentId, status, notes);
                await loadApprovals();
            } catch (err) {
                alert(`Could not update appointment: ${err.message}`);
            }
        }

        async function rejectAppointment(appointmentId) {
            if (!canManageBookings()) return;
            const note = prompt('Reason for rejection (optional):', '');
            if (note === null) return;
            await updateStatus(appointmentId, 'rejected', note.trim());
        }

        async function saveStatus(appointmentId, status, notes = null) {
            const body = notes ? { status, notes } : { status };
            await apiFetch(`/appointments/${appointmentId}/status`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            selectedIds.delete(appointmentId);
        }

        async function batchApprove() {
            if (!canManageBookings() || !selectedIds.size) return;
            const ids = Array.from(selectedIds);
            if (!confirm(`Approve ${ids.length} selected appointment${ids.length === 1 ? '' : 's'}?`)) return;

            const btn = document.getElementById('batchApproveBtn');
            btn.disabled = true;
            const failures = [];

            for (const id of ids) {
                try {
                    await saveStatus(id, 'approved');
                } catch (err) {
                    failures.push(`#${id}: ${err.message}`);
                }
            }

            await loadApprovals();
            if (failures.length) {
                alert(`Some appointments could not be approved:\n${failures.join('\n')}`);
            }
        }

        async function loadProfile() {
            try {
                const data = await apiFetch('/secretary/me');
                const sec = data.secretary;
                document.getElementById('profileMenuName').textContent = `${sec.firstName || ''} ${sec.lastName || ''}`.trim() || 'Clinic Assistant/Secretary';

                const banner = document.getElementById('onBehalfBanner');
                if (sec.linkedPediatrician) {
                    const ped = sec.linkedPediatrician;
                    document.getElementById('pedNameBanner').textContent =
                        `Dr. ${ped.firstName || ''} ${ped.lastName || ''}`.trim() + (ped.clinicName ? ` - ${ped.clinicName}` : '');
                    banner.style.display = 'flex';
                } else {
                    banner.style.cssText = 'display:flex;border-color:#f4d89f;background:#f8e5b5;color:#3d4738;';
                    banner.innerHTML = '<img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> This secretary account is not linked to a pediatrician.';
                }
            } catch (err) {
                document.getElementById('onBehalfBanner').style.display = 'flex';
                document.getElementById('onBehalfBanner').textContent = err.message;
            }
        }

        async function loadApprovals() {
            try {
                document.getElementById('tableMeta').textContent = 'Loading...';
                const data = await apiFetch('/secretary/approvals');
                approvals = Array.isArray(data.approvals) ? data.approvals : [];
                permissions = data.permissions || {};
                selectedIds.clear();
                renderRows();
            } catch (err) {
                document.getElementById('approvalsBody').innerHTML =
                    `<tr><td colspan="6"><div class="empty-state"><strong>Could not load approvals</strong><span>${escapeHtml(err.message)}</span></div></td></tr>`;
                document.getElementById('tableMeta').textContent = 'Unavailable';
            }
        }

        document.querySelectorAll('a.logout').forEach((link) => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                logout();
            });
        });

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.profile-btn') && !event.target.closest('#profileMenu')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

        (async () => {
            await loadProfile();
            await loadApprovals();
            loadNotificationCount();
        })();
