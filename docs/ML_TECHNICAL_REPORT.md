# KinderCura ML Technical Report

**Inspected:** 31 Oct 2026, at commit `fc55201` (main), plus read-only queries against the shared Atlas database.
**Scope:** what the code and the stored records show today. Nothing here was changed to produce the report, and no weight, formula or model behaviour is described unless a file or a database record shows it. Anything that could not be verified is marked **Not verified**.

---

## 1. Existing implementation

KinderCura classifies each completed screening in three separate layers that must not be confused (`services/assessmentProgress.js:19-25`, `routes/recommendations.js:23-34`):

| Layer | What it is | Decided by | Stored? |
|---|---|---|---|
| A. **Developmental Band** | Rule-based score band: On-Track / Developing / At-Risk / Delayed | `constants/scoring.js` (`bandFor`) on `overallScore` | No, recomputed from `overallScore` |
| B. **Developmental Risk Category** | Random Forest output: Low / Medium / High (shown to people as Low / **Moderate** / High) | `ml/predict.py` with the active `TrainedModel` | Yes: `AssessmentResult.prediction` |
| C. **Care Stage** | Low / Intermediate / Severe Concern, plus consultation and monitoring levels | `constants/developmental-staging.js` from B or, when no ML result exists, from A | Yes: inside `prediction` |

Pipeline at assessment submission (`routes/assessments.js` POST `/submit`):

```
parent answers (yes / sometimes / no)
  → domain % scores and overall %             routes/assessments.js:902-1061
  → buildPredictionForStorage(scores, childId, core answers)   :1076-1083
      → active TrainedModel (isActive, completed)   services/assessmentProgress.js:114
      → inputs: 5 scores + age_months (+ Q01–Q34 for a question-based model)  :124-151
      → modelManager.predict(...)  → ml/predict.py (local Python, or the Vercel function /api/py/predict)
      → risk_category → care stage                   constants/developmental-staging.js:141-145
      → on ANY failure: rule-based care stage from the band, riskCategory = null,
        and the reason kept in mlUnavailableReason   services/assessmentProgress.js:105-110,187-202
  → AssessmentResult saved with `prediction` (written once, never recomputed)  :1085-1108
```

Every later page (Results, Recommendations, pediatrician views, reassessment comparison) reads the stored `prediction` back through `getStoredOrDerivedCareStage` (`services/assessmentProgress.js:315-331`). A model trained later never rewrites an older assessment.

**Training** (`ml/trainer.py`) is started from Admin → Training. It produces a `.joblib` artifact (classifier, label encoder, feature list), stored in R2 object storage in production (`ml/model_manager.js:759-777`). It also creates a `TrainedModel` record with metrics and feature importances. An admin must activate a model before it is used.

---

## 2. Training features and target

### Q1. Are Age, Communication, Cognitive, Motor and Social included?

**Yes, all five, in the active model.**

| Model | Feature set | Features (from `TrainedModel.featuresUsed` in the DB) |
|---|---|---|
| **v5 (active)** | score_based | `communication_score`, `social_score`, `cognitive_score`, `motor_score`, `overall_score`, `age_months` |
| v4, v3, v2 | score_based | same six |
| v1 | score_based (pre-Step-15) | same six + `gender_encoded` (gender was later removed, `ml/trainer.py:69-78`) |

- Code: `REQUIRED_SCORE_COLUMNS` (`ml/trainer.py:61-67`) is always used; `age_months` is optional and is added only when the dataset has it (`ml/trainer.py:79, 264-268`).
- A second feature set, **question_based** (Q01–Q34 item answers plus age), exists in code (`ml/trainer.py:107-117, 301-377`). No question-based model has been trained or activated (all five models in the DB are score-based).
- Note: `overall_score` is itself the average of the four domain scores (see §4), so it is a **derived, collinear feature**, not independent information.

### Q2. What target does the Random Forest predict?

`risk_category`, one of **Low / Medium / High** (`ml/trainer.py:81-83`). It is decoded by the stored label encoder in `ml/predict.py:118-122`. `consultation_needed` is set to true for Medium or High (`ml/predict.py:125`).

**Where the labels come from:** the trainer refuses to derive labels from scores (`ml/trainer.py:9-18, 190-198`). The active model v5 was trained on the dataset record **"KinderCura Synthetic Training Dataset V2"**:
- 50,000 rows;
- `provenance.sourceType: synthetic`;
- the dataset's own note reads "Not clinically validated".

That file comes from `ml/datasets/generate_kindercura_dataset.py` (command in `ml/datasets/README.md:186-192`):
1. Each row's class (Low / Medium / High) is chosen **first, uniformly at random** (`:187`).
2. Every administered question is answered from a class-specific probability table that **overlaps** between classes (`ANSWER_PROBS`, `:93-97`):

   | Class | Yes | Sometimes | No |
   |---|---|---|---|
   | Low | 0.62 | 0.24 | 0.14 |
   | Medium | 0.40 | 0.34 | 0.26 |
   | High | 0.22 | 0.30 | 0.48 |

3. Scores are computed with the app's own formula (`:213-217`).
4. **18 % of labels are then moved to a neighbouring class** (`LABEL_NOISE_RATE`, `:99-100, 222-224`).

The labels are therefore **simulated, not clinical outcomes**.

### Model configuration and results (v5)

| Item | Value | Source |
|---|---|---|
| Algorithm | `RandomForestClassifier`, 100 trees, `max_leaf_nodes=256`, `class_weight="balanced"`, `random_state=42` | `ml/trainer.py:418-426` |
| Split | Stratified 80 / 20 (`random_state=42`) | `ml/trainer.py:408-415` |
| Training / test rows | 40,000 / 10,000 | `TrainedModel` v5 |
| Class balance | Medium 19,657 · High 15,222 · Low 15,121 | `TrainedModel.classDistribution` |
| Accuracy | 0.697 | `TrainedModel` v5 |
| Weighted F1 | 0.689 | `TrainedModel` v5 |
| Metrics | Test split only; weighted precision, recall and F1, plus a confusion matrix | `ml/trainer.py:430-444` |

---

## 3. Age-related developmental expectations

### Q3. Are age-related expectations considered?

**Partly.** Age is used in two ways, and two others are missing:

| Mechanism | Present? | Where |
|---|---|---|
| **Age-gated questions:** each of the 34 core questions has a minimum age (36, 42, 48, 60, 72 or 84 months). A child is only asked, and is only required to answer, the questions for their age. | Yes | `js/parent/screening.js` `DOCTOR_QUESTION_BANK` (`minAgeMonths`); `routes/assessments.js:47-52` |
| **Age as an ML feature:** `age_months` is computed from the date of birth at submission and given to the model. | Yes | `services/assessmentProgress.js:141-151`; `ml/trainer.py:264-268` |
| **Age-normed scoring:** scores compared against what is expected for the child's age (e.g. percentile or z-score by age band). | **No** | A domain % is earned points ÷ points possible on the *administered* questions (`routes/assessments.js:1057-1060`). The same 80 / 60 / 40 cutoffs apply at every age (`constants/scoring.js:69-74`). |
| **Age-dependent labels in the training data** | **No** | In the default generator process (used for v5) the class is drawn independently of age (`generate_kindercura_dataset.py:187-188, 204`). The model has no age-specific pattern to learn, which matches the low importance of `age_months` in v5 (0.031). The age-aware process added on 31 Oct 2026 addresses this (§10). |

Age also selects the screening group label (Preschool 3–5, Early School Age 6–8; `routes/assessments.js:123-132`). That is a label only; it does not change scoring.

---

## 4. Domain scoring weights and overall formula

### Q4. What are the actual weights and formula?

| Step | Rule | Source |
|---|---|---|
| Answer points | yes = 2, sometimes = 1, no (or anything else) = 0 | `routes/assessments.js:139-144` |
| What counts in a domain | Core-bank answers, active Dataset Question answers, and yes / no custom questions in a scored domain, each out of 2 points | `routes/assessments.js:912-929, 1018-1031` |
| Domain score | `round(earned ÷ total × 100)` for each of Communication, Social Skills, Cognitive and Motor Skills | `routes/assessments.js:1057-1060` |
| **Overall score** | `round((communication + social + cognitive + motor) ÷ 4)` | `routes/assessments.js:1061` |
| Developmental Band | On-Track 80–100, Developing 60–79, At-Risk 40–59, Delayed 0–39 | `constants/scoring.js:69-74` |
| Domain risk flag | Domain score below 40 | `constants/scoring.js:140, 193-195`; `routes/assessments.js:1063-1067` |
| Care stage, rule-based fallback | On-Track or Developing → Low Concern; At-Risk → Intermediate; Delayed → Severe | `constants/developmental-staging.js:164-169` |
| Care stage, from ML | Low → Low Concern; Medium → Intermediate; High → Severe | `constants/developmental-staging.js:141-145` |

**Effective weights:**
- Each domain counts **25 %** of the overall score, whatever its number of questions.
- The core bank has 13 Motor, 9 Social, 6 Communication and 6 Cognitive items (`js/parent/screening.js`).
- So inside the overall score, one Communication or Cognitive question weighs more than one Motor question. For example, at 84+ months a single Communication item is 1/6 of 25 %, while a Motor item is 1/13 of 25 %.
- No other weights exist in the code.

The code itself marks the band cutoffs as unconfirmed: "Band cutoffs 80/60/40 unconfirmed — pending confirmation from consultant pediatrician" (`constants/scoring.js:5-6`).

---

## 5. Random Forest feature importance

### Q5. Is feature importance available?

**Yes.** The trainer stores scikit-learn's **impurity-based** `feature_importances_` (mean decrease in Gini impurity) for every run (`ml/trainer.py:437`). They are saved in `TrainedModel.featureImportances`. Values from the database:

| Feature | v1 | v2 / v3 | v4 | **v5 (active)** |
|---|---:|---:|---:|---:|
| overall_score | 0.306 | 0.252 | 0.283 | **0.436** |
| motor_score | 0.164 | 0.281 | 0.190 | **0.266** |
| social_score | 0.144 | 0.128 | 0.127 | **0.143** |
| communication_score | 0.180 | 0.142 | 0.085 | **0.069** |
| cognitive_score | 0.082 | 0.064 | 0.075 | **0.056** |
| age_months | 0.093 | 0.133 | 0.240 | **0.031** |
| gender_encoded | 0.032 | — | — | — |
| Training rows | 48 | 80 | 39,448 | **40,000** |

No permutation importance, SHAP values or per-prediction explanations are computed anywhere in the code.

---

## 6. Rule-based weights vs ML feature importance

### Q6. How do they differ?

| | Rule-based scoring | Random Forest (v5) |
|---|---|---|
| Domain weighting | Equal, 25 % each | Motor 0.266 ≫ Social 0.143 > Communication 0.069 > Cognitive 0.056 |
| Overall score | The output of the formula | The single most important input (0.436) |
| Age | Only through question gating | An explicit feature, but nearly unused (0.031) |
| Output | Band (4 levels) from fixed cutoffs | Risk category (3 levels) learned from labels |
| Deterministic? | Yes | Yes for one model artifact; changes when a new model is activated |

**Why they differ, from the code** (an explanation, not a clinical finding):
1. **Feature importance is not a weight.** Impurity importance measures how often and how usefully the trees split on a feature. It does not say how much a domain "counts" toward the prediction, and correlated features share or steal importance from each other.
2. **`overall_score` is the mean of the other four**, so the trees can get most of the signal from that one column. This lowers the apparent importance of the individual domains.
3. **Motor and Social carry more items** (13 and 9 questions against 6 and 6). In the generator every question of every domain is sampled from the *same* class distribution, so the domain with the most items is the least noisy estimate of the class. That makes it the most useful split. This follows from how the synthetic data were made, not from child development.
4. **Age carries no label signal in the synthetic data**, so its importance is low. The higher age importances in v1–v4 came from small or differently generated datasets (48 and 80 rows for v1–v3). **Not verified:** how v4's dataset was generated, since its file is not in the repository.

**Conclusion:** the ML importances describe what the model learned from synthetic data. They must not be presented as clinically derived domain weights, and they do not contradict the equal-weight scoring rule, which answers a different question.

---

## 7. Identified gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | **Labels are synthetic.** The model shows the pipeline works; it is not clinically validated. | `ml/datasets/README.md:7-18, 148-166`; dataset record `provenance.sourceType: synthetic` |
| G2 | **No real outcome labels yet.** The fields exist (`Assessment.clinicalOutcome`, 5 values, and `Assessment.mlLabel`, Low / Medium / High, `models/Assessment.js:30-62`), but the DB has 34 complete non-synthetic assessments, **0** with `clinicalOutcome` and **1** with `mlLabel`. | Read-only DB count, 31 Oct 2026 |
| G3 | **No age-normed expectations.** The same 80 / 60 / 40 cutoffs apply at every age; age only gates which questions are asked. The active model v5 also misses most High-risk children at ages 7–8 (§10). | §3, §10 |
| G4 | **Collinear feature.** `overall_score` duplicates the four domains and dominates importance. | §5–6 |
| G5 | **Impurity importance only.** No permutation importance, SHAP or per-child explanation. | `ml/trainer.py:437` |
| G6 | **Item-level model not used.** The question-based feature set exists but was never trained or activated. | `TrainedModel` records: all score-based |
| G7 | **No cross-validation or calibration.** One stratified split; probabilities shown as-is. | `ml/trainer.py:408-428` |
| G8 | **Environment gap.** Local development writes to the same database as production but cannot load the active model, which is stored only in R2. An assessment submitted locally is saved with a rule-based fallback ("No ML prediction"). This happened to one real assessment on 30 Oct 2026. | `mlUnavailableReason: model_artifact_not_found …`; see the fix report |
| G9 | **Unequal item counts per domain** make single Communication and Cognitive answers swing the overall score more than Motor answers. | §4 |

**Stored predictions today** (all results in the DB):
- 15 by ML: 14 from v5 and 1 from v4.
- 1,190 rule-based legacy or synthetic records with no recorded reason.
- 14 with no prediction.
- 2 rule-based because of a technical failure.

## 8. Recommended revisions (recommendations only; nothing implemented)

1. **Collect real labels before claiming clinical validity.** Have pediatricians record `clinicalOutcome` and `mlLabel` during review, then retrain on reviewed, non-synthetic assessments (fixes G1, G2).
2. **Add age-referenced scoring**, e.g. per-age-band cutoffs or norms from the consultant pediatrician or a published instrument, so "expected for age" is explicit (G3).
3. **Drop `overall_score` from the ML features**, or train a variant without it, and compare (G4).
4. **Report permutation importance** (`sklearn.inspection.permutation_importance` on the test split) next to impurity importance. Consider SHAP for per-child explanations (G5).
5. **Train and compare the question-based model** on the same dataset (G6).
6. **Use stratified k-fold cross-validation** and a calibration check before activating a model (G7).
7. **Make local development load the active model**, or stop local submissions from writing to the shared database. Existing technical failures can be re-run with `scripts/repredict-ml-fallbacks.js` (G8).
8. **Decide with the consultant whether domains should stay equally weighted** and whether item counts per domain should be balanced (G9).

## 9. Suggested answers to panel questions

| Likely question | Suggested answer (supported by) |
|---|---|
| *Does the model use age and all four domains?* | Yes. The active model v5 uses Communication, Social, Cognitive, Motor, the overall score and age in months (`TrainedModel.featuresUsed`; `ml/trainer.py:61-79`). |
| *What does the Random Forest predict?* | A developmental risk category: Low, Medium (shown as "Moderate") or High (`ml/trainer.py:81-83`). It is kept separate from the rule-based Developmental Band (`constants/scoring.js`) and turned into a care stage by `constants/developmental-staging.js:141-145`. |
| *Where do the training labels come from?* | A 50,000-row synthetic dataset, generated with class-first sampling and 18 % label noise so labels are not a threshold of the scores (`generate_kindercura_dataset.py:35-51, 93-100`). We present the model as a working pipeline, not a validated clinical tool. Real labels (`clinicalOutcome`, `mlLabel`) are planned. |
| *Is age-appropriate development considered?* | Partly. Questions are age-gated and age is a model feature. Scores are not yet age-normed (§3); this is a planned revision. |
| *How is the overall score weighted?* | Equally: the mean of four domain percentages, each domain scored yes = 2, sometimes = 1, no = 0 (`routes/assessments.js:139-144, 1057-1061`). |
| *Why does the model rely on Motor and the overall score more than the formula does?* | Importance is impurity-based and reflects the synthetic data. Motor has the most items, so it is the least noisy class signal, and `overall_score` repeats the four domains. It is not a clinical weighting (§6). |
| *What if the model is unavailable?* | The system falls back to the rule-based care stage and says "No ML prediction". It never invents an ML result, and the reason is stored (`services/assessmentProgress.js:105-110, 187-202`). |
| *How accurate is it?* | 69.7 % accuracy and 0.689 weighted F1 on a 10,000-row held-out test split of synthetic data (`TrainedModel` v5). Not a measure of real-world accuracy. |

**Not verified:** the panelists' exact comments were not available to this inspection. The questions above are inferred from the task's seven points.

---

## 10. Age-aware model (added 31 Oct 2026)

**The panel's questions:**
- If a 4-year-old scores low in a skill area because they are young, does the model understand that?
- Does it know when an 8-year-old is no longer on track?

**The active model v5 does not.** Its training data gave every answer the same odds at every age, so it learned "low score = concern" whatever the age.

### Method

`ml/datasets/generate_kindercura_dataset.py --age-aware` simulates a **developmental quotient** (DQ = developmental age ÷ chronological age), a standard concept in developmental pediatrics (`:113-170, 187-204`):

1. The risk class is chosen first. A DQ is then drawn from that class's range, and the ranges overlap (`AGE_AWARE_DQ_RANGE`, `:136-140`):

   | Class | DQ range |
   |---|---|
   | Low | 0.90–1.10 |
   | Medium | 0.75–0.92 |
   | High | 0.50–0.78 |

2. Developmental age = age × DQ. A low DQ therefore means a lag that **grows with age**. At DQ 0.70, a 4-year-old is about 14 months behind and an 8-year-old about 29 months behind.
3. Each milestone is answered from a mastery curve on *developmental age − the milestone's minimum age*. The curve gives "no" well before that age, "sometimes" while the skill is emerging, and "yes" once mastered (`age_aware_answer_probs`, `:153`):

   | Months past the milestone's age | yes | sometimes | no |
   |---|---|---|---|
   | −12 | 0.06 | 0.26 | 0.68 |
   | 0 | 0.56 | 0.34 | 0.10 |
   | +12 | 0.96 | 0.03 | 0.01 |

4. The app's score formula, the age gate and the 18 % label noise are unchanged.

The DQ ranges and curve constants are **design parameters of the simulation, to be confirmed with the consultant pediatrician**. They are not published norms. The data remain simulated (provenance: synthetic).

### Results (50,000 age-aware rows, seed 20261031; trained locally with the unchanged `ml/trainer.py`)

| Model | Accuracy | Weighted F1 | `age_months` importance |
|---|---:|---:|---:|
| v5 (active, age-blind data), tested on fresh age-aware rows | 0.441 | — | 0.031 |
| **Age-aware, score-based** (same 6 features as v5) | **0.692** | 0.684 | **0.187** |
| Age-aware, question-based (Q01–Q34 + age) | 0.683 | 0.673 | 0.117 |

Score-based importances of the age-aware model:

| Feature | Importance |
|---|---:|
| overall | 0.248 |
| motor | 0.194 |
| cognitive | 0.190 |
| **age** | **0.187** |
| social | 0.123 |
| communication | 0.058 |

**Share of High-risk children correctly identified (High recall), per year of age**, on 10,000 fresh age-aware rows (`python ml/age_scenarios.py --eval-rows 10000`):

| Age | v5 (active) | Age-aware, score-based | Age-aware, question-based |
|---|---:|---:|---:|
| 3 | 0.744 | 0.761 | 0.797 |
| 4 | 0.647 | 0.843 | 0.818 |
| 5 | 0.397 | 0.812 | 0.816 |
| 6 | 0.247 | 0.821 | 0.810 |
| 7 | 0.077 | 0.798 | 0.837 |
| 8 | **0.006** | **0.745** | 0.705 |

**Scenario check** (`python ml/age_scenarios.py --model <artifact>`; children built answer by answer through the app's age gate and score formula, predicted with the same `predict_from_artifact` live predictions use):

| Child | Overall | v5 (active) | Age-aware, score-based |
|---|---:|---|---|
| 4 y: earlier milestones mastered, half of the 4-year ones still emerging | 84 % | Low | **Low** (P(High) 0.04) |
| 4 y: earlier milestones mastered, every 4-year one only emerging | 73 % | Low | Medium |
| 4 y: missing 3-year milestones | 29 % | High | High |
| 8 y: every milestone mastered | 100 % | Low | Low |
| 8 y: 6- and 7-year milestones still only emerging | 88 % | Low | **High** (P(High) 0.75) |
| 8 y: answering like a typical 5-year-old | 64 % | Medium | **High** (P(High) 0.83) |
| 8 y: missing 3- and 4-year milestones | 11 % | High | High |

Rows 1 and 5 answer the panel directly. The 8-year-old has a **higher** overall score than the 4-year-old (88 % against 84 %) and is still the one flagged. The age-aware model judges the answers against what is expected for the child's age, not against the raw percentage.

### Recommendation

1. Train the **score-based** model on the age-aware dataset, through Admin → Training (command in `ml/datasets/README.md`).
   - It matches the question-based model and uses the same six features as v5, so the prediction path and stored predictions need no change.
2. Run the activation smoke test and `ml/age_scenarios.py`, then activate.
   - Activation affects new assessments only. Earlier assessments keep their stored v5 prediction.
3. Confirm the DQ ranges and mastery-curve constants with the consultant pediatrician. Replace the simulation with clinician-reviewed labels (`clinicalOutcome`, `mlLabel`) as they accumulate.

### Suggested panel answers

| Question | Answer |
|---|---|
| *A 4-year-old scores low in a skill area because they are young. Does the model understand?* | Two layers handle it. **Questions are age-gated**, so a 4-year-old is only asked milestones expected by about 4. The **age-aware model** was trained on data where the chance of each answer depends on how far the child is past that milestone's age. A 4-year-old whose newest milestones are still emerging is classified Low (84 % overall → Low, P(High) 0.04). |
| *Does the model know when an older child is not on track?* | Yes, for the age-aware model. The same kind of answers that are normal at 4 are a concern at 8. An 8-year-old whose 6- and 7-year milestones are only emerging is High even at 88 % overall, and High-risk children are found at a similar rate at every age: recall 0.76–0.84 for ages 3–7, 0.75 at 8 (the earlier model: 0.006 at 8). |
| *Where do the age expectations come from?* | Each milestone's minimum age comes from the KinderCura question bank. How quickly a skill moves from "emerging" to "mastered", and how much lag each risk level represents, are simulation parameters set from the developmental-quotient concept. They are pending confirmation by our consultant pediatrician. Training data are simulated, and will be replaced by pediatrician-reviewed outcomes. |
