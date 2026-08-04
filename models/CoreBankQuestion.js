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

    // ── Provenance ───────────────────────────────────────────────────────────
    // Important: these fields record EVIDENCE, not intent. A question with no
    // recorded source must read as unknown. Do NOT give any of them a
    // non-null default — a default is an unverified claim that looks like a
    // record, which is exactly the failure this block exists to prevent.
    //
    // History: sourcedFrom previously defaulted to 'Consultant pediatrician
    // interview'. The seed script never wrote it (see toDoc() in
    // scripts/seed-core-bank-questions.js), so all 34 existing rows carry that
    // string from the schema default alone — no act of sourcing produced it.
    // Those legacy values are left in place; treat them as an unverified
    // attribution, not a citation. See docs/SCORING.md.

    // Free-text attribution, e.g. 'Consultant pediatrician interview'.
    // null = no source recorded.
    sourcedFrom: { type: String, default: null, trim: true },

    // A real, checkable citation for an external instrument or dataset —
    // e.g. 'Frankenburg WK et al., Denver II Technical Manual, 1996'.
    // This is the field that makes a question dataset-derived. null = not
    // from any external dataset. The admin Dataset tab counts rows where
    // this is set; if none are, it correctly shows zero.
    sourceCitation: { type: String, default: null, trim: true },

    // Version/edition of the cited instrument, e.g. 'Denver II (1992 rev.)'.
    sourceVersion: { type: String, default: null, trim: true },

    // When the question was imported FROM ITS SOURCE. Deliberately distinct
    // from createdAt, which only records when the seed script last ran.
    importedAt: { type: Date, default: null },

    // Groups every question brought in by one import run, so a batch can be
    // traced or reversed. Stamped by the importer, never by hand.
    importBatchId: { type: String, default: null, trim: true, index: true },

    // True = owned by the codebase; the admin UI must not offer edit/delete.
    isSystemManaged: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, collection: 'core_bank_questions' }
);

module.exports = mongoose.models.CoreBankQuestion || mongoose.model('CoreBankQuestion', coreBankQuestionSchema);
