// middleware/guardianAccess.js
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const Appointment = require('../models/Appointment');

async function resolveChildIdFromReq(req) {
  return req.params.childId || req.body.childId || req.query.childId || null;
}

async function hasPermission(userId, childId, permissionKey) {
  if (!userId || !childId) return false;

  const child = await Child.findById(childId).lean();
  if (!child) return false;

  // Parent owner has full control
  if (String(child.parentId) === String(userId)) return true;

  // Look up an active guardian link
  const link = await GuardianLink.findOne({ childId, guardianId: userId, status: 'active' }).lean();
  if (!link) return false;

  // If permissionKey is not provided, treat any active link as permission
  if (!permissionKey) return true;

  const perms = link.permissions || {};
  // viewMedicalRecords is stored as string; handle truthy defaults
  if (permissionKey === 'viewMedicalRecords') {
    return perms.viewMedicalRecords && perms.viewMedicalRecords !== 'none';
  }

  return Boolean(perms[permissionKey]);
}

// Read access to one child's records: the owning parent, a pediatrician with
// an appointment for this child, an admin, or a guardian link granting
// permissionKey. Owner is checked first so owners never trigger a link lookup.
async function canViewChild(user, child, permissionKey) {
  if (!user || !child) return false;
  if (String(child.parentId) === String(user.userId)) return true;
  if (user.role === 'admin') return true;
  if (user.role === 'pediatrician') {
    if (await Appointment.exists({ childId: child._id, pediatricianId: user.userId })) return true;
  }
  return hasPermission(user.userId, child._id, permissionKey);
}

// Express middleware factory
function checkPermission(permissionKey) {
  return async function (req, res, next) {
    const childId = await resolveChildIdFromReq(req);
    if (!childId) return res.status(400).json({ error: 'childId is required.' });

    if (await hasPermission(req.user.userId, childId, permissionKey)) return next();

    return res.status(403).json({ error: 'Access denied.' });
  };
}

module.exports = { hasPermission, canViewChild, checkPermission };
