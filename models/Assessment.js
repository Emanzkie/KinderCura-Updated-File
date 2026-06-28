// Assessment model
// One document per screening session.
// Connection note: mongoose model only; DB connection comes from db.js.
const mongoose = require('mongoose');

const assessmentSchema = new mongoose.Schema(
  {
    // Links the assessment to the child being screened.
    childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true, index: true },

    // Tracks which parent created the assessment record.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: ['in_progress', 'submitted', 'complete'],
      default: 'in_progress',
      index: true,
    },

    currentProgress: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },

    // Pediatrician-written note shown on the parent Results page.
    diagnosis: { type: String, default: null },
    recommendations: { type: String, default: null },
    nextAssessmentDate: { type: Date, default: null },
    nextAssessmentReason: { type: String, default: null, trim: true },

    // These two fields are required by the Results page banner.
    // They must exist in the schema so Mongoose will actually persist them.
    reviewedByPediatrician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'assessments' }
);

module.exports = mongoose.models.Assessment || mongoose.model('Assessment', assessmentSchema);
