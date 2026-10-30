// FollowUpPlan model
// ============================================================================
// A "Follow-up Check-up" a pediatrician schedules from Patient Check-up
// History: the next appointment, its fee, and how many developmental
// assessments the parent should complete before it, within a monitoring
// period.
//
// The plan is an ADDITIONAL record, like SpecialistReferral. It never edits a
// check-up, an assessment or a score:
//   - the appointment is an ordinary Appointment (status 'pending', unpaid),
//     created together with the plan, so the existing payment page, payment
//     policy and confirmation code handle it unchanged;
//   - when that payment is confirmed, services/followUpPlans.js moves the plan
//     from 'awaiting_payment' to 'active' (once) and starts the period;
//   - "completed assessments" are the child's ordinary completed screenings
//     since activation — nothing is copied or re-scored here.
const mongoose = require('mongoose');

const STATUSES = ['awaiting_payment', 'active', 'cancelled'];

const followUpPlanSchema = new mongoose.Schema(
  {
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // The check-up this follow-up came out of (the pediatrician's latest one
    // for the child when the plan was made), or null when there was none.
    sourceCheckupId: { type: mongoose.Schema.Types.ObjectId, ref: 'PediatricianCheckup', default: null },

    // One plan per appointment: the appointment is created with the plan.
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
    // Appointment.id, the number the payment page and notifications use.
    appointmentNumericId: { type: Number, default: null, index: true },

    fee: { type: Number, required: true, min: 0 },
    requiredAssessments: { type: Number, required: true, min: 1 },
    monitoringDays: { type: Number, required: true, min: 1 },
    instructions: { type: String, default: null, trim: true },

    status: { type: String, enum: STATUSES, default: 'awaiting_payment', index: true },
    // Set once, when the payment is confirmed. The monitoring period runs from
    // activatedAt to dueDate.
    activatedAt: { type: Date, default: null },
    dueDate: { type: Date, default: null },

    // Sent by the form once per submission, so a resubmitted request returns
    // the plan that was already saved instead of creating a second one.
    clientRequestId: { type: String, default: null, trim: true },
  },
  { timestamps: true, collection: 'follow_up_plans' }
);

followUpPlanSchema.index(
  { pediatricianId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } }
);

followUpPlanSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.FollowUpPlan || mongoose.model('FollowUpPlan', followUpPlanSchema);
