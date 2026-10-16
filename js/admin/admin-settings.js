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

        // Matches CLINIC_NAME_MAX_LENGTH in controllers/paymentController.js.
        const CLINIC_NAME_MAX_LENGTH = 120;

        function setClinicNameState(message, isError = false) {
            const el = document.getElementById('clinicNameState');
            if (!el) return;
            el.textContent = message;
            el.style.color = isError ? '#3d4738' : 'var(--text-light)';
        }

        function showClinicName(data) {
            const input = document.getElementById('clinicNameInput');
            if (data.clinicNameConfigured) {
                input.value = data.clinic.clinicName;
                return true;
            }
            input.value = '';
            return false;
        }

        async function loadClinicName() {
            try {
                const data = await apiFetch('/payments/clinic-config');
                setClinicNameState(showClinicName(data)
                    ? 'This is the saved clinic name.'
                    : 'Clinic name not configured. Receipts and payment pages use the built-in default name until one is saved.');
            } catch (err) {
                setClinicNameState(err.message || 'Could not load the clinic name.', true);
            }
        }

        // Sends only clinicName, so the clinic's payment settings stay as they are.
        async function saveClinicName(event) {
            event.preventDefault();
            const input = document.getElementById('clinicNameInput');
            const button = document.getElementById('clinicNameSaveBtn');
            const clinicName = input.value.trim();
            if (!clinicName) {
                setClinicNameState('Enter a clinic name. It cannot be blank.', true);
                input.focus();
                return;
            }
            if (clinicName.length > CLINIC_NAME_MAX_LENGTH) {
                setClinicNameState(`Clinic name must be ${CLINIC_NAME_MAX_LENGTH} characters or fewer.`, true);
                input.focus();
                return;
            }
            button.disabled = true;
            setClinicNameState('Saving...');
            try {
                const data = await apiFetch('/payments/clinic-config', {
                    method: 'PUT',
                    body: JSON.stringify({ clinicName }),
                });
                showClinicName(data);
                setClinicNameState('Saved. Receipts and payment pages now use this clinic name.');
            } catch (err) {
                setClinicNameState(err.message || 'Could not save the clinic name.', true);
            } finally {
                button.disabled = false;
            }
        }

        document.getElementById('clinicNameForm').addEventListener('submit', saveClinicName);

        loadAppointmentSlotSetting();
        loadClinicName();
        if (typeof loadNotificationCount === 'function') loadNotificationCount();
        setInterval(() => {
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
        }, 30000);
