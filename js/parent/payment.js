requireAuth();

const appointmentId = new URLSearchParams(location.search).get('appointmentId');
let appointmentData = null;
let modeSelected = false;

const PANEL_IDS = [
    'optionCards', 'walkInPanel', 'ewalletSubmittedPanel',
    'clinicQrPanel', 'onlinePendingPanel', 'onlineSuccessPanel', 'onlineFailedPanel',
];

function showPanel(id) {
    PANEL_IDS.forEach((pid) => {
        const el = document.getElementById(pid);
        if (el) {
            el.style.display = pid === id ? (id === 'optionCards' ? 'grid' : 'block') : 'none';
            if (pid === id) el.classList.add('active');
            else el.classList.remove('active');
        }
    });
}

function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '₱0.00';
    return `₱${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtTime(timeStr) {
    if (!timeStr) return '—';
    const [h, m] = timeStr.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Receipt card ──────────────────────────────────────────────────────────
// Renders the SAME confirmed database payment record the email receipt was
// built from (see receiptService.buildReceiptContext / GET /payments/ref/:ref/receipt),
// so the values on this page and the ones the parent got by email always match.
function renderReceiptCard(r) {
    return `
        <div class="official-receipt">
            <div class="official-receipt__head">
                <h2>${escapeHtml(r.clinic?.clinicName || 'KinderCura')}</h2>
                <p>Official Payment Receipt</p>
            </div>
            <div class="receipt-ids">
                <span>Receipt No.: <strong>${escapeHtml(r.receiptNumber || '—')}</strong></span>
                <span>Payment Ref: <strong>${escapeHtml(r.paymentRef || '—')}</strong></span>
            </div>
            <dl class="receipt-fields">
                <div><dt>Parent</dt><dd>${escapeHtml(r.parentName || '—')}</dd></div>
                <div><dt>Child</dt><dd>${escapeHtml(r.childName || '—')}</dd></div>
                <div><dt>Pediatrician</dt><dd>${escapeHtml(r.pediatricianName || '—')}</dd></div>
                <div><dt>Appointment No.</dt><dd>${r.appointmentId != null ? `#${escapeHtml(String(r.appointmentId))}` : '—'}</dd></div>
                <div><dt>Appointment Date</dt><dd>${fmtDate(r.appointmentDate)}</dd></div>
                <div><dt>Appointment Time</dt><dd>${fmtTime(r.appointmentTime)}</dd></div>
                <div><dt>Service</dt><dd>${escapeHtml(r.service || 'Consultation')}</dd></div>
                <div><dt>Payment Method</dt><dd>${escapeHtml(r.paymentMethodLabel || r.paymentMethod || '—')}</dd></div>
            </dl>
            <div class="receipt-amount-row">
                <span>Amount Paid</span>
                <span class="amt">${formatMoney(r.amount)}</span>
            </div>
            <dl class="receipt-fields">
                <div><dt>Paid At</dt><dd>${fmtDateTime(r.paidAt)}</dd></div>
                <div><dt>Status</dt><dd style="color:var(--status-positive-fg);">${escapeHtml(String(r.status || '').toUpperCase())}</dd></div>
            </dl>
            <p class="receipt-emailed">Receipt emailed to: <strong>${escapeHtml(r.parentEmail || '—')}</strong></p>
            ${r.contactPhone ? `<p class="receipt-emailed">Contact mobile: <strong>${escapeHtml(r.contactPhone)}</strong></p>` : ''}
        </div>`;
}

/**
 * Fetch the confirmed receipt for a payment reference and render it into
 * `containerId`. Never fabricates a receipt: if the backend has not confirmed
 * the payment as Paid yet (409) or the reference cannot be found/accessed,
 * this shows an honest message instead of receipt-shaped content.
 */
async function loadReceiptInto(containerId, ref) {
    const el = document.getElementById(containerId);
    if (!el) return false;
    if (!ref) {
        el.innerHTML = '<p class="mini">No receipt is available for this payment yet.</p>';
        return false;
    }
    try {
        const data = await apiFetch(`/payments/ref/${encodeURIComponent(ref)}/receipt`);
        el.innerHTML = renderReceiptCard(data.receipt || {});
        return true;
    } catch (err) {
        el.innerHTML = `<p class="mini">${escapeHtml(err.message || 'Could not load your receipt right now.')}</p>`;
        return false;
    }
}

function showError(msg) {
    const el = document.getElementById('errorMsg');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function clearError() {
    const el = document.getElementById('errorMsg');
    if (el) el.style.display = 'none';
}

async function loadAppointmentSummary() {
    const summaryEl = document.getElementById('apptSummary');
    if (!summaryEl) return;

    if (!appointmentId) {
        summaryEl.innerHTML = '<p style="color:#c00;">No appointment ID provided. <a href="/parent/appointments.html">Go back</a>.</p>';
        return;
    }

    try {
        // Load all user appointments and find the one matching our ID
        const user = KC.user();
        if (!user) return;
        const data = await apiFetch(`/appointments/${user.id}`);
        const appt = (data.appointments || []).find((a) => String(a.id) === String(appointmentId));

        if (!appt) {
            summaryEl.innerHTML = '<p style="color:#c00;">Appointment not found. <a href="/parent/appointments.html">Go back</a>.</p>';
            return;
        }

        appointmentData = appt;

        // If already paid, let the parent review the actual receipt again —
        // built from the same confirmed payment record as the email receipt —
        // rather than only telling them it was paid.
        if (appt.paymentStatus === 'Paid') {
            summaryEl.innerHTML = `
                <p><strong>Appointment #${appt.id}</strong></p>
                <p>Patient: ${escapeHtml(appt.childName || '—')}</p>
                <p>Pediatrician: Dr. ${escapeHtml(appt.pediatricianName || '—')}</p>
                <p>Date: ${fmtDate(appt.appointmentDate)} at ${fmtTime(appt.appointmentTime)}</p>
                <p class="fee">${formatMoney(appt.totalAmount)} <span style="font-size:0.8rem;font-weight:400;color:var(--status-positive-fg);">— Paid</span></p>`;
            document.getElementById('optionCards').style.display = 'none';
            showPanel('onlineSuccessPanel');
            const ref = appt.paymentRef || appt.receiptNumber || null;
            await loadReceiptInto('receiptCardContainer', ref);
            return;
        }

        if (appt.paymentStatus === 'Payment Verification Pending') {
            summaryEl.innerHTML = `
                <p><strong>Appointment #${appt.id}</strong></p>
                <p>Patient: ${escapeHtml(appt.childName || '—')}</p>
                <p>Pediatrician: Dr. ${escapeHtml(appt.pediatricianName || '—')}</p>
                <p>Date: ${fmtDate(appt.appointmentDate)} at ${fmtTime(appt.appointmentTime)}</p>
                <p class="fee">${formatMoney(appt.totalAmount)}</p>`;
            document.getElementById('optionCards').style.display = 'none';
            document.getElementById('ewalletSubmittedPanel').style.display = 'block';
            return;
        }

        if (appt.pendingPaymentMode === 'walk_in') {
            summaryEl.innerHTML = buildSummaryHtml(appt);
            document.getElementById('optionCards').style.display = 'none';
            document.getElementById('walkInPanel').style.display = 'block';
            return;
        }

        summaryEl.innerHTML = buildSummaryHtml(appt);
    } catch (err) {
        summaryEl.innerHTML = `<p style="color:#c00;">Could not load appointment: ${escapeHtml(err.message)}</p>`;
    }
}

function buildSummaryHtml(appt) {
    return `
        <p><strong>Appointment #${appt.id}</strong></p>
        <p>Patient: ${escapeHtml(appt.childName || '—')}</p>
        <p>Pediatrician: Dr. ${escapeHtml(appt.pediatricianName || '—')}</p>
        <p>Date: ${fmtDate(appt.appointmentDate)} at ${fmtTime(appt.appointmentTime)}</p>
        <p>Reason: ${escapeHtml(appt.reason || 'General checkup')}</p>
        <p class="fee">${formatMoney(appt.totalAmount || 0)} <span style="font-size:0.8rem;font-weight:400;color:var(--text-light);">consultation fee</span></p>`;
}

async function selectWalkIn() {
    clearError();
    try {
        await apiFetch(`/payments/appointments/${appointmentId}/select-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'walk_in' }),
        });
        modeSelected = true;
        document.getElementById('optionCards').style.display = 'none';
        document.getElementById('walkInPanel').style.display = 'block';
    } catch (err) {
        showError(err.message || 'Could not set payment mode. Please try again.');
    }
}

function backToOptions() {
    clearError();
    showPanel('optionCards');
}

// ── Pay Online (PayMongo hosted checkout) ────────────────────────────────
// The browser never sees a PayMongo key and never states an amount or contact
// info. It asks the server to open a checkout session and follows the URL it
// gets back — the parent enters/edits their payment email and phone on
// PayMongo's own hosted checkout page, not here.
async function payOnline() {
    clearError();
    const btn = document.getElementById('payOnlineBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening secure checkout…'; }

    try {
        const data = await apiFetch(`/payments/appointments/${appointmentId}/checkout`, { method: 'POST' });
        if (!data.checkoutUrl) throw new Error('The payment provider did not return a checkout link.');
        // Remember the reference so the page can resume polling if the parent
        // returns without the query string (e.g. by pressing Back).
        sessionStorage.setItem(`kc_pay_ref_${appointmentId}`, data.paymentRef);
        window.location.href = data.checkoutUrl;
    } catch (err) {
        showError(err.message || 'Could not start the online payment. Please try again or choose Pay at Clinic.');
        if (btn) { btn.disabled = false; btn.textContent = 'Pay Online'; }
    }
}

// ── Pay at Clinic (QR) ────────────────────────────────────────────────────
async function payAtClinic() {
    clearError();
    const btn = document.getElementById('payAtClinicBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating QR…'; }

    try {
        const data = await apiFetch(`/payments/appointments/${appointmentId}/pay-at-clinic`, { method: 'POST' });
        renderClinicQr(data);
        showPanel('clinicQrPanel');
    } catch (err) {
        showError(err.message || 'Could not generate your clinic QR code. Please try again.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Get Clinic QR'; }
    }
}

function renderClinicQr(data) {
    const img = document.getElementById('clinicQrImage');
    if (img && data.qrDataUrl) img.src = data.qrDataUrl;

    const refEl = document.getElementById('clinicQrRef');
    if (refEl) refEl.textContent = data.paymentRef || '—';

    const amountEl = document.getElementById('clinicQrAmount');
    if (amountEl) amountEl.textContent = formatMoney(data.amount);

    // Clinic contact comes from server configuration, never hard-coded here.
    const contactEl = document.getElementById('clinicContactLine');
    if (contactEl) {
        const bits = [data.clinicName, data.clinicAddress, data.clinicPhone].filter(Boolean).map(escapeHtml);
        contactEl.innerHTML = bits.length ? `Questions? ${bits.join(' · ')}` : '';
    }
}

// ── Returning from the hosted checkout ────────────────────────────────────
// The success URL is only a hint. The page polls our own API, and the server
// confirms with PayMongo directly, so nothing is marked paid from the browser.
async function resolveOnlineResult(result, paymentRef) {
    if (result === 'cancelled') {
        document.getElementById('onlineFailedReason').textContent =
            'You cancelled the payment before it completed. No money has been taken.';
        showPanel('onlineFailedPanel');
        return;
    }

    document.getElementById('onlinePendingRef').textContent = `Reference: ${paymentRef}`;
    showPanel('onlinePendingPanel');

    // Ask the server to reconcile once, then poll our own record briefly. The
    // webhook usually wins the race; the reconcile covers the case where it
    // has not landed yet.
    try {
        await apiFetch(`/payments/ref/${encodeURIComponent(paymentRef)}/reconcile`, { method: 'POST' });
    } catch { /* fall through to polling */ }

    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            const status = await apiFetch(`/payments/ref/${encodeURIComponent(paymentRef)}/status`);
            if (status.paid) {
                sessionStorage.removeItem(`kc_pay_ref_${appointmentId}`);
                showPanel('onlineSuccessPanel');
                // Load the actual confirmed receipt — the same database record
                // the email receipt was built from — rather than just a number.
                await loadReceiptInto('receiptCardContainer', paymentRef);
                return;
            }
            if (['Failed', 'Expired', 'Cancelled'].includes(status.status)) {
                document.getElementById('onlineFailedReason').textContent =
                    `The payment was marked ${status.status.toLowerCase()}. No money has been taken from your account.`;
                showPanel('onlineFailedPanel');
                return;
            }
        } catch { /* keep polling */ }
        await new Promise((r) => setTimeout(r, 2500));
    }

    // Still unconfirmed. Say so honestly rather than implying success.
    document.getElementById('onlineFailedReason').innerHTML =
        'We have not received confirmation yet. If you completed the payment, it will appear shortly — '
        + 'please check your appointments in a few minutes before paying again.';
    showPanel('onlineFailedPanel');
}

document.addEventListener('DOMContentLoaded', async () => {
    initNav();
    document.querySelectorAll('a.logout').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); logout(); }));
    await loadAppointmentSummary();

    // PayMongo sends the parent back here with ?result=success|cancelled.
    // Treat it purely as a signal to start checking — never as proof of payment.
    // Skip it entirely if loadAppointmentSummary() already found the payment
    // confirmed Paid and rendered its receipt — re-running reconcile/poll here
    // would only flash "Confirming payment…" over a receipt already on screen.
    const params = new URLSearchParams(location.search);
    const result = params.get('result');
    const paymentRef = params.get('ref') || sessionStorage.getItem(`kc_pay_ref_${appointmentId}`);
    if (result && paymentRef && appointmentData?.paymentStatus !== 'Paid') {
        await resolveOnlineResult(result, paymentRef);
    }
});
