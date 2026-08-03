// AssessmentAnswer model
// Stores one answer per question for one assessment.
// Connection note: DB connection string is in .env as MONGODB_URI.
const mongoose = require('mongoose');
const { DATA_ORIGIN, DATA_ORIGIN_VALUES } = require('../constants/dataOrigin');

const assessmentAnswerSchema = new mongoose.Schema(
  {
    assessmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', required: true, index: true },
    questionId: { type: String, required: true },
    domain: { type: String, required: true, trim: true },
    questionText: { type: String, default: '' },
    answer: { type: String, required: true, trim: true },

    // How this answer's question entered the system. Defaults to the core bank
    // because the parent screening flow only serves the fixed baseline bank.
    // Set on the server only — see constants/dataOrigin.js.
    origin: {
      type: String,
      enum: DATA_ORIGIN_VALUES,
      default: DATA_ORIGIN.CORE_BANK,
      index: true,
    },

    // Points back to the question this answer belongs to:
    // - core_bank answers   → CoreBankQuestion.questionId (e.g. 'Q01')
    // - pedia_entry answers → the PediaCustomQuestion _id as a string
    // Kept separate from questionId so the existing questionId meaning is unchanged.
    sourceQuestionRef: { type: String, default: '' },
  },
  { timestamps: true, collection: 'assessment_answers' }
);

assessmentAnswerSchema.index({ assessmentId: 1, questionId: 1 }, { unique: true });

module.exports = mongoose.models.AssessmentAnswer || mongoose.model('AssessmentAnswer', assessmentAnswerSchema);
