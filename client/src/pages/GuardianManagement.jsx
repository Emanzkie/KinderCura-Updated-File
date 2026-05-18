import React, { useEffect, useState } from 'react';

const KC_CHILD_KEY = 'kc_childId';

function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

function getUrlChildId() {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  return params.get('childId') || '';
}

function getStoredChildId() {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(KC_CHILD_KEY) || '';
}

function getInitialChildId() {
  return getUrlChildId() || getStoredChildId();
}

function persistChildId(id) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KC_CHILD_KEY, id);
}

function removeChildId() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KC_CHILD_KEY);
}

function resolveSelectedChild(kids, storedId) {
  if (kids.length === 0) return '';
  const match = storedId && kids.find((c) => String(c.id) === String(storedId));
  if (match) return String(match.id);
  return String(kids[0].id);
}

const TOAST_DURATION = 4000;

function addToast(toasts, toast) {
  return [...toasts, { ...toast, id: Date.now() + Math.random() }];
}

const PERMISSION_PRESETS = [
  { value: 'full', label: 'Full Access', icon: '🔓' },
  { value: 'standard', label: 'Standard Access', icon: '⚖️' },
  { value: 'medical', label: 'Medical Only', icon: '🏥' },
  { value: 'limited', label: 'Limited Access', icon: '🔒' },
  { value: 'custom', label: 'Custom', icon: '⚙️' },
];

const PERMISSION_DEFS = [
  { key: 'viewAssessments', label: 'View Assessments & Results' },
  { key: 'submitAssessments', label: 'Submit Assessments' },
  { key: 'viewResults', label: 'View Assessment Results' },
  { key: 'uploadDocuments', label: 'Upload Documents & Photos' },
  { key: 'manageAppointments', label: 'Manage Appointments' },
  { key: 'viewMedicalRecords', label: 'View Medical Records' },
  { key: 'modifyChild', label: 'Modify Child Profile' },
  { key: 'inviteGuardians', label: 'Invite Other Guardians' },
  { key: 'revokeAccess', label: 'Revoke Access' },
  { key: 'viewMessages', label: 'View Chat Messages' },
  { key: 'sendMessages', label: 'Send Messages' },
  { key: 'viewNotifications', label: 'View Notifications' },
];

const PRESET_PERMISSIONS = {
  full: Object.fromEntries(PERMISSION_DEFS.map((p) => [p.key, true])),
  standard: {
    viewAssessments: true, viewResults: true,
    viewMessages: true, viewNotifications: true,
  },
  medical: { viewMedicalRecords: true, manageAppointments: true },
  limited: { viewResults: true },
};

const RELATIONSHIP_OPTIONS = [
  { value: 'mother', label: 'Mother' },
  { value: 'father', label: 'Father' },
  { value: 'grandparent', label: 'Grandparent' },
  { value: 'legal_guardian', label: 'Legal Guardian' },
  { value: 'foster_parent', label: 'Foster Parent' },
  { value: 'court_appointed', label: 'Court-Appointed' },
  { value: 'nanny', label: 'Nanny / Babysitter' },
  { value: 'therapist', label: 'Therapist' },
  { value: 'teacher', label: 'Teacher' },
  { value: 'other', label: 'Other' },
];

function permissionsMatchPreset(perms, presetKey) {
  const preset = PRESET_PERMISSIONS[presetKey];
  if (!preset) return false;
  return PERMISSION_DEFS.every(
    (p) => Boolean(perms[p.key]) === Boolean(preset[p.key])
  );
}

function presetForPermissions(perms) {
  if (!perms) return 'custom';
  for (const p of ['full', 'standard', 'medical', 'limited']) {
    if (permissionsMatchPreset(perms, p)) return p;
  }
  return 'custom';
}

export default function GuardianManagement() {
  const [children, setChildren] = useState([]);
  const [selectedChild, setSelectedChild] = useState(getInitialChildId);
  const [guardians, setGuardians] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [toasts, setToasts] = useState([]);
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [childSelectorError, setChildSelectorError] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [invitationPreset, setInvitationPreset] = useState('standard');
  const [customPermissions, setCustomPermissions] = useState({ ...PRESET_PERMISSIONS.standard });
  const [invitationRelationship, setInvitationRelationship] = useState('legal_guardian');
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferBusy, setTransferBusy] = useState(false);

  const token = getToken();

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function fetchPendingInvitations() {
    if (!token) return;
    setPendingLoading(true);
    fetch('/api/v2/guardians/pending-invitations', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        setPendingInvitations(data.invitations || []);
        setPendingLoading(false);
      })
      .catch(() => setPendingLoading(false));
  }

  // Auto-dismiss toasts
  useEffect(() => {
    if (toasts.length === 0) return;
    const latest = toasts[toasts.length - 1];
    const timer = setTimeout(() => dismissToast(latest.id), TOAST_DURATION);
    return () => clearTimeout(timer);
  }, [toasts]);

  // Clear selector error when a child is selected
  useEffect(() => {
    if (selectedChild) setChildSelectorError(false);
  }, [selectedChild]);

  // Sync selectedChild when kc_childId changes in another tab
  useEffect(() => {
    function handleStorageChange(e) {
      if (e.key !== KC_CHILD_KEY) return;
      if (!e.newValue) return;
      if (e.newValue === selectedChild) return;
      if (children.length === 0) return;
      const match = children.find((c) => String(c.id) === String(e.newValue));
      if (match) setSelectedChild(String(match.id));
    }
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [children, selectedChild]);

  useEffect(() => {
    if (!token) {
      setChildrenLoading(false);
      return;
    }

    let cancelled = false;

    fetch('/api/children', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const kids = Array.isArray(data?.children) ? data.children : [];
        const urlId = getUrlChildId();
        const stored = urlId || getStoredChildId();
        const resolvedId = resolveSelectedChild(kids, stored);

        setChildren(kids);
        setSelectedChild(resolvedId);
        if (resolvedId) persistChildId(resolvedId);
        setChildrenLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('Failed to load children', err);
          setChildrenLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [token]);

  // Two-way binding: preset → customPermissions
  useEffect(() => {
    if (invitationPreset !== 'custom') {
      const preset = PRESET_PERMISSIONS[invitationPreset];
      if (preset) setCustomPermissions({ ...preset });
    }
  }, [invitationPreset]);

  // Fetch pending invitations on mount
  useEffect(() => {
    fetchPendingInvitations();
  }, [token]);

  // Persist selected child to localStorage on user-initiated change
  useEffect(() => {
    if (selectedChild) {
      persistChildId(selectedChild);
    } else {
      removeChildId();
    }
  }, [selectedChild]);

  useEffect(() => {
    if (!selectedChild) return;
    if (!token) {
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Please log in to manage guardians.' }));
      return;
    }

    fetch(`/api/v2/guardians/children/${selectedChild}/guardians`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        setGuardians(data.guardians || []);
      })
      .catch((err) => console.warn('Failed to load guardians', err));
  }, [selectedChild, token]);

  async function handleInvite(e) {
    e.preventDefault();
    setChildSelectorError(false);

    if (!selectedChild) {
      setChildSelectorError(true);
      return;
    }
    if (!inviteEmail) {
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Please enter an email address to invite.' }));
      return;
    }
    try {
      const res = await fetch('/api/v2/guardians/generate-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          childIds: [String(selectedChild)],
          inviteEmail,
          relationship: invitationRelationship,
          permissionPreset: invitationPreset,
          customPermissions: invitationPreset === 'custom' ? customPermissions : undefined,
        }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setToasts((prev) => addToast(prev, { type: 'success', text: `Invitation sent to ${inviteEmail}.`, email: inviteEmail }));
        setInviteEmail('');
        fetchPendingInvitations();
        fetch(`/api/v2/guardians/children/${selectedChild}/guardians`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.json())
          .then((data) => setGuardians(data.guardians || []));
      } else {
        setToasts((prev) => addToast(prev, { type: 'error', text: body.error || 'Failed to send invitation. Please try again.' }));
      }
    } catch (err) {
      console.error(err);
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Network error. Please check your connection and try again.' }));
    }
  }

  async function handleResendInvite(inviteId) {
    try {
      const res = await fetch(`/api/v2/guardians/invitations/${inviteId}/resend`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (res.ok) {
        setToasts((prev) => addToast(prev, { type: 'success', text: 'Invitation resent.' }));
        fetchPendingInvitations();
      } else {
        setToasts((prev) => addToast(prev, { type: 'error', text: body.error || 'Failed to resend.' }));
      }
    } catch {
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Network error. Please try again.' }));
    }
  }

  async function handleRevokeInvite(inviteId) {
    if (!confirm('Revoke this invitation?')) return;
    try {
      const res = await fetch(`/api/v2/guardians/invitations/${inviteId}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setPendingInvitations((prev) => prev.filter((i) => i.id !== inviteId));
        setToasts((prev) => addToast(prev, { type: 'success', text: 'Invitation revoked.' }));
      } else {
        const body = await res.json();
        setToasts((prev) => addToast(prev, { type: 'error', text: body.error || 'Failed to revoke.' }));
      }
    } catch {
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Network error. Please try again.' }));
    }
  }

  function handleOpenTransfer(guardian) {
    setTransferTarget(guardian);
  }

  function handleCloseTransfer() {
    setTransferTarget(null);
    setTransferBusy(false);
  }

  async function handleConfirmTransfer() {
    if (!transferTarget || !selectedChild) return;
    setTransferBusy(true);
    try {
      const res = await fetch(`/api/v2/guardians/children/${selectedChild}/transfer-primary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ targetGuardianId: transferTarget.id }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setToasts((prev) => addToast(prev, { type: 'success', text: 'Primary guardian transferred.' }));
        handleCloseTransfer();
        fetch(`/api/v2/guardians/children/${selectedChild}/guardians`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.json())
          .then((data) => setGuardians(data.guardians || []));
      } else {
        setToasts((prev) => addToast(prev, { type: 'error', text: body.error || 'Transfer failed.' }));
        setTransferBusy(false);
      }
    } catch {
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Network error. Please try again.' }));
      setTransferBusy(false);
    }
  }

  async function handleRevoke(guardianId) {
    if (!selectedChild) return;
    if (!confirm('Revoke access for this guardian?')) return;
    try {
      const res = await fetch(`/api/v2/guardians/children/${selectedChild}/guardians/${guardianId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (res.ok) {
        setToasts((prev) => addToast(prev, { type: 'success', text: 'Guardian access revoked.' }));
        setGuardians((g) => g.filter((x) => x.id !== guardianId));
      } else {
        setToasts((prev) => addToast(prev, { type: 'error', text: body.error || 'Failed to revoke guardian.' }));
      }
    } catch (err) {
      console.error(err);
      setToasts((prev) => addToast(prev, { type: 'error', text: 'Network error. Please check your connection and try again.' }));
    }
  }

  const activeChild = selectedChild && children.find((c) => c.id === selectedChild);
  const emptyState = !childrenLoading && children.length === 0;

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2>Guardian Management</h2>
      {!token && <div style={{ color: 'darkred' }}>You must be logged in to manage guardians.</div>}

      {/* ── Child Selector ── */}
      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'block', marginBottom: 6 }}>Select Child</label>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <select
            value={selectedChild}
            onChange={(e) => setSelectedChild(e.target.value)}
            style={{
              padding: 8,
              minWidth: 320,
              border: childSelectorError ? '2px solid #d32f2f' : '1px solid #ccc',
              outline: 'none',
            }}
            disabled={childrenLoading}
          >
            {childrenLoading ? (
              <option value="">Loading children...</option>
            ) : (
              <option value="">-- Select a child --</option>
            )}
            {!childrenLoading && children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName}
              </option>
            ))}
          </select>
          {childrenLoading && (
            <span style={{ fontSize: '0.85rem', color: '#888' }}>⏳ Loading...</span>
          )}
          {!childrenLoading && activeChild && (
            <span style={{ fontSize: '0.85rem', color: '#2e7d32' }}>
              ✓ Active: {activeChild.firstName}
            </span>
          )}
        </div>
        {childSelectorError && (
          <div style={{ color: '#d32f2f', fontSize: '0.85rem', marginTop: 4 }}>
            Please select a child to continue.
          </div>
        )}
      </div>

      {/* ── Empty State ── */}
      {emptyState && (
        <div
          style={{
            marginTop: 20,
            padding: 32,
            textAlign: 'center',
            background: '#f9fafb',
            borderRadius: 10,
            border: '1px dashed #ccc',
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 8 }}>👶</div>
          <h3 style={{ margin: '0 0 6px', color: '#555' }}>No children registered yet</h3>
          <p style={{ margin: 0, color: '#888', fontSize: '0.9rem' }}>
            Add a child on your dashboard to start managing guardians.
          </p>
        </div>
      )}

      {/* ── Invite Form ── */}
      {!emptyState && (
        <form onSubmit={handleInvite} style={{ marginTop: 16, background: '#fafafa', padding: 16, borderRadius: 10 }}>
          <h3 style={{ margin: '0 0 12px', color: '#2e7d32' }}>Send Invitation</h3>

          <label style={{ display: 'block', marginBottom: 6 }}>Email</label>
          <input
            type="email"
            placeholder="guardian@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            style={{ padding: 8, minWidth: 280 }}
            disabled={childrenLoading}
          />

          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', marginBottom: 6 }}>Relationship</label>
            <select
              value={invitationRelationship}
              onChange={(e) => setInvitationRelationship(e.target.value)}
              style={{ padding: 8, minWidth: 200 }}
              disabled={childrenLoading}
            >
              {RELATIONSHIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', marginBottom: 6 }}>Permission Preset</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PERMISSION_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setInvitationPreset(p.value)}
                  style={{
                    padding: '6px 14px',
                    border: invitationPreset === p.value ? '2px solid #2e7d32' : '1px solid #ccc',
                    background: invitationPreset === p.value ? '#e8f5e9' : '#fff',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                  }}
                >
                  {p.icon} {p.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', marginBottom: 6 }}>Individual Permissions</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
              {PERMISSION_DEFS.map((pd) => (
                <label
                  key={pd.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.88rem', cursor: 'pointer',
                    padding: '4px 0',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!customPermissions[pd.key]}
                    onChange={(e) => {
                      const next = { ...customPermissions, [pd.key]: e.target.checked };
                      setCustomPermissions(next);
                      setInvitationPreset(presetForPermissions(next));
                    }}
                    disabled={childrenLoading}
                  />
                  {pd.label}
                </label>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={!selectedChild || childrenLoading}
            style={{ marginTop: 14, padding: '10px 24px', background: '#2e7d32', color: '#fff', border: 'none', borderRadius: 6, cursor: !selectedChild || childrenLoading ? 'not-allowed' : 'pointer', fontWeight: 600 }}
          >
            {childrenLoading ? 'Loading...' : 'Send Invite'}
          </button>
        </form>
      )}

      {/* ── Pending Invitations ── */}
      {!emptyState && (
        <div style={{ marginTop: 28 }}>
          <h3>Pending Invitations</h3>
          {pendingLoading && pendingInvitations.length === 0 ? (
            <div style={{ color: '#888' }}>Loading...</div>
          ) : pendingInvitations.length === 0 ? (
            <div style={{ color: '#888' }}>No pending invitations.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 8 }}>Email</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
                  <th style={{ textAlign: 'left', padding: 8 }}>Expires</th>
                  <th style={{ padding: 8 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvitations.map((inv) => (
                  <tr key={inv.id} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: 8 }}>{inv.sentTo || '—'}</td>
                    <td style={{ padding: 8 }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontSize: '0.82rem',
                          fontWeight: 600,
                          background: inv.isExpired ? '#ffebee' : '#e8f5e9',
                          color: inv.isExpired ? '#c62828' : '#2e7d32',
                        }}
                      >
                        {inv.isExpired ? 'Expired' : 'Pending'}
                      </span>
                    </td>
                    <td style={{ padding: 8, fontSize: '0.9rem', color: '#888' }}>
                      {inv.isExpired ? '—' : `${inv.daysLeft}d`}
                    </td>
                    <td style={{ padding: 8 }}>
                      <button
                        onClick={() => handleResendInvite(inv.id)}
                        disabled={inv.isExpired}
                        style={{ padding: '6px 10px', marginRight: 6 }}
                      >
                        Resend
                      </button>
                      <button
                        onClick={() => handleRevokeInvite(inv.id)}
                        style={{ padding: '6px 10px' }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Guardian List ── */}
      <div style={{ marginTop: 28 }}>
        <h3>Current Guardians</h3>
        {guardians.length === 0 ? (
          <div style={{ color: '#888' }}>No guardians found for this child.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 8 }}>Name</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Email</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Role</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {guardians.map((g) => (
                <tr key={g.id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>{g.name || '—'}</td>
                  <td style={{ padding: 8 }}>{g.email || '—'}</td>
                  <td style={{ padding: 8 }}>{g.role || '—'}</td>
                  <td style={{ padding: 8 }}>
                    <button onClick={() => handleRevoke(g.id)} style={{ padding: '6px 10px', marginRight: 6 }}>
                      Revoke
                    </button>
                    {guardians.length > 1 && (
                      <button onClick={() => handleOpenTransfer(g)} style={{ padding: '6px 10px' }}>
                        Transfer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Transfer Confirmation Modal ── */}
      {transferTarget && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
          }}
          onClick={handleCloseTransfer}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 14, padding: 28, maxWidth: 480, width: '90%',
              boxShadow: '0 8px 36px rgba(0,0,0,0.18)',
            }}
          >
            <h3 style={{ margin: '0 0 6px', color: '#2e7d32' }}>Transfer Primary Guardian</h3>
            <p style={{ color: '#666', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 16 }}>
              <strong>{transferTarget.name || 'This user'}</strong> will become the primary guardian for{' '}
              <strong>{activeChild?.firstName || 'this child'}</strong>.
            </p>
            <div style={{ padding: 12, background: '#fff3e0', borderRadius: 8, marginBottom: 16, fontSize: '0.88rem', lineHeight: 1.6 }}>
              ⚠️ <strong>You will lose primary admin rights.</strong> The new primary guardian will be able to
              manage guardians, modify the child profile, and control access permissions. You will retain
              your current access level unless changed by the new primary.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={handleCloseTransfer}
                disabled={transferBusy}
                style={{ padding: '10px 20px', background: '#eee', border: 'none', borderRadius: 8, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmTransfer}
                disabled={transferBusy}
                style={{
                  padding: '10px 24px', background: transferBusy ? '#ccc' : '#d32f2f', color: '#fff',
                  border: 'none', borderRadius: 8, cursor: transferBusy ? 'not-allowed' : 'pointer', fontWeight: 600,
                }}
              >
                {transferBusy ? 'Transferring...' : 'Confirm Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Container ── */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {toasts.map((t) => (
            <div
              key={t.id}
              onClick={() => dismissToast(t.id)}
              style={{
                padding: '12px 18px',
                borderRadius: 8,
                background: t.type === 'success' ? '#2e7d32' : '#d32f2f',
                color: '#fff',
                fontSize: '0.9rem',
                fontWeight: 500,
                boxShadow: '0 4px 12px rgba(0,0,0,.18)',
                cursor: 'pointer',
                maxWidth: 380,
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
