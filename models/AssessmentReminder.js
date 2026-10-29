// AssessmentReminder model
// A parent's own recurring reminder to screen one child, e.g. "every 2 months
// on the 15th, 3 days before". One document per child. The daily reminder job
// (services/reminders.js) sends them to the parent's bell.
const mongoose = require('mongoose');

const assessmentReminderSchema = new mongoose.Schema(
  {
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, unique: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    frequencyMonths: { type: Number, enum: [1, 2, 3], required: true },
    dayOfMonth: { type: Number, min: 1, max: 28, required: true },
    // Days before the due date to send the reminder; 0 = on the day.
    leadDays: { type: Number, enum: [0, 1, 3, 7], required: true },
    status: { type: String, enum: ['active', 'paused'], default: 'active', index: true },
    // 'YYYY-MM' of the first due date; due dates repeat every frequencyMonths
    // from here. Pausing keeps it, so the cycle carries on after resuming.
    startMonth: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  },
  { timestamps: true, collection: 'assessment_reminders' }
);

module.exports = mongoose.models.AssessmentReminder || mongoose.model('AssessmentReminder', assessmentReminderSchema);
