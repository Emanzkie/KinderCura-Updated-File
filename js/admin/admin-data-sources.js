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

        // The three canonical question origins. Kept in step with
        // constants/dataOrigin.js DATA_ORIGIN_LABELS — the server already sends
        // originLabel, and this is only the fallback when it is absent.
        //
        // Never relabel these, and never merge them:
        //   core_bank        source = our pediatrician interview
        //   dataset_question source = an actual external dataset
        //   pedia_entry      author = a pediatrician working in KinderCura
        //
        // "Standard" is banned — it implies a validated instrument (ASQ, DDST,
        // M-CHAT) we cannot claim. "Dataset Question" is a QUESTION origin and
        // never means ML training data, which lives under Training.
        const ORIGIN_LABELS = {
            core_bank: 'Core Question Bank',
            dataset_question: 'Dataset Question',
            pedia_entry: 'Pediatrician Entry',
        };

        const ORIGIN_SOURCE_KIND = {
            core_bank: 'Pediatrician interview',
            dataset_question: 'External dataset',
            pedia_entry: 'Created by a pediatrician in KinderCura',
        };

        // Badge markup for a question's ORIGIN — always driven by the stored
        // `origin` field, never inferred from provenance or from an answer.
        function originBadge(origin, label) {
            const glyphs = { core_bank: '◆', dataset_question: '▣', pedia_entry: '✚' };
            const cls = ORIGIN_LABELS[origin] ? `origin-${origin}` : 'origin-unknown';
            const glyph = glyphs[origin] || '?';
            const text = label || ORIGIN_LABELS[origin] || origin || 'Unknown';
            return `<span class="origin-badge ${cls}"><span class="origin-glyph" aria-hidden="true">${glyph}</span>${escapeHtml(text)}</span>`;
        }

        // Pediatrician review lifecycle. Applies to Dataset Questions only —
        // for the other two origins the server sends null, which renders as a
        // dash. A dash means "outside this workflow", NEVER "approved".
        const APPROVAL_LABELS = {
            pending_pediatrician_approval: 'Pending Pediatrician Approval',
            approved: 'Approved',
            rejected: 'Rejected',
        };

        // Renders the approval cell. For a Dataset Question this keeps THREE
        // facts visually separate so they can never be read as one:
        //   Reviewer decision   — the wording review round only (catalogue)
        //   Pediatrician approval — the sign-off that gates activation
        //   Active              — whether it is live in an assessment
        // Only a pediatrician "Approved" can make a question eligible to be
        // active; the reviewer decision never does.
        function approvalCell(r) {
            if (!r.approvalStatus) {
                return '<span class="prov-none">—</span>';
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
            const seeded = (dq.questions ?? 0) > 0;
            const pending = ap.pending ?? 0;
            const approvedCount = ap.approved ?? 0;
            // "Approved" only once every seeded question has actually been
            // signed off — a partial batch (or none seeded yet) still reads
            // Pending, matching the per-row cell's own logic in
            // routes/admin.js (approvalStatus === APPROVED per question).
            const allApproved = seeded && pending === 0 && approvedCount === dq.questions;
            const pediaLabel = allApproved ? 'Approved' : 'Pending';
            const pediaCls = allApproved ? 'dqrs-v--ok' : 'dqrs-v--hold';
            const pediaTxt = seeded
                ? `${approvedCount} of ${dq.questions} approved by a pediatrician, ${pending} pending`
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

        // ── Core Question Bank usage + Dataset Question sources ─────────────
        // "Assessment answers recorded" counts assessment DATA collected with
        // these questions — not a question count, and not an ML dataset.
        function renderDatasetUsage(s) {
            const body = document.getElementById('datasetUsageBody');
            if (!body) return;

            const ds = s.datasetQuestion || s.dataset || {};
            const usage = s.coreBankUsage || {};

            if (!ds.hasExternalDataset) {
                body.innerHTML = `
                    <div class="dataset-stats">
                        <div class="dataset-stat"><span class="k">Core Question Bank items</span><span class="v">${escapeHtml(String(usage.questions ?? 0))}</span></div>
                        <div class="dataset-stat"><span class="k">Answered at least once</span><span class="v">${escapeHtml(String(usage.questionsAnswered ?? 0))}</span></div>
                        <div class="dataset-stat"><span class="k">Assessment answers recorded</span><span class="v">${escapeHtml(String(usage.answers ?? 0))}</span></div>
                        <div class="dataset-stat"><span class="k">Dataset Questions</span><span class="v">0</span></div>
                    </div>
                    <p style="margin:0.75rem 0 0;font-size:0.8rem;color:var(--text-light);line-height:1.5;">
                        No Dataset Question has been added yet, so no external source is listed. The Core Question Bank above came from our pediatrician interview &mdash; that is its source, and it is not an external dataset.
                    </p>
                    ${reviewerStatusBlock(s)}`;
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

            // Review lifecycle. "Pending" is stated plainly because a pending
            // question is a CANDIDATE — it is not part of any assessment, and
            // the wording is ours, adapted from the source above, not the
            // source's own item text.
            const ap = ds.approval || {};
            const pending = ap.pending ?? 0;
            const reviewLine = pending > 0
                ? `<p class="dataset-review-note"><strong>${escapeHtml(String(pending))} question(s) are pending pediatrician approval.</strong>
                   They are not active and are not shown to any parent. Wording was written for KinderCura
                   from the developmental concepts in the sources above &mdash; it is not the sources' own
                   questionnaire text, and these sources have not reviewed or endorsed it.</p>`
                : '';

            body.innerHTML = `
                <ul style="margin:0;padding-left:1.15rem;font-size:0.88rem;line-height:1.55;">${sources}</ul>
                <div class="dataset-stats">
                    <div class="dataset-stat"><span class="k">Dataset Questions</span><span class="v">${escapeHtml(String(ds.questions ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Pending approval</span><span class="v">${escapeHtml(String(pending))}</span></div>
                    <div class="dataset-stat"><span class="k">Approved</span><span class="v">${escapeHtml(String(ap.approved ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Active in assessments</span><span class="v">${escapeHtml(String(ap.active ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Answered at least once</span><span class="v">${escapeHtml(String(ds.questionsAnswered ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">Assessment answers attributable</span><span class="v">${escapeHtml(String(ds.answers ?? 0))}</span></div>
                    <div class="dataset-stat"><span class="k">External sources cited</span><span class="v">${escapeHtml(String((ds.sources || []).length))}</span></div>
                </div>
                ${reviewerStatusBlock(s)}
                ${reviewLine}`;
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

                // Dataset Questions are their own origin, counted from `origin`
                // — never core-bank rows that happen to carry a citation.
                const ds = s.datasetQuestion || s.dataset || {};
                document.getElementById('sumDataset').textContent = ds.questions ?? 0;
                document.getElementById('sumDatasetAnswers').textContent = `${ds.answers ?? 0} answers`;

                document.getElementById('tabCountCore').textContent = ` (${s.coreBank?.questions ?? 0})`;
                document.getElementById('tabCountDataset').textContent = ` (${ds.questions ?? 0})`;
                document.getElementById('tabCountPedia').textContent = ` (${s.pediaEntry?.questions ?? 0})`;
                document.getElementById('tabCountAll').textContent =
                    ` (${(s.coreBank?.questions ?? 0) + (ds.questions ?? 0) + (s.pediaEntry?.questions ?? 0)})`;

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
            rowsEl.innerHTML = '<tr><td colspan="9" style="padding:2rem;text-align:center;color:var(--text-light);">Loading…</td></tr>';

            try {
                const data = await apiFetch(`/admin/data-origin/list?origin=${encodeURIComponent(currentFilter)}&page=${currentPage}&limit=${PAGE_LIMIT}`);
                const rows = data.rows || [];
                lastPagination = data.pagination || null;

                if (!rows.length) {
                    const msg = (data.datasetQuestionView ?? data.externalSourceView ?? data.datasetView)
                        ? '<strong>No Dataset Questions found.</strong><br>' +
                          '<span style="font-size:0.85rem;">No question from an external dataset has been added yet. Core Question Bank questions came from our pediatrician interview and are a separate origin &mdash; they are not counted here.</span>'
                        : 'No questions found for this filter.';
                    rowsEl.innerHTML = `<tr><td colspan="9" style="padding:2rem;text-align:center;color:var(--text-light);line-height:1.6;">${msg}</td></tr>`;
                } else {
                    rowsEl.innerHTML = rows.map((r, i) => {
                        const rid = `prov-${i}`;
                        // Origin ALWAYS comes from the stored `origin` field —
                        // never from a citation, an answer, or an author.
                        const badge = originBadge(r.origin, r.originLabel);
                        const kind = r.sourceKind || ORIGIN_SOURCE_KIND[r.origin] || '';
                        // The Origin cell carries only the relationship kind.
                        // The citation itself now has its own column, so it is
                        // not repeated here.
                        const sourceLine = kind
                            ? `<div class="prov-inline">${escapeHtml(kind)}</div>`
                            : '';
                        // Source column. Only a Dataset Question can carry a
                        // citation — the schema refuses to store one on a
                        // core-bank row — so the other origins show a dash
                        // rather than borrowing their origin's description.
                        // Three separate facts, deliberately stacked and
                        // labelled so they can never be read as one claim:
                        //   name      — WHICH external source
                        //   reference — the checkable citation
                        //   wording   — that OUR text is an adaptation of it,
                        //               not the source's own item text
                        const sourceCell = r.sourceCitation
                            ? (r.sourcedFrom ? `<div class="src-name">${escapeHtml(r.sourcedFrom)}</div>` : '')
                              + `<div class="src-citation" title="${escapeHtml(r.sourceCitation)}">${escapeHtml(r.sourceCitation)}</div>`
                              + (r.generationMethodLabel
                                  ? `<div class="src-generation">Our wording: ${escapeHtml(r.generationMethodLabel)}</div>`
                                  : '')
                            : '<span class="prov-none">—</span>';
                        return `
                        <tr>
                            <td style="min-width:260px;">
                                <div style="font-weight:600;">
                                    <button class="prov-toggle" type="button"
                                            aria-expanded="false" aria-controls="${rid}"
                                            onclick="toggleProvenance('${rid}', this)"
                                            title="Show question details">▸</button>
                                    ${escapeHtml(r.questionText)}
                                </div>
                                <div class="q-id">${escapeHtml(r.questionId)}</div>
                            </td>
                            <td>
                                ${escapeHtml(r.domain)}
                                ${r.displayDomain ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:0.2rem;">${escapeHtml(r.displayDomain)}</div>` : ''}
                            </td>
                            <td>${badge}${sourceLine}</td>
                            <td class="src-cell">${sourceCell}</td>
                            <td>${r.sourceVersion ? escapeHtml(r.sourceVersion) : '<span class="prov-none">—</span>'}</td>
                            <td>${approvalCell(r)}</td>
                            <td>${escapeHtml(r.createdBy)}</td>
                            <td>${formatDateTime(r.createdAt)}</td>
                            <td style="text-align:right;font-weight:700;">${r.timesAnswered ?? 0}</td>
                        </tr>
                        <tr class="prov-detail" id="${rid}" hidden>
                            <td colspan="9">
                                <dl class="prov-grid">
                                    <div>
                                        <dt>Source Reference</dt>
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
                                        <dt>${r.sourceCitation ? 'External Source' : 'Attribution (unverified)'}</dt>
                                        <dd>${provValue(r.sourcedFrom)}</dd>
                                    </div>
                                    <div>
                                        <dt>Date Added</dt>
                                        <dd>${provValue(r.createdAt, fmtDate)}</dd>
                                    </div>
                                    <div>
                                        <dt>How the wording was produced</dt>
                                        <dd>${provValue(r.generationMethodLabel)}</dd>
                                    </div>
                                    <div>
                                        <dt>Reviewer decision (wording)</dt>
                                        <dd>${r.reviewerDecisionLabel
                                            ? escapeHtml(r.reviewerDecisionLabel) + (r.reviewerDecisionRound ? ' — ' + escapeHtml(r.reviewerDecisionRound) : '')
                                            : '<span class="prov-none">—</span>'}</dd>
                                    </div>
                                    <div>
                                        <dt>Pediatrician approval</dt>
                                        <dd>${provValue(r.approvalStatusLabel)}</dd>
                                    </div>
                                    <div>
                                        <dt>Approved On</dt>
                                        <dd>${provValue(r.approvedAt, fmtDate)}</dd>
                                    </div>
                                    <div>
                                        <dt>Active</dt>
                                        <dd>${r.isActive ? 'Yes' : 'No'}</dd>
                                    </div>
                                    <div>
                                        <dt>Open clinical mapping question</dt>
                                        <dd>${r.hasOpenMappingQuestion
                                            ? 'Yes — pediatrician to rule'
                                            : (r.approvalStatus ? 'No' : '<span class="prov-none">—</span>')}</dd>
                                    </div>
                                    <div>
                                        <dt>Used in assessments</dt>
                                        <dd>${r.isUsableInAssessment ? 'Yes' : 'No'}</dd>
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
