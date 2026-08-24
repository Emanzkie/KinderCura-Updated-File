// === Extracted from PEDIA\pediatrician-appointments.html (script block 1) ===
const API = window.location.origin + '/api';
// Uses the current site origin so the same code works on localhost and when deployed.
const getToken = () => localStorage.getItem('kc_token');
const getUser  = () => { try { return JSON.parse(localStorage.getItem('kc_user')); } catch { return null; } };
function doLogout() { localStorage.clear(); window.location.href = '/login.html'; }

const _u = getUser();
if (!getToken() || !_u) { window.location.href = '/login.html'; }
else if ((_u.role||'').trim().toLowerCase() !== 'pediatrician') {
    window.location.href = _u.role === 'admin' ? '/admin/admin-dashboard.html' : '/parent/dashboard.html';
}
if (_u) {
    document.getElementById('navWelcome').textContent = `Welcome, Dr. ${_u.firstName}`;
    if (_u.profileIcon && _u.profileIcon.startsWith('/uploads/'))
        document.getElementById('navProfilePic').src = _u.profileIcon;
}

async function apiFetch(ep, opts={}) {
    const res = await fetch(`${API}${ep}`, {
        ...opts,
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${getToken()}`, ...opts.headers }
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `Error ${res.status}`);
    return d;
}

let appointmentSlotSettings = { enforceThirtyMinuteSlots: true, slotMinutes: 60 };

function currentPediatricianId() {
    return _u?.id || _u?._id || '';
}

function useStartTimeSlots() {
    return Boolean(appointmentSlotSettings?.enforceThirtyMinuteSlots);
}

function getRescheduleTimeField() {
    return document.getElementById('rTime');
}

function getRescheduleTimeValue() {
    const field = getRescheduleTimeField();
    return field ? field.value : '';
}

function setRescheduleTimeHelp(message) {
    const help = document.getElementById('rTimeHelp');
    if (help) help.textContent = message;
}

function renderRescheduleTimeField() {
    const wrap = document.getElementById('rTimeField');
    const previousValue = getRescheduleTimeValue();
    if (!wrap) return;

    if (useStartTimeSlots()) {
        wrap.innerHTML = `
            <select id="rTime" disabled>
                <option value="">Select a date to see available start times</option>
            </select>`;
        setRescheduleTimeHelp('Choose a date to see the available start times.');
    } else {
        wrap.innerHTML = '<input type="time" id="rTime" step="60">';
        setRescheduleTimeHelp('Manual time selection is currently allowed by the admin setting.');
    }

    const field = getRescheduleTimeField();
    if (field && previousValue) {
        if (field.tagName === 'INPUT') field.value = previousValue;
        if (field.tagName === 'SELECT' && Array.from(field.options).some((option) => option.value === previousValue)) {
            field.value = previousValue;
        }
    }
}

function populateRescheduleTimeOptions(slots) {
    const field = getRescheduleTimeField();
    const date = document.getElementById('rDate')?.value;
    if (!field || field.tagName !== 'SELECT') return;

    const safeSlots = Array.isArray(slots) ? slots : [];
    field.innerHTML = `<option value="">${date ? (safeSlots.length ? 'Select a start time' : 'No start times available') : 'Select a date to see available start times'}</option>`
        + safeSlots.map((slot) => `<option value="${slot}">${fmtTime(slot)}</option>`).join('');
    field.disabled = !date || !safeSlots.length;
}

async function loadRescheduleSlotSettings() {
    try {
        const data = await apiFetch('/appointments/slot-settings');
        appointmentSlotSettings = data.settings || appointmentSlotSettings;
    } catch {}
    renderRescheduleTimeField();
    if (useStartTimeSlots() && document.getElementById('rDate')?.value) {
        await loadRescheduleAvailability();
    }
}

async function loadRescheduleAvailability() {
    const date = document.getElementById('rDate').value;
    if (!useStartTimeSlots()) return;

    if (!date) {
        populateRescheduleTimeOptions([]);
        setRescheduleTimeHelp('Choose a date to see the available start times.');
        return;
    }

    try {
        const params = new URLSearchParams({
            pediatricianId: currentPediatricianId(),
            date,
        });
        const data = await apiFetch(`/appointments/availability/check?${params.toString()}`);
        appointmentSlotSettings = data.availability?.slotSettings || appointmentSlotSettings;
        if (!useStartTimeSlots()) {
            renderRescheduleTimeField();
            setRescheduleTimeHelp('Manual time selection is currently allowed by the admin setting.');
            return;
        }
        populateRescheduleTimeOptions(data.availability?.availableSlots || []);
        setRescheduleTimeHelp(
            Array.isArray(data.availability?.breakRanges) && data.availability.breakRanges.length
                ? 'Break periods are skipped automatically.'
                : 'Choose one of the available start times.'
        );
    } catch (err) {
        populateRescheduleTimeOptions([]);
        setRescheduleTimeHelp(err.message || 'Could not load reschedule slots.');
    }
}

// ── Date/time helpers ─────────────────────────────────────────────────────────
function fmtDate(d) {
    if (!d) return '—';
    const raw = String(d).split('T')[0];
    const parts = raw.split('-').map(Number);
    if (parts.length === 3 && parts.every(n => !Number.isNaN(n))) {
        return new Date(parts[0], parts[1]-1, parts[2]).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
    }
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return String(d);
    return parsed.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
}
function fmtTime(t) {
    if (!t) return '—';
    var s = String(t);
    if (s.indexOf('T') !== -1 || s.indexOf('Z') !== -1 || s.length > 8) {
        var d = new Date(s);
        if (!isNaN(d.getTime())) {
            var h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2,'0');
            return (h%12||12) + ':' + m + ' ' + (h>=12?'PM':'AM');
        }
    }
    var parts = s.split(':');
    var h = parseInt(parts[0],10), m = String(parts[1]||'00').padStart(2,'0');
    if (isNaN(h)) return s;
    return (h%12||12) + ':' + m + ' ' + (h>=12?'PM':'AM');
}

// Important: normalize appointment display values so the UI still shows the
// correct child/parent names even if the API returns slightly different field names.
function getDisplayInfo(a) {
    const child = [
        [a.childFirstName, a.childLastName].filter(Boolean).join(' ').trim(),
        a.childName,
        a.patientName,
        a.patient,
        a.child?.name,
        [a.child?.firstName, a.child?.lastName].filter(Boolean).join(' ').trim(),
        a.name
    ].find(v => typeof v === 'string' && v.trim()) || 'Unknown Patient';

    const parent = [
        [a.parentFirstName, a.parentLastName].filter(Boolean).join(' ').trim(),
        a.parentName,
        a.parent,
        a.parent?.name,
        [a.parent?.firstName, a.parent?.lastName].filter(Boolean).join(' ').trim()
    ].find(v => typeof v === 'string' && v.trim()) || '—';

    const age = a.childAge || a.age || a.child?.age || '—';
    return { child, parent, age };
}

// ── Badge ─────────────────────────────────────────────────────────────────────
function badge(status) {
    return `<span class="badge ${status}">${status.charAt(0).toUpperCase()+status.slice(1)}</span>`;
}

// ── Render functions ──────────────────────────────────────────────────────────
function emptyState(msg, icon='📭') {
    return `<div class="empty"><p style="font-size:2rem;margin-bottom:0.8rem;">${icon}</p><p style="font-weight:600;">${msg}</p></div>`;
}

function renderUpcoming(apts) {
    const el = document.getElementById('upcoming-pane');
    if (!apts.length) { el.innerHTML = emptyState('No upcoming appointments','<img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'); return; }
    el.innerHTML = apts.map(a => {
        const info = getDisplayInfo(a);
        const isPending  = a.status === 'pending';
        const isApproved = a.status === 'approved';
        return `<div class="appt-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;">
                <div>
                    <p style="font-weight:700;font-size:1rem;color:var(--text-dark);margin:0 0 0.2rem;">${info.child}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0;">Parent: ${info.parent} &nbsp;|&nbsp; Age: ${info.age}</p>
                </div>
                ${badge(a.status)}
            </div>
            <div class="info-grid">
                <div>
                    <p class="info-label">Date</p>
                    <p class="info-val">${fmtDate(a.appointmentDate)}</p>
                </div>
                <div>
                    <p class="info-label">Time</p>
                    <p class="info-val">${fmtTime(a.appointmentTime)}</p>
                </div>
                <div>
                    <p class="info-label">Reason</p>
                    <p class="info-val">${a.reason||'General checkup'}</p>
                </div>
                <div>
                    <p class="info-label">Status</p>
                    <p class="info-val">${a.status.charAt(0).toUpperCase()+a.status.slice(1)}</p>
                </div>
            </div>
            ${a.notes ? `<p style="color:var(--text-light);font-size:0.85rem;margin-bottom:1rem;"><img src="/icons/logs.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${a.notes}</p>` : ''}
            <div class="action-row">
                ${isPending  ? `<button class="btn btn-primary btn-sm" onclick="updateStatus('${a.id}','approved','${info.child}')">✅ Approve</button>` : ''}
                ${isPending  ? `<button class="btn btn-secondary btn-sm" style="color:var(--danger,#e74c3c);border-color:var(--danger,#e74c3c);" onclick="openStatusModal('${a.id}','rejected','${info.child}')">❌ Reject</button>` : ''}
                ${isApproved ? `<button class="btn btn-primary btn-sm" onclick="openStatusModal('${a.id}','completed','${info.child}')">✅ Mark Completed</button>` : ''}
                ${isApproved ? `<button class="btn btn-secondary btn-sm" onclick="window.location.href='/pedia/pedia-chat.html?appointmentId=${a.id}'"> Chat</button>` : ''}
                <button class="btn btn-secondary btn-sm" onclick="openReschedule('${a.id}','${encodeURIComponent(info.child)}','${encodeURIComponent(info.parent)}')"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Reschedule</button>
                <button class="btn btn-secondary btn-sm" onclick="cancelConfirm('${a.id}','${encodeURIComponent(info.child)}')">🚫 Cancel</button>
            </div>
        </div>`;
    }).join('');
}

function renderCompleted(apts) {
    const el = document.getElementById('completed-pane');
    if (!apts.length) { el.innerHTML = emptyState('No completed appointments','✅'); return; }
    el.innerHTML = apts.map(a => {
        const info = getDisplayInfo(a);
        return `<div class="appt-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1rem;">
                <div>
                    <p style="font-weight:700;font-size:1rem;color:var(--text-dark);margin:0 0 0.2rem;">${info.child}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0;">Parent: ${info.parent} &nbsp;|&nbsp; Age: ${info.age}</p>
                </div>
                ${badge('completed')}
            </div>
            <div class="info-grid">
                <div><p class="info-label">Date</p><p class="info-val">${fmtDate(a.appointmentDate)}</p></div>
                <div><p class="info-label">Time</p><p class="info-val">${fmtTime(a.appointmentTime)}</p></div>
                <div><p class="info-label">Reason</p><p class="info-val">${a.reason||'General checkup'}</p></div>
            </div>
            ${a.notes ? `<p style="color:var(--text-light);font-size:0.85rem;"><img src="/icons/logs.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${a.notes}</p>` : ''}
        </div>`;
    }).join('');
}

function renderCancelled(apts) {
    const el = document.getElementById('cancelled-pane');
    if (!apts.length) { el.innerHTML = emptyState('No cancelled or rejected appointments','📭'); return; }
    el.innerHTML = apts.map(a => {
        const info = getDisplayInfo(a);
        return `<div class="appt-card">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <p style="font-weight:700;font-size:1rem;color:var(--text-dark);margin:0 0 0.2rem;">${info.child}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0;">Parent: ${info.parent}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0.3rem 0 0;">${fmtDate(a.appointmentDate)} at ${fmtTime(a.appointmentTime)}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0.2rem 0 0;">Reason: ${a.reason||'—'}</p>
                </div>
                ${badge(a.status)}
            </div>
        </div>`;
    }).join('');
}

async function loadAppointments() {
    document.getElementById('upcoming-pane').innerHTML = emptyState('Loading…','⏳');
    try {
        const data = await apiFetch('/appointments/pedia');
        const all  = (data.appointments || []).sort((a,b) => (b.id||0)-(a.id||0));
        renderUpcoming(all.filter(a => ['pending','approved'].includes(a.status)));
        renderCompleted(all.filter(a => a.status === 'completed'));
        renderCancelled(all.filter(a => ['cancelled','rejected'].includes(a.status)));
    } catch(e) {
        document.getElementById('upcoming-pane').innerHTML = emptyState('Could not load appointments','<img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️');
        console.error(e);
    }
}

// ── Status updates ────────────────────────────────────────────────────────────
async function updateStatus(aptId, status, childName, notes='') {
    try {
        await apiFetch(`/appointments/${aptId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status, notes })
        });
        await loadAppointments();
        await loadNotificationCount();
    } catch(e) { alert('Error: ' + e.message); }
}

let _pendingStatus = null, _pendingAptId = null;

function openStatusModal(aptId, status, childName) {
    _pendingAptId  = aptId;
    _pendingStatus = status;
    const titles = { rejected:'Reject Appointment', completed:'Mark as Completed', cancelled:'Cancel Appointment' };
    document.getElementById('statusModalTitle').textContent = titles[status] || 'Update Status';
    document.getElementById('statusModalSub').textContent   = `Patient: ${childName}`;
    document.getElementById('statusNote').value = '';
    document.getElementById('statusModal').style.display = 'flex';
}

async function confirmStatus() {
    const notes = document.getElementById('statusNote').value.trim();
    closeModal('statusModal');
    await updateStatus(_pendingAptId, _pendingStatus, '', notes);
}

// ── Reschedule ────────────────────────────────────────────────────────────────
let _rescheduleId = null;

function openReschedule(aptId, childName, parentName) {
    _rescheduleId = aptId;
    const safeChild = decodeURIComponent(childName || 'Unknown Patient');
    const safeParent = decodeURIComponent(parentName || '—');
    document.getElementById('rSub').textContent = `Patient: ${safeChild}  |  Parent: ${safeParent}`;
    document.getElementById('rDate').min = new Date().toISOString().split('T')[0];
    ['rDate','rReason','rNote'].forEach(id => document.getElementById(id).value = '');
    loadRescheduleSlotSettings();
    document.getElementById('rescheduleModal').style.display = 'flex';
}

async function confirmReschedule() {
    const date   = document.getElementById('rDate').value;
    const time   = getRescheduleTimeValue();
    const reason = document.getElementById('rReason').value;
    const note   = document.getElementById('rNote').value;
    if (!date)   { alert('Please select a new date.'); return; }
    if (!time)   { alert('Please select a new time.'); return; }
    if (!reason) { alert('Please select a reason.'); return; }
    closeModal('rescheduleModal');
    try {
        await apiFetch(`/appointments/${_rescheduleId}/reschedule`, {
            method: 'POST',
            body: JSON.stringify({ newDate:date, newTime:time, reason, note })
        });
        await loadAppointments();
        await loadNotificationCount();
    } catch(e) { alert('Reschedule error: ' + e.message); }
}

// Important: if the name is missing, use a cleaner fallback in the confirm dialog
// so the pediatrician will not see “Unknown Patient”.
async function cancelConfirm(aptId, childName) {
    const safeChild = decodeURIComponent(childName || '').trim();
    const label = safeChild && safeChild !== 'Unknown Patient' ? safeChild : 'this patient';
    if (!confirm(`Cancel appointment for ${label}?\n\nThe parent will be notified by email.`)) return;
    try {
        await apiFetch(`/appointments/${aptId}/cancel`, { method:'POST' });
        await loadAppointments();
        await loadNotificationCount();
    } catch(e) { alert('Error: ' + e.message); }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
    ['upcoming','completed','cancelled'].forEach(t => {
        document.getElementById(`${t}-pane`).style.display = 'none';
        document.getElementById(`tab-${t}`).classList.remove('active');
    });
    document.getElementById(`${tab}-pane`).style.display = 'block';
    document.getElementById(`tab-${tab}`).classList.add('active');
}

// ── Nav helpers ───────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function formatDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
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
    let role = '';
    try {
        role = String((JSON.parse(localStorage.getItem('kc_user')) || {}).role || '').toLowerCase();
    } catch {}

    const title = String(n?.title || '').toLowerCase();
    const type  = String(n?.type  || '').toLowerCase();
    const msg   = String(n?.message || '').toLowerCase();

    if (role === 'pediatrician') {
        if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
        if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
        if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question answered')) return '/pedia/pedia-questions.html';
        if (title.includes('diagnosis') || msg.includes('diagnosis') || title.includes('recommendation') || msg.includes('recommendation')) return '/pedia/pediatrician-patients.html';
        return '/pedia/pediatrician-dashboard.html';
    }

    if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/parent/chat.html';
    if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/parent/appointments.html';
    if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question assigned') || title.includes('question answered')) return '/parent/custom-questions.html';
    if (title.includes('recommendation') || msg.includes('recommendation')) return '/parent/recommendations.html';
    if (title.includes('result') || title.includes('diagnosis') || msg.includes('diagnosis')) return '/parent/results.html';
    return '/parent/dashboard.html';
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

function toggleProfileMenu() {
    const m = document.getElementById('profileMenu');
    m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', e => {
    if (!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display = 'none';
});

document.getElementById('rDate').addEventListener('change', loadRescheduleAvailability);

loadRescheduleSlotSettings();
loadAppointments();
loadNotificationCount();
