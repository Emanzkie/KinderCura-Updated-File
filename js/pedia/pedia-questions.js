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
            const age = readAgeRange();

            if (!questionText) { errEl.textContent = 'Question text is required.'; errEl.style.display = 'block'; return; }
            if (age.error) { errEl.textContent = age.error; errEl.style.display = 'block'; return; }
            const options = questionType === 'multiple_choice' ? getOptions() : [];
            if (questionType === 'multiple_choice' && options.length < 2) { errEl.textContent = 'Add at least 2 options.'; errEl.style.display = 'block'; return; }

            // Add to batch
            questionBatch.push({ questionText, questionType, options, domain, ageMin: age.ageMin, ageMax: age.ageMax });

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
                btn.textContent = '+ Add to Batch'; btn.disabled = false;
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

            // Appointments arrive newest first. The id sent with an assignment
            // must be one the server accepts as a live link (pending, approved
            // or completed), so a cancelled or rejected newest booking must not
            // be picked over an older live one, which made the assignment fail
            // with a false 403.
            const LIVE_STATUSES = ['pending', 'approved', 'completed'];
            appointments.forEach(a => {
                const key = String(a.childId);
                const live = LIVE_STATUSES.includes(a.status);
                const current = seen.get(key);
                if (!current) {
                    seen.set(key, {
                        childId: String(a.childId),
                        childName: `${a.childFirstName || ''} ${a.childLastName || ''}`.trim() || 'Child',
                        parentName: `${a.parentFirstName || ''} ${a.parentLastName || ''}`.trim() || 'Parent',
                        appointmentId: live ? (a.id || null) : null
                    });
                } else if (current.appointmentId == null && live) {
                    current.appointmentId = a.id || null;
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
            ${patientList.map(p => `<option value="${escapeHtml(p.childId)}">${escapeHtml(p.childName)}</option>`).join('')}
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
                document.getElementById('pendingAssignmentsList').innerHTML = `<div class="empty-small" style="color:var(--status-attention-fg);">${escapeHtml(err.message)}</div>`;
                document.getElementById('answeredAssignmentsList').innerHTML = `<div class="empty-small" style="color:var(--status-attention-fg);">${escapeHtml(err.message)}</div>`;
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
                        <h4 class="qset-title"><img src="/icons/clipboard.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> ${esc(setDisplayTitle(set, index))}</h4>
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
                        <button class="btn-outline" onclick="openAssignSetModal('${set.setId}')" style="font-size:.78rem;padding:.3rem .7rem;"><img src="/icons/parent_assign.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Assign Set</button>
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
                        <button class="btn-outline" onclick="openEditModal(${q.id})" style="font-size:.78rem;padding:.3rem .7rem;"><img src="/icons/edit_pedia.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;">️ Edit</button>
                        <button class="btn-outline" onclick="openAssignModal(${q.id})" style="font-size:.78rem;padding:.3rem .7rem;"><img src="/icons/parent_assign.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Assign</button>
                        <button class="btn-outline" onclick="toggleActive(${q.id}, ${!q.isActive})" style="font-size:.78rem;padding:.3rem .7rem;">${q.isActive ? 'Deactivate' : 'Activate'}</button>
                        <button class="btn-danger" onclick="deleteQuestion(${q.id})"><img src="/icons/delete_pedia.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Delete</button>
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
                        ${answeredView ? '✓ Answered' : '<img src="/icons/pending_request.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Pending'}
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
                                <p class="tcard-q-note tcard-q-note--pending"><img src="/icons/pending_request.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Waiting for parent answer</p>
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
                            <p class="tcard-q-note tcard-q-note--pending"><img src="/icons/pending_request.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Waiting for the parent to submit an answer.</p>
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
            // Short Answer is retired. A legacy short_answer question loads with
            // the type reset to Yes / No so it cannot be saved as short_answer
            // again; the pediatrician must pick a supported type.
            const supportedTypes = ['yes_no', 'multiple_choice'];
            const legacyShortAnswer = !supportedTypes.includes(q.questionType);
            document.getElementById('qType').value = legacyShortAnswer ? 'yes_no' : q.questionType;
            document.getElementById('qDomain').value = q.domain || 'Communication';
            document.getElementById('qAgeMin').value = q.ageMin ?? 0;
            document.getElementById('qAgeMax').value = q.ageMax ?? 18;
            const editErr = document.getElementById('modalError');
            if (legacyShortAnswer) {
                editErr.textContent = 'This question was a Short Answer question, which is no longer supported. '
                    + 'Please choose Yes / No or Multiple Choice before saving.';
                editErr.style.display = 'block';
            } else {
                editErr.style.display = 'none';
            }
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

        // Add one option input row. The value is set as a property, not written
        // into markup: an option containing a double quote used to cut the
        // attribute short, so editing a question dropped the rest of that option.
        function addOption(value = '') {
            optionCount++;

            const div = document.createElement('div');
            div.className = 'options-input-row';

            const input = document.createElement('input');
            input.type = 'text';
            input.id = `opt_${optionCount}`;
            input.value = value;
            input.placeholder = `Option ${optionCount}`;

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'option-remove-btn';
            remove.textContent = '\u00D7';
            remove.addEventListener('click', () => div.remove());

            div.append(input, remove);
            document.getElementById('optionsContainer').appendChild(div);
        }

        // The age window from the form: whole years 0-18, minimum not above maximum.
        // An empty field takes its default; a typed 0 is kept (it used to become 18).
        function readAgeRange() {
            const minRaw = document.getElementById('qAgeMin').value.trim();
            const maxRaw = document.getElementById('qAgeMax').value.trim();
            const ageMin = minRaw === '' ? 0 : Number(minRaw);
            const ageMax = maxRaw === '' ? 18 : Number(maxRaw);
            if (![ageMin, ageMax].every(n => Number.isInteger(n) && n >= 0 && n <= 18)) {
                return { error: 'Ages must be whole numbers from 0 to 18.' };
            }
            if (ageMin > ageMax) return { error: 'The minimum age cannot be above the maximum age.' };
            return { ageMin, ageMax };
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
            const age = readAgeRange();
            const options = questionType === 'multiple_choice' ? getOptions() : [];

            if (!questionText) {
                errEl.textContent = 'Question text is required.';
                errEl.style.display = 'block';
                return;
            }

            if (age.error) {
                errEl.textContent = age.error;
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
                const payload = { questionText, questionType, options, domain, ageMin: age.ageMin, ageMax: age.ageMax };

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

        // ── Assign modal (question or question set → patients) ─────────────
        // One table for both modes. Which endpoint a row uses is decided by
        // assigningSetId / assigningQId, exactly as before:
        //   set      → assignSetToPatient()  POST /questions/set/:setId/assign
        //   question → assignToPatient()     POST /questions/:id/assign
        // The rows come from patientList (unfiltered) or from the existing
        // /assessments/patients filter (filtered). patientList itself is never
        // overwritten by a filter: the Answer Tracker reads it too.
        let assignFilteredRows = null;      // null = no filter active
        let assignScoresByChild = new Map(); // childId → score data from /assessments/patients
        let assignScoresError = false;
        let assignRequestToken = 0;          // latest filter request
        let assignScoreToken = 0;            // latest score request

        function setAssignModalHeader(title, subtitle) {
            document.getElementById('assignModalTitle').textContent = title;
            document.getElementById('assignModalSub').textContent = subtitle;
        }

        function resetAssignFilterControls() {
            document.getElementById('filterCategory').value = '';
            document.getElementById('filterThreshold').value = '';
            assignFilteredRows = null;
            syncThresholdAvailability();
        }

        // The status filter only has a meaning per domain (the server ignores
        // it without a category), so it waits for a category to be chosen.
        function syncThresholdAvailability() {
            const category = document.getElementById('filterCategory').value;
            const sel = document.getElementById('filterThreshold');
            sel.disabled = !category;
            sel.title = category ? '' : 'Choose a category first';
            if (!category) sel.value = '';
        }

        // Maps one /assessments/patients record to a modal row. Scores and
        // statuses are the server's values, used as-is.
        function assignRowFromAssessment(p) {
            return {
                childId: String(p.childId),
                childName: `${p.childFirstName || ''} ${p.childLastName || ''}`.trim() || 'Child',
                parentName: `${p.parentFirstName || ''} ${p.parentLastName || ''}`.trim() || 'Parent',
                appointmentId: p.appointmentId || null,
                lastAssessmentDate: p.lastAssessmentDate || null,
                scores: { motor: p.motorScore, communication: p.communicationScore, social: p.socialScore, cognitive: p.cognitiveScore },
                statuses: { motor: p.motorStatus, communication: p.communicationStatus, social: p.socialStatus, cognitive: p.cognitiveStatus },
            };
        }

        // Latest-assessment date and domain scores for the unfiltered table.
        // Same endpoint the filters use, called without a filter.
        async function loadAssignScores() {
            const token = ++assignScoreToken;
            try {
                const response = await apiFetch('/assessments/patients');
                if (token !== assignScoreToken) return;
                assignScoresByChild = new Map((response.patients || []).map(p => [String(p.childId), assignRowFromAssessment(p)]));
                assignScoresError = false;
            } catch (err) {
                if (token !== assignScoreToken) return;
                console.error('Assign modal score load error:', err);
                assignScoresByChild = new Map();
                assignScoresError = true;
            }
        }

        async function openAssignDialog() {
            selectedPatients.clear();
            resetAssignFilterControls();
            document.getElementById('selectAllPatients').checked = false;
            document.getElementById('assignModal').style.display = 'flex';
            document.getElementById('assignPatientList').innerHTML = '<div class="assign-state">Loading patients…</div>';
            document.getElementById('assignVisibleCount').textContent = '';
            updateSelectedCount();

            if (!patientList.length) {
                await loadPatientsOnly();
            }
            await loadAssignScores();
            renderAssignList();
        }

        // Open assign modal for a specific question
        async function openAssignModal(qId) {
            assigningQId = qId;
            assigningSetId = null;

            const q = allQuestions.find(x => String(x.id) === String(qId));
            setAssignModalHeader('Assign Question to Patient',
                `"${q ? q.questionText.substring(0, 60) + (q.questionText.length > 60 ? '…' : '') : 'Question'}"`);
            await openAssignDialog();
        }

        // Open assign modal for an entire Question Set
        let assigningSetId = null;
        async function openAssignSetModal(setId) {
            assigningSetId = setId;
            assigningQId = null;

            const set = allQuestionSets.find(s => String(s.setId) === String(setId));
            const qCount = set ? set.questions.length : 0;
            setAssignModalHeader('Assign Question Set to Patient',
                `Set: "${set ? set.title : 'Question Set'}" (${qCount} question${qCount !== 1 ? 's' : ''})`);
            await openAssignDialog();
        }

        // Kept for existing callers: both modes now share renderAssignList().
        function renderAssignSetList() {
            renderAssignList();
        }

        // Filter patients by assessment category and threshold, using the
        // existing /assessments/patients endpoint. Without a status the
        // endpoint is called unfiltered (with only a category it returns no
        // one), and the table then shows that category's score for every
        // patient with a result.
        async function filterPatientsByAssessment() {
            syncThresholdAvailability();
            const category = document.getElementById('filterCategory')?.value || '';
            const threshold = document.getElementById('filterThreshold')?.value || '';
            const list = document.getElementById('assignPatientList');
            const token = ++assignRequestToken;

            if (!category) {
                assignFilteredRows = null;
                renderAssignList();
                return;
            }

            list.innerHTML = '<div class="assign-state">Filtering patients…</div>';

            try {
                const params = new URLSearchParams();
                if (threshold) {
                    params.append('category', category);
                    params.append('threshold', threshold);
                }
                const query = params.toString();
                const response = await apiFetch(`/assessments/patients${query ? `?${query}` : ''}`);
                if (token !== assignRequestToken) return;
                assignFilteredRows = (response.patients || []).map(assignRowFromAssessment);
                renderAssignList();
            } catch (err) {
                if (token !== assignRequestToken) return;
                console.error('Filter error:', err);
                assignFilteredRows = [];
                list.innerHTML = '<div class="assign-state">Error filtering patients. Please try again.</div>';
                pruneSelectionToVisible();
                updateVisibleCount(0);
                updateSelectedCount();
            }
        }

        // Clear assessment filters and show all patients
        async function clearAssessmentFilters() {
            resetAssignFilterControls();
            ++assignRequestToken;
            await loadPatientsOnly();
            await loadAssignScores();
            renderAssignList();
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
                                'background:var(--status-caution-bg);color:#3d4738;'
                            }">${
                                isDraft ? '<img src="/icons/edit_pedia.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Draft' :
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
                            <p style="font-size:1.6rem;font-weight:700;color:var(--primary);margin:0;">${answeredAssignments.length}</p>
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
                                <div style="background:#FAFAF6;border:1px solid var(--border);border-radius:8px;padding:1rem;">
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
                        <h3 style="margin:0 0 1rem;font-size:.95rem;font-weight:600;color:var(--status-positive-fg);"><img src="/icons/parent_answer_tracker.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;vertical-align:-0.18em;"> Parent's Answers</h3>
                        <div style="display:flex;flex-direction:column;gap:.8rem;">
                            ${answeredAssignments.map(a => `
                                <div style="background:var(--status-positive-bg);border:1px solid #a8c49d;border-radius:8px;padding:1rem;">
                                    <p style="margin:0 0 .5rem;font-size:.85rem;color:var(--text-light);">Question: ${esc(a.questionText || 'Question')}</p>
                                    <div style="background:#FAFAF6;border:1px solid #a8c49d;border-radius:6px;padding:.75rem;">
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
        let assignBulkBusy = false;

        const ASSIGN_DOMAINS = [
            ['communication', 'Communication', 'Communication'],
            ['social', 'Social', 'Social Skills'],
            ['cognitive', 'Cognitive', 'Cognitive'],
            ['motor', 'Motor', 'Motor Skills'],
        ];

        // Rows currently in the table: the filter result, or every patient
        // with the latest-assessment data merged in by childId.
        function assignVisibleRows() {
            if (assignFilteredRows) return assignFilteredRows;
            return patientList.map(p => {
                const s = assignScoresByChild.get(String(p.childId));
                return {
                    childId: String(p.childId),
                    childName: p.childName,
                    parentName: p.parentName,
                    appointmentId: p.appointmentId || null,
                    lastAssessmentDate: s ? s.lastAssessmentDate : null,
                    scores: s ? s.scores : null,
                    statuses: s ? s.statuses : null,
                };
            });
        }

        // Display only, from the Answer Tracker data already on the page. It
        // mirrors the server's duplicate rule (routes/custom-questions.js): one
        // assignment per question + child + appointment. The server still
        // decides, and answers "Already assigned" without creating a copy.
        function assignmentStatusFor(row) {
            const appt = row.appointmentId == null ? null : Number(row.appointmentId);
            const mine = trackerAssignments.filter(a => String(a.childId) === String(row.childId)
                && (a.appointmentId == null ? null : Number(a.appointmentId)) === appt);
            if (assigningSetId) {
                const set = allQuestionSets.find(s => String(s.setId) === String(assigningSetId));
                const ids = (set && Array.isArray(set.questions) ? set.questions : []).map(q => String(q.id));
                if (!ids.length) return { key: 'none' };
                const done = ids.filter(id => mine.some(a => String(a.questionId) === id)).length;
                if (done === ids.length) return { key: 'assigned' };
                return done ? { key: 'partial', done, total: ids.length } : { key: 'none' };
            }
            return { key: mine.some(a => String(a.questionId) === String(assigningQId)) ? 'assigned' : 'none' };
        }

        function isAssignable(row) {
            return assignmentStatusFor(row).key !== 'assigned';
        }

        // Score badges show the server's score and stored status (KCScoring
        // only supplies the label text and band colour; nothing is recomputed).
        function assignScoreBadge(row, key, shortLabel, small) {
            const S = window.KCScoring;
            const value = row.scores ? row.scores[key] : null;
            if (value == null) return '';
            const status = row.statuses ? row.statuses[key] : null;
            const statusLabel = status ? S.clinicalLabel(status) : '';
            const fill = (status && S.STATUS_COLORS[status]) || 'var(--surface-muted)';
            const fullName = (ASSIGN_DOMAINS.find(d => d[0] === key) || [])[2] || key;
            const title = `${fullName}: ${value}%${statusLabel ? ` (${statusLabel})` : ''}`;
            const text = small ? `${shortLabel} ${value}%` : `${statusLabel ? `${statusLabel} ` : ''}${value}%`;
            const srText = small && statusLabel ? `<span class="assign-sr-only"> (${esc(statusLabel)})</span>` : '';
            return `<span class="assign-badge${small ? ' assign-badge--small' : ''}" style="background:${fill};" title="${esc(title)}">${esc(text)}${srText}</span>`;
        }

        function assignDomainScoreCell(row) {
            const hasScores = row.scores && Object.values(row.scores).some(v => v != null);
            if (!hasScores) {
                const text = assignScoresError && !assignFilteredRows ? 'Unavailable' : 'No score';
                return `<span class="assign-badge assign-badge--none">${text}</span>`;
            }
            const category = document.getElementById('filterCategory').value;
            if (category) {
                return assignScoreBadge(row, category, '', false) || '<span class="assign-badge assign-badge--none">No score</span>';
            }
            return `<div class="assign-domain-badges">${ASSIGN_DOMAINS.map(([key, label]) => assignScoreBadge(row, key, label, true)).join('')}</div>`;
        }

        function assignDateCell(row) {
            if (row.lastAssessmentDate) {
                return esc(new Date(row.lastAssessmentDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
            }
            const text = assignScoresError && !assignFilteredRows ? 'Unavailable' : 'No assessment result yet';
            return `<span class="assign-muted">${text}</span>`;
        }

        function assignStatusCell(status) {
            if (status.key === 'assigned') return '<span class="assign-badge assign-badge--assigned">Already assigned</span>';
            if (status.key === 'partial') return `<span class="assign-badge assign-badge--partial">Partly assigned (${status.done}/${status.total})</span>`;
            return '<span class="assign-badge assign-badge--none">Not assigned</span>';
        }

        function renderAssignRow(row) {
            const status = assignmentStatusFor(row);
            const assignable = status.key !== 'assigned';
            const isSelected = assignable && selectedPatients.has(row.childId);
            const id = esc(row.childId);
            const appt = row.appointmentId == null ? 'null' : Number(row.appointmentId);
            const actionLabel = assigningSetId ? 'Assign Set' : 'Assign';
            return `
                <tr class="${isSelected ? 'is-selected' : ''}">
                    <td class="col-select">
                        <input type="checkbox" class="patient-checkbox" value="${id}" ${isSelected ? 'checked' : ''} ${assignable ? '' : 'disabled'}
                            aria-label="Select ${esc(row.childName)}" onchange="togglePatientSelection('${id}')">
                    </td>
                    <td class="col-name">${esc(row.childName)}</td>
                    <td class="col-name">${esc(row.parentName)}</td>
                    <td>${assignDateCell(row)}</td>
                    <td>${assignDomainScoreCell(row)}</td>
                    <td>${assignStatusCell(status)}</td>
                    <td class="col-action">${assignable
                        ? `<button type="button" class="btn-outline assign-row-btn" onclick="assignRowAction(this, '${id}', ${appt})">${actionLabel}</button>`
                        : '<span class="assign-muted" aria-label="No action">&mdash;</span>'}</td>
                </tr>`;
        }

        // Render patient table inside the assign modal
        function renderAssignList() {
            const list = document.getElementById('assignPatientList');
            const rows = assignVisibleRows();
            pruneSelectionToVisible(rows);
            updateVisibleCount(rows.length);

            if (!rows.length) {
                list.innerHTML = assignFilteredRows
                    ? '<div class="assign-state">No patients match this filter.<br><small>Try selecting different criteria.</small></div>'
                    : '<div class="assign-state">No patients yet. Approve some appointments first.</div>';
                updateSelectedCount();
                return;
            }

            list.innerHTML = `
                <table class="assign-table">
                    <thead>
                        <tr>
                            <th class="col-select"><span class="assign-sr-only">Select</span></th>
                            <th>Patient Name</th>
                            <th>Parent Name</th>
                            <th>Latest Assessment</th>
                            <th>Domain Score</th>
                            <th>Status</th>
                            <th class="col-action">Action</th>
                        </tr>
                    </thead>
                    <tbody>${rows.map(renderAssignRow).join('')}</tbody>
                </table>`;

            updateSelectedCount();
        }

        // A selection never outlives a filter change: only visible patients
        // that can still be assigned stay selected.
        function pruneSelectionToVisible(rows = assignVisibleRows()) {
            const keep = new Set(rows.filter(isAssignable).map(r => r.childId));
            [...selectedPatients].forEach(id => { if (!keep.has(id)) selectedPatients.delete(id); });
        }

        function updateVisibleCount(n) {
            document.getElementById('assignVisibleCount').textContent = `${n} patient${n === 1 ? '' : 's'} shown`;
        }

        // Individual "Assign" / "Assign Set": the existing handlers, guarded
        // against a double click.
        async function assignRowAction(btn, childId, appointmentId) {
            if (btn) btn.disabled = true;
            try {
                if (assigningSetId) await assignSetToPatient(childId, appointmentId);
                else await assignToPatient(childId, appointmentId);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        // Toggle individual patient selection
        function togglePatientSelection(childId) {
            if (selectedPatients.has(childId)) {
                selectedPatients.delete(childId);
            } else {
                const row = assignVisibleRows().find(r => r.childId === childId);
                if (row && isAssignable(row)) selectedPatients.add(childId);
            }
            renderAssignList();
        }

        // Toggle select all visible patients
        function toggleSelectAllPatients() {
            const selectAll = document.getElementById('selectAllPatients');
            const eligible = assignVisibleRows().filter(isAssignable);
            if (selectAll.checked) {
                eligible.forEach(p => selectedPatients.add(p.childId));
            } else {
                eligible.forEach(p => selectedPatients.delete(p.childId));
            }
            renderAssignList();
        }

        // Update selected count display (toolbar + footer) and Select All state
        function updateSelectedCount() {
            const count = selectedPatients.size;
            document.getElementById('selectedCount').textContent = count;
            document.querySelectorAll('#assignModal .assign-selected-count').forEach(el => { el.textContent = count; });
            ['assignSelectedBtn', 'assignSelectedFooterBtn'].forEach(btnId => {
                const btn = document.getElementById(btnId);
                if (btn) btn.disabled = count === 0 || assignBulkBusy;
            });

            const selectAll = document.getElementById('selectAllPatients');
            if (selectAll) {
                const eligible = assignVisibleRows().filter(isAssignable);
                const picked = eligible.filter(r => selectedPatients.has(r.childId)).length;
                selectAll.disabled = eligible.length === 0;
                selectAll.checked = eligible.length > 0 && picked === eligible.length;
                selectAll.indeterminate = picked > 0 && picked < eligible.length;
            }
        }

        // Assign to selected patients (bulk) — the same endpoint as the
        // matching single action, once per selected, visible, assignable row.
        async function assignToSelectedPatients() {
            if (assignBulkBusy || selectedPatients.size === 0) return;

            const rows = assignVisibleRows().filter(r => selectedPatients.has(r.childId) && isAssignable(r));
            if (!rows.length) return;

            const endpoint = assigningSetId
                ? `/questions/set/${assigningSetId}/assign`
                : `/questions/${assigningQId}/assign`;
            const isSet = Boolean(assigningSetId);

            assignBulkBusy = true;
            updateSelectedCount();

            let successCount = 0;
            let failCount = 0;

            for (const row of rows) {
                try {
                    await apiFetch(endpoint, {
                        method: 'POST',
                        body: JSON.stringify({
                            childId: row.childId,
                            appointmentId: row.appointmentId || undefined
                        })
                    });
                    successCount++;
                } catch (e) {
                    failCount++;
                }
            }

            assignBulkBusy = false;

            if (failCount === 0) {
                flash(isSet
                    ? `Question set assigned to ${successCount} patient(s)! Parents have been notified.`
                    : `Question assigned to ${successCount} patient(s)! Parents have been notified.`);
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
            // Drop the filter result and ignore any request still in flight.
            assignFilteredRows = null;
            assignRequestToken++;
            assignScoreToken++;
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
        // One explanation for every score chip in the Assign list. Ranges are
        // KCScoring's, the same ones the status filter above lists.
        function syncAssignScoreNote() {
            const el = document.getElementById('assignScoreNote');
            if (!el || !window.KCScoring) return;
            const S = window.KCScoring;
            el.innerHTML = 'Percentages are <strong>domain assessment scores</strong> from the child\'s latest assessment '
                + '(share of possible points on that domain\'s questions: Yes = 2, Sometimes = 1, No = 0):<br>'
                + S.ACTIVE_BANDS.map(b => `<span class="assign-score-key"><span class="assign-score-dot" style="background:${S.colorForBand(b.key)};" aria-hidden="true"></span>${S.clinicalLabel(b.key)} ${b.min}&ndash;${b.max}%</span>`).join(' &nbsp;|&nbsp; ');
        }

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
            syncAssignScoreNote();
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
