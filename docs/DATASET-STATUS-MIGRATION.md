# Dataset Status Migration Report

**Generated:** 2026-08-04T06:10:02.232Z
**Mode:** APPLY (writes)
**Change:** `status: 'trained'` → `status: 'registered'`

## Why

`TrainingDataset.status` was set to `'trained'` by a code path that only
registers an uploaded file. No model artifact was produced. Keeping the value as
`'trained'` makes the database assert something untrue.

A dataset is migrated **only** when it has no `modelId` and no corresponding
`TrainedModel` document. Anything that genuinely produced a model is left alone.

## Summary

| Metric | Value |
|---|---:|
| Datasets examined | 3 |
| Migrated to `registered` | 3 |
| Skipped (kept `trained`) | 0 |

## Migrated

| Dataset | Rows | From | To | Reason |
|---|---:|---|---|---|
| `kindercura_demo_training_dataset` | 60 | `trained` | `registered` | no modelId and no completed TrainedModel — nothing was trained |
| `ecdi2030_style_demo_dataset` | 50 | `trained` | `registered` | no modelId and no completed TrainedModel — nothing was trained |
| `dscore_childdevdata_style_demo_dataset` | 952 | `trained` | `registered` | no modelId and no completed TrainedModel — nothing was trained |

## Skipped

| Dataset | Reason |
|---|---|
| _none_ | — |

## Not touched

- Every uploaded file in `uploads/datasets/` — nothing deleted or moved.
- All other `TrainingDataset` fields, including `trainedAt` and
  `trainingSummary`, which remain as the historical record of what happened.
- The `ml/` directory and every `TrainedModel` document.
