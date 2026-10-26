// The ML label belongs to the latest COMPLETED assessment
// (PEDIATRICIAN_BUGS.md #13).
//
// /assessments/pedia-patients read the ML label and review status from the
// child's latest STARTED assessment, while the diagnosis came from the latest
// completed one, and the Diagnosis modal sent the started assessment's id to
// POST /:id/ml-label, which only accepts completed assessments. With a newer
// in-progress reassessment the card showed the wrong label and saving one
// failed with a 400.
//
// No DB, no browser: the route runs against in-memory stubs, and the real page
// script runs in a node vm with a tiny fake DOM.
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
const User = require('../../models/User');
const assessmentsRouter = require('../../routes/assessments');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

const oid = () => new mongoose.Types.ObjectId();
const pediaId = oid();
const parentId = oid();
const childId = oid();
const completedId = oid();
const inProgressId = oid();
const same = (a, b) => String(a) === String(b);
const chain = (value) => {
  const q = {
    select: () => q, sort: () => q, lean: () => q, populate: () => q, limit: () => q,
    then: (a, b) => Promise.resolve(value).then(a, b),
  };
  return q;
};

// A completed screening with a reviewed ML label, and a NEWER unfinished reassessment.
const completed = {
  _id: completedId, childId, status: 'complete', startedAt: new Date('2030-01-01'), completedAt: new Date('2030-01-02'),
  diagnosis: 'Speech delay', reviewedByPediatrician: pediaId,
  mlLabel: { riskCategory: 'High', reviewedBy: pediaId, reviewedAt: new Date('2030-01-03'), notes: 'reviewed' }, mlReviewStatus: 'reviewed',
};
const inProgress = {
  _id: inProgressId, childId, status: 'in_progress', startedAt: new Date('2030-03-01'), mlLabel: null, mlReviewStatus: 'unreviewed',
};

Appointment.find = (f) => chain(same(f.pediatricianId, pediaId)
  ? [{ _id: oid(), id: 1, childId, parentId, pediatricianId: pediaId, status: 'approved', appointmentDate: new Date(), paymentStatus: 'Paid' }] : []);
Child.findById = () => chain({ _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto', dateOfBirth: new Date('2021-01-01'), gender: 'male' });
User.findById = () => chain({ _id: parentId, firstName: 'Emman', lastName: 'D', email: 'parent@example.invalid' });
// Latest started = the in-progress one; latest completed = the labelled one.
Assessment.findOne = (f) => chain(f && f.status === 'complete' ? completed : inProgress);
AssessmentResult.findOne = () => chain({
  communicationScore: 40, socialScore: 50, cognitiveScore: 60, motorScore: 70, overallScore: 55, generatedAt: new Date(),
});

const layer = assessmentsRouter.stack.find((l) => l.route && l.route.path === '/pedia-patients' && l.route.methods.get);
const pediaPatients = layer.route.stack[layer.route.stack.length - 1].handle;
const getPatients = () => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); return this; } };
  Promise.resolve(pediaPatients({ user: { userId: String(pediaId), role: 'pediatrician' }, params: {}, query: {} }, res)).catch(reject);
});
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  // ── Backend: label and diagnosis come from the same assessment ──────────
  const { patients } = await quiet(getPatients);
  const p = patients[0];
  assert.strictEqual(p.mlLabel && p.mlLabel.riskCategory, 'High', 'the card shows the label of the completed assessment');
  assert.strictEqual(p.mlReviewStatus, 'reviewed');
  assert.strictEqual(p.diagnosis, 'Speech delay');
  assert.strictEqual(p.resultAssessmentId, String(completedId), 'resultAssessmentId is the labelled, completed assessment');
  assert.strictEqual(p.assessmentId, String(inProgressId), 'assessmentId keeps its meaning (the latest started)');
  ok('with a newer in-progress reassessment, the card still shows the completed assessment\'s ML label and review status');

  // ── Frontend: the Diagnosis modal is opened for that assessment ─────────
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
  const sandbox = {
    console, URLSearchParams, URL, JSON, Number, String, Promise,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, alert() {}, confirm: () => false,
    localStorage: {
      getItem: (k) => ({ kc_token: 't', kc_user: JSON.stringify({ role: 'pediatrician', firstName: 'Ana', lastName: 'Cruz', id: 'u1' }) }[k] ?? null),
      setItem() {}, removeItem() {}, clear() {},
    },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: { contains: () => true } },
    fetch: () => new Promise(() => {}),
    KC: { poll: () => ({ stop() {} }) },
    addEventListener() {},
    loadNotificationCount: async () => {},
  };
  sandbox.window = sandbox;
  sandbox.location = { origin: 'http://localhost', href: '', search: '' };
  vm.createContext(sandbox);
  for (const file of ['constants/scoring.js', 'js/shared/care-plan-labels.js', 'js/pedia/pediatrician-patients.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox);
  }

  sandbox.__patients = JSON.parse(JSON.stringify(patients));
  vm.runInContext('renderPatients(__patients)', sandbox);
  const html = el('patientsList').innerHTML;
  const diagnosisCall = html.match(/onclick="openDiagnosis\(([^"]*)\)"/);
  assert(diagnosisCall, 'the card has a diagnosis button');
  assert(diagnosisCall[1].includes(`'${completedId}'`), 'the modal is opened for the completed assessment');
  assert(!diagnosisCall[1].includes(String(inProgressId)), 'not for the unfinished reassessment');
  ok('the Diagnosis modal is opened for the completed assessment, so saving an ML label no longer hits the 400');

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\npedia-ml-label-target.test.js: ${results.length} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
