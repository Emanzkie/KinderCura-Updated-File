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

        // Builds one summary card at the top of the report page.
        function summaryCard(label, value) {
            return `<div class="report-card"><p class="report-label">${label}</p><p class="report-value">${value}</p></div>`;
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
                const monthlySignups = analytics.monthlySignups || [];
                const averageScores = analytics.averageScores || {};
                const totalAppointments = appointmentStats.reduce((sum, item) => sum + (item.count || 0), 0);
                const totalRoles = roleBreakdown.reduce((sum, item) => sum + (item.count || 0), 0);
                const pendingCount = (pendingUsers.users || []).length;

                reportCache = {
                    generatedAt: new Date().toISOString(),
                    dashboard,
                    analytics,
                    pendingCount,
                    totalAppointments
                };

                document.getElementById('reportGeneratedAt').textContent = `Generated: ${new Date(reportCache.generatedAt).toLocaleString()}`;

                // Top summary cards for the most important report numbers.
                document.getElementById('summaryCards').innerHTML = [
                    summaryCard('Total Users', dashboard.totalUsers ?? 0),
                    summaryCard('Total Children', dashboard.childCount ?? 0),
                    summaryCard('Completed Screenings', dashboard.completedScreenings ?? 0),
                    summaryCard('Active Assessments', dashboard.activeAssessments ?? 0),
                    summaryCard('Total Appointments', totalAppointments),
                    summaryCard('Pending Approvals', pendingCount)
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

                const maxSignup = Math.max(...monthlySignups.map(item => item.count || 0), 1);
                document.getElementById('signupBars').innerHTML = monthlySignups.length
                    ? monthlySignups.map(item => `
                        <div>
                            <div style="display:flex;justify-content:space-between;gap:1rem;margin-bottom:0.35rem;">
                                <strong>${item.month}</strong>
                                <span class="muted">${item.count} signup${item.count === 1 ? '' : 's'}</span>
                            </div>
                            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${Math.max(8, Math.round(((item.count || 0) / maxSignup) * 100))}%;"></div></div>
                        </div>`).join('')
                    : '<p class="muted">No signup data available.</p>';

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
                    ? roleBreakdown.map(item => row(item.role, item.count || 0, totalRoles)).join('')
                    : '<tr><td colspan="3" class="muted">No role data available.</td></tr>';

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
        function exportReportJson() {
            if (!reportCache) {
                alert('Please wait for the report to finish loading first.');
                return;
            }
            const blob = new Blob([JSON.stringify(reportCache, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'kindercura-admin-report.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadReport();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                refreshReport();
            }, 30000);
        });
