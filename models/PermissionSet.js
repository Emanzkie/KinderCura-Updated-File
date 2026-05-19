// models/PermissionSet.js
const mongoose = require('mongoose');

const permissionsSchema = new mongoose.Schema(
  {
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
  },
  { _id: false }
);

const permissionSetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true, default: null },
    permissions: { type: permissionsSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.PermissionSet || mongoose.model('PermissionSet', permissionSetSchema);
