# Dataset Questions — review round 2 note

> **Record only.** The block below is the reviewer's note, reproduced verbatim
> as received on 2026-08-28. It is a record for the dev team and for the
> pediatrician. It is **not** a task list, and several lines in it are warnings
> addressed to people rather than instructions to act on. Do not edit the
> quoted text; add any response below it instead.

---

```
DATASET QUESTIONS — REVIEW ROUND 2 RESULT
Marked 28 August 2026

STATUS: All 16 marked Approve on WORDING ONLY.

These marks come from a structured clinical content review, NOT from our
pediatrician. They are reviewer recommendations. Pediatrician sign-off is still
outstanding. Do not read 16/16 Approve as clearance to activate.

Keep all 16 at pending_pediatrician_approval / isActive: false.

VERIFIED THIS ROUND
All 9 wording revisions applied exactly as recommended. The 7 previously
approved questions are untouched. DQ15 now cites ALSPAC Table A4 item 30 only —
item 26 correctly removed.

RULING ON ISSUE 7 (DQ16 bead/choking residual risk)
Do not change DQ16. Instead add one global instruction at the top of the whole
assessment: "Answer from what you have already seen your child do. You do not
need to test anything." This resolves DQ16 and every future physical item at
once, and it also stops parents coaching or drilling a child to pass — which
would damage the validity of every item, not just this one.

CAVEAT ON THE LOOSENED TEST
The unit test in tests/unit/dataset-questions.test.js was relaxed to allow a
trailing parenthetical after the question mark, so DQ12 would pass. Justified
here, but the guard is now weaker for ALL future items, not just DQ12. It will
no longer catch a malformed stem of that shape. Flag this when new questions are
added.

DQ09 IS THE ONE MOST LIKELY TO CHANGE
"At least three" is still our number, not CDC's — the source says "a few" and
sets none. Three is more defensible than four at age 4;0, but it should be
verified against whichever norm reference we standardise on. If the pediatrician
overrules it, that is expected, not a process failure. DQ09 keeps its open
mapping question flag even though it is marked Approve.

DQ12 DISPLAY NOTE
The stem is now ~30 words. If the UI has a helper-text field below the question,
move "(Do not count time spent on a phone, tablet, or TV.)" there. Same clarity,
easier to read. Display change only, no rewording.

STILL BLOCKING — nothing may go live until these are resolved
See docs/dataset-questions-open-issues.md. The two that matter most: age-gating
across the 3;6 / 4;0 / 5;0 bands, and the undefined "Sometimes" plus missing
scoring and referral rules. Parent-facing output text has still not been
reviewed by anyone.
```

---

## Where this note was acted on

Recorded 2026-08-28. Nothing in the note was treated as an instruction; the
items below were handled under a separate, explicit request.

| Note item | Where it stands |
|---|---|
| Loosened-test caveat | Documented at the assertion in `tests/unit/dataset-questions.test.js`. Test **not** re-tightened. |
| DQ09 open mapping question | Still flagged in `constants/datasetQuestions.js` and in the review packet, as the note requires. |
| Global assessment instruction (issue 7 ruling) | **Not implemented.** Placement identified but it lands in unreviewed parent-facing text — see `docs/dataset-questions-open-issues.md` §4 and the note below. |
| DQ12 helper-text move | **Investigated only, not implemented.** Findings below. |
| Still-blocking list | Unchanged in `docs/dataset-questions-open-issues.md`. |

### Global assessment instruction — placement, not implemented

The natural home is `PARENT/screening.html`, in the hero card above the
question flow, where line 52 already reads *"Answer each question based on what
you observe about your child."* — roughly the first half of the proposed
sentence, missing the "you do not need to test anything" half.

That is parent-facing template text which **no one has reviewed** (open issue
4). It is also the live core-bank assessment: Dataset Questions are not served
to parents at all yet, so editing it changes the existing 34-question
experience immediately, for every parent, ahead of any review. Flagged and left
alone.

### DQ12 helper text — investigated

`js/parent/screening.js` renders a `.assessment-helper-text` line directly
below the question stem, so a slot exists — but it is already occupied, and
there is no per-question field behind it:

- core-bank questions render `"<difficulty> difficulty • Scored under <domain>"`
- pediatrician questions render `"Assigned by Dr. X • <domain>"`

Moving DQ12's parenthetical there would need a new per-question field, a
renderer change, and a decision about what happens to the text currently in
that slot. Not a display-only change. Not implemented.

Separately, and outside the scope of that request: that slot currently shows a
parent the item's **difficulty and scoring domain**. That is scoring internals
rendered to parents, and it belongs in the open-issue 4 review of parent-facing
output text.
