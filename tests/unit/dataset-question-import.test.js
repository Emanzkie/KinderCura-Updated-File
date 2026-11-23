// Admin import of Dataset Questions and the pediatrician review that follows:
// services/datasetQuestionImport.js, POST /api/admin/data-origin/
// dataset-questions/import, /api/questions/dataset-review, and the CSV reader
// on the Question Origin page. No DB, no network; real CoreBankQuestion
// documents are built so the model's own validators run.
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

const CoreBankQuestion = require('../../models/CoreBankQuestion');
const AuditLog = require('../../models/AuditLog');
const { adminOnly } = require('../../middleware/auth');
const { normalizeQuestionText } = require('../../services/datasetQuestionImport');
const eligibility = require('../../services/datasetQuestionEligibility');
const adminRouter = require('../../routes/admin');
const questionsRouter = require('../../routes/custom-questions');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);
const clone = (v) => JSON.parse(JSON.stringify(v));
const oid = () => new mongoose.Types.ObjectId();
const PENDING = 'pending_pediatrician_approval';

let db, audit, failInsert = null;
const chain = (v) => { const o = { select: () => o, sort: () => o, lean: async () => clone(v) }; return o; };
const matches = (r, f) => Object.entries(f).every(([k, v]) => String(r[k]) === String(v));
CoreBankQuestion.find = (f) => chain(db.filter((r) => matches(r, f)));
CoreBankQuestion.insertMany = async (docs) => {
  if (failInsert) { db.push(clone(docs[0])); throw failInsert; }
  db.push(...docs.map((d) => clone(d.toObject())));
};
CoreBankQuestion.deleteMany = async (f) => { db = db.filter((r) => !matches(r, f)); };
CoreBankQuestion.deleteOne = async (f) => { const n = db.length; db = db.filter((r) => !matches(r, f)); return { deletedCount: n - db.length }; };
CoreBankQuestion.exists =async (f) => db.find((r) => matches(r, f)) || null;
CoreBankQuestion.findOneAndUpdate = async (f, { $set }) => {
  const row = db.find((r) => matches(r, f));
  return row ? Object.assign(row, $set) : null;
};
CoreBankQuestion.findOne = async (f) => {
  const row = db.find((r) => matches(r, f));
  return row ? Object.assign(CoreBankQuestion.hydrate(clone(row)), { save: async function () { const e = this.validateSync(); if (e) throw e; row.isActive = this.isActive; } }) : null;
};
AuditLog.create = async (e) => { audit.push(e); return e; };

const layerOf = (router, method, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]).route.stack;
async function call(router, method, p, user, { params = {}, body = {} } = {}) {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  for (const { handle } of layerOf(router, method, p)) {
    if (handle.name === 'authMiddleware') continue;
    let next = false;
    await handle({ user, params, body }, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}

const admin = { userId: String(oid()), role: 'admin' };
const pedia = { userId: String(oid()), role: 'pediatrician' };
const IMPORT = '/data-origin/dataset-questions/import';
const source = { sourcedFrom: 'ALSPAC', citation: 'Iles-Caven et al., Wellcome Open Res, 2016', version: '2016' };
const row = (text, p = {}) => ({ text, domain: 'Cognitive', minAgeMonths: 48, generationMethod: 'verbatim_from_source', ...p });
const send = (body, user = admin) => call(adminRouter, 'post', IMPORT, user, { body });
const statuses = (r) => r.body.rows.map((x) => x.status);
function seed() {
  audit = [];
  db = [
    { _id: String(oid()), questionId: 'Q01', text: 'Does your child ride a tricycle?', origin: 'core_bank' },
    { _id: String(oid()), questionId: 'DQ16', text: 'Can your child hop on one foot?', origin: 'dataset_question', approvalStatus: 'rejected' },
  ];
}

async function run() {
  // 1. Access.
  seed();
  assert(layerOf(adminRouter, 'post', IMPORT).some((l) => l.handle === adminOnly));
  for (const role of ['parent', 'pediatrician', 'secretary']) assert.strictEqual((await send({ source, questions: [row('Does your child count to ten?')] }, { role })).statusCode, 403);
  ok('only an admin can import');

  // 2. Dry run: verdict per row, nothing written.
  let r = await send({ dryRun: true, source, questions: [
    row('Does your child count to ten?'),
    row('does your child RIDE a tricycle'),
    row('Can your child hop on one foot'),
    row('Does your child  count to ten'),
    row('Too short'),
    row('Does your child draw a circle?', { domain: 'Language' }),
    row('Does your child name colors?', { minAgeMonths: 35 }),
    row('Does your child name shapes?', { minAgeMonths: '48.5' }),
    row('Does your child name animals?', { minAgeMonths: '' }),
    row('Does your child name foods?', { generationMethod: '' }),
    null,
  ] });
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(statuses(r), ['ok', 'duplicate', 'duplicate', 'duplicate', 'error', 'error', 'error', 'error', 'error', 'error', 'error']);
  assert(r.body.rows[1].message.includes('Q01') && r.body.rows[2].message.includes('DQ16') && r.body.rows[3].message.includes('row 1'));
  assert.strictEqual(r.body.ok, false);
  r = await send({ dryRun: true, source: {}, questions: [row('Does your child count to ten?', { generationMethod: '' }), row('Does your child count to ten'), row('Does your child ride a tricycle?', { domain: '' })] });
  assert.deepStrictEqual(statuses(r), ['error', 'duplicate', 'duplicate'], 'rows are checked without a source; copies of an unfinished row are flagged');
  assert(r.body.sourceError && r.body.ok === false);
  r = await send({ source, questions: [row('Does your child count to ten?')] });
  assert.strictEqual(r.body.dryRun, true, 'saving must be asked for explicitly');
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(db.length, 2);
  assert.strictEqual(audit.length, 0);
  ok('a check flags invalid rows and duplicates (bank, rejected, same file) and writes nothing');

  // 3. Unusable requests.
  for (const bad of [
    { source, questions: [] }, { source, questions: 'x' }, { source, questions: Array(101).fill(row('Does your child count?')) },
    { source: { ...source, citation: ' ' }, questions: [row('Does your child count to ten?')] },
    { source: { ...source, sourcedFrom: '' }, questions: [row('Does your child count to ten?')] },
    { source: null, questions: [row('Does your child count to ten?')] },
  ]) assert.strictEqual((await send({ dryRun: false, ...bad })).statusCode, 400);
  ok('no rows, too many rows, or no source/citation is refused');

  // 4. All or nothing.
  r = await send({ dryRun: false, source, questions: [row('Does your child count to ten?'), row('Too short')] });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(db.length, 2);
  failInsert = Object.assign(new Error('dup'), { code: 11000 });
  r = await send({ dryRun: false, source, questions: [row('Does your child count to ten?'), row('Does your child draw a circle?')] });
  failInsert = null;
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(db.length, 2, 'a half-written batch is removed');
  ok('one bad row or a failed write saves nothing');

  // 5. Save. Client cannot set approval, activation, origin or id.
  r = await send({ dryRun: false, source, questions: [
    row('Does your child count to ten?', { isActive: true, approvalStatus: 'approved', origin: 'core_bank', questionId: 'Q01' }),
    row('Does your child draw a circle?', { domain: 'Motor Skills', minAgeMonths: '36' }),
  ] });
  assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.questionIds, ['DQ101', 'DQ102'], 'clear of the DQ01-DQ99 code catalogue');
  const [a, b] = db.slice(2);
  for (const q of [a, b]) {
    assert.deepStrictEqual([q.origin, q.approvalStatus, q.isActive, q.sourceCitation, q.sourcedFrom, q.sourceVersion, q.importBatchId],
      ['dataset_question', PENDING, false, source.citation, 'ALSPAC', '2016', r.body.importBatchId]);
    assert(q.importedAt);
    assert.strictEqual(q.approvedBy, null);
  }
  assert.deepStrictEqual([b.domain, b.minAgeMonths], ['Motor Skills', 36]);
  assert.deepStrictEqual(audit.map((x) => x.action), ['dataset_questions_imported']);
  r = await send({ dryRun: false, source, questions: [row('Does your child count to ten?')] });
  assert.strictEqual(r.statusCode, 400, 're-importing is a duplicate');
  r = await send({ dryRun: false, source, questions: [row('Does your child name five animals?')] });
  assert.deepStrictEqual(r.body.questionIds, ['DQ103']);
  ok('saved rows are pending, inactive and cited, with new ids');

  // 6. Pediatrician review.
  const LIST = '/dataset-review', ONE = '/dataset-review/:datasetQuestionId';
  const decide = (q, decision, user = pedia) => call(questionsRouter, 'patch', ONE, user, { params: { datasetQuestionId: q._id }, body: { decision } });
  const activate = adminRouter.__testables.setDatasetQuestionActivation;
  const warn = console.error; console.error = () => {};
  for (const role of ['parent', 'admin', 'secretary']) {
    assert.strictEqual((await call(questionsRouter, 'get', LIST, { role })).statusCode, 403);
    assert.strictEqual((await decide(a, 'approve', { role })).statusCode, 403);
  }
  r = await call(questionsRouter, 'get', LIST, pedia);
  assert.deepStrictEqual(r.body.questions.map((x) => x.questionId), ['DQ101', 'DQ102', 'DQ103']);
  assert.strictEqual(r.body.questions[0].sourceCitation, source.citation);
  assert.strictEqual((await activate(a._id, true, admin.userId)).status, 409, 'pending cannot be activated');
  assert.strictEqual((await decide(a, 'maybe')).statusCode, 400);
  assert.strictEqual((await decide({ _id: String(oid()) }, 'approve')).statusCode, 404);
  assert.strictEqual((await decide(db[0], 'approve')).statusCode, 404, 'never a core question');
  r = await decide(a, 'approve');
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual([a.approvalStatus, a.isActive, a.approvedBy], ['approved', false, pedia.userId], 'approval never activates');
  assert.strictEqual((await decide(b, 'reject')).statusCode, 200);
  assert.deepStrictEqual([b.approvalStatus, b.approvedBy, b.approvedAt], ['rejected', null, null], 'a rejection is not a sign-off');
  assert.strictEqual((await decide(a, 'reject')).statusCode, 409, 'decided once');
  assert.strictEqual((await decide(db[1], 'approve')).statusCode, 409);
  console.error = warn;
  assert.deepStrictEqual(audit.map((x) => x.action).slice(-2), ['dataset_question_approved', 'dataset_question_rejected']);
  ok('a pediatrician approves or rejects a pending question once; nobody else can');

  // 7. Activation, then parents (the existing rules).
  const offered = (months) => eligibility.selectForAge(new Map(db.map((q) => [q.questionId, q])), months).map((q) => q.id);
  assert.deepStrictEqual(offered(60), []);
  assert.strictEqual((await activate(b._id, true, admin.userId)).status, 409, 'rejected stays off');
  assert.strictEqual((await activate(a._id, true, admin.userId)).status, 200);
  assert.deepStrictEqual(offered(60), ['DQ101']);
  assert.deepStrictEqual(offered(47), [], 'younger child');
  ok('only an approved and activated question reaches a child old enough');

  // 8. Delete: admin only, an unreviewed import only.
  const DEL = '/data-origin/dataset-questions/:id';
  const del = (id, user = admin) => call(adminRouter, 'delete', DEL, user, { params: { id } });
  const c = db.find((q) => q.questionId === 'DQ103');
  const seeded = { _id: String(oid()), questionId: 'DQ01', text: 'Seeded', origin: 'dataset_question', approvalStatus: PENDING, importBatchId: 'seed-1' };
  db.push(seeded);
  assert.strictEqual((await del(c._id, pedia)).statusCode, 403);
  assert.strictEqual((await del('x')).statusCode, 404);
  assert.strictEqual((await del(db[0]._id)).statusCode, 404, 'never a core question');
  for (const q of [a, b, seeded]) assert.strictEqual((await del(q._id)).statusCode, 409, `${q.questionId} stays`);
  assert.strictEqual((await del(c._id)).statusCode, 200);
  assert.deepStrictEqual(db.map((q) => q.questionId), ['Q01', 'DQ16', 'DQ101', 'DQ102', 'DQ01']);
  assert.strictEqual(audit[audit.length - 1].action, 'dataset_question_deleted');
  ok('an admin can delete an imported question only while it is pending');

  // 9. CSV reader (the page's own code).
  const sandbox = { requireAuth() {}, KC: { user: () => null }, document: { addEventListener() {} }, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/admin/admin-data-sources.js'), 'utf8'), sandbox);
  const parse = (t) => clone(sandbox.dqRowsFromCsv(t));
  let rows = parse('﻿Question,Domain,Min Age Months,Wording_Method\r\n"Does your child say ""hi"", and wave?",motor skills,48,Verbatim\r\n\r\n"Two\nlines",Language,abc,\r\n');
  assert.deepStrictEqual(rows.map((x) => [x.text, x.domain, x.minAgeMonths, x.generationMethod]), [
    ['Does your child say "hi", and wave?', 'Motor Skills', '48', 'verbatim_from_source'], ['Two\nlines', '', 'abc', '']]);
  rows = parse('question;domain;min_age_months\nDoes your child, at home, sing?;Communication;36');
  assert.strictEqual(rows[0].text, 'Does your child, at home, sing?');
  for (const bad of ['', 'question,domain\nx,y', 'question,domain,min_age_months\n', 'question,domain,min_age_months\n"open,Cognitive,48',
    'question,domain,min_age_months\n' + 'a,b,1\n'.repeat(101)]) assert.throws(() => parse(bad));
  assert.strictEqual(normalizeQuestionText('  Niño—can HE  run?'), 'niño can he run');
  ok('the CSV reader handles quotes, blank lines, semicolons and bad files');

  results.forEach((m) => console.log(`  ok - ${m}`));
  console.log(`Dataset question import tests OK — ${results.length} groups`);
}

run().catch((e) => { console.error(e); process.exit(1); });
