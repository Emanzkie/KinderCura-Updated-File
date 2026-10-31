// ActivitySchedule model
// One scheduled session of a recommended home activity: the parent (or a
// guardian with viewRecommendations) picks a Manila date and time for one of a
// Recommendation's `activities`, then marks it completed (with an optional
// 0-100% score) or missed. Routes are in routes/recommendations.js; the daily
// reminder job (services/reminders.js) reminds whoever scheduled it.
const mongoose = require('mongoose');

const activityScheduleSchema = new mongoose.Schema(
  {
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
    recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recommendation', required: true, index: true },
    // The assessment the recommendation came from, so a reminder can link back
    // to the same recommendations page.
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', default: null },
    skill: { type: String, required: true, trim: true },
    // The exact string from Recommendation.activities.
    activity: { type: String, required: true },
    // Manila calendar day and wall-clock time, like the reminder job's dates.
    scheduledDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    scheduledTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    // A session still 'pending' after its day has ended is shown as missed
    // (effectiveStatus in routes/recommendations.js); 'missed' is stored only
    // when the parent marks it so.
    status: { type: String, enum: ['pending', 'completed', 'missed'], default: 'pending' },
    score: { type: Number, min: 0, max: 100, default: null },
    completedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'activity_schedules' }
);

activityScheduleSchema.index({ childId: 1, scheduledDate: 1 });
activityScheduleSchema.index({ status: 1, scheduledDate: 1 });

module.exports = mongoose.models.ActivitySchedule || mongoose.model('ActivitySchedule', activityScheduleSchema);
