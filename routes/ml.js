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
const fileStorage = require('../services/fileStorage');
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

      // 3. Resolve dataset file on disk or in storage
      let datasetPath = modelManager.resolveDatasetPath(dataset.filePath);
      let datasetContent = null;
      if (!datasetPath) {
        const storedName = dataset.storedName || path.basename(dataset.filePath);
        const storedBuffer = await fileStorage.readStored('uploads/datasets', storedName);
        if (storedBuffer) {
          datasetContent = storedBuffer.toString('utf8');
          datasetPath = `/uploads/datasets/${storedName}`;
        }
      }

      if (!datasetPath && !datasetContent) {
        return res.status(404).json({
          error: `Dataset file not found. Expected at: ${dataset.filePath}`,
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
        const metrics = await modelManager.trainModel(datasetPath, dataset._id, { featureSet, datasetContent });

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
          // The SERVER's reason this model cannot be activated, or null when
          // it can. Sent so the admin UI shows the actual rule that would
          // reject it rather than a second copy of the rules that could drift
          // out of sync with getModelActivationBlocker(). Note this is the
          // cheap document-level check only — the artifact/prediction smoke
          // test runs on demand via POST /models/:modelId/smoke-test, because
          // it spawns Python and must not run once per row on every page load.
          activationBlocker: m.isActive ? null : getModelActivationBlocker(m),
          canActivate: !m.isActive && getModelActivationBlocker(m) === null,
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

/**
 * Full pre-activation gate: the cheap document rules, then a REAL prediction.
 *
 * getModelActivationBlocker() can only see what MongoDB says. It cannot tell
 * that the .joblib is missing, unreadable, or trained on different columns
 * than the document claims — all of which produce a model that activates
 * cleanly and then fails on every live prediction. modelManager.smokeTestModel
 * closes that gap by loading the artifact and predicting once through the same
 * code path live predictions use.
 *
 * Read-only: writes nothing and never changes which model is active.
 *
 * @returns {Promise<{ok: boolean, blocker: string|null, smokeTest: object|null}>}
 */
async function runActivationPreflight(model) {
  const blocker = getModelActivationBlocker(model);
  if (blocker) return { ok: false, blocker, smokeTest: null };

  const smokeTest = await modelManager.smokeTestModel(model);
  if (!smokeTest.ok) {
    return {
      ok: false,
      blocker: `Pre-activation smoke test failed: ${smokeTest.error}`,
      smokeTest,
    };
  }
  return { ok: true, blocker: null, smokeTest };
}

/**
 * Promote one model to active.
 *
 * ORDER: deactivate every other model FIRST, then activate the requested one.
 *
 * This is the opposite of the original order, which activated first so there
 * was never a moment with no active model. The tradeoff was a brief window
 * with TWO active documents, during which findOne({isActive:true}) could
 * return either one — so a prediction in that window might silently use the
 * OLD model. The invariant "at most one model is active" is the more valuable
 * one to hold absolutely, and the cost of the other window is nil: with no
 * active model, services/assessmentProgress.js getMLCareStage() returns null
 * and the existing rule-based fallback runs, which is a documented, safe,
 * already-exercised path (it is what the system does today).
 *
 * Verified rather than assumed: the write is followed by a count, and a
 * violated invariant is repaired and reported instead of passing silently.
 * MongoDB gives no cross-document atomicity without a transaction, so this
 * check is what makes the invariant real.
 *
 * Never deletes anything. A deactivated model keeps its document, its metrics
 * and its .joblib artifact, which is what makes rollback possible.
 */
async function performModelActivation(model) {
  await TrainedModel.updateMany({ _id: { $ne: model._id }, isActive: true }, { $set: { isActive: false } });
  model.isActive = true;
  await model.save();

  const activeCount = await TrainedModel.countDocuments({ isActive: true });
  if (activeCount !== 1) {
    // Self-heal: re-run the deactivation, then re-check. If it still fails the
    // caller is told, because silently reporting success here would leave the
    // system in the exact state this function exists to prevent.
    await TrainedModel.updateMany({ _id: { $ne: model._id }, isActive: true }, { $set: { isActive: false } });
    const repaired = await TrainedModel.countDocuments({ isActive: true });
    if (repaired !== 1) {
      throw new Error(
        `Model activation left ${repaired} active model(s) instead of exactly 1. ` +
        'The active model may be ambiguous — check the Trained Models panel before relying on ML predictions.'
      );
    }
  }
  return { activeCount: 1 };
}

/**
 * Turn ML off entirely: no model active, every prediction rule-based.
 *
 * The counterpart to activation, and the only way back to the rule-based-only
 * behaviour the system had before any model was promoted. Deliberately a
 * separate action from switching models, because "use a different model" and
 * "stop using ML" are different decisions.
 *
 * Deactivation is a FLAG CHANGE ONLY. No document is deleted, no .joblib is
 * removed, no metrics are cleared — every deactivated model stays fully
 * intact and can be re-activated later (subject to the same preflight).
 *
 * @returns {Promise<{deactivated: number, previous: Array}>}
 */
async function performModelDeactivation() {
  const previouslyActive = await TrainedModel.find({ isActive: true }).select('version modelPath').lean();
  const res = await TrainedModel.updateMany({ isActive: true }, { $set: { isActive: false } });
  return {
    deactivated: res.modifiedCount || 0,
    previous: previouslyActive.map((m) => ({ version: m.version, modelPath: m.modelPath })),
  };
}

/**
 * POST /api/ml/models/:modelId/smoke-test
 *
 * Run the pre-activation checks WITHOUT activating anything. This is what the
 * admin UI calls before showing its confirmation dialog, so the admin sees a
 * real "this model can produce a prediction" result before deciding, rather
 * than discovering a broken artifact after the switch.
 *
 * Always 200 for a model that exists — a FAILED smoke test is a valid result
 * to report, not a request error. Read the `ok` field.
 */
router.post('/models/:modelId/smoke-test', authMiddleware, adminOnly, async (req, res) => {
  try {
    const model = await TrainedModel.findById(req.params.modelId).lean();
    if (!model) return res.status(404).json({ error: 'Model not found.' });

    const preflight = await runActivationPreflight(model);
    res.json({
      success: true,
      modelId: String(model._id),
      version: model.version,
      ok: preflight.ok,
      blocker: preflight.blocker,
      smokeTest: preflight.smokeTest,
      probe: modelManager.buildSmokeTestProbe(model),
    });
  } catch (err) {
    console.error('Model smoke test error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ml/models/deactivate
 *
 * Deactivate whatever model is currently active and fall back to rule-based
 * predictions. Nothing is deleted — see performModelDeactivation.
 *
 * Declared BEFORE the '/models/:modelId/activate' route below only for
 * readability; Express matches on the full path, and 'deactivate' has no
 * second segment, so the two can never shadow each other.
 */
router.post('/models/deactivate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await performModelDeactivation();

    sse.broadcast('analytics:update', {
      type: 'ml',
      action: 'model_deactivated',
      deactivated: result.deactivated,
    });

    res.json({
      success: true,
      deactivated: result.deactivated,
      previous: result.previous,
      message: result.deactivated
        ? `Deactivated model v${result.previous.map((p) => p.version).join(', v')}. New predictions will use the rule-based fallback. No model or model file was deleted.`
        : 'No model was active. New predictions were already using the rule-based fallback.',
    });
  } catch (err) {
    console.error('Model deactivation error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/models/:modelId/activate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const model = await TrainedModel.findById(req.params.modelId);
    if (!model) {
      return res.status(404).json({ error: 'Model not found.' });
    }

    // Document rules AND a real test prediction. A model that cannot predict
    // never becomes the model live predictions depend on.
    const preflight = await runActivationPreflight(model);
    if (!preflight.ok) {
      return res.status(409).json({ error: preflight.blocker, smokeTest: preflight.smokeTest });
    }

    // Recorded so the response can name what was rolled back FROM, which is
    // what the admin needs in order to roll back TO it again later.
    const previouslyActive = await TrainedModel.find({ isActive: true, _id: { $ne: model._id } })
      .select('version')
      .lean();

    await performModelActivation(model);

    sse.broadcast('analytics:update', {
      type: 'ml',
      action: 'model_activated',
      modelId: String(model._id),
      modelVersion: model.version,
    });

    res.json({
      success: true,
      // Deactivated, never deleted: these documents and their .joblib files
      // are untouched and remain activatable.
      deactivated: previouslyActive.map((m) => ({ version: m.version })),
      smokeTest: preflight.smokeTest,
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
router.__testables = {
  modelLifecycleState,
  getModelActivationBlocker,
  performModelActivation,
  performModelDeactivation,
  runActivationPreflight,
};
