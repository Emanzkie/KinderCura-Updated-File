// Recommendation model
// Stores generated advice based on the latest assessment result.
// Connection note: recommendation model uses the shared mongoose connection from db.js.
const mongoose = require('mongoose');

const recommendationSchema = new mongoose.Schema(
  {
    assessmentResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssessmentResult', required: true, index: true },
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    skill: { type: String, required: true, trim: true },
    priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
    suggestion: { type: String, required: true },
    activities: [{ type: String }],
    consultationNeeded: { type: Boolean, default: false },
    generatedAt: { type: Date, default: Date.now },
    // Home activities the parent/guardian has marked done. `activity` is the
    // exact string from `activities` above; at most one entry per activity
    // (enforced by the conditional update in PATCH /:recommendationId/activities).
    completedActivities: [
      {
        _id: false,
        activity: { type: String, required: true },
        completedAt: { type: Date, default: Date.now },
        completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      },
    ],
  },
  { timestamps: false, collection: 'recommendations' }
);

module.exports = mongoose.models.Recommendation || mongoose.model('Recommendation', recommendationSchema);
