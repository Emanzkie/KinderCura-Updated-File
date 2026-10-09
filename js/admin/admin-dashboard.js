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
                    <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:#FAFAF6;position:sticky;top:0;z-index:1;">
                        ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:#FAFAF6;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                        <button onclick="clearAllNotifications()" style="border:1px solid #e8a5a5;background:#FAFAF6;color:var(--status-attention-fg);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
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
