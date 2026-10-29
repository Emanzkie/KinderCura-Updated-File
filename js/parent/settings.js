// === Extracted from PARENT\settings.html (script block 1) ===
function switchTab(tab) {
            // Hide all tabs
            document.querySelectorAll('[id$="-tab"]').forEach(el => el.style.display = 'none');
            // Show selected tab
            document.getElementById(tab + '-tab').style.display = 'block';
            
            // Update button styles
            document.querySelectorAll('.settings-tab').forEach(btn => {
                btn.style.background = 'transparent';
                btn.style.color = 'var(--text-light)';
            });
            // The click can land on the icon inside the button; style the button itself.
            const tabBtn = event && event.target && event.target.closest ? event.target.closest('.settings-tab') : null;
            if (tabBtn) {
                tabBtn.style.background = 'var(--bg-primary)';
                tabBtn.style.color = 'var(--text-dark)';
            }

            // Load family data when tab is selected
            if (tab === 'family') {
                loadFamilyTabData();
            }
            if (tab === 'notifications') loadAssessmentReminders();
        }

        function toggleProfileMenu() {
            const menu = document.getElementById('profileMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.profile-btn')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

        // ── Family Management ──────────────────────────────────────────

        function famEscape(value) {
            return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        }

        function famHeaders(json) {
            const headers = {};
            if (json) headers['Content-Type'] = 'application/json';
            const t = localStorage.getItem('kc_token') || localStorage.getItem('token') || '';
            if (t) headers['Authorization'] = 'Bearer ' + t;
            return headers;
        }

        const FAM_RELATIONSHIP_LABELS = {
            mother: 'Mother', father: 'Father', grandparent: 'Grandparent', legal_guardian: 'Legal Guardian',
            foster_parent: 'Foster Parent', court_appointed: 'Court-Appointed', nanny: 'Nanny / Babysitter',
            babysitter: 'Babysitter', therapist: 'Therapist', teacher: 'Teacher', other: 'Other',
        };

        function setFamilyMsg(text, kind) {
            const msg = document.getElementById('createAccountMsg');
            if (!msg) return;
            msg.textContent = text || '';
            msg.className = 'gm-inline-msg' + (kind ? ' is-' + kind : '');
        }

        async function loadFamilyTabData() {
            const user = typeof KC !== 'undefined' ? KC.user() : null;
            if (!user || (user.role !== 'parent' && user.role !== 'legal_guardian')) {
                document.getElementById('family-tab').innerHTML = '<p>Family management is only available for parent accounts.</p>';
                return;
            }
            await populateFamilyChildSelect();
            await loadFamilyMembers();
        }

        async function populateFamilyChildSelect() {
            const sel = document.getElementById('familyChildSelect');
            if (!sel) return;
            try {
                const res = await fetch('/api/children', { headers: famHeaders(false) });
                const data = await res.json();
                const children = Array.isArray(data.children) ? data.children : [];
                const previous = sel.value || localStorage.getItem('kc_childId') || '';
                if (!children.length) {
                    sel.innerHTML = '<option value="">No child registered yet</option>';
                    return;
                }
                sel.innerHTML = children.map(c => `<option value="${famEscape(c.id)}">${famEscape(c.firstName)} ${famEscape(c.lastName)}</option>`).join('');
                // Same child the rest of the Parent side has selected, else the first one.
                sel.value = children.some(c => c.id === previous) ? previous : children[0].id;
            } catch (err) {
                console.error('Failed to load children:', err);
            }
        }

        async function loadFamilyMembers() {
            const list = document.getElementById('familyLinkedList');
            const sel = document.getElementById('familyChildSelect');
            const childId = sel ? sel.value : '';
            if (!list) return;
            if (!childId) {
                list.innerHTML = '<p class="gm-empty">Select a child to view linked family members.</p>';
                return;
            }
            list.innerHTML = '<p class="gm-empty">Loading…</p>';
            try {
                const res = await fetch('/api/v2/guardians/children/' + encodeURIComponent(childId) + '/guardians', { headers: famHeaders(false) });
                const data = await res.json().catch(() => ({}));
                if (res.status === 403) {
                    list.innerHTML = '<p class="gm-empty">Only this child\'s primary parent or guardian can manage family members.</p>';
                    return;
                }
                if (!res.ok || !data.success || !Array.isArray(data.guardians)) {
                    list.innerHTML = '<p class="gm-empty">Could not load family members. Please try again.</p>';
                    return;
                }
                if (!data.guardians.length) {
                    list.innerHTML = '<p class="gm-empty">No linked family members for this child.</p>';
                    return;
                }
                // .table-scroll keeps a wide guardian table scrolling inside
                // its own box on a phone instead of widening the page.
                list.innerHTML = '<div class="table-scroll"><table class="gm-table gm-table--stack">' +
                    '<thead><tr><th>Name</th><th>Relationship</th><th>Status</th></tr></thead><tbody>' +
                    data.guardians.map(g => {
                        const relLabel = g.relationshipLabel || FAM_RELATIONSHIP_LABELS[g.relationship] ||
                            (g.role ? g.role.charAt(0).toUpperCase() + g.role.slice(1).replace(/_/g, ' ') : 'Guardian');
                        const status = String(g.status || '');
                        return '<tr>' +
                            '<td data-label="Name"><span class="gm-person"><strong>' + famEscape(g.name || '—') + '</strong><span>' + famEscape(g.email || '') + '</span></span></td>' +
                            '<td data-label="Relationship">' + famEscape(relLabel) + '</td>' +
                            '<td data-label="Status"><span class="gm-badges"><span class="gm-status gm-status--' + famEscape(status) + '">' +
                                famEscape(status.charAt(0).toUpperCase() + status.slice(1)) + '</span>' +
                                (g.isPrimary ? '<span class="gm-status gm-status--primary">Primary</span>' : '') + '</span></td>' +
                            '</tr>';
                    }).join('') +
                    '</tbody></table></div>';
            } catch (err) {
                list.innerHTML = '<p class="gm-empty">Failed to load family members.</p>';
                console.error('loadFamilyMembers error:', err);
            }
        }

        let _creatingFamilyAccount = false;

        async function createFamilyAccount(e) {
            if (e && e.preventDefault) e.preventDefault();
            if (_creatingFamilyAccount) return; // ignore double clicks while the request runs
            setFamilyMsg('');
            const firstName = document.getElementById('famFirstName')?.value?.trim();
            const lastName = document.getElementById('famLastName')?.value?.trim();
            const email = document.getElementById('famEmail')?.value?.trim();
            const password = document.getElementById('famPassword')?.value;
            const relationship = document.getElementById('famRelationship')?.value || 'other';
            const permissionPreset = document.getElementById('famPermissionPreset')?.value || 'standard';
            const childId = document.getElementById('familyChildSelect')?.value;

            if (!childId) return setFamilyMsg('Select a child first.', 'error');
            if (!firstName || !lastName) return setFamilyMsg('First and last name are required.', 'error');
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setFamilyMsg('Enter a valid email address.', 'error');
            if (!password || password.length < 8) return setFamilyMsg('Password must be at least 8 characters.', 'error');

            const btn = document.getElementById('createAccountBtn');
            _creatingFamilyAccount = true;
            if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
            try {
                const res = await fetch('/api/v2/guardians/create-account', {
                    method: 'POST',
                    headers: famHeaders(true),
                    body: JSON.stringify({ firstName, lastName, email, password, relationship, childIds: [childId], permissionPreset }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setFamilyMsg(data.error || 'Failed to create account.', 'error');
                    return;
                }
                setFamilyMsg(data.message || 'Account created successfully!', data.emailSent === false ? 'error' : 'success');
                ['famFirstName', 'famLastName', 'famEmail', 'famPassword'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                // Refresh the linked family members list
                await loadFamilyMembers();
            } catch (err) {
                setFamilyMsg('Network error. Try again.', 'error');
                console.error('createFamilyAccount error:', err);
            } finally {
                _creatingFamilyAccount = false;
                if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
            }
        }

        // ── Account / Notification / Privacy preferences ───────────────

        // Checkbox id -> preference key in /auth/me and /auth/update-profile.
        // emailAppointments turns appointment emails on/off (routes/appointments.js).
        // researchParticipation is the sign-up machine-learning consent; the
        // admin training export only uses screenings when it is on.
        const NOTIFICATION_PREF_INPUTS = {
            prefEmailAppointments: 'emailAppointments',
        };
        const PRIVACY_PREF_INPUTS = {
            prefResearchParticipation: 'researchParticipation',
        };

        function fillPrefInputs(map, values) {
            Object.entries(map).forEach(([id, key]) => {
                const input = document.getElementById(id);
                if (input && values && typeof values[key] === 'boolean') input.checked = values[key];
            });
        }

        function readPrefInputs(map) {
            const out = {};
            Object.entries(map).forEach(([id, key]) => {
                const input = document.getElementById(id);
                if (input) out[key] = input.checked;
            });
            return out;
        }

        function setPrefMsg(id, text, isError) {
            const msg = document.getElementById(id);
            if (!msg) return;
            msg.textContent = text;
            msg.style.color = isError ? 'var(--text-dark)' : 'var(--text-light)';
            msg.style.fontWeight = isError ? '600' : '';
        }

        async function loadAccountSettings() {
            if (typeof requireAuth === 'function' && !requireAuth()) return;
            try {
                const data = await apiFetch('/auth/me');
                const user = data.user || {};
                const email = document.getElementById('settingsEmail');
                if (email) email.value = user.email || '';
                fillPrefInputs(NOTIFICATION_PREF_INPUTS, user.notificationSettings);
                fillPrefInputs(PRIVACY_PREF_INPUTS, user.privacySettings);
            } catch (err) {
                setPrefMsg('notificationPrefsMsg', 'Could not load your saved preferences.', true);
                setPrefMsg('privacyPrefsMsg', 'Could not load your saved preferences.', true);
            }
        }

        async function savePrefs(field, map, btnId, msgId) {
            const btn = document.getElementById(btnId);
            if (btn) btn.disabled = true;
            setPrefMsg(msgId, 'Saving…');
            try {
                const data = await apiFetch('/auth/update-profile', {
                    method: 'PUT',
                    body: JSON.stringify({ [field]: readPrefInputs(map) }),
                });
                fillPrefInputs(map, data.user && data.user[field]);
                setPrefMsg(msgId, 'Saved.');
            } catch (err) {
                setPrefMsg(msgId, err.message || 'Could not save. Please try again.', true);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        function saveNotificationPrefs() {
            return savePrefs('notificationSettings', NOTIFICATION_PREF_INPUTS, 'saveNotificationPrefsBtn', 'notificationPrefsMsg');
        }

        function savePrivacyPrefs() {
            return savePrefs('privacySettings', PRIVACY_PREF_INPUTS, 'savePrivacyPrefsBtn', 'privacyPrefsMsg');
        }

        // ── Assessment Reminders (Notifications tab) ─────────────────────────
        // One recurring reminder per child, kept by /api/reminders/assessment.
        // The server works out the next dates; the daily reminder job sends them.
        let assessmentReminderChildren = [];
        let assessmentReminderBusy = false;

        function arDate(ymd) {
            return ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
        }

        function arOrdinal(n) {
            const s = ['th', 'st', 'nd', 'rd'];
            const v = n % 100;
            return n + (s[(v - 20) % 10] || s[v] || s[0]);
        }

        function arSelected() {
            const id = document.getElementById('arChild')?.value;
            return assessmentReminderChildren.find((c) => c.childId === id) || null;
        }

        function arMsg(text, isError) {
            const el = document.getElementById('arMsg');
            if (!el) return;
            el.textContent = text || '';
            el.style.color = isError ? 'var(--status-attention-fg)' : 'var(--text-light)';
        }

        async function loadAssessmentReminders() {
            const sel = document.getElementById('arChild');
            if (!sel) return;
            const day = document.getElementById('arDay');
            if (day && !day.options.length) {
                day.innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${arOrdinal(i + 1)}</option>`).join('');
            }
            try {
                const data = await apiFetch('/reminders/assessment');
                assessmentReminderChildren = Array.isArray(data.children) ? data.children : [];
                const previous = sel.value || localStorage.getItem('kc_childId') || '';
                if (!assessmentReminderChildren.length) {
                    sel.innerHTML = '<option value="">No child registered yet</option>';
                    renderAssessmentReminder();
                    return;
                }
                sel.innerHTML = assessmentReminderChildren
                    .map((c) => `<option value="${escapeHtml(c.childId)}">${escapeHtml(c.childName || 'Child')}</option>`).join('');
                sel.value = assessmentReminderChildren.some((c) => c.childId === previous) ? previous : assessmentReminderChildren[0].childId;
                renderAssessmentReminder();
            } catch (err) {
                document.getElementById('arStatus').textContent = err.message || 'Could not load assessment reminders.';
            }
        }

        function renderAssessmentReminder() {
            const child = arSelected();
            const r = child && child.reminder;
            const status = document.getElementById('arStatus');
            const pauseBtn = document.getElementById('arPauseBtn');
            const offBtn = document.getElementById('arOffBtn');
            arMsg('');
            if (!child) {
                status.textContent = 'Add a child first to set an assessment reminder.';
                pauseBtn.style.display = 'none';
                offBtn.style.display = 'none';
                return;
            }
            document.getElementById('arFrequency').value = String(r ? r.frequencyMonths : 1);
            document.getElementById('arDay').value = String(r ? r.dayOfMonth : 1);
            document.getElementById('arLead').value = String(r ? r.leadDays : 0);
            pauseBtn.style.display = r ? '' : 'none';
            offBtn.style.display = r ? '' : 'none';
            if (!r) {
                status.textContent = `Off. Set a schedule below to get reminders for ${child.childName}.`;
                return;
            }
            const every = r.frequencyMonths === 1 ? 'every month' : `every ${r.frequencyMonths} months`;
            const when = r.leadDays === 0 ? 'on the day' : `${r.leadDays} day${r.leadDays === 1 ? '' : 's'} before`;
            pauseBtn.textContent = r.status === 'paused' ? 'Resume' : 'Pause';
            status.textContent = r.status === 'paused'
                ? `Paused: ${every} on the ${arOrdinal(r.dayOfMonth)}, ${when}. Resume to get reminders again.`
                : `Active: ${every} on the ${arOrdinal(r.dayOfMonth)}, ${when}. Next reminder: ${arDate(r.nextReminderDate)} (assessment due ${arDate(r.nextDueDate)}).`;
        }

        async function putAssessmentReminder(status, doneText) {
            const child = arSelected();
            if (!child || assessmentReminderBusy) return;
            assessmentReminderBusy = true;
            arMsg('Saving…');
            try {
                const data = await apiFetch(`/reminders/assessment/${encodeURIComponent(child.childId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        frequencyMonths: Number(document.getElementById('arFrequency').value),
                        dayOfMonth: Number(document.getElementById('arDay').value),
                        leadDays: Number(document.getElementById('arLead').value),
                        status,
                    }),
                });
                child.reminder = data.reminder;
                renderAssessmentReminder();
                arMsg(doneText);
            } catch (err) {
                arMsg(err.message || 'Could not save the reminder.', true);
            } finally {
                assessmentReminderBusy = false;
            }
        }

        function saveAssessmentReminder() {
            const current = arSelected()?.reminder;
            return putAssessmentReminder(current && current.status === 'paused' ? 'paused' : 'active', 'Reminder saved.');
        }

        function toggleAssessmentReminderPause() {
            const current = arSelected()?.reminder;
            if (!current) return;
            const resume = current.status === 'paused';
            return putAssessmentReminder(resume ? 'active' : 'paused', resume ? 'Reminder resumed.' : 'Reminder paused.');
        }

        async function turnOffAssessmentReminder() {
            const child = arSelected();
            if (!child || !child.reminder || assessmentReminderBusy) return;
            if (!window.confirm(`Turn off assessment reminders for ${child.childName}?`)) return;
            assessmentReminderBusy = true;
            try {
                await apiFetch(`/reminders/assessment/${encodeURIComponent(child.childId)}`, { method: 'DELETE' });
                child.reminder = null;
                renderAssessmentReminder();
                arMsg('Reminder turned off.');
            } catch (err) {
                arMsg(err.message || 'Could not turn off the reminder.', true);
            } finally {
                assessmentReminderBusy = false;
            }
        }

        loadAccountSettings();
