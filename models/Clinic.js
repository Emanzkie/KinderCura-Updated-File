// Clinic model — a registered clinic, created by an admin.
//
// Distinct from three things it is easy to confuse it with:
//   - system_settings.clinic (models/SystemSetting.js): the one shared clinic
//     profile printed on receipts and payment pages. Not a registered clinic.
//   - a pediatrician account, or its free-text User.clinicName/clinicAddress
//     typed at sign-up. Not a clinic record either.
//   - the pediatrician-to-clinic link: User.clinicId (one clinic per
//     pediatrician, any number of pediatricians per clinic).
//
// Identity is the _id. identityKey only blocks registering the same clinic
// twice: the same name at the same address (case, spacing and punctuation
// ignored). The same name at another address is another clinic — a branch —
// and similar names are never merged.
const mongoose = require('mongoose');

const CLINIC_STATUSES = Object.freeze(['active', 'inactive']);

/** Lower-cased, punctuation and spacing collapsed: "Sta. Rosa  Clinic" → "sta rosa clinic". */
function normalizeIdentityPart(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function clinicIdentityKey(name, address) {
  return `${normalizeIdentityPart(name)}|${normalizeIdentityPart(address)}`;
}

const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    contactPhone: { type: String, trim: true, maxlength: 40, default: null },
    contactEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    // active: registered and operating on KinderCura. inactive: an admin has
    // marked it as no longer operating; no new pediatrician can be linked to
    // it. Neither status changes bookings, payments or accounts.
    status: { type: String, enum: CLINIC_STATUSES, default: 'active', index: true },
    identityKey: { type: String, required: true, unique: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  // createdAt is the registration date.
  { timestamps: true, collection: 'clinics' }
);

clinicSchema.pre('validate', function setIdentityKey() {
  this.identityKey = clinicIdentityKey(this.name, this.address);
});

const Clinic = mongoose.models.Clinic || mongoose.model('Clinic', clinicSchema);
Clinic.CLINIC_STATUSES = CLINIC_STATUSES;
Clinic.clinicIdentityKey = clinicIdentityKey;
module.exports = Clinic;
