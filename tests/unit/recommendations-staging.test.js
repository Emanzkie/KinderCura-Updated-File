// Unit tests for Step 3 (wiring)/Step 8 (concept separation): wiring
// constants/developmental-staging.js into the ML prediction + recommendation
// flow (routes/ml.js, routes/recommendations.js, ml/model_manager.js). No DB
// required — exercises the pure helper functions.
const assert = require('assert');
const recommendationsRouter = require('../../routes/recommendations');
const { buildOverallCarePlan } = recommendationsRouter.__testables;
const staging = require('../../constants/developmental-staging');
const modelManager = require('../../ml/model_manager');

function run() {
  // A. Low ML prediction -> LOW_CONCERN care stage, as_needed consultation, parent monitoring.
  const lowMl = {
    source: 'ml',
    riskCategory: 'Low',
    consultationNeeded: false,
    careStage: staging.CARE_STAGE.LOW_CONCERN,
    careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.LOW_CONCERN).label,
    consultationLevel: 'as_needed',
    monitoringLevel: 'parent_monitoring',
  };
  const planLow = buildOverallCarePlan({ overallScore: 90 }, lowMl);
  assert.strictEqual(planLow.source, 'ml');
  assert.strictEqual(planLow.careStage, staging.CARE_STAGE.LOW_CONCERN);
  assert.strictEqual(planLow.consultationLevel, 'as_needed');
  assert.strictEqual(planLow.monitoringLevel, 'parent_monitoring');
  assert.strictEqual(planLow.riskCategory, 'Low');

  // B. Medium ML prediction -> INTERMEDIATE care stage, scheduled consultation, continued monitoring.
  const mediumMl = {
    source: 'ml',
    riskCategory: 'Medium',
    consultationNeeded: true,
    careStage: staging.CARE_STAGE.INTERMEDIATE,
    careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.INTERMEDIATE).label,
    consultationLevel: 'scheduled',
    monitoringLevel: 'continued_parent_monitoring',
  };
  const planMedium = buildOverallCarePlan({ overallScore: 50 }, mediumMl);
  assert.strictEqual(planMedium.source, 'ml');
  assert.strictEqual(planMedium.careStage, staging.CARE_STAGE.INTERMEDIATE);
  assert.strictEqual(planMedium.consultationLevel, 'scheduled');
  assert.strictEqual(planMedium.monitoringLevel, 'continued_parent_monitoring');

  // C. High ML prediction -> SEVERE care stage, required consultation, close monitoring.
  const highMl = {
    source: 'ml',
    riskCategory: 'High',
    consultationNeeded: true,
    careStage: staging.CARE_STAGE.SEVERE,
    careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.SEVERE).label,
    consultationLevel: 'required',
    monitoringLevel: 'close_monitoring',
  };
  const planHigh = buildOverallCarePlan({ overallScore: 20 }, highMl);
  assert.strictEqual(planHigh.source, 'ml');
  assert.strictEqual(planHigh.careStage, staging.CARE_STAGE.SEVERE);
  assert.strictEqual(planHigh.consultationLevel, 'required');
  assert.strictEqual(planHigh.monitoringLevel, 'close_monitoring');

  // D. The route's overall care plan passes the centralized care-stage data
  // straight through rather than re-deriving it — proven by the fact the
  // three cases above reproduce exactly what constants/developmental-staging.js
  // defines for Low/Medium/High, with no separate mapping inside routes/recommendations.js.
  assert.deepStrictEqual(
    { low: planLow.careStage, medium: planMedium.careStage, high: planHigh.careStage },
    { low: 'low_concern', medium: 'intermediate', high: 'severe' }
  );

  // E. No active ML model -> rule-based legacy fallback still works, and is
  // explicitly marked 'rule_based' so it is never mistaken for an ML result.
  // Uses the fallback (developmental-band-based) path, not a re-derived
  // Low/Medium/High mapping.
  const planFallback = buildOverallCarePlan({ overallScore: 85 }, null);
  assert.strictEqual(planFallback.source, 'rule_based');
  assert.strictEqual(planFallback.riskCategory, null);
  assert.strictEqual(planFallback.careStage, staging.getCareStageFromScore(85));
  assert.strictEqual(
    planFallback.consultationLevel,
    staging.getCarePlanForCareStage(staging.getCareStageFromScore(85)).consultationLevel
  );

  // F. An old/incompatible model (trained with gender_encoded, per Step 2)
  // is detected before prediction is ever attempted, so the recommendation
  // endpoint can fall back safely instead of crashing or mispredicting.
  assert.strictEqual(
    modelManager.isModelCompatible({ featuresUsed: ['communication_score', 'gender_encoded'] }),
    false
  );
  assert.strictEqual(
    modelManager.isModelCompatible({ featuresUsed: ['communication_score', 'age_months'] }),
    true
  );
  assert.strictEqual(modelManager.isModelCompatible({ featuresUsed: [] }), true);
  assert.strictEqual(modelManager.isModelCompatible({}), true); // no featuresUsed recorded — assume compatible

  // G. Step 5 regression (re-affirmed Step 8): a TRUTHY predictionInfo whose
  // real source is rule_based (e.g. a stored historical prediction from an
  // assessment that had no active model at completion time) must be
  // reported as 'rule_based', never hardcoded to 'ml' just because it has a
  // `.careStage`.
  const storedRuleBased = {
    source: 'rule_based',
    riskCategory: null,
    careStage: staging.CARE_STAGE.INTERMEDIATE,
    careStageLabel: staging.getCareStageDefinition(staging.CARE_STAGE.INTERMEDIATE).label,
    consultationLevel: 'scheduled',
    monitoringLevel: 'continued_parent_monitoring',
  };
  const planStoredRuleBased = buildOverallCarePlan({ overallScore: 50 }, storedRuleBased);
  assert.strictEqual(planStoredRuleBased.source, 'rule_based');
  assert.strictEqual(planStoredRuleBased.careStage, staging.CARE_STAGE.INTERMEDIATE);

  // H. Step 8 example A: overall score 65 -> developmentalBand 'developing'
  // (constants/scoring.js), independent of whatever the ML riskCategory/
  // careStage says for the same assessment. The two vocabularies must not
  // collapse into one value just because they're "usually" related.
  const developmentalBand65 = staging.getDevelopmentalBandFromScore(65);
  assert.strictEqual(developmentalBand65, 'developing');
  const carePlanForMedium = buildOverallCarePlan({ overallScore: 65 }, mediumMl);
  assert.strictEqual(carePlanForMedium.careStage, 'intermediate');
  // Same assessment, two different classifications, neither one renamed to
  // match the other.
  assert.notStrictEqual(developmentalBand65, carePlanForMedium.careStage);

  console.log('Recommendation staging wiring OK');
}

run();
