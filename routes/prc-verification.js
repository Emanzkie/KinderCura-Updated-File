// routes/prc-verification.js
// ──────────────────────────────────────────────────────────────────
// PRC License Verification Module — Backend API
//
// PURPOSE:
//   Allows pediatricians to submit their PRC License Number and
//   upload a PRC ID document.  Admins can then list pending
//   submissions, preview the document, and approve or reject the
//   verification after manually cross-checking against the official
//   PRC verification portal.
//
// ENDPOINTS ADDED:
//   POST   /api/prc/upload          – Pediatrician uploads PRC ID + license number
//   GET    /api/prc/status          – Pediatrician checks own verification status
//   GET    /api/prc/pending         – Admin lists all pending verifications
//   GET    /api/prc/document/:userId – Admin views a specific PRC ID document
//   PUT    /api/prc/verify/:userId  – Admin approves or rejects a verification
//
// SECURITY:
//   - PRC documents are stored in a separate 'uploads/prc-documents' directory
//     that is NOT publicly served by Express static middleware.
//   - Only admins can access /api/prc/document/:userId (served on demand).
//   - Only authenticated pediatricians can upload.
// ──────────────────────────────────────────────────────────────────

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const Notification = require('../models/Notification');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const fileStorage = require('../services/fileStorage');

const router = express.Router();

// ── Multer config — PRC documents go to PRIVATE storage ──────────
// PRC_DIR is project-relative: fileStorage resolves it to disk locally and to
// a private Vercel Blob prefix in production. PRC_UPLOAD_DIR stays as the
// on-disk path because the legacy document-resolution fallbacks below still
// scan the copies bundled with the deployment.
const PRC_DIR = 'uploads/prc-documents';
const PRC_ACCESS = { access: 'private' };
const PRC_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'prc-documents');

const prcFilename = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  // Unique, traceable filename: prc_<userId>_<timestamp>.<ext>
  cb(null, `prc_${req.user.userId}_${Date.now()}${ext}`);
};

const prcStorage = fileStorage.makeStorage(PRC_DIR, prcFilename);
const finalizePrc = fileStorage.finalizeUploads(PRC_DIR, prcFilename, PRC_ACCESS);

const prcFileFilter = (_req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) return cb(null, true);
  cb(new Error('Only JPG, PNG, WebP, and PDF files are accepted for PRC documents.'));
};

const prcUpload = multer({
  storage: prcStorage,
  fileFilter: prcFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

// ── Helper: delete an old PRC upload ─────────────────────────────
function deletePrcFile(filePath) {
  if (!filePath) return;
  fileStorage.deleteStored(PRC_DIR, path.basename(filePath), PRC_ACCESS);
}

function normalizeDocumentPath(value) {
  if (!value) return null;
  const clean = String(value).trim().replace(/\\/g, '/');
  if (!clean) return null;
  if (/^https?:\/\//i.test(clean)) return clean;
  const uploadsIndex = clean.indexOf('uploads/');
  if (uploadsIndex >= 0) return `/${clean.slice(uploadsIndex).replace(/^\/+/, '')}`;
  return clean;
}

function extractTimestampFromPath(value) {
  if (!value) return null;
  const match = path.basename(String(value)).match(/_(\d{10,})(?:\.[^.]+)?$/);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function findTimestampMatchedProfileDocument(user) {
  const profilesDir = path.join(__dirname, '..', 'uploads', 'profiles');
  if (!fs.existsSync(profilesDir)) return null;

  const profileUploadTs = extractTimestampFromPath(user?.profileIcon);
  const createdTs = user?.createdAt ? new Date(user.createdAt).getTime() : null;
  const anchorTs = profileUploadTs || createdTs;
  if (!anchorTs) return null;

  try {
    const nearby = fs.readdirSync(profilesDir)
      .filter((f) => /^user_\d+\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => ({ file: f, ts: extractTimestampFromPath(f) }))
      .filter((item) => item.ts && Math.abs(item.ts - anchorTs) <= 30 * 1000)
      .sort((a, b) => Math.abs(a.ts - anchorTs) - Math.abs(b.ts - anchorTs))[0];

    if (!nearby) return null;

    const publicPath = `/uploads/profiles/${nearby.file}`;
    console.log('[PRC Document] Found timestamp-matched profile document:', {
      userId: String(user._id),
      publicPath,
      deltaMs: Math.abs(nearby.ts - anchorTs),
    });
    return publicPath;
  } catch (err) {
    console.warn('[PRC Document] Timestamp orphan search failed:', err.message);
    return null;
  }
}

function buildDocumentResponseFields(user) {
  const storedPath = normalizeDocumentPath(
    user.prcIdDocumentPath ||
    user.idDocumentPath ||
    findTimestampMatchedProfileDocument(user) ||
    null
  );
  return {
    prcIdDocumentPath: storedPath,
    idDocumentPath: normalizeDocumentPath(user.idDocumentPath || null),
    prcDocumentUrl: `/api/prc/document/${String(user._id)}`,
    prcDocumentStaticUrl: storedPath && storedPath.startsWith('/uploads/') ? storedPath : null,
    hasPrcDocument: Boolean(storedPath),
  };
}

// ── Helper: create a notification (best-effort, never blocks) ────
async function pushNotification(userId, title, message, type = 'admin', relatedPage = '') {
  try {
    const payload = {
      userId: new mongoose.Types.ObjectId(String(userId)),
      title,
      message,
      type,
      relatedPage,
      isRead: false,
    };
    if (typeof Notification.create === 'function') {
      await Notification.create(payload);
    } else {
      await mongoose.connection.collection('notifications').insertOne({
        ...payload,
        createdAt: new Date(),
      });
    }
  } catch (err) {
    console.warn('[PRC] Notification push failed (non-blocking):', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────
// POST /api/prc/upload
// Pediatrician submits PRC License Number + PRC ID image
// ──────────────────────────────────────────────────────────────────
router.post('/upload', authMiddleware, (req, res) => {
  prcUpload.single('prcDocument')(req, res, (multerErr) => finalizePrc(req, res, async (storeErr) => {
    const err = multerErr || storeErr;
    if (err) {
      console.error('[PRC Upload][standalone] Upload failed:', {
        userId: req.user?.userId,
        message: err.message,
      });
      return res.status(400).json({ error: err.message });
    }

    try {
      const user = await User.findById(req.user.userId);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      if (user.role !== 'pediatrician') {
        return res.status(403).json({ error: 'Only pediatricians can submit PRC documents.' });
      }

      const licenseNumber = String(req.body.prcLicenseNumber || '').trim();
      if (!licenseNumber) {
        // Remove uploaded file if license number is missing
        if (req.file) deletePrcFile(req.file.filename);
        return res.status(400).json({ error: 'PRC License Number is required.' });
      }
      if (!req.file) {
        console.warn('[PRC Upload][standalone] Missing file in upload request:', {
          userId: req.user.userId,
          bodyKeys: Object.keys(req.body || {}),
        });
        return res.status(400).json({ error: 'PRC ID document file is required.' });
      }

      console.log('[PRC Upload][standalone] Received PRC document:', {
        userId: req.user.userId,
        originalName: req.file.originalname,
        savedName: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
      });

      // PRC license number format: accept alphanumeric, typically digits
      if (!/^[A-Za-z0-9\-]{3,20}$/.test(licenseNumber)) {
        deletePrcFile(req.file.filename);
        return res.status(400).json({ error: 'PRC License Number format is invalid.' });
      }

      // Remove old PRC document file if replacing
      if (user.prcIdDocumentPath) {
        deletePrcFile(user.prcIdDocumentPath);
      }

      // Update user record with PRC verification fields
      user.prcLicenseNumber = licenseNumber;
      user.prcIdDocumentPath = req.file.filename; // filename only — NOT publicly served
      user.prcVerificationStatus = 'pending';
      user.prcAdminNotes = null;
      user.prcSubmittedAt = new Date();
      await user.save();

      console.log('[PRC Upload][standalone] Saved PRC document fields:', {
        userId: String(user._id),
        prcLicenseNumber: user.prcLicenseNumber,
        prcIdDocumentPath: user.prcIdDocumentPath,
        prcSubmittedAt: user.prcSubmittedAt,
      });

      // Notify all admins about the new submission
      const admins = await User.find({ role: 'admin' }).select('_id').lean();
      for (const admin of admins) {
        await pushNotification(
          admin._id,
          'New PRC Verification Request',
          `Dr. ${user.firstName} ${user.lastName} submitted a PRC license for verification.`,
          'admin',
          '/admin/prc-verification'
        );
      }

      res.json({
        success: true,
        message: 'PRC document submitted. Awaiting admin verification.',
        verificationStatus: 'pending',
        ...buildDocumentResponseFields(user),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }));
});

// ──────────────────────────────────────────────────────────────────
// GET /api/prc/status
// Pediatrician checks own PRC verification status
// ──────────────────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    res.json({
      success: true,
      prcLicenseNumber: user.prcLicenseNumber || null,
      prcVerificationStatus: user.prcVerificationStatus || 'unsubmitted',
      prcAdminNotes: user.prcAdminNotes || null,
      prcSubmittedAt: user.prcSubmittedAt || null,
      prcVerifiedAt: user.prcVerifiedAt || null,
      hasDocument: !!user.prcIdDocumentPath,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/prc/pending
// Admin lists all pediatricians with pending PRC verification
// ──────────────────────────────────────────────────────────────────
router.get('/pending', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'pediatrician' };

    if (status && ['pending', 'verified', 'rejected'].includes(status)) {
      filter.prcVerificationStatus = status;
    } else {
      // Default: only pending
      filter.prcVerificationStatus = 'pending';
    }

    const users = await User.find(filter)
      .sort({ prcSubmittedAt: -1, createdAt: -1 })
      .select('firstName lastName email prcLicenseNumber prcVerificationStatus prcAdminNotes prcSubmittedAt prcVerifiedAt licenseNumber institution specialization clinicName status createdAt')
      .lean();

    res.json({
      success: true,
      users: users.map((u) => ({
        id: String(u._id),
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        prcLicenseNumber: u.prcLicenseNumber || u.licenseNumber || null,
        verificationStatus: u.prcVerificationStatus || 'unsubmitted',
        adminNotes: u.prcAdminNotes || null,
        submittedAt: u.prcSubmittedAt || u.createdAt || null,
        verifiedAt: u.prcVerifiedAt || null,
        accountStatus: u.status || 'pending',
        // Existing profile fields for context
        licenseNumber: u.licenseNumber || null,
        institution: u.institution || null,
        specialization: u.specialization || null,
        clinicName: u.clinicName || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/prc/document/:userId
// Admin-only: securely serve the PRC ID document for preview
// ──────────────────────────────────────────────────────────────────
router.get('/document/:userId', async (req, res) => {
  // Accept token from Authorization header OR query parameter
  // (query param fallback is needed because <img>/<a> tags can't set custom headers)
  let token = null;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'No token. Please log in.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: 'Token invalid or expired. Please log in again.' });
  }

  if (decoded.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only.' });
  }

  try {
    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Resolve best-available document filename
    let docFilename = normalizeDocumentPath(user.prcIdDocumentPath || user.idDocumentPath || null);
    if (!docFilename) {
      // Search all upload directories for orphan files matching this userId
      const dirs = [
        { base: 'profiles', prefix: `pediatric_id_${req.params.userId}_` },
        { base: 'prc', prefix: `prc_${req.params.userId}_` },
        { base: 'prc-documents', prefix: `prc_${req.params.userId}_` },
      ];
      for (const { base, prefix } of dirs) {
        const dir = path.join(__dirname, '..', 'uploads', base);
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir);
          const match = files.find((f) => f.startsWith(prefix));
          if (match) { docFilename = path.join(dir, match); break; }
        } catch { /* ignore */ }
      }
    }
    if (!docFilename) {
      docFilename = findTimestampMatchedProfileDocument(user);
    }

    if (!docFilename) {
      console.warn('[PRC Document] No document path available for user:', req.params.userId);
      return res.status(404).json({ error: 'No PRC document on file.' });
    }

    const normalizedDocPath = normalizeDocumentPath(docFilename);

    // Documents uploaded since the move to Blob live in the private store.
    // Anything older is still on disk inside the deployment, so fall through
    // to the directory search below when the blob lookup comes up empty.
    if (fileStorage.USE_BLOB) {
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      const blobName = path.basename(String(normalizedDocPath || docFilename));
      if (await fileStorage.serveStored(res, PRC_DIR, blobName, PRC_ACCESS)) {
        console.log('[PRC Document] Served PRC document from blob store:', {
          userId: req.params.userId, blobName,
        });
        return;
      }
    }

    // Check PRC-documents, prc, and profiles directories
    const directUploadPath = normalizedDocPath && normalizedDocPath.startsWith('/uploads/')
      ? path.join(__dirname, '..', normalizedDocPath.slice(1))
      : null;
    const dirsToCheck = [
      directUploadPath,
      path.join(PRC_UPLOAD_DIR, path.basename(docFilename)),
      path.join(__dirname, '..', 'uploads', 'prc', path.basename(docFilename)),
      path.join(__dirname, '..', 'uploads', 'profiles', path.basename(docFilename)),
      docFilename,
    ].filter(Boolean);
    let resolvedPath = null;
    for (const p of dirsToCheck) {
      if (p && fs.existsSync(p)) { resolvedPath = p; break; }
    }
    if (!resolvedPath) {
      console.warn('[PRC Document] Document path did not resolve to a file:', {
        userId: req.params.userId,
        docFilename,
        checked: dirsToCheck,
      });
      return res.status(404).json({ error: 'Document file not found on disk.' });
    }

    console.log('[PRC Document] Serving PRC document:', {
      userId: req.params.userId,
      storedPath: user.prcIdDocumentPath || user.idDocumentPath || null,
      resolvedPath,
    });

    // Determine content type
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    // Prevent caching of sensitive documents
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    fs.createReadStream(resolvedPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /api/prc/verify/:userId
// Admin approves or rejects a PRC verification
// Body: { action: 'approve' | 'reject', notes: '...' }
// ──────────────────────────────────────────────────────────────────
router.put('/verify/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { action, notes } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be "approve" or "reject".' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'pediatrician') {
      return res.status(400).json({ error: 'Only pediatrician accounts can be verified.' });
    }

    const newStatus = action === 'approve' ? 'verified' : 'rejected';
    user.prcVerificationStatus = newStatus;
    user.prcAdminNotes = notes ? String(notes).trim() : null;
    user.prcVerifiedAt = new Date();
    user.prcVerifiedBy = req.user.userId;

    // ── Critical: toggle the account status so login is allowed/blocked ──
    // Approving PRC = set user.status to 'active' (pediatrician can now log in)
    // Rejecting PRC = keep user.status as 'pending' (pediatrician still blocked)
    if (action === 'approve') {
      user.status = 'active';
    } else {
      user.status = 'pending';
    }
    await user.save();

    // Notify the pediatrician about the verification result
    const notifTitle = action === 'approve'
      ? 'PRC License Verified ✅'
      : 'PRC Verification Rejected';
    const notifMessage = action === 'approve'
      ? 'Your PRC license has been verified by the admin. Your account is now fully credentialed.'
      : `Your PRC license verification was not approved.${notes ? ' Admin notes: ' + notes : ' Please re-submit with the correct documents.'}`;

    await pushNotification(
      user._id,
      notifTitle,
      notifMessage,
      'admin',
      '/pedia/pediatrician-dashboard.html'
    );

    res.json({
      success: true,
      message: `Verification ${newStatus} for Dr. ${user.firstName} ${user.lastName}.`,
      verificationStatus: newStatus,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/prc/verifications
// Admin lists all pediatricians with PRC verification data (any status)
// Supports optional ?status=pending|verified|rejected filter
// ──────────────────────────────────────────────────────────────────
router.get('/verifications', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'pediatrician', prcVerificationStatus: { $ne: null } };

    if (status && ['pending', 'verified', 'rejected'].includes(status)) {
      filter.prcVerificationStatus = status;
    }

    const users = await User.find(filter)
      .sort({ prcSubmittedAt: -1, createdAt: -1 })
      .select('firstName lastName email prcLicenseNumber specialization clinicName clinicAddress phoneNumber prcVerificationStatus prcAdminNotes prcSubmittedAt prcVerifiedAt prcVerifiedBy prcIdDocumentPath idDocumentPath profileIcon createdAt')
      .lean();

    res.json({
      success: true,
      users: users.map((u) => ({
        _id: String(u._id),
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        prcLicenseNumber: u.prcLicenseNumber || null,
        specialization: u.specialization || null,
        clinicName: u.clinicName || null,
        clinicAddress: u.clinicAddress || null,
        phoneNumber: u.phoneNumber || null,
        prcVerificationStatus: u.prcVerificationStatus || 'pending',
        prcAdminNotes: u.prcAdminNotes || null,
        prcSubmittedAt: u.prcSubmittedAt || null,
        prcVerifiedAt: u.prcVerifiedAt || null,
        ...buildDocumentResponseFields(u),
        createdAt: u.createdAt || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// GET /api/prc/verifications/:userId
// Admin views full details for a single pediatrician's PRC verification
// ──────────────────────────────────────────────────────────────────
router.get('/verifications/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('role firstName lastName email prcLicenseNumber specialization clinicName clinicAddress phoneNumber prcVerificationStatus prcAdminNotes prcSubmittedAt prcVerifiedAt prcVerifiedBy prcIdDocumentPath idDocumentPath profileIcon createdAt')
      .lean();

    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'pediatrician') {
      return res.status(400).json({ error: 'Not a pediatrician account.' });
    }

    res.json({
      success: true,
      user: {
        _id: String(user._id),
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        prcLicenseNumber: user.prcLicenseNumber || null,
        specialization: user.specialization || null,
        clinicName: user.clinicName || null,
        clinicAddress: user.clinicAddress || null,
        phoneNumber: user.phoneNumber || null,
        prcVerificationStatus: user.prcVerificationStatus || 'unsubmitted',
        prcAdminNotes: user.prcAdminNotes || null,
        prcSubmittedAt: user.prcSubmittedAt || null,
        prcVerifiedAt: user.prcVerifiedAt || null,
        ...buildDocumentResponseFields(user),
        createdAt: user.createdAt || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /api/prc/verifications/:userId/approve
// Admin approves a pediatrician's PRC verification
// ──────────────────────────────────────────────────────────────────
router.put('/verifications/:userId/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'pediatrician') {
      return res.status(400).json({ error: 'Only pediatrician accounts can be verified.' });
    }

    user.prcVerificationStatus = 'verified';
    user.prcAdminNotes = null;
    user.prcVerifiedAt = new Date();
    user.prcVerifiedBy = req.user.userId;
    user.status = 'active';
    await user.save();

    const notifTitle = 'PRC License Verified ✅';
    const notifMessage = 'Your PRC license has been verified by the admin. Your account is now fully credentialed.';

    await pushNotification(
      user._id,
      notifTitle,
      notifMessage,
      'admin',
      '/pedia/pediatrician-dashboard.html'
    );

    res.json({
      success: true,
      message: `Verification approved for Dr. ${user.firstName} ${user.lastName}.`,
      verificationStatus: 'verified',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// PUT /api/prc/verifications/:userId/reject
// Admin rejects a pediatrician's PRC verification
// ──────────────────────────────────────────────────────────────────
router.put('/verifications/:userId/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Rejection reason is required.' });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'pediatrician') {
      return res.status(400).json({ error: 'Only pediatrician accounts can be verified.' });
    }

    user.prcVerificationStatus = 'rejected';
    user.prcAdminNotes = String(reason).trim();
    user.prcVerifiedAt = new Date();
    user.prcVerifiedBy = req.user.userId;
    user.status = 'pending';
    await user.save();

    const notifTitle = 'PRC Verification Rejected';
    const notifMessage = `Your PRC license verification was not approved. Admin notes: ${String(reason).trim()}`;

    await pushNotification(
      user._id,
      notifTitle,
      notifMessage,
      'admin',
      '/pedia/pediatrician-dashboard.html'
    );

    res.json({
      success: true,
      message: `Verification rejected for Dr. ${user.firstName} ${user.lastName}.`,
      verificationStatus: 'rejected',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
