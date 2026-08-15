// Upload routes converted to MongoDB
// Purpose:
// - save the image file in /public/uploads/profiles
// - save the image path in MongoDB
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const User = require('../models/User');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const { authMiddleware } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianAccess');
const fileStorage = require('../services/fileStorage');

const router = express.Router();

// Project-relative upload folders. fileStorage maps them to disk locally and
// to Vercel Blob in production — see services/fileStorage.js.
const PROFILE_DIR = 'uploads/profiles';
const PRC_DIR = 'uploads/prc';

// Profile photos are shown directly in <img> tags, so they stay public.
// PRC ID cards are identity documents and are stored privately.
const PROFILE_ACCESS = { access: 'public' };
const PRC_ACCESS = { access: 'private' };

const profileFilename = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.uploadType || 'user'}_${Date.now()}${ext}`);
};

const prcFilename = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `prc_${req.user.userId}_${Date.now()}${ext}`);
};

// Allow only common image types
const fileFilter = (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only image files are allowed (jpg, jpeg, png, gif, webp)'));
};

const upload = multer({
    storage: fileStorage.makeStorage(PROFILE_DIR, profileFilename),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },
});
const finalizeProfile = fileStorage.finalizeUploads(PROFILE_DIR, profileFilename, PROFILE_ACCESS);

const prcUpload = multer({
    storage: fileStorage.makeStorage(PRC_DIR, prcFilename),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },
});
const finalizePrc = fileStorage.finalizeUploads(PRC_DIR, prcFilename, PRC_ACCESS);

// Delete the old uploaded image so replaced profile photos do not pile up.
// Accepts both stored shapes: '/uploads/profiles/x.jpg' and 'uploads/prc/x.jpg'.
function deleteOldUpload(uploadPath) {
    if (!uploadPath) return;
    const clean = String(uploadPath).replace(/\\/g, '/').replace(/^\//, '');
    if (!clean.startsWith('uploads/')) return;
    const dir = path.posix.dirname(clean);
    const name = path.posix.basename(clean);
    const access = dir.includes('prc') ? PRC_ACCESS : PROFILE_ACCESS;
    fileStorage.deleteStored(dir, name, access);
}

// Upload the logged-in user's own profile picture
router.post('/profile', authMiddleware, (req, res) => {
    req.uploadType = `${req.user.role || 'user'}_${req.user.userId}`;
    upload.single('photo')(req, res, (err) => finalizeProfile(req, res, async (finalizeErr) => {
        const uploadErr = err || finalizeErr;
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        try {
            const picPath = `/uploads/profiles/${req.file.filename}`;
            const user = await User.findById(req.user.userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found.' });
            }

            // Persist first, then delete the old file, so a failed write can
            // never leave the user with no photo at all.
            const previousIcon = user.profileIcon;
            user.profileIcon = picPath;
            await user.save();
            deleteOldUpload(previousIcon);

            res.json({ success: true, path: picPath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }));
});

// Upload one child's profile picture
router.post('/child/:childId', authMiddleware, (req, res) => {
    req.uploadType = `child_${req.params.childId}`;
    upload.single('photo')(req, res, (err) => finalizeProfile(req, res, async (finalizeErr) => {
        const uploadErr = err || finalizeErr;
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        try {
            const picPath = `/uploads/profiles/${req.file.filename}`;
            // NOT .lean(): a lean() result is a plain object with no .save(),
            // so saving threw TypeError and the new path was never persisted
            // (while deleteOldUpload had already removed the previous photo).
            const child = await Child.findById(req.params.childId);
            if (!child) {
                return res.status(404).json({ error: 'Child not found.' });
            }

            const allowed = await hasPermission(req.user.userId, child._id, 'uploadDocuments');
            if (!allowed) {
                return res.status(403).json({ error: 'Access denied.' });
            }

            // Persist first, then delete the old file — if the write fails the
            // child keeps the photo it already had.
            const previousIcon = child.profileIcon;
            child.profileIcon = picPath;
            await child.save();
            deleteOldUpload(previousIcon);

            res.json({ success: true, path: picPath, childId: String(child._id) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }));
});

// Upload pediatrician's ID document for verification
// req.uploadType is set before multer runs so the file is written under its
// final name straight away. It used to be saved as `user_<ts>` and renamed
// afterwards, which cannot work on a read-only production filesystem.
router.post(
    '/pediatric-id',
    authMiddleware,
    (req, _res, next) => { req.uploadType = `pediatric_id_${req.user.userId}`; next(); },
    upload.single('photo'),
    finalizeProfile,
    async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        try {
            const user = await User.findById(req.user.userId);
            if (!user || user.role !== 'pediatrician') {
                return res.status(403).json({ error: 'Only pediatricians can upload ID documents.' });
            }

            // Delete old ID if exists
            if (user.idDocumentPath) {
                deleteOldUpload(user.idDocumentPath);
            }

            // Normalize path to forward slashes for web compatibility
            const normalizedPath = `/${PROFILE_DIR}/${req.file.filename}`.replace(/\\/g, '/');

            user.idDocumentPath = normalizedPath;
            user.prcIdDocumentPath = normalizedPath;
            user.idDocumentUploadedAt = new Date();
            await user.save();

            res.json({ success: true, path: normalizedPath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
);

// Upload pediatrician's PRC ID image for license verification
// prcUpload writes straight into uploads/prc under the final traceable name,
// so there is no post-upload rename to perform.
router.post('/prc-id', authMiddleware, prcUpload.single('prcId'), finalizePrc, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'pediatrician') {
            // Clean up the uploaded file since validation failed
            fileStorage.deleteStored(PRC_DIR, req.file.filename, PRC_ACCESS);
            return res.status(403).json({ success: false, message: 'Only pediatricians can upload PRC documents.' });
        }

        // Normalize path to forward slashes for web compatibility (critical on Windows)
        const filePath = `${PRC_DIR}/${req.file.filename}`.replace(/\\/g, '/');

        // Remove old PRC document file if replacing
        if (user.prcIdDocumentPath) {
            deleteOldUpload(user.prcIdDocumentPath);
        }

        // Update user record
        user.prcIdDocumentPath = filePath;
        await user.save();

        res.json({
            success: true,
            message: 'PRC ID uploaded successfully',
            path: filePath,
            url: `/${filePath}`,
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, message: 'Server error during upload' });
    }
});

module.exports = router;
