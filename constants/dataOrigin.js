// constants/dataOrigin.js
// Purpose:
// - Single source of truth for WHERE A SCREENING QUESTION CAME FROM.
//
// There are exactly THREE question origins, and they must never be merged:
//
//   CORE_BANK        → SOURCE: our consultant pediatrician's interview
//                      (see js/parent/screening.js:4). Fixed system-wide
//                      baseline, no pediatricianId, identical for every child
//                      and clinic, changeable only by code deploy. Carries NO
//                      external citation — if a question has one, it is not
//                      core bank, it is a DATASET_QUESTION.
//
//   DATASET_QUESTION → SOURCE: an actual external dataset / published
//                      instrument. Also system-provided (no pediatricianId),
//                      but its content did not come from our interview. It
//                      MUST carry a checkable sourceCitation — see
//                      models/CoreBankQuestion.js, which refuses to save one
//                      without it. Zero such questions exist today; this
//                      origin is the supported way to add them.
//
//   PEDIA_ENTRY      → AUTHOR: an authenticated pediatrician created it inside
//                      KinderCura at runtime. Has a pediatricianId and
//                      createdAt, scoped to specific children.
//
// Source vs author: the interview is the SOURCE of the core bank; an external
// dataset is the SOURCE of a dataset question; a pediatrician is the AUTHOR of
// a pedia entry. These are three different relationships — never interchange
// them.
//
// DATASET_QUESTION is NOT an ML dataset. It is a question whose text came from
// an external source. The ML datasets in this project are ml/test_dataset.csv
// and the CSVs in the TrainingDataset collection — aggregate scores with
// risk_category used for model training. That separate concept is reserved
// below as ML_DATASET and is deliberately kept out of the question enum.
//
// The full chain, with no step collapsed into another:
//   QUESTION (core_bank | dataset_question | pedia_entry)
//     → parent answers it  → ASSESSMENT DATA (AssessmentAnswer/AssessmentResult)
//     → selected/structured → ML TRAINING DATASET (TrainingDataset)
//     → trains              → ML MODEL (TrainedModel)
//
// Important: origin is always decided on the server. Never read it from
// req.body, otherwise a client could label its own answers as core-bank content.

const DATA_ORIGIN = Object.freeze({
  CORE_BANK: 'core_bank',
  DATASET_QUESTION: 'dataset_question',
  PEDIA_ENTRY: 'pedia_entry',
});

// Reserved for a future extension to the ML module (training CSVs).
// Deliberately NOT in DATA_ORIGIN_VALUES, so the schema enums reject it until
// we actually implement it — a typo can't silently create an extra bucket.
// Note this is ML TRAINING data, not DATA_ORIGIN.DATASET_QUESTION above.
const RESERVED_ORIGIN = Object.freeze({
  ML_DATASET: 'ml_dataset',
});

// Every valid question origin. Shared by AssessmentAnswer (an answer inherits
// the origin of the question it answers) and by the admin origin filter.
const DATA_ORIGIN_VALUES = Object.freeze([
  DATA_ORIGIN.CORE_BANK,
  DATA_ORIGIN.DATASET_QUESTION,
  DATA_ORIGIN.PEDIA_ENTRY,
]);

// The two SYSTEM-PROVIDED origins — fixed questions with no pediatricianId,
// stored together in the core_bank_questions collection and told apart by
// `origin`. PEDIA_ENTRY is excluded: those live in pedia_custom_questions and
// always have an author.
const SYSTEM_QUESTION_ORIGINS = Object.freeze([
  DATA_ORIGIN.CORE_BANK,
  DATA_ORIGIN.DATASET_QUESTION,
]);

// Human labels for the admin UI and report exports.
//
// Important: "Core Question Bank", never "Standard" anything. "Standard"
// implies a validated instrument (ASQ, DDST, M-CHAT) and we cannot claim that.
// "Dataset Question" is reserved for a question that genuinely came from an
// external dataset — it is never a synonym for the core bank, and never means
// ML training data.
const DATA_ORIGIN_LABELS = Object.freeze({
  [DATA_ORIGIN.CORE_BANK]: 'Core Question Bank',
  [DATA_ORIGIN.DATASET_QUESTION]: 'Dataset Question',
  [DATA_ORIGIN.PEDIA_ENTRY]: 'Pediatrician Entry',
});

// What each origin means, for admin tooltips/help text. Plain description of
// the relationship only — never an assertion that a specific source exists.
const DATA_ORIGIN_SOURCE_KIND = Object.freeze({
  [DATA_ORIGIN.CORE_BANK]: 'Pediatrician interview',
  [DATA_ORIGIN.DATASET_QUESTION]: 'External dataset',
  [DATA_ORIGIN.PEDIA_ENTRY]: 'Created by a pediatrician in KinderCura',
});

// ── Pediatrician review lifecycle (DATASET_QUESTION only) ───────────────────
// A dataset question is written by adapting a construct from an external
// source, so it is a CANDIDATE until a pediatrician says otherwise:
//
//   dataset question created → PENDING → pediatrician reviews
//                                      → APPROVED  (may then be activated)
//                                      → REJECTED  (never activated)
//
// This applies to DATASET_QUESTION only. CORE_BANK predates the workflow and
// is governed by the seed script; PEDIA_ENTRY is written by a pediatrician, so
// there is nobody else to approve it. For both of those the status stays null,
// which means "outside this workflow" — NOT "approved" and NOT "pending".
// models/CoreBankQuestion.js enforces exactly that.
const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending_pediatrician_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

const APPROVAL_STATUS_VALUES = Object.freeze([
  APPROVAL_STATUS.PENDING,
  APPROVAL_STATUS.APPROVED,
  APPROVAL_STATUS.REJECTED,
]);

const APPROVAL_STATUS_LABELS = Object.freeze({
  [APPROVAL_STATUS.PENDING]: 'Pending Pediatrician Approval',
  [APPROVAL_STATUS.APPROVED]: 'Approved',
  [APPROVAL_STATUS.REJECTED]: 'Rejected',
});

// ── How the stored wording came to exist ────────────────────────────────────
// Separate from WHERE the concept came from (`origin` + `sourceCitation`).
// A dataset question cites an external source for its developmental CONSTRUCT
// while its wording is newly written for KinderCura — recording that here is
// what stops the pair being read as "we copied the instrument".
//
//   AI_ADAPTATION → wording generated for KinderCura from the cited source's
//                   construct. NOT the source's own item text. Requires
//                   pediatrician review before use.
//   VERBATIM      → the source's item text, reproduced exactly. Only legitimate
//                   where the source's licence actually permits it.
//   MANUAL        → written by hand for KinderCura.
const GENERATION_METHOD = Object.freeze({
  AI_ADAPTATION: 'ai_generated_adaptation',
  VERBATIM: 'verbatim_from_source',
  MANUAL: 'manually_written',
});

const GENERATION_METHOD_VALUES = Object.freeze([
  GENERATION_METHOD.AI_ADAPTATION,
  GENERATION_METHOD.VERBATIM,
  GENERATION_METHOD.MANUAL,
]);

const GENERATION_METHOD_LABELS = Object.freeze({
  [GENERATION_METHOD.AI_ADAPTATION]: 'AI-generated adaptation',
  [GENERATION_METHOD.VERBATIM]: 'Verbatim from source',
  [GENERATION_METHOD.MANUAL]: 'Manually written',
});

function isValidOrigin(value) {
  return DATA_ORIGIN_VALUES.includes(value);
}

function approvalStatusLabel(value) {
  return APPROVAL_STATUS_LABELS[value] || null;
}

function generationMethodLabel(value) {
  return GENERATION_METHOD_LABELS[value] || null;
}

function originLabel(value) {
  return DATA_ORIGIN_LABELS[value] || 'Unknown';
}

function originSourceKind(value) {
  return DATA_ORIGIN_SOURCE_KIND[value] || 'Unknown';
}

module.exports = {
  DATA_ORIGIN,
  DATA_ORIGIN_VALUES,
  SYSTEM_QUESTION_ORIGINS,
  DATA_ORIGIN_LABELS,
  DATA_ORIGIN_SOURCE_KIND,
  RESERVED_ORIGIN,
  APPROVAL_STATUS,
  APPROVAL_STATUS_VALUES,
  APPROVAL_STATUS_LABELS,
  GENERATION_METHOD,
  GENERATION_METHOD_VALUES,
  GENERATION_METHOD_LABELS,
  isValidOrigin,
  originLabel,
  originSourceKind,
  approvalStatusLabel,
  generationMethodLabel,
  // Convenience named exports so callers can destructure directly.
  CORE_BANK: DATA_ORIGIN.CORE_BANK,
  DATASET_QUESTION: DATA_ORIGIN.DATASET_QUESTION,
  PEDIA_ENTRY: DATA_ORIGIN.PEDIA_ENTRY,
};
