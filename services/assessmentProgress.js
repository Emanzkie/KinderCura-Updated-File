// services/assessmentProgress.js
// Purpose:
// - Compare a child's previous COMPLETED assessment against a current one.
// - This is an assessment-HISTORY comparison feature, not a diagnosis engine.
//   It answers "did the flagged CARE STAGE go up or down between two
//   screenings" — it never claims medical improvement/recovery, and it
//   never removes or overrides a pediatrician's judgement.
//
// Layering (kept identical to routes/recommendations.js — see that file for
// the fuller explanation):
//   1. ML PREDICTION        — classifies scores into a raw risk_category.
//   2. STAGING INTERPRETATION (constants/developmental-staging.js) — the
//      ONLY place a risk_category (or, as fallback, a developmental band)
//      becomes a CARE STAGE + care plan. This module never invents its own
//      thresholds.
//   3. THIS SERVICE          — reads what layer 2 decided for two different
//      assessments and reports the direction of change between them.
//
// Step 8: THREE SEPARATE CONCEPTS — do not conflate them anywhere in this
// file (this file previously called all three of these "stage"):
//   developmentalBand — a SCORE classification (constants/scoring.js).
//   riskCategory       — the ML classification ('Low'/'Medium'/'High').
//   careStage          — the CARE-PLAN classification derived from EITHER
//                         of the above (constants/developmental-staging.js
//                         CARE_STAGE.*).
//
// Historical reproducibility (Step 5): riskCategory/careStage IS persisted
// on AssessmentResult.prediction (see models/AssessmentResult.js), written
// once by buildPredictionForStorage() at assessment-completion time.
// Comparisons and recommendations read that stored snapshot back via
// getStoredOrDerivedCareStage() — they must NOT call
// getMLCareStage/getAssessmentCareStage again for an assessment that already
// has one. This fixes the gap Step 4 flagged: a July assessment stays
// reported exactly as it was in July even after a newer model becomes
// active and August gets scored differently. getMLCareStage/
// getAssessmentCareStage still exist, but are only meant to be called once,
// at completion time, to produce the value that then gets stored.
// developmentalBand is NEVER persisted — see models/AssessmentResult.js for
// why (it's fully derivable from the already-stored overallScore).

const path = require('path');

const Assessment = require('../models/Assessment');
const Child = require('../models/Child');
const TrainedModel = require('../models/TrainedModel');
const modelManager = require('../ml/model_manager');
const staging = require('../constants/developmental-staging');

/**
 * Query filter for the immediately preceding COMPLETED assessment: same
 * child, status 'complete' only (excludes in-progress/draft/abandoned),
 * excludes the current assessment itself, strictly before the anchor date.
 * Split out from getPreviousCompletedAssessment so the selection RULES can
 * be unit-tested without a live DB connection (Mongoose queries only
 * execute once awaited/exec'd).
 */
function buildPreviousAssessmentFilter(childId, currentAssessmentId, anchorDate) {
  return {
    childId,
    status: 'complete',
    _id: { $ne: currentAssessmentId },
    completedAt: { $lt: anchorDate },
  };
}

/**
 * Find the immediately preceding COMPLETED assessment for the same child.
 * Excludes the current assessment, excludes other children's assessments,
 * excludes anything not status: 'complete' (in-progress/draft/abandoned).
 *
 * @param {string|ObjectId} childId
 * @param {string|ObjectId} currentAssessmentId
 * @param {Date} anchorDate  usually the current assessment's completedAt
 * @returns {Promise<object|null>} lean Assessment document, or null
 */
async function getPreviousCompletedAssessment(childId, currentAssessmentId, anchorDate) {
  return Assessment.findOne(buildPreviousAssessmentFilter(childId, currentAssessmentId, anchorDate))
    .sort({ completedAt: -1 })
    .lean();
}

/**
 * Run the active, compatible ML model against an AssessmentResult's scores
 * and translate the resulting risk category into a care stage. Returns null
 * (never throws) when no active model exists, the active model is
 * incompatible with the current feature set (see ml/model_manager.js
 * isModelCompatible — guards the Step 2 gender_encoded removal), or
 * prediction fails for any reason.
 *
 * @param {object} resultDoc  AssessmentResult document (lean or hydrated)
 * @param {string|ObjectId} [childId]  used only to fetch age_months, if the
 *   active model was trained with it
 * @returns {Promise<object|null>}
 */
async function getMLCareStage(resultDoc, childId) {
  try {
    const activeModel = await TrainedModel.findOne({ isActive: true, status: 'completed' }).lean();
    if (!activeModel || !activeModel.modelPath) return null;

    if (!modelManager.isModelCompatible(activeModel)) {
      console.warn(`ML model v${activeModel.version} is incompatible with the current feature set — using rule-based fallback.`);
      return null;
    }

    let modelPath = activeModel.modelPath;
    if (!path.isAbsolute(modelPath)) modelPath = path.join(__dirname, '..', modelPath);
    modelPath = path.normalize(modelPath);

    const scores = {
      communication_score: resultDoc.communicationScore || 0,
      social_score: resultDoc.socialScore || 0,
      cognitive_score: resultDoc.cognitiveScore || 0,
      motor_score: resultDoc.motorScore || 0,
      overall_score: resultDoc.overallScore || 0,
    };

    if (childId) {
      try {
        const child = await Child.findById(childId).lean();
        if (child?.dateOfBirth) {
          const diffMs = Date.now() - new Date(child.dateOfBirth).getTime();
          scores.age_months = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.4375)));
        }
      } catch (childErr) {
        console.warn('Could not fetch child for ML care-stage lookup:', childErr.message);
      }
    }

    const prediction = await modelManager.predict(modelPath, scores);

    // B -> C: ML risk category -> care stage. The ONLY translation used here.
    const careStage = staging.getCareStageFromRiskCategory(prediction.risk_category);
    if (!careStage) {
      console.warn(`ML prediction returned an unrecognized risk_category "${prediction.risk_category}" — using rule-based fallback.`);
      return null;
    }
    const definition = staging.getCareStageDefinition(careStage);

    return {
      source: 'ml',
      riskCategory: prediction.risk_category,
      careStage: definition.careStage,
      careStageLabel: definition.label,
      consultationLevel: definition.consultationLevel,
      monitoringLevel: definition.monitoringLevel,
      consultationNeeded: prediction.consultation_needed,
      probabilities: prediction.probabilities,
      modelVersion: activeModel.version,
    };
  } catch (err) {
    console.warn('ML care-stage lookup fallback — using rule-based:', err.message);
    return null;
  }
}

/**
 * Rule-based care stage via the developmental-band -> care-stage fallback
 * mapping (A -> C; used only when no compatible ML model is available).
 * riskCategory is always null here — no ML was involved. Never null itself.
 */
function getRuleBasedCareStage(resultDoc) {
  const careStage = staging.getCareStageFromScore(resultDoc.overallScore);
  const definition = staging.getCareStageDefinition(careStage);
  const carePlan = staging.getCarePlanForCareStage(careStage);
  return {
    source: 'rule_based',
    riskCategory: null,
    careStage,
    careStageLabel: definition ? definition.label : null,
    consultationLevel: carePlan ? carePlan.consultationLevel : null,
    monitoringLevel: carePlan ? carePlan.monitoringLevel : null,
    consultationNeeded: null,
    probabilities: null,
    modelVersion: null,
  };
}

/**
 * Care stage for one AssessmentResult: ML when a compatible active model
 * produces a usable result, rule-based (developmental-band) fallback
 * otherwise. ALWAYS resolves to an object (unlike getMLCareStage, which can
 * be null) — the `source` field tells the caller which path produced it, so
 * a fallback is never mistaken for a real ML result.
 *
 * Used ONLY to generate a FRESH prediction (i.e. at assessment-completion
 * time, by buildPredictionForStorage). Once a prediction is persisted on an
 * AssessmentResult, every later read must go through
 * getStoredOrDerivedCareStage instead — this function must not be called
 * again for an assessment that already has a stored prediction (see module
 * docstring on historical reproducibility).
 *
 * @param {object} resultDoc  AssessmentResult document
 * @param {string|ObjectId} [childId]
 */
async function getAssessmentCareStage(resultDoc, childId) {
  const mlCareStage = await getMLCareStage(resultDoc, childId);
  return mlCareStage || getRuleBasedCareStage(resultDoc);
}

/** consultationNeeded is derivable from consultationLevel and is NOT persisted (see buildPredictionForStorage) — fill it in for callers that still expect it (routes/recommendations.js domain-level logic). */
function withConsultationNeeded(careStageInfo) {
  if (!careStageInfo) return careStageInfo;
  if (careStageInfo.consultationNeeded != null) return careStageInfo;
  const lowConcernLevel = staging.CARE_STAGE_DEFINITIONS[staging.CARE_STAGE.LOW_CONCERN].consultationLevel;
  return { ...careStageInfo, consultationNeeded: careStageInfo.consultationLevel !== lowConcernLevel };
}

/**
 * Generate the prediction record to PERSIST on a newly completed
 * AssessmentResult. This is the ONLY place a fresh prediction is computed
 * for storage — called once, at assessment-completion time
 * (routes/assessments.js POST /submit). After this, comparisons and
 * recommendations must read the stored value back
 * (getStoredOrDerivedCareStage) rather than recomputing it, which is what
 * makes an already-completed assessment's reported care stage stable even
 * after a newer model is trained.
 *
 * Never throws and never returns a partially-filled object — either the
 * full ML-sourced record or the full rule-based record, never a mix (see
 * Step 5 data-integrity requirement: no "source: ml, riskCategory: null").
 *
 * @param {{communicationScore:number, socialScore:number, cognitiveScore:number, motorScore:number, overallScore:number}} scores
 * @param {string|ObjectId} childId
 * @returns {Promise<object>} shaped exactly like AssessmentResult.prediction
 */
async function buildPredictionForStorage(scores, childId) {
  try {
    const careStageInfo = await getAssessmentCareStage(scores, childId);
    return {
      source: careStageInfo.source,
      modelVersion: careStageInfo.modelVersion,
      riskCategory: careStageInfo.riskCategory,
      careStage: careStageInfo.careStage,
      careStageLabel: careStageInfo.careStageLabel,
      consultationLevel: careStageInfo.consultationLevel,
      monitoringLevel: careStageInfo.monitoringLevel,
      probabilities: careStageInfo.probabilities,
      generatedAt: new Date(),
    };
  } catch (err) {
    // getMLCareStage/getAssessmentCareStage already catch ML errors
    // internally and fall back to rule-based, so this branch should be
    // unreachable in practice. It exists so assessment completion can NEVER
    // fail because of prediction generation (Step 5 requirement).
    console.error('Unexpected error building prediction record — saving minimal rule-based fallback:', err.message);
    const careStage = staging.getCareStageFromScore(scores?.overallScore ?? 0);
    const definition = staging.getCareStageDefinition(careStage);
    const carePlan = staging.getCarePlanForCareStage(careStage);
    return {
      source: 'rule_based',
      modelVersion: null,
      riskCategory: null,
      careStage,
      careStageLabel: definition ? definition.label : null,
      consultationLevel: carePlan ? carePlan.consultationLevel : null,
      monitoringLevel: carePlan ? carePlan.monitoringLevel : null,
      probabilities: null,
      generatedAt: new Date(),
    };
  }
}

/**
 * Read the historical prediction already stored on an AssessmentResult.
 * Falls back to a RULE-BASED-ONLY derivation when nothing was stored (or
 * the stored record predates Step 8's field rename) — this only happens for
 * records that predate Step 5. Deliberately does NOT attempt a live ML
 * prediction in that case: running today's active model over an old
 * assessment and labeling the result "ml" would misrepresent history (the
 * assessment never actually had an ML read at submission time).
 * Synchronous — reading a stored value, or computing the rule-based band
 * from a score, needs no I/O and never calls into ML.
 *
 * IMPORTANT: fields are read by explicit name, not `{ ...resultDoc.prediction }`.
 * routes/recommendations.js fetches AssessmentResult WITHOUT .lean() (it
 * needs a hydrated document elsewhere), and spreading a Mongoose subdocument
 * does not copy its schema fields as own-enumerable properties — it silently
 * produces an object with none of the real values. Named access via Mongoose
 * getters works correctly on both lean and hydrated documents; spread does not.
 *
 * @param {object} resultDoc  AssessmentResult document (lean or hydrated)
 * @returns {object} care-stage info, always with an accurate `source`
 */
function getStoredOrDerivedCareStage(resultDoc) {
  const stored = resultDoc?.prediction;
  if (stored && stored.source && stored.careStage) {
    return withConsultationNeeded({
      source: stored.source,
      modelVersion: stored.modelVersion,
      riskCategory: stored.riskCategory,
      careStage: stored.careStage,
      careStageLabel: stored.careStageLabel,
      consultationLevel: stored.consultationLevel,
      monitoringLevel: stored.monitoringLevel,
      probabilities: stored.probabilities,
    });
  }
  return withConsultationNeeded(getRuleBasedCareStage(resultDoc));
}

/**
 * Classify the direction of CARE-PLAN progression between a previous and
 * current care-stage lookup (as returned by getAssessmentCareStage /
 * getStoredOrDerivedCareStage). `previousCareStageInfo === null` means
 * there is no previous completed assessment at all — reported as
 * "unavailable" with reason "first_assessment", never as "improved" or
 * "worsened".
 *
 * @param {object|null} previousCareStageInfo
 * @param {object|null} currentCareStageInfo
 */
function compareAssessmentProgress(previousCareStageInfo, currentCareStageInfo) {
  if (!previousCareStageInfo) {
    return {
      direction: 'unavailable',
      reason: 'first_assessment',
      previousRank: null,
      currentRank: currentCareStageInfo ? staging.getCareStageRank(currentCareStageInfo.careStage) : null,
    };
  }
  if (!currentCareStageInfo) {
    return { direction: 'unavailable', reason: 'current_care_stage_unavailable', previousRank: staging.getCareStageRank(previousCareStageInfo.careStage), currentRank: null };
  }
  const result = staging.compareCareStages(previousCareStageInfo.careStage, currentCareStageInfo.careStage);
  return {
    direction: result.direction,
    previousRank: result.previousRank,
    currentRank: result.currentRank,
  };
}

const SCORE_FIELDS = [
  { key: 'communication', field: 'communicationScore', label: 'Communication' },
  { key: 'social', field: 'socialScore', label: 'Social Skills' },
  { key: 'cognitive', field: 'cognitiveScore', label: 'Cognitive' },
  { key: 'motor', field: 'motorScore', label: 'Motor Skills' },
  { key: 'overall', field: 'overallScore', label: 'Overall' },
];

/** Per-domain (+ overall) previous/current/difference table. Never recomputes scores — only diffs values already stored on the two AssessmentResult documents. */
function buildScoreChanges(currentResult, previousResult) {
  const scores = {};
  for (const d of SCORE_FIELDS) {
    const current = currentResult ? (currentResult[d.field] ?? null) : null;
    const previous = previousResult ? (previousResult[d.field] ?? null) : null;
    scores[d.key] = {
      label: d.label,
      current: current != null ? Math.round(current) : null,
      previous: previous != null ? Math.round(previous) : null,
      difference: (current != null && previous != null) ? Math.round(current) - Math.round(previous) : null,
    };
  }
  return scores;
}

/**
 * Assemble the full reassessment comparison payload for a completed current
 * assessment (and, when one exists, its immediately preceding completed
 * assessment). This is the single function routes should call — it does not
 * duplicate care-stage/ordering logic, only orchestrates the pieces above.
 *
 * Reads each side's STORED prediction (getStoredOrDerivedCareStage) rather
 * than running ML again — this is the fix for the historical-reproducibility
 * gap Step 4 identified: a July assessment stays whatever it was reported
 * as in July even after a newer model becomes active for August's
 * assessment. developmentalBand (the SCORE classification — separate from
 * riskCategory and careStage, Step 8) is computed live from each side's
 * overallScore since it is never persisted.
 *
 * @param {object} currentAssessment  Assessment document
 * @param {object} currentResult      AssessmentResult document
 * @param {object|null} previousAssessment  Assessment document, or null
 * @param {object|null} previousResult      AssessmentResult document, or null
 */
async function buildAssessmentProgressSummary(currentAssessment, currentResult, previousAssessment, previousResult) {
  const currentCareStageInfo = getStoredOrDerivedCareStage(currentResult);
  const previousCareStageInfo = (previousAssessment && previousResult)
    ? getStoredOrDerivedCareStage(previousResult)
    : null;

  const comparison = compareAssessmentProgress(previousCareStageInfo, currentCareStageInfo);

  return {
    current: {
      assessmentId: String(currentAssessment._id),
      date: currentAssessment.completedAt || currentAssessment.startedAt,
      developmentalBand: staging.getDevelopmentalBandFromScore(currentResult.overallScore),
      ...currentCareStageInfo,
    },
    previous: (previousAssessment && previousResult) ? {
      assessmentId: String(previousAssessment._id),
      date: previousAssessment.completedAt || previousAssessment.startedAt,
      developmentalBand: staging.getDevelopmentalBandFromScore(previousResult.overallScore),
      ...previousCareStageInfo,
    } : null,
    comparison,
    scores: buildScoreChanges(currentResult, previousResult),
  };
}

module.exports = {
  buildPreviousAssessmentFilter,
  getPreviousCompletedAssessment,
  getMLCareStage,
  getRuleBasedCareStage,
  getAssessmentCareStage,
  buildPredictionForStorage,
  getStoredOrDerivedCareStage,
  compareAssessmentProgress,
  buildScoreChanges,
  buildAssessmentProgressSummary,
};
