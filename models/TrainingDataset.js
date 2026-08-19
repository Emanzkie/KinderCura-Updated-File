// TrainingDataset model
// Stores uploaded dataset files and simple training status for the admin page.
const mongoose = require('mongoose');

const trainingDatasetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    originalName: { type: String, required: true, trim: true },
    storedName: { type: String, required: true, trim: true },
    filePath: { type: String, required: true, trim: true },
    fileType: { type: String, required: true, trim: true },
    fileSize: { type: Number, required: true },
    rowCount: { type: Number, default: 0 },
    columnCount: { type: Number, default: 0 },
    sampleColumns: [{ type: String }],
    targetModule: {
      type: String,
      enum: ['assessment', 'recommendation', 'general'],
      default: 'general',
    },
    notes: { type: String, default: null },

    // ── Provenance (Step 13) ─────────────────────────────────────────────
    // Where this dataset's rows actually came from. A STRUCTURED field —
    // set explicitly at upload time (see routes/admin.js POST
    // /training/upload), never inferred from the filename. routes/admin.js
    // GET /training/datasets still falls back to a filename heuristic for
    // datasets uploaded before this field existed, but always prefers this
    // field when it's set. This is also what the training quality gate
    // (POST /training/:id/train) checks to decide whether a dataset is
    // subject to the reviewed-assessment readiness rules from Step 12 —
    // synthetic/unknown datasets are never gated against that logic.
    provenance: {
      sourceType: {
        type: String,
        enum: ['reviewed_assessment', 'synthetic', 'unknown'],
        default: 'unknown',
      },
    },
    // 'registered' = the file was uploaded and its structure recorded. NOTHING
    // was trained. This value exists because 'trained' was previously set by a
    // path that only registered the file, which made the admin page report
    // "Models Trained: 3" while the trained_models collection held 0 documents.
    // 'trained' is retained in the enum so pre-migration documents still
    // validate; it must only ever be set when a model artifact was produced.
    status: {
      type: String,
      enum: ['uploaded', 'registered', 'training', 'trained', 'failed'],
      default: 'uploaded',
      index: true,
    },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    trainedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    trainedAt: { type: Date, default: null },
    trainingSummary: { type: String, default: null },
    modelId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainedModel', default: null },
    trainingMetrics: { type: mongoose.Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true, collection: 'training_datasets' }
);

module.exports = mongoose.models.TrainingDataset || mongoose.model('TrainingDataset', trainingDatasetSchema);
