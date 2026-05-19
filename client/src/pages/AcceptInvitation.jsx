import React, { useEffect, useState, useMemo, useCallback } from 'react';

const TOKEN_KEY = 'kc_token';
const FETCH_TIMEOUT_MS = 10000;

function getToken() {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(TOKEN_KEY) || localStorage.getItem('token') || '';
  const t = String(raw || '').trim();
  if (!t || t === 'null' || t === 'undefined') return null;
  return t;
}

function isLoggedIn() {
  return !!getToken().trim();
}

function isExpired(inv) {
  return !!inv?.expiresAt && new Date(inv.expiresAt) < new Date();
}

function logApiRequest({ endpoint, method, headers }) {
  console.group(`[REQ] ${method} ${endpoint}`);
  console.log('Authorization header present:', !!headers?.Authorization);
  console.log('Headers:', { ...headers, Authorization: headers?.Authorization ? 'Bearer [REDACTED]' : undefined });
  console.groupEnd();
}

function logApiCall({ endpoint, method, hasToken, status, body, error }) {
  console.group(`[API] ${method} ${endpoint}`);
  console.log('Token present:', hasToken);
  console.log('Response status:', status);
  if (body) console.log('Response body:', body);
  if (error) console.log('Error:', error);
  console.groupEnd();
}

async function tryRefreshToken() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.success && data.token) {
      localStorage.setItem('kc_token', data.token);
      return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

async function handleAuthFailure() {
  if (typeof window === 'undefined') return;
  const newToken = await tryRefreshToken();
  if (newToken) {
    window.location.reload();
    return;
  }
  localStorage.removeItem('kc_token');
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = '/login.html?next=' + next;
}

function authErrorToast(status) {
  if (status === 400) return 'Bad request. Please check your input and try again.';
  if (status === 401 || status === 403) return 'Your session has expired. Please log in again.';
  if (status === 404) return 'Resource not found. It may have been removed.';
  if (status === 429) return 'Invitation limit reached. Try again tomorrow.';
  if (status >= 500) return 'Server error. Please try again later.';
  return null;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

const RELATIONSHIP_LABELS = {
  mother: 'Mother', father: 'Father', grandparent: 'Grandparent',
  legal_guardian: 'Legal Guardian', foster_parent: 'Foster Parent',
  court_appointed: 'Court-Appointed', nanny: 'Nanny / Babysitter',
  therapist: 'Therapist', teacher: 'Teacher', other: 'Other',
};

const PERMISSION_LABELS = {
  viewAssessments: 'View Assessments & Results',
  submitAssessments: 'Submit Assessments',
  viewResults: 'View Assessment Results',
  uploadDocuments: 'Upload Documents & Photos',
  manageAppointments: 'Manage Appointments',
  viewMedicalRecords: 'View Medical Records',
  modifyChild: 'Modify Child Profile',
  inviteGuardians: 'Invite Other Guardians',
  revokeAccess: 'Revoke Access',
  viewMessages: 'View Chat Messages',
  sendMessages: 'Send Messages',
  viewNotifications: 'View Notifications',
};

export default function AcceptInvitation() {
  const [state, setState] = useState('init');
  const [inv, setInv] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const rawCode = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || params.get('code') || '';
  }, []);

  const TERMINAL_STATES = new Set(['valid', 'expired', 'already_accepted', 'invalid_link', 'error', 'accepted', 'unauthenticated']);
  const MAX_RETRIES = 3;

  // Token validation state machine
  useEffect(() => {
    if (!rawCode.trim()) {
      setState('invalid_link');
      return;
    }
    if (!isLoggedIn()) {
      setState('unauthenticated');
      return;
    }

    let cancelled = false;
    let retries = 0;
    let safetyActive = true;
    const VERIFY_SAFETY_TIMEOUT_MS = 10000;
    const safetyTimer = setTimeout(() => {
      if (cancelled || !safetyActive) return;
      safetyActive = false;
      cancelled = true;
      setState('error');
      setErrMsg('Verification timed out. Please reload and try again.');
    }, VERIFY_SAFETY_TIMEOUT_MS);

    (async function verify() {
      setState('verifying');
      try {
        const endpoint = `/api/v2/guardians/verify/${encodeURIComponent(rawCode.trim())}`;
        const method = 'GET';
        const reqHeaders = { Authorization: `Bearer ${getToken()}` };
        logApiRequest({ endpoint, method, headers: reqHeaders });
        const res = await fetchWithTimeout(endpoint);
        const body = await res.json();
        logApiCall({ endpoint, method, hasToken: !!getToken(), status: res.status, body: res.ok ? undefined : body });

        if (cancelled) return;

        if (!res.ok || !body.success) {
          if (res.status === 401 || res.status === 403) {
            handleAuthFailure();
            return;
          }
          if (res.status === 410 || isExpired(body?.invitation)) {
            setState('expired');
          } else if (res.status === 409) {
            setState('already_accepted');
          } else if (res.status === 404) {
            setState('invalid_link');
          } else {
            setState('error');
          }
          setErrMsg(body.error || 'Could not verify invitation.');
          safetyActive = false;
          return;
        }

        if (isExpired(body.invitation)) {
          setState('expired');
          setErrMsg('This invitation has expired.');
          safetyActive = false;
          return;
        }

        setInv(body.invitation || body);
        setState('valid');
        safetyActive = false;
      } catch (err) {
        if (cancelled) return;
        retries++;
        if (retries <= MAX_RETRIES) {
          const delay = Math.min(500 * Math.pow(2, retries - 1), 2000);
          await new Promise((r) => setTimeout(r, delay));
          if (cancelled) return;
          return verify();
        }
        safetyActive = false;
        if (err.name === 'AbortError') {
          setState('error');
          setErrMsg('Request timed out. Please check your internet and reload.');
        } else if (err.name === 'SyntaxError') {
          setState('error');
          setErrMsg('Unexpected response from server. Please try again.');
        } else {
          setState('error');
          setErrMsg('Network error. Please check your connection and try again.');
        }
      }
    })();

    return () => { clearTimeout(safetyTimer); cancelled = true; safetyActive = false; };
  }, [rawCode]);

  const handleAccept = useCallback(async () => {
    if (busy || state !== 'valid') return;
    setBusy(true);

    let retries = 0;
    let acceptCancelled = false;
    const MAX_ACCEPT_RETRIES = 2;
    const ACCEPT_SAFETY_TIMEOUT_MS = 10000;
    const acceptSafetyTimer = setTimeout(() => {
      if (acceptCancelled) return;
      acceptCancelled = true;
      setState('error');
      setErrMsg('Request timed out. Please try again.');
      setBusy(false);
    }, ACCEPT_SAFETY_TIMEOUT_MS);

    (async function attemptAccept() {
      try {
        const endpoint = '/api/v2/guardians/accept-invitation';
        const method = 'POST';
        const token = getToken();
        const reqHeaders = { 'Content-Type': 'application/json' };
        if (token) reqHeaders.Authorization = `Bearer ${token}`;
        logApiRequest({ endpoint, method, headers: reqHeaders });
        const res = await fetchWithTimeout(endpoint, {
          method,
          headers: reqHeaders,
          body: JSON.stringify({ code: rawCode.trim() }),
        });
        const body = await res.json();
        logApiCall({ endpoint, method, hasToken: !!getToken(), status: res.status, body: res.ok ? undefined : body });
        if (acceptCancelled) return;
        if (!res.ok || !body.success) {
          if (res.status === 401 || res.status === 403) {
            clearTimeout(acceptSafetyTimer);
            handleAuthFailure();
            return;
          }
          if (res.status === 410 || isExpired(body?.invitation)) {
            setState('expired');
            setErrMsg(body.error || 'This invitation has expired.');
          } else if (res.status === 409) {
            setState('already_accepted');
            setErrMsg('This invitation was already accepted.');
          } else {
            const msg = authErrorToast(res.status) || body.error || 'Failed to accept invitation.';
            setState('error');
            setErrMsg(msg);
          }
          acceptCancelled = true;
          clearTimeout(acceptSafetyTimer);
          setBusy(false);
          return;
        }
        acceptCancelled = true;
        clearTimeout(acceptSafetyTimer);
        setState('accepted');
        setBusy(false);
      } catch (err) {
        if (acceptCancelled) return;
        retries++;
        if (retries <= MAX_ACCEPT_RETRIES) {
          const delay = Math.min(500 * Math.pow(2, retries - 1), 2000);
          await new Promise((r) => setTimeout(r, delay));
          if (acceptCancelled) return;
          return attemptAccept();
        }
        acceptCancelled = true;
        clearTimeout(acceptSafetyTimer);
        if (err.name === 'AbortError') {
          setState('error');
          setErrMsg('Request timed out. Please try again.');
        } else if (err.name === 'SyntaxError') {
          setState('error');
          setErrMsg('Unexpected response from server. Please try again.');
        } else {
          setState('error');
          setErrMsg('Network error. Please try again.');
        }
        setBusy(false);
      }
    })();
  }, [busy, state, rawCode]);

  const inviterName = inv?.inviterName || inv?.createdByName || '';
  const inviterEmail = inv?.inviterEmail || inv?.createdByEmail || '';
  const relationship = RELATIONSHIP_LABELS[inv?.relationship] || 'Guardian';
  const childrenList = inv?.children || (inv?.child ? [inv.child] : []);
  const childName = childrenList[0]
    ? `${childrenList[0].firstName || ''} ${childrenList[0].lastName || ''}`.trim()
    : 'a child';
  const permissions = inv?.permissions || inv?.customPermissions || {};
  const expiryDate = inv?.expiresAt ? new Date(inv.expiresAt) : null;
  const now = Date.now();
  const expiryLabel = !expiryDate
    ? 'does not expire'
    : expiryDate < now
      ? 'has expired'
      : `expires ${Math.ceil((expiryDate - now) / 3600000)}h`;

  // ── Render ──

  if (state === 'invalid_link') {
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🔗</div>
        <h2 style={{ color: '#555' }}>Invalid Link</h2>
        <p style={{ color: '#888', marginBottom: 24 }}>
          This invitation link is missing or incomplete. Use the link from your email.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a href="/" style={{ padding: '10px 20px', background: '#eee', borderRadius: 8, textDecoration: 'none', color: '#333' }}>Go to Home</a>
          <a href="mailto:support@kindercura.com" style={{ padding: '10px 20px', border: '1px solid #ccc', borderRadius: 8, textDecoration: 'none', color: '#555' }}>Contact Support</a>
        </div>
      </div>
    );
  }

  if (state === 'unauthenticated') {
    const nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>👋</div>
        <h2 style={{ color: '#555' }}>Accept a Guardian Invitation</h2>
        <p style={{ color: '#888', marginBottom: 24 }}>
          Sign in to your KinderCura account to accept this invitation and access {childName}'s profile.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <a
            href={`/login.html?next=${nextUrl}`}
            style={{ padding: '10px 24px', background: '#2e7d32', color: '#fff', borderRadius: 8, textDecoration: 'none', fontWeight: 600 }}
          >
            Log In
          </a>
          <a
            href={`/signup.html?next=${nextUrl}`}
            style={{ padding: '10px 24px', border: '2px solid #2e7d32', color: '#2e7d32', borderRadius: 8, textDecoration: 'none', fontWeight: 600 }}
          >
            Create Account
          </a>
        </div>
      </div>
    );
  }

  if (state === 'verifying' || state === 'init') {
    return (
      <div style={{ padding: 48, maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ width: 32, height: 32, border: '3px solid #ddd', borderTopColor: '#2e7d32', borderRadius: '50%', animation: 'spinner .7s linear infinite', margin: '0 auto 16px' }} />
        <p style={{ color: '#888' }}>Verifying invitation…</p>
        <style>{`@keyframes spinner { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (state === 'expired') {
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: '0 auto' }}>
        <div style={{ padding: 14, background: '#fff3e0', borderLeft: '4px solid #e65100', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          <span style={{ fontSize: 20 }}>⏰</span>
          <span style={{ fontWeight: 600 }}>Invitation Expired</span>
        </div>
        <p style={{ color: '#888', lineHeight: 1.6 }}>{errMsg || 'This invitation has expired. Ask the inviter to send a new one.'}</p>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <a href="/" style={{ padding: '10px 20px', background: '#eee', borderRadius: 8, textDecoration: 'none', color: '#333' }}>Go to Home</a>
          <a href="mailto:support@kindercura.com" style={{ padding: '10px 20px', border: '1px solid #ccc', borderRadius: 8, textDecoration: 'none', color: '#555' }}>Contact Support</a>
        </div>
      </div>
    );
  }

  if (state === 'already_accepted') {
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: '0 auto' }}>
        <div style={{ padding: 14, background: '#e8f5e9', borderLeft: '4px solid #2e7d32', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          <span style={{ fontSize: 20 }}>✅</span>
          <span style={{ fontWeight: 600 }}>Already Accepted</span>
        </div>
        <p style={{ color: '#888', lineHeight: 1.6 }}>
          This invitation was already accepted. You already have access to this profile.
        </p>
        <div style={{ marginTop: 20 }}>
          <a href="/parent/dashboard.html" style={{ padding: '10px 24px', background: '#2e7d32', color: '#fff', borderRadius: 8, textDecoration: 'none', fontWeight: 600, display: 'inline-block' }}>
            Go to Dashboard
          </a>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ padding: 32, maxWidth: 560, margin: '0 auto' }}>
        <div style={{ padding: 14, background: '#fff3e0', borderLeft: '4px solid #e65100', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          <span style={{ fontSize: 20 }}>⚠️</span>
          <span style={{ fontWeight: 600 }}>Error</span>
        </div>
        <p style={{ color: '#888', lineHeight: 1.6 }}>{errMsg || 'An unexpected error occurred.'}</p>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', background: '#eee', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
            Try Again
          </button>
          <a href="mailto:support@kindercura.com" style={{ padding: '10px 20px', border: '1px solid #ccc', borderRadius: 8, textDecoration: 'none', color: '#555' }}>Contact Support</a>
        </div>
      </div>
    );
  }

  if (state === 'valid') {
    return (
      <div style={{ padding: 24, maxWidth: 640, margin: '0 auto' }}>
        <h2 style={{ color: '#2e7d32', marginBottom: 4 }}>Guardian Invitation</h2>
        <p style={{ color: '#888', fontSize: '0.95rem', marginBottom: 20 }}>
          You've been invited to access {childName}'s profile on KinderCura
        </p>

        {/* Inviter */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888', marginBottom: 6 }}>Invited by</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: '#f5f5f5', borderRadius: 8 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#2e7d32', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18 }}>
              {(inviterName || '?')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{inviterName || 'A KinderCura user'}</div>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>{relationship}</div>
              {inviterEmail && <div style={{ fontSize: '0.82rem', color: '#2e7d32' }}>{inviterEmail}</div>}
            </div>
          </div>
        </div>

        {/* Children */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888', marginBottom: 6 }}>Children</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {childrenList.map((k, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 8 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#f4d89f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>👶</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{k.firstName || ''} {k.lastName || ''}</div>
                  {k.dateOfBirth && (
                    <div style={{ fontSize: '0.8rem', color: '#888' }}>Age {Math.max(0, Math.round((Date.now() - new Date(k.dateOfBirth.split('T')[0])) / 31557600000))}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Permissions */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888', marginBottom: 6 }}>Access Permissions</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {Object.entries(permissions).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.88rem' }}>
                <span>{v ? '✅' : '⬜'}</span>
                <span>{PERMISSION_LABELS[k] || k}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Personal message */}
        {inv?.personalMessage && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888', marginBottom: 6 }}>Message from inviter</div>
            <div style={{ padding: 12, background: '#f5f5f5', borderRadius: 8, fontStyle: 'italic', lineHeight: 1.6 }}>{inv.personalMessage}</div>
          </div>
        )}

        {/* Expiry notice */}
        <div style={{ padding: '10px 14px', background: '#fff3e0', borderRadius: 8, fontSize: '0.85rem', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          ⏰ This invitation <strong>{expiryLabel}</strong>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={handleAccept}
            disabled={busy}
            style={{
              padding: '12px 32px',
              background: busy ? '#ccc' : '#2e7d32',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: '1.05rem',
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Accepting...' : 'Accept Invitation'}
          </button>
        </div>
      </div>
    );
  }

  if (state === 'accepted') {
    return (
      <div style={{ padding: 48, maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
        <h2 style={{ color: '#2e7d32' }}>Invitation Accepted!</h2>
        <p style={{ color: '#888', marginBottom: 24 }}>
          You now have access to {childName}'s profile.
        </p>
        <a
          href="/parent/dashboard.html"
          style={{ padding: '12px 32px', background: '#2e7d32', color: '#fff', borderRadius: 8, textDecoration: 'none', fontWeight: 600, display: 'inline-block' }}
        >
          Go to Dashboard
        </a>
      </div>
    );
  }

  return (
    <div style={{ padding: 32, maxWidth: 560, margin: '0 auto' }}>
      <div style={{ padding: 14, background: '#fff3e0', borderLeft: '4px solid #e65100', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <span style={{ fontSize: 20 }}>⚠️</span>
        <span style={{ fontWeight: 600 }}>Error</span>
      </div>
      <p style={{ color: '#888', lineHeight: 1.6 }}>{errMsg || 'An unexpected error occurred.'}</p>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', background: '#eee', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
          Try Again
        </button>
        <a href="mailto:support@kindercura.com" style={{ padding: '10px 20px', border: '1px solid #ccc', borderRadius: 8, textDecoration: 'none', color: '#555' }}>Contact Support</a>
      </div>
    </div>
  );
}
