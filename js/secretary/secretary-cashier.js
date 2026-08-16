// Cashier page for the clinic assistant/secretary.
//
// Scanning only *identifies* a transaction — it never marks anything paid.
// The secretary presses Confirm Payment after the parent physically pays, and
// the server re-checks every rule before settling. Nothing on this page is
// trusted: the amount shown comes from the server, and the server ignores any
// amount the browser might send back.

requireAuth();

// Only assistant/secretary accounts (and admins, who may supervise) belong here.
const _u = KC.user();
if (_u && !['secretary', 'admin'].includes(_u.role)) {
    const roleMap = {
        pediatrician: '/pedia/pediatrician-dashboard.html',
        parent: '/parent/dashboard.html',
    };
    window.location.href = roleMap[_u.role] || '/login.html';
}

let currentLookup = null;   // last successful lookup payload
let cameraStream = null;
let cameraLoopId = null;

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '₱0.00';
    return `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-PH', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtTime(value) {
    if (!value) return '—';
    const [h, m] = String(value).split(':').map(Number);
    if (!Number.isFinite(h)) return String(value);
    const suffix = h >= 12 ? 'PM' : 'AM';
    return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

function methodLabel(method) {
    return {
        pay_at_clinic: 'Pay at Clinic',
        paymongo: 'Paid Online (PayMongo)',
        cash: 'Cash',
        ewallet: 'E-Wallet Transfer',
        walk_in: 'Walk-in',
    }[method] || (method ? String(method) : '—');
}

function showScanError(msg) {
    const el = document.getElementById('scanError');
    el.textContent = msg;
    el.style.display = 'block';
}

function clearScanError() {
    document.getElementById('scanError').style.display = 'none';
}

// ── Lookup ───────────────────────────────────────────────────────────────

async function lookupPayment(rawRef) {
    clearScanError();
    document.getElementById('confirmError').style.display = 'none';
    document.getElementById('paidBanner').style.display = 'none';

    const typed = document.getElementById('refInput').value || '';
    const ref = String(rawRef ?? typed).trim().toUpperCase();
    if (!ref) {
        showScanError('Scan a QR code or type a payment reference first.');
        return;
    }
    document.getElementById('refInput').value = ref;

    const btn = document.getElementById('lookupBtn');
    btn.disabled = true;
    btn.textContent = 'Looking up…';

    try {
        const data = await apiFetch(`/payments/clinic/lookup/${encodeURIComponent(ref)}`);
        currentLookup = data;
        renderLookup(data);
    } catch (err) {
        currentLookup = null;
        document.getElementById('resultCard').style.display = 'none';
        showScanError(err.message || 'That payment reference could not be found.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Look up';
    }
}

function renderLookup(data) {
    const { payment, appointment, canConfirm, blockers, isToday } = data;

    document.getElementById('rPaymentRef').textContent = payment.paymentRef;
    document.getElementById('rToday').textContent = fmtDate(new Date());
    document.getElementById('rApptDate').textContent = fmtDate(appointment.date);
    document.getElementById('rApptTime').textContent = fmtTime(appointment.time);
    document.getElementById('rParent').textContent = appointment.parentName;
    document.getElementById('rChild').textContent = appointment.childName;
    document.getElementById('rPedia').textContent = appointment.pediatricianName;
    document.getElementById('rService').textContent = appointment.service;
    document.getElementById('rMethod').textContent = methodLabel(payment.paymentMethod);
    document.getElementById('rAmount').textContent = formatMoney(payment.amountDue);

    const statusEl = document.getElementById('rStatus');
    if (payment.status === 'Paid') {
        statusEl.textContent = 'PAID';
        statusEl.style.color = '#3D5A40';
    } else if (canConfirm) {
        statusEl.textContent = 'WAITING FOR PAYMENT';
        statusEl.style.color = '#8A6D1F';
    } else {
        statusEl.textContent = String(payment.status).toUpperCase();
        statusEl.style.color = '#8C3A2B';
    }

    // Banners
    const valid = document.getElementById('validBanner');
    const blocked = document.getElementById('blockedBanner');
    const reasons = document.getElementById('blockedReasons');
    reasons.innerHTML = '';

    if (canConfirm) {
        valid.style.display = 'block';
        blocked.style.display = 'none';
        // A different-day appointment is worth flagging but is not a hard block:
        // the clinic may legitimately take payment in advance.
        if (!isToday) {
            valid.style.display = 'none';
            blocked.style.display = 'block';
            document.getElementById('blockedTitle').textContent = 'CHECK BEFORE ACCEPTING';
            reasons.innerHTML = '<li>This appointment is not scheduled for today. Confirm with the parent before taking payment.</li>';
        }
    } else {
        valid.style.display = 'none';
        blocked.style.display = 'block';
        document.getElementById('blockedTitle').textContent = 'CANNOT ACCEPT PAYMENT';
        reasons.innerHTML = (blockers || [])
            .map((b) => `<li>${escapeHtml(b.message)}</li>`)
            .join('') || '<li>This payment cannot be accepted right now.</li>';
    }

    document.getElementById('confirmRow').style.display = canConfirm ? 'flex' : 'none';
    document.getElementById('resultCard').style.display = 'block';
    document.getElementById('resultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Confirm ──────────────────────────────────────────────────────────────

async function confirmPayment() {
    if (!currentLookup) return;

    const errEl = document.getElementById('confirmError');
    errEl.style.display = 'none';

    const ref = currentLookup.payment.paymentRef;
    const amount = formatMoney(currentLookup.payment.amountDue);
    const parent = currentLookup.appointment.parentName;
    // Deliberately a plain in-page guard rather than a browser dialog.
    if (!window.confirm(`Confirm that you received ${amount} from ${parent}?\n\nReference: ${ref}`)) return;

    const btn = document.getElementById('confirmBtn');
    btn.disabled = true;
    btn.textContent = 'Confirming…';

    try {
        const data = await apiFetch(`/payments/clinic/${encodeURIComponent(ref)}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ notes: 'Cash payment received at clinic counter.' }),
        });

        document.getElementById('confirmRow').style.display = 'none';
        document.getElementById('validBanner').style.display = 'none';
        document.getElementById('rStatus').textContent = 'PAID';
        document.getElementById('rStatus').style.color = '#3D5A40';

        const detail = [
            `Receipt ${data.receiptNumber}`,
            data.receiptEmailed ? 'emailed to the parent' : 'created (email pending)',
            `for ${formatMoney(data.amount)}`,
        ].join(' · ');
        document.getElementById('paidDetail').textContent = detail;
        document.getElementById('paidBanner').style.display = 'block';

        await loadToday();
    } catch (err) {
        errEl.textContent = err.message || 'Could not confirm the payment. Please try again.';
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm Payment';
    }
}

function resetScan() {
    currentLookup = null;
    document.getElementById('refInput').value = '';
    document.getElementById('resultCard').style.display = 'none';
    clearScanError();
    document.getElementById('refInput').focus();
}

// ── Today's appointments ─────────────────────────────────────────────────

async function loadToday() {
    const body = document.getElementById('todayBody');
    try {
        const data = await apiFetch('/payments/clinic/today');
        const rows = data.appointments || [];
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="7" style="padding:1rem 0.5rem;color:var(--text-light);">No appointments scheduled for today.</td></tr>';
            return;
        }

        body.innerHTML = rows.map((a) => {
            const paid = a.paymentStatus === 'Paid';
            const payColor = paid ? '#3D5A40' : '#8A6D1F';
            const payText = paid
                ? `Paid${a.receiptNumber ? ` · ${escapeHtml(a.receiptNumber)}` : ''}`
                : escapeHtml(a.paymentStatus || 'Unpaid');
            const action = (!paid && a.paymentRef)
                ? `<button class="btn btn-primary" style="padding:0.35rem 0.7rem;font-size:0.82rem;"
                     onclick="lookupPayment('${escapeHtml(a.paymentRef)}')">Collect</button>`
                : '';
            return `<tr style="border-bottom:1px solid var(--border,#EEE);">
                <td style="padding:0.6rem 0.5rem;white-space:nowrap;font-weight:600;">${fmtTime(a.time)}</td>
                <td style="padding:0.6rem 0.5rem;">${escapeHtml(a.parentName)}</td>
                <td style="padding:0.6rem 0.5rem;">${escapeHtml(a.childName)}</td>
                <td style="padding:0.6rem 0.5rem;">${escapeHtml(a.service)}</td>
                <td style="padding:0.6rem 0.5rem;color:${payColor};font-weight:600;">${payText}</td>
                <td style="padding:0.6rem 0.5rem;text-transform:capitalize;">${escapeHtml(a.appointmentStatus)}</td>
                <td style="padding:0.6rem 0.5rem;text-align:right;">${action}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        body.innerHTML = `<tr><td colspan="7" style="padding:1rem 0.5rem;color:#8C3A2B;">${escapeHtml(err.message || 'Could not load today’s appointments.')}</td></tr>`;
    }
}

// ── Optional camera scanning ─────────────────────────────────────────────
// Uses the browser's built-in BarcodeDetector when available. Hardware USB
// scanners keyboard-type into the input box and need none of this, so a
// missing BarcodeDetector is reported as a hint rather than an error.

async function startCameraScan() {
    const wrap = document.getElementById('cameraWrap');
    const video = document.getElementById('cameraVideo');
    const hint = document.getElementById('cameraHint');
    wrap.style.display = 'block';

    if (!('BarcodeDetector' in window)) {
        hint.textContent = 'This browser cannot scan QR codes from the camera. Use a USB scanner, or type the reference by hand.';
        return;
    }

    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = cameraStream;
        await video.play();

        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
            if (!cameraStream) return;
            try {
                const codes = await detector.detect(video);
                const hit = codes.find((c) => /^KC-PAY-\d{4}-\d{6}$/i.test(String(c.rawValue || '').trim()));
                if (hit) {
                    stopCameraScan();
                    await lookupPayment(hit.rawValue);
                    return;
                }
            } catch { /* frame not ready */ }
            cameraLoopId = window.setTimeout(tick, 350);
        };
        tick();
    } catch (err) {
        hint.textContent = `Camera unavailable: ${err.message}. Type the reference by hand instead.`;
    }
}

function stopCameraScan() {
    if (cameraLoopId) { window.clearTimeout(cameraLoopId); cameraLoopId = null; }
    if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
    }
    document.getElementById('cameraWrap').style.display = 'none';
}

// ── Init ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    if (typeof initNav === 'function') initNav();
    document.querySelectorAll('a.logout').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); logout(); }));

    // A USB scanner ends its transmission with Enter, so this makes the
    // hardware path work with no extra clicks.
    const input = document.getElementById('refInput');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); lookupPayment(); }
    });
    input.focus();

    loadToday();
});

window.addEventListener('beforeunload', stopCameraScan);
