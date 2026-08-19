// routes/ml.js
// Purpose:
// - ML API endpoints for training models, checking status, making predictions
// - Uses the model_manager bridge to spawn Python processes
// - All training/model endpoints require admin auth
// - Prediction endpoint is available to any authenticated user

const express = require('express');
const router = express.Router();
const path = require('path');

const { authMiddleware, adminOnly } = require('../middleware/auth');
const TrainingDataset = require('../models/TrainingDataset');
const TrainedModel = require('../models/TrainedModel');
const modelManager = require('../ml/model_manager');
const staging = require('../constants/developmental-staging');
const sse = require('../sse');

/**
 * POST /api/ml/train-model
 * Triggers real ML training on a dataset.
 * Body: { datasetId: string }
 */
router.post('/train-model', authMiddleware, adminOnly, async (req, res) => {
    const { datasetId, featureSet = 'score_based' } = req.body;
    if (!datasetId) {
      return res.status(400).json({ error: 'datasetId is required.' });
    }

    try {
      // 1. Check Python environment first
      const envCheck = await modelManager.checkPythonEnvironment();
      if (!envCheck.ok) {
        return res.status(503).json({ error: envCheck.error });
      }

      // 2. Find the dataset
      const dataset = await TrainingDataset.findById(datasetId);
      if (!dataset) {
        return res.status(404).json({ error: 'Dataset not found.' });
      }

      if (dataset.status === 'training') {
        return res.status(409).json({ error: 'This dataset is already being trained.' });
      }

      // 3. Resolve dataset file on disk
      const datasetPath = modelManager.resolveDatasetPath(dataset.filePath);
      if (!datasetPath) {
        return res.status(404).json({
          error: `Dataset file not found on disk. Expected at: ${dataset.filePath}`,
        });
      }

      // 4. Mark dataset as training
      dataset.status = 'training';
      dataset.errorMessage = null;
      await dataset.save();

      // 5. Determine next model version
      const lastModel = await TrainedModel.findOne().sort({ version: -1 }).lean();
      const nextVersion = (lastModel?.version || 0) + 1;

      // 6. Create a placeholder TrainedModel doc
      const modelDoc = await TrainedModel.create({
        datasetId: dataset._id,
        version: nextVersion,
        modelPath: '',
        status: 'training',
        featureSetType: featureSet,
        trainedBy: req.user.userId,
      });

      // Broadcast that training has started
      sse.broadcast('analytics:update', {
        type: 'ml',
        action: 'training_started',
        datasetId: String(dataset._id),
        modelVersion: nextVersion,
      });

      // 7. Respond immediately — training runs in the background
      res.json({
        success: true,
        message: 'Training started. Check model status for progress.',
        modelId: String(modelDoc._id),
        version: nextVersion,
      });

      // 8. Run training asynchronously
      try {
        const metrics = await modelManager.trainModel(datasetPath, dataset._id, { featureSet });

        // Step 7: a successfully trained model is a CANDIDATE only — it does
        // NOT become active, and the currently active model (if any) is left
        // completely untouched. Activation is a separate, explicit admin
        // action: POST /api/ml/models/:modelId/activate below.
        modelDoc.modelPath = metrics.model_path;
        modelDoc.accuracy = metrics.accuracy;
        modelDoc.precision = metrics.precision;
        modelDoc.recall = metrics.recall;
        modelDoc.f1Score = metrics.f1;
        modelDoc.featureImportances = metrics.feature_importances;
        modelDoc.perClassMetrics = metrics.per_class_metrics || {};
        modelDoc.confusionMatrix = metrics.confusion_matrix || null;
        modelDoc.classDistribution = metrics.class_distribution || null;
        modelDoc.classNames = metrics.class_names || [];
        modelDoc.featuresUsed = metrics.features_used || [];
        modelDoc.featureCount = metrics.feature_count || (metrics.features_used ? metrics.features_used.length : 0);
        modelDoc.featureSetType = metrics.feature_set_type || featureSet;
        modelDoc.trainingSamples = metrics.training_samples;
        modelDoc.testSamples = metrics.test_samples;
        modelDoc.totalRows = metrics.total_rows || 0;
        modelDoc.rowsDropped = metrics.rows_dropped || 0;
        modelDoc.status = 'completed';
        // isActive intentionally not set here — stays false (schema default).
        await modelDoc.save();

      // Update dataset
      dataset.status = 'trained';
      dataset.trainedBy = req.user.userId;
      dataset.trainedAt = new Date();
      dataset.modelId = modelDoc._id;
      dataset.trainingMetrics = {
        accuracy: metrics.accuracy,
        precision: metrics.precision,
        recall: metrics.recall,
        f1: metrics.f1,
      };
      dataset.trainingSummary =
        `Model v${nextVersion} trained with ${metrics.accuracy * 100}% accuracy. ` +
        `${metrics.training_samples} training / ${metrics.test_samples} test samples. ` +
        `Risk categories: ${(metrics.class_names || []).join(', ')}.`;
      await dataset.save();

      sse.broadcast('analytics:update', {
        type: 'ml',
        action: 'training_completed',
        datasetId: String(dataset._id),
        modelVersion: nextVersion,
        accuracy: metrics.accuracy,
      });
    } catch (trainErr) {
      // Training failed — update records
      console.error('ML training failed:', trainErr.message);
      modelDoc.status = 'failed';
      modelDoc.errorMessage = trainErr.message;
      await modelDoc.save();

      dataset.status = 'failed';
      dataset.errorMessage = trainErr.message;
      dataset.trainingSummary = `Training failed: ${trainErr.message}`;
      await dataset.save();

      sse.broadcast('analytics:update', {
        type: 'ml',
        action: 'training_failed',
        datasetId: String(dataset._id),
        error: trainErr.message,
      });
    }
  } catch (err) {
    console.error('ML train-model endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ml/model-status
 * Returns the currently active model's info and metrics.
 */
router.get('/model-status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const activeModel = await TrainedModel.findOne({ isActive: true })
      .populate('trainedBy', 'firstName lastName')
      .lean();

    if (!activeModel) {
      return res.json({
        success: true,
        hasActiveModel: false,
        model: null,
      });
    }

    res.json({
      success: true,
      hasActiveModel: true,
      model: {
        id: String(activeModel._id),
        version: activeModel.version,
        accuracy: activeModel.accuracy,
        precision: activeModel.precision,
        recall: activeModel.recall,
        f1Score: activeModel.f1Score,
        featureImportances: activeModel.featureImportances,
        perClassMetrics: activeModel.perClassMetrics,
        classNames: activeModel.classNames,
        featuresUsed: activeModel.featuresUsed,
        featureSetType: activeModel.featureSetType || 'score_based',
        featureCount: activeModel.featureCount || (activeModel.featuresUsed ? activeModel.featuresUsed.length : 0),
        trainingSamples: activeModel.trainingSamples,
        testSamples: activeModel.testSamples,
        totalRows: activeModel.totalRows,
        status: activeModel.status,
        trainedBy: activeModel.trainedBy
          ? `${activeModel.trainedBy.firstName} ${activeModel.trainedBy.lastName}`
          : 'Admin',
        createdAt: activeModel.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ml/predict
 * Predicts risk category for a set of assessment scores.
 * Body: { communication_score, social_score, cognitive_score, motor_score, overall_score, age_months?, gender? }
 */
router.post('/predict', authMiddleware, async (req, res) => {
  try {
    const activeModel = await TrainedModel.findOne({ isActive: true, status: 'completed' }).lean();

    if (!activeModel || !activeModel.modelPath) {
      return res.status(404).json({
        error: 'No active trained model available. Using rule-based recommendations.',
        fallback: true,
      });
    }

    // Refuse to predict with a model trained on a feature set the current
    // pipeline no longer supports (e.g. gender — see ml/model_manager.js).
    // Predicting anyway would silently miscompute rather than fail cleanly.
    if (!modelManager.isModelCompatible(activeModel)) {
      return res.status(409).json({
        error: 'The active trained model uses features no longer supported by the prediction pipeline (e.g. gender). Retrain a model to enable ML predictions.',
        fallback: true,
      });
    }

    // Resolve model path (it may be stored as a relative unix-style path)
    let modelPath = activeModel.modelPath;
    if (!path.isAbsolute(modelPath)) {
      modelPath = path.join(__dirname, '..', modelPath);
    }
    // Normalise forward slashes to the OS separator
    modelPath = path.normalize(modelPath);

    const scores = {
      communication_score: req.body.communication_score,
      social_score: req.body.social_score,
      cognitive_score: req.body.cognitive_score,
      motor_score: req.body.motor_score,
      overall_score: req.body.overall_score,
    };

    // Optional fields
    if (req.body.age_months != null) scores.age_months = req.body.age_months;
    if (req.body.gender != null) scores.gender = req.body.gender;

    const prediction = await modelManager.predict(modelPath, scores);

    // ── ML vs. interpretation boundary ──────────────────────────────────
    // ml/predict.py's job ends at risk_category — a raw classification
    // label (B). It has no notion of "care stage" or "consultation level";
    // that interpretation (C) is the centralized staging module's job, not
    // the model's. Recommendation/care-plan text is a further step
    // downstream (routes/recommendations.js) that this endpoint does not
    // produce. developmental_band (A) is a THIRD, separate concept — a
    // score classification, not an ML output — included here since the
    // caller already supplied overall_score.
    const careStage = staging.getCareStageFromRiskCategory(prediction.risk_category);
    const careStageDefinition = careStage ? staging.getCareStageDefinition(careStage) : null;
    const developmentalBand = req.body.overall_score != null
      ? staging.getDevelopmentalBandFromScore(req.body.overall_score)
      : null;

    res.json({
      success: true,
      // Legacy/back-compat fields — unchanged shape.
      risk_category: prediction.risk_category,
      consultation_needed: prediction.consultation_needed,
      probabilities: prediction.probabilities,
      model_version: activeModel.version,
      // A. Developmental band — score classification (constants/scoring.js).
      developmental_band: developmentalBand,
      // C. Care stage — centralized staging interpretation of the risk
      // category above (constants/developmental-staging.js).
      care_stage: careStageDefinition ? careStageDefinition.careStage : null,
      care_stage_label: careStageDefinition ? careStageDefinition.label : null,
      consultation_level: careStageDefinition ? careStageDefinition.consultationLevel : null,
      monitoring_level: careStageDefinition ? careStageDefinition.monitoringLevel : null,
    });
  } catch (err) {
    console.error('ML predict error:', err.message);
    res.status(500).json({ error: err.message, fallback: true });
  }
});

// Step 7: a single label for the admin UI, distinct from the raw `status` +
// `isActive` + compatibility flags underneath. "completed" alone does NOT
// mean "ready for production" — only "training finished without error".
// Reused by both /models below and the activation endpoint's response.
function modelLifecycleState(m, compatible) {
  if (m.status === 'training') return 'training';
  if (m.status === 'failed') return 'failed';
  if (m.status !== 'completed') return m.status;
  if (m.isActive) return 'active';
  return compatible ? 'candidate' : 'incompatible';
}

/**
 * GET /api/ml/models
 * Lists all trained model versions with metrics, status, and — Step 7 —
 * enough lifecycle info (compatibility, lifecycleState) for the admin UI to
 * distinguish a merely-completed candidate from the actual active model.
 */
router.get('/models', authMiddleware, adminOnly, async (req, res) => {
  try {
    const models = await TrainedModel.find()
      .sort({ version: -1 })
      .populate('trainedBy', 'firstName lastName')
      .populate('datasetId', 'name originalName provenance')
      .lean();

    res.json({
      success: true,
      models: models.map((m) => {
        const compatible = m.status === 'completed' ? modelManager.isModelCompatible(m) : null;
        // Step 13: the dataset's own structured provenance — never
        // re-derived here, just read from what POST /training/upload
        // recorded (routes/admin.js). 'unknown' for datasets uploaded
        // before that field existed, or trained via routes/ml.js
        // /train-model directly (no datasetId join).
        const sourceType = m.datasetId?.provenance?.sourceType || 'unknown';
        return {
          id: String(m._id),
          version: m.version,
          datasetName: m.datasetId?.name || 'Unknown',
          sourceType,
          accuracy: m.accuracy,
          precision: m.precision,
          recall: m.recall,
          f1Score: m.f1Score,
          perClassMetrics: m.perClassMetrics,
          confusionMatrix: m.confusionMatrix || null,
          classDistribution: m.classDistribution || null,
          classNames: m.classNames,
          featuresUsed: m.featuresUsed,
          featureSetType: m.featureSetType || 'score_based',
          featureCount: m.featureCount || (m.featuresUsed ? m.featuresUsed.length : 0),
          trainingSamples: m.trainingSamples,
          testSamples: m.testSamples,
          totalRows: m.totalRows,
          rowsDropped: m.rowsDropped,
          status: m.status,
          isActive: m.isActive,
          compatible,
          lifecycleState: modelLifecycleState(m, compatible),
          trainedBy: m.trainedBy
            ? `${m.trainedBy.firstName} ${m.trainedBy.lastName}`
            : 'Admin',
          errorMessage: m.errorMessage || null,
          createdAt: m.createdAt,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ml/models/:modelId/activate
 *
 * Step 7 — the ONLY place a model's isActive flag is ever set to true.
 * Training (routes/admin.js, routes/ml.js POST /train-model, ml/model_manager.js)
 * never activates a model on its own; it only produces a candidate. This
 * endpoint is the explicit, admin-approved promotion of a candidate to the
 * model actually used for live predictions.
 *
 * Rejects: model not found, not status 'completed' (still training or
 * failed), no saved model file, or incompatible with the current feature
 * set (e.g. the old gender_encoded model — see ml/model_manager.js
 * isModelCompatible). None of these ever change which model is currently
 * active.
 */

// Pure (no I/O) — returns null when `model` is eligible for activation, or a
// human-readable reason it isn't. Kept separate from the route handler so
// the rejection rules are unit-testable without a live document/DB.
function getModelActivationBlocker(model) {
  if (model.status === 'training') return 'This model is still training and cannot be activated yet.';
  if (model.status === 'failed') return 'This model failed training and cannot be activated.';
  if (model.status !== 'completed') return `Only a completed model can be activated (current status: "${model.status}").`;
  if (!model.modelPath) return 'This model has no saved model file and cannot be activated.';
  if (!modelManager.isModelCompatible(model)) {
    return 'This model uses features no longer supported by the prediction pipeline (e.g. gender) and cannot be activated. Train a new model under the current feature set instead.';
  }
  return null;
}

// Safe order: activate the requested model FIRST, then deactivate every
// other model. Every read path (routes/ml.js /predict, services/
// assessmentProgress.js) already checks isModelCompatible() before trusting
// whichever active model it finds, so a brief moment with two active
// documents is harmless — it can only ever result in a correct prediction
// or a safe rule-based fallback, never a crash or a silently wrong one.
// Doing it in the other order would risk a brief window with NO active
// model, which is unnecessary here.
async function performModelActivation(model) {
  model.isActive = true;
  await model.save();
  await TrainedModel.updateMany({ _id: { $ne: model._id }, isActive: true }, { $set: { isActive: false } });
}

router.post('/models/:modelId/activate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const model = await TrainedModel.findById(req.params.modelId);
    if (!model) {
      return res.status(404).json({ error: 'Model not found.' });
    }

    const blocker = getModelActivationBlocker(model);
    if (blocker) {
      return res.status(409).json({ error: blocker });
    }

    await performModelActivation(model);

    sse.broadcast('analytics:update', {
      type: 'ml',
      action: 'model_activated',
      modelId: String(model._id),
      modelVersion: model.version,
    });

    res.json({
      success: true,
      model: {
        id: String(model._id),
        version: model.version,
        status: model.status,
        isActive: true,
        lifecycleState: 'active',
        featuresUsed: model.featuresUsed,
        featureSetType: model.featureSetType || 'score_based',
        featureCount: model.featureCount || (model.featuresUsed ? model.featuresUsed.length : 0),
        classNames: model.classNames,
        accuracy: model.accuracy,
      },
    });
  } catch (err) {
    console.error('Model activation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Exposed for tests only (see tests/unit/model-activation.test.js). Attaching
// to the router function is inert for Express — app.use() only ever calls it
// as a request handler, so this does not affect routing.
router.__testables = { modelLifecycleState, getModelActivationBlocker, performModelActivation };
