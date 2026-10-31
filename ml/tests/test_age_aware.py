"""
Tests for the age-aware dataset option (generate_kindercura_dataset.py
--age-aware) and ml/age_scenarios.py: a model trained on age-aware data must
judge the same answers differently by age, and the default generator output
must stay unchanged. No test framework — plain assert, like the other
ml/tests files.

Run:
    python ml/tests/test_age_aware.py
"""

import csv
import os
import sys
import tempfile
import warnings

import joblib
import pandas as pd

ML_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ML_DIR)
sys.path.insert(0, os.path.join(ML_DIR, "datasets"))

import age_scenarios  # noqa: E402
import generate_kindercura_dataset as g  # noqa: E402
import trainer  # noqa: E402

CANONICAL = os.path.join(ML_DIR, "datasets", "kindercura_assessment_dataset.csv")
SCENARIO = {label: i for i, (label, _, _) in enumerate(age_scenarios.SCENARIOS)}


def test_default_output_unchanged():
    rows, _, _ = g.generate_dataset(60, 20260819, 0.0)
    committed = list(csv.DictReader(open(CANONICAL, encoding="utf-8")))
    assert [{k: str(v) for k, v in r.items()} for r in rows] == committed


def test_age_aware_is_reproducible_and_keeps_the_age_gate():
    a, _, _ = g.generate_dataset(2000, 7, 0.0, max_age_months=g.APP_MAX_AGE_MONTHS, app_rounding=True, age_aware=True)
    b, _, _ = g.generate_dataset(2000, 7, 0.0, max_age_months=g.APP_MAX_AGE_MONTHS, app_rounding=True, age_aware=True)
    plain, _, _ = g.generate_dataset(2000, 7, 0.0, max_age_months=g.APP_MAX_AGE_MONTHS, app_rounding=True)
    assert a == b, "same seed, same rows"
    assert a != plain, "age-aware answers differ from the default process"
    for r in a:
        for qid, _, min_age in g.QUESTIONS:
            assert (r[qid] == "") == (r["age_months"] < min_age), f"{qid} age gate broken"
    assert {r["risk_category"] for r in a} == {"Low", "Medium", "High"}


def test_mastery_curve_rises_with_months_past_the_milestone():
    early, at, late = (g.age_aware_answer_probs(d) for d in (-12, 0, 12))
    assert early["no"] > at["no"] > late["no"]
    assert early["yes"] < at["yes"] < late["yes"]
    for p in (early, at, late):
        assert abs(sum(p.values()) - 1) < 1e-9 and min(p.values()) >= 0


def test_trained_model_judges_answers_by_age():
    rows, columns, _ = g.generate_dataset(
        20000, 20261031, 0.0, max_age_months=g.APP_MAX_AGE_MONTHS, app_rounding=True, age_aware=True)
    with tempfile.TemporaryDirectory() as tmp:
        result = trainer.train_dataframe(pd.DataFrame(rows, columns=columns), tmp, "score_based")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            artifact = joblib.load(result["model_path"])
    assert result["feature_importances"]["age_months"] > 0.05, "age must carry signal"

    out = age_scenarios.run_scenarios(artifact)
    risk = lambda label: out[SCENARIO[label]]["risk_category"]  # noqa: E731
    p_high = lambda label: out[SCENARIO[label]]["probabilities"]["High"]  # noqa: E731
    young_ok = "4y: earlier milestones mastered, half of the 4-year ones still emerging"
    old_lag = "8y: 6- and 7-year milestones still only emerging"

    assert risk(young_ok) == "Low"
    assert risk("8y: every milestone mastered") == "Low"
    assert risk(old_lag) == "High"
    assert risk("8y: answering like a typical 5-year-old") == "High"
    assert risk("4y: missing 3-year milestones") == "High"
    # A HIGHER overall score at 8 is still the bigger concern.
    assert out[SCENARIO[old_lag]]["overall_score"] >= out[SCENARIO[young_ok]]["overall_score"]
    assert p_high(old_lag) > p_high(young_ok) + 0.3

    evaluation = age_scenarios.evaluate_by_age(artifact, 3000)
    assert [a["age_years"] for a in evaluation["by_age"]] == [3, 4, 5, 6, 7, 8]
    assert all(a["high_recall"] >= 0.5 for a in evaluation["by_age"]), evaluation


def run():
    test_default_output_unchanged()
    test_age_aware_is_reproducible_and_keeps_the_age_gate()
    test_mastery_curve_rises_with_months_past_the_milestone()
    test_trained_model_judges_answers_by_age()
    print("Age-aware dataset and scenario tests OK")


if __name__ == "__main__":
    run()
