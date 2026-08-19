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

import csv
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


def generate_row(row_number):
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

    row = {'assessment_ref': f'TEST-{row_number:03d}', 'age_months': age_months}
    for question_id, _, _ in QUESTIONS:
        row[question_id] = question_values[question_id]
    for domain in DOMAIN_KEYS:
        row[DOMAIN_SCORE_COLUMN[domain]] = domain_scores[domain]
    row['overall_score'] = overall_score
    row['risk_category'] = risk_category
    return row


def main(n_rows=60, out_path='ml/datasets/kindercura_assessment_dataset.csv'):
    rows = [generate_row(i + 1) for i in range(n_rows)]
    fieldnames = (
        ['assessment_ref', 'age_months']
        + [q[0] for q in QUESTIONS]
        + ['communication_score', 'social_score', 'cognitive_score', 'motor_score', 'overall_score', 'risk_category']
    )
    with open(out_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    counts = {}
    for row in rows:
        counts[row['risk_category']] = counts.get(row['risk_category'], 0) + 1
    print(f'Wrote {len(rows)} synthetic rows to {out_path}')
    print(f'Class balance: {counts}')


if __name__ == '__main__':
    main()
