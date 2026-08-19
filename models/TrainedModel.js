// TrainedModel model
// Stores metadata and metrics for each ML model trained via the admin training page.
// Each document corresponds to one training run on a specific dataset.
// The status lifecycle is: pending → training → completed | failed
const mongoose = require('mongoose');

const trainedModelSchema = new mongoose.Schema(
  {
    // Reference to the dataset that was used for this training run.
    // Accepts both ObjectId (from admin.js / ml.js) and plain strings.
    datasetId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainingDataset', required: true, index: true },

    // Auto-incrementing version number (v1, v2, …)
    version: { type: Number, required: true },

    // File path to the saved .joblib model on disk.
    // Empty string while status is 'pending' or 'training'; populated on completion.
    modelPath: { type: String, default: '', trim: true },

    // ── Flattened metric fields (used by routes/ml.js and routes/admin.js) ──
    accuracy: { type: Number, default: 0 },
    precision: { type: Number, default: 0 },
    recall: { type: Number, default: 0 },
    f1Score: { type: Number, default: 0 },

    // ── Structured metrics object (used by model_manager.js trainModel) ──
    // Provides a single sub-document consumers can read without knowing
    // each individual field name.
    metrics: {
      accuracy:  { type: Number, default: 0 },
      precision: { type: Number, default: 0 },
      recall:    { type: Number, default: 0 },
      f1_score:  { type: Number, default: 0 },
    },

    // Extended analytics fields from the Python trainer output
    featureImportances: { type: mongoose.Schema.Types.Mixed, default: {} },
    perClassMetrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    // { labels: [...classNames order], matrix: [[...]] } from ml/trainer.py
    // confusion_matrix — TEST split only. Step 13.
    confusionMatrix: { type: mongoose.Schema.Types.Mixed, default: null },
    // Full pre-split label counts, e.g. { Low: 20, Medium: 15, High: 5 } —
    // the class balance actually used for this training run. Distinct from
    // perClassMetrics (test-split support only). Step 13.
    classDistribution: { type: mongoose.Schema.Types.Mixed, default: null },
    classNames: [{ type: String }],
    featuresUsed: [{ type: String }],
    trainingSamples: { type: Number, default: 0 },
    testSamples: { type: Number, default: 0 },
    totalRows: { type: Number, default: 0 },
    rowsDropped: { type: Number, default: 0 },

    // Status lifecycle: pending → training → completed | failed
    status: {
      type: String,
      enum: ['pending', 'training', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },

    // Marks the model that should be used for live predictions.
    isActive: { type: Boolean, default: false, index: true },

    // Admin who triggered the training run.
    trainedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Timestamp set when training completes successfully.
    trainedAt: { type: Date, default: null },

    // Human-readable failure reason when status === 'failed'.
    errorMessage: { type: String, default: null },
  },
  {
    timestamps: true,          // adds createdAt and updatedAt automatically
    collection: 'trained_models',
  }
);

module.exports = mongoose.models.TrainedModel || mongoose.model('TrainedModel', trainedModelSchema);
