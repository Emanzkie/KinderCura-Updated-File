"""
KinderCura ML Predictor
=======================
Loads a trained .joblib model and predicts the risk category for a single
child assessment.

Usage:
    python ml/predict.py --model <path_to_joblib> --data '<json_string>'

The --data argument should be a JSON object with score fields, e.g.:
    '{"communication_score":80,"social_score":30,"cognitive_score":65,
      "motor_score":70,"overall_score":61}'

Exit codes:
    0  Prediction successful  (result JSON on stdout)
    1  Prediction failed      (error  JSON on stdout)
"""

import argparse
import json
import sys

import joblib
import numpy as np


def fail(message: str):
    print(json.dumps({"success": False, "error": message}))
    sys.exit(1)


def predict(model_path: str, data_json: str):
    # ── Load model artifact ──────────────────────────────────────────────
    try:
        artifact = joblib.load(model_path)
    except Exception as exc:
        fail(f"Could not load model: {exc}")
        return

    clf = artifact["classifier"]
    label_encoder = artifact["label_encoder"]
    feature_columns = artifact["feature_columns"]
    class_names = artifact["class_names"]

    # ── Parse input data ─────────────────────────────────────────────────
    try:
        data = json.loads(data_json)
    except json.JSONDecodeError as exc:
        fail(f"Invalid JSON input: {exc}")
        return

    # Accept camelCase from the Node.js world
    rename_map = {
        "communicationScore": "communication_score",
        "socialScore": "social_score",
        "cognitiveScore": "cognitive_score",
        "motorScore": "motor_score",
        "overallScore": "overall_score",
        "ageMonths": "age_months",
    }
    for old, new in rename_map.items():
        if old in data and new not in data:
            data[new] = data[old]

    # ── Build feature vector ─────────────────────────────────────────────
    # gender_encoded is intentionally not supported here (see ml/trainer.py
    # for why). A model trained before that change will list gender_encoded
    # in its feature_columns and simply fail with a clear "missing feature"
    # error below — it needs to be retrained on a gender-free dataset rather
    # than have its predictions silently miscomputed.
    features = []
    for col in feature_columns:
        val = data.get(col)
        if val is None:
            fail(f"Missing required feature: {col}")
            return
        features.append(float(val))

    import pandas as pd
    X = pd.DataFrame([features], columns=feature_columns)

    # ── Predict ──────────────────────────────────────────────────────────
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

    result = {
        "success": True,
        "risk_category": risk_category,
        "consultation_needed": consultation_needed,
        "probabilities": prob_map,
        "features_used": feature_columns,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KinderCura ML Predictor")
    parser.add_argument("--model", required=True, help="Path to the trained .joblib model")
    parser.add_argument("--data", required=True, help="JSON string with score data")
    args = parser.parse_args()

    try:
        predict(args.model, args.data)
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"Prediction failed: {exc}")
