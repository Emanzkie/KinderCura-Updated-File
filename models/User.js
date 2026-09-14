// models/User.js
// Stores all account types and the pediatrician schedule/settings in MongoDB.
const mongoose = require('mongoose');
const { SYNTHETIC_FIELDS } = require('../constants/syntheticData');

const availabilitySchema = new mongoose.Schema(
  {
    days: [{ type: String, trim: true }],
    startTime: { type: String, default: '09:00' },
    endTime: { type: String, default: '17:00' },
    maxPatientsPerDay: { type: Number, default: 10 },
    // Optional provider breaks are skipped when the booking page generates slots.
    breaks: [
      new mongoose.Schema(
        {
          label: { type: String, trim: true, default: null },
          startTime: { type: String, required: true },
          endTime: { type: String, required: true },
        },
        { _id: false }
      ),
    ],
  },
  { _id: false }
);

const notificationSettingsSchema = new mongoose.Schema(
  {
    emailAppointments: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    assessmentCompleted: { type: Boolean, default: true },
    dailySummary: { type: Boolean, default: false },
  },
  { _id: false }
);

const privacySettingsSchema = new mongoose.Schema(
  {
    showProfile: { type: Boolean, default: true },
    showAvailability: { type: Boolean, default: true },
    shareRecommendations: { type: Boolean, default: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, trim: true, default: null },
    lastName: { type: String, required: true, trim: true },
    username: { type: String, required: true, trim: true, unique: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },

    // Important: 'secretary' is the new Clinic Secretary role.
    // Admins create secretary accounts and link them to one pediatrician.
    role: {
      type: String,
      enum: ['parent', 'legal_guardian', 'foster_parent', 'court_appointed', 'pediatrician', 'admin', 'secretary'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'pending', 'suspended'],
      default: 'active',
    },
    emailVerified: { type: Boolean, default: false },
    profileIcon: { type: String, default: 'avatar1' },

    // Guardian verification and tiering (additive, safe for existing accounts)
    guardianVerificationTier: {
      type: String,
      enum: ['tier1', 'tier2', 'tier3'],
      default: 'tier1',
    },
    guardianIdDocumentPath: { type: String, default: null },
    guardianVerificationStatus: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: null,
    },
    guardianVerifiedAt: { type: Date, default: null },
    twoFactorEnabled: { type: Boolean, default: false },

    // Pediatrician profile fields
    licenseNumber: { type: String, trim: true, default: null },
    institution: { type: String, trim: true, default: null },
    specialization: { type: String, trim: true, default: null },
    clinicName: { type: String, trim: true, default: null },
    clinicAddress: { type: String, trim: true, default: null },
    phoneNumber: { type: String, trim: true, default: null },
    consultationFee: { type: Number, default: null },
    bio: { type: String, trim: true, default: null },
    availability: { type: availabilitySchema, default: () => ({}) },
    notificationSettings: { type: notificationSettingsSchema, default: () => ({}) },
    privacySettings: { type: privacySettingsSchema, default: () => ({}) },

    // Pediatrician ID verification fields
    idDocumentPath: { type: String, default: null },
    idDocumentUploadedAt: { type: Date, default: null },

    // ── PRC License Verification fields (added by PRC Verification Module) ──
    prcLicenseNumber: { type: String, trim: true, default: null },
    licenseExpiry: { type: Date, default: null },
    prcIdDocumentPath: { type: String, default: null },
    prcVerificationStatus: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: null,
    },
    prcAdminNotes: { type: String, trim: true, default: null },
    prcSubmittedAt: { type: Date, default: null },
    prcVerifiedAt: { type: Date, default: null },
    prcVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Admin fields
    organization: { type: String, trim: true, default: null },
    department: { type: String, trim: true, default: null },

    // Secretary field — points to the one pediatrician this secretary manages for.
    // Set automatically when the pediatrician creates the secretary account.
    linkedPediatricianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Important: secretaryPermissions — fine-grained control set by the Pediatrician
    // from their Settings > Staff Access tab.
    // Only scheduling-related actions are listed here.
    // Medical decisions (diagnosis, results, recommendations) are NEVER included.
    secretaryPermissions: {
      viewAppointments: { type: Boolean, default: true },
      manageBookings: { type: Boolean, default: true },
      rescheduleRequests: { type: Boolean, default: true },
      approveSchedules: { type: Boolean, default: true },
      // managePayments — confirming cash/POS payments at the clinic counter.
      // Deliberately defaults to false (unlike the scheduling flags above):
      // this is a financial action and must be an explicit opt-in by the
      // pediatrician, not something a new secretary account gets automatically.
      managePayments: { type: Boolean, default: false },
    },

    // ── Synthetic/demo marker (additive) ────────────────────────────────────
    // false/null on every real account, including every account created before
    // this field existed. Set to true ONLY by
    // scripts/generate-system-demo-data.js, and it is the ONLY thing that makes
    // an account eligible for that script's purge path — a real account can
    // never be reached by it. Nothing in the app reads this to change
    // behaviour: synthetic accounts are ordinary users to every route,
    // including Admin Analytics, which is the entire point (the analytics
    // numbers must come from real aggregation over real documents).
    // See constants/syntheticData.js.
    ...SYNTHETIC_FIELDS,
  },
  { timestamps: true }
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
