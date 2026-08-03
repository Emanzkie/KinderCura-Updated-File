// CoreBankQuestion model
// The fixed, system-wide screening question baseline (Q01–Q34).
//
// Mechanism, not authorship — see constants/dataOrigin.js:
// these questions have NO pediatricianId, are identical for every child and
// every clinic, and change only by code deploy. That is what separates them
// from PediaCustomQuestion, which pediatricians create at runtime.
//
// Provenance is a separate axis and lives in `sourcedFrom`: the content was
// transcribed from our consultant pediatrician's interview
// (see js/parent/screening.js:4). These are NOT a public dataset, and not the
// ML training data in ml/test_dataset.csv or the TrainingDataset collection.
//
// Seeded from the DOCTOR_QUESTION_BANK literal in js/parent/screening.js by
// scripts/seed-core-bank-questions.js — that file is still the source of truth
// until the frontend is switched over to fetching from the API.

const mongoose = require('mongoose');
const { DATA_ORIGIN } = require('../constants/dataOrigin');

const coreBankQuestionSchema = new mongoose.Schema(
  {
    // Stable public id, e.g. 'Q01'. Unique on its own — unlike the old
    // questions-database.json ids, these do not repeat across age groups.
    questionId: { type: String, required: true, unique: true, index: true, trim: true },

    text: { type: String, required: true, trim: true },

    // Scoring domain. Must match the buckets in routes/assessments.js so the
    // existing score totals keep working: Communication / Social Skills /
    // Cognitive / Motor Skills.
    domain: { type: String, required: true, trim: true, index: true },

    // Domain shown to the parent, e.g. 'Gross Motor'. Purely presentational.
    displayDomain: { type: String, default: '', trim: true },

    // The bank is age-gated by minimum age in months, not by an age-group label.
    minAgeMonths: { type: Number, required: true, index: true },

    difficulty: { type: String, default: '', trim: true },

    // The live bank renders fixed Yes/Sometimes/No choices in the frontend,
    // so this is empty for now. Kept so per-question options are possible later.
    options: { type: [String], default: [] },

    // Enum deliberately allows only CORE_BANK. Anything else throws a
    // validation error rather than quietly creating a mislabelled row.
    origin: {
      type: String,
      enum: [DATA_ORIGIN.CORE_BANK],
      default: DATA_ORIGIN.CORE_BANK,
      index: true,
    },

    // Real-world provenance, surfaced as "Created By" in the admin table so the
    // doctor-interview origin is never lost behind the mechanism label.
    sourcedFrom: { type: String, default: 'Consultant pediatrician interview', trim: true },

    // True = owned by the codebase; the admin UI must not offer edit/delete.
    isSystemManaged: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: 'core_bank_questions' }
);

module.exports = mongoose.models.CoreBankQuestion || mongoose.model('CoreBankQuestion', coreBankQuestionSchema);
