// Registered Clinics section of ADMIN/admin-reports.html.
// Data: /api/admin/clinics (routes/admin-clinics.js), admin-only on the server.
// A failed request shows "Unavailable" with the reason, never a zero: a zero
// is shown only when a successful query found no matching records.
(function () {
    'use strict';

    const byId = (id) => document.getElementById(id);
    const UNAVAILABLE = 'Unavailable';
    const state = { page: 1, limit: 20, search: '', status: '', sort: 'name', from: '', to: '', selectedId: null, totalPages: 1 };

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }
    const count = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : '—');
    const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
    const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—');

    // Amounts are shown with their currency only when every record shares one.
    function money(amount, summary) {
        const value = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const currencies = summary.currencies || [];
        return currencies.length === 1 ? `${esc(currencies[0])} ${value}` : value;
    }
    function currencyNote(summary) {
        const currencies = summary.currencies || [];
        const parts = [];
        if (currencies.length > 1) parts.push(`Amounts mix currencies (${currencies.map(esc).join(', ')}) and are summed as recorded.`);
        if (summary.recordsWithoutCurrency) parts.push(`${count(summary.recordsWithoutCurrency)} records have no currency.`);
        return parts.join(' ');
    }

    function notice(el, message, isError) {
        el.innerHTML = message ? `<div class="pr-notice${isError ? ' is-error' : ''}">${esc(message)}</div>` : '';
    }

    function query(extra) {
        const params = new URLSearchParams();
        if (state.from) params.set('from', state.from);
        if (state.to) params.set('to', state.to);
        for (const [k, v] of Object.entries(extra || {})) if (v !== '' && v != null) params.set(k, v);
        const s = params.toString();
        return s ? `?${s}` : '';
    }

    function periodText() {
        if (!state.from && !state.to) return 'all dates';
        return `${state.from || 'the first record'} to ${state.to || 'today'} (whole days, UTC)`;
    }

    // ── Summary ───────────────────────────────────────────────────────────
    function card(label, value, note) {
        return `<div class="report-card"><p class="report-label">${esc(label)}</p><p class="report-value">${value}</p>${note ? `<p class="muted pr-scope-line" style="margin:0.3rem 0 0;">${note}</p>` : ''}</div>`;
    }

    function groupCell(summary, key, field) {
        const g = (summary.groups || []).find((x) => x.key === key);
        if (!g) return '—';
        return field === 'amount' ? money(g.amount, summary) : count(g.count);
    }

    function txRow(label, summary) {
        return `<tr><td>${esc(label)}</td><td class="num">${count(summary.totalCount)}</td>`
            + `<td class="num">${groupCell(summary, 'collected', 'count')}</td><td class="num">${groupCell(summary, 'collected', 'amount')}</td>`
            + `<td class="num">${groupCell(summary, 'pending', 'count')}</td><td class="num">${groupCell(summary, 'failed', 'count')}</td>`
            + `<td class="num">${groupCell(summary, 'refunded', 'count')}</td><td class="num">${groupCell(summary, 'other', 'count')}</td></tr>`;
    }

    async function loadSummary() {
        byId('clinicPeriodNote').textContent = `Reporting period: ${periodText()}. It applies to New registrations and to transactions; the other clinic counts are all-time.`;
        try {
            const data = await apiFetch(`/admin/clinics/summary${query()}`);
            const c = data.clinics;
            const hasPeriod = Boolean(state.from || state.to);
            const share = c.registered > 0
                ? `${(Math.round((c.active / c.registered) * 1000) / 10).toFixed(1)}%`
                : '—';
            byId('clinicSummaryCards').innerHTML = [
                card('Registered clinics', count(c.registered), 'Distinct clinic records, all dates.'),
                card('Active', count(c.active), 'Status "active", all dates.'),
                card('Inactive', count(c.inactive), 'Status "inactive", all dates.'),
                card('Active share', share, c.registered > 0
                    ? `(${count(c.active)} active ÷ ${count(c.registered)} registered) × 100, one decimal.`
                    : 'No registered clinics, so there is no share to compute.'),
                card('New registrations', hasPeriod ? count(c.newInPeriod) : '—', hasPeriod
                    ? 'Clinics registered in the reporting period.'
                    : 'Choose a reporting period to count new registrations.'),
                card('With pediatricians', count(c.withPediatricians), 'Clinics with at least one linked pediatrician account.'),
            ].join('');
            byId('clinicSummaryNote').textContent = c.registered === 0
                ? 'No clinics have been registered yet.'
                : '';

            const t = data.transactions;
            byId('clinicTxRows').innerHTML = txRow('With a registered clinic', t.withClinic)
                + txRow('No clinic association', t.withoutClinic)
                + txRow('All transactions', t.all);
            byId('clinicTxNote').textContent = [
                `Payment records created in the reporting period (${periodText()}), grouped as on the Payments page: collected counts "Paid" only, and pending, failed or expired payments are never collected. Counts and amounts are separate measures.`,
                '"No clinic association" means the appointment was booked before its pediatrician was linked to a registered clinic (or the appointment record is missing). Those payments are kept as recorded and are not assigned to any clinic.',
                currencyNote(t.all),
            ].filter(Boolean).join(' ');
        } catch (err) {
            byId('clinicSummaryCards').innerHTML = card('Clinic summary', UNAVAILABLE, esc(err.message || 'The request failed.'));
            byId('clinicSummaryNote').textContent = '';
            byId('clinicTxRows').innerHTML = `<tr><td colspan="8" class="muted">${UNAVAILABLE}: ${esc(err.message || 'the request failed.')}</td></tr>`;
            byId('clinicTxNote').textContent = '';
        }
    }

    // ── Listing ───────────────────────────────────────────────────────────
    function statusBadge(status) {
        return `<span class="pr-status-badge clinic-status-${status === 'active' ? 'active' : 'inactive'}">${esc(capitalize(status))}</span>`;
    }

    async function loadList() {
        const rows = byId('clinicRows');
        rows.innerHTML = '<tr><td colspan="8" class="muted">Loading registered clinics...</td></tr>';
        try {
            const data = await apiFetch(`/admin/clinics${query({ search: state.search, status: state.status, sort: state.sort, page: state.page, limit: state.limit })}`);
            state.totalPages = data.totalPages;
            if (!data.clinics.length) {
                const filtered = state.search || state.status;
                rows.innerHTML = `<tr><td colspan="8" class="muted">${filtered ? 'No registered clinics match these filters.' : 'No clinics have been registered yet.'}</td></tr>`;
            } else {
                rows.innerHTML = data.clinics.map((c) => `<tr>
                    <td>${esc(c.name)}</td>
                    <td>${esc(c.address)}</td>
                    <td>${[c.contactPhone, c.contactEmail].filter(Boolean).map(esc).join('<br>') || '—'}</td>
                    <td>${esc(dateText(c.registeredAt))}</td>
                    <td>${statusBadge(c.status)}</td>
                    <td class="num">${count(c.pediatricianCount)}</td>
                    <td class="num">${count(c.transactionCount)}</td>
                    <td><button type="button" class="btn btn-secondary" data-clinic-view="${esc(c.id)}">View</button></td>
                </tr>`).join('');
            }
            const first = data.total ? (data.page - 1) * data.limit + 1 : 0;
            const last = Math.min(data.total, data.page * data.limit);
            byId('clinicPageInfo').textContent = data.total
                ? `Showing ${count(first)}–${count(last)} of ${count(data.total)} · page ${count(data.page)} of ${count(data.totalPages)}`
                : '0 clinics';
            byId('clinicPrevBtn').disabled = data.page <= 1;
            byId('clinicNextBtn').disabled = data.page >= data.totalPages;
        } catch (err) {
            rows.innerHTML = `<tr><td colspan="8" class="muted">${UNAVAILABLE}: ${esc(err.message || 'the request failed.')}</td></tr>`;
            byId('clinicPageInfo').textContent = '—';
            byId('clinicPrevBtn').disabled = true;
            byId('clinicNextBtn').disabled = true;
        }
    }

    // ── Registration ──────────────────────────────────────────────────────
    function readForm(prefix) {
        return {
            name: byId(`${prefix}Name`).value.trim(),
            address: byId(`${prefix}Address`).value.trim(),
            contactPhone: byId(`${prefix}Phone`).value.trim(),
            contactEmail: byId(`${prefix}Email`).value.trim(),
        };
    }
    function formError(v) {
        if (!v.name) return 'Enter the clinic name.';
        if (!v.address) return 'Enter the clinic address.';
        if (v.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail)) return 'Contact email is not a valid email address.';
        if (v.contactPhone && !/^[0-9+()\-.\s]{7,40}$/.test(v.contactPhone)) return 'Contact phone may contain only digits, spaces, +, -, ( ) and dots.';
        return null;
    }

    async function register(event) {
        event.preventDefault();
        const msg = byId('clinicRegisterMsg');
        const values = readForm('clinicNew');
        const invalid = formError(values);
        if (invalid) return notice(msg, invalid, true);
        const btn = byId('clinicRegisterBtn');
        btn.disabled = true;
        notice(msg, 'Registering...');
        try {
            const data = await apiFetch('/admin/clinics', { method: 'POST', body: JSON.stringify(values) });
            byId('clinicRegisterForm').reset();
            notice(msg, `Registered "${data.clinic.name}".`);
            state.page = 1;
            await Promise.all([loadSummary(), loadList()]);
            openDetails(data.clinic.id);
        } catch (err) {
            notice(msg, err.message || 'Could not register the clinic.', true);
        } finally {
            btn.disabled = false;
        }
    }

    // ── Details ───────────────────────────────────────────────────────────
    async function openDetails(id) {
        state.selectedId = id;
        const panel = byId('clinicDetails');
        panel.hidden = false;
        notice(byId('clinicDetailsMsg'), '');
        byId('clinicPedSearch').value = '';
        byId('clinicPedResults').innerHTML = '';
        await loadDetails();
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function loadDetails() {
        const id = state.selectedId;
        if (!id) return;
        try {
            const data = await apiFetch(`/admin/clinics/${encodeURIComponent(id)}${query()}`);
            const c = data.clinic;
            byId('clinicDetailsTitle').textContent = c.name;
            byId('clinicEditName').value = c.name;
            byId('clinicEditAddress').value = c.address;
            byId('clinicEditPhone').value = c.contactPhone || '';
            byId('clinicEditEmail').value = c.contactEmail || '';
            byId('clinicEditStatus').value = c.status;
            byId('clinicDetailsRegistered').textContent = dateText(c.registeredAt);

            byId('clinicPedRows').innerHTML = data.pediatricians.length
                ? data.pediatricians.map((p) => `<tr>
                    <td>${esc(p.name || '—')}${p.isSynthetic ? ' <span class="muted">(synthetic)</span>' : ''}</td>
                    <td>${esc(p.email || '—')}</td>
                    <td>${esc(capitalize(p.accountStatus))}</td>
                    <td>${esc(p.prcVerificationStatus ? capitalize(p.prcVerificationStatus) : 'Not submitted')}</td>
                    <td><button type="button" class="btn btn-secondary" data-ped-unlink="${esc(p.id)}">Unlink</button></td>
                </tr>`).join('')
                : '<tr><td colspan="5" class="muted">No pediatricians are linked to this clinic.</td></tr>';

            const t = data.transactions;
            byId('clinicDetailTxRows').innerHTML = t.totalCount
                ? t.groups.map((g) => `<tr>
                    <td>${esc(g.label)}</td>
                    <td>${g.statuses.length ? g.statuses.map(esc).join(', ') : '—'}</td>
                    <td class="num">${count(g.count)}</td>
                    <td class="num">${money(g.amount, t)}</td>
                </tr>`).join('')
                : '<tr><td colspan="4" class="muted">No transactions for this clinic in the reporting period.</td></tr>';
            byId('clinicDetailTxNote').textContent = [
                `Reporting period: ${periodText()}. Payment records whose appointment was booked under this clinic. Only "Paid (collected)" is money received; the other amounts are what those records state.`,
                currencyNote(t),
            ].filter(Boolean).join(' ');
        } catch (err) {
            byId('clinicDetailsTitle').textContent = 'Clinic';
            notice(byId('clinicDetailsMsg'), `${UNAVAILABLE}: ${err.message || 'the request failed.'}`, true);
            byId('clinicPedRows').innerHTML = `<tr><td colspan="5" class="muted">${UNAVAILABLE}</td></tr>`;
            byId('clinicDetailTxRows').innerHTML = `<tr><td colspan="4" class="muted">${UNAVAILABLE}</td></tr>`;
            byId('clinicDetailTxNote').textContent = '';
        }
    }

    async function saveEdit(event) {
        event.preventDefault();
        const msg = byId('clinicDetailsMsg');
        const values = { ...readForm('clinicEdit'), status: byId('clinicEditStatus').value };
        const invalid = formError(values);
        if (invalid) return notice(msg, invalid, true);
        const btn = byId('clinicEditBtn');
        btn.disabled = true;
        try {
            const data = await apiFetch(`/admin/clinics/${encodeURIComponent(state.selectedId)}`, { method: 'PATCH', body: JSON.stringify(values) });
            notice(msg, data.changed.length ? 'Saved.' : 'No changes to save.');
            await Promise.all([loadSummary(), loadList(), loadDetails()]);
        } catch (err) {
            notice(msg, err.message || 'Could not save the clinic.', true);
        } finally {
            btn.disabled = false;
        }
    }

    async function setLink(pediatricianId, clinicId) {
        const msg = byId('clinicDetailsMsg');
        try {
            await apiFetch(`/admin/clinics/pediatricians/${encodeURIComponent(pediatricianId)}`, { method: 'PUT', body: JSON.stringify({ clinicId }) });
            notice(msg, clinicId ? 'Pediatrician linked.' : 'Pediatrician unlinked.');
            byId('clinicPedResults').innerHTML = '';
            byId('clinicPedSearch').value = '';
            await Promise.all([loadSummary(), loadList(), loadDetails()]);
        } catch (err) {
            notice(msg, err.message || 'Could not update the link.', true);
        }
    }

    let pedSearchTimer = null;
    let pedSearchSeq = 0;
    function onPedSearch() {
        clearTimeout(pedSearchTimer);
        const term = byId('clinicPedSearch').value.trim();
        const results = byId('clinicPedResults');
        if (!term) { results.innerHTML = ''; return; }
        pedSearchTimer = setTimeout(async () => {
            const seq = ++pedSearchSeq;
            try {
                const data = await apiFetch(`/admin/clinics/pediatricians?search=${encodeURIComponent(term)}`);
                if (seq !== pedSearchSeq) return;
                results.innerHTML = data.pediatricians.length
                    ? data.pediatricians.map((p) => {
                        const here = p.clinicId === state.selectedId;
                        const where = p.clinicId ? (here ? 'Linked to this clinic' : `Linked to ${esc(p.clinicName || 'another clinic')}`) : 'No clinic';
                        return `<tr>
                            <td>${esc(p.name || '—')}${p.isSynthetic ? ' <span class="muted">(synthetic)</span>' : ''}</td>
                            <td>${esc(p.email || '—')}</td>
                            <td>${where}</td>
                            <td>${here ? '' : `<button type="button" class="btn btn-primary" data-ped-link="${esc(p.id)}">${p.clinicId ? 'Move here' : 'Link'}</button>`}</td>
                        </tr>`;
                    }).join('')
                    : '<tr><td class="muted">No pediatrician accounts match.</td></tr>';
            } catch (err) {
                if (seq === pedSearchSeq) results.innerHTML = `<tr><td class="muted">${UNAVAILABLE}: ${esc(err.message || 'the request failed.')}</td></tr>`;
            }
        }, 300);
    }

    // ── Wiring ────────────────────────────────────────────────────────────
    let searchTimer = null;
    function init() {
        if (!byId('clinicsSection')) return;
        byId('clinicPeriodApply').addEventListener('click', () => {
            const from = byId('clinicFrom').value;
            const to = byId('clinicTo').value;
            if (from && to && from > to) {
                byId('clinicPeriodNote').textContent = '"From" must not be later than "To".';
                return;
            }
            state.from = from; state.to = to; state.page = 1;
            loadSummary(); loadList(); loadDetails();
        });
        byId('clinicPeriodClear').addEventListener('click', () => {
            byId('clinicFrom').value = ''; byId('clinicTo').value = '';
            state.from = ''; state.to = ''; state.page = 1;
            loadSummary(); loadList(); loadDetails();
        });
        byId('clinicSearch').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { state.search = byId('clinicSearch').value.trim(); state.page = 1; loadList(); }, 300);
        });
        byId('clinicStatusFilter').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; loadList(); });
        byId('clinicSort').addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; loadList(); });
        byId('clinicPrevBtn').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; loadList(); } });
        byId('clinicNextBtn').addEventListener('click', () => { if (state.page < state.totalPages) { state.page += 1; loadList(); } });
        byId('clinicRegisterForm').addEventListener('submit', register);
        byId('clinicEditForm').addEventListener('submit', saveEdit);
        byId('clinicDetailsClose').addEventListener('click', () => { byId('clinicDetails').hidden = true; state.selectedId = null; });
        byId('clinicPedSearch').addEventListener('input', onPedSearch);
        byId('clinicRows').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-clinic-view]');
            if (btn) openDetails(btn.getAttribute('data-clinic-view'));
        });
        byId('clinicPedRows').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ped-unlink]');
            if (btn) setLink(btn.getAttribute('data-ped-unlink'), null);
        });
        byId('clinicPedResults').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-ped-link]');
            if (btn) setLink(btn.getAttribute('data-ped-link'), state.selectedId);
        });
        loadSummary();
        loadList();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
