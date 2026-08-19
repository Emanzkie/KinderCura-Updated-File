"""
KinderCura ML Trainer
=====================
Trains a RandomForestClassifier on uploaded screening datasets to predict a
child's developmental risk category (Low / Medium / High).

Dataset requirements
---------------------
Every training dataset MUST contain an explicit, human-labeled
`risk_category` column with values Low, Medium, or High (case-insensitive).
This trainer does NOT derive risk_category from assessment scores — doing so
would mean the "ground truth" the model learns from is just a restatement of
the same rule-based thresholds it's meant to improve on, and would let an
unconfirmed score cutoff quietly become a clinical claim. See
constants/scoring.js and constants/developmental-staging.js for why those
cutoffs are still marked unconfirmed. A dataset with no (or no valid)
risk_category labels fails training with a clear error instead of silently
inventing labels.

Usage:
    python ml/trainer.py --input <dataset_path> --output <model_dir>

Exit codes:
    0  Training completed successfully  (metrics JSON on stdout)
    1  Training failed                  (error  JSON on stdout)
"""

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

# Minimum examples a REPRESENTED class needs for a stratified train/test
# split to be possible at all (sklearn's train_test_split(stratify=...)
# raises otherwise — this turns that into a clear KinderCura error instead
# of a raw sklearn traceback). Mirrors routes/admin.js's
# QUALITY.MIN_ROWS_PER_REPRESENTED_CLASS exactly — same technical rule,
# enforced independently on both sides so trainer.py stays safe even when
# invoked outside the Node admin route's quality gate.
MIN_ROWS_PER_REPRESENTED_CLASS = 2

# ── Column configuration ────────────────────────────────────────────────
REQUIRED_SCORE_COLUMNS = [
    "communication_score",
    "social_score",
    "cognitive_score",
    "motor_score",
    "overall_score",
]

# age_months is the only optional feature column. gender was removed (see
# ml/predict.py) because trainer.py fit a LabelEncoder on gender at train
# time but never persisted it in the model artifact, so predict.py had to
# guess the encoding with a hardcoded {female:0, male:1} map — silently
# wrong whenever the training data's LabelEncoder ordering didn't match
# that guess (e.g. a third gender value, or a dataset containing only one
# gender). Rather than plumb the real encoder through the artifact for a
# feature with no demonstrated importance yet, gender is dropped until
# there's a concrete reason to bring it back correctly (persist the fitted
# encoder in the artifact and use it, not option-A-style hardcoding).
OPTIONAL_COLUMNS = ["age_months"]

# The target we predict. Must be present and labeled — see module docstring.
TARGET_COLUMN = "risk_category"
VALID_LABELS = {"Low", "Medium", "High"}

# ── Step 15: configurable feature-set option ────────────────────────────
# Model A ("score_based", the existing/default pipeline — unchanged): the
# five domain/overall percentage scores (+ optional age_months).
# Model B ("question_based", new): the 34 individual core-bank item-level
# answers Q01-Q34 (+ optional age_months) — see ml/datasets/README.md
# "Assessment feature columns". Neither feature set ever includes
# risk_category (the target), or any reviewer/diagnosis/care-stage/
# prediction/recommendation field — those are not columns this trainer
# reads from at all; only REQUIRED_SCORE_COLUMNS / QUESTION_COLUMNS /
# OPTIONAL_COLUMNS / TARGET_COLUMN are ever touched.
FEATURE_SET_SCORE = "score_based"
FEATURE_SET_QUESTION = "question_based"
VALID_FEATURE_SETS = {FEATURE_SET_SCORE, FEATURE_SET_QUESTION}

# Q01-Q34 — mirrors js/parent/screening.js DOCTOR_QUESTION_BANK / the
# canonical dataset (ml/datasets/kindercura_assessment_dataset.csv).
QUESTION_COLUMNS = [f"Q{n:02d}" for n in range(1, 35)]

# Sentinel for a question that was not administered (age-gated blank) — see
# ml/datasets/README.md "Assessment feature columns". Deliberately NOT 0
# (0 already means a real "no" answer per scoreAnswer()) and NOT NaN
# (RandomForestClassifier does not accept NaN features). Both trainer.py
# (here) and predict.py apply this EXACT same sentinel — a question-based
# model's predictions would be silently wrong if the two ever diverged.
QUESTION_MISSING_SENTINEL = -1

# routes/assessments.js scoreAnswer(): yes=2, sometimes=1, no=0. Accepts
# both the raw answer string and the already-numeric encoding (the
# canonical dataset and the reviewed-assessment export both write numeric
# 0/1/2 strings; a caller building question features by hand may still pass
# the raw answer word) — never a fourth value, and blank is handled
# separately (-> QUESTION_MISSING_SENTINEL), not through this map.
QUESTION_ANSWER_MAP = {
    "yes": 2, "sometimes": 1, "no": 0,
    "2": 2, "1": 1, "0": 0,
    "2.0": 2, "1.0": 1, "0.0": 0,
}


# ── Helpers ──────────────────────────────────────────────────────────────
def fail(message: str):
    """Print an error payload and exit with code 1."""
    print(json.dumps({"success": False, "error": message}))
    sys.exit(1)


def load_dataset(filepath: str) -> pd.DataFrame:
    """Load a CSV or JSON dataset from *filepath* and return a DataFrame."""
    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".json":
        return pd.read_json(filepath)
    if ext == ".csv":
        return pd.read_csv(filepath)
    fail(f"Unsupported file extension '{ext}'. Only .csv and .json are accepted.")
    return pd.DataFrame()  # unreachable – keeps linters happy


def validate_columns(df: pd.DataFrame, feature_set: str = FEATURE_SET_SCORE):
    """Ensure every required feature column AND the risk_category target are
    present in *df*, for the requested *feature_set*. Fails with a clear,
    specific error otherwise — this is the single place that decides a
    dataset is trainable at all."""
    # Accept both snake_case and camelCase column names from the JS world.
    rename_map = {
        "communicationScore": "communication_score",
        "socialScore": "social_score",
        "cognitiveScore": "cognitive_score",
        "motorScore": "motor_score",
        "overallScore": "overall_score",
        "ageMonths": "age_months",
        "riskCategory": "risk_category",
    }
    df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns}, inplace=True)

    if feature_set == FEATURE_SET_QUESTION:
        missing = [c for c in QUESTION_COLUMNS if c not in df.columns]
        if missing:
            fail(
                f"Dataset is missing required question columns: {', '.join(missing)}. "
                f"question_based training requires all {len(QUESTION_COLUMNS)} "
                "core-bank item columns (Q01-Q34) — see "
                "ml/datasets/README.md 'Assessment feature columns'."
            )
    else:
        missing = [c for c in REQUIRED_SCORE_COLUMNS if c not in df.columns]
        if missing:
            fail(
                f"Dataset is missing required columns: {', '.join(missing)}. "
                f"Expected columns: {', '.join(REQUIRED_SCORE_COLUMNS)}"
            )

    if TARGET_COLUMN not in df.columns:
        fail(
            "Dataset is missing the required 'risk_category' column. Every "
            "training row must include a labeled risk_category value (Low, "
            "Medium, or High) — KinderCura does not automatically generate "
            "risk labels from assessment scores. Label the dataset with real "
            "outcomes (or use the admin dataset template as a format guide) "
            "and re-upload."
        )


def prepare_score_features(df: pd.DataFrame):
    """Model A — build the feature matrix X and target vector y from the
    five domain/overall scores.

    Strict validation: rows with a missing/blank/unrecognized risk_category,
    or any missing critical score, are dropped entirely — we never train on
    incomplete or unlabeled health data. Assumes validate_columns() has
    already confirmed both the score columns and risk_category exist.

    UNCHANGED from the pre-Step-15 pipeline — this is the exact function
    question_based training must not disturb (see prepare_question_features
    below for the parallel Model B path).
    """
    raw_rows = len(df)

    # ── 1. Normalize and validate the target label ───────────────────────
    df[TARGET_COLUMN] = df[TARGET_COLUMN].astype(str).str.strip().str.title()
    invalid_mask = ~df[TARGET_COLUMN].isin(VALID_LABELS)
    invalid_count = int(invalid_mask.sum())
    df = df[~invalid_mask].copy()
    if df.empty:
        fail(
            f"None of the {raw_rows} row(s) had a valid risk_category label. "
            "Expected exactly one of: Low, Medium, High (case-insensitive). "
            f"{invalid_count} row(s) were missing, blank, or unrecognized — "
            "fix the labels and re-upload. risk_category is never inferred "
            "from scores."
        )

    # ── 2. Drop rows with missing critical scores ────────────────────────
    before = len(df)
    df = df.dropna(subset=REQUIRED_SCORE_COLUMNS).copy()
    after = len(df)
    if after == 0:
        fail("All rows have missing critical score values. Cannot train.")
    if after < 10:
        fail(
            f"Only {after} valid, labeled row(s) remain after removing "
            "incomplete scores and invalid risk_category labels. At least "
            "10 rows are needed for a meaningful model."
        )
    dropped = invalid_count + (before - after)

    # ── 2b. Every REPRESENTED class needs enough rows to stratify-split ───
    # A class with only 1 example can't have a member in both the train and
    # test split. This does not reject the dataset for having too FEW
    # classes overall (2 represented classes is fine) — only for a
    # represented class that's too thin to split safely. Never invents or
    # drops a class silently; fails loudly instead.
    class_counts = df[TARGET_COLUMN].value_counts().to_dict()
    thin_classes = {cls: n for cls, n in class_counts.items() if n < MIN_ROWS_PER_REPRESENTED_CLASS}
    if thin_classes:
        detail = ", ".join(f"{cls}: {n} row(s)" for cls, n in thin_classes.items())
        fail(
            f"Cannot stratify a train/test split: {detail}. Each represented "
            f"risk_category needs at least {MIN_ROWS_PER_REPRESENTED_CLASS} rows. "
            "Label more assessments for the affected class(es), or exclude "
            "them, before training."
        )

    # ── 3. Build feature columns ─────────────────────────────────────────
    feature_cols = list(REQUIRED_SCORE_COLUMNS)  # always present

    if "age_months" in df.columns:
        df["age_months"] = pd.to_numeric(df["age_months"], errors="coerce")
        if df["age_months"].notna().sum() > 0:
            df["age_months"] = df["age_months"].fillna(df["age_months"].median())
            feature_cols.append("age_months")

    X = df[feature_cols].astype(float)
    y = df[TARGET_COLUMN]

    # Full pre-split distribution — Step 13 §7 "record the class
    # distribution used for training". Distinct from per_class_metrics
    # below, which is TEST-split support only.
    class_distribution = {cls: int(n) for cls, n in class_counts.items()}

    return X, y, feature_cols, dropped, class_distribution


def encode_question_value(raw):
    """Encode one Q0N cell to its trainer-facing numeric value.

    Blank / NaN / None -> QUESTION_MISSING_SENTINEL (not administered —
    age gate; NOT the same as a "no" answer, which is a real 0).
    'yes'/'sometimes'/'no' (case-insensitive) or numeric 0/1/2 (as a string
    or number) -> 2/1/0 per routes/assessments.js scoreAnswer().
    Anything else -> None, which the caller treats as an invalid-encoding
    error (never silently coerced or dropped).
    """
    if raw is None:
        return QUESTION_MISSING_SENTINEL
    if isinstance(raw, float) and pd.isna(raw):
        return QUESTION_MISSING_SENTINEL
    s = str(raw).strip()
    if s == "":
        return QUESTION_MISSING_SENTINEL
    return QUESTION_ANSWER_MAP.get(s.lower())  # None if unrecognized


def prepare_question_features(df: pd.DataFrame):
    """Model B — build the feature matrix X and target vector y from the
    34 item-level core-bank answers (Q01-Q34), never the domain/overall
    scores. Mirrors prepare_score_features()'s label-validation and
    stratify-safety checks exactly (same messages, same order), but never
    drops a row for a blank QNN cell: age-gated blanks are an EXPECTED,
    real pattern (see ml/datasets/README.md), not incomplete data — they are
    encoded as QUESTION_MISSING_SENTINEL instead. Assumes validate_columns()
    has already confirmed every Q01-Q34 column and risk_category exist.
    """
    raw_rows = len(df)

    # ── 1. Normalize and validate the target label (identical to Model A) ─
    df[TARGET_COLUMN] = df[TARGET_COLUMN].astype(str).str.strip().str.title()
    invalid_mask = ~df[TARGET_COLUMN].isin(VALID_LABELS)
    invalid_count = int(invalid_mask.sum())
    df = df[~invalid_mask].copy()
    if df.empty:
        fail(
            f"None of the {raw_rows} row(s) had a valid risk_category label. "
            "Expected exactly one of: Low, Medium, High (case-insensitive). "
            f"{invalid_count} row(s) were missing, blank, or unrecognized — "
            "fix the labels and re-upload. risk_category is never inferred "
            "from scores."
        )

    # ── 2. Row-count floor — no score-based dropna here; a blank QNN cell
    # is expected (age gate), not incomplete data, so it never removes a row.
    after = len(df)
    if after < 10:
        fail(
            f"Only {after} valid, labeled row(s) remain after removing "
            "invalid risk_category labels. At least 10 rows are needed for "
            "a meaningful model."
        )
    dropped = invalid_count

    # ── 2b. Stratify-safety check (identical to Model A) ──────────────────
    class_counts = df[TARGET_COLUMN].value_counts().to_dict()
    thin_classes = {cls: n for cls, n in class_counts.items() if n < MIN_ROWS_PER_REPRESENTED_CLASS}
    if thin_classes:
        detail = ", ".join(f"{cls}: {n} row(s)" for cls, n in thin_classes.items())
        fail(
            f"Cannot stratify a train/test split: {detail}. Each represented "
            f"risk_category needs at least {MIN_ROWS_PER_REPRESENTED_CLASS} rows. "
            "Label more assessments for the affected class(es), or exclude "
            "them, before training."
        )

    # ── 3. Encode Q01-Q34 (blank -> sentinel, yes/sometimes/no or 0/1/2 ->
    # 2/1/0). Invalid, non-blank values fail loudly rather than being
    # coerced or silently dropped.
    feature_cols = list(QUESTION_COLUMNS)
    for q in feature_cols:
        encoded = df[q].map(encode_question_value)
        bad = encoded.isna()
        if bad.any():
            bad_values = df.loc[bad, q].astype(str).unique().tolist()[:5]
            fail(
                f"Invalid answer encoding in column '{q}': {bad_values}. "
                "Expected 'yes'/'sometimes'/'no' or 0/1/2, or blank for a "
                "question not administered (age gate)."
            )
        df[q] = encoded

    if "age_months" in df.columns:
        df["age_months"] = pd.to_numeric(df["age_months"], errors="coerce")
        if df["age_months"].notna().sum() > 0:
            df["age_months"] = df["age_months"].fillna(df["age_months"].median())
            feature_cols.append("age_months")

    X = df[feature_cols].astype(float)
    y = df[TARGET_COLUMN]

    class_distribution = {cls: int(n) for cls, n in class_counts.items()}

    return X, y, feature_cols, dropped, class_distribution


def prepare_features(df: pd.DataFrame, feature_set: str = FEATURE_SET_SCORE):
    """Dispatch to the Model A (score_based) or Model B (question_based)
    feature-preparation path. Neither path ever includes risk_category
    (the target) or any reviewer/diagnosis/care-stage/prediction/
    recommendation field as a feature — those columns are simply never
    read by either prepare_*_features() function."""
    if feature_set == FEATURE_SET_QUESTION:
        return prepare_question_features(df)
    return prepare_score_features(df)


# ── Main training routine ────────────────────────────────────────────────
def train(input_path: str, output_dir: str, feature_set: str = FEATURE_SET_SCORE):
    if feature_set not in VALID_FEATURE_SETS:
        fail(f"Invalid feature_set '{feature_set}'. Expected one of: {', '.join(sorted(VALID_FEATURE_SETS))}")

    # Load & validate
    df = load_dataset(input_path)
    validate_columns(df, feature_set)
    X, y, feature_cols, rows_dropped, class_distribution = prepare_features(df, feature_set)

    # Encode target labels → integers for the classifier
    label_encoder = LabelEncoder()
    y_encoded = label_encoder.fit_transform(y)
    class_names = list(label_encoder.classes_)  # e.g. ['High', 'Low', 'Medium']

    # Train/test split
    test_size = 0.2
    if len(X) < 20:
        test_size = 0.3  # slightly more test data for tiny datasets

    X_train, X_test, y_train, y_test = train_test_split(
        X, y_encoded, test_size=test_size, random_state=42, stratify=y_encoded
    )

    # Train
    clf = RandomForestClassifier(
        n_estimators=100,
        max_depth=None,
        min_samples_split=2,
        random_state=42,
        class_weight="balanced",  # handle imbalanced risk categories
        n_jobs=-1,
    )
    clf.fit(X_train, y_train)

    # Evaluate
    y_pred = clf.predict(X_test)
    accuracy = float(accuracy_score(y_test, y_pred))
    precision = float(precision_score(y_test, y_pred, average="weighted", zero_division=0))
    recall = float(recall_score(y_test, y_pred, average="weighted", zero_division=0))
    f1 = float(f1_score(y_test, y_pred, average="weighted", zero_division=0))

    # Feature importances
    importances = dict(zip(feature_cols, [round(float(v), 4) for v in clf.feature_importances_]))

    # Confusion matrix — rows = actual, columns = predicted, ordered to
    # match class_names so it's directly interpretable without re-deriving
    # the label encoding. TEST split only (same data classification_report
    # below uses), never training data.
    cm = confusion_matrix(y_test, y_pred, labels=range(len(class_names)))
    confusion = {"labels": class_names, "matrix": cm.tolist()}

    # Save model artifact (includes the classifier + label encoder + feature list)
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    model_filename = f"kindercura_model_{timestamp}.joblib"
    model_path = os.path.join(output_dir, model_filename)

    artifact = {
        "classifier": clf,
        "label_encoder": label_encoder,
        "feature_columns": feature_cols,
        "class_names": class_names,
        # Step 15: which feature-set config produced this artifact —
        # predict.py doesn't need this to build X (it always uses
        # feature_columns), but it's recorded so the artifact is
        # self-describing (mirrors TrainedModel.featureSetType).
        "feature_set_type": feature_set,
        "featureSetType": feature_set,
    }
    joblib.dump(artifact, model_path)

    # Build per-class report for the admin UI
    report = classification_report(y_test, y_pred, target_names=class_names, output_dict=True, zero_division=0)
    per_class = {}
    for cls_name in class_names:
        if cls_name in report:
            per_class[cls_name] = {
                "precision": round(report[cls_name]["precision"], 4),
                "recall": round(report[cls_name]["recall"], 4),
                "f1": round(report[cls_name]["f1-score"], 4),
                "support": int(report[cls_name]["support"]),
            }

    # Output metrics as JSON on stdout for the Node.js bridge
    result = {
        "success": True,
        "model_path": model_path.replace("\\", "/"),
        "accuracy": round(accuracy, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "feature_importances": importances,
        "per_class_metrics": per_class,
        "confusion_matrix": confusion,
        "class_names": class_names,
        # Full pre-split label distribution (Low/Medium/High counts) — the
        # class balance actually used for this training run, independent of
        # the train/test split. Never modified, never rebalanced.
        "class_distribution": class_distribution,
        "training_samples": int(len(X_train)),
        "test_samples": int(len(X_test)),
        "total_rows": int(len(X)),
        "rows_dropped": int(rows_dropped),
        "features_used": feature_cols,
        "feature_count": len(feature_cols),
        "feature_set_type": feature_set,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    print(json.dumps(result))


# ── CLI entry point ──────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KinderCura ML Trainer")
    parser.add_argument("--input", required=True, help="Path to the dataset file (CSV or JSON)")
    parser.add_argument("--output", required=True, help="Directory to save the trained model")
    parser.add_argument(
        "--feature-set",
        choices=sorted(VALID_FEATURE_SETS),
        default=FEATURE_SET_SCORE,
        help=(
            "Which feature set to train on: score_based (default — the five "
            "domain/overall percentage scores) or question_based (the 34 "
            "item-level Q01-Q34 answers). Both accept optional age_months."
        ),
    )
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        fail(f"Input file not found: {args.input}")

    try:
        train(args.input, args.output, args.feature_set)
    except SystemExit:
        raise
    except Exception as exc:
        # Catch-all: never let the trainer crash without a parseable message
        print(json.dumps({
            "success": False,
            "error": f"Training failed: {exc}",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)
