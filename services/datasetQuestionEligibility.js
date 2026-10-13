// services/datasetQuestionEligibility.js
// The single rule for when a Dataset Question (origin dataset_question, stored
// in core_bank_questions — see models/CoreBankQuestion.js) may reach a child
// assessment, shared by the admin activation route (routes/admin.js) and the
// screening routes (routes/assessments.js) so the two can never disagree.
//
// A Dataset Question is used in a NEW assessment only when ALL hold, read from
// the database at request time (no cache, so activating or deactivating takes
// effect on the next screening without a deploy):
//   - origin is dataset_question
//   - approvalStatus is approved (the pediatrician sign-off)
//   - isActive is true (the admin's separate activation decision)
//   - its domain is one of the four scored domains
//   - the child's age in months is at least its minAgeMonths — the SAME
//     minimum-age rule js/parent/screening.js applies to the core bank
//
// Approval and activation stay separate acts: approval never activates, and
// only an approved question can be activated (also enforced by the model's
// isActive validator).
const CoreBankQuestion = require('../models/CoreBankQuestion');
const { DATA_ORIGIN, APPROVAL_STATUS } = require('../constants/dataOrigin');
const { SCORING_DOMAINS } = require('../constants/datasetQuestions');

function isApproved(q) {
  return Boolean(q) && q.approvalStatus === APPROVAL_STATUS.APPROVED;
}

// May an admin switch this question on?
function canActivate(q) {
  return Boolean(q) && q.origin === DATA_ORIGIN.DATASET_QUESTION && isApproved(q);
}

function isUsableInAssessment(q) {
  return canActivate(q)
    && q.isActive === true
    && SCORING_DOMAINS.includes(q.domain)
    && Number.isFinite(Number(q.minAgeMonths))
    && String(q.text || '').trim().length > 0;
}

function fitsAge(q, ageMonths) {
  return Number.isFinite(ageMonths) && ageMonths >= Number(q.minAgeMonths);
}

// Whole months, computed exactly as getAgeInMonths() in js/parent/screening.js
// so the server and the screening page gate questions by the same age.
function ageInMonths(dateOfBirth, now = new Date()) {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return NaN;
  let months = (now.getFullYear() - dob.getFullYear()) * 12;
  months += now.getMonth() - dob.getMonth();
  if (now.getDate() < dob.getDate()) months -= 1;
  return months;
}

// Every dataset_question row, keyed by questionId. Includes ineligible rows on
// purpose: an answer naming a known Dataset Question that is not usable must be
// refused, never mistaken for a core-bank answer.
async function loadDatasetQuestionIndex() {
  const rows = await CoreBankQuestion.find({ origin: DATA_ORIGIN.DATASET_QUESTION })
    .select('questionId text domain displayDomain minAgeMonths difficulty origin approvalStatus isActive '
      + 'sourcedFrom sourceCitation sourceVersion generationMethod')
    .lean();
  return new Map(rows.map((q) => [q.questionId, q]));
}

// What the screening page receives: the same shape as a DOCTOR_QUESTION_BANK
// entry, plus where the question came from.
function toScreeningQuestion(q) {
  return {
    id: q.questionId,
    minAgeMonths: Number(q.minAgeMonths),
    displayDomain: q.displayDomain || q.domain,
    scoreDomain: q.domain,
    text: q.text,
    difficulty: q.difficulty || '',
    origin: DATA_ORIGIN.DATASET_QUESTION,
    sourcedFrom: q.sourcedFrom || null,
  };
}

// Dataset Questions to add to a new screening for a child of this age, in the
// order the core bank uses (minimum age, then id).
function selectForAge(index, ageMonths) {
  return [...index.values()]
    .filter((q) => isUsableInAssessment(q) && fitsAge(q, ageMonths))
    .sort((a, b) => (Number(a.minAgeMonths) - Number(b.minAgeMonths)) || a.questionId.localeCompare(b.questionId))
    .map(toScreeningQuestion);
}

module.exports = {
  canActivate,
  isUsableInAssessment,
  fitsAge,
  ageInMonths,
  loadDatasetQuestionIndex,
  selectForAge,
  toScreeningQuestion,
};
