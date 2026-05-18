// models/GuardianInvitation.js
// Stores guardian invitation tokens for KinderCura's Linked Guardian Account System.
const mongoose = require('mongoose');

const guardianInvitationSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true },
    // --- Enriched invitation metadata ---
    childIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Child' }], // one or more children
    relationship: {
      type: String,
      enum: ['mother','father','grandparent','legal_guardian','foster_parent','court_appointed','nanny','babysitter','therapist','teacher','other'],
      default: 'legal_guardian',
    },
    permissionPreset: {
      type: String,
      enum: ['full','standard','medical','limited','custom'],
      default: 'standard',
    },
    customPermissions: {
      viewAssessments:    { type: Boolean, default: true },
      submitAssessments:  { type: Boolean, default: false },
      viewResults:        { type: Boolean, default: true },
      uploadDocuments:    { type: Boolean, default: false },
      manageAppointments: { type: Boolean, default: false },
      viewMedicalRecords: { type: String, enum: ['none','partial','full'], default: 'partial' },
      modifyChild:        { type: Boolean, default: false },
      inviteGuardians:    { type: Boolean, default: false },
      revokeAccess:       { type: Boolean, default: false },
      viewMessages:       { type: Boolean, default: true },
      sendMessages:       { type: Boolean, default: false },
      manageMessages:     { type: Boolean, default: false },
      viewNotifications:  { type: Boolean, default: true },
      sendNotifications:  { type: Boolean, default: false },
      manageNotifications:{ type: Boolean, default: false },
    },
    personalMessage: { type: String, trim: true, default: null },
    // --- Core fields ---
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, default: null },
    singleUse: { type: Boolean, default: true },
    used: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    usedAt: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
    // --- Email tracking ---
    sentTo: { type: String, trim: true, default: null },
    emailSent: { type: Boolean, default: false },
    viewCount: { type: Number, default: 0 },
    viewTokenHash: { type: String, default: null }, // rotated on each page view to prevent replay
    lastViewedAt: { type: Date, default: null },
    // --- Resend tracking ---
    resentCount: { type: Number, default: 0 },
    lastResentAt: { type: Date, default: null },
    // --- Revocation ---
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Index for efficient lookups by codeHash (unique per invitation)
guardianInvitationSchema.index({ codeHash: 1 }, { unique: true });

module.exports = mongoose.models.GuardianInvitation || mongoose.model('GuardianInvitation', guardianInvitationSchema);
