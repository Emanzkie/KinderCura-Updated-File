// === Extracted from ADMIN\admin-reports.html (script block 1) ===
requireAuth();
        const _u = KC.user();
        if (_u && _u.role !== 'admin') window.location.href = '/parent/dashboard.html';

        let reportCache = null;

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

        // Small helper so the report shows readable percent values.
        function percentOf(value, total) {
            if (!total) return '0%';
            return `${Math.round((value / total) * 100)}%`;
        }

        // Reusable row template for count tables.
        function row(label, value, total) {
            return `<tr><td>${label}</td><td>${value}</td><td>${percentOf(value, total)}</td></tr>`;
        }

        // Human-readable labels for the ACTUAL role values found in the
        // database (models/User.js role enum) — never invented, only
        // prettified. 'parent', 'legal_guardian', 'foster_parent' and
        // 'court_appointed' are all distinct guardian-type roles that can own
        // a Child record; a technical-looking name like "court_appointed" is
        // easy to skip when eyeballing the table, which is exactly how the
        // earlier "Total Users doesn't match Role Breakdown" question arose —
        // the breakdown was always complete, the row was just easy to miss.
        const ROLE_LABELS = {
            parent: 'Parent',
            legal_guardian: 'Legal Guardian',
            foster_parent: 'Foster Parent',
            court_appointed: 'Court-Appointed Guardian',
            pediatrician: 'Pediatrician',
            secretary: 'Secretary',
            admin: 'Admin',
        };

        function roleRow(role, value, total) {
            const label = ROLE_LABELS[role] || role;
            return `<tr><td>${label}</td><td>${value}</td><td>${percentOf(value, total)}</td></tr>`;
        }

        // Builds one summary card at the top of the report page. `note` is an
        // optional short interpretation — what is being counted, and what it
        // should not be read as (req 11) — kept to one line by design.
        function summaryCard(label, value, note) {
            return `<div class="report-card"><p class="report-label">${label}</p><p class="report-value">${value}</p>${note ? `<p class="pr-kpi-note">${note}</p>` : ''}</div>`;
        }

        async function loadReport() {
            try {
                const [dashboard, analytics, pendingUsers] = await Promise.all([
                    apiFetch('/admin/dashboard'),
                    apiFetch('/admin/analytics'),
                    apiFetch('/admin/users?status=pending')
                ]);

                const appointmentStats = analytics.appointmentStats || [];
                const roleBreakdown = analytics.roleBreakdown || [];
                const averageScores = analytics.averageScores || {};
                const totalAppointments = appointmentStats.reduce((sum, item) => sum + (item.count || 0), 0);
                const totalRoles = roleBreakdown.reduce((sum, item) => sum + (item.count || 0), 0);
                // Audited (see routes/auth.js:617 and the login check in
                // routes/auth.js): status:'pending' is set by role-agnostic
                // logic — a real pediatrician sign-up starts pending until
                // PRC/admin approval, and any OTHER role can also be placed in
                // this state by an admin, which likewise blocks login. In the
                // live database today the 100 pending accounts are mostly
                // parent/guardian roles, not pediatricians — so this must be
                // labelled generically, never "Pending Pediatrician Approvals".
                const pendingCount = (pendingUsers.users || []).length;

                reportCache = {
                    generatedAt: new Date().toISOString(),
                    dashboard,
                    analytics,
                    pendingCount,
                    totalAppointments
                };

                document.getElementById('reportGeneratedAt').textContent = `Generated: ${new Date(reportCache.generatedAt).toLocaleString()}`;

                // Top summary cards — Total Children leads, as the primary
                // patient-focused metric (req 2). Every card's note states the
                // unit being counted and, where it matters, what NOT to read
                // the number as (req 11).
                document.getElementById('summaryCards').innerHTML = [
                    summaryCard('Total Children', dashboard.childCount ?? 0,
                        'Distinct Child/patient records registered in KinderCura — the primary patient population.'),
                    summaryCard('Total Users', dashboard.totalUsers ?? 0,
                        'All registered accounts across every role: parent, legal guardian, foster parent, court-appointed guardian, pediatrician, secretary, and admin. See User Role Breakdown below for the exact split.'),
                    summaryCard('Completed Assessments', dashboard.completedAssessments ?? 0,
                        'Assessment records with status = complete, each backed by a stored result. Not the same as active (in-progress) assessments or appointment bookings.'),
                    summaryCard('Active Assessments', dashboard.activeAssessments ?? 0,
                        'Assessment records currently marked in-progress (not yet completed). Counts assessment sessions, not distinct children.'),
                    summaryCard('Total Appointments', totalAppointments,
                        'Total appointment records across all statuses (pending, approved, completed, cancelled, rejected). One child may have several.'),
                    summaryCard('Pending Account Approvals', pendingCount,
                        'User accounts (any role) with status = pending, which blocks sign-in until an admin approves them — includes pediatrician sign-ups awaiting PRC verification as well as other accounts awaiting activation.')
                ].join('');

                // Snapshot table gives the adviser a quick one-look report summary.
                document.getElementById('snapshotTable').innerHTML = `
                    <tr><td>Total parents</td><td>${dashboard.parentCount ?? 0}</td></tr>
                    <tr><td>Total pediatricians</td><td>${dashboard.pediatricianCount ?? 0}</td></tr>
                    <tr><td>Total admins</td><td>${dashboard.adminCount ?? 0}</td></tr>
                    <tr><td>System uptime</td><td>${dashboard.uptime || '99.9%'}</td></tr>
                    <tr><td>Pending account approvals</td><td>${pendingCount}</td></tr>
                    <tr><td>Total appointment records</td><td>${totalAppointments}</td></tr>
                `;

                const scoreCards = [
                    ['Communication', averageScores.avgCommunication],
                    ['Social Skills', averageScores.avgSocial],
                    ['Cognitive', averageScores.avgCognitive],
                    ['Motor Skills', averageScores.avgMotor]
                ];
                document.getElementById('averageScoreBlocks').innerHTML = scoreCards.map(([label, value]) => summaryCard(label, value == null ? '—' : `${Math.round(value)}%`)).join('');

                document.getElementById('appointmentBreakdownTable').innerHTML = appointmentStats.length
                    ? appointmentStats.map(item => row(item.status, item.count || 0, totalAppointments)).join('')
                    : '<tr><td colspan="3" class="muted">No appointment data available.</td></tr>';

                document.getElementById('roleBreakdownTable').innerHTML = roleBreakdown.length
                    ? roleBreakdown.map(item => roleRow(item.role, item.count || 0, totalRoles)).join('')
                    : '<tr><td colspan="3" class="muted">No role data available.</td></tr>';

                // req 3: the breakdown must visibly reconcile to Total Users,
                // not leave the reader to add it up (or miss a row) themselves.
                const reconciliationEl = document.getElementById('roleBreakdownReconciliation');
                if (reconciliationEl) {
                    const matches = totalRoles === (dashboard.totalUsers ?? 0);
                    reconciliationEl.textContent = matches
                        ? `Total: ${totalRoles} — matches Total Users above.`
                        : `Total: ${totalRoles} vs Total Users ${dashboard.totalUsers ?? 0} — these should match; investigate if they do not.`;
                    reconciliationEl.style.color = matches ? '' : 'var(--status-attention-fg, #c0392b)';
                }

                const activities = dashboard.recentActivity || [];
                document.getElementById('recentActivityList').innerHTML = activities.length
                    ? activities.map(item => `
                        <div class="report-item">
                            <p style="font-weight:600;margin-bottom:0.2rem;">${item.type}</p>
                            <p class="muted" style="margin-bottom:0.35rem;">${item.description}</p>
                            <p class="muted" style="font-size:0.82rem;">${item.timestamp}</p>
                        </div>`).join('')
                    : '<div class="report-item"><p class="muted">No recent activity yet.</p></div>';
            } catch (err) {
                console.error('admin reports load error:', err);
                document.getElementById('summaryCards').innerHTML = `<div class="report-card"><p class="report-label">Could not load report</p><p class="report-value" style="font-size:1rem;">${err.message}</p></div>`;
            }
        }

        function refreshReport() {
            loadReport();
        }

        // Print is useful during adviser checking or demo walkthrough.
        function printReport() {
            window.print();
        }

        // Exports the combined report data that is already shown on screen.
        // Includes the Centralized Patient Reports data too, scoped to
        // whichever filters are currently applied (req 26) — never the whole
        // unfiltered patient list when a filter is active.
        function exportReportJson() {
            if (!reportCache) {
                alert('Please wait for the report to finish loading first.');
                return;
            }
            const payload = { ...reportCache, patientReports: patientReportsCache };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'kindercura-admin-report.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        // ================================================================
        // Centralized Patient Reports — the admin pivot (see
        // routes/admin-patient-reports.js). Read-only: this page never
        // scores, never writes, and never invents a pediatrician/parent
        // relationship — it aggregates the SAME stored Assessment /
        // AssessmentResult data Parent Reports and Pediatrician Reports read.
        // ================================================================

        let patientFilters = { pediatricianId: 'all', parentId: 'all', childId: 'all', dateFrom: '', dateTo: '', scope: 'all', sort: 'newest' };
        let patientPage = 1;
        const PATIENT_PAGE_LIMIT = 15;
        let lastPatientPagination = null;
        let patientReportsCache = null; // last successful /patients response, for export (req 26)

        function fmtDateShortPR(d) {
            if (!d) return '—';
            const dt = new Date(d);
            return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function fmtDateTimePR(d) {
            if (!d) return '—';
            const dt = new Date(d);
            return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        }

        function patientReportsNotice(message, kind) {
            const el = document.getElementById('patientReportsNotice');
            if (!el) return;
            if (!message) { el.hidden = true; el.textContent = ''; el.className = 'pr-notice'; return; }
            el.className = 'pr-notice' + (kind === 'error' ? ' is-error' : '');
            el.textContent = message;
            el.hidden = false;
        }

        // ── Overview: system totals + pediatrician/parent rosters ─────────
        // Rosters respect ONLY the date range (a roster answers "who is
        // active", not "who matches today's drill-down" — see
        // services/adminPatientReportsView.js header for the full policy).
        async function loadPatientReportsOverview() {
            try {
                const params = new URLSearchParams();
                if (patientFilters.dateFrom) params.set('dateFrom', patientFilters.dateFrom);
                if (patientFilters.dateTo) params.set('dateTo', patientFilters.dateTo);
                const data = await apiFetch(`/admin/patient-reports/overview?${params.toString()}`);

                const t = data.systemTotals || {};
                document.getElementById('systemTotalsCards').innerHTML = [
                    summaryCard('Total Patients', t.totalPatients ?? 0),
                    summaryCard('Total Parents', t.totalParents ?? 0),
                    summaryCard('Total Pediatricians', t.totalPediatricians ?? 0),
                    summaryCard('Completed Assessments', t.totalCompletedAssessments ?? 0),
                    summaryCard('Total Appointments', t.totalAppointments ?? 0),
                    summaryCard('Pediatrician-Reviewed', t.totalReviewed ?? 0),
                ].join('');

                // Pediatrician dropdown — populated from the roster response so
                // it never needs to load the whole User collection (req 23).
                const pedSelect = document.getElementById('prPediatrician');
                const currentPed = patientFilters.pediatricianId;
                pedSelect.innerHTML = '<option value="all">All Pediatricians</option>'
                    + (data.pediatricianSummary || []).map((p) => `<option value="${escapeHtml(p.pediatricianId)}" ${currentPed === p.pediatricianId ? 'selected' : ''}>${escapeHtml(p.name)} (${p.patients})</option>`).join('');

                const pedRowsEl = document.getElementById('pediatricianReportSummaryRows');
                const pedList = data.pediatricianSummary || [];
                pedRowsEl.innerHTML = pedList.length
                    ? pedList.map((p) => `<tr>
                        <td>${escapeHtml(p.name)}</td>
                        <td>${escapeHtml(String(p.patients))}</td>
                        <td>${escapeHtml(String(p.assessments))}</td>
                        <td>${escapeHtml(String(p.reviewed))}</td>
                        <td>${fmtDateShortPR(p.latestActivity)}</td>
                    </tr>`).join('') + (data.pediatricianSummaryCapped ? '<tr><td colspan="5" class="muted">Showing the most active pediatricians only. Use the Pediatrician filter above to look up a specific one.</td></tr>' : '')
                    : '<tr><td colspan="5" class="muted">No pediatrician has any patients yet.</td></tr>';

                const parentRowsEl = document.getElementById('parentReportSummaryRows');
                const parentList = data.parentSummary || [];
                parentRowsEl.innerHTML = parentList.length
                    ? parentList.map((p) => `<tr>
                        <td>${escapeHtml(p.name)}</td>
                        <td>${escapeHtml(String(p.children))}</td>
                        <td>${escapeHtml(String(p.assessments))}</td>
                        <td>${fmtDateShortPR(p.latestActivity)}</td>
                    </tr>`).join('') + (data.parentSummaryCapped ? '<tr><td colspan="4" class="muted">Showing the most active parents only. Use the Parent filter above to look up a specific one.</td></tr>' : '')
                    : '<tr><td colspan="4" class="muted">No parent has any children on file yet.</td></tr>';
            } catch (err) {
                console.error('patient reports overview error:', err);
                document.getElementById('systemTotalsCards').innerHTML = summaryCard('Could not load', err.message);
            }
        }

        function statusPillClass(label) {
            const l = String(label || '').toLowerCase();
            if (l.includes('on') || l.includes('track')) return 'pill pill-green';
            if (l.includes('delay') || l.includes('concern')) return 'pill pill-red';
            if (label) return 'pill pill-orange';
            return '';
        }

        // ── Main pivot table ───────────────────────────────────────────────
        async function loadPatientReportsList() {
            const rowsEl = document.getElementById('patientReportsRows');
            rowsEl.innerHTML = '<tr><td colspan="9" style="padding:2rem;text-align:center;color:var(--text-light);">Loading...</td></tr>';
            patientReportsNotice(null);

            try {
                const params = new URLSearchParams({ page: patientPage, limit: PATIENT_PAGE_LIMIT, sort: patientFilters.sort, scope: patientFilters.scope });
                if (patientFilters.pediatricianId !== 'all') params.set('pediatricianId', patientFilters.pediatricianId);
                if (patientFilters.parentId !== 'all') params.set('parentId', patientFilters.parentId);
                if (patientFilters.childId !== 'all') params.set('childId', patientFilters.childId);
                if (patientFilters.dateFrom) params.set('dateFrom', patientFilters.dateFrom);
                if (patientFilters.dateTo) params.set('dateTo', patientFilters.dateTo);

                const data = await apiFetch(`/admin/patient-reports/patients?${params.toString()}`);
                patientReportsCache = data;
                lastPatientPagination = data.pagination || null;

                document.getElementById('patientPivotTitle').textContent = data.title || 'All Patient Reports';

                const s = data.summary || {};
                document.getElementById('patientFilteredSummary').innerHTML = [
                    summaryCard('Patients', s.patients ?? 0),
                    summaryCard('Assessments', s.assessments ?? 0),
                    summaryCard('Reviewed', s.reviewed ?? 0),
                    summaryCard('Latest Activity', fmtDateShortPR(s.latestActivity)),
                ].join('');

                const rows = data.rows || [];
                if (!rows.length) {
                    rowsEl.innerHTML = '<tr><td colspan="9" style="padding:2rem;text-align:center;color:var(--text-light);">No reports found for the selected filters.</td></tr>';
                } else {
                    rowsEl.innerHTML = rows.map((r) => `
                        <tr>
                            <td>${escapeHtml(r.childName)}</td>
                            <td>${escapeHtml(r.parentName)}</td>
                            <td>${r.pediatricianName ? escapeHtml(r.pediatricianName) : '<span class="muted">—</span>'}</td>
                            <td>${escapeHtml(String(r.assessmentsCount))}</td>
                            <td>${r.latestScore != null ? escapeHtml(String(r.latestScore)) + '%' : '<span class="muted">—</span>'}</td>
                            <td>${r.latestStatusLabel ? `<span class="${statusPillClass(r.latestStatusLabel)}">${escapeHtml(r.latestStatusLabel)}</span>` : '<span class="muted">No assessment in range</span>'}</td>
                            <td>${fmtDateShortPR(r.latestAssessmentDate)}</td>
                            <td>${r.hasReview ? '<span class="pr-review-yes">Reviewed</span>' : '<span class="pr-review-no">Not reviewed</span>'}</td>
                            <td><button class="btn btn-secondary" style="padding:0.35rem 0.7rem;font-size:0.78rem;" onclick="viewPatientReport('${r.childId}', '${escapeHtml(r.childName).replace(/'/g, "\\'")}')">View Report</button></td>
                        </tr>`).join('');
                }

                renderPatientReportsPagination();
            } catch (err) {
                console.error('patient reports list error:', err);
                rowsEl.innerHTML = '';
                patientReportsNotice(`Could not load patient reports: ${err.message}`, 'error');
                document.getElementById('patientFilteredSummary').innerHTML = summaryCard('Could not load', 'Server request failed');
            }
        }

        function renderPatientReportsPagination() {
            const p = lastPatientPagination;
            const info = document.getElementById('patientReportsPageInfo');
            const prev = document.getElementById('prPrevBtn');
            const next = document.getElementById('prNextBtn');
            if (!p) { info.textContent = '—'; return; }
            const start = p.total === 0 ? 0 : (p.page - 1) * p.limit + 1;
            const end = Math.min(p.page * p.limit, p.total);
            info.textContent = `Showing ${start}–${end} of ${p.total} patient${p.total === 1 ? '' : 's'} (page ${p.page} of ${p.totalPages})`;
            prev.disabled = !p.hasPrev;
            next.disabled = !p.hasNext;
            prev.style.opacity = p.hasPrev ? '1' : '0.5';
            next.style.opacity = p.hasNext ? '1' : '0.5';
        }

        function changePatientReportsPage(delta) {
            if (!lastPatientPagination) return;
            const next = patientPage + delta;
            if (next < 1 || next > lastPatientPagination.totalPages) return;
            patientPage = next;
            loadPatientReportsList();
        }

        function onPatientFilterChange(key, value) {
            patientFilters[key] = value;
            patientPage = 1;
            loadPatientReportsList();
            // The date range also affects the (date-scoped) roster summaries.
            if (key === 'dateFrom' || key === 'dateTo') loadPatientReportsOverview();
        }

        function resetPatientFilters() {
            patientFilters = { pediatricianId: 'all', parentId: 'all', childId: 'all', dateFrom: '', dateTo: '', scope: 'all', sort: 'newest' };
            patientPage = 1;
            document.getElementById('prPediatrician').value = 'all';
            document.getElementById('prParentSearch').value = '';
            document.getElementById('prParentId').value = '';
            document.getElementById('prChildSearch').value = '';
            document.getElementById('prChildId').value = '';
            document.getElementById('prDateFrom').value = '';
            document.getElementById('prDateTo').value = '';
            document.getElementById('prScope').value = 'all';
            document.getElementById('prSort').value = 'newest';
            loadPatientReportsOverview();
            loadPatientReportsList();
        }

        // ── Parent / Child typeahead (req 23 — never load the whole
        // collection into the browser) ─────────────────────────────────────
        let parentSearchTimer = null;
        function onParentSearchInput(value) {
            clearTimeout(parentSearchTimer);
            document.getElementById('prParentId').value = '';
            parentSearchTimer = setTimeout(async () => {
                const resultsEl = document.getElementById('prParentResults');
                if (!value || value.trim().length < 2) { resultsEl.hidden = true; return; }
                try {
                    const data = await apiFetch(`/admin/patient-reports/search?type=parent&q=${encodeURIComponent(value.trim())}`);
                    const results = data.results || [];
                    resultsEl.innerHTML = results.length
                        ? results.map((r) => `<div class="pr-typeahead-item" onclick="selectParentResult('${r.id}', '${escapeHtml(r.name).replace(/'/g, "\\'")}')">${escapeHtml(r.name)}</div>`).join('')
                        : '<div class="pr-typeahead-item muted">No matching parent</div>';
                    resultsEl.hidden = false;
                } catch (err) {
                    resultsEl.hidden = true;
                }
            }, 300);
        }

        function selectParentResult(id, name) {
            document.getElementById('prParentSearch').value = name;
            document.getElementById('prParentId').value = id;
            document.getElementById('prParentResults').hidden = true;
            onPatientFilterChange('parentId', id);
        }

        let childSearchTimer = null;
        function onChildSearchInput(value) {
            clearTimeout(childSearchTimer);
            document.getElementById('prChildId').value = '';
            childSearchTimer = setTimeout(async () => {
                const resultsEl = document.getElementById('prChildResults');
                if (!value || value.trim().length < 2) { resultsEl.hidden = true; return; }
                try {
                    const params = new URLSearchParams({ type: 'child', q: value.trim() });
                    if (patientFilters.pediatricianId !== 'all') params.set('pediatricianId', patientFilters.pediatricianId);
                    if (patientFilters.parentId !== 'all') params.set('parentId', patientFilters.parentId);
                    const data = await apiFetch(`/admin/patient-reports/search?${params.toString()}`);
                    const results = data.results || [];
                    resultsEl.innerHTML = results.length
                        ? results.map((r) => `<div class="pr-typeahead-item" onclick="selectChildResult('${r.id}', '${escapeHtml(r.name).replace(/'/g, "\\'")}')">${escapeHtml(r.name)}</div>`).join('')
                        : '<div class="pr-typeahead-item muted">No matching child</div>';
                    resultsEl.hidden = false;
                } catch (err) {
                    resultsEl.hidden = true;
                }
            }, 300);
        }

        function selectChildResult(id, name) {
            document.getElementById('prChildSearch').value = name;
            document.getElementById('prChildId').value = id;
            document.getElementById('prChildResults').hidden = true;
            onPatientFilterChange('childId', id);
        }

        // ── Detailed patient report modal (req 11) — reuses the SAME
        // /api/parent/children/:childId/report endpoint Parent Reports calls.
        // Never recomputes a score; only reads and displays what that
        // endpoint returns.
        async function viewPatientReport(childId, childName) {
            const modal = document.getElementById('patientReportModal');
            const body = document.getElementById('patientReportModalBody');
            document.getElementById('patientReportModalTitle').textContent = `${childName} — Patient Report`;
            modal.style.display = 'flex';
            body.innerHTML = '<p class="muted">Loading...</p>';

            try {
                const data = await apiFetch(`/parent/children/${childId}/report`);
                const assessments = (data.assessments || []).slice().reverse(); // newest first for this view
                const follow = data.followUp;

                const historyRows = assessments.length
                    ? assessments.map((a) => `
                        <tr>
                            <td>${fmtDateShortPR(a.completedAt)}</td>
                            <td>${a.overallScore != null ? Math.round(a.overallScore) + '%' : '—'}</td>
                            <td>${a.domains.find(d => d.key==='communication')?.score ?? '—'}</td>
                            <td>${a.domains.find(d => d.key==='social')?.score ?? '—'}</td>
                            <td>${a.domains.find(d => d.key==='cognitive')?.score ?? '—'}</td>
                            <td>${a.domains.find(d => d.key==='motor')?.score ?? '—'}</td>
                        </tr>`).join('')
                    : '<tr><td colspan="6" class="muted">No completed assessments found.</td></tr>';

                const latest = assessments[0];
                const review = latest && latest.review && (latest.review.reviewedAt || latest.review.recommendations || latest.review.nextAssessmentDate)
                    ? `
                        <p><strong>Reviewed by:</strong> ${escapeHtml(latest.review.pediatricianName || '—')}</p>
                        <p><strong>Reviewed date:</strong> ${fmtDateTimePR(latest.review.reviewedAt)}</p>
                        <p><strong>Recommendation:</strong> ${latest.review.recommendations ? escapeHtml(latest.review.recommendations) : '—'}</p>
                        <p><strong>Next recommended follow-up:</strong> ${latest.review.nextAssessmentDate ? fmtDateShortPR(latest.review.nextAssessmentDate) : '—'}</p>
                        <p><strong>Reason:</strong> ${latest.review.nextAssessmentReason ? escapeHtml(latest.review.nextAssessmentReason) : '—'}</p>`
                    : '<p class="muted">No pediatrician review documented.</p>';

                body.innerHTML = `
                    <p><strong>Patient:</strong> ${escapeHtml(childName)}</p>
                    <h4 style="margin:1rem 0 0.5rem;">Assessment History</h4>
                    <div style="overflow-x:auto;">
                        <table class="simple-table">
                            <thead><tr><th>Date</th><th>Overall</th><th>Communication</th><th>Social</th><th>Cognitive</th><th>Motor</th></tr></thead>
                            <tbody>${historyRows}</tbody>
                        </table>
                    </div>
                    <h4 style="margin:1.25rem 0 0.5rem;">Pediatrician Review (Latest Assessment)</h4>
                    ${review}
                    ${follow ? `<p class="muted" style="margin-top:0.75rem;">Scheduled follow-up on file: ${fmtDateShortPR(follow.nextAssessmentDate)}${follow.reason ? ' — ' + escapeHtml(follow.reason) : ''}</p>` : ''}
                `;
            } catch (err) {
                body.innerHTML = `<p style="color:var(--status-attention-fg, #c0392b);">Could not load this patient's report: ${escapeHtml(err.message)}</p>`;
            }
        }

        function closePatientReportModal() {
            document.getElementById('patientReportModal').style.display = 'none';
        }

        // req 10: dataset/demo-data volume, kept visibly separate from the
        // real user/child/assessment totals above. Reuses the EXACT SAME
        // /admin/demo-data/summary endpoint already shown on the Data Sources
        // page's "System Demo Data" panel — no new counting logic here.
        const DEMO_COLLECTION_LABELS = {
            users: 'Users', children: 'Children', assessments: 'Assessments',
            results: 'Assessment results', answers: 'Assessment answers', appointments: 'Appointments',
        };

        async function loadDemoDataVolume() {
            const tbody = document.getElementById('demoDataVolumeTable');
            if (!tbody) return;
            try {
                const data = await apiFetch('/admin/demo-data/summary');
                const c = data.collections || {};
                const rows = Object.keys(DEMO_COLLECTION_LABELS).filter((k) => c[k]).map((k) => `
                    <tr>
                        <td>${DEMO_COLLECTION_LABELS[k]}</td>
                        <td>${c[k].total}</td>
                        <td>${c[k].synthetic}</td>
                        <td>${c[k].real}</td>
                    </tr>`).join('');
                tbody.innerHTML = rows || '<tr><td colspan="4" class="muted">No demo data recorded.</td></tr>';
            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="4" style="color:var(--status-attention-fg, #c0392b);">Could not load demo data volume: ${escapeHtml(err.message)}</td></tr>`;
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadReport();
            loadPatientReportsOverview();
            loadPatientReportsList();
            loadDemoDataVolume();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                refreshReport();
            }, 30000);
        });
