// Pediatrician Patient History (js/pedia/patient-history.js) and its chat
// summary route (GET /api/chat/summary/child/:childId in routes/chat.js).
//
// Builder: every existing record becomes exactly one entry, newest first,
// with its category; records of any other child are dropped; text is escaped
// when rendered. Route: counts and dates only, for this pediatrician's
// approved/completed appointments with the child, and it never marks a
// message read.
//
// No DB, no network: bufferCommands is off and the models are stubbed.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

const Appointment = require('../../models/Appointment');
const ChatMessage = require('../../models/ChatMessage');
const chatRouter = require('../../routes/chat');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── Builder ───────────────────────────────────────────────────────────────
function loadBuilder() {
  const sandbox = { window: {}, console, document: { getElementById: () => ({}) } };
  sandbox.escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/pedia/patient-history.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

const KID = 'childA';
const SIB = 'childB';
const sources = () => ({
  history: [
    { id: 'a1', childId: KID, status: 'complete', startedAt: '2026-03-01T01:00:00Z', completedAt: '2026-03-02T02:00:00Z', overallScore: 57, communicationScore: 50, socialScore: 60, cognitiveScore: 55, motorScore: 62, diagnosis: 'Speech <delay>', recommendations: 'Read daily' },
    { id: 'a2', childId: KID, status: 'complete', startedAt: '2026-11-03T01:00:00Z', completedAt: '2026-11-03T02:00:00Z', overallScore: 79, communicationScore: 78, socialScore: 80, cognitiveScore: 74, motorScore: 82 },
    { id: 'a3', childId: KID, status: 'in_progress', startedAt: '2026-11-10T01:00:00Z', currentProgress: 40 },
    { id: 'x1', childId: SIB, status: 'complete', completedAt: '2026-04-01T00:00:00Z', overallScore: 20, diagnosis: 'SIBLING ASSESSMENT' },
  ],
  followUps: [
    { id: 'p1', childId: KID, createdAt: '2026-10-30T03:00:00Z', fee: 500, requiredAssessments: 10, monitoringDays: 30, state: 'active', completed: 1, remaining: 9, dueDate: '2026-11-29T15:59:59Z', assessments: [{ id: 'a2' }], appointment: { id: 117, date: '2026-11-30T00:00:00.000Z', time: '13:00' } },
  ],
  checkups: {
    checkups: [
      { id: 'c1', childId: KID, checkupDate: '2026-06-12T04:00:00Z', visitType: 'initial_checkup', status: 'monitoring', findings: 'Short phrases', appointmentId: 9005 },
      { id: 'cx', childId: SIB, checkupDate: '2026-06-13T04:00:00Z', visitType: 'initial_checkup', status: 'stable', findings: 'SIBLING CHECKUP' },
    ],
    referrals: [{ id: 'r1', childId: KID, referredAt: '2026-06-15T05:00:00Z', specialty: 'Speech Therapy', reason: 'Evaluate expressive language' }],
  },
  notes: [{ id: 1, mongoId: 'n1', childId: KID, createdAt: '2026-06-20T06:00:00Z', progressStatus: 'improving', note: 'Better eye contact' }],
  appointments: [
    { id: 9005, childId: KID, status: 'completed', appointmentDate: '2026-06-12T00:00:00.000Z', appointmentTime: '14:30', reason: 'Check-up' },
    { id: 9006, childId: KID, status: 'approved', appointmentDate: '2099-01-05T00:00:00.000Z', appointmentTime: '09:00', reason: 'Follow-up Check-up' },
    { id: 9007, childId: KID, status: 'cancelled', appointmentDate: '2026-05-01T00:00:00.000Z', appointmentTime: '10:00' },
    { id: 9100, childId: SIB, status: 'completed', appointmentDate: '2026-06-12T00:00:00.000Z', appointmentTime: '15:00', reason: 'SIBLING VISIT' },
  ],
  questions: [
    { assignmentId: 1, questionSetId: 'qs1', setTitle: 'Speech check', createdAt: '2026-07-01T00:00:00Z', questionText: 'Says 2-word phrases?', answer: 'Yes', answeredAt: '2026-07-02T00:00:00Z' },
    { assignmentId: 2, questionSetId: 'qs1', setTitle: 'Speech check', createdAt: '2026-07-01T00:00:00Z', questionText: 'Points to <objects>?', answer: null },
    { assignmentId: 3, questionSetId: null, createdAt: '2026-08-01T00:00:00Z', questionText: 'Sleeps well?', answer: 'Sometimes', answeredAt: '2026-08-03T00:00:00Z' },
  ],
  chat: [
    { appointmentId: 9005, messageCount: 12, firstMessageAt: '2026-06-10T00:00:00Z', lastMessageAt: '2026-06-21T00:00:00Z' },
    { appointmentId: 9100, messageCount: 3, firstMessageAt: '2026-06-10T00:00:00Z', lastMessageAt: '2026-06-22T00:00:00Z' },
  ],
});

function builderTests() {
  const sb = loadBuilder();
  const now = new Date('2026-11-15T00:00:00Z');
  const entries = sb.buildPatientHistory(sources(), KID, now);
  const keys = Array.from(entries, (e) => e.key);

  // One entry per record of this child; nothing of the sibling's.
  assert.deepStrictEqual(clone(keys).sort(), [
    'appointment:9005', 'appointment:9006', 'appointment:9007', 'assessment:a1', 'assessment:a2', 'assessment:a3',
    'chat:9005', 'checkup:c1', 'note:n1', 'plan:p1', 'questions:set:qs1', 'questions:single:3', 'referral:r1',
  ]);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicates');
  const all = JSON.stringify(clone(entries));
  assert(!all.includes('SIBLING') && !all.includes('9100'), 'sibling records never appear');
  ok('one entry per record of this child, none of a sibling, no duplicates');

  // Newest first; the future appointment is upcoming and at the top.
  const times = Array.from(entries, (e) => new Date(e.date).getTime());
  assert.deepStrictEqual(clone(times), clone(times).sort((x, y) => y - x), 'newest first');
  assert.strictEqual(entries[0].key, 'appointment:9006');
  assert.strictEqual(entries[0].upcoming, true);
  assert.strictEqual(entries.find((e) => e.key === 'appointment:9005').upcoming, false);
  assert.strictEqual(entries.find((e) => e.key === 'appointment:9007').title, 'Appointment Cancelled');
  ok('newest first, future appointment marked upcoming');

  // Categories, including follow-up assessments and grouped questions.
  const cat = (key) => entries.find((e) => e.key === key).category;
  assert.strictEqual(cat('assessment:a2'), 'followup_assessment', 'counted by a follow-up plan');
  assert.strictEqual(cat('assessment:a1'), 'assessment');
  assert.strictEqual(entries.find((e) => e.key === 'assessment:a1').title, 'Assessment completed — overall 57% (At-Risk)');
  assert.strictEqual(entries.find((e) => e.key === 'assessment:a3').title, 'Assessment started — 40% answered');
  assert.strictEqual(cat('checkup:c1'), 'checkup');
  assert.strictEqual(cat('referral:r1'), 'referral');
  assert.strictEqual(cat('plan:p1'), 'followup_plan');
  assert.strictEqual(cat('note:n1'), 'note');
  assert.strictEqual(cat('chat:9005'), 'chat');
  const set = entries.find((e) => e.key === 'questions:set:qs1');
  assert.strictEqual(set.title, '2 questions sent to parent — Speech check · 1 of 2 answered');
  assert.deepStrictEqual(clone(set.details)[1], ['Points to <objects>?', 'Not answered yet']);
  assert.strictEqual(entries.find((e) => e.key === 'chat:9005').title, 'Chat with parent — 12 messages');
  assert(entries.find((e) => e.key === 'appointment:9005').links.some((l) => l.href === '/pedia/pedia-chat?appointmentId=9005'));
  assert(!entries.find((e) => e.key === 'appointment:9007').links.some((l) => l.label === 'Open chat'), 'no chat for a cancelled booking');
  ok('every category is mapped; follow-up assessments tagged; questions grouped by set');

  // Rendering escapes record text.
  const html = sb.renderPatientHistoryEntry(entries.find((e) => e.key === 'assessment:a1'));
  assert(html.includes('Speech &lt;delay&gt;') && !html.includes('Speech <delay>'));
  const qHtml = sb.renderPatientHistoryEntry(set);
  assert(qHtml.includes('Points to &lt;objects&gt;?'));
  ok('record text is escaped when rendered');

  // A source that failed to load (undefined) is simply absent.
  const partial = sources();
  partial.appointments = undefined;
  const without = sb.buildPatientHistory(partial, KID, now);
  assert(!without.some((e) => e.category === 'appointment'));
  assert(without.some((e) => e.key === 'chat:9005') && without.some((e) => e.key === 'chat:9100') === true,
    'with no appointment list, chat conversations are kept as returned (the route already limits them to this child)');
  ok('a failed source leaves the others intact');
}

// ── Chat summary route ────────────────────────────────────────────────────
async function routeTests() {
  const layer = chatRouter.stack.find((l) => l.route && l.route.path === '/summary/child/:childId');
  assert(layer, 'route exists');
  const call = async (user, childId) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const req = { params: { childId }, user };
    for (const { handle } of layer.route.stack) {
      if (handle.name === 'authMiddleware') continue;
      let next = false;
      await handle(req, res, () => { next = true; });
      if (!next) break;
    }
    return res;
  };

  const pedia = String(new mongoose.Types.ObjectId());
  const child = String(new mongoose.Types.ObjectId());
  let findFilter = null;
  let aggregatePipeline = null;
  let updates = 0;
  Appointment.exists = async (f) => (String(f.pediatricianId) === pedia && String(f.childId) === child ? { _id: 1 } : null);
  Appointment.find = (f) => { findFilter = f; return { select: () => ({ lean: async () => [{ id: 9005 }, { id: 9006 }] }) }; };
  ChatMessage.aggregate = async (p) => { aggregatePipeline = p; return [{ _id: 9005, messageCount: 12, firstMessageAt: new Date('2026-06-10'), lastMessageAt: new Date('2026-06-21') }]; };
  ChatMessage.updateMany = async () => { updates += 1; };
  ChatMessage.find = () => { throw new Error('message text must not be read'); };

  const res = await call({ userId: pedia, role: 'pediatrician' }, child);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(clone(res.body.conversations), [{ appointmentId: 9005, messageCount: 12, firstMessageAt: '2026-06-10T00:00:00.000Z', lastMessageAt: '2026-06-21T00:00:00.000Z' }]);
  assert.strictEqual(String(findFilter.pediatricianId), pedia);
  assert.strictEqual(String(findFilter.childId), child);
  assert.deepStrictEqual(findFilter.status, { $in: ['approved', 'completed'] });
  assert.deepStrictEqual(aggregatePipeline[0].$match.appointmentId.$in, [9005, 9006]);
  assert.strictEqual(updates, 0, 'nothing marked read');
  ok('chat summary: counts and dates for this pediatrician\'s live conversations, nothing marked read');

  assert.strictEqual((await call({ userId: String(new mongoose.Types.ObjectId()), role: 'pediatrician' }, child)).statusCode, 403);
  assert.strictEqual((await call({ userId: pedia, role: 'parent' }, child)).statusCode, 403);
  assert.strictEqual((await call({ userId: pedia, role: 'secretary' }, child)).statusCode, 403);
  assert.strictEqual((await call({ userId: pedia, role: 'pediatrician' }, 'not-an-id')).statusCode, 404);
  assert.strictEqual(updates, 0);
  ok('chat summary: unlinked pediatricians, parents and secretaries are refused');
}

(async () => {
  builderTests();
  await routeTests();
  results.forEach((r) => console.log('ok -', r));
  console.log(`\npedia-patient-history: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
