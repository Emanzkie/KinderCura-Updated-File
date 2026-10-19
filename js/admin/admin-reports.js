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

        // value ÷ total as a one-decimal share (same format as Admin
        // Analytics). N/A — never 0% — when there is nothing to divide by.
        function percentOf(value, total) {
            if (!total || !Number.isFinite(value) || value < 0 || value > total) return 'N/A';
            const pct = (value / total) * 100;
            if (pct > 0 && pct < 0.05) return '<0.1%';
            return `${pct.toFixed(1)}%`;
        }

        // "x% of N <noun>", or a plain "N/A (no <noun>)" when N is zero.
        function shareOfText(part, whole, noun) {
            return whole > 0 ? `${percentOf(part, whole)} of ${fmtCountR(whole)} ${noun}` : `N/A (no ${noun})`;
        }

        function fmtCountR(value) {
            return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—';
        }

        // Reusable row template for count tables.
        function row(label, value, total) {
            const text = String(label || 'No status recorded');
            return `<tr><td>${escapeHtml(text.charAt(0).toUpperCase() + text.slice(1))}</td><td class="num">${fmtCountR(value)}</td><td class="num">${percentOf(value, total)}</td></tr>`;
        }

        // Closing row for a count table: the same total the shares divide by,
        // so the column visibly sums (percentOf gives N/A when it is zero).
        function totalRow(total) {
            return `<tr class="total-row"><td>Total</td><td class="num">${fmtCountR(total)}</td><td class="num">${percentOf(total, total)}</td></tr>`;
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
            return `<tr><td>${escapeHtml(label)}</td><td class="num">${fmtCountR(value)}</td><td class="num">${percentOf(value, total)}</td></tr>`;
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
                document.getElementById('reportRefreshNotice').hidden = true;

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
                // System uptime: the API's `uptime` field is a fixed '99.9%'
                // string in routes/admin.js, not a measurement, so it is not
                // shown (same treatment as the Admin Dashboard).
                document.getElementById('snapshotTable').innerHTML = `
                    <tr><td>Parent-role accounts <span class="muted snapshot-note">(legal guardian, foster parent and court-appointed accounts are listed separately in User Role Breakdown)</span></td><td>${fmtCountR(dashboard.parentCount ?? 0)}</td></tr>
                    <tr><td>Total pediatricians</td><td>${fmtCountR(dashboard.pediatricianCount ?? 0)}</td></tr>
                    <tr><td>Total admins</td><td>${fmtCountR(dashboard.adminCount ?? 0)}</td></tr>
                    <tr><td>System uptime <span class="muted snapshot-note">(no uptime monitor is connected)</span></td><td>Not measured</td></tr>
                    <tr><td>Pending account approvals <span class="muted snapshot-note">(accounts of any role awaiting activation)</span></td><td>${fmtCountR(pendingCount)}</td></tr>
                    <tr><td>Total appointment records <span class="muted snapshot-note">(every status)</span></td><td>${fmtCountR(totalAppointments)}</td></tr>
                `;

                const scoreCards = [
                    ['Communication', averageScores.avgCommunication],
                    ['Social Skills', averageScores.avgSocial],
                    ['Cognitive', averageScores.avgCognitive],
                    ['Motor Skills', averageScores.avgMotor]
                ];
                // The API sends 0 when there are no results to average; with
                // no completed assessments that 0 is not a real score.
                const noScores = (analytics.scoreDistribution && analytics.scoreDistribution.total === 0)
                    || (analytics.summaryTotals && analytics.summaryTotals.completedScreenings === 0);
                reportCache.noScores = noScores;
                document.getElementById('averageScoreBlocks').innerHTML = scoreCards.map(([label, value]) =>
                    summaryCard(label, noScores || value == null ? 'N/A' : `${Math.round(value)}%`, 'mean domain score')).join('');

                document.getElementById('appointmentBreakdownTable').innerHTML = appointmentStats.length
                    ? appointmentStats.map(item => row(item.status, item.count || 0, totalAppointments)).join('') + totalRow(totalAppointments)
                    :'<tr><td colspan="3" class="muted">No appointment data available.</td></tr>';
                const apptNote = document.getElementById('appointmentBreakdownNote');
                if (apptNote) {
                    apptNote.textContent = `Share = appointments in that status ÷ all ${fmtCountR(totalAppointments)} appointment records (every status, all dates). Shares are rounded to one decimal.`;
                }
                renderAppointmentInterpretation(appointmentStats, totalAppointments);

                document.getElementById('roleBreakdownTable').innerHTML = roleBreakdown.length
                    ? roleBreakdown.map(item => roleRow(item.role, item.count || 0, totalRoles)).join('') + totalRow(totalRoles)
                    :'<tr><td colspan="3" class="muted">No role data available.</td></tr>';

                // req 3: the breakdown must visibly reconcile to Total Users,
                // not leave the reader to add it up (or miss a row) themselves.
                const reconciliationEl = document.getElementById('roleBreakdownReconciliation');
                if (reconciliationEl) {
                    const matches = totalRoles === (dashboard.totalUsers ?? 0);
                    reconciliationEl.textContent = matches
                        ? `Total: ${fmtCountR(totalRoles)} — matches Total Users above. Share = accounts with that role ÷ all ${fmtCountR(totalRoles)} accounts (every status).`
                        : `Total: ${fmtCountR(totalRoles)} vs Total Users ${fmtCountR(dashboard.totalUsers ?? 0)} — these should match; investigate if they do not.`;
                    reconciliationEl.style.color = matches ? '' : 'var(--status-attention-fg, #3D4738)';
                }

                const activities = dashboard.recentActivity || [];
                document.getElementById('recentActivityList').innerHTML = activities.length
                    ? activities.map(item => `
                        <div class="report-item">
                            <p style="font-weight:600;margin-bottom:0.2rem;">${escapeHtml(item.type)}</p>
                            <p class="muted" style="margin-bottom:0.35rem;">${escapeHtml(item.description)}</p>
                            <p class="muted" style="font-size:0.82rem;">${escapeHtml(item.timestamp)}</p>
                        </div>`).join('')
                    : '<div class="report-item"><p class="muted">No recent activity yet.</p></div>';
                renderTotalsCheck();
            } catch (err) {
                console.error('admin reports load error:', err);
                // A failed refresh keeps the last figures that loaded, all from
                // one consistent result, and says so — rather than replacing
                // good tables with "Unavailable" while their totals linger.
                if (reportCache) {
                    const notice = document.getElementById('reportRefreshNotice');
                    notice.textContent = `Refresh failed at ${new Date().toLocaleTimeString()}: ${err.message}. Showing the figures generated ${new Date(reportCache.generatedAt).toLocaleString()}.`;
                    notice.hidden = false;
                    return;
                }
                document.getElementById('summaryCards').innerHTML = `<div class="report-card"><p class="report-label">Could not load report</p><p class="report-value" style="font-size:1rem;">${escapeHtml(err.message)}</p></div>`;
                // Leave nothing on "Loading…" that looks like it might still arrive.
                document.getElementById('snapshotTable').innerHTML = '<tr><td colspan="2" class="muted">Unavailable: the report did not load.</td></tr>';
                document.getElementById('averageScoreBlocks').innerHTML = summaryCard('Average scores', '—', 'Unavailable: the report did not load.');
                document.getElementById('appointmentBreakdownTable').innerHTML = '<tr><td colspan="3" class="muted">Unavailable: the report did not load.</td></tr>';
                document.getElementById('roleBreakdownTable').innerHTML = '<tr><td colspan="3" class="muted">Unavailable: the report did not load.</td></tr>';
                document.getElementById('recentActivityList').innerHTML = '<div class="report-item"><p class="muted">Unavailable: the report did not load.</p></div>';
                document.getElementById('roleBreakdownReconciliation').textContent = '—';
                document.getElementById('appointmentBreakdownNote').textContent = '—';
                document.getElementById('appointmentBreakdownInterp').hidden = true;
            }
        }

        // States the largest status and how settled the bookings are, from the
        // same rows and total as the table above. No trend: there is no
        // earlier period to compare against.
        function renderAppointmentInterpretation(stats, total) {
            const box = document.getElementById('appointmentBreakdownInterp');
            const text = document.getElementById('appointmentBreakdownInterpText');
            if (!box || !text) return;
            box.hidden = false;
            if (!total) {
                text.textContent = 'No appointment records yet, so there is insufficient data for an interpretation.';
                return;
            }
            const countOf = (s) => stats.filter((x) => x.status === s).reduce((n, x) => n + (x.count || 0), 0);
            const max = Math.max(...stats.map((x) => x.count || 0));
            const leaders = stats.filter((x) => (x.count || 0) === max)
                .map((x) => { const t = String(x.status || 'no status recorded'); return t.charAt(0).toUpperCase() + t.slice(1); });
            const open = countOf('pending') + countOf('approved');
            const closedUnseen = countOf('cancelled') + countOf('rejected');
            text.textContent = [
                `${leaders.length > 1 ? `The most common statuses (tied) are ${leaders.join(' and ')}` : `The most common status is ${leaders[0]}`}, with ${fmtCountR(max)} of ${fmtCountR(total)} appointment records (${percentOf(max, total)}).`,
                `${fmtCountR(open)} (${percentOf(open, total)}) are still open (pending or approved), ${fmtCountR(countOf('completed'))} (${percentOf(countOf('completed'), total)}) are completed, and ${fmtCountR(closedUnseen)} (${percentOf(closedUnseen, total)}) ended without a visit (cancelled or rejected).`,
                'These are all-time counts; they do not show a trend.',
            ].join(' ');
        }

        // The top summary and the System-wide totals count children,
        // completed assessments and appointments through different endpoints.
        // When both have loaded, say whether they agree; a difference is shown
        // with both values, and neither source is assumed to be the right one.
        let systemTotalsCache = null;
        function renderTotalsCheck() {
            const el = document.getElementById('systemTotalsCheck');
            if (!el || !reportCache || !systemTotalsCache) return;
            const d = reportCache.dashboard || {};
            const t = systemTotalsCache;
            const pairs = [
                ['Children', d.childCount, t.totalPatients],
                ['Completed assessments', d.completedAssessments, t.totalCompletedAssessments],
                ['Appointments', reportCache.totalAppointments, t.totalAppointments],
            ];
            const diffs = pairs.filter(([, a, b]) => Number(a ?? 0) !== Number(b ?? 0));
            el.classList.toggle('totals-mismatch', diffs.length > 0);
            el.textContent = diffs.length
                ? `Mismatch with the summary at the top of the page — ${diffs.map(([label, a, b]) => `${label}: top summary ${fmtCountR(a ?? 0)}, system-wide totals ${fmtCountR(b ?? 0)}`).join('; ')}. The two figures come from different queries; neither is assumed correct, so check both.`
                : 'Children, completed assessments and appointments match the summary at the top of the page (counted by a separate query).';
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

                // Always system-wide and all-time (routes/admin-patient-reports.js
                // GET /overview) — the filters below never change these.
                const t = data.systemTotals || {};
                systemTotalsCache = t;
                renderTotalsCheck();
                document.getElementById('systemTotalsCards').innerHTML = [
                    summaryCard('Total Patients', fmtCountR(t.totalPatients ?? 0), 'Every child record, assessed or not.'),
                    summaryCard('Total Parents', fmtCountR(t.totalParents ?? 0), 'Parent-role accounts only; other guardian roles are not included.'),
                    summaryCard('Total Pediatricians', fmtCountR(t.totalPediatricians ?? 0), 'Pediatrician accounts, any status.'),
                    summaryCard('Completed Assessments', fmtCountR(t.totalCompletedAssessments ?? 0), 'Assessment sessions with status complete. Counts sessions, not children.'),
                    summaryCard('Total Appointments', fmtCountR(t.totalAppointments ?? 0), 'Appointment records of every status.'),
                    summaryCard('Pediatrician-Reviewed', fmtCountR(t.totalReviewed ?? 0),
                        `Completed assessments with a recorded pediatrician review: ${shareOfText(t.totalReviewed ?? 0, t.totalCompletedAssessments ?? 0, 'completed assessments')}.`),
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
                        <td class="num">${fmtCountR(p.patients)}</td>
                        <td class="num">${fmtCountR(p.assessments)}</td>
                        <td class="num">${fmtCountR(p.reviewed)}</td>
                        <td>${fmtDateShortPR(p.latestActivity)}</td>
                    </tr>`).join('') + (data.pediatricianSummaryCapped ? '<tr><td colspan="5" class="muted">Showing the most active pediatricians only. Use the Pediatrician filter above to look up a specific one.</td></tr>' : '')
                    : '<tr><td colspan="5" class="muted">No pediatrician has any patients yet.</td></tr>';

                const parentRowsEl = document.getElementById('parentReportSummaryRows');
                const parentList = data.parentSummary || [];
                parentRowsEl.innerHTML = parentList.length
                    ? parentList.map((p) => `<tr>
                        <td>${escapeHtml(p.name)}</td>
                        <td class="num">${fmtCountR(p.children)}</td>
                        <td class="num">${fmtCountR(p.assessments)}</td>
                        <td>${fmtDateShortPR(p.latestActivity)}</td>
                    </tr>`).join('') + (data.parentSummaryCapped ? '<tr><td colspan="4" class="muted">Showing the most active parents only. Use the Parent filter above to look up a specific one.</td></tr>' : '')
                    : '<tr><td colspan="4" class="muted">No parent has any children on file yet.</td></tr>';
            } catch (err) {
                console.error('patient reports overview error:', err);
                document.getElementById('systemTotalsCards').innerHTML = summaryCard('Could not load', err.message);
            }
        }

        // Score-band chip: the band's colour from constants/scoring.js as a
        // dot beside the label, so the label (not the colour) carries meaning.
        function bandChip(bandKey, label) {
            // STATUS_COLORS directly: colorForBand() falls back to the delayed
            // colour, which would mislabel a row with no band key.
            const color = window.KCScoring ? window.KCScoring.STATUS_COLORS[bandKey] : null;
            const dot = color ? `<span class="band-dot" style="background:${escapeHtml(color)};" aria-hidden="true"></span>` : '';
            return `<span class="band-label">${dot}${escapeHtml(label)}</span>`;
        }

        // Legend for the Status column: every active band, high → low, with
        // its score range. Built from window.KCScoring, the same module the
        // server uses to assign the band, so legend and rows cannot drift.
        function renderPatientBandLegend() {
            const el = document.getElementById('patientBandLegend');
            const KS = window.KCScoring;
            if (!el || !KS) return;
            el.innerHTML = `<span class="band-legend-title">Status legend (latest overall score):</span>`
                + KS.ACTIVE_BANDS.map((b) => `${bandChip(b.key, KS.clinicalLabel(b.key))}<span class="band-range">${b.min}–${b.max}%</span>`).join('');
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

                // Same population for all four cards and the rows below; see
                // the filter policy in services/adminPatientReportsView.js.
                const s = data.summary || {};
                const dated = Boolean(patientFilters.dateFrom || patientFilters.dateTo);
                const inRange = dated ? ' in the date range' : '';
                document.getElementById('patientFilteredSummary').innerHTML = [
                    summaryCard('Patients', fmtCountR(s.patients ?? 0),
                        `Children matching the filters${dated ? '. The date range does not remove patients; it only narrows the other three cards' : ''}.`),
                    summaryCard('Assessments', fmtCountR(s.assessments ?? 0), `Completed assessment sessions of these patients${inRange}.`),
                    summaryCard('Reviewed', fmtCountR(s.reviewed ?? 0),
                        `Of those assessments, with a pediatrician review: ${shareOfText(s.reviewed ?? 0, s.assessments ?? 0, 'assessments')}.`),
                    summaryCard('Latest Activity', fmtDateShortPR(s.latestActivity), `Most recent completion date among these assessments${inRange}.`),
                ].join('');
                renderPatientFilterScope(data.filters);

                const rows = data.rows || [];
                if (!rows.length) {
                    rowsEl.innerHTML = '<tr><td colspan="9" style="padding:2rem;text-align:center;color:var(--text-light);">No reports found for the selected filters.</td></tr>';
                } else {
                    rowsEl.innerHTML = rows.map((r) => `
                        <tr>
                            <td>${escapeHtml(r.childName)}</td>
                            <td>${escapeHtml(r.parentName)}</td>
                            <td>${r.pediatricianName ? escapeHtml(r.pediatricianName) : '<span class="muted">—</span>'}</td>
                            <td class="num">${fmtCountR(r.assessmentsCount)}</td>
                            <td class="num">${r.latestScore != null ? escapeHtml(String(r.latestScore)) + '%' : '<span class="muted">—</span>'}</td>
                            <td>${r.latestStatusLabel ? bandChip(r.latestBand, r.latestStatusLabel) : '<span class="muted">No assessment in range</span>'}</td>
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
                // Don't leave a "Showing: …" line describing figures that failed to load.
                const scopeEl = document.getElementById('patientFilterScope');
                if (scopeEl) scopeEl.textContent = '';
                document.getElementById('patientReportsPageInfo').textContent = '—';
            }
        }

        const SCOPE_LABELS = {
            all: 'All patients',
            assessments: 'Patients with a completed assessment',
            reviewed: 'Patients with a reviewed assessment',
            followup: 'Patients with a follow-up date or recommendation',
        };

        // One line saying exactly which filters produced the cards and rows,
        // from the filters the server echoes back (not from the form).
        function renderPatientFilterScope(echo) {
            const el = document.getElementById('patientFilterScope');
            if (!el) return;
            const f = echo || {};
            const parts = [SCOPE_LABELS[f.scope] || SCOPE_LABELS.all];
            const ped = document.getElementById('prPediatrician');
            if (f.pediatricianId && ped && ped.selectedIndex > 0) parts.push(`Pediatrician: ${ped.options[ped.selectedIndex].text.replace(/\s*\(\d+\)$/, '')}`);
            if (f.parentId) parts.push(`Parent: ${document.getElementById('prParentSearch').value || 'selected'}`);
            if (f.childId) parts.push(`Child: ${document.getElementById('prChildSearch').value || 'selected'}`);
            const dayOf = (iso) => (iso ? iso.slice(0, 10) : null);
            if (f.dateFrom || f.dateTo) {
                parts.push(`Assessments completed ${f.dateFrom ? `from ${dayOf(f.dateFrom)}` : 'up to'} ${f.dateTo ? `${f.dateFrom ? 'to ' : ''}${dayOf(f.dateTo)} (inclusive, UTC dates)` : 'onwards'}`);
            } else {
                parts.push('all dates');
            }
            el.textContent = `Showing: ${parts.join(' · ')}.`;
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
            // Editing the box invalidates the earlier selection (the hidden id
            // was just cleared), so drop the applied filter too — otherwise
            // the list stays filtered by a parent the box no longer shows.
            if (patientFilters.parentId !== 'all') onPatientFilterChange('parentId', 'all');
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
            // Same as the parent box: an edited name no longer matches the
            // applied child filter, so remove it.
            if (patientFilters.childId !== 'all') onPatientFilterChange('childId', 'all');
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
                body.innerHTML = `<p style="color:var(--status-attention-fg, #3d4738);">Could not load this patient's report: ${escapeHtml(err.message)}</p>`;
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
                        <td class="num">${fmtCountR(c[k].total)}</td>
                        <td class="num">${fmtCountR(c[k].synthetic)}</td>
                        <td class="num">${fmtCountR(c[k].real)}</td>
                    </tr>`).join('');
                tbody.innerHTML = rows || '<tr><td colspan="4" class="muted">No demo data recorded.</td></tr>';
            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="4" style="color:var(--status-attention-fg, #3d4738);">Could not load demo data volume: ${escapeHtml(err.message)}</td></tr>`;
            }
        }

        // ================================================================
        // Demographic Profile of Late Development + Most Common Pediatrician
        // Diagnosis — adviser revision.
        //
        // Reuses the EXISTING GET /api/admin-reports/screenings endpoint
        // (routes/admin-reports.js) — no new backend aggregation for the
        // gender/age-range breakdown, which that endpoint already returns as
        // bandByGender.delayed / bandByAgeBand.delayed. diagnosisFrequency IS
        // a new, small, server-computed field on that same endpoint (see
        // routes/admin-reports.js computeDiagnosisMode) — the browser only
        // ever receives the already-grouped, small frequency table, never raw
        // per-assessment diagnosis text.
        //
        // "Late development" here means the "Delayed" band ONLY — see
        // js/admin/admin-reports-interpretations.js header for why that is
        // the deliberate choice, not the broader At-Risk+Delayed grouping.
        // ================================================================

        const GENDER_DISPLAY_LABELS = { male: 'Male', female: 'Female', other: 'Other' };
        const GENDER_UNKNOWN_LABEL = 'Not recorded';
        const AGE_BAND_UNKNOWN_LABEL = 'Age not resolvable';
        const OTHER_DIAGNOSES_DISPLAY_LIMIT = 25;

        function fmtReportDate(iso) {
            if (!iso) return '—';
            const d = new Date(iso);
            return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        }

        /** One .mini-bars set, each row scaled relative to the GROUP's own max (not a global 100).
            `total` (the chart's own sum) adds each row's share; `leaders` tags the most frequent row(s). */
        function renderMiniBars(orderedKeys, counts, labels, total, leaders) {
            const max = Math.max(1, ...orderedKeys.map((k) => counts[k] || 0));
            return `<div class="mini-bars">${orderedKeys.map((k) => {
                const n = counts[k] || 0;
                const pct = Math.round((n / max) * 100);
                const share = total ? ` · ${percentOf(n, total)}` : '';
                const tag = n > 0 && (leaders || []).includes(k) ? ' <span class="mini-bar-tag">most frequent</span>' : '';
                return `
                    <div>
                        <div class="mini-bar-row-label">
                            <span>${escapeHtml(labels[k] || k)}${tag}</span>
                            <span class="mini-bar-count">${fmtCountR(n)} ${n === 1 ? 'case' : 'cases'}${share}</span>
                        </div>
                        <div class="mini-bar-track" role="img" aria-label="${escapeHtml(labels[k] || k)}: ${n} ${n === 1 ? 'case' : 'cases'}" title="${escapeHtml(labels[k] || k)}: ${n} ${n === 1 ? 'assessment' : 'assessments'}"><div class="mini-bar-fill" style="width:${pct}%;"></div></div>
                    </div>`;
            }).join('')}</div>`;
        }

        function renderLateDevelopmentSection(data) {
            const scopeNote = document.getElementById('lateDevelopmentScopeNote');
            const body = document.getElementById('lateDevelopmentBody');
            if (!scopeNote || !body) return;

            const vocab = data.vocabulary || {};
            const unknownKey = vocab.unknownKey || 'unknown';
            const delayedBand = (vocab.bands || []).find((b) => b.key === 'delayed');
            const delayedLabel = delayedBand ? delayedBand.label : 'Delayed';

            scopeNote.textContent = `Based on completed, scored assessments from ${fmtReportDate(data.filters?.from)} to ${fmtReportDate(data.filters?.to)} (this section's own default range; it does not follow the Centralized Patient Reports filters above). "Late development" here means an overall score in the "${delayedLabel}" band only, per KinderCura's existing scoring rules — not a new category. "${delayedLabel}" is a developmental screening category assigned from the score band; it is not a medical diagnosis. Counts are assessments, so a child assessed more than once can be counted more than once.`;

            const genderKeys = [...(vocab.genders || []), unknownKey];
            const genderLabels = { ...GENDER_DISPLAY_LABELS, [unknownKey]: GENDER_UNKNOWN_LABEL };
            const genderCounts = (data.bandByGender && data.bandByGender.delayed) || {};

            const ageKeys = [...(vocab.ageBands || []).map((b) => b.key), unknownKey];
            const ageLabels = Object.fromEntries((vocab.ageBands || []).map((b) => [b.key, b.label]));
            ageLabels[unknownKey] = AGE_BAND_UNKNOWN_LABEL;
            const ageCounts = (data.bandByAgeBand && data.bandByAgeBand.delayed) || {};

            const KI = window.KCAdminReportsInterpretations;
            const genderMode = KI.mostFrequentEntries(genderCounts, genderKeys);
            const ageMode = KI.mostFrequentEntries(ageCounts, ageKeys);

            if (!genderMode.hasData) {
                body.innerHTML = `
                    <p class="muted" style="padding:1rem 0;">
                        No assessments in this range are classified as "${escapeHtml(delayedLabel)}", so a demographic profile cannot be shown yet.
                    </p>`;
                return;
            }

            const genderInterp = KI.formatGenderInterpretation(genderCounts, genderKeys, genderLabels);
            const ageInterp = KI.formatAgeRangeInterpretation(ageCounts, ageKeys, ageLabels);
            const totalsAgree = genderMode.total === ageMode.total;

            body.innerHTML = `
                <p style="margin:0 0 0.4rem;"><strong>${fmtCountR(genderMode.total)}</strong> assessment${genderMode.total === 1 ? '' : 's'} classified as "${escapeHtml(delayedLabel)}", ${escapeHtml(fmtReportDate(data.filters?.from))} – ${escapeHtml(fmtReportDate(data.filters?.to))}.</p>
                ${totalsAgree ? '' : `<p class="pr-notice is-error">The gender chart totals ${fmtCountR(genderMode.total)} and the age chart totals ${fmtCountR(ageMode.total)}, although both count the same "${escapeHtml(delayedLabel)}" assessments. Check the screenings data before relying on either chart.</p>`}
                <p class="muted mini-bars-legend">How to read the bars: each bar is a count of "${escapeHtml(delayedLabel)}" assessments, and its length is relative to the largest group in the same chart (that group fills the bar). The percentage beside each count is that group's share of the chart's total. These are counts, not rates — they are not adjusted for how many children of each gender or age were assessed, so a larger bar does not mean a group is more likely to be delayed.</p>

                <div class="late-dev-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start;">
                    <div>
                        <h4 style="margin:0 0 0.6rem;">Gender Distribution</h4>
                        ${renderMiniBars(genderKeys, genderCounts, genderLabels, genderMode.total, genderMode.leaders)}
                        <div class="report-interp">
                            <p class="report-interp-label">Interpretation</p>
                            <p class="report-interp-text">${escapeHtml(genderInterp)}</p>
                        </div>
                    </div>
                    <div>
                        <h4 style="margin:0 0 0.6rem;">Age Range Distribution <span class="muted" style="font-weight:400;font-size:0.78rem;">(age at assessment)</span></h4>
                        ${renderMiniBars(ageKeys, ageCounts, ageLabels, ageMode.total, ageMode.leaders)}
                        <div class="report-interp">
                            <p class="report-interp-label">Interpretation</p>
                            <p class="report-interp-text">${escapeHtml(ageInterp)}</p>
                        </div>
                    </div>
                </div>`;
        }

        function renderDiagnosisModeSection(data) {
            const scopeNote = document.getElementById('diagnosisScopeNote');
            const body = document.getElementById('diagnosisModeBody');
            if (!scopeNote || !body) return;

            scopeNote.textContent = `Based on completed assessments with a recorded pediatrician diagnosis, from ${fmtReportDate(data.filters?.from)} to ${fmtReportDate(data.filters?.to)} (same default range as the section above; not affected by the Centralized Patient Reports filters). Diagnoses are free text recorded by pediatricians and are separate from the screening bands above. Counts are assessments, not children.`;

            const df = data.diagnosisFrequency || { totalConsidered: 0, rows: [], topCount: 0, topDiagnoses: [], tie: false };
            const KI = window.KCAdminReportsInterpretations;
            const interp = KI.formatDiagnosisInterpretation(df);

            if (!df.rows || !df.rows.length) {
                body.innerHTML = `<p class="muted" style="padding:1rem 0;">${escapeHtml(interp)}</p>`;
                return;
            }

            const topRows = df.rows.filter((r) => df.topDiagnoses.includes(r.diagnosis));
            const otherRowsAll = df.rows.filter((r) => !df.topDiagnoses.includes(r.diagnosis));
            const otherRows = otherRowsAll.slice(0, OTHER_DIAGNOSES_DISPLAY_LIMIT);
            const otherCapped = otherRowsAll.length > OTHER_DIAGNOSES_DISPLAY_LIMIT;

            const topBlock = df.tie
                ? `
                    <h4 style="margin:0 0 0.6rem;">Most Common Diagnoses (tied)</h4>
                    <div class="report-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:1rem;">
                        ${topRows.map((r) => summaryCard(escapeHtml(r.diagnosis), r.count, `${r.count === 1 ? 'recorded assessment' : 'recorded assessments'}`)).join('')}
                    </div>`
                : `
                    <div class="report-grid" style="grid-template-columns:minmax(0,1fr);margin-bottom:1rem;">
                        ${summaryCard('Most Common Diagnosis', escapeHtml(topRows[0].diagnosis), `${fmtCountR(topRows[0].count)} ${topRows[0].count === 1 ? 'recorded assessment' : 'recorded assessments'} (${percentOf(topRows[0].count, df.totalConsidered)} of ${fmtCountR(df.totalConsidered)} with a recorded diagnosis)`)}
                    </div>`;

            const otherTable = otherRows.length
                ? `
                    <h4 style="margin:1rem 0 0.6rem;">Other Recorded Diagnoses</h4>
                    <div style="overflow-x:auto;">
                        <table class="simple-table">
                            <thead><tr><th>Diagnosis</th><th class="num">Recorded Cases</th><th class="num">Share</th></tr></thead>
                            <tbody>${otherRows.map((r) => `<tr><td>${escapeHtml(r.diagnosis)}</td><td class="num">${fmtCountR(r.count)}</td><td class="num">${percentOf(r.count, df.totalConsidered)}</td></tr>`).join('')}</tbody>
                        </table>
                    </div>
                    ${otherCapped ? `<p class="muted" style="margin-top:0.5rem;font-size:0.8rem;">Showing the ${OTHER_DIAGNOSES_DISPLAY_LIMIT} most frequent of ${otherRowsAll.length} other recorded diagnoses.</p>` : ''}`
                : '';

            body.innerHTML = `
                ${topBlock}
                ${otherTable}
                <div class="report-interp">
                    <p class="report-interp-label">Interpretation</p>
                    <p class="report-interp-text">${escapeHtml(interp)}</p>
                </div>`;
        }

        async function loadLateDevelopmentAndDiagnosis() {
            try {
                const data = await apiFetch('/admin-reports/screenings');
                renderLateDevelopmentSection(data);
                renderDiagnosisModeSection(data);
            } catch (err) {
                console.error('late development / diagnosis report error:', err);
                const ldBody = document.getElementById('lateDevelopmentBody');
                const dxBody = document.getElementById('diagnosisModeBody');
                const ldScope = document.getElementById('lateDevelopmentScopeNote');
                const dxScope = document.getElementById('diagnosisScopeNote');
                if (ldBody) ldBody.innerHTML = `<p style="color:var(--status-attention-fg, #3d4738);">Could not load demographic profile: ${escapeHtml(err.message)}</p>`;
                if (dxBody) dxBody.innerHTML = `<p style="color:var(--status-attention-fg, #3d4738);">Could not load diagnosis frequency: ${escapeHtml(err.message)}</p>`;
                if (ldScope) ldScope.textContent = '';
                if (dxScope) dxScope.textContent = '';
            }
        }

        // "How these averages are calculated": every stored result the cards
        // average, and the sum ÷ count behind each card. Fetched the first
        // time the panel opens and kept for the page view; only a failed load
        // is fetched again (Retry, or reopening the panel).
        const AVERAGE_SCORE_DETAIL_TIMEOUT_MS = 20000;
        let averageScoreDetailLoad = null;

        function openAverageScoreDetail() {
            if (!averageScoreDetailLoad) averageScoreDetailLoad = loadAverageScoreDetail();
        }

        function retryAverageScoreDetail() {
            document.getElementById('averageScoreDetailMethod').textContent = 'Loading…';
            document.getElementById('averageScoreCalcRows').innerHTML = '<tr><td colspan="6" class="muted">Loading...</td></tr>';
            document.getElementById('averageScoreRecordRows').innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
            openAverageScoreDetail();
        }

        async function loadAverageScoreDetail() {
            const method = document.getElementById('averageScoreDetailMethod');
            const calcRows = document.getElementById('averageScoreCalcRows');
            const recordRows = document.getElementById('averageScoreRecordRows');
            const recordsNote = document.getElementById('averageScoreRecordsNote');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), AVERAGE_SCORE_DETAIL_TIMEOUT_MS);
            try {
                const detail = await apiFetch('/admin/analytics/average-scores-detail', { signal: controller.signal });
                const cards = (reportCache && reportCache.analytics && reportCache.analytics.averageScores) || {};
                const domains = [
                    ['communication', 'Communication', cards.avgCommunication],
                    ['social', 'Social Skills', cards.avgSocial],
                    ['cognitive', 'Cognitive', cards.avgCognitive],
                    ['motor', 'Motor Skills', cards.avgMotor]
                ];
                method.textContent = `Each card is the mean of the stored domain percentages: sum of every result's stored % for that domain ÷ number of results with a score for that domain, rounded to a whole number. Every result weighs equally — it is not total points earned ÷ total points possible. Each stored % was computed when the assessment was submitted as points earned ÷ points possible × 100, rounded; points themselves are not stored per result, so they are not shown here. Includes all ${fmtCountR(detail.totalResults)} stored assessment results (all dates, ${fmtCountR(detail.distinctChildren)} children); this section has no filters.`;

                if (!detail.totalResults) {
                    calcRows.innerHTML = '<tr><td colspan="6" class="muted">No stored assessment results.</td></tr>';
                    recordRows.innerHTML = '<tr><td colspan="7" class="muted">No stored assessment results.</td></tr>';
                    recordsNote.textContent = '';
                    return;
                }

                calcRows.innerHTML = domains.map(([key, label, card]) => {
                    const d = detail.domains[key];
                    const noScores = Boolean(reportCache && reportCache.noScores);
                    const cardText = noScores ? 'N/A' : card == null ? '—' : `${Math.round(card)}%`;
                    const matches = !noScores && card != null && d.rounded === Math.round(card);
                    const check = noScores ? ' (the card shows N/A while no completed screenings are counted)'
                        : card == null ? '' : matches ? ' ✓' : ' (differs — data changed since the cards loaded; reload the page)';
                    const excluded = d.excluded ? ` <span class="muted">(${fmtCountR(d.excluded)} without a score excluded)</span>` : '';
                    return `<tr><td>${label}</td><td class="num">${fmtCountR(d.included)}${excluded}</td><td class="num">${fmtCountR(d.sum)}</td><td class="num">${d.mean == null ? '—' : `${fmtCountR(d.sum)} ÷ ${fmtCountR(d.included)} = ${d.mean.toFixed(2)}%`}</td><td class="num">${d.rounded == null ? 'N/A' : `${d.rounded}%`}</td><td class="num">${cardText}${check}</td></tr>`;
                }).join('');

                recordsNote.textContent = `The ${fmtCountR(detail.totalResults)} results included, newest first. "Child N" is a reference numbered by each child's first result in this list — not a record ID — so the same child keeps the same number across rows. "—" means no score was stored for that domain, so that result is left out of that domain's average.`;
                const pct = (v) => (v == null ? '—' : `${v}%`);
                recordRows.innerHTML = detail.records.map((r, i) =>
                    `<tr><td class="num">${i + 1}</td><td>${escapeHtml(formatDateTime(r.generatedAt))}</td><td>${escapeHtml(r.childRef)}</td><td class="num">${pct(r.scores.communication)}</td><td class="num">${pct(r.scores.social)}</td><td class="num">${pct(r.scores.cognitive)}</td><td class="num">${pct(r.scores.motor)}</td></tr>`
                ).join('');
            } catch (err) {
                console.error('average score detail load error:', err);
                averageScoreDetailLoad = null;
                const reason = controller.signal.aborted
                    ? `the request took longer than ${AVERAGE_SCORE_DETAIL_TIMEOUT_MS / 1000} seconds`
                    : err.message;
                method.innerHTML = `Could not load the calculation detail: ${escapeHtml(reason)}. <button type="button" class="btn btn-secondary" onclick="retryAverageScoreDetail()">Retry</button>`;
                calcRows.innerHTML = '<tr><td colspan="6" class="muted">Unavailable.</td></tr>';
                recordRows.innerHTML = '<tr><td colspan="7" class="muted">Unavailable.</td></tr>';
                recordsNote.textContent = '';
            } finally {
                clearTimeout(timer);
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            const averageScoreDetail = document.getElementById('averageScoreDetail');
            averageScoreDetail.addEventListener('toggle', () => {
                if (averageScoreDetail.open) openAverageScoreDetail();
            });
            renderPatientBandLegend();
            loadReport();
            loadPatientReportsOverview();
            loadPatientReportsList();
            loadDemoDataVolume();
            loadLateDevelopmentAndDiagnosis();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            // KC.poll: no runs in a hidden tab and never two refreshes at once.
            KC.poll(async () => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                await loadReport();
            }, 30000);
        });
