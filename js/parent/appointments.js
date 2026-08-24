// === Extracted from PARENT\appointments.html (script block 1) ===
requireAuth();

let allChildren = [];
let activeChild = null;
let allPediatricians = [];
let suggestionContext = null;
let latestAvailability = null;
let appointmentSlotSettings = { enforceThirtyMinuteSlots: true, slotMinutes: 30 };
let availabilityBlocksBooking = false;

function useThirtyMinuteSlots() {
    return Boolean(appointmentSlotSettings?.enforceThirtyMinuteSlots);
}

function roundMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

function formatMoney(value) {
    return `\u20b1${roundMoney(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getSelectedPediatrician() {
    const selectedId = document.getElementById('pedSelect')?.value;
    return allPediatricians.find((p) => p.id === selectedId) || null;
}

function getConsultationFee(ped = getSelectedPediatrician()) {
    const fee = Number(ped?.consultationFee);
    return Number.isFinite(fee) && fee > 0 ? roundMoney(fee) : 0;
}

function getMinimumPayment(totalAmount) {
    return roundMoney(totalAmount * 0.3);
}

function paymentTypeLabel(value) {
    return {
        full_payment: 'Full Payment',
        down_payment: 'Down Payment',
        partial_installment: 'Partial Payment',
        balance_payment: 'Balance Payment',
    }[value] || value || 'Payment';
}

function refreshBookButtonState(forceDisabled = false) {
    const btn = document.getElementById('bookBtn');
    if (!btn) return;
    const disabled = forceDisabled || availabilityBlocksBooking;
    btn.disabled = disabled;
    btn.style.opacity = disabled ? '0.7' : '1';
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

function getTimeField() {
    return document.getElementById('apptTime');
}

function getSelectedAppointmentTime() {
    const field = getTimeField();
    return field ? field.value : '';
}

function clearSelectedAppointmentTime() {
    const field = getTimeField();
    if (field) field.value = '';
}

function updateTimeFieldHelp(info = latestAvailability) {
    const help = document.getElementById('apptTimeHelp');
    const date = document.getElementById('apptDate').value;
    const pediatricianId = document.getElementById('pedSelect').value;
    const ped = allPediatricians.find((entry) => entry.id === pediatricianId);
    if (!help) return;

    if (!pediatricianId) {
        help.textContent = 'Select a pediatrician first.';
        return;
    }

    if (!hasConfiguredAvailability(ped)) {
        help.textContent = 'This pediatrician must save schedule details before booking can continue.';
        return;
    }

    if (!useThirtyMinuteSlots()) {
        help.textContent = 'Manual time selection is currently allowed by the admin setting.';
        return;
    }

    if (!date) {
        help.textContent = 'Select a date to load the allowed 30-minute slots at :00 and :30.';
        return;
    }

    if (Array.isArray(info?.breakRanges) && info.breakRanges.length) {
        help.textContent = 'Break periods are skipped automatically while the 30-minute slots are generated.';
        return;
    }

    help.textContent = 'Select one of the available 30-minute appointment slots.';
}

function applyAppointmentSlotSettings(settings) {
    const normalized = {
        enforceThirtyMinuteSlots: settings?.enforceThirtyMinuteSlots !== false,
        slotMinutes: Number(settings?.slotMinutes || 30),
    };
    const modeChanged = normalized.enforceThirtyMinuteSlots !== appointmentSlotSettings.enforceThirtyMinuteSlots;
    appointmentSlotSettings = normalized;

    if (modeChanged || !getTimeField()) {
        renderTimeField();
    } else {
        updateTimeFieldHelp();
    }
}

function renderTimeField() {
    const wrap = document.getElementById('apptTimeField');
    const previousValue = getSelectedAppointmentTime();
    if (!wrap) return;

    if (useThirtyMinuteSlots()) {
        wrap.innerHTML = `
            <select id="apptTime" class="form-input" disabled>
                <option value="">Select a date to load 30-minute slots</option>
            </select>`;
    } else {
        wrap.innerHTML = '<input type="time" id="apptTime" class="form-input" step="60">';
    }

    const field = getTimeField();
    if (field) {
        field.required = true;
        field.addEventListener('change', checkSelectedAvailability);
    }

    applyTimeFieldConstraints();

    if (previousValue && field) {
        if (field.tagName === 'INPUT') {
            field.value = previousValue;
        } else if (Array.from(field.options).some((option) => option.value === previousValue)) {
            field.value = previousValue;
        }
    }

    updateTimeFieldHelp();
}

function applyTimeFieldConstraints() {
    const field = getTimeField();
    const pediatricianId = document.getElementById('pedSelect').value;
    const date = document.getElementById('apptDate').value;
    const ped = allPediatricians.find((entry) => entry.id === pediatricianId);
    if (!field) return;

    if (!ped || !hasConfiguredAvailability(ped)) {
        field.disabled = true;
        clearSelectedAppointmentTime();
        if (field.tagName === 'SELECT') {
            field.innerHTML = `<option value="">${ped ? 'Schedule not available yet' : 'Select a pediatrician first'}</option>`;
        } else {
            field.min = '';
            field.max = '';
        }
        updateTimeFieldHelp();
        return;
    }

    if (field.tagName === 'SELECT') {
        field.disabled = !date;
        field.innerHTML = `<option value="">${date ? 'Select a 30-minute slot' : 'Select a date to load 30-minute slots'}</option>`;
        updateTimeFieldHelp();
        return;
    }

    const startMinutes = timeToMinutes(ped.availability.startTime);
    const endMinutes = timeToMinutes(ped.availability.endTime);

    if (startMinutes != null && endMinutes != null && endMinutes > startMinutes && endMinutes !== 0) {
        field.min = ped.availability.startTime || '';
        field.max = ped.availability.endTime || '';
    } else if (startMinutes != null && endMinutes === 0) {
        field.min = ped.availability.startTime || '';
        field.max = '';
    } else {
        field.min = '';
        field.max = '';
    }

    field.disabled = false;
    updateTimeFieldHelp();
}

function populateTimeSlotOptions(info) {
    const field = getTimeField();
    const date = document.getElementById('apptDate').value;
    if (!field || field.tagName !== 'SELECT') return;

    const slots = Array.isArray(info?.availableSlots) ? info.availableSlots : [];
    const previousValue = field.value;
    let placeholder = 'Select a 30-minute slot';
    if (!date) placeholder = 'Select a date to load 30-minute slots';
    else if (!slots.length) placeholder = 'No 30-minute slots available';

    field.innerHTML = `<option value="">${placeholder}</option>` + slots
        .map((slot) => `<option value="${slot}">${escapeHtml(fmtTime(slot))}</option>`)
        .join('');
    field.disabled = !date || !slots.length;

    if (slots.includes(previousValue)) {
        field.value = previousValue;
    }

    updateTimeFieldHelp(info);
}

async function loadAppointmentSlotSettings() {
    try {
        const data = await apiFetch('/appointments/slot-settings');
        applyAppointmentSlotSettings(data.settings || null);
    } catch {
        renderTimeField();
    }
}

// Small helpers so the appointment card can reflect the exact schedule the
// pediatrician saved, while also making it clear when availability is missing.
function hasConfiguredAvailability(ped) {
    return Boolean(ped?.availabilityConfigured || (ped?.availability?.days?.length && ped?.availability?.startTime && ped?.availability?.endTime));
}

function timeToMinutes(value) {
    // Keep the frontend in sync with the backend time parsing.
    if (value === undefined || value === null || value === '') return null;
    const raw = String(value).trim();
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const hours = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
    return hours * 60 + mins;
}

function availabilitySummary(ped) {
    if (!ped) return { days: '—', hours: '—', max: '—' };
    if (!hasConfiguredAvailability(ped)) {
        return {
            days: 'Set by pediatrician in Settings',
            hours: 'Set by pediatrician in Settings',
            max: Number(ped?.availability?.maxPatientsPerDay || 10),
        };
    }
    return {
        days: ped.availability.days.join(', '),
        hours: `${fmtTime(ped.availability.startTime)} - ${fmtTime(ped.availability.endTime)}`,
        max: Number(ped.availability.maxPatientsPerDay || 10),
    };
}

function switchChild(childId) {
    setParentContext(childId, null);
    window.location.href = `/parent/appointments.html?childId=${encodeURIComponent(childId)}`;
}

function renderChildSwitcher() {
    const wrap = document.getElementById('childSwitchWrap');
    if (!wrap) return;
    if (allChildren.length <= 1) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = `
        <select class="child-select" onchange="switchChild(this.value)">
            ${allChildren.map((c) => `<option value="${c.id}" ${c.id === activeChild?.id ? 'selected' : ''}>${c.firstName} ${c.lastName}</option>`).join('')}
        </select>`;
}

function fillChildSelect() {
    const sel = document.getElementById('childSelect');
    sel.innerHTML = allChildren.length
        ? allChildren.map((c) => `<option value="${c.id}" ${c.id === activeChild?.id ? 'selected' : ''}>${c.firstName} ${c.lastName}</option>`).join('')
        : '<option value="">No children registered yet</option>';
    sel.onchange = async () => {
        const picked = allChildren.find((c) => c.id === sel.value);
        if (!picked) return;
        activeChild = picked;
        setParentContext(activeChild.id, null);
        renderChildSwitcher();
        await loadPediatricians();
    };
}

function choosePediatrician(id) {
    document.getElementById('pedSelect').value = id;
    localStorage.setItem('kc_prefPediaId', id);
    renderSelectedPediatrician();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSelectedPediatrician() {
    const selectedId = document.getElementById('pedSelect').value;
    const ped = allPediatricians.find((p) => p.id === selectedId);
    const panel = document.getElementById('clinicPanel');
    if (!ped) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        renderAvailabilityStatus(null);
        return;
    }

    const availability = availabilitySummary(ped);
    panel.style.display = 'block';
    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start;">
            <div>
                <p style="font-weight:700;color:var(--text-dark);margin:0 0 .25rem;">Dr. ${escapeHtml(ped.firstName)} ${escapeHtml(ped.lastName)}</p>
                <p class="mini" style="margin:0 0 .2rem;">${escapeHtml(ped.specialization || 'Pediatrician')}</p>
                <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(ped.clinicName || ped.institution || 'Clinic not set')}</p>
                <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/data.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(ped.clinicAddress || 'Clinic address not available')}</p>
                ${ped.phoneNumber ? `<p class="mini" style="margin:0 0 .2rem;"><img src="/icons/data.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(ped.phoneNumber)}</p>` : ''}
                ${ped.consultationFee != null ? `<p class="mini" style="margin:0;">💳 Consultation Fee: ₱${Number(ped.consultationFee).toLocaleString()}</p>` : ''}
            </div>
            <div>
                ${ped.isSuggested ? '<span class="pill green">Suggested Match</span>' : '<span class="pill gold">Available</span>'}
            </div>
        </div>
        <div class="clinic-grid" style="margin-top:.8rem;">
            <div class="mini"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Available Days: ${escapeHtml(availability.days)}</div>
            <div class="mini">⏰ Hours: ${escapeHtml(availability.hours)}</div>
        </div>
        <div class="mini" style="margin-top:.45rem;">👥 Maximum patients per day: ${availability.max}</div>
        ${hasConfiguredAvailability(ped) ? '' : '<div class="mini" style="margin-top:.55rem;color:var(--status-attention-fg);font-weight:600;">This pediatrician must finish saving availability in Settings before parents can book.</div>'}`;

    applyTimeFieldConstraints();
    // updatePaymentStep() used to run here. Payment selection moved to
    // /parent/payment.html when booking was decoupled from payment, and that
    // change deleted the function but left these two calls behind. Every call
    // threw ReferenceError, which aborted renderSelectedPediatrician ->
    // loadPediatricians -> resolveContext, so loadAppointments() at the end of
    // DOMContentLoaded never ran and the parent's existing appointments never
    // appeared on the page.
    checkSelectedAvailability();
}

function renderSuggestionBanner() {
    const el = document.getElementById('suggestionBanner');
    if (!suggestionContext) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    if (!suggestionContext.consultationNeeded) {
        el.style.display = 'block';
        el.innerHTML = `<strong>General booking guide.</strong> ${escapeHtml(suggestionContext.summary || 'You may choose any active pediatrician for follow-up.')}`;
        return;
    }

    el.style.display = 'block';
    const focus = Array.isArray(suggestionContext.focusAreas) && suggestionContext.focusAreas.length
        ? suggestionContext.focusAreas.join(', ')
        : 'developmental support';
    el.innerHTML = `
        <strong>${suggestionContext.urgent ? 'Suggested clinic recommendation' : 'Suggested follow-up consultation'}.</strong>
        ${escapeHtml(suggestionContext.summary || '')}
        <div class="mini" style="margin-top:.45rem;">Focus areas: ${escapeHtml(focus)}</div>`;
}

function renderRecommendedPediatricians() {
    const listEl = document.getElementById('recommendedList');
    if (!Array.isArray(allPediatricians) || !allPediatricians.length) {
        listEl.innerHTML = '';
        return;
    }

    const suggested = allPediatricians.filter((p) => p.isSuggested).slice(0, 3);
    if (!suggested.length) {
        listEl.innerHTML = '';
        return;
    }

    listEl.innerHTML = `
        <div style="margin:1rem 0 1.2rem;">
            <h3 style="color:var(--primary);margin-bottom:.8rem;">Suggested Pediatricians / Clinics</h3>
            ${suggested.map((p) => `
                <div class="ped-card suggested">
                    <div style="display:flex;gap:1rem;flex:1;min-width:0;">
                        <img src="${escapeHtml(p.profileIcon && p.profileIcon.startsWith('/uploads/') ? p.profileIcon : '/icons/profile.png')}" style="width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid #e6efe6;">
                        <div style="min-width:0;">
                            <p style="font-weight:700;margin:0 0 .2rem;color:var(--text-dark);">Dr. ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</p>
                            <p class="mini" style="margin:0 0 .2rem;">${escapeHtml(p.specialization || 'Pediatrician')}</p>
                            <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(p.clinicName || p.institution || 'Clinic not set')}</p>
                            <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/data.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(p.clinicAddress || 'Clinic address not available')}</p>
                            <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(availabilitySummary(p).days)}</p>
                            <p class="mini" style="margin:0 0 .2rem;">⏰ ${escapeHtml(availabilitySummary(p).hours)}</p>
                            <p class="mini" style="margin:0;">Why suggested: ${escapeHtml(p.suggestedReason || 'Good match for follow-up')}</p>
                        </div>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:.6rem;align-items:flex-end;">
                        <span class="pill green">Suggested</span>
                        <button class="btn btn-secondary" onclick="choosePediatrician('${p.id}')">Choose This</button>
                    </div>
                </div>`).join('')}
        </div>`;
}

// Important: setBookButtonState disables the Book button when the selected slot is unavailable.
function setBookButtonState(disabled) {
    availabilityBlocksBooking = Boolean(disabled);
    refreshBookButtonState();
}

// Override the legacy free-entry availability renderer with a slot-aware version.
function renderAvailabilityStatus(info) {
    const panel = document.getElementById('availabilityPanel');
    if (!info) {
        latestAvailability = null;
        populateTimeSlotOptions(null);
        panel.style.display = 'none';
        panel.innerHTML = '';
        setBookButtonState(false);
        applyTimeFieldConstraints();
        return;
    }

    if (info.slotSettings) {
        applyAppointmentSlotSettings(info.slotSettings);
    }

    latestAvailability = info;
    populateTimeSlotOptions(info);
    panel.style.display = 'block';

    const statusClass = info.available ? 'green' : 'red';
    const statusText = info.available
        ? 'Available'
        : (info.isTimeTaken ? 'Slot Taken' : (info.isFull ? 'Day Full' : 'Unavailable'));

    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start;">
            <div>
                <p style="font-weight:700;color:var(--text-dark);margin:0 0 .25rem;">Availability Schedule</p>
                <p class="mini" style="margin:0 0 .25rem;">View the pediatrician's available schedule and open appointment slots.</p>
                <p class="mini" style="margin:0;">${escapeHtml(info.message || '')}</p>
            </div>
            <span class="pill ${statusClass}">${statusText}</span>
        </div>
        <div class="clinic-grid" style="margin-top:.8rem;">
            <div class="mini">Day: ${escapeHtml(info.dayName || '-')}</div>
            <div class="mini">Booking hours: ${escapeHtml(fmtTime(info.startTime))} - ${escapeHtml(fmtTime(info.endTime))}</div>
            <div class="mini">Booked today: ${Number(info.bookedCount || 0)} / ${Number(info.maxPatientsPerDay || 0)}</div>
            <div class="mini">Remaining daily capacity: ${Number(info.remainingSlots || 0)}</div>
        </div>
        ${Array.isArray(info.availableSlots) && info.availableSlots.length ? `
            <div style="margin-top:.7rem;">
                <p class="mini" style="margin:0 0 .35rem;">Available 30-minute appointment slots</p>
                <div class="slot-chips">
                    ${info.availableSlots.map((slot) => `<span class="slot-chip free">${escapeHtml(fmtTime(slot))}</span>`).join('')}
                </div>
            </div>` : ''}
        ${Array.isArray(info.bookedTimes) && info.bookedTimes.length ? `
            <div style="margin-top:.7rem;">
                <p class="mini" style="margin:0 0 .35rem;">Booked time slots for this date</p>
                <div class="slot-chips">
                    ${info.bookedTimes.map((slot) => `<span class="slot-chip taken">${escapeHtml(fmtTime(slot))}</span>`).join('')}
                </div>
            </div>` : ''}
        ${Array.isArray(info.breakRanges) && info.breakRanges.length ? `
            <div style="margin-top:.7rem;">
                <p class="mini" style="margin:0 0 .35rem;">Provider breaks skipped automatically</p>
                <div class="slot-chips">
                    ${info.breakRanges.map((pause) => `<span class="slot-chip break">${escapeHtml(fmtTime(pause.startTime))} - ${escapeHtml(fmtTime(pause.endTime))}</span>`).join('')}
                </div>
            </div>` : ''}`;

    const selectedTime = getSelectedAppointmentTime();
    const shouldDisable = !info.available && Boolean(document.getElementById('apptDate').value) && (!selectedTime || info.isTimeTaken || info.isFull || !info.isDayAvailable || !info.isWithinHours);
    setBookButtonState(shouldDisable);
}

// This version reads the selected time from either the slot dropdown or the manual input.
async function checkSelectedAvailability() {
    const pediatricianId = document.getElementById('pedSelect').value;
    const date = document.getElementById('apptDate').value;
    const time = getSelectedAppointmentTime();

    if (!pediatricianId || !date) {
        renderAvailabilityStatus(null);
        return;
    }

    try {
        const params = new URLSearchParams({ pediatricianId, date });
        if (time) params.set('time', time);
        const data = await apiFetch(`/appointments/availability/check?${params.toString()}`);
        renderAvailabilityStatus(data.availability || null);
    } catch (e) {
        renderAvailabilityStatus({
            available: false,
            message: e.message || 'Could not check availability.',
            dayName: '-',
            startTime: '09:00',
            endTime: '17:00',
            bookedCount: 0,
            maxPatientsPerDay: 0,
            remainingSlots: 0,
            bookedTimes: [],
            availableSlots: [],
            breakRanges: [],
            isDayAvailable: false,
            isWithinHours: false,
            isFull: false,
            isTimeTaken: false,
            slotSettings: appointmentSlotSettings,
        });
    }
}

async function loadPediatricians() {
    const selectedChildId = activeChild?.id;
    if (!selectedChildId) return;

    const data = await apiFetch(`/appointments/pediatricians/list?childId=${encodeURIComponent(selectedChildId)}`);
    applyAppointmentSlotSettings(data.slotSettings || appointmentSlotSettings);
    allPediatricians = Array.isArray(data.pediatricians) ? data.pediatricians : [];
    suggestionContext = data.context || null;

    const sel = document.getElementById('pedSelect');
    sel.innerHTML = allPediatricians.length
        ? `<option value="">Select a pediatrician</option>` + allPediatricians.map((p) => `<option value="${p.id}">${p.isSuggested ? '<img src="/icons/account.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ' : ''}Dr. ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}${p.clinicName ? ' — ' + escapeHtml(p.clinicName) : ''}${hasConfiguredAvailability(p) ? '' : ' — schedule not set'}</option>`).join('')
        : '<option value="">No pediatricians available</option>';

    const pref = localStorage.getItem('kc_prefPediaId');
    if (pref && allPediatricians.some((p) => p.id === pref)) {
        sel.value = pref;
    } else if (!sel.value && allPediatricians.length) {
        const firstSuggested = allPediatricians.find((p) => p.isSuggested) || allPediatricians[0];
        sel.value = firstSuggested.id;
    }

    renderSuggestionBanner();
    renderRecommendedPediatricians();
    renderSelectedPediatrician();
}

async function resolveContext() {
    allChildren = await fetchParentChildren();
    if (!allChildren.length) return;
    activeChild = allChildren.find((c) => c.id === getRequestedChildId()) || allChildren.find((c) => c.id === KC.childId()) || allChildren[0];
    setParentContext(activeChild.id, null);
    renderChildSwitcher();
    fillChildSelect();
    await loadPediatricians();
}

async function bookAppointment() {
    const btn = document.getElementById('bookBtn');
    const errEl = document.getElementById('bookError');
    const sucEl = document.getElementById('bookSuccess');
    errEl.style.display = 'none';
    sucEl.style.display = 'none';

    const childId = document.getElementById('childSelect').value;
    const pediatricianId = document.getElementById('pedSelect').value;
    const appointmentDate = document.getElementById('apptDate').value;
    const appointmentTime = getSelectedAppointmentTime();
    const reason = document.getElementById('apptReason').value;
    const notes = document.getElementById('apptNotes').value.trim();

    if (!childId) { errEl.textContent = 'Please select a child.'; errEl.style.display = 'block'; return; }
    if (!pediatricianId) { errEl.textContent = 'Please select a pediatrician.'; errEl.style.display = 'block'; return; }

    const chosenPedia = allPediatricians.find((p) => p.id === pediatricianId);
    if (!hasConfiguredAvailability(chosenPedia)) {
        errEl.textContent = 'This pediatrician has not finished saving appointment availability yet.';
        errEl.style.display = 'block';
        return;
    }

    if (!appointmentDate) { errEl.textContent = 'Please select a date.'; errEl.style.display = 'block'; return; }
    if (!appointmentTime) { errEl.textContent = 'Please select a time.'; errEl.style.display = 'block'; return; }

    if (latestAvailability && !latestAvailability.available) {
        errEl.textContent = latestAvailability.message || 'Please choose an available consultation time.';
        errEl.style.display = 'block';
        return;
    }

    btn.textContent = 'Booking...';
    btn.disabled = true;
    try {
        const data = await apiFetch('/appointments/create', {
            method: 'POST',
            body: JSON.stringify({ childId, pediatricianId, appointmentDate, appointmentTime, reason, notes }),
        });
        localStorage.removeItem('kc_prefPediaId');
        window.location.href = `/PARENT/payment.html?appointmentId=${data.appointmentId}`;
    } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
        btn.textContent = 'Book Appointment';
        refreshBookButtonState();
    }
}

async function loadAppointments() {
    const user = KC.user();
    if (!user) return;
    try {
        const data = await apiFetch(`/appointments/${user.id}`);
        const all = (data.appointments || []).sort((a, b) => (b.id || 0) - (a.id || 0));
        renderActive(all.filter((a) => ['pending', 'approved'].includes(a.status)));
        renderPast(all.filter((a) => ['completed', 'cancelled', 'rejected'].includes(a.status)));
    } catch {
        document.getElementById('activeList').innerHTML = '<p style="color:var(--text-light);text-align:center;">Could not load appointments.</p>';
    }
}

function paymentBadgeClass(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'paid') return 'payment-paid';
    if (normalized.includes('down')) return 'payment-down';
    if (normalized.includes('partial')) return 'payment-partial';
    if (normalized.includes('cancel')) return 'payment-cancelled';
    return 'payment-unpaid';
}

function renderPaymentSummary(a) {
    const total = Number(a.totalAmount || a.consultationFee || 0);
    if (!total) return '';
    const paymentStatus = a.paymentStatus || 'Unpaid';
    const paid = Number(a.amountPaid || 0);
    const balance = Number(a.balanceDue || Math.max(total - paid, 0));
    return `
        <div class="appointment-payment-summary">
            <span class="payment-badge ${paymentBadgeClass(paymentStatus)}">${escapeHtml(paymentStatus)}</span>
            ${a.paymentType ? `<span class="mini">${escapeHtml(a.paymentType)} plan</span>` : ''}
            <span class="mini">Paid ${formatMoney(paid)} of ${formatMoney(total)}</span>
            <span class="mini">Balance ${formatMoney(balance)}</span>
            <button type="button" class="payment-link-btn" onclick="viewReceipt(${a.id})">Receipt</button>
        </div>`;
}

async function viewReceipt(appointmentId) {
    const modal = document.getElementById('receiptModal');
    const body = document.getElementById('receiptBody');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    body.innerHTML = '<p class="mini">Loading receipt...</p>';

    try {
        const data = await apiFetch(`/payments/appointments/${appointmentId}`);
        const appointment = data.appointment || {};
        const payments = Array.isArray(data.payments) ? data.payments : [];
        body.innerHTML = renderReceiptDetails(appointment, payments);
    } catch (err) {
        body.innerHTML = `<p class="error-msg" style="display:block;margin:0;">${escapeHtml(err.message || 'Could not load receipt.')}</p>`;
    }
}

function renderReceiptDetails(appointment, payments) {
    const total = Number(appointment.totalAmount || 0);
    const paid = Number(appointment.amountPaid || 0);
    const balance = Number(appointment.balanceDue || 0);
    const paymentRows = payments.length
        ? payments.map((payment) => `
            <div class="receipt-payment-row">
                <div>
                    <strong>${escapeHtml(payment.paymentTypeLabel || paymentTypeLabel(payment.paymentType))}</strong>
                    <p class="mini">${escapeHtml(payment.referenceNumber || payment.receiptNumber || 'No reference')} · ${formatDateTime(payment.transactionDate)}</p>
                </div>
                <div style="text-align:right;">
                    <strong>${formatMoney(payment.amount ?? payment.amountPaid ?? 0)}</strong>
                    <p class="mini">Balance ${formatMoney(payment.balanceDue || 0)}</p>
                </div>
            </div>`).join('')
        : '<p class="mini">No payment transactions recorded yet.</p>';

    return `
        <div class="receipt-summary">
            <div><span>Total Due</span><strong>${formatMoney(total)}</strong></div>
            <div><span>Amount Paid</span><strong>${formatMoney(paid)}</strong></div>
            <div><span>Remaining Balance</span><strong>${formatMoney(balance)}</strong></div>
        </div>
        <div class="receipt-meta">
            <p><strong>Appointment:</strong> #${appointment.id || appointment.appointmentId || '-'}</p>
            <p><strong>Patient:</strong> ${escapeHtml(appointment.childName || 'Unknown Child')}</p>
            <p><strong>Payment Status:</strong> ${escapeHtml(appointment.paymentStatus || 'Unpaid')}</p>
        </div>
        <div class="receipt-payments">${paymentRows}</div>`;
}

function closeReceiptModal() {
    const modal = document.getElementById('receiptModal');
    if (modal) modal.style.display = 'none';
}

function renderActive(list) {
    const el = document.getElementById('activeList');
    if (!list.length) {
        el.innerHTML = '<p style="color:var(--text-light);text-align:center;padding:1rem;">No active appointments</p>';
        return;
    }
    el.innerHTML = list.map((a) => `
        <div class="appt-card ${a.status}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.8rem;gap:1rem;">
                <div>
                    <p style="font-weight:700;color:var(--text-dark);margin:0 0 0.25rem;">${a.pediatricianName ? 'Dr. ' + escapeHtml(a.pediatricianName) : 'Pediatrician TBD'}</p>
                    <p class="mini" style="margin:0;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.clinicName || 'Clinic not set')}</p>
                    <p class="mini" style="margin:.15rem 0 0;"><img src="/icons/data.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.clinicAddress || 'Clinic address not available')}</p>
                    <p class="mini" style="margin:.15rem 0 0;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${fmtDate(a.appointmentDate)} at ${fmtTime(a.appointmentTime)}</p>
                    <p class="mini" style="margin:.15rem 0 0;"><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.reason || 'General checkup')}</p>
                    ${a.childName ? `<p class="mini" style="margin:.15rem 0 0;"><img src="/icons/parent.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.childName)}</p>` : ''}
                </div>
                <span class="badge ${a.status}">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>
            </div>
            ${a.status === 'pending' ? '<p style="font-size:0.82rem;color:var(--status-caution-fg);margin:0;">⏳ Your request is being reviewed by the clinic staff.</p>' : ''}
            ${a.status === 'approved' ? `<p style="font-size:0.82rem;color:var(--status-positive-fg);margin:0;">✅ Confirmed by clinic staff on behalf of Dr. ${escapeHtml(a.pediatricianName || 'Pediatrician')}</p>` : ''}
            ${['approved', 'completed'].includes(a.status) ? `<button onclick="window.location.href='/parent/chat.html?appointmentId=${a.id}'" style="margin-top:.7rem;background:var(--primary);color:white;border:none;padding:.45rem 1.1rem;border-radius:20px;font-size:.8rem;cursor:pointer;"><img src="/icons/chat.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Chat with Dr. ${escapeHtml(a.pediatricianName || 'Pediatrician')}</button>` : ''}
        </div>`).join('');
}

function renderPast(list) {
    const el = document.getElementById('pastList');
    if (!list.length) {
        el.innerHTML = '<p style="color:var(--text-light);text-align:center;padding:1rem;">No past appointments</p>';
        return;
    }
    el.innerHTML = list.map((a) => `
        <div class="appt-card ${a.status}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;">
                <div>
                    <p style="font-weight:700;color:var(--text-dark);margin:0 0 0.25rem;">${a.pediatricianName ? 'Dr. ' + escapeHtml(a.pediatricianName) : 'Pediatrician'}</p>
                    <p class="mini" style="margin:0;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.clinicName || 'Clinic not set')}</p>
                    <p class="mini" style="margin:.15rem 0 0;"><img src="/icons/data.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.clinicAddress || 'Clinic address not available')}</p>
                    <p class="mini" style="margin:.15rem 0 0;"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${fmtDate(a.appointmentDate)} at ${fmtTime(a.appointmentTime)}</p>
                    ${a.childName ? `<p class="mini" style="margin:.15rem 0 0;"><img src="/icons/parent.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.childName)}</p>` : ''}
                    ${a.reason ? `<p class="mini" style="margin:.15rem 0 0;"><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(a.reason)}</p>` : ''}
                </div>
                <span class="badge ${a.status}">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>
            </div>
        </div>`).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
    initNav();
    document.querySelectorAll('a.logout').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); logout(); }));
    renderTimeField();
    await loadAppointmentSlotSettings();
    document.getElementById('apptDate').min = new Date().toISOString().split('T')[0];
    document.getElementById('apptDate').required = true;
    document.getElementById('childSelect').required = true;
    document.getElementById('pedSelect').required = true;
    document.getElementById('apptDate').addEventListener('change', checkSelectedAvailability);
    document.getElementById('pedSelect')?.addEventListener('change', renderSelectedPediatrician);
    await resolveContext();
    await loadAppointments();
});
