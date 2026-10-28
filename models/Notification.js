// Notification model
// Keeps the in-app bell notifications in MongoDB for parents, pediatricians, and admins.
const mongoose = require('mongoose');
const Counter = require('./Counter');

const notificationSchema = new mongoose.Schema(
  {
    // Numeric id is preserved because several existing frontend handlers still expect n.id.
    id: { type: Number, unique: true, index: true },

    // userId points to the account that should see the notification in the bell modal.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    type: { type: String, default: 'system', trim: true, index: true },
    relatedPage: { type: String, default: null, trim: true },
    relatedId: { type: String, default: null, trim: true }, // Store questionSetId, appointmentId, etc. for context
    isRead: { type: Boolean, default: false, index: true },
    // Set only on scheduled reminders (services/reminders.js): one key per
    // thing being reminded about, so a reminder is never sent twice even when
    // the daily job runs again or twice at once.
    reminderKey: { type: String, default: undefined },
  },
  {
    timestamps: true,
    collection: 'notifications',
  }
);

notificationSchema.index(
  { reminderKey: 1 },
  { unique: true, partialFilterExpression: { reminderKey: { $type: 'string' } } }
);

notificationSchema.pre('validate', async function assignNumericId(next) {
  if (!this.isNew || this.id != null) return next();

  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'notifications' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    this.id = counter.seq;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
