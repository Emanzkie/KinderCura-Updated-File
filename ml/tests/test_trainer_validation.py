"""
Focused tests for ml/trainer.py's dataset validation, score-based vs
question-based training pipelines, and ml/predict.py's feature-column
compatibility.

No test framework — plain assert, mirroring the style of
tests/unit/models.test.js. Runs the real scripts as subprocesses (same way
ml/model_manager.js invokes them) so these tests exercise the actual CLI
contract, not just the internal functions.

Run:
    python ml/tests/test_trainer_validation.py
"""

import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile

import joblib

ML_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRAINER = os.path.join(ML_DIR, "trainer.py")
PREDICT = os.path.join(ML_DIR, "predict.py")
CANONICAL_DATASET = os.path.join(ML_DIR, "datasets", "kindercura_assessment_dataset.csv")

SCORE_FIELDS = [
    "communication_score", "social_score", "cognitive_score",
    "motor_score", "overall_score", "age_months", "risk_category",
]

QUESTION_COLUMNS = [f"Q{n:02d}" for n in range(1, 35)]
ALL_QUESTION_FIELDS = ["assessment_ref", "age_months"] + QUESTION_COLUMNS + ["risk_category"]

# 12 rows, 4 per class — enough for the >=10 row minimum and for
# train_test_split(stratify=...) to have >=2 samples per class in each split.
VALID_SCORE_ROWS = [
    [90, 88, 85, 92, 89, 48, "Low"],
    [85, 90, 88, 80, 86, 50, "Low"],
    [88, 85, 90, 85, 87, 45, "Low"],
    [92, 90, 85, 88, 89, 52, "Low"],
    [60, 55, 58, 62, 59, 36, "Medium"],
    [65, 60, 55, 58, 60, 40, "Medium"],
    [58, 62, 60, 55, 59, 38, "Medium"],
    [62, 58, 60, 60, 60, 42, "Medium"],
    [30, 25, 28, 32, 29, 24, "High"],
    [25, 30, 28, 30, 28, 20, "High"],
    [28, 25, 30, 25, 27, 22, "High"],
    [32, 28, 25, 30, 29, 26, "High"],
]


def write_csv(path, fields, rows):
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(fields)
        writer.writerows(rows)


def run_trainer(dataset_path, output_dir, feature_set=None):
    cmd = [sys.executable, TRAINER, "--input", dataset_path, "--output", output_dir]
    if feature_set:
        cmd.extend(["--feature-set", feature_set])
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        raise AssertionError(f"trainer.py did not print JSON. stdout={proc.stdout!r} stderr={proc.stderr!r}")
    return proc.returncode, payload


def run_predict(model_path, data):
    proc = subprocess.run(
        [sys.executable, PREDICT, "--model", model_path, "--data", json.dumps(data)],
        capture_output=True, text=True, timeout=30,
    )
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        raise AssertionError(f"predict.py did not print JSON. stdout={proc.stdout!r} stderr={proc.stderr!r}")
    return proc.returncode, payload


def test_valid_score_dataset_accepted(tmp_dir):
    """Score-based model trains successfully on valid Low/Medium/High labels."""
    dataset = os.path.join(tmp_dir, "valid_score.csv")
    write_csv(dataset, SCORE_FIELDS, VALID_SCORE_ROWS)
    out_dir = os.path.join(tmp_dir, "models_valid_score")

    code, payload = run_trainer(dataset, out_dir, feature_set="score_based")
    assert code == 0, payload
    assert payload["success"] is True
    assert sorted(payload["class_names"]) == ["High", "Low", "Medium"]
    assert payload["rows_dropped"] == 0
    assert payload["feature_set_type"] == "score_based"
    assert "risk_category" not in payload["features_used"]

    # Verify saved joblib artifact structure (Phase 6)
    artifact = joblib.load(payload["model_path"])
    assert artifact["feature_set_type"] == "score_based"
    assert artifact["featureSetType"] == "score_based"
    assert "feature_columns" in artifact
    assert "class_names" in artifact
    assert "risk_category" not in artifact["feature_columns"]
    return payload


def test_question_based_training_and_artifact(tmp_dir):
    """Question-based model trains successfully on the canonical dataset with Q01-Q34 and age-gated blanks."""
    assert os.path.isfile(CANONICAL_DATASET), f"Canonical dataset not found at {CANONICAL_DATASET}"
    out_dir = os.path.join(tmp_dir, "models_question_based")

    code, payload = run_trainer(CANONICAL_DATASET, out_dir, feature_set="question_based")
    assert code == 0, payload
    assert payload["success"] is True
    assert payload["feature_set_type"] == "question_based"
    assert payload["feature_count"] >= 34
    assert all(f"Q{n:02d}" in payload["features_used"] for n in range(1, 35))
    assert "risk_category" not in payload["features_used"]

    # Verify saved joblib artifact structure (Phase 6)
    artifact = joblib.load(payload["model_path"])
    assert artifact["feature_set_type"] == "question_based"
    assert artifact["featureSetType"] == "question_based"
    assert set(QUESTION_COLUMNS).issubset(set(artifact["feature_columns"]))
    assert "risk_category" not in artifact["feature_columns"]
    return payload


def test_question_based_prediction(tmp_dir, question_payload):
    """Predictor builds Q01-Q34 feature vector dynamically from artifact and handles age-gated blanks safely."""
    model_path = question_payload["model_path"]

    # 1. Full input with numeric and string answers, and age-gated blanks
    sample_input = {f"Q{n:02d}": 2 for n in range(1, 20)}
    sample_input.update({f"Q{n:02d}": "" for n in range(20, 35)}) # age-gated unadministered questions
    sample_input["Q01"] = "yes"
    sample_input["Q02"] = "sometimes"
    sample_input["Q03"] = "no"
    sample_input["age_months"] = 42

    code, payload = run_predict(model_path, sample_input)
    assert code == 0, payload
    assert payload["success"] is True
    assert payload["risk_category"] in ("Low", "Medium", "High")
    assert payload["consultation_needed"] == (payload["risk_category"] in ("Medium", "High"))
    assert set(QUESTION_COLUMNS).issubset(set(payload["features_used"]))

    # 2. Invalid answer value in question features must fail loudly
    invalid_input = dict(sample_input)
    invalid_input["Q05"] = "invalid_answer"
    code_bad, payload_bad = run_predict(model_path, invalid_input)
    assert code_bad == 1
    assert payload_bad["success"] is False
    assert "Invalid answer encoding" in payload_bad["error"]


def test_missing_risk_category_column_rejected(tmp_dir):
    """No risk_category column at all -> training fails with a clear error."""
    dataset = os.path.join(tmp_dir, "no_label_col.csv")
    fields_no_label = SCORE_FIELDS[:-1]  # drop risk_category
    rows_no_label = [row[:-1] for row in VALID_SCORE_ROWS]
    write_csv(dataset, fields_no_label, rows_no_label)
    out_dir = os.path.join(tmp_dir, "models_no_label_col")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_missing_question_columns_rejected(tmp_dir):
    """question_based training fails when Q01-Q34 columns are missing."""
    dataset = os.path.join(tmp_dir, "scores_only.csv")
    write_csv(dataset, SCORE_FIELDS, VALID_SCORE_ROWS)
    out_dir = os.path.join(tmp_dir, "models_missing_q")

    code, payload = run_trainer(dataset, out_dir, feature_set="question_based")
    assert code == 1
    assert payload["success"] is False
    assert "Dataset is missing required question columns" in payload["error"]


def test_invalid_labels_rejected(tmp_dir):
    """Every row has an unrecognized risk_category value -> rejected."""
    dataset = os.path.join(tmp_dir, "invalid_labels.csv")
    rows = [row[:-1] + ["Unknown"] for row in VALID_SCORE_ROWS]
    write_csv(dataset, SCORE_FIELDS, rows)
    out_dir = os.path.join(tmp_dir, "models_invalid")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_blank_labels_rejected(tmp_dir):
    """Every row has a blank risk_category value -> rejected."""
    dataset = os.path.join(tmp_dir, "blank_labels.csv")
    rows = [row[:-1] + [""] for row in VALID_SCORE_ROWS]
    write_csv(dataset, SCORE_FIELDS, rows)
    out_dir = os.path.join(tmp_dir, "models_blank")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_no_score_derivation_fallback(tmp_dir):
    """A dataset with only consultation_needed and no risk_category must be rejected."""
    dataset = os.path.join(tmp_dir, "consultation_only.csv")
    fields = SCORE_FIELDS[:-1] + ["consultation_needed"]
    rows = [row[:-1] + [1 if row[-1] != "Low" else 0] for row in VALID_SCORE_ROWS]
    write_csv(dataset, fields, rows)
    out_dir = os.path.join(tmp_dir, "models_consultation_only")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_prediction_features_match_training(tmp_dir, score_payload):
    """Predict.py's required features are exactly the model's trained feature_columns."""
    model_path = score_payload["model_path"]
    trained_features = score_payload["features_used"]
    assert "gender_encoded" not in trained_features

    full_input = {
        "communication_score": 40, "social_score": 42, "cognitive_score": 38,
        "motor_score": 45, "overall_score": 41, "age_months": 30,
    }
    code, payload = run_predict(model_path, full_input)
    assert code == 0, payload
    assert payload["success"] is True
    assert payload["risk_category"] in ("Low", "Medium", "High")
    assert sorted(payload["features_used"]) == sorted(trained_features)

    # Omitting a required score feature must fail clearly
    partial_input = dict(full_input)
    del partial_input["communication_score"]
    code2, payload2 = run_predict(model_path, partial_input)
    assert code2 == 1
    assert payload2["success"] is False
    assert "communication_score" in payload2["error"]


def test_data_leakage_prevented(score_payload, question_payload):
    """Verify that neither pipeline includes target or sensitive/derived fields in feature sets."""
    forbidden = [
        "risk_category", "gender", "gender_encoded", "careStage", "care_stage",
        "consultationLevel", "monitoringLevel", "recommendations", "diagnosis",
        "clinicalOutcome", "mlLabel", "reviewedBy", "reviewer", "prediction",
    ]
    for p in (score_payload, question_payload):
        features = p["features_used"]
        for f in forbidden:
            assert f not in features, f"Forbidden field '{f}' leaked into features: {features}"


def run():
    tmp_dir = tempfile.mkdtemp(prefix="kindercura_ml_tests_")
    try:
        test_missing_risk_category_column_rejected(tmp_dir)
        test_missing_question_columns_rejected(tmp_dir)
        test_invalid_labels_rejected(tmp_dir)
        test_blank_labels_rejected(tmp_dir)
        test_no_score_derivation_fallback(tmp_dir)
        score_payload = test_valid_score_dataset_accepted(tmp_dir)
        question_payload = test_question_based_training_and_artifact(tmp_dir)
        test_prediction_features_match_training(tmp_dir, score_payload)
        test_question_based_prediction(tmp_dir, question_payload)
        test_data_leakage_prevented(score_payload, question_payload)
        print("ML trainer/predict validation tests OK")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    run()
