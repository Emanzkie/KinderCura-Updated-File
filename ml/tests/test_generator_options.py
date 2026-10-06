"""
Tests for the production-dataset options of
ml/datasets/generate_kindercura_dataset.py (unique, max_age_months,
app_rounding) and for ml/preprocess.py's duplicate detection on large files.
No test framework — plain assert, like the other ml/tests files.

Run:
    python ml/tests/test_generator_options.py
"""

import csv
import math
import os
import sys
import tempfile

ML_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ML_DIR)
sys.path.insert(0, os.path.join(ML_DIR, "datasets"))

import generate_kindercura_dataset as g  # noqa: E402
import preprocess  # noqa: E402

CANONICAL = os.path.join(ML_DIR, "datasets", "kindercura_assessment_dataset.csv")
DOMAIN_COLUMN = {"communication": "communication_score", "social": "social_score",
                 "cognitive": "cognitive_score", "motor": "motor_score"}


def app_scores(row):
    """Scores exactly as routes/assessments.js POST /submit computes them (Math.round)."""
    earned = {d: 0 for d in DOMAIN_COLUMN}
    total = {d: 0 for d in DOMAIN_COLUMN}
    for qid, domain, _ in g.QUESTIONS:
        if row[qid] != "":
            earned[domain] += int(row[qid])
            total[domain] += 2
    domains = {d: (math.floor(earned[d] / total[d] * 100 + 0.5) if total[d] else 0) for d in DOMAIN_COLUMN}
    return domains, math.floor(sum(domains.values()) / 4 + 0.5)


def test_defaults_still_reproduce_canonical_file():
    rows, _, _ = g.generate_dataset(60, 20260819, 0.0)
    committed = list(csv.DictReader(open(CANONICAL, encoding="utf-8")))
    assert [{k: str(v) for k, v in r.items()} for r in rows] == committed


def test_unique_full_age_range_app_rounding():
    stats = {}
    rows, columns, injected = g.generate_dataset(
        4000, 20261006, 0.0, max_age_months=g.APP_MAX_AGE_MONTHS, unique=True, stats=stats, app_rounding=True)
    assert len(rows) == 4000 and injected == {}
    assert len({g.observation_key(r) for r in rows}) == 4000, "rows must be distinct observations"
    assert stats["drawn"] - stats["duplicates_discarded"] == 4000
    assert len({r["assessment_ref"] for r in rows}) == 4000
    ages = [r["age_months"] for r in rows]
    assert min(ages) >= 36 and max(ages) <= 107 and any(a >= 96 for a in ages), "8-year-olds must be covered"
    for r in rows:
        for qid, _, min_age in g.QUESTIONS:
            assert (r[qid] == "") == (r["age_months"] < min_age), f"{qid} age gate broken for {r['assessment_ref']}"
        domains, overall = app_scores(r)
        assert all(r[DOMAIN_COLUMN[d]] == domains[d] for d in DOMAIN_COLUMN), r["assessment_ref"]
        assert r["overall_score"] == overall, r["assessment_ref"]
    labels = {r["risk_category"] for r in rows}
    assert labels == {"Low", "Medium", "High"}


def test_preprocess_finds_every_duplicate_in_a_large_file():
    # Big enough that pandas would parse it in several chunks; the injected
    # invalid answers make some Q columns non-numeric in later chunks only.
    rows, columns, _ = g.generate_dataset(30000, 20260903, 0.02)
    expected = len(rows) - len({g.observation_key(r) for r in rows})
    with tempfile.TemporaryDirectory() as tmp:
        path = g.write_dataset(rows, columns, os.path.join(tmp, "raw.csv"))
        _, report = preprocess.clean_dataframe(preprocess.load_dataset(path))
    assert report["duplicates_removed"] == expected, (report["duplicates_removed"], expected)


def run():
    test_defaults_still_reproduce_canonical_file()
    test_unique_full_age_range_app_rounding()
    test_preprocess_finds_every_duplicate_in_a_large_file()
    print("Generator option tests OK")


if __name__ == "__main__":
    run()
