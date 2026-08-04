// === Extracted from ADMIN\admin-training.html (script block 1) ===
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
            listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Loading...</p>';

            try {
                const data = await apiFetch('/notifications');
                const notifications = Array.isArray(data.notifications) ? data.notifications : [];

                if (!notifications.length) {
                    listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1.5rem;">No notifications yet.</p>';
                    return;
                }

                const hasUnread = notifications.some(n => !n.isRead);
                const tools = `
                    <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                        ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                        <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:#c0392b;padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
                    </div>`;

                const items = notifications.map((n) => {
                    const dest = notificationDestination(n);
                    const unreadStyle = n.isRead ? '' : 'background:#f0f7f0;border-left:3px solid var(--primary);';
                    const click = dest
                        ? `goToNotificationTarget(${n.id}, '${dest}')`
                        : `markNotificationRead(${n.id})`;

                    return `
                        <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                            <div onclick="${click}" style="flex:1;cursor:pointer;min-width:0;">
                                <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                                <p style="font-size:.82rem;color:#555;margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                                <p style="font-size:.75rem;color:#aaa;margin:0;">${formatDateTime(n.createdAt)}</p>
                                ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                            </div>
                            <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                        </div>`;
                }).join('');

                listEl.innerHTML = tools + items;
            } catch {
                listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Could not load notifications.</p>';
            }
        }

        function closeNotifications() {
            const modal = document.getElementById('notificationsModal');
            if (modal) modal.style.display = 'none';
        }

        function fmtDateTime(value) {
            if (!value) return '—';
            return new Date(value).toLocaleString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        }

        function fileSizeText(bytes) {
            if (!bytes) return '0 KB';
            if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
            return `${(bytes / 1024).toFixed(1)} KB`;
        }

        function statusChip(status) {
            const map = {
                uploaded:  { bg: '#fff3cd', color: '#856404', text: 'Uploaded' },
                // File uploaded and structure recorded — NOT trained. Amber, so
                // it never reads as a success state.
                registered: { bg: '#fff8e5', color: '#7a5c00', text: 'Registered — not trained' },
                training:  { bg: '#e3f0ff', color: '#1a56db', text: '⏳ Training…' },
                // Legacy value on pre-migration rows: set by a path that only
                // registered the file. See scripts/migrate-dataset-status-registered.js.
                trained:   { bg: '#fff8e5', color: '#7a5c00', text: 'Marked trained — no model' },
                completed: { bg: '#dff5e3', color: '#1e6f3f', text: '✅ Trained' },
                failed:    { bg: '#fde8e8', color: '#c0392b', text: '❌ Failed' },
            };
            const s = map[status] || map.uploaded;
            const pulse = status === 'training' ? 'animation:pulse 1.5s infinite;' : '';
            return `<span style="background:${s.bg};color:${s.color};padding:0.3rem 0.75rem;border-radius:20px;font-size:0.78rem;font-weight:700;${pulse}">${s.text}</span>`;
        }

        // Load the whole dataset table and summary cards from the admin API.
        async function loadDatasets() {
            try {
                const data = await apiFetch('/admin/training/datasets');
                const summary = data.summary || {};
                const datasets = data.datasets || [];

                document.getElementById('sumTotal').textContent = summary.total || 0;
                document.getElementById('sumUploaded').textContent = summary.uploaded || 0;
                // Authoritative count of real model artifacts. When datasets are
                // flagged 'trained' but produced no model, say so on the card
                // instead of letting the flag masquerade as a model count.
                document.getElementById('sumTrained').textContent = summary.modelsCompleted ?? summary.trained ?? 0;
                const trainedNote = document.getElementById('sumTrainedNote');
                if (trainedNote) {
                    trainedNote.textContent = summary.flagMismatch
                        ? `0 produced · ${summary.datasetsFlaggedTrained} dataset(s) flagged "trained" with no model`
                        : 'model artifacts produced';
                    trainedNote.style.color = summary.flagMismatch ? '#7a5c00' : 'var(--text-light)';
                }
                document.getElementById('sumRows').textContent = summary.totalRows || 0;

                // Provenance cell. A file is marked synthetic only when it
                // self-declares ('demo', '_style'); otherwise the source reads
                // as unrecorded. Filenames naming a real instrument are shown
                // as an IMITATION of it, never as the instrument itself —
                // 'ecdi2030_style_demo' contains no ECDI2030 data.
                function provenanceCell(d) {
                    const p = d.provenance || {};
                    if (p.isSynthetic) {
                        const imitates = (p.imitates || []).length
                            ? `<div class="prov-imitates">named after ${(p.imitates || []).map(escapeHtml).join(', ')} — <strong>contains none of its data</strong></div>`
                            : '';
                        return `<span class="prov-chip prov-chip-synthetic">Synthetic demo fixture</span>${imitates}`;
                    }
                    if (p.recordedSource) {
                        return `<span class="prov-chip prov-chip-sourced">${escapeHtml(p.recordedSource)}</span>`;
                    }
                    return '<span class="prov-chip prov-chip-none">not recorded</span>';
                }

                const rowsEl = document.getElementById('datasetRows');
                if (!datasets.length) {
                    rowsEl.innerHTML = '<tr><td colspan="9" style="padding:2rem;text-align:center;color:var(--text-light);">No datasets uploaded yet.</td></tr>';
                    return;
                }

                rowsEl.innerHTML = datasets.map((d) => {
                    const columns = d.sampleColumns && d.sampleColumns.length
                        ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:0.35rem;">${d.sampleColumns.join(', ')}</div>`
                        : '';
                    const trainingDetails = d.trainingSummary
                        ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:0.35rem;">${d.trainingSummary}</div>`
                        : '';
                    return `
                        <tr style="border-bottom:1px solid var(--border);vertical-align:top;">
                            <td style="padding:1rem;min-width:220px;">
                                <div style="font-weight:700;">${d.name}</div>
                                <div style="font-size:0.82rem;color:var(--text-light);margin-top:0.2rem;">${d.originalName} · ${fileSizeText(d.fileSize)}</div>
                                ${columns}
                                ${trainingDetails}
                            </td>
                            <td style="padding:1rem;text-transform:capitalize;">${d.targetModule || 'general'}</td>
                            <td style="padding:1rem;">${d.fileType}</td>
                            <td style="padding:1rem;">${d.rowCount || 0}</td>
                            <td style="padding:1rem;">${d.columnCount || 0}</td>
                            <td style="padding:1rem;min-width:170px;">${provenanceCell(d)}</td>
                            <td style="padding:1rem;">${statusChip(d.status)}</td>
                            <td style="padding:1rem;">
                                <div>${fmtDateTime(d.uploadedAt)}</div>
                                <div style="font-size:0.75rem;color:var(--text-light);margin-top:0.2rem;">by ${d.uploadedByName || 'Admin'}</div>
                                ${d.trainedAt ? `<div style="font-size:0.75rem;color:var(--text-light);margin-top:0.35rem;">Trained: ${fmtDateTime(d.trainedAt)}</div>` : ''}
                            </td>
                            <td style="padding:1rem;text-align:center;white-space:nowrap;">
                                <button class="btn btn-primary" style="padding:0.55rem 0.95rem;margin-bottom:0.5rem;${(d.status === 'trained' || d.status === 'registered' || d.status === 'training') ? 'opacity:.65;cursor:not-allowed;' : ''}" ${(d.status === 'trained' || d.status === 'registered' || d.status === 'training') ? 'disabled' : ''} onclick="trainDataset('${d.id}')">${d.status === 'training' ? 'Training…' : (d.status === 'trained' || d.status === 'registered') ? 'Marked as trained' : '🚀 Train Model'}</button><br>
                                ${(d.status === 'trained' || d.status === 'registered') && !d.modelId ? '<div class="prov-chip prov-chip-none" style="margin:0.3rem 0;white-space:normal;max-width:190px;">Marked as trained — no model produced</div>' : ''}
                                ${d.trainingMetrics ? `<div style="font-size:0.72rem;color:#1e6f3f;margin:0.3rem 0;">Acc: ${(d.trainingMetrics.accuracy*100).toFixed(1)}% · F1: ${(d.trainingMetrics.f1*100).toFixed(1)}%</div>` : ''}
                                ${d.errorMessage ? `<div style="font-size:0.72rem;color:#c0392b;margin:0.3rem 0;max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(d.errorMessage)}">${escapeHtml(d.errorMessage.substring(0,60))}</div>` : ''}
                                <button class="btn btn-secondary" style="padding:0.55rem 0.95rem;border-color:#e1b6b6;color:#c0392b;" onclick="deleteDataset('${d.id}')">Delete</button>
                            </td>
                        </tr>`;
                }).join('');
            } catch (err) {
                document.getElementById('datasetRows').innerHTML = `<tr><td colspan="9" style="padding:2rem;text-align:center;color:#c0392b;">${err.message}</td></tr>`;
            }
        }

        // File upload uses FormData because the dataset is a real CSV/JSON file.
        async function uploadDataset() {
            const errEl = document.getElementById('uploadError');
            const okEl = document.getElementById('uploadSuccess');
            errEl.style.display = 'none';
            okEl.style.display = 'none';

            const file = document.getElementById('datasetFile').files[0];
            if (!file) {
                errEl.textContent = 'Please choose a CSV or JSON file first.';
                errEl.style.display = 'block';
                return;
            }

            const btn = document.getElementById('uploadBtn');
            btn.disabled = true;
            btn.textContent = 'Uploading…';

            try {
                const fd = new FormData();
                fd.append('dataset', file);
                fd.append('name', document.getElementById('datasetName').value.trim());
                fd.append('targetModule', document.getElementById('targetModule').value);
                fd.append('notes', document.getElementById('datasetNotes').value.trim());

                const res = await fetch(`${API}/admin/training/upload`, {
                    method: 'POST',
                    headers: KC.token() ? { Authorization: `Bearer ${KC.token()}` } : {},
                    body: fd,
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Upload failed.');

                okEl.textContent = 'Dataset uploaded successfully.';
                okEl.style.display = 'block';
                document.getElementById('datasetName').value = '';
                document.getElementById('datasetNotes').value = '';
                document.getElementById('datasetFile').value = '';
                await loadDatasets();
            } catch (err) {
                errEl.textContent = err.message;
                errEl.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Upload Dataset';
            }
        }

        async function trainDataset(datasetId) {
            if (!confirm('Start ML training on this dataset? This will train a RandomForest model using the Python pipeline.')) return;
            try {
                const result = await apiFetch(`/admin/training/${datasetId}/train`, { method: 'POST' });
                alert(result.message || 'Training started!');
                await loadDatasets();
                // Poll for completion
                pollTrainingStatus();
            } catch (err) {
                alert('Training error: ' + err.message);
                await loadDatasets();
            }
        }

        let _pollTimer = null;
        function pollTrainingStatus() {
            if (_pollTimer) clearInterval(_pollTimer);
            _pollTimer = setInterval(async () => {
                await loadDatasets();
                await loadActiveModel();
                // Stop polling when no datasets are in training state
                const data = await apiFetch('/admin/training/datasets').catch(() => null);
                if (data && data.datasets && !data.datasets.some(d => d.status === 'training')) {
                    clearInterval(_pollTimer);
                    _pollTimer = null;
                }
            }, 4000);
        }

        async function loadActiveModel() {
            try {
                const data = await apiFetch('/ml/model-status');
                const card = document.getElementById('activeModelCard');
                const info = document.getElementById('activeModelInfo');
                if (!data.hasActiveModel) { card.style.display = 'none'; return; }
                card.style.display = 'block';
                const m = data.model;
                info.innerHTML = `
                    <div style="background:var(--bg-primary);padding:1rem;border-radius:10px;text-align:center;">
                        <div style="font-size:0.8rem;color:var(--text-light);">Version</div>
                        <div style="font-size:1.6rem;font-weight:700;color:var(--primary);">v${m.version}</div>
                    </div>
                    <div style="background:var(--bg-primary);padding:1rem;border-radius:10px;text-align:center;">
                        <div style="font-size:0.8rem;color:var(--text-light);">Accuracy</div>
                        <div style="font-size:1.6rem;font-weight:700;color:#27ae60;">${(m.accuracy*100).toFixed(1)}%</div>
                    </div>
                    <div style="background:var(--bg-primary);padding:1rem;border-radius:10px;text-align:center;">
                        <div style="font-size:0.8rem;color:var(--text-light);">Precision</div>
                        <div style="font-size:1.6rem;font-weight:700;color:#2980b9;">${(m.precision*100).toFixed(1)}%</div>
                    </div>
                    <div style="background:var(--bg-primary);padding:1rem;border-radius:10px;text-align:center;">
                        <div style="font-size:0.8rem;color:var(--text-light);">Recall</div>
                        <div style="font-size:1.6rem;font-weight:700;color:#8e44ad;">${(m.recall*100).toFixed(1)}%</div>
                    </div>
                    <div style="background:var(--bg-primary);padding:1rem;border-radius:10px;text-align:center;">
                        <div style="font-size:0.8rem;color:var(--text-light);">F1 Score</div>
                        <div style="font-size:1.6rem;font-weight:700;color:#e67e22;">${(m.f1Score*100).toFixed(1)}%</div>
                    </div>
                    <div style="background:var(--bg-primary);padding:1rem;border-radius:10px;text-align:center;">
                        <div style="font-size:0.8rem;color:var(--text-light);">Samples</div>
                        <div style="font-size:1.6rem;font-weight:700;color:var(--primary);">${m.trainingSamples + m.testSamples}</div>
                    </div>
                `;
            } catch { document.getElementById('activeModelCard').style.display = 'none'; }
        }

        async function deleteDataset(datasetId) {
            if (!confirm('Delete this dataset?')) return;
            try {
                await apiFetch(`/admin/training/${datasetId}`, { method: 'DELETE' });
                await loadDatasets();
            } catch (err) {
                alert('Could not delete dataset: ' + err.message);
            }
        }

        function downloadTrainingTemplate(format) {
            if (format === 'json') {
                const sample = JSON.stringify([
                    { communication_score: 80, social_score: 70, cognitive_score: 60, motor_score: 75, overall_score: 71, age_months: 48, gender: 'female', risk_category: 'Low' },
                    { communication_score: 60, social_score: 55, cognitive_score: 40, motor_score: 50, overall_score: 51, age_months: 36, gender: 'male', risk_category: 'Medium' },
                    { communication_score: 30, social_score: 25, cognitive_score: 35, motor_score: 28, overall_score: 30, age_months: 30, gender: 'male', risk_category: 'High' }
                ], null, 2);
                const blob = new Blob([sample], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'kindercura-training-template.json';
                a.click();
                return;
            }

            const sample = 'communication_score,social_score,cognitive_score,motor_score,overall_score,age_months,gender,risk_category\n80,70,60,75,71,48,female,Low\n60,55,40,50,51,36,male,Medium\n30,25,35,28,30,30,male,High\n';
            const blob = new Blob([sample], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'kindercura-training-template.csv';
            a.click();
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadDatasets();
            loadActiveModel();
            if (typeof loadNotificationCount === 'function') loadNotificationCount();
            setInterval(() => {
                if (typeof loadNotificationCount === 'function') loadNotificationCount();
            }, 30000);
        });
