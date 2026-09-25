import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureToolResult, loadReliabilityFixtures, normalizeOcr, scoreOcr } from './reliability-fixtures.mjs';

const fixtures = await loadReliabilityFixtures();
const allowed = { allowed: true };
const tool = (name, args) => ({ id: 'test-call', name, arguments: args });

test('approved corpus counts, repeated cases, budgets and synthetic image bytes are intact', () => {
  const { cases, images, manifest } = fixtures;
  assert.equal(cases.agentCases.length, 8);
  assert.equal(cases.j7Cases.length, 12);
  assert.deepEqual(cases.agentRepeats, ['agent-01', 'agent-06']);
  assert.deepEqual(manifest.repeats, ['ocr-03', 'ocr-04']);
  assert.equal(cases.budget.methods.respond.maxCalls, 104);
  assert.equal(images.length, 6);
  assert.equal(cases.ocrFollowThrough.reduce((sum, entry) => sum + entry.variants.length, 0), 4);
  for (const image of images) {
    assert.equal(image.width, 1280); assert.equal(image.height, 900);
    assert(image.bytes.length <= 500_000);
    const raw = { observations: image.expected.observations.map(({ match, ...observation }) => observation), interpretations: [] };
    const score = scoreOcr(image.expected, JSON.stringify(raw));
    assert(Object.values(score.raw.checks).every(Boolean), image.id);
    assert(Object.values(score.validated.checks).every(Boolean), image.id);
  }
});

test('provider payloads contain opaque IDs and no expected-result or scenario labels', () => {
  const { agentCases, j7Cases } = fixtures.cases;
  for (const entry of [...agentCases, ...j7Cases]) {
    const payload = JSON.stringify(entry.providerInput);
    assert(!payload.includes('"expected"'));
    assert(!payload.includes('"scenario"'));
    assert(!payload.includes(entry.id));
    assert(!payload.includes('Gardening'));
  }
  for (const { providerInput } of j7Cases) {
    assert.equal(providerInput.record.title, 'Saved passage');
    assert.deepEqual(providerInput.record.topics, []);
    assert.deepEqual(providerInput.topicCandidates, []);
    assert.match(providerInput.record.id, /^r-[a-f0-9]{16}$/);
    assert.equal(providerInput.record.purpose, undefined);
  }
});

test('paired J7 fidelity examples have identical source text, title and topic metadata', () => {
  for (let i = 0; i < 4; i++) {
    const good = fixtures.cases.j7Cases[i]; const bad = fixtures.cases.j7Cases[i + 4];
    assert.equal(good.pair, bad.pair);
    assert.equal(good.providerInput.record.segments[0].text, bad.providerInput.record.segments[0].text);
    assert.equal(good.providerInput.record.title, bad.providerInput.record.title);
    assert.deepEqual(good.providerInput.record.topics, bad.providerInput.record.topics);
    assert.equal(good.expected.purpose, bad.expected.purpose);
    assert.equal(good.expected.faithful, true); assert.equal(bad.expected.faithful, false);
    assert.notEqual(good.providerInput.record.summary, bad.providerInput.record.summary);
  }
});

test('new search fixture matches the query instead of returning a universal seeded note', () => {
  const entry = fixtures.cases.agentCases[0];
  const matched = fixtureToolResult(tool('search_notes', { query: 'optical filter' }), allowed, entry);
  const unrelated = fixtureToolResult(tool('search_notes', { query: 'acoustic foam absorption' }), allowed, entry);
  assert.equal(matched.results.length, 1);
  assert.equal(matched.results[0].id, entry.providerInput.notes[0].id);
  assert.deepEqual(unrelated.results, []);
  assert.equal(matched.executed, false); assert.equal(matched.previewOnly, true);
});

test('empty, rejected and failed searches cannot appear as successful no-match searches', () => {
  const entry = fixtures.cases.agentCases[2];
  const empty = fixtureToolResult(tool('search_notes', { query: '' }), allowed, entry);
  assert.equal(empty.allowed, false); assert.equal(empty.results, undefined);
  const rejected = fixtureToolResult(tool('search_notes', { query: 'filter' }), { allowed: false, reason: 'blocked' }, entry);
  assert.equal(rejected.error, 'blocked'); assert.equal(rejected.results, undefined);
  assert.throws(() => fixtureToolResult(tool('search_notes', { query: 'filter comparison setup' }), allowed, entry), /unavailable/);
});

test('corrected-note fixture preserves old observed evidence but search and reads use current text', () => {
  const entry = fixtures.cases.agentCases[5];
  const previous = entry.providerInput.priorToolEvents[0].result.results[0];
  const current = entry.providerInput.notes[0];
  assert.match(previous.original, /20 cm/); assert.equal(previous.revision, 1);
  assert.match(current.text, /40 cm/); assert.equal(current.revision, 2);
  const read = fixtureToolResult(tool('read_note', { id: current.id }), allowed, entry);
  assert.match(read.record.original, /40 cm/);
  assert(!read.record.original.includes('20 cm'));
  const search = fixtureToolResult(tool('search_notes', { query: 'filter comparison' }), allowed, entry);
  assert.match(search.results[0].original, /40 cm/);
});

test('fixture execution blocks web, screenshots and real writes', () => {
  const entry = fixtures.cases.agentCases[0];
  for (const name of ['search_web', 'capture_screen', 'create_note']) {
    const result = fixtureToolResult(tool(name, {}), allowed, entry);
    assert.equal(result.allowed, false); assert.equal(result.executed, false);
    assert.equal(result.saved, undefined);
  }
});

test('unreadable and absent OCR fields have no usable values; contradictory raw values remain reviewable', () => {
  for (const status of ['unreadable', 'absent']) {
    const raw = JSON.stringify({ observations: [{ field: 'value', value: 'K7-41', status }], interpretations: ['Could be a calibration record.'] });
    const normalized = normalizeOcr(raw);
    assert.equal(normalized.raw, raw);
    assert.equal(normalized.parsed.observations[0].value, 'K7-41');
    assert.deepEqual(normalized.observations[0], { field: 'value', value: null, status });
    assert.equal(normalized.valid, false);
    assert.deepEqual(normalized.issues, [{ code: 'unusable_value_present', field: 'value' }]);
    assert.deepEqual(normalized.interpretations, ['Could be a calibration record.']);
  }
});

test('raw OCR extraction and validated consumer values receive distinct scores', () => {
  const expected = { observations: [{ field: 'calibrationValue', value: null, status: 'unreadable' }] };
  const raw = { observations: [{ field: 'calibrationValue', value: 'K7-41', status: 'unreadable' }], interpretations: [] };
  const score = scoreOcr(expected, raw);
  assert.equal(score.raw.checks['calibrationValue.status'], true);
  assert.equal(score.raw.checks['calibrationValue.value'], false);
  assert.equal(score.validated.checks['calibrationValue.value'], true);
  assert.equal(score.normalized.valid, false);
});

test('validation cannot repair confidently misread OCR content or falsely readable hidden fields', () => {
  const expected = { observations: [{ field: 'calibrationValue', value: null, status: 'unreadable' }] };
  const raw = { observations: [{ field: 'calibrationValue', value: 'K7-41', status: 'readable' }], interpretations: [] };
  const score = scoreOcr(expected, raw);
  assert.equal(score.validated.checks['calibrationValue.status'], false);
  assert.equal(score.validated.checks['calibrationValue.value'], false);
  assert.equal(score.normalized.valid, true);
});

test('duplicate fields, invalid statuses and missing values fail closed without erasing raw evidence', () => {
  const raw = { observations: [{ field: 'a', value: 42, status: 'readable' }, { field: 'a', value: 43, status: 'readable' }, { field: 'b', value: 'guessed', status: 'likely' }, { field: 'c', status: 'readable' }], interpretations: [] };
  const normalized = normalizeOcr(raw, ['a', 'b', 'c', 'd']);
  assert.equal(normalized.raw, raw);
  assert(normalized.observations.every((item) => item.value === null));
  assert.deepEqual(normalized.issues.map((item) => item.code), ['duplicate_field', 'invalid_status', 'invalid_value', 'missing_field']);
  assert.equal(normalized.valid, false);
});

test('malformed OCR output does not create usable evidence', () => {
  for (const raw of ['not JSON', '[]', 'null', null]) {
    const result = normalizeOcr(raw);
    assert.equal(result.valid, false); assert.deepEqual(result.observations, []);
    assert.deepEqual(result.issues, [{ code: 'invalid_json_object', field: null }]);
  }
  const result = normalizeOcr({ observations: [{ field: 'a', value: 2, status: 'readable' }], interpretations: [2] });
  assert.equal(result.valid, false); assert.deepEqual(result.interpretations, []);
});

test('directional edge scoring ignores output order but never direction or extra edges', () => {
  const expected = fixtures.images.find((entry) => entry.id === 'ocr-06').expected;
  const observations = expected.observations.map(({ match, ...item }) => ({ ...item, value: [...item.value].reverse() }));
  assert(Object.values(scoreOcr(expected, { observations, interpretations: [] }).raw.checks).every(Boolean));
  observations[1].value[0] = ['Waste', 'Filter'];
  assert.equal(scoreOcr(expected, { observations, interpretations: [] }).raw.checks['directedEdges.value'], false);
});
