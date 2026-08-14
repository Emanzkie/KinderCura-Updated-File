// === Extracted from ADMIN\admin-settings.html (script block 1) ===
// Switches the visible settings tab in the admin settings page.
        function switchTab(tabName) {
            // Hide all tabs
            document.querySelectorAll('.settings-content').forEach(tab => {
                tab.style.display = 'none';
            });

            // Show selected tab
            document.getElementById(tabName + '-tab').style.display = 'block';

            // Update sidebar active state
            document.querySelectorAll('.settings-tab').forEach(tab => {
                tab.style.background = 'transparent';
                tab.style.color = 'var(--primary)';
            });
            const clicked = window.event?.target;
            if (clicked) {
                clicked.style.background = 'var(--primary)';
                clicked.style.color = 'white';
            }
        }

        function toggleProfileMenu() {
            const menu = document.getElementById('profileMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }

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

        function notificationDestination(n) {
            const title = String(n?.title || '').toLowerCase();
            const msg = String(n?.message || '').toLowerCase();
            if (title.includes('pending') || title.includes('registration') || title.includes('approval') || msg.includes('approval')) {
                return '/admin/admin-users.html';
            }
            return '/admin/admin-dashboard.html';
        }

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

        async function goToNotificationTarget(id, target) {
            await markNotificationRead(id);
            window.location.href = target;
        }

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

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.profile-btn')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

// === Extracted from ADMIN\admin-settings.html (script block 2) ===
// Shared auth guard keeps the settings page admin-only.
        requireAuth();
        const _u = KC.user();
        if (_u && _u.role !== "admin") window.location.href = "/parent/dashboard.html";
        document.querySelectorAll("a.logout").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); logout(); }));

        function setAppointmentSlotSettingState(message, isError = false) {
            const el = document.getElementById('appointmentSlotSettingState');
            if (!el) return;
            el.textContent = message;
            el.style.color = isError ? '#c0392b' : 'var(--text-light)';
        }

        async function loadAppointmentSlotSetting() {
            try {
                const data = await apiFetch('/admin/settings/appointments');
                const settings = data.settings || {};
                document.getElementById('enforceThirtyMinuteSlots').checked = settings.enforceThirtyMinuteSlots !== false;
                setAppointmentSlotSettingState(
                    settings.enforceThirtyMinuteSlots === false
                        ? '30-minute slot enforcement is currently OFF. Legacy manual time entry is allowed.'
                        : '30-minute slot enforcement is currently ON for new bookings and reschedules.'
                );
            } catch (err) {
                setAppointmentSlotSettingState(err.message || 'Could not load appointment slot setting.', true);
            }
        }

        // This saves only the new appointment-slot switch so the existing placeholder settings remain untouched.
        async function saveAppointmentSlotSetting() {
            try {
                const enforceThirtyMinuteSlots = document.getElementById('enforceThirtyMinuteSlots').checked;
                const data = await apiFetch('/admin/settings/appointments', {
                    method: 'PUT',
                    body: JSON.stringify({ enforceThirtyMinuteSlots }),
                });
                const saved = data.settings || {};
                document.getElementById('enforceThirtyMinuteSlots').checked = saved.enforceThirtyMinuteSlots !== false;
                setAppointmentSlotSettingState(
                    saved.enforceThirtyMinuteSlots === false
                        ? 'Saved. 30-minute slot enforcement is OFF.'
                        : 'Saved. 30-minute slot enforcement is ON.'
                );
            } catch (err) {
                setAppointmentSlotSettingState(err.message || 'Could not save appointment slot setting.', true);
            }
        }

        loadAppointmentSlotSetting();
        if (typeof loadNotificationCount === 'function') loadNotificationCount();
        setInterval(() => {
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
        }, 30000);
