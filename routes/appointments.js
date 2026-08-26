// routes/appointments.js
// MongoDB replacement for parent + pediatrician appointment features.
// NOTE: This file does not open MongoDB by itself.
// It uses the mongoose connection that server.js starts through db.js.
const express = require('express');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
require('dotenv').config();

const { authMiddleware, secretaryOrPediatrician } = require('../middleware/auth');
const { hasPermission } = require('../middleware/guardianAccess');
const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Child = require('../models/Child');
const Assessment = require('../models/Assessment');
const AssessmentResult = require('../models/AssessmentResult');
const SystemSetting = require('../models/SystemSetting');
const scoring = require('../constants/scoring');
const paymentService = require('../services/paymentService');
const sse = require('../sse');

const router = express.Router();

function clinicStaffOrAdmin(req, res, next) {
  if (!['pediatrician', 'secretary', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Pediatricians, secretaries, and admins only.' });
  }
  next();
}

// Optional Gmail sender. If EMAIL_USER / EMAIL_PASS are not set, the app still works.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

const emailConfigured = () => Boolean(
  process.env.EMAIL_USER &&
  process.env.EMAIL_PASS &&
  process.env.EMAIL_USER !== 'your_email@gmail.com' &&
  process.env.EMAIL_PASS !== 'your_gmail_app_password'
);

function wrapEmail(content) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
    <div style="background:#6B8E6F;padding:20px;text-align:center;border-radius:10px 10px 0 0;">
      <h1 style="color:white;margin:0;"><span style="color:#E8A5A5;">Kinder</span>Cura</h1>
    </div>
    <div style="background:#f9f9f9;padding:28px;border-radius:0 0 10px 10px;">${content}</div>
    <p style="text-align:center;color:#aaa;font-size:0.78rem;margin-top:12px;">KinderCura — Supporting Your Child's Development Journey</p>
  </div>`;
}

async function sendEmail(to, subject, html) {
  if (!emailConfigured() || !to) {
    console.log(`\n[EMAIL SKIPPED] To: ${to || 'n/a'} | Subject: ${subject}\n`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"KinderCura" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html: wrapEmail(html),
    });
  } catch (err) {
    console.error('Appointment email error:', err.message);
  }
}

function resolveNotificationModel() {
  if (!Notification) return null;
  if (typeof Notification.create === 'function') return Notification;
  if (Notification.default && typeof Notification.default.create === 'function') return Notification.default;
  if (Notification.Notification && typeof Notification.Notification.create === 'function') return Notification.Notification;
  return null;
}

// 1-hour preferred-start-time interval. The parent's selected time is a request;
// the clinic confirms the final schedule during approval (see approval flow below).
const DEFAULT_SLOT_MINUTES = 60;

async function getAppointmentSlotSettings() {
  try {
    const doc = await SystemSetting.findOneAndUpdate(
      { singleton: 'default' },
      { $setOnInsert: { singleton: 'default', appointmentSlots: { enforceThirtyMinuteSlots: true, slotMinutes: DEFAULT_SLOT_MINUTES } } },
      { new: true, upsert: true }
    ).lean();

    return {
      enforceThirtyMinuteSlots: Boolean(doc?.appointmentSlots?.enforceThirtyMinuteSlots ?? true),
      slotMinutes: DEFAULT_SLOT_MINUTES,
    };
  } catch (err) {
    console.warn('Appointment slot settings fallback error:', err.message);
    return {
      enforceThirtyMinuteSlots: true,
      slotMinutes: DEFAULT_SLOT_MINUTES,
    };
  }
}

async function nextNotificationId() {
  try {
    const counters = mongoose.connection.collection('counters');
    const result = await counters.findOneAndUpdate(
      { _id: 'notifications' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );

    if (result?.value?.seq != null) return result.value.seq;

    const doc = await counters.findOne({ _id: 'notifications' });
    if (doc?.seq != null) return doc.seq;
  } catch (err) {
    console.warn('Notification counter fallback error:', err.message);
  }

  return Date.now();
}

// Important: notification problems must never block booking / approval / reschedule.
async function pushNotification(userId, title, message, type = 'appointment') {
  const notificationModel = resolveNotificationModel();
  const payload = {
    userId: new mongoose.Types.ObjectId(String(userId)),
    title,
    message,
    type,
    isRead: false,
  };

  try {
    if (notificationModel) {
      await notificationModel.create(payload);
      return;
    }
  } catch (err) {
    console.warn('Notification model create failed, using collection fallback:', err.message);
  }

  try {
    const notifications = mongoose.connection.collection('notifications');
    await notifications.insertOne({
      ...payload,
      id: await nextNotificationId(),
      createdAt: new Date(),
    });
  } catch (err) {
    console.warn('Notification insert fallback failed:', err.message);
  }
}

function fmtDate(dateValue) {
  if (!dateValue) return '—';
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return String(dateValue);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function fmtTime(timeValue) {
  if (!timeValue) return '—';
  const s = String(timeValue);
  const [rawH, rawM] = s.split(':');
  const h = parseInt(rawH, 10);
  const m = String(rawM || '00').padStart(2, '0');
  if (Number.isNaN(h)) return s;
  return `${h % 12 || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

function calcAge(dateOfBirth) {
  if (!dateOfBirth) return '—';
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let y = now.getFullYear() - dob.getFullYear();
  let m = now.getMonth() - dob.getMonth();
  if (m < 0) {
    y -= 1;
    m += 12;
  }
  if (y <= 0) return `${m} month${m !== 1 ? 's' : ''}`;
  return `${y} year${y !== 1 ? 's' : ''} ${m} month${m !== 1 ? 's' : ''}`.trim();
}

function safeText(value) {
  return String(value || '').trim();
}

function clinicNameFor(pediatrician) {
  return pediatrician?.clinicName || pediatrician?.institution || null;
}

function clinicAddressFor(pediatrician) {
  return pediatrician?.clinicAddress || null;
}

function normalizeBreakList(source = []) {
  if (!Array.isArray(source)) return [];

  return source
    .map((entry) => {
      const startTime = safeText(entry?.startTime);
      const endTime = safeText(entry?.endTime);
      if (!startTime || !endTime) return null;
      return {
        label: safeText(entry?.label) || null,
        startTime,
        endTime,
      };
    })
    .filter(Boolean);
}

// Availability can be stored in slightly different shapes depending on which
// settings screen saved it. This normalizer keeps parent booking synced with
// the pediatrician's real saved schedule.
function normalizeAvailability(source = {}) {
  const nested = source.availability || source.scheduleAvailability || source.schedule || {};

  const dayCandidates = nested.days || nested.availableDays || nested.daysAvailable || source.availableDays || source.availabilityDays || source.daysAvailable || source.days || [];
  const days = Array.isArray(dayCandidates) ? dayCandidates.filter(Boolean) : [];

  const startTime =
    nested.startTime || nested.from || nested.begin ||
    source.availabilityStartTime || source.startTime || source.availableFrom || source.clinicStartTime || null;

  const endTime =
    nested.endTime || nested.to || nested.finish ||
    source.availabilityEndTime || source.endTime || source.availableUntil || source.clinicEndTime || null;

  const rawMax =
    nested.maxPatientsPerDay ?? nested.maxPerDay ?? nested.dailyLimit ??
    source.maxPatientsPerDay ?? source.dailyPatientLimit ?? source.maxPerDay ?? null;

  const parsedMax = rawMax == null || rawMax === '' ? null : Math.max(1, Number(rawMax) || 0);
  const breaks = normalizeBreakList(
    nested.breaks || nested.breakTimes || source.breaks || source.availabilityBreaks || []
  );

  return {
    days,
    startTime,
    endTime,
    maxPatientsPerDay: parsedMax,
    breaks,
    configured: Boolean(days.length && startTime && endTime),
  };
}

function parseTimeParts(value) {
  // The backend accepts browser HH:mm strings plus older stored values with seconds / ISO timestamps.
  if (value === undefined || value === null || value === '') {
    return { valid: false, canonical: null, totalMinutes: null, seconds: null };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hours = value.getUTCHours();
    const minutes = value.getUTCMinutes();
    const seconds = value.getUTCSeconds();
    return {
      valid: true,
      hours,
      minutes,
      seconds,
      totalMinutes: hours * 60 + minutes,
      canonical: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    };
  }

  const raw = String(value).trim();
  if (!raw) return { valid: false, canonical: null, totalMinutes: null, seconds: null };

  const iso = new Date(raw);
  if ((raw.includes('T') || raw.includes('Z')) && !Number.isNaN(iso.getTime())) {
    const hours = iso.getUTCHours();
    const minutes = iso.getUTCMinutes();
    const seconds = iso.getUTCSeconds();
    return {
      valid: true,
      hours,
      minutes,
      seconds,
      totalMinutes: hours * 60 + minutes,
      canonical: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    };
  }

  const ampm = raw.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (ampm) {
    let hours = parseInt(ampm[1], 10);
    const minutes = parseInt(ampm[2] || '0', 10);
    const seconds = parseInt(ampm[3] || '0', 10);
    if ([hours, minutes, seconds].some((part) => Number.isNaN(part))) {
      return { valid: false, canonical: null, totalMinutes: null, seconds: null };
    }
    const suffix = ampm[4].toUpperCase();
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
      return { valid: false, canonical: null, totalMinutes: null, seconds: null };
    }
    if (hours === 12) hours = 0;
    if (suffix === 'PM') hours += 12;
    return {
      valid: true,
      hours,
      minutes,
      seconds,
      totalMinutes: hours * 60 + minutes,
      canonical: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    };
  }

  const simple = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!simple) {
    return { valid: false, canonical: null, totalMinutes: null, seconds: null };
  }

  const hours = parseInt(simple[1], 10);
  const minutes = parseInt(simple[2], 10);
  const seconds = parseInt(simple[3] || '0', 10);
  if (
    [hours, minutes, seconds].some((part) => Number.isNaN(part)) ||
    hours < 0 || hours > 23 ||
    minutes < 0 || minutes > 59 ||
    seconds < 0 || seconds > 59
  ) {
    return { valid: false, canonical: null, totalMinutes: null, seconds: null };
  }

  return {
    valid: true,
    hours,
    minutes,
    seconds,
    totalMinutes: hours * 60 + minutes,
    canonical: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

function normalizeTimeString(value) {
  const parsed = parseTimeParts(value);
  return parsed.valid ? parsed.canonical : null;
}

function toMinutes(value) {
  // Convert time strings into minutes after midnight so range checks stay consistent.
  const parsed = parseTimeParts(value);
  return parsed.valid ? parsed.totalMinutes : null;
}

function minutesToTimeString(totalMinutes) {
  const normalized = ((Math.floor(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function ceilToSlot(totalMinutes, slotMinutes = DEFAULT_SLOT_MINUTES) {
  return Math.ceil(totalMinutes / slotMinutes) * slotMinutes;
}

function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function normalizeMinutesForWindow(totalMinutes, timeWindow) {
  if (totalMinutes == null) return null;
  if (timeWindow?.crossesMidnight && totalMinutes < timeWindow.startMinutes) {
    return totalMinutes + (24 * 60);
  }
  return totalMinutes;
}

function normalizeBreakWindows(breaks, timeWindow) {
  if (!timeWindow?.valid || !Array.isArray(breaks) || !breaks.length) return [];

  return breaks
    .map((entry) => {
      const interval = normalizeTimeWindow(entry.startTime, entry.endTime);
      if (!interval.valid) return null;

      let startMinutes = interval.startMinutes;
      let endMinutes = interval.endMinutes;

      if (timeWindow.crossesMidnight && startMinutes < timeWindow.startMinutes) {
        startMinutes += 24 * 60;
        endMinutes += 24 * 60;
      }

      const clippedStart = Math.max(startMinutes, timeWindow.startMinutes);
      const clippedEnd = Math.min(endMinutes, timeWindow.endMinutes);
      if (clippedEnd <= clippedStart) return null;

      return {
        label: entry.label || null,
        startMinutes: clippedStart,
        endMinutes: clippedEnd,
        startTime: minutesToTimeString(clippedStart),
        endTime: minutesToTimeString(clippedEnd),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

function buildIntervalSlots({ timeWindow, breakWindows, slotMinutes }) {
  if (!timeWindow?.valid || slotMinutes <= 0) return [];

  const slots = [];
  for (
    let cursor = ceilToSlot(timeWindow.startMinutes, slotMinutes);
    cursor + slotMinutes <= timeWindow.endMinutes;
    cursor += slotMinutes
  ) {
    const endMinutes = cursor + slotMinutes;
    const overlapsBreak = breakWindows.some((pause) => intervalsOverlap(cursor, endMinutes, pause.startMinutes, pause.endMinutes));
    if (overlapsBreak) continue;

    slots.push({
      startMinutes: cursor,
      endMinutes,
      value: minutesToTimeString(cursor),
    });
  }

  return slots;
}

function buildExistingAppointmentIntervals(existingAppointments, timeWindow, slotMinutes) {
  return existingAppointments
    .map((entry) => {
      const parsed = parseTimeParts(entry?.appointmentTime);
      const fallbackValue = safeText(entry?.appointmentTime);

      if (!parsed.valid) {
        return fallbackValue ? { value: fallbackValue, valid: false } : null;
      }

      const startMinutes = normalizeMinutesForWindow(parsed.totalMinutes, timeWindow);
      return {
        value: parsed.canonical,
        valid: true,
        startMinutes,
        endMinutes: startMinutes + slotMinutes,
      };
    })
    .filter(Boolean);
}

function validateRequestedTime(appointmentTime, slotSettings) {
  const parsed = parseTimeParts(appointmentTime);
  if (!parsed.valid) {
    return {
      valid: false,
      message: 'Please select a valid appointment time.',
      requestedTime: null,
    };
  }

  if (parsed.seconds !== 0) {
    return {
      valid: false,
      message: slotSettings?.enforceThirtyMinuteSlots
        ? 'Please select a valid appointment start time.'
        : 'Please select a valid appointment time.',
      requestedTime: null,
    };
  }

  if (slotSettings?.enforceThirtyMinuteSlots && (parsed.minutes % DEFAULT_SLOT_MINUTES !== 0)) {
    return {
      valid: false,
      message: 'Please select a valid appointment start time.',
      requestedTime: null,
    };
  }

  return {
    valid: true,
    message: null,
    requestedTime: parsed.canonical,
    requestedMinutes: parsed.totalMinutes,
  };
}

function normalizeTimeWindow(startTime, endTime) {
  // Midnight-ending schedules (for example 10:00 AM - 12:00 AM) are treated as
  // end-of-day windows. Schedules that truly cross midnight stay supported too.
  const startMinutes = toMinutes(startTime);
  const endMinutesRaw = toMinutes(endTime);

  if (startMinutes == null || endMinutesRaw == null) {
    return { startMinutes, endMinutes: endMinutesRaw, crossesMidnight: false, valid: false };
  }

  if (endMinutesRaw === 0 && startMinutes > 0) {
    return { startMinutes, endMinutes: 24 * 60, crossesMidnight: false, valid: true };
  }

  if (endMinutesRaw < startMinutes) {
    return { startMinutes, endMinutes: endMinutesRaw + (24 * 60), crossesMidnight: true, valid: true };
  }

  return { startMinutes, endMinutes: endMinutesRaw, crossesMidnight: false, valid: true };
}

function normalizeUtcDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const only = String(value).slice(0, 10);
  const d = new Date(`${only}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getTodayUtcStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function getLatestAssessmentResultForChild(childId) {
  if (!childId) return null;
  const latestAssessment = await Assessment.findOne({ childId, status: 'complete' })
    .sort({ completedAt: -1, startedAt: -1, createdAt: -1 })
    .lean();
  if (!latestAssessment) return null;
  const result = await AssessmentResult.findOne({ assessmentId: latestAssessment._id }).lean();
  if (!result) return null;
  return { assessment: latestAssessment, result };
}

function buildAssessmentContext(resultDoc) {
  if (!resultDoc) {
    return {
      hasAssessment: false,
      consultationNeeded: false,
      urgent: false,
      focusAreas: [],
      summary: 'You can still choose any active pediatrician for your child.',
    };
  }

  const domains = [
    { key: 'communication', label: 'Communication', score: Number(resultDoc.communicationScore || 0), keywords: ['communication', 'speech', 'language', 'behavior', 'development'] },
    { key: 'social', label: 'Social Skills', score: Number(resultDoc.socialScore || 0), keywords: ['social', 'behavior', 'interaction', 'development'] },
    { key: 'cognitive', label: 'Cognitive', score: Number(resultDoc.cognitiveScore || 0), keywords: ['cognitive', 'development', 'behavior', 'learning', 'neuro'] },
    { key: 'motor', label: 'Motor Skills', score: Number(resultDoc.motorScore || 0), keywords: ['motor', 'occupational', 'physical', 'development', 'movement'] },
  ];

  // A focus area is any domain not in the top band. See constants/scoring.js.
  const focusAreas = domains
    .filter((d) => scoring.bandFor(d.score) !== scoring.BAND.ON_TRACK)
    .sort((a, b) => a.score - b.score);

  const urgent = focusAreas.some((d) => scoring.isRiskFlagged(d.score));
  const consultationNeeded = focusAreas.length > 0;

  let summary = 'You can book an appointment with any active pediatrician.';
  if (consultationNeeded) {
    const names = focusAreas.slice(0, 2).map((d) => d.label).join(' and ');
    summary = urgent
      ? `KinderCura suggests prioritizing a pediatrician who can support ${names}.`
      : `A follow-up consultation may help support ${names}.`;
  }

  return { hasAssessment: true, consultationNeeded, urgent, focusAreas, summary };
}

function scorePediatricianForContext(pediatrician, context) {
  const hay = `${safeText(pediatrician.specialization)} ${safeText(pediatrician.clinicName)} ${safeText(pediatrician.institution)} ${safeText(pediatrician.bio)}`.toLowerCase();
  let score = 0;
  const reasons = [];

  if (context.consultationNeeded) {
    for (const area of context.focusAreas) {
      if (area.keywords.some((kw) => hay.includes(kw))) {
        score += scoring.isRiskFlagged(area.score) ? 8 : 5;
        reasons.push(`${area.label} support match`);
      }
    }
  }

  if (/pediatric|development|child/.test(hay)) {
    score += 2;
    reasons.push('pediatric development care');
  }
  if (clinicNameFor(pediatrician)) score += 1;
  if (clinicAddressFor(pediatrician)) score += 1;
  if (pediatrician.consultationFee != null) score += 1;

  return {
    score,
    reason: reasons.length ? reasons[0] : (context.consultationNeeded ? 'general pediatric follow-up' : 'active pediatrician'),
  };
}

async function buildSuggestedPediatricians({ childId = null } = {}) {
  const latest = childId ? await getLatestAssessmentResultForChild(childId) : null;
  const context = buildAssessmentContext(latest?.result || null);

  const pediatricians = await User.find({ role: 'pediatrician', status: 'active' })
    .select('firstName lastName specialization institution clinicName clinicAddress phoneNumber consultationFee profileIcon availability bio availableDays availabilityDays daysAvailable startTime endTime maxPatientsPerDay dailyPatientLimit schedule scheduleAvailability clinicStartTime clinicEndTime availableFrom availableUntil')
    .sort({ firstName: 1, lastName: 1 })
    .lean();

  const mapped = pediatricians.map((p) => {
    const match = scorePediatricianForContext(p, context);
    const availability = normalizeAvailability(p);
    return {
      id: String(p._id),
      firstName: p.firstName,
      lastName: p.lastName,
      specialization: p.specialization || null,
      institution: p.institution || null,
      clinicName: clinicNameFor(p),
      clinicAddress: clinicAddressFor(p),
      phoneNumber: p.phoneNumber || null,
      consultationFee: p.consultationFee ?? null,
      profileIcon: p.profileIcon || null,
      availability,
      availabilityConfigured: availability.configured,
      matchScore: match.score,
      suggestedReason: match.reason,
      isSuggested: context.consultationNeeded ? match.score > 0 : false,
    };
  });

  mapped.sort((a, b) => (b.matchScore - a.matchScore) || `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));

  return {
    context: {
      hasAssessment: context.hasAssessment,
      consultationNeeded: context.consultationNeeded,
      urgent: context.urgent,
      focusAreas: context.focusAreas.map((a) => a.label),
      summary: context.summary,
      assessmentId: latest?.assessment ? String(latest.assessment._id) : null,
    },
    pediatricians: mapped,
  };
}

// Important helper:
// All slot checks are centralized here so create/reschedule and the parent availability preview
// all follow the same booking rules.
async function evaluateAvailability({ pediatrician, appointmentDate, appointmentTime = null, excludeAppointmentMongoId = null }) {
  const slotSettings = await getAppointmentSlotSettings();
  const baseUnavailable = {
    slotSettings,
    availableSlots: [],
    generatedSlots: [],
    breakRanges: [],
    isDayAvailable: false,
    isWithinHours: false,
    isFull: false,
    isTimeTaken: false,
    remainingSlots: 0,
    bookedCount: 0,
    bookedTimes: [],
    freeSlotCount: 0,
  };

  if (!pediatrician) {
    return {
      ...baseUnavailable,
      available: false,
      message: 'Selected pediatrician was not found.',
    };
  }

  const dateOnly = normalizeUtcDate(appointmentDate);
  if (!dateOnly) {
    return {
      ...baseUnavailable,
      available: false,
      message: 'Please choose a valid appointment date.',
    };
  }

  const normalizedAvailability = normalizeAvailability(pediatrician);
  const availableDays = normalizedAvailability.days;
  const startTime = normalizedAvailability.startTime;
  const endTime = normalizedAvailability.endTime;
  const breaks = normalizedAvailability.breaks || [];
  // Capacity must come from what the pediatrician actually saved — never guess a number.
  const configuredMaxPatientsPerDay = normalizedAvailability.maxPatientsPerDay != null
    ? Math.max(1, Number(normalizedAvailability.maxPatientsPerDay))
    : null;
  const dayName = dateOnly.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

  if (!normalizedAvailability.configured || configuredMaxPatientsPerDay == null) {
    return {
      ...baseUnavailable,
      available: false,
      configured: false,
      message: 'Availability has not been configured yet.',
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay: null,
    };
  }

  const maxPatientsPerDay = configuredMaxPatientsPerDay;

  const isDayAvailable = availableDays.includes(dayName);

  const todayUtc = getTodayUtcStart();
  if (dateOnly < todayUtc) {
    return {
      ...baseUnavailable,
      available: false,
      message: 'Please choose today or a future date.',
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      isDayAvailable,
    };
  }

  if (!isDayAvailable) {
    return {
      ...baseUnavailable,
      available: false,
      message: `This pediatrician is not available on ${dayName}. Please choose one of the available days.`,
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      isDayAvailable: false,
      remainingSlots: maxPatientsPerDay,
    };
  }

  const nextDay = new Date(dateOnly);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const query = {
    pediatricianId: pediatrician._id,
    appointmentDate: { $gte: dateOnly, $lt: nextDay },
    status: { $in: ['pending', 'approved'] },
  };
  if (excludeAppointmentMongoId) {
    query._id = { $ne: excludeAppointmentMongoId };
  }

  const existing = await Appointment.find(query)
    .select('appointmentTime')
    .sort({ appointmentTime: 1 })
    .lean();

  const bookedTimes = [...new Set(existing.map((a) => normalizeTimeString(a.appointmentTime) || safeText(a.appointmentTime)).filter(Boolean))];
  const bookedCount = existing.length;
  const remainingSlots = Math.max(maxPatientsPerDay - bookedCount, 0);
  const timeWindow = normalizeTimeWindow(startTime, endTime);
  if (!timeWindow.valid) {
    return {
      ...baseUnavailable,
      available: false,
      message: "This pediatrician's saved schedule is incomplete. Please choose another pediatrician or try again later.",
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      isDayAvailable: true,
      bookedCount,
      bookedTimes,
      remainingSlots,
    };
  }

  const breakWindows = normalizeBreakWindows(breaks, timeWindow);
  const generatedSlotEntries = buildIntervalSlots({
    timeWindow,
    breakWindows,
    slotMinutes: DEFAULT_SLOT_MINUTES,
  });
  const generatedSlots = generatedSlotEntries.map((slot) => slot.value);
  const existingIntervals = buildExistingAppointmentIntervals(existing, timeWindow, DEFAULT_SLOT_MINUTES);
  const takenGeneratedSlots = generatedSlotEntries
    .filter((slot) => existingIntervals.some((busy) => busy.valid && intervalsOverlap(slot.startMinutes, slot.endMinutes, busy.startMinutes, busy.endMinutes)))
    .map((slot) => slot.value);
  const availableSlots = remainingSlots > 0
    ? generatedSlotEntries
      .filter((slot) => !takenGeneratedSlots.includes(slot.value))
      .map((slot) => slot.value)
    : [];
  const breakRanges = breakWindows.map((pause) => ({
    label: pause.label,
    startTime: pause.startTime,
    endTime: pause.endTime,
  }));

  if (appointmentTime) {
    const requestedValidation = validateRequestedTime(appointmentTime, slotSettings);
    if (!requestedValidation.valid) {
      return {
        ...baseUnavailable,
        available: false,
        message: requestedValidation.message,
        dayName,
        startTime,
        endTime,
        maxPatientsPerDay,
        bookedCount,
        bookedTimes,
        remainingSlots,
        generatedSlots,
        availableSlots,
        breakRanges,
        isDayAvailable: true,
      };
    }

    const requestedMinutes = requestedValidation.requestedMinutes;
    const normalizedRequestedMinutes = normalizeMinutesForWindow(requestedMinutes, timeWindow);
    const isWithinHours = normalizedRequestedMinutes >= timeWindow.startMinutes
      && normalizedRequestedMinutes < timeWindow.endMinutes;
    const requestedOverlapsBreak = breakWindows.some((pause) => intervalsOverlap(
      normalizedRequestedMinutes,
      normalizedRequestedMinutes + DEFAULT_SLOT_MINUTES,
      pause.startMinutes,
      pause.endMinutes
    ));
    const requestedIntervalTaken = existingIntervals.some((busy) => busy.valid && intervalsOverlap(
      normalizedRequestedMinutes,
      normalizedRequestedMinutes + DEFAULT_SLOT_MINUTES,
      busy.startMinutes,
      busy.endMinutes
    ));

    if (slotSettings.enforceThirtyMinuteSlots) {
      const alignsWithGeneratedSlot = generatedSlots.includes(requestedValidation.requestedTime);

      if (!alignsWithGeneratedSlot || requestedOverlapsBreak || !isWithinHours) {
        return {
          ...baseUnavailable,
          available: false,
          message: 'Please choose one of the available start times.',
          dayName,
          startTime,
          endTime,
          maxPatientsPerDay,
          bookedCount,
          bookedTimes,
          remainingSlots,
          generatedSlots,
          availableSlots,
          breakRanges,
          requestedTime: requestedValidation.requestedTime,
          isDayAvailable: true,
        };
      }

      if (requestedIntervalTaken) {
        return {
          ...baseUnavailable,
          available: false,
          message: 'This start time is already booked. Please choose another time.',
          dayName,
          startTime,
          endTime,
          maxPatientsPerDay,
          bookedCount,
          bookedTimes,
          remainingSlots,
          generatedSlots,
          availableSlots,
          breakRanges,
          requestedTime: requestedValidation.requestedTime,
          isDayAvailable: true,
          isWithinHours: true,
          isTimeTaken: true,
        };
      }
    } else {
      if (!isWithinHours) {
        return {
          ...baseUnavailable,
          available: false,
          message: `Please choose a time between ${fmtTime(startTime)} and ${fmtTime(endTime)}.`,
          dayName,
          startTime,
          endTime,
          maxPatientsPerDay,
          bookedCount,
          bookedTimes,
          remainingSlots,
          generatedSlots,
          availableSlots,
          breakRanges,
          requestedTime: requestedValidation.requestedTime,
          isDayAvailable: true,
        };
      }

      if (requestedOverlapsBreak) {
        return {
          ...baseUnavailable,
          available: false,
          message: 'Please choose a time outside of the provider break schedule.',
          dayName,
          startTime,
          endTime,
          maxPatientsPerDay,
          bookedCount,
          bookedTimes,
          remainingSlots,
          generatedSlots,
          availableSlots,
          breakRanges,
          requestedTime: requestedValidation.requestedTime,
          isDayAvailable: true,
        };
      }

      if (bookedTimes.includes(requestedValidation.requestedTime)) {
        return {
          ...baseUnavailable,
          available: false,
          message: 'This start time is already booked. Please choose another time.',
          dayName,
          startTime,
          endTime,
          maxPatientsPerDay,
          bookedCount,
          bookedTimes,
          remainingSlots,
          generatedSlots,
          availableSlots,
          breakRanges,
          requestedTime: requestedValidation.requestedTime,
          isDayAvailable: true,
          isWithinHours: true,
          isTimeTaken: true,
        };
      }
    }

    if (bookedCount >= maxPatientsPerDay) {
      return {
        ...baseUnavailable,
        available: false,
        message: `This pediatrician is already fully booked for ${fmtDate(dateOnly)}. Please choose another date.`,
        dayName,
        startTime,
        endTime,
        maxPatientsPerDay,
        bookedCount,
        bookedTimes,
        remainingSlots: 0,
        generatedSlots,
        availableSlots,
        breakRanges,
        requestedTime: requestedValidation.requestedTime,
        isDayAvailable: true,
        isWithinHours: true,
        isFull: true,
      };
    }

    return {
      available: true,
      message: 'Your preferred start time is available. The clinic will confirm the final schedule.',
      slotSettings,
      requestedTime: requestedValidation.requestedTime,
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      bookedCount,
      bookedTimes,
      remainingSlots,
      generatedSlots,
      availableSlots,
      breakRanges,
      freeSlotCount: availableSlots.length,
      isDayAvailable: true,
      isWithinHours: true,
      isFull: false,
      isTimeTaken: false,
    };
  }

  const dayIsFull = bookedCount >= maxPatientsPerDay;
  const dayHasAvailableStartTimes = availableSlots.length > 0;

  if (slotSettings.enforceThirtyMinuteSlots && !generatedSlots.length) {
    return {
      ...baseUnavailable,
      available: false,
      message: 'No appointment start times are available for this schedule.',
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      bookedCount,
      bookedTimes,
      remainingSlots,
      generatedSlots,
      availableSlots,
      breakRanges,
      isDayAvailable: true,
    };
  }

  if (dayIsFull) {
    return {
      ...baseUnavailable,
      available: false,
      message: `This pediatrician is already fully booked for ${fmtDate(dateOnly)}. Please choose another date.`,
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      bookedCount,
      bookedTimes,
      remainingSlots: 0,
      generatedSlots,
      availableSlots,
      breakRanges,
      isDayAvailable: true,
      isWithinHours: true,
      isFull: true,
      freeSlotCount: availableSlots.length,
    };
  }

  if (slotSettings.enforceThirtyMinuteSlots && !dayHasAvailableStartTimes) {
    return {
      ...baseUnavailable,
      available: false,
      message: `No available start times are left for ${fmtDate(dateOnly)}. Please choose another date.`,
      dayName,
      startTime,
      endTime,
      maxPatientsPerDay,
      bookedCount,
      bookedTimes,
      remainingSlots,
      generatedSlots,
      availableSlots,
      breakRanges,
      isDayAvailable: true,
      isWithinHours: true,
      isFull: true,
      freeSlotCount: 0,
    };
  }

  return {
    available: true,
    message: slotSettings.enforceThirtyMinuteSlots
      ? 'Choose your preferred appointment start time. The clinic will confirm the final schedule.'
      : 'Schedule is available for booking.',
    slotSettings,
    dayName,
    startTime,
    endTime,
    maxPatientsPerDay,
    bookedCount,
    bookedTimes,
    remainingSlots,
    generatedSlots,
    availableSlots,
    breakRanges,
    freeSlotCount: availableSlots.length,
    isDayAvailable: true,
    isWithinHours: true,
    isFull: false,
    isTimeTaken: false,
  };
}

async function hydrateAppointment(appointmentDoc) {
  const [child, parent, pediatrician] = await Promise.all([
    Child.findById(appointmentDoc.childId).lean(),
    User.findById(appointmentDoc.parentId).lean(),
    appointmentDoc.pediatricianId ? User.findById(appointmentDoc.pediatricianId).lean() : null,
  ]);

  return {
    id: appointmentDoc.id,
    childId: child ? String(child._id) : null,
    parentId: parent ? String(parent._id) : null,
    pediatricianId: pediatrician ? String(pediatrician._id) : null,
    appointmentDate: appointmentDoc.appointmentDate,
    appointmentTime: appointmentDoc.appointmentTime,
    reason: appointmentDoc.reason,
    notes: appointmentDoc.notes,
    location: appointmentDoc.location,
    status: appointmentDoc.status,
    paymentType: appointmentDoc.paymentType || null,
    paymentStatus: appointmentDoc.paymentStatus || 'Unpaid',
    totalAmount: appointmentDoc.totalAmount || 0,
    amountPaid: appointmentDoc.amountPaid || 0,
    balanceDue: appointmentDoc.balanceDue || 0,
    nextInstallmentDate: appointmentDoc.nextInstallmentDate || null,
    requiredDownPayment: paymentService.calculateRequiredDownPayment(appointmentDoc.totalAmount || 0),
    createdAt: appointmentDoc.createdAt,
    childFirstName: child?.firstName || null,
    childLastName: child?.lastName || null,
    childName: child ? `${child.firstName} ${child.lastName}` : 'Unknown Child',
    childAge: child ? calcAge(child.dateOfBirth) : '—',
    childDob: child?.dateOfBirth || null,
    childDateOfBirth: child?.dateOfBirth || null,
    childGender: child?.gender || null,
    childProfileIcon: child?.profileIcon || null,
    parentFirstName: parent?.firstName || null,
    parentLastName: parent?.lastName || null,
    parentName: parent ? `${parent.firstName} ${parent.lastName}` : 'Unknown Parent',
    parentEmail: parent?.email || null,
    pediatricianName: pediatrician ? `${pediatrician.firstName} ${pediatrician.lastName}` : null,
    pediatricianFirstName: pediatrician?.firstName || null,
    pediatricianLastName: pediatrician?.lastName || null,
    pediatricianEmail: pediatrician?.email || null,
    pediatricianSpecialization: pediatrician?.specialization || null,
    clinicName: clinicNameFor(pediatrician),
    clinicAddress: clinicAddressFor(pediatrician),
    pediatricianPhoneNumber: pediatrician?.phoneNumber || null,
    consultationFee: pediatrician?.consultationFee ?? null,
    pedPhoto: pediatrician?.profileIcon || null,
    parentPhoto: parent?.profileIcon || null,
    hasVideo: Boolean(appointmentDoc.hasVideo),
    pendingPaymentMode: appointmentDoc.pendingPaymentMode || null,
  };
}

// GET /api/appointments/slot-settings
// Shared by parent and pediatrician pages so the time field can switch between
// enforced 1-hour start times and the legacy manual time input without guessing.
router.get('/slot-settings', authMiddleware, async (req, res) => {
  try {
    if (!['parent', 'pediatrician', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const settings = await getAppointmentSlotSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error('appointments /slot-settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/appointments/pediatricians/list
// Used by parent appointments page.
router.get('/pediatricians/list', authMiddleware, async (req, res) => {
  // Consultation fees change over time; never let a browser/proxy cache serve
  // a stale rate for a page that is about to create a new booking.
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!['parent','legal_guardian','foster_parent','court_appointed','admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Parents or admins only.' });
    }

    const childId = req.query.childId ? String(req.query.childId) : null;
    if (childId) {
      const childDoc = await Child.findById(childId).lean();
      if (!childDoc) return res.status(404).json({ error: 'Child not found.' });
      const allowed = String(childDoc.parentId) === String(req.user.userId) || await hasPermission(req.user.userId, childId, 'manageAppointments') || req.user.role === 'admin';
      if (!allowed) return res.status(404).json({ error: 'Child not found for this account.' });
    }

    const built = await buildSuggestedPediatricians({ childId });
    const slotSettings = await getAppointmentSlotSettings();
    res.json({ success: true, ...built, slotSettings });
  } catch (err) {
    console.error('appointments /pediatricians/list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/appointments/availability/check
// Parent page calls this to preview live slot availability before booking.
router.get('/availability/check', authMiddleware, async (req, res) => {
  try {
    if (!['parent', 'pediatrician', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const pediatricianId = String(req.query.pediatricianId || '');
    const appointmentDate = String(req.query.date || '');
    const appointmentTime = req.query.time ? String(req.query.time) : null;

    if (!pediatricianId || !appointmentDate) {
      return res.status(400).json({ error: 'Pediatrician and date are required.' });
    }

    const pediatrician = await User.findOne({ _id: pediatricianId, role: 'pediatrician', status: 'active' }).lean();
    if (!pediatrician) {
      return res.status(404).json({ error: 'Selected pediatrician not found.' });
    }

    if (req.user.role === 'pediatrician' && String(req.user.userId) !== String(pediatrician._id)) {
      return res.status(403).json({ error: 'You can only view your own availability.' });
    }

    const summary = await evaluateAvailability({ pediatrician, appointmentDate, appointmentTime });
    res.json({
      success: true,
      availability: {
        ...summary,
        clinicName: clinicNameFor(pediatrician),
        clinicAddress: clinicAddressFor(pediatrician),
        pediatricianName: `Dr. ${pediatrician.firstName} ${pediatrician.lastName}`,
      },
    });
  } catch (err) {
    console.error('appointments availability check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/appointments/pedia
// Used by pediatrician appointments / dashboard / question assignment pages.
// Important: secretaries with a valid linkedPediatricianId also have access
// so they can manage bookings on behalf of the linked pediatrician.
router.get('/pedia', authMiddleware, secretaryOrPediatrician, async (req, res) => {
  try {
    // Secretary: load appointments for their linked pediatrician.
    // Pediatrician: load their own appointments.
    const pedId = req.user.role === 'secretary'
      ? req.user.linkedPediatricianId
      : req.user.userId;

    if (!pedId) {
      return res.status(403).json({ error: 'Assistant/Secretary account is not linked to a pediatrician yet.' });
    }

    const docs = await Appointment.find({ pediatricianId: pedId }).sort({ appointmentDate: -1, createdAt: -1 }).lean();
    const appointments = [];
    for (const doc of docs) appointments.push(await hydrateAppointment(doc));

    res.json({ success: true, appointments });
  } catch (err) {
    console.error('appointments /pedia error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/appointments/pedia-notifications
// Builds the pedia dashboard request list from appointments.
// Important: secretaries can also call this to see the notification-style request list.
router.get('/pedia-notifications', authMiddleware, secretaryOrPediatrician, async (req, res) => {
  try {
    const pedId = req.user.role === 'secretary'
      ? req.user.linkedPediatricianId
      : req.user.userId;

    if (!pedId) {
      return res.status(403).json({ error: 'Assistant/Secretary account is not linked to a pediatrician yet.' });
    }
    const docs = await Appointment.find({ pediatricianId: pedId }).sort({ createdAt: -1 }).lean();
    const notifications = [];
    for (const doc of docs) {
      const appt = await hydrateAppointment(doc);
      notifications.push({
        id: appt.id,
        appointmentId: appt.id,
        pediatricianId: appt.pediatricianId,
        parentName: appt.parentName,
        childName: appt.childName,
        appointmentDate: appt.appointmentDate,
        appointmentTime: appt.appointmentTime,
        reason: appt.reason,
        hasVideo: appt.hasVideo,
        status: appt.status,
        appointmentStatus: appt.status,
        createdAt: doc.createdAt,
      });
    }

    res.json({ success: true, notifications });
  } catch (err) {
    console.error('appointments /pedia-notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/appointments/create
// Parent books a new appointment.
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { childId, pediatricianId, appointmentDate, appointmentTime, reason, notes, location } = req.body;

    if (!childId || !pediatricianId || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ error: 'Child, pediatrician, date, and time are required.' });
    }

    const child = await Child.findById(childId);
    if (!child) return res.status(404).json({ error: 'Child not found.' });

    const allowed = String(child.parentId) === String(req.user.userId) || await hasPermission(req.user.userId, child._id, 'manageAppointments') || req.user.role === 'admin';
    if (!allowed) return res.status(403).json({ error: 'Access denied.' });

    const parent = await User.findById(req.user.userId);
    const pediatrician = await User.findOne({ _id: pediatricianId, role: 'pediatrician', status: 'active' });

    if (!parent) return res.status(404).json({ error: 'User account not found.' });
    if (!pediatrician) return res.status(404).json({ error: 'Selected pediatrician not found.' });

    const availability = await evaluateAvailability({ pediatrician, appointmentDate, appointmentTime });
    if (!availability.available) {
      return res.status(400).json({ error: availability.message });
    }

    const totalAmount = Number(pediatrician.consultationFee ?? 0);

    // Parents always use the deferred payment flow: book now, pay on a separate page.
    // Secretaries and admins booking on behalf of patients use the legacy upfront-payment path.
    let paymentPlan;
    if (req.user.role === 'parent') {
      paymentPlan = paymentService.buildDeferredPaymentPlan({ totalAmount });
    } else {
      paymentPlan = paymentService.buildInitialPaymentPlan({
        payment: req.body?.payment || null,
        totalAmount,
        actorRole: req.user.role,
        allowAdminOverride: Boolean(req.body?.overridePayment),
      });
    }

    const normalizedRequestedTime = availability.requestedTime || normalizeTimeString(appointmentTime) || appointmentTime;
    const apptDate = normalizeUtcDate(appointmentDate);
    let appt = null;
    let initialPayment = null;

    await paymentService.withPaymentTransaction(async (session) => {
      const created = await Appointment.create([{
        childId: child._id,
        parentId: parent._id,
        pediatricianId: pediatrician._id,
        appointmentDate: apptDate,
        appointmentTime: normalizedRequestedTime,
        reason: reason || 'General checkup',
        notes: notes || null,
        location: location || pediatrician.clinicAddress || pediatrician.clinicName || pediatrician.institution || null,
        status: paymentPlan.appointmentStatus,
        pendingPaymentMode: null,
        ...paymentPlan.paymentFields,
      }], { session });

      appt = created[0];
      if (paymentPlan.shouldRecord) {
        initialPayment = await paymentService.createInitialPayment({
          appointment: appt,
          plan: paymentPlan,
          actor: req.user,
          session,
        });
      }
    });

    const childName = `${child.firstName} ${child.lastName}`;
    const parentName = `${parent.firstName} ${parent.lastName}`;
    const dateStr = fmtDate(appt.appointmentDate);
    const timeStr = fmtTime(appt.appointmentTime);
    const appointmentLabel = appt.status === 'approved' ? 'Confirmed Appointment' : 'Appointment Request';

    await pushNotification(
      pediatrician._id,
      `New ${appointmentLabel}`,
      `${parentName} ${appt.status === 'approved' ? 'booked and paid for' : 'requested'} an appointment for ${childName} on ${dateStr} at ${timeStr}.`,
      'appointment'
    );

    if (appt.status === 'approved') {
      await pushNotification(
        parent._id,
        'Appointment Confirmed',
        `Your appointment for ${childName} on ${dateStr} at ${timeStr} is confirmed. Balance due: ${appt.balanceDue || 0}.`,
        'appointment'
      );
    }

    await sendEmail(
      pediatrician.email,
      `New Appointment Request — ${childName}`,
      `<h2>New Appointment Request</h2>
       <p>Hello Dr. ${pediatrician.firstName} ${pediatrician.lastName},</p>
       <div style="background:white;border-left:4px solid #6B8E6F;padding:16px;border-radius:6px;margin:16px 0;">
         <p><strong>Patient:</strong> ${childName}</p>
         <p><strong>Parent:</strong> ${parentName}</p>
         <p><strong>Date:</strong> ${dateStr}</p>
         <p><strong>Time:</strong> ${timeStr}</p>
         <p><strong>Reason:</strong> ${reason || 'General checkup'}</p>
         <p><strong>Payment:</strong> ${appt.paymentStatus} - paid ${appt.amountPaid || 0} of ${appt.totalAmount || 0}</p>
         ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
       </div>
       <p>Log in to KinderCura to approve or decline this request.</p>`
    );

    res.status(201).json({
      success: true,
      appointmentId: appt.id,
      status: appt.status,
      redirectTo: req.user.role === 'parent' ? `/PARENT/payment.html?appointmentId=${appt.id}` : null,
      payment: paymentService.serializePayment(initialPayment),
      paymentSummary: {
        paymentType: appt.paymentType || null,
        paymentStatus: appt.paymentStatus,
        totalAmount: appt.totalAmount || 0,
        amountPaid: appt.amountPaid || 0,
        balanceDue: appt.balanceDue || 0,
        nextInstallmentDate: appt.nextInstallmentDate || null,
        requiredDownPayment: paymentPlan.requiredDownPayment,
      },
    });
  } catch (err) {
    console.error('appointments create error:', err);
    const status = /payment|amount|fee|installment|minimum|required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// updateAppointmentStatusById — updates the appointment status and sends notifications.
// Important: when secretaryName is provided, it means a secretary (not the pedia) performed
// this action. In that case, we also send a separate notification to the pediatrician so
// they always know what their secretary did on their behalf.
async function updateAppointmentStatusById({ appointmentId, status, notes = null, secretaryName = null, pediatricianId = null }) {
  const appt = await Appointment.findOne({ id: Number(appointmentId) });
  if (!appt) throw new Error('Appointment not found.');

  if (status === 'approved') {
    const paymentCheck = paymentService.canConfirmAppointment(appt);
    if (!paymentCheck.ok) throw new Error(paymentCheck.message);
  }

  if (notes != null && String(notes).trim()) appt.notes = String(notes).trim();
  appt.status = status;
  if (['cancelled', 'rejected'].includes(status)) appt.paymentStatus = 'Cancelled';
  await appt.save();

  sse.broadcast('analytics:update', { type: 'appointment', action: 'update', status });

  const hydrated = await hydrateAppointment(appt.toObject());
  const labelMap = { approved: 'Approved', rejected: 'Rejected', completed: 'Completed', cancelled: 'Cancelled' };
  const label = labelMap[status] || status;
  const pedName = hydrated.pediatricianName ? `Dr. ${hydrated.pediatricianName}` : 'Your Pediatrician';
  const dateStr = fmtDate(hydrated.appointmentDate);
  const timeStr = fmtTime(hydrated.appointmentTime);

  // Always notify the parent about the status change.
  await pushNotification(
    hydrated.parentId,
    `Appointment ${label}`,
    `Your appointment with ${pedName} for ${hydrated.childName} on ${dateStr} at ${timeStr} has been ${label}.`,
    'appointment'
  );

  await sendEmail(
    hydrated.parentEmail,
    `Appointment ${label} — KinderCura`,
    `<h2>Appointment Status Update</h2>
     <p>Hello ${hydrated.parentFirstName || 'Parent'},</p>
     <div style="background:white;border-left:4px solid #6B8E6F;padding:16px;border-radius:6px;margin:16px 0;">
       <p><strong>Patient:</strong> ${hydrated.childName}</p>
       <p><strong>Pediatrician:</strong> ${pedName}</p>
       <p><strong>Date:</strong> ${dateStr}</p>
       <p><strong>Time:</strong> ${timeStr}</p>
       <p><strong>Status:</strong> ${label}</p>
       ${hydrated.reason ? `<p><strong>Reason:</strong> ${hydrated.reason}</p>` : ''}
       ${hydrated.notes ? `<p><strong>Note:</strong> ${hydrated.notes}</p>` : ''}
     </div>
     <p>Please check KinderCura for the latest update.</p>`
  );

  // Important: if a secretary performed this action, notify the pediatrician as well.
  // This keeps the pedia informed of everything the secretary does on their behalf,
  // so they can review, override, or follow up without confusion.
  if (secretaryName && pediatricianId) {
    const pedNotifTitle = `Secretary ${label} an Appointment`;
    const pedNotifMessage = `Secretary ${secretaryName} ${label.toLowerCase()} an appointment for ${hydrated.childName} on ${dateStr} at ${timeStr}.`;
    await pushNotification(pediatricianId, pedNotifTitle, pedNotifMessage, 'appointment');
  }

  return hydrated;
}

// PUT /api/appointments/:appointmentId/status
// Important: both pediatrician and their linked secretary can update appointment status.
router.put('/:appointmentId/status', authMiddleware, clinicStaffOrAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const valid = ['approved', 'rejected', 'completed', 'cancelled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }

    // Resolve which pediatrician ID to check against.
    const pedId = req.user.role === 'admin'
      ? null
      : (req.user.role === 'secretary' ? req.user.linkedPediatricianId : req.user.userId);

    if (req.user.role !== 'admin' && !pedId) {
      return res.status(403).json({ error: 'Assistant/Secretary account is not linked to a pediatrician yet.' });
    }

    // Important: check that the secretary has permission to manage bookings or approve schedules.
    // The pediatrician controls these permissions from their Settings > Staff Access tab.
    let secretaryFullName = null;
    if (req.user.role === 'secretary') {
      const secUser = await User.findById(req.user.userId).select('secretaryPermissions firstName lastName').lean();
      const perms = secUser?.secretaryPermissions || {};
      if (!perms.manageBookings && !perms.approveSchedules) {
        return res.status(403).json({ error: 'You do not have permission to update appointment status.' });
      }
      // Build the secretary name so the pedia notification is readable.
      secretaryFullName = `${secUser?.firstName || ''} ${secUser?.lastName || ''}`.trim() || 'Secretary';
    }

    const apptQuery = { id: Number(req.params.appointmentId) };
    if (pedId) apptQuery.pediatricianId = pedId;
    const appt = await Appointment.findOne(apptQuery);
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });

    if (status === 'approved') {
      const paymentCheck = paymentService.canConfirmAppointment(appt);
      const wantsOverride = Boolean(req.body.overridePayment);
      if (!paymentCheck.ok) {
        if (req.user.role !== 'admin' || !wantsOverride) {
          return res.status(400).json({ error: paymentCheck.message });
        }
        appt.paymentOverride = {
          isOverridden: true,
          overriddenBy: req.user.userId,
          reason: String(req.body.overrideReason || 'Admin payment override').trim(),
          overriddenAt: new Date(),
        };
        await appt.save();
      }
    }

    // Pass secretaryName and pediatricianId so the helper can notify the pedia
    // when a secretary (not the pedia themselves) performs this action.
    await updateAppointmentStatusById({
      appointmentId: appt.id,
      status,
      notes,
      secretaryName: secretaryFullName,       // null when the pedia acts directly
      pediatricianId: pedId || appt.pediatricianId, // used to route the pedia notification
    });
    res.json({ success: true });
  } catch (err) {
    console.error('appointments status error:', err);
    const statusCode = /payment|minimum|paid/i.test(err.message) ? 400 : 500;
    res.status(statusCode).json({ error: err.message });
  }
});

// PUT /api/appointments/pedia-notifications/:id
router.put('/pedia-notifications/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'pediatrician') {
      return res.status(403).json({ error: 'Pediatricians only.' });
    }

    const incoming = req.body.status;
    if (!['approved', 'declined'].includes(incoming)) {
      return res.status(400).json({ error: 'Status must be approved or declined.' });
    }

    const appt = await Appointment.findOne({ id: Number(req.params.id), pediatricianId: req.user.userId });
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });

    const finalStatus = incoming === 'declined' ? 'rejected' : 'approved';
    await updateAppointmentStatusById({ appointmentId: appt.id, status: finalStatus });

    res.json({ success: true, status: incoming });
  } catch (err) {
    console.error('appointments pedia-notifications update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/appointments/:appointmentId/cancel
router.post('/:appointmentId/cancel', authMiddleware, async (req, res) => {
  try {
    const appt = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });

    const isOwner = String(appt.parentId) === String(req.user.userId) || String(appt.pediatricianId) === String(req.user.userId) || await hasPermission(req.user.userId, appt.childId, 'manageAppointments');
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    await updateAppointmentStatusById({ appointmentId: appt.id, status: 'cancelled' });
    res.json({ success: true });
  } catch (err) {
    console.error('appointments cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/appointments/:appointmentId/reschedule
// Important: both the pediatrician and their linked secretary can reschedule.
router.post('/:appointmentId/reschedule', authMiddleware, secretaryOrPediatrician, async (req, res) => {
  try {
    const { newDate, newTime, reason, note } = req.body;
    if (!newDate || !newTime) {
      return res.status(400).json({ error: 'New date and time are required.' });
    }

    // Secretary acts on behalf of their linked pediatrician
    const pedId = req.user.role === 'secretary'
      ? req.user.linkedPediatricianId
      : req.user.userId;

    if (!pedId) {
      return res.status(403).json({ error: 'Assistant/Secretary account is not linked to a pediatrician yet.' });
    }

    // Important: check that the secretary has permission to manage bookings or approve schedules.
    // The pediatrician controls these permissions from their Settings > Staff Access tab.
    if (req.user.role === 'secretary') {
      const secUser = await User.findById(req.user.userId).select('secretaryPermissions').lean();
      const perms = secUser?.secretaryPermissions || {};
      if (!perms.manageBookings && !perms.approveSchedules) {
        return res.status(403).json({ error: 'You do not have permission to update appointment status.' });
      }
    }

    const appt = await Appointment.findOne({ id: Number(req.params.appointmentId), pediatricianId: pedId });
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });

    const pediatrician = await User.findOne({ _id: pedId, role: 'pediatrician', status: 'active' });
    if (!pediatrician) return res.status(404).json({ error: 'Linked pediatrician not found.' });

    const availability = await evaluateAvailability({
      pediatrician,
      appointmentDate: newDate,
      appointmentTime: newTime,
      excludeAppointmentMongoId: appt._id,
    });
    if (!availability.available) {
      return res.status(400).json({ error: availability.message });
    }

    appt.appointmentDate = normalizeUtcDate(newDate);
    appt.appointmentTime = availability.requestedTime || normalizeTimeString(newTime) || newTime;
    appt.status = 'approved';
    if (note && String(note).trim()) appt.notes = String(note).trim();
    await appt.save();

    const hydrated = await hydrateAppointment(appt.toObject());
    const newDateStr = fmtDate(appt.appointmentDate);
    const newTimeStr = fmtTime(appt.appointmentTime);

    // Always notify the parent that the appointment was rescheduled.
    await pushNotification(
      hydrated.parentId,
      'Appointment Rescheduled',
      `Your appointment for ${hydrated.childName} was moved to ${newDateStr} at ${newTimeStr}.`,
      'appointment'
    );

    await sendEmail(
      hydrated.parentEmail,
      'Appointment Rescheduled — KinderCura',
      `<h2>Appointment Rescheduled</h2>
       <p>Hello ${hydrated.parentFirstName || 'Parent'},</p>
       <div style="background:white;border-left:4px solid #6B8E6F;padding:16px;border-radius:6px;margin:16px 0;">
         <p><strong>Patient:</strong> ${hydrated.childName}</p>
         <p><strong>New Date:</strong> ${newDateStr}</p>
         <p><strong>New Time:</strong> ${newTimeStr}</p>
         ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
         ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
       </div>`
    );

    // Important: if a secretary performed the reschedule, also notify the pediatrician.
    // This ensures the pedia can see what was rescheduled on their behalf and review if needed.
    if (req.user.role === 'secretary') {
      // Load the secretary's name for a readable notification message.
      const secUser = await User.findById(req.user.userId).select('firstName lastName').lean();
      const secName = secUser
        ? `${secUser.firstName || ''} ${secUser.lastName || ''}`.trim()
        : 'Secretary';
      await pushNotification(
        pedId,
        'Secretary Rescheduled an Appointment',
        `Secretary ${secName} rescheduled an appointment for ${hydrated.childName} to ${newDateStr} at ${newTimeStr}.`,
        'appointment'
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('appointments reschedule error:', err);
    res.status(500).json({ error: err.message });
  }

});

// GET /api/appointments/:userId
// Parent appointment history list.
router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    const sameUser = String(req.user.userId) === String(req.params.userId);
    if (!sameUser && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const docs = await Appointment.find({ parentId: req.params.userId }).sort({ appointmentDate: -1, createdAt: -1 }).lean();
    const appointments = [];
    for (const doc of docs) appointments.push(await hydrateAppointment(doc));

    res.json({ success: true, appointments });
  } catch (err) {
    console.error('appointments history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Optional general update endpoint still used in some older code.
router.put('/:appointmentId', authMiddleware, async (req, res) => {
  try {
    const appt = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });

    const isOwner = String(appt.parentId) === String(req.user.userId) || String(appt.pediatricianId) === String(req.user.userId) || await hasPermission(req.user.userId, appt.childId, 'manageAppointments');
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { status, notes } = req.body;
    if (status) appt.status = status;
    if (notes !== undefined) appt.notes = notes;
    await appt.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:appointmentId', authMiddleware, async (req, res) => {
  try {
    const appt = await Appointment.findOne({ id: Number(req.params.appointmentId) });
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
    await Appointment.deleteOne({ _id: appt._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
