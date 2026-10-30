// Follow-up Check-up plans (models/FollowUpPlan.js) after they are created:
//
//   activateForAppointment — called by the two places where a payment confirms
//     an appointment (receiptService.syncAppointmentAfterPayment for online and
//     Cashier payments, paymentController.confirmWalkIn for a staff-confirmed
//     walk-in). It assigns the plan's assessments by moving the plan from
//     'awaiting_payment' to 'active' exactly once and starting its monitoring
//     period. A failure here is logged and never fails the payment.
//
//   planProgress — what the pediatrician and the parent see: completed and
//     remaining assessments, the deadline, and the appointment's state. A
//     "completed assessment" is the child's ordinary completed screening
//     (Assessment status 'complete') since the plan became active; its score
//     is read from AssessmentResult, never recomputed here.
const FollowUpPlan = require('../models/FollowUpPlan');
const Appointment = require('../models/Appointment');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const Child = require('../models/Child');
const Notification = require('../models/Notification');
const { clinicToday, addDays } = require('./reminders');
const { CLINIC_TIMEZONE, clinicDayEnd } = require('../constants/clinicTime');

const personName = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ');

function formatClinicDate(date) {
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: CLINIC_TIMEZONE });
}

// Appointment dates are stored as UTC midnight of the booked day.
function formatAppointmentDate(date) {
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatTime(value) {
  const [rawH, rawM] = String(value || '').split(':');
  const h = parseInt(rawH, 10);
  if (Number.isNaN(h)) return String(value || '');
  return `${h % 12 || 12}:${String(rawM || '00').padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** End of the Manila day `monitoringDays` after `from`: the plan's deadline. */
function dueDateFrom(from, monitoringDays) {
  return clinicDayEnd(addDays(clinicToday(from), Number(monitoringDays)));
}

async function notify(userId, title, message, type, relatedPage, relatedId) {
  if (!userId) return;
  try {
    await Notification.create({ userId, title, message, type, relatedPage, relatedId: relatedId != null ? String(relatedId) : null, isRead: false });
  } catch (err) {
    console.warn('[followUpPlans] notification failed:', err.message);
  }
}

async function activateForAppointment(appointment, now = new Date()) {
  if (!appointment || !appointment._id || appointment.status !== 'approved') return null;
  try {
    const pending = await FollowUpPlan.findOne({ appointmentId: appointment._id, status: 'awaiting_payment' })
      .select('monitoringDays').lean();
    if (!pending) return null;

    const dueDate = dueDateFrom(now, pending.monitoringDays);
    // The status condition is the guard: if two confirmations race (a webhook
    // retry, a double click), only one update matches.
    const plan = await FollowUpPlan.findOneAndUpdate(
      { _id: pending._id, status: 'awaiting_payment' },
      { $set: { status: 'active', activatedAt: now, dueDate } },
      { new: true }
    ).lean();
    if (!plan) return null;

    const child = await Child.findById(plan.childId).select('firstName lastName parentId').lean();
    const childName = personName(child) || 'your child';
    const due = formatClinicDate(plan.dueDate);
    const visit = `${formatAppointmentDate(appointment.appointmentDate)} at ${formatTime(appointment.appointmentTime)}`;
    const count = `${plan.requiredAssessments} developmental assessment${plan.requiredAssessments === 1 ? '' : 's'}`;

    await notify(
      plan.parentId || child?.parentId,
      'Follow-up assessments assigned',
      `Payment confirmed. Please complete ${count} for ${childName} by ${due}. The follow-up check-up on ${visit} is confirmed.`,
      'assessment',
      '/parent/dashboard',
      plan._id
    );
    await notify(
      plan.pediatricianId,
      'Follow-up payment confirmed',
      `Payment for ${childName}'s follow-up check-up on ${visit} (Appointment #${appointment.id}) was confirmed. ${count} assigned, due ${due}.`,
      'appointment',
      '/pedia/pediatrician-patients',
      plan._id
    );
    return plan;
  } catch (err) {
    console.error('[followUpPlans] activation failed for appointment', String(appointment._id), err.message);
    return null;
  }
}

// What a plan looks like now. Appointment state wins over the plan's own
// status: a cancelled appointment ends the plan, a completed one means the
// follow-up visit happened.
function planState(plan, appointment, completed, now) {
  if (!appointment || ['cancelled', 'rejected'].includes(appointment.status) || plan.status === 'cancelled') return 'cancelled';
  if (appointment.status === 'completed') return 'visit_completed';
  if (plan.status === 'awaiting_payment') return 'awaiting_payment';
  if (completed >= plan.requiredAssessments) return 'assessments_complete';
  if (plan.dueDate && now > new Date(plan.dueDate)) return 'overdue';
  return 'active';
}

async function planProgress(plans, now = new Date()) {
  if (!plans.length) return [];

  const appointments = await Appointment.find({ _id: { $in: plans.map((p) => p.appointmentId) } })
    .select('id appointmentDate appointmentTime status paymentStatus totalAmount amountPaid balanceDue').lean();
  const apptById = new Map(appointments.map((a) => [String(a._id), a]));

  const active = plans.filter((p) => p.activatedAt);
  const earliest = active.length ? new Date(Math.min(...active.map((p) => new Date(p.activatedAt).getTime()))) : null;
  const assessments = earliest
    ? await Assessment.find({
      childId: { $in: [...new Set(active.map((p) => String(p.childId)))] },
      status: 'complete',
      completedAt: { $gte: earliest },
    }).select('childId completedAt').sort({ completedAt: 1 }).lean()
    : [];
  const results = assessments.length
    ? await AssessmentResult.find({ assessmentId: { $in: assessments.map((a) => a._id) } }).select('assessmentId overallScore').lean()
    : [];
  const scoreById = new Map(results.map((r) => [String(r.assessmentId), r.overallScore]));

  return plans.map((plan) => {
    const appointment = apptById.get(String(plan.appointmentId)) || null;
    const done = plan.activatedAt
      ? assessments.filter((a) => String(a.childId) === String(plan.childId) && new Date(a.completedAt) >= new Date(plan.activatedAt))
      : [];
    const pedia = plan.pediatricianId;
    const pediaPopulated = Boolean(pedia) && typeof pedia === 'object' && pedia.firstName !== undefined;
    return {
      id: String(plan._id),
      childId: String(plan.childId),
      pediatricianId: pediaPopulated ? String(pedia._id) : String(pedia),
      pediatricianName: pediaPopulated ? personName(pedia) : null,
      fee: plan.fee,
      requiredAssessments: plan.requiredAssessments,
      monitoringDays: plan.monitoringDays,
      instructions: plan.instructions || null,
      status: plan.status,
      state: planState(plan, appointment, done.length, now),
      activatedAt: plan.activatedAt || null,
      dueDate: plan.dueDate || null,
      completed: done.length,
      remaining: Math.max(0, plan.requiredAssessments - done.length),
      assessments: done.map((a) => ({
        id: String(a._id),
        completedAt: a.completedAt,
        overallScore: scoreById.has(String(a._id)) ? scoreById.get(String(a._id)) : null,
        late: Boolean(plan.dueDate && new Date(a.completedAt) > new Date(plan.dueDate)),
      })),
      appointment: appointment ? {
        id: appointment.id,
        date: appointment.appointmentDate,
        time: appointment.appointmentTime,
        status: appointment.status,
        paymentStatus: appointment.paymentStatus,
        totalAmount: appointment.totalAmount || 0,
        amountPaid: appointment.amountPaid || 0,
        balanceDue: appointment.balanceDue || 0,
      } : null,
      createdAt: plan.createdAt,
    };
  });
}

module.exports = {
  activateForAppointment,
  planProgress,
  dueDateFrom,
  _internals: { planState, formatTime, formatAppointmentDate, formatClinicDate },
};
