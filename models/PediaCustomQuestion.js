// PediaCustomQuestion model
// Stores each pediatrician-made question in MongoDB.
// Named to match the DATA_ORIGIN.PEDIA_ENTRY mechanism: these are created at
// runtime by an authenticated pediatrician, unlike the fixed CoreBankQuestion
// baseline which only changes by code deploy.
// The numeric `id` field is used by the frontend for easy edit/delete actions.
// Questions can optionally belong to a QuestionSet (batch) for grouped management.

const mongoose = require('mongoose');
const Counter = require('./Counter');
const { DATA_ORIGIN, DATA_ORIGIN_VALUES } = require('../constants/dataOrigin');

// Schema definition for one custom question
const pediaCustomQuestionSchema = new mongoose.Schema(
  {
    // Numeric id is kept so existing pediatrician pages can keep using q.id in onclick handlers.
    id: { type: Number, unique: true, index: true },
    pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    questionSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuestionSet', default: null, index: true },
    questionText: { type: String, required: true, trim: true },
    questionType: {
      type: String,
      enum: ['yes_no', 'multiple_choice', 'short_answer'],
      required: true,
    },
    options: { type: [String], default: [] },
    domain: { type: String, trim: true, default: 'Other' },
    ageMin: { type: Number, default: 0 },
    ageMax: { type: Number, default: 18 },
    isActive: { type: Boolean, default: true },

    // Questions in this collection are created at runtime by an authenticated
    // pediatrician (they carry pediatricianId), so origin is always PEDIA_ENTRY.
    // Stored anyway so the admin data-origin queries can filter both
    // collections the same way.
    origin: {
      type: String,
      enum: DATA_ORIGIN_VALUES,
      default: DATA_ORIGIN.PEDIA_ENTRY,
      index: true,
    },
  },
  { timestamps: true, collection: 'pedia_custom_questions' }
);

// Note: the Counter key stays 'custom_questions' so the numeric id sequence
// continues from where it left off (seq 39) rather than restarting at 1.
pediaCustomQuestionSchema.pre('validate', async function (next) {
  if (!this.isNew || this.id != null) return next();
  try {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'custom_questions' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    this.id = counter.seq;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.models.PediaCustomQuestion || mongoose.model('PediaCustomQuestion', pediaCustomQuestionSchema);
