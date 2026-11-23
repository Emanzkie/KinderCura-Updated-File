// services/datasetQuestionImport.js
// Admin import of Dataset Questions (Question Origin page): checks an uploaded
// batch and stores it as PENDING, INACTIVE dataset_question rows. A pediatrician
// still has to approve each one (routes/custom-questions.js) and an admin still
// has to activate it (routes/admin.js) before any parent sees it.
//
// Nothing the client sends decides origin, approval or activation.
const crypto = require('crypto');
const CoreBankQuestion = require('../models/CoreBankQuestion');
const { DATA_ORIGIN, APPROVAL_STATUS, GENERATION_METHOD_VALUES } = require('../constants/dataOrigin');
const { SCORING_DOMAINS } = require('../constants/datasetQuestions');

const MAX_ROWS = 100;
const TEXT_MIN = 10;
const TEXT_MAX = 300;
// Ages 3 to 8 — the screening's own range. Minimum age only, like the core bank.
const AGE_MIN_MONTHS = 36;
const AGE_MAX_MONTHS = 96;
// The code catalogue owns DQ01–DQ99 (scripts/seed-dataset-questions.js accepts
// two digits only and rewrites a row by id), so imports start at DQ101: a later
// catalogue question can never overwrite an imported one.
const FIRST_IMPORT_NUMBER = 101;
const BATCH_PREFIX = 'admin-import-'; // marks rows imported here, not by the seed script

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Case, punctuation and spacing do not make a question a different question. */
function normalizeQuestionText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function checkSource(source) {
  const s = source && typeof source === 'object' ? source : {};
  const clean = { sourcedFrom: str(s.sourcedFrom), sourceCitation: str(s.citation), sourceVersion: str(s.version) };
  if (!clean.sourcedFrom || clean.sourcedFrom.length > 150) return { error: 'Enter the dataset or source name (up to 150 characters).' };
  if (clean.sourceCitation.length < 10 || clean.sourceCitation.length > 1000) return { error: 'Enter the full citation of the source (10 to 1000 characters).' };
  if (clean.sourceVersion.length > 150) return { error: 'The version can have up to 150 characters.' };
  return { clean };
}

function checkRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  const text = str(r.text).replace(/\s+/g, ' ');
  const age = r.minAgeMonths === '' || r.minAgeMonths == null ? NaN : Number(r.minAgeMonths);
  if (text.length < TEXT_MIN || text.length > TEXT_MAX) return { error: `The question must have ${TEXT_MIN} to ${TEXT_MAX} characters.` };
  if (!SCORING_DOMAINS.includes(r.domain)) return { error: `Choose a domain: ${SCORING_DOMAINS.join(', ')}.` };
  if (!Number.isInteger(age) || age < AGE_MIN_MONTHS || age > AGE_MAX_MONTHS) {
    return { error: `The minimum age must be a whole number from ${AGE_MIN_MONTHS} to ${AGE_MAX_MONTHS} months.` };
  }
  if (!GENERATION_METHOD_VALUES.includes(r.generationMethod)) return { error: 'Choose how the wording was produced.' };
  return { clean: { text, domain: r.domain, minAgeMonths: age, generationMethod: r.generationMethod } };
}

/**
 * { error } for an unusable request, else { source, sourceError, rows, ok }.
 * Rows are checked even while the source is incomplete. Never writes.
 */
function checkImport({ source, questions } = {}, existing = []) {
  if (!Array.isArray(questions) || !questions.length) return { error: 'There are no questions to import.' };
  if (questions.length > MAX_ROWS) return { error: `Import at most ${MAX_ROWS} questions at a time.` };
  const src = checkSource(source);

  const known = new Map(existing.map((q) => [normalizeQuestionText(q.text), q.questionId]));
  const inFile = new Map();
  const rows = questions.map((q, i) => {
    // Duplicates first, so a copy is reported even while its other fields (or
    // the row it copies) still need fixing.
    const key = normalizeQuestionText(q && q.text);
    if (key && known.has(key)) return { status: 'duplicate', message: `Already in the question bank (${known.get(key)}).` };
    if (key && inFile.has(key)) return { status: 'duplicate', message: `Same question as row ${inFile.get(key)}.` };
    if (key) inFile.set(key, i + 1);
    const { error, clean } = checkRow(q);
    if (error) return { status: 'error', message: error };
    if (!key) return { status: 'error', message: 'The question has no readable text.' };
    return { status: 'ok', message: '', clean };
  });
  return { source: src.clean, sourceError: src.error || null, rows, ok: !src.error && rows.every((r) => r.status === 'ok') };
}

function nextNumber(existing) {
  return existing.reduce((max, q) => {
    const m = /^DQ(\d+)$/.exec(String(q.questionId || ''));
    return m ? Math.max(max, Number(m[1]) + 1) : max;
  }, FIRST_IMPORT_NUMBER);
}

/** Preview (dryRun) or store a batch. All rows are stored, or none. */
async function importDatasetQuestions(payload) {
  // Every stored question counts as a duplicate, whatever its status: a
  // rejected question must not come back as a new one.
  const existing = await CoreBankQuestion.find({}).select('questionId text').lean();
  const checked = checkImport(payload, existing);
  if (checked.error) return { status: 400, body: { error: checked.error } };

  const rows = checked.rows.map(({ status, message }) => ({ status, message }));
  if (payload.dryRun !== false) return { status: 200, body: { dryRun: true, ok: checked.ok, sourceError: checked.sourceError, rows } };
  if (checked.sourceError) return { status: 400, body: { error: checked.sourceError } };
  if (!checked.ok) return { status: 400, body: { error: 'Fix or remove the flagged questions first. Nothing was saved.', rows } };

  const importedAt = new Date();
  const importBatchId = `${BATCH_PREFIX}${importedAt.toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
  const first = nextNumber(existing);
  const docs = checked.rows.map((r, i) => new CoreBankQuestion({
    ...r.clean,
    questionId: `DQ${first + i}`,
    displayDomain: r.clean.domain,
    origin: DATA_ORIGIN.DATASET_QUESTION,
    ...checked.source,
    sourceVersion: checked.source.sourceVersion || null,
    approvalStatus: APPROVAL_STATUS.PENDING,
    isActive: false,
    importedAt,
    importBatchId,
  }));
  for (const doc of docs) await doc.validate();
  try {
    await CoreBankQuestion.insertMany(docs);
  } catch (err) {
    // Two imports at once take the same ids; the unique index lets one win.
    // Remove whatever part of THIS batch got in, so it is all or nothing.
    await CoreBankQuestion.deleteMany({ importBatchId, origin: DATA_ORIGIN.DATASET_QUESTION });
    if (err && err.code === 11000) return { status: 409, body: { error: 'Another import was saved at the same time. Check the questions again and retry.' } };
    throw err;
  }
  return { status: 201, body: { success: true, importBatchId, questionIds: docs.map((d) => d.questionId) } };
}

// Only an admin-imported question nobody has reviewed yet can be deleted. It
// has never been active, so no parent has seen or answered it.
function canDelete(q) {
  return Boolean(q) && q.origin === DATA_ORIGIN.DATASET_QUESTION
    && q.approvalStatus === APPROVAL_STATUS.PENDING
    && String(q.importBatchId || '').startsWith(BATCH_PREFIX);
}

async function deleteImportedQuestion(id) {
  if (!/^[0-9a-fA-F]{24}$/.test(String(id))) return { status: 404, body: { error: 'Dataset Question not found.' } };
  const question = await CoreBankQuestion.findOne({ _id: id, origin: DATA_ORIGIN.DATASET_QUESTION });
  if (!question) return { status: 404, body: { error: 'Dataset Question not found.' } };
  // The status is in the delete filter too: a review in between wins.
  const { deletedCount } = canDelete(question)
    ? await CoreBankQuestion.deleteOne({ _id: id, origin: DATA_ORIGIN.DATASET_QUESTION, approvalStatus: APPROVAL_STATUS.PENDING })
    : { deletedCount: 0 };
  if (!deletedCount) return { status: 409, body: { error: 'Only an imported question that has not been reviewed yet can be deleted.' } };
  return { status: 200, body: { success: true, questionId: question.questionId, text: question.text } };
}

module.exports = { importDatasetQuestions, deleteImportedQuestion, canDelete, checkImport, normalizeQuestionText, MAX_ROWS };
