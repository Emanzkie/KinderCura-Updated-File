// === Extracted from PARENT\recommendations.html (script block 1) ===
// Define missing functions for assessment context management
        function getRequestedChildId() {
            try {
                return new URLSearchParams(window.location.search).get('childId');
            } catch {
                return null;
            }
        }

        function getRequestedAssessmentId() {
            try {
                return new URLSearchParams(window.location.search).get('assessmentId');
            } catch {
                return null;
            }
        }

        function setParentContext(childId, assessmentId = null) {
            if (childId) localStorage.setItem('kc_childId', childId);
            else localStorage.removeItem('kc_childId');
            
            if (assessmentId) localStorage.setItem('kc_assessmentId', assessmentId);
            else localStorage.removeItem('kc_assessmentId');
        }

        async function getLatestCompletedAssessment(childId) {
            try {
                const hist = await apiFetch(`/assessments/${childId}/history`);
                const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
                if (assessments.length > 0) {
                    return assessments[0]; // Return the most recent completed assessment
                }
                return null;
            } catch (error) {
                console.error("Error fetching latest completed assessment:", error);
                return null;
            }
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

        function fmtDate(dateString) {
            const date = new Date(dateString);
            return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        }

        requireAuth();

        const ICONS = { communication:'<img src="/icons/communication.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', social:'<img src="/icons/social.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', cognitive:'<img src="/icons/cognitive.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">', motor:'<img src="/icons/motor.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">' };
        // Same colours as the results-page score guide: --accent-red,
        // --accent, --success. They are light fills, so chips use dark text,
        // and every chip keeps its text label.
        const PRIORITY_COLORS = { high:'var(--accent-red)', medium:'var(--accent)', low:'var(--success)' };
        const PRIORITY_LABELS = { high:'Needs Attention', medium:'Monitor Progress', low:'Keep Up Great Work' };
        // Display-only mirror of RECOMMENDATION_LEVEL_BY_BAND in
        // routes/recommendations.js (score band -> priority), used to build the
        // label legend from window.KCScoring's ranges. It never assigns a
        // priority — each card shows the priority stored by the server.
        const PRIORITY_BY_BAND = { 'on-track':'low', developing:'medium', 'at-risk':'medium', delayed:'high' };
        // r.skill -> area score field on GET /assessments/:id/results.
        const SKILL_SCORE = {
            communication: { field:'communicationScore', label:'Communication' },
            social:        { field:'socialScore',        label:'Social Skills' },
            cognitive:     { field:'cognitiveScore',     label:'Cognitive' },
            motor:         { field:'motorScore',         label:'Motor Skills' },
        };

        // Legend for the priority chips: which area-score range each label covers,
        // grouped from the current KCScoring bands.
        function renderPriorityLegend() {
            const S = window.KCScoring;
            if (!S || !Array.isArray(S.ACTIVE_BANDS)) return '';
            const items = ['high', 'medium', 'low'].map((priority) => {
                const bands = S.ACTIVE_BANDS.filter((b) => PRIORITY_BY_BAND[b.key] === priority);
                if (!bands.length) return '';
                const min = Math.min(...bands.map((b) => b.min));
                const max = Math.max(...bands.map((b) => b.max));
                return `
                    <li>
                        <span class="kc-swatch" style="background:${PRIORITY_COLORS[priority]};" aria-hidden="true"></span>
                        <span><span class="kc-chart-legend-label">${PRIORITY_LABELS[priority]}</span>: area score ${min}&ndash;${max}%</span>
                    </li>`;
            }).join('');
            return `
                <div style="background:#FAFAF6;border-radius:15px;padding:1.4rem 2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-bottom:1.5rem;">
                    <h3 style="margin:0 0 .3rem;color:var(--primary);font-size:1rem;">How the recommendation labels work</h3>
                    <p style="margin:0;color:var(--text-light);font-size:.85rem;line-height:1.5;">Each card below is one developmental area. Its label comes from that area's recorded score in the latest assessment, using KinderCura's current score ranges:</p>
                    <ul class="kc-chart-legend">${items}</ul>
                </div>`;
        }

        let allChildren = [];
        let activeChild = null;
        let activeAssessment = null;

        function safeRequestedChildId() {
            try {
                return typeof getRequestedChildId === 'function'
                    ? getRequestedChildId()
                    : new URLSearchParams(window.location.search).get('childId');
            } catch {
                return null;
            }
        }

        function safeRequestedAssessmentId() {
            try {
                return typeof getRequestedAssessmentId === 'function'
                    ? getRequestedAssessmentId()
                    : new URLSearchParams(window.location.search).get('assessmentId');
            } catch {
                return null;
            }
        }

        function storedChildId() {
            try { return typeof KC?.childId === 'function' ? KC.childId() : localStorage.getItem('kc_childId'); }
            catch { return localStorage.getItem('kc_childId'); }
        }

        function storedAssessmentId() {
            try { return typeof KC?.assessmentId === 'function' ? KC.assessmentId() : localStorage.getItem('kc_assessmentId'); }
            catch { return localStorage.getItem('kc_assessmentId'); }
        }

        function saveParentChildContext(childId, assessmentId = null) {
            if (typeof setParentContext === 'function') {
                setParentContext(childId, assessmentId);
                return;
            }
            if (childId) localStorage.setItem('kc_childId', childId);
            else localStorage.removeItem('kc_childId');
            if (assessmentId) localStorage.setItem('kc_assessmentId', assessmentId);
            else localStorage.removeItem('kc_assessmentId');
        }

        function updateParentNavLinks() {
            const childId = activeChild?.id || storedChildId();
            const assessmentId = activeAssessment?.id || storedAssessmentId();
            const setHref = (selector, baseHref, includeAssessment = false) => {
                const link = document.querySelector(selector);
                if (!link) return;
                const q = new URLSearchParams();
                if (childId) q.set('childId', childId);
                if (includeAssessment && assessmentId) q.set('assessmentId', assessmentId);
                link.href = q.toString() ? `${baseHref}?${q.toString()}` : baseHref;
            };

            // Keep the active child and assessment context when moving between parent pages.
            setHref('.main-nav a[href="/parent/dashboard"]', '/parent/dashboard');
            setHref('.main-nav a[href="/parent/results"]', '/parent/results', true);
            setHref('.main-nav a[href="/parent/recommendations"]', '/parent/recommendations', true);
            setHref('.main-nav a[href="/parent/appointments"]', '/parent/appointments');
            setHref('.main-nav a[href="/parent/custom-questions"]', '/parent/custom-questions');
        }

        function switchChild(childId) {
            saveParentChildContext(childId, null);
            window.location.href = `/parent/recommendations?childId=${encodeURIComponent(childId)}`;
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

        async function resolveContext() {
            allChildren = await fetchParentChildren();
            if (!allChildren.length) return null;

            const preferredChildId = safeRequestedChildId() || storedChildId();
            activeChild = allChildren.find((c) => String(c.id) === String(preferredChildId)) || allChildren[0];
            renderChildSwitcher();

            const preferredAssessmentId = safeRequestedAssessmentId() || storedAssessmentId();
            if (preferredAssessmentId) {
                try {
                    const forced = await apiFetch(`/assessments/${preferredAssessmentId}/results`);
                    if (String(forced.results?.childId || '') === String(activeChild.id)) {
                        activeAssessment = { id: preferredAssessmentId, ...forced.results };
                        saveParentChildContext(activeChild.id, preferredAssessmentId);
                        updateParentNavLinks();
                        return preferredAssessmentId;
                    }
                } catch {}
            }

            const latest = await getLatestCompletedAssessment(activeChild.id);
            activeAssessment = latest;
            saveParentChildContext(activeChild.id, latest?.id || null);
            updateParentNavLinks();
            return latest?.id || null;
        }

        function goBookWithPediatrician(pediatricianId, assessmentId) {
            localStorage.setItem('kc_prefPediaId', pediatricianId);
            saveParentChildContext(activeChild?.id || null, assessmentId || null);
            window.location.href = `/parent/appointments?childId=${encodeURIComponent(activeChild?.id || '')}`;
        }

        function renderSuggestedClinics(suggestedPediatricians, assessmentId, bookedConsultation, suggestionSummary) {
            if (!Array.isArray(suggestedPediatricians) || !suggestedPediatricians.length) return '';

            const top = suggestedPediatricians.slice(0, 3);
            return `
                <div style="background:#FAFAF6;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-bottom:2rem;">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
                        <div>
                            <h2 style="color:var(--primary);margin:0 0 .35rem;">Suggested Pediatricians / Clinics</h2>
                            <p style="color:var(--text-light);margin:0;">${escapeHtml(suggestionSummary || 'KinderCura matched these clinics based on the latest assessment.')}</p>
                        </div>
                        ${bookedConsultation ? '<span class="review-pill">Consultation Already Booked</span>' : '<span class="review-pill">Top Clinic Matches</span>'}
                    </div>
                    ${top.map((p) => `
                        <div class="clinic-card">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
                                <div>
                                    <h3 style="margin:0 0 .3rem;">Dr. ${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</h3>
                                    <p class="mini" style="margin:0 0 .2rem;">${escapeHtml(p.specialization || 'Pediatrician')}</p>
                                    <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/pediatrician.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(p.clinicName || p.institution || 'Clinic not set')}</p>
                                    <p class="mini" style="margin:0 0 .2rem;"><img src="/icons/address.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(p.clinicAddress || 'Clinic address not available')}</p>
                                    ${p.phoneNumber ? `<p class="mini" style="margin:0 0 .2rem;"><img src="/icons/mobile_number.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${escapeHtml(p.phoneNumber)}</p>` : ''}
                                    ${p.consultationFee != null ? `<p class="mini" style="margin:0 0 .2rem;"><img src="/icons/consultation_fee.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Consultation Fee: ₱${Number(p.consultationFee).toLocaleString()}</p>` : ''}
                                    <p class="mini" style="margin:0;">Why suggested: ${escapeHtml(p.suggestedReason || 'Good clinic match')}</p>
                                </div>
                                <div style="display:flex;flex-direction:column;gap:.6rem;align-items:flex-end;">
                                    <span class="review-pill">${p.isSuggested ? 'Suggested Match' : 'Available Clinic'}</span>
                                    ${bookedConsultation
                                        ? `<button class="btn btn-secondary" onclick="window.location.href='/parent/appointments?childId=${encodeURIComponent(activeChild.id)}'">View Appointment</button>`
                                        : `<button class="btn btn-primary" onclick="goBookWithPediatrician('${p.id}', '${assessmentId}')">Book With This Clinic</button>`}
                                </div>
                            </div>
                            <div class="clinic-grid" style="margin-top:.9rem;">
                                <div class="mini"><img src="/icons/appointment.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Available Days: ${Array.isArray(p.availability?.days) && p.availability.days.length ? escapeHtml(p.availability.days.join(', ')) : 'Not set'}</div>
                                <div class="mini"><img src="/icons/pedia_hours.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Hours: ${fmtTime(p.availability?.startTime)} - ${fmtTime(p.availability?.endTime)}</div>
                            </div>
                        </div>`).join('')}
                </div>`;
        }

        // "Communication area score: 50% in the latest assessment" — the stored
        // score from the same /results response this page already loads.
        function areaScoreLine(skill, result) {
            const def = SKILL_SCORE[skill];
            const raw = def && result ? result[def.field] : null;
            if (raw == null || !Number.isFinite(Number(raw))) return '';
            return `<p style="margin:0 0 .6rem;font-size:.85rem;color:var(--text-dark);">${escapeHtml(def.label)} area score: <strong>${Math.round(Number(raw))}%</strong> <span style="color:var(--text-light);">&mdash; recorded score for this area in the latest assessment</span></p>`;
        }

        // kc-badge only defines positive/caution/attention/neutral/info — this is a
        // defensive pass-through so an unrecognized tone never emits a broken class.
        function stageBadgeSafe(tone) {
            return ['positive', 'caution', 'attention', 'neutral', 'info'].includes(tone) ? tone : 'neutral';
        }

        // Step 14: same Developmental Assessment & Care Plan summary shown on the
        // Results page (js/parent/results.js renderCarePlanCard), built from the
        // SAME backend fields (developmentalBand, overallCarePlan.*) so the two
        // pages never disagree. Nothing here recomputes a band/risk/care stage —
        // window.KCCarePlan only formats what GET /api/recommendations/:id already
        // decided.
        function renderCarePlanCard(developmentalBand, carePlan) {
            if (!carePlan) return '';
            const CP = window.KCCarePlan;

            const bandLabel = CP.developmentalBandLabel(developmentalBand);
            const bandTone = stageBadgeSafe(CP.toneForDevelopmentalBand(developmentalBand));
            const riskLabel = CP.riskCategoryLabel(carePlan.riskCategory, carePlan.source);
            const riskTone = stageBadgeSafe(CP.toneForRiskCategory(carePlan.riskCategory));
            const stageLabel = CP.careStageLabel(carePlan.careStageLabel);
            const stageTone = stageBadgeSafe(CP.toneForCareStage(carePlan.careStage));
            const consultationLabel = CP.consultationLevelLabel(carePlan.consultationLevel);
            const monitoringLabel = CP.monitoringLevelLabel(carePlan.monitoringLevel);
            const interpretation = CP.interpretationLine(carePlan.source);

            // Same plain-language lines as the Results page (shared helper).
            const hints = CP.fieldHints(carePlan.riskCategory, carePlan.source);

            const field = (label, valueHtml, hint) => `
                <div>
                    <p style="margin:0 0 .4rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-light);">${escapeHtml(label)}</p>
                    ${valueHtml}
                    ${hint ? `<p style="margin:.45rem 0 0;font-size:.76rem;line-height:1.45;color:var(--text-light);">${escapeHtml(hint)}</p>` : ''}
                </div>`;

            return `
            <div style="background:#FAFAF6;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-bottom:2rem;">
                <h3 style="margin:0 0 .4rem;color:var(--primary);">Developmental Assessment &amp; Care Plan</h3>
                <p style="margin:0 0 1.2rem;font-size:.85rem;color:var(--text-light);line-height:1.5;">A summary of how KinderCura's existing rules classify the latest assessment, and the follow-up they suggest.</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1.4rem;">
                    ${field('Developmental Band', `<span class="kc-badge kc-badge--${bandTone}">${escapeHtml(bandLabel)}</span>`, hints.band)}
                    ${field('Developmental Risk Category', `<span class="kc-badge kc-badge--${riskTone}">${escapeHtml(riskLabel)}</span>`, hints.risk)}
                    ${field('Care Stage', `<span class="kc-badge kc-badge--${stageTone}">${escapeHtml(stageLabel)}</span>`, hints.stage)}
                    ${field('Consultation', `<p style="margin:0;font-weight:600;color:var(--text-dark);">${escapeHtml(consultationLabel)}</p>`, hints.consultation)}
                    ${field('Monitoring', `<p style="margin:0;font-weight:600;color:var(--text-dark);">${escapeHtml(monitoringLabel)}</p>`, hints.monitoring)}
                </div>
                <p style="margin:1.3rem 0 0;font-size:.8rem;color:var(--text-light);">${escapeHtml(interpretation)}. ${escapeHtml(hints.disclaimer)}</p>
            </div>`;
        }

        // "Activities completed: X of Y (Z%)" — the numbers come from the server
        // (routes/recommendations.js buildActivityProgress), never counted here.
        function renderActivityProgress(progress) {
            const p = progress || { completed: 0, total: 0, percentage: 0 };
            return `
                <h3 style="margin-bottom:0.5rem;">Home Activity Progress</h3>
                <p style="color:var(--text-light);margin-bottom:0.75rem;">Activities completed: <strong>${p.completed} of ${p.total}</strong> (${p.percentage}%)</p>
                <div role="progressbar" aria-label="Activities completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percentage}" style="height:10px;background:var(--border);border-radius:5px;overflow:hidden;">
                    <div style="height:100%;width:${p.percentage}%;background:var(--primary);"></div>
                </div>
                <p id="activityProgressError" class="kc-alert kc-alert--error" role="alert" style="margin-top:0.75rem;display:none;"></p>`;
        }

        async function toggleActivity(input) {
            const completed = input.checked;
            input.disabled = true;
            try {
                const data = await apiFetch(`/recommendations/${encodeURIComponent(input.dataset.recId)}/activities`, {
                    method: 'PATCH',
                    body: JSON.stringify({ activity: input.dataset.activity, completed }),
                });
                input.checked = (data.completedActivities || []).includes(input.dataset.activity);
                const box = document.getElementById('activityProgress');
                if (box) box.innerHTML = renderActivityProgress(data.activityProgress);
            } catch (e) {
                input.checked = !completed;
                const err = document.getElementById('activityProgressError');
                if (err) {
                    err.textContent = `Could not save that change: ${e.message}`;
                    err.style.display = 'block';
                }
            } finally {
                input.disabled = false;
            }
        }

        // ── Scheduled activity sessions (routes/recommendations.js) ─────────
        // Every session of the shown assessment's recommendations, as the
        // server serialised it (status is already "missed" once its day passed).
        let scheduledTasks = [];
        const SESSION_STATUS = {
            pending:   { label: 'Pending',   tone: 'neutral' },
            completed: { label: 'Completed', tone: 'positive' },
            missed:    { label: 'Missed',    tone: 'attention' },
        };

        // Sessions are Manila days, like the reminder job.
        function manilaToday() {
            return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        }

        function fmtSessionDate(ymd) {
            return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        }

        const sessionWhen = (t) => `${t.scheduledDate}T${t.scheduledTime}`;

        function sessionsFor(recId, activity) {
            return scheduledTasks
                .filter((t) => t.recommendationId === recId && t.activity === activity)
                .sort((a, b) => sessionWhen(a).localeCompare(sessionWhen(b)));
        }

        function renderSessions(recId, activity) {
            return sessionsFor(recId, activity).map((t) => {
                const st = SESSION_STATUS[t.status] || SESSION_STATUS.pending;
                const id = escapeHtml(t.id);
                const actions = [
                    t.status !== 'completed' ? `<button type="button" class="btn btn-secondary activity-btn" onclick="openCompleteForm(this, '${id}')">Mark completed</button>` : '',
                    t.status === 'pending' ? `<button type="button" class="btn btn-secondary activity-btn" onclick="setSessionStatus(this, '${id}', 'missed')">Mark missed</button>` : '',
                    t.status !== 'completed' ? `<button type="button" class="btn btn-secondary activity-btn" onclick="openScheduleForm(this, '${id}')">Reschedule</button>` : '',
                    `<button type="button" class="btn btn-secondary activity-btn" onclick="removeSession(this, '${id}')">Remove</button>`,
                ].join('');
                return `
                    <li class="activity-session">
                        <span>${escapeHtml(fmtSessionDate(t.scheduledDate))} &middot; ${escapeHtml(fmtTime(t.scheduledTime))}</span>
                        <span class="kc-badge kc-badge--${st.tone}">${st.label}</span>
                        ${t.status === 'completed' && t.score != null ? `<span>Score: <strong>${Number(t.score)}%</strong></span>` : ''}
                        <span class="activity-session-actions">${actions}</span>
                    </li>`;
            }).join('');
        }

        // In-page reminder: the next pending sessions across all four areas.
        function renderUpcomingActivities() {
            const upcoming = scheduledTasks
                .filter((t) => t.status === 'pending')
                .sort((a, b) => sessionWhen(a).localeCompare(sessionWhen(b)))
                .slice(0, 5);
            const list = upcoming.length
                ? `<ul class="upcoming-activities">${upcoming.map((t) => `
                    <li>
                        <strong>${escapeHtml(fmtSessionDate(t.scheduledDate))} &middot; ${escapeHtml(fmtTime(t.scheduledTime))}</strong>
                        <span>${escapeHtml(SKILL_SCORE[t.skill]?.label || t.skill)}: ${escapeHtml(t.activity)}</span>
                    </li>`).join('')}</ul>`
                : `<p style="color:var(--text-light);margin:0;">${scheduledTasks.length ? 'No upcoming activities.' : 'No activities scheduled yet.'} Use <strong>Schedule</strong> under any recommended activity below to plan one.</p>`;
            return `
                <h3 style="margin-bottom:0.35rem;color:var(--primary);">Upcoming Activities</h3>
                <p style="color:var(--text-light);font-size:0.85rem;margin-bottom:0.75rem;">You also get a notification the day before (or on the morning of) each scheduled activity.</p>
                ${list}`;
        }

        function refreshActivityItem(item) {
            const list = item.querySelector('.activity-sessions');
            if (list) list.innerHTML = renderSessions(item.dataset.recId, item.dataset.activity);
            const upcoming = document.getElementById('upcomingActivities');
            if (upcoming) upcoming.innerHTML = renderUpcomingActivities();
        }

        // Checkbox and progress bar after a session was completed.
        function applyActivityState(item, data) {
            if (Array.isArray(data.completedActivities)) {
                const box = item.querySelector('input[type="checkbox"]');
                if (box) box.checked = data.completedActivities.includes(item.dataset.activity);
            }
            if (data.activityProgress) {
                const progress = document.getElementById('activityProgress');
                if (progress) progress.innerHTML = renderActivityProgress(data.activityProgress);
            }
        }

        function upsertSession(task) {
            scheduledTasks = scheduledTasks.filter((t) => t.id !== task.id).concat(task);
        }

        function showActivityError(item, message) {
            const err = item.querySelector('.activity-error');
            if (!err) return;
            err.textContent = message || '';
            err.style.display = message ? 'block' : 'none';
        }

        function closeActivityForm(el) {
            const item = el.closest('.activity-item');
            if (!item) return;
            item.querySelector('.activity-form-slot').innerHTML = '';
            showActivityError(item, '');
        }

        // New session (no taskId) or reschedule of an existing one.
        function openScheduleForm(btn, taskId = '') {
            const item = btn.closest('.activity-item');
            const task = taskId ? scheduledTasks.find((t) => t.id === taskId) : null;
            const today = manilaToday();
            showActivityError(item, '');
            item.querySelector('.activity-form-slot').innerHTML = `
                <form class="activity-form" data-task-id="${escapeHtml(taskId)}" onsubmit="saveSchedule(event, this)">
                    <label>Date <input type="date" name="date" required min="${today}" value="${escapeHtml(task && task.scheduledDate >= today ? task.scheduledDate : today)}"></label>
                    <label>Time <input type="time" name="time" required value="${escapeHtml(task ? task.scheduledTime : '')}"></label>
                    <button type="submit" class="btn btn-primary activity-btn">${task ? 'Save new time' : 'Save schedule'}</button>
                    <button type="button" class="btn btn-secondary activity-btn" onclick="closeActivityForm(this)">Cancel</button>
                </form>`;
            item.querySelector('.activity-form input[name="date"]').focus();
        }

        function openCompleteForm(btn, taskId) {
            const item = btn.closest('.activity-item');
            showActivityError(item, '');
            item.querySelector('.activity-form-slot').innerHTML = `
                <form class="activity-form" data-task-id="${escapeHtml(taskId)}" onsubmit="saveCompletion(event, this)">
                    <label>Score or progress (optional) <input type="number" name="score" min="0" max="100" step="1" inputmode="numeric" placeholder="0–100" style="width:6rem;"> %</label>
                    <button type="submit" class="btn btn-primary activity-btn">Mark completed</button>
                    <button type="button" class="btn btn-secondary activity-btn" onclick="closeActivityForm(this)">Cancel</button>
                </form>`;
            item.querySelector('.activity-form input[name="score"]').focus();
        }

        // Runs one schedule request for an activity item: disables its
        // buttons meanwhile, shows any error on the item, re-renders on success.
        async function sessionRequest(item, path, options) {
            const buttons = [...item.querySelectorAll('button')];
            buttons.forEach((b) => { b.disabled = true; });
            showActivityError(item, '');
            try {
                const data = await apiFetch(path, options);
                if (data.task) upsertSession(data.task);
                applyActivityState(item, data);
                item.querySelector('.activity-form-slot').innerHTML = '';
                return data;
            } catch (e) {
                showActivityError(item, `Could not save that change: ${e.message}`);
                return null;
            } finally {
                buttons.forEach((b) => { b.disabled = false; });
                if (item.isConnected) refreshActivityItem(item);
            }
        }

        async function saveSchedule(event, form) {
            event.preventDefault();
            const item = form.closest('.activity-item');
            const taskId = form.dataset.taskId;
            const body = JSON.stringify({ date: form.date.value, time: form.time.value, ...(taskId ? {} : { activity: item.dataset.activity }) });
            await sessionRequest(item, taskId
                ? `/recommendations/schedule/${encodeURIComponent(taskId)}`
                : `/recommendations/${encodeURIComponent(item.dataset.recId)}/schedule`,
                { method: taskId ? 'PATCH' : 'POST', body });
        }

        async function saveCompletion(event, form) {
            event.preventDefault();
            const item = form.closest('.activity-item');
            const raw = form.score.value.trim();
            await sessionRequest(item, `/recommendations/schedule/${encodeURIComponent(form.dataset.taskId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'completed', ...(raw === '' ? {} : { score: Number(raw) }) }),
            });
        }

        async function setSessionStatus(btn, taskId, status) {
            await sessionRequest(btn.closest('.activity-item'), `/recommendations/schedule/${encodeURIComponent(taskId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ status }),
            });
        }

        async function removeSession(btn, taskId) {
            if (!confirm('Remove this scheduled activity?')) return;
            const item = btn.closest('.activity-item');
            const data = await sessionRequest(item, `/recommendations/schedule/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
            if (data) {
                scheduledTasks = scheduledTasks.filter((t) => t.id !== taskId);
                refreshActivityItem(item);
            }
        }

        async function loadRecommendations() {
            const assessmentId = await resolveContext();
            if (!assessmentId || !activeChild) {
                document.getElementById('recsContent').innerHTML = `
                    <div style="text-align:center;padding:3rem;background:#FAFAF6;border-radius:15px;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);">
                        <p style="font-size:1.1rem;font-weight:600;margin-bottom:1rem;">No recommendations yet</p>
                        <p style="color:var(--text-light);margin-bottom:1.5rem;">Complete an assessment first to receive personalized recommendations for this child.</p>
                        <button class="btn btn-primary" onclick="window.location.href='/parent/screening'">Start Assessment</button>
                    </div>`;
                return;
            }

            try {
                const [data, resultData] = await Promise.all([
                    apiFetch(`/recommendations/${assessmentId}`),
                    apiFetch(`/assessments/${assessmentId}/results`)
                ]);

                const recs = data.recommendations || [];
                scheduledTasks = recs.flatMap((r) => (Array.isArray(r.scheduledTasks) ? r.scheduledTasks : []));
                const result = resultData.results || {};
                const suggested = data.suggestedPediatricians || [];
                const booked = Boolean(data.bookedConsultation);
                document.getElementById('recMeta').textContent = `${activeChild.firstName} ${activeChild.lastName} • Based on the latest assessment`;
                activeAssessment = { id: assessmentId, ...result };
                saveParentChildContext(activeChild.id, assessmentId);
                updateParentNavLinks();

                let html = '';

                // Important:
                // The pediatrician diagnosis and parent recommendation now live on
                // the Results page only, so this Recommendations page does not
                // duplicate that reviewed clinical note anymore.

                html += renderCarePlanCard(data.developmentalBand, data.overallCarePlan);

                if (data.consultationNeeded && !booked) {
                    html += `
                    <div style="background:linear-gradient(135deg,var(--accent) 0%,#F8E5B5 100%);border-radius:15px;padding:2rem;margin-bottom:2rem;color:#6B7967;box-shadow:0 4px 15px rgba(61, 71, 56, 0.12);">
                        <div style="display:flex;align-items:flex-start;gap:1.5rem;">
                            <span style="font-size:2.5rem;"><img src="/icons/smart_notif.png" alt="" aria-hidden="true" style="width:1em;height:1em;object-fit:contain;vertical-align:middle;"></span>
                            <div style="flex:1;">
                                <h2 style="margin-bottom:0.5rem;">Schedule Professional Consultation</h2>
                                <p style="margin-bottom:0.9rem;opacity:0.95;">${escapeHtml(data.suggestionSummary || 'Based on the assessment results, we recommend scheduling a consultation with a pediatrician.')}</p>
                                ${Array.isArray(data.focusAreas) && data.focusAreas.length ? `<p style="margin:0 0 1.1rem;font-weight:600;">Focus areas: ${escapeHtml(data.focusAreas.join(', '))}</p>` : ''}
                                <button class="btn btn-primary" onclick="window.location.href='/parent/appointments?childId=${encodeURIComponent(activeChild.id)}'" style="background:#FAFAF6;color:var(--text-dark);font-weight:700;">Book Appointment Now</button>
                            </div>
                        </div>
                    </div>`;
                }

                if (booked) {
                    html += `
                    <div style="background:var(--surface-tint);border-left:4px solid var(--primary);border-radius:15px;padding:1.3rem 1.4rem;margin-bottom:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.06);">
                        <h3 style="margin:0 0 .35rem;color:var(--primary);">Consultation already scheduled</h3>
                        <p style="margin:0;color:var(--text-light);">This child already has a consultation request or appointment. The urgent consultation banner has been hidden to avoid confusion.</p>
                    </div>`;
                }

                html += renderSuggestedClinics(suggested, assessmentId, booked, data.suggestionSummary || 'KinderCura matched these clinics based on the latest assessment.');

                if (recs.length) html += `<div id="activityProgress" aria-live="polite" style="background:#FAFAF6;border-radius:15px;padding:1.5rem 2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-bottom:1.5rem;">${renderActivityProgress(data.activityProgress)}</div>`;
                if (recs.length) html += `<div id="upcomingActivities" aria-live="polite" style="background:#FAFAF6;border-radius:15px;padding:1.5rem 2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-bottom:1.5rem;">${renderUpcomingActivities()}</div>`;
                if (recs.length) html += renderPriorityLegend();

                recs.forEach((r) => {
                    const color = PRIORITY_COLORS[r.priority] || 'var(--primary)';
                    const label = PRIORITY_LABELS[r.priority] || '';
                    const icon = ICONS[r.skill] || '<img src="/icons/recommendations.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">';
                    const activities = Array.isArray(r.activities) ? r.activities : [];
                    const completedSet = new Set(Array.isArray(r.completedActivities) ? r.completedActivities : []);
                    html += `
                    <div style="background:#FAFAF6;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);border-left:4px solid ${color};margin-bottom:1.5rem;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:1rem;flex-wrap:wrap;">
                            <h3>${icon} ${r.skill.charAt(0).toUpperCase() + r.skill.slice(1)} Development</h3>
                            <span style="background:${color};color:var(--text-dark);padding:0.5rem 1rem;border-radius:20px;font-size:0.8rem;font-weight:600;">${label}</span>
                        </div>
                        ${areaScoreLine(r.skill, result)}
                        <p style="color:var(--text-light);margin-bottom:1rem;line-height:1.6;">${escapeHtml(r.suggestion)}</p>
                        ${activities.length ? `
                        <h4 style="font-weight:600;margin-bottom:0.5rem;">Recommended Activities:</h4>
                        <p style="color:var(--text-light);font-size:0.85rem;margin-bottom:0.5rem;">Tick an activity once your child has done it, or schedule a date and time to do it.</p>
                        <ul style="color:var(--text-light);list-style:none;padding-left:0;line-height:1.8;">
                            ${activities.map((a) => `<li class="activity-item" data-rec-id="${escapeHtml(r.id)}" data-activity="${escapeHtml(a)}">
                                <div class="activity-row">
                                    <label style="display:flex;align-items:flex-start;gap:0.6rem;cursor:pointer;"><input type="checkbox" data-rec-id="${escapeHtml(r.id)}" data-activity="${escapeHtml(a)}" ${completedSet.has(a) ? 'checked' : ''} onchange="toggleActivity(this)" style="margin-top:0.45rem;width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:var(--primary);"><span>${escapeHtml(a)}</span></label>
                                    <button type="button" class="btn btn-secondary activity-btn" onclick="openScheduleForm(this)">Schedule</button>
                                </div>
                                <div class="activity-form-slot"></div>
                                <p class="activity-error kc-alert kc-alert--error" role="alert" style="display:none;"></p>
                                <ul class="activity-sessions" aria-label="Scheduled sessions">${renderSessions(r.id, a)}</ul>
                            </li>`).join('')}
                        </ul>` : ''}
                    </div>`;
                });

                html += `
                <div style="background:#FAFAF6;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-top:1rem;">
                    <h3 style="margin-bottom:1.5rem;color:var(--primary);">Next Steps</h3>
                    <div style="display:flex;gap:1rem;flex-wrap:wrap;">
                        <button class="btn btn-secondary" onclick="saveParentChildContext(activeChild.id, assessmentId); window.location.href='/parent/results?childId=${activeChild.id}&assessmentId=${assessmentId}'">Back to Results</button>
                        <button class="btn btn-primary" onclick="saveParentChildContext(activeChild.id, assessmentId); window.location.href='/parent/appointments?childId=${activeChild.id}'">Appointments</button>
                        <button class="btn btn-secondary" onclick="saveParentChildContext(activeChild.id, null); window.location.href='/parent/screening'">Reassessment</button>
                    </div>
                </div>`;

                document.getElementById('recsContent').innerHTML = html;
            } catch (e) {
                document.getElementById('recsContent').innerHTML = `
                    <div style="text-align:center;padding:2rem;background:#FAFAF6;border-radius:15px;">
                        <p style="color:red;">Failed to load recommendations: ${escapeHtml(e.message)}</p>
                        <button class="btn btn-secondary" onclick="loadRecommendations()" style="margin-top:1rem;">Retry</button>
                    </div>`;
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            initNav();
            document.querySelectorAll('a.logout').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); logout(); }));
            loadRecommendations();
        });

        // Bfcache restore (browser Back/Forward) skips DOMContentLoaded, so a
        // pediatrician's rate change made elsewhere while this tab was cached
        // would otherwise keep showing the stale fee. Re-fetch on restore.
        window.addEventListener('pageshow', (event) => {
            if (!event.persisted) return;
            loadRecommendations();
        });
