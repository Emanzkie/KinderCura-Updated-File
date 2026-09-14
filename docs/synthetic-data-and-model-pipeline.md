# Synthetic data & model pipeline

Two separate requirements, two separate mechanisms. Conflating them is the
single most common misreading, so this document keeps them apart throughout.

| | **Requirement A — system data** | **Requirement B — model dataset** |
|---|---|---|
| Purpose | Give the existing Admin Analytics page enough records to aggregate | Give the ML classifier enough rows to train on |
| Size | 1,500 user accounts (+ ~5,300 related records) | 50,000 assessment records |
| Lives in | MongoDB (`users`, `children`, `assessments`, `results`, `appointments`) | A CSV file, registered as one `training_datasets` document |
| Built by | `scripts/generate-system-demo-data.js` (Node) | `ml/pipeline.py` (Python) |
| Becomes login accounts? | Yes — 1,500 accounts, no usable password by default | **Never.** 50,000 dataset rows create zero accounts |
| Reversible by | `--purge --yes` (matches `isSynthetic: true` only) | Deleting the dataset on the Training page |

**The 50,000 model records are not 50,000 users.** They are simulated
*assessments* — rows of scores and answers with a `risk_category` label. They
never enter `users`, never appear in Analytics, and never create a child or an
appointment.

---

## Quick reference

```bash
# Requirement A — synthetic system data
npm run demo:generate:dry      # plan and report, write nothing
npm run demo:generate          # 1,500 accounts + children/assessments/results/appointments
npm run demo:verify            # synthetic vs real counts per collection
npm run demo:purge             # delete every isSynthetic:true document (all batches)

# Batches are independent datasets and can coexist:
node scripts/generate-system-demo-data.js --users=40 --batch=scratch
node scripts/generate-system-demo-data.js --purge --batch=scratch --yes

# Requirement B — 50,000-record model dataset
npm run dataset:generate               # generate -> clean -> train, end to end
npm run dataset:generate:clean-only    # generate + clean, no training
npm run dataset:canonical              # regenerate the committed 60-row reference file

# Tests
npm test                       # Node unit tests (includes the synthetic-data contract)
npm run test:ml                # Python trainer + canonical dataset suites
```

---

## Requirement A — 1,000+ synthetic system users

### What gets created

Running `npm run demo:generate` (1,500 accounts, seed `20260903`) produces:

| Collection | Documents |
|---|---|
| `users` | 1,500 |
| `children` | 1,530 |
| `assessments` | 1,668 |
| `results` | 1,187 (one per *completed* assessment) |
| `appointments` | 1,091 |

Role mix: 1,215 parent · 105 legal_guardian · 45 foster_parent ·
30 court_appointed · 68 pediatrician · 37 secretary · **0 admin**.

### The safety contract

The local `.env` and the production deployment point at the **same Atlas
database**, so every promise below is enforced in code, not by convention.
See `constants/syntheticData.js`.

1. **Marked.** Every synthetic document carries `isSynthetic: true` and
   `syntheticBatch`. Both default to `false`/`null`, so every document that
   predates this feature reads correctly as real with no migration.
2. **Addressable.** Each `_id` is derived from a namespaced SHA-1 of the batch
   label plus a stable reference string
   (`syntheticObjectId('demo-2026', 'user:42')`). The same pair always yields
   the same `_id`, so re-running the generator **upserts** rather than
   inserting duplicates. Verified: two consecutive runs leave the counts
   unchanged.
   *The batch must be part of the address.* Without it, `user:0` names the same
   document in every batch, so a second batch silently overwrote the first
   batch's users with different people while their children and assessments
   kept pointing at those ids. The same applies to `username`, `email` and the
   numeric `Appointment.id`, all of which carry unique indexes and are all
   namespaced by batch.
3. **Collision-guarded.** Before each write phase, `assertNoRealCollisions()`
   checks that no `_id` about to be written already belongs to a
   non-synthetic document, and aborts the whole run if one does.
4. **Reversible.** `--purge` deletes on `{ isSynthetic: true }` and nothing
   else, and refuses to run without `--yes`. It is structurally incapable of
   reaching a real record. With no `--batch` it removes every synthetic batch;
   with `--batch=<label>` it removes only that one.
5. **Counter-safe.** `Appointment.id` is a number allocated from a shared
   `counters` document. Synthetic appointments take theirs from a reserved
   block starting at 9,000,000 instead, so demo data never advances the real
   booking sequence.

### What it deliberately does *not* fabricate

- **No admin accounts.** The role exists; synthetic data never creates one.
- **No clinical judgements.** `clinicalOutcome`, `mlLabel`, `mlReviewStatus`,
  `diagnosis` and `reviewedByPediatrician` are left at their defaults. This
  guarantees a synthetic screening can never be exported as reviewed ML
  training data by `GET /api/admin/training/reviewed-assessments/export`.
- **No payment transactions.** Synthetic appointments record what they were
  *billed* (`totalAmount`, from the pediatrician's `consultationFee`) and stay
  `Unpaid`, because no money moved. Analytics' "total collected" therefore
  continues to reflect real `payments` documents only.
- **No usable passwords.** Every account gets a bcrypt hash of a random secret
  that is discarded immediately, so none can be signed into. Pass
  `--demo-password=<pw>` if a synthetic login needs to be demonstrated.
- **No assessment answers, by default.** `--with-answers` persists the ~28,000
  per-question rows the scores were computed from. It is opt-in because the
  Question Origin page reports how many times each question has actually been
  answered, and writing tens of thousands of synthetic answers would make that
  page describe demo traffic instead of real usage. The stored scores are
  identical either way.

### How the scores are produced

Not random numbers. Each synthetic child is assigned a developmental profile
(`typical` 62% / `watch` 26% / `concern` 12%), the **live core-bank question
bank** is read from MongoDB, age-gated questions are skipped exactly as the
real screening skips them, and answers are sampled from that profile. The
domain percentages are then computed with the same arithmetic
`routes/assessments.js POST /submit` uses, and banded through
`constants/scoring.js` — not a second copy of the cutoffs. The stored
`prediction` snapshot is recorded honestly as `rule_based` with
`riskCategory: null`, because no ML model was consulted.

### Verifying it

```bash
npm run demo:verify
```

or open **Question Origin / Data Sources → System Demo Data**, which counts
the live collections on every load and evaluates the "> 1,000 users" threshold
against the actual number rather than asserting it.

---

## Requirement B — the 50,000-record model dataset

### The flow

```
generate            ml/datasets/generate_kindercura_dataset.py
   ↓
clean / preprocess  ml/preprocess.py
   ↓
train               ml/trainer.py          ← the EXISTING trainer, unchanged
   ↓
metrics + artifact  trained_models + uploads/models/*.joblib
```

`ml/pipeline.py` orchestrates all three. It does not reimplement any of them.

### Running it

```bash
npm run dataset:generate          # python ml/pipeline.py --rows 50000
```

Options: `--rows`, `--seed`, `--feature-set score_based|question_based`,
`--defect-rate`, `--normalize`, `--skip-training`, `--json`.

Reproducible: the same `--rows` and `--seed` always produce the same dataset.

### Or from the admin UI

**Question Origin / Data Sources → Model Dataset Pipeline**

1. **Generate & Clean** → `POST /api/admin/dataset-pipeline/generate` runs the
   generate + clean stages and registers the cleaned CSV as a
   `TrainingDataset` with `provenance.sourceType: 'synthetic'`.
2. **Send to Model** → `POST /api/admin/training/:id/train` — **the same
   endpoint the Training page's Process button calls.** There is one training
   implementation, not two, so the synthetic dataset goes through the same
   quality gate and the same candidate/active model lifecycle as any
   hand-uploaded dataset.

Generation needs a local Python 3 with pandas/scikit-learn. On a deployment
without one (Vercel), the panel reports it and the endpoint returns 503 with
instructions to generate locally and upload through the existing form.

### Why defects are injected on purpose

A generator that only emits perfect rows makes the cleaning stage untestable —
"invalid: 0, duplicates: 0" every run proves nothing. `--defect-rate` (default
0.02) corrupts a seeded, counted fraction of rows with realistic faults, and
the report states exactly how many of each kind were injected, so the cleaning
counts can be reconciled against a known number.

From the run recorded on 2026-09-03 (seed 20260903, 50,000 rows):

| Injected | Count | Outcome |
|---|---|---|
| missing score | 152 | rejected (`missing_or_non_numeric_score`) |
| invalid label | 163 | rejected (`invalid_or_missing_risk_category`) |
| out of range | 163 | rejected (`score_out_of_range_0_100`) |
| invalid answer | 173 | rejected (`unrecognized_answer_value`) |
| missing age | 170 | **recovered** — imputed with the median (66) |
| duplicate | 179 | 217 removed by exact-duplicate detection |

Every injected defect is accounted for. Duplicates removed (217) exceeds
duplicates injected (179) because at 50,000 rows the generator also produces
some *coincidentally* identical rows — same answers, same scores, same label —
which are genuine duplicate observations and are removed for the same reason.
At small row counts the two numbers match exactly; a 500-row run with
`--defect-rate 0.05` injected 3 duplicates and removed exactly 3.

### The cleaning report

```
Original records:       50,179
Valid records:          49,528
Invalid records:            651
Duplicates removed:         217
Final training records: 49,311
```

Definitions, so the arithmetic always closes exactly:

- `original_records` — rows read from the raw file (more than 50,000 because
  injected duplicates are *appended*).
- `duplicates_removed` — exact duplicate observations, compared on the feature
  and target columns but **not** `assessment_ref`: two rows with identical
  answers, scores and label are the same observation counted twice regardless
  of their reference ids.
- `invalid_records` — rows dropped for a stated, itemised reason.
- `valid_records` = original − invalid.
- `final_records` = original − duplicates − invalid = rows written.

Duplicates are removed *before* validity is assessed, so no row is counted in
both buckets.

### Two decisions worth knowing about

**Normalization is off by default.** The model is a `RandomForestClassifier`,
which splits on thresholds and is completely scale-invariant — min-max scaling
would change nothing about the fitted trees while destroying the "these columns
are percentages" contract that `constants/scoring.js`, the admin pages and
`ml/predict.py` all rely on. The min/max/mean statistics are recorded either
way, so the decision is visible rather than silent. `--normalize` applies it.

**The `-1` sentinel is not written into the clean file.** A blank `Q0N` cell
means "not administered" (the age gate), which is different from a "no" answer.
`ml/trainer.py` encodes that as `-1` itself. Writing `-1` into the file would
make the trainer's own encoder reject it as an unrecognized answer value, so
blanks stay blank and the sentinel is applied at train time.

### Actual metrics from the recorded run

Model **v4**, dataset `syn-20260903-50000-20260903013646`, feature set
`score_based`, trained 2026-09-03 09:40:

| Metric | Value |
|---|---|
| Accuracy | 0.6320 |
| Precision (weighted) | 0.6287 |
| Recall (weighted) | 0.6320 |
| F1 (weighted) | 0.6297 |
| Training samples | 39,448 |
| Test samples | 9,863 |
| Total rows | 49,311 |
| Rows dropped by the trainer | 0 |
| Class distribution | Medium 19,469 · High 15,133 · Low 14,709 |

**Why ~63% and not ~99%.** The generator picks each row's class *first*, then
samples answers from heavily overlapping class-conditional distributions, then
perturbs ~18% of labels to a neighbouring class *after* the scores are fixed.
`risk_category` is therefore never a threshold of `overall_score`. A model that
scored 99% here would be evidence of data leakage — that the "ground truth" was
just a restatement of the score cutoffs — not of a good model. Roughly 63%
against a 33% three-class baseline is the honest ceiling this data allows.
See `ml/datasets/README.md` §6.

The model is saved as a **candidate**: `isActive: false`. It does not affect
any live prediction until an admin explicitly activates it in Trained Models.

---

## Model activation, rollback and deactivation

Managed from **Training → Trained Models**. Three actions, all admin-only.

### Activation

`POST /api/ml/models/:modelId/activate`

1. **Document gate** (`getModelActivationBlocker`) — status must be
   `completed`, a `modelPath` must be recorded, and no feature column may be
   one the current `ml/predict.py` cannot handle.
2. **Smoke test** (`modelManager.smokeTestModel`) — the artifact is read, and
   **one real prediction is run** through the same `getPrediction()` path live
   predictions use. This is what catches a model whose document looks fine but
   whose `.joblib` is missing, unreadable, or trained on different columns than
   the database claims.
3. **Swap** (`performModelActivation`) — every other model is deactivated
   *first*, then the chosen model is activated, then the result is **verified**
   with a count. If more than one model is somehow active, the write is
   repaired and, failing that, throws rather than reporting success.

A failure at step 1 or 2 returns **409 and changes nothing**.

### Rollback / switching

Rollback is the same operation pointed at an earlier model — there is no
separate code path, so a rollback is subject to exactly the same smoke test as
a forward switch. Activating v2 while v4 is active deactivates v4 and makes v2
the only active model.

**Nothing is ever deleted.** A deactivated model keeps its document, its
metrics and its `.joblib` file, which is precisely what makes rollback
possible. Verified end to end on the live database:

```
v1 → activate v2 → active: v2  (v1 deactivated, kept)
     activate v3 → active: v3  (v2 deactivated, kept)
     activate v2 → active: v2  (v3 deactivated, kept)   ← rollback
     deactivate  → active: none (rule-based fallback)
all four documents and all four .joblib artifacts still present afterwards
```

### Deactivation

`POST /api/ml/models/deactivate` sets `isActive: false` everywhere and returns
the system to the **rule-based fallback**. This is the only way to turn ML off
without switching to another model. It is a flag change only.

### Invariants

| Guarantee | Enforced by |
|---|---|
| At most one active model | deactivate-first ordering + post-write count check |
| No model activates without a working prediction | smoke test in `runActivationPreflight` |
| v1 (`gender_encoded`) can never be activated | `isModelCompatible` → 409 |
| Nothing is deleted on deactivation | flag-only writes; asserted in tests |
| Existing results never recalculated | `AssessmentResult.prediction` is written once by `POST /submit` and never recomputed |
| ML unavailable → still works | `getMLCareStage()` returns null → rule-based path |

### Why v1 cannot be rolled back to

v1 was trained with a `gender_encoded` feature that `ml/predict.py` no longer
supports. Its artifact genuinely cannot predict:

```
$ python ml/predict.py --model uploads/models/kindercura_model_20260813_034229.joblib --data '{...}'
{"success": false, "error": "Missing required feature: gender_encoded"}
```

So v1 being "active" today is inert — every read path checks compatibility
first and falls back to rule-based. **v2 and v3 are the real rollback
targets** (they share one artifact — they are the duplicate pair from the
`ownsModelDoc` bug). Making v1 usable again would require retraining under the
current feature set, which is what the blocker message says.

---

## Verification checklist

| Claim | How to check |
|---|---|
| More than 1,000 users exist | `npm run demo:verify`, or Data Sources → System Demo Data |
| Related child/assessment records exist | Same panel — per-collection synthetic vs real counts |
| Analytics reads actual MongoDB records | `routes/admin.js:845` is pure aggregation; delete synthetic data and every number falls back |
| No real patient information is used | Names come from fixed pools; every email is `@synthetic.kindercura.test` (RFC 2606 `.test`); no real record is read or written |
| Real data is untouched | The "Real" column in the verification panel is unchanged before and after a run |
| 50,000 dataset records exist | Data Sources → Model Dataset Pipeline → Generation, or the `*_raw.csv` in `ml/datasets/generated/` |
| The dataset passes validation | Cleaning table — rejections itemised by reason |
| The dataset is cleaned | The reconciliation line: `50,179 − 217 − 651 = 49,311` |
| The cleaned dataset reached the model | `TrainedModel.totalRows` (49,311) equals the dataset's `final_records`, and `datasetId` points at that dataset |
| Training actually ran | A `.joblib` artifact exists at `TrainedModel.modelPath`, with a real `trainedAt` |
| Metrics are real | They are `ml/trainer.py`'s own output; re-run `npm run test:ml` to re-derive the pipeline from scratch |
| The two requirements stay separate | `users` holds 1,506 documents, not 50,000; the dataset holds 49,311 rows and zero accounts |

---

## Known limitations

- **Synthetic pediatricians appear in the parent booking list.** This is the
  one place demo data is visible to a non-admin. `GET
  /api/appointments/pediatricians/list` now returns 63 synthetic pediatricians
  alongside the real one, so a parent choosing a doctor would see them — and
  those accounts have no usable password, so nobody would ever respond to the
  booking.

  This is an unavoidable consequence of the requirement itself: the demo
  records have to live in the real collections for Admin Analytics to
  aggregate them. Whether that is acceptable is a product decision, so it has
  been left as-is rather than changed unilaterally. **If you want real-only
  booking**, add one condition to `buildSuggestedPediatricians()` in
  `routes/appointments.js`:

  ```js
  // exclude demo accounts from the parent-facing booking list
  isSynthetic: { $ne: true },
  ```

  Analytics is unaffected either way — it counts documents, not booking
  eligibility. The alternative is to generate fewer pediatricians
  (`ROLE_MIX` in the generator), which reduces but does not remove the effect.

- **`GET /api/admin/users` is unpaginated.** It returns all 1,506 users in one
  response (~2.2s, 1,506 rendered rows). It works, but the Users page is
  noticeably slower than with 6 users. Pre-existing design; not changed here.
- **Analytics "User Growth vs last month"** compares the *partial* current
  month against the *complete* previous one, so it reads negative mid-month.
  Pre-existing calculation in `js/admin/admin-analytics.js`.
- **Dataset generation needs local Python.** Not available on Vercel; generate
  locally and upload the cleaned CSV through the existing form.
- **`trained_models` v2 and v3 are one training run**, duplicated by a bug
  fixed in this change (`ownsModelDoc`). The historical pair is left in place
  rather than rewritten.
- **The dataset's labels are fabricated.** They are simulated for this project,
  not sourced from real clinical outcomes, so the metrics measure the model's
  ability to learn a synthetic pattern — not clinical validity. Real validity
  needs pediatrician-reviewed labels; that path already exists via
  `Assessment.mlLabel` and the reviewed-assessment export.
