const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware } = require('../middleware/auth');
const paymentController = require('../controllers/paymentController');

const router = express.Router();

// E-wallet proof images are stored in a private directory (not publicly served).
const PROOF_DIR = path.join(__dirname, '..', 'private', 'payment-proofs');

const ewalletStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(PROOF_DIR)) fs.mkdirSync(PROOF_DIR, { recursive: true });
    cb(null, PROOF_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `proof_appt${req.params.appointmentId}_${Date.now()}${ext}`);
  },
});

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
router.post('/appointments/:appointmentId/ewallet-proof', authMiddleware, ewalletUpload.single('proofImage'), paymentController.uploadEwalletProof);
router.post('/appointments/:appointmentId/confirm-walkin', authMiddleware, paymentController.confirmWalkIn);
router.post('/appointments/:appointmentId/verify-ewallet', authMiddleware, paymentController.verifyEwallet);
router.get('/pending-ewallet', authMiddleware, paymentController.getPendingEwallets);
router.get('/proof/:filename', authMiddleware, paymentController.serveProofImage);

module.exports = router;
