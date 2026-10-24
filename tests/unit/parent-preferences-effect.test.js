// Regression test: the parent's saved preferences actually take effect.
//
// The bug: Settings saved notification and privacy preferences that nothing
// read. Separately, the optional machine-learning consent asked at sign-up
// (User.consents.mlConsentGiven) was never checked by the admin training
// export, so every pediatrician-reviewed screening became training data.
//
// Now:
//   * "Appointment Emails" (notificationSettings.emailAppointments) decides
//     whether appointment emails reach the parent; in-app notices still go.
//   * "Allow anonymous research participation" IS the sign-up ML consent, and
//     the training export includes a real child's screenings only when the
//     registering parent consented. Synthetic demo records are always kept.
//
// No DB and no network: nodemailer's transport is replaced before the routes
// load, models are monkey-patched, and handlers are called directly.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..', '..');
const sent = [];
process.env.EMAIL_USER = 'clinic@example.invalid';
process.env.EMAIL_PASS = 'test-only';
process.env.EMAIL_API_KEY = '';
process.env.JWT_SECRET = process.env.JWT_SECRET || `unit-test-only-${Math.random()}`;
nodemailer.createTransport = () => ({
  sendMail: async (msg) => { sent.push(msg); return { messageId: 'm' }; },
  verify: async () => true,
});
mongoose.set('bufferCommands', false);

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const AssessmentAnswer = require('../../models/AssessmentAnswer');
const CoreBankQuestion = require('../../models/CoreBankQuestion');
const User = require('../../models/User');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const Payment = require('../../models/Payment');
const Notification = require('../../models/Notification');
const appointmentsRouter = require('../../routes/appointments');
const adminRouter = require('../../routes/admin');
const authRouter = require('../../routes/auth');

const ok = (m) => console.log('  ok -', m);
const chain = (value) => {
  const q = { select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};
const handler = (router, method, p) => {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
  assert(layer, `${method.toUpperCase()} ${p} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
async function call(fn, req) {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { await fn({ params: {}, query: {}, body: {}, ...req }, res); } finally { Object.assign(console, saved); }
  return res;
}

// ── 1. Appointment emails follow the parent's setting ──────────────────────
async function appointmentEmailTests() {
  const parentId = new mongoose.Types.ObjectId();
  const pediaId = new mongoose.Types.ObjectId();
  const childId = new mongoose.Types.ObjectId();
  let emailAppointments = true;
  const notices = [];
  let appt;

  User.findById = (id) => chain(String(id) === String(pediaId)
    ? { _id: pediaId, role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', email: 'dr@example.invalid' }
    : { _id: parentId, firstName: 'Emman', lastName: 'D', email: 'parent@example.invalid', notificationSettings: { emailAppointments } });
  Child.findById = () => chain({ _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto' });
  GuardianLink.findOne = () => chain(null);
  Payment.find = () => chain([]);
  Payment.findOne = () => chain(null);
  Notification.create = async (n) => { notices.push(n); return n; };
  Appointment.findOne = () => chain(appt);

  const cancel = handler(appointmentsRouter, 'post', '/:appointmentId/cancel');
  const fresh = () => {
    appt = { _id: new mongoose.Types.ObjectId(), id: 5, parentId, pediatricianId: pediaId, childId, status: 'pending',
      appointmentDate: new Date('2030-01-07'), appointmentTime: '09:00', paymentStatus: 'Pending Payment', amountPaid: 0 };
    appt.save = async () => appt;
    appt.toObject = () => { const { save, toObject, ...rest } = appt; return { ...rest }; };
  };

  fresh(); sent.length = 0; notices.length = 0; emailAppointments = true;
  let r = await call(cancel, { user: { userId: String(parentId), role: 'parent' }, params: { appointmentId: '5' } });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(sent.some((m) => m.to === 'parent@example.invalid'), 'opted-in parent gets the status email');
  ok('appointment emails reach a parent who left "Appointment Emails" on');

  fresh(); sent.length = 0; notices.length = 0; emailAppointments = false;
  r = await call(cancel, { user: { userId: String(parentId), role: 'parent' }, params: { appointmentId: '5' } });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!sent.some((m) => m.to === 'parent@example.invalid'), 'opted-out parent gets no email');
  assert.ok(notices.some((n) => String(n.userId) === String(parentId)), 'in-app notice still sent');
  ok('an opted-out parent gets no email, but still gets the in-app notice');

  // Every parent-facing appointment email goes through the setting, and the
  // pediatrician page does not report an opted-out parent as a mail failure.
  const src = fs.readFileSync(path.join(ROOT, 'routes/appointments.js'), 'utf8');
  assert.strictEqual((src.match(/parentAppointmentEmailTo\(hydrated\.parentId, hydrated\.parentEmail\)/g) || []).length, 3);
  assert.ok(!/sendEmail\(\s*hydrated\.parentEmail/.test(src), 'no parent email bypasses the setting');
  assert.ok(/emailSkipped/.test(fs.readFileSync(path.join(ROOT, 'js/pedia/pediatrician-dashboard.js'), 'utf8')));
  ok('all three parent appointment emails check the setting; opt-out is not shown as a mail failure');
}

// ── 2. Training export respects the research consent ──────────────────────
async function exportConsentTests() {
  const { buildReviewedAssessmentExportRows } = adminRouter.__testables;
  const label = (rc) => ({ riskCategory: rc, reviewedBy: 'ped1', reviewedAt: new Date('2026-02-01') });
  const assessments = [
    { _id: 'aYes', childId: 'cYes', completedAt: new Date('2026-01-10'), mlLabel: label('Low') },
    { _id: 'aNo', childId: 'cNo', completedAt: new Date('2026-01-11'), mlLabel: label('High') },
    { _id: 'aNever', childId: 'cNever', completedAt: new Date('2026-01-12'), mlLabel: label('Medium') },
    { _id: 'aSynth', childId: 'cSynth', isSynthetic: true, completedAt: new Date('2026-01-13'), mlLabel: label('High') },
  ];
  const children = [
    { _id: 'cYes', parentId: 'pYes', dateOfBirth: new Date('2021-01-01') },
    { _id: 'cNo', parentId: 'pNo', dateOfBirth: new Date('2021-01-01') },
    { _id: 'cNever', parentId: 'pNever', dateOfBirth: new Date('2021-01-01') },
    { _id: 'cSynth', parentId: 'pSynth', dateOfBirth: new Date('2021-01-01') },
  ];
  const users = [
    { _id: 'pYes', consents: { mlConsentGiven: true } },
    { _id: 'pNo', consents: { mlConsentGiven: false } },
    { _id: 'pNever', consents: { mlConsentGiven: null } },
    { _id: 'pSynth', consents: { mlConsentGiven: null } },
  ];
  Assessment.find = () => ({ lean: async () => assessments });
  AssessmentResult.find = () => ({ lean: async () => assessments.map((a) => ({ assessmentId: a._id, communicationScore: 50, socialScore: 50, cognitiveScore: 50, motorScore: 50, overallScore: 50 })) });
  AssessmentAnswer.find = () => ({ lean: async () => [] });
  Child.find = () => ({ select: () => ({ lean: async () => children }) });
  CoreBankQuestion.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [{ questionId: 'Q01' }] }) }) });
  let userFilter = null;
  User.find = (f) => { userFilter = f; return { select: () => ({ lean: async () => users.filter((u) => f._id.$in.includes(u._id) && u.consents.mlConsentGiven === f['consents.mlConsentGiven']) }) }; };

  const { rows, total, skipped } = await buildReviewedAssessmentExportRows();
  assert.deepStrictEqual(rows.map((r) => r._assessmentId).sort(), ['aSynth', 'aYes']);
  assert.strictEqual(total, 2);
  assert.strictEqual(skipped.noConsent, 2);
  assert.strictEqual(userFilter['consents.mlConsentGiven'], true);
  ok('export keeps the consenting parent\'s screening and synthetic records; refused and never-asked are left out');
}

// ── 3. Settings reads and writes the real consent and email setting ───────
async function settingsRoundTripTests() {
  const update = handler(authRouter, 'put', '/update-profile');
  const user = { _id: new mongoose.Types.ObjectId(), firstName: 'A', lastName: 'B', role: 'parent', status: 'active',
    notificationSettings: { emailAppointments: true, inApp: true }, privacySettings: {}, consents: { mlConsentGiven: null } };
  user.set = (p, v) => { const [a, b] = p.split('.'); user[a] = { ...(user[a] || {}), [b]: v }; };
  user.save = async () => user;
  User.findById = async () => user;

  const r = await call(update, {
    user: { userId: String(user._id), role: 'parent' },
    body: { notificationSettings: { emailAppointments: false, marketingEmails: true }, privacySettings: { researchParticipation: true, shareWithProfessionals: false } },
  });
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.strictEqual(user.notificationSettings.emailAppointments, false);
  assert.strictEqual(user.notificationSettings.inApp, true, 'other keys kept');
  assert.ok(!('marketingEmails' in user.notificationSettings), 'removed keys are not stored');
  assert.strictEqual(user.consents.mlConsentGiven, true, 'research toggle writes the sign-up consent');
  assert.ok(user.consents.mlConsentRecordedAt instanceof Date, 'consent change is time-stamped');
  assert.strictEqual(r.body.user.privacySettings.researchParticipation, true, 'and reads it back');
  assert.strictEqual(r.body.user.notificationSettings.emailAppointments, false);
  ok('Settings writes emailAppointments and the sign-up ML consent, and reads them back');

  const html = fs.readFileSync(path.join(ROOT, 'PARENT/settings.html'), 'utf8');
  for (const gone of ['prefAssessmentReminders', 'prefDevelopmentalUpdates', 'prefMarketingEmails', 'prefShareWithProfessionals']) {
    assert.ok(!html.includes(gone), `${gone} removed from Settings`);
  }
  assert.ok(html.includes('id="prefEmailAppointments"') && html.includes('id="prefResearchParticipation"'));
  ok('Settings shows only the two preferences that take effect');
}

(async () => {
  await appointmentEmailTests();
  await exportConsentTests();
  await settingsRoundTripTests();
  console.log('\nParent preference effect tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
