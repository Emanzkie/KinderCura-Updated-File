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
                clicked.style.color = '#FAFAF6';
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
            el.style.color = isError ? '#3d4738' : 'var(--text-light)';
        }

        async function loadAppointmentSlotSetting() {
            try {
                const data = await apiFetch('/admin/settings/appointments');
                const settings = data.settings || {};
                document.getElementById('enforceThirtyMinuteSlots').checked = settings.enforceThirtyMinuteSlots !== false;
                setAppointmentSlotSettingState(
                    settings.enforceThirtyMinuteSlots === false
                        ? '1-hour start time enforcement is currently OFF. Legacy manual time entry is allowed.'
                        : '1-hour start time enforcement is currently ON for new bookings and reschedules.'
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
                        ? 'Saved. 1-hour start time enforcement is OFF.'
                        : 'Saved. 1-hour start time enforcement is ON.'
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
