// Refund model
// One parent request to refund an online (PayMongo) payment, and what happened
// to it. The Payment row only turns 'Refunded' once PayMongo confirms the
// refund succeeded — never on staff approval alone (services/refundService.js).
const mongoose = require('mongoose');

const REFUND_STATUSES = ['pending_review', 'approved', 'processing', 'refunded', 'rejected', 'failed'];

const refundSchema = new mongoose.Schema(
  {
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, index: true },
    appointmentNumericId: { type: Number, required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', default: null },
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: 'PHP' },
    reason: { type: String, trim: true, maxlength: 500, required: true },

    status: { type: String, enum: REFUND_STATUSES, default: 'pending_review', index: true },

    // The payment id while this request is open or refunded; removed when it is
    // rejected or failed. Unique, so a payment has at most one live request.
    activeKey: { type: String, default: undefined },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByRole: { type: String, trim: true, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 500, default: null },

    // PayMongo side. providerStatus is PayMongo's own word: pending,
    // processing, succeeded or failed.
    paymongoPaymentId: { type: String, trim: true, default: null },
    paymongoRefundId: { type: String, trim: true, default: null, index: true },
    providerStatus: { type: String, trim: true, default: null },
    failureReason: { type: String, trim: true, default: null },
    refundedAt: { type: Date, default: null },
    lastProviderSyncAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'refunds' }
);

refundSchema.index(
  { activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } }
);

refundSchema.statics.STATUSES = REFUND_STATUSES;

module.exports = mongoose.models.Refund || mongoose.model('Refund', refundSchema);
