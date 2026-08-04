# Scoring Bands Backfill Report

**Generated:** 2026-08-04T02:46:00.078Z
**Mode:** APPLY (writes)
**Target version stamp:** `v2-80/60/40`

## Active bands

```
   80-100 → on-track
   60-79  → developing
   40-59  → at-risk
    0-39  → delayed
```

> Band cutoffs 80/60/40 unconfirmed — pending confirmation from consultant
> pediatrician. Do not cite as clinically validated.

## Summary

| Metric | Value |
|---|---:|
| Result documents examined | 11 |
| Already stamped `v2-80/60/40` (skipped) | 0 |
| Documents with ≥1 status change | 4 |
| Individual status fields changed | 7 |
| Documents restamped | 11 |

## Per-document changes

| Result _id (tail) | Domain | Score | Before | After |
|---|---|---:|---|---|
| `…533f74` | motor | 67% | `on-track` | `developing` |
| `…9a8ec1` | cognitive | 75% | `on-track` | `developing` |
| `…9a8ec1` | motor | 60% | `on-track` | `developing` |
| `…36e0e6` | social | 64% | `on-track` | `developing` |
| `…36e0e6` | motor | 65% | `on-track` | `developing` |
| `…d38fa1` | communication | 33% | `at-risk` | `delayed` |
| `…d38fa1` | cognitive | 75% | `on-track` | `developing` |

## What was not touched

- `riskFlags` — generated from a <40% threshold, unchanged by the move to 80/60/40.
- All score fields, `childId`, `assessmentId`, `generatedAt`.
- Every `Assessment`, `AssessmentAnswer`, and `CoreBankQuestion` document.
