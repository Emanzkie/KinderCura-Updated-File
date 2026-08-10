# KinderCura — Pediatrician Reports Module

**Status:** current as of the pediatrician reports module.
**Authority:** `routes/pedia-reports.js` is the implementation; `constants/scoring.js`
is the single source of truth for every band decision this module makes. Where
this document and the code disagree, the code is correct and this document is
stale.

> ⚠️ **The band cutoffs this report classifies against are unconfirmed**, pending
> confirmation from the consultant pediatrician. **Do not cite this report, or
> anything computed from it, as clinically validated.**

---

## 1. What the module is

A read-only reporting page for a pediatrician, covering their own patients only:

1. **Classification analytics** — where the cohort falls across the four bands,
   overall and per scoring domain.
2. **Screening-to-screening progression** — for children screened more than
   once, how their scores and bands moved.
3. **Outcome cross-tab** — how the screening classified each child set against
   what the reviewing pediatrician actually concluded.

**It is descriptive reporting over stored, rule-based scores.** It counts what
is on file. There is no model, no prediction, no estimation, and no inference
anywhere in it. The `ml/` directory has never produced a model and is not in
this path — see `docs/AUDIT-SUMMARY.md` §2.

### What it deliberately does not do

| Not done | Why |
|---|---|
| Recompute any score | `AssessmentResult` is read directly. A second scoring path is how the system ended up with five disagreeing band sets (`docs/SCORING.md` §4). |
| Write anything | Read-only, like `routes/parent-reports.js`. No new collections, no cache, no denormalised summary documents. |
| Contain a numeric cutoff | Every band comes from `scoring.bandFor()`, every risk flag from `scoring.isRiskFlagged()`. `grep -nE '\b(80\|70\|60\|51\|40\|26)\b' routes/pedia-reports.js` returns nothing. |
| Compute accuracy / sensitivity / PPV | See §5. |
| Read a conclusion from `diagnosis` | `models/Assessment.js` forbids it. Only `clinicalOutcome` counts as a label. |

---

## 2. Patient scope

**A child is in scope if, and only if, an `Appointment` document exists linking
that child to the requesting pediatrician's `userId`.**

- Scope is derived from `req.user.userId` inside `loadScope()`. **No
  pediatrician id is ever accepted from the client**, so the cohort cannot be
  changed by editing a query parameter.
- This is the same rule as the ownership gate at `routes/assessments.js:776` and
  in `routes/parent-reports.js`, so this router cannot be more permissive than
  the endpoints it reports on.
- Appointment **status is not consulted**. A pending, cancelled, or rejected
  appointment still establishes the clinical relationship, which matches how
  `/pedia-patients` and the progress-note endpoints already behave. Narrowing to
  approved appointments only would silently drop patients from the report that
  the My Patients page still lists.

Every handler applies `authMiddleware`, then a role gate returning
`403 {"error":"Pediatricians only."}` to any other role.

### Query cost

The `uniqueByChild` dedupe pattern comes from `/pedia-patients`; its per-patient
`await` loop deliberately does not. Each endpoint issues **one query per
collection** with an `$in` over the scoped child ids — cost is a function of how
many collections are involved, not how many patients exist.

---

## 3. Endpoints

All four accept optional `?from=` and `?to=` ISO dates, filtering on
`AssessmentResult.generatedAt`. **Default is all time.** A date-only `to`
(`2026-08-08`) is extended to the end of that day, so "to 8 August" includes
screenings generated during 8 August. A full ISO timestamp is honoured exactly.
An unparseable date, or `from` later than `to`, returns `400`.

### `GET /api/pedia-reports/overview`

```jsonc
{
  "success": true,
  "range": { "from": null, "to": null },
  "cohort": {
    "patients": 5,              // children linked by an appointment
    "screenings": 6,            // AssessmentResult documents in range
    "patientsWithScreening": 5,
    "legacyBandDocs": 0         // scoringBandsVersion == null
  },
  "overallDistribution": { "on-track": 1, "developing": 1, "at-risk": 3, "delayed": 0 },
  "domainDistribution": { "communication": {…}, "social": {…}, "cognitive": {…}, "motor": {…} },
  "riskFlagged": { "communication": 1, "social": 0, "cognitive": 0, "motor": 0, "anyDomain": 1 },
  "labelling": { "labelled": 0, "unlabelled": 6, "byOutcome": { … } }
}
```

**The distributions count the latest screening per child, not every screening.**
This is the first thing a reader should check, so it is stated in a comment in
the handler and on the page itself. Counting every screening would let one child
screened four times outweigh three children screened once. One child, one count.

Consequences that follow from that rule, and which are worth verifying:

- For each domain, the four band counts **sum exactly to
  `patientsWithScreening`**. So does `overallDistribution`.
- `labelling.labelled + labelling.unlabelled` sums to `cohort.screenings`
  — labelling is counted **per screening**, because the question it answers is
  how many screenings carry a clinician's conclusion.
- `riskFlagged.anyDomain` counts each child **once**, however many of their
  domains were flagged. It is never the sum of the four domain counts.

`byOutcome` is keyed off `Assessment.schema.path('clinicalOutcome').enumValues`
rather than a restated list, so adding a sixth outcome to the model cannot leave
this report silently showing five.

### `GET /api/pedia-reports/progression`

One entry per in-scope child with **≥2 screenings in range**. A child with one
screening is excluded and counted in `childrenWithSingleScreening` instead, so a
short table is explained rather than merely short. A single score is a reading,
not a trend — the same rule `routes/parent-reports.js` applies via
`trendAvailable`.

Each entry carries `firstScreening`, `latestScreening`, the full `screenings`
array (so the UI can expand a row without a second request), `delta` per domain
and overall, `bandMovement` per domain and overall, `screeningCount`,
`progressNoteCount`, `latestProgressStatus`, and `bandComparabilityWarning`.
A `cohortMovement` roll-up counts children improved / unchanged / declined on
overall band.

**Band movement compares band index, not raw score.** `ACTIVE_BANDS` is ordered
high → low, so a lower index is a better band. A child moving 61% → 78% has
gained 17 points without leaving `developing`, and `bandMovement` says
`unchanged` for exactly that reason.

Progress notes are filtered to `pediatricianId: req.user.userId`, matching
`routes/assessments.js:807`, so the count here agrees with the timeline the same
clinician sees in My Patients.

### `GET /api/pedia-reports/outcomes`

The cross-tab of **screening overall band × recorded clinical outcome**, over
every in-scope assessment where `clinicalOutcome != null`, plus a `rows` list of
the individual labelled screenings.

`matrix` is fully enumerated: every band × every outcome exists, at zero if
nobody recorded it. An empty cell renders as `0`, never as a gap.

When `labelledCount === 0` the same structure is returned with an explicit
`message` explaining that outcome labelling has not started. **No label is ever
fabricated or inferred from the free-text `diagnosis` field.**

### `GET /api/pedia-reports/export.csv`

One row per screening in range, 18 columns: child name, date of birth, screening
date, each domain's stored score and its band, overall score and band,
`scoring_bands_version`, `clinical_outcome`, `clinical_outcome_domains`,
`clinical_outcome_at`, `assessment_id`.

RFC 4180: every cell is quoted, an embedded `"` is doubled, records are
CRLF-separated. The stored `overallScore` is emitted as-is — it is never
recomputed from the four domain scores, which would produce a second, different
figure (the domain scores are each rounded before the mean is taken).

The endpoint requires the bearer token, so the page fetches it with an auth
header and hands it to the browser as a blob. `downloadWithAuth()` in `api.js`
is JSON-only and would try to parse the CSV body as JSON.

---

## 4. Bands, and how legacy documents are handled

Every band in this module is computed by `scoring.bandFor()` from the **stored
score**, under the current `ACTIVE_BANDS`. It is **not** read from the stored
`communicationStatus` / `socialStatus` / … strings.

That choice matters, and it is the reason the report is internally coherent:

- All children are placed on **one ruler**, whatever ruler was in force when
  their record was written. Band totals therefore reconcile against
  `patientsWithScreening` exactly, and a progression row's two ends are directly
  comparable.
- The stored `*Status` strings on an unstamped document were assigned under the
  old 51/26 cutoffs. Those strings are still read by other parts of the system.
  So a legacy record can be shown here as `developing` while an older page shows
  `on-track` for the same score.

Two mechanisms surface that rather than hiding it:

| Signal | Where | Meaning |
|---|---|---|
| `cohort.legacyBandDocs` | `/overview` | How many screenings in range carry no `scoringBandsVersion`. The page shows a footnote whenever this is non-zero. |
| `bandComparabilityWarning` | `/progression`, per child | The two endpoints of this row were stamped with different band-set versions. The *movement* is still sound — both ends were recomputed on the current ruler — but reconciling this row against the stored labels elsewhere will not work. |

**Current data:** `docs/BACKFILL-REPORT.md` records that the backfill ran in
APPLY mode over all 11 result documents then on file and restamped every one to
`v2-80/60/40` ("Already stamped: 0, Documents restamped: 11"). A live check
confirms **0 documents with a null `scoringBandsVersion`** across the whole
`results` collection. So `legacyBandDocs` reads 0 and
`bandComparabilityWarning` never fires today. Both are **defensive paths** — a
restore, an import, or a script that bypasses the submit handler could still
introduce an unstamped document — not live conditions.

---

## 5. Why no validation metrics are computed

**No accuracy, sensitivity, specificity, PPV, NPV, F1, or kappa is computed
anywhere in this module, and none may be added.** The `/outcomes` handler
returns counts and stops. Three independent reasons, each sufficient alone:

1. **Sample size.** `docs/AUDIT-SUMMARY.md` §4 records 11 completed screenings
   across the entire system, and 0 with a confirmed clinical outcome. A rate
   computed from a handful of labelled cases has a confidence interval wide
   enough to span "useless" and "excellent"; quoting the point estimate hides
   that interval rather than reporting it.

2. **The labels are not blind.** The pediatrician recording `clinicalOutcome`
   has already seen the screening scores — the diagnosis modal displays them on
   the same form. The label is therefore not independent of the thing it would
   be validating. Agreement between the two partly measures the score's
   influence on the clinician, not the score's correctness.

3. **The cutoffs are unconfirmed.** Band provenance is still pending the
   consultant pediatrician. An accuracy figure computed against unconfirmed
   boundaries measures agreement with an arbitrary line.

The contingency table is the honest artefact. A panelist is entitled to say a
computed accuracy figure here would be misleading, and they would be right.

This reasoning is repeated in a comment above the `/outcomes` handler so that
anyone editing the file meets it before adding a metric.

---

## 6. Known limitations

These apply to every number this module reports.

1. **Small N.** With screenings in single or low double digits, every count in
   this report is a description of a handful of specific children. Nothing here
   generalises to a population.

2. **Non-blinded outcome labels.** See §5.2. Until outcomes are recorded without
   the screening score in view, the cross-tab describes concordance between two
   non-independent judgements.

3. **Unconfirmed cutoffs.** 80/60/40 was chosen because it matched what parents
   already saw and because it errs toward flagging more children rather than
   fewer. Its clinical provenance is unconfirmed (`constants/scoring.js`).

4. **Mixed `scoringBandsVersion` in historical data.** See §4. Currently zero
   affected documents, but the report is built to disclose it if that changes.

5. **Scores are not age-normed.** Age decides which questions a child is asked,
   never how the answers are judged (`docs/SCORING.md` §5). A 3-year-old scored
   on 8 items and an 8-year-old scored on 34 are placed against identical
   cutoffs. This report inherits that limitation in full and does not correct
   for it — a band distribution across a cohort of mixed ages is a distribution
   of age-unadjusted scores.

6. **Unequal domain weighting.** The overall score is the unweighted mean of the
   four domain percentages, and the domains contain 6 / 6 / 9 / 13 items. A
   single Cognitive item moves the overall score ~2.17× as much as a single
   Motor Skills item (`docs/SCORING.md` §2.4). `overallDistribution` inherits
   this.

7. **Custom pediatrician questions are not counted anywhere in this module.**
   They live on `PediaCustomQuestionAssignment`, not in `assessment_answers`,
   carry no `assessmentId`, and are not scored. They cannot be attributed to a
   screening session, so placing them in a per-screening report would be a guess
   presented as a record. `routes/parent-reports.js` keeps them in a separate
   section for the same reason.

8. **Appointment status is ignored in scope.** See §2 — deliberate, for
   consistency with the pages this reports on.

---

## 7. Related files

| File | Role |
|---|---|
| `routes/pedia-reports.js` | The four endpoints |
| `PEDIA/pedia-reports.html` | The page shell, caveat banner, and script load order |
| `js/pedia/pedia-reports.js` | Rendering; reads bands, labels, and colours from `window.KCScoring` |
| `CSS files/pedia-reports-styles.css` | Page styles |
| `constants/scoring.js` | Single source of truth — bands, labels, colours, version stamp |
| `models/Assessment.js` | `clinicalOutcome`, the only field that can serve as a label |
| `models/AssessmentResult.js` | The stored scores this module reads |
| `docs/SCORING.md` | Full scoring protocol |
| `docs/AUDIT-SUMMARY.md` | Plain-language audit position |
| `docs/BACKFILL-REPORT.md` | Evidence for the §4 claim about band-version stamping |
