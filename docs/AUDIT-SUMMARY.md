# KinderCura — Audit Summary

**One page, plain language.** Written for a reader who has not seen the code.
Every claim here was verified against the source and the live database.

---

## 1. What the scoring mechanism is

**KinderCura is a rule-based screening system.** Every result it produces is
computed by fixed arithmetic and threshold comparisons written by a developer.

The mechanism, in full:

1. Each question is answered *yes* / *sometimes* / *not yet*, scoring **2 / 1 / 0**.
2. Each of four domains — Communication, Social Skills, Cognitive, Motor Skills —
   gets a percentage: points earned ÷ points possible.
3. The overall score is the **unweighted average of those four percentages**.
4. The score is placed in one of four bands: **80-100 on-track, 60-79 developing,
   40-59 at-risk, 0-39 delayed**.

That is the whole system. There is no model, no learned weight, and no
statistical estimation anywhere in the result path.

**The band cutoffs are not clinically validated.** They were chosen because they
match what parents were already shown and because they err toward flagging more
children rather than fewer. Their clinical provenance is unconfirmed and is
marked as such in the code. They should not be cited as validated.

**Scores are not age-adjusted.** A child's age determines *which questions they
are asked*, but never *how the resulting score is judged*. A three-year-old and
an eight-year-old are measured against the same cutoffs. Age-referencing is a
defining property of a validated developmental screening instrument, and this
system does not implement it. This is a stated limitation, not an oversight.

---

## 2. What the `ml/` directory is — and is not

**It is:** a complete, competently written machine-learning pipeline in Python.
It can load a dataset, train a random-forest classifier, evaluate it, and save
the result. The code is real and it runs.

**It is not:** part of the system. It has never produced a model.

- The collection that stores trained models holds **zero records**.
- **No model file exists** anywhere on disk.
- The prediction path checks for an active model, finds none, and falls back to
  the rules — **on every single request, without exception**.

**No screening result this system has ever produced involved a model.**

There is also a deeper problem. When a dataset arrives without outcome labels,
the training script *generates* them using the rule engine's own cutoffs. A
model trained that way would learn to imitate the existing if/else logic. Any
accuracy figure it reported would measure how well the model memorised the
rules — approaching 100% — and would say nothing about child development.

The directory is retained deliberately, for transparency. It is exploratory work
and is now labelled as such in the admin interface: **"Experimental — not used
for live screening results."**

---

## 3. Uploaded training datasets

Three CSV files were uploaded through the admin page. **All three are
synthetically generated. None contains real child records. None has a genuine
external source.**

### The decisive finding

`kindercura_demo_training_dataset.csv` **could not have been produced by
KinderCura.**

Its `overall_score` column matches Python's "banker's rounding" (round-half-to-
even) on **60 of 60 rows**, but matches JavaScript's `Math.round` (round-half-up)
on only **45 of 60**. Twenty-seven rows land exactly on `.5`, which is where the
two methods disagree — and on those rows the file follows Python, not JavaScript.

KinderCura computes that column in JavaScript with `Math.round`. Fifteen rows
therefore differ from what this system would have written. The file came out of
a Python generator script, not the KinderCura database.

### Corroborating evidence

- **Python boolean capitalisation** — `True` / `False` throughout all three
  files, rather than the `true` / `false` a JavaScript system emits.
- **Perfect internal consistency** — all **240 of 240** answer-to-score checks
  reproduce exactly. Real clinical data contains noise and transcription error;
  formula-generated data does not.
- **Templated free text** — only **6 distinct** diagnosis strings across 60 rows,
  every one of the form *"Needs follow-up support in {domains}."* Clinicians do
  not write from a template.
- **Gapless sequential identifiers** — `KC-DS-0001` through `KC-DS-0060`, and
  `ECDI-0001` through `ECDI-0050`, with no gaps or duplicates.
- **A self-declaring column** — the third file's `instrument_name` field reads
  **`demo_childdevdata_style` on all 952 rows**.

### On the instrument names

**ECDI2030 (UNICEF)** and **D-score / childdevdata** are real, respected
developmental instruments. These files **imitate their column shape and contain
none of their data.** The filenames gesture at real instruments; the contents do
not come from them. The admin interface now labels each as a
**"Synthetic demo fixture"** with the note *"named after ECDI2030 (UNICEF) —
contains none of its data."*

### A counter that was reporting a falsehood

The admin page displayed **"Models Trained: 3"**. That number came from a status
flag on the uploaded-dataset records — a flag set by a code path that only
*registers* an uploaded file. The collection that actually stores trained models
contained, and still contains, **zero documents**.

The counter now reads from the model collection directly and correctly shows
**0**, alongside an explicit note that three datasets were flagged as trained
without producing a model. The stored status values themselves have been
corrected from *"trained"* to *"registered"*, because the database should not
assert something untrue.

---

## 4. How many usable training rows exist

**Zero.**

| | Count |
|---|---:|
| Answers recorded | 767 |
| Completed screenings | 11 |
| **Screenings with a confirmed clinical outcome** | **0** |

Only the third row is training data.

Training requires labelled examples — screenings where a clinician recorded what
they actually concluded, independently of what the system computed. No such field
existed. The only free-text diagnosis in the entire database was the string
**"Yes please"**, which the system accepted because it checked merely that the
field was non-empty.

Both problems are now fixed: a structured clinical-outcome field has been added
alongside the free-text note, and trivial entries are rejected.

---

## 5. What would be required before any ML claim could be made

In order. None of these can be skipped.

1. **Collect real outcome labels.** Pediatricians must record a structured
   conclusion for each reviewed screening. The field now exists; it needs to be
   used. **Currently: 0 labels.**
2. **Reach a defensible sample size.** Eleven screenings cannot train or validate
   anything. This needs to be in the hundreds, across a real spread of ages and
   outcomes.
3. **Stop deriving labels from the rules.** While the training script invents
   labels from its own cutoffs, any model it produces is imitating the rules
   rather than learning from clinical reality.
4. **Hold out a genuine test set** of labelled real cases never seen in training.
5. **Report honest metrics** — accuracy, precision, recall, and a confusion
   matrix — computed on that held-out set. No confusion matrix is currently
   computed anywhere.
6. **Compare against the rule-based baseline.** A model is only worth deploying
   if it beats the existing rules on real labelled data.

Until step 1 produces a non-zero count, **no machine-learning claim of any kind
is supportable.**

---

## 6. The honest position

> KinderCura is a rule-based pediatric developmental screening tool with an
> exploratory machine-learning module that has never been operational. All
> screening results come from transparent, inspectable rules. The system has no
> training data and has never trained a model.

This is a legitimate and defensible system. A transparent, clinician-informed
rule set is auditable in a way a trained model is not — every result can be
traced to a specific answer and a specific threshold, which matters in a
pediatric context.

**The risk to this project is not the absence of machine learning. It is
describing the system as something it is not.** Everything documented here is
now reflected in the interface and the code, so the system describes itself
accurately to anyone who looks.

---

*Companion documents: `docs/SCORING.md` (full scoring protocol and verification),
`docs/BACKFILL-REPORT.md` and `docs/DATASET-STATUS-MIGRATION.md` (data-change
evidence trails).*
