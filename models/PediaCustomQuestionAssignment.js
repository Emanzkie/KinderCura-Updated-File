// PediaCustomQuestionAssignment model
// Stores which question was assigned to which child/parent and the parent's answer if available.
// Now includes questionSetId to track assignments made as part of a batch/set
// Child record of PediaCustomQuestion — assignments only ever reference
// pediatrician-authored questions, never the CoreBankQuestion baseline.

const mongoose = require('mongoose');
const Counter = require('./Counter');

// Schema definition for one question assignment
const pediaCustomQuestionAssignmentSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true, index: true },
    questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PediaCustomQuestion', required: true, index: true },
    questionSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionSet', default: null, index: true },
    appointmentId: { type: Number, default: null, index: true },
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    answer: { type: String, default: null },
    answeredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'pedia_custom_question_assignments' }
);

// Note: the Counter key stays 'custom_question_assignments' so the numeric id
// sequence continues from where it left off (seq 33) rather than restarting at 1.
pediaCustomQuestionAssignmentSchema.pre('validate', async function (next) {
  if (!this.isNew || this.id != null) return next();
  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'custom_question_assignments' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    this.id = counter.seq;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.models.PediaCustomQuestionAssignment || mongoose.model('PediaCustomQuestionAssignment', pediaCustomQuestionAssignmentSchema);
