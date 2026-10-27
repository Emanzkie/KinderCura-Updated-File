﻿// === Extracted from ADMIN\admin-analytics.html (script block 1) ===
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
        //
        // Every figure here comes from ONE admin-only request,
        // GET /api/admin/analytics/operations, which returns no clinical field.
        // (This page used to also poll GET /api/admin/analytics every 5 s — a
        // 1–5 s request that builds every clinical aggregate.)
        //
        // Each section renders on its own: a section that throws is shown as
        // unavailable and the others still render. A failed request never
        // turns into zeros — figures already on screen are kept and labelled
        // as the last good update, or "Unable to load" is shown.

        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[ch]));
        }

        // Pure helpers (shares, % formatting, month handling) — see
        // js/admin/analytics-interpretations.js; covered by its unit test.
        const KCI = window.KCAnalyticsInterpretations;

        const REQUEST_TIMEOUT_MS = 20000;
        const REFRESH_MS = 30000;
        const UNAVAILABLE = 'Unable to load this data. It will be retried automatically.';

        let loadedAt = null;
        let requestSeq = 0;
        let activeController = null;

        // Fixed display order for the tables so rows do not jump between
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
        const byId = (id) => document.getElementById(id);
        const setText = (id, text) => { byId(id).textContent = text; };

        function sortByFixedOrder(items, order, keyField) {
            const rank = (item) => {
                const key = String(item[keyField] || '').trim().toLowerCase();
                const idx = order.indexOf(key);
                return idx === -1 ? order.length : idx;
            };
            return items.slice().sort((a, b) => rank(a) - rank(b));
        }

        function unavailableRow(colspan) {
            return `<tr><td colspan="${colspan}" class="muted">${escapeHtml(UNAVAILABLE)}</td></tr>`;
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
                `<tr><td>${escapeHtml(labelFor(r))}</td><td class="num">${KCI.formatCount(r.count || 0)}</td><td class="num">${KCI.formatPercent(r.share)}</td></tr>`
            ).join('');
            if (tfoot) {
                tfoot.innerHTML = `<tr><td>${escapeHtml(totalLabel)}</td><td class="num">${KCI.formatCount(total)}</td><td class="num">${total > 0 ? '100%' : 'N/A'}</td></tr>`;
            }
            return total;
        }

        function splitRowsHtml(rows, labelFor, emptyText) {
            if (!rows || !rows.length) return `<tr><td colspan="4" class="muted">${escapeHtml(emptyText)}</td></tr>`;
            return rows.map((r) => `<tr><td>${escapeHtml(labelFor(r.key))}</td><td class="num">${KCI.formatCount(r.real)}</td><td class="num">${KCI.formatCount(r.synthetic)}</td><td class="num">${KCI.formatCount(r.total)}</td></tr>`).join('');
        }

        function periodLabel(period) {
            const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
            if (!period || (!period.from && !period.to)) return 'All time';
            if (period.from && period.to) return `${day(period.from)} – ${day(period.to)}`;
            return period.from ? `From ${day(period.from)}` : `Up to ${day(period.to)}`;
        }
        const createdText = (period) => (period === 'All time' ? 'at any time' : `in ${period}`);

        // ── Sections ────────────────────────────────────────────────────────
        // Each takes the validated response and fills its own elements; each
        // has a matching failure state in SECTION_FAILURES.

        function renderGrowth(data) {
            const el = byId('growthRate');
            const calc = byId('growthCalc');
            const g = KCI.computeSignupChange(data.monthlySignups);
            const partialText = g.partial && KCI.isCount(g.partial.count)
                ? ` ${g.partial.month} so far: ${KCI.formatCount(g.partial.count)} new accounts (month in progress, not compared with a full month).`
                : '';
            if (!g.available) {
                el.textContent = 'N/A';
                el.className = 'value';
                calc.hidden = true;
                setText('growthDef', g.reason === 'zero-baseline'
                    ? `Percentage change unavailable because ${g.previous.month} had no new accounts. ${g.latest.month}: ${KCI.formatCount(g.latest.count)} new accounts.`
                    : 'Not enough monthly sign-up data to compare two full months.');
                return;
            }
            el.textContent = KCI.formatSignedPercent(g.change);
            el.className = 'value ' + (g.change >= 0 ? 'green' : 'orange');
            const explained = KCI.explainSignupChange(g);
            setText('growthDef', explained.interpretation);
            byId('growthSteps').innerHTML = explained.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
            // Synthetic demo accounts are counted, as they always have been;
            // the split is shown so the change is not mistaken for real demand.
            const syn = (row) => (row && KCI.isCount(row.syntheticCount) ? row.syntheticCount : null);
            const synText = syn(g.latest) != null && syn(g.previous) != null
                ? ` Includes synthetic demo accounts: ${KCI.formatCount(syn(g.latest))} of ${KCI.formatCount(g.latest.count)} in ${g.latest.month} and ${KCI.formatCount(syn(g.previous))} of ${KCI.formatCount(g.previous.count)} in ${g.previous.month}.`
                : '';
            setText('growthSource', `Compares the last two full calendar months of user accounts, by creation date.${partialText}${synText}`);
            calc.hidden = false;
        }

        function renderPayments(data, period) {
            const t = data.transactions;
            const currency = (t.currencies || []).length === 1 ? t.currencies[0] : null;
            const money = (n) => KCI.formatMoney(n, currency);
            const groups = t.groups || [];
            const collected = groups.find((g) => g.key === 'collected') || { count: 0, amount: 0 };

            setText('collectedAmount', money(collected.amount));
            setText('collectedDef', `${KCI.formatCount(collected.count)} Paid ${collected.count === 1 ? 'record' : 'records'} · ${period}`);
            const currencyText = (t.currencies || []).length > 1
                ? ` Records use more than one currency (${t.currencies.join(', ')}), so amounts are shown without a currency label.`
                : (t.recordsWithoutCurrency ? ` ${KCI.formatCount(t.recordsWithoutCurrency)} older records have no stored currency.` : '');
            setText('collectedSource', `Sum of the amount on payment records with status Paid, created ${createdText(period)}. Pending, failed and refunded records are not included.${currencyText}`);

            setText('transactionsNote', `${KCI.formatCount(t.totalCount)} payment ${t.totalCount === 1 ? 'record' : 'records'} created ${createdText(period)}, grouped by stored status.${currency ? ` Amounts in ${currency}.` : ''}`);
            const rows = groups.filter((g) => g.key !== 'other' || g.count > 0);
            byId('transactionGroupsTable').innerHTML = t.totalCount
                ? rows.map((g) => `<tr><td>${escapeHtml(g.label)}</td><td>${escapeHtml((g.statuses || []).join(', ') || '—')}</td><td class="num">${KCI.formatCount(g.count)}</td><td class="num">${escapeHtml(money(g.amount))}</td></tr>`).join('')
                : '<tr><td colspan="4" class="muted">No payment records in this period.</td></tr>';
            byId('transactionGroupsTotal').innerHTML = t.totalCount
                ? `<tr><td>All transactions</td><td></td><td class="num">${KCI.formatCount(t.totalCount)}</td><td class="num muted">not summed across groups</td></tr>`
                : '';
        }

        function renderAppointments(data) {
            const stats = sortByFixedOrder(data.appointments.byStatus || [], APPOINTMENT_STATUS_ORDER, 'status');
            // Pending = appointment records whose stored status is pending.
            const pending = stats.filter((a) => String(a.status).toLowerCase() === 'pending').reduce((n, a) => n + (a.count || 0), 0);
            setText('pendingRate', KCI.formatCount(pending));
            setText('activeAppointments', KCI.formatCount(data.appointments.active));
            const total = renderShareTable(byId('appointmentStatusTable'), byId('appointmentStatusTotal'), stats,
                (a) => capitalize(a.status, 'No status recorded'), 'All appointments', 'No appointment records.');
            setText('appointmentStatusNote',
                `Share = (appointments in that status ÷ all ${KCI.formatCount(total)} appointments) × 100, rounded to one decimal place. Every status, all dates.`);
        }

        function renderAccounts(data, period) {
            const accounts = data.accounts;
            const total = accounts.total || {};
            const fresh = (accounts.newInPeriod && accounts.newInPeriod.total) || {};
            setText('totalUsers', KCI.formatCount(total.total));
            setText('totalUsersNote', `${KCI.formatCount(total.real)} real · ${KCI.formatCount(total.synthetic)} synthetic demo · all dates`);
            setText('newRegistrations', KCI.formatCount(fresh.total));
            setText('newRegistrationsNote', `${KCI.formatCount(fresh.real)} real · ${KCI.formatCount(fresh.synthetic)} synthetic demo · ${period}`);
            setText('totalChildren', KCI.formatCount(data.childRecords));

            byId('accountStatusTable').innerHTML = splitRowsHtml(
                sortByFixedOrder(accounts.byStatus || [], ['active', 'pending', 'suspended'], 'key'),
                (k) => capitalize(k, 'No status recorded'), 'No user accounts.');
            byId('newByRoleTable').innerHTML = splitRowsHtml(
                sortByFixedOrder((accounts.newInPeriod && accounts.newInPeriod.byRole) || [], USER_ROLE_ORDER, 'key'),
                roleLabel, 'No accounts were created in this period.');
            setText('newByRoleNote', `Accounts created ${createdText(period)}, by role.`);

            // All accounts by role, all dates. Accounts without a role are left
            // out of the shares and counted in the note instead.
            const roles = sortByFixedOrder((accounts.byRole || []).filter((r) => r.key != null)
                .map((r) => ({ role: r.key, count: r.total })), USER_ROLE_ORDER, 'role');
            const roleTotal = renderShareTable(byId('userRoleTable'), byId('userRoleTotal'), roles,
                (r) => roleLabel(r.role), 'All user accounts', 'No user accounts.');
            let note = `Share = (accounts with that role ÷ all ${KCI.formatCount(roleTotal)} accounts with a role) × 100, rounded to one decimal place. Real and synthetic, all dates.`;
            if (KCI.isCount(total.total) && total.total > roleTotal) {
                note += ` ${KCI.formatCount(total.total - roleTotal)} accounts have no role and are not listed.`;
            }
            setText('userRoleNote', note);
        }

        function renderClinic(data) {
            const clinic = data.clinic;
            const yesNo = (v) => (v == null ? '—' : (v ? 'Enabled' : 'Disabled'));
            // A field with no stored value shows the default the payment flow uses.
            const unsaved = new Set(clinic.unsavedFields || []);
            const mark = (key) => (unsaved.has(key) ? ' (built-in default, not saved)' : '');
            byId('clinicProfile').innerHTML = clinic.profileSaved
                ? `<table class="simple-table ops-table"><tbody>
                        <tr><td>Clinic name</td><td>${clinic.name
                            ? escapeHtml(clinic.name)
                            : 'Not configured. Receipts and payment pages use the built-in default name.'}</td></tr>
                        <tr><td>Profile status</td><td>${clinic.active ? 'Active' : 'Inactive'}${mark('active')}</td></tr>
                        <tr><td>Online payment (PayMongo)</td><td>${yesNo(clinic.onlinePaymentEnabled)}${mark('onlinePaymentEnabled')}</td></tr>
                        <tr><td>Pay at clinic</td><td>${yesNo(clinic.payAtClinicEnabled)}${mark('payAtClinicEnabled')}</td></tr>
                   </tbody></table>`
                : '<p class="pr-kpi-note">No clinic profile has been saved yet, so receipts and payment pages use the built-in default clinic details.</p>';
            byId('prcTable').innerHTML = splitRowsHtml(
                sortByFixedOrder(data.accounts.pediatricianLicense || [], ['verified', 'pending', 'rejected'], 'key'),
                (k) => capitalize(k, 'No status recorded'), 'No pediatrician accounts.');
        }

        // What each section shows when it has nothing valid to display.
        const SECTION_FAILURES = {
            growth() {
                byId('growthRate').textContent = '—';
                byId('growthRate').className = 'value';
                byId('growthCalc').hidden = true;
                setText('growthDef', UNAVAILABLE);
            },
            payments() {
                setText('collectedAmount', '—');
                setText('collectedDef', UNAVAILABLE);
                setText('collectedSource', '');
                setText('transactionsNote', UNAVAILABLE);
                byId('transactionGroupsTable').innerHTML = unavailableRow(4);
                byId('transactionGroupsTotal').innerHTML = '';
            },
            appointments() {
                setText('pendingRate', '—');
                setText('activeAppointments', '—');
                byId('appointmentStatusTable').innerHTML = unavailableRow(3);
                byId('appointmentStatusTotal').innerHTML = '';
            },
            accounts() {
                ['totalUsers', 'newRegistrations', 'totalChildren'].forEach((id) => setText(id, '—'));
                ['totalUsersNote', 'newRegistrationsNote'].forEach((id) => setText(id, UNAVAILABLE));
                ['accountStatusTable', 'newByRoleTable'].forEach((id) => { byId(id).innerHTML = unavailableRow(4); });
                byId('userRoleTable').innerHTML = unavailableRow(3);
                byId('userRoleTotal').innerHTML = '';
            },
            clinic() {
                byId('clinicProfile').innerHTML = `<p class="muted">${escapeHtml(UNAVAILABLE)}</p>`;
                byId('prcTable').innerHTML = unavailableRow(4);
            },
        };

        /** Runs one section; a throw marks only that section unavailable. */
        function renderSection(name, render) {
            try {
                render();
                return true;
            } catch (err) {
                console.error(`[Analytics] Could not display the "${name}" section:`, err);
                SECTION_FAILURES[name]();
                return false;
            }
        }

        // ── Status and period controls ─────────────────────────────────────

        // errorMessage: the request failed. partialFailure: the data loaded but
        // one or more sections could not be displayed (they say so themselves).
        function setStatus(errorMessage, partialFailure = false) {
            const banner = byId('analyticsError');
            const header = document.querySelector('.analytics-header');
            const statusText = document.querySelector('.analytics-header .status-text');
            const updated = byId('lastUpdated');
            if (!errorMessage && partialFailure) {
                header.classList.add('is-stale');
                statusText.textContent = 'Partly updated';
                banner.hidden = false;
                banner.textContent = 'Some sections could not be displayed and are marked "Unable to load". All other figures are current.';
                updated.textContent = 'Updated: ' + loadedAt.toLocaleTimeString();
                return;
            }
            if (!errorMessage) {
                banner.hidden = true;
                header.classList.remove('is-stale');
                statusText.textContent = 'Live';
                updated.textContent = 'Updated: ' + loadedAt.toLocaleTimeString();
                return;
            }
            header.classList.add('is-stale');
            statusText.textContent = 'Update failed';
            banner.hidden = false;
            banner.textContent = loadedAt
                ? `The latest refresh failed (${errorMessage}). The figures below are from the last good update at ${loadedAt.toLocaleTimeString()}.`
                : `Could not load analytics (${errorMessage}). No figures are shown until the data loads; the page retries automatically.`;
            updated.textContent = loadedAt ? 'Last good update: ' + loadedAt.toLocaleTimeString() : 'Not loaded';
        }

        function periodQuery() {
            const params = new URLSearchParams();
            const from = byId('opsFrom').value;
            const to = byId('opsTo').value;
            if (from) params.set('from', from);
            if (to) params.set('to', to);
            const qs = params.toString();
            return qs ? `?${qs}` : '';
        }

        // The period the figures on screen were loaded with — refreshes reuse
        // it, so an edited-but-not-applied date never changes the numbers.
        let appliedQuery = '';

        function setPeriodError(message) {
            const el = byId('opsPeriodError');
            el.textContent = message || '';
            el.hidden = !message;
        }

        function setApplyBusy(busy) {
            byId('opsApply').disabled = busy;
            byId('opsReset').disabled = busy;
            byId('opsApply').textContent = busy ? 'Loading…' : 'Apply';
        }

        // ── Loading ─────────────────────────────────────────────────────────

        /**
         * One request; only the newest request may change the page. A
         * timeout aborts it. `userAction` marks Apply / All time, which show
         * their own busy state.
         */
        async function loadAnalytics({ userAction = false } = {}) {
            const seq = ++requestSeq;
            if (activeController) activeController.abort();
            const controller = new AbortController();
            activeController = controller;
            const query = appliedQuery;
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
            if (userAction) setApplyBusy(true);

            let data;
            try {
                data = await apiFetch(`/admin/analytics/operations${query}`, { signal: controller.signal });
                if (!data || data.success !== true || !data.accounts || !data.transactions || !data.appointments) {
                    throw new Error('unexpected response from the server');
                }
            } catch (err) {
                if (seq !== requestSeq) return;
                const message = timedOut ? `no response after ${REQUEST_TIMEOUT_MS / 1000} seconds` : (err.message || 'unknown error');
                console.error('[Analytics] Load error:', err);
                // Never replace figures with zeros: keep the last good values,
                // or show "Unable to load" if nothing has loaded yet.
                if (!loadedAt) Object.keys(SECTION_FAILURES).forEach((name) => SECTION_FAILURES[name]());
                setStatus(message);
                return;
            } finally {
                clearTimeout(timer);
                if (activeController === controller) activeController = null;
                if (userAction && seq === requestSeq) setApplyBusy(false);
            }
            if (seq !== requestSeq) return;

            const period = periodLabel(data.period);
            setText('opsAppliedRange', `Showing: ${period}`);
            const results = [
                renderSection('growth', () => renderGrowth(data)),
                renderSection('payments', () => renderPayments(data, period)),
                renderSection('appointments', () => renderAppointments(data)),
                renderSection('accounts', () => renderAccounts(data, period)),
                renderSection('clinic', () => renderClinic(data)),
            ];
            loadedAt = new Date();
            setStatus(null, !results.every(Boolean));
        }

        function applyOpsPeriod() {
            const from = byId('opsFrom').value;
            const to = byId('opsTo').value;
            if (from && to && from > to) {
                setPeriodError('The start date is later than the end date. Choose an earlier start date or a later end date.');
                return;
            }
            setPeriodError('');
            appliedQuery = periodQuery();
            loadAnalytics({ userAction: true });
        }

        function resetOpsPeriod() {
            byId('opsFrom').value = '';
            byId('opsTo').value = '';
            setPeriodError('');
            appliedQuery = '';
            loadAnalytics({ userAction: true });
        }

        // Live updates (local server only). Read with fetch so the admin token
        // is sent. A refusal — 501 on Vercel, which has no live stream, or an
        // auth error — ends the attempts for this page; it used to retry every
        // 5 s forever. A dropped connection is retried a few times, and the
        // 30 s refresh (KC.poll below) keeps the page current either way.
        const SSE_RETRY_MS = 30000;
        const SSE_MAX_RETRIES = 5;
        let sseActive = false;
        let sseRetries = 0;

        async function initSSE() {
            if (sseActive || !window.fetch || !window.TextDecoder) return;
            sseActive = true;
            let retry = false;
            try {
                const res = await fetch('/api/admin/sse', {
                    headers: { Accept: 'text/event-stream', ...(KC.token() ? { Authorization: `Bearer ${KC.token()}` } : {}) },
                });
                if (!res.ok || !res.body) return;
                sseRetries = 0;
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const events = buffer.split('\n\n');
                    buffer = events.pop();
                    // A background update never cancels a request already in flight.
                    if (events.some((e) => /^event: analytics:update$/m.test(e)) && !activeController) loadAnalytics();
                }
                retry = true;
            } catch {
                retry = true;
            } finally {
                sseActive = false;
                if (retry && sseRetries < SSE_MAX_RETRIES) {
                    sseRetries += 1;
                    setTimeout(initSSE, SSE_RETRY_MS);
                }
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            byId('opsApply').addEventListener('click', applyOpsPeriod);
            byId('opsReset').addEventListener('click', resetOpsPeriod);
            loadAnalytics();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            initSSE();
            // Visible tabs only, never overlapping a request still in flight
            // (api.js KC.poll). Live changes also arrive through the SSE event.
            KC.poll(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
                // Skip while Apply / All time (or any load) is still running, so a
                // background refresh never cancels the user's own request.
                return activeController ? undefined : loadAnalytics();
            }, REFRESH_MS);
        });
