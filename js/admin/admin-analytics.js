// === Extracted from ADMIN\admin-analytics.html (script block 1) ===
requireAuth();
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

        let monthlyChart, scoresChart, apptChart, roleChart;

        function initCharts() {
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            };

            monthlyChart = new Chart(document.getElementById('monthlyChart'), {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: '#6B8E6F', backgroundColor: 'rgba(107,142,111,0.1)', fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#6B8E6F' }] },
                options: { ...chartOptions, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
            });

            scoresChart = new Chart(document.getElementById('scoresChart'), {
                type: 'bar',
                data: { labels: ['Communication', 'Social', 'Cognitive', 'Motor'], datasets: [{ data: [0,0,0,0], backgroundColor: ['#6B8E6F','#8BA98D','#F4D89F','#D4E2D4'] }] },
                options: { ...chartOptions, indexAxis: 'y', scales: { x: { beginAtZero: true, max: 100 } } }
            });

            apptChart = new Chart(document.getElementById('apptChart'), {
                type: 'pie',
                data: { labels: [], datasets: [{ data: [], backgroundColor: ['#F4D89F','#6B8E6F','#8BA98D','#e74c3c'] }] },
                options: { ...chartOptions, plugins: { legend: { position: 'bottom', display: true } } }
            });

            roleChart = new Chart(document.getElementById('roleChart'), {
                type: 'doughnut',
                data: { labels: [], datasets: [{ data: [], backgroundColor: ['#6B8E6F','#8BA98D','#e74c3c','#D4E2D4'] }] },
                options: { ...chartOptions, plugins: { legend: { position: 'bottom', display: true } } }
            });
        }

        function updateCharts(data) {
            if (!data) return;

            // Update monthly signups line chart
            if (monthlyChart) {
                const monthly = data.monthlySignups || [];
                monthlyChart.data.labels = monthly.map(m => m.month);
                monthlyChart.data.datasets[0].data = monthly.map(m => m.count);
                monthlyChart.update();
            }

            // Update assessment scores bar chart
            if (scoresChart) {
                const avg = data.averageScores || {};
                scoresChart.data.datasets[0].data = [
                    avg.avgCommunication || 0,
                    avg.avgSocial || 0,
                    avg.avgCognitive || 0,
                    avg.avgMotor || 0
                ];
                scoresChart.update();
            }

            // Update appointment status pie chart
            if (apptChart) {
                const appt = data.appointmentStats || [];
                apptChart.data.labels = appt.map(a => a.status ? (a.status.charAt(0).toUpperCase() + a.status.slice(1)) : 'Unknown');
                apptChart.data.datasets[0].data = appt.map(a => a.count || 0);
                apptChart.update();
            }

            // Update role distribution doughnut chart
            if (roleChart) {
                const roles = data.roleBreakdown || [];
                roleChart.data.labels = roles.map(r => r.role ? (r.role.charAt(0).toUpperCase() + r.role.slice(1)) : 'Unknown');
                roleChart.data.datasets[0].data = roles.map(r => r.count || 0);
                roleChart.update();
            }
        }

        async function loadAnalytics() {
            try {
                const response = await apiFetch('/admin/analytics');
                console.log('[Analytics] Full Response:', response);

                // Validate response structure
                if (!response || response.success !== true) {
                    throw new Error('Invalid API response');
                }

                // Extract data with explicit fallbacks
                const summary = response.summaryTotals || {};
                const avg = response.averageScores || {};
                const monthly = response.monthlySignups || [];
                const apptStats = response.appointmentStats || [];
                const roles = response.roleBreakdown || [];

                // Update KPI cards with fallback values
                document.getElementById('totalUsers').textContent = summary.totalUsers != null ? summary.totalUsers : 0;
                document.getElementById('totalChildren').textContent = summary.totalChildren != null ? summary.totalChildren : 0;
                document.getElementById('activeAppointments').textContent = summary.activeAppointments != null ? summary.activeAppointments : 0;
                document.getElementById('completedScreenings').textContent = summary.completedScreenings != null ? summary.completedScreenings : 0;

                // Update average scores section
                const commVal = avg.avgCommunication != null ? avg.avgCommunication : 0;
                const socialVal = avg.avgSocial != null ? avg.avgSocial : 0;
                const cognVal = avg.avgCognitive != null ? avg.avgCognitive : 0;
                const motorVal = avg.avgMotor != null ? avg.avgMotor : 0;

                document.getElementById('avgScores').innerHTML = [
                    { label:'Communication', val: commVal },
                    { label:'Social', val: socialVal },
                    { label:'Cognitive', val: cognVal },
                    { label:'Motor', val: motorVal }
                ].map(s => `
                    <div style="background:var(--bg-primary);padding:1.2rem;border-radius:8px;text-align:center;">
                        <p style="font-size:0.9rem;color:var(--text-light);margin-bottom:0.5rem;">${s.label}</p>
                        <p style="font-size:2rem;font-weight:700;color:var(--primary);">${s.val}%</p>
                    </div>`).join('');

                // Update charts
                updateCharts({
                    averageScores: avg,
                    monthlySignups: monthly,
                    appointmentStats: apptStats,
                    roleBreakdown: roles
                });

                // Calculate growth rate
                const totalRecent = monthly.reduce((sum, m) => sum + m.count, 0);
                const growthRate = monthly.length >= 2 && monthly[monthly.length-2].count > 0
                    ? Math.round(((monthly[monthly.length-1].count - monthly[monthly.length-2].count) / monthly[monthly.length-2].count) * 100)
                    : (totalRecent > 0 ? 100 : 0);
                document.getElementById('growthRate').textContent = (growthRate >= 0 ? '+' : '') + growthRate + '%';
                document.getElementById('growthRate').className = 'value ' + (growthRate >= 0 ? 'green' : 'orange');

                // Completion rate
                const completionRate = summary.totalAssessments > 0
                    ? Math.round((summary.completedScreenings / summary.totalAssessments) * 100)
                    : 0;
                document.getElementById('completionRate').textContent = completionRate + '%';

                // Pending appointments.
                // This used to be (totalAppointments - completed), which counted
                // approved and rejected bookings as "pending" — the tile read 9
                // when the database held 8 approved, 1 rejected and 0 pending.
                // apptStats is already grouped by status, so read it directly.
                const pendingAppt = apptStats
                    .filter(a => String(a.status).toLowerCase() === 'pending')
                    .reduce((sum, a) => sum + (a.count || 0), 0);
                document.getElementById('pendingRate').textContent = pendingAppt;

                document.getElementById('lastUpdated').textContent = 'Updated: ' + new Date().toLocaleTimeString();

            } catch (e) {
                console.error('[Analytics] Load error:', e);
                const errorMsg = 'Error: ' + e.message;
                document.getElementById('totalUsers').textContent = '0';
                document.getElementById('totalChildren').textContent = '0';
                document.getElementById('activeAppointments').textContent = '0';
                document.getElementById('completedScreenings').textContent = '0';
                document.getElementById('avgScores').innerHTML = '<p style="color:red;text-align:center;">' + errorMsg + '</p>';
                document.getElementById('lastUpdated').textContent = 'Update failed';
            }
        }

        let eventSource = null;

        function initSSE() {
            if (eventSource) return;
            eventSource = new EventSource('/api/admin/sse');
            eventSource.addEventListener('analytics:update', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    console.log('[SSE] Analytics update received:', data);
                    loadAnalytics();
                } catch (err) {
                    console.error('[SSE] Parse error:', err);
                }
            });
            eventSource.onerror = () => {
                console.log('[SSE] Connection lost, reconnecting...');
                eventSource.close();
                eventSource = null;
                setTimeout(initSSE, 5000);
            };
        }

        document.addEventListener('DOMContentLoaded', () => {
            // Small delay to ensure canvas elements are in DOM
            setTimeout(() => {
                initCharts();
                loadAnalytics();
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                initSSE();
            }, 100);
            
            // Auto-refresh every 5 seconds
            setInterval(() => {
                loadAnalytics();
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
            }, 5000);
        });
