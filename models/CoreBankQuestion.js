// CoreBankQuestion model
// The SYSTEM-PROVIDED screening question catalogue: fixed questions with no
// pediatricianId, identical for every child and clinic, changeable only by
// code deploy or an import run. That is what separates every row here from
// PediaCustomQuestion, which pediatricians author at runtime.
//
// This collection holds TWO distinct question origins, told apart by `origin`
// (see constants/dataOrigin.js) — they must never be conflated:
//
//   core_bank        → came from our consultant pediatrician's interview
//                      (see js/parent/screening.js:4). Q01–Q34 today. Carries
//                      NO sourceCitation; the interview is an attribution, not
//                      an external dataset.
//   dataset_question → came from an actual external dataset / published
//                      instrument. MUST carry a checkable sourceCitation —
//                      enforced below, so a question can never claim external
//                      provenance it does not have. It must also record how its
//                      wording was produced (generationMethod) and where it sits
//                      in the pediatrician review lifecycle (approvalStatus),
//                      and it cannot go isActive until that review says
//                      "approved". The catalogue lives in
//                      constants/datasetQuestions.js.
//
// Neither is ML training data. That lives in ml/test_dataset.csv and the
// TrainingDataset collection (aggregate scores + risk_category).
//
// The core_bank rows are seeded from the DOCTOR_QUESTION_BANK literal in
// js/parent/screening.js by scripts/seed-core-bank-questions.js — that file is
// still the source of truth until the frontend fetches from the API. That
// script only ever writes core_bank and leaves dataset_question rows alone.

const mongoose = require('mongoose');
const {
  DATA_ORIGIN,
  SYSTEM_QUESTION_ORIGINS,
  APPROVAL_STATUS,
  APPROVAL_STATUS_VALUES,
  GENERATION_METHOD_VALUES,
} = require('../constants/dataOrigin');

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

    // Which of the two SYSTEM-PROVIDED origins this row is. pedia_entry is
    // deliberately excluded — those live in pedia_custom_questions and always
    // have an author. Anything else throws a validation error rather than
    // quietly creating a mislabelled row.
    origin: {
      type: String,
      enum: SYSTEM_QUESTION_ORIGINS,
      default: DATA_ORIGIN.CORE_BANK,
      index: true,
      // Origin/provenance consistency — this is what makes "Dataset Question"
      // a claim the data can back up. Written as a PATH validator (not a
      // pre('validate') hook) so it also runs under validateSync().
      //
      //   - dataset_question REQUIRES a non-empty sourceCitation. Without a
      //     real, checkable source there is nothing to call an external
      //     dataset, so the save is refused rather than storing an unbacked
      //     claim.
      //   - core_bank must NOT carry a sourceCitation. The core bank came from
      //     our pediatrician interview; a citation would mean it actually came
      //     from an external instrument, so it belongs under dataset_question.
      //
      // Existing rows (all core_bank, all sourceCitation null) satisfy both,
      // so nothing historical is affected.
      validate: {
        validator: function originMatchesProvenance(value) {
          const citation = String(this.sourceCitation || '').trim();
          if (value === DATA_ORIGIN.DATASET_QUESTION) return citation.length > 0;
          if (value === DATA_ORIGIN.CORE_BANK) return citation.length === 0;
          return true;
        },
        message: (props) => (
          props.value === DATA_ORIGIN.DATASET_QUESTION
            ? 'A dataset_question requires a sourceCitation naming the external dataset it came from. '
              + 'Use origin "core_bank" for questions from the pediatrician interview.'
            : 'A core_bank question came from the pediatrician interview and must not carry a sourceCitation. '
              + 'If it came from an external dataset, set origin to "dataset_question".'
        ),
      },
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

    // ── Pediatrician review lifecycle (dataset_question only) ────────────────
    // See constants/dataOrigin.js. A dataset question's wording is newly
    // written for KinderCura from an external construct, so it is a CANDIDATE
    // until a pediatrician rules on it. core_bank rows keep null: they predate
    // this workflow and are governed by the seed script, and stamping them
    // "approved" would be a review that never happened.

    // null = outside the review workflow (core_bank). Never means "approved".
    approvalStatus: {
      type: String,
      enum: APPROVAL_STATUS_VALUES,
      default: null,
      index: true,
      validate: {
        validator: function approvalMatchesOrigin(value) {
          if (this.origin === DATA_ORIGIN.DATASET_QUESTION) {
            return APPROVAL_STATUS_VALUES.includes(value);
          }
          return value == null;
        },
        message: function approvalMessage() {
          return this.origin === DATA_ORIGIN.DATASET_QUESTION
            ? 'A dataset_question must carry an approvalStatus — it is a candidate until a pediatrician reviews it. '
              + `Use "${APPROVAL_STATUS.PENDING}" on creation.`
            : 'Only a dataset_question takes part in the pediatrician review workflow; leave approvalStatus null.';
        },
      },
    },

    // How the STORED WORDING came to exist — distinct from where the concept
    // came from. Required on a dataset_question so an adapted question can
    // never be mistaken for the source instrument's own item text.
    generationMethod: {
      type: String,
      enum: GENERATION_METHOD_VALUES,
      default: null,
      index: true,
      validate: {
        validator: function generationMatchesOrigin(value) {
          if (this.origin === DATA_ORIGIN.DATASET_QUESTION) {
            return GENERATION_METHOD_VALUES.includes(value);
          }
          return value == null;
        },
        message: function generationMessage() {
          return this.origin === DATA_ORIGIN.DATASET_QUESTION
            ? 'A dataset_question must record how its wording was produced (generationMethod), so an adaptation '
              + 'is never read as the external instrument\'s own item text.'
            : 'generationMethod only applies to a dataset_question; leave it null.';
        },
      },
    },

    // Who signed off and when. Written only by a real review action — never
    // defaulted, so an unreviewed question cannot look reviewed.
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },

    // True = owned by the codebase; the admin UI must not offer edit/delete.
    isSystemManaged: { type: Boolean, default: true },

    // The activation gate. For a dataset_question this can only be true once
    // approvalStatus is APPROVED — that is what makes "pending" mean the
    // question genuinely cannot reach an assessment, rather than being a label.
    // Note the default is true, so creating a dataset_question without
    // explicitly setting isActive:false FAILS validation rather than quietly
    // going live. core_bank rows are unaffected.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
      validate: {
        validator: function activationRequiresApproval(value) {
          if (value !== true) return true;
          if (this.origin !== DATA_ORIGIN.DATASET_QUESTION) return true;
          return this.approvalStatus === APPROVAL_STATUS.APPROVED;
        },
        message: 'A dataset_question cannot be active until a pediatrician has approved it. '
          + 'Create it with isActive:false and activate only after approvalStatus becomes "approved".',
      },
    },
  },
  { timestamps: true, collection: 'core_bank_questions' }
);

module.exports = mongoose.models.CoreBankQuestion || mongoose.model('CoreBankQuestion', coreBankQuestionSchema);
