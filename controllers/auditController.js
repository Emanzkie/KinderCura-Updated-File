// controllers/auditController.js
const AuditLog = require('../models/AuditLog');

async function createLog({ actorId = null, action, targetType = null, targetId = null, details = null, ip = null, device = null }) {
  try {
    await AuditLog.create({ actorId, action, targetType, targetId, details, ip, device });
  } catch (err) {
    console.warn('Failed to write audit log:', err && err.message ? err.message : err);
  }
}

async function listLogs({ filter = {}, limit = 200, skip = 0 } = {}) {
  const q = { ...filter };
  // Names and role only, so the admin Logs page can show who acted without exposing emails.
  return AuditLog.find(q).sort({ createdAt: -1 }).skip(Number(skip || 0)).limit(Number(limit || 200))
    .populate('actorId', 'firstName lastName role').lean();
}

module.exports = { createLog, listLogs };
