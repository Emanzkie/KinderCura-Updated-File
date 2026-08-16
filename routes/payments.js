const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const paymentController = require('../controllers/paymentController');

const router = express.Router();

// Existing routes
router.get('/quote', authMiddleware, paymentController.quoteDownPayment);
router.get('/pending-balances', authMiddleware, paymentController.getPendingBalances);
router.get('/appointments/:appointmentId', authMiddleware, paymentController.getAppointmentPayments);
router.post('/appointments/:appointmentId/manual', authMiddleware, paymentController.recordManualPayment);

// New payment flow routes
router.post('/appointments/:appointmentId/select-mode', authMiddleware, paymentController.selectPaymentMode);
// Legacy manual e-wallet transfer — retired in favor of Pay Online (PayMongo)
// and Pay at Clinic (QR). No upload middleware runs in front of this anymore,
// so a stale client gets a clean 410 without any file ever being accepted.
router.post('/appointments/:appointmentId/ewallet-proof', authMiddleware, paymentController.uploadEwalletProof);
router.post('/appointments/:appointmentId/confirm-walkin', authMiddleware, paymentController.confirmWalkIn);
router.post('/appointments/:appointmentId/verify-ewallet', authMiddleware, paymentController.verifyEwallet);
router.get('/pending-ewallet', authMiddleware, paymentController.getPendingEwallets);
// Kept active (read-only, admin-gated): still needed to view proof images on
// historical e-wallet payment records for audit purposes.
router.get('/proof/:filename', authMiddleware, paymentController.serveProofImage);

// ── Automated payments ────────────────────────────────────────────────────

// PayMongo webhook. Deliberately NOT behind authMiddleware: PayMongo cannot
// present a JWT. It is authenticated by the Paymongo-Signature HMAC instead,
// which is verified against the raw request bytes captured in server.js.
router.post('/webhook/paymongo', paymentController.handlePaymongoWebhook);

// Parent — Pay Online
router.post('/appointments/:appointmentId/checkout', authMiddleware, paymentController.startOnlineCheckout);
router.get('/ref/:paymentRef/status', authMiddleware, paymentController.getPaymentStatusByRef);
router.post('/ref/:paymentRef/reconcile', authMiddleware, paymentController.reconcileCheckout);

// Parent — Pay at Clinic
router.post('/appointments/:appointmentId/pay-at-clinic', authMiddleware, paymentController.startPayAtClinic);

// Secretary / cashier
router.get('/clinic/today', authMiddleware, paymentController.getClinicToday);
router.get('/clinic/lookup/:paymentRef', authMiddleware, paymentController.lookupClinicPayment);
router.post('/clinic/:paymentRef/confirm', authMiddleware, paymentController.confirmClinicPayment);

// Admin — monitoring and clinic configuration
router.get('/admin/monitor', authMiddleware, paymentController.getAdminPaymentMonitor);
router.get('/clinic-config', authMiddleware, paymentController.getClinicConfig);
router.put('/clinic-config', authMiddleware, paymentController.updateClinicConfig);

module.exports = router;
