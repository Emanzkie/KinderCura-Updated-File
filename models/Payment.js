// Payment model
// Stores every payment transaction for an appointment while Appointment keeps
// a denormalized balance snapshot for fast listing.
const mongoose = require('mongoose');
const Counter = require('./Counter');

const paymentSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true, index: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, index: true },
    appointmentNumericId: { type: Number, required: true, index: true },
    amountPaid: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paymentType: {
      type: String,
      enum: ['full_payment', 'down_payment', 'partial_installment', 'balance_payment'],
      required: true,
      index: true,
    },
    balanceDue: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['Pending', 'Partially Paid', 'Paid', 'Cancelled'],
      required: true,
      index: true,
    },
    transactionDate: { type: Date, default: Date.now, index: true },
    paymentMethod: {
      type: String,
      enum: ['simulated_gateway', 'card', 'gcash', 'bank_transfer', 'cash', 'check'],
      required: true,
    },
    nextInstallmentDate: { type: Date, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedByRole: { type: String, trim: true, default: null },
    referenceNumber: { type: String, trim: true, default: null },
    notes: { type: String, trim: true, default: null },
  },
  { timestamps: true, collection: 'payments' }
);

paymentSchema.pre('validate', async function (next) {
  if (!this.isNew || this.id != null) return next();
  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'payments' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    this.id = counter.seq;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
