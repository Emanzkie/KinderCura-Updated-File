// routes/auth.js
// Handles OTP, registration, login, profile updates, and pediatrician settings.
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const Assessment = require('../models/Assessment');
const OtpCode = require('../models/OtpCode');
const Notification = require('../models/Notification');
const { authMiddleware } = require('../middleware/auth');
const sse = require('../sse');

const router = express.Router();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const prcUploadDir = path.join(__dirname, '..', 'uploads', 'prc-documents');

const prcStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(prcUploadDir)) {
      fs.mkdirSync(prcUploadDir, { recursive: true });
    }
    cb(null, prcUploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `prc_${uniqueSuffix}${ext}`);
  },
});

const prcUpload = multer({
  storage: prcStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    if (file.mimetype.startsWith('image/') && allowedExts.has(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only JPG, PNG, and WebP image files are allowed for PRC ID uploads.'));
  },
});

function handlePrcUpload(req, res, next) {
  prcUpload.single('prcIdCard')(req, res, (err) => {
    if (err) {
      const message = err instanceof multer.MulterError ? err.message : (err.message || 'PRC ID upload failed.');
      console.error('[PRC Upload][multer] Upload failed:', {
        message,
        field: err.field || 'prcIdCard',
        contentType: req.headers['content-type'],
      });
      return res.status(400).json({ error: message });
    }

    if (req.file) {
      console.log('[PRC Upload][multer] Received PRC ID file:', {
        field: req.file.fieldname,
        originalName: req.file.originalname,
        savedName: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
        tempPath: req.file.path,
      });
    } else if (String(req.body?.role || '').toLowerCase() === 'pediatrician') {
      console.warn('[PRC Upload][multer] Pediatrician registration reached upload middleware without a PRC file:', {
        contentType: req.headers['content-type'],
        bodyKeys: Object.keys(req.body || {}).filter((key) => !/password/i.test(key)),
      });
    }

    next();
  });
}

function deleteUploadedPrcFile(file) {
  if (!file?.path) return;
  try {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  } catch (err) {
    console.warn('[register] Failed to remove uploaded PRC file:', err.message);
  }
}

function movePrcUploadToUserFile(file, userId) {
  if (!file) return null;

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  const safeExt = ext || path.extname(file.filename || '').toLowerCase() || '.jpg';
  const finalName = `prc_${userId}_${Date.now()}${safeExt}`;
  const finalPath = path.join(prcUploadDir, finalName);

  if (path.resolve(file.path) !== path.resolve(finalPath)) {
    fs.renameSync(file.path, finalPath);
    file.path = finalPath;
    file.filename = finalName;
  }

  return `/uploads/prc-documents/${finalName}`;
}

/**
 * Profile photo uploads (parents / children)
 */
const profileUploadDir = path.join(__dirname, '..', 'uploads', 'profiles');

const profileStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(profileUploadDir)) {
      fs.mkdirSync(profileUploadDir, { recursive: true });
    }
    cb(null, profileUploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `upload_${uniqueSuffix}${ext}`);
  },
});

const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    if (file.mimetype.startsWith('image/') && allowedExts.has(ext)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only JPG, PNG, and WebP image files are allowed for profile uploads.'));
  },
});

function handleProfileUpload(req, res, next) {
  profileUpload.fields([
    { name: 'parentProfilePhoto', maxCount: 1 },
    { name: 'childProfilePhoto', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      const message = err instanceof multer.MulterError ? err.message : (err.message || 'Profile upload failed.');
      console.error('[Profile Upload][multer] Upload failed:', { message, contentType: req.headers['content-type'] });
      return res.status(400).json({ error: message });
    }

    if (req.files) {
      // Log received profile uploads for debugging
      const pf = (req.files.parentProfilePhoto || [])[0];
      const cf = (req.files.childProfilePhoto || [])[0];
      if (pf) console.log('[Profile Upload][multer] Received parentProfilePhoto:', { field: pf.fieldname, originalName: pf.originalname, savedName: pf.filename, mimetype: pf.mimetype, size: pf.size, tempPath: pf.path });
      if (cf) console.log('[Profile Upload][multer] Received childProfilePhoto:', { field: cf.fieldname, originalName: cf.originalname, savedName: cf.filename, mimetype: cf.mimetype, size: cf.size, tempPath: cf.path });
    }

    next();
  });
}

function deleteUploadedProfileFiles(files) {
  if (!files) return;
  const all = [];
  if (files.parentProfilePhoto) all.push(...files.parentProfilePhoto);
  if (files.childProfilePhoto) all.push(...files.childProfilePhoto);
  for (const f of all) {
    try {
      if (f && f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    } catch (err) {
      console.warn('[register] Failed to remove uploaded profile file:', err && err.message ? err.message : err);
    }
  }
}

function moveProfileUploadToUserFile(file, id, type = 'user') {
  if (!file) return null;
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.jpg';
  const prefix = type === 'child' ? 'child' : (type === 'parent' ? 'parent' : 'user');
  const finalName = `${prefix}_${String(id)}_${Date.now()}${ext}`;
  const finalPath = path.join(profileUploadDir, finalName);

  try {
    if (path.resolve(file.path) !== path.resolve(finalPath)) {
      fs.renameSync(file.path, finalPath);
      file.path = finalPath;
      file.filename = finalName;
    }
  } catch (err) {
    console.warn('[Profile Upload] Failed to move uploaded profile file:', err && err.message ? err.message : err);
    return null;
  }

  return `/uploads/profiles/${finalName}`;
}

function uploadPathExists(publicPath) {
  if (!publicPath || !String(publicPath).startsWith('/uploads/')) return false;
  const fullPath = path.join(__dirname, '..', String(publicPath).replace(/^\//, ''));
  return fs.existsSync(fullPath);
}

function emailConfigured() {
  return Boolean(
    process.env.EMAIL_USER &&
    process.env.EMAIL_PASS &&
    process.env.EMAIL_USER !== 'your_email@gmail.com' &&
    process.env.EMAIL_PASS !== 'your_gmail_app_password'
  );
}

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

// signToken — creates a JWT for the logged-in user.
// Important: for secretary accounts, linkedPediatricianId MUST be included
// in the payload so that appointment routes can scope queries to the correct
// pediatrician without an extra database lookup on every request.
function signToken(user) {
  const payload = {
    userId: String(user._id),
    role: user.role,
    email: user.email,
  };

  // Only attach linkedPediatricianId for secretary accounts.
  // For all other roles this field remains absent from the token.
  if (user.role === 'secretary' && user.linkedPediatricianId) {
    payload.linkedPediatricianId = String(user.linkedPediatricianId);
  }

  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '48h' });
}

// normalizeDays — validates and cleans the pediatrician's available day list.
// Only standard weekday names are accepted; anything else is stripped out.
function normalizeDays(days) {
  const valid = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  if (!Array.isArray(days)) return [];
  return days
    .map((d) => String(d || '').trim())
    .filter((d) => valid.includes(d));
}

// normalizeBreaks — validates the pediatrician's break time entries.
// Each break must have both a startTime and endTime; malformed entries are removed.
function normalizeBreaks(breaks) {
  if (!Array.isArray(breaks)) return [];
  return breaks
    .map((entry) => {
      const startTime = String(entry?.startTime || '').trim();
      const endTime = String(entry?.endTime || '').trim();
      if (!startTime || !endTime) return null;
      return {
        label: entry?.label ? String(entry.label).trim() : null,
        startTime,
        endTime,
      };
    })
    .filter(Boolean);
}

async function notifyAdmin(title, message, relatedPage = '/admin/admin-users.html', relatedId = null) {
  try {
    const admin = await User.findOne({ role: 'admin' });
    if (!admin) {
      console.warn('[notifyAdmin] No admin user found for notification');
      return;
    }
    console.log('[notifyAdmin] Creating notification for admin:', admin._id, 'title:', title);
    const notification = await Notification.create({
      userId: admin._id,
      title,
      message,
      type: 'admin',
      relatedPage,
      relatedId: relatedId ? String(relatedId) : null,
      isRead: false,
    });
    console.log('[notifyAdmin] Notification created with id:', notification.id);
  } catch (err) {
    console.warn('[notifyAdmin] Failed to create admin notification:', err.message);
  }
}

function publicUser(user) {
  return {
    id: String(user._id),
    firstName: user.firstName,
    middleName: user.middleName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    profileIcon: user.profileIcon || 'avatar1',
    licenseNumber: user.licenseNumber || null,
    institution: user.institution || null,
    specialization: user.specialization || null,
    clinicName: user.clinicName || null,
    clinicAddress: user.clinicAddress || null,
    phoneNumber: user.phoneNumber || null,
    consultationFee: user.consultationFee ?? null,
    bio: user.bio || null,
    organization: user.organization || null,
    department: user.department || null,
    // Important: linkedPediatricianId powers the secretary's "on behalf of Dr. X" UI.
    // It is null for all non-secretary roles.
    linkedPediatricianId: user.linkedPediatricianId
      ? String(user.linkedPediatricianId)
      : null,
    availability: {
      days: normalizeDays(user.availability?.days || []),
      startTime: user.availability?.startTime || '09:00',
      endTime: user.availability?.endTime || '17:00',
      maxPatientsPerDay: user.availability?.maxPatientsPerDay ?? 10,
      breaks: normalizeBreaks(user.availability?.breaks || []),
    },
    notificationSettings: {
      emailAppointments: Boolean(user.notificationSettings?.emailAppointments ?? true),
      inApp: Boolean(user.notificationSettings?.inApp ?? true),
      sms: Boolean(user.notificationSettings?.sms ?? false),
      assessmentCompleted: Boolean(user.notificationSettings?.assessmentCompleted ?? true),
      dailySummary: Boolean(user.notificationSettings?.dailySummary ?? false),
    },
    privacySettings: {
      showProfile: Boolean(user.privacySettings?.showProfile ?? true),
      showAvailability: Boolean(user.privacySettings?.showAvailability ?? true),
      shareRecommendations: Boolean(user.privacySettings?.shareRecommendations ?? true),
    },
  };
}

function parseNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


async function getParentPreAssessmentState(parentId) {
  const childIds = new Set();

  // Own children (parentId match)
  const own = await Child.find({ parentId }).sort({ createdAt: -1 }).select('_id').lean();
  own.forEach(c => childIds.add(String(c._id)));

  // Linked children via GuardianLink
  const links = await GuardianLink.find({ guardianId: parentId, status: 'active' }).lean();
  if (links.length) {
    links.forEach(l => childIds.add(String(l.childId)));
  }

  if (!childIds.size) {
    return { defaultChildId: null, needsPreAssessment: false, preAssessmentChildId: null };
  }

  const children = await Child.find({ _id: { $in: [...childIds] } }).sort({ createdAt: -1 }).select('_id').lean();
  const defaultChildId = children.length ? String(children[0]._id) : null;

  // Important:
  // Treat the first completed screening as the end of the required pre-assessment flow.
  // If the parent has not completed any screening yet, send them to screening on first login.
  const completedExists = await Assessment.exists({
    childId: { $in: children.map((c) => c._id) },
    status: 'complete',
  });

  return {
    defaultChildId,
    needsPreAssessment: !completedExists,
    preAssessmentChildId: defaultChildId,
  };
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const existingUser = await User.findOne({ email }).select('_id').lean();
    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use.' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await OtpCode.deleteMany({ email, used: false });
    await OtpCode.create({ email, code: otp, expiresAt, used: false });

    if (emailConfigured()) {
      await transporter.sendMail({
        from: `"KinderCura" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'KinderCura — Email Verification Code',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
            <div style="background:#6B8E6F;padding:20px;text-align:center;border-radius:10px 10px 0 0;">
              <h1 style="color:white;margin:0;">KinderCura</h1>
            </div>
            <div style="background:#f9f9f9;padding:30px;border-radius:0 0 10px 10px;">
              <h2 style="color:#333;">Email Verification</h2>
              <p style="color:#666;">Use the 4-digit code below to verify your email. It expires in <strong>10 minutes</strong>.</p>
              <div style="background:white;border:2px dashed #6B8E6F;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
                <span style="font-size:2.5rem;font-weight:bold;letter-spacing:10px;color:#6B8E6F;">${otp}</span>
              </div>
              <p style="color:#999;font-size:0.85rem;">If you did not request this, please ignore this email.</p>
            </div>
          </div>`,
      });
    } else {
      console.log(`\n⚠️ EMAIL NOT CONFIGURED — OTP for ${email}: ${otp}\n`);
    }

    res.json({
      success: true,
      message: emailConfigured() ? 'OTP sent to your email.' : `OTP generated (check server console): ${otp}`,
      devOtp: emailConfigured() ? undefined : otp,
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP. Please check email configuration.' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and OTP are required.' });
    }
    if (code.length !== 4) {
      return res.status(400).json({ error: 'OTP must be 4 digits.' });
    }

    const otpRow = await OtpCode.findOne({ email, code, used: false }).sort({ createdAt: -1 });
    if (!otpRow) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }
    if (new Date() > new Date(otpRow.expiresAt)) {
      return res.status(400).json({ error: 'OTP expired.' });
    }

    otpRow.used = true;
    await otpRow.save();

    res.json({ success: true, message: 'Email verified!' });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Server error while verifying OTP.' });
  }
});

// POST /api/auth/register
router.post('/register', handleProfileUpload, handlePrcUpload, async (req, res) => {
  const fail = (status, error) => {
    console.warn('[PRC Upload][register] Registration validation failed:', {
      status,
      error,
      role: req.body?.role,
      email: req.body?.email,
      uploadedFile: req.file ? {
        field: req.file.fieldname,
        savedName: req.file.filename,
        size: req.file.size,
      } : null,
    });
    // Remove any uploaded files (PRC + profile photos) on failure to avoid orphaned uploads
    deleteUploadedProfileFiles(req.files);
    deleteUploadedPrcFile(req.file);
    return res.status(status).json({ error });
  };

  try {
    const {
      role,
      firstName,
      middleName,
      lastName,
      username,
      email,
      password,
      profileIcon,
      licenseNumber,
      institution,
      specialization,
      clinicName,
      clinicAddress,
      phoneNumber,
      consultationFee,
      bio,
      organization,
      department,
      childFirstName,
      childLastName,
      childMiddleName,
      dateOfBirth,
      gender,
      relationship,
      childProfileIcon,
      prcLicenseNumber,
      licenseExpiry,
    } = req.body;

    if (!role || !firstName || !lastName || !username || !email || !password) {
      return fail(400, 'All required fields must be filled.');
    }

    const cleanRole = String(role).trim().toLowerCase();
    const cleanFirstName = String(firstName).trim();
    const cleanMiddleName = middleName ? String(middleName).trim() : null;
    const cleanLastName = String(lastName).trim();
    const cleanUsername = String(username).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPassword = String(password);

    console.log('[PRC Upload][register] Registration payload received:', {
      role: cleanRole,
      email: cleanEmail,
      hasPrcFile: Boolean(req.file),
      prcFile: req.file ? {
        field: req.file.fieldname,
        originalName: req.file.originalname,
        savedName: req.file.filename,
        mimetype: req.file.mimetype,
        size: req.file.size,
      } : null,
      hasPrcLicenseNumber: Boolean(prcLicenseNumber || licenseNumber),
      hasLicenseExpiry: Boolean(licenseExpiry),
    });

    // Important: secretary accounts can only be created by the admin — not self-registered.
    if (!['parent', 'legal_guardian', 'pediatrician', 'admin'].includes(cleanRole)) {
      return fail(400, 'Invalid user role. Secretary accounts must be created by the admin.');
    }
    if (!isValidEmail(cleanEmail)) {
      return fail(400, 'Please enter a valid email address.');
    }
    if (cleanPassword.length < 8) {
      return fail(400, 'Password must be at least 8 characters long.');
    }

    const existingUser = await User.findOne({
      $or: [{ email: cleanEmail }, { username: cleanUsername }],
    }).select('_id').lean();
    if (existingUser) {
      return fail(409, 'Email or username already in use.');
    }

    const verifiedOtp = await OtpCode.findOne({ email: cleanEmail, used: true }).sort({ createdAt: -1 }).lean();
    if (!verifiedOtp) {
      return fail(400, 'Please verify your email first.');
    }

    const passwordHash = await bcrypt.hash(cleanPassword, 10);

    // Important: pediatrician accounts are pending until admin approval.
    const initialStatus = cleanRole === 'pediatrician' ? 'pending' : 'active';

    // For pediatricians, validate that professional info is provided
    if (cleanRole === 'pediatrician') {
      if (!licenseNumber || !licenseNumber.trim()) {
        return fail(400, 'Professional license number is required for pediatricians.');
      }
      if (!req.file) {
        return fail(400, 'PRC ID Card upload is required for pediatrician verification.');
      }
      // Validate phone number (Philippine format)
      const cleanPhone = String(phoneNumber || '').replace(/[\s\-]/g, '');
      if (!cleanPhone) {
        return fail(400, 'Phone number is required for pediatricians.');
      }
      if (!/^(09|\+639)\d{9}$/.test(cleanPhone)) {
        return fail(400, 'Please enter a valid Philippine mobile number (e.g., 09123456789).');
      }
      // Validate license expiry is a future date
      if (!licenseExpiry) {
        return fail(400, 'PRC License Expiry Date is required.');
      }
      const parsedExpiry = new Date(licenseExpiry);
      if (isNaN(parsedExpiry.getTime()) || parsedExpiry <= new Date()) {
        return fail(400, 'License expiry must be a valid future date.');
      }
    } else if (req.file) {
      deleteUploadedPrcFile(req.file);
    }

    const userObjectId = new mongoose.Types.ObjectId();
    const prcDocumentPath = cleanRole === 'pediatrician' && req.file
      ? movePrcUploadToUserFile(req.file, userObjectId)
      : null;

    if (cleanRole === 'pediatrician') {
      console.log('[PRC Upload][database-save] Prepared PRC document path for user create:', {
        userId: String(userObjectId),
        prcDocumentPath,
        fileExistsBeforeSave: uploadPathExists(prcDocumentPath),
      });
    }

    const user = await User.create({
      _id: userObjectId,
      firstName: cleanFirstName,
      middleName: cleanMiddleName,
      lastName: cleanLastName,
      username: cleanUsername,
      email: cleanEmail,
      passwordHash,
      role: cleanRole,
      status: initialStatus,
      emailVerified: true,
      profileIcon: profileIcon || 'avatar1',
      licenseNumber: licenseNumber || null,
      institution: institution || null,
      specialization: specialization || null,
      clinicName: clinicName || institution || null,
      clinicAddress: clinicAddress || null,
      licenseExpiry: licenseExpiry ? new Date(licenseExpiry) : null,
      phoneNumber: phoneNumber || null,
      consultationFee: parseNumberOrNull(consultationFee),
      bio: bio || null,
      availability: {
        days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        startTime: '09:00',
        endTime: '17:00',
        maxPatientsPerDay: 10,
      },
      organization: organization || null,
      department: department || null,
      // ── PRC Verification: auto-populate at registration time ──
      prcLicenseNumber: cleanRole === 'pediatrician' ? (prcLicenseNumber || licenseNumber || null) : null,
      idDocumentPath: prcDocumentPath,
      idDocumentUploadedAt: prcDocumentPath ? new Date() : null,
      prcIdDocumentPath: prcDocumentPath,
      prcVerificationStatus: cleanRole === 'pediatrician' ? 'pending' : null,
      prcSubmittedAt: cleanRole === 'pediatrician' ? new Date() : null,
    });

    // If a parent profile photo was uploaded, move it to a final filename and update the user record
    try {
      const parentFile = req.files?.parentProfilePhoto?.[0];
      if (parentFile) {
        const parentProfilePath = moveProfileUploadToUserFile(parentFile, user._id, 'parent');
        if (parentProfilePath) {
          user.profileIcon = parentProfilePath;
          await user.save();
          console.log('[Profile Upload][database-save] Saved parent profileIcon:', { userId: String(user._id), profileIcon: user.profileIcon });
        }
      }
    } catch (err) {
      console.warn('[Profile Upload] Error while attaching parent profile photo to user:', err && err.message ? err.message : err);
    }

    if (cleanRole === 'pediatrician') {
      console.log('[PRC Upload][database-save] Saved pediatrician PRC fields:', {
        userId: String(user._id),
        prcLicenseNumber: user.prcLicenseNumber,
        idDocumentPath: user.idDocumentPath,
        prcIdDocumentPath: user.prcIdDocumentPath,
        idDocumentUploadedAt: user.idDocumentUploadedAt,
        prcSubmittedAt: user.prcSubmittedAt,
        fileExistsAfterSave: uploadPathExists(user.prcIdDocumentPath),
      });
    }

    sse.broadcast('analytics:update', { type: 'user', action: 'create', role: cleanRole });

    if (cleanRole === 'pediatrician') {
      console.log('[pediatrician registration] Calling notifyAdmin for:', cleanFirstName, cleanLastName);
      await notifyAdmin(
        'New PRC Verification Request',
        `Dr. ${cleanFirstName} ${cleanLastName || ''} has registered and requires PRC license verification. License: ${licenseNumber || 'N/A'}`,
        '/admin/prc-verification',
        String(user._id)
      );
    }

    let child = null;
    // Child information is optional for parent/guardian registration
    if ((cleanRole === 'parent' || cleanRole === 'legal_guardian') && childFirstName && childLastName && dateOfBirth) {
      child = await Child.create({
        parentId: user._id,
        firstName: String(childFirstName).trim(),
        middleName: childMiddleName ? String(childMiddleName).trim() : null,
        lastName: String(childLastName).trim(),
        dateOfBirth: new Date(dateOfBirth),
        gender: gender || null,
        relationship: relationship || null,
        profileIcon: childProfileIcon || 'child1',
      });

      // If a child profile photo was uploaded, move it and update the child record
      try {
        const childFile = req.files?.childProfilePhoto?.[0];
        if (childFile && child) {
          const childProfilePath = moveProfileUploadToUserFile(childFile, child._id, 'child');
          if (childProfilePath) {
            child.profileIcon = childProfilePath;
            await child.save();
            console.log('[Profile Upload][database-save] Saved child profileIcon:', { childId: String(child._id), profileIcon: child.profileIcon });
          }
        }
      } catch (err) {
        console.warn('[Profile Upload] Error while attaching child profile photo to child record:', err && err.message ? err.message : err);
      }
    }

    const token = signToken(user);

    // Parent sign-up should continue directly to the required pre-assessment only if child was created
    const needsPreAssessment = cleanRole === 'parent' && Boolean(child);
    const preAssessmentChildId = child ? String(child._id) : null;

    res.status(201).json({
      success: true,
      userId: String(user._id),
      childId: child ? String(child._id) : null,
      role: user.role,
      status: user.status,
      token,
      user: publicUser(user),
      needsPreAssessment,
      preAssessmentChildId,
      message: user.role === 'pediatrician'
        ? 'Pediatrician account created. Please wait for admin approval before logging in.'
        : (child ? 'Account created successfully. Please continue to the child pre-assessment.' : 'Account created successfully.'),
    });
  } catch (err) {
    deleteUploadedProfileFiles(req.files);
    deleteUploadedPrcFile(req.file);
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error while registering user.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!password || (!email && !username)) {
      return res.status(400).json({ error: 'Please provide email/username and password.' });
    }

    const cleanEmail = email ? String(email).trim().toLowerCase() : '';
    const cleanUsername = username ? String(username).trim() : '';
    const cleanPassword = String(password);

    const orConditions = [];
    if (cleanEmail) orConditions.push({ email: cleanEmail });
    if (cleanUsername) orConditions.push({ username: cleanUsername });
    const user = await User.findOne({ $or: orConditions });

    console.log(`[LOGIN] Attempt: email="${cleanEmail}" username="${cleanUsername}"`);

    if (!user) {
      console.log(`[LOGIN] User NOT FOUND: email="${cleanEmail}" username="${cleanUsername}"`);
      return res.status(401).json({ error: 'Invalid email/username or password.' });
    }

    console.log(`[LOGIN] User FOUND: _id=${user._id} role=${user.role} status=${user.status}`);

    if (user.status === 'pending') {
      console.log(`[LOGIN] Account PENDING: _id=${user._id}`);
      return res.status(403).json({ error: user.role === 'pediatrician' ? 'Your pediatrician account is still pending admin approval.' : 'Your account is not yet active. Please contact the clinic administrator.' });
    }
    if (user.status === 'suspended') {
      console.log(`[LOGIN] Account SUSPENDED: _id=${user._id}`);
      return res.status(403).json({ error: 'Your account has been suspended.' });
    }

    const match = await bcrypt.compare(cleanPassword, user.passwordHash);
    console.log(`[LOGIN] bcrypt.compare result: ${match}`);

    if (!match) {
      console.log(`[LOGIN] PASSWORD MISMATCH for user ${user._id}`);
      return res.status(401).json({ error: 'Invalid email/username or password.' });
    }

    let childId = null;
    let needsPreAssessment = false;
    let preAssessmentChildId = null;

    if (user.role === 'parent' || user.role === 'legal_guardian') {
      const preState = await getParentPreAssessmentState(user._id);
      childId = preState.defaultChildId;
      needsPreAssessment = preState.needsPreAssessment;
      preAssessmentChildId = preState.preAssessmentChildId;
    }

    const token = signToken(user);
    console.log(`[LOGIN] Token generated for user ${user._id}`);
    console.log(`[LOGIN] Login SUCCESS: user=${user._id} role=${user.role}`);
    res.json({
      success: true,
      token,
      role: user.role,
      userId: String(user._id),
      childId,
      needsPreAssessment,
      preAssessmentChildId,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('[LOGIN] Error:', err);
    res.status(500).json({ error: 'Server error while logging in.' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const userData = publicUser(user);
    console.log('[/api/auth/me] Returning user:', { id: userData.id, firstName: userData.firstName, role: userData.role, profileIcon: userData.profileIcon });
    res.json({ success: true, user: userData });
  } catch (err) {
    console.error('[/api/auth/me] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/update-profile
router.put('/update-profile', authMiddleware, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      middleName,
      licenseNumber,
      institution,
      specialization,
      organization,
      department,
      clinicName,
      clinicAddress,
      phoneNumber,
      consultationFee,
      bio,
    } = req.body;

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (firstName !== undefined) user.firstName = String(firstName).trim();
    if (lastName !== undefined) user.lastName = String(lastName).trim();
    if (middleName !== undefined) user.middleName = middleName ? String(middleName).trim() : null;
    if (licenseNumber !== undefined) user.licenseNumber = licenseNumber ? String(licenseNumber).trim() : null;
    if (institution !== undefined) user.institution = institution ? String(institution).trim() : null;
    if (specialization !== undefined) user.specialization = specialization ? String(specialization).trim() : null;
    if (organization !== undefined) user.organization = organization ? String(organization).trim() : null;
    if (department !== undefined) user.department = department ? String(department).trim() : null;
    if (clinicName !== undefined) user.clinicName = clinicName ? String(clinicName).trim() : null;
    if (clinicAddress !== undefined) user.clinicAddress = clinicAddress ? String(clinicAddress).trim() : null;
    if (phoneNumber !== undefined) user.phoneNumber = phoneNumber ? String(phoneNumber).trim() : null;
    if (consultationFee !== undefined) user.consultationFee = parseNumberOrNull(consultationFee);
    if (bio !== undefined) user.bio = bio ? String(bio).trim() : null;

    await user.save();
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    user.passwordHash = await bcrypt.hash(String(password), 10);
    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/pediatrician/settings
router.get('/pediatrician/settings', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/pediatrician/settings
router.put('/pediatrician/settings', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const {
      phoneNumber,
      consultationFee,
      bio,
      clinicName,
      clinicAddress,
      institution,
      specialization,
      email,
      availability,
      notificationSettings,
      privacySettings,
    } = req.body;

    if (email !== undefined) {
      const cleanEmail = String(email).trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      const emailUsed = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } }).select('_id').lean();
      if (emailUsed) {
        return res.status(409).json({ error: 'That email address is already in use.' });
      }
      user.email = cleanEmail;
    }

    if (phoneNumber !== undefined) user.phoneNumber = phoneNumber ? String(phoneNumber).trim() : null;
    if (consultationFee !== undefined) user.consultationFee = parseNumberOrNull(consultationFee);
    if (bio !== undefined) user.bio = bio ? String(bio).trim() : null;
    if (clinicName !== undefined) user.clinicName = clinicName ? String(clinicName).trim() : null;
    if (clinicAddress !== undefined) user.clinicAddress = clinicAddress ? String(clinicAddress).trim() : null;
    if (institution !== undefined) user.institution = institution ? String(institution).trim() : null;
    if (specialization !== undefined) user.specialization = specialization ? String(specialization).trim() : null;

    // Save availability in one place so appointments can enforce it later.
    if (availability && typeof availability === 'object') {
      const startTime = String(availability.startTime || '09:00');
      const endTime = String(availability.endTime || '17:00');
      const days = normalizeDays(availability.days || []);
      const maxPatientsPerDay = parseNumberOrNull(availability.maxPatientsPerDay) ?? 10;

      if (!days.length) {
        return res.status(400).json({ error: 'Please select at least one available day.' });
      }
      user.availability = {
        days,
        startTime,
        endTime,
        maxPatientsPerDay: Math.max(1, Math.min(50, maxPatientsPerDay)),
        // Preserve existing breaks when this settings form only updates days/hours.
        breaks: normalizeBreaks(
          availability.breaks !== undefined
            ? availability.breaks
            : (user.availability?.breaks || [])
        ),
      };
    }

    if (notificationSettings && typeof notificationSettings === 'object') {
      user.notificationSettings = {
        emailAppointments: Boolean(notificationSettings.emailAppointments),
        inApp: Boolean(notificationSettings.inApp),
        sms: Boolean(notificationSettings.sms),
        assessmentCompleted: Boolean(notificationSettings.assessmentCompleted),
        dailySummary: Boolean(notificationSettings.dailySummary),
      };
    }

    if (privacySettings && typeof privacySettings === 'object') {
      user.privacySettings = {
        showProfile: Boolean(privacySettings.showProfile),
        showAvailability: Boolean(privacySettings.showAvailability),
        shareRecommendations: Boolean(privacySettings.shareRecommendations),
      };
    }

    await user.save();
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/refresh
// Issues a fresh JWT if the existing token is still valid (with a 2-minute grace
// period for recently expired tokens).  This keeps the user's session alive
// without forcing a full re-login during normal usage.
router.post('/refresh', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'No token provided.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { clockTolerance: 120 });
    const user = await User.findById(decoded.userId).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active.' });
    }
    const newToken = signToken(user);
    res.json({ success: true, token: newToken, user: publicUser(user) });
  } catch (err) {
    return res.status(403).json({ error: 'Token invalid or expired. Please log in again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;
