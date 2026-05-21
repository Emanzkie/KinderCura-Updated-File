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
            event.target.style.background = 'var(--bg-primary)';
            event.target.style.color = 'var(--text-dark)';

            // Load family data when tab is selected
            if (tab === 'family') {
                loadFamilyTabData();
            }
        }

        function toggleProfileMenu() {
            const menu = document.getElementById('profileMenu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }

        function openNotifications() {
            document.getElementById('notificationsModal').style.display = 'flex';
        }

        function closeNotifications() {
            document.getElementById('notificationsModal').style.display = 'none';
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.profile-btn')) {
                document.getElementById('profileMenu').style.display = 'none';
            }
        });

        // ── Family Management ──────────────────────────────────────────

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
                const api = typeof apiFetch === 'function' ? apiFetch : (ep) => {
                    const headers = { 'Content-Type': 'application/json' };
                    const t = localStorage.getItem('kc_token') || localStorage.getItem('token') || '';
                    if (t) headers['Authorization'] = 'Bearer ' + t;
                    return fetch('/api' + ep, { headers }).then(r => r.json());
                };
                const data = await api('/children');
                const children = Array.isArray(data.children) ? data.children : [];
                const currentVal = sel.value;
                sel.innerHTML = '<option value="">-- Select a child --</option>' +
                    children.map(c => `<option value="${c.id}">${c.firstName} ${c.lastName}</option>`).join('');
                if (currentVal && children.some(c => c.id === currentVal)) {
                    sel.value = currentVal;
                }
            } catch (err) {
                console.error('Failed to load children:', err);
            }
        }

        async function loadFamilyMembers() {
            const list = document.getElementById('familyLinkedList');
            const sel = document.getElementById('familyChildSelect');
            const childId = sel ? sel.value : '';
            if (!childId || !list) {
                if (list) list.innerHTML = '<p style="color: var(--text-light);">Select a child to view linked family members.</p>';
                return;
            }
            list.innerHTML = '<p style="color: var(--text-light);">Loading...</p>';
            try {
                const headers = { 'Content-Type': 'application/json' };
                const t = localStorage.getItem('kc_token') || localStorage.getItem('token') || '';
                if (t) headers['Authorization'] = 'Bearer ' + t;
                const res = await fetch('/api/v2/guardians/children/' + encodeURIComponent(childId) + '/guardians', { headers });
                const data = await res.json();
                if (!data.success || !Array.isArray(data.guardians)) {
                    list.innerHTML = '<p style="color: var(--text-light);">No linked guardians found.</p>';
                    return;
                }
                if (!data.guardians.length) {
                    list.innerHTML = '<p style="color: var(--text-light);">No linked family members for this child.</p>';
                    return;
                }
                list.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;">' +
                    '<thead><tr style="background:var(--bg-primary);">' +
                    '<th style="padding:8px;text-align:left;">Name</th>' +
                    '<th style="padding:8px;text-align:left;">Email</th>' +
                    '<th style="padding:8px;text-align:left;">Role</th>' +
                    '<th style="padding:8px;text-align:left;">Status</th>' +
                    '</tr></thead><tbody>' +
                    data.guardians.map(g => {
                        const relLabel = g.role ? g.role.charAt(0).toUpperCase() + g.role.slice(1).replace(/_/g, ' ') : 'Guardian';
                        const statusColor = g.status === 'active' ? '#27ae60' : '#c0392b';
                        return '<tr style="border-top:1px solid var(--border);">' +
                            '<td style="padding:8px;">' + (g.name || '—') + '</td>' +
                            '<td style="padding:8px;">' + (g.email || '—') + '</td>' +
                            '<td style="padding:8px;">' + relLabel + '</td>' +
                            '<td style="padding:8px;"><span style="padding:2px 8px;border-radius:12px;font-size:0.8rem;background:' + (g.status === 'active' ? '#e8f5e9' : '#ffebee') + ';color:' + statusColor + ';">' + g.status + '</span></td>' +
                            '</tr>';
                    }).join('') +
                    '</tbody></table>';
            } catch (err) {
                list.innerHTML = '<p style="color: var(--text-light);">Failed to load family members.</p>';
                console.error('loadFamilyMembers error:', err);
            }
        }

        async function createFamilyAccount() {
            const msg = document.getElementById('createAccountMsg');
            msg.textContent = '';
            const firstName = document.getElementById('famFirstName')?.value?.trim();
            const lastName = document.getElementById('famLastName')?.value?.trim();
            const email = document.getElementById('famEmail')?.value?.trim();
            const password = document.getElementById('famPassword')?.value;
            const relationship = document.getElementById('famRelationship')?.value || 'parent';
            const permissionPreset = document.getElementById('famPermissionPreset')?.value || 'standard';
            const childId = document.getElementById('familyChildSelect')?.value;

            if (!firstName || !lastName) { msg.textContent = 'First and last name are required.'; msg.style.color = '#c0392b'; return; }
            if (!email) { msg.textContent = 'Email is required.'; msg.style.color = '#c0392b'; return; }
            if (!password || password.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; msg.style.color = '#c0392b'; return; }
            if (!childId) { msg.textContent = 'Select a child first.'; msg.style.color = '#c0392b'; return; }

            try {
                const headers = { 'Content-Type': 'application/json' };
                const t = localStorage.getItem('kc_token') || localStorage.getItem('token') || '';
                if (t) headers['Authorization'] = 'Bearer ' + t;
                const res = await fetch('/api/v2/guardians/create-account', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ firstName, lastName, email, password, relationship, childIds: [childId], permissionPreset }),
                });
                const data = await res.json();
                if (!res.ok) {
                    msg.textContent = data.error || 'Failed to create account.';
                    msg.style.color = '#c0392b';
                    return;
                }
                msg.textContent = data.message || 'Account created successfully!';
                msg.style.color = '#27ae60';
                document.getElementById('famFirstName').value = '';
                document.getElementById('famLastName').value = '';
                document.getElementById('famEmail').value = '';
                document.getElementById('famPassword').value = '';
                // Refresh the linked family members list
                await loadFamilyMembers();
            } catch (err) {
                msg.textContent = 'Network error. Try again.';
                msg.style.color = '#c0392b';
                console.error('createFamilyAccount error:', err);
            }
        }
