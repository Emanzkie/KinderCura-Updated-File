// services/emailService.js
// KinderCura branded email templates for the Linked Guardian Account System.
// Uses nodemailer; gracefully degrades to console logs when EMAIL_USER / EMAIL_PASS
// are not configured in .env.
require('dotenv').config();
const nodemailer = require('nodemailer');
const { wrapEmail } = require('../routes/appointments');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const configured =
    process.env.EMAIL_USER &&
    process.env.EMAIL_PASS &&
    process.env.EMAIL_USER !== 'your_email@gmail.com' &&
    process.env.EMAIL_PASS !== 'your_gmail_app_password';

  if (!configured) {
    console.warn('[emailService] EMAIL_USER / EMAIL_PASS not configured — emails will be logged only.');
    return null;
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  return _transporter;
}

/* ─────────────────── helpers ─────────────────── */

function brandLine(text, color = '#E8A5A5') {
  return `<span style="color:${color};font-weight:700">${text}</span>`;
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function childTag(child, index) {
  const name = `${child.firstName || ''} ${child.lastName || ''}`.trim() || 'Child';
  const age  = child.dateOfBirth ? `${Math.max(0, Math.round((Date.now() - new Date(child.dateOfBirth)) / 31557600000))} yrs` : '';
  return `<span class="km-child-tag">${escapeHtml(name)} ${age ? '(' + escapeHtml(age) + ')' : ''}</span>`;
}

const _relationshipLabels = {
  mother:'Mother', father:'Father', grandparent:'Grandparent',
  legal_guardian:'Legal Guardian', foster_parent:'Foster Parent',
  court_appointed:'Court-Appointed', nanny:'Nanny / Babysitter',
  babysitter:'Babysitter', therapist:'Therapist', teacher:'Teacher', other:'Other',
};

function permRow(label, has) {
  const icon = has ? '✅' : '⬜';
  return `<div class="km-perm-row"><span class="km-perm-icon">${icon}</span><span>${label}</span></div>`;
}

const permissionLabelMap = {
  viewAssessments:    'View Assessments & Results',
  submitAssessments:  'Submit / Complete Assessments',
  viewResults:        'View Assessment Results',
  uploadDocuments:    'Upload Documents & Photos',
  manageAppointments: 'Manage Appointments',
  viewMedicalRecords: 'View Medical Records',
  modifyChild:        'Modify Child Profile',
  inviteGuardians:    'Invite Other Guardians',
  revokeAccess:       'Revoke Access',
  viewMessages:       'View Chat Messages',
  sendMessages:       'Send Chat Messages',
  manageMessages:     'Manage Messages',
  viewNotifications:  'View Notifications',
  sendNotifications:  'Send Notifications',
  manageNotifications:'Manage Notifications',
};

function buildPermissionBlock(perms = {}) {
  const rows = Object.entries(perms).map(([key, val]) =>
    permRow(permissionLabelMap[key] || key, Boolean(val))
  ).join('');
  return rows || '<p class="km-muted">— No permissions set —</p>';
}

function actionButton(text, href, bgColor = '#6B8E6F') {
  return `<a href="${escapeHtml(href)}" class="km-btn" style="background:${bgColor}">${escapeHtml(text)}</a>`;
}

function childCardsHtml(children = []) {
  if (!children.length) return '<p class="km-muted">No children specified.</p>';
  return `<div class="km-child-grid">${children.map(c => `
    <div class="km-child-card">
      ${c.profileIcon && c.profileIcon !== 'child1' && !c.profileIcon.startsWith('http')
        ? `<img src="${process.env.APP_URL || 'http://localhost:3001'}${escapeHtml(c.profileIcon)}" class="km-child-avatar" alt="" onerror="this.style.display='none'"/>`
        : ''}
      <div class="km-child-info">
        <strong>${escapeHtml(`${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Child')}</strong>
        ${c.dateOfBirth ? `<br/><small>Age: ${Math.max(0, Math.round((Date.now() - new Date(c.dateOfBirth)) / 31557600000))}</small>` : ''}
      </div>
    </div>
  `).join('')}</div>`;
}

/* ─────────────────── wrapper ─────────────────── */

const baseStyles = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f5f5f0;color:#3D4738}
  .km-wrapper{max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;
               box-shadow:0 4px 30px rgba(0,0,0,0.12)}
  .km-bar{background:linear-gradient(135deg,#6B8E6F 0%,#8BA98D 100%);padding:28px 32px;text-align:center}
  .km-bar h1{color:#fff;font-size:1.55rem;margin-bottom:4px}
  .km-bar p{color:rgba(255,255,255,0.85);font-size:0.95rem}
  .km-body{padding:28px 32px}
  .km-section{margin-bottom:22px}
  .km-section h3{color:#6B8E6F;font-size:1.05rem;margin-bottom:10px;display:flex;align-items:center;gap:6px}
  .km-muted{color:#6B7967;font-size:0.9rem;font-style:italic}
  .km-child-grid{display:flex;flex-wrap:wrap;gap:10px}
  .km-child-card{display:flex;align-items:center;gap:10px;
                  background:var(--bg-primary,#FAFAF6);border:2px solid #DDD9CC;
                  border-radius:10px;padding:8px 14px}
  .km-child-avatar{width:36px;height:36px;object-fit:cover;border-radius:50%}
  .km-child-info small{color:#6B7967;font-size:0.82rem}
  .km-perm-list{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .km-perm-row{display:flex;align-items:center;gap:6px;font-size:0.88rem}
  .km-perm-icon{font-size:0.85rem}
  .km-btn{display:inline-block;padding:12px 26px;border-radius:8px;font-weight:700;
           text-decoration:none;font-size:1rem;text-align:center;margin:6px 4px 0 0}
  .km-footer{background:#fafafa;border-top:1px solid #DDD9CC;padding:18px 32px;
              text-align:center;font-size:0.82rem;color:#6B7967;line-height:1.6}
  .km-warn{background:#F4D89F;border-left:4px solid #E8A5A5;padding:10px 14px;
            border-radius:6px;margin-bottom:16px;font-size:0.88rem;color:#3D4738}
  .km-msg{border-left:4px solid #D4897A;padding:10px 14px;border-radius:6px;
           font-size:0.9rem;color:#3D4738;margin-bottom:14px}
`;

function wrap(name, brand, body, brandColor = '#E8A5A5') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>KinderCura — ${escapeHtml(name)}</title>
<style>${baseStyles}</style></head><body style="padding:16px">
<div class="km-wrapper">
  <div class="km-bar">
    <h1><span style="color:${escapeHtml(brandColor)}">Kinder</span>Cura</h1>
    <p>${escapeHtml(brand)}</p>
  </div>
  <div class="km-body">${body}</div>
  <div class="km-footer">
    <p>KinderCura — Supporting Your Child's Development Journey</p>
    <p style="margin-top:6px">© ${new Date().getFullYear()} KinderCura. All rights reserved.</p>
  </div>
</div>
</body></html>`;
}

/* ─────────────────── PUBLIC API ─────────────────── */

/**
 * Send a guardian invitation acceptance email.
 * @param {Object} opts
 * @param {string} opts.to            – recipient email
 * @param {string} opts.inviterName   – name of the person who sent the invite
 * @param {string} opts.inviterEmail  – email of inviter
 * @param {Array}  opts.children      – child detail objects attached to the invite
 * @param {Object} opts.permissions   – permissions map from GuardianInvitation
 * @param {Object} [opts.invitation]  – full GuardianInvitation document (for childIds fallback, relationship, preset)
 * @param {string} [opts.code]        – raw invitation code (pre-registration only)
 * @param {string} [opts.acceptUrl]   – override the accept-link base URL
 * @param {string} [opts.relationship] – relationship label for the email body
 * @param {string} [opts.permissionPreset] – preset name for context
 * @param {string} [opts.personalMessage]  – optional personal note from inviter
 */
async function sendInvitationEmail({
  to, inviterName, inviterEmail, children: invitedChildren, permissions, invitation, code,
  relationship, permissionPreset, personalMessage, expiresAt,
}) {
  const childDisplay = invitedChildren && invitedChildren.length
    ? invitedChildren
    : (invitation && invitation.childIds && invitation.childIds.length
        ? invitation.childIds.map(ci => ({ firstName: '', lastName: '' }))
        : [{ firstName: '', lastName: '' }]);

  const permHtml    = buildPermissionBlock(permissions || {});
  const relLabel    = (invitation?.relationship && _relationshipLabels[invitation.relationship])
    || relationship || 'a KinderCura user';
  const presetLabel = (permissionPreset || invitation?.permissionPreset || 'standard')
    .charAt(0).toUpperCase() + (permissionPreset || invitation?.permissionPreset || 'standard').slice(1);

  const baseUrl  = process.env.APP_URL || 'http://localhost:3001';
  const codePath = code ? `?code=${encodeURIComponent(code)}` : '';
  const acceptBtn = `<a href="${baseUrl}/accept-invitation${codePath}"
    class="km-btn" style="background:#6B8E6F">Accept</a>`;

  const expiryStr = expiresAt
    ? `${Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 86400000))} days`
    : '7 days';

  const personalMsgBlock = personalMessage || invitation?.personalMessage
    ? `<div class="km-msg"><strong>Message from the inviter:</strong><br/>${escapeHtml(personalMessage || invitation.personalMessage)}</div>`
    : '';

  const body = `
    <p style="margin-bottom:18px">Hello,</p>
    <p style="margin-bottom:18px;font-size:1rem">
      <strong>${escapeHtml(inviterName)}</strong> has invited you to join KinderCura as a
      <strong>${escapeHtml(relLabel)}</strong> for the following child${childDisplay.length > 1 ? 'ren' : ''}
      <em>(${escapeHtml(presetLabel)} Access)</em>:
    </p>
    <div class="km-section"><h3>👶 Child${childDisplay.length > 1 ? 'ren' : ''} Included</h3>${childCardsHtml(childDisplay)}</div>
    <div class="km-section"><h3>🔐 Permissions Granted</h3><div class="km-perm-list">${permHtml}</div></div>
    ${personalMsgBlock}
    <p style="margin:18px 0 10px;font-size:0.9rem;color:#6B7967">
      Once you accept, you'll be able to access the child's profile, appointments,
      medical records, and assessments in line with the permissions listed above.
    </p>
    <div style="text-align:center;margin:24px 0">${acceptBtn}</div>
    <div class="km-warn" role="alert">
      ⚠️ This invitation expires in ${expiryStr}. If you did not expect this email, you may safely ignore it.
    </div>
  `;

  const html = wrap('Guardian Invitation', `${inviterName || 'A KinderCura user'} has invited you as ${relLabel}.`, body);

  const text = `
KinderCura – Guardian Invitation

${inviterName || 'A KinderCura user'} has invited you as ${relLabel} (${presetLabel} access).

To accept: ${baseUrl}/accept-invitation${codePath}

This invitation expires in ${expiryStr}.
  `.trim();

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`\n[EMAIL – INVITATION]\nTo: ${to}\n${text}\n`);
    return { sent: false, message: 'No transporter configured — logged to console.' };
  }

  try {
    await transporter.sendMail({
      from: `"KinderCura" <${process.env.EMAIL_USER}>`,
      to: to.trim(),
      subject: `${inviterName || 'Someone'} invited you to join KinderCura as a guardian`,
      html,
      text,
    });
    return { sent: true };
  } catch (err) {
    console.error('Invitation email error:', err.message);
    return { sent: false, message: err.message };
  }
}

/**
 * Send a welcome email after a guardian accepts the invitation.
 */
async function sendWelcomeEmail({ to, guardianName, childName, inviterName, inviterEmail }) {
  const body = `
    <p style="margin-bottom:18px">Hi ${escapeHtml(guardianName)},</p>
    <p style="margin-bottom:18px">
      Welcome to KinderCura! You now have access to <strong>${escapeHtml(childName)}</strong>'s profile.
    </p>
    <div style="margin:18px 0">
      <a href="${process.env.APP_URL || 'http://localhost:3001'}/parent/dashboard.html"
         class="km-btn" style="background:#6B8E6F">Go to Dashboard</a>
    </div>
    <p style="margin-bottom:8px;color:#6B7967;font-size:0.9rem">
      If you have questions, reach out to the primary guardian, ${escapeHtml(inviterName)} (${escapeHtml(inviterEmail)}),
      or contact KinderCura support.
    </p>
  `;

  const html = wrap('Welcome to KinderCura', 'You are now a linked guardian.', body);

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`\n[EMAIL – WELCOME]\nTo: ${to}\n`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"KinderCura" <${process.env.EMAIL_USER}>`,
      to: to.trim(),
      subject: `Welcome to KinderCura — you now have access to ${escapeHtml(childName)}`,
      html,
    });
  } catch (err) {
    console.error('Welcome email error:', err.message);
  }
}

/**
 * Notify the primary guardian that someone accepted the invitation.
 */
async function sendAcceptanceNotification({ to, inviterName, acceptorName, acceptorEmail, childName }) {
  const body = `
    <p style="margin-bottom:18px">Hi ${escapeHtml(inviterName)},</p>
    <p style="margin-bottom:18px">
      <strong>${escapeHtml(acceptorName || acceptorEmail)}</strong> has accepted your guardian invitation
      and now has access to <strong>${escapeHtml(childName)}</strong>'s profile.
    </p>
    <div style="margin:18px 0">
      <a href="${process.env.APP_URL || 'http://localhost:3001'}/parent/guardians"
         class="km-btn" style="background:#6B8E6F">Manage Guardians</a>
    </div>
  `;
  const html = wrap('Invitation Accepted', `${acceptorName} accepted your invitation.`, body);

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`\n[EMAIL – ACCEPTANCE NOTIFICATION]\nTo: ${to}\n`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"KinderCura" <${process.env.EMAIL_USER}>`,
      to: to.trim(),
      subject: `${acceptorName || 'Someone'} accepted your KinderCura guardian invitation`,
      html,
    });
  } catch (err) {
    console.error('Acceptance notification error:', err.message);
  }
}

module.exports = {
  sendInvitationEmail,
  sendWelcomeEmail,
  sendAcceptanceNotification,
  getTransporter,
};
