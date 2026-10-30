// js/pedia/patient-profile.js
// Patient Profile — one child's own page for the pediatrician, opened from
// My Patients → View Profile as /pedia/patient-profile?childId=<id>.
//
// Two tabs, both existing views reused for this one child:
//   Case File        openCaseFile()        js/pedia/pedia-case-files.js
//   Patient History  loadPatientHistory()  js/pedia/patient-history.js
// The child must be in this pediatrician's own patient list
// (/pedia-reports/patients, i.e. a pending, approved or completed appointment);
// otherwise nothing about them is requested. Every endpoint the two views call
// checks the same link again on the server, and both views drop any record
// whose childId is not this child's, so siblings never mix.

let profileChildId = null;
let profileHistoryLoaded = false;

function profileRequestedChildId() {
    try {
        return new URLSearchParams(window.location.search).get('childId');
    } catch {
        return null;
    }
}

function profileMessage(text) {
    document.getElementById('caseFileContent').innerHTML =
        `<div class="report-card"><div class="report-loading">${escapeHtml(text)}</div></div>`;
}

function showProfileTab(tab) {
    if (!profileChildId) return;
    const onHistory = tab === 'history';
    // The case-file print rules (pedia-reports-styles.css) apply on the Case File tab only.
    document.body.dataset.reportTab = onHistory ? 'patient-history' : 'case-files';
    document.getElementById('profileCaseFilePanel').hidden = onHistory;
    document.getElementById('profileHistoryPanel').hidden = !onHistory;
    document.getElementById('profileCaseActions').style.display = onHistory ? 'none' : '';
    document.getElementById('tabProfileCaseFile').setAttribute('aria-selected', String(!onHistory));
    document.getElementById('tabProfileHistory').setAttribute('aria-selected', String(onHistory));
    // #history reopens this tab; nothing is stored.
    const hash = onHistory ? '#history' : '';
    if (window.location.hash !== hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    }
    if (onHistory && !profileHistoryLoaded) {
        profileHistoryLoaded = true;
        loadPatientHistory(profileChildId);
    }
    // Progress charts drawn while this tab was hidden have no size.
    if (!onHistory) drawCaseFileCharts();
}

function renderProfileHeader(patient, parent) {
    const months = caseFileAgeMonths(patient.dateOfBirth, new Date());
    const sex = patient.gender ? patient.gender.charAt(0).toUpperCase() + patient.gender.slice(1) : null;
    const parts = [
        `Born ${caseFileDay(patient.dateOfBirth)}`,
        months != null ? caseFileAgeText(months) : null,
        sex,
        parent && parent.name ? `Parent: ${parent.name}${parent.email ? ` (${parent.email})` : ''}` : null,
    ].filter(Boolean);
    document.getElementById('profileName').textContent = patient.name;
    document.getElementById('profileMeta').textContent = parts.join(' · ');
    document.title = `${patient.name} - Patient Profile - KinderCura`;
}

async function initPatientProfile() {
    const requested = profileRequestedChildId();
    if (!requested) {
        document.getElementById('profileMeta').textContent = '';
        profileMessage('No patient was selected. Open a profile from My Patients.');
        return;
    }

    let patients;
    try {
        patients = await loadCaseFilePatients();
    } catch (err) {
        document.getElementById('profileMeta').textContent = '';
        profileMessage(`Your patient list could not be loaded right now: ${err.message}`);
        return;
    }

    const patient = patients.find((p) => p.childId === String(requested));
    if (!patient) {
        document.getElementById('profileMeta').textContent = '';
        profileMessage('This child is not one of your patients, so their profile cannot be shown.');
        return;
    }

    profileChildId = patient.childId;
    renderProfileHeader(patient, null);
    loadCaseFileParents()
        .then((parents) => renderProfileHeader(patient, parents.get(patient.childId) || null))
        .catch(() => {});

    document.getElementById('profileTabs').hidden = false;
    showProfileTab(window.location.hash === '#history' ? 'history' : 'case-file');
    openCaseFile(patient.childId);
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof initNav === 'function') initNav();
    initPatientProfile();
});
