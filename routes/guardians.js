// routes/guardians.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const guardianController = require('../controllers/guardianController');

// Invitation flow endpoints
router.post('/invite', authMiddleware, guardianController.generateInvitation);
router.get('/verify/:token', guardianController.verifyInvitation);
router.post('/accept', authMiddleware, guardianController.acceptInvitation);

// Guardian management endpoints
router.get('/list/:childId', authMiddleware, guardianController.listGuardians);
router.put('/:linkId/permissions', authMiddleware, guardianController.updatePermissions);
router.delete('/:linkId', authMiddleware, guardianController.revokeGuardian);

// Pending invitations management
router.get('/pending-invitations', authMiddleware, guardianController.listPendingInvitations);
router.post('/invitations/:id/resend', authMiddleware, guardianController.resendInvitation);
router.post('/invitations/:id/revoke', authMiddleware, guardianController.revokeInvitation);
router.post('/invitations/:id/transfer-primary', authMiddleware, guardianController.transferPrimary);

// Backward compatibility aliases (keep existing endpoints working)
router.post('/generate-invitation', authMiddleware, guardianController.generateInvitation);
router.post('/accept-invitation', authMiddleware, guardianController.acceptInvitation);
router.get('/children/:childId/guardians', authMiddleware, guardianController.listGuardians);
router.put('/children/:childId/guardians/:guardianId/permissions', authMiddleware, guardianController.updatePermissions);
router.delete('/children/:childId/guardians/:guardianId', authMiddleware, guardianController.revokeGuardian);
router.post('/children/:childId/transfer-primary', authMiddleware, guardianController.transferPrimary);

// Post-acceptance email trigger
router.post('/invitations/accept-email', authMiddleware, guardianController.sendAcceptanceEmails);

module.exports = router;
