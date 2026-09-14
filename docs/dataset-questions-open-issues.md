# Dataset Questions — open blocking issues

**Status: nothing here is implemented.** This file is a register, not a plan of
record. It was written on 2026-08-28 alongside the wording revision of the 16
Dataset Questions (`constants/datasetQuestions.js`).

**None of these may be started without explicit sign-off.** They are listed
here so the list exists in the repo rather than in a chat log.

## What is true today

| | |
|---|---|
| Dataset Questions defined in code | 16 |
| Written to the database | 0 |
| Active | 0 |
| Approval status | all `pending_pediatrician_approval` |
| Reviewer decision (wording only) | Approve 16 / Revise 0 / Reject 0 — round 2, 2026-08-28 |
| Pediatrician sign-off | **not obtained** |
| Pediatrician review packet | ready — `npm run packet:dataset-questions` (writes `build/dataset-question-review-packet.html`) |

The 2026-08-28 content review produced reviewer *recommendations*. It was not a
licensed pediatrician review, and nothing in it constitutes approval.

The pediatrician review packet is the review workflow for this stage. It is
generated read-only from `constants/datasetQuestions.js` (wording, sources,
citations, verbatim source items) plus the `DATASET_REVIEW` record and the
hand-written mapping commentary in the build script. For each question it
offers **Approve / Revise / Reject** and a free-text note, carries DQ09's open
clinical mapping question, and states that a decision in the packet does not
change `approvalStatus` and does not activate anything. Only a pediatrician
`approved` on a seeded row lets `models/CoreBankQuestion.js` accept
`isActive: true`. The admin **Question Origin** page shows the reviewer
decision, the pediatrician approval, and the active state as three separate
facts.

`models/CoreBankQuestion.js` refuses to set `isActive: true` on a
`dataset_question` whose `approvalStatus` is not `approved`, so none of these
questions can reach a parent by accident while the issues below are open.

---

## 1. Age-gating — BLOCKING

The set mixes three target ages: 3;6 (42mo), 4;0 (48mo) and 5;0 (60mo).

| Target age | Questions |
|---|---|
| 42 months | DQ08, DQ15, DQ16 |
| 48 months | DQ01, DQ02, DQ05, DQ06, DQ09, DQ10, DQ13, DQ14 |
| 60 months | DQ03, DQ04, DQ07, DQ11, DQ12 |

Serving all 16 to every child regardless of age makes the result
uninterpretable: a 3-year-old scored against 5-year milestones will fail items
they are not expected to have reached, and the total will read as a deficit
that is really an artefact of the instrument.

`minAgeMonths` is already stored per question, so the data supports gating —
but no gating rule has been written or agreed.

Also required: **a documented rule for corrected age in preterm children.**
Which gestational-age cutoff, up to what chronological age correction applies,
and where the correction is computed. Undocumented, this silently varies.

## 2. "Sometimes" is undefined, and there is no scoring or referral rule — BLOCKING

The answer scale is Yes / Sometimes / No, scored 2 / 1 / 0 by
`routes/assessments.js`. For these 16 questions:

- **"Sometimes" has no definition.** Not in frequency, not in consistency, not
  in degree of support. Two parents can mean opposite things by it.
- **There is no scoring rule** for the Dataset Question set — no agreed total,
  no per-domain cut, no weighting decision.
- **There is no referral threshold**, so no score can currently be turned into
  an action.

Nothing here should be inferred from the existing core-bank scoring. That was
built for a different question set and its thresholds were not derived for
these items.

## 3. Missing items — BLOCKING

Two questions are absent that a screening set of this kind should carry, and
both must route **outside** domain scoring:

1. **Parental concern.** An open question asking whether the parent has any
   concern about their child's development. Parental concern carries
   independent signal and must not be diluted by being averaged into a domain.
2. **Skill regression.** Whether the child has lost a skill they previously
   had. Regression is a distinct flag, not a low score, and must route directly
   to review regardless of the rest of the result.

Both need a defined route: what happens when they are positive, and who sees it.

## 4. Parent-facing output text — unreviewed, BLOCKING

No parent-facing wording for these questions' results has been reviewed.

Hard constraints to enforce and then verify. The output must **never** produce:

- a diagnosis of any kind
- a risk score or risk category shown to a parent
- a percentile or normative rank
- the words **"delayed"** or **"at risk"**

CDC states on both cited pages that Learn the Signs. Act Early. materials are
not a substitute for standardized, validated developmental screening tools.
Nothing derived from them is one either, and the parent-facing text must not
imply otherwise.

## 5. Licence confirmation — BLOCKING, and legal rather than clinical

Confirm the terms under which we may build on each source. **A pediatrician
cannot sign this off; it needs whoever handles legal/IP for the project.**

- **CDC Learn the Signs. Act Early.** — confirm the reuse terms for the
  milestone checklists, including whether attribution wording is prescribed.
- **Iles-Caven et al. (2016), Data in Brief 9:112–122** — confirm the licence
  covering the article and its Appendix A item tables.

Note what we actually store: our questions are newly written adaptations, but
`sourceItemVerbatim` in `constants/datasetQuestions.js` holds each source
item's exact text for review purposes. That is the part with a licence
question attached.

## 6. Translation and back-translation — BLOCKING

Three items now say "in any language your child speaks" (DQ03, DQ09, DQ11),
which makes the language question explicit but does not answer it.

Required: translation, independent back-translation, reconciliation, then **a
second clinical review of the translated set** — a translated item is a new
item and does not inherit the original's review.

DQ03 needs specific attention: its rhyme examples were deliberately removed
from the question text because a rhyme pair only works in the language it was
written for. **Each translation must supply its own rhyme example.**

## 7. DQ16 — choking/strangulation note: FINDING, ruling still needed

> DQ16: *Can your child put beads or other small objects onto a string or
> shoelace one after another?*

**What I checked.** The parent screening flow (`js/parent/screening.js`)
renders questions for a parent to answer about behaviour already observed. I
found no "try this activity" prompt anywhere in `js/parent/` — no
demonstrate/show-your-child/ask-your-child-to pattern. Dataset Questions are
also not served to parents at all today: the parent flow renders the hardcoded
`DOCTOR_QUESTION_BANK` and never reads this collection.

**So, on the strict reading of the question as asked — does the app prompt a
parent to TRY threading beads? — the answer today is no, and no note is
required.**

**The residual risk, which is a judgement call and not mine to close.** The
wording begins "Can your child…", which invites a parent who has not observed
the behaviour to go and test it. Beads and small objects are a choking hazard
for younger siblings, and a string or shoelace is a strangulation hazard.
Nothing in the app would stop a parent staging that trial unsupervised.

Options, for a ruling:

1. Add a supervision note to DQ16 regardless, on the grounds that the wording
   invites a trial even though the app never asks for one.
2. Reword to ask only about observed behaviour ("Have you seen your child…"),
   removing the invitation.
3. No note — the app never prompts a trial, and the record above says so.

This must be settled **before** any Dataset Question is activated, not after.

---

## Order of operations

Issues 1–6 are blocking and independent of one another. Issue 7 needs a ruling
but not implementation work.

Recommended sequence: settle **5** (licence) first, because a negative answer
there changes what the rest of the work is for.
