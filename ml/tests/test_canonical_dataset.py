"""
Focused tests for the Step 9 canonical dataset:
    ml/datasets/kindercura_assessment_dataset.csv

Verifies the file's structure/schema/PII-safety directly, and verifies the
real trainer.py / predict.py pipeline actually accepts it end-to-end. No
test framework — plain assert, mirroring ml/tests/test_trainer_validation.py.
Does not touch MongoDB and does not activate any model (see model_manager.js
trainModel(datasetPath) with no datasetId — no DB writes happen at all).

Run:
    python ml/tests/test_canonical_dataset.py
"""

import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile

ML_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET_PATH = os.path.join(ML_DIR, "datasets", "kindercura_assessment_dataset.csv")
TRAINER = os.path.join(ML_DIR, "trainer.py")
PREDICT = os.path.join(ML_DIR, "predict.py")

REQUIRED_SCORE_COLUMNS = [
    "communication_score", "social_score", "cognitive_score", "motor_score", "overall_score",
]
QUESTION_COLUMNS = [f"Q{n:02d}" for n in range(1, 35)]  # Q01..Q34
VALID_LABELS = {"Low", "Medium", "High"}

# Column names that would indicate PII if present. Checked as an exact
# (case-insensitive) match against the header, not a substring, so
# legitimate columns like "assessment_ref" are not accidentally flagged.
FORBIDDEN_COLUMNS = {
    "name", "first_name", "last_name", "child_name", "parent_name",
    "email", "phone", "phone_number", "address",
    "child_id", "parent_id", "assessment_id", "user_id", "_id",
}


def load_rows():
    with open(DATASET_PATH, newline="") as f:
        reader = csv.DictReader(f)
        return list(reader), reader.fieldnames


def run_trainer(dataset_path, output_dir):
    proc = subprocess.run(
        [sys.executable, TRAINER, "--input", dataset_path, "--output", output_dir],
        capture_output=True, text=True, timeout=120,
    )
    payload = json.loads(proc.stdout.strip())
    return proc.returncode, payload


def run_predict(model_path, data):
    proc = subprocess.run(
        [sys.executable, PREDICT, "--model", model_path, "--data", json.dumps(data)],
        capture_output=True, text=True, timeout=30,
    )
    payload = json.loads(proc.stdout.strip())
    return proc.returncode, payload


def test_required_assessment_columns_present():
    """A. Canonical dataset has the required assessment columns (Q01-Q34 + scores)."""
    _, fieldnames = load_rows()
    missing_questions = [q for q in QUESTION_COLUMNS if q not in fieldnames]
    assert not missing_questions, f"Missing question columns: {missing_questions}"
    missing_scores = [c for c in REQUIRED_SCORE_COLUMNS if c not in fieldnames]
    assert not missing_scores, f"Missing score columns: {missing_scores}"


def test_risk_category_present_and_valid():
    """B & C. risk_category is present, and only ever Low/Medium/High."""
    rows, fieldnames = load_rows()
    assert "risk_category" in fieldnames
    assert len(rows) > 0
    seen = {row["risk_category"] for row in rows}
    assert seen, "no risk_category values found"
    assert seen.issubset(VALID_LABELS), f"unexpected risk_category values: {seen - VALID_LABELS}"
    # Enough of each class to exercise Low/Medium/High and to stratify-split.
    for label in VALID_LABELS:
        count = sum(1 for row in rows if row["risk_category"] == label)
        assert count >= 5, f"too few '{label}' rows ({count}) to be a meaningful class"


def test_no_pii_columns():
    """D. No PII fields exist as columns."""
    _, fieldnames = load_rows()
    lowered = {c.lower() for c in fieldnames}
    present = lowered & FORBIDDEN_COLUMNS
    assert not present, f"PII-like columns present: {present}"


def test_answer_encoding_valid():
    """E. Answer encoding is valid: every non-blank QNN cell is 0, 1, or 2
    (routes/assessments.js scoreAnswer(): no=0, sometimes=1, yes=2); blank
    means the question was not administered (age gate), not a "no"."""
    rows, _ = load_rows()
    blanks = 0
    filled = 0
    for row in rows:
        for q in QUESTION_COLUMNS:
            value = row[q]
            if value == "":
                blanks += 1
                continue
            filled += 1
            assert value in ("0", "1", "2"), f"invalid answer encoding for {q}: {value!r}"
    # Sanity: age-gating should produce a real mix of blank vs filled cells
    # across a 60-row, wide-age-range dataset — not all-filled, not all-blank.
    assert blanks > 0, "expected at least some age-gated (blank) question cells"
    assert filled > 0, "expected at least some answered question cells"


def test_trainer_accepts_canonical_dataset_and_predictor_matches():
    """F, G, H. Trainer accepts the canonical schema, trains successfully,
    and the predictor's required feature columns match the trained model's
    (and contain no gender_encoded). Trains into a throwaway temp dir —
    never touches uploads/models/ or MongoDB (no datasetId is involved at
    all; this calls trainer.py directly, exactly like
    ml/model_manager.js trainModel() does with no datasetId)."""
    tmp_dir = tempfile.mkdtemp(prefix="kindercura_canonical_dataset_test_")
    try:
        code, payload = run_trainer(DATASET_PATH, tmp_dir)
        assert code == 0, payload
        assert payload["success"] is True
        assert sorted(payload["class_names"]) == ["High", "Low", "Medium"]
        trained_features = payload["features_used"]
        assert "gender_encoded" not in trained_features  # H

        full_input = {
            "communication_score": 55, "social_score": 60, "cognitive_score": 58,
            "motor_score": 62, "overall_score": 59, "age_months": 50,
        }
        pcode, ppayload = run_predict(payload["model_path"], full_input)
        assert pcode == 0, ppayload
        assert ppayload["success"] is True
        assert ppayload["risk_category"] in ("Low", "Medium", "High")
        # G. Predictor's required features match the trained model's exactly.
        assert sorted(ppayload["features_used"]) == sorted(trained_features)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def run():
    test_required_assessment_columns_present()
    test_risk_category_present_and_valid()
    test_no_pii_columns()
    test_answer_encoding_valid()
    test_trainer_accepts_canonical_dataset_and_predictor_matches()
    print("Canonical dataset tests OK")


if __name__ == "__main__":
    run()
