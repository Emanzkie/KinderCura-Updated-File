// routes/audit-logs.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { listLogs } = require('../controllers/auditController');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');

// GET /api/v2/audit-logs?childId=...
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { childId, limit = 200, skip = 0 } = req.query;

    // Only admins or primary guardians / owners may view child audit logs
    if (childId) {
      const child = await Child.findById(childId).lean();
      if (!child) return res.status(404).json({ error: 'Child not found.' });

      const isOwner = String(child.parentId) === String(req.user.userId) || req.user.role === 'admin';
      if (!isOwner) {
        const link = await GuardianLink.findOne({ childId, guardianId: req.user.userId, status: 'active' }).lean();
        if (!link) return res.status(403).json({ error: 'Access denied.' });
      }
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only.' });
    }

    const logs = await listLogs({ filter: childId ? { 'details.childId': childId } : {}, limit, skip });
    res.json({ success: true, logs });
  } catch (err) {
    console.error('audit-logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
