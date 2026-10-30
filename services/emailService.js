// services/emailService.js
// KinderCura branded email templates for the Linked Guardian Account System.
// Uses nodemailer; gracefully degrades to console logs when EMAIL_USER / EMAIL_PASS
// are not configured in .env.
require('dotenv').config();
const nodemailer = require('nodemailer');
const { wrapEmail } = require('../routes/appointments');
const httpEmail = require('./httpEmail');

// Public origin used for links and images inside outgoing emails.
// APP_URL wins when set. On Vercel it falls back to the deployment's own
// public hostname, so a forgotten env var sends a working link instead of a
// localhost one that no recipient can open. Local development keeps its old
// default.
function appUrl() {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/$/, '');
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) return `https://${vercelHost}`;
  return 'http://localhost:3001';
}

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

  // Google shows an App Password as "abcd efgh ijkl mnop"; the spaces are
  // display only and make Gmail reject the login if they are pasted along.
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: String(process.env.EMAIL_USER).trim(),
      pass: String(process.env.EMAIL_PASS).replace(/\s+/g, ''),
    },
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
  viewRecommendations:'View Recommendations',
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
  // viewMedicalRecords is a level ('none' | 'partial' | 'full'), not a boolean.
  const rows = Object.entries(perms).map(([key, val]) =>
    permRow(permissionLabelMap[key] || key, typeof val === 'string' ? val !== 'none' : Boolean(val))
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
        ? `<img src="${appUrl()}${escapeHtml(c.profileIcon)}" class="km-child-avatar" alt="" onerror="this.style.display='none'"/>`
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

/* ─────────────────── delivery ─────────────────── */

// Guardian emails used to go out over Gmail SMTP only. The production host
// blocks outbound SMTP (see services/httpEmail.js), so they never arrived while
// the OTP emails — which already use the HTTPS API — did. Same choice as
// routes/auth.js: EMAIL_API_KEY → provider HTTPS API, otherwise SMTP.
//
// Never throws. `sent: true` means the provider accepted the message; anything
// else is reported back so the caller never claims an email went out when it
// did not. Recipients, links and invitation codes are never logged.
const GUARDIAN_MAIL_DEADLINE_MS = 15000;

async function deliver({ to, subject, html, text, kind }) {
  const recipient = String(to || '').trim();
  if (!recipient) return { sent: false, reason: 'NO_RECIPIENT' };
  try {
    if (httpEmail.httpEmailConfigured()) {
      await httpEmail.sendViaHttp({ to: recipient, subject, html, fromName: 'KinderCura' }, GUARDIAN_MAIL_DEADLINE_MS);
      return { sent: true, transport: 'https-api' };
    }
    const transporter = getTransporter();
    if (!transporter) {
      console.warn(`[emailService] ${kind}: no email transport configured (EMAIL_API_KEY or EMAIL_USER/EMAIL_PASS) — not sent.`);
      return { sent: false, reason: 'NOT_CONFIGURED' };
    }
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`MAIL_TIMEOUT after ${GUARDIAN_MAIL_DEADLINE_MS}ms`)), GUARDIAN_MAIL_DEADLINE_MS);
    });
    await Promise.race([
      transporter.sendMail({ from: `"KinderCura" <${process.env.EMAIL_USER}>`, to: recipient, subject, html, text }),
      deadline,
    ]).finally(() => clearTimeout(timer));
    return { sent: true, transport: 'smtp' };
  } catch (err) {
    console.error(`[emailService] ${kind} failed: ${err?.code || 'ERROR'} ${err?.message || ''}`.trim());
    return { sent: false, reason: 'SEND_FAILED' };
  }
}

function loginUrl() {
  return `${appUrl()}/login.html`;
}

// The page the invitation email links to. Also returned to the inviter so a
// failed email can still be shared another way.
function acceptUrlFor(code) {
  return `${appUrl()}/accept-invitation?code=${encodeURIComponent(code)}`;
}

function namesList(names = []) {
  const clean = names.filter(Boolean);
  if (clean.length <= 1) return clean[0] || 'your child';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/* ─────────────────── PUBLIC API ─────────────────── */

/**
 * Invitation email for a prospective linked guardian.
 * Child details are limited to names: no assessment, result or medical data.
 * @returns {Promise<{sent:boolean, reason?:string, transport?:string}>}
 */
async function sendInvitationEmail({
  to, inviterName, children: invitedChildren = [], permissions, code,
  relationship, permissionPreset, personalMessage, expiresAt,
}) {
  const childNames = invitedChildren.map(c => `${c.firstName || ''} ${c.lastName || ''}`.trim());
  const childLabel = namesList(childNames);
  const relLabel = _relationshipLabels[relationship] || 'Guardian';
  const presetLabel = { full: 'Full', standard: 'Standard', medical: 'Medical Only', limited: 'Limited', custom: 'Custom' }[permissionPreset] || 'Standard';
  const fromName = inviterName || 'A KinderCura parent';

  const acceptUrl = acceptUrlFor(code);
  const expiry = expiresAt ? new Date(expiresAt) : null;
  const expiryStr = expiry
    ? expiry.toLocaleString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })
    : null;

  const personalMsgBlock = personalMessage
    ? `<div class="km-msg"><strong>Message from ${escapeHtml(fromName)}:</strong><br/>${escapeHtml(personalMessage)}</div>`
    : '';

  const body = `
    <p style="margin-bottom:18px">Hello,</p>
    <p style="margin-bottom:18px;font-size:1rem">
      <strong>${escapeHtml(fromName)}</strong> has invited you to become a linked guardian
      (<strong>${escapeHtml(relLabel)}</strong>) for <strong>${escapeHtml(childLabel)}</strong> on KinderCura,
      with <em>${escapeHtml(presetLabel)} Access</em>.
    </p>
    <div class="km-section"><h3>👶 Child${childNames.length > 1 ? 'ren' : ''}</h3>${childCardsHtml(invitedChildren.map(c => ({ firstName: c.firstName, lastName: c.lastName })))}</div>
    <div class="km-section"><h3>🔐 What you will be able to do</h3><div class="km-perm-list">${buildPermissionBlock(permissions || {})}</div></div>
    ${personalMsgBlock}
    <div class="km-section">
      <h3>How to accept</h3>
      <p style="font-size:0.92rem;line-height:1.6">
        1. Open the invitation with the button below.<br/>
        2. Already have a KinderCura account with <strong>${escapeHtml(to)}</strong>? Choose <strong>Log In</strong>, then <strong>Accept</strong>.<br/>
        3. New to KinderCura? Choose <strong>Create Account</strong> on that page — use this same email address.
      </p>
    </div>
    <div style="text-align:center;margin:24px 0">${actionButton('Open Invitation', acceptUrl)}</div>
    <div class="km-warn" role="alert">
      ${expiryStr ? `This invitation expires on ${escapeHtml(expiryStr)}.` : 'This invitation expires soon.'}
      If you did not expect this email, you can safely ignore it.
    </div>
  `;

  const html = wrap('Guardian Invitation', `${fromName} invited you as a linked guardian.`, body);
  const text = [
    'KinderCura – Guardian Invitation',
    '',
    `${fromName} has invited you to become a linked guardian (${relLabel}) for ${childLabel} on KinderCura (${presetLabel} Access).`,
    '',
    `Open the invitation: ${acceptUrl}`,
    `If you already have an account with ${to}, log in and accept. Otherwise choose "Create Account" on that page using this email.`,
    expiryStr ? `This invitation expires on ${expiryStr}.` : '',
  ].join('\n').trim();

  return deliver({
    to, html, text, kind: 'invitation',
    subject: `${fromName} invited you to KinderCura as a linked guardian`,
  });
}

/**
 * Confirmation that a guardian is now linked to one or more children.
 * Sent only after the GuardianLink records were saved.
 * `accountCreatedBy` is set when the parent created the account directly — the
 * password is never included; the guardian gets it from that parent.
 */
async function sendWelcomeEmail({ to, guardianName, childNames, childName, inviterName, accountCreatedBy }) {
  const label = namesList(childNames || (childName ? [childName] : []));
  const signInHelp = accountCreatedBy
    ? `<p style="margin-bottom:14px">
         ${escapeHtml(accountCreatedBy)} created your KinderCura account. Sign in with
         <strong>${escapeHtml(to)}</strong> and the password ${escapeHtml(accountCreatedBy)} set for you —
         for your security it is not included in this email. After signing in, you can change it from
         <strong>Profile &rsaquo; Change Password</strong>.
       </p>`
    : `<p style="margin-bottom:14px">Sign in with <strong>${escapeHtml(to)}</strong> and your KinderCura password.</p>`;

  const body = `
    <p style="margin-bottom:18px">Hi ${escapeHtml(guardianName || 'there')},</p>
    <p style="margin-bottom:18px">
      You are now a linked guardian for <strong>${escapeHtml(label)}</strong> on KinderCura${inviterName ? `, added by ${escapeHtml(inviterName)}` : ''}.
    </p>
    ${signInHelp}
    <p style="margin-bottom:14px">
      Once signed in, ${escapeHtml(label)} appears on your dashboard. What you can see and do follows the
      access level the primary parent chose for you.
    </p>
    <div style="margin:18px 0;text-align:center">${actionButton('Sign In to KinderCura', loginUrl())}</div>
    <p style="margin-bottom:8px;color:#6B7967;font-size:0.9rem">
      If you were not expecting this, contact the child's primary parent or KinderCura support.
    </p>
  `;
  const html = wrap('Guardian Linked', 'You are now a linked guardian.', body);
  const text = [
    `Hi ${guardianName || 'there'},`,
    '',
    `You are now a linked guardian for ${label} on KinderCura${inviterName ? `, added by ${inviterName}` : ''}.`,
    accountCreatedBy
      ? `${accountCreatedBy} created your account. Sign in with ${to} and the password they set for you (not included here for security). You can change it in Profile > Change Password.`
      : `Sign in with ${to} and your KinderCura password.`,
    '',
    `Sign in: ${loginUrl()}`,
  ].join('\n');

  return deliver({ to, html, text, kind: 'guardian-linked', subject: `You are now linked to ${label} on KinderCura` });
}

/**
 * Tell the inviter that their invitation was accepted.
 */
async function sendAcceptanceNotification({ to, inviterName, acceptorName, acceptorEmail, childName }) {
  const who = acceptorName || acceptorEmail || 'Your invited guardian';
  const body = `
    <p style="margin-bottom:18px">Hi ${escapeHtml(inviterName || 'there')},</p>
    <p style="margin-bottom:18px">
      <strong>${escapeHtml(who)}</strong> accepted your guardian invitation
      and is now linked to <strong>${escapeHtml(childName || 'your child')}</strong>.
    </p>
    <div style="margin:18px 0">${actionButton('Manage Guardians', `${appUrl()}/parent/guardians`)}</div>
  `;
  const html = wrap('Invitation Accepted', `${who} accepted your invitation.`, body);
  return deliver({ to, html, kind: 'acceptance-notice', subject: `${who} accepted your KinderCura guardian invitation` });
}

/* ─────────────────── payment receipt ─────────────────── */

function receiptRow(label, value) {
  return `<tr>
    <td style="padding:7px 0;color:#6B7967;font-size:0.9rem;white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:7px 0 7px 18px;color:#3D4738;font-weight:600;font-size:0.92rem">${escapeHtml(value ?? '—')}</td>
  </tr>`;
}

function formatPeso(amount, currency = 'PHP') {
  const n = Number(amount);
  const shown = Number.isFinite(n)
    ? n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
  return currency === 'PHP' ? `₱${shown}` : `${currency} ${shown}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatDateOnly(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatClockTime(value) {
  if (!value) return '—';
  const [h, m] = String(value).split(':').map(Number);
  if (!Number.isFinite(h)) return String(value);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${(h % 12) || 12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

/**
 * Send the KinderCura payment receipt.
 * Covers both payment routes — `context.paymentMethodLabel` is what
 * distinguishes an online PayMongo receipt from a paid-at-clinic one.
 *
 * Callers must go through receiptService.settlePayment(), which guarantees
 * this runs at most once per payment even if a webhook is redelivered.
 */
async function sendPaymentReceiptEmail(context = {}) {
  const {
    clinic = {}, receiptNumber, paymentRef, parentName, parentEmail, contactPhone,
    childName, pediatricianName, appointmentId, appointmentDate, appointmentTime,
    service, paymentMethod, paymentMethodLabel, amount, currency = 'PHP', paidAt, status = 'Paid',
  } = context;

  if (!parentEmail) {
    return { sent: false, message: 'No recipient email supplied.' };
  }

  // Prefer the label the caller already resolved (receiptService normalizes
  // this once so the email and the website never disagree on the wording —
  // including the actual GCash/Maya brand when PayMongo reported it).
  const methodLabel = paymentMethodLabel || {
    paymongo: 'Paid Online (PayMongo)',
    pay_at_clinic: 'Paid at Clinic',
    cash: 'Cash at Clinic',
    ewallet: 'E-Wallet Transfer',
  }[paymentMethod] || String(paymentMethod || 'Payment');

  const amountStr = formatPeso(amount, currency);

  const body = `
    <p style="margin-bottom:16px">Hi ${escapeHtml(parentName || 'there')},</p>
    <p style="margin-bottom:18px">
      We have received your payment. This email is your payment receipt from
      ${brandLine(escapeHtml(clinic.clinicName || 'KinderCura'), '#6B8E6F')}.
    </p>

    <div class="km-section">
      <h3>🧾 Payment Receipt</h3>
      <table style="width:100%;border-collapse:collapse">
        ${receiptRow('Receipt Number', receiptNumber)}
        ${receiptRow('Payment Reference', paymentRef)}
        ${receiptRow('Parent Name', parentName)}
        ${receiptRow('Child Name', childName)}
        ${receiptRow('Pediatrician', pediatricianName)}
        ${receiptRow('Appointment', appointmentId ? `#${appointmentId}` : '—')}
        ${receiptRow('Appointment Date', formatDateOnly(appointmentDate))}
        ${receiptRow('Appointment Time', formatClockTime(appointmentTime))}
        ${receiptRow('Service', service)}
        ${receiptRow('Payment Method', methodLabel)}
        ${receiptRow('Amount Paid', amountStr)}
        ${receiptRow('Payment Date', formatDateTime(paidAt))}
        ${receiptRow('Payment Status', String(status).toUpperCase())}
        ${contactPhone ? receiptRow('Contact Mobile', contactPhone) : ''}
      </table>
    </div>

    <div class="km-warn">
      Please keep this receipt for your records. Present the receipt number if
      you have any question about this payment.
    </div>

    <div class="km-section">
      <h3>📍 Clinic</h3>
      <p style="font-size:0.9rem;line-height:1.7">
        ${escapeHtml(clinic.clinicName || 'KinderCura Clinic')}<br/>
        ${escapeHtml(clinic.address || '')}<br/>
        ${escapeHtml(clinic.phoneNumber || '')}<br/>
        ${escapeHtml(clinic.email || '')}
      </p>
    </div>
  `;

  const html = wrap('Payment Receipt', `Receipt ${receiptNumber || ''}`.trim(), body, '#6B8E6F');

  const text = `
KINDER CURA
Payment Receipt

Receipt Number:     ${receiptNumber || '—'}
Payment Reference:  ${paymentRef || '—'}
Parent Name:        ${parentName || '—'}
Child Name:         ${childName || '—'}
Pediatrician:       ${pediatricianName || '—'}
Appointment Date:   ${formatDateOnly(appointmentDate)}
Appointment Time:   ${formatClockTime(appointmentTime)}
Service:            ${service || '—'}
Payment Method:     ${methodLabel}
Amount Paid:        ${amountStr}
Payment Date:       ${formatDateTime(paidAt)}
Payment Status:     ${String(status).toUpperCase()}
${contactPhone ? `Contact Mobile:     ${contactPhone}\n` : ''}
${clinic.clinicName || 'KinderCura Clinic'}
${clinic.address || ''}
${clinic.phoneNumber || ''}
  `.trim();

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`\n[EMAIL – PAYMENT RECEIPT]\nTo: ${parentEmail}\n${text}\n`);
    return { sent: false, message: 'No transporter configured — logged to console.' };
  }

  await transporter.sendMail({
    from: `"KinderCura" <${process.env.EMAIL_USER}>`,
    to: String(parentEmail).trim(),
    subject: `KinderCura Payment Receipt ${receiptNumber || ''} — ${amountStr}`.replace(/\s+/g, ' ').trim(),
    html,
    text,
  });
  return { sent: true };
}

/* ─────────────────── reminders ─────────────────── */

// Email copy of a bell reminder from the daily job (services/reminders.js):
// appointment tomorrow, next assessment due, or the parent's own recurring
// assessment reminder. Same title and message as the bell. Never throws.
async function sendReminderEmail({ to, name, title, message, relatedPage }) {
  const link = `${appUrl()}${relatedPage || '/parent/dashboard'}`;
  const body = `
    <p>Hi ${escapeHtml(name || 'there')},</p>
    <p>${escapeHtml(message)}</p>
    <p style="text-align:center;margin:24px 0">${actionButton('Open KinderCura', link)}</p>
    <p style="color:#6B7967;font-size:13px">You get this email because Reminder Emails is on in Settings → Notifications. Reminders always appear in your KinderCura notifications too.</p>`;
  return deliver({
    to,
    subject: `KinderCura: ${title}`,
    html: wrap(title, title, body),
    text: `${message}\n\nOpen KinderCura: ${link}`,
    kind: 'reminder',
  });
}

module.exports = {
  sendReminderEmail,
  sendInvitationEmail,
  sendWelcomeEmail,
  sendAcceptanceNotification,
  sendPaymentReceiptEmail,
  getTransporter,
  acceptUrlFor,
};
