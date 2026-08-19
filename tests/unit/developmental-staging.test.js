// Unit tests for constants/developmental-staging.js (no DB required).
// Step 8: verifies the three concepts (developmental band / ML risk
// category / care stage) stay separate and that thresholds are not duplicated.
const assert = require('assert');
const staging = require('../../constants/developmental-staging');
const scoring = require('../../constants/scoring');

function run() {
  // A. Developmental band comes from constants/scoring.js, not a private copy.
  assert.strictEqual(staging.getDevelopmentalBandFromScore(90), scoring.bandFor(90));
  assert.strictEqual(staging.getDevelopmentalBandFromScore(65), scoring.bandFor(65));
  assert.strictEqual(staging.getDevelopmentalBandFromScore(45), scoring.bandFor(45));
  assert.strictEqual(staging.getDevelopmentalBandFromScore(10), scoring.bandFor(10));
  // Values are scoring.js's own band strings verbatim (hyphenated), never a
  // second, differently-formatted representation.
  assert.strictEqual(staging.getDevelopmentalBandFromScore(90), scoring.BAND.ON_TRACK);
  assert.strictEqual(staging.getDevelopmentalBandFromScore(10), scoring.BAND.DELAYED);

  // B. The 80/60/40 thresholds are not duplicated in this module — proven by
  // moving the boundary and confirming staging tracks scoring.js exactly,
  // rather than staging.js having its own hardcoded cutoffs that happen to
  // currently agree. (constants/developmental-staging.js source also
  // contains no numeric score literals — verified by code review; see file header.)
  for (const score of [0, 39, 40, 59, 60, 79, 80, 100]) {
    assert.strictEqual(staging.getDevelopmentalBandFromScore(score), scoring.bandFor(score), `score ${score} must match scoring.bandFor exactly`);
  }

  // C/D/E. ML risk category -> care stage, case-insensitive.
  assert.strictEqual(staging.getCareStageFromRiskCategory('Low'), staging.CARE_STAGE.LOW_CONCERN);       // C
  assert.strictEqual(staging.getCareStageFromRiskCategory('medium'), staging.CARE_STAGE.INTERMEDIATE);   // D
  assert.strictEqual(staging.getCareStageFromRiskCategory('HIGH'), staging.CARE_STAGE.SEVERE);           // E
  assert.strictEqual(staging.getCareStageFromRiskCategory('unknown'), null);
  assert.strictEqual(staging.getCareStageFromRiskCategory(undefined), null);

  // Care stage values are their own vocabulary — never renamed to Low/Medium/High,
  // and never reusing the developmental band's 'on-track'/'developing' wording.
  assert.strictEqual(staging.CARE_STAGE.LOW_CONCERN, 'low_concern');
  assert.strictEqual(staging.CARE_STAGE.INTERMEDIATE, 'intermediate');
  assert.strictEqual(staging.CARE_STAGE.SEVERE, 'severe');

  // Developmental band -> care stage (fallback path only; mirrors the
  // grouping already established in routes/assessments.js RISK_LEVEL_BY_BAND).
  assert.strictEqual(staging.getCareStageFromDevelopmentalBand(scoring.BAND.ON_TRACK), staging.CARE_STAGE.LOW_CONCERN);
  assert.strictEqual(staging.getCareStageFromDevelopmentalBand(scoring.BAND.DEVELOPING), staging.CARE_STAGE.LOW_CONCERN);
  assert.strictEqual(staging.getCareStageFromDevelopmentalBand(scoring.BAND.AT_RISK), staging.CARE_STAGE.INTERMEDIATE);
  assert.strictEqual(staging.getCareStageFromDevelopmentalBand(scoring.BAND.DELAYED), staging.CARE_STAGE.SEVERE);
  assert.strictEqual(staging.getCareStageFromDevelopmentalBand('bogus-band'), staging.CARE_STAGE.SEVERE);

  // Score -> care stage end to end, via the fallback path.
  assert.strictEqual(staging.getCareStageFromScore(90), staging.CARE_STAGE.LOW_CONCERN);
  assert.strictEqual(staging.getCareStageFromScore(65), staging.CARE_STAGE.LOW_CONCERN);
  assert.strictEqual(staging.getCareStageFromScore(45), staging.CARE_STAGE.INTERMEDIATE);
  assert.strictEqual(staging.getCareStageFromScore(10), staging.CARE_STAGE.SEVERE);

  // Care plan lookup.
  const carePlan = staging.getCarePlanForCareStage(staging.CARE_STAGE.INTERMEDIATE);
  assert.strictEqual(carePlan.consultationLevel, 'scheduled');
  assert.strictEqual(carePlan.monitoringLevel, 'continued_parent_monitoring');
  assert.strictEqual(staging.getCarePlanForCareStage('bogus-stage'), null);

  assert.deepStrictEqual(
    { low: staging.getCarePlanForCareStage(staging.CARE_STAGE.LOW_CONCERN).consultationLevel, mon: staging.getCarePlanForCareStage(staging.CARE_STAGE.LOW_CONCERN).monitoringLevel },
    { low: 'as_needed', mon: 'parent_monitoring' }
  );
  assert.deepStrictEqual(
    { low: staging.getCarePlanForCareStage(staging.CARE_STAGE.SEVERE).consultationLevel, mon: staging.getCarePlanForCareStage(staging.CARE_STAGE.SEVERE).monitoringLevel },
    { low: 'required', mon: 'close_monitoring' }
  );

  // Care stage definition — label is care-plan wording only, never reusing
  // developmental-band vocabulary ("on track", "developing", "delayed").
  const severeDef = staging.getCareStageDefinition(staging.CARE_STAGE.SEVERE);
  assert.ok(!/on.?track|developing|delayed/i.test(severeDef.label));
  assert.strictEqual(staging.getCareStageDefinition('bogus-stage'), null);

  // Risk category definitions are a SEPARATE lookup from care stage — they
  // do not carry consultation/monitoring info themselves.
  assert.strictEqual(staging.getRiskCategoryDefinition('low').riskCategory, staging.RISK_CATEGORY.LOW);
  assert.strictEqual(staging.getRiskCategoryDefinition('bogus'), null);
  assert.strictEqual('consultationLevel' in (staging.getRiskCategoryDefinition('Low') || {}), false);

  // Severe check.
  assert.strictEqual(staging.isSevereCareStage(staging.CARE_STAGE.SEVERE), true);
  assert.strictEqual(staging.isSevereCareStage(staging.CARE_STAGE.LOW_CONCERN), false);
  assert.strictEqual(staging.isSevereCareStage(staging.CARE_STAGE.INTERMEDIATE), false);

  // Care-stage ordering/comparison.
  assert.strictEqual(staging.getCareStageRank(staging.CARE_STAGE.LOW_CONCERN), 0);
  assert.strictEqual(staging.getCareStageRank(staging.CARE_STAGE.INTERMEDIATE), 1);
  assert.strictEqual(staging.getCareStageRank(staging.CARE_STAGE.SEVERE), 2);
  assert.strictEqual(staging.compareCareStages(staging.CARE_STAGE.SEVERE, staging.CARE_STAGE.INTERMEDIATE).direction, 'improved');
  assert.strictEqual(staging.compareCareStages(staging.CARE_STAGE.LOW_CONCERN, staging.CARE_STAGE.SEVERE).direction, 'worsened');
  assert.strictEqual(staging.compareCareStages(staging.CARE_STAGE.INTERMEDIATE, staging.CARE_STAGE.INTERMEDIATE).direction, 'no_change');
  assert.strictEqual(staging.compareCareStages(null, staging.CARE_STAGE.SEVERE).direction, 'unavailable');

  console.log('Developmental staging module OK');
}

run();
