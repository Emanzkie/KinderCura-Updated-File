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
        // The appointment being moved must not block its own slot.
        if (_rescheduleId) params.set('excludeAppointmentId', _rescheduleId);
        const data = await apiFetch(`/appointments/availability/check?${params.toString()}`);
        if (document.getElementById('rDate').value !== date) return;
        appointmentSlotSettings = data.availability?.slotSettings || appointmentSlotSettings;
        // A native date picker cannot grey out weekdays, so a day outside the
        // configured availability is cleared as soon as it is picked.
        if (data.availability?.isDayAvailable === false) {
            document.getElementById('rDate').value = '';
            populateRescheduleTimeOptions([]);
            const days = data.availability.availableDays || [];
            setRescheduleTimeHelp((data.availability.message || 'That date is not available.')
                + (days.length ? ` Your available days: ${days.join(', ')}.` : ''));
            return;
        }
        if (!useStartTimeSlots()) {
            renderRescheduleTimeField();
            setRescheduleTimeHelp('Manual time selection is currently allowed by the admin setting.');
            return;
        }
        // Start times already passed today are not offered either.
        const now = new Date();
        const slots = (data.availability?.availableSlots || []).filter((slot) => new Date(`${date}T${slot}`) >= now);
        populateRescheduleTimeOptions(slots);
        setRescheduleTimeHelp(
            !slots.length
                ? (data.availability?.available === false && data.availability.message ? data.availability.message : 'No open start times on this date. Choose another date.')
                : Array.isArray(data.availability?.breakRanges) && data.availability.breakRanges.length
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
    // Parent-supplied text: callers interpolate these into HTML and data-*
    // attributes, so they are returned already escaped.
    return { child: escapeHtml(child), parent: escapeHtml(parent), age: escapeHtml(age) };
}

// ── Badge ─────────────────────────────────────────────────────────────────────
function badge(status) {
    return `<span class="badge ${status}">${status.charAt(0).toUpperCase()+status.slice(1)}</span>`;
}

// ── Payment section (pediatrician appointment card) ───────────────────────────
function peso(n) {
    const v = Number(n);
    return '₱' + (Number.isFinite(v) ? v : 0).toFixed(2);
}

// Renders "Payment Status / Amount Paid / Payment Method" from the backend
// data. Never shows "Paid" unless the backend-derived status says so.
function paymentSection(a) {
    const status = a.paymentDisplayStatus || a.paymentStatus || 'Unpaid';
    const isPaid = status === 'Paid';
    const amountPaid = isPaid
        ? (a.amountPaid != null ? a.amountPaid : a.totalAmount)
        : (a.amountPaid || 0);
    const method = a.paymentMethodLabel || (isPaid ? 'E-Wallet' : '—');

    const colours = {
        Paid: '#5A7560',
        'Pending Payment': '#3D4738',
        Unpaid: '#3D4738',
        Failed: '#3D4738',
        Expired: '#3D4738',
        Cancelled: '#3D4738',
        Refunded: '#3D4738',
    };
    const colour = colours[status] || 'var(--text-dark)';

    const ref = a.receiptNumber || a.paymentRef || null;
    const rows = [
        `<div><p class="info-label">Payment Status</p><p class="info-val" style="color:${colour};font-weight:700;">${escapeHtml(status)}</p></div>`,
        `<div><p class="info-label">Amount Paid</p><p class="info-val">${peso(amountPaid)}${a.totalAmount ? ` <span style="color:var(--text-light);font-weight:400;">of ${peso(a.totalAmount)}</span>` : ''}</p></div>`,
        `<div><p class="info-label">Payment Method</p><p class="info-val">${escapeHtml(method)}</p></div>`,
    ];
    if (isPaid && ref) {
        rows.push(`<div><p class="info-label">${a.receiptNumber ? 'Receipt No.' : 'Payment Ref'}</p><p class="info-val">${escapeHtml(ref)}</p></div>`);
    }

    return `
        <div class="payment-section" style="margin:0.25rem 0 1rem;padding:0.75rem 0.9rem;background:var(--surface-muted,#FAFAF6);border-radius:10px;">
            <p style="font-weight:700;font-size:0.8rem;color:var(--text-dark);margin:0 0 0.5rem;text-transform:uppercase;letter-spacing:0.03em;">Payment</p>
            <div class="info-grid">${rows.join('')}</div>
        </div>`;
}

// ── Render functions ──────────────────────────────────────────────────────────
function emptyState(msg, icon='<img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">') {
    return `<div class="empty"><p style="font-size:2rem;margin-bottom:0.8rem;">${icon}</p><p style="font-weight:600;">${msg}</p></div>`;
}

function renderUpcoming(apts) {
    const el = document.getElementById('upcoming-pane');
    if (!apts.length) { el.innerHTML = emptyState('No upcoming appointments','<img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'); return; }
    el.innerHTML = apts.map(a => {
        const info = getDisplayInfo(a);
        const isPending  = a.status === 'pending';
        const isApproved = a.status === 'approved';
        return `<div class="appt-card" id="appt-card-${a.id}">
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
                    <p class="info-val">${escapeHtml(a.reason||'General checkup')}</p>
                </div>
                <div>
                    <p class="info-label">Status</p>
                    <p class="info-val">${a.status.charAt(0).toUpperCase()+a.status.slice(1)}</p>
                    ${a.isRescheduled && a.reschedule ? `<p class="info-label" style="margin-top:.3rem;color:var(--primary-dark);font-weight:600;">Rescheduled</p>
                    <p class="info-label">Rescheduled from ${fmtDate(a.reschedule.originalDate)} at ${fmtTime(a.reschedule.originalTime)}</p>` : ''}
                </div>
            </div>
            ${paymentSection(a)}
            ${a.notes ? `<p style="color:var(--text-light);font-size:0.85rem;margin-bottom:1rem;"><img src="/icons/logs.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.notes)}</p>` : ''}
            <div class="action-row">
                ${isPending  ? `<button class="btn btn-primary btn-sm" data-appt-act="approve" data-appt-id="${escapeHtml(a.id)}" data-child="${info.child}"><img src="/icons/approve_completed_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Approve</button>` : ''}
                ${isPending  ? `<button class="btn btn-secondary btn-sm" style="color:var(--danger,#3d4738);border-color:var(--danger,#e8a5a5);" data-appt-act="reject" data-appt-id="${escapeHtml(a.id)}" data-child="${info.child}"><img src="/icons/reject_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Reject</button>` : ''}
                ${isApproved ? `<button class="btn btn-primary btn-sm" data-appt-act="complete" data-appt-id="${escapeHtml(a.id)}" data-child="${info.child}"><img src="/icons/approve_completed_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Mark Completed</button>` : ''}
                ${isApproved ? `<button class="btn btn-secondary btn-sm" data-appt-act="chat" data-appt-id="${escapeHtml(a.id)}"> Chat</button>` : ''}
                <button class="btn btn-secondary btn-sm" data-appt-act="reschedule" data-appt-id="${escapeHtml(a.id)}" data-child="${info.child}" data-parent="${info.parent}"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Reschedule</button>
                <button class="btn btn-secondary btn-sm" data-appt-act="cancel" data-appt-id="${escapeHtml(a.id)}" data-child="${info.child}"><img src="/icons/cancelled_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Cancel</button>
            </div>
        </div>`;
    }).join('');
}

function renderCompleted(apts) {
    const el = document.getElementById('completed-pane');
    if (!apts.length) { el.innerHTML = emptyState('No completed appointments','<img src="/icons/finished_closed_appointments.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'); return; }
    el.innerHTML = apts.map(a => {
        const info = getDisplayInfo(a);
        return `<div class="appt-card" id="appt-card-${a.id}">
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
                <div><p class="info-label">Reason</p><p class="info-val">${escapeHtml(a.reason||'General checkup')}</p></div>
            </div>
            ${paymentSection(a)}
            ${a.notes ? `<p style="color:var(--text-light);font-size:0.85rem;"><img src="/icons/logs.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.notes)}</p>` : ''}
        </div>`;
    }).join('');
}

function renderCancelled(apts) {
    const el = document.getElementById('cancelled-pane');
    if (!apts.length) { el.innerHTML = emptyState('No cancelled or rejected appointments','<img src="/icons/cancelled_mark.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">'); return; }
    el.innerHTML = apts.map(a => {
        const info = getDisplayInfo(a);
        return `<div class="appt-card" id="appt-card-${a.id}">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <p style="font-weight:700;font-size:1rem;color:var(--text-dark);margin:0 0 0.2rem;">${info.child}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0;">Parent: ${info.parent}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0.3rem 0 0;">${fmtDate(a.appointmentDate)} at ${fmtTime(a.appointmentTime)}</p>
                    <p style="color:var(--text-light);font-size:0.82rem;margin:0.2rem 0 0;">Reason: ${escapeHtml(a.reason||'—')}</p>
                </div>
                ${badge(a.status)}
            </div>
            ${paymentSection(a)}
        </div>`;
    }).join('');
}

async function loadAppointments() {
    document.getElementById('upcoming-pane').innerHTML = emptyState('Loading…','<img src="/icons/parent_answer_tracker.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">');
    try {
        const data = await apiFetch('/appointments/pedia');
        const all  = (data.appointments || []).sort((a,b) => (b.id||0)-(a.id||0));
        renderUpcoming(all.filter(a => ['pending','approved'].includes(a.status)));
        renderCompleted(all.filter(a => a.status === 'completed'));
        renderCancelled(all.filter(a => ['cancelled','rejected'].includes(a.status)));
        focusAppointmentFromQuery();
    } catch(e) {
        document.getElementById('upcoming-pane').innerHTML = emptyState('Could not load appointments','<img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️');
        console.error(e);
    }
}

// When opened from a "Payment Received" notification the URL carries
// ?appointmentId=<id>. Switch to whichever tab holds that card, scroll to it,
// and flash a highlight. No-op (page opens normally) when the param is absent
// or the card is not on this pediatrician's list.
function focusAppointmentFromQuery() {
    let id = null;
    try { id = new URLSearchParams(window.location.search).get('appointmentId'); } catch { id = null; }
    if (!id) return;

    const card = document.getElementById(`appt-card-${id}`);
    if (!card) return;

    const pane = card.closest('[id$="-pane"]');
    if (pane && pane.id) {
        const tab = pane.id.replace('-pane', '');
        if (['upcoming', 'completed', 'cancelled'].includes(tab)) switchTab(tab);
    }

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = card.style.boxShadow;
    card.style.transition = 'box-shadow 0.3s ease';
    card.style.boxShadow = '0 0 0 3px var(--primary, #6B8E6F)';
    setTimeout(() => { card.style.boxShadow = prev; }, 2600);
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

function toggleProfileMenu() {
    const m = document.getElementById('profileMenu');
    m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', e => {
    if (!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display = 'none';
});

// Card action buttons carry data-* attributes instead of inline onclick strings,
// so a parent-supplied name can never break out of an attribute or JS string.
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-appt-act]');
    if (!btn) return;
    const { apptAct: act, apptId: id, child = '', parent = '' } = btn.dataset;
    if (act === 'approve') updateStatus(id, 'approved', child);
    else if (act === 'reject') openStatusModal(id, 'rejected', child);
    else if (act === 'complete') openStatusModal(id, 'completed', child);
    else if (act === 'chat') window.location.href = `/pedia/pedia-chat.html?appointmentId=${encodeURIComponent(id)}`;
    else if (act === 'reschedule') openReschedule(id, encodeURIComponent(child), encodeURIComponent(parent));
    else if (act === 'cancel') cancelConfirm(id, encodeURIComponent(child));
});

document.getElementById('rDate').addEventListener('change', loadRescheduleAvailability);

loadRescheduleSlotSettings();
loadAppointments();
loadNotificationCount();
