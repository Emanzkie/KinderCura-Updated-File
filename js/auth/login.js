// === Extracted from SIGN-UP,LOGIN\login.html (script block 1) ===
const API = window.location.origin + '/api';
// Uses the current site origin so the same code works on localhost and when deployed.

        // Important: keep the login page visible first.
        // Before, this page auto-redirected when a session existed, which made the landing-page Login button jump straight to a dashboard.
        const existingToken = localStorage.getItem('kc_token');
        const existingUser = (() => {
            try {
                return JSON.parse(localStorage.getItem('kc_user'));
            } catch {
                return null;
            }
        })();

        if (existingToken && existingUser) {
            const sessionMsg = document.getElementById('sessionMsg');
            sessionMsg.style.display = 'block';
            sessionMsg.innerHTML = `You already have an active session as <strong>${existingUser.role}</strong>. You may sign in to another account, or continue using your current session.`;
        }

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('submitBtn');
            const err = document.getElementById('errorMsg');
            err.style.display = 'none';
            btn.textContent = 'Signing in…';
            btn.disabled = true;

            try {
                const res = await fetch(`${API}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify((() => {
                        const identifier = document.getElementById('identifier').value.trim();
                        const isEmail = identifier.includes('@');
                        return {
                            email: isEmail ? identifier : '',
                            username: isEmail ? '' : identifier,
                            password: document.getElementById('password').value
                        };
                    })())
                });
                const data = await res.json();

                if (!res.ok) throw new Error(data.error || 'Login failed.');

                // Save session to localStorage
                localStorage.setItem('kc_token', data.token);
                localStorage.setItem('kc_user', JSON.stringify(data.user));
                if (data.childId) localStorage.setItem('kc_childId', data.childId);

                // Redirect based on role after successful sign-in
                // Support ?next= parameter for flow continuations (e.g. guardians or accept-invitation)
                const nextUrl = (() => {
                  try {
                    const p = new URLSearchParams(window.location.search).get('next');
                    return p ? decodeURIComponent(p) : null;
                  } catch { return null; }
                })();

                if (nextUrl && (nextUrl.startsWith('/') || nextUrl.startsWith(window.location.origin))) {
                  window.location.href = nextUrl;
                  return;
                }

                // Important: 'secretary' gets their own dedicated dashboard, not the pedia one.
                if (data.user.role === 'admin') {
                    window.location.href = '/admin/admin-dashboard.html';
                } else if (data.user.role === 'pediatrician') {
                    window.location.href = '/pedia/pediatrician-dashboard.html';
                } else if (data.user.role === 'secretary') {
                    // Secretary goes to the clinic secretary dashboard
                    window.location.href = '/secretary/secretary-dashboard.html';
                } else {
                    // First parent login should continue to the required pre-assessment.
                    if (data.needsPreAssessment) {
                        localStorage.setItem('kc_preAssessmentRequired', 'true');
                        if (data.preAssessmentChildId || data.childId) {
                            localStorage.setItem('kc_childId', data.preAssessmentChildId || data.childId);
                        }
                        localStorage.removeItem('kc_assessmentId');
                        window.location.href = `/parent/screening.html?mode=pre&source=login&childId=${encodeURIComponent(data.preAssessmentChildId || data.childId || '')}`;
                    } else {
                        localStorage.removeItem('kc_preAssessmentRequired');
                        window.location.href = '/parent/dashboard.html';
                    }
                }

            } catch (error) {
                err.textContent = error.message || 'Cannot connect to server. Make sure the server is running.';
                err.style.display = 'block';
                btn.textContent = 'Sign In';
                btn.disabled = false;
            }
        });
