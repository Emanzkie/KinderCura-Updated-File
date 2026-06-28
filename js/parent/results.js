// === Extracted from PARENT\results.html (script block 1) ===
requireAuth();

let allChildren = [];
let activeChild = null;
let activeAssessment = null;
let latestReview = null;

// Small HTML escape helper so diagnosis/recommendation text is safe in the page.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getStatusLabel(score) {
    if (score >= 80) return { label:'Excellent', color:'var(--primary)' };
    if (score >= 60) return { label:'Good', color:'var(--primary)' };
    if (score >= 40) return { label:'Fair', color:'var(--accent-red)' };
    return { label:'Needs Attention', color:'var(--accent-red)' };
}

function getOverallStatus(score) {
    if (score >= 80) return 'On Track';
    if (score >= 60) return 'Developing';
    return 'Needs Support';
}

function getRequestedChildId() {
    try { return new URLSearchParams(window.location.search).get('childId') || localStorage.getItem('kc_childId') || localStorage.getItem('kc_viewChildId'); } 
    catch { return localStorage.getItem('kc_childId') || localStorage.getItem('kc_viewChildId'); }
}

function getRequestedAssessmentId() {
    try { return new URLSearchParams(window.location.search).get('assessmentId') || localStorage.getItem('kc_assessmentId'); } 
    catch { return localStorage.getItem('kc_assessmentId'); }
}

function setParentContext(childId, assessmentId = null) {
    if (childId) localStorage.setItem('kc_childId', childId);
    else localStorage.removeItem('kc_childId');
    if (assessmentId) localStorage.setItem('kc_assessmentId', assessmentId);
    else localStorage.removeItem('kc_assessmentId');
}

async function fetchParentChildren() {
    try {
        const data = await apiFetch('/children');
        return data.children || [];
    } catch (error) {
        console.error("Error fetching parent children:", error);
        return [];
    }
}

async function getLatestCompletedAssessment(childId) {
    try {
        const hist = await apiFetch(`/assessments/${childId}/history`);
        const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
        if (assessments.length > 0) return assessments[0];
        return null;
    } catch (error) {
        console.error("Error fetching latest completed assessment:", error);
        return null;
    }
}

function fmtDate(dateString) {
    if (!dateString) return 'Recent';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtScheduledDate(dateString) {
    if (!dateString) return '';
    const match = String(dateString).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        const [, year, month, day] = match;
        return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });
    }
    return fmtDate(dateString);
}

function switchChild(childId) {
    setParentContext(childId, null);
    window.location.href = `/parent/results.html?childId=${encodeURIComponent(childId)}`;
}

function openRecommendationsPage() {
    const q = new URLSearchParams();
    if (activeChild?.id) q.set('childId', activeChild.id);
    if (activeAssessment?.id) q.set('assessmentId', activeAssessment.id);
    window.location.href = `/parent/recommendations.html?${q.toString()}`;
}

function renderChildSwitcher() {
    const wrap = document.getElementById('childSwitchWrap');
    if (!wrap) return;
    if (allChildren.length <= 1) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = `
        <select id="childSwitch" class="child-select" onchange="switchChild(this.value)">
            ${allChildren.map((c) => `<option value="${c.id}" ${c.id === activeChild?.id ? 'selected' : ''}>${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}</option>`).join('')}
        </select>`;
}

// Resolve the correct child and latest completed assessment for the page.
async function resolveContext() {
    const requestedChildId = getRequestedChildId();
    const requestedAssessmentId = getRequestedAssessmentId();

    let userRole = 'parent';
    try {
        const user = JSON.parse(localStorage.getItem('kc_user') || '{}');
        userRole = user.role || 'parent';
    } catch(e) {}

    if (userRole === 'pediatrician' || userRole === 'admin') {
        const childName = localStorage.getItem('kc_viewChildName') || 'Patient';
        const fName = childName.split(' ')[0] || 'Patient';
        const lName = childName.substring(fName.length).trim() || '';
        activeChild = { id: requestedChildId, firstName: fName, lastName: lName };

        if (requestedAssessmentId) {
            activeAssessment = { id: requestedAssessmentId };
            return requestedAssessmentId;
        }
        if (requestedChildId) {
            const latest = await getLatestCompletedAssessment(requestedChildId);
            if (latest?.id) {
                activeAssessment = latest;
                return latest.id;
            }
        }
        return null;
    }

    allChildren = await fetchParentChildren();
    if (!allChildren.length) return null;

    activeChild = allChildren.find((c) => String(c.id) === String(requestedChildId)) || allChildren[0];
    renderChildSwitcher();

    if (requestedAssessmentId) {
        try {
            const forced = await apiFetch(`/assessments/${requestedAssessmentId}/results`);
            if (String(forced.results?.childId || '') === String(activeChild.id)) {
                activeAssessment = { id: requestedAssessmentId };
                return requestedAssessmentId;
            }
        } catch {}
    }

    const latest = await getLatestCompletedAssessment(activeChild.id);
    activeAssessment = latest;
    if (latest?.id) {
        setParentContext(activeChild.id, latest.id);
        return latest.id;
    }

    setParentContext(activeChild.id, null);
    return null;
}

// Opens the compact diagnosis card content in a modal with full details.
function openDiagnosisModal() {
    const modal = document.getElementById('diagnosisModal');
    const body = document.getElementById('diagnosisModalBody');
    if (!modal || !body || !latestReview) return;

    body.innerHTML = `
        <div class="diagnosis-section">
            <h4>Diagnosis</h4>
            <p>${escapeHtml(latestReview.diagnosis || 'No diagnosis provided yet.')}</p>
        </div>
        <div class="diagnosis-section">
            <h4>Recommendation for Parent</h4>
            <p>${escapeHtml(latestReview.recommendation || latestReview.recommendations || 'No parent recommendation provided yet.')}</p>
        </div>
        <div class="diagnosis-section">
            <h4>Next Assessment</h4>
            <p>${latestReview.nextAssessmentDate ? `Your next scheduled assessment is on: ${escapeHtml(fmtScheduledDate(latestReview.nextAssessmentDate))}` : 'No follow-up scheduled yet.'}</p>
            ${latestReview.nextAssessmentReason ? `<p>${escapeHtml(latestReview.nextAssessmentReason)}</p>` : ''}
        </div>`;

    modal.style.display = 'flex';
}

function closeDiagnosisModal() {
    const modal = document.getElementById('diagnosisModal');
    if (modal) modal.style.display = 'none';
}

async function loadResults() {
    try {
        const assessmentId = await resolveContext();
        if (!assessmentId || !activeChild) {
            document.getElementById('resultsMeta').textContent = 'No completed screening yet';
            document.getElementById('resultsContent').innerHTML = `
                <div style="text-align:center;padding:3rem;background:white;border-radius:15px;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
                    <p style="font-size:1.1rem;font-weight:600;margin-bottom:1rem;">No assessment results yet</p>
                    <p style="color:var(--text-light);margin-bottom:1.5rem;">Complete a screening first to view results for this child.</p>
                    <button class="btn btn-primary" onclick="window.location.href='/parent/screening.html'">Start Screening</button>
                </div>`;
            return;
        }

        const data = await apiFetch(`/assessments/${assessmentId}/results`);
        const r = data.results;
        if (!r) throw new Error('No results data returned from server.');

        activeAssessment = { id: r.assessmentId, ...r };
        latestReview = {
            diagnosis: r.diagnosis || '',
            recommendation: r.parentRecommendation || r.pediatricianRecommendation || r.recommendations || '',
            reviewedAt: r.reviewedAt || null,
            reviewedByPediatrician: r.reviewedByPediatrician || null,
            nextAssessmentDate: r.nextAssessmentDate || null,
            nextAssessmentReason: r.nextAssessmentReason || null
        };
        setParentContext(activeChild.id, r.assessmentId);

        const overall = Math.round(r.overallScore || 0);
        const dateStr = r.generatedAt ? fmtDate(r.generatedAt) : 'Recent';
        document.getElementById('resultsMeta').textContent = `${escapeHtml(activeChild.firstName)} ${escapeHtml(activeChild.lastName)} • Assessment Date: ${dateStr}`;

        const domains = [
            { label:'Communication', icon:'<img src="/icons/communication.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', score: Math.round(r.communicationScore || 0) },
            { label:'Social Skills', icon:'<img src="/icons/social.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', score: Math.round(r.socialScore || 0) },
            { label:'Cognitive', icon:'<img src="/icons/cognitive.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', score: Math.round(r.cognitiveScore || 0) },
            { label:'Motor Skills', icon:'<img src="/icons/motor.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', score: Math.round(r.motorScore || 0) }
        ];
        const riskFlags = r.riskFlags || [];

        // Smaller banner card instead of the large review block.
        // We show the banner whenever a diagnosis/recommendation exists, even if
        // the frontend is loading a recently saved result before the review flag refreshes.
        const hasPediatricianReview = Boolean(latestReview.diagnosis || latestReview.recommendation);
        const reviewBanner = hasPediatricianReview ? `
            <div class="diagnosis-banner">
                <div>
                    <h3>Pediatrician Diagnosis</h3>
                    <p>${latestReview.reviewedAt ? `Reviewed on ${fmtDate(latestReview.reviewedAt)}.` : 'Reviewed by your assigned pediatrician.'} Open the review to see the full diagnosis and recommendation.</p>
                </div>
                <button class="diagnosis-btn" onclick="openDiagnosisModal()">View Diagnosis</button>
            </div>` : '';
        const followUpBanner = `
            <div class="follow-up-banner ${r.nextAssessmentDate ? '' : 'follow-up-empty'}">
                <div>
                    <h3>Next Assessment</h3>
                    <p>${r.nextAssessmentDate ? `Your next scheduled assessment is on: <strong>${escapeHtml(fmtScheduledDate(r.nextAssessmentDate))}</strong>` : 'No follow-up scheduled yet.'}</p>
                    ${r.nextAssessmentReason ? `<p class="follow-up-note">${escapeHtml(r.nextAssessmentReason)}</p>` : ''}
                </div>
                <button class="follow-up-action" onclick="window.location.href='/parent/appointments.html'">Appointments</button>
            </div>`;

        document.getElementById('resultsContent').innerHTML = `
            ${followUpBanner}
            ${reviewBanner}

            <div class="results-overview-grid" style="background:white;border-radius:15px;padding:2rem;margin-bottom:2rem;box-shadow:0 4px 15px rgba(0,0,0,0.08);display:grid;grid-template-columns:200px 1fr;gap:3rem;align-items:center;">
                <div style="text-align:center;">
                    <div style="width:150px;height:150px;border-radius:50%;background:linear-gradient(135deg,var(--primary) 0%,var(--primary-light) 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;color:white;margin:0 auto;">
                        <span style="font-size:2.5rem;font-weight:700;">${overall}</span>
                        <span style="font-size:1rem;">%</span>
                    </div>
                </div>
                <div>
                    <h2 style="color:var(--primary);margin-bottom:0.5rem;">${getOverallStatus(overall)}</h2>
                    <p style="color:var(--text-light);line-height:1.6;margin-bottom:1.5rem;">
                        ${overall >= 80 ? 'Your child is developing well overall and progressing as expected for their age.' : overall >= 60 ? 'Your child is making good progress. Some areas may benefit from additional focus.' : 'Your child may benefit from additional support. Consider consulting a pediatrician.'}
                        ${riskFlags.length ? ' Note: ' + escapeHtml(riskFlags.join('; ')) + '.' : ''}
                    </p>
                    <div class="results-domain-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;">
                        ${domains.map((d) => `
                            <div style="background:var(--bg-primary);padding:1rem;border-radius:8px;text-align:center;">
                                <span style="display:block;font-size:1.2rem;margin-bottom:0.5rem;">${d.icon}</span>
                                <div style="font-weight:700;color:${getStatusLabel(d.score).color};margin-bottom:0.3rem;">${d.score}%</div>
                                <div style="font-size:0.8rem;color:var(--text-light);">${d.label}</div>
                            </div>`).join('')}
                    </div>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.5rem;margin-bottom:2rem;">
                ${domains.map((d) => {
                    const st = getStatusLabel(d.score);
                    return `
                        <div style="background:white;border-radius:15px;padding:1.5rem;box-shadow:0 4px 15px rgba(0,0,0,0.08);border-left:4px solid ${st.color};">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:.8rem;">
                                <h3>${d.icon} ${d.label}</h3>
                                <span style="background:${st.color};color:white;padding:0.4rem 0.8rem;border-radius:20px;font-size:0.8rem;font-weight:600;white-space:nowrap;">${st.label}</span>
                            </div>
                            <div style="height:8px;background:var(--border);border-radius:10px;margin-bottom:1rem;overflow:hidden;">
                                <div style="height:100%;width:${d.score}%;background:linear-gradient(90deg,${st.color},var(--primary-light));"></div>
                            </div>
                            <p style="color:var(--text-light);font-size:0.9rem;">Score: <strong>${d.score}%</strong> — ${st.label}</p>
                        </div>`;
                }).join('')}
            </div>

            <div id="nextStepsBlock" style="background:white;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
                <h3 style="margin-bottom:1.5rem;color:var(--primary);">Next Steps</h3>
                <div style="display:flex;gap:1rem;flex-wrap:wrap;">
                    <button class="btn btn-primary" onclick="openRecommendationsPage()">View Recommendations</button>
                    <button class="btn btn-secondary" onclick="window.location.href='/parent/appointments.html'">Book Appointment</button>
                    <button class="btn btn-secondary" onclick="window.location.href='/parent/screening.html'">Reassessment</button>
                </div>
            </div>`;
            
        let userRole = 'parent';
        try { userRole = JSON.parse(localStorage.getItem('kc_user') || '{}').role; } catch(e) {}
        if (userRole === 'pediatrician' || userRole === 'admin') {
            const nextSteps = document.getElementById('nextStepsBlock');
            if (nextSteps) nextSteps.style.display = 'none';
        }
    } catch (e) {
        document.getElementById('resultsContent').innerHTML = `
            <div style="text-align:center;padding:2rem;background:white;border-radius:15px;">
                <p style="color:red;">Failed to load results: ${escapeHtml(e.message)}</p>
                <button class="btn btn-secondary" onclick="loadResults()" style="margin-top:1rem;">Retry</button>
            </div>`;
    }
}

// Close diagnosis modal when clicking outside the box.
document.getElementById('diagnosisModal').addEventListener('click', (e) => {
    if (e.target.id === 'diagnosisModal') closeDiagnosisModal();
});

// Initialize shared nav data so the latest parent profile photo also appears in the icon.
document.addEventListener('DOMContentLoaded', () => {
    let userRole = 'parent';
    try {
        const user = JSON.parse(localStorage.getItem('kc_user') || '{}');
        userRole = user.role || 'parent';
    } catch(e) {}

    if (userRole === 'pediatrician') {
        const logo = document.querySelector('.logo');
        if (logo) logo.href = '/pedia/pediatrician-dashboard.html';

        const mainNav = document.querySelector('.main-nav');
        if (mainNav) {
            mainNav.innerHTML = `
                <a href="/pedia/pediatrician-dashboard.html" class="nav-link">Dashboard</a>
                <a href="/pedia/pediatrician-patients.html" class="nav-link active">My Patients</a>
                <a href="/pedia/pediatrician-appointments.html" class="nav-link">Appointments</a>
                <a href="/pedia/pedia-chat.html" class="nav-link">Chat</a>
                <a href="/pedia/pedia-questions.html" class="nav-link">My Questions</a>
            `;
        }

        const profileMenu = document.getElementById('profileMenu');
        if (profileMenu) {
            const links = profileMenu.querySelectorAll('a');
            if (links.length >= 2) {
                links[0].href = '/pedia/pediatrician-profile.html';
                links[1].href = '/pedia/pediatrician-settings.html';
            }
        }
    }

    if (typeof initNav === 'function') initNav();
    loadResults();
});
