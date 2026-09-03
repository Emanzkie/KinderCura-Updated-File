"""
ml/datasets/generate_kindercura_dataset.py

Generates the canonical KinderCura ML training dataset:
    ml/datasets/kindercura_assessment_dataset.csv

SYNTHETIC / TEST DATA ONLY — see ml/datasets/README.md for full provenance,
the answer encoding, and (most importantly) the target-label / data-leakage
caveats before using this file to draw ANY conclusion about real children.
This script exists so the dataset is reproducible and its generation process
is auditable, rather than a set of numbers typed by hand.

Column structure mirrors real KinderCura code, not an invented schema:
- Question ids, domains, and minimum ages mirror js/parent/screening.js's
  DOCTOR_QUESTION_BANK exactly (34 questions, Q01-Q34; see
  models/CoreBankQuestion.js). This is DATA (question metadata) copied for
  dataset-generation purposes — the actual scoring FORMULA still lives only
  in routes/assessments.js; this script does not reimplement or override it,
  it reproduces the same 2/1/0 point arithmetic on synthetic answers.
- Per-question answer values (0/1/2) mirror routes/assessments.js
  scoreAnswer() exactly: yes=2, sometimes=1, no=0 (also covers the
  age_months blank/absent case for questions this synthetic child's age
  does not reach yet — see AGE GATING below).
- communication_score / social_score / cognitive_score / motor_score /
  overall_score are computed with the exact same rounding formula
  routes/assessments.js POST /submit uses.
- risk_category is the ml/trainer.py training target (Low/Medium/High).

AGE GATING: DOCTOR_QUESTION_BANK only shows a question once the child is at
least `minAgeMonths` old, so a real assessment never has an answer for every
one of the 34 questions — younger children see fewer. This generator
reproduces that: a question's column is left BLANK (not "0"/"no") for a
synthetic child too young for it. Blank means "not administered", not "no".

WHY risk_category IS NOT A THRESHOLD OF THE SCORES (avoiding data leakage):
Each row's target class is chosen FIRST (uniformly at random), THEN answers
are sampled from a class-conditional but heavily OVERLAPPING distribution
(see ANSWER_PROBS), and finally ~18% of rows have their label perturbed to a
neighboring class AFTER scores are computed. If risk_category were instead
computed directly from overall_score by a fixed rule, training a model to
predict risk_category from overall_score would just be re-learning that
rule — perfect, meaningless accuracy, and NOT evidence the model found any
real pattern. See README.md "Data leakage" for the full explanation. This
generation process also avoids the opposite failure mode of trivially
separable classes (e.g. Low = always high scores, High = always low scores)
by design of the overlap. This does NOT make the resulting labels clinically
meaningful — they are still fabricated for this thesis project, not sourced
from real outcomes. Real ML validity requires independently-labeled real
assessment outcomes (e.g. a pediatrician's actual clinicalOutcome — see
models/Assessment.js clinicalOutcome — collected after enough real,
reviewed assessments exist).
"""

import argparse
import csv
import os
import random

random.seed(20260819)  # fixed, documented seed -> this exact file is reproducible

# ── Question bank (mirrors js/parent/screening.js DOCTOR_QUESTION_BANK) ────
# (question_id, scoring_domain, minimum_age_months)
QUESTIONS = [
    ('Q02', 'motor', 36), ('Q05', 'communication', 36), ('Q07', 'social', 36),
    ('Q08', 'social', 36), ('Q01', 'motor', 36), ('Q03', 'motor', 36),
    ('Q04', 'motor', 36), ('Q06', 'cognitive', 36),
    ('Q09', 'motor', 42),
    ('Q10', 'motor', 48), ('Q11', 'motor', 48), ('Q14', 'communication', 48),
    ('Q18', 'social', 48), ('Q19', 'social', 48), ('Q12', 'motor', 48),
    ('Q13', 'motor', 48), ('Q15', 'communication', 48), ('Q16', 'cognitive', 48),
    ('Q17', 'social', 48),
    ('Q26', 'social', 60), ('Q20', 'motor', 60), ('Q21', 'cognitive', 60),
    ('Q22', 'communication', 60), ('Q23', 'communication', 60), ('Q24', 'social', 60),
    ('Q25', 'cognitive', 60),
    ('Q29', 'communication', 72), ('Q31', 'social', 72), ('Q27', 'motor', 72),
    ('Q28', 'motor', 72), ('Q30', 'cognitive', 72), ('Q32', 'social', 72),
    ('Q33', 'motor', 84), ('Q34', 'cognitive', 84),
]
DOMAIN_KEYS = ['communication', 'social', 'cognitive', 'motor']
DOMAIN_SCORE_COLUMN = {
    'communication': 'communication_score',
    'social': 'social_score',
    'cognitive': 'cognitive_score',
    'motor': 'motor_score',
}

# routes/assessments.js scoreAnswer(): yes=2, sometimes=1, anything else=0.
ANSWER_SCORE = {'yes': 2, 'sometimes': 1, 'no': 0}

# Class-conditional answer distributions. Deliberately OVERLAPPING between
# classes (not e.g. Low=100% yes, High=100% no) — see module docstring.
ANSWER_PROBS = {
    'Low':    {'yes': 0.62, 'sometimes': 0.24, 'no': 0.14},
    'Medium': {'yes': 0.40, 'sometimes': 0.34, 'no': 0.26},
    'High':   {'yes': 0.22, 'sometimes': 0.30, 'no': 0.48},
}

LABEL_NOISE_RATE = 0.18  # fraction of rows whose final label is perturbed
NEIGHBOR_CLASS = {'Low': ['Medium'], 'Medium': ['Low', 'High'], 'High': ['Medium']}


def sample_answer(true_class):
    probs = ANSWER_PROBS[true_class]
    r = random.random()
    if r < probs['yes']:
        return 'yes'
    if r < probs['yes'] + probs['sometimes']:
        return 'sometimes'
    return 'no'


def generate_row(row_number, ref_width=3):
    true_class = random.choice(['Low', 'Medium', 'High'])
    age_months = random.randint(36, 95)

    domain_earned = {k: 0 for k in DOMAIN_KEYS}
    domain_total = {k: 0 for k in DOMAIN_KEYS}
    question_values = {}

    for question_id, domain, min_age_months in QUESTIONS:
        if age_months < min_age_months:
            question_values[question_id] = ''  # not administered (age-gated), not "no"
            continue
        answer = sample_answer(true_class)
        score = ANSWER_SCORE[answer]
        question_values[question_id] = score
        domain_total[domain] += 2  # 2 points possible per question, per scoreAnswer()
        domain_earned[domain] += score

    domain_scores = {}
    for domain in DOMAIN_KEYS:
        domain_scores[domain] = round(domain_earned[domain] / domain_total[domain] * 100) if domain_total[domain] else 0
    overall_score = round(sum(domain_scores.values()) / len(DOMAIN_KEYS))

    # Label noise — see module docstring "WHY risk_category IS NOT A
    # THRESHOLD OF THE SCORES". Perturb a fraction of rows to a neighboring
    # class AFTER the scores above are already fixed.
    risk_category = true_class
    if random.random() < LABEL_NOISE_RATE:
        risk_category = random.choice(NEIGHBOR_CLASS[true_class])

    row = {'assessment_ref': f'TEST-{row_number:0{ref_width}d}', 'age_months': age_months}
    for question_id, _, _ in QUESTIONS:
        row[question_id] = question_values[question_id]
    for domain in DOMAIN_KEYS:
        row[DOMAIN_SCORE_COLUMN[domain]] = domain_scores[domain]
    row['overall_score'] = overall_score
    row['risk_category'] = risk_category
    return row


def fieldnames():
    """Canonical column order. Single source of truth for both the writer here
    and ml/preprocess.py's schema validation."""
    return (
        ['assessment_ref', 'age_months']
        + [q[0] for q in QUESTIONS]
        + ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'risk_category']
    )


# ── Deliberate data-quality defects (opt-in, off by default) ──────────────
# WHY THIS EXISTS: a generator that only ever emits perfect rows makes the
# cleaning stage (ml/preprocess.py) untestable and its report meaningless —
# "invalid: 0, duplicates: 0" every single run proves nothing about whether
# the cleaner works. Injecting a SEEDED, COUNTED fraction of realistic defects
# gives the preprocessing step something real to find, and the pipeline report
# states plainly how many were injected so the cleaning counts can be checked
# against a known expected number rather than taken on trust.
#
# Defaults to 0.0, so the canonical 60-row dataset and every existing test are
# byte-for-byte unaffected. Uses its OWN random.Random instance so enabling it
# never perturbs the main generation stream.
DEFECT_KINDS = (
    'missing_score',    # a required score cell left blank
    'missing_age',      # age_months left blank (imputable)
    'invalid_label',    # risk_category blank or an unrecognized word
    'out_of_range',     # a percentage score outside 0-100
    'invalid_answer',   # a Q0N cell holding a value that is not yes/sometimes/no or 0/1/2
    'duplicate',        # an exact copy of an earlier row
)

SCORE_COLUMNS = ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score']


def inject_defects(rows, defect_rate, seed):
    """Corrupt a `defect_rate` fraction of *rows* in place (plus append exact
    duplicates) and return a dict of how many of each kind were injected.

    Returns {} and leaves rows untouched when defect_rate <= 0.
    """
    if defect_rate <= 0 or not rows:
        return {}

    rng = random.Random(seed + 1)  # separate stream: never disturbs generation
    injected = {kind: 0 for kind in DEFECT_KINDS}
    n_defects = int(len(rows) * defect_rate)
    if n_defects <= 0:
        return injected

    # Never corrupt the same row twice: overlapping defects make the expected
    # invalid-row count ambiguous, which defeats the purpose of counting them.
    targets = rng.sample(range(len(rows)), min(n_defects, len(rows)))
    duplicates = []

    for idx in targets:
        kind = rng.choice(DEFECT_KINDS)
        row = rows[idx]
        if kind == 'missing_score':
            row[rng.choice(SCORE_COLUMNS)] = ''
        elif kind == 'missing_age':
            row['age_months'] = ''
        elif kind == 'invalid_label':
            row['risk_category'] = rng.choice(['', 'Unknown', 'N/A', 'moderate'])
        elif kind == 'out_of_range':
            row[rng.choice(SCORE_COLUMNS)] = rng.choice([150, -5, 999])
        elif kind == 'invalid_answer':
            answered = [q[0] for q in QUESTIONS if row.get(q[0]) != '']
            if not answered:
                continue
            row[rng.choice(answered)] = rng.choice(['maybe', 'n/a', '5'])
        elif kind == 'duplicate':
            duplicates.append(dict(row))
        injected[kind] += 1

    rows.extend(duplicates)
    return injected


def generate_dataset(n_rows=60, seed=20260819, defect_rate=0.0):
    """Generate *n_rows* synthetic assessment rows.

    Reproducible: the same (n_rows, seed, defect_rate) always yields the same
    rows. This is the function ml/pipeline.py calls for the 50,000-record model
    dataset; `main()` below is the thin CLI/canonical-file wrapper around it.

    Returns (rows, fieldnames, injected_defects).
    """
    random.seed(seed)
    ref_width = max(3, len(str(max(n_rows, 1))))
    rows = [generate_row(i + 1, ref_width) for i in range(n_rows)]
    injected = inject_defects(rows, defect_rate, seed)
    return rows, fieldnames(), injected


def write_dataset(rows, columns, out_path):
    """Write *rows* to *out_path* as CSV, creating parent directories."""
    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(out_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    return out_path


def main(n_rows=60, out_path='ml/datasets/kindercura_assessment_dataset.csv',
         seed=20260819, defect_rate=0.0):
    rows, columns, injected = generate_dataset(n_rows, seed, defect_rate)
    write_dataset(rows, columns, out_path)

    counts = {}
    for row in rows:
        counts[row['risk_category']] = counts.get(row['risk_category'], 0) + 1
    print(f'Wrote {len(rows)} synthetic rows to {out_path}')
    print(f'Class balance: {counts}')
    if injected:
        print(f'Injected defects: {injected}')
    return rows, columns, injected


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Generate the synthetic KinderCura assessment dataset.'
    )
    parser.add_argument('--rows', type=int, default=60,
                        help='How many rows to generate (default 60, the canonical file).')
    parser.add_argument('--out', default='ml/datasets/kindercura_assessment_dataset.csv',
                        help='Output CSV path.')
    parser.add_argument('--seed', type=int, default=20260819,
                        help='Random seed. Same seed + same row count => identical file.')
    parser.add_argument('--defect-rate', type=float, default=0.0,
                        help='Fraction of rows to corrupt with realistic data-quality '
                             'defects, so the cleaning stage has something to find. '
                             'Default 0.0 keeps the canonical file clean.')
    cli = parser.parse_args()
    main(cli.rows, cli.out, cli.seed, cli.defect_rate)
