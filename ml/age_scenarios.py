"""
KinderCura age scenarios
========================
Shows what a trained model predicts for children of different ages with the
same kind of answers, the question a developmental screen has to answer:
is a weak result normal for THIS age, or a concern?

  1. Scenario table: hand-built children (a typical 4-year-old whose
     newest milestones are still emerging, an 8-year-old answering like a
     5-year-old, ...) run through ml/predict.py's predict_from_artifact, the
     same function live predictions use. Works for score-based and
     question-based models: each scenario carries both its Q01-Q34 answers
     and the domain scores routes/assessments.js would compute from them.
  2. Per-age evaluation (optional, --eval-rows): accuracy and High-risk
     recall per year of age on fresh rows from the age-aware generator
     (ml/datasets/generate_kindercura_dataset.py --age-aware), with a seed
     different from any training file.

Read-only: loads an artifact, writes nothing.

Usage:
    python ml/age_scenarios.py --model <path_to_joblib> [--eval-rows 10000] [--json]
"""

import argparse
import json
import os
import sys

import joblib

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)
sys.path.insert(0, os.path.join(ML_DIR, "datasets"))

import generate_kindercura_dataset as generator  # noqa: E402
from predict import encode_question_value_for_predict, predict_from_artifact  # noqa: E402

ANSWER_POINTS = {"yes": 2, "sometimes": 1, "no": 0}
DOMAIN_COLUMN = {
    "communication": "communication_score",
    "social": "social_score",
    "cognitive": "cognitive_score",
    "motor": "motor_score",
}
EVAL_SEED = 20261101


def build_child(age_months, answer_for_min_age):
    """Answers for every item a child of this age is shown (the app's age
    gate), chosen by the item's minAgeMonths, plus the domain and overall
    scores routes/assessments.js POST /submit computes from them."""
    child = {"age_months": age_months}
    earned = {d: 0 for d in DOMAIN_COLUMN}
    total = {d: 0 for d in DOMAIN_COLUMN}
    for index, (qid, domain, min_age) in enumerate(generator.QUESTIONS):
        if age_months < min_age:
            continue
        answer = answer_for_min_age(min_age, index)
        child[qid] = answer
        earned[domain] += ANSWER_POINTS[answer]
        total[domain] += 2
    for d, column in DOMAIN_COLUMN.items():
        child[column] = generator.app_round(earned[d] / total[d] * 100) if total[d] else 0
    child["overall_score"] = generator.app_round(sum(child[c] for c in DOMAIN_COLUMN.values()) / 4)
    return child


# (label, age in months, answer rule). A rule gets an item's minAgeMonths and
# its position in the question bank and returns yes / sometimes / no. Rows
# 1 and 5 have the SAME overall score at different ages, the panel's question.
SCENARIOS = [
    ("4y: earlier milestones mastered, half of the 4-year ones still emerging",
     49, lambda m, i: "yes" if m < 48 or i % 2 == 0 else "sometimes"),
    ("4y: earlier milestones mastered, every 4-year one only emerging",
     49, lambda m, i: "yes" if m < 48 else "sometimes"),
    ("4y: missing 3-year milestones",
     49, lambda m, i: "no" if m == 36 else "sometimes"),
    ("8y: every milestone mastered",
     100, lambda m, i: "yes"),
    ("8y: 6- and 7-year milestones still only emerging",
     100, lambda m, i: "yes" if m < 72 else "sometimes"),
    ("8y: answering like a typical 5-year-old",
     100, lambda m, i: "yes" if m <= 48 else ("sometimes" if m == 60 else "no")),
    ("8y: missing 3- and 4-year milestones",
     100, lambda m, i: "sometimes" if m == 36 else "no"),
]


def run_scenarios(artifact):
    rows = []
    for label, age, rule in SCENARIOS:
        child = build_child(age, rule)
        result = predict_from_artifact(artifact, child)
        rows.append({
            "scenario": label,
            "age_months": age,
            "overall_score": child["overall_score"],
            "risk_category": result["risk_category"],
            "probabilities": result["probabilities"],
        })
    return rows


def evaluate_by_age(artifact, n_rows=10000, seed=EVAL_SEED):
    """Accuracy and High-risk recall per year of age on fresh age-aware rows."""
    import pandas as pd

    rows, _, _ = generator.generate_dataset(
        n_rows, seed, 0.0, max_age_months=generator.APP_MAX_AGE_MONTHS, app_rounding=True, age_aware=True)
    columns = artifact["feature_columns"]
    X = pd.DataFrame(
        [[encode_question_value_for_predict(r.get(c)) if c.startswith("Q") else float(r[c]) for c in columns] for r in rows],
        columns=columns,
    )
    predicted = artifact["label_encoder"].inverse_transform(artifact["classifier"].predict(X))

    by_year = {}
    for row, pred in zip(rows, predicted):
        year = row["age_months"] // 12
        s = by_year.setdefault(year, {"n": 0, "correct": 0, "high": 0, "high_found": 0})
        s["n"] += 1
        s["correct"] += int(pred == row["risk_category"])
        if row["risk_category"] == "High":
            s["high"] += 1
            s["high_found"] += int(pred == "High")
    out = []
    for year in sorted(by_year):
        s = by_year[year]
        out.append({
            "age_years": year,
            "rows": s["n"],
            "accuracy": round(s["correct"] / s["n"], 3),
            "high_recall": round(s["high_found"] / s["high"], 3) if s["high"] else None,
        })
    overall = sum(s["correct"] for s in by_year.values()) / max(1, sum(s["n"] for s in by_year.values()))
    return {"accuracy": round(overall, 3), "by_age": out}


def format_report(model_path, artifact, scenarios, evaluation):
    lines = [
        f"Model: {os.path.basename(model_path)} "
        f"({artifact.get('feature_set_type', 'score_based')}, {len(artifact['feature_columns'])} features)",
        "",
        f"{'Scenario':<74} {'Overall':>7}  {'Risk':<6}  Low / Medium / High",
    ]
    for s in scenarios:
        p = s["probabilities"]
        lines.append(f"{s['scenario']:<74} {s['overall_score']:>6}%  {s['risk_category']:<6}  "
                     f"{p.get('Low', 0):.2f} / {p.get('Medium', 0):.2f} / {p.get('High', 0):.2f}")
    if evaluation:
        lines += ["", f"Fresh age-aware rows: accuracy {evaluation['accuracy']:.3f}",
                  f"{'Age':>4} {'Rows':>6} {'Accuracy':>9} {'High recall':>12}"]
        for a in evaluation["by_age"]:
            recall = "—" if a["high_recall"] is None else f"{a['high_recall']:.3f}"
            lines.append(f"{a['age_years']:>3}y {a['rows']:>6} {a['accuracy']:>9.3f} {recall:>12}")
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Age scenarios for a trained KinderCura model.")
    parser.add_argument("--model", required=True, help="Path to a trained .joblib artifact")
    parser.add_argument("--eval-rows", type=int, default=0,
                        help="Also evaluate per year of age on this many fresh age-aware rows")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of a table")
    cli = parser.parse_args()

    loaded = joblib.load(cli.model)
    scenario_rows = run_scenarios(loaded)
    evaluation = evaluate_by_age(loaded, cli.eval_rows) if cli.eval_rows > 0 else None
    if cli.json:
        print(json.dumps({"scenarios": scenario_rows, "evaluation": evaluation}, indent=2))
    else:
        print(format_report(cli.model, loaded, scenario_rows, evaluation))
