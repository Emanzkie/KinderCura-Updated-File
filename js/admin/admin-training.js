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

function downloadDatasetTemplate(format) {
    if (format === 'json') {
        const sample = JSON.stringify([
            { communication_score: 80, social_score: 70, cognitive_score: 60, motor_score: 75, overall_score: 71, age_months: 48, gender: 'female', risk_category: 'Low' },
            { communication_score: 60, social_score: 55, cognitive_score: 40, motor_score: 50, overall_score: 51, age_months: 36, gender: 'male', risk_category: 'Medium' },
            { communication_score: 30, social_score: 25, cognitive_score: 35, motor_score: 28, overall_score: 30, age_months: 30, gender: 'male', risk_category: 'High' }
        ], null, 2);
        const blob = new Blob([sample], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'kindercura-dataset-template.json';
        a.click();
        URL.revokeObjectURL(a.href);
        return;
    }

    const sample = 'communication_score,social_score,cognitive_score,motor_score,overall_score,age_months,gender,risk_category\n80,70,60,75,71,48,female,Low\n60,55,40,50,51,36,male,Medium\n30,25,35,28,30,30,male,High\n';
    const blob = new Blob([sample], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kindercura-dataset-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

document.addEventListener('DOMContentLoaded', () => {
    loadDatasets();
    if (typeof loadNotificationCount === 'function') loadNotificationCount();
    setInterval(() => {
        if (typeof loadNotificationCount === 'function') loadNotificationCount();
    }, 30000);
});
