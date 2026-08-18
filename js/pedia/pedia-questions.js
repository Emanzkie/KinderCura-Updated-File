// === Extracted from PEDIA\pedia-questions.html (script block 1) ===
// Main API base URL
        const API = window.location.origin + '/api';
        // Uses the current site origin so the same code works on localhost and when deployed.

        // Get saved token from localStorage
        function getToken() {
            return localStorage.getItem('kc_token');
        }

        // Get saved logged-in user object
        function getUser() {
            try {
                return JSON.parse(localStorage.getItem('kc_user'));
            } catch {
                return null;
            }
        }

        // Logout and return to main login page
        function doLogout() {
            // Clear every saved session key so logout always resets the page state
            ['kc_token', 'kc_user', 'kc_childId', 'kc_assessmentId', 'kc_viewChildId'].forEach(k => localStorage.removeItem(k));

            // Use the root login page path so logout works even inside /pedia/ pages
            window.location.href = '/login.html';
        }

        const currentUser = getUser();

        // Guard: only pediatrician can stay on this page
        if (!getToken() || !currentUser) {
            window.location.href = '/login.html';
        } else if (currentUser.role !== 'pediatrician') {
            if (currentUser.role === 'parent') window.location.href = '/parent/dashboard.html';
            else if (currentUser.role === 'admin') window.location.href = '/admin/admin-dashboard.html';
            else window.location.href = '/login.html';
        }

        // Show pedia name and profile picture in nav
        if (currentUser) {
            document.getElementById('navWelcome').textContent = `Welcome, Dr. ${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim();
            if (currentUser.profileIcon && currentUser.profileIcon.startsWith('/uploads/')) {
                document.getElementById('navProfilePic').src = currentUser.profileIcon;
            }
        }

        // Reusable fetch helper with token header
        async function apiFetch(endpoint, options = {}) {
            const res = await fetch(`${API}${endpoint}`, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${getToken()}`,
                    ...options.headers
                }
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                throw new Error(data.error || `Error ${res.status}`);
            }

            return data;
        }

        let allQuestions = []; // Legacy: standalone questions not in a set
        let allQuestionSets = []; // New: question sets with their questions grouped
        let patientList = [];
        let trackerAssignments = [];
        let editingId = null;
        let assigningQId = null;
        let questionBatch = []; // Stores questions added to batch before submission
        let optionCount = 0;

        // Small success/error message
        function flash(message, type = 'success') {
            const el = document.getElementById(type === 'success' ? 'successFlash' : 'errorFlash');
            el.textContent = message;
            el.style.display = 'block';
            setTimeout(() => {
                el.style.display = 'none';
            }, 3500);
        }


        // ─── Batch Question Management ───────────────────────────────
        function addToBatch() {
            const errEl = document.getElementById('modalError');
            errEl.style.display = 'none';
            const questionText = document.getElementById('qText').value.trim();
            const questionType = document.getElementById('qType').value;
            const domain = document.getElementById('qDomain').value;
            const ageMin = parseInt(document.getElementById('qAgeMin').value) || 0;
            const ageMax = parseInt(document.getElementById('qAgeMax').value) || 18;

            if (!questionText) { errEl.textContent = 'Question text is required.'; errEl.style.display = 'block'; return; }
            const options = questionType === 'multiple_choice' ? getOptions() : [];
            if (questionType === 'multiple_choice' && options.length < 2) { errEl.textContent = 'Add at least 2 options.'; errEl.style.display = 'block'; return; }

            // Add to batch
            questionBatch.push({ questionText, questionType, options, domain, ageMin, ageMax });

            // Clear form for next question
            document.getElementById('qText').value = '';
            document.getElementById('qType').value = 'yes_no';
            document.getElementById('qDomain').value = 'Other';
            document.getElementById('qAgeMin').value = '0';
            document.getElementById('qAgeMax').value = '18';
            clearOptions();
            onTypeChange();

            updateBatchPreview();
            flash(`Question added to batch. ${questionBatch.length} total.`, 'success');
        }

        function updateBatchPreview() {
            const previewSection = document.getElementById('batchPreviewSection');
            const previewList = document.getElementById('batchPreviewList');
            const batchCount = document.getElementById('batchCount');
            const questionsInBatch = document.getElementById('questionsInBatch');

            if (questionBatch.length === 0) {
                previewSection.style.display = 'none';
                questionsInBatch.textContent = '0 questions';
                return;
            }

            previewSection.style.display = 'block';
            batchCount.textContent = questionBatch.length;
            questionsInBatch.textContent = `${questionBatch.length} question${questionBatch.length !== 1 ? 's' : ''}`;

            previewList.innerHTML = questionBatch.map((q, i) => `
            <div style="background:var(--surface-muted);border:1px solid var(--border);border-radius:6px;padding:.6rem .8rem;display:flex;justify-content:space-between;align-items:center;">
            <div style="flex:1;">
                <p style="font-size:.8rem;font-weight:600;margin:0;color:var(--text-dark);">${i + 1}. ${q.questionText.substring(0, 60)}${q.questionText.length > 60 ? '…' : ''}</p>
                <p style="font-size:.7rem;color:var(--text-light);margin:.2rem 0 0;">Type: ${q.questionType.replace('_', ' ')} | Domain: ${q.domain}</p>
            </div>
            <button class="btn-danger" onclick="removeFromBatch(${i})" style="font-size:.7rem;padding:.2rem .5rem;">Remove</button>
            </div>
        `).join('');
        }

        function removeFromBatch(index) {
            questionBatch.splice(index, 1);
            updateBatchPreview();
        }

        async function submitAllQuestions() {
            if (questionBatch.length === 0) { flash('No questions in batch.', 'error'); return; }

            const btn = document.getElementById('addToBatchBtn');
            btn.textContent = 'Submitting…'; btn.disabled = true;

            try {
                const data = await apiFetch('/questions/bulk', { method: 'POST', body: JSON.stringify({ questions: questionBatch }) });

                let msg = `✅ ${data.createdCount} question${data.createdCount !== 1 ? 's' : ''} created successfully!`;
                if (data.errorCount > 0) msg += ` (${data.errorCount} had errors)`;

                flash(msg);
                questionBatch = [];
                updateBatchPreview();
                closeModal();
                await refreshAll();
            } catch (e) {
                flash(e.message, 'error');
            } finally {
                btn.textContent = '➕ Add to Batch'; btn.disabled = false;
            }
        }

        // Format dates for display in tracker/notifications
        function formatDateTime(value) {
            if (!value) return 'No date';
            const d = new Date(value);
            if (isNaN(d)) return String(value);

            return d.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
            });
        }

        // Check if assignment already has parent's answer
        function hasAnswer(item) {
            return item.answer !== null && item.answer !== undefined && String(item.answer).trim() !== '';
        }

        function normalizeQuestionTypeLabel(type) {
            if (type === 'yes_no') return 'Yes / No';
            if (type === 'multiple_choice') return 'Multiple Choice';
            if (type === 'short_answer') return 'Short Answer';
            return type || 'Question';
        }

        function getDomainClass(domain) {
            return {
                'Communication': 'domain-comm',
                'Social Skills': 'domain-social',
                'Cognitive': 'domain-cog',
                'Motor Skills': 'domain-motor'
            }[domain] || 'domain-other';
        }

        function getTypeClass(type) {
            return {
                yes_no: 'type-yes_no',
                multiple_choice: 'type-multiple_choice',
                short_answer: 'type-short_answer'
            }[type] || 'type-yes_no';
        }

        // Count assigned / pending / answered per question card
        function getQuestionStats(questionId) {
            const rows = trackerAssignments.filter(a => String(a.questionId) === String(questionId));
            const answered = rows.filter(hasAnswer).length;
            const pending = rows.length - answered;

            return {
                assigned: rows.length,
                pending,
                answered
            };
        }

        // Load pediatrician's own custom questions (grouped by QuestionSet)
        async function loadQuestionsOnly() {
            const data = await apiFetch('/questions');
            // New structure: questionSets array with grouped questions
            allQuestionSets = Array.isArray(data.questionSets) ? data.questionSets : [];
            // Legacy: standalone questions not in any set
            allQuestions = Array.isArray(data.questions) ? data.questions : [];

            // Calculate total questions across all sets and standalone
            let totalQuestions = 0;
            allQuestionSets.forEach(set => {
                totalQuestions += (set.questions ? set.questions.length : 0);
            });
            totalQuestions += allQuestions.length;

            document.getElementById('totalCount').textContent = totalQuestions;
            document.getElementById('activeCount').textContent = allQuestionSets.filter(s => s.isActive).length + allQuestions.filter(q => q.isActive).length;
        }

        // Load available patients from pedia appointments
        async function loadPatientsOnly() {
            const data = await apiFetch('/appointments/pedia');
            const appointments = Array.isArray(data.appointments) ? data.appointments : [];

            const seen = new Map();

            appointments.forEach(a => {
                const key = String(a.childId);
                if (!seen.has(key)) {
                    seen.set(key, {
                        childId: String(a.childId),
                        childName: `${a.childFirstName || ''} ${a.childLastName || ''}`.trim() || 'Child',
                        parentName: `${a.parentFirstName || ''} ${a.parentLastName || ''}`.trim() || 'Parent',
                        appointmentId: a.id || null
                    });
                }
            });

            patientList = Array.from(seen.values()).sort((a, b) => a.childName.localeCompare(b.childName));

            renderTrackerChildOptions();
        }

        // Fill the child filter dropdown for tracker
        function renderTrackerChildOptions() {
            const select = document.getElementById('trackerChildFilter');
            const currentValue = select.value || 'all';

            select.innerHTML = `
            <option value="all">All patients</option>
            ${patientList.map(p => `<option value="${p.childId}">${p.childName}</option>`).join('')}
        `;

            if ([...select.options].some(opt => opt.value === currentValue)) {
                select.value = currentValue;
            }
        }

        // Load assigned questions per patient, then keep only questions created by this pedia
        async function loadAssignmentTracker() {
            try {
                trackerAssignments = [];

                const ownQuestionIds = new Set([
                    ...allQuestions.map(q => String(q.id)),
                    ...allQuestionSets.flatMap(set => (Array.isArray(set.questions) ? set.questions : []).map(q => String(q.id)))
                ]);

                if (!patientList.length || !ownQuestionIds.size) {
                    updateTrackerSummary();
                    renderAssignmentTracker();
                    renderQuestions();
                    return;
                }

                const grouped = await Promise.all(
                    patientList.map(async (patient) => {
                        try {
                            const data = await apiFetch(`/questions/assigned/${patient.childId}`);
                            const rows = Array.isArray(data.assignments) ? data.assignments : [];

                            return rows
                                .filter(row => ownQuestionIds.has(String(row.questionId)))
                                .map(row => ({
                                    ...row,
                                    childId: patient.childId,
                                    childName: patient.childName,
                                    parentName: patient.parentName
                                }));
                        } catch {
                            return [];
                        }
                    })
                );

                trackerAssignments = grouped.flat();

                // Newest answered items first
                trackerAssignments.sort((a, b) => {
                    const aTime = a.answeredAt ? new Date(a.answeredAt).getTime() : 0;
                    const bTime = b.answeredAt ? new Date(b.answeredAt).getTime() : 0;
                    return bTime - aTime;
                });

                updateTrackerSummary();
                renderAssignmentTracker();
                renderQuestions();
            } catch (err) {
                document.getElementById('pendingAssignmentsList').innerHTML = `<div class="empty-small" style="color:var(--status-attention-fg);">${err.message}</div>`;
                document.getElementById('answeredAssignmentsList').innerHTML = `<div class="empty-small" style="color:var(--status-attention-fg);">${err.message}</div>`;
            }
        }

        // Update summary counters above the tracker
        function updateTrackerSummary() {
            const assigned = trackerAssignments.length;
            const answered = trackerAssignments.filter(hasAnswer).length;
            const pending = assigned - answered;

            document.getElementById('assignedTotal').textContent = assigned;
            document.getElementById('pendingTotal').textContent = pending;
            document.getElementById('answeredTotal').textContent = answered;
        }

        // ─── Question Set display helpers ────────────────────────────
        // Auto-created sets are all titled "Question Set - <date>", so several
        // sets made on the same day look identical. Only those get replaced.
        function isAutoSetTitle(title) {
            return !title || /^question set(\s*[-–—].*)?$/i.test(title.trim());
        }

        function formatSetTimestamp(value) {
            if (!value) return null;
            const d = new Date(value);
            if (isNaN(d.getTime())) return null;
            return d.toLocaleString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit'
            });
        }

        // index is the position in the sorted list, used only as a fallback.
        function setDisplayTitle(set, index) {
            if (!isAutoSetTitle(set.title)) return set.title;
            const stamp = formatSetTimestamp(set.createdAt);
            return stamp ? `Question Set — ${stamp}` : `Question Set #${index + 1}`;
        }

        function setQuestionCount(set) {
            if (typeof set.questionCount === 'number') return set.questionCount;
            return Array.isArray(set.questions) ? set.questions.length : 0;
        }

        // Client-side ordering of already-fetched sets. Returns a copy so the
        // source array (looked up by setId elsewhere) is never reordered.
        function sortQuestionSets(sets) {
            const mode = document.getElementById('setSortOrder')?.value || 'newest';
            const time = s => {
                const t = new Date(s.createdAt).getTime();
                return isNaN(t) ? 0 : t;
            };
            const sorted = sets.slice();

            if (mode === 'oldest') {
                sorted.sort((a, b) => time(a) - time(b));
            } else if (mode === 'most') {
                // Ties fall back to newest-first so the order stays stable.
                sorted.sort((a, b) => setQuestionCount(b) - setQuestionCount(a) || time(b) - time(a));
            } else {
                sorted.sort((a, b) => time(b) - time(a));
            }

            return sorted;
        }

        // Render question cards on the right side (shows Question Sets as grouped cards + standalone questions)
        function renderQuestions() {
            const container = document.getElementById('questionsList');

            const hasSets = allQuestionSets.length > 0;
            const hasStandalone = allQuestions.length > 0;

            if (!hasSets && !hasStandalone) {
                container.innerHTML = `
        <div style="text-align:center;padding:2rem;color:var(--text-light);">
        <img src="/icons/clipboard.png" alt="Clipboard Icon" style="width:52px;height:52px;object-fit:contain;display:block;margin:0 auto 1rem;">
        <p style="font-weight:600;">No questions yet</p>
        <p style="font-size:.85rem;">Click "New Question" to create your first assessment question.</p>
        </div>
        `;
                return;
            }

            let html = '';

            // Render Question Sets as grouped cards
            if (hasSets) {
                const sortedSets = sortQuestionSets(allQuestionSets);
                // Only cap the height once the list is long enough to run away.
                const listClass = sortedSets.length > 4 ? 'qset-list qset-list--scroll' : 'qset-list';
                let setsHtml = '';

                sortedSets.forEach((set, index) => {
                    const setQuestions = set.questions || [];
                    const totalAssigned = setQuestions.reduce((sum, q) => sum + getQuestionStats(q.id).assigned, 0);
                    const totalPending = setQuestions.reduce((sum, q) => sum + getQuestionStats(q.id).pending, 0);
                    const totalAnswered = setQuestions.reduce((sum, q) => sum + getQuestionStats(q.id).answered, 0);
                    const count = setQuestionCount(set);

                    setsHtml += `
                <div class="q-card qset-card" id="qset_${set.setId}">
                    <div class="qset-card-head">
                        <h4 class="qset-title">📋 ${esc(setDisplayTitle(set, index))}</h4>
                        <span class="qset-count-pill">${count} question${count !== 1 ? 's' : ''}</span>
                    </div>
                    <p class="qset-desc">${esc(set.description || 'No description')}</p>

                    <div class="question-stats">
                        <span class="mini-chip assigned">Assigned: ${totalAssigned}</span>
                        <span class="mini-chip pending">Pending: ${totalPending}</span>
                        <span class="mini-chip answered">Answered: ${totalAnswered}</span>
                    </div>

                    <div class="qset-questions">
                        <p class="qset-questions-label">Questions in this set:</p>
                        <div class="qset-question-list">
                        ${setQuestions.map(q => `
                            <div class="qset-question-row">
                                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.4rem;">
                                    <div style="flex:1;">
                                        <span class="q-type-badge ${getTypeClass(q.questionType)}">${normalizeQuestionTypeLabel(q.questionType)}</span>
                                        <span class="domain-badge ${getDomainClass(q.domain)}">${q.domain || 'Other'}</span>
                                        ${(q.ageMin > 0 || q.ageMax < 18) ? `<span style="font-size:.68rem;color:var(--text-light);margin-left:.3rem;">Age ${q.ageMin}–${q.ageMax}</span>` : ''}
                                        <p>${esc(q.questionText)}</p>
                                        ${q.questionType === 'multiple_choice' && Array.isArray(q.options) && q.options.length ? `
                                            <div class="options-list">
                                                ${q.options.map(o => `<span class="option-chip">${esc(o)}</span>`).join('')}
                                            </div>
                                        ` : ''}
                                    </div>
                                    ${!q.isActive ? `<span style="font-size:.7rem;color:var(--text-light);background:var(--bg-secondary);border-radius:8px;padding:.2rem .5rem;">Inactive</span>` : ''}
                                </div>
                            </div>
                        `).join('')}
                        </div>
                    </div>

                    <div class="q-actions">
                        <button class="btn-outline" onclick="openAssignSetModal('${set.setId}')" style="font-size:.78rem;padding:.3rem .7rem;"><img src="/icons/profile_icon.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Assign Set</button>
                        <button class="btn-outline" onclick="viewSetDetails('${set.setId}')" style="font-size:.78rem;padding:.3rem .7rem;">View Details</button>
                    </div>
                </div>
                    `;
                });

                html += `<div class="${listClass}">${setsHtml}</div>`;
            }

            // Render standalone questions (legacy support)
            if (hasStandalone) {
                if (hasSets) {
                    html += `<h4 style="margin:1.5rem 0 .8rem;color:var(--text-light);font-size:.9rem;">Standalone Questions</h4>`;
                }
                html += allQuestions.map(q => {
                    const stats = getQuestionStats(q.id);

                    return `
                <div class="q-card" id="qcard_${q.id}" style="${!q.isActive ? 'opacity:.55;' : ''}">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;">
                        <div style="flex:1;">
                            <span class="q-type-badge ${getTypeClass(q.questionType)}">${normalizeQuestionTypeLabel(q.questionType)}</span>
                            <span class="domain-badge ${getDomainClass(q.domain)}">${q.domain || 'Other'}</span>
                            ${(q.ageMin > 0 || q.ageMax < 18) ? `<span style="font-size:.68rem;color:var(--text-light);margin-left:.3rem;">Age ${q.ageMin}–${q.ageMax}</span>` : ''}

                            <p style="font-size:.9rem;font-weight:600;color:var(--text-dark);margin:.4rem 0;">${esc(q.questionText)}</p>

                            ${q.questionType === 'multiple_choice' && Array.isArray(q.options) && q.options.length ? `
                                <div class="options-list">
                                    ${q.options.map(o => `<span class="option-chip">${esc(o)}</span>`).join('')}
                                </div>
                            ` : ''}

                            <!-- Quick progress chips for each question -->
                            <div class="question-stats">
                                <span class="mini-chip assigned">Assigned: ${stats.assigned}</span>
                                <span class="mini-chip pending">Pending: ${stats.pending}</span>
                                <span class="mini-chip answered">Answered: ${stats.answered}</span>
                            </div>
                        </div>

                        ${!q.isActive ? `<span style="font-size:.7rem;color:var(--text-light);background:var(--bg-secondary);border-radius:8px;padding:.2rem .5rem;">Inactive</span>` : ''}
                    </div>

                    <div class="q-actions">
                        <button class="btn-outline" onclick="openEditModal(${q.id})" style="font-size:.78rem;padding:.3rem .7rem;"><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️ Edit</button>
                        <button class="btn-outline" onclick="openAssignModal(${q.id})" style="font-size:.78rem;padding:.3rem .7rem;"><img src="/icons/profile_icon.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Assign</button>
                        <button class="btn-outline" onclick="toggleActive(${q.id}, ${!q.isActive})" style="font-size:.78rem;padding:.3rem .7rem;">${q.isActive ? 'Deactivate' : 'Activate'}</button>
                        <button class="btn-danger" onclick="deleteQuestion(${q.id})"><img src="/icons/logs.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Delete</button>
                    </div>
                </div>
            `;
                }).join('');
            }

            container.innerHTML = html;
        }

        // Group assignments by questionSetId (for batch submissions)
        function groupAssignmentsBySetForTracker(assignments) {
            const grouped = new Map();
            const ungrouped = []; // Standalone questions without a set

            assignments.forEach(a => {
                if (a.questionSetId) {
                    const setId = a.questionSetId.toString ? a.questionSetId.toString() : String(a.questionSetId);
                    const childId = a.childId != null ? String(a.childId) : 'unknown-child';
                    const appointmentId = a.appointmentId != null ? String(a.appointmentId) : 'no-appointment';
                    const groupKey = `${setId}|${childId}|${appointmentId}`;

                    if (!grouped.has(groupKey)) {
                        grouped.set(groupKey, []);
                    }
                    grouped.get(groupKey).push(a);
                } else {
                    // Standalone question
                    ungrouped.push(a);
                }
            });

            return { grouped: new Map(grouped), ungrouped };
        }

        // Shared card chrome for the tracker columns. Markup only — every caller
        // still passes the same assignment data it always did.
        function trackerCardHeader(sample, answeredView) {
            return `
                <div class="tcard-head">
                    <div class="tcard-identity">
                        <p class="tcard-child">${esc(sample.childName || 'Child')}</p>
                        <p class="tcard-parent"><span class="tcard-parent-label">Parent:</span>${esc(sample.parentName || 'Parent')}</p>
                    </div>
                    <span class="tracker-badge tcard-status ${answeredView ? 'badge-answered' : 'tcard-status--pending badge-pending'}">
                        ${answeredView ? '✓ Answered' : '⏳ Pending'}
                    </span>
                </div>
            `;
        }

        // Small clock glyph for the card footer (inherits the muted text colour).
        function trackerClockIcon() {
            return `<svg class="tcard-foot-icon" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>`;
        }

        function trackerFooter(label, timestamp) {
            return `
                <div class="tcard-foot">
                    ${trackerClockIcon()}<span>${label}: ${formatDateTime(timestamp)}</span>
                </div>
            `;
        }

        // Compact empty state so a column with nothing in it stays short.
        function trackerEmptyState(message, hint) {
            return `
            <div class="tracker-empty">
                <svg class="tracker-empty-icon" viewBox="0 0 24 24" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path>
                    <polyline points="15 3 15 8 20 8"></polyline>
                    <line x1="9" y1="13" x2="15" y2="13"></line>
                    <line x1="9" y1="17" x2="13" y2="17"></line>
                </svg>
                <p class="tracker-empty-title">${message}</p>
                <p class="tracker-empty-hint">${hint}</p>
            </div>
            `;
        }

        // Render grouped set submission (all answers from one set together)
        function renderGroupedSetSubmission(setAssignments, answeredView) {
            const sample = setAssignments[0];
            const setId = sample.questionSetId ? sample.questionSetId.toString() : 'unknown';
            const setTitle = sample.setTitle || `Question Set (${setAssignments.length})`;
            const allAnswered = setAssignments.every(hasAnswer);

            return `
            <div class="tracker-item tracker-card ${answeredView ? 'tracker-card--answered' : 'tracker-card--pending'}">
                ${trackerCardHeader(sample, answeredView)}

                <div class="tcard-setline">
                    <img src="/icons/clipboard.png" alt="" aria-hidden="true" class="tcard-setline-icon">
                    <span class="tcard-set-title">${esc(setTitle)}</span>
                    <span class="tcard-set-count">${setAssignments.length} question${setAssignments.length !== 1 ? 's' : ''} in this set</span>
                </div>

                <div class="tcard-questions">
                    ${setAssignments.map((item, idx) => `
                        <div class="tcard-q">
                            <p class="tcard-q-text">Q${idx + 1}. ${esc(item.questionText || 'Question')}</p>
                            <p class="tcard-q-meta">${item.domain || 'Other'} • ${normalizeQuestionTypeLabel(item.questionType)}</p>

                            ${answeredView && item.answer ? `
                                <div class="tcard-answer">
                                    <p class="tcard-answer-label">Parent's answer</p>
                                    <p class="tcard-answer-value">${esc(item.answer)}</p>
                                </div>
                            ` : answeredView ? `
                                <p class="tcard-q-note">No answer provided</p>
                            ` : `
                                <p class="tcard-q-note tcard-q-note--pending">⏳ Waiting for parent answer</p>
                            `}
                        </div>
                    `).join('')}
                </div>

                ${answeredView && setAssignments.some(hasAnswer)
                    ? trackerFooter('Submitted at', setAssignments[setAssignments.length - 1].answeredAt)
                    : ''}
            </div>
            `;
        }

        // Render pending / answered tracker lists
        function renderAssignmentTracker() {
            const childFilter = document.getElementById('trackerChildFilter').value || 'all';
            const stateFilter = document.getElementById('trackerStatusFilter').value || 'all';

            let filtered = trackerAssignments.slice();

            if (childFilter !== 'all') {
                filtered = filtered.filter(a => String(a.childId) === String(childFilter));
            }

            if (stateFilter === 'pending') {
                filtered = filtered.filter(a => !hasAnswer(a));
            } else if (stateFilter === 'answered') {
                filtered = filtered.filter(a => hasAnswer(a));
            }

            const pending = filtered.filter(a => !hasAnswer(a));
            const answered = filtered.filter(a => hasAnswer(a));

            // Group by set, keeping ungrouped separate
            const pendingGrouped = groupAssignmentsBySetForTracker(pending);
            const answeredGrouped = groupAssignmentsBySetForTracker(answered);

            let pendingHtml = '';
            let pendingCards = 0;
            // First show grouped set submissions
            pendingGrouped.grouped.forEach(setAssignments => {
                if (setAssignments.length > 0) {
                    pendingHtml += renderGroupedSetSubmission(setAssignments, false);
                    pendingCards++;
                }
            });
            // Then show ungrouped/standalone questions
            pendingHtml += pendingGrouped.ungrouped.map(a => renderTrackerItem(a, false)).join('');
            pendingCards += pendingGrouped.ungrouped.length;

            let answeredHtml = '';
            let answeredCards = 0;
            // First show grouped set submissions
            answeredGrouped.grouped.forEach(setAssignments => {
                if (setAssignments.length > 0) {
                    answeredHtml += renderGroupedSetSubmission(setAssignments, true);
                    answeredCards++;
                }
            });
            // Then show ungrouped/standalone questions
            answeredHtml += answeredGrouped.ungrouped.map(a => renderTrackerItem(a, true)).join('');
            answeredCards += answeredGrouped.ungrouped.length;

            // Past 3 cards the column scrolls instead of stretching the page.
            const listWrap = (html, count) =>
                `<div class="tracker-list${count > 3 ? ' tracker-list--scroll' : ''}">${html}</div>`;

            document.getElementById('pendingAssignmentsList').innerHTML = pendingHtml
                ? listWrap(pendingHtml, pendingCards)
                : trackerEmptyState('No pending parent answers.', 'Assigned questions waiting on a parent will show up here.');

            document.getElementById('answeredAssignmentsList').innerHTML = answeredHtml
                ? listWrap(answeredHtml, answeredCards)
                : trackerEmptyState('No answered questions yet.', 'Submitted parent answers will appear here once they come in.');
        }

        // Render one tracker card (for individual/standalone questions)
        function renderTrackerItem(item, answeredView) {
            return `
            <div class="tracker-item tracker-card ${answeredView ? 'tracker-card--answered' : 'tracker-card--pending'}">
                ${trackerCardHeader(item, answeredView)}

                <div class="tcard-questions" style="margin-top:12px;">
                    <div class="tcard-q">
                        <p class="tcard-q-text">${esc(item.questionText || 'Question')}</p>
                        <p class="tcard-q-meta">${item.domain || 'Other'} • ${normalizeQuestionTypeLabel(item.questionType)}</p>

                        ${answeredView ? `
                            <div class="tcard-answer">
                                <p class="tcard-answer-label">Parent's answer</p>
                                <p class="tcard-answer-value">${esc(item.answer || 'No answer text')}</p>
                            </div>
                        ` : `
                            <p class="tcard-q-note tcard-q-note--pending">⏳ Waiting for the parent to submit an answer.</p>
                        `}
                    </div>
                </div>

                ${answeredView ? trackerFooter('Answered at', item.answeredAt) : ''}
            </div>
        `;
        }

        // Open create modal and reset fields
        function openCreateModal() {
            editingId = null;
            document.getElementById('modalTitle').textContent = 'New Question';
            document.getElementById('modalSub').textContent = 'Create custom assessment questions for your patients';
            document.getElementById('qText').value = '';
            document.getElementById('qType').value = 'yes_no';
            document.getElementById('qDomain').value = 'Other';
            document.getElementById('qAgeMin').value = '0';
            document.getElementById('qAgeMax').value = '18';
            document.getElementById('modalError').style.display = 'none';
            // Reset batch when opening new create modal
            questionBatch = [];
            updateBatchPreview();
            clearOptions();
            onTypeChange();
            showQuestionModal();
        }

        // Open edit modal and fill current question values
        function openEditModal(id) {
            const q = allQuestions.find(x => String(x.id) === String(id));
            if (!q) return;

            editingId = id;
            document.getElementById('modalTitle').textContent = 'Edit Question';
            document.getElementById('modalSub').textContent = 'Update your assessment question';
            document.getElementById('qText').value = q.questionText || '';
            document.getElementById('qType').value = q.questionType || 'yes_no';
            document.getElementById('qDomain').value = q.domain || 'Communication';
            document.getElementById('qAgeMin').value = q.ageMin ?? 0;
            document.getElementById('qAgeMax').value = q.ageMax ?? 18;
            document.getElementById('modalError').style.display = 'none';
            // Hide batch UI when editing
            document.getElementById('multiQuestionHeader').style.display = 'none';
            document.getElementById('addToBatchBtn').style.display = 'none';
            document.getElementById('batchPreviewSection').style.display = 'none';

            clearOptions();
            onTypeChange();

            if (q.questionType === 'multiple_choice' && Array.isArray(q.options) && q.options.length) {
                q.options.forEach(o => addOption(o));
            }

            showQuestionModal();
        }

        // Reveal the modal overlay, lock background scroll, and focus the first field.
        function showQuestionModal() {
            document.getElementById('questionModal').style.display = 'flex';
            document.body.classList.add('modal-open');
            const qText = document.getElementById('qText');
            if (qText) qText.focus();
        }

        function closeModal() {
            // Restore batch UI visibility
            document.getElementById('multiQuestionHeader').style.display = 'flex';
            document.getElementById('addToBatchBtn').style.display = 'inline-block';
            document.getElementById('batchPreviewSection').style.display = questionBatch.length > 0 ? 'block' : 'none';
            document.getElementById('questionModal').style.display = 'none';
            document.body.classList.remove('modal-open');

            // Reset the form back to defaults, but keep whatever is staged in the
            // batch so a reopened modal still shows the pending questions.
            if (questionBatch.length === 0) {
                document.getElementById('qText').value = '';
                document.getElementById('qType').value = 'yes_no';
                document.getElementById('qDomain').value = 'Other';
                document.getElementById('qAgeMin').value = '0';
                document.getElementById('qAgeMax').value = '18';
                document.getElementById('modalError').style.display = 'none';
                clearOptions();
                onTypeChange();
            }
        }

        // Close on backdrop click (but not on clicks inside the card).
        document.getElementById('questionModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeModal();
        });

        // Close on Escape while the question modal is open.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const modal = document.getElementById('questionModal');
            if (modal && modal.style.display !== 'none') closeModal();
        });

        // Show / hide option fields depending on question type
        function onTypeChange() {
            const type = document.getElementById('qType').value;
            const section = document.getElementById('optionsSection');

            section.style.display = type === 'multiple_choice' ? 'block' : 'none';

            if (type === 'multiple_choice' && document.getElementById('optionsContainer').children.length === 0) {
                addOption();
                addOption();
            }
        }

        function clearOptions() {
            document.getElementById('optionsContainer').innerHTML = '';
            optionCount = 0;
        }

        // Add one option input row
        function addOption(value = '') {
            optionCount++;
            const inputId = `opt_${optionCount}`;

            const div = document.createElement('div');
            div.className = 'options-input-row';
            div.innerHTML = `
            <input type="text" id="${inputId}" value="${value}" placeholder="Option ${optionCount}">
            <button type="button" class="option-remove-btn" onclick="this.parentElement.remove()">&#215;</button>
        `;

            document.getElementById('optionsContainer').appendChild(div);
        }

        // Collect option values from UI
        function getOptions() {
            return Array.from(document.querySelectorAll('#optionsContainer input'))
                .map(i => i.value.trim())
                .filter(Boolean);
        }

        // Save new question or update existing one
        async function saveQuestion() {
            const btn = document.getElementById('saveQBtn');
            const errEl = document.getElementById('modalError');

            errEl.style.display = 'none';

            const questionText = document.getElementById('qText').value.trim();
            const questionType = document.getElementById('qType').value;
            const domain = document.getElementById('qDomain').value;
            const ageMin = parseInt(document.getElementById('qAgeMin').value) || 0;
            const ageMax = parseInt(document.getElementById('qAgeMax').value) || 18;
            const options = questionType === 'multiple_choice' ? getOptions() : [];

            if (!questionText) {
                errEl.textContent = 'Question text is required.';
                errEl.style.display = 'block';
                return;
            }

            if (questionType === 'multiple_choice' && options.length < 2) {
                errEl.textContent = 'Add at least 2 options.';
                errEl.style.display = 'block';
                return;
            }

            btn.textContent = 'Saving...';
            btn.disabled = true;

            try {
                const payload = { questionText, questionType, options, domain, ageMin, ageMax };

                if (editingId) {
                    await apiFetch(`/questions/${editingId}`, {
                        method: 'PUT',
                        body: JSON.stringify(payload)
                    });
                    flash('Question updated successfully.');
                } else {
                    await apiFetch('/questions', {
                        method: 'POST',
                        body: JSON.stringify(payload)
                    });
                    flash('Question created successfully.');
                }

                closeModal();
                await refreshAll();
            } catch (e) {
                errEl.textContent = e.message;
                errEl.style.display = 'block';
            } finally {
                btn.textContent = 'Save Question';
                btn.disabled = false;
            }
        }

        // Activate or deactivate a question
        async function toggleActive(id, active) {
            try {
                await apiFetch(`/questions/${id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ isActive: active })
                });

                flash(`Question ${active ? 'activated' : 'deactivated'} successfully.`);
                await refreshAll();
            } catch (e) {
                flash(e.message, 'error');
            }
        }

        // Delete a question permanently
        async function deleteQuestion(id) {
            if (!confirm('Delete this question? This cannot be undone.')) return;

            try {
                await apiFetch(`/questions/${id}`, { method: 'DELETE' });
                flash('Question deleted.');
                await refreshAll();
            } catch (e) {
                flash(e.message, 'error');
            }
        }

        // Open assign modal for a specific question
        async function openAssignModal(qId) {
            assigningQId = qId;

            const q = allQuestions.find(x => String(x.id) === String(qId));
            document.getElementById('assignModalSub').textContent = `"${q ? q.questionText.substring(0, 60) + (q.questionText.length > 60 ? '…' : '') : 'Question'}"`;

            document.getElementById('assignModal').style.display = 'flex';
            document.getElementById('assignPatientList').innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-light);">Loading patients…</div>';

            if (!patientList.length) {
                await loadPatientsOnly();
            }

            renderAssignList();
        }

        // Open assign modal for an entire Question Set
        let assigningSetId = null;
        async function openAssignSetModal(setId) {
            assigningSetId = setId;

            const set = allQuestionSets.find(s => String(s.setId) === String(setId));
            const qCount = set ? set.questions.length : 0;
            document.getElementById('assignModalSub').textContent = `Set: "${set ? set.title : 'Question Set'}" (${qCount} question${qCount !== 1 ? 's' : ''})`;

            document.getElementById('assignModal').style.display = 'flex';
            document.getElementById('assignPatientList').innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-light);">Loading patients…</div>';

            if (!patientList.length) {
                await loadPatientsOnly();
            }

            renderAssignSetList();
        }

        // Render patient list inside assign modal for Question Set assignment
        function renderAssignSetList() {
            const list = document.getElementById('assignPatientList');

            if (!patientList.length) {
                list.innerHTML = '<p style="color:var(--text-light);text-align:center;padding:1rem;">No patients yet. Approve some appointments first.</p>';
                return;
            }

            list.innerHTML = patientList.map(p => `
            <div class="patient-row">
                <div>
                    <p style="font-weight:600;font-size:.88rem;margin:0;"><img src="/icons/profile_icon.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${p.childName}</p>
                    <p style="font-size:.78rem;color:var(--text-light);margin:.1rem 0 0;"><img src="/icons/account.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${p.parentName}</p>
                </div>
                <button class="btn-outline" style="font-size:.78rem;padding:.3rem .7rem;" onclick="assignSetToPatient('${p.childId}', ${p.appointmentId || 'null'})">Assign Set</button>
            </div>
        `).join('');
        }

        // Filter patients by assessment category and threshold
        async function filterPatientsByAssessment() {
            const category = document.getElementById('filterCategory')?.value || '';
            const threshold = document.getElementById('filterThreshold')?.value || '';
            const list = document.getElementById('assignPatientList');

            if (!category && !threshold) {
                await loadPatientsOnly();
                if (typeof renderAssignList === 'function') renderAssignList();
                return;
            }

            list.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-light);">Filtering patients...</div>';

            try {
                const params = new URLSearchParams();
                if (category) params.append('category', category);
                if (threshold) params.append('threshold', threshold);

                const response = await apiFetch(`/assessments/patients?${params.toString()}`);
                const filteredPatients = response.patients || [];

                if (!filteredPatients.length) {
                    list.innerHTML = '<p style="color:var(--text-light);text-align:center;padding:1rem;">No patients match this filter.<br><small>Try selecting different criteria.</small></p>';
                    return;
                }

                const categoryLabels = { motor: 'Motor Skills', communication: 'Communication', social: 'Social Skills', cognitive: 'Cognitive' };
                const statusColors = window.KCScoring.STATUS_COLORS;

                patientList = filteredPatients.map(p => ({
                    childId: p.childId,
                    childName: `${p.childFirstName} ${p.childLastName}`.trim(),
                    parentName: `${p.parentFirstName} ${p.parentLastName}`.trim(),
                    appointmentId: p.appointmentId,
                    scores: {
                        motor: p.motorScore,
                        communication: p.communicationScore,
                        social: p.socialScore,
                        cognitive: p.cognitiveScore
                    },
                    statuses: {
                        motor: p.motorStatus,
                        communication: p.communicationStatus,
                        social: p.socialStatus,
                        cognitive: p.cognitiveStatus
                    }
                }));

                if (typeof renderAssignList === 'function') renderAssignList();
            } catch (err) {
                console.error('Filter error:', err);
                list.innerHTML = '<p style="color:var(--status-attention-fg);text-align:center;padding:1rem;">Error filtering patients.</p>';
            }
        }

        // Clear assessment filters and show all patients
        async function clearAssessmentFilters() {
            document.getElementById('filterCategory').value = '';
            document.getElementById('filterThreshold').value = '';
            await loadPatientsOnly();
            if (typeof renderAssignList === 'function') renderAssignList();
        }

        // Assign selected Question Set to one child (all questions in the set)
        async function assignSetToPatient(childId, appointmentId) {
            try {
                await apiFetch(`/questions/set/${assigningSetId}/assign`, {
                    method: 'POST',
                    body: JSON.stringify({
                        childId,
                        appointmentId: appointmentId || undefined
                    })
                });

                flash('Question set assigned! Parent has been notified.');
                closeAssignModal();
                await loadAssignmentTracker();
            } catch (e) {
                flash(e.message, 'error');
            }
        }

        // View details of a Question Set in a proper modal (now async to fetch answers)
        async function viewSetDetails(setId) {
            const set = allQuestionSets.find(s => String(s.setId) === String(setId));
            if (!set) {
                flash('Question Set not found.', 'error');
                return;
            }

            currentViewingSetId = setId;
            const isDraft = set.status === 'draft';
            const questions = Array.isArray(set.questions) ? set.questions : [];

            // Fetch assignments for this question set to show answered questions
            let answeredAssignments = [];
            try {
                // Build a filter for assignments that belong to this question set
                const matchingAssignments = trackerAssignments.filter(a => {
                    const assignSetId = a.questionSetId ? String(a.questionSetId) : null;
                    return assignSetId === String(setId) && a.answer;
                });
                answeredAssignments = matchingAssignments;
            } catch (e) {
                console.warn('Could not fetch assignments for set:', e);
            }

            let html = `
                <div style="margin-bottom:1.5rem;">
                    <div style="display:flex;justify-content:space-between;align-items:start;gap:1rem;margin-bottom:1rem;">
                        <div style="flex:1;">
                            <h2 style="margin:0 0 .5rem;font-size:1.3rem;color:var(--primary);">${esc(set.title)}</h2>
                            <p style="margin:0;color:var(--text-light);font-size:.9rem;line-height:1.5;">${esc(set.description || 'No description provided')}</p>
                        </div>
                        <div style="text-align:right;">
                            <span style="display:inline-block;padding:.3rem .8rem;border-radius:999px;font-size:.8rem;font-weight:600;${
                                isDraft ? 'background:var(--status-info-bg);color:var(--status-info-fg);' : 
                                set.status === 'answered' ? 'background:var(--status-positive-bg);color:var(--status-positive-fg);' :
                                'background:var(--status-caution-bg);color:#92400e;'
                            }">${
                                isDraft ? '📝 Draft' : 
                                set.status === 'answered' ? '✓ Answered' :
                                '✓ Assigned'
                            }</span>
                        </div>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-bottom:1.5rem;">
                        <div style="background:var(--bg-primary);border-radius:8px;padding:1rem;">
                            <p style="font-size:.78rem;color:var(--text-light);margin:0 0 .3rem;">Total Questions</p>
                            <p style="font-size:1.6rem;font-weight:700;color:var(--primary);margin:0;">${set.questionCount || questions.length}</p>
                        </div>
                        <div style="background:var(--bg-primary);border-radius:8px;padding:1rem;">
                            <p style="font-size:.78rem;color:var(--text-light);margin:0 0 .3rem;">Answered</p>
                            <p style="font-size:1.6rem;font-weight:700;color:var(--status-positive-fg);margin:0;">${answeredAssignments.length}</p>
                        </div>
                        <div style="background:var(--bg-primary);border-radius:8px;padding:1rem;">
                            <p style="font-size:.78rem;color:var(--text-light);margin:0 0 .3rem;">Created</p>
                            <p style="font-size:.9rem;font-weight:600;color:var(--text-dark);margin:0;">${new Date(set.createdAt).toLocaleDateString()}</p>
                        </div>
                    </div>
                </div>

                <div style="border-top:1px solid var(--border);padding-top:1.5rem;">
                    <h3 style="margin:0 0 1rem;font-size:.95rem;font-weight:600;color:var(--text-dark);">Questions in this set</h3>
                    ${questions.length === 0 ? `
                        <p style="color:var(--text-light);text-align:center;padding:1.5rem;background:var(--bg-primary);border-radius:8px;margin:0;">No questions in this set yet.</p>
                    ` : `
                        <div style="display:flex;flex-direction:column;gap:.8rem;">
                            ${questions.map((q, i) => `
                                <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:1rem;">
                                    <div style="display:flex;justify-content:space-between;align-items:start;gap:1rem;">
                                        <div style="flex:1;">
                                            <div style="margin-bottom:.5rem;">
                                                <span class="q-type-badge ${getTypeClass(q.questionType)}" style="font-size:.75rem;">${normalizeQuestionTypeLabel(q.questionType)}</span>
                                                <span class="domain-badge ${getDomainClass(q.domain)}" style="font-size:.75rem;margin-left:.3rem;">${q.domain || 'Other'}</span>
                                                ${(q.ageMin > 0 || q.ageMax < 18) ? `<span style="font-size:.7rem;color:var(--text-light);margin-left:.3rem;">Age ${q.ageMin}–${q.ageMax}</span>` : ''}
                                            </div>
                                            <p style="margin:.4rem 0;font-weight:600;color:var(--text-dark);">${i + 1}. ${esc(q.questionText)}</p>
                                            ${q.questionType === 'multiple_choice' && Array.isArray(q.options) && q.options.length ? `
                                                <div style="margin-top:.5rem;">
                                                    ${q.options.map(o => `<span style="display:inline-block;background:var(--surface-muted);padding:.25rem .5rem;border-radius:4px;font-size:.8rem;margin-right:.3rem;margin-bottom:.2rem;">${esc(o)}</span>`).join('')}
                                                </div>
                                            ` : ''}
                                        </div>
                                        ${isDraft ? `
                                            <div style="display:flex;gap:.4rem;">
                                                <button class="btn-outline" onclick="editQuestionInSet('${set.setId}', '${q.id}')" style="font-size:.75rem;padding:.25rem .5rem;white-space:nowrap;">Edit</button>
                                                <button class="btn-danger" onclick="removeQuestionFromSet('${set.setId}', '${q.id}')" style="font-size:.75rem;padding:.25rem .5rem;white-space:nowrap;">Remove</button>
                                            </div>
                                        ` : ''}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `}
                </div>

                ${answeredAssignments.length > 0 ? `
                    <div style="border-top:1px solid var(--border);padding-top:1.5rem;margin-top:1.5rem;">
                        <h3 style="margin:0 0 1rem;font-size:.95rem;font-weight:600;color:var(--status-positive-fg);">📋 Parent's Answers</h3>
                        <div style="display:flex;flex-direction:column;gap:.8rem;">
                            ${answeredAssignments.map(a => `
                                <div style="background:var(--status-positive-bg);border:1px solid #86efac;border-radius:8px;padding:1rem;">
                                    <p style="margin:0 0 .5rem;font-size:.85rem;color:var(--text-light);">Question: ${esc(a.questionText || 'Question')}</p>
                                    <div style="background:white;border:1px solid #d4edda;border-radius:6px;padding:.75rem;">
                                        <p style="margin:0 0 .3rem;font-size:.78rem;color:var(--text-light);">Parent's Answer</p>
                                        <p style="margin:0;font-weight:600;color:var(--text-dark);">${esc(a.answer || 'No answer provided')}</p>
                                    </div>
                                    <p style="margin:.5rem 0 0;font-size:.75rem;color:var(--text-light);">Answered: ${formatDateTime(a.answeredAt)}</p>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            `;

            document.getElementById('viewSetContent').innerHTML = html;
            document.getElementById('editSetBtn').style.display = isDraft ? 'block' : 'none';
            document.getElementById('assignSetFromViewBtn').style.display = isDraft ? 'block' : 'none';
            document.getElementById('viewSetModal').style.display = 'flex';
        }

        function closeViewSetModal() {
            document.getElementById('viewSetModal').style.display = 'none';
            currentViewingSetId = null;
        }

        function editQuestionSet() {
            // TODO: Open modal to edit set title and description
            flash('Edit set functionality coming soon.', 'info');
        }

        function assignSetFromView() {
            const setId = currentViewingSetId;
            if (!setId) return;
            closeViewSetModal();
            openAssignSetModal(setId);
        }

        function editQuestionInSet(setId, questionId) {
            // TODO: Open modal to edit the question
            flash('Edit question functionality coming soon.', 'info');
        }

        async function removeQuestionFromSet(setId, questionId) {
            if (!confirm('Remove this question from the set?')) return;

            try {
                const q = allQuestionSets.find(s => String(s.setId) === String(setId))?.questions?.find(q => String(q.id) === String(questionId));
                if (!q) return;

                // TODO: Call API endpoint to delete/remove question
                // For now, just show a message
                flash('Remove question functionality coming soon.', 'info');
            } catch (e) {
                flash(e.message, 'error');
            }
        }

        let currentViewingSetId = null;

        // Selected patients tracking
        let selectedPatients = new Set();

        // Render patient list inside assign modal with checkboxes
        function renderAssignList() {
            const list = document.getElementById('assignPatientList');

            if (!patientList.length) {
                list.innerHTML = '<p style="color:var(--text-light);text-align:center;padding:1rem;">No patients yet. Approve some appointments first.</p>';
                return;
            }

            const statusColors = window.KCScoring.STATUS_COLORS;

            list.innerHTML = patientList.map(p => {
                const hasScores = p.scores && Object.values(p.scores).some(s => s != null);
                const isSelected = selectedPatients.has(p.childId);
                const scoresHtml = hasScores ? `
                    <div style="display:flex;gap:0.5rem;margin-top:0.4rem;flex-wrap:wrap;">
                        ${p.scores.motor != null ? `<span style="font-size:0.7rem;padding:2px 6px;background:${statusColors[p.statuses?.motor] || '#ddd'};color:white;border-radius:4px;">M:${p.scores.motor}%</span>` : ''}
                        ${p.scores.communication != null ? `<span style="font-size:0.7rem;padding:2px 6px;background:${statusColors[p.statuses?.communication] || '#ddd'};color:white;border-radius:4px;">C:${p.scores.communication}%</span>` : ''}
                        ${p.scores.social != null ? `<span style="font-size:0.7rem;padding:2px 6px;background:${statusColors[p.statuses?.social] || '#ddd'};color:white;border-radius:4px;">S:${p.scores.social}%</span>` : ''}
                        ${p.scores.cognitive != null ? `<span style="font-size:0.7rem;padding:2px 6px;background:${statusColors[p.statuses?.cognitive] || '#ddd'};color:white;border-radius:4px;">Co:${p.scores.cognitive}%</span>` : ''}
                    </div>
                ` : '';

                return `
            <div class="patient-row" style="${isSelected ? 'background:var(--status-positive-bg);border-left:3px solid #27ae60;' : ''}">
                <label style="display:flex;align-items:flex-start;gap:0.75rem;cursor:pointer;flex:1;">
                    <input type="checkbox" class="patient-checkbox" value="${p.childId}" ${isSelected ? 'checked' : ''} onchange="togglePatientSelection('${p.childId}')" style="margin-top:0.3rem;">
                    <div>
                        <p style="font-weight:600;font-size:.88rem;margin:0;"><img src="/icons/profile_icon.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${p.childName}</p>
                        <p style="font-size:.78rem;color:var(--text-light);margin:.1rem 0 0;"><img src="/icons/account.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${p.parentName}</p>
                        ${scoresHtml}
                    </div>
                </label>
                <button class="btn-outline" style="font-size:.78rem;padding:.3rem .7rem;flex-shrink:0;" onclick="assignToPatient('${p.childId}', ${p.appointmentId || 'null'})">Assign</button>
            </div>
        `}).join('');

            updateSelectedCount();
        }

        // Toggle individual patient selection
        function togglePatientSelection(childId) {
            if (selectedPatients.has(childId)) {
                selectedPatients.delete(childId);
            } else {
                selectedPatients.add(childId);
            }
            renderAssignList();
        }

        // Toggle select all visible patients
        function toggleSelectAllPatients() {
            const selectAll = document.getElementById('selectAllPatients');
            if (selectAll.checked) {
                patientList.forEach(p => selectedPatients.add(p.childId));
            } else {
                patientList.forEach(p => selectedPatients.delete(p.childId));
            }
            renderAssignList();
        }

        // Update selected count display
        function updateSelectedCount() {
            const count = selectedPatients.size;
            document.getElementById('selectedCount').textContent = count;
            const btn = document.getElementById('assignSelectedBtn');
            if (btn) {
                btn.disabled = count === 0;
                btn.style.opacity = count === 0 ? '0.5' : '1';
            }
        }

        // Assign to selected patients (bulk)
        async function assignToSelectedPatients() {
            if (selectedPatients.size === 0) return;

            const selectedArray = Array.from(selectedPatients);
            let successCount = 0;
            let failCount = 0;

            for (const childId of selectedArray) {
                const patient = patientList.find(p => p.childId === childId);
                if (!patient) continue;

                try {
                    await apiFetch(`/questions/${assigningQId}/assign`, {
                        method: 'POST',
                        body: JSON.stringify({
                            childId,
                            appointmentId: patient.appointmentId || undefined
                        })
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                }
            }

            if (failCount === 0) {
                flash(`Question assigned to ${successCount} patient(s)! Parents have been notified.`);
            } else {
                flash(`Assigned to ${successCount} patient(s). ${failCount} failed.`, 'error');
            }

            selectedPatients.clear();
            closeAssignModal();
            await loadAssignmentTracker();
        }

        // Assign selected question to one child
        async function assignToPatient(childId, appointmentId) {
            try {
                await apiFetch(`/questions/${assigningQId}/assign`, {
                    method: 'POST',
                    body: JSON.stringify({
                        childId,
                        appointmentId: appointmentId || undefined
                    })
                });

                flash('Question assigned! Parent has been notified.');
                closeAssignModal();
                await loadAssignmentTracker();
            } catch (e) {
                flash(e.message, 'error');
            }
        }

        function closeAssignModal() {
            document.getElementById('assignModal').style.display = 'none';
            assigningQId = null;
            assigningSetId = null;
            selectedPatients.clear();
            document.getElementById('selectAllPatients').checked = false;
        }

        // Refresh everything on the page
        async function refreshAll() {
            try {
                document.getElementById('questionsList').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-light);">Refreshing questions…</div>';
                document.getElementById('pendingAssignmentsList').innerHTML = '<div class="empty-small">Refreshing tracker…</div>';
                document.getElementById('answeredAssignmentsList').innerHTML = '<div class="empty-small">Refreshing tracker…</div>';

                await loadQuestionsOnly();
                await loadPatientsOnly();
                await loadAssignmentTracker();
                renderQuestions();
            } catch (err) {
                flash(err.message, 'error');
            }
        }



        // Open / close profile dropdown

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

        // Alias for esc to match existing usage in templates
        const esc = escapeHtml;

        // Decide where a notification should open based on the current user role
        function notificationDestination(n) {
            let role = '';
            try {
                role = String((JSON.parse(localStorage.getItem('kc_user')) || {}).role || '').toLowerCase();
            } catch { }

            const title = String(n?.title || '').toLowerCase();
            const type = String(n?.type || '').toLowerCase();
            const msg = String(n?.message || '').toLowerCase();

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
            } catch { }
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

        // Mark read first, then send the user to the related page (with optional relatedId as query param)
        async function goToNotificationTarget(id, target, relatedId) {
            await markNotificationRead(id);
            const url = relatedId ? `${target}?setId=${encodeURIComponent(relatedId)}` : target;
            window.location.href = url;
        }

        // Shared notification modal renderer used by both parent and pediatrician pages
        async function openNotifications() {
            const modal = document.getElementById('notificationsModal');
            const listEl = modal ? modal.querySelector('.notifications-list') : null;
            if (!modal || !listEl) return;

            modal.style.display = 'flex';
            listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Loading...</p>';

            try {
                const data = await apiFetch('/notifications');
                const notifications = Array.isArray(data.notifications) ? data.notifications : [];

                if (!notifications.length) {
                    listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1.5rem;">No notifications yet.</p>';
                    return;
                }

                const hasUnread = notifications.some(n => !n.isRead);
                const tools = `
            <div style="display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--border);background:white;position:sticky;top:0;z-index:1;">
                ${hasUnread ? '<button onclick="markAllNotificationsRead()" style="border:1px solid var(--border);background:white;color:var(--primary);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Mark all read</button>' : ''}
                <button onclick="clearAllNotifications()" style="border:1px solid #e6b0b0;background:white;color:var(--status-attention-fg);padding:.45rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">Clear all</button>
            </div>`;

                const items = notifications.map((n) => {
                    const dest = notificationDestination(n);
                    const unreadStyle = n.isRead ? '' : 'background:var(--surface-tint);border-left:3px solid var(--primary);';
                    const relId = n.relatedId ? `, '${n.relatedId}'` : '';
                    const click = dest
                        ? `goToNotificationTarget(${n.id}, '${dest}'${relId})`
                        : `markNotificationRead(${n.id})`;

                    return `
                <div class="notification-item" style="display:flex;gap:.75rem;align-items:flex-start;justify-content:space-between;padding:1rem;border-bottom:1px solid var(--border);${unreadStyle}">
                    <div onclick="${click}" style="flex:1;cursor:pointer;min-width:0;">
                        <p style="font-weight:${n.isRead ? '400' : '700'};font-size:.9rem;margin:0 0 .2rem;color:var(--text-dark);">${escapeHtml(n.title || '')}</p>
                        <p style="font-size:.82rem;color:var(--text-dark);margin:0 0 .25rem;line-height:1.45;">${escapeHtml(n.message || '')}</p>
                        <p style="font-size:.75rem;color:var(--text-light);margin:0;">${formatDateTime(n.createdAt)}</p>
                        ${dest ? '<p style="font-size:.72rem;color:var(--primary);margin:.35rem 0 0;">Open related page →</p>' : ''}
                    </div>
                    <button onclick="event.stopPropagation();deleteNotification(${n.id})" title="Remove notification" style="border:none;background:none;color:var(--status-attention-fg);cursor:pointer;font-size:1rem;line-height:1;padding:.15rem .25rem;">&#215;</button>
                </div>`;
                }).join('');

                listEl.innerHTML = tools + items;
            } catch {
                listEl.innerHTML = '<p style="text-align:center;color:var(--text-light);padding:1rem;">Could not load notifications.</p>';
            }
        }

        function closeNotifications() {
            const modal = document.getElementById('notificationsModal');
            if (modal) modal.style.display = 'none';
        }


        function toggleProfileMenu() {
            const menu = document.getElementById('profileMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }

        // Close profile dropdown when clicking outside
        document.addEventListener('click', (e) => {
            // Keep the dropdown open when clicking inside the menu itself
            if (!e.target.closest('.profile-btn') && !e.target.closest('#profileMenu')) {
                const menu = document.getElementById('profileMenu');
                if (menu) menu.style.display = 'none';
            }
        });

        // Initial page load
        // Rebuild the status filter from constants/scoring.js so the dropdown can
        // never drift from the bands the server actually filters on. The static
        // <option> list in the HTML is only the no-JS fallback.
        function syncThresholdFilterOptions() {
            const sel = document.getElementById('filterThreshold');
            if (!sel || !window.KCScoring) return;
            const current = sel.value;
            sel.innerHTML = '<option value="">All Statuses</option>'
                + window.KCScoring.filterOptions()
                    .map(o => `<option value="${o.value}">${o.label}</option>`)
                    .join('');
            sel.value = current;
        }

        document.addEventListener('DOMContentLoaded', async () => {
            syncThresholdFilterOptions();
            await refreshAll();
            await loadNotificationCount();
            
            // Check if this page was opened from a notification with a specific question set
            const params = new URLSearchParams(window.location.search);
            const setIdFromNotification = params.get('setId');
            if (setIdFromNotification) {
                // Wait a moment for data to load, then auto-open the question set details
                setTimeout(() => {
                    viewSetDetails(setIdFromNotification);
                }, 500);
                // Clean up the URL so it doesn't stay in the browser history
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        });
