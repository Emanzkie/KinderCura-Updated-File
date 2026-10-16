// === Extracted from ADMIN\admin-analytics.html (script block 1) ===
requireAuth();
        const _u = KC.user();
        if (_u && _u.role !== 'admin') window.location.href = '/parent/dashboard.html';

        // Admin Analytics shows PLATFORM OPERATIONS only: accounts, the clinic
        // profile, clinic payment transactions and appointments. Developmental
        // assessment monitoring (score averages, distributions, domains needing
        // monitoring, trends, the pediatrician assessment comparison and the
        // assessment completion rate) was moved off this page because it is
        // clinical monitoring, which belongs to the pediatrician. Those figures
        // are still returned by GET /api/admin/analytics for Admin Reports, and
        // their calculation helpers stay in js/admin/analytics-interpretations.js.

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[ch]));
        }

        // Pure helpers (shares, % formatting, month handling) — see
        // js/admin/analytics-interpretations.js; covered by its unit test.
        const KCI = window.KCAnalyticsInterpretations;

        let analyticsLoadedAt = null;

        // Fixed display order for the share tables so rows do not jump between
        // refreshes. Anything not listed sorts last, in server order.
        const APPOINTMENT_STATUS_ORDER = ['pending', 'approved', 'completed', 'cancelled', 'rejected'];
        const USER_ROLE_ORDER = ['parent', 'pediatrician', 'secretary', 'legal_guardian', 'foster_parent', 'court_appointed', 'admin'];
        const ROLE_LABELS = {
            parent: 'Parent', legal_guardian: 'Legal Guardian', foster_parent: 'Foster Parent',
            court_appointed: 'Court-Appointed Guardian', pediatrician: 'Pediatrician',
            secretary: 'Secretary', admin: 'Admin',
        };
        const roleLabel = (key) => ROLE_LABELS[key] || (key ? (key.charAt(0).toUpperCase() + key.slice(1)) : 'No role recorded');
        const capitalize = (key, empty) => (key ? key.charAt(0).toUpperCase() + key.slice(1) : empty);

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
                (a) => capitalize(a.status, 'No status recorded'),
                'All appointments',
                'No appointment data available.'
            );
            document.getElementById('appointmentStatusNote').textContent =
                `Share = (appointments in that status ÷ all ${KCI.formatCount(total)} appointments) × 100, rounded to one decimal place. Every status is included, cancelled and rejected too, all dates. Active Appointments above = Pending + Approved.`;
        }

        function updateRoleTable(roleBreakdown, totalUsers) {
            const roles = sortByFixedOrder(roleBreakdown || [], USER_ROLE_ORDER, 'role');
            const total = renderShareTable(
                document.getElementById('userRoleTable'),
                document.getElementById('userRoleTotal'),
                roles,
                (r) => roleLabel(r.role),
                'All user accounts',
                'No role data available.'
            );
            let note = `Share = (accounts with that role ÷ all ${KCI.formatCount(total)} user accounts with a role) × 100, rounded to one decimal place. Active, pending and suspended accounts, real and synthetic, all dates.`;
            if (KCI.isCount(totalUsers) && totalUsers > total) {
                note += ` ${KCI.formatCount(totalUsers - total)} of the ${KCI.formatCount(totalUsers)} accounts in Total User Accounts have no role and are not listed.`;
            }
            document.getElementById('userRoleNote').textContent = note;
        }

        function updateGrowthCard(monthly) {
            const el = document.getElementById('growthRate');
            const def = document.getElementById('growthDef');
            const calc = document.getElementById('growthCalc');
            const g = KCI.computeSignupChange(monthly);
            const partialText = g.partial && KCI.isCount(g.partial.count)
                ? ` ${g.partial.month} so far: ${KCI.formatCount(g.partial.count)} (month in progress, so it is not compared with a full month).`
                : '';
            if (g.available) {
                el.textContent = KCI.formatSignedPercent(g.change);
                el.className = 'value ' + (g.change >= 0 ? 'green' : 'orange');
                const explained = KCI.explainSignupChange(g);
                def.textContent = `${explained.interpretation} Compares the last two full calendar months.${partialText}`;
                document.getElementById('growthSteps').innerHTML = explained.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
                // Synthetic demo accounts are counted, as they always have been;
                // the split is shown so the change is not mistaken for real demand.
                const syn = (row) => (row && KCI.isCount(row.syntheticCount) ? row.syntheticCount : null);
                const synLatest = syn(g.latest);
                const synPrevious = syn(g.previous);
                const synText = synLatest != null && synPrevious != null
                    ? ` These counts include synthetic demo accounts: ${KCI.formatCount(synLatest)} of ${KCI.formatCount(g.latest.count)} in ${g.latest.month} and ${KCI.formatCount(synPrevious)} of ${KCI.formatCount(g.previous.count)} in ${g.previous.month}.`
                    : '';
                document.getElementById('growthSource').textContent =
                    `Source: user accounts grouped by the calendar month of their creation date. Why it matters: shows whether sign-ups are rising or falling.${synText}`;
                calc.hidden = false;
            } else {
                el.textContent = 'N/A';
                el.className = 'value';
                calc.hidden = true;
                def.textContent = g.reason === 'zero-baseline'
                    ? `Percentage change unavailable because ${g.previous.month} had no new accounts (a change from zero cannot be calculated). ${g.latest.month}: ${KCI.formatCount(g.latest.count)} new accounts.${partialText}`
                    : 'Not enough monthly sign-up data to compare two full months.';
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
                setAnalyticsStatus(e.message || 'unknown error');
                return;
            }

            const summary = response.summaryTotals || {};
            const monthly = response.monthlySignups || [];
            const apptStats = response.appointmentStats || [];
            const roles = response.roleBreakdown || [];

            document.getElementById('totalUsers').textContent = KCI.formatCount(summary.totalUsers);
            document.getElementById('totalChildren').textContent = KCI.formatCount(summary.totalChildren);
            document.getElementById('activeAppointments').textContent = KCI.formatCount(summary.activeAppointments);

            updateAppointmentTable(apptStats);
            updateRoleTable(roles, summary.totalUsers);
            updateGrowthCard(monthly);

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

        // ── Operations: accounts, clinic and transactions ───────────────────
        // GET /api/admin/analytics/operations (admin only). The optional period
        // filters New Registrations and Clinic Transactions; everything else is
        // labelled all-time. Loaded on page load, on Apply and on a live update
        // event, not on the 5-second refresh: these figures change slowly.

        let opsRequestSeq = 0;

        function opsQuery() {
            const from = document.getElementById('opsFrom').value;
            const to = document.getElementById('opsTo').value;
            const params = new URLSearchParams();
            if (from) params.set('from', from);
            if (to) params.set('to', to);
            const qs = params.toString();
            return qs ? `?${qs}` : '';
        }

        function periodLabel(period) {
            const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
            if (!period || (!period.from && !period.to)) return 'all time';
            if (period.from && period.to) return `${day(period.from)} – ${day(period.to)}`;
            return period.from ? `from ${day(period.from)}` : `up to ${day(period.to)}`;
        }

        function splitRowsHtml(rows, labelFor, emptyText) {
            if (!rows || !rows.length) return `<tr><td colspan="4" class="muted">${escapeHtml(emptyText)}</td></tr>`;
            return rows.map((r) => `<tr><td>${escapeHtml(labelFor(r.key))}</td><td>${KCI.formatCount(r.real)}</td><td>${KCI.formatCount(r.synthetic)}</td><td>${KCI.formatCount(r.total)}</td></tr>`).join('');
        }

        function renderOperations(data) {
            const period = periodLabel(data.period);
            const accounts = data.accounts || {};
            const total = accounts.total || {};
            const fresh = (accounts.newInPeriod && accounts.newInPeriod.total) || {};

            document.getElementById('totalUsersNote').textContent =
                `All registered accounts across every role, all dates: ${KCI.formatCount(total.real)} real and ${KCI.formatCount(total.synthetic)} synthetic demo accounts. Child records are counted separately.`;
            document.getElementById('newRegistrations').textContent = KCI.formatCount(fresh.total);
            document.getElementById('newRegistrationsNote').textContent =
                `Accounts created ${period === 'all time' ? 'at any time' : `in ${period}`}: ${KCI.formatCount(fresh.real)} real and ${KCI.formatCount(fresh.synthetic)} synthetic demo accounts.`;

            const statusOrder = ['active', 'pending', 'suspended'];
            document.getElementById('accountStatusTable').innerHTML = splitRowsHtml(
                sortByFixedOrder(accounts.byStatus || [], statusOrder, 'key'),
                (k) => capitalize(k, 'No status recorded'), 'No account data available.');
            document.getElementById('newByRoleTable').innerHTML = splitRowsHtml(
                sortByFixedOrder((accounts.newInPeriod && accounts.newInPeriod.byRole) || [], USER_ROLE_ORDER, 'key'),
                roleLabel, 'No accounts were created in this period.');
            document.getElementById('newByRoleNote').textContent = `Accounts created in the selected period (${period}), by role.`;
            document.getElementById('prcTable').innerHTML = splitRowsHtml(
                sortByFixedOrder(accounts.pediatricianLicense || [], ['verified', 'pending', 'rejected'], 'key'),
                (k) => capitalize(k, 'No status recorded'), 'No pediatrician accounts.');

            const clinic = data.clinic || {};
            const yesNo = (v) => (v == null ? '—' : (v ? 'Enabled' : 'Disabled'));
            document.getElementById('clinicProfile').innerHTML = clinic.profileSaved
                ? `<table class="simple-table"><tbody>
                        <tr><td>Clinic name</td><td>${escapeHtml(clinic.name || 'Not set')}</td></tr>
                        <tr><td>Profile status</td><td>${clinic.active ? 'Active' : 'Inactive'}</td></tr>
                        <tr><td>Online payment (PayMongo)</td><td>${yesNo(clinic.onlinePaymentEnabled)}</td></tr>
                        <tr><td>Pay at clinic</td><td>${yesNo(clinic.payAtClinicEnabled)}</td></tr>
                   </tbody></table>`
                : '<p class="pr-kpi-note">No clinic profile has been saved yet, so receipts and payment pages use the built-in default clinic details.</p>';

            renderTransactions(data.transactions || {}, period);
        }

        function renderTransactions(t, period) {
            const currency = (t.currencies || []).length === 1 ? t.currencies[0] : null;
            const groups = t.groups || [];
            const collected = groups.find((g) => g.key === 'collected') || { count: 0, amount: 0 };
            const money = (n) => KCI.formatMoney(n, currency);

            document.getElementById('collectedAmount').textContent = money(collected.amount);
            const currencyText = (t.currencies || []).length > 1
                ? ` Records use more than one currency (${t.currencies.join(', ')}), so amounts are shown without a currency label.`
                : (t.recordsWithoutCurrency ? ` ${KCI.formatCount(t.recordsWithoutCurrency)} older records have no stored currency.` : '');
            document.getElementById('collectedDef').textContent =
                `Sum of ${KCI.formatCount(collected.count)} payment ${collected.count === 1 ? 'record' : 'records'} with status Paid, created ${period === 'all time' ? 'at any time' : `in ${period}`}. Pending, failed and refunded records are not included.${currencyText}`;

            document.getElementById('transactionsNote').textContent =
                `${KCI.formatCount(t.totalCount)} payment ${t.totalCount === 1 ? 'record' : 'records'} created ${period === 'all time' ? 'at any time' : `in ${period}`}, grouped by stored status.`;
            const tbody = document.getElementById('transactionGroupsTable');
            const rows = groups.filter((g) => g.key !== 'other' || g.count > 0);
            tbody.innerHTML = t.totalCount
                ? rows.map((g) => `<tr><td>${escapeHtml(g.label)}</td><td>${escapeHtml((g.statuses || []).join(', ') || '—')}</td><td>${KCI.formatCount(g.count)}</td><td>${escapeHtml(money(g.amount))}</td></tr>`).join('')
                : '<tr><td colspan="4" class="muted">No payment records in this period.</td></tr>';
            document.getElementById('transactionGroupsTotal').innerHTML = t.totalCount
                ? `<tr><td>All transactions</td><td></td><td>${KCI.formatCount(t.totalCount)}</td><td class="muted">not summed across groups</td></tr>`
                : '';
        }

        async function loadOperations() {
            const seq = ++opsRequestSeq;
            const query = opsQuery();
            try {
                const data = await apiFetch(`/admin/analytics/operations${query}`);
                if (seq !== opsRequestSeq) return;
                if (!data || data.success !== true) throw new Error('Invalid API response');
                renderOperations(data);
            } catch (e) {
                if (seq !== opsRequestSeq) return;
                console.error('[Analytics] Operations load error:', e);
                const msg = 'Unavailable: these figures did not load. Use Apply to try again.';
                document.getElementById('collectedAmount').textContent = '—';
                document.getElementById('collectedDef').textContent = msg;
                document.getElementById('newRegistrations').textContent = '—';
                document.getElementById('newRegistrationsNote').textContent = msg;
                ['accountStatusTable', 'newByRoleTable', 'prcTable'].forEach((id) => {
                    document.getElementById(id).innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(msg)}</td></tr>`;
                });
                document.getElementById('transactionGroupsTable').innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(msg)}</td></tr>`;
                document.getElementById('transactionGroupsTotal').innerHTML = '';
                document.getElementById('transactionsNote').textContent = msg;
                document.getElementById('clinicProfile').innerHTML = `<p class="muted">${escapeHtml(msg)}</p>`;
            }
        }

        function applyOpsPeriod() {
            const from = document.getElementById('opsFrom').value;
            const to = document.getElementById('opsTo').value;
            if (from && to && from > to) {
                alert('The "from" date cannot be later than the "to" date.');
                return;
            }
            loadOperations();
        }

        function resetOpsPeriod() {
            document.getElementById('opsFrom').value = '';
            document.getElementById('opsTo').value = '';
            loadOperations();
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
                    loadOperations();
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
            loadAnalytics();
            loadOperations();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            initSSE();

            // Auto-refresh every 5 seconds
            setInterval(() => {
                loadAnalytics();
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
            }, 5000);
        });
