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
    amount: { type: Number, required: true, min: 0, alias: 'amountPaid' },
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
      // 'Failed' / 'Expired' / 'Refunded' were added for gateway-driven payments,
      // where the outcome is decided by PayMongo rather than by a staff member.
      enum: [
        'Pending', 'Verification Pending', 'Down Payment', 'Partially Paid',
        'Paid', 'Cancelled', 'Failed', 'Expired', 'Refunded',
      ],
      required: true,
      index: true,
    },
    transactionDate: { type: Date, default: Date.now, index: true },
    paymentMethod: {
      type: String,
      // 'paymongo'      — parent paid online through PayMongo hosted checkout
      // 'pay_at_clinic' — parent pays physically; the secretary confirms by QR
      enum: [
        'simulated_gateway', 'card', 'gcash', 'maya', 'bank_transfer',
        'cash', 'check', 'ewallet', 'paymongo', 'pay_at_clinic',
      ],
      required: true,
    },
    nextInstallmentDate: { type: Date, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedByRole: { type: String, trim: true, default: null },
    referenceNumber: { type: String, trim: true, default: null },
    notes: { type: String, trim: true, default: null },
    proofImagePath: { type: String, trim: true, default: null },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Automated payment fields (PayMongo online + Pay-at-Clinic QR) ────────
    // Everything below is optional so the payment rows written by the older
    // walk-in / e-wallet flow stay valid exactly as they are.

    // Human-facing identifier, e.g. KC-PAY-2026-000001. This is the ONLY value
    // encoded into the Pay-at-Clinic QR code — never patient data.
    // Uniqueness is enforced by a partial index declared below, not here: these
    // fields default to null, and a `sparse` unique index still indexes an
    // explicit null, so the second unreceipted payment would collide.
    paymentRef: { type: String, trim: true, default: null },

    // Issued once, when the payment is actually settled. Its presence is what
    // makes "already receipted" checks cheap and reliable.
    receiptNumber: { type: String, trim: true, default: null },

    currency: { type: String, trim: true, uppercase: true, default: 'PHP' },

    // Denormalized parties. The appointment remains the source of truth; these
    // exist so admin reconciliation can filter without joining every time.
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null, index: true },
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    paidAt: { type: Date, default: null, index: true },

    // Captured at creation so a later email address change cannot silently
    // redirect an old receipt.
    receiptEmail: { type: String, trim: true, lowercase: true, default: null },
    // Set the moment the receipt email is dispatched. Guards against a retried
    // webhook sending the parent a second copy of the same receipt.
    receiptSentAt: { type: Date, default: null },

    // External identifiers from PayMongo. paymentIntentId and checkoutSessionId
    // are both indexed because a webhook may arrive keyed on either one.
    paymongoCheckoutSessionId: { type: String, trim: true, default: null, index: true },
    paymongoPaymentId: { type: String, trim: true, default: null, index: true },
    paymongoPaymentIntentId: { type: String, trim: true, default: null, index: true },

    // Which e-wallet the parent actually used at PayMongo checkout, e.g.
    // 'gcash' or 'paymaya'. `paymentMethod` stays 'paymongo' for all online
    // payments (admin monitoring counts on that); this optional field just
    // records the brand so receipts, the pediatrician notification, and the
    // appointment card can show "GCash" / "Maya" instead of a generic label.
    // Null on older rows and whenever PayMongo's payload does not carry it.
    paymongoSourceType: { type: String, trim: true, lowercase: true, default: null },
    checkoutUrl: { type: String, trim: true, default: null },
    checkoutExpiresAt: { type: Date, default: null },

    // Last webhook event id applied to this row. Compared before processing so
    // a duplicate delivery is a no-op instead of a second receipt.
    lastWebhookEventId: { type: String, trim: true, default: null },
    failureReason: { type: String, trim: true, default: null },
  },
  { timestamps: true, collection: 'payments' }
);

// Unique only among documents that actually carry a value. A partial index is
// required rather than `sparse`, because both fields default to null and a
// sparse unique index treats an explicit null as a real, collidable value.
paymentSchema.index(
  { paymentRef: 1 },
  { unique: true, partialFilterExpression: { paymentRef: { $type: 'string' } } }
);
paymentSchema.index(
  { receiptNumber: 1 },
  { unique: true, partialFilterExpression: { receiptNumber: { $type: 'string' } } }
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

/**
 * Year-scoped, gap-free sequence shared by payment references and receipts.
 * Uses the same Counter collection the numeric `id` above already relies on,
 * so there is one mechanism for sequences in the project rather than two.
 *
 * nextSequence('KC-PAY') -> 'KC-PAY-2026-000001'
 */
async function nextSequence(prefix) {
  const year = new Date().getFullYear();
  const counter = await Counter.findOneAndUpdate(
    { _id: `${prefix}-${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `${prefix}-${year}-${String(counter.seq).padStart(6, '0')}`;
}

paymentSchema.statics.nextPaymentRef = () => nextSequence('KC-PAY');
paymentSchema.statics.nextReceiptNumber = () => nextSequence('KC-RCPT');

module.exports = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);
