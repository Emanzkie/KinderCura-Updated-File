// Regression test: user-typed text is HTML-escaped in appointment emails
// (routes/appointments.js).
//
// The bug: the booking reason and notes, names, and reschedule reasons/notes
// were inserted raw into email HTML, so a parent could put links, images or
// fake content into the email a pediatrician or parent receives.
//
// No DB and no network: nodemailer's transport is replaced before the route
// loads, so the real email body is captured; models are monkey-patched.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..', '..');
const sent = [];
process.env.EMAIL_USER = 'clinic@example.invalid';
process.env.EMAIL_PASS = 'test-only';
nodemailer.createTransport = () => ({ sendMail: async (msg) => { sent.push(msg); return { messageId: 'm' }; } });

const Appointment = require('../../models/Appointment');
const User = require('../../models/User');
const Child = require('../../models/Child');
const Notification = require('../../models/Notification');
const SystemSetting = require('../../models/SystemSetting');
const paymentService = require('../../services/paymentService');
const router = require('../../routes/appointments');

const ok = (m) => console.log('  ok -', m);
const chain = (value) => {
  const q = { select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q, session: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

const MONDAY = (() => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const parentId = new mongoose.Types.ObjectId();
const pediaId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();
const HOSTILE = '<img src=x onerror="alert(1)">';
const pediatrician = {
  _id: pediaId, role: 'pediatrician', status: 'active', firstName: 'Ana', lastName: 'Cruz', email: 'dr@example.invalid',
  consultationFee: 1000, availability: { days: ['Monday'], startTime: '08:00', endTime: '17:00', maxPatientsPerDay: 50, breaks: [] },
};

SystemSetting.findOneAndUpdate = () => chain({ appointmentSlots: { enforceThirtyMinuteSlots: true } });
Child.findById = () => chain({ _id: childId, parentId, firstName: '<b>Kemri</b>', lastName: 'Soto' });
User.findById = (id) => chain(String(id) === String(pediaId) ? pediatrician
  : { _id: parentId, firstName: 'Emman<script>', lastName: 'D', email: 'p@example.invalid' });
User.findOne = (q) => chain(String(q._id) === String(pediaId) ? pediatrician : null);
Appointment.find = () => chain([]);
Appointment.create = async (docs) => docs.map((d) => ({ ...d, id: 1 }));
Notification.create = async (n) => n;
paymentService.withPaymentTransaction = async (work) => work(null);

const layer = router.stack.find((l) => l.route && l.route.path === '/create' && l.route.methods.post);
const create = layer.route.stack[layer.route.stack.length - 1].handle;

(async () => {
  // 1. A booking with hostile reason, notes and names: the pediatrician's
  //    email shows the text, never live HTML.
  const res = await new Promise((resolve, reject) => {
    const r = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    const { log, warn, error } = console;
    console.log = console.warn = console.error = () => {};
    Promise.resolve(create({
      user: { userId: String(parentId), role: 'parent' },
      body: { childId: String(childId), pediatricianId: String(pediaId), appointmentDate: MONDAY, appointmentTime: '09:00',
        reason: HOSTILE, notes: '<a href="https://evil.example">Click to pay</a>' },
    }, r)).catch(reject).finally(() => Object.assign(console, { log, warn, error }));
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  await new Promise((r) => setImmediate(r)); // the booking email is fire-and-forget
  const mail = sent.find((m) => m.to === 'dr@example.invalid');
  assert.ok(mail, 'pediatrician email captured');
  for (const raw of ['<img', 'onerror="', '<a href', '<b>Kemri', '<script>']) {
    assert.ok(!mail.html.includes(raw), `raw "${raw}" must not reach the email`);
  }
  assert.ok(mail.html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'reason shown as text');
  assert.ok(mail.html.includes('&lt;a href=&quot;https://evil.example&quot;&gt;Click to pay&lt;/a&gt;'), 'notes shown as text');
  assert.ok(mail.html.includes('&lt;b&gt;Kemri&lt;/b&gt; Soto'), 'child name shown as text');
  ok('booking email escapes reason, notes, child and parent names');

  // 2. Static guard: every ${...} inside every appointment email body is
  //    escaped (or a conditional whose inner values are escaped).
  const src = fs.readFileSync(path.join(ROOT, 'routes/appointments.js'), 'utf8');
  const bodies = [...src.matchAll(/sendEmail(?:Within)?\(\s*(?:EMAIL_WAIT_MS,\s*)?[^,]+,\s*(?:`[^`]*`|'[^']*'),\s*`([\s\S]*?)`\s*\)/g)].map((m) => m[1]);
  assert.strictEqual(bodies.length, 4, 'four appointment emails found');
  for (const body of bodies) {
    // Collapse "${cond ? `...${emailText(x)}...` : ''}" so only top-level values remain.
    const topLevel = body.replace(/\$\{[^{}]*\?\s*`[^`]*`\s*:\s*''\}/g, (block) => {
      const inner = [...block.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join('');
      const unescaped = [...inner.matchAll(/\$\{([^}]*)\}/g)].filter((m) => !/^emailText\(/.test(m[1].trim()));
      assert.deepStrictEqual(unescaped.map((m) => m[1]), [], 'conditional block values escaped');
      return '';
    });
    const raw = [...topLevel.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim()).filter((e) => !/^emailText\(/.test(e));
    assert.deepStrictEqual(raw, [], 'every value in an email body goes through emailText()');
  }
  ok('all four appointment email bodies escape every inserted value');

  console.log('\nAppointment email escape tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
