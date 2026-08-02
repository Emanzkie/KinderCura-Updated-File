// === Extracted from PEDIA\pediatrician-settings.html (script block 1) ===
requireAuth();
        if ((KC.user() || {}).role !== 'pediatrician') {
            window.location.href = '/login.html';
        }

        let currentSettings = null;

        function showNotice(type, message) {
            const err = document.getElementById('settingsErr');
            const suc = document.getElementById('settingsSuc');
            err.style.display = 'none';
            suc.style.display = 'none';
            if (type === 'error') {
                err.textContent = message;
                err.style.display = 'block';
            } else {
                suc.textContent = message;
                suc.style.display = 'block';
            }
        }

        function switchTab(event, tabName) {
            // Update tab panel visibility and sidebar highlight.
            ['account', 'notifications', 'availability', 'privacy', 'staff'].forEach((name) => {
                document.getElementById(name + '-tab').style.display = name === tabName ? 'block' : 'none';
            });
            document.querySelectorAll('.settings-tab').forEach((tab) => {
                tab.style.background = 'transparent';
                tab.style.color = 'var(--primary)';
            });
            event.currentTarget.style.background = 'var(--primary)';
            event.currentTarget.style.color = 'white';
            // Auto-load staff list when the Staff Access tab is first opened.
            if (tabName === 'staff') loadStaffList();
        }

        // Load saved settings so the page shows real database values instead of placeholders.
        async function loadSettings() {
            try {
                const data = await apiFetch('/auth/pediatrician/settings');
                const u = data.user || {};
                currentSettings = u;
                localStorage.setItem('kc_user', JSON.stringify(u));
                document.getElementById('menuWelcome').textContent = `Welcome, Dr. ${u.firstName || ''}`;
                if (u.profileIcon) document.getElementById('navProfilePic').src = u.profileIcon;

                document.getElementById('emailInput').value = u.email || '';
                document.getElementById('phoneInput').value = u.phoneNumber || '';
                document.getElementById('clinicNameInput').value = u.clinicName || '';
                document.getElementById('clinicAddressInput').value = u.clinicAddress || '';
                document.getElementById('institutionInput').value = u.institution || '';
                document.getElementById('specializationInput').value = u.specialization || '';
                document.getElementById('feeInput').value = u.consultationFee ?? '';
                document.getElementById('bioInput').value = u.bio || '';

                document.getElementById('startTimeInput').value = u.availability?.startTime || '09:00';
                document.getElementById('endTimeInput').value = u.availability?.endTime || '17:00';
                document.getElementById('max-patients-input').value = u.availability?.maxPatientsPerDay ?? 10;
                document.querySelectorAll('.day-box').forEach((box) => {
                    box.checked = (u.availability?.days || []).includes(box.value);
                });

                document.getElementById('notifEmailAppointments').checked = Boolean(u.notificationSettings?.emailAppointments ?? true);
                document.getElementById('notifInApp').checked = Boolean(u.notificationSettings?.inApp ?? true);
                document.getElementById('notifSms').checked = Boolean(u.notificationSettings?.sms ?? false);
                document.getElementById('notifAssessmentDone').checked = Boolean(u.notificationSettings?.assessmentCompleted ?? true);
                document.getElementById('notifDailySummary').checked = Boolean(u.notificationSettings?.dailySummary ?? false);

                document.getElementById('privacyShowProfile').checked = Boolean(u.privacySettings?.showProfile ?? true);
                document.getElementById('privacyShowAvailability').checked = Boolean(u.privacySettings?.showAvailability ?? true);
                document.getElementById('privacyShareRecs').checked = Boolean(u.privacySettings?.shareRecommendations ?? true);
            } catch (err) {
                showNotice('error', err.message);
            }
        }

        async function saveAccountSettings() {
            try {
                const data = await apiFetch('/auth/pediatrician/settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        email: document.getElementById('emailInput').value.trim(),
                        phoneNumber: document.getElementById('phoneInput').value.trim(),
                        clinicName: document.getElementById('clinicNameInput').value.trim(),
                        clinicAddress: document.getElementById('clinicAddressInput').value.trim(),
                        institution: document.getElementById('institutionInput').value.trim(),
                        specialization: document.getElementById('specializationInput').value.trim(),
                        consultationFee: document.getElementById('feeInput').value,
                        bio: document.getElementById('bioInput').value.trim(),
                    }),
                });
                localStorage.setItem('kc_user', JSON.stringify(data.user));
                showNotice('success', 'Account settings saved successfully.');
                await loadSettings();
            } catch (err) {
                showNotice('error', err.message);
            }
        }

        async function saveNotificationSettings() {
            try {
                const data = await apiFetch('/auth/pediatrician/settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        notificationSettings: {
                            emailAppointments: document.getElementById('notifEmailAppointments').checked,
                            inApp: document.getElementById('notifInApp').checked,
                            sms: document.getElementById('notifSms').checked,
                            assessmentCompleted: document.getElementById('notifAssessmentDone').checked,
                            dailySummary: document.getElementById('notifDailySummary').checked,
                        },
                    }),
                });
                localStorage.setItem('kc_user', JSON.stringify(data.user));
                showNotice('success', 'Notification settings saved successfully.');
            } catch (err) {
                showNotice('error', err.message);
            }
        }

        async function saveAvailability() {
            try {
                const days = Array.from(document.querySelectorAll('.day-box:checked')).map((box) => box.value);
                const data = await apiFetch('/auth/pediatrician/settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        availability: {
                            startTime: document.getElementById('startTimeInput').value,
                            endTime: document.getElementById('endTimeInput').value,
                            days,
                            maxPatientsPerDay: document.getElementById('max-patients-input').value,
                        },
                    }),
                });
                localStorage.setItem('kc_user', JSON.stringify(data.user));
                showNotice('success', 'Availability saved successfully.');
            } catch (err) {
                showNotice('error', err.message);
            }
        }

        async function savePrivacySettings() {
            try {
                const data = await apiFetch('/auth/pediatrician/settings', {
                    method: 'PUT',
                    body: JSON.stringify({
                        privacySettings: {
                            showProfile: document.getElementById('privacyShowProfile').checked,
                            showAvailability: document.getElementById('privacyShowAvailability').checked,
                            shareRecommendations: document.getElementById('privacyShareRecs').checked,
                        },
                    }),
                });
                localStorage.setItem('kc_user', JSON.stringify(data.user));
                showNotice('success', 'Privacy settings saved successfully.');
            } catch (err) {
                showNotice('error', err.message);
            }
        }

        function formatDateTime(ts) {
            if (!ts) return '—';
            return new Date(ts).toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            });
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

        function notificationDestination(n) {
            const title = String(n?.title || '').toLowerCase();
            const type = String(n?.type || '').toLowerCase();
            const msg = String(n?.message || '').toLowerCase();
            if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
            if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
            if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question answered')) return '/pedia/pedia-questions.html';
            if (title.includes('diagnosis') || msg.includes('diagnosis') || title.includes('recommendation') || msg.includes('recommendation')) return '/pedia/pediatrician-patients.html';
            return '/pedia/pediatrician-dashboard.html';
        }

        async function loadNotificationCount() {
            try {
                const data = await apiFetch('/notifications/count');
                const badge = document.getElementById('notifCount');
                const unread = data.unread || 0;
                badge.textContent = unread;
                badge.style.display = unread > 0 ? 'flex' : 'none';
            } catch { }
        }

        async function markNotificationRead(id) {
            try {
                await apiFetch(`/notifications/${id}/read`, { method: 'PUT' });
                await loadNotificationCount();
            } catch { }
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

        async function goToNotificationTarget(id, target) {
            await markNotificationRead(id);
            window.location.href = target;
        }

        async function openNotifications() {
            const modal = document.getElementById('notificationsModal');
            const listEl = document.getElementById('notificationsList');
            modal.style.display = 'flex';
            listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Loading...</p>';
            try {
                const data = await apiFetch('/notifications');
                const notifications = Array.isArray(data.notifications) ? data.notifications : [];
                if (!notifications.length) {
                    listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1.5rem;">No notifications yet.</p>';
                    return;
                }
                const hasUnread = notifications.some(n => !n.isRead);
                const tools = `
                    <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                        ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                        <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:#c0392b;padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
                    </div>`;
                const items = notifications.map((n) => {
                    const dest = notificationDestination(n);
                    const unreadStyle = n.isRead ? '' : 'background:#f0f7f0;border-left:3px solid var(--primary);';
                    const click = dest ? `goToNotificationTarget(${n.id}, '${dest}')` : `markNotificationRead(${n.id})`;
                    return `
                        <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                            <div onclick="${click}" style="flex:1;cursor:pointer;min-width:0;">
                                <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                                <p style="font-size:.82rem;color:#555;margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                                <p style="font-size:.75rem;color:#aaa;margin:0;">${formatDateTime(n.createdAt)}</p>
                                ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                            </div>
                            <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                        </div>`;
                }).join('');
                listEl.innerHTML = tools + items;
            } catch {
                listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Could not load notifications.</p>';
            }
        }

        function closeNotifications() {
            document.getElementById('notificationsModal').style.display = 'none';
        }

        function toggleProfileMenu() {
            const menu = document.getElementById('profileMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.profile-btn')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

        // ── Staff Access: Assistant/Secretary Management ─────────────────────────────────
        // These functions are only active for the Pediatrician.
        // The Pediatrician creates and manages their own assistant/secretary account.

        function escapeHtml(v) {
            return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // createSecretary — sends the form data to the backend to create a new secretary.
        // The assistant/secretary is automatically linked to the logged-in pediatrician.
        async function createSecretary() {
            const errEl = document.getElementById('secCreateErr');
            const sucEl = document.getElementById('secCreateSuc');
            errEl.style.display = 'none';
            sucEl.style.display = 'none';

            const payload = {
                firstName: document.getElementById('secFirstName').value.trim(),
                lastName: document.getElementById('secLastName').value.trim(),
                username: document.getElementById('secUsername').value.trim(),
                email: document.getElementById('secEmail').value.trim(),
                password: document.getElementById('secPassword').value,
            };

            try {
                const res = await apiFetch('/secretary/create', { method: 'POST', body: JSON.stringify(payload) });
                sucEl.textContent = res.message || 'Assistant/Secretary account created successfully!';
                sucEl.style.display = 'block';
                // Clear the form fields after a successful creation.
                ['secFirstName', 'secLastName', 'secUsername', 'secEmail', 'secPassword'].forEach(id => {
                    document.getElementById(id).value = '';
                });
                loadStaffList(); // refresh the staff list below the form
            } catch (e) {
                errEl.textContent = e.message;
                errEl.style.display = 'block';
            }
        }

        // loadStaffList — fetches and renders all secretaries linked to this pediatrician.
        async function loadStaffList() {
            const el = document.getElementById('staffList');
            el.innerHTML = '<p style="color:var(--text-light);text-align:center;">Loading…</p>';
            try {
                const data = await apiFetch('/secretary/my-staff');
                const staff = data.staff || [];

                if (!staff.length) {
                    el.innerHTML = '<p style="color:var(--text-light);text-align:center;padding:1rem;">No assistant/secretary accounts yet. Add one above.</p>';
                    return;
                }

                el.innerHTML = staff.map(s => `
                    <div style="border:1px solid var(--border);border-radius:10px;padding:1.2rem 1.4rem;margin-bottom:1rem;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.8rem;">
                            <div>
                                <p style="font-weight:700;font-size:1rem;margin:0 0 0.2rem;">${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}
                                    <span style="margin-left:0.5rem;padding:0.2rem 0.6rem;border-radius:20px;font-size:0.72rem;font-weight:700;color:white;background:${s.status === 'active' ? '#6B8E6F' : '#D4897A'};">${s.status === 'active' ? 'Active' : 'Inactive'}</span>
                                </p>
                                <p style="font-size:0.85rem;color:var(--text-light);margin:0;">${escapeHtml(s.email)} &nbsp;|&nbsp; @${escapeHtml(s.username)}</p>
                            </div>
                            <button onclick="toggleSecretaryStatus('${s.id}', '${s.status}')"
                                style="padding:0.45rem 1rem;border-radius:8px;border:none;cursor:pointer;font-size:0.82rem;font-weight:600;
                                background:${s.status === 'active' ? '#F0EFE8' : '#EDF3EE'};
                                color:${s.status === 'active' ? '#5A7560' : '#5A7560'};">        
                                ${s.status === 'active' ? '⏸ Deactivate' : '▶ Reactivate'}
                            </button>
                        </div>

                        <!-- Permission toggles: the pediatrician controls what the assistant/secretary can do -->
                        <div style="margin-top:1rem;padding:0.8rem 1rem;background:var(--bg-primary);border-radius:8px;">
                            <p style="font-size:0.82rem;font-weight:700;color:var(--text-dark);margin:0 0 0.6rem;">Permissions:</p>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 1.5rem;">
                                <label style="font-size:0.83rem;display:flex;align-items:center;gap:0.4rem;cursor:pointer;">
                                    <input type="checkbox" ${s.permissions.viewAppointments ? 'checked' : ''}
                                        onchange="updatePermission('${s.id}', 'viewAppointments', this.checked)">
                                    View Appointments
                                </label>
                                <label style="font-size:0.83rem;display:flex;align-items:center;gap:0.4rem;cursor:pointer;">
                                    <input type="checkbox" ${s.permissions.manageBookings ? 'checked' : ''}
                                        onchange="updatePermission('${s.id}', 'manageBookings', this.checked)">
                                    Manage Booking Requests
                                </label>
                                <label style="font-size:0.83rem;display:flex;align-items:center;gap:0.4rem;cursor:pointer;">
                                    <input type="checkbox" ${s.permissions.rescheduleRequests ? 'checked' : ''}
                                        onchange="updatePermission('${s.id}', 'rescheduleRequests', this.checked)">
                                    Reschedule Appointments
                                </label>
                                <label style="font-size:0.83rem;display:flex;align-items:center;gap:0.4rem;cursor:pointer;">
                                    <input type="checkbox" ${s.permissions.approveSchedules ? 'checked' : ''}
                                        onchange="updatePermission('${s.id}', 'approveSchedules', this.checked)">
                                    Approve Schedules
                                </label>
                            </div>
                            <div style="margin-top:0.6rem;padding-top:0.6rem;border-top:1px dashed var(--border);">
                                <label style="font-size:0.83rem;display:flex;align-items:center;gap:0.4rem;cursor:pointer;">
                                    <input type="checkbox" ${s.permissions.managePayments ? 'checked' : ''}
                                        onchange="updatePermission('${s.id}', 'managePayments', this.checked)">
                                    Confirm Cash/POS Payments
                                </label>
                                <p style="font-size:0.75rem;color:var(--text-light);margin:0.25rem 0 0 1.6rem;">
                                    Lets this assistant mark a walk-in appointment as paid when a parent hands over cash or taps a POS terminal at your counter. Separate from the scheduling permissions above.
                                </p>
                            </div>
                        </div>
                    </div>`).join('');
            } catch (e) {
                el.innerHTML = `<p style="color:red;text-align:center;">Could not load staff: ${escapeHtml(e.message)}</p>`;
            }
        }

        // updatePermission — saves a single permission change immediately.
        // Each checkbox fires this so the pediatrician gets instant feedback.
        async function updatePermission(secId, permKey, value) {
            try {
                await apiFetch(`/secretary/${secId}/permissions`, {
                    method: 'PUT',
                    body: JSON.stringify({ [permKey]: value }),
                });
                showNotice('success', 'Permission updated.');
            } catch (e) {
                showNotice('error', 'Could not update permission: ' + e.message);
                loadStaffList(); // revert UI to the saved state
            }
        }

        // toggleSecretaryStatus — deactivates or reactivates the assistant/secretary account.
        async function toggleSecretaryStatus(secId, currentStatus) {
            const action = currentStatus === 'active' ? 'deactivate' : 'reactivate';
            if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} this secretary?`)) return;
            try {
                const res = await apiFetch(`/secretary/${secId}/deactivate`, { method: 'PUT' });
                showNotice('success', res.message);
                loadStaffList();
            } catch (e) {
                showNotice('error', e.message);
            }
        }
        // ── End Staff Access ──────────────────────────────────────────────────

        loadSettings();
        loadNotificationCount();
