// routes/videos.js
// Handles video uploads for appointment videos and chat videos using MongoDB.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const { authMiddleware } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianAccess');
const fileStorage = require('../services/fileStorage');

// Main MongoDB models already used by your system
const Appointment = require('../models/Appointment');
const Child = require('../models/Child');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Counter = require('../models/Counter');

/* -------------------- small helper model -------------------- */
/* Keeps uploaded appointment videos in MongoDB */
const appointmentVideoSchema = new mongoose.Schema(
    {
        id: { type: Number, unique: true, index: true },
        appointmentId: { type: Number, required: true, index: true }, // numeric appointment id used by frontend
        appointmentMongoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
        childId: { type: mongoose.Schema.Types.ObjectId, ref: 'Child', required: true },
        parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        pediatricianId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        filePath: { type: String, required: true },
        fileName: { type: String, required: true },
        fileSize: { type: Number, default: 0 },
        mimeType: { type: String, default: '' },
        description: { type: String, default: null },
        uploadedAt: { type: Date, default: Date.now }
    },
    {
        collection: 'appointment_videos',
        versionKey: false
    }
);

/* Auto-generate simple numeric id */
appointmentVideoSchema.pre('validate', async function (next) {
    if (!this.isNew || this.id != null) return next();

    try {
        const counter = await Counter.findOneAndUpdate(
            { _id: 'appointment_videos' },
            { $inc: { seq: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        this.id = counter.seq;
        next();
    } catch (err) {
        next(err);
    }
});

const AppointmentVideo =
    mongoose.models.AppointmentVideo ||
    mongoose.model('AppointmentVideo', appointmentVideoSchema);

/* -------------------- helpers -------------------- */
async function pushNotification(userId, title, message, type = 'appointment') {
    if (!userId) return;

    await Notification.create({
        userId,
        title,
        message,
        type,
        isRead: false
    });
}

/* Creates upload folder if missing */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/* Project-relative folder for a video subdir, e.g. 'public/uploads/videos/chat'.
   fileStorage maps it to disk locally and to Vercel Blob in production. */
function videoDir(subdir) {
    return `public/uploads/${String(subdir).replace(/\\/g, '/')}`;
}

/* Filename maker — unchanged naming, extracted so blob uploads reuse it */
function makeFilename(label) {
    return (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        // Very important:
        // Use a safe label for the filename so slashes do not break the path.
        const safeLabel = String(label).replace(/[\\/]+/g, '_');

        // Use logged-in user id in file name
        const userPart = String(req.user?.userId || 'user');

        cb(null, `${safeLabel}_${userPart}_${Date.now()}${ext}`);
    };
}

/* Storage maker for multer */
function makeStorage(subdir, label) {
    return fileStorage.makeStorage(videoDir(subdir), makeFilename(label));
}

const VIDEO_TYPES = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const MAX_VIDEO = 150 * 1024 * 1024; // 150 MB

function videoFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!VIDEO_TYPES.includes(ext)) {
        return cb(new Error('Only video files are allowed (mp4, webm, mov, avi, mkv).'));
    }

    cb(null, true);
}

/* Separate upload handlers */
const APPT_VIDEO_SUBDIR = 'videos/appointments';
const CHAT_VIDEO_SUBDIR = 'videos/chat';
const VIDEO_ACCESS = { access: 'public' };

const uploadAppt = multer({
    storage: makeStorage(APPT_VIDEO_SUBDIR, 'appointment_video'),
    fileFilter: videoFilter,
    limits: { fileSize: MAX_VIDEO }
});
const finalizeAppt = fileStorage.finalizeUploads(
    videoDir(APPT_VIDEO_SUBDIR), makeFilename('appointment_video'), VIDEO_ACCESS
);

const uploadChat = multer({
    storage: makeStorage(CHAT_VIDEO_SUBDIR, 'chat_video'),
    fileFilter: videoFilter,
    limits: { fileSize: MAX_VIDEO }
});
const finalizeChat = fileStorage.finalizeUploads(
    videoDir(CHAT_VIDEO_SUBDIR), makeFilename('chat_video'), VIDEO_ACCESS
);

/* Converts /uploads/... into actual disk path inside public folder */
function toDiskPath(publicPath) {
    const cleanPath = String(publicPath || '').replace(/^\/+/, ''); // remove first slash
    return path.join(__dirname, '..', 'public', cleanPath);
}

/* -------------------- POST /api/videos/appointment/:appointmentId -------------------- */
/* Parent uploads appointment video */
router.post('/appointment/:appointmentId', authMiddleware, (req, res) => {
    if (req.user.role !== 'parent') {
        return res.status(403).json({ error: 'Parents only.' });
    }

    uploadAppt.single('video')(req, res, (multerErr) => finalizeAppt(req, res, async (storeErr) => {
        const err = multerErr || storeErr;
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No video file provided.' });
        }

        try {
            const appointmentId = Number(req.params.appointmentId);

            const appointment = await Appointment.findOne({ id: appointmentId }).lean();
            if (!appointment) {
                return res.status(404).json({ error: 'Appointment not found.' });
            }

            const isAdmin = req.user.role === 'admin';
            const isPediaOwner = req.user.role === 'pediatrician' &&
                String(appointment.pediatricianId) === String(req.user.userId);

            const allowed = isAdmin || isPediaOwner ||
                await hasPermission(req.user.userId, appointment.childId, 'manageAppointments');

            if (!allowed) {
                return res.status(403).json({ error: 'Access denied.' });
            }

            const [child, parent, pediatrician] = await Promise.all([
                Child.findById(appointment.childId).lean(),
                User.findById(appointment.parentId).lean(),
                appointment.pediatricianId ? User.findById(appointment.pediatricianId).lean() : null
            ]);

            const videoPath = `/uploads/videos/appointments/${req.file.filename}`;

            await AppointmentVideo.create({
                appointmentId: appointment.id,
                appointmentMongoId: appointment._id,
                childId: appointment.childId,
                parentId: appointment.parentId,
                pediatricianId: appointment.pediatricianId || null,
                filePath: videoPath,
                fileName: req.file.originalname,
                fileSize: req.file.size,
                mimeType: req.file.mimetype,
                description: req.body.description || null
            });

            // Mark appointment as having video
            if (!appointment.hasVideo) {
                appointment.hasVideo = true;
                await appointment.save();
            }

            // Notify pediatrician if there is one assigned
            if (appointment.pediatricianId && child && parent && pediatrician) {
                const parentName = `${parent.firstName} ${parent.lastName}`.trim();
                const childName = `${child.firstName} ${child.lastName}`.trim();

                await pushNotification(
                    appointment.pediatricianId,
                    '📹 Video Attached to Appointment',
                    `${parentName} uploaded a video for ${childName}'s appointment.`,
                    'appointment'
                );
            }

            return res.json({
                success: true,
                path: videoPath,
                fileName: req.file.originalname,
                fileSize: req.file.size
            });
        } catch (error) {
            console.error('Appointment video upload error:', error);
            return res.status(500).json({ error: error.message });
        }
    }));
});

/* -------------------- GET /api/videos/appointment/:appointmentId -------------------- */
/* Parent, pediatrician, or admin can view uploaded appointment videos if allowed */
router.get('/appointment/:appointmentId', authMiddleware, async (req, res) => {
    try {
        const appointmentId = Number(req.params.appointmentId);

        const appointment = await Appointment.findOne({ id: appointmentId }).lean();
        if (!appointment) {
            return res.status(404).json({ error: 'Appointment not found.' });
        }

        const isParentOwner =
            req.user.role === 'parent' &&
            String(appointment.parentId) === String(req.user.userId);

        const isPediaOwner =
            req.user.role === 'pediatrician' &&
            String(appointment.pediatricianId) === String(req.user.userId);

        const isAdmin = req.user.role === 'admin';

        const isLinkedGuardian = !isParentOwner && !isPediaOwner &&
            !isAdmin &&
            Boolean(await hasPermission(req.user.userId, appointment.childId, 'manageAppointments'));

        if (!isParentOwner && !isPediaOwner && !isAdmin && !isLinkedGuardian) {
            return res.status(403).json({ error: 'Access denied.' });
        }

        const videos = await AppointmentVideo.find({ appointmentId })
            .sort({ uploadedAt: -1 })
            .lean();

        return res.json({
            success: true,
            videos: videos.map(v => ({
                id: v.id,
                mongoId: String(v._id),
                appointmentId: v.appointmentId,
                filePath: v.filePath,
                fileName: v.fileName,
                fileSize: v.fileSize,
                mimeType: v.mimeType,
                description: v.description,
                uploadedAt: v.uploadedAt
            }))
        });
    } catch (error) {
        console.error('Get appointment videos error:', error);
        return res.status(500).json({ error: error.message });
    }
});

/* -------------------- POST /api/videos/chat -------------------- */
/* Upload chat video first, then chat route sends the message using returned path */
router.post('/chat', authMiddleware, (req, res) => {
    uploadChat.single('video')(req, res, (multerErr) => finalizeChat(req, res, async (storeErr) => {
        const err = multerErr || storeErr;
        if (err) {
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No video file provided.' });
        }

        try {
            const videoPath = `/uploads/videos/chat/${req.file.filename}`;

            return res.json({
                success: true,
                path: videoPath,
                fileName: req.file.originalname,
                fileSize: req.file.size,
                mimeType: req.file.mimetype
            });
        } catch (error) {
            console.error('Chat video upload error:', error);
            return res.status(500).json({ error: error.message });
        }
    }));
});

/* -------------------- DELETE /api/videos/:videoId -------------------- */
/* Delete uploaded appointment video */
router.delete('/:videoId', authMiddleware, async (req, res) => {
    try {
        const videoId = req.params.videoId;

        // Supports either numeric id or Mongo _id
        let videoDoc = null;

        if (/^\d+$/.test(videoId)) {
            videoDoc = await AppointmentVideo.findOne({ id: Number(videoId) });
        } else if (mongoose.Types.ObjectId.isValid(videoId)) {
            videoDoc = await AppointmentVideo.findById(videoId);
        }

        if (!videoDoc) {
            return res.status(404).json({ error: 'Video not found.' });
        }

        const isParentOwner = String(videoDoc.parentId) === String(req.user.userId);
        const isAdmin = req.user.role === 'admin';

        if (!isParentOwner && !isAdmin) {
          // Linked guardians need manageAppointments + and the appointment's childId
          const allowed = Boolean(await hasPermission(req.user.userId, videoDoc.childId, 'manageAppointments'));
          if (!allowed) {
            return res.status(403).json({ error: 'Access denied.' });
          }
        }

        // filePath is stored as '/uploads/videos/<kind>/<name>', which lives
        // under public/ — the same layout fileStorage uses as its blob prefix.
        const stored = String(videoDoc.filePath || '').replace(/^\/+/, '');
        if (stored) {
            fileStorage.deleteStored(
                `public/${path.posix.dirname(stored)}`,
                path.posix.basename(stored),
                VIDEO_ACCESS
            );
        }

        await AppointmentVideo.deleteOne({ _id: videoDoc._id });

        // If no more videos remain, remove appointment hasVideo flag
        const stillHasVideos = await AppointmentVideo.exists({
            appointmentId: videoDoc.appointmentId
        });

        if (!stillHasVideos) {
            await Appointment.updateOne(
                { id: videoDoc.appointmentId },
                { $set: { hasVideo: false } }
            );
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Delete video error:', error);
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;