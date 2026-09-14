"""
KinderCura model-dataset pipeline (REQUIREMENT B)
=================================================

One command that runs the whole adviser-specified flow end to end:

    DATASET -> DATA CLEANING -> PREPROCESSING -> EXISTING MODEL -> TRAINING
            -> MODEL OUTPUT / METRICS -> SAVED ARTIFACT + REPORT

Each stage is an EXISTING KinderCura component, called — not reimplemented:

    generate   ml/datasets/generate_kindercura_dataset.py  (generate_dataset)
    clean      ml/preprocess.py                            (clean_dataframe)
    train      ml/trainer.py                               (train_dataframe)

ml/trainer.py is untouched by this file: the same RandomForestClassifier, the
same train/test split, the same metric calculations that the admin Training
page has always used. The pipeline's only job is to hand it a much larger,
cleaned dataset and to record what actually happened.

WHAT THIS IS NOT
----------------
This dataset is NOT KinderCura's system users. It never becomes an account,
never enters the `users` collection, and never appears in Admin Analytics.
50,000 dataset rows are 50,000 simulated ASSESSMENTS for the classifier to
learn from — the 1,000+ synthetic system users are a separate concern handled
by scripts/generate-system-demo-data.js. See
docs/synthetic-data-and-model-pipeline.md.

NO FABRICATED METRICS
---------------------
Every accuracy/precision/recall/F1 number in the report comes from
trainer.py's own evaluation on its held-out test split. Nothing in this file
computes, adjusts, rounds up, defaults or hardcodes a metric. If training
fails, the report says so and carries no metrics at all.

Usage
-----
    python ml/pipeline.py --rows 50000
    python ml/pipeline.py --rows 50000 --feature-set question_based
    python ml/pipeline.py --rows 50000 --skip-training     # generate + clean only
    python ml/pipeline.py --rows 50000 --json              # machine-readable

Exit codes
    0  every requested stage succeeded  (report JSON written)
    1  a stage failed                   (error JSON on stdout)
"""

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone

import pandas as pd

ML_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(ML_DIR)
sys.path.insert(0, ML_DIR)
sys.path.insert(0, os.path.join(ML_DIR, "datasets"))

import preprocess  # noqa: E402  (path set up above)
import trainer     # noqa: E402
# Imported by bare module name off ml/datasets/, not as `from datasets import …`:
# `datasets` is also the name of a widely-installed third-party package, and a
# package-style import here would silently resolve to that one on any machine
# where it happens to be present.
import generate_kindercura_dataset as generator  # noqa: E402

# Where pipeline artifacts live. Kept out of ml/datasets/ so the canonical
# 60-row committed dataset is never confused with a large generated run, and
# git-ignored (see .gitignore) because a 50,000-row CSV does not belong in the
# repository.
DEFAULT_OUTPUT_DIR = os.path.join(ML_DIR, "datasets", "generated")
DEFAULT_MODEL_DIR = os.path.join(PROJECT_ROOT, "uploads", "models")

# A small, seeded fraction of rows is generated with realistic data-quality
# defects so the cleaning stage has something real to find and its counts mean
# something. Reported explicitly as INJECTED so nobody mistakes them for
# accidental corruption. Set --defect-rate 0 for a perfectly clean dataset.
DEFAULT_DEFECT_RATE = 0.02


def dataset_version(seed: int, rows: int, when: datetime) -> str:
    """Stable, human-readable identity for one pipeline run."""
    return f"syn-{seed}-{rows}-{when.strftime('%Y%m%d%H%M%S')}"


def run_pipeline(rows=50000, seed=20260903, feature_set="score_based",
                 output_dir=None, model_dir=None, defect_rate=DEFAULT_DEFECT_RATE,
                 normalize=False, skip_training=False, progress=None):
    """Run generate -> clean -> train and return the full report dictionary."""
    started = datetime.now(timezone.utc)
    output_dir = output_dir or DEFAULT_OUTPUT_DIR
    model_dir = model_dir or DEFAULT_MODEL_DIR
    os.makedirs(output_dir, exist_ok=True)

    version = dataset_version(seed, rows, started)
    raw_path = os.path.join(output_dir, f"{version}_raw.csv")
    clean_path = os.path.join(output_dir, f"{version}_clean.csv")
    report_path = os.path.join(output_dir, f"{version}_report.json")

    def say(message):
        if progress:
            progress(message)

    # ── Stage 1: generate ────────────────────────────────────────────────
    say(f"Generating {rows:,} synthetic assessment records (seed {seed})...")
    generated_rows, columns, injected = generator.generate_dataset(
        n_rows=rows, seed=seed, defect_rate=defect_rate
    )
    generator.write_dataset(generated_rows, columns, raw_path)
    generation = {
        "script": "ml/datasets/generate_kindercura_dataset.py",
        "seed": seed,
        "requested_rows": rows,
        # Injected duplicates are APPENDED, so the file can hold more rows than
        # were requested. Reporting both makes that visible rather than looking
        # like an off-by-N.
        "generated_rows": len(generated_rows),
        "defect_rate": defect_rate,
        "injected_defects": injected,
        "raw_path": raw_path.replace("\\", "/"),
    }
    say(f"Generated {len(generated_rows):,} rows -> {raw_path}")

    # ── Stage 2: clean / preprocess ──────────────────────────────────────
    say("Cleaning and preprocessing...")
    # preprocess.load_dataset, not pd.read_csv: it disables pandas' default
    # missing-value coercion so a corrupt cell like "n/a" is counted as invalid
    # instead of being laundered into an indistinguishable blank.
    raw_df = preprocess.load_dataset(raw_path)
    clean_df, cleaning = preprocess.clean_dataframe(raw_df, normalize=normalize)
    clean_df.to_csv(clean_path, index=False)
    cleaning["input_path"] = raw_path.replace("\\", "/")
    cleaning["output_path"] = clean_path.replace("\\", "/")
    for line in preprocess.summary_lines(cleaning):
        say("  " + line)

    report = {
        "success": True,
        "dataset_version": version,
        "started_at": started.isoformat(),
        "feature_set": feature_set,
        "generation": generation,
        "cleaning": cleaning,
        "training": None,
        "files": {
            "raw": raw_path.replace("\\", "/"),
            "clean": clean_path.replace("\\", "/"),
            "report": report_path.replace("\\", "/"),
        },
    }

    # ── Stage 3: train the EXISTING model on the cleaned dataset ─────────
    if skip_training:
        say("--skip-training: the cleaned dataset was not passed to the model.")
    else:
        say(f"Training ml/trainer.py ({feature_set}) on {len(clean_df):,} cleaned rows...")
        # Re-read from disk through the TRAINER'S OWN loader rather than passing
        # clean_df straight through. Two reasons: what the model trains on is
        # provably the exact bytes an examiner can open, and it is parsed by the
        # same code path a manual `python ml/trainer.py --input <clean.csv>` run
        # would use — so this pipeline cannot succeed on a file the trainer
        # would have read differently.
        training_df = trainer.load_dataset(clean_path)
        result = trainer.train_dataframe(training_df, model_dir, feature_set)
        report["training"] = result
        say(f"  accuracy {result['accuracy']:.4f}  precision {result['precision']:.4f} "
            f" recall {result['recall']:.4f}  f1 {result['f1']:.4f}")
        say(f"  train {result['training_samples']:,} / test {result['test_samples']:,} samples")
        say(f"  model artifact: {result['model_path']}")

    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    report["duration_seconds"] = round(
        (datetime.now(timezone.utc) - started).total_seconds(), 2
    )

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    return report


def print_human_summary(report):
    """The demonstration block: dataset -> cleaning -> model, real numbers only."""
    cleaning = report["cleaning"]
    print("")
    print("=" * 62)
    print("  KinderCura model dataset pipeline")
    print("=" * 62)
    print(f"  Dataset version : {report['dataset_version']}")
    print(f"  Seed            : {report['generation']['seed']}")
    print(f"  Feature set     : {report['feature_set']}")
    print("")
    print("  MODEL DATASET")
    for line in preprocess.summary_lines(cleaning):
        print("    " + line)
    if cleaning["rejections_by_reason"]:
        print("    Rejected by reason:")
        for reason, count in sorted(cleaning["rejections_by_reason"].items(), key=lambda kv: -kv[1]):
            print(f"      {reason}: {count:,}")
    print(f"    Class distribution: {cleaning['class_distribution']}")
    print("")

    training = report.get("training")
    print("  MODEL")
    if not training:
        print("    Training completed: NO (skipped)")
    else:
        print("    Training completed: YES")
        print(f"    Used for training : {training['total_rows']:,} rows "
              f"({training['training_samples']:,} train / {training['test_samples']:,} test)")
        print(f"    Accuracy          : {training['accuracy']}")
        print(f"    Precision         : {training['precision']}")
        print(f"    Recall            : {training['recall']}")
        print(f"    F1 score          : {training['f1']}")
        print(f"    Classes           : {', '.join(training['class_names'])}")
        print(f"    Model artifact    : {training['model_path']}")
    for warning in cleaning.get("warnings", []):
        print(f"    WARNING: {warning}")
    print("")
    print(f"  Full report: {report['files']['report']}")
    print("=" * 62)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KinderCura model-dataset pipeline")
    parser.add_argument("--rows", type=int, default=50000,
                        help="How many dataset records to generate (default 50000).")
    parser.add_argument("--seed", type=int, default=20260903,
                        help="Random seed. Same seed + same row count => identical dataset.")
    parser.add_argument("--feature-set", choices=["score_based", "question_based"],
                        default="score_based",
                        help="Which ml/trainer.py feature set to train on.")
    parser.add_argument("--output-dir", default=None, help="Where to write dataset artifacts.")
    parser.add_argument("--model-dir", default=None, help="Where to save the trained .joblib model.")
    parser.add_argument("--defect-rate", type=float, default=DEFAULT_DEFECT_RATE,
                        help="Fraction of rows generated with data-quality defects "
                             "so the cleaning stage is demonstrably doing something.")
    parser.add_argument("--normalize", action="store_true",
                        help="Min-max scale the score columns during preprocessing.")
    parser.add_argument("--skip-training", action="store_true",
                        help="Generate and clean only; do not train.")
    parser.add_argument("--json", action="store_true", help="Print the report JSON instead of a summary.")
    args = parser.parse_args()

    try:
        pipeline_report = run_pipeline(
            rows=args.rows,
            seed=args.seed,
            feature_set=args.feature_set,
            output_dir=args.output_dir,
            model_dir=args.model_dir,
            defect_rate=args.defect_rate,
            normalize=args.normalize,
            skip_training=args.skip_training,
            progress=None if args.json else (lambda m: print(m, flush=True)),
        )
        if args.json:
            print(json.dumps(pipeline_report))
        else:
            print_human_summary(pipeline_report)
    except (preprocess.CleaningError, trainer.TrainingError) as err:
        print(json.dumps({"success": False, "error": str(err)}))
        sys.exit(1)
    except Exception as exc:
        print(json.dumps({
            "success": False,
            "error": f"Pipeline failed: {exc}",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)
