"""
Focused tests for ml/trainer.py's dataset validation and ml/predict.py's
feature-column compatibility.

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

ML_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRAINER = os.path.join(ML_DIR, "trainer.py")
PREDICT = os.path.join(ML_DIR, "predict.py")

FIELDS = [
    "communication_score", "social_score", "cognitive_score",
    "motor_score", "overall_score", "age_months", "risk_category",
]

# 12 rows, 4 per class — enough for the >=10 row minimum and for
# train_test_split(stratify=...) to have >=2 samples per class in each split.
VALID_ROWS = [
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


def run_trainer(dataset_path, output_dir):
    proc = subprocess.run(
        [sys.executable, TRAINER, "--input", dataset_path, "--output", output_dir],
        capture_output=True, text=True, timeout=120,
    )
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


def test_valid_dataset_accepted(tmp_dir):
    """1 & 5: a dataset with valid Low/Medium/High labels trains successfully."""
    dataset = os.path.join(tmp_dir, "valid.csv")
    write_csv(dataset, FIELDS, VALID_ROWS)
    out_dir = os.path.join(tmp_dir, "models_valid")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 0, payload
    assert payload["success"] is True
    assert sorted(payload["class_names"]) == ["High", "Low", "Medium"]
    assert payload["rows_dropped"] == 0
    return payload  # reused by test_prediction_features_match_training


def test_missing_risk_category_column_rejected(tmp_dir):
    """2: no risk_category column at all -> training fails with a clear error."""
    dataset = os.path.join(tmp_dir, "no_label_col.csv")
    fields_no_label = FIELDS[:-1]  # drop risk_category
    rows_no_label = [row[:-1] for row in VALID_ROWS]
    write_csv(dataset, fields_no_label, rows_no_label)
    out_dir = os.path.join(tmp_dir, "models_no_label_col")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_invalid_labels_rejected(tmp_dir):
    """3: every row has an unrecognized risk_category value -> rejected."""
    dataset = os.path.join(tmp_dir, "invalid_labels.csv")
    rows = [row[:-1] + ["Unknown"] for row in VALID_ROWS]
    write_csv(dataset, FIELDS, rows)
    out_dir = os.path.join(tmp_dir, "models_invalid")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_blank_labels_rejected(tmp_dir):
    """4: every row has a blank risk_category value -> rejected."""
    dataset = os.path.join(tmp_dir, "blank_labels.csv")
    rows = [row[:-1] + [""] for row in VALID_ROWS]
    write_csv(dataset, FIELDS, rows)
    out_dir = os.path.join(tmp_dir, "models_blank")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_no_score_derivation_fallback(tmp_dir):
    """A dataset with only consultation_needed (the old fallback target) and
    no risk_category must be rejected, not silently converted into labels."""
    dataset = os.path.join(tmp_dir, "consultation_only.csv")
    fields = FIELDS[:-1] + ["consultation_needed"]
    rows = [row[:-1] + [1 if row[-1] != "Low" else 0] for row in VALID_ROWS]
    write_csv(dataset, fields, rows)
    out_dir = os.path.join(tmp_dir, "models_consultation_only")

    code, payload = run_trainer(dataset, out_dir)
    assert code == 1
    assert payload["success"] is False
    assert "risk_category" in payload["error"]


def test_prediction_features_match_training(tmp_dir, training_payload):
    """6: predict.py's required features are exactly the model's trained
    feature_columns — no gender_encoded, and every trained feature is
    required at prediction time."""
    model_path = training_payload["model_path"]
    trained_features = training_payload["features_used"]
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

    # Omitting a feature the model was actually trained on must fail clearly,
    # not silently substitute a default.
    if "age_months" in trained_features:
        partial_input = dict(full_input)
        del partial_input["age_months"]
        code2, payload2 = run_predict(model_path, partial_input)
        assert code2 == 1
        assert payload2["success"] is False
        assert "age_months" in payload2["error"]


def run():
    tmp_dir = tempfile.mkdtemp(prefix="kindercura_ml_tests_")
    try:
        test_missing_risk_category_column_rejected(tmp_dir)
        test_invalid_labels_rejected(tmp_dir)
        test_blank_labels_rejected(tmp_dir)
        test_no_score_derivation_fallback(tmp_dir)
        training_payload = test_valid_dataset_accepted(tmp_dir)
        test_prediction_features_match_training(tmp_dir, training_payload)
        print("ML trainer/predict validation tests OK")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    run()
