// Appointment model
// Stores parent appointment bookings for pediatricians.
// Connection note: models do not store the connection string.
// They attach to the mongoose connection that db.js already opened.
const mongoose = require('mongoose');
const Counter = require('./Counter');

const appointmentSchema = new mongoose.Schema(
  {
    // Numeric id kept because several existing HTML pages use ids directly in onclick.
    id: { type: Number, unique: true, index: true },
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, default: null, index: true },
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    appointmentDate: { type: Date, required: true },
    // Keep time as a simple HH:mm or browser time string so frontend formatting stays easy.
    appointmentTime: { type: String, required: true },
    reason: { type: String, trim: true, default: null },
    notes: { type: String, trim: true, default: null },
    location: { type: String, trim: true, default: null },
    paymentType: {
      type: String,
      enum: ['Full', 'Down', 'Partial', null],
      default: null,
      index: true,
    },
    totalAmount: { type: Number, min: 0, default: 0 },
    amountPaid: { type: Number, min: 0, default: 0 },
    balanceDue: { type: Number, min: 0, default: 0 },
    paymentStatus: {
      type: String,
      enum: ['Unpaid', 'Pending Payment', 'Payment Verification Pending', 'Down Payment', 'Partially Paid', 'Paid', 'Cancelled'],
      default: 'Unpaid',
      index: true,
    },
    pendingPaymentMode: {
      type: String,
      // 'walk_in' / 'ewallet' are the original manually-verified modes.
      // 'paymongo'      — parent is paying online via PayMongo hosted checkout
      // 'pay_at_clinic' — parent pays at the counter; secretary scans their QR
      enum: ['walk_in', 'ewallet', 'paymongo', 'pay_at_clinic', null],
      default: null,
    },
    nextInstallmentDate: { type: Date, default: null },
    paymentOverride: {
      isOverridden: { type: Boolean, default: false },
      overriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      reason: { type: String, trim: true, default: null },
      overriddenAt: { type: Date, default: null },
    },
    // Helps the 30-minute slot migration keep older appointment times recoverable.
    legacySlotIssue: { type: Boolean, default: false, index: true },
    slotMigration: {
      originalAppointmentTime: { type: String, default: null },
      action: { type: String, enum: ['rounded', 'flagged', null], default: null },
      note: { type: String, default: null },
      migratedAt: { type: Date, default: null },
      rolledBackAt: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'completed', 'cancelled', 'rejected'],
      default: 'pending',
      index: true,
    },
    hasVideo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'appointments' }
);

appointmentSchema.pre('validate', async function (next) {
  if (!this.isNew || this.id != null) return next();
  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'appointments' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    this.id = counter.seq;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
