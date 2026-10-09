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
        // Medium and low used to share the same green, and white text on the
        // light pink failed contrast. Each priority now has its own existing
        // status tone (kc-tokens.css), and every chip keeps its text label.
        const PRIORITY_COLORS = { high:'var(--status-attention-fg)', medium:'var(--status-caution-fg)', low:'var(--primary)' };
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
            setHref('.main-nav a[href="/parent/dashboard.html"]', '/parent/dashboard.html');
            setHref('.main-nav a[href="/parent/results.html"]', '/parent/results.html', true);
            setHref('.main-nav a[href="/parent/recommendations.html"]', '/parent/recommendations.html', true);
            setHref('.main-nav a[href="/parent/appointments.html"]', '/parent/appointments.html');
            setHref('.main-nav a[href="/parent/custom-questions.html"]', '/parent/custom-questions.html');
        }

        function switchChild(childId) {
            saveParentChildContext(childId, null);
            window.location.href = `/parent/recommendations.html?childId=${encodeURIComponent(childId)}`;
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
                    ${allChildren.map((c) => `<option value="${c.id}" ${c.id === activeChild?.id ? 'selected' : ''}>${c.firstName} ${c.lastName}</option>`).join('')}
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
            window.location.href = `/parent/appointments.html?childId=${encodeURIComponent(activeChild?.id || '')}`;
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
                                        ? `<button class="btn btn-secondary" onclick="window.location.href='/parent/appointments.html?childId=${encodeURIComponent(activeChild.id)}'">View Appointment</button>`
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

        async function loadRecommendations() {
            const assessmentId = await resolveContext();
            if (!assessmentId || !activeChild) {
                document.getElementById('recsContent').innerHTML = `
                    <div style="text-align:center;padding:3rem;background:#FAFAF6;border-radius:15px;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);">
                        <p style="font-size:1.1rem;font-weight:600;margin-bottom:1rem;">No recommendations yet</p>
                        <p style="color:var(--text-light);margin-bottom:1.5rem;">Complete an assessment first to receive personalized recommendations for this child.</p>
                        <button class="btn btn-primary" onclick="window.location.href='/parent/screening.html'">Start Assessment</button>
                    </div>`;
                return;
            }

            try {
                const [data, resultData] = await Promise.all([
                    apiFetch(`/recommendations/${assessmentId}`),
                    apiFetch(`/assessments/${assessmentId}/results`)
                ]);

                const recs = data.recommendations || [];
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
                            <span style="font-size:2.5rem;">⚠️</span>
                            <div style="flex:1;">
                                <h2 style="margin-bottom:0.5rem;">Schedule Professional Consultation</h2>
                                <p style="margin-bottom:0.9rem;opacity:0.95;">${escapeHtml(data.suggestionSummary || 'Based on the assessment results, we recommend scheduling a consultation with a pediatrician.')}</p>
                                ${Array.isArray(data.focusAreas) && data.focusAreas.length ? `<p style="margin:0 0 1.1rem;font-weight:600;">Focus areas: ${escapeHtml(data.focusAreas.join(', '))}</p>` : ''}
                                <button class="btn btn-primary" onclick="window.location.href='/parent/appointments.html?childId=${encodeURIComponent(activeChild.id)}'" style="background:#FAFAF6;color:var(--text-dark);font-weight:700;">Book Appointment Now</button>
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

                if (recs.length) html += renderPriorityLegend();

                recs.forEach((r) => {
                    const color = PRIORITY_COLORS[r.priority] || 'var(--primary)';
                    const label = PRIORITY_LABELS[r.priority] || '';
                    const icon = ICONS[r.skill] || '<img src="/icons/recommendations.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">';
                    const activities = Array.isArray(r.activities) ? r.activities : [];
                    html += `
                    <div style="background:#FAFAF6;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);border-left:4px solid ${color};margin-bottom:1.5rem;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:1rem;flex-wrap:wrap;">
                            <h3>${icon} ${r.skill.charAt(0).toUpperCase() + r.skill.slice(1)} Development</h3>
                            <span style="background:${color};color:#FAFAF6;padding:0.5rem 1rem;border-radius:20px;font-size:0.8rem;font-weight:600;">${label}</span>
                        </div>
                        ${areaScoreLine(r.skill, result)}
                        <p style="color:var(--text-light);margin-bottom:1rem;line-height:1.6;">${escapeHtml(r.suggestion)}</p>
                        ${activities.length ? `
                        <h4 style="font-weight:600;margin-bottom:0.5rem;">Recommended Activities:</h4>
                        <ul style="color:var(--text-light);padding-left:1.5rem;line-height:1.8;">
                            ${activities.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}
                        </ul>` : ''}
                    </div>`;
                });

                html += `
                <div style="background:#FAFAF6;border-radius:15px;padding:2rem;box-shadow:0 4px 15px rgba(61, 71, 56, 0.08);margin-top:1rem;">
                    <h3 style="margin-bottom:1.5rem;color:var(--primary);">Next Steps</h3>
                    <div style="display:flex;gap:1rem;flex-wrap:wrap;">
                        <button class="btn btn-secondary" onclick="saveParentChildContext(activeChild.id, assessmentId); window.location.href='/parent/results.html?childId=${activeChild.id}&assessmentId=${assessmentId}'">Back to Results</button>
                        <button class="btn btn-primary" onclick="saveParentChildContext(activeChild.id, assessmentId); window.location.href='/parent/appointments.html?childId=${activeChild.id}'">Appointments</button>
                        <button class="btn btn-secondary" onclick="saveParentChildContext(activeChild.id, null); window.location.href='/parent/screening.html'">Reassessment</button>
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
