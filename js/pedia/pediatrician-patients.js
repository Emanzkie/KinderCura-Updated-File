// === Extracted from PEDIA\pediatrician-patients.html (script block 1) ===
const API = window.location.origin + '/api';
// Uses the current site origin so the same code works on localhost and when deployed.
    const getToken = () => localStorage.getItem('kc_token');
    const getUser  = () => { try { return JSON.parse(localStorage.getItem('kc_user')); } catch { return null; } };

    function doLogout() {
        ['kc_token','kc_user','kc_childId','kc_assessmentId'].forEach(k => localStorage.removeItem(k));
        window.location.href = '/login.html';
    }

    // Auth guard
    const _u = getUser();
    if (!getToken() || !_u) { window.location.href = '/login.html'; }
    else if ((_u.role||'').trim().toLowerCase() !== 'pediatrician') {
        window.location.href = _u.role === 'admin' ? '/admin/admin-dashboard.html' : '/parent/dashboard.html';
    }
    if (_u) {
        document.getElementById('navWelcome').textContent = `Welcome, Dr. ${_u.firstName}`;
        if (_u.profileIcon && _u.profileIcon.startsWith('/uploads/'))
            document.getElementById('navProfilePic').src = _u.profileIcon;
    }

    async function apiFetch(ep, opts = {}) {
        const res = await fetch(`${API}${ep}`, {
            ...opts,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...opts.headers }
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        return d;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function fmtTime(t){
        if(!t)return'—';
        const s=String(t);
        if(s.includes('T')||s.includes('Z')||s.length>8){
            const d=new Date(s);
            if(!isNaN(d)){const h=d.getUTCHours(),m=String(d.getUTCMinutes()).padStart(2,'0');return`${h%12||12}:${m} ${h>=12?'PM':'AM'}`;}
        }
        const parts=s.split(':');
        const h=parseInt(parts[0],10),m=String(parts[1]||'00').padStart(2,'0');
        if(isNaN(h))return s;
        return`${h%12||12}:${m} ${h>=12?'PM':'AM'}`;
    }
        function calcAge(dob) {
        if (!dob) return '—';
        const b = new Date(dob), now = new Date();
        let y = now.getFullYear() - b.getFullYear();
        let m = now.getMonth() - b.getMonth();
        if (m < 0) { y--; m += 12; }
        if (y === 0) return `${m}mo`;
        return `${y}y ${m > 0 ? m + 'mo' : ''}`.trim();
    }

    function getAgeGroup(dob) {
        if (!dob) return 'unknown';
        const yrs = (Date.now() - new Date(dob)) / (365.25 * 864e5);
        if (yrs < 2)  return 'infant';
        if (yrs < 3)  return 'toddler';
        if (yrs < 6)  return 'preschool';
        if (yrs < 9)  return 'school';
        return 'older';
    }

    function aptStatusBadge(status) {
        const map = {
            pending:   ['badge-pending',   'Pending'],
            approved:  ['badge-approved',  'Approved'],
            confirmed: ['badge-approved',  'Confirmed'],
            completed: ['badge-completed', 'Completed'],
            cancelled: ['badge-cancelled', 'Cancelled'],
            rejected:  ['badge-rejected',  'Declined'],
        };
        const [cls, label] = map[status] || ['badge-pending', status || 'Unknown'];
        return `<span class="badge ${cls}">${label}</span>`;
    }

    function normaliseStatus(s) {
        if (!s) return 'pending';
        if (s === 'confirmed') return 'approved';
        if (s === 'rejected')  return 'cancelled';
        return s;
    }

    // Small helper so progress notes are easier to scan in the card and modal.
    function progressStatusMeta(status) {
        const map = {
            initial_review: { label: 'Initial Review', color: '#3b82f6', bg: '#dbeafe' },
            monitoring:      { label: 'Monitoring',     color: '#7c3aed', bg: '#ede9fe' },
            follow_up:       { label: 'Follow-up',      color: '#d97706', bg: '#fef3c7' },
            improving:       { label: 'Improving',      color: '#15803d', bg: '#dcfce7' },
            stable:          { label: 'Stable',         color: '#0f766e', bg: '#ccfbf1' },
            needs_attention: { label: 'Needs Attention',color: '#b91c1c', bg: '#fee2e2' },
            referred:        { label: 'Referred',       color: '#1d4ed8', bg: '#dbeafe' },
            completed:       { label: 'Completed',      color: '#166534', bg: '#dcfce7' },
        };
        return map[status] || { label: status || 'Monitoring', color: '#7c3aed', bg: '#ede9fe' };
    }

    function toDateInputValue(value) {
        if (!value) return '';
        if (value instanceof Date) {
            const y = value.getFullYear();
            const m = String(value.getMonth() + 1).padStart(2, '0');
            const d = String(value.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) return match[1];

        const parsed = new Date(value);
        if (isNaN(parsed.getTime())) return '';
        return toDateInputValue(parsed);
    }

    function formatDisplayDate(value) {
        const dateValue = toDateInputValue(value);
        if (!dateValue) return 'No follow-up scheduled yet';
        const [year, month, day] = dateValue.split('-').map(Number);
        return new Date(year, month - 1, day).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    function getSuggestedNextAssessmentDate(score) {
        if (score == null || score === '') return '';
        const numericScore = Number(score);
        if (Number.isNaN(numericScore)) return '';

        const date = new Date();
        date.setHours(0, 0, 0, 0);

        if (numericScore < 40) {
            date.setDate(date.getDate() + 14);
        } else if (numericScore <= 60) {
            date.setMonth(date.getMonth() + 1);
        } else {
            date.setMonth(date.getMonth() + 3);
        }

        return toDateInputValue(date);
    }

    function isPastDateInput(value) {
        if (!value) return false;
        return value < toDateInputValue(new Date());
    }

    function inlineArg(value) {
        return escapeHtml(String(value ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n'));
    }

    // ── Render ────────────────────────────────────────────────────────────────
    let _allPatients = [];

    function renderPatients(patients) {
        _allPatients = patients;
        document.getElementById('patientCount').textContent =
            patients.length ? `${patients.length} patient${patients.length !== 1 ? 's' : ''}` : '';

        const list = document.getElementById('patientsList');

        if (!patients.length) {
            list.innerHTML = `
                <div class="empty-state">
                    <p style="font-size:3rem;margin-bottom:1rem;"><img src="/icons/pediatrician.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"></p>
                    <p style="font-size:1.1rem;font-weight:600;margin-bottom:0.5rem;color:var(--text-dark);">No patients yet</p>
                    <p style="font-size:0.9rem;color:var(--text-light);">Patients will appear here once parents book appointments with you.</p>
                </div>`;
            return;
        }

        list.innerHTML = patients.map(p => {
            const age        = calcAge(p.childDateOfBirth || p.dateOfBirth);
            const ageGroup   = getAgeGroup(p.childDateOfBirth || p.dateOfBirth);
            const parentName = `${p.parentFirstName||''} ${p.parentLastName||''}`.trim() || p.parentEmail || '—';
            const aptStatus  = normaliseStatus(p.appointmentStatus);
            const hasDiag    = p.diagnosis && p.diagnosis.trim();
            const scores     = p.scores || {};
            const hasScores  = Object.keys(scores).length > 0;
            const genderLabel = p.childGender === 'female' ? 'Female' : p.childGender === 'male' ? 'Male' : 'Other';
            const avatarCls  = p.childGender === 'female' ? 'avatar-girl' : p.childGender === 'male' ? 'avatar-boy' : 'avatar-other';
            const hasPhoto   = p.childProfileIcon && p.childProfileIcon.startsWith('/uploads/');
            const avatarHTML = hasPhoto
                ? `<img src="${p.childProfileIcon}" alt="${p.childFirstName}" class="avatar ${avatarCls}" style="object-fit:cover;border:2px solid var(--primary);" onerror="this.onerror=null;this.src='/icons/profile_icon.png';">`
                : `<div class="avatar ${avatarCls}" style="font-size:0.65rem;font-weight:700;flex-direction:column;gap:0.1rem;color:white;text-align:center;line-height:1.2;">
                    <span style="font-size:0.9rem;">${p.childGender==='female'?'♀':'♂'}</span>
                    <span>${genderLabel}</span>
                   </div>`;
            const lastApt    = (function(d) {
                if (!d) return '—';
                const s = String(d).split('T')[0];
                const [y,mo,dy] = s.split('-').map(Number);
                if (!y||!mo||!dy) return s;
                return new Date(y,mo-1,dy).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
            })(p.appointmentDate);
            const lastAssess = p.lastAssessmentDate ? new Date(p.lastAssessmentDate).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : 'None yet';
            // Prepare the latest progress preview before rendering the card so refresh does not crash.
            const progressMeta = progressStatusMeta(p.latestProgressStatus);
            const latestProgressDate = p.latestProgressAt
                ? new Date(p.latestProgressAt).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'})
                : 'recently';
            const nextDateInput = toDateInputValue(p.nextAssessmentDate);
            const nextDateDisplay = nextDateInput ? formatDisplayDate(nextDateInput) : null;
            const overallScore = p.overallScore != null ? Math.round(p.overallScore) : '';
            const diagEsc    = inlineArg(p.diagnosis || '');
            const recEsc     = inlineArg(p.recommendations || '');
            const nextDateEsc = inlineArg(nextDateInput);
            const nextReasonEsc = inlineArg(p.nextAssessmentReason || '');
            const childNameEsc = inlineArg(`${p.childFirstName} ${p.childLastName}`);

            return `
            <div class="patient-card"
                data-status="${aptStatus}"
                data-age-group="${ageGroup}"
                data-name="${(p.childFirstName+' '+p.childLastName).toLowerCase()}"
                data-email="${(p.parentEmail||'').toLowerCase()}">

                <!-- Patient Header -->
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.2rem;">
                    <div style="display:flex;gap:1rem;align-items:center;flex:1;">
                        ${avatarHTML}
                        <div>
                            <p style="font-size:0.7rem;font-weight:600;color:var(--primary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.15rem;"><img src="/icons/profile_icon.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Child</p>
                            <p style="font-weight:700;font-size:1.1rem;color:var(--text-dark);margin-bottom:0.3rem;">
                                ${p.childFirstName} ${p.childLastName}
                            </p>
                            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.3rem;">
                                <span style="background:#e8f5e9;color:#2e7d32;padding:0.2rem 0.6rem;border-radius:8px;font-size:0.78rem;font-weight:600;">Age: ${age}</span>
                                <span style="background:#e3f2fd;color:#1565c0;padding:0.2rem 0.6rem;border-radius:8px;font-size:0.78rem;font-weight:600;">${genderLabel}</span>
                            </div>
                            <p style="color:var(--text-light);font-size:0.82rem;margin-bottom:0.15rem;">
                                <img src="/icons/account.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Parent: <strong style="color:var(--text-dark);">${parentName}</strong>
                            </p>
                            <p style="color:var(--text-light);font-size:0.82rem;">
                                <img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Last Appt: <strong style="color:var(--text-dark);">${lastApt}</strong>
                            </p>
                        </div>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:0.4rem;align-items:flex-end;">
                        ${aptStatusBadge(p.appointmentStatus)}
                        <span class="badge ${hasDiag ? 'badge-diagnosed' : 'badge-no-diag'}">${hasDiag ? '&#10003; Diagnosed' : '⏳ Awaiting Diagnosis'}</span>
                    </div>
                </div>

                <!-- Assessment Scores -->
                ${hasScores ? `
                <div style="background:var(--bg-primary);padding:1.2rem 1.5rem;border-radius:10px;margin-bottom:1.2rem;">
                    <p style="font-weight:600;color:var(--primary);margin-bottom:0.8rem;font-size:0.9rem;"><img src="/icons/analytics.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Assessment Results
                        <span style="float:right;font-size:0.78rem;color:var(--text-light);font-weight:400;">Last: ${lastAssess}</span>
                    </p>
                    <div class="score-grid">
                        ${Object.entries(scores).map(([k,v]) => {
                            const color = v >= 70 ? 'var(--success,#4a7c59)' : v >= 40 ? '#F4D89F' : '#ef4444';
                            return `<div class="score-item">
                                <div class="score-val" style="color:${color};">${v}%</div>
                                <div class="score-lbl">${k}</div>
                            </div>`;
                        }).join('')}
                    </div>
                    ${hasDiag ? `
                    <div style="margin-top:1rem;padding:0.8rem 1rem;background:white;border-radius:8px;border-left:3px solid var(--primary);">
                        <p style="font-size:0.8rem;font-weight:600;color:var(--primary);margin-bottom:0.3rem;">Your Diagnosis:</p>
                        <p style="font-size:0.85rem;color:var(--text-dark);">${p.diagnosis}</p>
                    </div>` : ''}
                    ${nextDateDisplay ? `
                    <div style="margin-top:1rem;padding:0.85rem 1rem;background:white;border-radius:8px;border-left:3px solid #0891b2;">
                        <p style="font-size:0.8rem;font-weight:700;color:#0e7490;margin:0 0 0.3rem;">Next Assessment</p>
                        <p style="font-size:0.85rem;color:var(--text-dark);margin:0;">${nextDateDisplay}</p>
                        ${p.nextAssessmentReason ? `<p style="font-size:0.8rem;color:var(--text-light);margin:0.35rem 0 0;line-height:1.45;">${escapeHtml(p.nextAssessmentReason)}</p>` : ''}
                    </div>` : ''}
                    ${p.progressNotesCount ? `
                    <div style="margin-top:1rem;padding:0.9rem 1rem;background:white;border-radius:8px;border-left:3px solid ${progressMeta.color};">
                        <div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap;">
                            <p style="font-size:0.8rem;font-weight:700;color:var(--text-dark);margin:0;">Latest Progress Update</p>
                            <span style="background:${progressMeta.bg};color:${progressMeta.color};padding:0.2rem 0.6rem;border-radius:999px;font-size:0.74rem;font-weight:700;">${progressMeta.label}</span>
                        </div>
                        <p style="font-size:0.83rem;color:var(--text-dark);margin:0.45rem 0 0;line-height:1.45;">${p.latestProgressNote || "No note text."}</p>
                        <p style="font-size:0.75rem;color:var(--text-light);margin:0.45rem 0 0;">${p.progressNotesCount} note${p.progressNotesCount !== 1 ? "s" : ""} • Last update ${latestProgressDate}</p>
                    </div>` : ''}
                </div>` : `
                <div style="background:var(--bg-primary);padding:1rem 1.5rem;border-radius:10px;margin-bottom:1.2rem;text-align:center;color:var(--text-light);font-size:0.85rem;">
                    <p><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> No assessment results on file yet. <span style="color:var(--text-light);">Last checked: ${lastAssess}</span></p>
                </div>`}

                <!-- Actions -->
                <div style="display:flex;gap:0.8rem;flex-wrap:wrap;">
                    <button class="btn btn-primary" onclick="viewAssessment('${p.assessmentId||''}','${p.childId}','${childNameEsc}')"
                        style="flex:1;min-width:130px;padding:0.7rem;">
                        <img src="/icons/data.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> View Assessment
                    </button>
                    <button class="btn btn-secondary" onclick="openReviewAnswers('${p.childId}','${childNameEsc}')"
                        style="flex:1;min-width:130px;padding:0.7rem;border-color:#0891b2;color:#0891b2;">
                        <img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Review Pre-Assessment
                    </button>
                    <button class="btn btn-secondary" onclick="openDiagnosis('${p.childId}','${childNameEsc}','${diagEsc}','${recEsc}','${nextDateEsc}','${nextReasonEsc}','${overallScore}')"
                        style="flex:1;min-width:130px;padding:0.7rem;">
                        ${hasDiag ? '<img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️ Edit Diagnosis' : '<img src="/icons/logs.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Provide Diagnosis'}
                    </button>
                    <button class="btn btn-secondary" onclick="openProgressModal('${p.childId}','${childNameEsc}')"
                        style="flex:1;min-width:130px;padding:0.7rem;border-color:#7c3aed;color:#7c3aed;">
                        <img src="/icons/analytics.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Progress History
                    </button>
                    ${p.appointmentId ? `<button class="btn btn-secondary" onclick="window.location.href='/pedia/pedia-chat.html?appointmentId=${p.appointmentId}'" style="flex:1;min-width:130px;padding:0.7rem;border-color:var(--primary);color:var(--primary);"> Chat with Parent</button>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    // ── Filtering ─────────────────────────────────────────────────────────────
    function filterPatients() {
        const search   = document.getElementById('searchInput').value.toLowerCase().trim();
        const status   = document.getElementById('statusFilter').value;
        const ageGroup = document.getElementById('ageFilter').value;

        let visible = 0;
        document.querySelectorAll('.patient-card').forEach(card => {
            const matchSearch = !search ||
                card.dataset.name.includes(search) ||
                (card.dataset.email && card.dataset.email.includes(search));
            const matchStatus = !status ||
                card.dataset.status === status ||
                (status === 'cancelled' && (card.dataset.status === 'cancelled' || card.dataset.status === 'rejected'));
            const matchAge = !ageGroup || card.dataset.ageGroup === ageGroup;
            const show = matchSearch && matchStatus && matchAge;
            card.style.display = show ? 'block' : 'none';
            if (show) visible++;
        });

        document.getElementById('patientCount').textContent =
            `${visible} of ${_allPatients.length} patient${_allPatients.length !== 1 ? 's' : ''}`;
    }

    // ── Load Data ─────────────────────────────────────────────────────────────
    async function loadPatients() {
        try {
            const data = await apiFetch('/assessments/pedia-patients');
            renderPatients(data.patients || []);
        } catch (err) {
            console.error('loadPatients error:', err);
            document.getElementById('patientsList').innerHTML = `
                <div class="empty-state">
                    <p style="font-size:2rem;margin-bottom:1rem;"><img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️</p>
                    <p style="font-weight:600;color:var(--text-dark);">Could not load patients</p>
                    <p style="font-size:0.85rem;color:var(--text-light);">${err.message}</p>
                    <button class="btn btn-primary" onclick="loadPatients()" style="margin-top:1rem;padding:0.7rem 1.5rem;">Retry</button>
                </div>`;
        }
    }




    // ── Actions ───────────────────────────────────────────────────────────────
    function viewAssessment(assessmentId, childId, childName) {
        if (!assessmentId || assessmentId === 'undefined' || assessmentId === 'null') {
            alert('No completed assessment on file for this patient yet.');
            return;
        }
        // Store assessment context and navigate to results page
        localStorage.setItem('kc_assessmentId', assessmentId);
        localStorage.setItem('kc_viewChildId', childId);
        if (childName) localStorage.setItem('kc_viewChildName', childName);
        window.open(`/parent/results.html?assessmentId=${assessmentId}&childId=${childId}`, '_blank');
    }

    function openDiagnosis(childId, childName, existingDiag, existingRec, existingNextDate, existingNextReason, overallScore) {
        window.currentChildId = childId;
        window.currentDiagnosisScore = overallScore;
        document.getElementById('diagModalTitle').textContent =
            existingDiag ? `Edit Diagnosis — ${childName}` : `Provide Diagnosis — ${childName}`;
        document.getElementById('diagPatientName').textContent = `Patient: ${childName}`;
        document.getElementById('diagnosis-text').value = existingDiag || '';
        document.getElementById('recommendations-text').value = existingRec || '';

        const dateInput = document.getElementById('next-assessment-date');
        const reasonInput = document.getElementById('next-assessment-reason');
        const suggestionText = document.getElementById('next-assessment-suggestion');
        const savedDate = toDateInputValue(existingNextDate);
        const suggestedDate = getSuggestedNextAssessmentDate(overallScore);

        if (dateInput) {
            dateInput.min = toDateInputValue(new Date());
            dateInput.value = savedDate || suggestedDate || '';
        }
        if (reasonInput) reasonInput.value = existingNextReason || '';
        if (suggestionText) {
            suggestionText.textContent = suggestedDate
                ? `Suggested from latest score${overallScore !== '' ? ` (${Math.round(Number(overallScore))}%)` : ''}: ${formatDisplayDate(suggestedDate)}.`
                : 'No score-based suggestion available yet.';
        }

        document.getElementById('diagnosisModal').style.display = 'flex';
    }

    async function submitDiagnosis() {
        const diagnosis = document.getElementById('diagnosis-text').value.trim();
        const recommendations = document.getElementById('recommendations-text').value.trim();
        const nextAssessmentDate = document.getElementById('next-assessment-date').value;
        const nextAssessmentReason = document.getElementById('next-assessment-reason').value.trim();
        if (!diagnosis) { alert('Please enter a diagnosis.'); return; }
        if (isPastDateInput(nextAssessmentDate)) {
            alert('Next assessment date cannot be in the past.');
            return;
        }
        try {
            await apiFetch(`/assessments/diagnose/${window.currentChildId}`, {
                method: 'POST',
                body: JSON.stringify({
                    diagnosis,
                    recommendations,
                    nextAssessmentDate: nextAssessmentDate || null,
                    nextAssessmentReason: nextAssessmentReason || null
                })
            });
            alert('✅ Diagnosis submitted! The parent will be notified.');
            closeDiagnosisModal();
            loadPatients();
        } catch (err) {
            alert('Failed to submit: ' + err.message);
        }
    }

    function closeDiagnosisModal() {
        document.getElementById('diagnosisModal').style.display = 'none';
        document.getElementById('diagnosis-text').value = '';
        document.getElementById('recommendations-text').value = '';
        document.getElementById('next-assessment-date').value = '';
        document.getElementById('next-assessment-reason').value = '';
        document.getElementById('next-assessment-suggestion').textContent = '';
        window.currentChildId = null;
        window.currentDiagnosisScore = null;
    }

    function exportPatients() {
        if (!_allPatients.length) { alert('No patients to export.'); return; }
        const rows = [['Name','Parent','Age','Apt Status','Has Diagnosis','Overall Score']];
        _allPatients.forEach(p => {
            rows.push([
                `${p.childFirstName} ${p.childLastName}`,
                `${p.parentFirstName||''} ${p.parentLastName||''}`.trim(),
                calcAge(p.childDateOfBirth),
                p.appointmentStatus || '—',
                p.diagnosis ? 'Yes' : 'No',
                p.scores?.['Communication'] !== undefined ? Object.values(p.scores).reduce((a,b)=>a+b,0)/4+'%' : '—'
            ]);
        });
        const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
        const a = document.createElement('a');
        a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
        a.download = 'my-patients.csv';
        a.click();
    }


    function renderAssessmentHistory(items) {
        const wrap = document.getElementById('assessmentHistoryList');
        if (!wrap) return;
        if (!items.length) {
            wrap.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">No previous assessments yet.</p>';
            return;
        }
        wrap.innerHTML = items.map(a => {
            const when = a.completedAt || a.startedAt;
            const dateText = when ? new Date(when).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : '—';
            const score = a.overallScore != null ? `${a.overallScore}% overall` : 'Assessment started';
            return `
                <div style="background:var(--bg-primary);border-radius:10px;padding:0.9rem 1rem;">
                    <div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap;">
                        <p style="font-weight:700;color:var(--text-dark);margin:0;">${dateText}</p>
                        <span style="font-size:0.75rem;color:var(--text-light);">${a.status || '—'}</span>
                    </div>
                    <p style="font-size:0.85rem;color:var(--primary);margin:0.35rem 0 0;">${score}</p>
                    ${a.diagnosis ? `<p style="font-size:0.82rem;color:var(--text-dark);margin:0.5rem 0 0;line-height:1.45;"><strong>Diagnosis:</strong> ${a.diagnosis}</p>` : ''}
                    ${a.nextAssessmentDate ? `<p style="font-size:0.82rem;color:var(--text-dark);margin:0.5rem 0 0;line-height:1.45;"><strong>Next assessment:</strong> ${formatDisplayDate(a.nextAssessmentDate)}${a.nextAssessmentReason ? ` - ${escapeHtml(a.nextAssessmentReason)}` : ''}</p>` : ''}
                </div>`;
        }).join('');
    }

    function renderProgressNotes(items) {
        const wrap = document.getElementById('progressTimeline');
        if (!wrap) return;
        if (!items.length) {
            wrap.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">No progress notes yet. Add the first clinical update above.</p>';
            return;
        }
        wrap.innerHTML = items.map(n => {
            const meta = progressStatusMeta(n.progressStatus);
            const dateText = n.createdAt ? new Date(n.createdAt).toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—';
            return `
                <div style="background:var(--bg-primary);border-radius:10px;padding:0.95rem 1rem;border-left:4px solid ${meta.color};">
                    <div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap;">
                        <span style="background:${meta.bg};color:${meta.color};padding:0.2rem 0.65rem;border-radius:999px;font-size:0.74rem;font-weight:700;">${meta.label}</span>
                        <span style="font-size:0.74rem;color:var(--text-light);">${dateText}</span>
                    </div>
                    <p style="font-size:0.85rem;color:var(--text-dark);margin:0.6rem 0 0;line-height:1.5;">${n.note || '—'}</p>
                </div>`;
        }).join('');
    }

    async function loadProgressData(childId) {
        const [historyData, notesData] = await Promise.all([
            apiFetch(`/assessments/${childId}/history`),
            apiFetch(`/assessments/child/${childId}/progress-notes`)
        ]);
        renderAssessmentHistory(historyData.assessments || []);
        renderProgressNotes(notesData.notes || []);
    }

    function openProgressModal(childId, childName) {
        window.currentProgressChildId = childId;
        document.getElementById('progressModalTitle').textContent = `Patient Progress History — ${childName}`;
        document.getElementById('progressPatientName').textContent = `Patient: ${childName}`;
        document.getElementById('progress-note').value = '';
        document.getElementById('progress-status').value = 'monitoring';
        document.getElementById('progressModal').style.display = 'flex';
        document.getElementById('progressTimeline').innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading progress notes...</p>';
        document.getElementById('assessmentHistoryList').innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading assessment history...</p>';
        loadProgressData(childId).catch((err) => {
            document.getElementById('progressTimeline').innerHTML = `<p style="text-align:center;color:#c0392b;padding:1rem;">${err.message}</p>`;
            document.getElementById('assessmentHistoryList').innerHTML = `<p style="text-align:center;color:#c0392b;padding:1rem;">${err.message}</p>`;
        });
    }

    async function submitProgressNote() {
        const childId = window.currentProgressChildId;
        const progressStatus = document.getElementById('progress-status').value;
        const note = document.getElementById('progress-note').value.trim();
        if (!childId) { alert('Child is missing. Please reopen the progress history modal.'); return; }
        if (!note) { alert('Please write a progress note first.'); return; }

        try {
            await apiFetch(`/assessments/child/${childId}/progress-notes`, {
                method: 'POST',
                body: JSON.stringify({ progressStatus, note })
            });

            document.getElementById('progress-note').value = '';
            document.getElementById('progress-status').value = 'monitoring';
            await loadProgressData(childId);
            await loadPatients();
            alert('✅ Progress note saved.');
        } catch (err) {
            alert('Failed to save progress note: ' + err.message);
        }
    }

    function closeProgressModal() {
        document.getElementById('progressModal').style.display = 'none';
        document.getElementById('progress-note').value = '';
        window.currentProgressChildId = null;
    }


    
// Format notification timestamps in one consistent style
function formatDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

// Small escape helper so notification text is safe to render in HTML
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

// Decide where a notification should open based on the current user role
function notificationDestination(n) {
    let role = '';
    try {
        role = String((JSON.parse(localStorage.getItem('kc_user')) || {}).role || '').toLowerCase();
    } catch {}

    const title = String(n?.title || '').toLowerCase();
    const type  = String(n?.type  || '').toLowerCase();
    const msg   = String(n?.message || '').toLowerCase();

    if (role === 'pediatrician') {
        if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/pedia/pedia-chat.html';
        if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/pedia/pediatrician-appointments.html';
        if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question answered')) return '/pedia/pedia-questions.html';
        if (title.includes('diagnosis') || msg.includes('diagnosis') || title.includes('recommendation') || msg.includes('recommendation')) return '/pedia/pediatrician-patients.html';
        return '/pedia/pediatrician-dashboard.html';
    }

    if (type === 'chat' || title.includes('message') || msg.includes('message from')) return '/parent/chat.html';
    if (type === 'appointment' || title.includes('appointment') || msg.includes('appointment')) return '/parent/appointments.html';
    if (type === 'assessment' || title.includes('custom question') || title.includes('assessment question') || title.includes('question assigned') || title.includes('question answered')) return '/parent/custom-questions.html';
    if (title.includes('recommendation') || msg.includes('recommendation')) return '/parent/recommendations.html';
    if (title.includes('result') || title.includes('diagnosis') || msg.includes('diagnosis')) return '/parent/results.html';
    return '/parent/dashboard.html';
}

// Keep the bell badge in sync on every page that uses the shared modal
async function loadNotificationCount() {
    try {
        const data = await apiFetch('/notifications/count');
        const badge = document.querySelector('.notification-badge');
        if (!badge) return;
        const unread = data.unread || 0;
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'flex' : 'none';
    } catch {
        const badge = document.querySelector('.notification-badge');
        if (badge) {
            badge.textContent = '0';
            badge.style.display = 'none';
        }
    }
}

// Mark only one notification as read when the user opens or clicks it
async function markNotificationRead(id) {
    try {
        await apiFetch(`/notifications/${id}/read`, { method: 'PUT' });
        await loadNotificationCount();
    } catch {}
}

// Remove one notification from the user's list
async function deleteNotification(id) {
    if (!confirm('Remove this notification?')) return;
    try {
        await apiFetch(`/notifications/${id}`, { method: 'DELETE' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not remove notification: ' + err.message);
    }
}

// Delete every notification so old items do not stay in the modal forever
async function clearAllNotifications() {
    if (!confirm('Clear all notifications?')) return;
    try {
        await apiFetch('/notifications/clear-all', { method: 'DELETE' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not clear notifications: ' + err.message);
    }
}

// Optional helper so users can mark everything as seen without deleting them
async function markAllNotificationsRead() {
    try {
        await apiFetch('/notifications/read-all', { method: 'PUT' });
        await openNotifications();
        await loadNotificationCount();
    } catch (err) {
        alert('Could not mark notifications as read: ' + err.message);
    }
}

// Mark read first, then send the user to the related page
async function goToNotificationTarget(id, target) {
    await markNotificationRead(id);
    window.location.href = target;
}

// Shared notification modal renderer used by both parent and pediatrician pages
async function openNotifications() {
    const modal = document.getElementById('notificationsModal');
    const listEl = modal ? modal.querySelector('.notifications-list') : null;
    if (!modal || !listEl) return;

    modal.style.display = 'flex';
    listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Loading...</p>';

    try {
        const data = await apiFetch('/notifications');
        const notifications = Array.isArray(data.notifications) ? data.notifications : [];

        if (!notifications.length) {
            listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1.5rem;">No notifications yet.</p>';
            return;
        }

        const hasUnread = notifications.some(n => !n.isRead);
        const tools = `
            <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:#c0392b;padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
            </div>`;

        const items = notifications.map((n) => {
            const dest = notificationDestination(n);
            const unreadStyle = n.isRead ? '' : 'background:#f0f7f0;border-left:3px solid var(--primary);';
            const click = dest
                ? `goToNotificationTarget(${n.id}, '${dest}')`
                : `markNotificationRead(${n.id})`;

            return `
                <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                    <div onclick="${click}" style="flex:1;cursor:pointer;min-width:0;">
                        <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                        <p style="font-size:.82rem;color:#555;margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                        <p style="font-size:.75rem;color:#aaa;margin:0;">${formatDateTime(n.createdAt)}</p>
                        ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                    </div>
                    <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:#c0392b;cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                </div>`;
        }).join('');

        listEl.innerHTML = tools + items;
    } catch {
        listEl.innerHTML = '<p style="text-align:center;color:#888;padding:1rem;">Could not load notifications.</p>';
    }
}

function closeNotifications() {
    const modal = document.getElementById('notificationsModal');
    if (modal) modal.style.display = 'none';
}


function toggleProfileMenu() {
        const m = document.getElementById('profileMenu');
        m.style.display = m.style.display === 'none' ? 'block' : 'none';
    }

    document.addEventListener('click', e => {
        if (!e.target.closest('.profile-btn')) document.getElementById('profileMenu').style.display = 'none';
    });

    // Close modals when the user clicks the dark overlay instead of the white content box.
    window.addEventListener('click', (e) => {
        if (e.target === document.getElementById('diagnosisModal')) closeDiagnosisModal();
        if (e.target === document.getElementById('progressModal')) closeProgressModal();
        if (e.target === document.getElementById('reviewModal')) closeReviewModal();
        if (e.target === document.getElementById('notificationsModal')) closeNotifications();
    });

    // ── Review Pre-Assessment Modal ─────────────────────────────────────────
    function openReviewModal() { document.getElementById('reviewModal').style.display = 'flex'; }
    function closeReviewModal() { document.getElementById('reviewModal').style.display = 'none'; }

    function insightIcon(level) {
        if (level === 'positive') return '<span class="ra-insight-dot ra-dot-positive"></span>';
        if (level === 'warning')  return '<span class="ra-insight-dot ra-dot-warning"></span>';
        return '<span class="ra-insight-dot ra-dot-concern"></span>';
    }

    function domainIcon(domain) {
        const map = {
            'Communication': '/icons/chat.png',
            'Social Skills': '/icons/parent.png',
            'Cognitive': '/icons/analytics.png',
            'Motor Skills': '/icons/appointment.png',
        };
        return map[domain] || '/icons/clipboard.png';
    }

    function riskBadgeClass(risk) {
        if (!risk) return 'ra-risk-unknown';
        if (risk.includes('High'))     return 'ra-risk-high';
        if (risk.includes('Moderate')) return 'ra-risk-moderate';
        return 'ra-risk-low';
    }

    function domainRiskClass(level) {
        if (level === 'high')     return 'ra-domain-high';
        if (level === 'moderate') return 'ra-domain-moderate';
        return 'ra-domain-low';
    }

    async function openReviewAnswers(childId, childName) {
        document.getElementById('reviewModalTitle').textContent = `Review Pre-Assessment — ${childName}`;
        document.getElementById('reviewModalBody').innerHTML =
            '<p style="text-align:center;color:var(--text-light);padding:2rem;">Loading pre-assessment data...</p>';
        openReviewModal();

        try {
            const data = await apiFetch(`/assessments/${childId}/review-answers`);
            renderReviewModal(data);
        } catch (err) {
            document.getElementById('reviewModalBody').innerHTML = `
                <div style="text-align:center;padding:3rem 2rem;">
                    <p style="font-size:1.5rem;margin-bottom:1rem;"><img src="/icons/smart_notif.png" alt="" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"></p>
                    <p style="font-weight:600;color:var(--text-dark);margin-bottom:0.5rem;">${err.message}</p>
                    <p style="font-size:0.85rem;color:var(--text-light);">This patient may not have a completed pre-assessment yet.</p>
                </div>`;
        }
    }

    function renderReviewModal(data) {
        const c = data.child;
        const a = data.assessment;
        const childAge = c.age != null ? `${c.age} years old` : '—';
        const genderLabel = c.gender === 'female' ? 'Female' : c.gender === 'male' ? 'Male' : '—';
        const completedDate = a.completedAt
            ? new Date(a.completedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : '—';
        const riskClass = riskBadgeClass(data.overallRisk);

        let html = '';

        // ── Sticky child profile header ──
        html += `
        <div class="ra-child-header">
            <div class="ra-child-info">
                <div>
                    <p class="ra-child-name">${c.firstName} ${c.lastName}</p>
                    <div class="ra-child-meta">
                        <span class="ra-meta-chip">Age: ${childAge}</span>
                        <span class="ra-meta-chip">${genderLabel}</span>
                        <span class="ra-meta-chip">${c.ageLabel || '—'}</span>
                    </div>
                </div>
                <div class="ra-header-right">
                    <div class="ra-overall-score">
                        <span class="ra-score-num">${data.overallScore != null ? data.overallScore + '%' : '—'}</span>
                        <span class="ra-score-label">Overall Score</span>
                    </div>
                    <span class="ra-risk-badge ${riskClass}">${data.overallRisk || 'N/A'}</span>
                </div>
            </div>
            <p class="ra-completed-date">Assessment completed: <strong>${completedDate}</strong></p>
        </div>`;

        // ── Risk flags ──
        if (data.riskFlags && data.riskFlags.length) {
            html += '<div class="ra-risk-flags">';
            html += '<p class="ra-flags-title"><img src="/icons/smart_notif.png" alt="" style="width:1em;height:1em;object-fit:contain;vertical-align:-0.15em;"> Risk Flags Detected</p>';
            html += '<div class="ra-flags-list">';
            data.riskFlags.forEach(f => {
                html += `<span class="ra-flag-chip">${f}</span>`;
            });
            html += '</div></div>';
        }

        // ── Domain sections ──
        const domainOrder = ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'];
        for (const domain of domainOrder) {
            const answers = data.answersByDomain[domain];
            if (!answers || !answers.length) continue;

            const summary = data.domainSummaries[domain];
            const dRisk = summary ? domainRiskClass(summary.riskLevel) : '';
            const scoreVal = summary ? summary.score + '%' : '—';
            const statusLabel = summary ? summary.status : '—';

            html += `
            <div class="ra-domain-section ${dRisk}">
                <div class="ra-domain-header">
                    <div class="ra-domain-title-row">
                        <img src="${domainIcon(domain)}" alt="" class="ra-domain-icon">
                        <h4 class="ra-domain-title">${domain}</h4>
                    </div>
                    <div class="ra-domain-score-wrap">
                        <span class="ra-domain-score">${scoreVal}</span>
                        <span class="ra-domain-status">${statusLabel}</span>
                    </div>
                </div>
                <div class="ra-answers-list">`;

            answers.forEach((q, idx) => {
                const answerClass = q.insightLevel === 'concern' ? 'ra-answer-concern'
                    : q.insightLevel === 'warning' ? 'ra-answer-warning' : 'ra-answer-positive';

                html += `
                <div class="ra-answer-card ${answerClass}">
                    <div class="ra-q-row">
                        <span class="ra-q-num">Q${idx + 1}</span>
                        <p class="ra-q-text">${q.questionText}</p>
                    </div>
                    <div class="ra-comparison-row">
                        <div class="ra-comp-block ra-parent-block">
                            <span class="ra-comp-label">Parent's Answer</span>
                            <p class="ra-comp-value">${q.answer}</p>
                        </div>
                        <div class="ra-comp-block ra-ai-block">
                            <span class="ra-comp-label">AI Interpretation</span>
                            <p class="ra-comp-value">${insightIcon(q.insightLevel)} ${q.aiInsight}</p>
                        </div>
                    </div>
                </div>`;
            });

            html += '</div></div>';
        }

        // ── Existing diagnosis (read-only) ──
        if (a.diagnosis) {
            html += `
            <div class="ra-existing-diag">
                <h4><img src="/icons/clipboard.png" alt="" style="width:1em;height:1em;object-fit:contain;vertical-align:-0.15em;"> Current Diagnosis</h4>
                <p class="ra-diag-text">${a.diagnosis}</p>
                ${a.recommendations ? `<p class="ra-diag-rec"><strong>Recommendations:</strong> ${a.recommendations}</p>` : ''}
                ${a.nextAssessmentDate ? `<p class="ra-diag-rec"><strong>Next assessment:</strong> ${formatDisplayDate(a.nextAssessmentDate)}${a.nextAssessmentReason ? ` - ${escapeHtml(a.nextAssessmentReason)}` : ''}</p>` : ''}
            </div>`;
        }

        // ── Review notes textarea ──
        html += `
        <div class="ra-review-notes">
            <h4><img src="/icons/logs.png" alt="" style="width:1em;height:1em;object-fit:contain;vertical-align:-0.15em;"> Review Remarks</h4>
            <textarea id="reviewNotesText" class="ra-notes-textarea" placeholder="Add your validation notes, observations, or remarks about this pre-assessment..."></textarea>
            <div class="ra-notes-actions">
                <button class="btn btn-primary" onclick="saveReviewNote('${c.id}')" style="padding:0.7rem 1.5rem;">Save Review Note</button>
                <button class="btn btn-secondary" onclick="closeReviewModal()" style="padding:0.7rem 1.5rem;">Close</button>
            </div>
        </div>`;

        document.getElementById('reviewModalBody').innerHTML = html;
    }

    async function saveReviewNote(childId) {
        const note = document.getElementById('reviewNotesText').value.trim();
        if (!note) { alert('Please write a review note first.'); return; }
        try {
            await apiFetch(`/assessments/child/${childId}/progress-notes`, {
                method: 'POST',
                body: JSON.stringify({ progressStatus: 'initial_review', note: `[Pre-Assessment Review] ${note}` })
            });
            alert('✅ Review note saved to patient progress history.');
            document.getElementById('reviewNotesText').value = '';
        } catch (err) {
            alert('Failed to save review note: ' + err.message);
        }
    }

    // Init
    loadPatients();
    loadNotificationCount();
