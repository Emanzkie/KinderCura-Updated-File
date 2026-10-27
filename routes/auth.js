// routes/auth.js
// Handles OTP, registration, login, profile updates, and pediatrician settings.
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Child = require('../models/Child');
const GuardianLink = require('../models/GuardianLink');
const Assessment = require('../models/Assessment');
const OtpCode = require('../models/OtpCode');
const Notification = require('../models/Notification');
const { authMiddleware, adminOnly, signPrcResubmitToken } = require('../middleware/auth');
const sse = require('../sse');
const fileStorage = require('../services/fileStorage');
const { parseSignupConsent } = require('../constants/legalConsent');
const childAge = require('../js/shared/child-age');
const httpEmail = require('../services/httpEmail');
const { httpEmailConfigured } = httpEmail;

const router = express.Router();

// Gmail credentials are read from the environment only — never hardcoded.
//
// EMAIL_PASS is a Google App Password. Google displays it as four groups of four
// ("abcd efgh ijkl mnop") and the spaces are presentation only; pasted verbatim
// into a hosting dashboard they make Gmail reject the login with 535, which
// looked exactly like "no OTP email arrives". Whitespace is stripped here.
const EMAIL_USER = String(process.env.EMAIL_USER || '').trim();
const EMAIL_PASS = String(process.env.EMAIL_PASS || '').replace(/\s+/g, '');

// smtp.gmail.com:465 is stated explicitly instead of `service: 'gmail'`, and the
// three timeouts below bound every stage of the SMTP conversation. Implicit TLS
// on 465 avoids the STARTTLS upgrade round trip that 587 needs, and a blocked
// or silent SMTP socket now fails fast with a real error instead of hanging
// until the platform kills the whole request.
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
  connectionTimeout: 7000,
  greetingTimeout: 7000,
  socketTimeout: 10000,
});

// Project-relative upload folders. fileStorage maps them to disk locally and
// to Vercel Blob in production — see services/fileStorage.js.
const PRC_DIR = 'uploads/prc-documents';
const PROFILE_DIR = 'uploads/profiles';

// PRC ID cards are identity documents, so they are stored privately and can
// only be read back through an authenticated route. Profile photos are shown
// in <img> tags and stay public.
const PRC_ACCESS = { access: 'private' };
const PROFILE_ACCESS = { access: 'public' };

const prcTempFilename = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  cb(null, `prc_${uniqueSuffix}${ext}`);
};

const prcStorage = fileStorage.makeStorage(PRC_DIR, prcTempFilename);

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

// The final name needs the user's id, which only exists once the account row
// is being created, so the upload is committed here rather than in multer.
async function movePrcUploadToUserFile(file, userId) {
  if (!file) return null;

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  const safeExt = ext || path.extname(file.filename || '').toLowerCase() || '.jpg';
  const finalName = `prc_${userId}_${Date.now()}${safeExt}`;

  const stored = await fileStorage.storeFile(PRC_DIR, finalName, file, PRC_ACCESS);
  return `/${stored}`;
}

/**
 * Profile photo uploads (parents / children)
 */
const profileTempFilename = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  cb(null, `upload_${uniqueSuffix}${ext}`);
};

const profileStorage = fileStorage.makeStorage(PROFILE_DIR, profileTempFilename);

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
    cb(new Error('Only JPG, PNG, and WebP image files are allowed for uploads.'));
  },
});

function handleProfileUpload(req, res, next) {
  profileUpload.fields([
    { name: 'parentProfilePhoto', maxCount: 1 },
    { name: 'childProfilePhoto', maxCount: 1 },
    { name: 'prcIdCard', maxCount: 1 },
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
      const prc = (req.files.prcIdCard || [])[0];
      
      if (pf) console.log('[Profile Upload][multer] Received parentProfilePhoto:', { field: pf.fieldname, originalName: pf.originalname, savedName: pf.filename, mimetype: pf.mimetype, size: pf.size, tempPath: pf.path });
      if (cf) console.log('[Profile Upload][multer] Received childProfilePhoto:', { field: cf.fieldname, originalName: cf.originalname, savedName: cf.filename, mimetype: cf.mimetype, size: cf.size, tempPath: cf.path });
      
      if (prc) {
        console.log('[Profile Upload][multer] Received prcIdCard:', { field: prc.fieldname, originalName: prc.originalname, savedName: prc.filename, mimetype: prc.mimetype, size: prc.size, tempPath: prc.path });
        req.file = prc;
      }
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

// Like movePrcUploadToUserFile: the final name needs the parent's or child's
// id, so the bytes are committed here instead of inside multer.
async function moveProfileUploadToUserFile(file, id, type = 'user') {
  if (!file) return null;
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.jpg';
  const prefix = type === 'child' ? 'child' : (type === 'parent' ? 'parent' : 'user');
  const finalName = `${prefix}_${String(id)}_${Date.now()}${ext}`;

  try {
    const stored = await fileStorage.storeFile(PROFILE_DIR, finalName, file, PROFILE_ACCESS);
    return `/${stored}`;
  } catch (err) {
    console.warn('[Profile Upload] Failed to move uploaded profile file:', err && err.message ? err.message : err);
    return null;
  }
}

// Logging aid only — never gates the response.
async function uploadPathExists(publicPath) {
  if (!publicPath || !String(publicPath).startsWith('/uploads/')) return false;
  const clean = String(publicPath).replace(/^\//, '');
  const dir = path.posix.dirname(clean);
  const name = path.posix.basename(clean);
  const access = dir.includes('prc') ? PRC_ACCESS : PROFILE_ACCESS;
  return fileStorage.existsStored(dir, name, access);
}

function smtpConfigured() {
  return Boolean(
    EMAIL_USER &&
    EMAIL_PASS &&
    EMAIL_USER !== 'your_email@gmail.com' &&
    EMAIL_PASS !== 'your_gmail_app_password'
  );
}

// Mail can leave by either route. EMAIL_API_KEY selects the provider's HTTPS
// API; with no key set, the original Gmail SMTP path is used exactly as before.
// Hosts that block outbound SMTP (Render does — see services/httpEmail.js) need
// the key; local development works unchanged without one.
function emailConfigured() {
  return httpEmailConfigured() || smtpConfigured();
}

function activeTransport() {
  return httpEmailConfigured() ? 'https-api' : 'smtp';
}

// A Gmail handshake that outlives the request budget turns a diagnosable mail
// error into an opaque timeout, so the send is raced against a deadline measured
// from when the request arrived. DB connect and the existing-user lookup are
// already spent by then, which is why the caller passes the time it has left
// rather than a fixed duration.
//
// On Vercel the budget is tight: server.js answers 504 at 9.5 s to stay inside
// the function limit, so the send must resolve before that. A long-lived host
// (Render, a plain Node process) has no such cap and gets the longer budget;
// there the transporter's own connection/greeting timeouts above are what stop
// a blocked SMTP port from hanging, and they fail in about 7 s.
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.NOW_REGION);
const MAIL_DEADLINE_MS = IS_SERVERLESS ? 8500 : 20000;

// Milliseconds still available for the send, given how long the request has
// already been running. Never below 2.5 s, so a slow start still gets a real try.
function mailBudgetFrom(startedAt) {
  return Math.max(2500, MAIL_DEADLINE_MS - (Date.now() - startedAt));
}

// Sorts a mail failure into one stable label, so the failing layer is named
// rather than inferred. Nothing here is secret: these are SMTP protocol codes
// and socket errnos, never credentials, addresses or the OTP.
//
//   EMAIL_AUTH_FAILED       Gmail answered and rejected the login (535 / EAUTH).
//                           Credentials reached Gmail, so the network is fine.
//   EMAIL_CONNECTION_FAILED The TCP/TLS connection to smtp.gmail.com never
//                           completed — refused, timed out, DNS, or TLS. This is
//                           the signature of a host that blocks outbound SMTP.
//   EMAIL_TIMEOUT           Our own deadline fired first.
//   EMAIL_SEND_FAILED       Connected and authenticated, but the message itself
//                           was refused (bad envelope, bad From, quota).
function classifyMailError(err) {
  const code = String(err?.code || '');
  const errno = String(err?.errno || '');
  const command = String(err?.command || '');
  const message = String(err?.message || '');
  const responseCode = Number(err?.responseCode) || null;
  const blob = `${code} ${errno} ${message}`;

  const smtp = { code: code || null, command: command || null, responseCode };

  if (/MAIL_TIMEOUT/.test(message)) {
    return { label: 'EMAIL_TIMEOUT', status: 502, smtp,
      clientMessage: 'The verification email is taking too long to send. Please try again.' };
  }
  if (responseCode === 535 || code === 'EAUTH') {
    return { label: 'EMAIL_AUTH_FAILED', status: 503, smtp,
      clientMessage: 'Email service is not configured. Please contact support.' };
  }
  if (/ECONNECTION|ESOCKET|EDNS|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|EPIPE|ERR_TLS|CERT_/.test(blob)) {
    return { label: 'EMAIL_CONNECTION_FAILED', status: 502, smtp,
      clientMessage: 'The verification email could not be sent right now. Please try again.' };
  }
  return { label: 'EMAIL_SEND_FAILED', status: 502, smtp,
    clientMessage: 'Failed to send the verification email. Please try again.' };
}

function sendMailWithin(message, budgetMs) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`MAIL_TIMEOUT after ${budgetMs}ms`)), budgetMs);
  });
  return Promise.race([transporter.sendMail(message), deadline]).finally(() => clearTimeout(timer));
}

// One entry point for both transports, so /send-otp does not care which is in
// use. The HTTPS API bounds itself with AbortController; SMTP is raced against
// the same budget. Either way the caller only proceeds on a real success.
function deliverOtpEmail({ to, subject, html }, budgetMs) {
  if (httpEmailConfigured()) {
    return httpEmail.sendViaHttp({ to, subject, html, fromName: 'KinderCura' }, budgetMs);
  }
  return sendMailWithin({ from: `"KinderCura" <${EMAIL_USER}>`, to, subject, html }, budgetMs);
}

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Accepted values for the parent sign-up selects: the options on signup.html
// (relationship) and the Child model's gender enum.
const SIGNUP_CHILD_GENDERS = ['male', 'female', 'other'];
const SIGNUP_RELATIONSHIPS = ['mother', 'father', 'guardian', 'grandparent', 'other'];

// Roles POST /register may create (see the check inside that route).
const SELF_REGISTER_ROLES = ['parent', 'pediatrician'];

// Wrong guesses allowed against one signup email code before it is voided.
const SIGNUP_OTP_MAX_ATTEMPTS = 5;

// How long a verified signup code may be used by /register.
const SIGNUP_VERIFICATION_WINDOW_MS = 30 * 60 * 1000;

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

// validateAvailabilitySettings — checks the schedule a pediatrician saves in
// Settings > Availability, so bookings never have to cope with a nonsense one.
// Returns { error } or { startTime, endTime, maxPatientsPerDay, breaks }.
//   - times are HH:mm on a 24-hour clock ("25:99" used to be stored as-is, and
//     then every booking failed with "schedule incomplete")
//   - the end is after the start (an earlier end was read as an overnight shift)
//   - capacity is a whole number from 1 to 50 (it used to be silently clamped,
//     fractions included); blank keeps the default of 10
//   - breaks sent with the request have valid times, start before end, and do
//     not overlap each other; breaks already stored are kept as they are
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmmToMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function validateAvailabilitySettings(availability, storedBreaks) {
  const startTime = String(availability.startTime || '09:00').trim();
  const endTime = String(availability.endTime || '17:00').trim();
  if (!HHMM_RE.test(startTime) || !HHMM_RE.test(endTime)) {
    return { error: 'Start and end time must be valid times, like 09:00.' };
  }
  if (hhmmToMinutes(endTime) <= hhmmToMinutes(startTime)) {
    return { error: 'End time must be later than start time.' };
  }

  const rawCapacity = availability.maxPatientsPerDay;
  let maxPatientsPerDay = 10;
  if (rawCapacity !== undefined && rawCapacity !== null && String(rawCapacity).trim() !== '') {
    maxPatientsPerDay = Number(rawCapacity);
    if (!Number.isInteger(maxPatientsPerDay) || maxPatientsPerDay < 1 || maxPatientsPerDay > 50) {
      return { error: 'Maximum patients per day must be a whole number from 1 to 50.' };
    }
  }

  let breaks;
  if (availability.breaks !== undefined) {
    breaks = normalizeBreaks(availability.breaks);
    for (const pause of breaks) {
      if (!HHMM_RE.test(pause.startTime) || !HHMM_RE.test(pause.endTime)) {
        return { error: 'Break times must be valid times, like 12:00.' };
      }
      if (hhmmToMinutes(pause.endTime) <= hhmmToMinutes(pause.startTime)) {
        return { error: 'Each break must end later than it starts.' };
      }
    }
    const ordered = [...breaks].sort((a, b) => hhmmToMinutes(a.startTime) - hhmmToMinutes(b.startTime));
    for (let i = 1; i < ordered.length; i += 1) {
      if (hhmmToMinutes(ordered[i].startTime) < hhmmToMinutes(ordered[i - 1].endTime)) {
        return { error: 'Breaks cannot overlap each other.' };
      }
    }
  } else {
    breaks = normalizeBreaks(storedBreaks || []);
  }

  return { startTime, endTime, maxPatientsPerDay, breaks };
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
      // Not a separate setting: the optional machine-learning consent given at
      // sign-up (User.consents.mlConsentGiven). Settings shows and edits it.
      researchParticipation: user.consents?.mlConsentGiven === true,
    },
  };
}

// Consultation fee is the pediatrician's CURRENT rate — it gets snapshotted
// into each new appointment's totalAmount at booking time and must never be
// zero/negative, since that would silently make every new booking free.
// Sentinel return values: undefined = field not present in the request body
// (caller should leave the stored value untouched); null = client explicitly
// cleared the fee. Anything else throws so the route can return a 400
// instead of persisting bad data.
function parseConsultationFee(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Consultation fee must be a positive number.');
  }
  return Math.round(n * 100) / 100;
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

  // The required first screening is the registering parent's step. A linked
  // guardian with no child of their own goes to the dashboard instead — their
  // access level may not even allow submitting an assessment.
  if (!own.length) {
    return { defaultChildId, needsPreAssessment: false, preAssessmentChildId: null };
  }

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

// GET /api/auth/email-status
//
// Answers one question: can THIS server open an authenticated SMTP session to
// Gmail? It runs transporter.verify(), which connects, does TLS, greets and
// authenticates — then disconnects. No mail is sent, no OTP is generated and
// nothing is written to the database, so it is safe to hit from a browser.
//
// It exists because the interesting failure is infrastructural: on a host that
// blocks outbound SMTP, /send-otp fails identically every time and the reason is
// only visible in the platform's own logs. This surfaces it over HTTP.
// Presence booleans and SMTP protocol codes only — never any value.
// ?port= probes an alternative Gmail SMTP port (465 implicit TLS, 587 STARTTLS,
// 25 plain). The host is fixed and the port is allowlisted, so this cannot be
// pointed at anything else. It answers "is only 465 blocked, or all of SMTP?",
// which decides between a one-line port change and a different transport.
// Admins only (Settings > Test email): every call opens a mail connection,
// so it must not be something anyone on the internet can trigger.
const PROBE_PORTS = new Map([[465, true], [587, false], [25, false]]);

router.get('/email-status', authMiddleware, adminOnly, async (req, res) => {
  const startedAt = Date.now();
  const requestedPort = Number(req.query.port);
  const probePort = PROBE_PORTS.has(requestedPort) ? requestedPort : 465;
  const probeSecure = PROBE_PORTS.get(probePort);
  const present = {
    EMAIL_USER: Boolean(process.env.EMAIL_USER),
    EMAIL_PASS: Boolean(process.env.EMAIL_PASS),
    MONGODB_URI: Boolean(process.env.MONGODB_URI),
    JWT_SECRET: Boolean(process.env.JWT_SECRET),
  };

  present.EMAIL_API_KEY = Boolean(process.env.EMAIL_API_KEY);

  const usingHttp = httpEmailConfigured();
  const transport = usingHttp
    ? httpEmail.describe()
    : { kind: 'smtp', host: 'smtp.gmail.com', port: probePort, secure: probeSecure };

  if (!emailConfigured()) {
    console.error('[OTP] EMAIL_NOT_CONFIGURED (email-status probe)');
    return res.status(503).json({ ok: false, code: 'EMAIL_NOT_CONFIGURED', present, transport });
  }

  // With a key set, the HTTPS API is what /send-otp uses, so that is what gets
  // checked: an authenticated GET that validates the key without sending mail.
  if (usingHttp) {
    try {
      await httpEmail.verifyHttpEmail(10000);
      const elapsedMs = Date.now() - startedAt;
      console.log('[OTP] email-status probe: HTTPS API OK', `provider=${transport.provider}`, `${elapsedMs}ms`);
      return res.json({ ok: true, code: 'EMAIL_API_OK', present, elapsedMs, transport });
    } catch (err) {
      const failure = classifyMailError(err);
      const elapsedMs = Date.now() - startedAt;
      console.error(`[OTP] ${failure.label} (email-status probe)`, `provider=${transport.provider}`, `${elapsedMs}ms`, {
        smtp: failure.smtp, message: err?.message,
      });
      return res.status(failure.status).json({
        ok: false, code: failure.label, present, elapsedMs, smtp: failure.smtp, transport,
      });
    }
  }

  // The default port reuses the application's own transporter, so the probe
  // reports on exactly what /send-otp uses. Another port needs its own.
  const probe = probePort === 465 ? transporter : nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: probePort,
    secure: probeSecure,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    connectionTimeout: 7000,
    greetingTimeout: 7000,
    socketTimeout: 10000,
  });

  try {
    await Promise.race([
      probe.verify(),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('MAIL_TIMEOUT after 12000ms')), 12000)),
    ]);
    const elapsedMs = Date.now() - startedAt;
    console.log('[OTP] email-status probe: SMTP OK', `port=${probePort}`, `${elapsedMs}ms`);
    res.json({ ok: true, code: 'SMTP_OK', present, elapsedMs, transport });
  } catch (err) {
    const failure = classifyMailError(err);
    const elapsedMs = Date.now() - startedAt;
    console.error(`[OTP] ${failure.label} (email-status probe)`, `port=${probePort}`, `${elapsedMs}ms`, {
      smtp: failure.smtp,
      errno: err?.errno ?? null,
      syscall: err?.syscall ?? null,
      message: err?.message,
    });
    res.status(failure.status).json({ ok: false, code: failure.label, present, elapsedMs, smtp: failure.smtp, transport });
  }
});

// POST /api/auth/send-otp
//
// Every stage is timed and logged with an elapsed-milliseconds marker so the
// slow or failing step is visible in the platform logs instead of guessed at.
// The OTP value itself is never logged.
router.post('/send-otp', async (req, res) => {
  const startedAt = Date.now();
  const ms = () => `${Date.now() - startedAt}ms`;
  const email = String(req.body.email || '').trim().toLowerCase();
  console.log('[OTP] request received', `email=${email || '(none)'}`, ms());

  try {
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    console.log('[OTP] email validated', ms());

    // Checked before anything is generated or stored, so an address that is
    // already registered never creates an OTP row.
    const existingUser = await User.findOne({ email }).select('_id').lean();
    console.log('[OTP] existing-user check completed', `exists=${Boolean(existingUser)}`, ms());
    if (existingUser) {
      return res.status(409).json({
        error: 'Email already in use.',
        code: 'EMAIL_EXISTS'
      });
    }

    // Refuse before writing an OTP nobody can receive. Answering here is what
    // keeps a misconfigured deployment from looking like a frozen button.
    console.log('[OTP] email configuration checked', `configured=${emailConfigured()}`, ms());
    if (!emailConfigured()) {
      console.error('[OTP] EMAIL_NOT_CONFIGURED — set EMAIL_API_KEY (HTTPS) or EMAIL_USER + EMAIL_PASS (SMTP)', ms());
      return res.status(503).json({
        error: 'Email service is not configured. Please contact support.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }

    const otp = generateOTP();
    console.log('[OTP] OTP generated', ms());
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await OtpCode.deleteMany({ email, used: false, purpose: { $ne: 'password_reset' } });
    await OtpCode.create({ email, code: otp, expiresAt, used: false });
    console.log('[OTP] OTP saved', ms());

    const mailBudget = mailBudgetFrom(startedAt);
    console.log('[OTP] email send started', `transport=${activeTransport()}`, `budget=${mailBudget}ms`, ms());
    try {
      await deliverOtpEmail({
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
      }, mailBudget);
      console.log('[OTP] email send completed', ms());
    } catch (mailErr) {
      // The label names the failing layer; smtp carries the protocol/socket
      // identifiers. Neither contains credentials, the recipient or the OTP.
      const failure = classifyMailError(mailErr);
      console.error(`[OTP] ${failure.label}`, `transport=${activeTransport()}`, ms(), {
        smtp: failure.smtp,
        errno: mailErr?.errno ?? null,
        syscall: mailErr?.syscall ?? null,
        message: mailErr?.message,
      });
      return res.status(failure.status).json({
        error: failure.clientMessage,
        code: failure.label,
        // Echoed so the failing layer is visible from DevTools when the host's
        // logs are not to hand. Protocol codes only — safe to remove once the
        // transport is settled.
        transport: activeTransport(),
        smtp: failure.smtp,
      });
    }

    console.log('[OTP] response sent', 'status=200', ms());
    res.json({ success: true, message: 'OTP sent to your email.' });
  } catch (err) {
    console.error('[OTP] ERROR unhandled', ms(), err?.stack || err);
    res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
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

    // Look up the newest unused signup code for this email WITHOUT the code,
    // so every wrong guess can be counted against it. Looking up by email+code
    // meant a wrong guess matched nothing and could be repeated without limit,
    // letting the 10,000 four-digit codes be tried within the 10-minute life.
    const otpRow = await OtpCode.findOne({ email, used: false, purpose: { $ne: 'password_reset' } }).sort({ createdAt: -1 });
    if (!otpRow) {
      console.log('[OTP] verify rejected — no unused code', `email=${email}`);
      return res.status(400).json({ error: 'Invalid OTP.' });
    }
    if (new Date() > new Date(otpRow.expiresAt)) {
      console.log('[OTP] verify rejected — code expired', `email=${email}`);
      return res.status(400).json({ error: 'OTP expired.' });
    }
    if (String(otpRow.code) !== code) {
      otpRow.attempts = (otpRow.attempts || 0) + 1;
      if (otpRow.attempts >= SIGNUP_OTP_MAX_ATTEMPTS) {
        // Deleted, not marked used: /register accepts a used signup code as
        // proof the email was verified.
        await OtpCode.deleteOne({ _id: otpRow._id });
        console.log('[OTP] verify rejected — too many wrong codes, code voided', `email=${email}`);
        return res.status(429).json({
          error: 'Too many incorrect codes. Please request a new verification code.',
          code: 'OTP_LOCKED',
        });
      }
      await otpRow.save();
      console.log('[OTP] verify rejected — wrong code', `email=${email}`, `attempts=${otpRow.attempts}`);
      return res.status(400).json({ error: 'Invalid OTP.' });
    }

    otpRow.used = true;
    otpRow.verifiedAt = new Date();
    await otpRow.save();
    console.log('[OTP] verify accepted', `email=${email}`);

    res.json({ success: true, message: 'Email verified!' });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Server error while verifying OTP.' });
  }
});

// POST /api/auth/register
router.post('/register', handleProfileUpload, async (req, res) => {
  // Never log req.body or req.file here: the body carries the plaintext
  // password and the child's name and date of birth.
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

    // Naming the fields matters: the browser drops empty values from the
    // multipart body entirely, so a blank input arrives as a missing one and
    // the old catch-all message gave the user nothing to act on.
    const missingFields = Object.entries({
      role, firstName, lastName, username, email, password,
    }).filter(([, value]) => !String(value == null ? '' : value).trim()).map(([key]) => key);
    if (missingFields.length) {
      return fail(400, `All required fields must be filled. Missing: ${missingFields.join(', ')}.`);
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

    // Public sign-up creates only the two roles signup.html offers. Admin and
    // secretary accounts are never self-registered: accepting 'admin' here let
    // anyone with a verified email create an active admin. Family members and
    // guardians get 'parent' accounts through the guardian flows instead.
    if (!SELF_REGISTER_ROLES.includes(cleanRole)) {
      return fail(400, 'Invalid user role. Only parent and pediatrician accounts can sign up.');
    }
    if (!isValidEmail(cleanEmail)) {
      return fail(400, 'Please enter a valid email address.');
    }
    if (cleanPassword.length < 8) {
      return fail(400, 'Password must be at least 8 characters long.');
    }

    // Terms acceptance + Privacy Notice acknowledgment are REQUIRED to create an
    // account; the machine-learning consent is optional and never blocks this.
    // Enforced here, not only in the sign-up page, so a request that skips the
    // page cannot create an account. See constants/legalConsent.js.
    const consent = parseSignupConsent(req.body);
    if (!consent.ok) {
      return fail(400, consent.error);
    }

    // Parent sign-up (signup.html) always sends the child from the Child Information
    // step and the parent's relationship to them; the page will not continue without
    // them, so a request that skips the page must not either. Middle names stay optional.
    if (cleanRole === 'parent') {
      const missingChildFields = Object.entries({
        childFirstName, childLastName, dateOfBirth, gender, relationship,
      }).filter(([, value]) => !String(value == null ? '' : value).trim()).map(([key]) => key);
      if (missingChildFields.length) {
        return fail(400, `All required fields must be filled. Missing: ${missingChildFields.join(', ')}.`);
      }
      if (!SIGNUP_CHILD_GENDERS.includes(String(gender).trim().toLowerCase())) {
        return fail(400, "Please select your child's gender.");
      }
      if (!SIGNUP_RELATIONSHIPS.includes(String(relationship).trim().toLowerCase())) {
        return fail(400, 'Please select your relationship to the child.');
      }
    }

    // Children aged 3 to 8 only. Checked before the account exists, so an
    // ineligible date of birth creates neither the user nor the child record.
    // Pediatrician sign-up never sends a child, so it is not affected.
    if ((cleanRole === 'parent' || cleanRole === 'legal_guardian')
      && String(dateOfBirth == null ? '' : dateOfBirth).trim()) {
      const ageCheck = childAge.checkChildAge(dateOfBirth, childAge.todayInTimeZone(childAge.CLINIC_TIME_ZONE));
      if (!ageCheck.ok) {
        return fail(400, ageCheck.message);
      }
    }

    const existingUser = await User.findOne({
      $or: [{ email: cleanEmail }, { username: cleanUsername }],
    }).select('_id').lean();
    if (existingUser) {
      return fail(409, 'Email or username already in use.');
    }

    // Only a recent verification counts: any old verified code used to be
    // accepted forever, and it was never used up.
    const verifiedOtp = await OtpCode.findOne({
      email: cleanEmail,
      used: true,
      purpose: { $ne: 'password_reset' },
      verifiedAt: { $gte: new Date(Date.now() - SIGNUP_VERIFICATION_WINDOW_MS) },
    }).sort({ createdAt: -1 }).lean();
    if (!verifiedOtp) {
      return fail(400, 'Please verify your email first. A verification lasts 30 minutes; if it has expired, request a new code.');
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
      // Required on the Professional Information step (only Hospital / Institution
      // is optional there).
      const missingPracticeFields = Object.entries({ clinicName, clinicAddress, specialization })
        .filter(([, value]) => !String(value == null ? '' : value).trim()).map(([key]) => key);
      if (missingPracticeFields.length) {
        return fail(400, `All required fields must be filled. Missing: ${missingPracticeFields.join(', ')}.`);
      }
    } else if (req.file) {
      deleteUploadedPrcFile(req.file);
    }

    let cleanConsultationFee;
    try {
      cleanConsultationFee = parseConsultationFee(consultationFee);
    } catch (err) {
      return fail(400, err.message);
    }

    const userObjectId = new mongoose.Types.ObjectId();
    const prcDocumentPath = cleanRole === 'pediatrician' && req.file
      ? await movePrcUploadToUserFile(req.file, userObjectId)
      : null;

    if (cleanRole === 'pediatrician') {
      console.log('[PRC Upload][database-save] Prepared PRC document path for user create:', {
        userId: String(userObjectId),
        prcDocumentPath,
        fileExistsBeforeSave: await uploadPathExists(prcDocumentPath),
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
      consents: consent.consents,
      profileIcon: profileIcon || 'avatar1',
      licenseNumber: licenseNumber || null,
      institution: institution || null,
      specialization: specialization || null,
      clinicName: clinicName || institution || null,
      clinicAddress: clinicAddress || null,
      licenseExpiry: licenseExpiry ? new Date(licenseExpiry) : null,
      phoneNumber: phoneNumber || null,
      consultationFee: cleanConsultationFee ?? null,
      bio: bio || null,
      // Left unconfigured (no days) on purpose: a pediatrician must explicitly save
      // their own schedule in Settings > Availability before parents can see them
      // as bookable. See normalizeAvailability()/evaluateAvailability() in
      // routes/appointments.js, which treat an empty days list as not configured.
      availability: { days: [] },
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

    // The verification is used up by this account. A failure here must not
    // fail a registration that already succeeded; the email now belongs to an
    // account, so a leftover code cannot register anyone else anyway.
    try {
      await OtpCode.deleteMany({ email: cleanEmail, purpose: { $ne: 'password_reset' } });
    } catch (err) {
      console.warn('[OTP] could not clear used signup codes after registration:', err?.message || err);
    }

    // If a parent profile photo was uploaded, move it to a final filename and update the user record
    try {
      const parentFile = req.files?.parentProfilePhoto?.[0];
      if (parentFile) {
        const parentProfilePath = await moveProfileUploadToUserFile(parentFile, user._id, 'parent');
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
        fileExistsAfterSave: await uploadPathExists(user.prcIdDocumentPath),
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
    // Child information is required for parents (checked above) and optional for legal_guardian
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
          const childProfilePath = await moveProfileUploadToUserFile(childFile, child._id, 'child');
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

    // A pending pediatrician must not get a working session before admin
    // approval; login refuses the same account, so registration hands out no token.
    const token = user.status === 'active' ? signToken(user) : undefined;

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

    // Password first: the pending/suspended messages below confirm that the
    // account exists and reveal its status, so they are only shown to someone
    // who already knows the password.
    const match = await bcrypt.compare(cleanPassword, user.passwordHash);
    console.log(`[LOGIN] bcrypt.compare result: ${match}`);

    if (!match) {
      console.log(`[LOGIN] PASSWORD MISMATCH for user ${user._id}`);
      return res.status(401).json({ error: 'Invalid email/username or password.' });
    }

    // A rejected PRC check also leaves the account pending. Say why, and hand
    // over a one-purpose token so they can resubmit (POST /api/prc/resubmit).
    if (user.status === 'pending' && user.role === 'pediatrician' && user.prcVerificationStatus === 'rejected') {
      console.log(`[LOGIN] Account PRC REJECTED: _id=${user._id}`);
      const reason = user.prcAdminNotes ? ` Reason: ${user.prcAdminNotes}` : '';
      return res.status(403).json({
        error: `Your PRC verification was not approved.${reason} You can resubmit your documents below.`,
        code: 'PRC_REJECTED',
        prcLicenseNumber: user.prcLicenseNumber || '',
        resubmitToken: signPrcResubmitToken(user),
      });
    }

    if (user.status === 'pending') {
      console.log(`[LOGIN] Account PENDING: _id=${user._id}`);
      return res.status(403).json({ error: user.role === 'pediatrician' ? 'Your pediatrician account is still pending admin approval.' : 'Your account is not yet active. Please contact the clinic administrator.' });
    }
    if (user.status === 'suspended') {
      console.log(`[LOGIN] Account SUSPENDED: _id=${user._id}`);
      return res.status(403).json({ error: 'Your account has been suspended.' });
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
    // /auth/me is called on every page load by every signed-in user, so the
    // per-request identity log was the noisiest line in the server output.
    res.json({ success: true, user: publicUser(user) });
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

    let cleanConsultationFee;
    try {
      cleanConsultationFee = parseConsultationFee(consultationFee);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

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
    if (cleanConsultationFee !== undefined) user.consultationFee = cleanConsultationFee;
    if (bio !== undefined) user.bio = bio ? String(bio).trim() : null;

    // Parent Settings preferences. Only these keys are accepted, and each is
    // merged into the stored object so the pediatrician keys are kept.
    // emailAppointments decides whether appointment emails reach the parent
    // (routes/appointments.js parentAppointmentEmailTo).
    mergeBooleanPrefs(user, 'notificationSettings', req.body.notificationSettings, PARENT_NOTIFICATION_PREF_KEYS);

    // "Allow anonymous research participation" IS the sign-up ML consent; the
    // admin training export includes a child's screenings only when it is true.
    const research = req.body.privacySettings && req.body.privacySettings.researchParticipation;
    if (research !== undefined) {
      user.set('consents.mlConsentGiven', Boolean(research));
      user.set('consents.mlConsentRecordedAt', new Date());
    }

    await user.save();
    res.json({ success: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PARENT_NOTIFICATION_PREF_KEYS = ['emailAppointments'];

function mergeBooleanPrefs(user, field, input, allowedKeys) {
  if (!input || typeof input !== 'object') return;
  for (const key of allowedKeys) {
    if (input[key] !== undefined) user.set(`${field}.${key}`, Boolean(input[key]));
  }
}

// ── Forgot password ─────────────────────────────────────────────────────────
// A 6-digit code is emailed and stored only as a sha256 hash. Codes last 15
// minutes, are single-use, and are voided after 5 wrong guesses. Both routes
// answer the same way whether or not the account exists. Known limitation:
// JWTs issued before a reset stay valid until they expire (48h), because
// tokens are stateless and there is no revocation list.
const RESET_PURPOSE = 'password_reset';
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_GENERIC_MESSAGE = 'If an account exists for that email, a reset code has been sent. It expires in 15 minutes.';

function hashResetCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const startedAt = Date.now();
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!emailConfigured()) {
      console.error('[RESET] EMAIL_NOT_CONFIGURED');
      return res.status(503).json({
        error: 'Email service is not configured. Please contact support.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }

    const user = await User.findOne({ email }).select('_id status').lean();
    if (!user || user.status === 'suspended') {
      return res.json({ success: true, message: RESET_GENERIC_MESSAGE });
    }

    const recent = await OtpCode.findOne({
      email, purpose: RESET_PURPOSE, createdAt: { $gt: new Date(Date.now() - RESET_RESEND_COOLDOWN_MS) },
    }).select('_id').lean();
    if (recent) {
      return res.json({ success: true, message: RESET_GENERIC_MESSAGE });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await OtpCode.deleteMany({ email, purpose: RESET_PURPOSE, used: false });
    await OtpCode.create({
      email,
      code: hashResetCode(code),
      purpose: RESET_PURPOSE,
      attempts: 0,
      expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
      used: false,
    });

    try {
      await deliverOtpEmail({
        to: email,
        subject: 'KinderCura — Password Reset Code',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
            <div style="background:#6B8E6F;padding:20px;text-align:center;border-radius:10px 10px 0 0;">
              <h1 style="color:white;margin:0;">KinderCura</h1>
            </div>
            <div style="background:#f9f9f9;padding:30px;border-radius:0 0 10px 10px;">
              <h2 style="color:#333;">Password Reset</h2>
              <p style="color:#666;">Use the 6-digit code below to reset your password. It expires in <strong>15 minutes</strong>.</p>
              <div style="background:white;border:2px dashed #6B8E6F;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
                <span style="font-size:2.5rem;font-weight:bold;letter-spacing:10px;color:#6B8E6F;">${code}</span>
              </div>
              <p style="color:#999;font-size:0.85rem;">If you did not request this, you can ignore this email. Your password has not changed.</p>
            </div>
          </div>`,
      }, mailBudgetFrom(startedAt));
    } catch (mailErr) {
      // Logged only: a different response here would reveal that the account exists.
      const failure = classifyMailError(mailErr);
      console.error(`[RESET] ${failure.label}`, `transport=${activeTransport()}`, { smtp: failure.smtp });
    }

    res.json({ success: true, message: RESET_GENERIC_MESSAGE });
  } catch (err) {
    console.error('[RESET] forgot-password error:', err?.message || err);
    res.status(500).json({ error: 'Could not start the password reset. Please try again.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const INVALID = 'Invalid or expired code. Request a new one if needed.';
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const password = req.body.password;

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter your email and the 6-digit code.' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const row = await OtpCode.findOne({ email, purpose: RESET_PURPOSE, used: false }).sort({ createdAt: -1 });
    if (!row || new Date() > new Date(row.expiresAt)) {
      return res.status(400).json({ error: INVALID });
    }

    const given = Buffer.from(hashResetCode(code), 'hex');
    const stored = Buffer.from(String(row.code || ''), 'hex');
    const matches = stored.length === given.length && crypto.timingSafeEqual(stored, given);
    if (!matches) {
      row.attempts = (row.attempts || 0) + 1;
      if (row.attempts >= RESET_MAX_ATTEMPTS) row.used = true;
      await row.save();
      return res.status(400).json({ error: INVALID });
    }

    const user = await User.findOne({ email });
    if (!user || user.status === 'suspended') {
      row.used = true;
      await row.save();
      return res.status(400).json({ error: INVALID });
    }

    user.passwordHash = await bcrypt.hash(String(password), 10);
    await user.save();
    row.used = true;
    await row.save();
    await OtpCode.deleteMany({ email, purpose: RESET_PURPOSE, used: false });

    res.json({ success: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) {
    console.error('[RESET] reset-password error:', err?.message || err);
    res.status(500).json({ error: 'Could not reset the password. Please try again.' });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { password, currentPassword } = req.body;
    // The current password is required so a stolen or left-open session cannot
    // lock the owner out by setting a new password.
    if (!currentPassword) {
      return res.status(400).json({ error: 'Enter your current password.' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!await bcrypt.compare(String(currentPassword), user.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    user.passwordHash = await bcrypt.hash(String(password), 10);
    await user.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/pediatrician/settings
router.get('/pediatrician/settings', authMiddleware, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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
      currentPassword,
      availability,
      notificationSettings,
      privacySettings,
    } = req.body;

    if (email !== undefined) {
      const cleanEmail = String(email).trim().toLowerCase();
      if (!isValidEmail(cleanEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
      // Changing the sign-in e-mail needs the current password, like changing
      // the password does: otherwise a stolen or left-open session could point
      // the account at an address of its own and take it over through
      // "forgot password". The settings page sends the e-mail on every save, so
      // this applies only when it actually changes. It runs before the
      // "already in use" check so a wrong password cannot be used to learn
      // which addresses have accounts.
      if (cleanEmail !== String(user.email || '').trim().toLowerCase()) {
        if (!currentPassword) {
          return res.status(400).json({ error: 'Enter your current password to change your email address.' });
        }
        if (!await bcrypt.compare(String(currentPassword), user.passwordHash)) {
          return res.status(400).json({ error: 'Current password is incorrect.' });
        }
      }
      const emailUsed = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } }).select('_id').lean();
      if (emailUsed) {
        return res.status(409).json({ error: 'That email address is already in use.' });
      }
      user.email = cleanEmail;
    }

    if (consultationFee !== undefined) {
      try {
        const cleanConsultationFee = parseConsultationFee(consultationFee);
        // Clearing a fee that is set would make every new booking free, since
        // the fee is copied into each booking's total. A blank box when no fee
        // was ever set just leaves it unset.
        if (cleanConsultationFee === null && user.consultationFee != null) {
          return res.status(400).json({ error: 'The consultation fee cannot be cleared. Enter the new amount instead.' });
        }
        if (cleanConsultationFee !== undefined) user.consultationFee = cleanConsultationFee;
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    if (phoneNumber !== undefined) user.phoneNumber = phoneNumber ? String(phoneNumber).trim() : null;
    if (bio !== undefined) user.bio = bio ? String(bio).trim() : null;
    if (clinicName !== undefined) user.clinicName = clinicName ? String(clinicName).trim() : null;
    if (clinicAddress !== undefined) user.clinicAddress = clinicAddress ? String(clinicAddress).trim() : null;
    if (institution !== undefined) user.institution = institution ? String(institution).trim() : null;
    if (specialization !== undefined) user.specialization = specialization ? String(specialization).trim() : null;

    // Save availability in one place so appointments can enforce it later.
    if (availability && typeof availability === 'object') {
      const days = normalizeDays(availability.days || []);
      if (!days.length) {
        return res.status(400).json({ error: 'Please select at least one available day.' });
      }
      // Preserves existing breaks when this settings form only updates days/hours.
      const checked = validateAvailabilitySettings(availability, user.availability?.breaks);
      if (checked.error) {
        return res.status(400).json({ error: checked.error });
      }
      user.availability = {
        days,
        startTime: checked.startTime,
        endTime: checked.endTime,
        maxPatientsPerDay: checked.maxPatientsPerDay,
        breaks: checked.breaks,
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

// Test seam: lets the unit tests assert how a mail failure is labelled without
// standing up SMTP. Not used by the application.
module.exports._classifyMailError = classifyMailError;
