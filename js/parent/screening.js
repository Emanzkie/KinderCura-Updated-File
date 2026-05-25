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

        function updateAnswerOptionStyles() {
            const q = QUESTION_SET?.[currentQuestion];
            if (!q) return;
            document.querySelectorAll('.answer-option').forEach(option => {
                option.classList.toggle('is-selected', answers[q.id] === option.dataset.answer);
            });
        }

        function updateProgress() {
            const totals = Object.fromEntries(DOMAIN_ORDER.map(d => [d.key, 0]));
            const answered = Object.fromEntries(DOMAIN_ORDER.map(d => [d.key, 0]));

            QUESTION_SET.forEach(q => {
                totals[q.scoreDomain] += 1;
                if (answers[q.id]) answered[q.scoreDomain] += 1;
            });

            DOMAIN_ORDER.forEach(domain => {
                const total = totals[domain.key] || 0;
                const done = answered[domain.key] || 0;
                document.getElementById(domain.progressId).textContent = `${done}/${total}`;
                document.getElementById(domain.barId).style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
            });

            const overallPercent = Math.round((Object.keys(answers).length / Math.max(QUESTION_SET.length, 1)) * 100);
            document.getElementById('overall-progress').textContent = `${overallPercent}%`;
            const overallBar = document.getElementById('overall-bar');
            if (overallBar) overallBar.style.width = `${overallPercent}%`;
        }

        function renderQuestion() {
            const q = QUESTION_SET?.[currentQuestion];
            const content = document.getElementById('assessmentContent');

            if (!q) {
                console.error(
                    '[SCREENING] Invalid question index:',
                    currentQuestion,
                    'total:',
                    QUESTION_SET.length
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
            const isLast = currentQuestion === QUESTION_SET.length - 1;

            content.innerHTML = `
                <section class="assessment-question-card question-card">
                    <div class="assessment-question-header">
                        <p class="assessment-counter">Question ${currentQuestion + 1} of ${QUESTION_SET.length}</p>
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
            const q = QUESTION_SET?.[currentQuestion];
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
            const answeredCount = Object.keys(answers).length;
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
            const q = QUESTION_SET?.[currentQuestion];
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

            if (currentQuestion >= QUESTION_SET.length - 1) {
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
                        answers: getAnswerPayload()
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

                const exactAge = formatExactAge(selectedChild.dateOfBirth);
                const ageRange = getAgeRangeLabel(ageMonths);
                document.getElementById('assessmentMeta').textContent = `Interview-based checklist loaded for age ${exactAge} • ${QUESTION_SET.length} questions`;
                document.getElementById('ageRangeLabel').textContent = ageRange;
                document.getElementById('ageRangeDetails').innerHTML = `Current child age: ${exactAge}<br>Question set for this child: ${QUESTION_SET.length}`;

                // Important: create the backend assessment record first so the answers still save correctly.
                const initData = await apiFetch('/assessments/initialize', {
                    method: 'POST',
                    body: JSON.stringify({ childId: selectedChild.id })
                });
                assessmentId = initData.assessmentId;

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
