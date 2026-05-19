// models/GuardianLink.js
const mongoose = require('mongoose');

const guardianLinkSchema = new mongoose.Schema(
  {
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    guardianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isPrimary: { type: Boolean, default: false },
    role: { type: String, enum: ['parent', 'legal_guardian', 'foster_parent', 'court_appointed'], default: 'parent' },
    status: { type: String, enum: ['pending', 'active', 'revoked', 'suspended', 'archived'], default: 'pending' },
    // Embedded permissions for fast checks; permissionSet may also be referenced.
    permissions: {
      viewAssessments: { type: Boolean, default: true },
      submitAssessments: { type: Boolean, default: true },
      viewResults: { type: Boolean, default: true },
      viewRecommendations: { type: Boolean, default: true },
      uploadDocuments: { type: Boolean, default: false },
      manageAppointments: { type: Boolean, default: true },
      viewMedicalRecords: { type: String, enum: ['none', 'partial', 'full'], default: 'partial' },
      modifyChild: { type: Boolean, default: false },
      inviteGuardians: { type: Boolean, default: false },
      revokeAccess: { type: Boolean, default: false },
      // Messaging permissions
      viewMessages: { type: Boolean, default: true },
      sendMessages: { type: Boolean, default: true },
      manageMessages: { type: Boolean, default: false },
      // Notification permissions
      viewNotifications: { type: Boolean, default: true },
      sendNotifications: { type: Boolean, default: false },
      manageNotifications: { type: Boolean, default: false },
    },
    permissionSet: { type: mongoose.Schema.Types.ObjectId, ref: 'PermissionSet', default: null },
    invitationId: { type: mongoose.Schema.Types.ObjectId, ref: 'GuardianInvitation', default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    transferLog: {
      previousPrimaryGuardianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      transferredAt: { type: Date, default: null },
      promotedAt: { type: Date, default: null },
      reason: { type: String, default: null },
    },
  },
  { timestamps: true }
);

guardianLinkSchema.index({ childId: 1, guardianId: 1 }, { unique: true, partialFilterExpression: { childId: { $exists: true }, guardianId: { $exists: true } } });

// Keep Child.guardianLinks in sync when links are created or removed.
const Child = require('./Child');

guardianLinkSchema.post('save', async function (doc) {
  try {
    if (!doc) return;
    const child = await Child.findById(doc.childId);
    if (!child) return;
    if (!Array.isArray(child.guardianLinks)) child.guardianLinks = [];
    const idStr = String(doc._id);
    const exists = child.guardianLinks.some((g) => String(g) === idStr);
    if (!exists && doc.status === 'active') {
      child.guardianLinks.push(doc._id);
      await child.save();
    } else if (exists && doc.status !== 'active') {
      child.guardianLinks = child.guardianLinks.filter((g) => String(g) !== idStr);
      await child.save();
    }
  } catch (err) {
    // Do not block main flow on hook errors
    console.error('GuardianLink post-save hook error:', err);
  }
});

// When a link is removed via findOneAndDelete / findByIdAndDelete
guardianLinkSchema.post('findOneAndDelete', async function (doc) {
  try {
    if (!doc) return;
    const child = await Child.findById(doc.childId);
    if (!child || !Array.isArray(child.guardianLinks)) return;
    const idStr = String(doc._id);
    if (child.guardianLinks.some((g) => String(g) === idStr)) {
      child.guardianLinks = child.guardianLinks.filter((g) => String(g) !== idStr);
      await child.save();
    }
  } catch (err) {
    console.error('GuardianLink post-delete hook error:', err);
  }
});

module.exports = mongoose.models.GuardianLink || mongoose.model('GuardianLink', guardianLinkSchema);
