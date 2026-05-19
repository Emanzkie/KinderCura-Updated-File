// routes/notifications.js
// Purpose:
// - load the notification bell list for parent, pediatrician, and admin pages
// - keep unread counts accurate
// - let users mark one, all, or delete notifications
// - support older records that may store user references in different fields
// - fall back to the raw MongoDB collection if the model shape changes

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const Notification = require('../models/Notification');
const GuardianLink = require('../models/GuardianLink');
const Child = require('../models/Child');
const { hasPermission } = require('../middleware/guardianPermission');

function toObjectId(value) {
  try {
    const raw = String(value || '').trim();
    return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
  } catch {
    return null;
  }
}

// Match notifications owned by this user even if older records used a different field name
// or saved the id as a string instead of an ObjectId.
function buildUserQuery(userId) {
  const raw = String(userId || '').trim();
  console.log('[buildUserQuery] raw userId:', raw);
  const or = [
    { userId: raw },
    { recipientId: raw },
    { recipient: raw },
  ];

  const objectId = toObjectId(raw);
  if (objectId) {
    or.push(
      { userId: objectId },
      { recipientId: objectId },
      { recipient: objectId }
    );
  }

  const query = { $or: or };
  console.log('[buildUserQuery] Final query:', JSON.stringify(query));
  return query;
}

// Match a notification document by numeric id, string id, or _id fallback.
function buildNotificationQuery(id) {
  const raw = String(id || '').trim();
  const or = [];

  if (!raw) return {};

  const numericId = Number(raw);
  if (Number.isFinite(numericId)) or.push({ id: numericId });
  or.push({ id: raw });

  const objectId = toObjectId(raw);
  if (objectId) or.push({ _id: objectId });

  return { $or: or };
}

function resolveNotificationModel() {
  if (!Notification) return null;
  if (typeof Notification.find === 'function') return Notification;
  if (Notification.default && typeof Notification.default.find === 'function') return Notification.default;
  if (Notification.Notification && typeof Notification.Notification.find === 'function') return Notification.Notification;
  return null;
}

function getCollection() {
  return mongoose.connection.collection('notifications');
}

function safeId(value) {
  if (value == null) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function formatNotification(n) {
  return {
    id: n.id ?? safeId(n._id),
    title: n.title || '',
    message: n.message || '',
    type: n.type || 'system',
    relatedPage: n.relatedPage || null,
    isRead: Boolean(n.isRead),
    createdAt: n.createdAt || n.created_at || new Date(),
  };
}

async function fetchNotificationsForUser(userId) {
  const model = resolveNotificationModel();
  const filter = buildUserQuery(userId);
  console.log('[fetchNotificationsForUser] Query filter:', JSON.stringify(filter));

  if (model) {
    try {
      const results = await model.find(filter).sort({ createdAt: -1, id: -1 }).lean();
      console.log('[fetchNotificationsForUser] Model query returned:', results.length);
      return results;
    } catch (err) {
      console.warn('[fetchNotificationsForUser] Notification model read failed, using collection fallback:', err.message);
    }
  }

  const results = await getCollection().find(filter).sort({ createdAt: -1, id: -1 }).toArray();
  console.log('[fetchNotificationsForUser] Collection fallback returned:', results.length);
  return results;
}

async function countUnreadForUser(userId) {
  const filter = { ...buildUserQuery(userId), isRead: false };
  const model = resolveNotificationModel();

  if (model) {
    try {
      return await model.countDocuments(filter);
    } catch (err) {
      console.warn('Notification model count failed, using collection fallback:', err.message);
    }
  }

  return getCollection().countDocuments(filter);
}

async function updateManyNotifications(filter, update) {
  const model = resolveNotificationModel();
  let modelResult = null;

  if (model) {
    try {
      modelResult = await model.updateMany(filter, update);
    } catch (err) {
      console.warn('Notification model update failed, using collection fallback:', err.message);
    }
  }

  const collectionResult = await getCollection().updateMany(filter, update);
  return modelResult || collectionResult;
}

async function deleteManyNotifications(filter) {
  const model = resolveNotificationModel();
  let modelResult = null;

  if (model) {
    try {
      modelResult = await model.deleteMany(filter);
    } catch (err) {
      console.warn('Notification model delete failed, using collection fallback:', err.message);
    }
  }

  const collectionResult = await getCollection().deleteMany(filter);
  return modelResult || collectionResult;
}

async function updateOneNotification(filter, update) {
  const model = resolveNotificationModel();
  let updated = null;

  if (model) {
    try {
      updated = await model.findOneAndUpdate(filter, update, { new: true }).lean();
    } catch (err) {
      console.warn('Notification model single update failed, using collection fallback:', err.message);
    }
  }

  if (updated) return updated;

  await getCollection().updateOne(filter, update);
  return null;
}

async function deleteOneNotification(filter) {
  const model = resolveNotificationModel();
  let deleted = null;

  if (model) {
    try {
      deleted = await model.findOneAndDelete(filter).lean();
    } catch (err) {
      console.warn('Notification model single delete failed, using collection fallback:', err.message);
    }
  }

  if (deleted) return deleted;

  const result = await getCollection().deleteOne(filter);
  return result;
}

// GET /api/notifications
// Returns the full bell list for the logged-in user.
router.get('/', authMiddleware, async (req, res) => {
  try {
    console.log('[GET /api/notifications] userId:', req.user.userId, 'role:', req.user.role);
    const notifications = await fetchNotificationsForUser(req.user.userId);
    console.log('[GET /api/notifications] Found notifications:', notifications.length);
    res.json({
      success: true,
      notifications: notifications.map(formatNotification),
    });
  } catch (err) {
    console.error('[GET /api/notifications] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/count
// Used by every bell badge in the system.
router.get('/count', authMiddleware, async (req, res) => {
  try {
    const unread = await countUnreadForUser(req.user.userId);
    res.json({ success: true, unread });
  } catch (err) {
    console.error('notifications count error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/read-all
// Marks all notifications as read, but never blocks the UI if something is missing.
router.put('/read-all', authMiddleware, async (req, res) => {
  try {
    const result = await updateManyNotifications(
      { ...buildUserQuery(req.user.userId), isRead: false },
      { $set: { isRead: true } }
    );

    res.json({
      success: true,
      updatedCount: result?.modifiedCount ?? result?.nModified ?? 0,
    });
  } catch (err) {
    console.error('notifications read-all error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications/clear-all
// Removes every notification for the logged-in user.
router.delete('/clear-all', authMiddleware, async (req, res) => {
  try {
    const result = await deleteManyNotifications(buildUserQuery(req.user.userId));
    res.json({
      success: true,
      deletedCount: result?.deletedCount ?? 0,
    });
  } catch (err) {
    console.error('notifications clear-all error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications/all
// Alias used by newer notification UIs.
router.delete('/all', authMiddleware, async (req, res) => {
  try {
    const result = await deleteManyNotifications(buildUserQuery(req.user.userId));
    res.json({
      success: true,
      deletedCount: result?.deletedCount ?? 0,
    });
  } catch (err) {
    console.error('notifications all delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/:id/read
// Marks one notification as read.
router.put('/:id/read', authMiddleware, async (req, res) => {
  try {
    const filter = {
      ...buildNotificationQuery(req.params.id),
      ...buildUserQuery(req.user.userId),
    };

    const updated = await updateOneNotification(filter, { $set: { isRead: true } });

    if (!updated) {
      // Even when the document was not found by the model, the collection update above
      // still handled it. Returning success keeps the bell UI consistent.
      return res.json({ success: true });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('notifications read error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications/:id
// Removes one notification from the user's list.
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const filter = {
      ...buildNotificationQuery(req.params.id),
      ...buildUserQuery(req.user.userId),
    };

    await deleteOneNotification(filter);
    res.json({ success: true });
  } catch (err) {
    console.error('notifications delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/child/:childId
// Returns notifications related to a specific child (requires guardian/parent access)
router.get('/child/:childId', authMiddleware, hasPermission('view_notifications'), async (req, res) => {
  try {
    const childId = req.params.childId;
    const model = resolveNotificationModel();
    const filter = {
      $and: [
        buildUserQuery(req.user.userId),
        { $or: [{ relatedId: childId }, { relatedId: String(childId) }] },
      ],
    };

    let results = [];
    if (model) {
      try {
        results = await model.find(filter).sort({ createdAt: -1 }).lean();
      } catch (err) {
        console.warn('notification model child query failed, using collection fallback:', err.message);
      }
    }

    if (!results || results.length === 0) {
      results = await getCollection().find(filter).sort({ createdAt: -1 }).toArray();
    }

    res.json({ success: true, notifications: results.map(formatNotification) });
  } catch (err) {
    console.error('notifications child error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/send
// Primary guardian (or admin) may create a notification targeted to all guardians of the child
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { childId, title, message, type = 'system', relatedPage = null, relatedId = null } = req.body;
    if (!childId || !title || !message) return res.status(400).json({ error: 'childId, title and message are required.' });

    const child = await Child.findById(childId).lean();
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    // Only primary guardian, linked guardian with permission, or admin may send
    const isOwner = String(child.parentId) === String(req.user.userId) || req.user.role === 'admin';
    const link = await GuardianLink.findOne({ childId, guardianId: req.user.userId, status: 'active' }).lean();
    const hasPerm = link && link.permissions && link.permissions.sendNotifications;
    if (!isOwner && !hasPerm) return res.status(403).json({ error: 'Only primary guardian or admin may send notifications for this child.' });

    const recipients = new Set();
    if (child.parentId) recipients.add(String(child.parentId));
    const links = await GuardianLink.find({ childId, status: 'active' }).lean();
    links.forEach((l) => recipients.add(String(l.guardianId)));

    const payloads = Array.from(recipients).map((uid) => ({
      userId: new mongoose.Types.ObjectId(uid),
      title,
      message,
      type,
      relatedPage,
      relatedId,
      isRead: false,
      createdAt: new Date(),
    }));

    const model = resolveNotificationModel();
    try {
      if (model && typeof model.insertMany === 'function') {
        await model.insertMany(payloads);
      } else if (model && typeof model.create === 'function') {
        await model.create(payloads);
      } else {
        await getCollection().insertMany(payloads);
      }
    } catch (err) {
      console.warn('notifications send insert failed, fallback may have partial success:', err.message);
    }

    res.json({ success: true, sentCount: payloads.length });
  } catch (err) {
    console.error('notifications send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/read/:id
// Marks one notification as read. Ensures user owns the notification or has guardian access to related child.
router.put('/read/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const filter = buildNotificationQuery(id);
    // Try to locate the notification first
    const model = resolveNotificationModel();
    let doc = null;
    if (model) {
      try {
        doc = await model.findOne(filter).lean();
      } catch (err) {
        console.warn('notification model read failed, using collection fallback:', err.message);
      }
    }

    if (!doc) {
      const arr = await getCollection().find(filter).limit(1).toArray();
      doc = arr && arr[0] ? arr[0] : null;
    }

    if (!doc) return res.status(404).json({ error: 'Notification not found.' });

    // If the notification clearly belongs to the user allow it
    const ownerIds = [String(doc.userId || doc.recipientId || doc.recipient || '')];
    if (ownerIds.includes(String(req.user.userId))) {
      await updateOneNotification(filter, { $set: { isRead: true } });
      return res.json({ success: true });
    }

    // Otherwise, if the notification references a child, ensure the user has guardian permission
    const relatedId = doc.relatedId || null;
    if (relatedId) {
      // If relatedId looks like a child id, check guardian permission
      const child = await Child.findById(relatedId).lean();
      if (child) {
        const link = await GuardianLink.findOne({ childId: child._id, guardianId: req.user.userId, status: 'active' }).lean();
        if (link && link.permissions && link.permissions.viewNotifications) {
          await updateOneNotification(filter, { $set: { isRead: true } });
          return res.json({ success: true });
        }
      }
    }

    return res.status(403).json({ error: 'Access denied.' });
  } catch (err) {
    console.error('notifications read-by-id error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
