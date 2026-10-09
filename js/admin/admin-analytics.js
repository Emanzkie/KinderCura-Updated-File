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

        // Pure helpers (shares, % formatting, month handling) — see
        // js/admin/analytics-interpretations.js; covered by its unit test.
        const KCI = window.KCAnalyticsInterpretations;

        // Existing domain color convention — reused verbatim from the retired
        // per-domain "Assessment Score Distribution" bar chart so Communication/
        // Social Skills/Cognitive/Motor Skills keep the same color everywhere on
        // this page (Developmental Areas chart AND Trends-over-time chart).
        const DOMAIN_COLORS = { communication: '#6B8E6F', social: '#8BA98D', cognitive: '#F4D89F', motor: '#D4E2D4' };
        const DOMAIN_KEYS = (KCI && KCI.DOMAIN_KEYS) || ['communication', 'social', 'cognitive', 'motor'];
        const DOMAIN_LABELS = (KCI && KCI.DOMAIN_LABELS) || { communication: 'Communication', social: 'Social Skills', cognitive: 'Cognitive', motor: 'Motor Skills' };

        // Latest values the chart tooltips read, so a hover shows the same
        // denominator the legend and interpretation text use.
        let histogramTotal = 0;
        let domainTotal = 0;
        let trendRows = [];
        let analyticsLoadedAt = null;

        // Score-band color for a histogram bin, straight from constants/scoring.js
        // (window.KCScoring) — the SAME colours used on every other score/result
        // view. rangeStart is the bin's lower edge (0,10,20,...,90).
        function histogramBinColor(rangeStart) {
            if (!window.KCScoring) return '#8BA98D';
            return window.KCScoring.colorForBand(window.KCScoring.bandFor(rangeStart));
        }

        // The month the server is still filling. domainMonthlyTrend is keyed by
        // the UTC month of completedAt ($dateToString defaults to UTC), so the
        // comparison is made in UTC too, whatever the viewer's timezone.
        function currentUtcMonthKey() {
            return new Date().toISOString().slice(0, 7);
        }

        function renderLegend(listEl, items) {
            if (!listEl) return;
            listEl.innerHTML = items.map((item) => `
                <li>
                    <span class="legend-swatch" style="background:${item.color};" aria-hidden="true"></span>
                    <span>${escapeHtml(item.label)}</span>
                    <span class="legend-value">${escapeHtml(item.value)}</span>
                </li>`).join('');
        }

        function initCharts() {
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            };

            // Assessment Score Distribution — vertical histogram, 10 bins of 10
            // points each, colour-coded by the existing score band (req 3). The
            // band legend is HTML (#scoreBandLegend): Chart.js would only show
            // one swatch for this single dataset.
            scoreHistogramChart = new Chart(document.getElementById('scoreHistogramChart'), {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [{ label: 'Completed assessments', data: [], backgroundColor: [] }],
                },
                options: {
                    ...chartOptions,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: (items) => `Overall score ${items[0].label}`,
                                label: (ctx) => `${KCI.formatCount(ctx.parsed.y)} completed assessments (${KCI.formatPercent(KCI.sharePercent(ctx.parsed.y, histogramTotal))} of ${KCI.formatCount(histogramTotal)})`,
                            },
                        },
                    },
                    scales: {
                        x: { title: { display: true, text: 'Overall assessment score range (0–100)' } },
                        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Number of completed assessments' } },
                    },
                },
            });

            // Developmental Areas Requiring Monitoring — one bar per domain,
            // count of stored results in the at-risk/delayed ("Needs Support")
            // range (req 4). Domains are named on the x-axis and in the HTML
            // legend (#domainMonitoringLegend) with their counts and shares.
            domainMonitoringChart = new Chart(document.getElementById('domainMonitoringChart'), {
                type: 'bar',
                data: {
                    labels: DOMAIN_KEYS.map((k) => DOMAIN_LABELS[k]),
                    datasets: [{ label: 'Completed assessments with a needs-support result', data: [0, 0, 0, 0], backgroundColor: DOMAIN_KEYS.map((k) => DOMAIN_COLORS[k]) }],
                },
                options: {
                    ...chartOptions,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${KCI.formatCount(ctx.parsed.y)} of ${KCI.formatCount(domainTotal)} completed assessments (${KCI.formatPercent(KCI.sharePercent(ctx.parsed.y, domainTotal))}) in the needs-support range`,
                            },
                        },
                    },
                    scales: {
                        x: { title: { display: true, text: 'Developmental domain' } },
                        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Completed assessments (needs support)' } },
                    },
                },
            });

            // Developmental Monitoring Trends Over Time — one line per domain,
            // month on the X-axis (req 5). Straight segments (tension 0): a
            // smoothed curve draws values between months that do not exist.
            // The segment into the current, unfinished month is dashed.
            domainTrendChart = new Chart(document.getElementById('domainTrendChart'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: DOMAIN_KEYS.map((k) => ({
                        label: DOMAIN_LABELS[k],
                        data: [],
                        borderColor: DOMAIN_COLORS[k],
                        backgroundColor: DOMAIN_COLORS[k],
                        tension: 0,
                        pointRadius: 3,
                        fill: false,
                        segment: {
                            borderDash: (ctx) => (trendRows[ctx.p1DataIndex] && trendRows[ctx.p1DataIndex].isPartial ? [6, 4] : undefined),
                        },
                    })),
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: true, position: 'bottom' },
                        tooltip: {
                            callbacks: {
                                title: (items) => {
                                    const row = trendRows[items[0].dataIndex];
                                    if (!row) return items[0].label;
                                    return `${row.monthLabel}${row.isPartial ? ' (month in progress)' : ''}: ${KCI.formatCount(row.totalAssessments)} completed assessments`;
                                },
                                label: (ctx) => {
                                    const row = trendRows[ctx.dataIndex];
                                    const total = row ? row.totalAssessments : null;
                                    return `${ctx.dataset.label}: ${KCI.formatCount(ctx.parsed.y)} needs support (${KCI.formatPercent(KCI.sharePercent(ctx.parsed.y, total))})`;
                                },
                            },
                        },
                    },
                    scales: {
                        x: { title: { display: true, text: 'Month assessment was completed (UTC)' } },
                        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Completed assessments (needs support)' } },
                    },
                },
            });
        }

        function updateScoreHistogram(scoreDistribution) {
            const bins = (scoreDistribution && scoreDistribution.bins) || [];
            histogramTotal = scoreDistribution && KCI.isCount(scoreDistribution.total)
                ? scoreDistribution.total
                : bins.reduce((sum, b) => sum + (b.count || 0), 0);
            if (scoreHistogramChart) {
                scoreHistogramChart.data.labels = bins.map((b) => b.range);
                scoreHistogramChart.data.datasets[0].data = bins.map((b) => b.count || 0);
                scoreHistogramChart.data.datasets[0].backgroundColor = bins.map((b, i) => histogramBinColor(i * 10));
                scoreHistogramChart.update();
            }

            // Band legend: each band's colour, label, score range, and how many
            // of the plotted assessments fall in it.
            const S = window.KCScoring;
            const bands = S && S.ACTIVE_BANDS
                ? S.ACTIVE_BANDS.map((b) => ({ key: b.key, min: b.min, max: b.max, label: S.clinicalLabel(b.key) }))
                : [];
            renderLegend(document.getElementById('scoreBandLegend'), histogramTotal > 0
                ? KCI.summarizeScoreBands(bins, bands).map((b) => ({
                    color: S.colorForBand(b.key),
                    label: `${b.label} (${b.min}–${b.max})`,
                    value: `${KCI.formatCount(b.count)} · ${KCI.formatPercent(b.share)}`,
                }))
                : []);

            document.getElementById('histogramInterpretation').textContent =
                KCI.formatHistogramInterpretation(bins, scoreDistribution ? scoreDistribution.total : undefined);
        }

        function updateDomainMonitoring(domainNeedsSupport) {
            const counts = domainNeedsSupport || { communication: 0, social: 0, cognitive: 0, motor: 0, total: 0 };
            domainTotal = KCI.isCount(counts.total) ? counts.total : 0;
            if (domainMonitoringChart) {
                domainMonitoringChart.data.datasets[0].data = DOMAIN_KEYS.map((k) => counts[k] || 0);
                domainMonitoringChart.update();
            }
            renderLegend(document.getElementById('domainMonitoringLegend'), domainTotal > 0
                ? DOMAIN_KEYS.map((k) => ({
                    color: DOMAIN_COLORS[k],
                    label: DOMAIN_LABELS[k],
                    value: `${KCI.formatCount(counts[k] || 0)} of ${KCI.formatCount(domainTotal)} · ${KCI.formatPercent(KCI.sharePercent(counts[k] || 0, domainTotal))}`,
                }))
                : []);
            document.getElementById('domainMonitoringInterpretation').textContent = KCI.formatDomainInterpretation(counts);
        }

        function updateDomainTrend(domainMonthlyTrend) {
            const prepared = KCI.prepareMonthlyTrend(domainMonthlyTrend, currentUtcMonthKey());
            const rows = prepared.rows;
            const wrap = document.getElementById('domainTrendChartWrap');
            const emptyState = document.getElementById('domainTrendEmptyState');
            trendRows = rows;

            if (!rows.length) {
                if (wrap) wrap.style.display = 'none';
                if (emptyState) emptyState.hidden = false;
            } else {
                if (wrap) wrap.style.display = '';
                if (emptyState) emptyState.hidden = true;
                if (domainTrendChart) {
                    domainTrendChart.data.labels = rows.map((r) => (r.isPartial ? `${r.monthLabel} (to date)` : r.monthLabel));
                    DOMAIN_KEYS.forEach((k, i) => {
                        domainTrendChart.data.datasets[i].data = rows.map((r) => r[k] || 0);
                    });
                    domainTrendChart.update();
                }
            }

            // The month-over-month comparison uses full months only.
            let interp;
            if (!rows.length) {
                interp = 'Not enough completed assessment data is available yet to describe a monitoring trend.';
            } else {
                const summary = KCI.computeMonitoringSummary(prepared.completeRows);
                interp = `${summary.trendText} This reflects the distribution of recorded assessment results, not a diagnosis.`;
                if (prepared.partialRow) {
                    interp += ` ${prepared.partialRow.monthLabel} is still in progress (${KCI.formatCount(prepared.partialRow.totalAssessments)} completed assessments so far), so it is drawn dashed and left out of the comparison.`;
                }
            }
            document.getElementById('domainTrendInterpretation').textContent = interp;
            return prepared;
        }

        function updateMonitoringSummary(prepared) {
            const el = document.getElementById('monitoringSummary');
            if (!el) return;
            const summary = KCI.computeMonitoringSummary(prepared.completeRows);
            const partial = prepared.partialRow;
            const card = (label, value) => `
                <div class="report-card"><p class="report-label">${escapeHtml(label)}</p><p class="report-value" style="font-size:1.3rem;">${escapeHtml(value)}</p></div>`;
            const partialCard = partial
                ? card(`${partial.monthLabel} so far (month in progress, not compared)`, `${KCI.formatCount(partial.totalAssessments)} completed assessments`)
                : '';

            if (!summary.hasData) {
                el.innerHTML = `<div class="report-card" style="grid-column:1/-1;"><p class="report-label">Not enough full-month data yet</p><p class="pr-kpi-note" style="margin-top:0.4rem;">${escapeHtml(summary.trendText)}</p></div>${partialCard}`;
                return;
            }

            const month = summary.latest.monthLabel;
            const tiedLeaders = KCI.leadingDomainForMonth(summary.latest).leaders.length > 1;
            const cards = [
                ['Latest full month', month],
                [`Highest monitoring area (${month})`, summary.latestLeadLabel],
                [`Completed assessments (${month})`, KCI.formatCount(summary.latest.totalAssessments)],
                [`Needs-support results in ${summary.latestLeadLabel}${tiedLeaders ? ', each' : ''} (${month})`, KCI.formatCount(summary.latestLeadCount)],
                [`Needs-support results, all four domains added together (${month}); one assessment can add up to four`, KCI.formatCount(summary.latestTotal)],
            ];
            if (summary.hasComparison) {
                cards.push(
                    ['Month before', summary.previous.monthLabel],
                    [`Highest monitoring area (${summary.previous.monthLabel})`, summary.previousLeadLabel],
                );
            }
            el.innerHTML = cards.map(([label, value]) => card(label, value)).join('')
                + partialCard
                + `<div class="report-card" style="grid-column:1/-1;"><p class="report-label">Trend (full months only)</p><p class="pr-kpi-note" style="margin-top:0.4rem;font-size:0.85rem;">${escapeHtml(summary.trendText)}</p></div>`;
        }

        function updatePediatricianComparison(rows, total, reviewedAssessmentsSystemWide) {
            const noteEl = document.getElementById('pediatricianComparisonNote');
            const capEl = document.getElementById('pediatricianComparisonCapNote');
            const tbody = document.getElementById('pediatricianComparisonTable');
            if (noteEl) {
                noteEl.textContent = KCI.formatPediatricianComparisonNote(reviewedAssessmentsSystemWide);
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
                        <td>${escapeHtml(KCI.formatPediatricianRowInterpretation(p))}</td>
                    </tr>`).join('');
            }
            if (capEl) {
                capEl.textContent = (total || 0) > list.length
                    ? `Showing the first ${list.length} of ${total} pediatricians with appointments, in order of needs-support cases.`
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

        // Every share in a table uses ONE denominator: the sum of that table's
        // rows, which is shown as the table's total row.
        function renderShareTable(tbody, tfoot, rows, labelFor, totalLabel, emptyText) {
            const { total, rows: withShare } = KCI.withShares(rows);
            if (!withShare.length) {
                tbody.innerHTML = `<tr><td colspan="3" class="muted">${escapeHtml(emptyText)}</td></tr>`;
                if (tfoot) tfoot.innerHTML = '';
                return total;
            }
            tbody.innerHTML = withShare.map((r) =>
                `<tr><td>${escapeHtml(labelFor(r))}</td><td>${KCI.formatCount(r.count || 0)}</td><td>${KCI.formatPercent(r.share)}</td></tr>`
            ).join('');
            if (tfoot) {
                tfoot.innerHTML = `<tr><td>${escapeHtml(totalLabel)}</td><td>${KCI.formatCount(total)}</td><td>${total > 0 ? '100%' : 'N/A'}</td></tr>`;
            }
            return total;
        }

        function updateAppointmentTable(appointmentStats) {
            const stats = sortByFixedOrder(appointmentStats || [], APPOINTMENT_STATUS_ORDER, 'status');
            const total = renderShareTable(
                document.getElementById('appointmentStatusTable'),
                document.getElementById('appointmentStatusTotal'),
                stats,
                (a) => (a.status ? (a.status.charAt(0).toUpperCase() + a.status.slice(1)) : 'No status recorded'),
                'All appointments',
                'No appointment data available.'
            );
            document.getElementById('appointmentStatusNote').textContent =
                `Share = appointments in that status ÷ all ${KCI.formatCount(total)} appointments, every status including cancelled and rejected, all dates. Active Appointments above = Pending + Approved.`;
        }

        function updateRoleTable(roleBreakdown, totalUsers) {
            const ROLE_LABELS = {
                parent: 'Parent', legal_guardian: 'Legal Guardian', foster_parent: 'Foster Parent',
                court_appointed: 'Court-Appointed Guardian', pediatrician: 'Pediatrician',
                secretary: 'Secretary', admin: 'Admin',
            };
            const roles = sortByFixedOrder(roleBreakdown || [], USER_ROLE_ORDER, 'role');
            const total = renderShareTable(
                document.getElementById('userRoleTable'),
                document.getElementById('userRoleTotal'),
                roles,
                (r) => ROLE_LABELS[r.role] || (r.role ? (r.role.charAt(0).toUpperCase() + r.role.slice(1)) : 'Unknown'),
                'All user accounts',
                'No role data available.'
            );
            let note = `Share = accounts with that role ÷ all ${KCI.formatCount(total)} user accounts with a role (active, pending and suspended).`;
            if (KCI.isCount(totalUsers) && totalUsers > total) {
                note += ` ${KCI.formatCount(totalUsers - total)} of the ${KCI.formatCount(totalUsers)} accounts in Total Users have no role and are not listed.`;
            }
            document.getElementById('userRoleNote').textContent = note;
        }

        function updateGrowthCard(monthly) {
            const el = document.getElementById('growthRate');
            const def = document.getElementById('growthDef');
            const g = KCI.computeSignupChange(monthly);
            const partialText = g.partial && KCI.isCount(g.partial.count)
                ? ` ${g.partial.month} so far: ${KCI.formatCount(g.partial.count)} (month in progress, not compared).`
                : '';
            if (g.available) {
                el.textContent = KCI.formatSignedPercent(g.change);
                el.className = 'value ' + (g.change >= 0 ? 'green' : 'orange');
                def.textContent = `Change in new accounts between the last two full months: ${KCI.formatCount(g.latest.count)} in ${g.latest.month} vs ${KCI.formatCount(g.previous.count)} in ${g.previous.month} (baseline).${partialText}`;
            } else {
                el.textContent = 'N/A';
                el.className = 'value';
                def.textContent = g.reason === 'zero-baseline'
                    ? `No new accounts in ${g.previous.month}, so a % change from it cannot be calculated. ${g.latest.month}: ${KCI.formatCount(g.latest.count)} new accounts.${partialText}`
                    : 'Not enough monthly sign-up data to compare two full months.';
            }
        }

        function updateCompletionCard(summary) {
            const c = KCI.computeCompletionRate(summary);
            document.getElementById('completionRate').textContent = KCI.formatPercent(c.rate);
            const def = document.getElementById('completionDef');
            if (c.rate == null) {
                def.textContent = c.total === 0
                    ? 'No assessment sessions have been started yet, so there is nothing to divide by.'
                    : 'Unavailable: the assessment counts did not load.';
                return;
            }
            const rest = c.submitted != null && c.inProgress != null
                ? ` The other ${KCI.formatCount(c.submitted)} submitted (awaiting result) and ${KCI.formatCount(c.inProgress)} in-progress sessions count as not completed.`
                : '';
            def.textContent = `${KCI.formatCount(c.complete)} completed ÷ ${KCI.formatCount(c.total)} assessment sessions started, all time.${rest}`;
        }

        function updateAverageScores(avg, completedCount) {
            const el = document.getElementById('avgScores');
            const note = document.getElementById('avgScoresNote');
            // The API sends 0 when there are no results to average, which would
            // read as a real 0% — show N/A instead.
            const noResults = completedCount === 0;
            const fmt = (v) => (noResults || v == null ? 'N/A' : `${v}%`);
            el.innerHTML = [
                { label: DOMAIN_LABELS.communication, val: avg.avgCommunication },
                { label: DOMAIN_LABELS.social, val: avg.avgSocial },
                { label: DOMAIN_LABELS.cognitive, val: avg.avgCognitive },
                { label: DOMAIN_LABELS.motor, val: avg.avgMotor }
            ].map(s => `
                <div style="background:var(--bg-primary);padding:1.2rem;border-radius:8px;text-align:center;">
                    <p style="font-size:0.9rem;color:var(--text-light);margin-bottom:0.5rem;">${escapeHtml(s.label)}</p>
                    <p style="font-size:2rem;font-weight:700;color:var(--primary);">${fmt(s.val)}</p>
                    <p style="font-size:0.78rem;color:var(--text-light);margin-top:0.25rem;">mean domain score</p>
                </div>`).join('');
            if (note) {
                note.textContent = noResults
                    ? 'No completed assessments yet, so there are no scores to average.'
                    : `Mean domain score across all ${KCI.formatCount(completedCount)} completed assessments, rounded to a whole number. A domain score is the share of that domain's possible points the child earned (0–100%). It is an average score, not a share of children, a probability or a diagnosis.`;
            }
        }

        function setAnalyticsStatus(errorMessage) {
            const banner = document.getElementById('analyticsError');
            const header = document.querySelector('.analytics-header');
            const statusText = document.querySelector('.analytics-header .status-text');
            const updated = document.getElementById('lastUpdated');
            if (!errorMessage) {
                banner.hidden = true;
                header.classList.remove('is-stale');
                statusText.textContent = 'Live';
                updated.textContent = 'Updated: ' + analyticsLoadedAt.toLocaleTimeString();
                return;
            }
            header.classList.add('is-stale');
            statusText.textContent = 'Update failed';
            banner.hidden = false;
            banner.textContent = analyticsLoadedAt
                ? `The latest refresh failed (${errorMessage}). Showing data from ${analyticsLoadedAt.toLocaleTimeString()}.`
                : `Could not load analytics (${errorMessage}). No figures are shown until the data loads; the page retries automatically.`;
            updated.textContent = analyticsLoadedAt ? 'Last good update: ' + analyticsLoadedAt.toLocaleTimeString() : 'Not loaded';
        }

        async function loadAnalytics() {
            let response;
            try {
                response = await apiFetch('/admin/analytics');
                if (!response || response.success !== true) throw new Error('Invalid API response');
            } catch (e) {
                console.error('[Analytics] Load error:', e);
                // Never replace figures with zeros: keep the last good values,
                // or leave the placeholders if nothing has loaded yet.
                if (!analyticsLoadedAt) {
                    document.getElementById('avgScores').innerHTML = '<p class="text-center text-muted" style="grid-column:1/-1;">Unavailable: analytics did not load.</p>';
                }
                setAnalyticsStatus(e.message || 'unknown error');
                return;
            }

            // Extract data with explicit fallbacks
            const summary = response.summaryTotals || {};
            const avg = response.averageScores || {};
            const monthly = response.monthlySignups || [];
            const apptStats = response.appointmentStats || [];
            const roles = response.roleBreakdown || [];

            // "completedScreenings" is the response field NAME (unchanged,
            // still Assessment.countDocuments({status:'complete'}) — see
            // routes/admin.js); the CARD label reads "Completed Assessments"
            // to match that definition and stay consistent with Admin Reports.
            document.getElementById('totalUsers').textContent = KCI.formatCount(summary.totalUsers);
            document.getElementById('totalChildren').textContent = KCI.formatCount(summary.totalChildren);
            document.getElementById('activeAppointments').textContent = KCI.formatCount(summary.activeAppointments);
            document.getElementById('completedScreenings').textContent = KCI.formatCount(summary.completedScreenings);
            document.getElementById('activeAssessments').textContent = KCI.formatCount(summary.inProgressScreenings);

            const histogram = response.scoreDistribution;
            updateAverageScores(avg, histogram && KCI.isCount(histogram.total) ? histogram.total : summary.completedScreenings);

            // Update the assessment-monitoring sections.
            updateScoreHistogram(histogram);
            updateDomainMonitoring(response.domainNeedsSupport);
            const preparedTrend = updateDomainTrend(response.domainMonthlyTrend);
            updateMonitoringSummary(preparedTrend);
            updatePediatricianComparison(response.pediatricianComparison, response.pediatricianComparisonTotal, response.reviewedAssessmentsSystemWide);
            updateAppointmentTable(apptStats);
            updateRoleTable(roles, summary.totalUsers);

            updateGrowthCard(monthly);
            updateCompletionCard(summary);

            // Pending appointments.
            // This used to be (totalAppointments - completed), which counted
            // approved and rejected bookings as "pending" — the tile read 9
            // when the database held 8 approved, 1 rejected and 0 pending.
            // apptStats is already grouped by status, so read it directly.
            const pendingAppt = apptStats
                .filter(a => String(a.status).toLowerCase() === 'pending')
                .reduce((sum, a) => sum + (a.count || 0), 0);
            document.getElementById('pendingRate').textContent = KCI.formatCount(pendingAppt);

            analyticsLoadedAt = new Date();
            setAnalyticsStatus(null);
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
