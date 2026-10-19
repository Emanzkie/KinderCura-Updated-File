// Unit tests for GET /api/admin/analytics/average-scores-detail (routes/admin.js).
//
// The endpoint behind "How these averages are calculated" on Admin Reports.
// What is locked in here:
//   - the same filter as /analytics averageScores ($match generatedAt exists);
//   - $avg semantics: a missing/null score is left out of that domain only;
//   - sum, mean and rounded match the plain mean of stored percentages;
//   - no child ids or names leave the server; "Child N" is stable per child;
//   - admin only.
//
// No DB and no network: AssessmentResult.find is an in-memory stand-in.
const assert = require('assert');
const mongoose = require('mongoose');

const AssessmentResult = require('../../models/AssessmentResult');
const router = require('../../routes/admin');
const { buildAverageScoreDetail } = router.__testables;

const oid = () => new mongoose.Types.ObjectId();
const kid1 = oid();
const kid2 = oid();

// Newest first, as the route sorts them.
const results = [
  { childId: kid1, generatedAt: new Date('2026-10-14T03:00:00Z'), communicationScore: 70, socialScore: 83, cognitiveScore: 55, motorScore: 60 },
  { childId: kid2, generatedAt: new Date('2026-10-03T03:00:00Z'), communicationScore: 40, socialScore: null, cognitiveScore: 50, motorScore: 50 },
  { childId: kid1, generatedAt: new Date('2026-05-04T03:00:00Z'), communicationScore: 51, socialScore: 45, cognitiveScore: 63, motorScore: 65 },
];

let lastFilter = null;
AssessmentResult.find = (filter) => {
  lastFilter = filter;
  const chain = { select: () => chain, sort: () => chain, lean: async () => results };
  return chain;
};

function routeStack(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  assert(layer, `route GET ${path} exists`);
  return layer.route.stack.map((s) => s.handle);
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function call(user) {
  const stack = routeStack('/analytics/average-scores-detail');
  const handler = stack[stack.length - 1];
  const gate = stack[stack.length - 2];
  const req = { query: {}, user };
  const res = fakeRes();
  let passed = false;
  await gate(req, res, () => { passed = true; });
  if (passed) await handler(req, res);
  return res;
}

async function testSameFilterAsCards() {
  const res = await call({ userId: String(oid()), role: 'admin' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(lastFilter, { generatedAt: { $exists: true } });
}

function testMeanOfStoredPercentages() {
  const d = buildAverageScoreDetail(results);
  assert.strictEqual(d.totalResults, 3);
  assert.strictEqual(d.distinctChildren, 2);
  // (70 + 40 + 51) / 3 = 53.666… → 53.67, rounded 54
  assert.deepStrictEqual(d.domains.communication, { included: 3, excluded: 0, sum: 161, mean: 53.67, rounded: 54 });
  // null social score is excluded, like $avg: (83 + 45) / 2 = 64
  assert.deepStrictEqual(d.domains.social, { included: 2, excluded: 1, sum: 128, mean: 64, rounded: 64 });
  assert.strictEqual(d.records[1].scores.social, null);
}

function testNoIdsAndStablePseudonyms() {
  const d = buildAverageScoreDetail(results);
  const json = JSON.stringify(d);
  assert.ok(!json.includes(String(kid1)) && !json.includes(String(kid2)), 'child ids never leave the server');
  assert.deepStrictEqual(Object.keys(d.records[0]).sort(), ['childRef', 'generatedAt', 'scores']);
  // kid1's first (oldest) result is numbered first.
  assert.deepStrictEqual(d.records.map((r) => r.childRef), ['Child 1', 'Child 2', 'Child 1']);
}

function testEmpty() {
  const d = buildAverageScoreDetail([]);
  assert.strictEqual(d.totalResults, 0);
  assert.deepStrictEqual(d.domains.motor, { included: 0, excluded: 0, sum: 0, mean: null, rounded: null });
}

async function testAdminOnly() {
  const res = await call({ userId: String(oid()), role: 'pediatrician' });
  assert.strictEqual(res.statusCode, 403);
}

(async () => {
  await testSameFilterAsCards();
  testMeanOfStoredPercentages();
  testNoIdsAndStablePseudonyms();
  testEmpty();
  await testAdminOnly();
  console.log('Admin average-scores detail OK — same filter as the cards, mean of stored %, $avg null handling, no child ids, admin only');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
