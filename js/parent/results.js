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

// Band cutoffs come from constants/scoring.js (loaded as window.KCScoring by
// the <script> tag above this file in results.html). Do not reintroduce
// literal cutoffs here — see that file's header for why.
//
// Colours previously used var(--primary) / var(--accent-red); they now come
// from the shared four-colour map so the parent and pediatrician views agree.
function getStatusLabel(score) {
    const st = window.KCScoring.parentDomainStatus(score);
    // `band` is passed through so the status chip can use the shared soft-tint
    // badge treatment. The band itself, its label and its colour still come
    // entirely from KCScoring — nothing about scoring changes here.
    return { label: st.label, color: st.color, band: st.band };
}

// Maps a KCScoring band onto the system-wide status tone used by .kc-badge,
// so "Fair" looks the same here as it does on the pediatrician and secretary
// screens instead of being a saturated solid chip unique to this page.
const BAND_TONE = {
    'on-track': 'positive',
    'developing': 'positive',
    'at-risk': 'caution',
    'delayed': 'attention',
};

function getOverallStatus(score) {
    return window.KCScoring.parentOverallLabel(score);
}

// Overall summary paragraph, keyed by band. Previously an inline 80/60 ternary.
// at-risk and delayed share the old "<60" wording so parent-facing text is
// unchanged at every score.
const OVERALL_BLURB = {
    'on-track':   'Your child is developing well overall and progressing as expected for their age.',
    'developing': 'Your child is making good progress. Some areas may benefit from additional focus.',
    'at-risk':    'Your child may benefit from additional support. Consider consulting a pediatrician.',
    'delayed':    'Your child may benefit from additional support. Consider consulting a pediatrician.',
};

// ---------------------------------------------------------------------------
// Domain evidence ("Why this score?")
//
// Everything below renders `results.domainDetails` from
// GET /api/assessments/:assessmentId/results. It never computes a score — the
// percentages and status chips still come from the stored result via KCScoring.
// domainDetails is absent on older assessments, which is why every renderer
// degrades to the plain score view instead of assuming it is there.
// ---------------------------------------------------------------------------

// Bullets shown on the card face. The rest stay in the expandable panel so a
// domain with 8 answers does not turn the card into a wall of text.
const MAX_CARD_BULLETS = 4;

function answerLabel(answer) {
    const key = String(answer ?? '').trim().toLowerCase();
    if (key === 'yes') return 'Yes';
    if (key === 'sometimes') return 'Sometimes';
    if (key === 'no') return 'No';
    return key ? String(answer) : 'Not answered';
}

function renderDomainBullets(title, entries, modifier) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (!list.length) return '';

    const shown = list.slice(0, MAX_CARD_BULLETS);
    const hiddenCount = list.length - shown.length;

    return `
        <section class="domain-list domain-list-${modifier}">
            <h4>${escapeHtml(title)}</h4>
            <ul>${shown.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>
            ${hiddenCount > 0 ? `<p class="domain-list-more">+${hiddenCount} more in assessment details</p>` : ''}
        </section>`;
}

function renderDomainDetailsPanel(panelId, items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '';

    return `
        <button type="button" class="domain-details-toggle"
                aria-expanded="false" aria-controls="${escapeHtml(panelId)}"
                onclick="toggleDomainDetails(this)">View Assessment Details</button>
        <div class="domain-details-panel" id="${escapeHtml(panelId)}" hidden>
            <h4>Assessment Details</h4>
            <ol class="domain-item-list">
                ${list.map((item) => `
                    <li class="domain-item level-${escapeHtml(item.insightLevel || 'positive')}">
                        <p class="domain-item-question">${escapeHtml(item.questionText || 'Assessment item not recorded')}</p>
                        <p class="domain-item-meta">
                            <span>Answer: <strong>${escapeHtml(answerLabel(item.answer))}</strong></span>
                            <span class="domain-item-result">${escapeHtml(item.insight || '')}</span>
                        </p>
                    </li>`).join('')}
            </ol>
        </div>`;
}

// Expand/collapse handler for the per-domain details panel.
// Exposed on window because the button uses an inline onclick, matching the
// rest of this page.
function toggleDomainDetails(button) {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (!panel) return;

    const willOpen = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    panel.hidden = !willOpen;
    button.textContent = willOpen ? 'Hide Assessment Details' : 'View Assessment Details';
}
window.toggleDomainDetails = toggleDomainDetails;

function renderDomainCard(domain, details, index) {
    const st = getStatusLabel(domain.score);
    const panelId = `domainDetails-${index}`;
    const hasDetails = Boolean(details) && Number(details.totalItems) > 0;

    const countsRow = hasDetails ? `
        <p class="domain-counts">
            <span class="domain-count count-yes">${details.achievedItems} Yes</span>
            <span class="domain-count count-sometimes">${details.developingItems} Sometimes</span>
            <span class="domain-count count-no">${details.concernItems} No</span>
        </p>` : '';

    const body = hasDetails ? `
        <section class="domain-why">
            <h4>Score Explanation</h4>
            <p>${escapeHtml(details.explanation || '')}</p>
        </section>
        ${renderDomainBullets('Strengths', details.strengths, 'strength')}
        ${renderDomainBullets('Developing', details.developing, 'developing')}
        ${renderDomainBullets('Needs Support', details.needsSupport, 'support')}
        ${renderDomainDetailsPanel(panelId, details.items)}`
        : `<p class="domain-fallback">Detailed assessment information is not available for this result.</p>`;

    return `
        <article class="domain-card" style="--domain-color:${st.color};">
            <header class="domain-card-head">
                <h3 class="domain-card-title">${domain.icon} ${escapeHtml(domain.label)}</h3>
                <span class="domain-status-chip tone-${escapeHtml(BAND_TONE[st.band] || 'neutral')}">${escapeHtml(st.label)}</span>
            </header>
            <div class="domain-score-row">
                <span class="domain-score-value">${domain.score}%</span>
                ${countsRow}
            </div>
            <div class="domain-progress" role="img"
                 aria-label="${escapeHtml(domain.label)} score ${domain.score} percent">
                <div class="domain-progress-fill" style="width:${domain.score}%;"></div>
            </div>
            ${body}
        </article>`;
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

// ---------------------------------------------------------------------------
// Previous-vs-current comparison (GET /api/assessments/:assessmentId/compare)
//
// Purely additive and read-only: it renders whatever the backend already
// computed from the two stored AssessmentResult documents. Neither result is
// ever recalculated here, and the previous assessment's data is displayed
// exactly as it was originally saved — this page never writes to it.
// ---------------------------------------------------------------------------

function diffColor(diff) {
    if (diff == null) return 'var(--text-light)';
    if (diff > 0) return '#27ae60';
    if (diff < 0) return '#e74c3c';
    return 'var(--text-light)';
}

function diffText(diff) {
    if (diff == null) return '—';
    if (diff > 0) return `+${diff}`;
    return `${diff}`;
}

function comparisonRow(d, bold) {
    if (!d) return '';
    const rowStyle = bold ? 'font-weight:700;border-top:1px solid var(--border);' : '';
    return `
        <tr style="${rowStyle}">
            <td style="padding:.5rem .25rem;text-align:left;">${escapeHtml(d.label)}</td>
            <td style="padding:.5rem .25rem;text-align:center;">${d.previous != null ? d.previous + '%' : '—'}</td>
            <td style="padding:.5rem .25rem;text-align:center;">${d.current != null ? d.current + '%' : '—'}</td>
            <td style="padding:.5rem .25rem;text-align:center;color:${diffColor(d.difference)};font-weight:700;">${diffText(d.difference)}${d.difference != null ? '&nbsp;pts' : ''}</td>
        </tr>`;
}

// Step 14: one side (previous or current) of the explicit developmental
// band / risk category / care stage block below — the three concepts stay
// on three separate lines (never collapsed into one label) per the
// reassessment-display requirement. Reads straight off compare.previous /
// compare.current (services/assessmentProgress.js
// buildAssessmentProgressSummary) — never recomputed here.
function renderCareStageColumn(heading, side) {
    if (!side) return '';
    const CP = window.KCCarePlan;
    return `
        <div>
            <p style="margin:0 0 .5rem;font-weight:700;color:var(--text-dark);">${escapeHtml(heading)}</p>
            <p style="margin:0 0 .3rem;font-size:.85rem;">Developmental Band: <strong>${escapeHtml(CP.developmentalBandLabel(side.developmentalBand))}</strong></p>
            <p style="margin:0 0 .3rem;font-size:.85rem;">Developmental Risk Category: <strong>${escapeHtml(CP.riskCategoryLabel(side.riskCategory))}</strong></p>
            <p style="margin:0;font-size:.85rem;">Care Stage: <strong>${escapeHtml(CP.careStageLabel(side.careStageLabel))}</strong></p>
        </div>`;
}

function renderComparisonSection(compare) {
    if (!compare) return '';
    const CP = window.KCCarePlan;

    // First completed assessment: there is nothing to compare against yet.
    // Never phrased as improved/worsened/no change — see Step 14 section 6.
    if (!compare.hasPrevious) {
        return `
        <div class="comparison-card" style="background:white;border-radius:15px;padding:2rem;margin-bottom:2rem;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
            <h3 style="margin:0 0 .5rem;color:var(--primary);">Progress Since Last Assessment</h3>
            <p style="margin:0;color:var(--text-light);">First completed assessment — there is no earlier screening to compare yet.</p>
        </div>`;
    }

    if (!compare.scores) return '';
    const s = compare.scores;
    const direction = compare.comparison?.direction;
    const directionTone = stageBadgeSafe(CP.toneForDirection(direction));

    return `
        <div class="comparison-card" style="background:white;border-radius:15px;padding:2rem;margin-bottom:2rem;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
            <h3 style="margin:0 0 .3rem;color:var(--primary);">Progress Since Last Assessment</h3>
            <p style="margin:0 0 1.2rem;color:var(--text-light);font-size:.85rem;">
                Previous: ${escapeHtml(fmtDate(compare.previous?.date))} &nbsp;→&nbsp; Current: ${escapeHtml(fmtDate(compare.current?.date))}
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:1rem;">
                ${renderCareStageColumn('Previous', compare.previous)}
                ${renderCareStageColumn('Current', compare.current)}
            </div>
            <p style="margin:0 0 1.2rem;font-size:.9rem;">
                <strong>Progress:</strong>
                <span class="kc-badge kc-badge--${directionTone}" style="margin-left:.4rem;">${escapeHtml(CP.directionLabel(direction))}</span>
            </p>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:.9rem;min-width:420px;">
                    <thead>
                        <tr style="color:var(--text-light);font-size:.75rem;text-transform:uppercase;">
                            <th style="text-align:left;padding:.25rem;">Domain</th>
                            <th style="padding:.25rem;">Previous</th>
                            <th style="padding:.25rem;">Current</th>
                            <th style="padding:.25rem;">Progress</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${comparisonRow(s.communication)}
                        ${comparisonRow(s.social)}
                        ${comparisonRow(s.cognitive)}
                        ${comparisonRow(s.motor)}
                        ${comparisonRow(s.overall, true)}
                    </tbody>
                </table>
            </div>
            <p style="margin:.7rem 0 0;font-size:.75rem;color:var(--text-light);">
                Progress shows how each domain's score moved since the previous assessment, in percentage points (pts) &mdash; a positive value means the score went up. The <strong>Progress</strong> badge above reflects the change in overall care stage, not these point totals.
            </p>
        </div>`;
}

// ---------------------------------------------------------------------------
// Step 14: Developmental Assessment & Care Plan summary card.
//
// Purely a DISPLAY of what the backend already decided — developmentalBand,
// riskCategory, careStage/careStageLabel, consultationLevel, monitoringLevel,
// and source all come straight from GET /api/assessments/:id/results
// (r.developmentalBand, r.prediction.*). Nothing here recomputes a band,
// risk category, or care stage from scores; window.KCCarePlan only maps the
// already-decided value to readable text/badge tone (see
// js/shared/care-plan-labels.js). `prediction` is always a full object (see
// services/assessmentProgress.js getStoredOrDerivedCareStage) — it is never
// partially filled, so this function only needs to guard against it being
// entirely absent (e.g. a pre-Step-5 legacy result).
// ---------------------------------------------------------------------------
function renderCarePlanCard(developmentalBand, prediction) {
    if (!prediction) return '';
    const CP = window.KCCarePlan;

    const bandLabel = CP.developmentalBandLabel(developmentalBand);
    const bandTone = CP.toneForDevelopmentalBand(developmentalBand);
    const riskLabel = CP.riskCategoryLabel(prediction.riskCategory);
    const riskTone = CP.toneForRiskCategory(prediction.riskCategory);
    const stageLabel = CP.careStageLabel(prediction.careStageLabel);
    const stageTone = CP.toneForCareStage(prediction.careStage);
    const consultationLabel = CP.consultationLevelLabel(prediction.consultationLevel);
    const monitoringLabel = CP.monitoringLevelLabel(prediction.monitoringLevel);
    const interpretation = CP.interpretationLine(prediction.source);

    const field = (label, valueHtml) => `
        <div>
            <p style="margin:0 0 .4rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-light);">${escapeHtml(label)}</p>
            ${valueHtml}
        </div>`;

    return `
    <div class="comparison-card" style="background:white;border-radius:15px;padding:2rem;margin-bottom:2rem;box-shadow:0 4px 15px rgba(0,0,0,0.08);">
        <h3 style="margin:0 0 1.2rem;color:var(--primary);">Developmental Assessment &amp; Care Plan</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1.4rem;">
            ${field('Developmental Band', `<span class="kc-badge kc-badge--${stageBadgeSafe(bandTone)}">${escapeHtml(bandLabel)}</span>`)}
            ${field('Developmental Risk Category', `<span class="kc-badge kc-badge--${stageBadgeSafe(riskTone)}">${escapeHtml(riskLabel)}</span>`)}
            ${field('Care Stage', `<span class="kc-badge kc-badge--${stageBadgeSafe(stageTone)}">${escapeHtml(stageLabel)}</span>`)}
            ${field('Consultation', `<p style="margin:0;font-weight:600;color:var(--text-dark);">${escapeHtml(consultationLabel)}</p>`)}
            ${field('Monitoring', `<p style="margin:0;font-weight:600;color:var(--text-dark);">${escapeHtml(monitoringLabel)}</p>`)}
        </div>
        <p style="margin:1.3rem 0 0;font-size:.8rem;color:var(--text-light);">${escapeHtml(interpretation)}</p>
    </div>`;
}

// kc-badge only defines positive/caution/attention/neutral/info — this is a
// defensive pass-through so an unrecognized tone never emits a broken class.
function stageBadgeSafe(tone) {
    return ['positive', 'caution', 'attention', 'neutral', 'info'].includes(tone) ? tone : 'neutral';
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

        // Additive, best-effort: absent on a child's first assessment (no
        // previous to compare against), and never blocks the results view.
        let compareData = null;
        try {
            compareData = await apiFetch(`/assessments/${assessmentId}/compare`);
        } catch (_) {
            compareData = null;
        }

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

        // Additive field — absent on assessments saved before this existed.
        // Keyed by the same domain names as the labels above.
        const domainDetails = (r.domainDetails && typeof r.domainDetails === 'object') ? r.domainDetails : {};
        const hasAnyDomainDetails = domains.some((d) => Number(domainDetails[d.label]?.totalItems) > 0);

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
                    <div class="overall-score-ring">
                        <span class="overall-score-caption">Overall Score</span>
                        <span class="overall-score-value">${overall}%</span>
                    </div>
                </div>
                <div>
                    <h2 style="color:var(--primary);margin-bottom:0.5rem;">${getOverallStatus(overall)}</h2>
                    <p style="color:var(--text-light);line-height:1.6;margin-bottom:1.5rem;">
                        ${OVERALL_BLURB[window.KCScoring.bandFor(overall)]}
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
                    ${hasAnyDomainDetails ? `
                    <p class="scoring-legend">
                        How each score is worked out: every answer of <strong>Yes</strong> earns full credit,
                        <strong>Sometimes</strong> earns partial credit, and <strong>No</strong> earns none.
                        Each card below shows the answers behind its percentage.
                    </p>` : ''}
                </div>
            </div>

            ${renderCarePlanCard(r.developmentalBand, r.prediction)}

            <div class="domain-cards-grid">
                ${domains.map((d, i) => renderDomainCard(d, domainDetails[d.label], i)).join('')}
            </div>

            ${renderComparisonSection(compareData)}

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
