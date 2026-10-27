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

function getToken() {
  const t = String(localStorage.getItem('kc_token') || localStorage.getItem('token') || '').trim();
  if (!t || t === 'null' || t === 'undefined') return '';
  return t;
}

// One fetch wrapper for every call on this page: auth header, JSON body, and a
// parsed result even when the server answers with an error.
async function gmApi(path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok && data.success !== false, status: res.status, data };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
const ROLE_LABELS = { parent: 'Parent', legal_guardian: 'Legal Guardian', foster_parent: 'Foster Parent', court_appointed: 'Court-Appointed' };

function relationshipLabel(value) {
  return RELATIONSHIP_OPTIONS.find(r => r.value === value)?.label || (value === 'babysitter' ? 'Babysitter' : '');
}

const PERMISSION_PRESETS = [
  { value: 'full', label: 'Full Access', icon: '🔓' },
  { value: 'standard', label: 'Standard Access', icon: '⚖️' },
  { value: 'medical', label: 'Medical Only', icon: '🏥' },
  { value: 'limited', label: 'Limited Access', icon: '🔒' },
  { value: 'custom', label: 'Custom', icon: '⚙️' },
];

const PERMISSION_DEFINITIONS = [
  { key: 'viewAssessments', label: 'View Assessments & Results', icon: 'analytics' },
  { key: 'submitAssessments', label: 'Submit Assessments', icon: 'edit_pedia' },
  { key: 'viewResults', label: 'View Assessment Results', icon: 'tracker_summary' },
  { key: 'viewRecommendations', label: 'View Recommendations', icon: 'recommendations' },
  { key: 'uploadDocuments', label: 'Upload Documents & Photos', icon: 'change_photo' },
  { key: 'manageAppointments', label: 'Manage Appointments', icon: 'appointment' },
  { key: 'viewMedicalRecords', label: 'View Medical Records', icon: 'logs' },
  { key: 'modifyChild', label: 'Modify Child Profile', icon: 'child' },
  { key: 'inviteGuardians', label: 'Invite Other Guardians', icon: 'parent_assign' },
  { key: 'revokeAccess', label: 'Revoke Access', icon: 'reject_mark' },
  { key: 'viewMessages', label: 'View Chat Messages', icon: 'chat' },
  { key: 'sendMessages', label: 'Send Messages', icon: 'chatbubble' },
  { key: 'viewNotifications', label: 'View Notifications', icon: 'notif_bell' },
];

// What each preset grants. The server applies the same table
// (constants/guardianLink.js) and is the authority; this copy drives the preview.
const PRESET_GRANTS = {
  full: { viewAssessments: true, submitAssessments: true, viewResults: true,
          uploadDocuments: true, manageAppointments: true, viewMedicalRecords: true,
          modifyChild: true, inviteGuardians: true, revokeAccess: true,
          viewMessages: true, sendMessages: true, viewNotifications: true },
  standard: { viewAssessments: true, viewResults: true, viewMessages: true, viewNotifications: true },
  medical: { viewMedicalRecords: true, manageAppointments: true },
  limited: { viewResults: true },
};

function presetPermissions(preset) {
  const grants = PRESET_GRANTS[preset] || {};
  const out = {};
  PERMISSION_DEFINITIONS.forEach(p => { out[p.key] = grants[p.key] === true; });
  out.viewRecommendations = out.viewResults; // recommendations follow results
  return out;
}

// viewMedicalRecords is stored as 'none' | 'partial' | 'full'.
function isGranted(perms, key) {
  const v = perms ? perms[key] : undefined;
  if (key === 'viewMedicalRecords') return v === true || v === 'partial' || v === 'full';
  return v === true;
}

function grantedLabels(perms) {
  return PERMISSION_DEFINITIONS.filter(p => isGranted(perms, p.key)).map(p => p.label);
}

function expiryText(inv) {
  if (inv.isExpired) return 'Expired';
  const hours = Math.max(inv.hoursLeft || 0, 0);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
  return `${hours}h left`;
}

// ===== Main Component =====
function GuardianManagement() {
  const [children, setChildren] = useState([]);
  const [selectedChild, setSelectedChild] = useState(getInitialChildId);
  const [invitationEmail, setInvitationEmail] = useState('');
  const [invitationRelationship, setInvitationRelationship] = useState('legal_guardian');
  const [invitationPreset, setInvitationPreset] = useState('standard');
  const [invitationMessage, setInvitationMessage] = useState('');
  const [customPermissions, setCustomPermissions] = useState(presetPermissions('standard'));
  const [pendingInvitations, setPendingInvitations] = useState([]);
  const [linkedGuardians, setLinkedGuardians] = useState([]);
  const [linkedState, setLinkedState] = useState('idle'); // idle | loading | ready | forbidden | error
  const [editingGuardian, setEditingGuardian] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [message, setMessage] = useState({ text: '', type: '' });
  const [shareInfo, setShareInfo] = useState(null); // invitation whose email failed
  const [sending, setSending] = useState(false);
  const [busyIds, setBusyIds] = useState({});
  const [childrenLoading, setChildrenLoading] = useState(true);

  const token = getToken();

  const notify = useCallback((text, type = 'success') => setMessage({ text, type }), []);

  // Toasts clear themselves.
  useEffect(() => {
    if (!message.text) return undefined;
    const t = setTimeout(() => setMessage({ text: '', type: '' }), message.type === 'error' ? 7000 : 5000);
    return () => clearTimeout(t);
  }, [message]);

  const setBusy = (id, on) => setBusyIds(prev => {
    const next = { ...prev };
    if (on) next[id] = true; else delete next[id];
    return next;
  });

  const selectedChildInfo = useMemo(() => {
    if (!selectedChild) return null;
    return children.find(c => String(c.id || c._id) === String(selectedChild)) || null;
  }, [children, selectedChild]);
  const childName = selectedChildInfo ? `${selectedChildInfo.firstName} ${selectedChildInfo.lastName}` : '';

  useEffect(() => {
    try {
      document.title = childName ? `Guardians — ${childName} | KinderCura` : 'Guardian Management — KinderCura';
    } catch {}
  }, [childName]);

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
      return undefined;
    }
    let cancelled = false;
    gmApi('/api/children')
      .then(({ data }) => {
        if (cancelled) return;
        const kids = Array.isArray(data?.children) ? data.children : [];
        const resolvedId = resolveSelectedChild(kids, getUrlChildId() || getStoredChildId());
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

  const loadPending = useCallback(async () => {
    if (!token) return;
    try {
      const { data } = await gmApi('/api/v2/guardians/pending-invitations');
      setPendingInvitations(Array.isArray(data.invitations) ? data.invitations : []);
    } catch {
      setPendingInvitations([]);
    }
  }, [token]);

  const loadLinked = useCallback(async (childId) => {
    if (!childId || !token) {
      setLinkedGuardians([]);
      setLinkedState('idle');
      return;
    }
    setLinkedState('loading');
    try {
      const { ok, status, data } = await gmApi(`/api/v2/guardians/children/${encodeURIComponent(childId)}/guardians`);
      if (ok) {
        setLinkedGuardians(Array.isArray(data.guardians) ? data.guardians : []);
        setLinkedState('ready');
      } else {
        setLinkedGuardians([]);
        setLinkedState(status === 403 ? 'forbidden' : 'error');
      }
    } catch {
      setLinkedGuardians([]);
      setLinkedState('error');
    }
  }, [token]);

  useEffect(() => { loadPending(); }, [loadPending]);
  useEffect(() => { loadLinked(selectedChild); }, [selectedChild, loadLinked]);

  // Presets fill the permission preview; Custom starts from the last preset shown.
  useEffect(() => {
    if (invitationPreset !== 'custom') setCustomPermissions(presetPermissions(invitationPreset));
  }, [invitationPreset]);

  const pendingForChild = useMemo(
    () => pendingInvitations.filter(inv => (inv.childIds || []).map(String).includes(String(selectedChild))),
    [pendingInvitations, selectedChild]
  );
  // Linked guardians other than the primary one.
  const activeGuardianCount = linkedGuardians.filter(g => g.status === 'active' && !g.isPrimary).length;

  const handleInvite = async (e) => {
    e.preventDefault();
    if (sending) return;
    if (!selectedChild) return notify('Select a child first.', 'error');
    const email = invitationEmail.trim();
    if (!email) return notify('Enter an email to invite.', 'error');
    setSending(true);
    setShareInfo(null);
    try {
      const { ok, data } = await gmApi('/api/v2/guardians/generate-invitation', {
        method: 'POST',
        body: {
          childIds: [selectedChild],
          inviteEmail: email,
          relationship: invitationRelationship,
          permissionPreset: invitationPreset,
          customPermissions: invitationPreset === 'custom' ? customPermissions : undefined,
          personalMessage: invitationMessage,
        },
      });
      if (ok) {
        if (data.emailSent) {
          notify(`Invitation email sent to ${email}.`);
        } else {
          setShareInfo({ email, url: data.acceptUrl });
          notify('Invitation created, but the email could not be sent.', 'error');
        }
        setInvitationEmail('');
        setInvitationMessage('');
        await loadPending();
      } else {
        notify(data.error || 'Failed to send invitation.', 'error');
      }
    } catch {
      notify('Network error. Try again.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleResend = async (inv) => {
    if (busyIds[inv.id]) return;
    setBusy(inv.id, true);
    setShareInfo(null);
    try {
      const { ok, data } = await gmApi(`/api/v2/guardians/invitations/${inv.id}/resend`, { method: 'POST' });
      if (ok) {
        if (data.emailSent) {
          notify(`Invitation resent to ${inv.sentTo}.`);
        } else {
          setShareInfo({ email: inv.sentTo, url: data.acceptUrl });
          notify('A new invitation link was created, but the email could not be sent.', 'error');
        }
        await loadPending();
      } else {
        notify(data.error || 'Failed to resend the invitation.', 'error');
      }
    } catch {
      notify('Network error. Try again.', 'error');
    } finally {
      setBusy(inv.id, false);
    }
  };

  const handleRevokeInvite = async (inv) => {
    if (busyIds[inv.id]) return;
    if (!window.confirm(`Revoke the invitation sent to ${inv.sentTo || 'this person'}? The link in their email will stop working.`)) return;
    setBusy(inv.id, true);
    try {
      const { ok, data } = await gmApi(`/api/v2/guardians/invitations/${inv.id}/revoke`, { method: 'POST' });
      if (ok) {
        notify('Invitation revoked.');
        if (shareInfo && shareInfo.email === inv.sentTo) setShareInfo(null);
        await loadPending();
      } else {
        notify(data.error || 'Failed to revoke the invitation.', 'error');
      }
    } catch {
      notify('Network error. Try again.', 'error');
    } finally {
      setBusy(inv.id, false);
    }
  };

  const handleRevokeGuardian = async (g) => {
    if (busyIds[g.id]) return;
    if (!window.confirm(`Remove ${g.name || 'this guardian'}'s access to ${childName || 'this child'}?`)) return;
    setBusy(g.id, true);
    try {
      const { ok, data } = await gmApi(
        `/api/v2/guardians/children/${encodeURIComponent(selectedChild)}/guardians/${encodeURIComponent(g.guardianId)}`,
        { method: 'DELETE' }
      );
      if (ok) {
        notify(`${g.name || 'Guardian'} no longer has access.`);
        await loadLinked(selectedChild);
      } else {
        notify(data.error || 'Failed to revoke access.', 'error');
      }
    } catch {
      notify('Network error. Try again.', 'error');
    } finally {
      setBusy(g.id, false);
    }
  };

  const handleTransferPrimary = async (guardian) => {
    const btn = document.getElementById('gmTransferConfirmBtn');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const { ok, data } = await gmApi(`/api/v2/guardians/children/${encodeURIComponent(selectedChild)}/transfer-primary`, {
        method: 'POST',
        body: { targetGuardianId: guardian.guardianId },
      });
      if (ok) {
        notify(`${guardian.name || 'The guardian'} is now the primary guardian.`);
        window.gmCloseTransferModal();
        await loadLinked(selectedChild);
      } else {
        notify(data.error || 'Transfer failed.', 'error');
      }
    } catch {
      notify('Network error during transfer.', 'error');
    } finally {
      if (btn) btn.disabled = false;
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
    document.getElementById('gmTransferBody').textContent = `${name} will become the primary guardian of ${childName || 'this child'}. You will keep full access, but they will be the primary contact and the one who manages guardians.`;
    document.getElementById('gmTransferModal').style.display = 'block';
  };
  window.gmCloseTransferModal = () => {
    setTransferTarget(null);
    document.getElementById('gmTransferModal').style.display = 'none';
  };

  // Render permission toggles for editing
  useEffect(() => {
    if (!editingGuardian) return;
    const container = document.getElementById('gmPermToggles');
    container.innerHTML = PERMISSION_DEFINITIONS.map(p => `
      <label class="gm-check" style="padding:6px 0;border-bottom:1px solid var(--border)">
        <input type="checkbox" data-key="${p.key}" ${isGranted(editingGuardian.permissions, p.key) ? 'checked' : ''}
          onchange="window.gmUpdatePermPreview()" />
        <img src="/icons/${p.icon}.png" alt="" aria-hidden="true" style="width:1.1em;height:1.1em;object-fit:contain;"><span>${escapeHtml(p.label)}</span>
      </label>
    `).join('');
    window.gmUpdatePermPreview = () => {
      const checked = Array.from(container.querySelectorAll('input:checked')).map(i => i.dataset.key);
      document.getElementById('gmPermImpact').textContent = checked.length
        ? 'This will allow: ' + checked.map(k => PERMISSION_DEFINITIONS.find(p => p.key === k)?.label || k).join(', ') + '.'
        : 'No permissions selected — they will still see the child on their dashboard but cannot open any records.';
    };
    window.gmUpdatePermPreview();
    document.getElementById('gmPermTitle').textContent = `Edit Permissions for ${editingGuardian.name || 'guardian'}`;
    document.getElementById('gmPermSub').textContent = `Access to ${childName || 'this child'}. Changes apply the next time they open a page.`;
  }, [editingGuardian, childName]);

  window.gmSavePerms = async () => {
    if (!editingGuardian) return;
    const saveBtn = document.getElementById('gmPermSaveBtn');
    if (saveBtn && saveBtn.disabled) return;
    const container = document.getElementById('gmPermToggles');
    const newPerms = {};
    PERMISSION_DEFINITIONS.forEach(p => {
      const el = container.querySelector(`input[data-key="${p.key}"]`);
      if (el) newPerms[p.key] = el.checked;
    });
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      const { ok, data } = await gmApi(
        `/api/v2/guardians/children/${encodeURIComponent(selectedChild)}/guardians/${encodeURIComponent(editingGuardian.guardianId)}/permissions`,
        { method: 'PUT', body: { permissions: newPerms } }
      );
      if (ok) {
        notify('Permissions updated.');
        window.gmClosePermModal();
        await loadLinked(selectedChild);
      } else {
        notify(data.error || 'Failed to update permissions.', 'error');
      }
    } catch {
      notify('Network error.', 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Permissions'; }
    }
  };

  window.gmConfirmTransfer = async () => {
    if (transferTarget) await handleTransferPrimary(transferTarget);
  };

  const copyShareLink = async () => {
    if (!shareInfo?.url) return;
    try {
      await navigator.clipboard.writeText(shareInfo.url);
      notify('Invitation link copied.');
    } catch {
      notify('Copy failed — select the link and copy it manually.', 'error');
    }
  };

  const presetSummary = grantedLabels(customPermissions);
  const noChildren = !childrenLoading && children.length === 0;

  return (
    <div>
      {/* ===== Header + selected child overview ===== */}
      <section className="gm-header" aria-labelledby="gmTitle">
        <div className="gm-header-top">
          <div className="gm-header-left">
            <h1 id="gmTitle">Guardian Management</h1>
            <p>Invite family members and caregivers, choose what they can see, and manage who is linked to your child.</p>
          </div>
          <div className="gm-header-actions">
            <a className="gm-btn gm-btn--primary" href="/parent/profile">Edit Profile</a>
            <span className="gm-btn gm-btn--current" aria-current="page">Manage Guardians</span>
          </div>
        </div>

        <div className="gm-overview">
          <div className="gm-overview-item gm-overview-item--child">
            <span className="gm-overview-label" id="gmChildLabel">Selected child</span>
            {children.length > 1 ? (
              <select
                value={selectedChild}
                onChange={(e) => { setSelectedChild(e.target.value); setShareInfo(null); }}
                className="gm-child-select"
                aria-labelledby="gmChildLabel"
              >
                {children.map((c) => (
                  <option key={c.id || c._id} value={c.id || c._id}>
                    {c.firstName} {c.lastName}
                  </option>
                ))}
              </select>
            ) : (
              <span className="gm-overview-value">
                {childrenLoading ? 'Loading…' : (childName || 'No child registered')}
              </span>
            )}
          </div>
          <div className="gm-overview-item">
            <span className="gm-overview-label">Linked guardians</span>
            <span className="gm-overview-value">{linkedState === 'ready' ? activeGuardianCount : '—'}</span>
          </div>
          <div className="gm-overview-item">
            <span className="gm-overview-label">Pending invitations</span>
            <span className="gm-overview-value">{pendingForChild.length}</span>
          </div>
        </div>
      </section>

      {noChildren && (
        <div className="gm-card">
          <div className="gm-empty">
            No child is registered on your account yet. Add a child from your profile before inviting guardians.
            <div style={{ marginTop: '0.9rem' }}>
              <a className="gm-btn gm-btn--primary" href="/parent/profile">Go to Profile</a>
            </div>
          </div>
        </div>
      )}

      {/* ===== Send Invitation Card ===== */}
      <section className="gm-card" aria-labelledby="gmInviteTitle">
        <h2 id="gmInviteTitle">{childName ? `Send Invitation for ${childName}` : 'Send Invitation'}</h2>
        <p className="gm-card-desc">
          {childName
            ? <>The invited person gets an email link. Once they accept, they are linked to <strong>{childName}</strong> with the access you choose below.{children.length > 1 ? ' Switch the selected child above to invite for another child.' : ''}</>
            : 'Select a child to send an invitation.'}
        </p>
        <form onSubmit={handleInvite} noValidate>
          <div className="gm-form-row">
            <div className="gm-field">
              <label className="gm-label" htmlFor="gmInviteEmail">Email</label>
              <input id="gmInviteEmail" type="email" value={invitationEmail} onChange={e => setInvitationEmail(e.target.value)}
                placeholder="guardian@example.com" required autoComplete="off" className="gm-input" />
            </div>
            <div className="gm-field">
              <label className="gm-label" htmlFor="gmInviteRel">Relationship</label>
              <select id="gmInviteRel" value={invitationRelationship} onChange={e => setInvitationRelationship(e.target.value)}
                className="gm-select">
                {RELATIONSHIP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div className="gm-block" role="group" aria-labelledby="gmPresetLabel">
            <span className="gm-label" id="gmPresetLabel">Permission Preset</span>
            <div className="gm-preset-group">
              {PERMISSION_PRESETS.map(p => (
                <button type="button" key={p.value}
                  onClick={() => setInvitationPreset(p.value)}
                  aria-pressed={invitationPreset === p.value}
                  className={`gm-preset${invitationPreset === p.value ? ' is-active' : ''}`}>
                  {p.label}
                </button>
              ))}
            </div>
            {invitationPreset === 'custom' ? (
              <div className="gm-custom-grid">
                {PERMISSION_DEFINITIONS.map(p => (
                  <label key={p.key} className="gm-check">
                    <input type="checkbox" checked={!!customPermissions[p.key]}
                      onChange={e => setCustomPermissions({ ...customPermissions, [p.key]: e.target.checked })} />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="gm-preset-summary" aria-live="polite">
                <strong>Includes:</strong> {presetSummary.length ? presetSummary.join(' · ') : 'No permissions'}
              </div>
            )}
          </div>

          <div className="gm-block">
            <label className="gm-label" htmlFor="gmInviteMsg">Personal Message (optional)</label>
            <textarea id="gmInviteMsg" value={invitationMessage} onChange={e => setInvitationMessage(e.target.value)}
              maxLength={1000} placeholder="Add a note for the invitee..." className="gm-textarea" />
          </div>

          <div className="gm-form-actions">
            <button type="submit" disabled={sending || childrenLoading || !selectedChild} className="gm-btn gm-btn--primary">
              {childrenLoading ? 'Loading...' : sending ? 'Sending...' : 'Send Invitation'}
            </button>
          </div>
        </form>

        {shareInfo && (
          <div className="gm-notice gm-notice--warn" role="alert">
            The invitation for <strong>{shareInfo.email}</strong> was saved, but the email could not be delivered.
            Try <strong>Resend</strong> below in a few minutes, or share this link with them directly:
            {shareInfo.url && (
              <div className="gm-notice-link">
                <input type="text" readOnly value={shareInfo.url} aria-label="Invitation link" onFocus={e => e.target.select()} />
                <button type="button" className="gm-btn gm-btn--secondary gm-btn--sm" onClick={copyShareLink}>Copy link</button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ===== Pending Invitations Card ===== */}
      <section className="gm-card" aria-labelledby="gmPendingTitle">
        <div className="gm-card-head">
          <h2 id="gmPendingTitle">Pending Invitations</h2>
          {pendingForChild.length > 0 && <span className="gm-count">{pendingForChild.length} waiting</span>}
        </div>
        {pendingForChild.length === 0 ? (
          <p className="gm-empty">No pending invitations{childName ? ` for ${childName}` : ''}.</p>
        ) : (
          <div className="table-scroll"><table className="gm-table gm-table--stack">
            <thead>
              <tr>
                <th>Email</th>
                <th>Relationship</th>
                <th>Status</th>
                <th>Expires</th>
                <th className="gm-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pendingForChild.map(inv => {
                const busy = !!busyIds[inv.id];
                return (
                  <tr key={inv.id}>
                    <td data-label="Email">
                      <span className="gm-person"><strong>{inv.sentTo || '—'}</strong>
                        {inv.emailSent === false && !inv.isExpired && <span>Email not delivered — try Resend</span>}
                      </span>
                    </td>
                    <td data-label="Relationship">{inv.relationshipLabel || relationshipLabel(inv.relationship) || '—'}</td>
                    <td data-label="Status">
                      <span className={`gm-status gm-status--${inv.isExpired ? 'expired' : 'pending'}`}>
                        {inv.isExpired ? 'Expired' : 'Pending'}
                      </span>
                    </td>
                    <td data-label="Expires" className="gm-muted">{expiryText(inv)}</td>
                    <td className="gm-col-actions">
                      <div className="gm-action-group">
                        <button type="button" onClick={() => handleResend(inv)} disabled={busy || !inv.sentTo}
                          className="gm-btn gm-btn--secondary gm-btn--sm">{busy ? 'Working…' : 'Resend'}</button>
                        <button type="button" onClick={() => handleRevokeInvite(inv)} disabled={busy}
                          className="gm-btn gm-btn--danger gm-btn--sm">Revoke</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      {/* ===== Linked Guardians Card ===== */}
      <section className="gm-card" aria-labelledby="gmLinkedTitle">
        <div className="gm-card-head">
          <h2 id="gmLinkedTitle">{childName ? `Linked Guardians – ${childName}` : 'Linked Guardians'}</h2>
          {linkedState === 'ready' && linkedGuardians.length > 0 && <span className="gm-count">{activeGuardianCount} active</span>}
        </div>
        {linkedState === 'loading' && <p className="gm-empty">Loading guardians…</p>}
        {linkedState === 'forbidden' && <p className="gm-empty">Only the primary parent or guardian of this child can view and manage its linked guardians.</p>}
        {linkedState === 'error' && <p className="gm-empty">Could not load linked guardians. Refresh the page to try again.</p>}
        {(linkedState === 'ready' || linkedState === 'idle') && linkedGuardians.length === 0 && (
          <p className="gm-empty">No linked guardians{childName ? ` for ${childName}` : ''} yet. Invited guardians appear here once they accept.</p>
        )}
        {linkedState === 'ready' && linkedGuardians.length > 0 && (
          <div className="table-scroll"><table className="gm-table gm-table--stack">
            <thead>
              <tr>
                <th>Guardian</th>
                <th>Relationship</th>
                <th>Status</th>
                <th>Access</th>
                <th className="gm-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {linkedGuardians.map(g => {
                const busy = !!busyIds[g.id];
                const isActive = g.status === 'active';
                const canAct = isActive && !g.isPrimary;
                const count = grantedLabels(g.permissions).length;
                return (
                  <tr key={g.id}>
                    <td data-label="Guardian">
                      <span className="gm-person"><strong>{g.name || '—'}</strong><span>{g.email || ''}</span></span>
                    </td>
                    <td data-label="Relationship">{g.relationshipLabel || ROLE_LABELS[g.role] || 'Guardian'}</td>
                    <td data-label="Status">
                      <span className="gm-badges">
                        <span className={`gm-status gm-status--${g.status}`}>{g.status.charAt(0).toUpperCase() + g.status.slice(1)}</span>
                        {g.isPrimary && <span className="gm-status gm-status--primary">Primary</span>}
                      </span>
                    </td>
                    <td data-label="Access" className="gm-muted">{isActive ? `${count} permission${count === 1 ? '' : 's'}` : 'No access'}</td>
                    <td className="gm-col-actions">
                      {canAct ? (
                        <div className="gm-action-group">
                          <button type="button" onClick={() => window.gmOpenPermModal(g)} disabled={busy} className="gm-btn gm-btn--secondary gm-btn--sm">Edit</button>
                          <button type="button" onClick={() => window.gmOpenTransferModal(g)} disabled={busy} className="gm-btn gm-btn--secondary gm-btn--sm">Transfer</button>
                          <button type="button" onClick={() => handleRevokeGuardian(g)} disabled={busy} className="gm-btn gm-btn--danger gm-btn--sm">{busy ? 'Working…' : 'Revoke'}</button>
                        </div>
                      ) : <span className="gm-muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      {/* Message Toast */}
      {message.text && (
        <div className={`gm-message-toast ${message.type === 'success' ? 'success' : 'error'}`}
          role={message.type === 'error' ? 'alert' : 'status'} onClick={() => setMessage({ text: '', type: '' })}>
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
