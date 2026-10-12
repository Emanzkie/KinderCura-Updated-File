// controllers/guardianController.js
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Child = require('../models/Child');
const GuardianInvitation = require('../models/GuardianInvitation');
const GuardianLink = require('../models/GuardianLink');
const User = require('../models/User');
const { createLog } = require('./auditController');
const emailService = require('../services/emailService');
const { parseSignupConsent } = require('../constants/legalConsent');
const {
  RELATIONSHIP_LABELS, BOOLEAN_PERMISSION_KEYS,
  roleForRelationship, isValidRelationship, isValidPreset,
  normalizeMedical, resolvePermissions, normalizeEmail,
} = require('../constants/guardianLink');

/* ─────────────────── In-memory rate limiter ───────────────────
   Limits: max 10 invitation emails (new or resent) per user per UTC day.
   No new npm deps — resets at midnight UTC.
   ─────────────────────────────────────────────────────────── */
const _inviteCounters = Object.create(null); //  { `${userId}_${dateStr}` : count }
function _todayStr() { return new Date().toISOString().slice(0, 10); }
function _rateLimitKey(userId) { return `${String(userId)}_${_todayStr()}`; }
const MAX_INVITES_PER_DAY = 10;
function checkInviteRateLimit(userId) {
  const key = _rateLimitKey(userId);
  return (_inviteCounters[key] || 0) < MAX_INVITES_PER_DAY;
}
function recordInviteAttempt(userId) {
  const key = _rateLimitKey(userId);
  _inviteCounters[key] = (_inviteCounters[key] || 0) + 1;
}

// Accounts that can hold a guardian link. Pediatricians, secretaries and admins cannot.
const GUARDIAN_ACCOUNT_ROLES = ['parent', 'legal_guardian', 'foster_parent', 'court_appointed'];
const PRESETS_FOR_DIRECT_ACCOUNTS = ['full', 'standard', 'medical', 'limited'];
// Keys the Guardian Management page lets a parent see and edit.
const DISPLAY_PERMISSION_KEYS = [
  'viewAssessments', 'submitAssessments', 'viewResults', 'viewRecommendations',
  'uploadDocuments', 'manageAppointments', 'viewMedicalRecords', 'modifyChild',
  'inviteGuardians', 'revokeAccess', 'viewMessages', 'sendMessages', 'viewNotifications',
];

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function isObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || '')) && /^[a-f0-9]{24}$/i.test(String(id));
}

// Unique child id strings, or null when any id is malformed.
function cleanChildIds(raw) {
  const list = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== undefined && v !== null && v !== '');
  if (list.some((id) => !isObjectId(id))) return null;
  return [...new Set(list.map(String))];
}

function fullName(person) {
  if (!person) return '';
  return `${person.firstName || ''} ${person.lastName || ''}`.trim();
}

function displayPermissions(perms = {}) {
  const out = {};
  for (const k of DISPLAY_PERMISSION_KEYS) out[k] = perms[k];
  return out;
}

// The permissions an invitation grants. New invitations store the resolved
// permissions for every preset; older ones only meant something for 'custom'.
function invitationPermissions(invitation) {
  const preset = invitation.permissionPreset || 'standard';
  return preset === 'custom'
    ? resolvePermissions('custom', invitation.customPermissions)
    : resolvePermissions(preset);
}

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`;
}

function makeUsername(email) {
  const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
  return `${emailPrefix}_${Date.now().toString(36)}`;
}

function sendError(res, err, fallbackLabel) {
  if (err && err.status) return res.status(err.status).json({ error: err.error, ...(err.extra || {}) });
  if (err && err.code === 11000) {
    return res.status(409).json({ error: 'This guardian is already linked to the selected child.' });
  }
  console.error(`${fallbackLabel} error:`, err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Verify that the caller is the currently active primary guardian for the child.
// Throws with an HTTP-like status/message object on failure.
async function verifyPrimaryGuardian({ childId, callerId }) {
  const child = await Child.findById(childId).lean();
  if (!child) throw { status: 404, error: 'Child not found.' };

  const callerIsOwner = String(child.parentId) === String(callerId);
  if (callerIsOwner) return child;

  const primaryLink = await GuardianLink.findOne({ childId, guardianId: callerId, isPrimary: true, status: 'active' }).lean();
  if (primaryLink) return child;

  throw { status: 403, error: 'Only the current primary guardian may perform this action.' };
}

// Every child must be owned by the caller or have the caller as active primary guardian.
async function assertCanManageChildren(children, user, verb) {
  if (user.role === 'admin') return;
  for (const child of children) {
    if (String(child.parentId) === String(user.userId)) continue;
    const primary = await GuardianLink.exists({ childId: child._id, guardianId: user.userId, isPrimary: true, status: 'active' });
    if (!primary) {
      throw { status: 403, error: `Only the primary parent or guardian of ${fullName(child) || 'this child'} may ${verb}.` };
    }
  }
}

function invitationProblem(invitation) {
  if (!invitation) return { status: 404, error: 'Invitation not found or invalid.' };
  if (invitation.used) return { status: 409, error: 'This invitation has already been used.', extra: { used: true } };
  if (invitation.revokedAt) {
    return { status: 410, error: 'This invitation was cancelled by the sender. Ask them to send a new one.', extra: { revoked: true } };
  }
  if (invitation.expiresAt && new Date() > new Date(invitation.expiresAt)) {
    return { status: 410, error: 'This invitation has expired. Ask the sender to resend it.', extra: { expired: true } };
  }
  if (!invitation.childIds?.length) return { status: 400, error: 'This invitation contains no children.' };
  return null;
}

/* ─────────────────── Linking (shared by every path) ─────────────────── */

// Creates or re-activates one GuardianLink per child for `guardianId`.
// All-or-nothing: if any child fails, every link written by this call is undone,
// so a failure never leaves a half-linked guardian behind.
async function linkGuardianToChildren({ guardianId, childIds, relationship, permissions, createdBy, invitationId = null }) {
  const role = roleForRelationship(relationship);
  const created = [];
  const restored = [];
  const alreadyActive = [];
  try {
    for (const childId of childIds) {
      const existing = await GuardianLink.findOne({ childId, guardianId });
      if (existing && existing.status === 'active') {
        alreadyActive.push(String(childId));
        continue;
      }
      if (existing && existing.status === 'suspended') {
        throw { status: 403, error: 'Access to this child is suspended for this account. Please contact KinderCura support.' };
      }
      const fields = {
        status: 'active', isPrimary: false, role, relationship: relationship || null,
        permissions, invitationId, createdBy, startDate: new Date(), endDate: null,
      };
      if (existing) {
        // revoked, archived or pending → active again with the newly granted access
        restored.push({ link: existing, previous: existing.toObject() });
        existing.set(fields);
        await existing.save();
      } else {
        created.push(await GuardianLink.create({ childId, guardianId, ...fields }));
      }
    }
  } catch (err) {
    for (const link of created) {
      await GuardianLink.findOneAndDelete({ _id: link._id }).catch(() => {});
    }
    for (const { link, previous } of restored) {
      link.set({
        status: previous.status, isPrimary: previous.isPrimary, role: previous.role,
        relationship: previous.relationship ?? null, permissions: previous.permissions,
        invitationId: previous.invitationId ?? null, createdBy: previous.createdBy ?? null,
        startDate: previous.startDate ?? null, endDate: previous.endDate ?? null,
      });
      await link.save().catch(() => {});
    }
    throw err;
  }
  return { created, restored, alreadyActive };
}

// Sends the "you are linked" email (and tells the inviter) at most once per invitation.
async function sendLinkedEmails({ invitation, guardian, children }) {
  const marked = await GuardianInvitation.findOneAndUpdate(
    { _id: invitation._id, acceptanceEmailSentAt: null },
    { $set: { acceptanceEmailSentAt: new Date() } }
  );
  if (!marked) return { guardianEmailSent: null, alreadySent: true };

  const inviter = await User.findById(invitation.createdBy).select('firstName lastName email').lean();
  const childNames = children.map(fullName);
  const guardianMail = await emailService.sendWelcomeEmail({
    to: guardian.email, guardianName: fullName(guardian), childNames, inviterName: fullName(inviter),
  });
  let inviterNotified = false;
  if (inviter?.email) {
    const notice = await emailService.sendAcceptanceNotification({
      to: inviter.email, inviterName: fullName(inviter), acceptorName: fullName(guardian),
      acceptorEmail: guardian.email, childName: childNames.join(', '),
    });
    inviterNotified = notice.sent;
  }
  // Let a later retry (POST /invitations/accept-email) try the guardian email again.
  if (!guardianMail.sent) {
    await GuardianInvitation.updateOne({ _id: invitation._id }, { $set: { acceptanceEmailSentAt: null } });
  }
  return { guardianEmailSent: guardianMail.sent, inviterNotified };
}

// Claims a valid invitation for `guardian` and links them to its children.
// The claim is atomic (used:false → true) so a double click cannot link or email twice;
// if linking fails the claim is released again.
async function completeAcceptance({ invitation, guardian, ip }) {
  const children = await Child.find({ _id: { $in: invitation.childIds } }).select('firstName lastName parentId').lean();
  if (!children.length) throw { status: 404, error: 'The child in this invitation no longer exists.' };
  const linkable = children.filter((c) => String(c.parentId) !== String(guardian._id));
  if (!linkable.length) throw { status: 409, error: 'You are already the primary parent of this child.' };

  const claimed = await GuardianInvitation.findOneAndUpdate(
    { _id: invitation._id, used: false },
    { $set: { used: true, usedBy: guardian._id, usedAt: new Date() } }
  );
  if (!claimed) throw { status: 409, error: 'This invitation has already been used.', extra: { used: true } };

  let linked;
  try {
    linked = await linkGuardianToChildren({
      guardianId: guardian._id,
      childIds: linkable.map((c) => String(c._id)),
      relationship: invitation.relationship,
      permissions: invitationPermissions(invitation),
      createdBy: invitation.createdBy,
      invitationId: invitation._id,
    });
  } catch (err) {
    await GuardianInvitation.updateOne({ _id: invitation._id }, { $set: { used: false, usedBy: null, usedAt: null } }).catch(() => {});
    throw err;
  }

  await createLog({
    actorId: guardian._id, action: 'invitation:accept', targetType: 'Child', targetId: linkable[0]._id,
    details: { invitationId: invitation._id, childCount: linkable.length, alreadyActive: linked.alreadyActive.length },
    ip,
  });

  const emails = await sendLinkedEmails({ invitation, guardian, children: linkable });
  return { children: linkable, emails };
}

/* ─────────────────── Invitations ─────────────────── */

async function generateInvitation(req, res) {
  try {
    const rawIds = Array.isArray(req.body.childIds) ? req.body.childIds : req.body.childId;
    const childIds = cleanChildIds(rawIds);
    if (!childIds) return res.status(400).json({ error: 'Invalid child selection.' });
    if (!childIds.length) return res.status(400).json({ error: 'At least one childId is required.' });

    const relationship = req.body.relationship || 'legal_guardian';
    if (!isValidRelationship(relationship)) return res.status(400).json({ error: 'Please choose a valid relationship.' });
    const permissionPreset = req.body.permissionPreset || 'standard';
    if (!isValidPreset(permissionPreset)) return res.status(400).json({ error: 'Please choose a valid permission level.' });

    const rawEmail = req.body.inviteEmail ?? req.body.email ?? null;
    const inviteEmail = rawEmail ? normalizeEmail(rawEmail) : null;
    if (rawEmail && !inviteEmail) return res.status(400).json({ error: 'Please enter a valid email address.' });

    // The page sends `personalMessage`; `message` / `note` are older names for the same field.
    const personalMessage = String(req.body.personalMessage ?? req.body.message ?? req.body.note ?? '').trim().slice(0, 1000) || null;
    const hours = Number(req.body.expiresHours ?? 48);
    const expiresHours = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 168) : 48;

    if (!checkInviteRateLimit(req.user.userId)) {
      return res.status(429).json({ error: 'Daily invitation limit reached. Please try again tomorrow.' });
    }

    const children = await Child.find({ _id: { $in: childIds } }).lean();
    if (children.length !== childIds.length) return res.status(404).json({ error: 'No matching children found.' });
    await assertCanManageChildren(children, req.user, 'invite guardians');

    const inviter = await User.findById(req.user.userId).select('firstName lastName email').lean();

    if (inviteEmail) {
      if (inviter && String(inviter.email).toLowerCase() === inviteEmail) {
        return res.status(400).json({ error: 'You cannot invite your own email address.' });
      }
      const invitee = await User.findOne({ email: inviteEmail }).select('_id').lean();
      if (invitee) {
        const owned = children.filter((c) => String(c.parentId) === String(invitee._id)).length;
        const active = await GuardianLink.countDocuments({ childId: { $in: childIds }, guardianId: invitee._id, status: 'active' });
        if (owned + active >= childIds.length) {
          return res.status(409).json({ error: 'This person already has access to the selected child.' });
        }
      }
      const open = await GuardianInvitation.findOne({
        sentTo: inviteEmail, childIds: { $in: childIds }, used: false, revokedAt: null, expiresAt: { $gt: new Date() },
      }).select('_id').lean();
      if (open) {
        return res.status(409).json({
          error: 'An invitation to this email is already pending for this child. Use Resend under Pending Invitations instead.',
          invitationId: open._id,
        });
      }
    }

    const permissions = resolvePermissions(permissionPreset, req.body.customPermissions);
    const rawCode = crypto.randomBytes(12).toString('hex');
    const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000);

    const inv = await GuardianInvitation.create({
      codeHash: hashCode(rawCode), childIds, createdBy: req.user.userId, expiresAt, singleUse: true,
      relationship, permissionPreset, customPermissions: permissions, personalMessage,
      note: req.body.note || null, sentTo: inviteEmail, emailSent: false,
    });
    recordInviteAttempt(req.user.userId);

    let email = { sent: false, reason: 'NO_RECIPIENT' };
    if (inviteEmail) {
      email = await emailService.sendInvitationEmail({
        to: inviteEmail, code: rawCode, inviterName: fullName(inviter), children,
        relationship, permissionPreset, permissions: displayPermissions(permissions), personalMessage, expiresAt,
      });
      if (email.sent) await GuardianInvitation.updateOne({ _id: inv._id }, { $set: { emailSent: true } });
    }

    await createLog({
      actorId: req.user.userId, action: 'invitation:create', targetType: 'Child',
      targetId: childIds[0],
      details: { invitationId: inv._id, childIds, relationship, permissionPreset, emailSent: email.sent },
      ip: req.ip,
    });

    res.json({
      success: true,
      invitationCode: rawCode,
      invitationId: inv._id,
      acceptUrl: emailService.acceptUrlFor(rawCode),
      expiresAt,
      emailSent: email.sent,
      emailStatus: email.sent ? 'sent' : email.reason,
    });
  } catch (err) {
    sendError(res, err, 'generateInvitation');
  }
}

async function acceptInvitation(req, res) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required.' });

    const guardian = await User.findById(req.user.userId).select('firstName lastName email role status').lean();
    if (!guardian) return res.status(401).json({ error: 'Please sign in again.' });
    if (!GUARDIAN_ACCOUNT_ROLES.includes(guardian.role)) {
      return res.status(403).json({ error: 'Only parent or guardian accounts can accept guardian invitations.' });
    }

    const invitation = await GuardianInvitation.findOne({ codeHash: hashCode(code) }).lean();
    const problem = invitationProblem(invitation);
    if (problem) throw problem;

    // The link was emailed to one address; only the account with that address may use it.
    if (invitation.sentTo && String(invitation.sentTo).toLowerCase() !== String(guardian.email).toLowerCase()) {
      return res.status(403).json({
        error: `This invitation was sent to ${maskEmail(invitation.sentTo)}. Sign in with that email address to accept it.`,
        emailMismatch: true,
      });
    }

    const result = await completeAcceptance({ invitation, guardian, ip: req.ip });
    res.json({
      success: true,
      childIds: result.children.map((c) => String(c._id)),
      guardianEmailSent: result.emails.guardianEmailSent,
    });
  } catch (err) {
    sendError(res, err, 'acceptInvitation');
  }
}

/**
 * POST /api/v2/guardians/accept-new-account   (no login required)
 *
 * For an invitee who has no KinderCura account yet. Parent sign-up cannot be
 * used for this: it requires registering a child of their own and drops the
 * invitation link. Holding the code proves access to the invited inbox, so the
 * account is created for exactly that address and linked in the same request.
 */
async function acceptWithNewAccount(req, res) {
  let createdUserId = null;
  try {
    const { code, firstName, lastName, password } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code is required.' });
    const cleanFirst = String(firstName || '').trim();
    const cleanLast = String(lastName || '').trim();
    if (!cleanFirst || !cleanLast) return res.status(400).json({ error: 'First and last name are required.' });
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }
    const consent = parseSignupConsent(req.body);
    if (!consent.ok) return res.status(400).json({ error: consent.error });

    const invitation = await GuardianInvitation.findOne({ codeHash: hashCode(code) }).lean();
    const problem = invitationProblem(invitation);
    if (problem) throw problem;
    if (!invitation.sentTo) {
      return res.status(400).json({ error: 'This invitation was not sent to an email address. Sign in with an existing account to accept it.' });
    }

    const email = String(invitation.sentTo).toLowerCase();
    if (await User.exists({ email })) {
      return res.status(409).json({ error: 'An account with this email already exists. Log in to accept the invitation.', accountExists: true });
    }

    const user = await User.create({
      firstName: cleanFirst,
      lastName: cleanLast,
      username: makeUsername(email),
      email,
      passwordHash: await bcrypt.hash(String(password), 10),
      role: 'parent',
      status: 'active',
      emailVerified: true,
      profileIcon: 'avatar1',
      consents: consent.consents,
    });
    createdUserId = user._id;

    const result = await completeAcceptance({ invitation, guardian: user.toObject(), ip: req.ip });
    createdUserId = null; // linked — keep the account

    await createLog({
      actorId: user._id, action: 'family:account:create', targetType: 'User', targetId: user._id,
      details: { via: 'invitation', invitationId: invitation._id }, ip: req.ip,
    });

    res.status(201).json({
      success: true,
      email,
      childIds: result.children.map((c) => String(c._id)),
      guardianEmailSent: result.emails.guardianEmailSent,
    });
  } catch (err) {
    // Never leave an account behind without its link.
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(() => {});
    if (err?.code === 11000 && err?.keyPattern?.email) {
      return res.status(409).json({ error: 'An account with this email already exists. Log in to accept the invitation.', accountExists: true });
    }
    sendError(res, err, 'acceptWithNewAccount');
  }
}

async function verifyInvitation(req, res) {
  try {
    const code = req.params.token;
    if (!code) return res.status(400).json({ error: 'Code is required.' });
    const invitation = await GuardianInvitation.findOne({ codeHash: hashCode(code) }).lean();
    const problem = invitationProblem(invitation);
    if (problem) {
      return res.status(problem.status).json({
        success: false, valid: false, error: problem.error, ...(problem.extra || {}),
        invitation: invitation ? { id: invitation._id, expiresAt: invitation.expiresAt } : undefined,
      });
    }

    // Names only: this page is reachable by anyone holding the link.
    const [children, inviter] = await Promise.all([
      Child.find({ _id: { $in: invitation.childIds } }).select('firstName lastName profileIcon').lean(),
      User.findById(invitation.createdBy).select('firstName lastName email').lean(),
    ]);
    const childDetails = children.map((c) => ({
      id: c._id, firstName: c.firstName, lastName: c.lastName, profileIcon: c.profileIcon,
    }));
    const inviterDetails = inviter ? { id: inviter._id, name: fullName(inviter), email: inviter.email } : null;
    const permissions = displayPermissions(invitationPermissions(invitation));

    res.json({
      success: true, valid: true, used: false,
      invitation: {
        id:                  invitation._id,
        child:               childDetails[0] || null,
        children:            childDetails,
        inviter:             inviterDetails,
        inviterName:         inviterDetails?.name || '',
        inviterEmail:        inviterDetails?.email || '',
        relationship:        invitation.relationship,
        relationshipLabel:   RELATIONSHIP_LABELS[invitation.relationship] || 'Guardian',
        permissionPreset:    invitation.permissionPreset,
        permissions,
        customPermissions:   permissions,
        permissionBreakdown: Object.entries(permissions).map(([key, val]) => ({
          key, label: _permLabels[key] || key, value: typeof val === 'string' ? val !== 'none' : Boolean(val),
        })),
        personalMessage:     invitation.personalMessage,
        expiresAt:           invitation.expiresAt,
        createdBy:           invitation.createdBy,
        sentTo:              invitation.sentTo,
        note:                invitation.note,
      },
    });
  } catch (err) {
    sendError(res, err, 'verifyInvitation');
  }
}

/* ─────────────────── Linked guardians ─────────────────── */

// Resolves the link a request targets: /:linkId routes pass a link id,
// /children/:childId/guardians/:guardianId routes pass the pair.
async function findTargetLink(params) {
  if (params.linkId) {
    if (!isObjectId(params.linkId)) throw { status: 400, error: 'Invalid guardian link.' };
    const link = await GuardianLink.findById(params.linkId);
    if (!link) throw { status: 404, error: 'Guardian link not found.' };
    return link;
  }
  const { childId, guardianId } = params;
  if (!childId || !guardianId) throw { status: 400, error: 'childId and guardianId are required.' };
  if (!isObjectId(childId) || !isObjectId(guardianId)) throw { status: 400, error: 'Invalid child or guardian.' };
  const link = await GuardianLink.findOne({ childId, guardianId });
  if (!link) throw { status: 404, error: 'Guardian link not found.' };
  return link;
}

async function assertPrimaryOrAdmin(childId, user, message) {
  const child = await Child.findById(childId).lean();
  if (!child) throw { status: 404, error: 'Child not found.' };
  const isOwner = String(child.parentId) === String(user.userId) || user.role === 'admin';
  if (isOwner) return child;
  const primary = await GuardianLink.exists({ childId, guardianId: user.userId, isPrimary: true, status: 'active' });
  if (!primary) throw { status: 403, error: message };
  return child;
}

async function listGuardians(req, res) {
  try {
    const { childId } = req.params;
    if (!childId) return res.status(400).json({ error: 'childId is required.' });
    if (!isObjectId(childId)) return res.status(400).json({ error: 'Invalid child.' });
    await assertPrimaryOrAdmin(childId, req.user, 'Access denied.');

    const links = await GuardianLink.find({ childId }).sort({ status: 1, createdAt: 1 }).populate('guardianId', 'firstName lastName email').lean();
    res.json({
      success: true,
      guardians: links.map((l) => ({
        id: l._id,
        guardianId: l.guardianId?._id || l.guardianId,
        name: l.guardianId ? fullName(l.guardianId) : null,
        email: l.guardianId?.email || null,
        role: l.role,
        relationship: l.relationship || null,
        relationshipLabel: RELATIONSHIP_LABELS[l.relationship] || null,
        isPrimary: Boolean(l.isPrimary),
        status: l.status,
        permissions: l.permissions,
      })),
    });
  } catch (err) {
    sendError(res, err, 'listGuardians');
  }
}

async function updatePermissions(req, res) {
  try {
    const { permissions } = req.body || {};
    if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'permissions are required.' });

    const link = await findTargetLink(req.params);
    await assertPrimaryOrAdmin(link.childId, req.user, 'Only primary guardian or admin may change permissions.');

    // Apply only known keys, each coerced to the stored type.
    for (const k of Object.keys(permissions)) {
      if (BOOLEAN_PERMISSION_KEYS.includes(k)) {
        link.set(`permissions.${k}`, permissions[k] === true);
      } else if (k === 'viewMedicalRecords') {
        link.set('permissions.viewMedicalRecords', normalizeMedical(permissions[k], link.permissions?.viewMedicalRecords));
      }
    }

    await link.save();
    await createLog({ actorId: req.user.userId, action: 'guardian:permissions:update', targetType: 'GuardianLink', targetId: link._id, details: { permissions: link.permissions }, ip: req.ip });

    res.json({ success: true, permissions: link.permissions });
  } catch (err) {
    sendError(res, err, 'updatePermissions');
  }
}

async function revokeGuardian(req, res) {
  try {
    const link = await findTargetLink(req.params);
    await assertPrimaryOrAdmin(link.childId, req.user, 'Only primary guardian or admin may revoke access.');
    if (link.isPrimary && link.status === 'active') {
      return res.status(400).json({ error: 'The primary guardian cannot be revoked. Transfer primary guardianship first.' });
    }
    if (link.status === 'revoked') return res.json({ success: true, alreadyRevoked: true });

    link.status = 'revoked';
    link.endDate = new Date();
    await link.save();

    await createLog({ actorId: req.user.userId, action: 'guardian:revoke', targetType: 'GuardianLink', targetId: link._id, details: { revokedBy: req.user.userId }, ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'revokeGuardian');
  }
}

/**
 * POST /api/v2/guardians/children/:childId/transfer-primary
 *
 * Transfers primary-guardian status for a child from the caller to a target user
 * who already holds an active GuardianLink for that child.
 *
 *  1. The caller's primary role ends; as the confirmation dialog promises, they
 *     keep an active (non-primary) link with full access. An owner who had no
 *     GuardianLink of their own (children registered directly) gets one here.
 *  2. The target's link becomes primary.
 *  3. Child.parentId is set to the target user.
 *  4. The transfer is audit-logged.
 *
 * @returns {200} { success: true, childId, newPrimaryGuardianId, archivedLinkId }
 */
async function transferPrimary(req, res) {
  try {
    const { childId } = req.params;
    const { targetGuardianId } = req.body || {};

    if (!childId)   return res.status(400).json({ error: 'childId is required.' });
    if (!targetGuardianId) return res.status(400).json({ error: 'targetGuardianId is required.' });
    if (!isObjectId(childId) || !isObjectId(targetGuardianId)) return res.status(400).json({ error: 'Invalid child or guardian.' });

    const targetId = new mongoose.Types.ObjectId(String(targetGuardianId));
    const child = await verifyPrimaryGuardian({ childId: new mongoose.Types.ObjectId(childId), callerId: req.user.userId });
    if (String(targetId) === String(req.user.userId)) {
      return res.status(409).json({ error: 'You are already the primary guardian.' });
    }

    // 1. The target must already hold an active GuardianLink.
    const targetLink = await GuardianLink.findOne({ childId: child._id, guardianId: targetId, status: 'active' }).lean();
    if (!targetLink) {
      return res.status(404).json({ error: 'Target user is not an active linked guardian for this child. They must accept an invitation first.' });
    }

    // 2. Guard against a no-op.
    if (targetLink.isPrimary) {
      return res.status(409).json({ error: 'The target user is already the primary guardian.' });
    }

    const previousPrimaryId = String(child.parentId) === String(req.user.userId)
      ? child.parentId
      : new mongoose.Types.ObjectId(String(req.user.userId));

    // 3. Step the previous primary down to an active, full-access, non-primary link.
    let formerLink;
    try {
      formerLink = await GuardianLink.findOneAndUpdate(
        { childId: child._id, guardianId: previousPrimaryId },
        {
          $set: {
            isPrimary: false,
            status: 'active',
            permissions: resolvePermissions('full'),
            'transferLog.previousPrimaryGuardianId': previousPrimaryId,
            'transferLog.transferredAt': new Date(),
            'transferLog.reason': 'Primary guardianship transferred to another guardian.',
          },
          $setOnInsert: { role: 'parent', createdBy: req.user.userId, startDate: new Date() },
        },
        { new: true, upsert: true }
      );
      // findOneAndUpdate skips the save hook, which keeps Child.guardianLinks in sync.
      await Child.updateOne({ _id: child._id }, { $addToSet: { guardianLinks: formerLink._id } });
    } catch (demoteErr) {
      console.error('transferPrimary demote error:', demoteErr.message);
      return res.status(500).json({ error: 'Failed to update the current primary guardian link.' });
    }

    // 4. Promote the target to primary.
    const promoted = await GuardianLink.findOneAndUpdate(
      { childId: child._id, guardianId: targetId },
      {
        $set: {
          isPrimary: true,
          status: 'active',
          'transferLog.promotedAt': new Date(),
          'transferLog.previousPrimaryGuardianId': previousPrimaryId,
        },
      },
      { new: true }
    );

    // 5. Update Child.parentId to the new primary.
    await Child.findByIdAndUpdate(child._id, { parentId: targetId });

    // 6. Audit log.
    await createLog({
      actorId: req.user.userId,
      action: 'guardian:primary:transfer',
      targetType: 'Child',
      targetId: child._id,
      details: {
        childId: String(child._id),
        oldPrimaryGuardianId: String(previousPrimaryId),
        oldPrimaryGuardianLinkId: formerLink ? String(formerLink._id) : null,
        newPrimaryGuardianId: String(targetId),
        newPrimaryGuardianLinkId: promoted ? String(promoted._id) : null,
      },
      ip: req.ip,
    });

    res.status(200).json({
      success: true,
      childId: String(child._id),
      newPrimaryGuardianId: String(targetId),
      archivedLinkId: formerLink ? String(formerLink._id) : null,
    });
  } catch (err) {
    sendError(res, err, 'transferPrimary');
  }
}

/* ─────────────────── Labels ─────────────────── */

const _permLabels = {
  viewAssessments:    'View Assessments & Results',
  submitAssessments:  'Submit Assessments',
  viewResults:        'View Assessment Results',
  viewRecommendations:'View Recommendations',
  uploadDocuments:    'Upload Documents & Photos',
  manageAppointments: 'Manage Appointments',
  viewMedicalRecords: 'View Medical Records',
  modifyChild:        'Modify Child Profile',
  inviteGuardians:    'Invite Other Guardians',
  revokeAccess:       'Revoke Access',
  viewMessages:       'View Chat Messages',
  sendMessages:       'Send Messages',
  manageMessages:     'Manage Messages',
  viewNotifications:  'View Notifications',
  sendNotifications:  'Send Notifications',
  manageNotifications:'Manage Notifications',
};

/* ─────────────────── Pending invitations list ─────────────────── */

async function listPendingInvitations(req, res) {
  try {
    // Revoked invitations are gone from the list; expired ones stay so they can be resent.
    const invitations = await GuardianInvitation.find({ createdBy: req.user.userId, used: false, revokedAt: null })
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      success: true,
      invitations: invitations.map(inv => {
        const ms = inv.expiresAt ? new Date(inv.expiresAt) - Date.now() : null;
        const isExpired = ms !== null && ms < 0;
        const daysLeft = ms !== null && ms >= 0 ? Math.max(0, Math.floor(ms / 86400000)) : 0;
        const hoursLeft = ms !== null && ms >= 0 ? Math.max(0, Math.floor(ms / 3600000)) : 0;
        return {
          id:                   inv._id,
          childIds:             inv.childIds,
          relationship:         inv.relationship,
          relationshipLabel:    RELATIONSHIP_LABELS[inv.relationship] || 'Guardian',
          permissionPreset:     inv.permissionPreset,
          customPermissions:    inv.customPermissions,
          personalMessage:      inv.personalMessage,
          sentTo:               inv.sentTo,
          emailSent:            inv.emailSent,
          expiresAt:            inv.expiresAt,
          status:               isExpired ? 'expired' : 'pending',
          isExpired,
          daysLeft,
          hoursLeft,
          viewCount:            inv.viewCount,
          resentCount:          inv.resentCount,
          createdAt:            inv.createdAt,
        };
      }),
    });
  } catch (err) {
    sendError(res, err, 'listPendingInvitations');
  }
}

/* ─────────────────── Resend invitation ─────────────────── */

async function resendInvitation(req, res) {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid invitation.' });
    const invitation = await GuardianInvitation.findById(id).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found.' });
    if (String(invitation.createdBy) !== String(req.user.userId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the inviter or an admin may resend this invitation.' });
    }
    if (!invitation.sentTo) return res.status(400).json({ error: 'No recipient email on file for this invitation.' });
    if (invitation.used) return res.status(400).json({ error: 'This invitation has already been used.' });
    if (invitation.revokedAt) return res.status(410).json({ error: 'This invitation was revoked. Send a new invitation instead.' });
    if (!checkInviteRateLimit(req.user.userId)) {
      return res.status(429).json({ error: 'Daily invitation limit reached. Please try again tomorrow.' });
    }

    const children = await Child.find({ _id: { $in: invitation.childIds } }).lean();
    if (!children.length) return res.status(404).json({ error: 'The child in this invitation no longer exists.' });
    const inviter = await User.findById(invitation.createdBy).select('firstName lastName').lean();

    // New code (the old link stops working) and a fresh 48h window.
    const rawCode   = crypto.randomBytes(12).toString('hex');
    const newExpiry = new Date(Date.now() + 48 * 3600 * 1000);
    const resentCount = (invitation.resentCount || 0) + 1;
    await GuardianInvitation.updateOne({ _id: invitation._id }, {
      $set: { codeHash: hashCode(rawCode), expiresAt: newExpiry, resentCount, lastResentAt: new Date(), emailSent: false },
    });
    recordInviteAttempt(req.user.userId);

    const permissions = invitationPermissions(invitation);
    const email = await emailService.sendInvitationEmail({
      to: invitation.sentTo, code: rawCode, inviterName: fullName(inviter), children,
      relationship: invitation.relationship, permissionPreset: invitation.permissionPreset,
      permissions: displayPermissions(permissions), personalMessage: invitation.personalMessage, expiresAt: newExpiry,
    });
    if (email.sent) await GuardianInvitation.updateOne({ _id: invitation._id }, { $set: { emailSent: true } });

    await createLog({
      actorId: req.user.userId,
      action: 'invitation:resend',
      targetType: 'GuardianInvitation',
      targetId: invitation._id,
      details: { resentCount, emailSent: email.sent },
      ip: req.ip,
    });

    res.json({
      success: true,
      newCode: rawCode,
      acceptUrl: emailService.acceptUrlFor(rawCode),
      expiresAt: newExpiry,
      emailSent: email.sent,
      emailStatus: email.sent ? 'sent' : email.reason,
    });
  } catch (err) {
    sendError(res, err, 'resendInvitation');
  }
}

/* ─────────────────── Revoke invitation ─────────────────── */

async function revokeInvitation(req, res) {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ error: 'Invalid invitation.' });
    const invitation = await GuardianInvitation.findById(id);
    if (!invitation) return res.status(404).json({ error: 'Invitation not found.' });
    if (String(invitation.createdBy) !== String(req.user.userId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the inviter or an admin may revoke this invitation.' });
    }
    if (invitation.used) {
      return res.status(400).json({ error: 'This invitation was already accepted. Remove the guardian under Linked Guardians instead.' });
    }
    if (invitation.revokedAt) return res.json({ success: true, alreadyRevoked: true });

    invitation.revokedAt   = new Date();
    invitation.revokedBy   = req.user.userId;
    invitation.expiresAt   = new Date(); // immediately expire
    await invitation.save();

    await createLog({
      actorId: req.user.userId,
      action: 'invitation:revoke',
      targetType: 'GuardianInvitation',
      targetId: invitation._id,
      details: {},
      ip: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'revokeInvitation');
  }
}

/* ─────────────────── Post-acceptance email retry ─────────────────── */
// The confirmation emails are now sent by the server inside acceptInvitation.
// This older endpoint is kept for pages that still call it: it only acts for the
// guardian who used the invitation, reads every address from the database (never
// from the request body) and sends at most once per invitation.

async function sendAcceptanceEmails(req, res) {
  try {
    const { invitationId } = req.body || {};
    if (!invitationId) return res.status(400).json({ error: 'invitationId is required.' });
    if (!isObjectId(invitationId)) return res.status(400).json({ error: 'Invalid invitation.' });

    const invitation = await GuardianInvitation.findById(invitationId).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found.' });
    if (!invitation.used || String(invitation.usedBy) !== String(req.user.userId)) {
      return res.status(403).json({ error: 'Only the guardian who accepted this invitation may request this email.' });
    }

    const [guardian, children] = await Promise.all([
      User.findById(req.user.userId).select('firstName lastName email').lean(),
      Child.find({ _id: { $in: invitation.childIds } }).select('firstName lastName').lean(),
    ]);
    const result = await sendLinkedEmails({ invitation, guardian, children });
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err, 'sendAcceptanceEmails');
  }
}

/**
 * POST /api/v2/guardians/create-account
 *
 * Creates a secondary family account (e.g. for spouse) directly without
 * requiring the invitation email flow. The caller must be the primary
 * guardian for every child being linked.
 *
 * Request body:
 *   firstName, lastName, email, password       (required)
 *   middleName, relationship, childIds[]        (required: childIds)
 *   permissionPreset                            (optional, default: 'standard')
 *
 * Creates, all-or-nothing:
 *   - User account (role: 'parent', active)
 *   - GuardianLink entries for each childId
 * then emails the new guardian a link confirmation (never the password).
 */
async function createSecondaryAccount(req, res) {
  let createdUserId = null;
  try {
    const {
      firstName, lastName, middleName, email, password, permissionPreset,
    } = req.body || {};
    const relationship = req.body?.relationship || 'other';

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: 'firstName, lastName, email, and password are required.' });
    }
    const childIds = cleanChildIds(req.body?.childIds || []);
    if (!childIds) return res.status(400).json({ error: 'Invalid child selection.' });
    if (!childIds.length) return res.status(400).json({ error: 'At least one childId is required.' });
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!isValidRelationship(relationship)) {
      return res.status(400).json({ error: 'Please choose a valid relationship.' });
    }
    const preset = permissionPreset || 'standard';
    if (!PRESETS_FOR_DIRECT_ACCOUNTS.includes(preset)) {
      return res.status(400).json({ error: 'Please choose a valid permission level.' });
    }

    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const cleanFirstName = String(firstName).trim();
    const cleanLastName = String(lastName).trim();
    if (!cleanFirstName || !cleanLastName) return res.status(400).json({ error: 'First and last name are required.' });

    // Verify caller is primary guardian for all target children
    const children = await Child.find({ _id: { $in: childIds } }).lean();
    if (children.length !== childIds.length) {
      return res.status(404).json({ error: 'One or more children not found.' });
    }
    // No admin bypass here (unchanged): only the child's own primary parent/guardian adds family.
    await assertCanManageChildren(children, { userId: req.user.userId, role: 'parent' }, 'add family members');

    // Check for duplicate email
    const existingUser = await User.findOne({ email: cleanEmail }).select('_id').lean();
    if (existingUser) {
      return res.status(409).json({
        error: 'An account with this email already exists. To link that account, send an invitation from Guardian Management instead.',
        accountExists: true,
      });
    }

    // Validate the link data before any account exists, so a bad value can
    // never leave a user without a link (the cause of "No child registered").
    const permissions = resolvePermissions(preset);
    await new GuardianLink({
      childId: childIds[0], guardianId: new mongoose.Types.ObjectId(), isPrimary: false,
      role: roleForRelationship(relationship), relationship, status: 'active', permissions,
    }).validate();

    const user = await User.create({
      firstName: cleanFirstName,
      middleName: middleName ? String(middleName).trim() : null,
      lastName: cleanLastName,
      username: makeUsername(cleanEmail),
      email: cleanEmail,
      passwordHash: await bcrypt.hash(String(password), 10),
      role: 'parent',
      status: 'active',
      emailVerified: true,
      profileIcon: 'avatar1',
    });
    createdUserId = user._id;

    await linkGuardianToChildren({
      guardianId: user._id, childIds, relationship, permissions, createdBy: req.user.userId,
    });
    createdUserId = null; // fully linked — keep the account

    await createLog({
      actorId: req.user.userId,
      action: 'family:account:create',
      targetType: 'User',
      targetId: user._id,
      details: { newUserId: user._id, childIds, relationship, permissionPreset: preset },
      ip: req.ip,
    });

    const creator = await User.findById(req.user.userId).select('firstName lastName').lean();
    const mail = await emailService.sendWelcomeEmail({
      to: cleanEmail,
      guardianName: cleanFirstName,
      childNames: children.map(fullName),
      inviterName: fullName(creator),
      accountCreatedBy: fullName(creator) || 'The primary parent',
    });

    const who = `${cleanFirstName} ${cleanLastName}`;
    res.status(201).json({
      success: true,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
      emailSent: mail.sent,
      message: mail.sent
        ? `Account created for ${who} and linked. A confirmation email was sent to ${cleanEmail}. Share the password with them privately — it is not emailed.`
        : `Account created for ${who} and linked, but the confirmation email could not be sent. Let them know they can sign in with ${cleanEmail} and the password you set.`,
    });
  } catch (err) {
    if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(() => {});
    if (err?.name === 'ValidationError') {
      return res.status(400).json({ error: 'Some of the details are not valid. Please check the form and try again.' });
    }
    if (err?.code === 11000 && err?.keyPattern?.email) {
      return res.status(409).json({ error: 'An account with this email already exists.', accountExists: true });
    }
    sendError(res, err, 'createSecondaryAccount');
  }
}

module.exports = {
  generateInvitation, acceptInvitation, acceptWithNewAccount, verifyInvitation,
  listGuardians, updatePermissions, revokeGuardian, transferPrimary,
  listPendingInvitations, resendInvitation, revokeInvitation,
  sendAcceptanceEmails, createSecondaryAccount,
  // exported for unit tests
  _internal: { linkGuardianToChildren, invitationPermissions, cleanChildIds, maskEmail },
};
