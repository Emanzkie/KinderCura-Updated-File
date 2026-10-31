// routes/recommendations.js
// MongoDB recommendation route with suggested pediatrician / clinic support.
// Important:
// - still returns the domain recommendations used by the parent page
// - now also suggests active pediatricians based on the child's latest assessment result
// - tells the frontend if the child already has a consultation booked
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { canViewChild, hasPermission } = require('../middleware/guardianAccess');
const AssessmentResult = require('../models/AssessmentResult');
const Recommendation = require('../models/Recommendation');
const ActivitySchedule = require('../models/ActivitySchedule');
const Assessment = require('../models/Assessment');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const Child = require('../models/Child');
const scoring = require('../constants/scoring');
const staging = require('../constants/developmental-staging');

const assessmentProgress = require('../services/assessmentProgress');
const { clinicToday, addDays } = require('../services/reminders');

// ── Three concepts, three layers (see constants/developmental-staging.js) ──
// A. DEVELOPMENTAL BAND — a SCORE classification (constants/scoring.js:
//    on-track/developing/at-risk/delayed). Computed live from overallScore
//    wherever needed below; never persisted (see models/AssessmentResult.js).
// B. ML RISK CATEGORY — Low/Medium/High, ml/predict.py's raw output.
//    Produced ONCE, at assessment-completion time
//    (routes/assessments.js POST /submit) — not here.
// C. CARE STAGE — the centralized staging module's care-plan interpretation
//    of EITHER the risk category (ml) or, as fallback, the developmental
//    band (rule_based). This file (the recommendation engine) reads what
//    that interpretation already decided; it never re-derives Low/Medium/
//    High or a stage mapping itself.
//
// Step 5: this route reads the PREDICTION ALREADY STORED on the
// AssessmentResult (see models/AssessmentResult.js `prediction`) rather than
// calling ML again on every page load. That is what makes an assessment's
// recommendation stable over time — it must not change just because a
// newer ML model gets trained later. `predictionInfo` below can legitimately
// be `source: 'rule_based'` (no active model existed when this assessment
// was completed, or it's a pre-Step-5 legacy record) — never assume it's ML
// just because it's non-null; always read `.source`.
function getPredictionForResult(resultDoc) {
  return assessmentProgress.getStoredOrDerivedCareStage(resultDoc);
}

// ── Domain-level recommendations (unchanged in Step 3) ────────────────────
// These stay rule-based, keyed off each domain's own score band. They answer
// "what should the parent practice for communication/social/cognitive/motor
// this week" — a different question from "what is the child's OVERALL
// developmental stage", which is what buildOverallCarePlan() below answers
// using the centralized staging module. Do not confuse the two: this map
// is domain-tier wording selection, not an overall risk decision.
//
// Maps a score band to the recommendation tier. `level` selects the wording in
// suggestionMap below; `priority` is what the parent page sorts and badges on.
//
// Note the behaviour change vs. the previous 70/40 literals: scores 70-79 were
// formerly 'low' priority and now fall in `developing` -> 'medium'. That is the
// intended direction — see constants/scoring.js on erring toward over-referral.
const RECOMMENDATION_LEVEL_BY_BAND = Object.freeze({
  [scoring.BAND.ON_TRACK]:   { priority: 'low',    level: 'high' },
  [scoring.BAND.DEVELOPING]: { priority: 'medium', level: 'medium' },
  [scoring.BAND.AT_RISK]:    { priority: 'medium', level: 'medium' },
  [scoring.BAND.DELAYED]:    { priority: 'high',   level: 'low' },
});

function buildRecommendationSet(resultDoc, predictionInfo) {
  const suggestionMap = {
    communication: {
      high:   { suggestion: 'Continue encouraging verbal communication through storytelling and reading aloud daily.', activities: ['Read together 20 min/day', 'Ask open-ended questions', 'Sing songs and nursery rhymes'] },
      medium: { suggestion: 'Practice conversation skills and expand vocabulary with daily activities.', activities: ['Describe pictures in books', 'Play word games', 'Talk during daily routines'] },
      low:    { suggestion: 'Immediate speech therapy evaluation recommended. Focus on basic communication cues.', activities: ['Consult a speech therapist', 'Use picture cards for communication', 'Practice simple words daily'] },
    },
    social: {
      high:   { suggestion: 'Encourage group play and cooperative activities to further develop social bonds.', activities: ['Arrange playdates', 'Team sports or group classes', 'Board games with family'] },
      medium: { suggestion: 'Increase opportunities for peer interaction in structured settings.', activities: ['Join a playgroup', 'Practice turn-taking games', 'Role-play social scenarios'] },
      low:    { suggestion: 'Consider evaluation for social development support. Structured social programs recommended.', activities: ['Consult a developmental pediatrician', 'Social skills groups', 'Gradual peer exposure'] },
    },
    cognitive: {
      high:   { suggestion: 'Challenge with age-appropriate puzzles and creative problem-solving activities.', activities: ['Puzzles and building blocks', 'Science experiments', 'Memory games'] },
      medium: { suggestion: 'Incorporate more hands-on learning and exploratory play.', activities: ['Sorting and counting games', 'Simple cooking together', 'Nature exploration'] },
      low:    { suggestion: 'Cognitive development evaluation recommended. Focus on foundational learning skills.', activities: ['Consult a developmental specialist', 'Shape and color recognition', 'Simple cause-and-effect toys'] },
    },
    motor: {
      high:   { suggestion: 'Support fine and gross motor development through active play and art.', activities: ['Drawing and coloring', 'Outdoor play', 'Dance and movement activities'] },
      medium: { suggestion: 'Increase physical activities that challenge both fine and gross motor skills.', activities: ['Playdough and clay activities', 'Tricycle or bike riding', 'Climbing structures'] },
      low:    { suggestion: 'Occupational therapy evaluation recommended to address motor skill delays.', activities: ['Consult an occupational therapist', 'Finger strengthening exercises', 'Balance and coordination activities'] },
    },
  };

  const domains = [
    { key: 'communication', score: resultDoc.communicationScore },
    { key: 'social',        score: resultDoc.socialScore },
    { key: 'cognitive',     score: resultDoc.cognitiveScore },
    { key: 'motor',         score: resultDoc.motorScore },
  ];

  // Only a REAL ml-sourced prediction augments the per-domain consultation
  // flag — a rule_based-sourced predictionInfo (no active model at
  // completion time, or a pre-Step-5 legacy record) must not change
  // domain-tier behavior. Individual domain recommendations still use score
  // thresholds for granularity either way.
  const mlConsultation = predictionInfo && predictionInfo.source === 'ml' ? predictionInfo.consultationNeeded : null;

  return domains.map((d) => {
    const { priority, level } = RECOMMENDATION_LEVEL_BY_BAND[scoring.bandFor(d.score)];
    const info = suggestionMap[d.key][level];

    // Per-domain consultation: use rule-based logic per domain
    // The overall ML prediction augments the top-level consultationNeeded
    const domainConsultation = scoring.isRiskFlagged(d.score);

    return {
      skill: d.key,
      priority,
      suggestion: info.suggestion,
      activities: info.activities,
      consultationNeeded: mlConsultation != null ? (domainConsultation || mlConsultation) : domainConsultation,
    };
  });
}

// ── Activity completion ────────────────────────────────────────────────────
// Completion entries are stored on the Recommendation itself
// (models/Recommendation.js completedActivities). Only entries naming one of
// the recommendation's own activities count, so a stray entry can never push
// the percentage past 100.
function completedActivityNames(rec) {
  const valid = new Set(Array.isArray(rec.activities) ? rec.activities : []);
  const done = new Set();
  for (const c of rec.completedActivities || []) {
    if (c && valid.has(c.activity)) done.add(c.activity);
  }
  return [...done];
}

// Progress over one assessment's whole recommendation set (all four domains).
function buildActivityProgress(recDocs) {
  let total = 0;
  let completed = 0;
  for (const r of recDocs) {
    total += new Set(Array.isArray(r.activities) ? r.activities : []).size;
    completed += completedActivityNames(r).length;
  }
  return { completed, total, percentage: total ? Math.round((completed / total) * 100) : 0 };
}

// Only the child's parent, or a guardian whose link grants viewRecommendations,
// carries out home activities — pediatricians and admins can read the plan
// through GET but never tick or schedule.
async function canManageActivities(user, child) {
  if (String(child.parentId) === String(user.userId)) return true;
  return hasPermission(user.userId, child._id, 'viewRecommendations');
}

// The $ne filter makes the push a no-op when the activity is already recorded,
// so repeated or concurrent requests never create duplicates.
function markActivityDone(recId, activity, userId) {
  return Recommendation.updateOne(
    { _id: recId, 'completedActivities.activity': { $ne: activity } },
    { $push: { completedActivities: { activity, completedAt: new Date(), completedBy: userId } } }
  );
}

// Completed activities of one recommendation plus the progress over its whole
// set, as the checkbox and progress bar need them after a change.
async function activityState(rec) {
  const recDocs = await Recommendation.find({ assessmentResultId: rec.assessmentResultId }).sort({ generatedAt: 1 }).lean();
  const updated = recDocs.find((r) => String(r._id) === String(rec._id));
  return {
    completedActivities: updated ? completedActivityNames(updated) : [],
    activityProgress: buildActivityProgress(recDocs),
  };
}

// ── Scheduled activity sessions (models/ActivitySchedule.js) ──────────────
// Dates are Manila YYYY-MM-DD days and times HH:MM, like services/reminders.js.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHEDULE_AHEAD_DAYS = 365;

function isCalendarDate(ymd) {
  return typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ymd)
    && new Date(`${ymd}T00:00:00.000Z`).toISOString().slice(0, 10) === ymd;
}

/** Error message for a date/time the parent cannot schedule, or null. */
function scheduleError(date, time, today) {
  if (!isCalendarDate(date)) return 'Choose a valid date.';
  if (typeof time !== 'string' || !TIME_RE.test(time)) return 'Choose a valid time.';
  if (date < today) return 'The date cannot be in the past.';
  if (date > addDays(today, SCHEDULE_AHEAD_DAYS)) return 'Schedule at most one year ahead.';
  return null;
}

// A session still pending after its Manila day has ended counts as missed.
function effectiveStatus(task, today) {
  return task.status === 'pending' && task.scheduledDate < today ? 'missed' : task.status;
}

function serializeTask(task, today) {
  return {
    id: String(task._id),
    recommendationId: String(task.recommendationId),
    skill: task.skill,
    activity: task.activity,
    scheduledDate: task.scheduledDate,
    scheduledTime: task.scheduledTime,
    status: effectiveStatus(task, today),
    score: task.score ?? null,
    completedAt: task.completedAt || null,
  };
}

const byWhen = (a, b) => `${a.scheduledDate}T${a.scheduledTime}`.localeCompare(`${b.scheduledDate}T${b.scheduledTime}`);

// ── Overall care stage + care plan ─────────────────────────────────────────
// This is the OVERALL consultation/monitoring decision (separate from the
// per-domain recommendations above, and separate from the developmental
// band computed in the route handler below). The careStage/care-plan values
// come straight from predictionInfo — Step 5's stored-prediction-first
// design means predictionInfo is source: 'ml' when a compatible model was
// active at completion time, or 'rule_based' otherwise (no active model
// then, or a pre-Step-5 legacy record). IMPORTANT: this function must read
// predictionInfo.source rather than assuming 'ml' — a truthy predictionInfo
// is NOT the same thing as a real ML result, and mislabeling one as the
// other is exactly the "pretend a rule-based result is an ML prediction"
// mistake this whole feature exists to avoid.
function buildOverallCarePlan(resultDoc, predictionInfo) {
  if (predictionInfo && predictionInfo.careStage) {
    return {
      source: predictionInfo.source,
      careStage: predictionInfo.careStage,
      careStageLabel: predictionInfo.careStageLabel,
      riskCategory: predictionInfo.riskCategory,
      consultationLevel: predictionInfo.consultationLevel,
      monitoringLevel: predictionInfo.monitoringLevel,
    };
  }

  // Defensive fallback only — getPredictionForResult() always resolves to a
  // full care-stage object (stored, or rule-based-derived), so this branch
  // should be unreachable in practice.
  const careStage = staging.getCareStageFromScore(resultDoc.overallScore);
  const carePlan = staging.getCarePlanForCareStage(careStage);
  const definition = staging.getCareStageDefinition(careStage);
  return {
    source: 'rule_based',
    careStage,
    careStageLabel: definition ? definition.label : null,
    riskCategory: null,
    consultationLevel: carePlan ? carePlan.consultationLevel : null,
    monitoringLevel: carePlan ? carePlan.monitoringLevel : null,
  };
}

function clinicNameFor(pediatrician) {
  return pediatrician?.clinicName || pediatrician?.institution || null;
}

function clinicAddressFor(pediatrician) {
  return pediatrician?.clinicAddress || null;
}

function buildAssessmentContext(resultDoc) {
  const domains = [
    { key: 'communication', label: 'Communication', score: Number(resultDoc.communicationScore || 0), keywords: ['communication', 'speech', 'language', 'behavior', 'development'] },
    { key: 'social', label: 'Social Skills', score: Number(resultDoc.socialScore || 0), keywords: ['social', 'behavior', 'interaction', 'development'] },
    { key: 'cognitive', label: 'Cognitive', score: Number(resultDoc.cognitiveScore || 0), keywords: ['cognitive', 'development', 'learning', 'behavior', 'neuro'] },
    { key: 'motor', label: 'Motor Skills', score: Number(resultDoc.motorScore || 0), keywords: ['motor', 'occupational', 'physical', 'movement', 'development'] },
  ];

  // A focus area is any domain not in the top band.
  const focusAreas = domains
    .filter((d) => scoring.bandFor(d.score) !== scoring.BAND.ON_TRACK)
    .sort((a, b) => a.score - b.score);
  const consultationNeeded = focusAreas.length > 0;
  const urgent = focusAreas.some((d) => scoring.isRiskFlagged(d.score));

  let summary = 'You may continue monitoring your child while using the generated home activities.';
  if (consultationNeeded) {
    const areaNames = focusAreas.slice(0, 2).map((d) => d.label).join(' and ');
    summary = urgent
      ? `KinderCura suggests prioritizing clinic support for ${areaNames}.`
      : `A follow-up pediatric consultation may help support ${areaNames}.`;
  }

  return { focusAreas, consultationNeeded, urgent, summary };
}

function scorePediatricianForContext(pediatrician, context) {
  const hay = `${pediatrician.specialization || ''} ${pediatrician.clinicName || ''} ${pediatrician.institution || ''} ${pediatrician.bio || ''}`.toLowerCase();
  let score = 0;
  const reasons = [];

  for (const area of context.focusAreas) {
    if (area.keywords.some((kw) => hay.includes(kw))) {
      score += scoring.isRiskFlagged(area.score) ? 8 : 5;
      reasons.push(`${area.label} support match`);
    }
  }

  if (/pediatric|development|child/.test(hay)) {
    score += 2;
    reasons.push('child development care');
  }
  if (clinicNameFor(pediatrician)) score += 1;
  if (clinicAddressFor(pediatrician)) score += 1;
  if (pediatrician.consultationFee != null) score += 1;

  return {
    score,
    reason: reasons[0] || (context.consultationNeeded ? 'general pediatric follow-up' : 'active pediatrician'),
  };
}

async function buildSuggestedPediatricians(resultDoc) {
  const context = buildAssessmentContext(resultDoc);
  // Parent-facing suggestion list — demo/synthetic pediatricians are excluded
  // for the same reason as the booking list in routes/appointments.js: a
  // synthetic account has no usable password and could never answer a booking.
  // $ne:true rather than false, so real accounts predating the field still show.
  const pediatricians = await User.find({ role: 'pediatrician', status: 'active', isSynthetic: { $ne: true } })
    .select('firstName lastName specialization institution clinicName clinicAddress phoneNumber consultationFee profileIcon availability bio')
    .sort({ firstName: 1, lastName: 1 })
    .lean();

  const suggestions = pediatricians.map((p) => {
    const match = scorePediatricianForContext(p, context);
    return {
      id: String(p._id),
      firstName: p.firstName,
      lastName: p.lastName,
      specialization: p.specialization || null,
      institution: p.institution || null,
      clinicName: clinicNameFor(p),
      clinicAddress: clinicAddressFor(p),
      phoneNumber: p.phoneNumber || null,
      consultationFee: p.consultationFee ?? null,
      profileIcon: p.profileIcon || null,
      availability: {
        days: Array.isArray(p.availability?.days) ? p.availability.days : [],
        startTime: p.availability?.startTime || '09:00',
        endTime: p.availability?.endTime || '17:00',
        maxPatientsPerDay: p.availability?.maxPatientsPerDay ?? 10,
      },
      isSuggested: context.consultationNeeded ? match.score > 0 : false,
      matchScore: match.score,
      suggestedReason: match.reason,
    };
  }).sort((a, b) => (b.matchScore - a.matchScore) || `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));

  return {
    context: {
      consultationNeeded: context.consultationNeeded,
      urgent: context.urgent,
      focusAreas: context.focusAreas.map((a) => a.label),
      summary: context.summary,
    },
    pediatricians: suggestions,
  };
}

router.get('/:assessmentId', authMiddleware, async (req, res) => {
  // Includes each pediatrician's current consultation fee for display; never
  // let a browser/proxy cache serve a stale rate.
  res.setHeader('Cache-Control', 'no-store');
  try {
    const assessmentId = req.params.assessmentId;
    const assessment = await Assessment.findById(assessmentId).lean();
    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found.' });
    }

    // Every role is checked: the owning parent, a pediatrician with an
    // appointment for this child, an admin, or a guardian whose link grants
    // viewRecommendations. Previously only role 'parent' was checked.
    const child = await Child.findById(assessment.childId).lean();
    if (!child) {
      return res.status(404).json({ error: 'Child not found.' });
    }
    if (!await canViewChild(req.user, child, 'viewRecommendations')) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const resultDoc = await AssessmentResult.findOne({ assessmentId });
    if (!resultDoc) {
      return res.status(404).json({ error: 'Assessment results not found.' });
    }

    // Step 5: read the prediction already stored on this assessment result
    // (or, for a pre-Step-5 legacy record, derive a rule-based-only value —
    // never a fresh ML call here). Always resolves to a full object; check
    // `.source` to see whether it's really ML.
    const predictionInfo = getPredictionForResult(resultDoc);

    let recDocs = await Recommendation.find({ assessmentResultId: resultDoc._id }).sort({ generatedAt: 1 }).lean();
    if (!recDocs.length) {
      const generated = buildRecommendationSet(resultDoc, predictionInfo).map((r) => ({
        assessmentResultId: resultDoc._id,
        childId: resultDoc.childId,
        ...r,
      }));
      await Recommendation.insertMany(generated);
      recDocs = await Recommendation.find({ assessmentResultId: resultDoc._id }).sort({ generatedAt: 1 }).lean();
    }

    const today = clinicToday();
    const tasks = (await ActivitySchedule.find({ recommendationId: { $in: recDocs.map((r) => r._id) } }).lean())
      .map((t) => serializeTask(t, today))
      .sort(byWhen);

    const recommendations = recDocs.map((r) => ({
      id: String(r._id),
      assessmentResultId: String(r.assessmentResultId),
      childId: String(r.childId),
      skill: r.skill,
      priority: r.priority,
      suggestion: r.suggestion,
      activities: Array.isArray(r.activities) ? r.activities : [],
      completedActivities: completedActivityNames(r),
      scheduledTasks: tasks.filter((t) => t.recommendationId === String(r._id)),
      consultationNeeded: Boolean(r.consultationNeeded),
      generatedAt: r.generatedAt,
    }));

    const [suggested, bookedCount] = await Promise.all([
      buildSuggestedPediatricians(resultDoc),
      Appointment.countDocuments({
        childId: resultDoc.childId,
        status: { $in: ['pending', 'approved', 'completed'] },
      }),
    ]);

    // Overall care stage + consultation/monitoring plan, from the stored (or
    // legacy-fallback) predictionInfo. See buildOverallCarePlan().
    const overallCarePlan = buildOverallCarePlan(resultDoc, predictionInfo);

    // A. Developmental band — the SCORE classification, kept separate from
    // riskCategory (B, ML) and careStage (C, care-plan). Never persisted
    // (see models/AssessmentResult.js) — computed live from overallScore.
    const developmentalBand = staging.getDevelopmentalBandFromScore(resultDoc.overallScore);

    res.json({
      success: true,
      // Preserves the exact pre-Step-5 fallback chain: only a REAL ml-sourced
      // prediction overrides the domain-focus-area-based signal below.
      consultationNeeded: (predictionInfo && predictionInfo.source === 'ml')
        ? predictionInfo.consultationNeeded
        : suggested.context.consultationNeeded,
      urgent: suggested.context.urgent,
      focusAreas: suggested.context.focusAreas,
      suggestionSummary: suggested.context.summary,
      bookedConsultation: bookedCount > 0,
      suggestedPediatricians: suggested.pediatricians.slice(0, 5),
      recommendations,
      activityProgress: buildActivityProgress(recDocs),
      // A. Developmental band (score classification) — separate from B/C below.
      developmentalBand,
      // C. Overall care stage/care-plan for the frontend to eventually
      // surface (e.g. "Care Stage: Severe Concern", "Consultation:
      // required", "Monitoring: close_monitoring"). `source` tells the
      // caller whether this came from ML or the rule-based fallback — never
      // presented as ML when it isn't.
      overallCarePlan,
      // B + C. Historical prediction snapshot for this assessment (Step 5)
      // — the value actually stored at completion time, not a fresh
      // recomputation. riskCategory (B, ML) is kept distinct from careStage
      // (C, care-plan interpretation) — see models/AssessmentResult.js.
      // Never exposes the model's filesystem path.
      prediction: predictionInfo ? {
        source: predictionInfo.source,
        modelVersion: predictionInfo.modelVersion,
        riskCategory: predictionInfo.riskCategory,
        careStage: predictionInfo.careStage,
        careStageLabel: predictionInfo.careStageLabel,
        consultationLevel: predictionInfo.consultationLevel,
        monitoringLevel: predictionInfo.monitoringLevel,
        probabilities: predictionInfo.probabilities,
      } : null,
    });
  } catch (err) {
    console.error('recommendations load error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark one recommended home activity done (completed: true) or undo it
// (completed: false). Only the child's parent, or a guardian whose link grants
// viewRecommendations, may change it — pediatricians and admins can read the
// plan through GET but do not carry out home activities.
router.patch('/:recommendationId/activities', authMiddleware, async (req, res) => {
  try {
    const { recommendationId } = req.params;
    if (!mongoose.isValidObjectId(recommendationId)) {
      return res.status(400).json({ error: 'Invalid recommendation id.' });
    }
    const activity = typeof req.body?.activity === 'string' ? req.body.activity : '';
    const completed = req.body?.completed;
    if (!activity || typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'activity and completed (true or false) are required.' });
    }

    const rec = await Recommendation.findById(recommendationId).lean();
    if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });

    const child = await Child.findById(rec.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });
    if (!await canManageActivities(req.user, child)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (!Array.isArray(rec.activities) || !rec.activities.includes(activity)) {
      return res.status(400).json({ error: 'That activity is not part of this recommendation.' });
    }

    if (completed) {
      await markActivityDone(rec._id, activity, req.user.userId);
    } else {
      await Recommendation.updateOne({ _id: rec._id }, { $pull: { completedActivities: { activity } } });
    }

    res.json({
      success: true,
      recommendationId: String(rec._id),
      activity,
      completed,
      ...await activityState(rec),
    });
  } catch (err) {
    console.error('activity completion update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Schedule one session of a recommended activity: { activity, date, time }.
router.post('/:recommendationId/schedule', authMiddleware, async (req, res) => {
  try {
    const { recommendationId } = req.params;
    if (!mongoose.isValidObjectId(recommendationId)) {
      return res.status(400).json({ error: 'Invalid recommendation id.' });
    }
    const rec = await Recommendation.findById(recommendationId).lean();
    if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });
    const child = await Child.findById(rec.childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });
    if (!await canManageActivities(req.user, child)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const activity = typeof req.body?.activity === 'string' ? req.body.activity : '';
    if (!activity || !Array.isArray(rec.activities) || !rec.activities.includes(activity)) {
      return res.status(400).json({ error: 'That activity is not part of this recommendation.' });
    }
    const today = clinicToday();
    const { date, time } = req.body || {};
    const invalid = scheduleError(date, time, today);
    if (invalid) return res.status(400).json({ error: invalid });

    const result = await AssessmentResult.findById(rec.assessmentResultId).select('assessmentId').lean();
    const task = await ActivitySchedule.create({
      childId: child._id,
      recommendationId: rec._id,
      assessmentId: result?.assessmentId || null,
      skill: rec.skill,
      activity,
      scheduledDate: date,
      scheduledTime: time,
      createdBy: req.user.userId,
    });
    res.status(201).json({ success: true, task: serializeTask(task, today) });
  } catch (err) {
    console.error('activity schedule create error:', err);
    res.status(500).json({ error: 'Could not schedule the activity.' });
  }
});

// Loads a session the caller may manage; otherwise sends the error response
// and returns null.
async function loadOwnTask(req, res) {
  const { taskId } = req.params;
  if (!mongoose.isValidObjectId(taskId)) {
    res.status(400).json({ error: 'Invalid schedule id.' });
    return null;
  }
  const task = await ActivitySchedule.findById(taskId).lean();
  if (!task) {
    res.status(404).json({ error: 'Scheduled activity not found.' });
    return null;
  }
  const child = await Child.findById(task.childId).lean();
  if (!child) {
    res.status(404).json({ error: 'Child not found.' });
    return null;
  }
  if (!await canManageActivities(req.user, child)) {
    res.status(403).json({ error: 'Access denied.' });
    return null;
  }
  return task;
}

// Reschedule ({ date, time } puts it back to pending), or set the status
// ({ status: 'completed', score? }, 'missed' or 'pending').
router.patch('/schedule/:taskId', authMiddleware, async (req, res) => {
  try {
    const task = await loadOwnTask(req, res);
    if (!task) return;
    const today = clinicToday();
    const body = req.body || {};
    let set;

    if (body.date !== undefined || body.time !== undefined) {
      const date = body.date ?? task.scheduledDate;
      const time = body.time ?? task.scheduledTime;
      const invalid = scheduleError(date, time, today);
      if (invalid) return res.status(400).json({ error: invalid });
      set = { scheduledDate: date, scheduledTime: time, status: 'pending', score: null, completedAt: null };
    } else if (body.status === 'completed') {
      let score = null;
      if (body.score !== undefined && body.score !== null && body.score !== '') {
        score = Number(body.score);
        if (!Number.isInteger(score) || score < 0 || score > 100) {
          return res.status(400).json({ error: 'Score must be a whole number from 0 to 100.' });
        }
      }
      set = { status: 'completed', score, completedAt: new Date() };
    } else if (body.status === 'missed' || body.status === 'pending') {
      set = { status: body.status, score: null, completedAt: null };
    } else {
      return res.status(400).json({ error: 'Give a new date and time, or a status of pending, completed or missed.' });
    }

    const updated = await ActivitySchedule.findByIdAndUpdate(task._id, { $set: set }, { new: true, runValidators: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Scheduled activity not found.' });

    const response = { success: true, task: serializeTask(updated, today) };
    const rec = await Recommendation.findById(task.recommendationId).lean();
    if (rec) {
      // Completing a session also ticks the activity; nothing here ever unticks it.
      if (set.status === 'completed' && Array.isArray(rec.activities) && rec.activities.includes(task.activity)) {
        await markActivityDone(rec._id, task.activity, req.user.userId);
      }
      Object.assign(response, await activityState(rec));
    }
    res.json(response);
  } catch (err) {
    console.error('activity schedule update error:', err);
    res.status(500).json({ error: 'Could not update the scheduled activity.' });
  }
});

// Cancel a scheduled session.
router.delete('/schedule/:taskId', authMiddleware, async (req, res) => {
  try {
    const task = await loadOwnTask(req, res);
    if (!task) return;
    await ActivitySchedule.deleteOne({ _id: task._id });
    res.json({ success: true, id: String(task._id) });
  } catch (err) {
    console.error('activity schedule delete error:', err);
    res.status(500).json({ error: 'Could not cancel the scheduled activity.' });
  }
});

module.exports = router;

// Exposed for tests only (see tests/unit/recommendations-staging.test.js).
// Attaching to the router function is inert for Express — app.use() only
// ever calls it as a request handler, so this does not affect routing.
router.__testables = { buildOverallCarePlan, getPredictionForResult, buildActivityProgress, effectiveStatus, scheduleError };
