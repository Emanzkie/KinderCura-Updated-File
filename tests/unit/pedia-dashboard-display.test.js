// Pediatrician dashboard numbers and labels (PEDIATRICIAN_BUGS.md #26).
//
//   - "Upcoming" compared each appointment's date (a UTC-midnight calendar date)
//     with the current instant, so appointments TODAY were never counted.
//   - The activity feed looked for a 'declined' status, but the API says
//     'rejected', so rejected, completed and cancelled requests all showed as a
//     generic "Activity".
//   - The pending-request card read communicationStatus / socialStatus /
//     cognitiveStatus / motorStatus from the assessment history, which never
//     returned them, so no status text ever appeared next to a domain score.
//
// No DB, no browser: the history route runs against in-memory stubs, and the
// real dashboard script runs in a node vm with a fake DOM and a pinned clock.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const Appointment = require('../../models/Appointment');
const Assessment = require('../../models/Assessment');
const AssessmentResult = require('../../models/AssessmentResult');
const Child = require('../../models/Child');
const GuardianLink = require('../../models/GuardianLink');
const assessmentsRouter = require('../../routes/assessments');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

// ── The history route returns the stored domain statuses ──────────────────
const oid = () => new mongoose.Types.ObjectId();
const parentId = oid();
const childId = oid();
const doneId = oid();
const openId = oid();
const chain = (value) => {
  const q = { select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};
Child.findById = () => chain({ _id: childId, parentId });
GuardianLink.findOne = () => chain(null);
Appointment.exists = async () => null;
Assessment.find = () => chain([
  { _id: openId, childId, status: 'in_progress', startedAt: new Date('2030-03-01') },
  { _id: doneId, childId, status: 'complete', startedAt: new Date('2030-01-01'), completedAt: new Date('2030-01-02') },
]);
AssessmentResult.find = () => chain([{
  assessmentId: doneId, communicationScore: 45, socialScore: 85, cognitiveScore: 65, motorScore: 30, overallScore: 56,
  communicationStatus: 'at-risk', socialStatus: 'on-track', cognitiveStatus: 'developing', motorStatus: 'delayed', generatedAt: new Date(),
}]);
const historyLayer = assessmentsRouter.stack.find((l) => l.route && l.route.path === '/:childId/history' && l.route.methods.get);
const history = historyLayer.route.stack[historyLayer.route.stack.length - 1].handle;

const RealDate = Date;
(async () => {
  const body = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); return this; } };
    Promise.resolve(history({ user: { userId: String(parentId), role: 'parent' }, params: { childId: String(childId) }, query: {} }, res)).catch(reject);
  });
  const done = body.assessments.find((a) => a.id === String(doneId));
  assert.deepStrictEqual(
    [done.communicationStatus, done.socialStatus, done.cognitiveStatus, done.motorStatus],
    ['at-risk', 'on-track', 'developing', 'delayed'],
    'the history now carries the stored domain statuses'
  );
  const open = body.assessments.find((a) => a.id === String(openId));
  assert.strictEqual(open.communicationStatus, null, 'an assessment with no result has none');
  ok('the assessment history returns the stored domain statuses (null when there is no result yet)');

  // ── The real dashboard script ───────────────────────────────────────────
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', textContent: '', innerHTML: '', src: '', href: '', disabled: false, style: {}, dataset: {},
        addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} },
        closest: () => null, querySelector: () => null, querySelectorAll: () => [],
      });
    }
    return els.get(id);
  };
  let notifications = [];
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise, Math, encodeURIComponent, Intl,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, alert() {}, confirm: () => false,
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
      setItem() {}, removeItem() {}, clear() {},
    },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true } },
    fetch: async (url) => {
      const p = new URL(url).pathname;
      let out = {};
      if (p === '/api/appointments/pedia-notifications') out = { notifications };
      else if (p === '/api/appointments/pedia') out = { appointments: [{ id: 1, childId: 'kid1' }] };
      else if (/\/api\/assessments\/.+\/history/.test(p)) out = { assessments: [done].map((a) => ({ ...a, completedAt: '2030-01-02T00:00:00.000Z' })) };
      return { ok: true, status: 200, json: async () => out };
    },
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    loadNotificationCount: async () => {},
  };
  sandbox.window = sandbox;
  sandbox.Date = Date;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/pedia/pediatrician-dashboard.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
  }

  // The vm has its own Date, so pin the clock inside it too.
  const runDashboard = async (localParts) => {
    const pinned = new RealDate(...localParts);
    vm.runInContext(`
      (function () {
        const Real = Date;
        const pinned = ${pinned.getTime()};
        globalThis.Date = class extends Real {
          constructor(...a) { if (a.length === 0) super(pinned); else super(...a); }
          static now() { return pinned; }
        };
      })();
    `, sandbox);
    try { await vm.runInContext('loadDashboard()', sandbox); } finally { vm.runInContext('globalThis.Date = Object.getPrototypeOf(Date)', sandbox); }
  };

  // Local noon on 2030-01-08. Appointment dates are calendar dates at UTC midnight.
  const day = (iso) => `${iso}T00:00:00.000Z`;
  const note = (id, status, date) => ({ id, appointmentId: id, status, appointmentDate: day(date), childName: 'Kemri', parentName: 'Emman', createdAt: '2030-01-07T00:00:00.000Z' });
  notifications = [
    note(1, 'approved', '2030-01-07'),   // yesterday
    note(2, 'approved', '2030-01-08'),   // today
    note(3, 'approved', '2030-01-12'),   // within the week
    note(4, 'approved', '2030-01-15'),   // exactly 7 days out
    note(5, 'approved', '2030-01-16'),   // 8 days out
    note(6, 'pending', '2030-01-09'),    // not approved
    note(7, 'rejected', '2030-01-09'),
    note(8, 'completed', '2030-01-05'),
    note(9, 'cancelled', '2030-01-10'),
  ];
  await runDashboard([2030, 0, 8, 12, 0, 0]);
  assert.strictEqual(el('statUpcoming').textContent, 3, "today's, this week's and the 7th-day appointments count; yesterday's, the 8th day's and unapproved ones do not");
  ok("'Upcoming' counts approved appointments from today through the next 7 days, today's included");

  // The feed shows the newest 6 of the 9; check each status's wording separately.
  notifications = ['pending', 'approved', 'rejected', 'completed', 'cancelled'].map((s, i) => ({
    ...note(20 + i, s, '2030-01-09'), createdAt: `2030-01-0${7 - i}T00:00:00.000Z`,
  }));
  await runDashboard([2030, 0, 8, 12, 0, 0]);
  const feed = el('activityList').innerHTML;
  for (const label of ['Appointment Requested', 'Appointment Approved', 'Appointment Declined', 'Appointment Completed', 'Appointment Cancelled']) {
    assert(feed.includes(label), `the feed says "${label}"`);
  }
  assert(!feed.includes('Activity:'), 'nothing falls back to the generic "Activity"');
  ok('the activity feed labels rejected, completed and cancelled requests instead of "Activity"');

  // ── A pending request shows its domain statuses ─────────────────────────
  notifications = [note(30, 'pending', '2030-01-09')];
  notifications[0].childId = 'kid1';
  await runDashboard([2030, 0, 8, 12, 0, 0]);
  const card = el('pendingList').innerHTML;
  assert(card.includes('Communication: <strong>45%</strong> (At-Risk)'), 'communication status shown');
  assert(card.includes('Social: <strong>85%</strong> (On-Track)'), 'social status shown');
  assert(card.includes('Cognitive: <strong>65%</strong> (Developing)'), 'cognitive status shown');
  assert(card.includes('Motor: <strong>30%</strong> (Delayed)'), 'motor status shown');
  ok('a pending request shows each domain score with its status, as a readable label');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npedia-dashboard-display.test.js: ${results.length} checks passed`);
})().catch((err) => {
  global.Date = RealDate;
  console.error(err);
  process.exit(1);
});
