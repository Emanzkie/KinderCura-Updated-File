requireAuth();

const _u = KC.user();
if (_u && _u.role !== 'admin') window.location.href = '/parent/dashboard.html';

function formatDateTime(ts) {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function formatSummaryDate(ts) {
    if (!ts) return 'No activity';
    return new Date(ts).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
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

        const hasUnread = notifications.some((n) => !n.isRead);
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
                        ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page</p>' : ''}
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

function fileSizeText(bytes) {
    if (!bytes) return '0 KB';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function hasProcessedDataset(dataset) {
    return dataset.status === 'trained' && Boolean(dataset.modelId);
}

function statusChip(dataset) {
    const status = dataset.status;
    let chip = { className: 'status-ready', text: 'Ready' };

    if (status === 'training') chip = { className: 'status-processing', text: 'Processing' };
    else if (status === 'failed') chip = { className: 'status-review', text: 'Needs Review' };
    else if (hasProcessedDataset(dataset)) chip = { className: 'status-processed', text: 'Processed' };

    return `<span class="dataset-status ${chip.className}">${chip.text}</span>`;
}

function categoryLabel(value) {
    const labels = {
        assessment: 'Assessment',
        recommendation: 'Recommendation',
        general: 'General'
    };
    return labels[value] || 'General';
}

function datasetIsReady(dataset) {
    return !['training', 'failed'].includes(dataset.status);
}

function latestDatasetDate(datasets, summary) {
    if (summary.lastUpdated) return summary.lastUpdated;
    return datasets.reduce((latest, dataset) => {
        const value = dataset.updatedAt || dataset.trainedAt || dataset.uploadedAt;
        if (!value) return latest;
        const time = new Date(value).getTime();
        if (!Number.isFinite(time)) return latest;
        return !latest || time > new Date(latest).getTime() ? value : latest;
    }, null);
}

function displayDatasetName(dataset, index) {
    if (dataset.provenance?.isSynthetic) return `Assessment Dataset ${index + 1}`;
    const raw = String(dataset.name || dataset.originalName || '').replace(/\.[^.]+$/, '');
    const cleaned = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || `Assessment Dataset ${index + 1}`;
}

async function loadDatasets() {
    try {
        const data = await apiFetch('/admin/training/datasets');
        const summary = data.summary || {};
        const datasets = Array.isArray(data.datasets) ? data.datasets : [];
        const readyCount = Number.isFinite(summary.ready)
            ? summary.ready
            : datasets.filter(datasetIsReady).length;

        document.getElementById('sumTotal').textContent = summary.total ?? datasets.length;
        document.getElementById('sumReady').textContent = readyCount;
        document.getElementById('sumLastUpdated').textContent = formatSummaryDate(latestDatasetDate(datasets, summary));

        const rowsEl = document.getElementById('datasetRows');
        if (!datasets.length) {
            rowsEl.innerHTML = '<tr><td colspan="6" class="empty-cell">No datasets uploaded yet.</td></tr>';
            return;
        }

        rowsEl.innerHTML = datasets.map((dataset, index) => {
            const displayName = displayDatasetName(dataset, index);
            const sampleFields = Array.isArray(dataset.sampleColumns) && dataset.sampleColumns.length
                ? `<div class="dataset-fields">Fields: ${dataset.sampleColumns.slice(0, 6).map(escapeHtml).join(', ')}${dataset.sampleColumns.length > 6 ? ', ...' : ''}</div>`
                : '';
            const updatedAt = dataset.updatedAt || dataset.trainedAt || dataset.uploadedAt;
            const canProcess = dataset.status !== 'training' && !hasProcessedDataset(dataset);
            const actionLabel = dataset.status === 'failed' ? 'Try Again' : 'Process';
            const processButton = canProcess
                ? `<button class="btn btn-primary dataset-action" onclick="processDataset('${escapeHtml(dataset.id)}')">${actionLabel}</button>`
                : `<button class="btn btn-primary dataset-action" disabled>${dataset.status === 'training' ? 'Processing' : 'Processed'}</button>`;

            return `
                <tr>
                    <td data-label="Dataset">
                        <div class="dataset-name">${escapeHtml(displayName)}</div>
                        <div class="dataset-meta">${escapeHtml(dataset.fileType || 'File')} - ${fileSizeText(dataset.fileSize)}</div>
                        ${sampleFields}
                    </td>
                    <td data-label="Type">${categoryLabel(dataset.targetModule)}<div class="dataset-meta">${escapeHtml(dataset.fileType || '')}</div></td>
                    <td data-label="Records">${dataset.rowCount || 0}<div class="dataset-meta">${dataset.columnCount || 0} fields</div></td>
                    <td data-label="Status">${statusChip(dataset)}</td>
                    <td data-label="Date">
                        <div>${formatDateTime(updatedAt)}</div>
                        <div class="dataset-meta">by ${escapeHtml(dataset.uploadedByName || 'Admin')}</div>
                    </td>
                    <td class="dataset-actions" data-label="Actions">
                        ${processButton}
                        <button class="btn btn-secondary dataset-action delete-action" onclick="deleteDataset('${escapeHtml(dataset.id)}')">Delete</button>
                    </td>
                </tr>`;
        }).join('');
    } catch (err) {
        document.getElementById('datasetRows').innerHTML =
            `<tr><td colspan="6" class="empty-cell error-cell">${escapeHtml(err.message)}</td></tr>`;
    }
}

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
    btn.textContent = 'Uploading...';

    try {
        const fd = new FormData();
        fd.append('dataset', file);
        fd.append('name', document.getElementById('datasetName').value.trim());
        fd.append('targetModule', document.getElementById('targetModule').value);
        fd.append('sourceType', document.getElementById('datasetSourceType').value);
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
        document.getElementById('datasetSourceType').value = 'unknown';
        await loadDatasets();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Upload Dataset';
    }
}

async function processDataset(datasetId) {
    if (!confirm('Process this dataset now?')) return;
    try {
        await apiFetch(`/admin/training/${datasetId}/train`, { method: 'POST' });
        alert('Dataset processing started. The page will update when it finishes.');
        await loadDatasets();
        pollDatasetStatus();
    } catch (err) {
        alert('Could not process dataset: ' + err.message);
        await loadDatasets();
    }
}

let _pollTimer = null;
function pollDatasetStatus() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(async () => {
        const data = await apiFetch('/admin/training/datasets').catch(() => null);
        await loadDatasets();
        if (data && Array.isArray(data.datasets) && !data.datasets.some((dataset) => dataset.status === 'training')) {
            clearInterval(_pollTimer);
            _pollTimer = null;
            await loadModels(); // training just finished — surface the new candidate
        }
    }, 4000);
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

// Template rows are neutral, made-up placeholder values used only to show
// the required file format (columns + risk_category labeling) — they are
// NOT clinically validated examples and must not be treated as real cases.
// gender is intentionally not included: see ml/trainer.py for why it was
// dropped from the ML feature set.
//
// Step 9: these are the assessment's CALCULATED SCORE columns — the minimum
// ml/trainer.py actually requires. A dataset may optionally also include
// one column per KinderCura assessment question (Q01-Q34) for a richer,
// item-level record of what was actually answered; trainer.py ignores any
// column it doesn't need, so extra columns are always safe to include. See
// ml/datasets/kindercura_assessment_dataset.csv and
// ml/datasets/README.md for the full canonical structure (question
// columns, answer encoding, and why risk_category must be an independently
// supplied label — never generated from the scores).
function downloadDatasetTemplate(format) {
    if (format === 'json') {
        const sample = JSON.stringify([
            { communication_score: 80, social_score: 70, cognitive_score: 60, motor_score: 75, overall_score: 71, age_months: 48, risk_category: 'Low' },
            { communication_score: 60, social_score: 55, cognitive_score: 40, motor_score: 50, overall_score: 51, age_months: 36, risk_category: 'Medium' },
            { communication_score: 30, social_score: 25, cognitive_score: 35, motor_score: 28, overall_score: 30, age_months: 30, risk_category: 'High' }
        ], null, 2);
        const blob = new Blob([sample], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'kindercura-dataset-template.json';
        a.click();
        URL.revokeObjectURL(a.href);
        return;
    }

    const sample = 'communication_score,social_score,cognitive_score,motor_score,overall_score,age_months,risk_category\n80,70,60,75,71,48,Low\n60,55,40,50,51,36,Medium\n30,25,35,28,30,30,High\n';
    const blob = new Blob([sample], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kindercura-dataset-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Trained Models (Step 7: explicit model activation) ─────────────────────
// Training (via processDataset() above) only ever produces a CANDIDATE
// model — see routes/admin.js / routes/ml.js / ml/model_manager.js. This
// panel is the only place a candidate becomes the model live predictions
// use, and it always requires an explicit admin confirmation click.

const MODEL_STATE_CHIP = {
    active:       { className: 'status-ready',      text: 'Active' },
    candidate:    { className: 'status-processed',  text: 'Candidate' },
    incompatible: { className: 'status-review',     text: 'Incompatible' },
    training:     { className: 'status-processing', text: 'Training' },
    failed:       { className: 'status-review',     text: 'Failed' },
};

function modelStateChip(lifecycleState) {
    const chip = MODEL_STATE_CHIP[lifecycleState] || { className: 'status-ready', text: lifecycleState || 'Unknown' };
    return `<span class="dataset-status ${chip.className}">${chip.text}</span>`;
}

// Heuristic only (dataset naming convention already used across this
// project — see constants/dataOrigin.js "Core Question Bank" naming notes).
// Never claims a dataset IS clinical data; only flags the ones that clearly
// aren't, so an admin does not mistake a demo model for a validated one.
function formatMetric(value) {
    return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—';
}

async function loadModels() {
    try {
        const data = await apiFetch('/ml/models');
        const models = Array.isArray(data.models) ? data.models : [];
        const rowsEl = document.getElementById('modelRows');

        if (!models.length) {
            rowsEl.innerHTML = '<tr><td colspan="6" class="empty-cell">No trained models yet. Process a dataset above to train one.</td></tr>';
            return;
        }

        rowsEl.innerHTML = models.map((m) => {
            // Step 13: sourceType comes straight from the dataset's own
            // structured provenance field (routes/ml.js /models, joined from
            // TrainingDataset.provenance) — never re-guessed from the name here.
            const sourceLabel = m.sourceType === 'reviewed_assessment'
                ? '<div class="dataset-meta" style="color:var(--primary-dark);font-weight:600;">Reviewed Assessment Data</div>'
                : (m.sourceType === 'synthetic'
                    ? '<div class="dataset-meta" style="color:var(--danger);">Test/Synthetic Data — not clinically validated</div>'
                    : '<div class="dataset-meta">Source not recorded</div>');
            const metrics = m.status === 'completed'
                ? `Acc ${formatMetric(m.accuracy)} · Prec ${formatMetric(m.precision)} · Rec ${formatMetric(m.recall)} · F1 ${formatMetric(m.f1Score)}`
                    + `<div class="dataset-meta">${m.trainingSamples ?? '—'} train / ${m.testSamples ?? '—'} test (of ${m.totalRows ?? '—'} rows, ${m.rowsDropped ?? 0} dropped)</div>`
                : (m.status === 'failed' ? `<span style="color:var(--danger);">${escapeHtml(m.errorMessage || 'Training failed')}</span>` : '—');
            const features = Array.isArray(m.featuresUsed) && m.featuresUsed.length
                ? escapeHtml(m.featuresUsed.join(', '))
                : '—';

            let actionCell;
            if (m.lifecycleState === 'active') {
                actionCell = '<button class="btn btn-secondary dataset-action" disabled>Active</button>';
            } else if (m.lifecycleState === 'candidate') {
                actionCell = `<button class="btn btn-primary dataset-action" onclick="activateModel('${escapeHtml(m.id)}', ${m.version})">Activate</button>`;
            } else if (m.lifecycleState === 'incompatible') {
                actionCell = '<button class="btn btn-secondary dataset-action" disabled title="Uses a feature set the current prediction pipeline no longer supports (e.g. gender).">Cannot Activate</button>';
            } else {
                actionCell = '<button class="btn btn-secondary dataset-action" disabled>—</button>';
            }

            return `
                <tr>
                    <td data-label="Version"><strong>v${m.version}</strong></td>
                    <td data-label="Dataset">
                        ${escapeHtml(m.datasetName)}
                        ${sourceLabel}
                    </td>
                    <td data-label="Status">${modelStateChip(m.lifecycleState)}</td>
                    <td data-label="Metrics">${metrics}</td>
                    <td data-label="Feature Columns"><div class="dataset-fields">${features}</div></td>
                    <td class="dataset-actions" data-label="Actions">${actionCell}</td>
                </tr>`;
        }).join('');
    } catch (err) {
        document.getElementById('modelRows').innerHTML =
            `<tr><td colspan="6" class="empty-cell error-cell">${escapeHtml(err.message)}</td></tr>`;
    }
}

async function activateModel(modelId, version) {
    if (!confirm(`Activate model v${version} for new assessment predictions? This replaces the model currently used for live ML predictions.`)) return;
    try {
        await apiFetch(`/ml/models/${modelId}/activate`, { method: 'POST' });
        await loadModels();
    } catch (err) {
        alert('Could not activate model: ' + err.message);
        await loadModels();
    }
}

// ── Reviewed Assessment Data (Step 10) ──────────────────────────────────────
// Real, pediatrician-reviewed KinderCura assessments (routes/assessments.js
// POST /:assessmentId/ml-label), NOT synthetic. Export is a plain file
// download — it does not register a dataset, train, or activate anything;
// the admin uploads the downloaded file through the existing Upload Dataset
// form above when ready, exactly like any other dataset.

async function loadReviewedSummary() {
    const countEl = document.getElementById('reviewedCount');
    const byLabelEl = document.getElementById('reviewedByLabel');
    try {
        const data = await apiFetch('/admin/training/reviewed-assessments/summary');
        countEl.textContent = data.total ?? 0;
        const byLabel = data.byLabel || {};
        byLabelEl.textContent = data.total
            ? `Low: ${byLabel.Low || 0} · Medium: ${byLabel.Medium || 0} · High: ${byLabel.High || 0}`
            : 'No assessments have been reviewed yet.';
    } catch (err) {
        countEl.textContent = '—';
        byLabelEl.textContent = 'Could not load: ' + err.message;
    }
    loadReviewedQuality();
}

// ── Dataset readiness / quality control (Step 12) ───────────────────────────
// Purely technical characterization of the same reviewed data above ("Is
// this technically suitable for the current ML training pipeline?") — never
// a clinical judgement, never a label change. See routes/admin.js
// buildReviewedAssessmentQualitySummary().
const READINESS_CHIP = {
    ready: { className: 'status-ready', text: 'READY' },
    warning: { className: 'status-processing', text: 'WARNING' },
    not_ready: { className: 'status-review', text: 'NOT READY' },
};

async function loadReviewedQuality() {
    const badge = document.getElementById('readinessBadge');
    const details = document.getElementById('qualityDetails');
    try {
        const q = await apiFetch('/admin/training/reviewed-assessments/quality');
        const chip = READINESS_CHIP[q.readiness.status] || READINESS_CHIP.not_ready;
        badge.className = `dataset-status ${chip.className}`;
        badge.textContent = chip.text;

        const cd = q.classDistribution || {};
        const missingAge = q.ageStatistics?.missingCount ?? 0;
        const reasonsHtml = q.readiness.reasons.length
            ? `<ul style="margin:0.5rem 0 0;padding-left:1.2rem;">${q.readiness.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
            : '<p style="margin:0.5rem 0 0;color:var(--text-light);">No quality concerns detected.</p>';

        details.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.75rem;margin-bottom:0.5rem;">
                <div><strong>${q.eligibleAssessments}</strong> eligible <div class="dataset-meta">of ${q.totalReviewedAssessments} reviewed</div></div>
                <div><strong>${cd.Low?.count ?? 0} / ${cd.Medium?.count ?? 0} / ${cd.High?.count ?? 0}</strong><div class="dataset-meta">Low / Medium / High</div></div>
                <div><strong>${q.duplicateCount}</strong><div class="dataset-meta">Duplicate rows</div></div>
                <div><strong>${missingAge}</strong><div class="dataset-meta">Missing age_months</div></div>
                <div><strong>${q.excludedAssessments}</strong><div class="dataset-meta">Excluded</div></div>
                <div><strong>${q.reviewStatistics?.uniqueReviewers ?? 0}</strong><div class="dataset-meta">Reviewers</div></div>
            </div>
            <p style="margin:0;font-weight:600;">${escapeHtml(chip.text)}${q.readiness.reasons.length ? ' — see notes below:' : '.'}</p>
            ${reasonsHtml}`;
    } catch (err) {
        badge.className = 'dataset-status status-review';
        badge.textContent = 'ERROR';
        details.innerHTML = `<p style="color:var(--danger);margin:0;">${escapeHtml(err.message)}</p>`;
    }
}

async function exportReviewedAssessments() {
    try {
        const res = await fetch(`${API}/admin/training/reviewed-assessments/export`, {
            headers: KC.token() ? { Authorization: `Bearer ${KC.token()}` } : {},
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Export failed (${res.status})`);
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        // Filename mirrors the server's Content-Disposition naming
        // convention (routes/admin.js) so re-uploading it is correctly
        // recognized as reviewed-assessment provenance, not synthetic.
        a.download = `kindercura-reviewed-assessments-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    } catch (err) {
        alert('Could not export reviewed assessments: ' + err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadDatasets();
    loadModels();
    loadReviewedSummary();
    if (typeof loadNotificationCount === 'function') loadNotificationCount();
    setInterval(() => {
        if (typeof loadNotificationCount === 'function') loadNotificationCount();
    }, 30000);
});
