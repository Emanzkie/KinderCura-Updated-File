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

        let scoreHistogramChart, domainMonitoringChart, domainTrendChart;

        // Existing domain color convention — reused verbatim from the retired
        // per-domain "Assessment Score Distribution" bar chart so Communication/
        // Social Skills/Cognitive/Motor Skills keep the same color everywhere on
        // this page (Developmental Areas chart AND Trends-over-time chart).
        const DOMAIN_COLORS = { communication: '#6B8E6F', social: '#8BA98D', cognitive: '#F4D89F', motor: '#D4E2D4' };
        const DOMAIN_KEYS = (window.KCAnalyticsInterpretations && window.KCAnalyticsInterpretations.DOMAIN_KEYS) || ['communication', 'social', 'cognitive', 'motor'];
        const DOMAIN_LABELS = (window.KCAnalyticsInterpretations && window.KCAnalyticsInterpretations.DOMAIN_LABELS) || { communication: 'Communication', social: 'Social Skills', cognitive: 'Cognitive', motor: 'Motor Skills' };

        // Score-band color for a histogram bin, straight from constants/scoring.js
        // (window.KCScoring) — the SAME colours used on every other score/result
        // view. rangeStart is the bin's lower edge (0,10,20,...,90).
        function histogramBinColor(rangeStart) {
            if (!window.KCScoring) return '#8BA98D';
            return window.KCScoring.colorForBand(window.KCScoring.bandFor(rangeStart));
        }

        function initCharts() {
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            };

            // Assessment Score Distribution — vertical histogram, 10 bins of 10
            // points each, colour-coded by the existing score band (req 3).
            scoreHistogramChart = new Chart(document.getElementById('scoreHistogramChart'), {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{ label: 'Assessments', data: [], backgroundColor: [] }],
                },
                options: {
                    ...chartOptions,
                    scales: {
                        x: { title: { display: true, text: 'Score range' } },
                        y: { beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: 'Number of assessments' } },
                    },
                },
            });

            // Developmental Areas Requiring Monitoring — one bar per domain,
            // count of stored results in the at-risk/delayed ("Needs Support")
            // range (req 4).
            domainMonitoringChart = new Chart(document.getElementById('domainMonitoringChart'), {
                type: 'bar',
                data: {
                    labels: DOMAIN_KEYS.map((k) => DOMAIN_LABELS[k]),
                    datasets: [{ label: 'Needs-support cases', data: [0, 0, 0, 0], backgroundColor: DOMAIN_KEYS.map((k) => DOMAIN_COLORS[k]) }],
                },
                options: {
                    ...chartOptions,
                    scales: {
                        y: { beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: 'Number of assessments / results' } },
                    },
                },
            });

            // Developmental Monitoring Trends Over Time — one line per domain,
            // month on the X-axis (req 5).
            domainTrendChart = new Chart(document.getElementById('domainTrendChart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: DOMAIN_KEYS.map((k) => ({
                        label: DOMAIN_LABELS[k],
                        data: [],
                        borderColor: DOMAIN_COLORS[k],
                        backgroundColor: DOMAIN_COLORS[k],
                        tension: 0.3,
                        pointRadius: 3,
                        fill: false,
                    })),
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: true, position: 'bottom' } },
                    scales: {
                        y: { beginAtZero: true, ticks: { stepSize: 1 }, title: { display: true, text: 'Needs-support results' } },
                    },
                },
            });
        }

        function updateScoreHistogram(scoreDistribution) {
            const bins = (scoreDistribution && scoreDistribution.bins) || [];
            if (!scoreHistogramChart) return;
            scoreHistogramChart.data.labels = bins.map((b) => b.range);
            scoreHistogramChart.data.datasets[0].data = bins.map((b) => b.count || 0);
            scoreHistogramChart.data.datasets[0].backgroundColor = bins.map((b, i) => histogramBinColor(i * 10));
            scoreHistogramChart.update();

            const interp = window.KCAnalyticsInterpretations
                ? window.KCAnalyticsInterpretations.formatHistogramInterpretation(bins, scoreDistribution.total)
                : '';
            document.getElementById('histogramInterpretation').textContent = interp;
        }

        function updateDomainMonitoring(domainNeedsSupport) {
            const counts = domainNeedsSupport || { communication: 0, social: 0, cognitive: 0, motor: 0, total: 0 };
            if (domainMonitoringChart) {
                domainMonitoringChart.data.datasets[0].data = DOMAIN_KEYS.map((k) => counts[k] || 0);
                domainMonitoringChart.update();
            }
            const interp = window.KCAnalyticsInterpretations
                ? window.KCAnalyticsInterpretations.formatDomainInterpretation(counts)
                : '';
            document.getElementById('domainMonitoringInterpretation').textContent = interp;
        }

        function updateDomainTrend(domainMonthlyTrend) {
            const rows = domainMonthlyTrend || [];
            const wrap = document.getElementById('domainTrendChartWrap');
            const emptyState = document.getElementById('domainTrendEmptyState');

            if (!rows.length) {
                if (wrap) wrap.style.display = 'none';
                if (emptyState) emptyState.hidden = false;
            } else {
                if (wrap) wrap.style.display = '';
                if (emptyState) emptyState.hidden = true;
                if (domainTrendChart) {
                    domainTrendChart.data.labels = rows.map((r) => r.monthLabel);
                    DOMAIN_KEYS.forEach((k, i) => {
                        domainTrendChart.data.datasets[i].data = rows.map((r) => r[k] || 0);
                    });
                    domainTrendChart.update();
                }
            }

            let interp = '';
            if (window.KCAnalyticsInterpretations) {
                if (!rows.length) {
                    interp = 'Not enough completed assessment data is available yet to describe a monitoring trend.';
                } else {
                    const summary = window.KCAnalyticsInterpretations.computeMonitoringSummary(rows);
                    interp = summary.trendText + ' This reflects the distribution of recorded assessment results, not a diagnosis.';
                }
            }
            document.getElementById('domainTrendInterpretation').textContent = interp;
            return rows;
        }

        function updateMonitoringSummary(domainMonthlyTrend) {
            const el = document.getElementById('monitoringSummary');
            if (!el || !window.KCAnalyticsInterpretations) return;
            const summary = window.KCAnalyticsInterpretations.computeMonitoringSummary(domainMonthlyTrend || []);

            if (!summary.hasData) {
                el.innerHTML = `<div class="report-card" style="grid-column:1/-1;"><p class="report-label">Not enough data yet</p><p class="pr-kpi-note" style="margin-top:0.4rem;">${summary.trendText}</p></div>`;
                return;
            }

            const cards = [
                ['Current highest monitoring area', summary.latestLeadLabel],
                ['Latest period', summary.latest.monthLabel],
                [`Needs-support results (${summary.latestLeadLabel}, latest period)`, summary.latestLeadCount],
                ['Total needs-support results, all domains (latest period)', summary.latestTotal],
            ];
            if (summary.hasComparison) {
                cards.push(
                    ['Previous period', summary.previous.monthLabel],
                    ['Previous highest monitoring area', summary.previousLeadLabel],
                );
            }
            el.innerHTML = cards.map(([label, value]) => `
                <div class="report-card"><p class="report-label">${label}</p><p class="report-value" style="font-size:1.3rem;">${value}</p></div>
            `).join('') + `<div class="report-card" style="grid-column:1/-1;"><p class="report-label">Trend</p><p class="pr-kpi-note" style="margin-top:0.4rem;font-size:0.85rem;">${summary.trendText}</p></div>`;
        }

        function updatePediatricianComparison(rows, total, reviewedAssessmentsSystemWide) {
            const noteEl = document.getElementById('pediatricianComparisonNote');
            const capEl = document.getElementById('pediatricianComparisonCapNote');
            const tbody = document.getElementById('pediatricianComparisonTable');
            if (noteEl && window.KCAnalyticsInterpretations) {
                noteEl.textContent = window.KCAnalyticsInterpretations.formatPediatricianComparisonNote(reviewedAssessmentsSystemWide);
            }
            const list = rows || [];
            if (!list.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="muted">No pediatrician has any assigned appointments yet.</td></tr>';
            } else {
                tbody.innerHTML = list.map((p) => `
                    <tr>
                        <td>${p.rank}</td>
                        <td>${escapeHtml(p.name)}</td>
                        <td>${p.relevantChildren}</td>
                        <td>${p.completedAssessments}</td>
                        <td>${p.needsSupportCases}</td>
                        <td>${p.reviewedAssessments}</td>
                        <td>${escapeHtml(window.KCAnalyticsInterpretations ? window.KCAnalyticsInterpretations.formatPediatricianRowInterpretation(p) : '')}</td>
                    </tr>`).join('');
            }
            if (capEl) {
                capEl.textContent = (total || 0) > list.length
                    ? `Showing the top ${list.length} of ${total} pediatricians with assigned appointments, ranked by needs-support cases.`
                    : '';
            }
        }

        // Fixed DISPLAY order only — never touches counts, percentages, or the
        // aggregation query. Both tables' backend rows come straight out of a
        // Mongo $group, whose row order is not guaranteed to stay the same
        // between requests; this pins the presentation order so the table
        // doesn't reshuffle on every refresh.
        const APPOINTMENT_STATUS_ORDER = ['pending', 'approved', 'completed', 'cancelled', 'rejected'];
        const USER_ROLE_ORDER = ['parent', 'pediatrician', 'secretary', 'legal_guardian', 'foster_parent', 'court_appointed', 'admin'];

        // Sorts `items` by where item[keyField] (normalized to lowercase/trimmed)
        // falls in `order`. Anything not found in `order` is kept, appended after
        // every known key, in the order the backend returned it (stable sort) —
        // so an unexpected/future status or role is never silently dropped.
        function sortByFixedOrder(items, order, keyField) {
            const rank = (item) => {
                const key = String(item[keyField] || '').trim().toLowerCase();
                const idx = order.indexOf(key);
                return idx === -1 ? order.length : idx;
            };
            return items.slice().sort((a, b) => rank(a) - rank(b));
        }

        function updateAppointmentTable(appointmentStats) {
            const tbody = document.getElementById('appointmentStatusTable');
            const stats = sortByFixedOrder(appointmentStats || [], APPOINTMENT_STATUS_ORDER, 'status');
            const total = stats.reduce((sum, a) => sum + (a.count || 0), 0);
            if (!stats.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="muted">No appointment data available.</td></tr>';
                return;
            }
            tbody.innerHTML = stats.map((a) => {
                const label = a.status ? (a.status.charAt(0).toUpperCase() + a.status.slice(1)) : 'Unknown';
                const pct = total > 0 ? Math.round(((a.count || 0) / total) * 100) : 0;
                return `<tr><td>${escapeHtml(label)}</td><td>${a.count || 0}</td><td>${pct}%</td></tr>`;
            }).join('');
        }

        function updateRoleTable(roleBreakdown) {
            const tbody = document.getElementById('userRoleTable');
            const roles = sortByFixedOrder(roleBreakdown || [], USER_ROLE_ORDER, 'role');
            const total = roles.reduce((sum, r) => sum + (r.count || 0), 0);
            if (!roles.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="muted">No role data available.</td></tr>';
                return;
            }
            const ROLE_LABELS = {
                parent: 'Parent', legal_guardian: 'Legal Guardian', foster_parent: 'Foster Parent',
                court_appointed: 'Court-Appointed Guardian', pediatrician: 'Pediatrician',
                secretary: 'Secretary', admin: 'Admin',
            };
            tbody.innerHTML = roles.map((r) => {
                const label = ROLE_LABELS[r.role] || (r.role ? (r.role.charAt(0).toUpperCase() + r.role.slice(1)) : 'Unknown');
                const pct = total > 0 ? Math.round(((r.count || 0) / total) * 100) : 0;
                return `<tr><td>${escapeHtml(label)}</td><td>${r.count || 0}</td><td>${pct}%</td></tr>`;
            }).join('');
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

                // Update KPI cards with fallback values.
                // "completedScreenings" is the response field NAME (unchanged,
                // still Assessment.countDocuments({status:'complete'}) — see
                // routes/admin.js); the CARD label now correctly reads
                // "Completed Assessments" to match that definition and stay
                // consistent with Admin Reports.
                document.getElementById('totalUsers').textContent = summary.totalUsers != null ? summary.totalUsers : 0;
                document.getElementById('totalChildren').textContent = summary.totalChildren != null ? summary.totalChildren : 0;
                document.getElementById('activeAppointments').textContent = summary.activeAppointments != null ? summary.activeAppointments : 0;
                document.getElementById('completedScreenings').textContent = summary.completedScreenings != null ? summary.completedScreenings : 0;
                document.getElementById('activeAssessments').textContent = summary.inProgressScreenings != null ? summary.inProgressScreenings : 0;

                // Update average scores section
                const commVal = avg.avgCommunication != null ? avg.avgCommunication : 0;
                const socialVal = avg.avgSocial != null ? avg.avgSocial : 0;
                const cognVal = avg.avgCognitive != null ? avg.avgCognitive : 0;
                const motorVal = avg.avgMotor != null ? avg.avgMotor : 0;

                document.getElementById('avgScores').innerHTML = [
                    { label: DOMAIN_LABELS.communication, val: commVal },
                    { label: DOMAIN_LABELS.social, val: socialVal },
                    { label: DOMAIN_LABELS.cognitive, val: cognVal },
                    { label: DOMAIN_LABELS.motor, val: motorVal }
                ].map(s => `
                    <div style="background:var(--bg-primary);padding:1.2rem;border-radius:8px;text-align:center;">
                        <p style="font-size:0.9rem;color:var(--text-light);margin-bottom:0.5rem;">${s.label}</p>
                        <p style="font-size:2rem;font-weight:700;color:var(--primary);">${s.val}%</p>
                    </div>`).join('');

                // Update the assessment-monitoring sections.
                updateScoreHistogram(response.scoreDistribution);
                updateDomainMonitoring(response.domainNeedsSupport);
                updateDomainTrend(response.domainMonthlyTrend);
                updateMonitoringSummary(response.domainMonthlyTrend);
                updatePediatricianComparison(response.pediatricianComparison, response.pediatricianComparisonTotal, response.reviewedAssessmentsSystemWide);
                updateAppointmentTable(apptStats);
                updateRoleTable(roles);

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
                document.getElementById('activeAssessments').textContent = '0';
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
