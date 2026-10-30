// js/pedia/patient-history.js
// Patient History — one chronological history of a child's records for the
// pediatrician, opened from the patient card on My Patients.
//
// READ-ONLY, and it stores nothing new: every entry is an existing record read
// from an endpoint that already limits it to this pediatrician's patients.
//   /assessments/:childId/history              developmental assessments + documented review
//   /checkups/child/:childId/follow-ups        follow-up check-up plans
//   /checkups/child/:childId                   own check-ups and specialist referrals
//   /assessments/child/:childId/progress-notes own progress notes
//   /appointments/pedia                        own appointments (this child's are kept)
//   /questions/assigned/:childId               own questions to the parent and answers
//   /chat/summary/child/:childId               message counts per conversation (marks nothing read)
// Each record becomes exactly one entry; nothing is merged or recomputed.
//
// Loaded after js/pedia/pediatrician-patients.js and reuses its apiFetch and
// escapeHtml. Band labels come from window.KCScoring.

// Palette tokens only (kc-tokens.css). The colour marks the entry's left border
// and the badge dot; badge text stays dark, never on a pastel fill.
const HISTORY_CATEGORIES = Object.freeze({
    assessment: { label: 'Developmental assessment', color: 'var(--primary)' },
    followup_assessment: { label: 'Follow-up assessment', color: 'var(--primary-dark)' },
    appointment: { label: 'Appointment', color: 'var(--primary-light)' },
    checkup: { label: 'Check-up / consultation', color: 'var(--text-dark)' },
    referral: { label: 'Specialist referral', color: 'var(--accent-red)' },
    followup_plan: { label: 'Follow-up plan', color: 'var(--accent)' },
    note: { label: 'Progress note', color: 'var(--text-light)' },
    questions: { label: 'Questions to parent', color: 'var(--success)' },
    chat: { label: 'Chat with parent', color: 'var(--bg-tertiary)' },
});

const HISTORY_SOURCES = Object.freeze({
    history: 'Assessments',
    followUps: 'Follow-up plans',
    checkups: 'Check-ups and referrals',
    notes: 'Progress notes',
    appointments: 'Appointments',
    questions: 'Questions to parent',
    chat: 'Chat summary',
});

const CHECKUP_STATUS_LABELS = Object.freeze({
    initial_review: 'Initial Review', monitoring: 'Monitoring', improving: 'Improving', stable: 'Stable',
    needs_attention: 'Needs Attention', referred: 'Referred', resolved: 'Resolved / Ruled Out',
    parent_monitoring: 'Parent Monitoring',
});

const APPOINTMENT_STATUS_LABELS = Object.freeze({
    pending: 'Pending', approved: 'Approved', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Rejected',
});

const PLAN_STATE_LABELS = Object.freeze({
    awaiting_payment: 'Awaiting payment', active: 'Assessments assigned', assessments_complete: 'Assessments complete',
    overdue: 'Overdue', visit_completed: 'Visit completed', cancelled: 'Cancelled',
});

let patientHistoryEntries = [];
let patientHistoryFilter = 'all';
let patientHistoryLoadToken = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function historyDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Appointment dates are stored as UTC midnight of the booked day; combined
// with the booked time so a visit sorts among the day's other records.
function appointmentWhen(appointment) {
    const day = historyDate(appointment.appointmentDate);
    if (!day) return null;
    const ymd = day.toISOString().slice(0, 10);
    const time = /^\d{1,2}:\d{2}/.test(String(appointment.appointmentTime || '')) ? String(appointment.appointmentTime).slice(0, 5).padStart(5, '0') : '00:00';
    return historyDate(`${ymd}T${time}:00`);
}

function historyDay(value, utc = false) {
    const d = historyDate(value);
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', ...(utc ? { timeZone: 'UTC' } : {}) });
}

function historyClock(value) {
    const [h, m] = String(value || '').split(':');
    const hour = parseInt(h, 10);
    if (Number.isNaN(hour)) return '';
    return `${hour % 12 || 12}:${String(m || '00').padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function historyScore(value) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : `${Math.round(Number(value))}%`;
}

function historyBand(score) {
    if (score == null || !window.KCScoring) return null;
    return window.KCScoring.clinicalLabel(window.KCScoring.bandFor(score));
}

function humanize(value) {
    const text = String(value || '').replace(/_/g, ' ').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

const sameChild = (record, childId) => record && String(record.childId) === String(childId);

// ── Building the history (pure; tests/unit/pedia-patient-history.test.js) ────

/**
 * One entry per existing record, newest first. `sources` holds each loaded
 * list (or undefined when it could not be loaded); records belonging to any
 * other child are dropped. Entry: { key, date, category, title, meta, details:
 * [[label, value]], links: [{ label, href }], upcoming }.
 */
function buildPatientHistory(sources, childId, now = new Date()) {
    const entries = [];
    const add = (entry) => entries.push({ details: [], links: [], meta: '', upcoming: false, ...entry });

    // Assessments counted toward a follow-up plan are follow-up assessments.
    const plans = (sources.followUps || []).filter((p) => sameChild(p, childId));
    const followUpAssessmentIds = new Set(plans.flatMap((p) => (p.assessments || []).map((a) => String(a.id))));

    for (const a of (sources.history || []).filter((x) => sameChild(x, childId))) {
        const complete = a.status === 'complete';
        const details = [];
        if (a.overallScore != null) {
            details.push(['Communication', historyScore(a.communicationScore)], ['Social Skills', historyScore(a.socialScore)],
                ['Cognitive', historyScore(a.cognitiveScore)], ['Motor Skills', historyScore(a.motorScore)]);
        }
        if (a.diagnosis) details.push(['Diagnosis', a.diagnosis]);
        if (a.recommendations) details.push(['Recommendations', a.recommendations]);
        if (a.nextAssessmentDate) details.push(['Next assessment', `${historyDay(a.nextAssessmentDate)}${a.nextAssessmentReason ? ` — ${a.nextAssessmentReason}` : ''}`]);
        const band = complete ? historyBand(a.overallScore) : null;
        add({
            key: `assessment:${a.id}`,
            date: historyDate(complete ? (a.completedAt || a.startedAt) : a.startedAt),
            category: followUpAssessmentIds.has(String(a.id)) ? 'followup_assessment' : 'assessment',
            title: complete
                ? `Assessment completed — overall ${historyScore(a.overallScore)}${band ? ` (${band})` : ''}`
                : `Assessment ${a.status === 'submitted' ? 'submitted' : 'started'}${a.currentProgress != null ? ` — ${Math.round(a.currentProgress)}% answered` : ''}`,
            details,
        });
    }

    for (const p of plans) {
        const details = [
            ['Status', PLAN_STATE_LABELS[p.state] || humanize(p.state)],
            ['Assessments', `${p.completed || 0} of ${p.requiredAssessments} completed`],
            ['Fee', `₱${Number(p.fee || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
        ];
        if (p.dueDate) details.push(['Due', historyDay(p.dueDate)]);
        if (p.appointment && p.appointment.date) details.push(['Follow-up visit', `${historyDay(p.appointment.date, true)}${p.appointment.time ? `, ${historyClock(p.appointment.time)}` : ''} (#${p.appointment.id})`]);
        if (p.instructions) details.push(['Instructions', p.instructions]);
        add({
            key: `plan:${p.id}`,
            date: historyDate(p.createdAt),
            category: 'followup_plan',
            title: `Follow-up check-up planned — ${p.requiredAssessments} assessment${p.requiredAssessments === 1 ? '' : 's'} over ${p.monitoringDays} days`,
            details,
        });
    }

    const checkups = sources.checkups ? (sources.checkups.checkups || []) : [];
    for (const c of checkups.filter((x) => sameChild(x, childId))) {
        const details = [];
        if (c.diagnosis) details.push(['Diagnosis', c.diagnosis]);
        if (c.findings) details.push(['Findings', c.findings]);
        if (c.recommendations) details.push(['Recommendations', c.recommendations]);
        if (c.nextFollowUpDate) details.push(['Next follow-up', `${historyDay(c.nextFollowUpDate)}${c.nextFollowUpReason ? ` — ${c.nextFollowUpReason}` : ''}`]);
        details.push(['Clinic visit', c.appointmentId != null ? `Appointment #${c.appointmentId}` : 'Not linked to a visit']);
        add({
            key: `checkup:${c.id}`,
            date: historyDate(c.checkupDate || c.createdAt),
            category: 'checkup',
            title: `${c.visitType === 'follow_up_checkup' ? 'Follow-up Check-up' : 'Initial Check-up'} — ${CHECKUP_STATUS_LABELS[c.status] || humanize(c.status)}`,
            details,
        });
    }

    const referrals = sources.checkups ? (sources.checkups.referrals || []) : [];
    for (const r of referrals.filter((x) => sameChild(x, childId))) {
        const details = [];
        if (r.specialistName) details.push(['Specialist', r.specialistName]);
        if (r.specialistContact) details.push(['Contact', r.specialistContact]);
        if (r.reason) details.push(['Reason', r.reason]);
        add({
            key: `referral:${r.id}`,
            date: historyDate(r.referredAt || r.createdAt),
            category: 'referral',
            title: `Referred to ${r.specialty || 'a specialist'}`,
            details,
        });
    }

    for (const n of (sources.notes || []).filter((x) => sameChild(x, childId))) {
        add({
            key: `note:${n.mongoId || n.id}`,
            date: historyDate(n.createdAt),
            category: 'note',
            title: `Progress note — ${humanize(n.progressStatus) || 'Recorded'}`,
            details: [['Note', n.note || '']],
        });
    }

    const appointments = (sources.appointments || []).filter((x) => sameChild(x, childId));
    const appointmentIds = new Set(appointments.map((a) => String(a.id)));
    for (const a of appointments) {
        const when = appointmentWhen(a);
        const details = [];
        if (a.reason) details.push(['Reason', a.reason]);
        if (a.notes) details.push(['Parent note', a.notes]);
        if (a.statusNote) details.push(['Clinic note', a.statusNote]);
        if (a.isRescheduled && a.reschedule && a.reschedule.originalDate) details.push(['Rescheduled from', historyDay(a.reschedule.originalDate, true)]);
        const links = [{ label: 'Open appointment', href: `/pedia/pediatrician-appointments?appointmentId=${encodeURIComponent(a.id)}` }];
        if (['approved', 'completed'].includes(a.status)) links.push({ label: 'Open chat', href: `/pedia/pedia-chat?appointmentId=${encodeURIComponent(a.id)}` });
        add({
            key: `appointment:${a.id}`,
            date: when,
            category: 'appointment',
            title: `Appointment ${APPOINTMENT_STATUS_LABELS[a.status] || humanize(a.status)}`,
            meta: `${historyDay(a.appointmentDate, true)}${a.appointmentTime ? `, ${historyClock(a.appointmentTime)}` : ''} · #${a.id}`,
            details,
            links,
            upcoming: Boolean(when && when > now && ['pending', 'approved'].includes(a.status)),
        });
    }

    // Questions sent together (one question set) form one entry.
    const groups = new Map();
    for (const q of sources.questions || []) {
        const key = q.questionSetId ? `set:${q.questionSetId}` : `single:${q.assignmentId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(q);
    }
    for (const [key, items] of groups) {
        const sent = items.map((q) => historyDate(q.createdAt)).filter(Boolean).sort((x, y) => x - y)[0] || null;
        const answered = items.filter((q) => q.answer != null && String(q.answer).trim() !== '').length;
        add({
            key: `questions:${key}`,
            date: sent,
            category: 'questions',
            title: `${items.length} question${items.length === 1 ? '' : 's'} sent to parent${items[0].setTitle ? ` — ${items[0].setTitle}` : ''} · ${answered} of ${items.length} answered`,
            details: items.map((q) => [q.questionText || 'Question', q.answer != null && String(q.answer).trim() !== ''
                ? `${q.answer}${q.answeredAt ? ` (answered ${historyDay(q.answeredAt)})` : ''}`
                : 'Not answered yet']),
        });
    }

    for (const c of sources.chat || []) {
        // Only conversations about this child's appointments (when they are known).
        if (sources.appointments && !appointmentIds.has(String(c.appointmentId))) continue;
        add({
            key: `chat:${c.appointmentId}`,
            date: historyDate(c.lastMessageAt),
            category: 'chat',
            title: `Chat with parent — ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`,
            meta: `Appointment #${c.appointmentId} · first message ${historyDay(c.firstMessageAt)}`,
            links: [{ label: 'Open chat', href: `/pedia/pedia-chat?appointmentId=${encodeURIComponent(c.appointmentId)}` }],
        });
    }

    // Newest first; undated records last.
    return entries.sort((a, b) => (b.date ? b.date.getTime() : -Infinity) - (a.date ? a.date.getTime() : -Infinity));
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderPatientHistoryFilters() {
    const wrap = document.getElementById('patientHistoryFilters');
    const counts = {};
    for (const e of patientHistoryEntries) counts[e.category] = (counts[e.category] || 0) + 1;
    const chip = (key, label, n) => `
        <button type="button" onclick="setPatientHistoryFilter('${key}')" aria-pressed="${patientHistoryFilter === key}"
            style="padding:0.35rem 0.8rem;border-radius:999px;border:1.5px solid var(--primary);font-size:0.78rem;font-weight:600;cursor:pointer;
            background:${patientHistoryFilter === key ? 'var(--primary)' : 'var(--bg-primary)'};color:${patientHistoryFilter === key ? 'var(--bg-primary)' : 'var(--primary)'};">
            ${escapeHtml(label)} (${n})</button>`;
    wrap.innerHTML = chip('all', 'All', patientHistoryEntries.length)
        + Object.keys(HISTORY_CATEGORIES).filter((k) => counts[k]).map((k) => chip(k, HISTORY_CATEGORIES[k].label, counts[k])).join('');
}

function renderPatientHistoryEntry(e) {
    const cat = HISTORY_CATEGORIES[e.category];
    const when = e.category === 'appointment' ? e.meta : `${e.date ? e.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Date not recorded'}${e.meta ? ` · ${e.meta}` : ''}`;
    return `
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-left:4px solid ${cat.color};border-radius:10px;padding:0.9rem 1.1rem;">
            <div style="display:flex;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;align-items:flex-start;">
                <div style="min-width:0;">
                    <p style="margin:0;font-size:0.78rem;color:var(--text-light);">${escapeHtml(when)}${e.upcoming ? ' <strong style="color:var(--primary);">· Upcoming</strong>' : ''}</p>
                    <p style="margin:0.2rem 0 0;font-weight:700;color:var(--text-dark);overflow-wrap:anywhere;">${escapeHtml(e.title)}</p>
                </div>
                <span style="display:inline-flex;align-items:center;gap:0.35rem;background:var(--surface-tint);color:var(--text-dark);padding:0.2rem 0.65rem;border-radius:999px;font-size:0.72rem;font-weight:700;white-space:nowrap;">
                    <span aria-hidden="true" style="width:0.55rem;height:0.55rem;border-radius:50%;background:${cat.color};"></span>${escapeHtml(cat.label)}</span>
            </div>
            ${e.details.length ? `<dl style="margin:0.6rem 0 0;display:grid;gap:0.3rem;">${e.details.map(([label, value]) => `
                <div style="font-size:0.84rem;line-height:1.5;overflow-wrap:anywhere;"><dt style="display:inline;font-weight:700;color:var(--text-dark);">${escapeHtml(label)}:</dt>
                    <dd style="display:inline;margin:0;color:var(--text-dark);white-space:pre-line;">${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
            ${e.links.length ? `<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:0.6rem;">${e.links.map((l) => `
                <a href="${escapeHtml(l.href)}" style="font-size:0.8rem;font-weight:600;color:var(--primary);">${escapeHtml(l.label)}</a>`).join('')}</div>` : ''}
        </div>`;
}

function renderPatientHistory() {
    renderPatientHistoryFilters();
    const list = document.getElementById('patientHistoryList');
    const shown = patientHistoryFilter === 'all' ? patientHistoryEntries : patientHistoryEntries.filter((e) => e.category === patientHistoryFilter);
    list.innerHTML = shown.length
        ? shown.map(renderPatientHistoryEntry).join('')
        : '<p style="text-align:center;color:var(--text-light);padding:1.5rem;background:var(--bg-primary);border-radius:10px;">No records are on file with you for this patient yet.</p>';
}

function setPatientHistoryFilter(category) {
    patientHistoryFilter = category;
    renderPatientHistory();
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function openPatientHistory(childId, childName) {
    const token = ++patientHistoryLoadToken;
    patientHistoryEntries = [];
    patientHistoryFilter = 'all';
    document.getElementById('patientHistoryTitle').textContent = `Patient History — ${childName}`;
    document.getElementById('patientHistoryNotice').innerHTML = '';
    document.getElementById('patientHistoryFilters').innerHTML = '';
    document.getElementById('patientHistoryList').innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading patient history…</p>';
    document.getElementById('patientHistoryModal').style.display = 'flex';

    const id = encodeURIComponent(childId);
    const load = (path, pick) => apiFetch(path).then(pick).catch(() => undefined);
    const [history, followUps, checkups, notes, appointments, questions, chat] = await Promise.all([
        load(`/assessments/${id}/history`, (d) => d.assessments || []),
        load(`/checkups/child/${id}/follow-ups`, (d) => d.plans || []),
        load(`/checkups/child/${id}`, (d) => ({ checkups: d.checkups || [], referrals: d.referrals || [] })),
        load(`/assessments/child/${id}/progress-notes`, (d) => d.notes || []),
        load('/appointments/pedia', (d) => (d.appointments || []).filter((a) => String(a.childId) === String(childId))),
        load(`/questions/assigned/${id}`, (d) => d.assignments || []),
        load(`/chat/summary/child/${id}`, (d) => d.conversations || []),
    ]);
    // Another patient's history was opened, or this one closed, meanwhile.
    if (token !== patientHistoryLoadToken) return;

    const sources = { history, followUps, checkups, notes, appointments, questions, chat };
    const failed = Object.keys(HISTORY_SOURCES).filter((k) => sources[k] === undefined).map((k) => HISTORY_SOURCES[k]);
    document.getElementById('patientHistoryNotice').innerHTML = failed.length
        ? `<p style="margin:0 0 0.8rem;padding:0.7rem 0.9rem;border-radius:8px;background:var(--surface-tint);font-size:0.82rem;color:var(--text-dark);">Not included because they could not be loaded right now: ${escapeHtml(failed.join(', '))}. This does not mean there are none — reopen to try again.</p>`
        : '';
    patientHistoryEntries = buildPatientHistory(sources, childId);
    renderPatientHistory();
}

function closePatientHistory() {
    patientHistoryLoadToken += 1;
    document.getElementById('patientHistoryModal').style.display = 'none';
}
