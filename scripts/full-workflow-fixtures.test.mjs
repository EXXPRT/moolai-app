import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureToolResult, loadWorkflowFixtures, scoreOcr } from './full-workflow-fixtures.mjs';

test('frozen workflow has approved hard limits and three intact synthetic OCR fixtures', async () => {
  const { cases, images } = await loadWorkflowFixtures();
  assert.equal(cases.routes.length, 25);
  assert.equal(new Set(cases.routes.map((item) => item.id)).size, cases.routes.length);
  assert.equal(cases.budget.methods.route.maxCalls, 48);
  assert.equal(cases.budget.methods.respond.maxCalls, 8);
  for (const image of images) assert(Object.values(scoreOcr(image.expected, JSON.stringify(image.expected)).checks).every(Boolean));
});

test('OCR scoring rejects fabricated masked values, incorrect case, and extra graph edges', () => {
  assert.equal(scoreOcr({ calibration_value: null }, '{"calibration_value":"REDACTED"}').checks.calibration_value, false);
  assert.equal(scoreOcr({ equation_ascii: 'c1*V1=c2*V2' }, '{"equation_ascii":"C1*v1=C2*v2"}').checks.equation_ascii, false);
  assert.equal(scoreOcr({ edges: [['A', 'B']] }, '{"edges":[["A","B"],["B","C"]]}').checks.edges, false);
  assert.equal(scoreOcr({}, 'Not JSON').checks.jsonObject, false);
});

test('preview note creation never claims successful saving or returns a real record ID', () => {
  const result = fixtureToolResult({ name: 'create_note', arguments: { title: 'Test', text: 'Synthetic' } }, { allowed: true });
  assert.equal(result.executed, false);
  assert.equal(result.saved, false);
  assert.equal('id' in result, false);
  assert.equal(fixtureToolResult({ name: 'capture_screen' }, { allowed: false, reason: 'No consent' }).allowed, false);
});
