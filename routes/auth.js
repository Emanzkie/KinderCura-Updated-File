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
const fileStorage = require('../services/fileStorage');
const { parseSignupConsent } = require('../constants/legalConsent');
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
const PROBE_PORTS = new Map([[465, true], [587, false], [25, false]]);

router.get('/email-status', async (req, res) => {
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

    await OtpCode.deleteMany({ email, used: false });
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

    const otpRow = await OtpCode.findOne({ email, code, used: false }).sort({ createdAt: -1 });
    if (!otpRow) {
      console.log('[OTP] verify rejected — no matching unused code', `email=${email}`);
      return res.status(400).json({ error: 'Invalid OTP.' });
    }
    if (new Date() > new Date(otpRow.expiresAt)) {
      console.log('[OTP] verify rejected — code expired', `email=${email}`);
      return res.status(400).json({ error: 'OTP expired.' });
    }

    otpRow.used = true;
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
  console.log('--- REGISTRATION DEBUG ---');
  console.log('req.body:', req.body);
  console.log('req.file:', req.file);
  console.log('--------------------------');

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

    // Terms acceptance + Privacy Notice acknowledgment are REQUIRED to create an
    // account; the machine-learning consent is optional and never blocks this.
    // Enforced here, not only in the sign-up page, so a request that skips the
    // page cannot create an account. See constants/legalConsent.js.
    const consent = parseSignupConsent(req.body);
    if (!consent.ok) {
      return fail(400, consent.error);
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

    if (consultationFee !== undefined) {
      try {
        const cleanConsultationFee = parseConsultationFee(consultationFee);
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

// Test seam: lets the unit tests assert how a mail failure is labelled without
// standing up SMTP. Not used by the application.
module.exports._classifyMailError = classifyMailError;
