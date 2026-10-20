// Admin Logs page: lists AuditLog entries from GET /api/v2/audit-logs (admin only).
requireAuth();
const _logsUser = KC.user();
if (_logsUser && _logsUser.role !== 'admin') window.location.href = '/parent/dashboard.html';

const LOGS_PAGE_SIZE = 100;
let logsSkip = 0;

// toggleProfileMenu() comes from /api.js.
document.addEventListener('click', (e) => {
    if (!e.target.closest('.profile-btn')) {
        document.getElementById('profileMenu').style.display = 'none';
    }
});

function logsEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function logsActor(actor) {
    if (!actor) return 'System';
    if (typeof actor === 'object') {
        const name = [actor.firstName, actor.lastName].filter(Boolean).join(' ');
        return name ? `${name}${actor.role ? ` (${actor.role.replace(/_/g, ' ')})` : ''}` : 'Deleted user';
    }
    return 'Deleted user';
}

function logsRow(log) {
    const when = log.createdAt
        ? new Date(log.createdAt).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '—';
    const details = log.details ? `<pre>${logsEscape(JSON.stringify(log.details, null, 1))}</pre>` : '';
    return '<tr>' +
        `<td>${logsEscape(when)}</td>` +
        `<td>${logsEscape(logsActor(log.actorId))}</td>` +
        `<td><code>${logsEscape(log.action)}</code>${details}</td>` +
        `<td>${logsEscape(log.targetType || '—')}</td>` +
        '</tr>';
}

async function loadLogs() {
    const state = document.getElementById('logsState');
    const more = document.getElementById('logsMoreBtn');
    more.disabled = true;
    try {
        const data = await apiFetch(`/v2/audit-logs?limit=${LOGS_PAGE_SIZE}&skip=${logsSkip}`);
        const logs = Array.isArray(data.logs) ? data.logs : [];
        if (logs.length) {
            document.getElementById('logsBody').insertAdjacentHTML('beforeend', logs.map(logsRow).join(''));
            document.getElementById('logsTable').hidden = false;
        }
        logsSkip += logs.length;
        state.textContent = logsSkip
            ? `Showing ${logsSkip} log entr${logsSkip === 1 ? 'y' : 'ies'}.`
            : 'No log entries have been recorded yet.';
        more.hidden = logs.length < LOGS_PAGE_SIZE;
    } catch (err) {
        state.textContent = err.message || 'Could not load the logs.';
    } finally {
        more.disabled = false;
    }
}

document.getElementById('logsMoreBtn').addEventListener('click', loadLogs);
loadLogs();
