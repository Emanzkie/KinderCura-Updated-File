# KinderCura Objective Source Code Report

This report lists the KinderCura source code behind each of the four research objectives. Line numbers are as of commit 42c838b. Every excerpt is copied verbatim from the cited lines; `// …` marks lines left out. `PROJECT_MAP.md` lists more related files.

| Objective | Status |
|---|---|
| 1. Developmental Assessment Tool | Implemented and verified |
| 2. Progress-Tracking Dashboard | Assessment results and progress tracking are implemented. Completion of individual activities is **not implemented** |
| 3. Automated Recommendations | Implemented and verified (rule-based per domain, with an ML-based overall care stage that falls back to rules) |
| 4. Pediatric Appointment Booking | Implemented and verified |

---

## Objective 1: Developmental Assessment Tool (communication, social, cognitive, motor)

### 1.1 Age-filtered screening form
**File:** `js/parent/screening.js`. The bank starts at `DOCTOR_QUESTION_BANK` (line 7). The relevant functions are `buildQuestionSet` (lines 129–146) and `getAnswerPayload` (lines 162–171).

Each question has a minimum age and is tagged with one of the four scoring domains. The form shows only the questions suitable for the child's age in months, and it sends each answer to the server along with its domain.

```js
        const DOCTOR_QUESTION_BANK = [
            { id: 'Q02', minAgeMonths: 36, displayDomain: 'Fine Motor',      scoreDomain: 'Motor Skills',   text: 'Does your child draw a circle?',                                                difficulty: 'Easy' },
// …
        function buildQuestionSet(child, datasetQuestions = []) {
            const ageMonths = getAgeInMonths(child.dateOfBirth);
// …
            return DOCTOR_QUESTION_BANK.concat(extra)
                .filter(q => ageMonths >= q.minAgeMonths)
// …
        function getAnswerPayload() {
            return QUESTION_SET
                .filter(q => q?.id && answers[q.id])
                .map(q => ({
                    questionId: q.id,
                    domain: q.scoreDomain ?? '',
                    questionText: q.text ?? '',
                    answer: answers[q.id]
                }));
        }
```

### 1.2 Answer scoring and domain totals
**File:** `routes/assessments.js`. The relevant code is `scoreAnswer` (lines 117–122) and the `POST /api/assessments/submit` handler (starting at line 745; domain totals at lines 797–811).

Every answer is converted to points: Yes = 2, Sometimes = 1, No = 0. The points are added up separately for each of the four domains.

```js
function scoreAnswer(answer) {
  const normalized = String(answer ?? '').trim().toLowerCase();
  if (normalized === 'yes') return 2;
  if (normalized === 'sometimes') return 1;
  return 0;
}
// …
    const totals = {
      Communication: { earned: 0, total: 0 },
      'Social Skills': { earned: 0, total: 0 },
      Cognitive: { earned: 0, total: 0 },
      'Motor Skills': { earned: 0, total: 0 },
    };
// …
    const storedCoreAnswers = await AssessmentAnswer.find({ assessmentId, origin: DATA_ORIGIN.CORE_BANK }).lean();
    for (const a of storedCoreAnswers) {
      if (!totals[a.domain]) continue;
      totals[a.domain].total += 2;
      totals[a.domain].earned += scoreAnswer(a.answer);
```

### 1.3 Domain percentages, overall score and risk flags
**File:** `routes/assessments.js` (lines 952–962). The results are saved by `AssessmentResult.findOneAndUpdate` starting at line 980.

Each domain score is the percentage of possible points the child earned. The overall score is the average of the four domain scores. A domain is flagged when its score is below the risk threshold.

```js
    const communicationScore = totals.Communication.total ? Math.round((totals.Communication.earned / totals.Communication.total) * 100) : 0;
    const socialScore        = totals['Social Skills'].total ? Math.round((totals['Social Skills'].earned / totals['Social Skills'].total) * 100) : 0;
    const cognitiveScore     = totals.Cognitive.total ? Math.round((totals.Cognitive.earned / totals.Cognitive.total) * 100) : 0;
    const motorScore         = totals['Motor Skills'].total ? Math.round((totals['Motor Skills'].earned / totals['Motor Skills'].total) * 100) : 0;
    const overallScore       = Math.round((communicationScore + socialScore + cognitiveScore + motorScore) / 4);

    const riskFlags = [];
    if (scoring.isRiskFlagged(communicationScore)) riskFlags.push('Communication delay detected');
    if (scoring.isRiskFlagged(socialScore)) riskFlags.push('Social skills concern detected');
    if (scoring.isRiskFlagged(cognitiveScore)) riskFlags.push('Cognitive development concern');
    if (scoring.isRiskFlagged(motorScore)) riskFlags.push('Motor skills delay detected');
```

### 1.4 Score bands
**File:** `constants/scoring.js`. The relevant code is `PARENT_DISPLAY_BANDS` (lines 69–74, used as `ACTIVE_BANDS`) and `isRiskFlagged` (lines 193–195; the threshold of 40 is set at line 140).

This one file defines the score bands used everywhere in the system: On Track, Developing, At Risk and Delayed.

```js
  const PARENT_DISPLAY_BANDS = Object.freeze([
    Object.freeze({ key: BAND.ON_TRACK,   min: 80, max: 100 }),
    Object.freeze({ key: BAND.DEVELOPING, min: 60, max: 79 }),
    Object.freeze({ key: BAND.AT_RISK,    min: 40, max: 59 }),
    Object.freeze({ key: BAND.DELAYED,    min: 0,  max: 39 }),
  ]);
// …
  function isRiskFlagged(score) {
    return normalizeScore(score) < RISK_FLAG_THRESHOLD;
  }
```

**Limitation:** `docs/SCORING.md` says the 80/60/40 cutoffs still need confirmation from the consultant pediatrician. It also says they should not be cited as clinically validated.

---

## Objective 2: Progress-Tracking Dashboard

### 2.1 Progress timeline API
**File:** `routes/parent-reports.js`. The handler for `GET /api/parent/children/:childId/report` starts at line 101; the completed-assessment query is at lines 109–111.

The API first checks that the user is allowed to see the child. It then loads every completed assessment in date order and attaches the stored scores, plus how many answers were recorded in each domain. The answer counts let the page tell a real 0% score apart from a domain where nothing was answered.

```js
    const assessments = await Assessment.find({ childId: child._id, status: 'complete' })
      .sort({ completedAt: 1, startedAt: 1 })
      .lean();
// …
        domains: DOMAINS.map((d) => ({
          key: d.key,
          label: d.label,
          score: r ? (r[d.scoreField] ?? null) : null,
          storedStatus: r ? (r[d.statusField] ?? null) : null,
// …
          answeredItemCount: domainCountMap.get(String(a._id))?.[d.label] ?? 0,
        })),
        overallScore: r ? (r.overallScore ?? null) : null,
```

### 2.2 Score-change calculation between assessments
**File:** `services/assessmentProgress.js`. The relevant functions are `buildScoreChanges` (lines 373–386) and `buildAssessmentProgressSummary` (line 407). The comparison endpoint `GET /api/assessments/:assessmentId/compare` (`routes/assessments.js:1849`) calls the summary function.

For each domain, the change is the current score minus the previous score.

```js
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
```

### 2.3 Dashboard and trend chart
**Files:** `js/parent/dashboard.js`, where `loadDashboard` starts at line 88 (lines 133–152 are excerpted), and `js/parent/reports.js`, where `drawTrendChart` starts at line 292 (the report API is fetched at line 778).

The dashboard shows the most recent assessment and its recommendations. The Reports page draws a line chart of the overall score across all completed assessments, with each point coloured by its band.

```js
            const hist = await apiFetch(`/assessments/${childId}/history`);
// …
            const assessments = (hist.assessments || []).filter(a => a.overallScore !== null);
            if (assessments.length > 0) {
                const latest = assessments[0];
                localStorage.setItem('kc_assessmentId', latest.id);
                renderSkills(latest);
                renderAssessment(latest);
// …
                    const recs = await apiFetch(`/recommendations/${latest.id}`);
                    renderRecs(recs.recommendations || []);
```
```js
    trendChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: scored.map((a) => fmtShortDate(a.completedAt)),
            datasets: [{
                label: 'Assessment score',
                data: scored.map((a) => a.overallScore),
```

**Not implemented: activity completion.** `models/Recommendation.js` stores recommended activities as `activities: [{ type: String }]`, with no field for completion or progress. No route or page records whether a parent finished an activity. When the dashboard shows "completed" counts, they refer to completed assessments and appointments only.

---

## Objective 3: Automated Recommendations

### 3.1 Recommendations for each domain
**File:** `routes/recommendations.js`. The relevant code is `RECOMMENDATION_LEVEL_BY_BAND` (lines 61–66) and `buildRecommendationSet` (lines 68–122).

Each domain's score band sets the recommendation's priority and picks the wording from a fixed suggestion map. The map holds home activities for each domain at three levels; at the lowest level the activities include consulting a specialist. A domain is marked as needing a professional consultation when its score is risk-flagged. When the stored prediction came from the ML model, the model's verdict can also set that flag.

```js
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
// … (social, cognitive and motor follow the same shape)
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
```

### 3.2 Generating and saving recommendations
**File:** `routes/recommendations.js`. The handler for `GET /api/recommendations/:assessmentId` starts at line 271; recommendations are generated and saved at lines 304–313.

The first time anyone views an assessment's results, the recommendations are generated and saved. Every later view reads the saved copy.

```js
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
```

### 3.3 Overall care stage (ML with rule-based fallback)
**File:** `services/assessmentProgress.js`. `buildPredictionForStorage` (lines 254–268 are excerpted) is called during assessment submission. Its result is used by `buildOverallCarePlan` in `routes/recommendations.js:136`.

When an assessment is submitted, the system saves an overall risk category and care stage (consultation level and monitoring level). The trained ML model produces them when it is available. Otherwise they come from rules applied to the overall score (`constants/developmental-staging.js:182`, `getCareStageFromScore`). The `source` field records which method was used.

```js
async function buildPredictionForStorage(scores, childId, answers = null) {
  try {
    const diagnostics = {};
    const careStageInfo = await getAssessmentCareStage(scores, childId, { answers: answers || {}, diagnostics });
    return {
      source: careStageInfo.source,
      modelVersion: careStageInfo.modelVersion,
      riskCategory: careStageInfo.riskCategory,
      careStage: careStageInfo.careStage,
      careStageLabel: careStageInfo.careStageLabel,
      consultationLevel: careStageInfo.consultationLevel,
      monitoringLevel: careStageInfo.monitoringLevel,
      probabilities: careStageInfo.probabilities,
      mlUnavailableReason: careStageInfo.source === 'ml' ? null : (diagnostics.reason || 'unknown'),
      generatedAt: new Date(),
```

**Limitations:**
- The activities and suggestions for each domain are fixed text chosen by score band. They are not personalised beyond that.
- An ML prediction is used only when an active trained model is reachable when the assessment is submitted.
- The bands come from Objective 1, so the same cutoff caveat applies.
- The recommendations route also suggests pediatricians (`buildSuggestedPediatricians`, line 224).

---

## Objective 4: Pediatric Appointment Booking

### 4.1 Booking form
**File:** `js/parent/appointments.js`. `bookAppointment` starts at line 579 (lines 615–620 are excerpted). Availability is checked at line 518.

The form checks that the child, pediatrician, date and time are filled in and that the slot is still free. It then posts the booking and sends the parent on to the payment page.

```js
        const data = await apiFetch('/appointments/create', {
            method: 'POST',
            body: JSON.stringify({ childId, pediatricianId, appointmentDate, appointmentTime, reason, notes }),
        });
        localStorage.removeItem('kc_prefPediaId');
        window.location.href = `/PARENT/payment.html?appointmentId=${data.appointmentId}`;
```

### 4.2 Booking API and database write
**File:** `routes/appointments.js`. The `POST /api/appointments/create` handler covers lines 1477–1610; the database insert is at lines 1524–1537.

The API requires the child, pediatrician, date and time. It checks that the user may book for this child, then confirms the slot is still available. If so, it saves the appointment together with the pediatrician's consultation fee and clinic. The pediatrician then receives a notification.

```js
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { childId, pediatricianId, appointmentDate, appointmentTime, reason, notes, location } = req.body;

    if (!childId || !pediatricianId || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ error: 'Child, pediatrician, date, and time are required.' });
    }
// …
    const availability = await evaluateAvailability({ pediatrician, appointmentDate, appointmentTime });
    if (!availability.available) {
      return res.status(400).json({ error: availability.message });
    }

    const totalAmount = Number(pediatrician.consultationFee ?? 0);
// …
      const created = await Appointment.create([{
        childId: child._id,
        parentId: parent._id,
        pediatricianId: pediatrician._id,
        clinicId: pediatrician.clinicId || null,
        appointmentDate: apptDate,
        appointmentTime: normalizedRequestedTime,
        reason: reason || 'General checkup',
```

### 4.3 Availability checks
**File:** `routes/appointments.js`. `evaluateAvailability` starts at line 745 (excerpted lines: 838–854 and 925–930).

The function enforces the pediatrician's working days and hours, breaks, and daily patient limit. It also loads that day's pending and approved appointments so that two bookings can never overlap.

```js
  const query = {
    pediatricianId: pediatrician._id,
    appointmentDate: { $gte: dateOnly, $lt: nextDay },
    status: { $in: ['pending', 'approved'] },
  };
// …
  const existing = await Appointment.find(query)
    .select('appointmentTime')
    .sort({ appointmentTime: 1 })
    .lean();
// …
  const bookedCount = existing.length;
  const remainingSlots = Math.max(maxPatientsPerDay - bookedCount, 0);
// …
    const requestedIntervalTaken = existingIntervals.some((busy) => busy.valid && intervalsOverlap(
      normalizedRequestedMinutes,
      normalizedRequestedMinutes + DEFAULT_SLOT_MINUTES,
      busy.startMinutes,
      busy.endMinutes
    ));
```

**Related routes:** `GET /pediatricians/list` (line 1323), `GET /availability/check` (line 1357), `PUT /:appointmentId/status` (line 1687, used by pediatricians and secretaries to approve or decline), `POST /:appointmentId/cancel` (line 1782), `POST /:appointmentId/reschedule` (line 1809).

**Note:** paying for an appointment is a separate step after booking (`PARENT/payment.html`, `routes/payments.js`).
