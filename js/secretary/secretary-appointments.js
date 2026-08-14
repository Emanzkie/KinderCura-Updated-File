// === Extracted from SECRETARY\secretary-appointments.html (script block 1) ===
// ── Auth guard ──────────────────────────────────────────────────────
        // Only assistant/secretary accounts may access this page.
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
        let allAppointments = [];
        let currentFilter   = 'all';
        let canManagePayments = false;

        // ── Helpers ─────────────────────────────────────────────────────────

        // Convert ISO date to short readable format ("Apr 19, 2026")
        function fmtDate(d) {
            if (!d) return '—';
            const x = new Date(d);
            if (isNaN(x)) return '—';
            return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        // Convert "HH:MM" to 12-hour clock format ("9:00 AM")
        function fmtTime(t) {
            if (!t) return '—';
            const [h, m] = t.split(':').map(Number);
            return `${((h % 12) || 12)}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
        }

        // Prevent XSS when injecting user-supplied data into innerHTML
        function escapeHtml(s) {
            return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // ── Profile load ────────────────────────────────────────────────────
        // Fetches the secretary's profile and linked pediatrician details.
        // Updates the profile menu name and the "on behalf of" banner.
        async function loadProfile() {
            try {
                const data = await apiFetch('/secretary/me');
                const sec  = data.secretary;
                canManagePayments = Boolean(sec.permissions && sec.permissions.managePayments);
                document.getElementById('profileMenuName').textContent =
                    `${sec.firstName} ${sec.lastName}`;

                const banner = document.getElementById('onBehalfBanner');
                if (sec.linkedPediatrician) {
                    const p = sec.linkedPediatrician;
                    document.getElementById('pedNameBanner').textContent =
                        `Dr. ${p.firstName} ${p.lastName}${p.clinicName ? ' — ' + p.clinicName : ''}`;
                    banner.style.display = 'flex';
                } else {
                    // Amber warning: not linked to a pediatrician yet
                    banner.style.cssText = 'display:flex;border-color:#d97706;background:#fef3c7;color:#92400e;border-radius:8px;padding:0.65rem 1rem;align-items:center;gap:0.6rem;margin-bottom:1.2rem;font-size:0.88rem;';
                    banner.innerHTML = '<img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️ Your account is not yet linked to a pediatrician. Contact the system administrator.';
                }
            } catch (e) {
                console.error('loadProfile error:', e);
            }
        }

        // ── Load appointments ────────────────────────────────────────────────
        // Fetches all appointments for the linked pediatrician's clinic
        // and refreshes the rendered list.
        async function loadAppointments() {
            try {
                const data = await apiFetch('/appointments/pedia');
                allAppointments = data.appointments || [];
                renderList();
            } catch (e) {
                document.getElementById('apptList').innerHTML =
                    `<p class="empty-msg" style="color:var(--danger);">Could not load appointments: ${escapeHtml(e.message)}</p>`;
            }
        }

        // ── Tab filter ───────────────────────────────────────────────────────
        // Switches the active tab and re-renders the filtered list.
        function filterTab(tab) {
            currentFilter = tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('tab-' + tab).classList.add('active');
            renderList();
        }

        // ── Render appointment list ──────────────────────────────────────────
        // Builds appointment cards filtered by the current tab selection.
        // Pending cards show Approve / Reschedule / Reject buttons.
        // Approved cards show Reschedule / Cancel buttons.
        function renderList() {
            const filtered = currentFilter === 'all'
                ? allAppointments
                : allAppointments.filter(a => a.status === currentFilter);

            const el = document.getElementById('apptList');
            if (!filtered.length) {
                el.innerHTML = '<p class="empty-msg">No appointments in this category.</p>';
                return;
            }

            el.innerHTML = filtered.map(a => {
                // Build action buttons based on the appointment's current status
                let actions = '';
                if (a.status === 'pending') {
                    const walkInBtn = (a.pendingPaymentMode === 'walk_in' && canManagePayments)
                        ? `<button class="btn-approve" onclick="confirmWalkIn(${a.id})" style="background:var(--status-positive-fg);">&#8369; Confirm Cash Payment</button>`
                        : '';
                    actions = `
                        ${walkInBtn}
                        <button class="btn-approve"    onclick="updateStatus(${a.id},'approved')">&#10003; Approve</button>
                        <button class="btn-reschedule" onclick="openReschedule(${a.id})"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Reschedule</button>
                        <button class="btn-reject"     onclick="updateStatus(${a.id},'rejected')">&#215; Reject</button>`;
                } else if (a.status === 'approved') {
                    actions = `
                        <button class="btn-reschedule" onclick="openReschedule(${a.id})"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Reschedule</button>
                        <button class="btn-reject"     onclick="updateStatus(${a.id},'cancelled')">Cancel</button>`;
                }

                return `
                    <div class="appt-card ${a.status}">
                        <div class="appt-card-header">
                            <div class="appt-main">
                                <p class="appt-title"><img src="/icons/parent.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.childName||'Child')} &nbsp;&middot;&nbsp; ${escapeHtml(a.parentName||'Parent')}</p>
                                <p class="mini"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${fmtDate(a.appointmentDate)} at ${fmtTime(a.appointmentTime)}</p>
                                <p class="mini"><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.reason||'General checkup')}</p>
                                ${a.notes ? `<p class="mini"><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.notes)}</p>` : ''}
                                ${a.paymentStatus ? `<p class="mini" style="margin-top:0.3rem;">&#8369; Payment: <strong>${escapeHtml(a.paymentStatus)}</strong>${a.pendingPaymentMode === 'walk_in' ? ' — Walk-in' : a.pendingPaymentMode === 'ewallet' ? ' — E-Wallet' : ''}</p>` : ''}
                            </div>
                            <span class="badge ${a.status}">${a.status.charAt(0).toUpperCase()+a.status.slice(1)}</span>
                        </div>
                        ${actions ? `<div class="card-actions">${actions}</div>` : ''}
                    </div>`;
            }).join('');
        }

        // ── Status update ────────────────────────────────────────────────────
        // Important: the backend checks the secretary's linkedPediatricianId
        // before allowing the status change — preserving the pediatrician's authority.
        async function updateStatus(appointmentId, status) {
            const labels = { approved:'Approve', rejected:'Reject', cancelled:'Cancel' };
            if (!confirm(`${labels[status]||'Update'} this appointment?`)) return;
            try {
                await apiFetch(`/appointments/${appointmentId}/status`, {
                    method: 'PUT',
                    body: JSON.stringify({ status }),
                });
                await loadAppointments(); // refresh the list after the change
            } catch (e) {
                alert('Could not update status: ' + e.message);
            }
        }

        // ── Walk-in payment confirmation ──────────────────────────────────────
        async function confirmWalkIn(appointmentId) {
            if (!confirm('Confirm that this parent has paid in cash or via POS at the clinic counter?')) return;
            try {
                await apiFetch(`/payments/appointments/${appointmentId}/confirm-walkin`, {
                    method: 'POST',
                    body: JSON.stringify({ paymentMethod: 'cash' }),
                });
                await loadAppointments();
            } catch (e) {
                alert('Could not confirm payment: ' + e.message);
            }
        }

        // ── Reschedule modal ─────────────────────────────────────────────────

        // Open the reschedule modal for a specific appointment
        function openReschedule(id) {
            document.getElementById('rescheduleApptId').value = id;
            // Prevent selecting dates in the past
            document.getElementById('rNewDate').min = new Date().toISOString().split('T')[0];
            document.getElementById('rNewDate').value = '';
            document.getElementById('rNewTime').value = '';
            document.getElementById('rNote').value = '';
            document.getElementById('rescheduleError').style.display = 'none';
            document.getElementById('rescheduleModal').style.display = 'flex';
        }

        function closeReschedule() {
            document.getElementById('rescheduleModal').style.display = 'none';
        }

        // Submit the reschedule form.
        // The backend validates the new slot against the pediatrician's availability rules.
        async function submitReschedule() {
            const id      = document.getElementById('rescheduleApptId').value;
            const newDate = document.getElementById('rNewDate').value;
            const newTime = document.getElementById('rNewTime').value;
            const note    = document.getElementById('rNote').value.trim();
            const errEl   = document.getElementById('rescheduleError');

            errEl.style.display = 'none';
            if (!newDate || !newTime) {
                errEl.textContent = 'Please select a new date and time.';
                errEl.style.display = 'block';
                return;
            }

            try {
                await apiFetch(`/appointments/${id}/reschedule`, {
                    method: 'POST',
                    body: JSON.stringify({ newDate, newTime, note }),
                });
                closeReschedule();
                await loadAppointments(); // refresh after successful reschedule
            } catch (e) {
                errEl.textContent = e.message || 'Reschedule failed.';
                errEl.style.display = 'block';
            }
        }

        // ── Notification bell ─────────────────────────────────────────────────
        function openNotifications()  { loadNotificationCount(); document.getElementById('notificationsModal').style.display = 'flex'; }
        function closeNotifications() { document.getElementById('notificationsModal').style.display = 'none'; }

        // ── Profile menu ──────────────────────────────────────────────────────
        function toggleProfileMenu() {
            const m = document.getElementById('profileMenu');
            m.style.display = m.style.display === 'none' ? 'block' : 'none';
        }

        // Close profile menu when clicking outside the profile button
        document.addEventListener('click', e => {
            if (!e.target.closest('.profile-btn'))
                document.getElementById('profileMenu').style.display = 'none';
        });

        // Attach logout to the logout link using the shared logout() from api.js
        document.querySelectorAll('a.logout').forEach(a =>
            a.addEventListener('click', e => { e.preventDefault(); logout(); })
        );

        // ── Boot ─────────────────────────────────────────────────────────────
        // Load profile first so the banner is shown, then appointments, then notification count.
        (async () => {
            await loadProfile();
            await loadAppointments();
            loadNotificationCount();
        })();
