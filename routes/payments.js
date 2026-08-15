const express = require('express');
const multer = require('multer');
const path = require('path');
const { authMiddleware } = require('../middleware/auth');
const paymentController = require('../controllers/paymentController');
const fileStorage = require('../services/fileStorage');

const router = express.Router();

// E-wallet proof images are stored privately and never served as static files.
// PROOF_DIR is the project-relative folder; fileStorage decides whether that
// resolves to disk (local) or a private Vercel Blob path (production).
const PROOF_DIR = 'private/payment-proofs';

const proofFilename = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, `proof_appt${req.params.appointmentId}_${Date.now()}${ext}`);
};

const ewalletStorage = fileStorage.makeStorage(PROOF_DIR, proofFilename);

const ewalletFileFilter = (_req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  allowed.includes(ext)
    ? cb(null, true)
    : cb(new Error('Only JPG, PNG, or WebP images are accepted for payment proofs.'));
};

const ewalletUpload = multer({
  storage: ewalletStorage,
  fileFilter: ewalletFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Existing routes
router.get('/quote', authMiddleware, paymentController.quoteDownPayment);
router.get('/pending-balances', authMiddleware, paymentController.getPendingBalances);
router.get('/appointments/:appointmentId', authMiddleware, paymentController.getAppointmentPayments);
router.post('/appointments/:appointmentId/manual', authMiddleware, paymentController.recordManualPayment);

// New payment flow routes
router.post('/appointments/:appointmentId/select-mode', authMiddleware, paymentController.selectPaymentMode);
router.post(
  '/appointments/:appointmentId/ewallet-proof',
  authMiddleware,
  ewalletUpload.single('proofImage'),
  fileStorage.finalizeUploads(PROOF_DIR, proofFilename, { access: 'private' }),
  paymentController.uploadEwalletProof
);
router.post('/appointments/:appointmentId/confirm-walkin', authMiddleware, paymentController.confirmWalkIn);
router.post('/appointments/:appointmentId/verify-ewallet', authMiddleware, paymentController.verifyEwallet);
router.get('/pending-ewallet', authMiddleware, paymentController.getPendingEwallets);
router.get('/proof/:filename', authMiddleware, paymentController.serveProofImage);

module.exports = router;
