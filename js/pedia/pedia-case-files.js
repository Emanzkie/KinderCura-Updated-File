// js/pedia/pedia-case-files.js
// Patient Case Files — one patient's complete record on the pediatrician
// Reports page, printable on its own.
//
// READ-ONLY, and it scores nothing. Every value comes from an endpoint that
// already checks this pediatrician may see the child (a live pending, approved
// or completed appointment — services/patientAccess.js):
//   /pedia-reports/patients      the patient list (this pediatrician's scope)
//   /assessments/pedia-patients  parent name and e-mail (the My Patients source)
//   /assessments/:childId/history  assessments, stored scores, documented review
//   /checkups/child/:childId     this pediatrician's check-ups and referrals
// /recommendations/:assessmentId is deliberately NOT used: it writes generated
// recommendations when none exist yet.
//
// Loaded after js/pedia/pedia-reports.js and reuses its escapeHtml,
// fmtShortDate, scoreText, bandChip and deltaHtml. Band keys and labels come
// from window.KCScoring, like every other section of this page.

const CASE_FILE_DOMAINS = Object.freeze([
    { label: 'Communication', field: 'communicationScore' },
    { label: 'Social Skills', field: 'socialScore' },
    { label: 'Cognitive', field: 'cognitiveScore' },
    { label: 'Motor Skills', field: 'motorScore' },
]);

const CASE_FILE_CHECKUP_STATUS = Object.freeze({
    initial_review: 'Initial Review',
    monitoring: 'Monitoring',
    improving: 'Improving',
    stable: 'Stable',
    needs_attention: 'Needs Attention',
    referred: 'Referred',
    resolved: 'Resolved / Ruled Out',
    parent_monitoring: 'Parent Monitoring',
});

let caseFilePatients = null;      // [{ childId, name, dateOfBirth, gender, assessmentCount }]
let caseFileParentsByChild = null; // Map childId -> { name, email }
let caseFileMatches = [];
let caseFileActiveIndex = -1;
let caseFileSelectedId = null;
let caseFileLoadToken = 0;
let practiceReportsShown = false;       // Practice Reports has been visible at least once
let practiceReportsDrawnHidden = false; // its charts were drawn while it was hidden

// ── Tabs ────────────────────────────────────────────────────────────────────

function showReportTab(tab) {
    const caseFiles = tab !== 'practice-reports';
    document.body.dataset.reportTab = caseFiles ? 'case-files' : 'practice-reports';
    document.getElementById('caseFilePanel').hidden = !caseFiles;
    document.getElementById('practiceReportsPanel').hidden = caseFiles;
    document.getElementById('tabCaseFiles').setAttribute('aria-selected', String(caseFiles));
    document.getElementById('tabPracticeReports').setAttribute('aria-selected', String(!caseFiles));
    document.getElementById('caseFileMeta').hidden = !caseFiles;
    document.getElementById('reportMeta').hidden = caseFiles;
    document.getElementById('exportBtn').hidden = caseFiles;
    // A bookmarkable view without storing anything: #practice-reports reopens it.
    const hash = caseFiles ? '' : '#practice-reports';
    if (window.location.hash !== hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    }
    // Chart.js charts drawn inside the hidden panel stay 0×0 even after a
    // resize, so the first time Practice Reports is shown its sections are
    // loaded again while visible (loadReports drops any older in-flight load).
    if (caseFiles) {
        practiceReportsDrawnHidden = practiceReportsDrawnHidden || !practiceReportsShown;
    } else {
        practiceReportsShown = true;
        if (practiceReportsDrawnHidden && typeof loadReports === 'function') loadReports();
        practiceReportsDrawnHidden = false;
    }
}

// ── Pure helpers (also exercised by tests/unit/pedia-case-files.test.js) ────

/** Patients whose name contains every typed word, case-insensitively. */
function filterCaseFilePatients(patients, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return patients.slice();
    return patients.filter((p) => {
        const name = String(p.name || '').toLowerCase();
        return words.every((w) => name.includes(w));
    });
}

/** Whole months between two dates (age at a date); null when unusable. */
function caseFileAgeMonths(dateOfBirth, atDate) {
    if (!dateOfBirth || !atDate) return null;
    const dob = new Date(dateOfBirth);
    const at = new Date(atDate);
    if (Number.isNaN(dob.getTime()) || Number.isNaN(at.getTime())) return null;
    let months = (at.getFullYear() - dob.getFullYear()) * 12 + (at.getMonth() - dob.getMonth());
    if (at.getDate() < dob.getDate()) months -= 1;
    return Math.max(0, months);
}

function caseFileAgeText(months) {
    if (months == null) return '—';
    const years = Math.floor(months / 12);
    const rem = months % 12;
    if (years <= 0) return `${rem} mo`;
    return rem ? `${years} y ${rem} mo` : `${years} y`;
}

function caseFileLongDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Date-only fields (date of birth, follow-up dates) are stored as UTC midnight;
// reading them in UTC keeps a behind-UTC browser from showing the day before.
function caseFileDay(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** This child's completed assessments, oldest first. Anything else is dropped. */
function caseFileAssessments(history, childId) {
    return (history || [])
        .filter((a) => String(a.childId) === String(childId) && a.status === 'complete')
        .sort((a, b) => new Date(a.completedAt || a.startedAt || 0) - new Date(b.completedAt || b.startedAt || 0));
}

function pointsBetween(from, to) {
    if (from == null || to == null) return null;
    return Math.round(Number(to)) - Math.round(Number(from));
}

/**
 * First vs latest scored assessment: the stored score for each area and
 * overall, and the difference in percentage points. Arithmetic on stored
 * values only. null when fewer than two assessments have scores.
 */
function caseFileComparison(assessments) {
    const scored = assessments.filter((a) => a.overallScore != null);
    if (scored.length < 2) return null;
    const first = scored[0];
    const latest = scored[scored.length - 1];
    return {
        first,
        latest,
        count: scored.length,
        rows: [
            ...CASE_FILE_DOMAINS.map((d) => ({
                label: d.label, from: first[d.field], to: latest[d.field], diff: pointsBetween(first[d.field], latest[d.field]),
            })),
            { label: 'Overall', from: first.overallScore, to: latest.overallScore, diff: pointsBetween(first.overallScore, latest.overallScore), overall: true },
        ],
    };
}

function changeWords(diff) {
    if (diff == null) return 'could not be compared';
    if (diff > 0) return `increased ${diff} pts`;
    if (diff < 0) return `decreased ${Math.abs(diff)} pts`;
    return 'did not change';
}

// ── Rendering ───────────────────────────────────────────────────────────────

function caseFileBand(score) {
    return score == null ? bandChip(null) : bandChip(window.KCScoring.bandFor(score));
}

function caseFileField(label, value) {
    return `<div class="cf-field"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function renderCaseFileHistory(child, assessments) {
    if (!assessments.length) {
        return '<p class="cf-empty">No completed assessments are on record for this patient.</p>';
    }
    const rows = assessments.map((a, i) => {
        const previous = assessments.slice(0, i).reverse().find((p) => p.overallScore != null);
        const change = a.overallScore != null && previous ? deltaHtml(pointsBetween(previous.overallScore, a.overallScore)) : '<span class="delta delta-flat">—</span>';
        return `
            <tr>
                <td class="cf-nowrap">${escapeHtml(fmtShortDate(a.completedAt))}</td>
                <td class="cf-nowrap">${escapeHtml(caseFileAgeText(caseFileAgeMonths(child.dateOfBirth, a.completedAt)))}</td>
                ${CASE_FILE_DOMAINS.map((d) => `<td class="num">${escapeHtml(scoreText(a[d.field]))}</td>`).join('')}
                <td class="num"><strong>${escapeHtml(scoreText(a.overallScore))}</strong></td>
                <td>${caseFileBand(a.overallScore)}</td>
                <td class="num">${change}</td>
            </tr>`;
    }).join('');
    return `
        <div class="report-table-wrap">
            <table class="report-table cf-table">
                <thead>
                    <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Age</th>
                        ${CASE_FILE_DOMAINS.map((d) => `<th scope="col" class="num">${escapeHtml(d.label)}</th>`).join('')}
                        <th scope="col" class="num">Overall</th>
                        <th scope="col">Classification</th>
                        <th scope="col" class="num">Change</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p class="cf-note">Change = overall score difference from the previous scored assessment, in percentage points (pts).</p>`;
}

function renderCaseFileComparison(assessments) {
    const cmp = caseFileComparison(assessments);
    if (!cmp) {
        return '<p class="cf-empty">Not enough assessments to compare yet. A comparison needs at least two scored assessments.</p>';
    }
    const overall = cmp.rows[cmp.rows.length - 1];
    return `
        <p class="cf-lead">
            Comparing the first scored assessment (${escapeHtml(fmtShortDate(cmp.first.completedAt))}) with the latest
            (${escapeHtml(fmtShortDate(cmp.latest.completedAt))}), across ${cmp.count} scored assessments:
            the overall score ${escapeHtml(changeWords(overall.diff))}.
        </p>
        <div class="report-table-wrap">
            <table class="report-table cf-table">
                <thead>
                    <tr>
                        <th scope="col">Area</th>
                        <th scope="col" class="num">First</th>
                        <th scope="col" class="num">Latest</th>
                        <th scope="col" class="num">Change</th>
                        <th scope="col">Latest classification</th>
                    </tr>
                </thead>
                <tbody>
                    ${cmp.rows.map((r) => `
                        <tr${r.overall ? ' class="cf-total"' : ''}>
                            <td>${r.overall ? '<strong>Overall</strong>' : escapeHtml(r.label)}</td>
                            <td class="num">${escapeHtml(scoreText(r.from))}</td>
                            <td class="num">${escapeHtml(scoreText(r.to))}</td>
                            <td class="num">${deltaHtml(r.diff)}</td>
                            <td>${caseFileBand(r.to)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p class="cf-note">Differences between stored screening scores. They describe recorded answers, not a cause or a diagnosis.</p>`;
}

function renderCaseFileReviews(assessments) {
    const reviewed = assessments.filter((a) => a.diagnosis || a.recommendations || a.nextAssessmentDate);
    if (!reviewed.length) {
        return '<p class="cf-empty">No diagnosis or recommendation has been documented on these assessments.</p>';
    }
    return reviewed.slice().reverse().map((a) => `
        <div class="cf-entry">
            <p class="cf-entry-date">Assessment of ${escapeHtml(caseFileLongDate(a.completedAt))}</p>
            <dl class="cf-fields">
                ${a.diagnosis ? caseFileField('Diagnosis', escapeHtml(a.diagnosis)) : ''}
                ${a.recommendations ? caseFileField('Recommendations', escapeHtml(a.recommendations)) : ''}
                ${a.nextAssessmentDate ? caseFileField('Next assessment', `${escapeHtml(caseFileDay(a.nextAssessmentDate))}${a.nextAssessmentReason ? ` — ${escapeHtml(a.nextAssessmentReason)}` : ''}`) : ''}
            </dl>
        </div>`).join('');
}

function renderCaseFileCheckups(checkupsResult) {
    if (checkupsResult.error) {
        return '<p class="cf-empty">Check-up history could not be loaded right now. This does not mean none has been recorded.</p>';
    }
    const { checkups, referrals, referralsError } = checkupsResult;
    const visits = checkups.map((c) => `
        <div class="cf-entry">
            <p class="cf-entry-date">${escapeHtml(caseFileLongDate(c.checkupDate))} &middot;
                ${c.visitType === 'follow_up_checkup' ? 'Follow-up Check-up' : 'Initial Check-up'} &middot;
                ${escapeHtml(CASE_FILE_CHECKUP_STATUS[c.status] || c.status || 'Recorded')}</p>
            <dl class="cf-fields">
                ${c.diagnosis ? caseFileField('Diagnosis', escapeHtml(c.diagnosis)) : ''}
                ${c.findings ? caseFileField('Findings', escapeHtml(c.findings)) : ''}
                ${c.recommendations ? caseFileField('Recommendations', escapeHtml(c.recommendations)) : ''}
                ${c.nextFollowUpDate ? caseFileField('Next follow-up', `${escapeHtml(caseFileDay(c.nextFollowUpDate))}${c.nextFollowUpReason ? ` — ${escapeHtml(c.nextFollowUpReason)}` : ''}`) : ''}
            </dl>
        </div>`).join('');
    const refs = referrals.map((r) => `
        <div class="cf-entry">
            <p class="cf-entry-date">${escapeHtml(caseFileLongDate(r.referredAt))} &middot; Specialist referral</p>
            <dl class="cf-fields">
                ${caseFileField('Specialty', escapeHtml(r.specialty))}
                ${r.specialistName ? caseFileField('Specialist', escapeHtml(r.specialistName)) : ''}
                ${r.specialistContact ? caseFileField('Contact', escapeHtml(r.specialistContact)) : ''}
                ${r.reason ? caseFileField('Reason', escapeHtml(r.reason)) : ''}
            </dl>
        </div>`).join('');
    return `
        ${visits || '<p class="cf-empty">No check-up visits have been recorded by you for this patient.</p>'}
        ${referralsError ? '<p class="cf-empty">Specialist referrals could not be loaded right now.</p>' : ''}
        ${refs ? `<h3 class="cf-subhead">Specialist referrals</h3>${refs}` : ''}`;
}

/**
 * The whole case file. `data` = { patient, parent, history, checkups }, all
 * for the same child; assessments for any other child are dropped here.
 */
function renderCaseFile(data) {
    const { patient } = data;
    const assessments = caseFileAssessments(data.history, patient.childId);
    const latest = assessments.slice().reverse().find((a) => a.overallScore != null) || null;
    const me = (window.KC && KC.user && KC.user()) || {};
    const preparedBy = [me.firstName, me.lastName].filter(Boolean).join(' ');
    const parent = data.parent;

    return `
        <article class="case-file" aria-label="Case file for ${escapeHtml(patient.name)}">
            <header class="cf-header">
                <div>
                    <p class="cf-kicker">KinderCura &mdash; Patient Case File</p>
                    <h2 class="cf-title">${escapeHtml(patient.name)}</h2>
                </div>
                <p class="cf-generated">Generated ${escapeHtml(new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }))}${preparedBy ? `<br>Prepared by Dr. ${escapeHtml(preparedBy)}` : ''}</p>
            </header>

            <section class="cf-section">
                <h3>Patient information</h3>
                <dl class="cf-fields cf-grid">
                    ${caseFileField('Full name', escapeHtml(patient.name))}
                    ${caseFileField('Date of birth', escapeHtml(caseFileDay(patient.dateOfBirth)))}
                    ${caseFileField('Sex', escapeHtml(patient.gender ? patient.gender.charAt(0).toUpperCase() + patient.gender.slice(1) : 'Not recorded'))}
                    ${caseFileField('Current age', escapeHtml(caseFileAgeText(caseFileAgeMonths(patient.dateOfBirth, new Date()))))}
                </dl>
            </section>

            <section class="cf-section">
                <h3>Parent / guardian</h3>
                <dl class="cf-fields cf-grid">
                    ${caseFileField('Name', escapeHtml(parent && parent.name ? parent.name : 'Not available'))}
                    ${caseFileField('E-mail', escapeHtml(parent && parent.email ? parent.email : 'Not available'))}
                </dl>
            </section>

            <section class="cf-section">
                <h3>Assessment summary</h3>
                <dl class="cf-fields cf-grid">
                    ${caseFileField('Completed assessments', String(assessments.length))}
                    ${caseFileField('First assessment', escapeHtml(assessments.length ? caseFileLongDate(assessments[0].completedAt) : '—'))}
                    ${caseFileField('Latest assessment', escapeHtml(assessments.length ? caseFileLongDate(assessments[assessments.length - 1].completedAt) : '—'))}
                    ${caseFileField('Latest overall result', latest ? `${escapeHtml(scoreText(latest.overallScore))} ${caseFileBand(latest.overallScore)}` : '—')}
                </dl>
            </section>

            <section class="cf-section">
                <h3>Assessment history</h3>
                ${renderCaseFileHistory(patient, assessments)}
            </section>

            <section class="cf-section">
                <h3>Developmental progress comparison</h3>
                ${renderCaseFileComparison(assessments)}
            </section>

            <section class="cf-section">
                <h3>Pediatrician reviews &amp; recommendations</h3>
                ${renderCaseFileReviews(assessments)}
            </section>

            <section class="cf-section">
                <h3>Check-up history</h3>
                ${renderCaseFileCheckups(data.checkups)}
            </section>

            <footer class="cf-footer">
                Confidential patient record. Scores are rule-based developmental screening scores from completed
                assessments; they are not a diagnosis. Classifications follow KinderCura's scoring bands:
                ${window.KCScoring.ACTIVE_BANDS.map((b) => `${escapeHtml(window.KCScoring.clinicalLabel(b.key))} ${b.min}&ndash;${b.max}%`).join(', ')}.
            </footer>
        </article>`;
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadCaseFilePatients() {
    if (caseFilePatients) return caseFilePatients;
    const data = await apiFetch('/pedia-reports/patients');
    caseFilePatients = (data.patients || []).map((p) => ({
        childId: String(p.childId),
        name: p.name,
        dateOfBirth: p.dateOfBirth,
        gender: p.gender,
        assessmentCount: p.assessmentCount,
    }));
    return caseFilePatients;
}

async function loadCaseFileParents() {
    if (caseFileParentsByChild) return caseFileParentsByChild;
    const data = await apiFetch('/assessments/pedia-patients');
    const map = new Map();
    for (const p of data.patients || []) {
        if (!p.childId || map.has(String(p.childId))) continue;
        map.set(String(p.childId), {
            name: [p.parentFirstName, p.parentLastName].filter(Boolean).join(' '),
            email: p.parentEmail || '',
        });
    }
    caseFileParentsByChild = map;
    return map;
}

async function openCaseFile(childId) {
    const patient = (caseFilePatients || []).find((p) => p.childId === String(childId));
    if (!patient) return;
    const token = ++caseFileLoadToken;
    caseFileSelectedId = patient.childId;

    const content = document.getElementById('caseFileContent');
    const printBtn = document.getElementById('printCaseFileBtn');
    printBtn.hidden = true;
    content.innerHTML = `<div class="report-card"><div class="report-loading">Loading ${escapeHtml(patient.name)}'s case file…</div></div>`;

    const id = encodeURIComponent(patient.childId);
    try {
        const [historyData, checkups, parents] = await Promise.all([
            apiFetch(`/assessments/${id}/history`),
            apiFetch(`/checkups/child/${id}`)
                .then((r) => ({ checkups: r.checkups || [], referrals: r.referrals || [], referralsError: r.referralsError || null, error: null }))
                .catch((err) => ({ checkups: [], referrals: [], referralsError: null, error: err })),
            loadCaseFileParents().catch(() => new Map()),
        ]);
        // Another patient was picked while this one loaded: drop this response.
        if (token !== caseFileLoadToken || caseFileSelectedId !== patient.childId) return;

        content.innerHTML = `<div class="report-card case-file-card">${renderCaseFile({
            patient,
            parent: parents.get(patient.childId) || null,
            history: historyData.assessments || [],
            checkups,
        })}</div>`;
        printBtn.hidden = false;
    } catch (err) {
        if (token !== caseFileLoadToken) return;
        content.innerHTML = `<div class="report-card"><div class="report-loading">This case file could not be loaded: ${escapeHtml(err.message)}</div></div>`;
    }
}

function printCaseFile() {
    if (!caseFileSelectedId) return;
    window.print();
}

// ── Searchable patient picker ───────────────────────────────────────────────

function renderCaseFileResults() {
    const list = document.getElementById('caseFileResults');
    const input = document.getElementById('caseFileSearch');
    if (!caseFileMatches.length) {
        list.innerHTML = '<li class="case-file-result is-empty" role="option" aria-disabled="true">No matching patient</li>';
    } else {
        list.innerHTML = caseFileMatches.map((p, i) => `
            <li class="case-file-result${i === caseFileActiveIndex ? ' is-active' : ''}" role="option" id="caseFileOption${i}"
                aria-selected="${i === caseFileActiveIndex}" data-child-id="${escapeHtml(p.childId)}">
                <span class="case-file-result-name">${escapeHtml(p.name)}</span>
                <span class="case-file-result-meta">Born ${escapeHtml(caseFileDay(p.dateOfBirth))} &middot; ${count(p.assessmentCount)} ${plural(p.assessmentCount, 'assessment')}</span>
            </li>`).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (caseFileActiveIndex >= 0) input.setAttribute('aria-activedescendant', `caseFileOption${caseFileActiveIndex}`);
    else input.removeAttribute('aria-activedescendant');
}

function closeCaseFileResults() {
    document.getElementById('caseFileResults').hidden = true;
    const input = document.getElementById('caseFileSearch');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    caseFileActiveIndex = -1;
}

async function updateCaseFileResults() {
    const input = document.getElementById('caseFileSearch');
    try {
        const patients = await loadCaseFilePatients();
        caseFileMatches = filterCaseFilePatients(patients, input.value);
        caseFileActiveIndex = caseFileMatches.length ? 0 : -1;
        renderCaseFileResults();
    } catch (err) {
        const list = document.getElementById('caseFileResults');
        list.innerHTML = `<li class="case-file-result is-empty" role="option" aria-disabled="true">Patients could not be loaded: ${escapeHtml(err.message)}</li>`;
        list.hidden = false;
    }
}

function chooseCaseFilePatient(childId) {
    const patient = (caseFilePatients || []).find((p) => p.childId === String(childId));
    if (!patient) return;
    document.getElementById('caseFileSearch').value = patient.name;
    closeCaseFileResults();
    openCaseFile(patient.childId);
}

function initCaseFilePicker() {
    const input = document.getElementById('caseFileSearch');
    const list = document.getElementById('caseFileResults');
    if (!input || !list) return;

    input.addEventListener('focus', updateCaseFileResults);
    input.addEventListener('input', updateCaseFileResults);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (list.hidden) { updateCaseFileResults(); return; }
            if (!caseFileMatches.length) return;
            const step = e.key === 'ArrowDown' ? 1 : -1;
            caseFileActiveIndex = (caseFileActiveIndex + step + caseFileMatches.length) % caseFileMatches.length;
            renderCaseFileResults();
        } else if (e.key === 'Enter') {
            if (!list.hidden && caseFileMatches[caseFileActiveIndex]) {
                e.preventDefault();
                chooseCaseFilePatient(caseFileMatches[caseFileActiveIndex].childId);
            }
        } else if (e.key === 'Escape') {
            closeCaseFileResults();
        }
    });
    // mousedown, not click: it fires before the input's blur closes the list.
    list.addEventListener('mousedown', (e) => {
        const item = e.target.closest('[data-child-id]');
        if (!item) return;
        e.preventDefault();
        chooseCaseFilePatient(item.dataset.childId);
    });
    input.addEventListener('blur', () => setTimeout(closeCaseFileResults, 120));
}

document.addEventListener('DOMContentLoaded', () => {
    showReportTab(window.location.hash === '#practice-reports' ? 'practice-reports' : 'case-files');
    initCaseFilePicker();
});
