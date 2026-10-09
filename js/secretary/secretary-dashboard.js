// === Extracted from SECRETARY\secretary-dashboard.html (script block 1) ===
// ── Auth guard ──────────────────────────────────────────────────────
        // Only assistant/secretary accounts may access this page.
        // Any other logged-in role is redirected to their own dashboard.
        requireAuth();
        const _u = KC.user();
        if (_u && _u.role !== 'secretary') {
            const roleMap = {
                admin: '/admin/admin-dashboard.html',
                pediatrician: '/pedia/pediatrician-dashboard.html',
                parent: '/parent/dashboard.html',
            };
            window.location.href = roleMap[_u.role] || '/sign-up,login/login.html';
        }

        // Module-level state
        let secretaryProfile = null;   // filled in by loadProfile()
        let allAppointments  = [];     // all appointment records from the API

        // ── Helpers ─────────────────────────────────────────────────────────

        // Convert an ISO date string to a short human-readable date (e.g. "Apr 19, 2026")
        function fmtDate(d) {
            if (!d) return '—';
            const x = new Date(d);
            if (isNaN(x)) return '—';
            return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        // Convert "HH:MM" to 12-hour clock format (e.g. "9:00 AM")
        function fmtTime(t) {
            if (!t) return '—';
            const [h, m] = t.split(':').map(Number);
            const ampm = h >= 12 ? 'PM' : 'AM';
            return `${((h % 12) || 12)}:${String(m).padStart(2,'0')} ${ampm}`;
        }

        // Prevent XSS when injecting user-supplied data into innerHTML
        function escapeHtml(s) {
            return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // Returns true if the given appointment date falls on today (local time)
        function isToday(dateStr) {
            const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
            return String(dateStr || '').startsWith(today);
        }

        // ── Profile load ────────────────────────────────────────────────────
        // Fetches the secretary's profile and linked-pediatrician details.
        // Updates the profile menu name and the "on behalf of" banner.
        async function loadProfile() {
            try {
                const data = await apiFetch('/secretary/me');
                secretaryProfile = data.secretary;

                // Show the secretary's real name in the profile dropdown
                document.getElementById('profileMenuName').textContent =
                    `${secretaryProfile.firstName} ${secretaryProfile.lastName}`;

                const banner = document.getElementById('onBehalfBanner');
                if (secretaryProfile.linkedPediatrician) {
                    // Show which pediatrician and clinic this secretary serves
                    const pedia = secretaryProfile.linkedPediatrician;
                    document.getElementById('pedName').textContent =
                        `Dr. ${escapeHtml(pedia.firstName)} ${escapeHtml(pedia.lastName)}${pedia.clinicName ? ' — ' + escapeHtml(pedia.clinicName) : ''}`;
                    banner.style.display = 'flex';
                } else {
                    // Warn: account is not yet linked — shown in amber (KinderCura warning tone)
                    banner.style.display = 'flex';
                    banner.style.borderColor = '#f4d89f';
                    banner.style.background  = '#f8e5b5';
                    banner.style.color       = '#3d4738';
                    banner.innerHTML =
                        '<img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️ Your account is not yet linked to a pediatrician. Please contact the system administrator.';
                }
            } catch (e) {
                console.error('loadProfile error:', e);
            }
        }

        // ── Appointment data ─────────────────────────────────────────────────
        // Fetches all appointments for the linked pediatrician's clinic,
        // updates the stat counters, and re-renders both lists.
        async function loadAppointments() {
            try {
                const data = await apiFetch('/appointments/pedia');
                allAppointments = data.appointments || [];

                // Calculate stat counts
                const today = new Date().toLocaleDateString('en-CA');
                const pending      = allAppointments.filter(a => a.status === 'pending');
                const approvedToday = allAppointments.filter(a =>
                    a.status === 'approved' && String(a.appointmentDate || '').startsWith(today)
                );

                document.getElementById('statPending').textContent  = pending.length;
                document.getElementById('statApproved').textContent = approvedToday.length;
                document.getElementById('statTotal').textContent     = allAppointments.length;

                renderPending(pending);
                renderToday(approvedToday);
            } catch (e) {
                document.getElementById('pendingList').innerHTML =
                    `<p class="empty-msg" style="color:var(--text-dark);">Could not load appointments: ${escapeHtml(e.message)}</p>`;
            }
        }

        // ── Render pending requests ─────────────────────────────────────────
        // Builds the list of pending appointment cards with Approve / Reject buttons.
        function renderPending(list) {
            const el = document.getElementById('pendingList');
            if (!list.length) {
                el.innerHTML = '<p class="empty-msg">No pending requests — the clinic is all caught up.</p>';
                return;
            }
            el.innerHTML = list.map(a => `
                <div class="req-card">
                    <div class="req-info">
                        <p class="req-name"><img src="/icons/parent.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.childName || 'Child')} · ${escapeHtml(a.parentName || 'Parent')}</p>
                        <p><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${fmtDate(a.appointmentDate)} at ${fmtTime(a.appointmentTime)}</p>
                        <p><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.reason || 'General checkup')}</p>
                    </div>
                    <div class="req-actions">
                        <span class="pill pill-pending">Pending</span>
                        <button class="btn-approve" onclick="updateStatus(${a.id}, 'approved')">&#10003; Approve</button>
                        <button class="btn-reject"  onclick="updateStatus(${a.id}, 'rejected')"><img src="/icons/reject_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Reject</button>
                        <!-- Link to full Appointments page for more detail -->
                        <a href="/secretary/secretary-approval.html">View queue</a>
                    </div>
                </div>`).join('');
        }

        // ── Render today's confirmed appointments ───────────────────────────
        // Read-only list so the secretary can see what is scheduled for today.
        function renderToday(list) {
            const el = document.getElementById('todayList');
            if (!list.length) {
                el.innerHTML = '<p class="empty-msg">No appointments confirmed for today.</p>';
                return;
            }
            el.innerHTML = list.map(a => `
                <div class="req-card req-card-approved">
                    <div class="req-info">
                        <p class="req-name"><img src="/icons/parent.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.childName || 'Child')} · ${escapeHtml(a.parentName || 'Parent')}</p>
                        <p><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${fmtTime(a.appointmentTime)}</p>
                        <p><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.reason || 'General checkup')}</p>
                    </div>
                    <span class="pill pill-approved">Approved</span>
                </div>`).join('');
        }

        // ── Status update (approve / reject from this dashboard) ────────────
        // Important: the secretary uses the SAME status endpoint as the pediatrician.
        // The backend verifies the secretary's linkedPediatricianId before saving.
        async function updateStatus(appointmentId, status) {
            const verb = status === 'approved' ? 'Approve' : 'Reject';
            if (!confirm(`${verb} this appointment?`)) return;
            try {
                await apiFetch(`/appointments/${appointmentId}/status`, {
                    method: 'PUT',
                    body: JSON.stringify({ status }),
                });
                await loadAppointments(); // refresh all counts and lists
            } catch (e) {
                alert('Could not update status: ' + e.message);
            }
        }

        // ── Notification bell ────────────────────────────────────────────────
        function openNotifications()  { loadNotificationCount(); document.getElementById('notificationsModal').style.display = 'flex'; }
        function closeNotifications() { document.getElementById('notificationsModal').style.display = 'none'; }

        // ── Profile menu toggle ──────────────────────────────────────────────
        function toggleProfileMenu() {
            const m = document.getElementById('profileMenu');
            m.style.display = m.style.display === 'none' ? 'block' : 'none';
        }

        // ── Logout ──────────────────────────────────────────────────────────
        // Uses the shared logout() helper from api.js
        document.querySelectorAll('a.logout').forEach(a =>
            a.addEventListener('click', e => { e.preventDefault(); logout(); })
        );
        // Close profile menu when clicking anywhere outside the profile button
        document.addEventListener('click', e => {
            if (!e.target.closest('.profile-btn')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

        // ── Boot ─────────────────────────────────────────────────────────────
        // Load profile first so the banner is shown, then appointments, then notification count.
        (async () => {
            await loadProfile();
            await loadAppointments();
            loadNotificationCount();
        })();
