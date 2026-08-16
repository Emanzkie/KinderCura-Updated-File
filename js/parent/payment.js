requireAuth();

const appointmentId = new URLSearchParams(location.search).get('appointmentId');
let appointmentData = null;
let modeSelected = false;

const PANEL_IDS = [
    'optionCards', 'walkInPanel', 'ewalletPanel', 'ewalletSubmittedPanel',
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

        // If already paid, show a different state
        if (appt.paymentStatus === 'Paid') {
            summaryEl.innerHTML = `
                <p><strong>Appointment #${appt.id}</strong></p>
                <p>Patient: ${escapeHtml(appt.childName || '—')}</p>
                <p>Pediatrician: Dr. ${escapeHtml(appt.pediatricianName || '—')}</p>
                <p>Date: ${fmtDate(appt.appointmentDate)} at ${fmtTime(appt.appointmentTime)}</p>
                <p class="fee">${formatMoney(appt.totalAmount)} <span style="font-size:0.8rem;font-weight:400;color:var(--status-positive-fg);">— Paid</span></p>`;
            showPanel(null);
            document.getElementById('optionCards').style.display = 'none';
            showError('This appointment has already been paid. Your appointment is approved.');
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

function showEwalletForm() {
    clearError();
    document.getElementById('optionCards').style.display = 'none';
    document.getElementById('ewalletPanel').style.display = 'block';
}

function backToOptions() {
    clearError();
    const ewErr = document.getElementById('ewalletError');
    if (ewErr) ewErr.style.display = 'none';
    showPanel('optionCards');
}

// ── Pay Online (PayMongo hosted checkout) ────────────────────────────────
// The browser never sees a PayMongo key and never states an amount. It asks
// the server to open a checkout session and then follows the URL it gets back.
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
                const line = document.getElementById('onlineReceiptLine');
                if (line && status.receiptNumber) line.textContent = `Receipt number: ${status.receiptNumber}`;
                sessionStorage.removeItem(`kc_pay_ref_${appointmentId}`);
                showPanel('onlineSuccessPanel');
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

function previewProof(input) {
    const previewEl = document.getElementById('proofPreview');
    if (!previewEl) return;
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => {
            previewEl.innerHTML = `<img src="${e.target.result}" alt="Payment proof preview">`;
        };
        reader.readAsDataURL(input.files[0]);
    } else {
        previewEl.innerHTML = '';
    }
}

async function submitEwalletProof() {
    const errEl = document.getElementById('ewalletError');
    errEl.style.display = 'none';

    const referenceNumber = String(document.getElementById('referenceNumber').value || '').trim();
    const proofFileInput = document.getElementById('proofImage');
    const proofFile = proofFileInput?.files?.[0];

    if (!referenceNumber) {
        errEl.textContent = 'Please enter your reference number.';
        errEl.style.display = 'block';
        return;
    }
    if (!proofFile) {
        errEl.textContent = 'Please upload a screenshot of your payment.';
        errEl.style.display = 'block';
        return;
    }

    const submitBtn = document.getElementById('submitProofBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading…';

    try {
        // Select ewallet mode first
        await apiFetch(`/payments/appointments/${appointmentId}/select-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'ewallet' }),
        });

        // Upload proof image using fetch directly (multipart/form-data)
        const formData = new FormData();
        formData.append('referenceNumber', referenceNumber);
        formData.append('proofImage', proofFile);

        const token = KC.token ? KC.token() : localStorage.getItem('kc_token') || sessionStorage.getItem('kc_token') || '';
        const response = await fetch(`/api/payments/appointments/${appointmentId}/ewallet-proof`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
            // Do NOT set Content-Type — browser sets multipart boundary automatically
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed.');

        document.getElementById('ewalletPanel').style.display = 'none';
        document.getElementById('ewalletSubmittedPanel').style.display = 'block';
    } catch (err) {
        errEl.textContent = err.message || 'Could not upload proof. Please try again.';
        errEl.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Payment Proof';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    initNav();
    document.querySelectorAll('a.logout').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); logout(); }));
    await loadAppointmentSummary();

    // PayMongo sends the parent back here with ?result=success|cancelled.
    // Treat it purely as a signal to start checking — never as proof of payment.
    const params = new URLSearchParams(location.search);
    const result = params.get('result');
    const paymentRef = params.get('ref') || sessionStorage.getItem(`kc_pay_ref_${appointmentId}`);
    if (result && paymentRef) {
        await resolveOnlineResult(result, paymentRef);
    }
});
