// Unit tests for the parent-facing Yes / Sometimes / No wording on the Results
// page (routes/assessments.js describeItem / interpretAnswer /
// buildDomainExplanation / buildDomainDetails).
//
// Yes → "Can …", Sometimes → "Still learning to …", No → "Cannot …".
// Scoring (2 / 1 / 0) must stay unchanged.
const assert = require('assert');

const assessmentsRouter = require('../../routes/assessments');
const {
  scoreAnswer, interpretAnswer, describeItem, buildDomainExplanation, buildDomainDetails,
} = assessmentsRouter.__testables;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('parent-results-wording');

test('scoring is unchanged: Yes=2, Sometimes=1, No=0', () => {
  assert.strictEqual(scoreAnswer('yes'), 2);
  assert.strictEqual(scoreAnswer('Yes'), 2);
  assert.strictEqual(scoreAnswer('sometimes'), 1);
  assert.strictEqual(scoreAnswer('no'), 0);
  assert.strictEqual(scoreAnswer(''), 0);
});

test('describeItem builds Can / Still learning to / Cannot from the question', () => {
  const cases = [
    ['Does your child speak using 3-4 word sentences?', 'speak using 3-4 word sentences'],
    ['Does your child tell a simple story?', 'tell a simple story'],
    ['Does your child wash hands properly?', 'wash hands properly'],
  ];
  for (const [q, phrase] of cases) {
    assert.strictEqual(describeItem(q, 'strength'), `Can ${phrase}`);
    assert.strictEqual(describeItem(q, 'developing'), `Still learning to ${phrase}`);
    assert.strictEqual(describeItem(q, 'support'), `Cannot ${phrase}`);
  }
});

test('describeItem shows non-matching questions verbatim', () => {
  assert.strictEqual(describeItem('Child stacks blocks', 'support'), 'Child stacks blocks');
  assert.strictEqual(describeItem('', 'strength'), 'Assessment item not recorded');
});

test('interpretAnswer: parent and pediatrician wording match; levels unchanged', () => {
  assert.deepStrictEqual(interpretAnswer('yes'),
    { score: 2, insight: 'Can do this', parentInsight: 'Can do this', insightLevel: 'positive' });
  assert.deepStrictEqual(interpretAnswer('sometimes'),
    { score: 1, insight: 'Still learning', parentInsight: 'Still learning', insightLevel: 'warning' });
  assert.deepStrictEqual(interpretAnswer('no'),
    { score: 0, insight: 'Cannot do this', parentInsight: 'Cannot do this', insightLevel: 'concern' });
});

test('buildDomainExplanation distinguishes "still learning" from "cannot"', () => {
  assert.strictEqual(buildDomainExplanation({ totalItems: 0, achievedItems: 0, developingItems: 0, concernItems: 0 }),
    'No assessment items were recorded for this area.');
  assert.strictEqual(buildDomainExplanation({ totalItems: 3, achievedItems: 3, developingItems: 0, concernItems: 0 }),
    'Your child can consistently do all 3 assessment items in this area.');
  assert.strictEqual(buildDomainExplanation({ totalItems: 4, achievedItems: 2, developingItems: 0, concernItems: 2 }),
    'Of the 4 assessment items in this area, your child can consistently do 2 and cannot yet do 2.');

  const mixed = buildDomainExplanation({ totalItems: 5, achievedItems: 2, developingItems: 2, concernItems: 1 });
  assert.ok(mixed.startsWith('Of the 5 assessment items in this area, your child can consistently do 2, is still learning 2, and cannot yet do 1.'));
  assert.ok(mixed.includes('"Still learning" means'));

  // Without concernItems (older callers) the "No" count is derived.
  assert.strictEqual(buildDomainExplanation({ totalItems: 3, achievedItems: 0, developingItems: 0 }),
    'Of the 3 assessment items in this area, your child cannot yet do 3.');
});

test('buildDomainDetails routes answers into Can / Still learning / Cannot lists', () => {
  const answers = [
    { domain: 'Communication', questionId: 'Q01', questionText: 'Does your child speak using 3-4 word sentences?', answer: 'yes' },
    { domain: 'Communication', questionId: 'Q02', questionText: 'Does your child tell a simple story?', answer: 'sometimes' },
    { domain: 'Communication', questionId: 'Q03', questionText: 'Does your child wash hands properly?', answer: 'no' },
  ];
  const result = { communicationScore: 50, communicationStatus: 'Developing' };
  const d = buildDomainDetails(answers, result).Communication;

  assert.strictEqual(d.score, 50); // stored score passed through, not recomputed
  assert.deepStrictEqual(d.strengths, ['Can speak using 3-4 word sentences']);
  assert.deepStrictEqual(d.developing, ['Still learning to tell a simple story']);
  assert.deepStrictEqual(d.needsSupport, ['Cannot wash hands properly']);
  assert.deepStrictEqual([d.achievedItems, d.developingItems, d.concernItems], [1, 1, 1]);
  assert.deepStrictEqual(d.items.map((i) => i.insight), ['Can do this', 'Still learning', 'Cannot do this']);
});

test('Sometimes never reads as Cannot / Concern / Red Flag', () => {
  const q = 'Does your child speak using 3-4 word sentences?';
  const texts = [
    describeItem(q, 'developing'),
    interpretAnswer('sometimes').insight,
    interpretAnswer('sometimes').parentInsight,
    buildDomainExplanation({ totalItems: 2, achievedItems: 0, developingItems: 2, concernItems: 0 }),
  ];
  for (const t of texts) assert.ok(!/cannot|concern|red flag/i.test(t), t);
});

test('mixed answers still score the same (2/1/0 sum)', () => {
  const answers = ['yes', 'sometimes', 'no', 'yes', 'sometimes'];
  const points = answers.reduce((n, a) => n + scoreAnswer(a), 0);
  assert.strictEqual(points, 6);
  assert.strictEqual(Math.round((points / (answers.length * 2)) * 100), 60);
});

console.log(`\n${passed} passed`);
