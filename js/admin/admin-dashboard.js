// === Extracted from ADMIN\admin-dashboard.html (script block 1) ===
// Require login before this page can load
        requireAuth();
        // Admin-only page guard
        const _u = KC.user();
        if (_u && _u.role !== 'admin') window.location.href = '/parent/dashboard.html';

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

        // Counts and shares come from js/admin/admin-dashboard-metrics.js, which
        // documents the exact query behind every field of GET /api/admin/dashboard.
        const M = window.KCAdminDashboardMetrics;
        let dashboardLoadedAt = null;

        function setText(id, value) {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        }

        function setDashStatus(message, isError) {
            const box = document.getElementById('dashStatus');
            const retry = document.getElementById('dashRetry');
            setText('dashStatusText', message);
            if (box) box.classList.toggle('is-error', Boolean(isError));
            if (retry) retry.hidden = !isError;
        }

        function formatClock(date) {
            return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }

        function renderUserDistribution(data) {
            // Row keys double as the element id prefixes (parentCount, parentShare, …).
            const dist = M.buildUserDistribution(data);
            dist.rows.forEach((row) => {
                setText(`${row.key}Count`, M.formatCount(row.count));
                let shareText = `${M.formatShare(row.share)} of all users`;
                if (row.share == null) {
                    if (dist.total == null) shareText = 'Share: N/A (total unavailable)';
                    else if (dist.total === 0) shareText = 'Share: N/A (no users yet)';
                    else shareText = 'Share: N/A (count unavailable)';
                }
                setText(`${row.key}Share`, shareText);
            });
        }

        function renderAssessmentBreakdown(data) {
            const caption = document.getElementById('assessmentBreakdownCaption');
            const bar = document.getElementById('assessmentBreakdownBar');
            const legend = document.getElementById('assessmentBreakdownLegend');
            if (!caption || !bar || !legend) return;

            const breakdown = M.buildAssessmentBreakdown(data);
            if (!breakdown.available) {
                caption.textContent = 'The status breakdown is unavailable because one of its counts did not load.';
                bar.innerHTML = '';
                bar.setAttribute('aria-label', 'Assessment sessions by status: unavailable');
                legend.innerHTML = '';
                return;
            }
            if (breakdown.total === 0) {
                caption.textContent = 'No assessment sessions have been started yet, so there is nothing to break down.';
                bar.innerHTML = '';
                bar.setAttribute('aria-label', 'Assessment sessions by status: no sessions yet');
                legend.innerHTML = '';
                return;
            }

            caption.textContent = `All ${M.formatCount(breakdown.total)} assessment sessions ever started. `
                + 'Each % = sessions in that status ÷ all sessions. One child can have several sessions.';

            const notes = {
                complete: 'Marked complete; same as Completed Assessments above',
                submitted: 'Answers sent, result not yet generated; not in either card above',
                inProgress: 'Started, not yet submitted; same as In-Progress Assessments above',
            };

            bar.innerHTML = breakdown.segments
                .filter((s) => s.count > 0)
                .map((s) => `<span class="breakdown-segment seg-${s.key}" style="flex:${s.count} 1 0"></span>`)
                .join('');
            bar.setAttribute('aria-label', 'Assessment sessions by status: ' + breakdown.segments
                .map((s) => `${s.label} ${M.formatCount(s.count)} (${M.formatShare(s.share)})`).join(', '));

            legend.innerHTML = breakdown.segments.map((s) => `
                <li>
                    <span class="legend-swatch seg-${s.key}" aria-hidden="true"></span>
                    <span class="legend-label">${escapeHtml(s.label)}<small>${escapeHtml(notes[s.key])}</small></span>
                    <span class="legend-value">${M.formatCount(s.count)} · ${M.formatShare(s.share)}</span>
                </li>`).join('');
        }

        function renderRecentActivity(acts) {
            const el = document.getElementById('recentActivity');
            if (!el) return;
            el.innerHTML = acts.length
                ? acts.map(a => `<div style="padding:1rem;background:var(--bg-primary);border-radius:8px;border-left:4px solid var(--primary);"><p style="font-weight:600;margin-bottom:0.3rem;">${escapeHtml(a.type)}</p><p style="color:var(--text-light);font-size:0.9rem;">${escapeHtml(a.description)}</p><p style="color:var(--text-light);font-size:0.8rem;margin-top:0.5rem;">${escapeHtml(a.timestamp)}</p></div>`).join('')
                : '<p style="text-align:center;color:var(--text-light);">No recent activity</p>';
        }

        async function loadDashboardData() {
            let data;
            try {
                data = await apiFetch('/admin/dashboard');
            } catch (e) {
                console.error(e);
                if (dashboardLoadedAt) {
                    // Keep the last good numbers on screen, but say they are stale.
                    setDashStatus(`Could not refresh the statistics. Showing values from ${formatClock(dashboardLoadedAt)}.`, true);
                } else {
                    setDashStatus('Could not load the dashboard statistics. Check your connection and try again.', true);
                    setText('assessmentBreakdownCaption', 'Unavailable: the dashboard statistics did not load.');
                    const actEl = document.getElementById('recentActivity');
                    if (actEl) actEl.innerHTML = '<p style="text-align:center;color:var(--text-light);">Could not load recent activity.</p>';
                }
                return;
            }

            setText('totalUsers', M.formatCount(M.toCount(data.totalUsers)));
            setText('activeAssessments', M.formatCount(M.toCount(data.activeAssessments)));
            setText('completedAssessments', M.formatCount(M.toCount(data.completedAssessments)));
            // The API's `uptime` field is a fixed '99.9%' string in routes/admin.js,
            // not a measurement, so it is deliberately not displayed here.
            setText('uptime', 'Not measured');
            setText('childCount', M.formatCount(M.toCount(data.childCount)));
            renderUserDistribution(data);
            renderAssessmentBreakdown(data);
            renderRecentActivity(Array.isArray(data.recentActivity) ? data.recentActivity : []);

            dashboardLoadedAt = new Date();
            setDashStatus(`All figures are all-time totals. Updated ${formatClock(dashboardLoadedAt)}; refreshes every 30 seconds.`, false);
        }

        async function exportData() {
            try {
                await downloadWithAuth('/admin/export-data', 'admin-export.json');
            } catch (e) {
                alert('Export failed: ' + e.message);
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            const retry = document.getElementById('dashRetry');
            if (retry) retry.addEventListener('click', () => {
                setDashStatus('Loading dashboard statistics…', false);
                loadDashboardData();
            });
            loadDashboardData();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                loadDashboardData();
            }, 30000);
        });
