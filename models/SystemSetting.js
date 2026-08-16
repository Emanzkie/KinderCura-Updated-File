// SystemSetting model
// Stores lightweight platform-wide switches that affect runtime behavior.
const mongoose = require('mongoose');

const appointmentSlotSettingsSchema = new mongoose.Schema(
  {
    // When true, new bookings and reschedules must use 30-minute aligned slots.
    enforceThirtyMinuteSlots: { type: Boolean, default: true },
    slotMinutes: { type: Number, default: 30 },
  },
  { _id: false }
);

// Clinic identity and payment preferences.
// These values appear on receipts and payment pages. They live here, in one
// database document, specifically so the clinic's real contact details can be
// changed from the admin settings page without editing any source file.
const clinicSettingsSchema = new mongoose.Schema(
  {
    clinicName: { type: String, trim: true, default: 'KinderCura Clinic' },
    // Placeholder until the clinic supplies its real line — change it in the
    // database or the admin settings page, never in code.
    phoneNumber: { type: String, trim: true, default: '+63 000 000 0000' },
    email: { type: String, trim: true, default: 'billing@kindercura.example' },
    address: { type: String, trim: true, default: 'Clinic address not yet configured' },
    // Optional: the pediatrician this clinic record represents, when a single
    // practice runs the deployment.
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    currency: { type: String, trim: true, uppercase: true, default: 'PHP' },
    // Master switches for the two automated payment routes.
    onlinePaymentEnabled: { type: Boolean, default: true },
    payAtClinicEnabled: { type: Boolean, default: true },
    // Which PayMongo methods the hosted checkout should offer.
    paymongoMethods: { type: [String], default: ['gcash', 'paymaya', 'card'] },
    active: { type: Boolean, default: true },
  },
  { _id: false }
);

const systemSettingSchema = new mongoose.Schema(
  {
    singleton: { type: String, unique: true, default: 'default' },
    appointmentSlots: { type: appointmentSlotSettingsSchema, default: () => ({}) },
    clinic: { type: clinicSettingsSchema, default: () => ({}) },
  },
  { timestamps: true, collection: 'system_settings' }
);

/** Returns the clinic config, creating the singleton with defaults on first use. */
systemSettingSchema.statics.getClinic = async function getClinic() {
  const doc = await this.findOneAndUpdate(
    { singleton: 'default' },
    { $setOnInsert: { singleton: 'default' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return { ...(new this().clinic.toObject()), ...(doc?.clinic || {}) };
};

module.exports = mongoose.models.SystemSetting || mongoose.model('SystemSetting', systemSettingSchema);
