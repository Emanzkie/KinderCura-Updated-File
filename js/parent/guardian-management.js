// ==================== Guardian Management Component ====================
const { useState, useEffect, useMemo, useCallback } = React;

const KC_CHILD_KEY = 'kc_childId';

function getUrlChildId() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('childId') || '');
}

function getStoredChildId() {
  return String(localStorage.getItem(KC_CHILD_KEY) || '');
}

function getInitialChildId() {
  return getUrlChildId() || getStoredChildId();
}

function persistChildId(id) {
  if (id) localStorage.setItem(KC_CHILD_KEY, String(id));
  else localStorage.removeItem(KC_CHILD_KEY);
}

function resolveSelectedChild(kids, storedId) {
  if (kids.length === 0) return '';
  const match = storedId && kids.find(c => String(c.id || c._id) === String(storedId));
  if (match) return String(match.id || match._id);
  return String(kids[0].id || kids[0]._id);
}

// Static lookup tables
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

const PERMISSION_PRESETS = [
  { value: 'full', label: 'Full Access', icon: '🔓' },
  { value: 'standard', label: 'Standard Access', icon: '⚖️' },
  { value: 'medical', label: 'Medical Only', icon: '🏥' },
  { value: 'limited', label: 'Limited Access', icon: '🔒' },
  { value: 'custom', label: 'Custom', icon: '⚙️' },
];

const PERMISSION_DEFINITIONS = [
  { key: 'viewAssessments', label: 'View Assessments & Results', icon: '📊' },
  { key: 'submitAssessments', label: 'Submit Assessments', icon: '✏️' },
  { key: 'viewResults', label: 'View Assessment Results', icon: '📈' },
  { key: 'uploadDocuments', label: 'Upload Documents & Photos', icon: '📷' },
  { key: 'manageAppointments', label: 'Manage Appointments', icon: '📅' },
  { key: 'viewMedicalRecords', label: 'View Medical Records', icon: '💊' },
  { key: 'modifyChild', label: 'Modify Child Profile', icon: '👤' },
  { key: 'inviteGuardians', label: 'Invite Other Guardians', icon: '➕' },
  { key: 'revokeAccess', label: 'Revoke Access', icon: '❌' },
  { key: 'viewMessages', label: 'View Chat Messages', icon: '💬' },
  { key: 'sendMessages', label: 'Send Messages', icon: '🗨️' },
  { key: 'viewNotifications', label: 'View Notifications', icon: '🔔' },
];

// ===== Main Component =====
function GuardianManagement() {
  const [children, setChildren] = useState([]);
  const [selectedChild, setSelectedChild] = useState(getInitialChildId);
  const [invitationEmail, setInvitationEmail] = useState('');
  const [invitationRelationship, setInvitationRelationship] = useState('legal_guardian');
  const [invitationPreset, setInvitationPreset] = useState('standard');
  const [invitationMessage, setInvitationMessage] = useState('');
  const [customPermissions, setCustomPermissions] = useState({});
  const [showCustomPerms, setShowCustomPerms] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState([]);
  const [linkedGuardians, setLinkedGuardians] = useState([]);
  const [editingGuardian, setEditingGuardian] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [message, setMessage] = useState({ text: '', type: '' });
  const [loading, setLoading] = useState(false);
  const [childrenLoading, setChildrenLoading] = useState(true);

  function _getToken() {
    const a = localStorage.getItem('kc_token');
    const b = localStorage.getItem('token');
    const t = String(a || b || '').trim();
    if (!t || t === 'null' || t === 'undefined') return '';
    return t;
  }
  const token = _getToken();

  // Computed: selected-child summary for the context bar below
  const selectedChildInfo = useMemo(() => {
    if (!selectedChild) return null;
    return children.find(c =>
      String(c.id || c._id) === String(selectedChild)
    ) || null;
  }, [children, selectedChild]);

  // Set page title once children are loaded
  useEffect(() => {
    try { document.title = children.length
      ? `Guardians — ${children[0].firstName} ${children[0].lastName} | KinderCura`
      : 'Guardian Management — KinderCura'; } catch {}
  }, [children]);

  // Persist selected child to localStorage on change
  useEffect(() => {
    persistChildId(selectedChild);
  }, [selectedChild]);

  // Sync selectedChild when kc_childId changes in another tab
  useEffect(() => {
    function handleStorageChange(e) {
      if (e.key !== KC_CHILD_KEY || !e.newValue) return;
      if (e.newValue === selectedChild) return;
      if (children.length === 0) return;
      const match = children.find(c => String(c.id || c._id) === String(e.newValue));
      if (match) setSelectedChild(String(match.id || match._id));
    }
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [children, selectedChild]);

  // Load children on mount & auto-select in one pass
  useEffect(() => {
    if (!token) {
      setChildrenLoading(false);
      return;
    }

    let cancelled = false;

    const fetchHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/children', { headers: fetchHeaders })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const kids = Array.isArray(d?.children) ? d.children : [];
        const urlId = getUrlChildId();
        const stored = urlId || getStoredChildId();
        const resolvedId = resolveSelectedChild(kids, stored);

        setChildren(kids);
        setSelectedChild(resolvedId);
        if (resolvedId) persistChildId(resolvedId);
        setChildrenLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setChildren([]);
          setChildrenLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [token]);

  // Load pending invitations
  useEffect(() => {
    if (!token) return;
    const pendingHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/v2/guardians/pending-invitations', { headers: pendingHeaders })
      .then(r => r.json())
      .then(d => setPendingInvitations(d.invitations || []))
      .catch(() => setPendingInvitations([]));
  }, [token]);

  // Load linked guardians when child selected
  useEffect(() => {
    if (!selectedChild || !token) {
      setLinkedGuardians([]);
      return;
    }
    const childGuardiansHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(`/api/v2/guardians/children/${selectedChild}/guardians`, { headers: childGuardiansHeaders })
      .then(r => r.json())
      .then(d => setLinkedGuardians(d.guardians || []))
      .catch(() => setLinkedGuardians([]));
  }, [selectedChild, token]);

  // Permission preset presets
  useEffect(() => {
    const presets = {
      full: { viewAssessments: true, submitAssessments: true, viewResults: true,
                uploadDocuments: true, manageAppointments: true, viewMedicalRecords: true,
                modifyChild: true, inviteGuardians: true, revokeAccess: true,
                viewMessages: true, sendMessages: true, viewNotifications: true },
      standard: { viewAssessments: true, viewResults: true, viewMessages: true, viewNotifications: true },
      medical: { viewMedicalRecords: true, manageAppointments: true },
      limited: { viewResults: true },
    };
    if (invitationPreset !== 'custom' && presets[invitationPreset]) {
      setCustomPermissions(presets[invitationPreset]);
    }
  }, [invitationPreset]);

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!selectedChild) return setMessage({ text: 'Select a child first.', type: 'error' });
    if (!invitationEmail) return setMessage({ text: 'Enter an email to invite.', type: 'error' });
    setLoading(true);
    try {
      const inviteHeaders = token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' };
      const res = await fetch('/api/v2/guardians/generate-invitation', {
        method: 'POST',
        headers: inviteHeaders,
        body: JSON.stringify({
          childIds: [selectedChild],
          inviteEmail: invitationEmail,
          relationship: invitationRelationship,
          permissionPreset: invitationPreset,
          customPermissions: invitationPreset === 'custom' ? customPermissions : undefined,
          personalMessage: invitationMessage,
        }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        setMessage({ text: `Invitation sent! Code: ${body.invitationCode}`, type: 'success' });
        setInvitationEmail('');
        setInvitationMessage('');
        // Refresh pending list
        const pendingHeaders2 = token ? { Authorization: `Bearer ${token}` } : {};
        fetch('/api/v2/guardians/pending-invitations', { headers: pendingHeaders2 })
          .then(r => r.json())
          .then(d => setPendingInvitations(d.invitations || []));
      } else {
        setMessage({ text: body.error || 'Failed to send invitation', type: 'error' });
      }
    } catch (err) {
      setMessage({ text: 'Network error. Try again.', type: 'error' });
    }
    setLoading(false);
  };

  const handleResend = async (id) => {
    try {
      const resendHeaders = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`/api/v2/guardians/invitations/${id}/resend`, {
        method: 'POST',
        headers: resendHeaders,
      });
      const body = await res.json();
      if (res.ok) {
        setMessage({ text: 'Invitation resent!', type: 'success' });
        const pendingHeaders3 = token ? { Authorization: `Bearer ${token}` } : {};
        fetch('/api/v2/guardians/pending-invitations', { headers: pendingHeaders3 })
          .then(r => r.json())
          .then(d => setPendingInvitations(d.invitations || []));
      }
    } catch {
      setMessage({ text: 'Failed to resend', type: 'error' });
    }
  };

  const handleRevokeInvite = async (id) => {
    if (!confirm('Revoke this invitation?')) return;
    try {
      const revokeHeaders = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`/api/v2/guardians/invitations/${id}/revoke`, {
        method: 'POST',
        headers: revokeHeaders,
      });
      if (res.ok) {
        setPendingInvitations(p => p.filter(i => i.id !== id));
      }
    } catch {
      setMessage({ text: 'Failed to revoke invitation', type: 'error' });
    }
  };

  const openPermissionEditor = (guardian) => {
    setEditingGuardian(guardian);
  };

  const handleTransferPrimary = async (guardianId) => {
    if (!window.confirm('Transfer primary guardian status to this user? They will become the main contact.')) return;
    try {
      const transferHeaders = token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' };
      const res = await fetch(`/api/v2/guardians/children/${selectedChild}/transfer-primary`, {
        method: 'POST',
        headers: transferHeaders,
        body: JSON.stringify({ targetGuardianId: guardianId }),
      });
      const body = await res.json();
      if (res.ok) {
        setMessage({ text: 'Primary guardian transferred.', type: 'success' });
        // Refresh guardians list
        const refreshHeaders = token ? { Authorization: `Bearer ${token}` } : {};
        fetch(`/api/v2/guardians/children/${selectedChild}/guardians`, { headers: refreshHeaders })
          .then(r => r.json())
          .then(d => setLinkedGuardians(d.guardians || []));
      } else {
        setMessage({ text: body.error || 'Transfer failed', type: 'error' });
      }
    } catch {
      setMessage({ text: 'Network error during transfer', type: 'error' });
    }
  };

  // Permission modal handlers (window-level for inline onclick)
  window.gmOpenPermModal = (guardian) => {
    setEditingGuardian(guardian);
    document.getElementById('gmPermModal').style.display = 'block';
  };
  window.gmClosePermModal = () => {
    setEditingGuardian(null);
    document.getElementById('gmPermModal').style.display = 'none';
  };

  // Transfer modal handlers
  window.gmOpenTransferModal = (guardian) => {
    setTransferTarget(guardian);
    const name = guardian.name || 'this user';
    document.getElementById('gmTransferBody').textContent = `${name} will become the primary guardian. You will retain access but they will be listed as the primary contact.`;
    document.getElementById('gmTransferModal').style.display = 'block';
  };
  window.gmCloseTransferModal = () => {
    setTransferTarget(null);
    document.getElementById('gmTransferModal').style.display = 'none';
  };

  // Render permission toggles for editing
  useEffect(() => {
    if (editingGuardian) {
      const container = document.getElementById('gmPermToggles');
      container.innerHTML = PERMISSION_DEFINITIONS.map(p => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
          <input type="checkbox" data-key="${p.key}" ${editingGuardian.permissions?.[p.key] ? 'checked' : ''}
            onchange="window.gmUpdatePermPreview()" />
          <span>${p.icon}</span><span>${p.label}</span>
        </label>
      `).join('');
      window.gmUpdatePermPreview = () => {
        const checked = Array.from(container.querySelectorAll('input:checked')).map(i => i.dataset.key);
        document.getElementById('gmPermImpact').textContent = checked.length
          ? 'This will allow: ' + checked.map(k => PERMISSION_DEFINITIONS.find(p => p.key === k)?.label || k).join(', ') + '.'
          : 'No permissions selected.';
      };
      window.gmUpdatePermPreview();
      document.getElementById('gmPermTitle').textContent = `Edit Permissions for ${editingGuardian.name}`;
    }
  }, [editingGuardian]);

  window.gmSavePerms = async () => {
    if (!editingGuardian) return;
    const container = document.getElementById('gmPermToggles');
    const newPerms = {};
    PERMISSION_DEFINITIONS.forEach(p => {
      const el = container.querySelector(`input[data-key="${p.key}"]`);
      if (el) newPerms[p.key] = el.checked;
    });
    try {
      const permHeaders = token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' };
      const res = await fetch(`/api/v2/guardians/children/${selectedChild}/guardians/${editingGuardian.id}/permissions`, {
        method: 'PUT',
        headers: permHeaders,
        body: JSON.stringify({ permissions: newPerms }),
      });
      if (res.ok) {
        setMessage({ text: 'Permissions updated.', type: 'success' });
        // Refresh guardians
        const refreshHeaders3 = token ? { Authorization: `Bearer ${token}` } : {};
        fetch(`/api/v2/guardians/children/${selectedChild}/guardians`, { headers: refreshHeaders3 })
          .then(r => r.json())
          .then(d => setLinkedGuardians(d.guardians || []));
        window.gmClosePermModal();
      } else {
        setMessage({ text: 'Failed to update permissions', type: 'error' });
      }
    } catch {
      setMessage({ text: 'Network error', type: 'error' });
    }
  };

  window.gmConfirmTransfer = async () => {
    if (transferTarget) {
      await handleTransferPrimary(transferTarget.id);
      window.gmCloseTransferModal();
    }
  };

  return (
    <div>
      {/* ===== Hero Card Header (matches dashboard child-card) ===== */}
      <div className="gm-header">
        <div className="gm-header-left">
          <h1>Guardian Management</h1>
          <p>Manage guardians linked to selected child.</p>
        </div>
        <div className="gm-header-right">
          {children.length > 1 && (
            <select
              value={selectedChild}
              onChange={(e) => setSelectedChild(e.target.value)}
              className="gm-child-select"
            >
              {children.map((c) => (
                <option key={c.id || c._id} value={c.id || c._id}>
                  {c.firstName} {c.lastName}
                </option>
              ))}
            </select>
          )}
          <button className="gm-btn-primary"
            onClick={() => window.location.href = '/parent/profile.html'}>
            Edit Profile
          </button>
          <button className="gm-btn-secondary" disabled>
            Manage Guardians
          </button>
        </div>
      </div>

      {/* ===== Send Invitation Card ===== */}
      <div className="gm-card">
        <h3>
          {selectedChildInfo
            ? `Send Invitation for ${selectedChildInfo.firstName} ${selectedChildInfo.lastName}`
            : 'Send Invitation'}
        </h3>
        {selectedChildInfo && (
          <p className="gm-card-desc">
            This invitation will be sent for <strong>{selectedChildInfo.firstName} {selectedChildInfo.lastName}</strong>.
            Switch the selected child above using the child selector.
          </p>
        )}
        <form onSubmit={handleInvite}>
          {/* Email + Relationship row */}
          <div className="gm-form-row">
            <div style={{ flex: '2 1 0', minWidth: '260px' }}>
              <label className="gm-label">Email</label>
              <input type="email" value={invitationEmail} onChange={e => setInvitationEmail(e.target.value)}
                placeholder="guardian@example.com" required className="gm-input" />
            </div>
            <div style={{ flex: '1 1 0', minWidth: '140px' }}>
              <label className="gm-label">Relationship</label>
              <select value={invitationRelationship} onChange={e => setInvitationRelationship(e.target.value)}
                className="gm-select">
                {RELATIONSHIP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {/* Permission Presets */}
          <div className="gm-perm-section">
            <label className="gm-label">Permission Preset</label>
            <div className="gm-perm-group">
              {PERMISSION_PRESETS.map(p => (
                <button type="button" key={p.value}
                  onClick={() => { setInvitationPreset(p.value); setShowCustomPerms(p.value === 'custom'); }}
                  className={`gm-perm-btn${invitationPreset === p.value ? ' active' : ''}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom Permissions */}
          {showCustomPerms && (
            <div className="gm-custom-perms">
              <label className="gm-label">Custom Permissions</label>
              <div className="gm-custom-grid">
                {PERMISSION_DEFINITIONS.map(p => (
                  <label key={p.key}>
                    <input type="checkbox" checked={!!customPermissions[p.key]}
                      onChange={e => setCustomPermissions({ ...customPermissions, [p.key]: e.target.checked })} />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Personal Message */}
          <div className="gm-message-section">
            <label className="gm-label">Personal Message (optional)</label>
            <textarea value={invitationMessage} onChange={e => setInvitationMessage(e.target.value)}
              placeholder="Add a note for the invitee..." className="gm-textarea" />
          </div>

          {/* CTA */}
          <div className="gm-btn-submit">
            <button type="submit" disabled={loading || childrenLoading}
              className="btn btn-primary" style={{ width: 'fit-content', padding: '0.85rem 2rem' }}>
              {childrenLoading ? 'Loading...' : loading ? 'Sending...' : 'Send Invitation'}
            </button>
          </div>
        </form>
      </div>

      {/* ===== Pending Invitations Card ===== */}
      <div className="gm-card">
        <h3>Pending Invitations</h3>
        {pendingInvitations.length === 0 ? (
          <p className="gm-empty-text">No pending invitations.</p>
        ) : (
          <table className="gm-table">
            <thead>
              <tr>
                <th className="text-left">Email</th>
                <th className="text-left">Relationship</th>
                <th className="text-center">Status</th>
                <th className="text-center">Expires In</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pendingInvitations.map(inv => {
                const isExp = inv.isExpired;
                const daysLeft = inv.daysLeft;
                return (
                  <tr key={inv.id}>
                    <td>{inv.sentTo || '—'}</td>
                    <td>{RELATIONSHIP_OPTIONS.find(r => r.value === inv.relationship)?.label || inv.relationship}</td>
                    <td className="text-center">
                      <span className={`gm-status${isExp ? ' expired' : ' pending'}`}>
                        {isExp ? 'Expired' : 'Pending'}
                      </span>
                    </td>
                    <td className="text-center" style={{ color: 'var(--text-light)' }}>{isExp ? '—' : `${daysLeft}d`}</td>
                    <td className="text-center">
                      <div className="gm-action-group">
                        <button onClick={() => handleResend(inv.id)} disabled={isExp}
                          className="btn btn-secondary gm-action-btn">Resend</button>
                        <button onClick={() => handleRevokeInvite(inv.id)}
                          className="btn btn-border gm-action-btn">Revoke</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ===== Linked Guardians Card ===== */}
      <div className="gm-card">
        <h3>
          {selectedChildInfo
            ? `Linked Guardians – ${selectedChildInfo.firstName} ${selectedChildInfo.lastName}`
            : 'Linked Guardians'}
        </h3>
        {linkedGuardians.length === 0 ? <p className="gm-empty-text">No linked guardians for this child.</p> :
          <table className="gm-table">
            <thead>
              <tr>
                <th className="text-left">Name</th>
                <th className="text-left">Email</th>
                <th className="text-center">Status</th>
                <th className="text-left">Permissions</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {linkedGuardians.map(g => {
                const permKeys = Object.keys(g.permissions || {}).filter(k => g.permissions[k]);
                return (
                  <tr key={g.id}>
                    <td>{g.name || '—'}</td>
                    <td>{g.email || '—'}</td>
                    <td className="text-center">
                      <span className={`gm-status${g.status === 'active' ? ' active' : ' inactive'}`}>
                        {g.status}
                      </span>
                    </td>
                    <td>{permKeys.length} permissions</td>
                    <td className="text-center">
                      <div className="gm-action-group">
                        <button onClick={() => window.gmOpenPermModal(g)} className="btn btn-secondary gm-action-btn">Edit</button>
                        <button onClick={() => window.gmOpenTransferModal(g)} className="btn btn-border gm-action-btn">Transfer</button>
                        <button onClick={() => {
                          if (confirm('Revoke this guardian?')) {
                            const revokeHdrs = token ? { Authorization: `Bearer ${token}` } : {};
                            fetch(`/api/v2/guardians/children/${selectedChild}/guardians/${g.id}/revoke`, {
                              method: 'DELETE',
                              headers: revokeHdrs,
                            }).then(() => setLinkedGuardians(lg => lg.filter(l => l.id !== g.id)));
                          }
                        }} className="btn btn-border gm-action-btn">Revoke</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }
      </div>

      {/* Message Toast */}
      {message.text && (
        <div className={`gm-message-toast ${message.type === 'success' ? 'success' : 'error'}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}

// Mount the app
const root = document.getElementById('guardian-management-root');
if (root) {
  ReactDOM.createRoot(root).render(React.createElement(GuardianManagement));
}
