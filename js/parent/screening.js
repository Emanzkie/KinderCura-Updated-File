// === Extracted from PARENT\screening.html (script block 1) ===
requireAuth();

        // Important: these are the interview-based questions from the doctor source.
        // We keep BOTH the display domain and the KinderCura scoring domain so results,
        // recommendations, dashboard cards, and pediatrician pages still work correctly.
        const DOCTOR_QUESTION_BANK = [
            { id: 'Q02', minAgeMonths: 36, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child draw a circle?',                                                difficulty: 'Easy' },
            { id: 'Q05', minAgeMonths: 36, displayDomain: 'Language',        scoreDomain: 'Communication', text: 'Does your child speak using 3–4 word sentences?',                             difficulty: 'Easy' },
            { id: 'Q07', minAgeMonths: 36, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child dress with supervision?',                                    difficulty: 'Easy' },
            { id: 'Q08', minAgeMonths: 36, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child wash hands properly?',                                          difficulty: 'Easy' },
            { id: 'Q01', minAgeMonths: 36, displayDomain: 'Gross Motor',     scoreDomain: 'Motor Skills',   text: 'Does your child ride a tricycle?',                                            difficulty: 'Moderate' },
            { id: 'Q03', minAgeMonths: 36, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child draw a person with at least 2 body parts?',                 difficulty: 'Moderate' },
            { id: 'Q04', minAgeMonths: 36, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child build a tower using 10 cubes?',                              difficulty: 'Moderate' },
            { id: 'Q06', minAgeMonths: 36, displayDomain: 'Language',        scoreDomain: 'Cognitive',      text: 'Does your child understand simple prepositions (e.g., in, on, under)?',     difficulty: 'Moderate' },

            { id: 'Q09', minAgeMonths: 42, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child draw a cube?',                                               difficulty: 'Moderate' },

            { id: 'Q10', minAgeMonths: 48, displayDomain: 'Gross Motor',     scoreDomain: 'Motor Skills',   text: 'Does your child hop?',                                                       difficulty: 'Easy' },
            { id: 'Q11', minAgeMonths: 48, displayDomain: 'Gross Motor',     scoreDomain: 'Motor Skills',   text: 'Does your child throw a ball overhead?',                                     difficulty: 'Easy' },
            { id: 'Q14', minAgeMonths: 48, displayDomain: 'Language',        scoreDomain: 'Communication', text: 'Does your child speak in complete sentences?',                                 difficulty: 'Easy' },
            { id: 'Q18', minAgeMonths: 48, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child engage in group play?',                                        difficulty: 'Easy' },
            { id: 'Q19', minAgeMonths: 48, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child use the toilet independently?',                                difficulty: 'Easy' },
            { id: 'Q12', minAgeMonths: 48, displayDomain: 'Gross Motor',     scoreDomain: 'Motor Skills',   text: 'Does your child use scissors to cut pictures?',                              difficulty: 'Moderate' },
            { id: 'Q13', minAgeMonths: 48, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child draw a square?',                                             difficulty: 'Moderate' },
            { id: 'Q15', minAgeMonths: 48, displayDomain: 'Language',        scoreDomain: 'Communication', text: 'Does your child tell a simple story?',                                          difficulty: 'Moderate' },
            { id: 'Q16', minAgeMonths: 48, displayDomain: 'Language',        scoreDomain: 'Cognitive',      text: 'Does your child understand size concepts (e.g., big vs small)?',            difficulty: 'Moderate' },
            { id: 'Q17', minAgeMonths: 48, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child dress independently and correctly?',                         difficulty: 'Moderate' },

            { id: 'Q26', minAgeMonths: 60, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child engage in pretend or role-playing activities?',                difficulty: 'Easy' },
            { id: 'Q20', minAgeMonths: 60, displayDomain: 'Gross Motor',     scoreDomain: 'Motor Skills',   text: 'Does your child skip?',                                                      difficulty: 'Moderate' },
            { id: 'Q21', minAgeMonths: 60, displayDomain: 'Language',        scoreDomain: 'Cognitive',      text: 'Does your child understand basic concepts of time?',                         difficulty: 'Moderate' },
            { id: 'Q22', minAgeMonths: 60, displayDomain: 'Language',        scoreDomain: 'Communication', text: 'Does your child follow 3-step commands?',                                      difficulty: 'Moderate' },
            { id: 'Q23', minAgeMonths: 60, displayDomain: 'Language',        scoreDomain: 'Communication', text: 'Does your child pronounce most speech sounds clearly?',                       difficulty: 'Moderate' },
            { id: 'Q24', minAgeMonths: 60, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child do simple errands or help with household tasks?',            difficulty: 'Moderate' },
            { id: 'Q25', minAgeMonths: 60, displayDomain: 'Personal-Social', scoreDomain: 'Cognitive',      text: 'Does your child ask questions about the meaning of words?',                  difficulty: 'Moderate' },

            { id: 'Q29', minAgeMonths: 72, displayDomain: 'Language',        scoreDomain: 'Communication', text: 'Does your child express emotions verbally?',                                    difficulty: 'Easy' },
            { id: 'Q31', minAgeMonths: 72, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child dress completely on their own?',                              difficulty: 'Easy' },
            { id: 'Q27', minAgeMonths: 72, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child copy letters (even if some are reversed)?',                  difficulty: 'Moderate' },
            { id: 'Q28', minAgeMonths: 72, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child draw a person with complete body parts (around 12 parts)?',  difficulty: 'Moderate' },
            { id: 'Q30', minAgeMonths: 72, displayDomain: 'Language',        scoreDomain: 'Cognitive',      text: 'Does your child follow 3-step sequential commands?',                         difficulty: 'Moderate' },
            { id: 'Q32', minAgeMonths: 72, displayDomain: 'Personal-Social', scoreDomain: 'Social Skills', text: 'Does your child tie shoelaces?',                                               difficulty: 'Moderate' },

            { id: 'Q33', minAgeMonths: 84, displayDomain: 'Gross Motor',     scoreDomain: 'Motor Skills',   text: 'Does your child run and climb with good coordination?',                       difficulty: 'Easy' },
            { id: 'Q34', minAgeMonths: 84, displayDomain: 'Fine Motor',      scoreDomain: 'Cognitive',      text: 'Does your child correctly identify left and right?',                         difficulty: 'Moderate' }
        ];

        const DOMAIN_ORDER = [
            { key: 'Communication', label: 'Communication', progressId: 'comm-progress', barId: 'comm-bar' },
            { key: 'Social Skills', label: 'Social Skills', progressId: 'social-progress', barId: 'social-bar' },
            { key: 'Cognitive', label: 'Cognitive', progressId: 'cognitive-progress', barId: 'cognitive-bar' },
            { key: 'Motor Skills', label: 'Motor Skills', progressId: 'motor-progress', barId: 'motor-bar' }
        ];

        let currentQuestion = 0;
        let answers = {};
        let assessmentId = null;
        let selectedChild = null;
        let QUESTION_SET = [];

        // Pediatrician Custom Questions still pending for this child, fetched from
        // /assessments/initialize. Presented after the core checklist so answering
        // them becomes part of THIS new assessment (a reassessment) instead of the
        // separate custom-questions page flow. Empty when nothing is pending, in
        // which case this screening behaves exactly like before.
        let CUSTOM_QUESTION_SET = [];
        let FULL_SET = [];

        function buildFullSet() {
            const core = QUESTION_SET.map(q => ({ ...q, kind: 'core' }));
            const custom = CUSTOM_QUESTION_SET.map(q => ({
                id: `custom_${q.assignmentId}`,
                kind: 'custom',
                assignmentId: q.assignmentId,
                text: q.questionText,
                domain: q.domain,
                questionType: q.questionType,
                options: q.options,
                pediatricianName: q.pediatricianName,
            }));
            FULL_SET = core.concat(custom);
        }

        function getDifficultyClass(level) {
            const normalized = String(level || '').toLowerCase();
            if (normalized === 'easy') return 'easy';
            if (normalized === 'moderate') return 'moderate';
            return 'advanced';
        }

        function difficultyRank(level) {
            const normalized = String(level || '').toLowerCase();
            if (normalized === 'easy') return 0;
            if (normalized === 'moderate') return 1;
            return 2;
        }

        function isValidObjectId(value) {
            return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
        }

        function getAgeInMonths(dateOfBirth) {
            const dob = new Date(dateOfBirth);
            const now = new Date();
            let months = (now.getFullYear() - dob.getFullYear()) * 12;
            months += now.getMonth() - dob.getMonth();
            if (now.getDate() < dob.getDate()) months -= 1;
            return months;
        }

        function formatExactAge(dateOfBirth) {
            const months = getAgeInMonths(dateOfBirth);
            const years = Math.floor(months / 12);
            const remainingMonths = months % 12;
            return `${years} year${years !== 1 ? 's' : ''} ${remainingMonths} month${remainingMonths !== 1 ? 's' : ''}`;
        }

        function getAgeRangeLabel(ageMonths) {
            if (ageMonths >= 36 && ageMonths <= 60) return 'Preschool (3-5 years)';
            if (ageMonths > 60 && ageMonths <= 96) return 'School Age (5-8 years)';
            return 'Child Assessment';
        }

        // Important: we keep the interview checklist progressive by age, then Easy before Moderate.
        function buildQuestionSet(child) {
            const ageMonths = getAgeInMonths(child.dateOfBirth);
            return DOCTOR_QUESTION_BANK
                .filter(q => ageMonths >= q.minAgeMonths)
                .sort((a, b) => {
                    if (a.minAgeMonths !== b.minAgeMonths) return a.minAgeMonths - b.minAgeMonths;
                    if (difficultyRank(a.difficulty) !== difficultyRank(b.difficulty)) {
                        return difficultyRank(a.difficulty) - difficultyRank(b.difficulty);
                    }
                    return a.id.localeCompare(b.id);
                });
        }

        async function getSelectedChild() {
            const data = await apiFetch('/children');
            const children = Array.isArray(data.children) ? data.children : [];
            if (!children.length) return null;

            let childId = KC.childId();
            if (!isValidObjectId(childId)) childId = localStorage.getItem('kc_viewChildId');

            let child = children.find(c => c.id === childId);
            if (!child) child = children[0];
            if (child) localStorage.setItem('kc_childId', child.id);
            return child || null;
        }

        function getAnswerPayload() {
            return QUESTION_SET
                .filter(q => q?.id && answers[q.id])
                .map(q => ({
                    questionId: q.id,
                    domain: q.scoreDomain ?? '',
                    questionText: q.text ?? '',
                    answer: answers[q.id]
                }));
        }

        // Custom Question answers are keyed separately (by assignmentId, not
        // questionId) because the backend scores/stores them through a different
        // path — see routes/assessments.js POST /submit.
        function getCustomAnswerPayload() {
            return CUSTOM_QUESTION_SET
                .filter(q => q?.assignmentId && answers[`custom_${q.assignmentId}`])
                .map(q => ({
                    assignmentId: q.assignmentId,
                    answer: answers[`custom_${q.assignmentId}`]
                }));
        }

        function updateAnswerOptionStyles() {
            const q = FULL_SET?.[currentQuestion];
            if (!q) return;
            document.querySelectorAll('.answer-option').forEach(option => {
                option.classList.toggle('is-selected', answers[q.id] === option.dataset.answer);
            });
        }

        function updateProgress() {
            const totals = Object.fromEntries(DOMAIN_ORDER.map(d => [d.key, 0]));
            const answered = Object.fromEntries(DOMAIN_ORDER.map(d => [d.key, 0]));

            // Domain progress bars are built dynamically from FULL_SET — core-bank
            // items AND every pediatrician Custom Question assigned to this child,
            // grouped by whichever of the four domains each item actually belongs
            // to (q.scoreDomain for core, q.domain for custom — both are always one
            // of the four official domains; custom is guaranteed by the server-side
            // normalizeDomain() in routes/assessments.js). No number here is
            // hardcoded: 9 core Motor Skills + 1 custom Motor Skills question means
            // this loop produces totals['Motor Skills'] === 10 on its own.
            //
            // This is an ITEM-COUNT/completion tally only. Whether a given custom
            // question's answer will actually contribute POINTS to the domain score
            // is a completely separate decision made once, server-side, in
            // routes/assessments.js POST /submit (yes_no only) — a multiple_choice
            // or short_answer custom question still counts here as one more item to
            // answer, even though it will be recorded-but-not-scored on submit.
            FULL_SET.forEach(q => {
                const domain = q.kind === 'custom' ? q.domain : q.scoreDomain;
                if (!(domain in totals)) return; // defensive: should never happen post-normalization
                totals[domain] += 1;
                if (answers[q.id]) answered[domain] += 1;
            });

            DOMAIN_ORDER.forEach(domain => {
                const total = totals[domain.key] || 0;
                const done = answered[domain.key] || 0;
                document.getElementById(domain.progressId).textContent = `${done}/${total}`;
                document.getElementById(domain.barId).style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
            });

            const answeredInFullSet = FULL_SET.filter(q => answers[q.id]).length;
            const overallPercent = Math.round((answeredInFullSet / Math.max(FULL_SET.length, 1)) * 100);
            document.getElementById('overall-progress').textContent = `${overallPercent}%`;
            const overallBar = document.getElementById('overall-bar');
            if (overallBar) overallBar.style.width = `${overallPercent}%`;
        }

        // Pediatrician-authored text (question text, options, domain, name) is
        // untrusted input rendered via innerHTML below — escape it the same way
        // js/parent/custom-questions.js already does for the identical data.
        function esc(s) {
            return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function encodeJsString(value) {
            return JSON.stringify(String(value ?? '')).replace(/"/g, '&quot;');
        }

        // Answer widget for a custom question, based on its questionType. yes_no
        // reuses the same 'Yes'/'No' values the standalone custom-questions page
        // already saves (js/parent/custom-questions.js selectChoice), so a single
        // scoring rule on the backend covers both entry points.
        function buildCustomAnswerOptions(q) {
            if (q.questionType === 'yes_no') {
                return [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }];
            }
            if (q.questionType === 'multiple_choice') {
                return (q.options || []).map(opt => ({ value: opt, label: opt }));
            }
            return null; // short_answer -> free text
        }

        function renderCustomQuestionCard(q, hasPrevious, isLast) {
            const currentAnswer = answers[q.id] || '';
            const opts = buildCustomAnswerOptions(q);

            const answerBlock = opts ? `
                <div class="answer-list">
                    ${opts.map(o => `
                        <label class="answer-option option-btn ${currentAnswer === o.value ? 'is-selected' : ''}" data-answer="${esc(o.value)}">
                            <input type="radio" name="answer" value="${esc(o.value)}" ${currentAnswer === o.value ? 'checked' : ''} onchange="recordAnswer(${encodeJsString(o.value)})">
                            <span class="answer-option-mark"></span>
                            <span class="answer-option-text">${esc(o.label)}</span>
                        </label>
                    `).join('')}
                </div>` : `
                <textarea class="assessment-question-box" style="width:100%;min-height:110px;padding:0.9rem;border-radius:10px;border:1px solid var(--border, #ddd);font:inherit;"
                    placeholder="Type your answer here..."
                    oninput="recordAnswer(this.value.trim())">${esc(currentAnswer)}</textarea>`;

            return `
                <section class="assessment-question-card question-card">
                    <div class="assessment-question-header">
                        <p class="assessment-counter">Question ${currentQuestion + 1} of ${FULL_SET.length}</p>
                        <span class="assessment-question-domain category-badge">Pediatrician Question</span>
                    </div>

                    <div class="assessment-question-box">
                        <p class="assessment-question-text">${esc(q.text)}</p>
                        <p class="assessment-helper-text">Assigned by Dr. ${esc(q.pediatricianName || 'Pediatrician')} • ${esc(q.domain || 'Other')}</p>
                    </div>

                    <h3 class="assessment-answer-title">How would you answer?</h3>
                    ${answerBlock}

                    <div class="assessment-actions ${hasPrevious ? '' : 'single'}">
                        ${hasPrevious ? `<button type="button" class="assessment-action-btn secondary" onclick="previousQuestion()">← Back</button>` : ''}
                        <button type="button" class="assessment-action-btn primary" onclick="nextQuestion()">${isLast ? 'Complete Assessment ✓' : 'Next Question'}</button>
                    </div>
                </section>
            `;
        }

        function renderQuestion() {
            const q = FULL_SET?.[currentQuestion];
            const content = document.getElementById('assessmentContent');

            if (!q) {
                console.error(
                    '[SCREENING] Invalid question index:',
                    currentQuestion,
                    'total:',
                    FULL_SET.length
                );
                if (content) {
                    content.innerHTML = `
                        <div class="assessment-error">
                            <p>Assessment questions could not be loaded. Please try again.</p>
                        </div>
                    `;
                }
                return;
            }

            const hasPrevious = currentQuestion > 0;
            const isLast = currentQuestion === FULL_SET.length - 1;

            if (q.kind === 'custom') {
                content.innerHTML = renderCustomQuestionCard(q, hasPrevious, isLast);
                return;
            }

            content.innerHTML = `
                <section class="assessment-question-card question-card">
                    <div class="assessment-question-header">
                        <p class="assessment-counter">Question ${currentQuestion + 1} of ${FULL_SET.length}</p>
                        <span class="assessment-question-domain category-badge">${q?.displayDomain ?? 'Development'}</span>
                    </div>

                    <div class="assessment-question-box">
                        <p class="assessment-question-text">${q?.text ?? ''}</p>
                        <p class="assessment-helper-text">${q?.difficulty ?? ''} difficulty • Scored under ${q?.scoreDomain ?? ''}</p>
                    </div>

                    <h3 class="assessment-answer-title">How would you answer?</h3>

                    <div class="answer-list">
                        ${[
                            { value: 'yes', label: 'Yes, consistently' },
                            { value: 'sometimes', label: 'Sometimes' },
                            { value: 'no', label: 'Not yet' }
                        ].map(option => `
                            <label class="answer-option option-btn ${q?.id && answers[q.id] === option.value ? 'is-selected' : ''}" data-answer="${option.value}">
                                <input type="radio" name="answer" value="${option.value}" ${q?.id && answers[q.id] === option.value ? 'checked' : ''} onchange="recordAnswer('${option.value}')">
                                <span class="answer-option-mark"></span>
                                <span class="answer-option-text">${option.label}</span>
                            </label>
                        `).join('')}
                    </div>

                    <div class="assessment-actions ${hasPrevious ? '' : 'single'}">
                        ${hasPrevious ? `<button type="button" class="assessment-action-btn secondary" onclick="previousQuestion()">← Back</button>` : ''}
                        <button type="button" class="assessment-action-btn primary" onclick="nextQuestion()">${isLast ? 'Complete Assessment ✓' : 'Next Question'}</button>
                    </div>
                </section>
            `;
        }

        function recordAnswer(answer) {
            const q = FULL_SET?.[currentQuestion];
            if (!q) {
                console.error(
                    '[SCREENING] Cannot record answer — missing question at index:',
                    currentQuestion
                );
                return;
            }
            answers[q.id] = answer;
            updateProgress();
            updateAnswerOptionStyles();
        }

        function previousQuestion() {
            if (currentQuestion <= 0) return;
            currentQuestion -= 1;
            renderQuestion();
            updateAnswerOptionStyles();
        }

        async function saveDraftIfNeeded() {
            if (!assessmentId) return;
            // Draft saving only covers core answers — custom question answers are
            // claimed and saved atomically at final submit (routes/assessments.js
            // POST /submit), so an abandoned screening never partially claims a
            // pediatrician's assignment. See getCustomAnswerPayload.
            const answeredCount = QUESTION_SET.filter(cq => answers[cq.id]).length;
            if (!answeredCount || answeredCount % 5 !== 0) return;

            try {
                await apiFetch('/assessments/save-draft', {
                    method: 'POST',
                    body: JSON.stringify({
                        assessmentId,
                        progress: Math.round((answeredCount / QUESTION_SET.length) * 100),
                        answers: getAnswerPayload()
                    })
                });
            } catch (_) {
                // Important: silent on purpose so draft saving will not interrupt the parent flow.
            }
        }

        async function nextQuestion() {
            const q = FULL_SET?.[currentQuestion];
            if (!q) {
                console.error(
                    '[SCREENING] nextQuestion — invalid question at index:',
                    currentQuestion
                );
                return;
            }
            if (!answers[q.id]) {
                alert('Please answer the question before continuing.');
                return;
            }

            if (currentQuestion >= FULL_SET.length - 1) {
                completeAssessment();
                return;
            }

            await saveDraftIfNeeded();
            currentQuestion += 1;
            renderQuestion();
            updateAnswerOptionStyles();
        }

        async function completeAssessment() {
            const content = document.getElementById('assessmentContent');
            content.innerHTML = `
                <div class="assessment-loading">
                    <p style="font-size:1.15rem;font-weight:700;margin:0 0 0.7rem 0;">Submitting assessment…</p>
                    <p style="margin:0;color:var(--text-light);">Please wait while KinderCura calculates the result.</p>
                </div>
            `;

            try {
                const data = await apiFetch('/assessments/submit', {
                    method: 'POST',
                    body: JSON.stringify({
                        assessmentId,
                        childId: selectedChild.id,
                        answers: getAnswerPayload(),
                        customAnswers: getCustomAnswerPayload()
                    })
                });

                if (data.assessmentId) {
                    localStorage.setItem('kc_assessmentId', data.assessmentId);
                }

                // Important: after finishing the assessment, return the parent to the dashboard first.
                // The latest result will still appear in Dashboard, Results, and Recommendations.
                window.location.href = '/parent/dashboard.html';
            } catch (e) {
                content.innerHTML = `
                    <div class="assessment-error">
                        <p style="color:red;font-weight:700;margin:0 0 0.9rem 0;">Submission failed: ${e.message}</p>
                        <button type="button" class="assessment-action-btn primary" onclick="completeAssessment()" style="max-width:220px;">Retry</button>
                    </div>
                `;
            }
        }

        async function initAssessment() {
            const content = document.getElementById('assessmentContent');
            content.innerHTML = `
                <div class="assessment-loading">
                    <p style="margin:0;font-weight:700;">Loading assessment…</p>
                </div>
            `;

            try {
                selectedChild = await getSelectedChild();
                if (!selectedChild) {
                    alert('No child registered. Please complete your profile first.');
                    window.location.href = '/parent/profile.html';
                    return;
                }

                const ageMonths = getAgeInMonths(selectedChild.dateOfBirth);
                if (isNaN(ageMonths) || ageMonths < 36) {
                    alert('This assessment is available for children aged 3 to 8 only.');
                    window.location.href = '/parent/dashboard.html';
                    return;
                }

                QUESTION_SET = buildQuestionSet(selectedChild);

                if (!Array.isArray(QUESTION_SET) || !QUESTION_SET.length) {
                    console.error(
                        '[SCREENING] No questions matched for child age:',
                        getAgeInMonths(selectedChild.dateOfBirth)
                    );
                    content.innerHTML = `
                        <div class="assessment-error">
                            <p>No assessment questions are available for this child's age. Please contact support.</p>
                            <button
                                type="button"
                                class="assessment-action-btn primary"
                                onclick="window.location.href='/parent/dashboard.html'"
                                style="max-width:220px;"
                            >
                                Back to Dashboard
                            </button>
                        </div>
                    `;
                    return;
                }

                // Important: create the backend assessment record first so the answers still save correctly.
                const initData = await apiFetch('/assessments/initialize', {
                    method: 'POST',
                    body: JSON.stringify({ childId: selectedChild.id })
                });
                assessmentId = initData.assessmentId;
                CUSTOM_QUESTION_SET = Array.isArray(initData.customQuestions) ? initData.customQuestions : [];
                buildFullSet();

                const exactAge = formatExactAge(selectedChild.dateOfBirth);
                const ageRange = getAgeRangeLabel(ageMonths);
                // Show the COMPLETE reassessment question count (FULL_SET) up front,
                // not just the core checklist count — previously this text read e.g.
                // "20 questions + 1 pediatrician question", which read like the total
                // was still 20. The breakdown is kept for transparency, but the
                // headline number now matches what "Question X of Y" below counts.
                const totalQuestions = FULL_SET.length;
                const breakdown = CUSTOM_QUESTION_SET.length
                    ? ` (${QUESTION_SET.length} core + ${CUSTOM_QUESTION_SET.length} pediatrician)`
                    : '';
                document.getElementById('assessmentMeta').textContent = `Interview-based checklist loaded for age ${exactAge} • ${totalQuestions} questions${breakdown}`;
                document.getElementById('ageRangeLabel').textContent = ageRange;
                document.getElementById('ageRangeDetails').innerHTML = `Current child age: ${exactAge}<br>Question set for this child: ${totalQuestions}${breakdown}`;

                updateProgress();
                renderQuestion();
                updateAnswerOptionStyles();
            } catch (e) {
                console.error('Assessment init error:', e);
                content.innerHTML = `
                    <div class="assessment-error">
                        <p style="color:red;font-weight:700;margin:0 0 0.9rem 0;">Failed to load the assessment: ${e.message}</p>
                        <button type="button" class="assessment-action-btn primary" onclick="initAssessment()" style="max-width:220px;">Retry</button>
                    </div>
                `;
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            if (typeof initNav === 'function') initNav();
            initAssessment();
        });
