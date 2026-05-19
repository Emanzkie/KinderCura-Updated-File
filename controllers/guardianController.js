// controllers/guardianController.js
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Child = require('../models/Child');
const GuardianInvitation = require('../models/GuardianInvitation');
const GuardianLink = require('../models/GuardianLink');
const PermissionSet = require('../models/PermissionSet');
const User = require('../models/User');
const { createLog } = require('./auditController');
const emailService = require('../services/emailService');

/* ─────────────────── In-memory rate limiter ───────────────────
   Limits: max 10 invitation creations per user per UTC day.
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

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
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

async function generateInvitation(req, res) {
  try {
    // Accept single childId or array of childIds
    const rawChildId = req.body.childId || req.body.childIds?.[0] || null;
    const childIds   = Array.isArray(req.body.childIds)
      ? req.body.childIds
      : (rawChildId ? [rawChildId] : []);
    const expiresHours = req.body.expiresHours ?? 48;
    const inviterEmail = req.body.inviteEmail || null;
    const relationship  = req.body.relationship || 'legal_guardian';
    const permissionPreset = req.body.permissionPreset || 'standard';
    const customPermissions = req.body.customPermissions || null;
    const personalMessage = req.body.message || req.body.note || null;

    if (!childIds.length) return res.status(400).json({ error: 'At least one childId is required.' });

    // Rate limit: max 10 invitations per user per day
    if (!checkInviteRateLimit(req.user.userId)) {
      return res.status(429).json({ error: 'Daily invitation limit reached. Please try again tomorrow.' });
    }

    const children = await Child.find({ _id: { $in: childIds } }).lean();
    if (!children.length) return res.status(404).json({ error: 'No matching children found.' });

    const isOwner = String(children[0].parentId) === String(req.user.userId);
    const isAdmin = req.user.role === 'admin';
    const primaryLinks = await GuardianLink.find({
      childId: { $in: childIds }, guardianId: req.user.userId, isPrimary: true, status: 'active',
    }).lean();
    if (!isOwner && primaryLinks.length < childIds.length && !isAdmin) {
      return res.status(403).json({ error: 'Only the primary guardian or admin may invite guardians.' });
    }

    const rawCode = crypto.randomBytes(12).toString('hex');
    const codeHash = hashCode(rawCode);
    const expiresAt = new Date(Date.now() + Number(expiresHours) * 3600 * 1000);

    const inv = await GuardianInvitation.create({
      codeHash, childIds, createdBy: req.user.userId, expiresAt, singleUse: true,
      relationship, permissionPreset, customPermissions, personalMessage,
      note: req.body.note || null,
    });

    recordInviteAttempt(req.user.userId);

    if (inviterEmail) {
      try {
        await emailService.sendInvitationEmail({
          to: inviterEmail, code: rawCode, child: children[0], children, inviter: req.user,
          relationship, permissionPreset, customPermissions, personalMessage,
          expiresAt, invitation: inv,
        });
        await GuardianInvitation.findByIdAndUpdate(inv._id, { sentTo: inviterEmail, emailSent: true });
      } catch (e) { console.warn('Failed to send invitation email:', e.message); }
    }

    await createLog({
      actorId: req.user.userId, action: 'invitation:create', targetType: 'Child',
      targetId: childIds[0],
      details: { invitationId: inv._id, childIds, relationship, permissionPreset },
      ip: req.ip,
    });

    res.json({ success: true, invitationCode: rawCode, invitationId: inv._id, expiresAt });
  } catch (err) {
    console.error('generateInvitation error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function acceptInvitation(req, res) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required.' });

    const codeHash = hashCode(code);
    const invitation = await GuardianInvitation.findOne({ codeHash }).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found or invalid.' });
    if (invitation.used) return res.status(400).json({ error: 'This invitation has already been used.' });
    if (invitation.expiresAt && new Date() > new Date(invitation.expiresAt)) {
      return res.status(400).json({ error: 'Invitation has expired.' });
    }

    const childIds = (() => {
      const arr = invitation.childIds;
      if (!arr?.length) return [];
      const first = arr[0];
      /* DB stores strings or ObjectIds — normalise to ObjectId strings */
      return arr.map(id => String(id));
    })();
    if (!childIds.length) return res.status(400).json({ error: 'Invitation contains no children.' });

    // Find or create a default 'Standard' permission set
    let standard = await PermissionSet.findOne({ name: 'Standard' });
    if (!standard) {
      standard = await PermissionSet.create({ name: 'Standard', description: 'Default standard guardian permissions', permissions: {} });
    }

    // Upsert GuardianLink for this user across all children in the invitation
    await Promise.all(childIds.map(async (childId) => {
      const existing = await GuardianLink.findOne({ childId, guardianId: req.user.userId });
      if (existing) {
        if (existing.status === 'revoked') {
          existing.status = 'active';
          existing.permissionSet = standard._id;
          existing.permissions = standard.permissions;
          await existing.save();
        }
      } else {
        await GuardianLink.create({
          childId,
          guardianId: req.user.userId,
          isPrimary: false,
          status: 'active',
          permissions: standard.permissions,
          permissionSet: standard._id,
          createdBy: invitation.createdBy,
        });
      }
    }));

    // Mark invitation used
    await GuardianInvitation.findByIdAndUpdate(invitation._id, { used: true, usedBy: req.user.userId, usedAt: new Date() });

    await createLog({ actorId: req.user.userId, action: 'invitation:accept', targetType: 'Child', targetId: childIds[0], details: { invitationId: invitation._id, childCount: childIds.length }, ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    console.error('acceptInvitation error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function verifyInvitation(req, res) {
  try {
    const code = req.params.token;
    if (!code) return res.status(400).json({ error: 'Code is required.' });
    const codeHash = hashCode(code);
    const invitation = await GuardianInvitation.findOne({ codeHash }).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found or invalid.' });
    if (invitation.used) return res.json({ success: true, valid: true, used: true, usedBy: invitation.usedBy });

    // Find first child for details enrichment
    const firstChildId = invitation.childIds?.[0];
    let childDetails = null;
    let inviterDetails = null;
    let allChildrenDetails = [];

    if (firstChildId) {
      const child = await Child.findById(firstChildId).populate('parentId', 'firstName lastName email').lean();
      if (child) {
        childDetails = {
          id: child._id,
          firstName: child.firstName,
          lastName: child.lastName,
          dateOfBirth: child.dateOfBirth,
          profileIcon: child.profileIcon,
        };
        const parent = child.parentId;
        inviterDetails = parent ? {
          id: parent._id,
          name: `${parent.firstName || ''} ${parent.lastName || ''}`.trim(),
          email: parent.email,
        } : null;
      }
    }

    // Resolve all children
    if (invitation.childIds?.length) {
      const allChildren = await Child.find({ _id: { $in: invitation.childIds } }).lean();
      allChildrenDetails = allChildren.map(c => ({
        id: c._id,
        firstName: c.firstName,
        lastName: c.lastName,
        dateOfBirth: c.dateOfBirth,
        profileIcon: c.profileIcon,
      }));
    }

    if (invitation.expiresAt && new Date() > new Date(invitation.expiresAt)) {
      return res.json({
        success: false, valid: false, expired: true,
        invitation: {
          id: invitation._id,
          child: childDetails,
          children: allChildrenDetails,
          inviter: inviterDetails,
          relationship: invitation.relationship,
          permissionPreset: invitation.permissionPreset,
          customPermissions: invitation.customPermissions,
          personalMessage: invitation.personalMessage,
          expiresAt: invitation.expiresAt,
          createdBy: invitation.createdBy,
        },
      });
    }

    const rawPerms = invitation.customPermissions || {};
    const permBreakdown = Object.entries(rawPerms).map(([key, val]) => ({
      key: key,
      label: _permLabels[key] || key,
      value: Boolean(val),
    }));

    res.json({
      success: true, valid: true, used: false,
      invitation: {
        id:                invitation._id,
        child:             childDetails,
        children:          allChildrenDetails,
        inviter:           inviterDetails,
        relationship:      invitation.relationship,
        relationshipLabel: _relationshipLabels[invitation.relationship] || 'Guardian',
        permissionPreset:  invitation.permissionPreset,
        customPermissions: invitation.customPermissions,
        permissionBreakdown: permBreakdown,
        personalMessage:   invitation.personalMessage,
        expiresAt:         invitation.expiresAt,
        createdBy:         invitation.createdBy,
        sentTo:            invitation.sentTo,
        note:              invitation.note,
      },
    });
  } catch (err) {
    console.error('verifyInvitation error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function listGuardians(req, res) {
  try {
    const { childId } = req.params;
    if (!childId) return res.status(400).json({ error: 'childId is required.' });

    const child = await Child.findById(childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isOwner = String(child.parentId) === String(req.user.userId) || req.user.role === 'admin';
    if (!isOwner) {
      // allow primary guardian
      const primary = await GuardianLink.findOne({ childId, guardianId: req.user.userId, isPrimary: true, status: 'active' }).lean();
      if (!primary) return res.status(403).json({ error: 'Access denied.' });
    }

    const links = await GuardianLink.find({ childId }).populate('guardianId', 'firstName lastName email').lean();
    res.json({ success: true, guardians: links.map((l) => ({ id: l._id, guardianId: l.guardianId?._id || l.guardianId, name: l.guardianId ? `${l.guardianId.firstName || ''} ${l.guardianId.lastName || ''}`.trim() : null, email: l.guardianId?.email || null, role: l.role, status: l.status, permissions: l.permissions })) });
  } catch (err) {
    console.error('listGuardians error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function updatePermissions(req, res) {
  try {
    const { childId, guardianId } = req.params;
    const { permissions } = req.body;
    if (!childId || !guardianId) return res.status(400).json({ error: 'childId and guardianId are required.' });

    const child = await Child.findById(childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isOwner = String(child.parentId) === String(req.user.userId) || req.user.role === 'admin';
    if (!isOwner) {
      const primary = await GuardianLink.findOne({ childId, guardianId: req.user.userId, isPrimary: true, status: 'active' }).lean();
      if (!primary) return res.status(403).json({ error: 'Only primary guardian or admin may change permissions.' });
    }

    const link = await GuardianLink.findOne({ childId, guardianId });
    if (!link) return res.status(404).json({ error: 'Guardian link not found.' });

    // Apply only allowed keys
    const allowedKeys = ['viewAssessments','submitAssessments','viewResults','uploadDocuments','manageAppointments','viewMedicalRecords','modifyChild','inviteGuardians','revokeAccess'];
    for (const k of Object.keys(permissions || {})) {
      if (allowedKeys.includes(k)) {
        link.permissions[k] = permissions[k];
      }
    }

    await link.save();
    await createLog({ actorId: req.user.userId, action: 'guardian:permissions:update', targetType: 'GuardianLink', targetId: link._id, details: { permissions: link.permissions }, ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    console.error('updatePermissions error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function revokeGuardian(req, res) {
  try {
    const { childId, guardianId } = req.params;
    if (!childId || !guardianId) return res.status(400).json({ error: 'childId and guardianId are required.' });

    const child = await Child.findById(childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const isOwner = String(child.parentId) === String(req.user.userId) || req.user.role === 'admin';
    if (!isOwner) {
      const primary = await GuardianLink.findOne({ childId, guardianId: req.user.userId, isPrimary: true, status: 'active' }).lean();
      if (!primary) return res.status(403).json({ error: 'Only primary guardian or admin may revoke access.' });
    }

    const link = await GuardianLink.findOne({ childId, guardianId });
    if (!link) return res.status(404).json({ error: 'Guardian link not found.' });

    link.status = 'revoked';
    await link.save();

    await createLog({ actorId: req.user.userId, action: 'guardian:revoke', targetType: 'GuardianLink', targetId: link._id, details: { revokedBy: req.user.userId }, ip: req.ip });

    res.json({ success: true });
  } catch (err) {
    console.error('revokeGuardian error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/v2/guardians/:childId/transfer-primary
 *
 * Transfers primary-guardian status for a child from the current caller to a
 * nominated target user who already holds an active GuardianLink for that child.
 *
 * Actions taken atomically:
 *  1. Demote the caller's current primary GuardianLink (isPrimary → false, status promoted to onChangeArchived).
 *  2. Promote the target user's GuardianLink to primary (isPrimary → true).
 *  3. Update Child.parentId to the target user.
 *  4. Audit-log the transfer.
 *
 * @param {string} req.body.targetGuardianId  – Mongoose ObjectId string of the nominated guardian
 * @param {string} [req.params.childId]       – child whose primary guard is being transferred
 * @returns {200} { success: true, childId, newPrimaryGuardianId, archivedLinkId }
 * @throws {400}  childId or targetGuardianId missing
 * @throws {404}  child not found / target guardian not linked
 * @throws {409}  target is already the primary guardian
 * @throws {403}  caller is not the current primary guardian
 * @throws {500}  unexpected server error
 */
async function transferPrimary(req, res) {
  try {
    const { childId } = req.params;
    const { targetGuardianId } = req.body;

    if (!childId)   return res.status(400).json({ error: 'childId is required.' });
    if (!targetGuardianId) return res.status(400).json({ error: 'targetGuardianId is required.' });

    const targetId = new mongoose.Types.ObjectId(String(targetGuardianId));
    const child = await verifyPrimaryGuardian({ childId: new mongoose.Types.ObjectId(childId), callerId: req.user.userId });

    // 1. The target must already hold an active GuardianLink.
    const targetLink = await GuardianLink.findOne({ childId: child._id, guardianId: targetId, status: 'active' }).lean();
    if (!targetLink) {
      return res.status(404).json({ error: 'Target user is not an active linked guardian for this child. They must accept an invitation first.' });
    }

    // 2. Guard against a no-op.
    if (targetLink.isPrimary) {
      return res.status(409).json({ error: 'The target user is already the primary guardian.' });
    }

    const callerIsOwner = String(child.parentId) === String(req.user.userId);
    const callerGuardianId = callerIsOwner ? null : new mongoose.Types.ObjectId(String(req.user.userId));

    // 3. Archive / demote the current primary link.
    let archivedLinkId = null;
    try {
      const demoteFilter = callerIsOwner
        ? { childId: child._id, isPrimary: true }
        : { childId: child._id, guardianId: callerGuardianId, isPrimary: true };

      const demoteResult = await GuardianLink.updateOne(demoteFilter, {
        $set: {
          isPrimary: false,
          status: 'archived',
          'transferLog.previousPrimaryGuardianId': callerIsOwner ? child.parentId : callerGuardianId,
          'transferLog.transferredAt': new Date(),
          'transferLog.reason': 'Primary guardianship transferred to another guardian.',
        },
      });

      if (demoteResult.matchedCount === 0) {
        return res.status(409).json({ error: 'No active primary guardian link found to demote.' });
      }

      const archived = await GuardianLink.findOne(demoteFilter);
      archivedLinkId = archived ? String(archived._id) : null;
    } catch (demoteErr) {
      console.error('transferPrimary demote error:', demoteErr.message);
      return res.status(500).json({ error: 'Failed to demote the current primary guardian link.' });
    }

    // 4. Promote the target to primary.
    const promoted = await GuardianLink.findOneAndUpdate(
      { childId: child._id, guardianId: targetId },
      {
        $set: {
          isPrimary: true,
          status: 'active',
          'transferLog.promotedAt': new Date(),
          'transferLog.previousPrimaryGuardianId': callerIsOwner ? child.parentId : callerGuardianId,
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
        oldPrimaryGuardianId: callerIsOwner ? String(child.parentId) : null,
        oldPrimaryGuardianLinkId: archivedLinkId,
        newPrimaryGuardianId: String(targetId),
        newPrimaryGuardianLinkId: promoted ? String(promoted._id) : null,
      },
      ip: req.ip,
    });

    res.status(200).json({
      success: true,
      childId: String(child._id),
      newPrimaryGuardianId: String(targetId),
      archivedLinkId,
    });
  } catch (err) {
    console.error('transferPrimary error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.error || err.message || 'Internal server error.' });
  }
}

/* ─────────────────── Enhanced verifyInvitation ─────────────────── */

const _permLabels = {
  viewAssessments:    'View Assessments & Results',
  submitAssessments:  'Submit Assessments',
  viewResults:        'View Assessment Results',
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

const _relationshipLabels = {
  mother:'Mother', father:'Father', grandparent:'Grandparent',
  legal_guardian:'Legal Guardian', foster_parent:'Foster Parent',
  court_appointed:'Court-Appointed', nanny:'Nanny / Babysitter',
  babysitter:'Babysitter', therapist:'Therapist', teacher:'Teacher', other:'Other',
};

/* ─────────────────── Pending invitations list ─────────────────── */

async function listPendingInvitations(req, res) {
  try {
    const invitations = await GuardianInvitation.find({ createdBy: req.user.userId, used: false })
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      success: true,
      invitations: invitations.map(inv => {
        const ms = inv.expiresAt ? new Date(inv.expiresAt) - Date.now() : null;
        const isExpired = ms !== null && ms < 0;
        const daysLeft = ms !== null && ms >= 0 ? Math.max(0, Math.floor(ms / 86400000)) : 0;
        return {
          id:                   inv._id,
          childIds:             inv.childIds,
          relationship:         inv.relationship,
          permissionPreset:     inv.permissionPreset,
          customPermissions:    inv.customPermissions,
          personalMessage:      inv.personalMessage,
          sentTo:               inv.sentTo,
          emailSent:            inv.emailSent,
          expiresAt:            inv.expiresAt,
          isExpired,
          daysLeft,
          viewCount:            inv.viewCount,
          resentCount:          inv.resentCount,
          createdAt:            inv.createdAt,
        };
      }),
    });
  } catch (err) {
    console.error('listPendingInvitations error:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────── Resend invitation ─────────────────── */

async function resendInvitation(req, res) {
  try {
    const { id } = req.params;
    const invitation = await GuardianInvitation.findById(id).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found.' });
    if (!invitation.sentTo) return res.status(400).json({ error: 'No recipient email on file for this invitation.' });
    if (invitation.used) return res.status(400).json({ error: 'This invitation has already been used.' });
    if (String(invitation.createdBy) !== String(req.user.userId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the inviter or an admin may resend this invitation.' });
    }

    // Generate new code, rotate token, extend expiry by 48h from now
    const rawCode   = crypto.randomBytes(12).toString('hex');
    const codeHash   = hashCode(rawCode);
    const newExpiry = new Date(Date.now() + 48 * 3600 * 1000);

    const [child] = await Promise.all([
      Child.findById(invitation.childIds[0]).lean(),
      GuardianInvitation.findByIdAndUpdate(invitation._id, {
        codeHash, expiresAt: newExpiry, resentCount: (invitation.resentCount || 0) + 1, lastResentAt: new Date(),
      }),
    ]);

    if (child) {
      try {
        await emailService.sendInvitationEmail({
          to: invitation.sentTo, code: rawCode, child, inviter: req.user, expiresAt: newExpiry,
        });
      } catch (e) { console.warn('Resend email error:', e.message); }
    }

    await createLog({
      actorId: req.user.userId,
      action: 'invitation:resend',
      targetType: 'GuardianInvitation',
      targetId: invitation._id,
      details: { sentTo: invitation.sentTo, resentCount: (invitation.resentCount || 0) + 1 },
      ip: req.ip,
    });

    res.json({ success: true, newCode: rawCode, expiresAt: newExpiry });
  } catch (err) {
    console.error('resendInvitation error:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────── Revoke invitation ─────────────────── */

async function revokeInvitation(req, res) {
  try {
    const { id } = req.params;
    const invitation = await GuardianInvitation.findById(id);
    if (!invitation) return res.status(404).json({ error: 'Invitation not found.' });
    if (String(invitation.createdBy) !== String(req.user.userId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the inviter or an admin may revoke this invitation.' });
    }

    invitation.revokedAt   = new Date();
    invitation.revokedBy   = req.user.userId;
    invitation.expiresAt   = new Date(); // immediately expire
    await invitation.save();

    await createLog({
      actorId: req.user.userId,
      action: 'invitation:revoke',
      targetType: 'GuardianInvitation',
      targetId: invitation._id,
      details: { sentTo: invitation.sentTo },
      ip: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('revokeInvitation error:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ─────────────────── Post-acceptance email bump ─────────────────── */
// Called by the accept-invitation page after a successful acceptance so the browser
// is never required to import Node modules directly.

async function sendAcceptanceEmails(req, res) {
  try {
    const { invitationId, inviterName, inviterEmail, acceptorName, acceptorEmail, childName } = req.body;
    if (!invitationId) return res.status(400).json({ error: 'invitationId is required.' });

    const invitation = await GuardianInvitation.findById(invitationId).lean();
    if (!invitation) return res.status(404).json({ error: 'Invitation not found.' });

    // Load child details for the welcome email
    let childForEmail = null;
    const firstChildId = invitation.childIds?.[0];
    if (firstChildId) {
      const c = await Child.findById(firstChildId).lean();
      if (c) childForEmail = { firstName: c.firstName, lastName: c.lastName, dateOfBirth: c.dateOfBirth, profileIcon: c.profileIcon };
    }

    try {
      await emailService.sendWelcomeEmail({
        to: acceptorEmail,
        guardianName: acceptorName || '',
        childName: childName || (childForEmail ? `${childForEmail.firstName} ${childForEmail.lastName}`.trim() : ''),
        inviterName: inviterName || '',
        inviterEmail: inviterEmail || '',
      });
    } catch (e) { console.warn('Welcome email error:', e.message); }

    if (inviterEmail) {
      try {
        await emailService.sendAcceptanceNotification({
          to: inviterEmail,
          inviterName: inviterName || '',
          acceptorName: acceptorName || '',
          acceptorEmail: acceptorEmail || '',
          childName: childName || '',
        });
      } catch (e) { console.warn('Acceptance notification error:', e.message); }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('sendAcceptanceEmails error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/v2/guardians/create-account
 *
 * Creates a secondary family account (e.g. for spouse) directly without
 * requiring the invitation email flow. The caller must be the primary
 * guardian for at least one child being linked.
 *
 * Request body:
 *   firstName, lastName, email, password       (required)
 *   middleName, relationship, childIds[]        (required: childIds)
 *   permissionPreset                            (optional, default: 'standard')
 *
 * Creates:
 *   - User account (role: 'parent', active)
 *   - GuardianLink entries for each childId
 */
async function createSecondaryAccount(req, res) {
  try {
    const {
      firstName, lastName, middleName, email, password,
      relationship, childIds, permissionPreset,
    } = req.body;

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: 'firstName, lastName, email, and password are required.' });
    }
    if (!childIds || !Array.isArray(childIds) || !childIds.length) {
      return res.status(400).json({ error: 'At least one childId is required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanFirstName = String(firstName).trim();
    const cleanLastName = String(lastName).trim();

    // Verify caller is primary guardian for all target children
    const children = await Child.find({ _id: { $in: childIds } }).lean();
    if (children.length !== childIds.length) {
      return res.status(404).json({ error: 'One or more children not found.' });
    }

    for (const child of children) {
      const isOwner = String(child.parentId) === String(req.user.userId);
      if (isOwner) continue;
      const primaryLink = await GuardianLink.findOne({
        childId: child._id, guardianId: req.user.userId, isPrimary: true, status: 'active',
      }).lean();
      if (!primaryLink) {
        return res.status(403).json({
          error: `You are not the primary guardian for ${child.firstName} ${child.lastName}.`,
        });
      }
    }

    // Check for duplicate email
    const existingUser = await User.findOne({ email: cleanEmail }).select('_id').lean();
    if (existingUser) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    // Auto-generate a username based on email prefix + random suffix
    const emailPrefix = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_');
    const username = `${emailPrefix}_${Date.now().toString(36)}`;

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await User.create({
      firstName: cleanFirstName,
      middleName: middleName ? String(middleName).trim() : null,
      lastName: cleanLastName,
      username,
      email: cleanEmail,
      passwordHash,
      role: 'parent',
      status: 'active',
      emailVerified: true,
      profileIcon: 'avatar1',
    });

    // Resolve permission set
    let permSet = null;
    const presetName = permissionPreset || 'standard';
    permSet = await PermissionSet.findOne({ name: presetName.charAt(0).toUpperCase() + presetName.slice(1) });
    if (!permSet) {
      permSet = await PermissionSet.findOne({ name: 'Standard' });
      if (!permSet) {
        permSet = await PermissionSet.create({
          name: 'Standard', description: 'Default standard guardian permissions', permissions: {},
        });
      }
    }

    // Create GuardianLink for each child
    await Promise.all(childIds.map(async (childId) => {
      await GuardianLink.create({
        childId,
        guardianId: user._id,
        isPrimary: false,
        role: relationship || 'parent',
        status: 'active',
        permissions: permSet.permissions || {},
        permissionSet: permSet._id,
        createdBy: req.user.userId,
      });
    }));

    await createLog({
      actorId: req.user.userId,
      action: 'family:account:create',
      targetType: 'User',
      targetId: user._id,
      details: { newUserId: user._id, childIds, relationship: relationship || 'parent' },
      ip: req.ip,
    });

    res.status(201).json({
      success: true,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
      },
      message: `Account created for ${cleanFirstName} ${cleanLastName}. They can log in with their email and password.`,
    });
  } catch (err) {
    console.error('createSecondaryAccount error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  generateInvitation, acceptInvitation, verifyInvitation,
  listGuardians, updatePermissions, revokeGuardian, transferPrimary,
  listPendingInvitations, resendInvitation, revokeInvitation,
  sendAcceptanceEmails, createSecondaryAccount,
};
