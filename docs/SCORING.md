# KinderCura — Scoring Protocol

**Status:** current as of the scoring-bands unification (`v2-80/60/40`).
**Authority:** `constants/scoring.js` is the single source of truth for all band
cutoffs, labels, and colours. This document describes what that file and the
scoring pipeline actually do. Where the two ever disagree, the code is correct
and this document is stale.

> ⚠️ **TODO — provenance unconfirmed.** Band cutoffs 80/60/40 are unconfirmed,
> pending confirmation from the consultant pediatrician. **Do not cite as
> clinically validated.**

---

## 1. What the system is

KinderCura computes screening results using **hardcoded rules** — fixed
arithmetic and threshold comparisons written by a developer. It is not a
machine-learning system. See `docs/AUDIT-SUMMARY.md` for the full position on
the `ml/` directory.

---

## 2. Scoring math

### 2.1 Item scoring

Each screening item is answered on a three-point scale
(`js/parent/screening.js:211-213` → `routes/assessments.js:68-72`):

| Answer | Parent-facing label | Points |
|---|---|---:|
| `yes` | "Yes, consistently" | **2** |
| `sometimes` | "Sometimes" | **1** |
| `no` | "Not yet" | **0** |

Any unrecognised value scores 0.

### 2.2 Domain percentage

`routes/assessments.js:386-395`

```
domain % = round( (sum of points earned in domain) / (2 × items answered in domain) × 100 )
```

The denominator counts **items actually answered**, not the full bank. A child
served fewer items by the age gate (§5) is scored only on what they were asked.
A domain with no answered items scores 0.

### 2.3 Overall score

`routes/assessments.js:396`

```
overall = round( (communication% + social% + cognitive% + motor%) / 4 )
```

**This is an unweighted mean of the four domain percentages — not a pooled
percentage of all points earned.**

### 2.4 Consequence: domains with fewer items carry equal weight

The four scoring domains contain unequal numbers of items:

| Scoring domain | Items in bank | Share of overall | Weight per item |
|---|---:|---:|---:|
| Motor Skills | 13 | 25% | 1.92% |
| Social Skills | 9 | 25% | 2.78% |
| Communication | 6 | 25% | 4.17% |
| Cognitive | 6 | 25% | 4.17% |
| **Total** | **34** | **100%** | — |

A single Cognitive item therefore moves the overall score **~2.17× as much** as
a single Motor Skills item. This is a consequence of the unweighted mean, not a
deliberate clinical weighting. It is documented here because it is not obvious
from the code and would otherwise be an unstated methodological choice.

### 2.5 Scoring domains vs. display subdomains

Scoring uses **four** buckets. The parent-facing screening UI additionally shows
a **display subdomain** per item (`Gross Motor`, `Fine Motor`, `Language`,
`Personal-Social`) which is **presentational only** and is never scored
separately (`js/parent/screening.js:135`, `models/CoreBankQuestion.js:35`).

Do not describe the system as scoring five domains.

### 2.6 Risk flags

`routes/assessments.js:398-402`, threshold `scoring.RISK_FLAG_THRESHOLD = 40`.

A domain scoring **below 40%** raises a text risk flag (e.g. `"Communication
delay detected"`). The threshold is intentionally equal to the `at-risk` band
floor — "below the at-risk band" and "flagged" are the same event.

---

## 3. Score bands

### 3.1 Active bands (`v2-80/60/40`)

Defined once in `constants/scoring.js` as `ACTIVE_BANDS`.

| Range | Band key (persisted) | Parent domain label | Parent overall label | Clinician label |
|---|---|---|---|---|
| 80-100% | `on-track` | Excellent | On Track | On-Track |
| 60-79% | `developing` | Good | Developing | Developing |
| 40-59% | `at-risk` | Fair | Needs Support | At-Risk |
| 0-39% | `delayed` | Needs Attention | Needs Support | Delayed |

**Two label vocabularies over one set of boundaries.** The wording differs by
audience; the cutoffs never do. This is deliberate — the contradiction the
unification removed lived in the boundaries, not the words.

Band keys are persisted to `AssessmentResult.{communication,social,cognitive,
motor}Status`. **Changing a key is a data migration, not an edit.**

### 3.2 Why 80/60/40 was chosen

1. It is what parents already saw, so unifying to it changed nothing
   parent-facing. Verified exhaustively: identical output for all scores 0-100.
2. Relative to both 51/26 and 70/40 it flags **more** children rather than
   fewer. For a screening instrument, erring toward over-referral is the safer
   direction — a false positive costs a consultation, a false negative costs a
   missed delay.
3. **Provenance remains unconfirmed** — see the warning at the top.

### 3.3 Version stamping

`AssessmentResult.scoringBandsVersion` records which band set produced the
stored `*Status` values:

- `'v2-80/60/40'` — scored under the current `ACTIVE_BANDS`.
- `null` — pre-unification document, scored under the old 51/26 bands.

Stamped on write by `routes/assessments.js` and by
`scripts/backfill-scoring-bands.js`.

---

## 4. The five pre-unification cutoff sets

Before `constants/scoring.js` existed, **five** independent cutoff sets were
live simultaneously and disagreed about the same child. This section is the
audit record.

| # | Cutoffs | Location (pre-unification) | Consumer it drove |
|---|---|---|---|
| 1 | **80 / 60 / 40** | `js/parent/results.js:19-24` (`getStatusLabel`) | Parent results page — per-domain score chips |
| 2 | **80 / 60** | `js/parent/results.js:26-30` (`getOverallStatus`) | Parent results page — overall headline + summary paragraph |
| 3 | **51 / 26** | `routes/assessments.js:74-90` (`THRESHOLD_RANGES`, `getStatus`, `getScoreThreshold`) | Persisted `*Status` fields; pediatrician patient-filter dropdown |
| 4 | **70 / 40** | `routes/recommendations.js:121-127,155-157,177` and `routes/appointments.js:551-576` | Recommendation tiers, focus areas, urgency flag, pediatrician matching |
| 5 | **51 / 26** (different vocabulary) | `routes/assessments.js:905,935` | Pediatrician review endpoint — `riskLevel`, `overallRisk` |

Set 5 was missed by an initial string search because it emitted different words
(`high`/`moderate`/`low` and `High Risk`/`Moderate Risk`/`Low Risk`) rather than
the `on-track`/`at-risk`/`delayed` vocabulary.

**Worked example of the contradiction.** A child scoring **62%** was reported as:

- *"Developing"* to the parent (set 2)
- `on-track` in the database (set 3)
- a **focus area requiring consultation** in recommendations (set 4)
- `low` risk to the reviewing pediatrician (set 5)

All four statements were produced by the same system about the same score.

---

## 5. Age: scores are NOT age-normed

**This is a documented limitation, stated deliberately.**

Age affects **which questions are asked**. It does **not** affect **how the
answers are judged**.

- **Eligibility:** screening is offered only to ages 3-8
  (`routes/assessments.js:63-65`). Outside that range the request is refused.
- **Item selection:** each item carries a `minAgeMonths` gate and a child is
  served only items at or below their age in months
  (`js/parent/screening.js:106`). Gates are 36, 42, 48, 60, 72, and 84 months,
  serving 8, 9, 19, 26, 32, and 34 cumulative items respectively.
- **Interpretation:** the scoring pipeline **never reads age**
  (`routes/assessments.js:386-422`). `scoring.getStatus()` takes exactly one
  argument — the score.

**Consequence.** A 3-year-old scored on their 8 eligible items and an
8-year-old scored on all 34 are judged against the **identical** 80/60/40
cutoffs. There is no age-specific norm, no age-adjusted cutoff, and no
standardisation against any reference population.

**Provenance of the age gates.** The `minAgeMonths` values are attributed to the
consultant pediatrician interview (`js/parent/screening.js:4`,
`models/CoreBankQuestion.js:9-11`). They are **not** traceable to any published
developmental norm, and no citation exists in the codebase.

Age-referencing is a defining property of a validated developmental screening
instrument. **KinderCura does not implement it.** Any description of the system
must state this rather than imply age-appropriate interpretation.

---

## 6. Verification: riskLevel / overallRisk (cutoff set 5)

Cutoff set 5 was folded into the shared bands via two named maps in
`routes/assessments.js` (`RISK_LEVEL_BY_BAND`, `OVERALL_RISK_BY_BAND`). Because
this changed a clinician-facing risk classification, the change was verified
exhaustively rather than by sampling.

**Method.** The pre-refactor ternaries (`< 26 → high`, `< 51 → moderate`, else
`low`) were evaluated verbatim against the new band-keyed maps for every integer
score 0-100, and the results ranked by urgency (`low` < `moderate` < `high`).

**Result.**

| Metric | Value |
|---|---:|
| Scores checked | 101 (0-100 inclusive) |
| Unchanged | 78 |
| **More urgent** | **23** |
| **Less urgent** | **0** |

**No score becomes less urgent under the new bands.** The change is
monotonically conservative: the unified bands never downgrade a child's risk
classification relative to the old set, at any score.

### 6.1 The 23 scores that became more urgent

| Score range | Old | New |
|---|---|---|
| 26-39% | `moderate` | **`high`** |
| 51-59% | `low` | **`moderate`** |

Both ranges were **gaps in the old set**. Under the old cutoffs a child at 30%
was called `moderate` while a child at 25% was `high`; a child at 55% was `low`
while one at 50% was `moderate`. The new bands close both discontinuities.

### 6.2 Internal consistency

`riskLevel` and `overallRisk` agreed with each other at all 101 scores after
unification. Previously they were two independent ternaries that happened to
share literals — nothing enforced their agreement.

### 6.3 Caveat

> "More urgent" here is a statement about **internal consistency, not clinical
> accuracy**. It means the unified bands never classify a child as safer than
> the old logic did. It does **not** mean the new classification is correct —
> that still depends on the unconfirmed 80/60/40 provenance.

---

## 7. Behaviour changes from unification

Two changes alter system behaviour. They are stated here plainly rather than
left to be discovered.

### 7.1 Recommendation tier for scores 70-79: `low` → `medium`

`routes/recommendations.js`, `RECOMMENDATION_LEVEL_BY_BAND`.

Under the old 70/40 cutoffs, a domain scoring 70-79% was `low` priority and
received the top-tier "continue what you are doing" wording. Those scores now
fall in the `developing` band and receive `medium` priority with the
"practise / expand" wording instead.

**More children now receive an actionable recommendation.** This is the intended
direction — see §3.2.

### 7.2 Focus areas: `score < 70` → `score < 80`

`routes/recommendations.js` and `routes/appointments.js`.

A "focus area" is now any domain not in the top band, i.e. below 80% rather
than below 70%. This widens the set of domains surfaced for follow-up and feeds
`consultationNeeded`, the summary text, and pediatrician matching.

### 7.3 Not changed

- **Parent-facing output** — verified identical for all scores 0-100.
- **`riskFlags`** — still generated at `< 40`, unaffected by the band move.

---

## 8. Open clinical question for the adviser

### `getSuggestedNextAssessmentDate()` — `js/pedia/pediatrician-patients.js:136-145`

This function still contains its own **40 / 60** literals, deliberately left
un-unified:

```js
if (numericScore < 40)       date.setDate(date.getDate() + 14);   // 2 weeks
else if (numericScore <= 60) date.setMonth(date.getMonth() + 1);  // 1 month
else                         date.setMonth(date.getMonth() + 3);  // 3 months
```

**Why it was not unified.** These literals select a **follow-up interval**, not
a status band. They are a different semantic from the scoring cutoffs. Mapping
them onto the four bands requires deciding whether a `developing` child (60-79%)
warrants a 1-month or a 3-month recall — a **clinical judgement, not a
refactor**.

**Note the boundary mismatch this leaves:** a score of exactly 60 is
`developing` under §3.1 but takes the `<= 60` one-month branch here, while 61 —
also `developing` — takes the three-month branch. Two children in the same band
receive different recall intervals.

**Decision required:** what recall interval should each of the four bands carry?
Once answered, this function should be driven from `constants/scoring.js` like
everything else.

---

## 9. Related files

| File | Role |
|---|---|
| `constants/scoring.js` | Single source of truth — bands, labels, colours, version stamp |
| `routes/assessments.js` | Computes and persists scores; pediatrician review endpoint |
| `routes/recommendations.js` | Recommendation tiers, focus areas, pediatrician matching |
| `routes/appointments.js` | Appointment-time focus areas and matching |
| `models/AssessmentResult.js` | Persisted scores, statuses, `scoringBandsVersion` |
| `scripts/backfill-scoring-bands.js` | Rescores stored `*Status` under current bands |
| `docs/BACKFILL-REPORT.md` | Evidence trail from the backfill run |
| `docs/AUDIT-SUMMARY.md` | Plain-language summary of the audit |
