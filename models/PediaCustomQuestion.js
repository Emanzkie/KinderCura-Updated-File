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
const { ASSESSMENT_DOMAINS, FALLBACK_DOMAIN, normalizeDomain } = require('../constants/assessmentDomains');

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
      // 'short_answer' is retired: free-text answers don't fit the yes/no
      // scoring scale. It stays in this enum ONLY so historical documents that
      // already hold the value keep loading and re-saving without a validation
      // error (e.g. the domain-normalization migration). New creation and
      // editing are blocked at the route layer — see SUPPORTED_QUESTION_TYPES
      // in routes/custom-questions.js.
      enum: ['yes_no', 'multiple_choice', 'short_answer'],
      required: true,
    },
    options: { type: [String], default: [] },
    // Must always be one of the four official assessment scoring domains —
    // see constants/assessmentDomains.js. The pre('validate') hook below
    // normalizes any legacy value (e.g. 'Gross Motor', 'Other') on every
    // save, so this enum can never actually reject a real document; it just
    // guarantees nothing but the four values is ever persisted.
    domain: { type: String, trim: true, enum: ASSESSMENT_DOMAINS, default: FALLBACK_DOMAIN },
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

// Runs on every save (new document or edit), not just creation, so a legacy
// domain value already sitting on an existing document gets normalized the
// next time it's touched even if the one-off migration script
// (scripts/migrate-custom-question-domains.js) hasn't been run yet.
pediaCustomQuestionSchema.pre('validate', function (next) {
  if (this.isModified('domain') || this.isNew) {
    this.domain = normalizeDomain(this.domain);
  }
  next();
});

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
