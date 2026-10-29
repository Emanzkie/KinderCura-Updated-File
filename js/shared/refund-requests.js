// Refund Requests panel for clinic staff (Pediatrician Appointments > Refunds,
// Secretary Cashier). Lists the clinic's refund requests and lets the
// pediatrician, or a secretary with Manage Payments, approve or reject them.
// The server does the PayMongo refund; this page never marks anything Refunded.
//
// Needs /api.js (apiFetch, escapeHtml, fmtDate, fmtTime, KC.poll) loaded first.
// Call initRefundRequests('<container id>') once the page is ready.

let refundRequestsContainerId = null;
let refundRequestsBusy = false;

const REFUND_STATUS_STYLE = {
    pending_review: 'background:var(--accent);color:var(--text-dark);',
    approved: 'background:var(--surface-muted);color:var(--text-dark);',
    processing: 'background:var(--surface-muted);color:var(--text-dark);',
    refunded: 'background:var(--success);color:var(--text-dark);',
    rejected: 'background:var(--accent-red);color:var(--text-dark);',
    failed: 'background:var(--accent-red);color:var(--text-dark);',
};

function refundMoney(amount) {
    return `₱${Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderRefundRequestRow(r) {
    const pill = `<span style="${REFUND_STATUS_STYLE[r.status] || ''}padding:.25rem .7rem;border-radius:999px;font-size:.78rem;font-weight:700;white-space:nowrap;">${escapeHtml(r.statusLabel)}</span>`;
    const lines = [
        `Appointment #${escapeHtml(r.appointmentId)}${r.appointmentDate ? ` · ${escapeHtml(fmtDate(r.appointmentDate))}${r.appointmentTime ? ` at ${escapeHtml(fmtTime(r.appointmentTime))}` : ''}` : ''}${r.appointmentStatus ? ` · ${escapeHtml(r.appointmentStatus)}` : ''}`,
        `Paid ${escapeHtml(refundMoney(r.amount))} via ${escapeHtml(r.ewallet || 'E-Wallet')}${r.paymentRef ? ` · ${escapeHtml(r.paymentRef)}` : ''}`,
        `Parent's reason: ${escapeHtml(r.reason)}`,
    ];
    if (r.reviewNote) lines.push(`Clinic note: ${escapeHtml(r.reviewNote)}`);
    if (r.status === 'processing') lines.push('Waiting for PayMongo to confirm the refund.');
    if (r.failureReason) lines.push(`PayMongo: ${escapeHtml(r.failureReason)}`);

    const actions = r.status === 'pending_review' ? `
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.7rem;">
            <button type="button" class="btn btn-primary" style="padding:.5rem 1rem;" data-refund-approve="${escapeHtml(r.id)}">Approve &amp; Refund ${escapeHtml(refundMoney(r.amount))}</button>
            <button type="button" class="btn btn-secondary" style="padding:.5rem 1rem;" data-refund-reject="${escapeHtml(r.id)}">Reject</button>
        </div>` : '';

    return `
        <div style="border:1px solid var(--border);border-radius:12px;padding:.9rem 1rem;margin-bottom:.75rem;background:var(--bg-primary);">
            <div style="display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start;flex-wrap:wrap;">
                <div style="min-width:0;">
                    <p style="font-weight:700;color:var(--text-dark);margin:0 0 .2rem;">${escapeHtml(r.childName || 'Patient')}${r.parentName ? ` <span style="font-weight:400;color:var(--text-light);">· parent ${escapeHtml(r.parentName)}</span>` : ''}</p>
                    ${lines.map((l) => `<p style="margin:.15rem 0 0;font-size:.86rem;color:var(--text-light);overflow-wrap:anywhere;">${l}</p>`).join('')}
                </div>
                ${pill}
            </div>
            ${actions}
        </div>`;
}

async function loadRefundRequests() {
    const el = document.getElementById(refundRequestsContainerId);
    if (!el) return;
    try {
        const data = await apiFetch('/payments/refunds/clinic');
        const list = Array.isArray(data.refunds) ? data.refunds : [];
        // Requests waiting for a decision first; the rest stay newest first.
        const ordered = [...list.filter((r) => r.status === 'pending_review'), ...list.filter((r) => r.status !== 'pending_review')];
        el.innerHTML = ordered.length
            ? ordered.map(renderRefundRequestRow).join('')
            : '<p style="color:var(--text-light);text-align:center;padding:1rem;">No refund requests.</p>';
    } catch (err) {
        el.innerHTML = `<p style="color:var(--text-light);text-align:center;padding:1rem;">${escapeHtml(err.message || 'Could not load refund requests.')}</p>`;
    }
}

async function reviewRefundRequest(refundId, decision) {
    if (refundRequestsBusy) return;
    let note = '';
    if (decision === 'reject') {
        note = window.prompt('Reason for rejecting this refund (the parent will see it):', '');
        if (note === null) return;
        if (!note.trim()) { alert('Please enter a reason for the parent.'); return; }
    } else if (!window.confirm('Approve this refund and send it to PayMongo now? The parent is refunded to the GCash or Maya account they paid with.')) {
        return;
    }

    refundRequestsBusy = true;
    document.querySelectorAll(`[data-refund-approve="${refundId}"], [data-refund-reject="${refundId}"]`).forEach((b) => { b.disabled = true; });
    try {
        const result = await apiFetch(`/payments/refunds/${encodeURIComponent(refundId)}/review`, {
            method: 'POST',
            body: JSON.stringify({ decision, note }),
        });
        if (result.status === 'failed') {
            alert(`PayMongo did not accept the refund: ${result.failureReason || 'unknown reason'}`);
        }
    } catch (err) {
        alert(err.message || 'Could not update the refund request.');
    } finally {
        refundRequestsBusy = false;
        await loadRefundRequests();
    }
}

function initRefundRequests(containerId) {
    refundRequestsContainerId = containerId;
    const el = document.getElementById(containerId);
    if (!el) return;
    el.addEventListener('click', (e) => {
        const approve = e.target.closest('[data-refund-approve]');
        const reject = e.target.closest('[data-refund-reject]');
        if (approve) reviewRefundRequest(approve.dataset.refundApprove, 'approve');
        if (reject) reviewRefundRequest(reject.dataset.refundReject, 'reject');
    });
    loadRefundRequests();
    KC.poll(loadRefundRequests, 60000);
}
