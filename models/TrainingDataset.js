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
