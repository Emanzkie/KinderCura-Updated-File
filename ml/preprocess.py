"""
KinderCura dataset cleaning / preprocessing
===========================================

Turns a raw generated dataset (ml/datasets/generate_kindercura_dataset.py)
into a clean, training-ready dataset that ml/trainer.py accepts, and emits a
report whose every number comes from the actual run.

    DATASET -> [ THIS FILE ] -> CLEAN DATASET -> ml/trainer.py -> METRICS

Pipeline stages, in the order they run
--------------------------------------
    1. Load the dataset (CSV or JSON).
    2. Validate the schema        -> hard failure if a required column is absent.
    3. Remove duplicate records.
    4. Validate the target label  -> drop rows with no usable risk_category.
    5. Coerce numerics, then handle missing values:
         age_months  -> imputed with the median (optional feature).
         domain/overall scores -> NOT imputable; the row is dropped.
    6. Reject impossible values   -> a percentage outside 0-100, an implausible age.
    7. Reject inconsistent values -> overall_score that contradicts the four
                                     domain scores it is supposed to summarize.
    8. Encode categorical answers -> Q0N cells normalized to 0/1/2.
    9. Normalize numerics         -> OPT-IN only; see NORMALIZATION below.
   10. Write the clean dataset and the report.

Why "Valid records" and "Final training records" are different numbers
----------------------------------------------------------------------
    original_records    rows read from the input file
    duplicates_removed  exact duplicate observations dropped in stage 3
    invalid_records     rows dropped in stages 4-8 for a stated reason
    valid_records       original_records - invalid_records
    final_records       original_records - duplicates_removed - invalid_records
                        (= the row count actually written to the clean file)

A duplicate is removed BEFORE validity is assessed, so no row is ever counted
in both buckets and the arithmetic above always closes exactly. Every one of
these numbers is produced by counting rows in this process — none is estimated,
assumed, or carried over from a previous run.

NORMALIZATION
-------------
Off by default, deliberately. The model this feeds is a
RandomForestClassifier (ml/trainer.py), which splits on thresholds and is
therefore completely scale-invariant: min-max scaling the scores would change
nothing about the fitted trees, while destroying the "these columns are
percentages" property that the rest of KinderCura relies on (the same 0-100
values are what constants/scoring.js bands, what the admin pages display, and
what ml/predict.py is handed at inference time). Pass --normalize to apply it
anyway; the report always records the min/max statistics either way, so the
decision is visible rather than silent.

THE -1 SENTINEL IS NOT APPLIED HERE
-----------------------------------
A blank Q0N cell means "not administered" (the age gate), which is different
from a "no" answer. ml/trainer.py encodes that as -1 itself
(QUESTION_MISSING_SENTINEL). This file therefore leaves those cells BLANK:
writing -1 into the clean file would make trainer.py's own encoder reject it
as an unrecognized answer value. Blank in, sentinel applied at train time.

Usage
-----
    python ml/preprocess.py --input raw.csv --output clean.csv --report report.json
    python ml/preprocess.py --input raw.csv --output clean.csv --normalize

Exit codes
    0  cleaning completed  (report JSON on stdout)
    1  cleaning failed     (error  JSON on stdout)
"""

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone

import numpy as np
import pandas as pd

# ── Schema ───────────────────────────────────────────────────────────────
# Mirrors ml/trainer.py exactly. Kept as literals rather than imported so this
# module stays runnable on its own, but any change here must be mirrored there.
REQUIRED_SCORE_COLUMNS = [
    "communication_score",
    "social_score",
    "cognitive_score",
    "motor_score",
    "overall_score",
]
TARGET_COLUMN = "risk_category"
VALID_LABELS = {"Low", "Medium", "High"}
QUESTION_COLUMNS = [f"Q{n:02d}" for n in range(1, 35)]
OPTIONAL_COLUMNS = ["age_months", "assessment_ref"]

# Accepted answer spellings -> the numeric encoding routes/assessments.js
# scoreAnswer() uses (yes=2, sometimes=1, no=0). Blank is handled separately.
ANSWER_ALIASES = {
    "yes": 2, "sometimes": 1, "no": 0,
    "2": 2, "1": 1, "0": 0,
    "2.0": 2, "1.0": 1, "0.0": 0,
}

# Plausibility bounds. A screening percentage outside 0-100 is arithmetically
# impossible, not merely unusual. The age bounds are generous on purpose — this
# stage rejects impossible data, it does not enforce the question bank's age
# gate (a 20-month-old simply answers no questions).
SCORE_MIN, SCORE_MAX = 0, 100
AGE_MIN_MONTHS, AGE_MAX_MONTHS = 6, 216

# overall_score is defined as the mean of the four domain percentages, each of
# which is itself rounded. Independent rounding can move the mean by at most
# 0.5; 2 points of slack keeps honest rounding while still catching a row whose
# overall_score has no relationship to its domain scores.
OVERALL_CONSISTENCY_TOLERANCE = 2


class CleaningError(Exception):
    """Raised when the dataset cannot be cleaned at all (e.g. bad schema)."""


def load_dataset(filepath: str) -> pd.DataFrame:
    """Load a raw CSV or JSON dataset for cleaning.

    `keep_default_na=False, na_values=[""]` is deliberate and load-bearing.
    pandas' DEFAULT missing-value list silently converts about fifteen strings
    — "N/A", "n/a", "NULL", "NaN", "-", "" and friends — into NaN. In a file
    this module is meant to VALIDATE, that is exactly the wrong behaviour: a
    cell reading "n/a" is a corrupt answer that must be counted and rejected,
    but the default reader turns it into an indistinguishable blank, and a
    blank Q0N cell legitimately means "not administered" (the age gate). So a
    real defect would be laundered into a normal value and the cleaning report
    would under-count invalid records.

    Only a genuinely empty cell counts as missing here. Everything else keeps
    its literal text and is judged on its merits.
    """
    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".json":
        return pd.read_json(filepath)
    if ext == ".csv":
        return pd.read_csv(filepath, keep_default_na=False, na_values=[""])
    raise CleaningError(f"Unsupported file extension '{ext}'. Only .csv and .json are accepted.")


def validate_schema(df: pd.DataFrame) -> dict:
    """Confirm every column the trainer requires is present.

    A missing required column is fatal — there is no honest way to clean a
    dataset into a shape it was never in. A missing OPTIONAL column is
    recorded and the run continues.
    """
    required = REQUIRED_SCORE_COLUMNS + [TARGET_COLUMN]
    missing_required = [c for c in required if c not in df.columns]
    if missing_required:
        raise CleaningError(
            "Dataset is missing required column(s): "
            f"{', '.join(missing_required)}. Expected at minimum: {', '.join(required)}."
        )

    missing_optional = [c for c in OPTIONAL_COLUMNS if c not in df.columns]
    present_questions = [c for c in QUESTION_COLUMNS if c in df.columns]
    return {
        "required_columns_present": True,
        "total_columns": int(len(df.columns)),
        "question_columns_present": len(present_questions),
        "missing_optional_columns": missing_optional,
        "unexpected_columns": [
            c for c in df.columns
            if c not in required + OPTIONAL_COLUMNS + QUESTION_COLUMNS
        ],
    }


def _encode_answer_cell(raw):
    """Blank -> np.nan (left blank in the output; the trainer applies its own
    -1 sentinel). A recognized answer -> 0/1/2. Anything else -> None, which the
    caller treats as an invalid row rather than silently coercing."""
    if raw is None:
        return np.nan
    if isinstance(raw, float) and pd.isna(raw):
        return np.nan
    text = str(raw).strip()
    if text == "" or text.lower() in ("nan", "none"):
        return np.nan
    return ANSWER_ALIASES.get(text.lower())


def clean_dataframe(df: pd.DataFrame, normalize: bool = False) -> tuple:
    """Run every cleaning stage and return (clean_df, report_dict).

    Rows are never modified into validity: a row that fails a check is dropped
    with its reason recorded, so the counts in the report can be reconciled
    against the input file by anyone who wants to check them.
    """
    original_records = int(len(df))
    schema = validate_schema(df)
    rejections = {}
    warnings = []

    def reject(mask, reason):
        """Drop the rows selected by *mask*, recording how many and why."""
        nonlocal df
        count = int(mask.sum())
        if count:
            rejections[reason] = rejections.get(reason, 0) + count
            df = df[~mask].copy()
        return count

    # ── 3. Duplicates ────────────────────────────────────────────────────
    # Compared on the feature + target columns, NOT on assessment_ref: two rows
    # holding identical answers, scores and label are the same observation
    # counted twice regardless of what reference id each carries, and feeding
    # both would silently over-weight it during training.
    dedupe_columns = [c for c in df.columns if c != "assessment_ref"]
    before = len(df)
    df = df.drop_duplicates(subset=dedupe_columns, keep="first").copy()
    duplicates_removed = int(before - len(df))

    # ── 4. Target label ──────────────────────────────────────────────────
    normalized_label = df[TARGET_COLUMN].astype(str).str.strip().str.title()
    reject(~normalized_label.isin(VALID_LABELS), "invalid_or_missing_risk_category")
    df[TARGET_COLUMN] = df[TARGET_COLUMN].astype(str).str.strip().str.title()

    # ── 5. Numeric coercion + missing values ─────────────────────────────
    for column in REQUIRED_SCORE_COLUMNS:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    reject(df[REQUIRED_SCORE_COLUMNS].isna().any(axis=1), "missing_or_non_numeric_score")

    missing_filled = {}
    if "age_months" in df.columns:
        df["age_months"] = pd.to_numeric(df["age_months"], errors="coerce")
        missing_age = int(df["age_months"].isna().sum())
        if missing_age:
            # age_months is an OPTIONAL feature, so a missing value is imputed
            # rather than costing the row. A domain score is not imputable —
            # inventing one would fabricate a screening result.
            if df["age_months"].notna().any():
                median_age = float(df["age_months"].median())
                df["age_months"] = df["age_months"].fillna(median_age)
                missing_filled["age_months"] = {"filled": missing_age, "strategy": "median", "value": median_age}
            else:
                warnings.append("age_months is entirely empty; the column will be ignored by the trainer.")

    # ── 6. Impossible values ─────────────────────────────────────────────
    out_of_range = pd.Series(False, index=df.index)
    for column in REQUIRED_SCORE_COLUMNS:
        out_of_range |= (df[column] < SCORE_MIN) | (df[column] > SCORE_MAX)
    reject(out_of_range, "score_out_of_range_0_100")

    if "age_months" in df.columns:
        bad_age = (df["age_months"] < AGE_MIN_MONTHS) | (df["age_months"] > AGE_MAX_MONTHS)
        reject(bad_age.fillna(False), "age_months_implausible")

    # ── 7. Internally inconsistent rows ──────────────────────────────────
    domain_mean = df[["communication_score", "social_score", "cognitive_score", "motor_score"]].mean(axis=1)
    inconsistent = (df["overall_score"] - domain_mean).abs() > OVERALL_CONSISTENCY_TOLERANCE
    reject(inconsistent, "overall_score_inconsistent_with_domain_scores")

    # ── 8. Categorical answer encoding ───────────────────────────────────
    present_questions = [c for c in QUESTION_COLUMNS if c in df.columns]
    unencodable = pd.Series(False, index=df.index)
    encoded_columns = {}
    for column in present_questions:
        encoded = df[column].map(_encode_answer_cell)
        # None (not NaN) means "present but unrecognized". isna() catches both,
        # so the blank case is excluded explicitly.
        original_blank = df[column].isna() | (df[column].astype(str).str.strip() == "")
        unencodable |= encoded.isna() & ~original_blank
        encoded_columns[column] = encoded
    reject(unencodable, "unrecognized_answer_value")
    for column in present_questions:
        df[column] = encoded_columns[column].loc[df.index]

    # ── 9. Normalization (opt-in — see module docstring) ─────────────────
    numeric_stats = {
        column: {"min": float(df[column].min()), "max": float(df[column].max()),
                 "mean": round(float(df[column].mean()), 4)}
        for column in REQUIRED_SCORE_COLUMNS
    } if len(df) else {}

    if normalize and len(df):
        for column in REQUIRED_SCORE_COLUMNS:
            lo, hi = numeric_stats[column]["min"], numeric_stats[column]["max"]
            df[column] = 0.0 if hi == lo else (df[column] - lo) / (hi - lo)
        normalization = {
            "applied": True,
            "method": "min-max to [0, 1] over the score columns",
            "statistics": numeric_stats,
        }
    else:
        normalization = {
            "applied": False,
            "reason": (
                "RandomForestClassifier splits on thresholds and is scale-invariant, so "
                "rescaling would not change the fitted model — and it would break the "
                "0-100 percentage contract the rest of KinderCura depends on. Statistics "
                "are recorded regardless. Pass --normalize to apply it anyway."
            ),
            "statistics": numeric_stats,
        }

    # ── 10. Tidy up ──────────────────────────────────────────────────────
    for column in REQUIRED_SCORE_COLUMNS:
        if not normalize:
            df[column] = df[column].round().astype("Int64")
    if "age_months" in df.columns:
        df["age_months"] = df["age_months"].round().astype("Int64")
    for column in present_questions:
        df[column] = df[column].astype("Int64")  # nullable: blanks stay blank

    invalid_records = int(sum(rejections.values()))
    final_records = int(len(df))
    class_distribution = (
        {str(k): int(v) for k, v in df[TARGET_COLUMN].value_counts().items()} if final_records else {}
    )

    # Trainer-readiness warnings. Deliberately warnings, not failures: this
    # module's job is to report the state of the data honestly, and
    # ml/trainer.py enforces its own thresholds loudly when training runs.
    if final_records < 10:
        warnings.append(f"Only {final_records} clean row(s) remain; ml/trainer.py requires at least 10.")
    thin = {k: v for k, v in class_distribution.items() if v < 2}
    if thin:
        warnings.append(f"Class(es) too thin for a stratified split: {thin}. Training will fail.")
    if len(class_distribution) < 2:
        warnings.append("Fewer than two risk_category classes are represented; a classifier cannot be fitted.")

    report = {
        "success": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "schema": schema,
        "original_records": original_records,
        "duplicates_removed": duplicates_removed,
        "invalid_records": invalid_records,
        "valid_records": original_records - invalid_records,
        "final_records": final_records,
        "rejections_by_reason": rejections,
        "missing_values_filled": missing_filled,
        "normalization": normalization,
        "encoding": {
            "question_columns_encoded": len(present_questions),
            "answer_encoding": "yes=2, sometimes=1, no=0 (mirrors routes/assessments.js scoreAnswer)",
            "blank_handling": (
                "left blank — a blank Q0N means 'not administered' (age gate). "
                "ml/trainer.py applies its own -1 sentinel at train time."
            ),
            "target_encoding": (
                "risk_category left as Low/Medium/High; ml/trainer.py fits its own "
                "LabelEncoder so the artifact carries the mapping it was trained with."
            ),
        },
        "class_distribution": class_distribution,
        "warnings": warnings,
    }
    return df, report


def summary_lines(report: dict) -> list:
    """The human-readable summary block, built only from counted values."""
    return [
        f"Original records:       {report['original_records']:,}",
        f"Valid records:          {report['valid_records']:,}",
        f"Invalid records:        {report['invalid_records']:,}",
        f"Duplicates removed:     {report['duplicates_removed']:,}",
        f"Final training records: {report['final_records']:,}",
    ]


def preprocess(input_path: str, output_path: str, report_path: str = None,
               normalize: bool = False) -> dict:
    """Clean *input_path* into *output_path*, optionally writing the JSON report."""
    df = load_dataset(input_path)
    clean_df, report = clean_dataframe(df, normalize=normalize)

    parent = os.path.dirname(os.path.abspath(output_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    clean_df.to_csv(output_path, index=False)

    report["input_path"] = os.path.abspath(input_path).replace("\\", "/")
    report["output_path"] = os.path.abspath(output_path).replace("\\", "/")

    if report_path:
        parent = os.path.dirname(os.path.abspath(report_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        report["report_path"] = os.path.abspath(report_path).replace("\\", "/")

    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KinderCura dataset cleaning / preprocessing")
    parser.add_argument("--input", required=True, help="Raw dataset path (.csv or .json)")
    parser.add_argument("--output", required=True, help="Where to write the cleaned dataset (.csv)")
    parser.add_argument("--report", default=None, help="Where to write the JSON cleaning report")
    parser.add_argument("--normalize", action="store_true",
                        help="Min-max scale the score columns (off by default — see module docstring)")
    parser.add_argument("--quiet", action="store_true", help="Emit only the JSON report on stdout")
    args = parser.parse_args()

    try:
        result = preprocess(args.input, args.output, args.report, args.normalize)
        if args.quiet:
            print(json.dumps(result))
        else:
            print("\n".join(summary_lines(result)))
            if result["rejections_by_reason"]:
                print("\nRejected by reason:")
                for reason, count in sorted(result["rejections_by_reason"].items(), key=lambda kv: -kv[1]):
                    print(f"  {reason}: {count:,}")
            for warning in result["warnings"]:
                print(f"WARNING: {warning}")
            print(f"\nClean dataset written to {result['output_path']}")
    except CleaningError as err:
        print(json.dumps({"success": False, "error": str(err)}))
        sys.exit(1)
    except Exception as exc:  # never exit without a parseable message
        print(json.dumps({
            "success": False,
            "error": f"Preprocessing failed: {exc}",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)
