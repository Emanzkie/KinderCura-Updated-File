"""
KinderCura ML Predictor
=======================
Loads a trained .joblib model and predicts the risk category for a single
child assessment.

Usage:
    python ml/predict.py --model <path_to_joblib> --data '<json_string>'

The --data argument should be a JSON object with the fields the model was
actually trained on. This script never assumes which feature set that is —
it always reads the artifact's stored feature_columns and builds the input
vector from exactly those, in that order (see ml/trainer.py's featureSetType
/ feature_set_type). For a score_based model (Model A, the default):
    '{"communication_score":80,"social_score":30,"cognitive_score":65,
      "motor_score":70,"overall_score":61}'
For a question_based model (Model B), pass Q01-Q34 instead (0/1/2 or
'yes'/'sometimes'/'no'; omit or blank a question the child is age-gated
out of):
    '{"Q01":2,"Q02":"sometimes","Q03":"","age_months":40}'

Exit codes:
    0  Prediction successful  (result JSON on stdout)
    1  Prediction failed      (error  JSON on stdout)
"""

import argparse
import json
import re
import sys

import joblib
import numpy as np

# Step 15: question-based (Model B) feature support. Must mirror
# ml/trainer.py's QUESTION_MISSING_SENTINEL / QUESTION_ANSWER_MAP exactly —
# a question-based model's predictions would be computed against features
# it was never trained with if the two ever diverged.
QUESTION_COLUMN_PATTERN = re.compile(r"^Q\d{2}$")
QUESTION_MISSING_SENTINEL = -1
QUESTION_ANSWER_MAP = {
    "yes": 2, "sometimes": 1, "no": 0,
    "2": 2, "1": 1, "0": 0,
    "2.0": 2, "1.0": 1, "0.0": 0,
}


class PredictionError(Exception):
    """Custom exception raised when ML prediction fails."""
    pass


def fail(message: str):
    raise PredictionError(message)


def encode_question_value_for_predict(val):
    """Encode one Q0N prediction input exactly like ml/trainer.py's
    encode_question_value(): blank/missing -> QUESTION_MISSING_SENTINEL
    (age-gated, "not administered" — not a "no"), 'yes'/'sometimes'/'no' or
    0/1/2 -> 2/1/0. Unlike the score feature columns, a question column
    legitimately being blank at prediction time is expected (age gate), so
    it is encoded rather than rejected as a missing feature."""
    if val is None:
        return float(QUESTION_MISSING_SENTINEL)
    s = str(val).strip()
    if s == "":
        return float(QUESTION_MISSING_SENTINEL)
    mapped = QUESTION_ANSWER_MAP.get(s.lower())
    if mapped is None:
        fail(
            f"Invalid answer encoding for question feature: {val!r}. Expected "
            "'yes'/'sometimes'/'no', 0/1/2, or blank/omitted for a question "
            "not administered (age gate)."
        )
        return None
    return float(mapped)


def predict_from_artifact(artifact: dict, data: dict) -> dict:
    """Predict risk category from a loaded model artifact dictionary and input data dict."""
    import pandas as pd

    clf = artifact["classifier"]
    label_encoder = artifact["label_encoder"]
    feature_columns = artifact["feature_columns"]
    class_names = artifact["class_names"]

    # Accept camelCase from the Node.js world
    data_normalized = dict(data)
    rename_map = {
        "communicationScore": "communication_score",
        "socialScore": "social_score",
        "cognitiveScore": "cognitive_score",
        "motorScore": "motor_score",
        "overallScore": "overall_score",
        "ageMonths": "age_months",
    }
    for old, new in rename_map.items():
        if old in data_normalized and new not in data_normalized:
            data_normalized[new] = data_normalized[old]

    # Build feature vector
    features = []
    for col in feature_columns:
        val = data_normalized.get(col)
        if QUESTION_COLUMN_PATTERN.match(col):
            features.append(encode_question_value_for_predict(val))
            continue
        if val is None:
            fail(f"Missing required feature: {col}")
            return {}
        features.append(float(val))

    X = pd.DataFrame([features], columns=feature_columns)

    # Predict
    prediction_encoded = clf.predict(X)[0]
    probabilities = clf.predict_proba(X)[0]

    # Decode label
    risk_category = label_encoder.inverse_transform([prediction_encoded])[0]

    # Map risk → consultation_needed boolean
    consultation_needed = risk_category in ("Medium", "High")

    # Build probability map
    prob_map = {}
    for i, cls_name in enumerate(class_names):
        prob_map[cls_name] = round(float(probabilities[i]), 4)

    return {
        "success": True,
        "risk_category": risk_category,
        "consultation_needed": consultation_needed,
        "probabilities": prob_map,
        "features_used": feature_columns,
    }


def predict(model_path: str, data_json: str) -> dict:
    """Load model artifact from disk and run prediction for data_json string or dict."""
    try:
        artifact = joblib.load(model_path)
    except Exception as exc:
        fail(f"Could not load model: {exc}")
        return {}

    if isinstance(data_json, str):
        try:
            data = json.loads(data_json)
        except json.JSONDecodeError as exc:
            fail(f"Invalid JSON input: {exc}")
            return {}
    else:
        data = data_json

    result = predict_from_artifact(artifact, data)
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KinderCura ML Predictor")
    parser.add_argument("--model", required=True, help="Path to the trained .joblib model")
    parser.add_argument("--data", required=True, help="JSON string with score data")
    args = parser.parse_args()

    try:
        predict(args.model, args.data)
    except PredictionError as err:
        print(json.dumps({"success": False, "error": str(err)}))
        sys.exit(1)
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"success": False, "error": f"Prediction failed: {exc}"}))
        sys.exit(1)

