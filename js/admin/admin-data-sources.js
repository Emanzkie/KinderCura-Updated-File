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
        let currentFilter = 'all';
        let currentPage = 1;
        const PAGE_LIMIT = 15;
        let lastPagination = null;

        // Badge markup for question source types.
        function originBadge(origin, label) {
            const glyphs = { core_bank: '◆', pedia_entry: '✚', dataset: '▣' };
            const known = ['core_bank', 'pedia_entry', 'dataset'];
            const cls = known.includes(origin) ? `origin-${origin}` : 'origin-unknown';
            const glyph = glyphs[origin] || '?';
            const cleanLabel = label === 'Core Bank' ? 'Standard' : label === 'Pedia Entry' ? 'Pediatrician' : label === 'Dataset' ? 'Imported' : (label || origin);
            return `<span class="origin-badge ${cls}"><span class="origin-glyph" aria-hidden="true">${glyph}</span>${escapeHtml(cleanLabel)}</span>`;
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

        // ── Dataset Usage card ──────────────────────────────────────────────
        function renderDatasetUsage(s) {
            const body = document.getElementById('datasetUsageBody');
            if (!body) return;

            const ds = s.dataset || {};
            const usage = s.coreBankUsage || {};

            if (!ds.hasExternalDataset) {
                body.innerHTML = `
                    <div class="dataset-stats">
                        <div class="dataset-stat"><span class="k">Standard bank items</span><span class="v">${escapeHtml(String(usage.questions ?? 0))}</span></div>
                        <div class="dataset-stat"><span class="k">Answered at least once</span><span class="v">${escapeHtml(String(usage.questionsAnswered ?? 0))}</span></div>
                        <div class="dataset-stat"><span class="k">Answers recorded</span><span class="v">${escapeHtml(String(usage.answers ?? 0))}</span></div>
                        <div class="dataset-stat"><span class="k">External sources</span><span class="v">0</span></div>
                    </div>`;
                return;
            }

            // Populated state — when citations exist.
            const sources = (ds.sources || []).map((src) => `
                <li style="margin-bottom:0.35rem;">
                    <strong>${escapeHtml(src.citation)}</strong>
                    ${src.version ? ` — version ${escapeHtml(src.version)}` : ' — <span class="prov-none">version not recorded</span>'}
                    · ${escapeHtml(String(src.items))} item(s)
                    · last import ${src.lastImportedAt ? escapeHtml(fmtDate(src.lastImportedAt)) : '<span class="prov-none">not recorded</span>'}
                </li>`).join('');

            body.innerHTML = `
                <ul style="margin:0;padding-left:1.15rem;font-size:0.88rem;line-height:1.55;">${sources}</ul>
                <div class="dataset-stats">
                    <div class="dataset-stat"><span class="k">Items imported</span><span class="v">${escapeHtml(String(ds.questions ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Answered at least once</span><span class="v">${escapeHtml(String(ds.questionsAnswered ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Answers attributable</span><span class="v">${escapeHtml(String(ds.answers ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">External sources</span><span class="v">${escapeHtml(String((ds.sources || []).length))}</span></div>
                </div>`;
        }

        async function loadSummary() {
            try {
                const s = await apiFetch('/admin/data-origin/summary');

                document.getElementById('sumTotal').textContent = s.total?.questions ?? 0;
                document.getElementById('sumTotalAnswers').textContent = `${s.total?.answers ?? 0} answers`;
                document.getElementById('sumCore').textContent = s.coreBank?.questions ?? 0;
                document.getElementById('sumCoreAnswers').textContent = `${s.coreBank?.answers ?? 0} answers`;
                document.getElementById('sumPedia').textContent = s.pediaEntry?.questions ?? 0;
                document.getElementById('sumPediaAnswers').textContent = `${s.pediaEntry?.answers ?? 0} answers`;

                const unclassifiedQ = s.unclassified?.questions ?? 0;
                const unclassifiedA = s.unclassified?.answers ?? 0;
                const card = document.getElementById('unclassifiedCard');
                if (unclassifiedQ > 0 || unclassifiedA > 0) {
                    card.classList.remove('is-hidden');
                    document.getElementById('sumUnclassified').textContent = unclassifiedA;
                    document.getElementById('sumUnclassifiedAnswers').textContent = 'unspecified origin';
                } else {
                    card.classList.add('is-hidden');
                }

                document.getElementById('sumDataset').textContent = s.dataset?.questions ?? 0;
                document.getElementById('sumDatasetAnswers').textContent = `${s.dataset?.answers ?? 0} answers`;

                document.getElementById('tabCountCore').textContent = ` (${s.coreBank?.questions ?? 0})`;
                document.getElementById('tabCountPedia').textContent = ` (${s.pediaEntry?.questions ?? 0})`;
                document.getElementById('tabCountDataset').textContent = ` (${s.dataset?.questions ?? 0})`;
                document.getElementById('tabCountAll').textContent =
                    ` (${(s.coreBank?.questions ?? 0) + (s.pediaEntry?.questions ?? 0)})`;

                renderDatasetUsage(s);
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

        async function loadList() {
            const rowsEl = document.getElementById('originRows');
            rowsEl.innerHTML = '<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--text-light);">Loading…</td></tr>';

            try {
                const data = await apiFetch(`/admin/data-origin/list?origin=${encodeURIComponent(currentFilter)}&page=${currentPage}&limit=${PAGE_LIMIT}`);
                const rows = data.rows || [];
                lastPagination = data.pagination || null;

                if (!rows.length) {
                    const msg = data.datasetView
                        ? '<strong>No imported dataset questions found.</strong><br>' +
                          '<span style="font-size:0.85rem;">No questions from an external dataset are currently registered in the system.</span>'
                        : 'No questions found for this filter.';
                    rowsEl.innerHTML = `<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--text-light);line-height:1.6;">${msg}</td></tr>`;
                } else {
                    rowsEl.innerHTML = rows.map((r, i) => {
                        const rid = `prov-${i}`;
                        const badge = r.isDataset
                            ? originBadge('dataset', 'Imported')
                            : originBadge(r.origin, r.origin === 'core_bank' ? 'Standard' : r.origin === 'pedia_entry' ? 'Pediatrician' : r.originLabel);
                        return `
                        <tr>
                            <td style="min-width:260px;">
                                <div style="font-weight:600;">
                                    <button class="prov-toggle" type="button"
                                            aria-expanded="false" aria-controls="${rid}"
                                            title="Show question details">▸</button>
                                    ${escapeHtml(r.questionText)}
                                </div>
                                <div class="q-id">${escapeHtml(r.questionId)}</div>
                            </td>
                            <td>
                                ${escapeHtml(r.domain)}
                                ${r.displayDomain ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:0.2rem;">${escapeHtml(r.displayDomain)}</div>` : ''}
                            </td>
                            <td>${badge}</td>
                            <td>${escapeHtml(r.createdBy)}</td>
                            <td>${formatDateTime(r.createdAt)}</td>
                            <td style="text-align:right;font-weight:700;">${r.timesAnswered ?? 0}</td>
                        </tr>
                        <tr class="prov-detail" id="${rid}" hidden>
                            <td colspan="6">
                                <dl class="prov-grid">
                                    <div>
                                        <dt>Source / Citation</dt>
                                        <dd>${provValue(r.sourceCitation)}</dd>
                                    </div>
                                    <div>
                                        <dt>Version</dt>
                                        <dd>${provValue(r.sourceVersion)}</dd>
                                    </div>
                                    <div>
                                        <dt>Import Date</dt>
                                        <dd>${provValue(r.importedAt, fmtDate)}</dd>
                                    </div>
                                    <div>
                                        <dt>Batch ID</dt>
                                        <dd>${provValue(r.importBatchId)}</dd>
                                    </div>
                                    <div>
                                        <dt>Attribution</dt>
                                        <dd>${provValue(r.sourcedFrom)}</dd>
                                    </div>
                                    <div>
                                        <dt>Date Added</dt>
                                        <dd>${provValue(r.createdAt, fmtDate)}</dd>
                                    </div>
                                </dl>
                            </td>
                        </tr>`;
                    }).join('');
                }

                renderPagination();
            } catch (err) {
                rowsEl.innerHTML = `<tr><td colspan="6" style="padding:2rem;text-align:center;color:var(--status-attention-fg);">${escapeHtml(err.message)}</td></tr>`;
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

        // Swaps the table without reloading the page.
        function setFilter(origin) {
            if (currentFilter === origin) return;
            currentFilter = origin;
            currentPage = 1;
            document.querySelectorAll('.origin-tab').forEach((tab) => {
                tab.classList.toggle('active', tab.dataset.origin === origin);
            });
            loadList();
        }

        // Expand/collapse the provenance detail row. Kept as a plain global so
        // the inline onclick in loadList() resolves, matching setFilter/changePage.
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
            await Promise.all([loadSummary(), loadList()]);
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadAll();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
            }, 30000);
        });
