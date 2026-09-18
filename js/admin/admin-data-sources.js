// === Data Sources admin page ===
// Shows which screening questions and answers come from the fixed core
// question bank versus which a pediatrician entered at runtime.
// Follows the same auth + fetch pattern as js/admin/admin-training.js.
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

        // ---- Data Sources state --------------------------------------------
        //
        // Exactly TWO adviser-facing categories, never a third:
        //   dataset_question       — system-provided (no pediatrician author).
        //                            Combines the real origins core_bank
        //                            (pediatrician interview) and
        //                            dataset_question (external dataset) —
        //                            see services/adminDataSourceView.js.
        //   pediatrician_question  — authored by a pediatrician (pedia_entry),
        //                            including any follow-up/additional
        //                            question they add. There is no separate
        //                            "Follow-up Question" bucket.
        let currentCategory = 'all';
        let currentPage = 1;
        const PAGE_LIMIT = 15;
        let lastPagination = null;
        let lastSummary = null;

        // Per-category filter state. Reset to these defaults every time the
        // tab changes (req 21: filters must not leak across tabs).
        function defaultFilters() {
            return { source: 'all', version: 'all', pediatricianId: 'all', dateFrom: '', dateTo: '', sort: 'newest' };
        }
        let filters = defaultFilters();

        const CATEGORY_LABELS = {
            dataset_question: 'Dataset Question',
            pediatrician_question: 'Pediatrician Question',
        };

        const ORIGIN_SOURCE_KIND = {
            core_bank: 'Pediatrician interview',
            dataset_question: 'External dataset',
            pedia_entry: 'Created by a pediatrician in KinderCura',
        };

        function categoryBadge(category) {
            const cls = category === 'pediatrician_question' ? 'origin-pedia_entry' : 'origin-dataset_question';
            const glyph = category === 'pediatrician_question' ? '✚' : '▣';
            const text = CATEGORY_LABELS[category] || category || 'Unknown';
            return `<span class="origin-badge ${cls}"><span class="origin-glyph" aria-hidden="true">${glyph}</span>${escapeHtml(text)}</span>`;
        }

        // Pediatrician review lifecycle. Applies to the dataset_question
        // sub-origin only — everything else (core_bank, pedia_entry) sends
        // approvalStatus:null, rendered here as a plain Active/Inactive state
        // rather than a misleading "Pending Pediatrician Approval" (req 23).
        const APPROVAL_LABELS = {
            pending_pediatrician_approval: 'Pending Pediatrician Approval',
            approved: 'Approved',
            rejected: 'Rejected',
        };

        // Renders the Approval/Status cell. For a row with a real approval
        // workflow (dataset_question sub-origin) this keeps THREE facts
        // visually separate so they can never be read as one:
        //   Reviewer decision   — the wording review round only (catalogue)
        //   Pediatrician approval — the sign-off that gates activation
        //   Active              — whether it is live in an assessment
        // Any other row (core_bank, pedia_entry) has no review workflow, so it
        // shows a simple Active/Inactive status instead — never a fabricated
        // approval state (req 23/24).
        function approvalCell(r) {
            if (!r.approvalStatus) {
                return `<span class="approval-note" style="margin-top:0;">Active: <strong>${r.isActive ? 'Yes' : 'No'}</strong></span>`;
            }
            const text = r.approvalStatusLabel || APPROVAL_LABELS[r.approvalStatus] || r.approvalStatus;
            const cls = `approval-${r.approvalStatus}`;
            const reviewerLine = r.reviewerDecisionLabel
                ? `<div class="reviewer-decision" title="${escapeHtml(r.reviewerDecisionRound || '')}">Reviewer decision: <strong>${escapeHtml(r.reviewerDecisionLabel)}</strong> <span class="rd-scope">(wording)</span></div>`
                : '';
            const pediaLine = `<div class="pedia-approval">Pediatrician approval: <span class="approval-badge ${cls}">${escapeHtml(text)}</span></div>`;
            const activeLine = `<div class="approval-note">Active: <strong>${r.isActive ? 'Yes' : 'No'}</strong></div>`;
            const openMap = r.hasOpenMappingQuestion
                ? '<div class="approval-note approval-note--open">Open clinical mapping question &mdash; pediatrician to rule</div>'
                : '';
            return `${reviewerLine}${pediaLine}${activeLine}${openMap}`;
        }

        // The three states req 4 keeps separate for the Dataset Question set as
        // a whole, on the sources card. Sourced from static catalogue data
        // (s.datasetQuestion.reviewerDecision) so it renders even before any
        // question is written to the database.
        function reviewerStatusBlock(s) {
            const dq = s.datasetQuestion || {};
            const rd = dq.reviewerDecision;
            if (!rd) return '';
            const ap = dq.approval || {};
            const n = rd.catalogueCount ?? 0;
            const externalQuestions = dq.breakdown?.externalDataset?.questions ?? 0;
            const seeded = externalQuestions > 0;
            const pending = ap.pending ?? 0;
            const approvedCount = ap.approved ?? 0;
            // "Approved" only once every seeded EXTERNAL-dataset question has
            // actually been signed off (the review workflow never applies to
            // the Core Question Bank sub-origin).
            const allApproved = seeded && pending === 0 && approvedCount === externalQuestions;
            const pediaLabel = allApproved ? 'Approved' : 'Pending';
            const pediaCls = allApproved ? 'dqrs-v--ok' : 'dqrs-v--hold';
            const pediaTxt = seeded
                ? `${approvedCount} of ${externalQuestions} approved by a pediatrician, ${pending} pending`
                : `all ${n} pending — not yet written to the database`;
            const activeTxt = seeded ? `${ap.active ?? 0} active` : 'none active';
            const openItems = rd.openMappingItems || [];
            return `
                <div class="dq-review-status">
                    <div class="dqrs-row"><span class="dqrs-k">Reviewer decision (wording)</span>
                        <span class="dqrs-v dqrs-v--ok">${escapeHtml(rd.decisionLabel || rd.decision)}</span>
                        <span class="dqrs-note">${escapeHtml(rd.round)} &middot; ${escapeHtml(rd.decidedOn)}</span></div>
                    <div class="dqrs-row"><span class="dqrs-k">Pediatrician approval</span>
                        <span class="dqrs-v ${pediaCls}">${pediaLabel}</span>
                        <span class="dqrs-note">${escapeHtml(pediaTxt)}</span></div>
                    <div class="dqrs-row"><span class="dqrs-k">Active in assessments</span>
                        <span class="dqrs-v">${(ap.active ?? 0) > 0 ? 'Yes' : 'No'}</span>
                        <span class="dqrs-note">${escapeHtml(activeTxt)}</span></div>
                    ${openItems.length ? `<div class="dqrs-row"><span class="dqrs-k">Open clinical mapping question</span>
                        <span class="dqrs-v dqrs-v--hold">${escapeHtml(openItems.join(', '))}</span>
                        <span class="dqrs-note">approval of the wording did not settle this &mdash; pediatrician to rule</span></div>` : ''}
                    <p class="dqrs-caveat">${escapeHtml(rd.caveat || '')}</p>
                </div>`;
        }

        // Renders a metadata value, or an explicit "not recorded" marker.
        function provValue(v, formatter) {
            if (v === null || v === undefined || String(v).trim() === '') {
                return '<span class="prov-none">not recorded</span>';
            }
            return escapeHtml(formatter ? formatter(v) : String(v));
        }

        function fmtDate(d) {
            const dt = new Date(d);
            return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleString();
        }

        function fmtDateShort(d) {
            if (!d) return '—';
            const dt = new Date(d);
            if (Number.isNaN(dt.getTime())) return '—';
            return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }

        // ── Dataset Question sources (external datasets ONLY) ────────────────
        // Core Question Bank is NOT part of Dataset Question — it belongs to
        // Pediatrician Question (see services/adminDataSourceView.js). This
        // card only ever describes the dataset_question origin.
        // "Assessment answers recorded" counts assessment DATA collected with
        // these questions — not a question count, and not an ML dataset.
        function renderDatasetUsage(s) {
            const body = document.getElementById('datasetUsageBody');
            if (!body) return;

            const ds = s.datasetQuestion || {};

            // Sources are already newest-first, by a real stored date (see
            // groupDatasetSources() in services/adminDataSourceView.js) —
            // never by array position or a hardcoded "Latest" label.
            const sourceItems = (ds.sources || []).map((src) => {
                const versionText = (src.versions || []).length
                    ? src.versions.map((v) => `${v.version ? escapeHtml(v.version) : '<span class="prov-none">version not recorded</span>'} (${escapeHtml(String(v.items))})`).join(', ')
                    : '<span class="prov-none">version not recorded</span>';
                return `
                <li style="margin-bottom:0.35rem;">
                    <strong>${escapeHtml(src.name)}</strong>
                    · ${escapeHtml(String(src.items))} item(s)
                    · version(s): ${versionText}
                    · latest ${src.latestDate ? escapeHtml(fmtDate(src.latestDate)) : '<span class="prov-none">not recorded</span>'}
                </li>`;
            }).join('');

            const ap = ds.approval || {};
            const pending = ap.pending ?? 0;
            const reviewLine = pending > 0
                ? `<p class="dataset-review-note"><strong>${escapeHtml(String(pending))} dataset question(s) are pending pediatrician approval.</strong>
                   They are not active and are not shown to any parent. Wording was written for KinderCura
                   from the developmental concepts in the sources listed above &mdash; it is not the sources' own
                   questionnaire text, and these sources have not reviewed or endorsed it.</p>`
                : '';

            body.innerHTML = `
                <p style="margin:0 0 0.75rem;font-size:0.82rem;color:var(--text-light);line-height:1.5;">
                    "Dataset Question" is only the <strong>${escapeHtml(String(ds.questions ?? 0))}</strong> question(s) cited to a real
                    external dataset, listed below with their real citation. The Core Question Bank (pediatrician-sourced, no external
                    citation) is a different category &mdash; see <strong>Pediatrician Question</strong>.
                </p>
                <ul style="margin:0;padding-left:1.15rem;font-size:0.88rem;line-height:1.55;">${sourceItems || '<li><span class="prov-none">No sources recorded</span></li>'}</ul>
                <div class="dataset-stats">
                    <div class="dataset-stat"><span class="k">Dataset Question items</span><span class="v">${escapeHtml(String(ds.questions ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Sources cited</span><span class="v">${escapeHtml(String((ds.sources || []).length))}</span></div>
                    <div class="dataset-stat"><span class="k">Pending approval</span><span class="v">${escapeHtml(String(pending))}</span></div>
                    <div class="dataset-stat"><span class="k">Approved</span><span class="v">${escapeHtml(String(ap.approved ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Active in assessments</span><span class="v">${escapeHtml(String(ap.active ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Answered at least once</span><span class="v">${escapeHtml(String(ds.questionsAnswered ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Assessment answers attributable</span><span class="v">${escapeHtml(String(ds.answers ?? 0))}</span></div>
                </div>
                ${reviewerStatusBlock(s)}
                ${reviewLine}`;
        }

        // ── Pediatrician Question Summary (req 11) ───────────────────────────
        // Real pediatrician authors ONLY (from PediaCustomQuestion.pediatricianId)
        // — the Core Question Bank is never listed here as a row, because it has
        // no individual owner to summarize. It still contributes to the tab's
        // total count; see the breakdown line rendered in loadSummary().
        function renderPediaSummary(s) {
            const section = document.getElementById('pediaSummarySection');
            const rowsEl = document.getElementById('pediaSummaryRows');
            if (!section || !rowsEl) return;

            if (currentCategory !== 'pediatrician_question') {
                section.hidden = true;
                return;
            }
            section.hidden = false;

            const pq = s.pediatricianQuestion || {};
            const coreBankQuestions = pq.breakdown?.coreBank?.questions ?? 0;
            const list = pq.pediatricians || [];
            const note = `<tr><td colspan="4" style="padding:0.7rem 0;color:var(--text-light);font-size:0.78rem;border-bottom:1px solid var(--border);">
                Core Question Bank (${escapeHtml(String(coreBankQuestions))} system-wide questions, no individual owner) also
                counts toward the Pediatrician Question tab total, but is not a pediatrician and is not listed as a row here.
            </td></tr>`;

            if (!list.length) {
                rowsEl.innerHTML = note + '<tr><td colspan="4" style="padding:1.2rem;text-align:center;color:var(--text-light);">No pediatrician has entered a question yet.</td></tr>';
                return;
            }
            rowsEl.innerHTML = note + list.map((p) => `
                <tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td style="text-align:right;font-weight:700;">${escapeHtml(String(p.total))}</td>
                    <td style="text-align:right;">${escapeHtml(String(p.active))}</td>
                    <td>${fmtDateShort(p.latestCreatedAt)}</td>
                </tr>`).join('');
        }

        async function loadSummary() {
            try {
                const s = await apiFetch('/admin/data-origin/summary');
                lastSummary = s;

                document.getElementById('sumTotal').textContent = s.total?.questions ?? 0;
                document.getElementById('sumTotalAnswers').textContent = `${s.total?.answers ?? 0} answers`;

                const ds = s.datasetQuestion || {};
                document.getElementById('sumDataset').textContent = ds.questions ?? 0;
                document.getElementById('sumDatasetAnswers').textContent = `${ds.answers ?? 0} answers`;
                document.getElementById('sumDatasetBreakdown').textContent =
                    `${(ds.sources || []).length} external source${(ds.sources || []).length === 1 ? '' : 's'} cited`;

                const pq = s.pediatricianQuestion || {};
                const pqBreakdown = pq.breakdown || {};
                document.getElementById('sumPedia').textContent = pq.questions ?? 0;
                document.getElementById('sumPediaAnswers').textContent = `${pq.answers ?? 0} answers`;
                document.getElementById('sumPediaBreakdown').textContent =
                    `${pqBreakdown.coreBank?.questions ?? 0} Core Question Bank + ${pqBreakdown.pediaAuthored?.questions ?? 0} pediatrician-authored`;
                document.getElementById('sumPediaAuthors').textContent =
                    `${pq.totalAuthors ?? 0} pediatrician author${(pq.totalAuthors ?? 0) === 1 ? '' : 's'}`;

                const latest = ds.latestSource;
                document.getElementById('sumLatestSource').textContent = latest ? latest.name : '—';
                document.getElementById('sumLatestSourceDate').textContent = latest && latest.latestDate
                    ? `Latest: ${fmtDateShort(latest.latestDate)}`
                    : 'No source recorded yet';

                const unclassifiedQ = s.unclassified?.questions ?? 0;
                const unclassifiedA = s.unclassified?.answers ?? 0;
                const card = document.getElementById('unclassifiedCard');
                if (unclassifiedQ > 0 || unclassifiedA > 0) {
                    card.classList.remove('is-hidden');
                    document.getElementById('sumUnclassified').textContent = unclassifiedQ;
                } else {
                    card.classList.add('is-hidden');
                }

                document.getElementById('tabCountDataset').textContent = ` (${ds.questions ?? 0})`;
                document.getElementById('tabCountPedia').textContent = ` (${pq.questions ?? 0})`;
                document.getElementById('tabCountAll').textContent = ` (${(ds.questions ?? 0) + (pq.questions ?? 0)})`;

                renderDatasetUsage(s);
                renderPediaSummary(s);
                renderFilters();
                renderNotice(s);
            } catch (err) {
                console.error('summary load failed', err);
            }
        }

        function renderNotice(s) {
            const el = document.getElementById('originNotice');
            el.style.display = 'none';
            el.innerHTML = '';
        }

        // ── Filter row — contents depend on the active category (req 20) ────
        function renderFilters() {
            const el = document.getElementById('filterRow');
            if (!el || !lastSummary) return;

            const sortOptions = `
                <option value="newest" ${filters.sort === 'newest' ? 'selected' : ''}>Newest First</option>
                <option value="oldest" ${filters.sort === 'oldest' ? 'selected' : ''}>Oldest First</option>`;

            if (currentCategory === 'dataset_question') {
                const sources = (lastSummary.datasetQuestion && lastSummary.datasetQuestion.sources) || [];
                const sourceOptions = sources.map((s) => `<option value="${escapeHtml(s.key)}" ${filters.source === s.key ? 'selected' : ''}>${escapeHtml(s.name)} (${s.items})</option>`).join('');
                const selectedSource = sources.find((s) => s.key === filters.source);
                const versions = selectedSource ? selectedSource.versions : sources.flatMap((s) => s.versions || []);
                const versionOptions = versions.filter((v) => v.version).map((v) => `<option value="${escapeHtml(v.version)}" ${filters.version === v.version ? 'selected' : ''}>${escapeHtml(v.version)} (${v.items})</option>`).join('');

                el.innerHTML = `
                    <div class="filter-group">
                        <label for="filterSource">Dataset / Source</label>
                        <select id="filterSource" onchange="onFilterChange('source', this.value)">
                            <option value="all" ${filters.source === 'all' ? 'selected' : ''}>All Sources</option>
                            ${sourceOptions}
                        </select>
                    </div>
                    <div class="filter-group">
                        <label for="filterVersion">Version</label>
                        <select id="filterVersion" onchange="onFilterChange('version', this.value)">
                            <option value="all" ${filters.version === 'all' ? 'selected' : ''}>All Versions</option>
                            ${versionOptions}
                        </select>
                    </div>
                    <div class="filter-group">
                        <label for="filterDateFrom">From</label>
                        <input type="date" id="filterDateFrom" value="${escapeHtml(filters.dateFrom)}" onchange="onFilterChange('dateFrom', this.value)">
                    </div>
                    <div class="filter-group">
                        <label for="filterDateTo">To</label>
                        <input type="date" id="filterDateTo" value="${escapeHtml(filters.dateTo)}" onchange="onFilterChange('dateTo', this.value)">
                    </div>
                    <div class="filter-group">
                        <label for="filterSort">Sort</label>
                        <select id="filterSort" onchange="onFilterChange('sort', this.value)">${sortOptions}</select>
                    </div>
                    <button class="btn btn-secondary" type="button" onclick="resetFilters()">Reset</button>`;
                return;
            }

            if (currentCategory === 'pediatrician_question') {
                const pediatricians = (lastSummary.pediatricianQuestion && lastSummary.pediatricianQuestion.pediatricians) || [];
                const pediaOptions = pediatricians.map((p) => `<option value="${escapeHtml(p.pediatricianId)}" ${filters.pediatricianId === p.pediatricianId ? 'selected' : ''}>${escapeHtml(p.name)} (${p.total})</option>`).join('');

                el.innerHTML = `
                    <div class="filter-group">
                        <label for="filterPedia">Pediatrician</label>
                        <select id="filterPedia" onchange="onFilterChange('pediatricianId', this.value)">
                            <option value="all" ${filters.pediatricianId === 'all' ? 'selected' : ''}>All Pediatricians</option>
                            ${pediaOptions}
                        </select>
                    </div>
                    <div class="filter-group">
                        <label for="filterDateFrom">From</label>
                        <input type="date" id="filterDateFrom" value="${escapeHtml(filters.dateFrom)}" onchange="onFilterChange('dateFrom', this.value)">
                    </div>
                    <div class="filter-group">
                        <label for="filterDateTo">To</label>
                        <input type="date" id="filterDateTo" value="${escapeHtml(filters.dateTo)}" onchange="onFilterChange('dateTo', this.value)">
                    </div>
                    <div class="filter-group">
                        <label for="filterSort">Sort</label>
                        <select id="filterSort" onchange="onFilterChange('sort', this.value)">${sortOptions}</select>
                    </div>
                    <button class="btn btn-secondary" type="button" onclick="resetFilters()">Reset</button>`;
                return;
            }

            // "All" — categories are mixed, so only a global sort applies.
            el.innerHTML = `
                <div class="filter-group">
                    <label for="filterSort">Sort</label>
                    <select id="filterSort" onchange="onFilterChange('sort', this.value)">${sortOptions}</select>
                </div>
                <button class="btn btn-secondary" type="button" onclick="resetFilters()">Reset</button>`;
        }

        // A source change invalidates any previously-selected version, since
        // versions are scoped to one source.
        function onFilterChange(key, value) {
            filters[key] = value;
            if (key === 'source') filters.version = 'all';
            currentPage = 1;
            if (key === 'source') renderFilters();
            loadList();
        }

        function resetFilters() {
            filters = defaultFilters();
            currentPage = 1;
            renderFilters();
            loadList();
        }

        // ── Table head — columns depend on the active category (req 5/12) ───
        function buildTableHead() {
            const head = document.getElementById('originTableHead');
            if (!head) return;
            if (currentCategory === 'dataset_question') {
                head.innerHTML = `<tr>
                    <th>Question</th><th>Domain</th><th>Source / Dataset</th><th>Version</th>
                    <th>Status</th><th>Created By</th><th>Date Added / Imported</th>
                    <th style="text-align:right;">Times Answered</th>
                </tr>`;
            } else if (currentCategory === 'pediatrician_question') {
                head.innerHTML = `<tr>
                    <th>Question</th><th>Domain</th><th>Pediatrician Owner</th>
                    <th>Created</th><th>Active</th><th style="text-align:right;">Times Answered</th>
                </tr>`;
            } else {
                head.innerHTML = `<tr>
                    <th>Question</th><th>Domain</th><th>Category</th><th>Source</th><th>Version</th>
                    <th>Approval / Status</th><th>Created By</th><th>Created</th>
                    <th style="text-align:right;">Times Answered</th>
                </tr>`;
            }
        }

        function columnCount() {
            if (currentCategory === 'dataset_question') return 8;
            if (currentCategory === 'pediatrician_question') return 6;
            return 9;
        }

        // Source column shared by the Dataset Question tab and the All tab —
        // states the REAL sub-origin plainly. A Core Question Bank row is
        // never given a fabricated external citation (req 6/17/24/25).
        function sourceCell(r) {
            if (r.origin === 'core_bank') {
                return `<div class="src-name">Core Question Bank</div><div class="src-citation">Pediatrician interview &mdash; no external citation</div>`;
            }
            if (!r.sourceCitation) return '<span class="prov-none">—</span>';
            return (r.sourcedFrom ? `<div class="src-name">${escapeHtml(r.sourcedFrom)}</div>` : '')
                + `<div class="src-citation" title="${escapeHtml(r.sourceCitation)}">${escapeHtml(r.sourceCitation)}</div>`
                + (r.generationMethodLabel ? `<div class="src-generation">Our wording: ${escapeHtml(r.generationMethodLabel)}</div>` : '');
        }

        // "Pediatrician Owner" / "Created By" cell for the Pediatrician
        // Question category. A Core Question Bank row states plainly that it
        // has NO individual owner — it is never assigned to a real or
        // invented pediatrician (req: never fake ownership).
        function pediaOwnerCell(r) {
            if (r.origin === 'core_bank') {
                return `<div class="src-name">Core Question Bank</div><div class="prov-inline">System-wide &middot; no individual pediatrician owner</div>`;
            }
            return escapeHtml(r.createdBy);
        }

        function provenanceDetailRow(r, rid, span) {
            if (r.category === 'pediatrician_question' && r.origin === 'core_bank') {
                // Core Question Bank sub-origin — system-wide, no individual
                // owner, no citation, no review workflow. Different shape from
                // a pediatrician-authored row below; never shows a fake owner.
                return `
                <tr class="prov-detail" id="${rid}" hidden>
                    <td colspan="${span}">
                        <dl class="prov-grid">
                            <div><dt>Source</dt><dd>Pediatrician interview &mdash; no external citation</dd></div>
                            <div><dt>Owner</dt><dd>System-wide &mdash; no individual pediatrician owner</dd></div>
                            <div><dt>Minimum Age</dt><dd>${provValue(r.minAgeMonths, (v) => `${v} months`)}</dd></div>
                            <div><dt>Created</dt><dd>${provValue(r.createdAt, fmtDate)}</dd></div>
                            <div><dt>Active</dt><dd>${r.isActive ? 'Yes' : 'No'}</dd></div>
                            <div><dt>Times Answered</dt><dd>${escapeHtml(String(r.timesAnswered ?? 0))}</dd></div>
                        </dl>
                    </td>
                </tr>`;
            }
            if (r.category === 'pediatrician_question') {
                const ageRange = (r.ageMin != null && r.ageMax != null) ? `${r.ageMin}–${r.ageMax} months` : null;
                return `
                <tr class="prov-detail" id="${rid}" hidden>
                    <td colspan="${span}">
                        <dl class="prov-grid">
                            <div><dt>Question Type</dt><dd>${provValue(r.questionType)}</dd></div>
                            <div><dt>Age Range</dt><dd>${provValue(ageRange)}</dd></div>
                            <div><dt>Created</dt><dd>${provValue(r.createdAt, fmtDate)}</dd></div>
                            <div><dt>Active</dt><dd>${r.isActive ? 'Yes' : 'No'}</dd></div>
                            <div><dt>Times Answered</dt><dd>${escapeHtml(String(r.timesAnswered ?? 0))}</dd></div>
                        </dl>
                    </td>
                </tr>`;
            }
            return `
                <tr class="prov-detail" id="${rid}" hidden>
                    <td colspan="${span}">
                        <dl class="prov-grid">
                            <div><dt>Source Reference</dt><dd>${provValue(r.sourceCitation)}</dd></div>
                            <div><dt>Version</dt><dd>${provValue(r.sourceVersion)}</dd></div>
                            <div><dt>Import Date</dt><dd>${provValue(r.importedAt, fmtDate)}</dd></div>
                            <div><dt>Batch ID</dt><dd>${provValue(r.importBatchId)}</dd></div>
                            <div><dt>${r.sourceCitation ? 'External Source' : 'Attribution'}</dt><dd>${provValue(r.sourcedFrom)}</dd></div>
                            <div><dt>Date Added / Imported</dt><dd>${provValue(r.effectiveDate || r.createdAt, fmtDate)}</dd></div>
                            <div><dt>How the wording was produced</dt><dd>${provValue(r.generationMethodLabel)}</dd></div>
                            <div><dt>Reviewer decision (wording)</dt><dd>${r.reviewerDecisionLabel ? escapeHtml(r.reviewerDecisionLabel) + (r.reviewerDecisionRound ? ' — ' + escapeHtml(r.reviewerDecisionRound) : '') : '<span class="prov-none">—</span>'}</dd></div>
                            <div><dt>Pediatrician approval</dt><dd>${provValue(r.approvalStatusLabel)}</dd></div>
                            <div><dt>Approved On</dt><dd>${provValue(r.approvedAt, fmtDate)}</dd></div>
                            <div><dt>Active</dt><dd>${r.isActive ? 'Yes' : 'No'}</dd></div>
                            <div><dt>Open clinical mapping question</dt><dd>${r.hasOpenMappingQuestion ? 'Yes — pediatrician to rule' : (r.approvalStatus ? 'No' : '<span class="prov-none">—</span>')}</dd></div>
                            <div><dt>Used in assessments</dt><dd>${r.isUsableInAssessment ? 'Yes' : 'No'}</dd></div>
                        </dl>
                    </td>
                </tr>`;
        }

        function renderRow(r, i) {
            const rid = `prov-${i}`;
            const span = columnCount();
            const toggle = `<button class="prov-toggle" type="button" aria-expanded="false" aria-controls="${rid}" onclick="toggleProvenance('${rid}', this)" title="Show question details">▸</button>`;
            const questionCell = `
                <td style="min-width:260px;">
                    <div style="font-weight:600;">${toggle}${escapeHtml(r.questionText)}</div>
                    <div class="q-id">${escapeHtml(r.questionId)}</div>
                </td>
                <td>${escapeHtml(r.domain)}${r.displayDomain ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:0.2rem;">${escapeHtml(r.displayDomain)}</div>` : ''}</td>`;

            // Branch on the ACTIVE TAB, not the row's own category — on the
            // "All" tab a row from either category must still render exactly
            // as many <td> as columnCount() says the header has, or every row
            // after a category boundary would drift out of alignment with its
            // column headers.
            let bodyCells;
            if (currentCategory === 'pediatrician_question') {
                bodyCells = `
                    <td>${pediaOwnerCell(r)}</td>
                    <td>${formatDateTime(r.createdAt)}</td>
                    <td>${r.isActive ? 'Yes' : 'No'}</td>
                    <td style="text-align:right;font-weight:700;">${r.timesAnswered ?? 0}</td>`;
            } else if (currentCategory === 'dataset_question') {
                bodyCells = `
                    <td class="src-cell">${sourceCell(r)}</td>
                    <td>${r.sourceVersion ? escapeHtml(r.sourceVersion) : '<span class="prov-none">—</span>'}</td>
                    <td>${approvalCell(r)}</td>
                    <td>${escapeHtml(r.createdBy)}</td>
                    <td>${formatDateTime(r.effectiveDate || r.createdAt)}</td>
                    <td style="text-align:right;font-weight:700;">${r.timesAnswered ?? 0}</td>`;
            } else {
                // "All" tab — one generic 7-cell body shape for every row,
                // whichever category it belongs to. A Pediatrician Question row
                // (Core Question Bank OR pediatrician-authored) shows a dash for
                // Source/Version when it has none, and "Active: Yes/No" in the
                // Approval column (approvalCell()'s null-approvalStatus branch
                // already renders that, never a fabricated "Pending Pediatrician
                // Approval"). Created By uses pediaOwnerCell() so a Core Question
                // Bank row states plainly it has no individual owner.
                bodyCells = `
                    <td>${categoryBadge(r.category)}<div class="prov-inline">${escapeHtml(ORIGIN_SOURCE_KIND[r.origin] || r.sourceKind || '')}</div></td>
                    <td class="src-cell">${sourceCell(r)}</td>
                    <td>${r.sourceVersion ? escapeHtml(r.sourceVersion) : '<span class="prov-none">—</span>'}</td>
                    <td>${approvalCell(r)}</td>
                    <td>${pediaOwnerCell(r)}</td>
                    <td>${formatDateTime(r.effectiveDate || r.createdAt)}</td>
                    <td style="text-align:right;font-weight:700;">${r.timesAnswered ?? 0}</td>`;
            }

            return `<tr>${questionCell}${bodyCells}</tr>${provenanceDetailRow(r, rid, span)}`;
        }

        async function loadList() {
            const rowsEl = document.getElementById('originRows');
            const span = columnCount();
            rowsEl.innerHTML = `<tr><td colspan="${span}" style="padding:2rem;text-align:center;color:var(--text-light);">Loading…</td></tr>`;

            try {
                const params = new URLSearchParams({ category: currentCategory, page: currentPage, limit: PAGE_LIMIT, sort: filters.sort });
                if (currentCategory === 'dataset_question') {
                    if (filters.source !== 'all') params.set('source', filters.source);
                    if (filters.version !== 'all') params.set('version', filters.version);
                }
                if (currentCategory === 'pediatrician_question' && filters.pediatricianId !== 'all') {
                    params.set('pediatricianId', filters.pediatricianId);
                }
                if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
                if (filters.dateTo) params.set('dateTo', filters.dateTo);

                const data = await apiFetch(`/admin/data-origin/list?${params.toString()}`);
                const rows = data.rows || [];
                lastPagination = data.pagination || null;

                if (!rows.length) {
                    const msg = currentCategory === 'dataset_question'
                        ? 'No Dataset Question matches this filter.'
                        : currentCategory === 'pediatrician_question'
                            ? 'No Pediatrician Question matches this filter.'
                            : 'No questions found for this filter.';
                    rowsEl.innerHTML = `<tr><td colspan="${span}" style="padding:2rem;text-align:center;color:var(--text-light);line-height:1.6;">${msg}</td></tr>`;
                } else {
                    rowsEl.innerHTML = rows.map((r, i) => renderRow(r, i)).join('');
                }

                renderPagination();
            } catch (err) {
                rowsEl.innerHTML = `<tr><td colspan="${span}" style="padding:2rem;text-align:center;color:var(--status-attention-fg);">${escapeHtml(err.message)}</td></tr>`;
            }
        }

        function renderPagination() {
            const p = lastPagination;
            const info = document.getElementById('pageInfo');
            const prev = document.getElementById('prevBtn');
            const next = document.getElementById('nextBtn');
            if (!p) {
                info.textContent = '—';
                return;
            }
            const start = p.total === 0 ? 0 : (p.page - 1) * p.limit + 1;
            const end = Math.min(p.page * p.limit, p.total);
            info.textContent = `Showing ${start}–${end} of ${p.total} question${p.total === 1 ? '' : 's'} (page ${p.page} of ${p.totalPages})`;
            prev.disabled = !p.hasPrev;
            next.disabled = !p.hasNext;
            prev.style.opacity = p.hasPrev ? '1' : '0.5';
            next.style.opacity = p.hasNext ? '1' : '0.5';
        }

        // Swaps the table (and its filters/columns) without reloading the page.
        // Filters reset on every tab change (req 21) — a Pediatrician filter
        // must never silently carry over onto the Dataset Question tab.
        function setCategory(category) {
            if (currentCategory === category) return;
            currentCategory = category;
            currentPage = 1;
            filters = defaultFilters();
            document.querySelectorAll('.origin-tab').forEach((tab) => {
                tab.classList.toggle('active', tab.dataset.category === category);
            });
            buildTableHead();
            renderFilters();
            renderPediaSummary(lastSummary || {});
            loadList();
        }

        // Expand/collapse the provenance detail row. Kept as a plain global so
        // the inline onclick in loadList() resolves, matching setCategory/changePage.
        function toggleProvenance(rowId, btn) {
            const row = document.getElementById(rowId);
            if (!row) return;
            const open = row.hasAttribute('hidden');
            if (open) row.removeAttribute('hidden');
            else row.setAttribute('hidden', '');
            if (btn) {
                btn.textContent = open ? '▾' : '▸';
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
        }

        function changePage(delta) {
            if (!lastPagination) return;
            const next = currentPage + delta;
            if (next < 1 || next > lastPagination.totalPages) return;
            currentPage = next;
            loadList();
        }

        async function loadAll() {
            buildTableHead();
            await Promise.all([loadSummary(), loadList()]);
        }

        // ================================================================
        // Model dataset pipeline (Requirement B)
        //
        // Generate -> clean -> send to model. "Send to Model" deliberately
        // POSTs to /admin/training/:id/train — the SAME endpoint the Training
        // page's Process button uses — so the synthetic dataset goes through
        // the one existing training path, gets the same candidate-model
        // lifecycle, and there is no second implementation to drift.
        //
        // Everything rendered here comes from a stored pipeline report or a
        // TrainedModel document. No number on this panel is computed for
        // display, defaulted, or shown when the underlying value is absent.
        // ================================================================

        let pipelineState = { datasetId: null, datasetStatus: null };
        let pipelinePollTimer = null;

        function num(value) {
            return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '—';
        }

        function pipelineMessage(text, kind) {
            const el = document.getElementById('pipelineMessage');
            if (!el) return;
            if (!text) { el.hidden = true; el.textContent = ''; return; }
            el.className = 'pipeline-message is-' + (kind || 'info');
            el.textContent = text;
            el.hidden = false;
        }

        function setPipelineBusy(busy) {
            const spinner = document.getElementById('pipelineBusy');
            const genBtn = document.getElementById('pipelineGenerateBtn');
            if (spinner) spinner.hidden = !busy;
            if (genBtn) genBtn.disabled = busy;
            // The train button is additionally gated on there being a dataset
            // that has not already been trained — see renderPipeline().
            const trainBtn = document.getElementById('pipelineTrainBtn');
            if (trainBtn && busy) trainBtn.disabled = true;
        }

        function statusChipFor(status) {
            const map = {
                uploaded: ['pipeline-chip--idle', 'Ready to train'],
                registered: ['pipeline-chip--idle', 'Registered'],
                training: ['pipeline-chip--warn', 'Training…'],
                trained: ['pipeline-chip--ok', 'Trained'],
                failed: ['pipeline-chip--bad', 'Failed'],
                completed: ['pipeline-chip--ok', 'Completed'],
                pending: ['pipeline-chip--idle', 'Pending'],
            };
            const [cls, label] = map[status] || ['pipeline-chip--idle', status || 'Unknown'];
            return `<span class="pipeline-chip ${cls}">${escapeHtml(label)}</span>`;
        }

        function renderCleaning(cleaning) {
            if (!cleaning) return '';
            const stats = [
                ['Original records', cleaning.originalRecords],
                ['Valid records', cleaning.validRecords],
                ['Invalid records', cleaning.invalidRecords],
                ['Duplicates removed', cleaning.duplicatesRemoved],
                ['Final training records', cleaning.finalRecords],
            ].map(([k, v]) => `<div class="dataset-stat"><span class="k">${k}</span><span class="v">${num(v)}</span></div>`).join('');

            const reasons = cleaning.rejectionsByReason || {};
            const reasonRows = Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]).map((reason) => `
                <tr><td>${escapeHtml(reason.replace(/_/g, ' '))}</td><td class="num">${num(reasons[reason])}</td></tr>`).join('');

            const filled = cleaning.missingValuesFilled || {};
            const filledRows = Object.keys(filled).map((column) => {
                const info = filled[column] || {};
                return `<tr><td>${escapeHtml(column)} <span style="color:var(--text-light);">(${escapeHtml(info.strategy || 'imputed')})</span></td><td class="num">${num(info.filled)}</td></tr>`;
            }).join('');

            const dist = cleaning.classDistribution || {};
            const distText = Object.keys(dist).length
                ? Object.keys(dist).map((k) => `${escapeHtml(k)} ${num(dist[k])}`).join(' · ')
                : '—';

            const norm = cleaning.normalization || {};
            const warnings = Array.isArray(cleaning.warnings) && cleaning.warnings.length
                ? `<p class="pipeline-message is-error" style="margin-top:0.8rem;">${cleaning.warnings.map(escapeHtml).join(' ')}</p>`
                : '';

            // The reconciliation line. Shown because "invalid: 651" means
            // nothing on its own — being able to check that the four numbers
            // add up is what makes the cleaning report verifiable.
            const closes = Number(cleaning.originalRecords) - Number(cleaning.duplicatesRemoved)
                - Number(cleaning.invalidRecords) === Number(cleaning.finalRecords);

            return `
                <div class="pipeline-section">
                    <h4>Cleaning &amp; preprocessing</h4>
                    <p class="sub">Counted during the actual preprocessing run (<code>ml/preprocess.py</code>).</p>
                    <div class="dataset-stats">${stats}</div>
                    <div class="pipeline-equation">
                        <code>${num(cleaning.originalRecords)} original − ${num(cleaning.duplicatesRemoved)} duplicates − ${num(cleaning.invalidRecords)} invalid = ${num(cleaning.finalRecords)} training-ready</code>
                        ${closes ? '' : ' <strong style="color:var(--status-attention-fg);">— these do not reconcile; investigate before using this dataset.</strong>'}
                    </div>
                    ${reasonRows ? `<table class="pipeline-table"><thead><tr><th>Rejected because</th><th class="num">Rows</th></tr></thead><tbody>${reasonRows}</tbody></table>` : ''}
                    ${filledRows ? `<table class="pipeline-table"><thead><tr><th>Missing values filled</th><th class="num">Rows</th></tr></thead><tbody>${filledRows}</tbody></table>` : ''}
                    <p class="sub" style="margin-top:0.85rem;">Class distribution: ${distText}</p>
                    <p class="sub">Normalization: ${norm.applied ? escapeHtml(norm.method || 'applied') : 'not applied'}${norm.applied ? '' : ' — the classifier is a random forest and is scale-invariant, so rescaling would change nothing about the fitted model.'}</p>
                    ${warnings}
                </div>`;
        }

        function renderGeneration(generator) {
            if (!generator) return '';
            const injected = generator.injectedDefects || {};
            const injectedTotal = Object.keys(injected).reduce((sum, k) => sum + Number(injected[k] || 0), 0);
            const injectedText = injectedTotal
                ? Object.keys(injected).filter((k) => injected[k]).map((k) => `${escapeHtml(k.replace(/_/g, ' '))} ${num(injected[k])}`).join(' · ')
                : 'none';
            return `
                <div class="pipeline-section">
                    <h4>Generation</h4>
                    <p class="sub">Reproducible: the same seed and record count always produce the same dataset.</p>
                    <div class="dataset-stats">
                        <div class="dataset-stat"><span class="k">Requested records</span><span class="v">${num(generator.requestedRows)}</span></div>
                        <div class="dataset-stat"><span class="k">Rows written</span><span class="v">${num(generator.generatedRows)}</span></div>
                        <div class="dataset-stat"><span class="k">Seed</span><span class="v">${escapeHtml(String(generator.seed ?? '—'))}</span></div>
                    </div>
                    <p class="sub" style="margin-top:0.85rem;">
                        Deliberately injected data-quality faults (${num(injectedTotal)} total): ${injectedText}.
                        These exist so the cleaning counts above measure something real rather than always reading zero.
                    </p>
                </div>`;
        }

        function renderModel(model) {
            if (!model) {
                return `
                    <div class="pipeline-section">
                        <h4>Model</h4>
                        <p class="sub">This dataset has not been sent to the model yet. Metrics appear here only after a training run actually produces them.</p>
                    </div>`;
            }
            if (model.status !== 'completed') {
                return `
                    <div class="pipeline-section">
                        <h4>Model v${escapeHtml(String(model.version))} ${statusChipFor(model.status)}</h4>
                        <p class="sub">${model.errorMessage ? escapeHtml(model.errorMessage) : 'Training is in progress. No metrics exist until it finishes.'}</p>
                    </div>`;
            }
            const pct = (v) => (Number.isFinite(Number(v)) ? (Number(v) * 100).toFixed(2) + '%' : '—');
            return `
                <div class="pipeline-section">
                    <h4>Model v${escapeHtml(String(model.version))} ${statusChipFor(model.status)} ${model.isActive ? '<span class="pipeline-chip pipeline-chip--ok">Active</span>' : '<span class="pipeline-chip pipeline-chip--idle">Candidate</span>'}</h4>
                    <p class="sub">Metrics measured by <code>ml/trainer.py</code> on its held-out test split. Feature set: ${escapeHtml(model.featureSetType || '—')}.</p>
                    <div class="dataset-stats">
                        <div class="dataset-stat"><span class="k">Accuracy</span><span class="v">${pct(model.accuracy)}</span></div>
                        <div class="dataset-stat"><span class="k">Precision</span><span class="v">${pct(model.precision)}</span></div>
                        <div class="dataset-stat"><span class="k">Recall</span><span class="v">${pct(model.recall)}</span></div>
                        <div class="dataset-stat"><span class="k">F1 score</span><span class="v">${pct(model.f1Score)}</span></div>
                        <div class="dataset-stat"><span class="k">Training rows</span><span class="v">${num(model.trainingSamples)}</span></div>
                        <div class="dataset-stat"><span class="k">Test rows</span><span class="v">${num(model.testSamples)}</span></div>
                    </div>
                    <p class="sub" style="margin-top:0.85rem;">
                        Trained ${escapeHtml(formatDateTime(model.trainedAt))} on ${num(model.totalRows)} rows.
                        Classes: ${(model.classNames || []).map(escapeHtml).join(', ') || '—'}.
                    </p>
                </div>`;
        }

        function renderPipeline(data) {
            const body = document.getElementById('pipelineBody');
            if (!body) return;

            const envWarn = document.getElementById('pipelineEnvWarning');
            if (envWarn) {
                if (data.environment && data.environment.ready === false) {
                    envWarn.innerHTML = `<strong>Dataset generation is unavailable on this server.</strong><p style="margin:0.5rem 0 0;font-size:0.85rem;white-space:pre-wrap;">${escapeHtml(data.environment.error || '')}</p>`;
                    envWarn.hidden = false;
                    const genBtn = document.getElementById('pipelineGenerateBtn');
                    if (genBtn) genBtn.disabled = true;
                } else {
                    envWarn.hidden = true;
                }
            }

            const dataset = data.dataset;
            pipelineState.datasetId = dataset ? dataset.id : null;
            pipelineState.datasetStatus = dataset ? dataset.status : null;

            const trainBtn = document.getElementById('pipelineTrainBtn');
            if (trainBtn) {
                trainBtn.disabled = !dataset || dataset.status === 'training' || dataset.status === 'trained';
                trainBtn.textContent = dataset && dataset.status === 'trained' ? 'Already Trained' : 'Send to Model';
            }

            if (!dataset) {
                body.innerHTML = '<p style="color:var(--text-light);">No model dataset has been generated yet. Choose a record count above and select <strong>Generate &amp; Clean</strong>.</p>';
                return;
            }

            const pipeline = dataset.pipeline || {};
            const sizeMb = dataset.fileSize ? (dataset.fileSize / (1024 * 1024)).toFixed(2) + ' MB' : '—';

            body.innerHTML = `
                <div class="pipeline-section" style="border-top:none;margin-top:0.4rem;padding-top:0;">
                    <h4>Current dataset ${statusChipFor(dataset.status)}</h4>
                    <p class="sub">Version <code>${escapeHtml(pipeline.datasetVersion || '—')}</code> · generated ${escapeHtml(formatDateTime(dataset.uploadedAt))} by ${escapeHtml(dataset.uploadedByName || 'Admin')} · ${sizeMb}</p>
                    <div class="dataset-stats">
                        <div class="dataset-stat"><span class="k">Training-ready records</span><span class="v">${num(dataset.rowCount)}</span></div>
                        <div class="dataset-stat"><span class="k">Columns</span><span class="v">${num(dataset.columnCount)}</span></div>
                        <div class="dataset-stat"><span class="k">Provenance</span><span class="v" style="font-size:0.95rem;">${escapeHtml((dataset.provenance && dataset.provenance.sourceType) || 'unknown')}</span></div>
                    </div>
                    ${dataset.errorMessage ? `<p class="pipeline-message is-error" style="margin-top:0.8rem;">${escapeHtml(dataset.errorMessage)}</p>` : ''}
                </div>
                ${renderGeneration(pipeline.generator)}
                ${renderCleaning(pipeline.cleaning)}
                ${renderModel(data.model)}
                <p class="sub" style="margin-top:1.2rem;">
                    ${num(data.pipelineDatasetCount)} pipeline dataset(s) recorded in total. Full history is on the
                    <a href="/admin/admin-training.html">Training</a> page.
                </p>`;
        }

        async function loadPipelineStatus() {
            try {
                const data = await apiFetch('/admin/dataset-pipeline/status');
                renderPipeline(data);
                // Keep polling only while a training run is genuinely in flight.
                if (data.dataset && data.dataset.status === 'training') startPipelinePoll();
                else stopPipelinePoll();
            } catch (err) {
                const body = document.getElementById('pipelineBody');
                if (body) body.innerHTML = `<p style="color:var(--status-attention-fg);">Could not load pipeline status: ${escapeHtml(err.message)}</p>`;
            }
        }

        function startPipelinePoll() {
            if (pipelinePollTimer) return;
            pipelinePollTimer = setInterval(loadPipelineStatus, 5000);
        }

        function stopPipelinePoll() {
            if (!pipelinePollTimer) return;
            clearInterval(pipelinePollTimer);
            pipelinePollTimer = null;
        }

        async function generateModelDataset() {
            const rows = Number(document.getElementById('pipelineRows').value);
            const seed = Number(document.getElementById('pipelineSeed').value);
            const defectRate = Number(document.getElementById('pipelineDefectRate').value);

            if (!Number.isFinite(rows) || rows < 100) {
                pipelineMessage('Enter at least 100 records.', 'error');
                return;
            }
            if (!confirm(`Generate and clean ${rows.toLocaleString('en-US')} synthetic assessment records?\n\nThis creates ML training data only — no user accounts, children or assessments.`)) return;

            pipelineMessage(`Generating ${rows.toLocaleString('en-US')} records and cleaning them. This can take a minute for large datasets.`, 'info');
            setPipelineBusy(true);
            try {
                const res = await apiFetch('/admin/dataset-pipeline/generate', {
                    method: 'POST',
                    body: JSON.stringify({ rows, seed, defectRate }),
                });
                const cleaning = (res.pipeline && res.pipeline.cleaning) || {};
                pipelineMessage(
                    `Dataset ${res.datasetVersion} ready: ${num(cleaning.originalRecords)} generated, ` +
                    `${num(cleaning.duplicatesRemoved)} duplicates removed, ${num(cleaning.invalidRecords)} invalid rejected, ` +
                    `${num(cleaning.finalRecords)} training-ready. Select "Send to Model" to train.`,
                    'success'
                );
            } catch (err) {
                pipelineMessage('Generation failed: ' + err.message, 'error');
            } finally {
                setPipelineBusy(false);
                await loadPipelineStatus();
            }
        }

        async function sendDatasetToModel() {
            if (!pipelineState.datasetId) return;
            if (!confirm('Send this dataset to the model and start training?\n\nTraining produces a CANDIDATE model. It does not change which model live assessments use until an admin activates it on the Training page.')) return;

            setPipelineBusy(true);
            pipelineMessage('Training started. Metrics appear here when the run finishes.', 'info');
            try {
                // The existing training endpoint — the same one the Training
                // page's Process button calls. No second training path exists.
                await apiFetch(`/admin/training/${pipelineState.datasetId}/train`, { method: 'POST' });
                startPipelinePoll();
            } catch (err) {
                pipelineMessage('Could not start training: ' + err.message, 'error');
            } finally {
                setPipelineBusy(false);
                await loadPipelineStatus();
            }
        }

        // ================================================================
        // System demo data (Requirement A) — read-only verification
        // ================================================================

        async function loadDemoDataSummary() {
            const body = document.getElementById('demoDataBody');
            if (!body) return;
            try {
                const data = await apiFetch('/admin/demo-data/summary');
                const c = data.collections || {};
                const labels = {
                    users: 'Users', children: 'Children', assessments: 'Assessments',
                    results: 'Assessment results', answers: 'Assessment answers', appointments: 'Appointments',
                };
                const rows = Object.keys(labels).filter((k) => c[k]).map((k) => `
                    <tr>
                        <td>${labels[k]}</td>
                        <td class="num">${num(c[k].total)}</td>
                        <td class="num">${num(c[k].synthetic)}</td>
                        <td class="num">${num(c[k].real)}</td>
                    </tr>`).join('');

                const roles = data.roles || {};
                const roleRows = Object.keys(roles).sort().map((role) => `
                    <tr>
                        <td>${escapeHtml(role)}</td>
                        <td class="num">${num(roles[role].synthetic)}</td>
                        <td class="num">${num(roles[role].real)}</td>
                    </tr>`).join('');

                const req = data.requirement || {};
                const met = req.met === true;

                body.innerHTML = `
                    <div class="pipeline-equation">
                        <strong>${escapeHtml(req.label || '')}:</strong>
                        ${num(req.actual)} user record(s)
                        <span class="pipeline-chip ${met ? 'pipeline-chip--ok' : 'pipeline-chip--bad'}">${met ? 'MET' : 'NOT MET'}</span>
                        <br>Evaluated against the live database each time this panel loads &mdash; not a stored or asserted value.
                    </div>
                    <table class="pipeline-table">
                        <thead><tr><th>Collection</th><th class="num">Total</th><th class="num">Synthetic</th><th class="num">Real</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <div class="pipeline-section">
                        <h4>User roles</h4>
                        <p class="sub">Synthetic data creates no admin accounts.</p>
                        <table class="pipeline-table">
                            <thead><tr><th>Role</th><th class="num">Synthetic</th><th class="num">Real</th></tr></thead>
                            <tbody>${roleRows}</tbody>
                        </table>
                    </div>
                    <p class="sub" style="margin-top:1rem;">
                        Batches: ${(data.batches || []).map((b) => `${escapeHtml(b.batch)} (${num(b.users)} users)`).join(', ') || 'none'}.
                        Regenerate with <code>${escapeHtml(data.generatorCommand || '')}</code>; remove with the same script's
                        <code>--purge --yes</code>, which matches <code>isSynthetic: true</code> and can never reach a real record.
                    </p>`;
            } catch (err) {
                body.innerHTML = `<p style="color:var(--status-attention-fg);">Could not load demo data summary: ${escapeHtml(err.message)}</p>`;
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadAll();
            loadPipelineStatus();
            loadDemoDataSummary();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
            }, 30000);
        });
