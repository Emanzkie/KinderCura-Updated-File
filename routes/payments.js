const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const paymentController = require('../controllers/paymentController');

const router = express.Router();

router.get('/quote', authMiddleware, paymentController.quoteDownPayment);
router.get('/pending-balances', authMiddleware, paymentController.getPendingBalances);
router.get('/appointments/:appointmentId', authMiddleware, paymentController.getAppointmentPayments);
router.post('/appointments/:appointmentId/manual', authMiddleware, paymentController.recordManualPayment);

module.exports = router;
