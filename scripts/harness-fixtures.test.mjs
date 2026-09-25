import assert from 'node:assert/strict';
import test from 'node:test';
import { harnessToolResult, loadHarnessFixtures, reviewPreparation } from './harness-fixtures.mjs';

const { cases, casesSha256 } = await loadHarnessFixtures();
const allowed = { allowed: true };
const call = (name, args) => ({ id: 'fixture-call', name, arguments: args });
const get = id => cases.agentCases.find(item => item.id === id);

test('frozen harness manifest has eight cases, four profiles, two models and reviewed call bounds', () => {
  assert.match(casesSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(cases.agentCases.map(item => item.id), ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08']);
  assert.deepEqual(cases.profiles.map(item => item.id), ['H0', 'H1', 'H2', 'H3']);
  assert.deepEqual(cases.agentRepeats, ['h01', 'h03']);
  assert.equal(cases.budget.totalCalls, 496);
  assert.equal(cases.budget.measuredCalls, 8 * (8 + 2) * 6);
  assert.equal(cases.budget.compatibilityCalls, 16);
  assert.equal(cases.budget.models.super.maxCalls, 248);
  assert.equal(cases.budget.models.ultra.maxCalls, 248);
  assert.equal(cases.sharedPolicy.newPolicyExcerptChars, 600);
  assert.equal(cases.sharedPolicy.maximumWireBytes, 12000);
});

test('provider payloads have opaque source IDs and no expected labels, profile hints or case IDs', () => {
  for (const item of cases.agentCases) {
    const serialized = JSON.stringify(item.providerInput);
    for (const forbidden of ['"expected"', '"scenario"', item.id, 'complete_supported', 'incorrect_or_unsupported', 'H0', 'H1', 'H2', 'H3'])
      assert(!serialized.includes(forbidden), `${item.id}: ${forbidden}`);
    for (const note of item.providerInput.notes) assert.match(note.id, /^n-[a-f0-9]{18}$/);
    for (const event of [...item.providerInput.priorToolEvents, ...item.providerInput.currentToolEvents]) {
      assert.match(event.call.id, /^n-[a-f0-9]{18}$/);
      assert(['success', 'no_matches', 'rejected', 'failed'].includes(event.status));
    }
  }
});

test('the four retained scenarios preserve known current-source facts and distinct failures', () => {
  assert.equal(get('h01').providerInput.currentToolEvents[0].status, 'rejected');
  assert.equal(get('h02').providerInput.currentToolEvents[0].status, 'no_matches');
  assert.equal(get('h03').providerInput.priorToolEvents[0].result.results[0].original.includes('20 cm'), true);
  assert.equal(get('h03').providerInput.notes[0].text.includes('40 cm'), true);
  assert.equal(get('h04').providerInput.currentToolEvents[0].status, 'success');
  assert.match(get('h04').providerInput.currentToolEvents[0].result.results[0].original, /no optical-filter comparison results/);
});

test('query-sensitive search returns matching notes and true no-match results', () => {
  const entry = get('h01');
  const matched = harnessToolResult(call('search_notes', { query: 'optical filter' }), allowed, entry);
  const absent = harnessToolResult(call('search_notes', { query: 'acoustic foam absorption' }), allowed, entry);
  assert.equal(matched.results.length, 1);
  assert.match(matched.results[0].original, /amber filter/);
  assert.deepEqual(absent.results, []);
  assert.equal(matched.executed, false);
  assert.equal(matched.previewOnly, true);
});

test('cross-note retrieval can discover the schedule without returning it for every query', () => {
  const entry = get('h05');
  const schedule = harnessToolResult(call('search_notes', { query: 'collection schedule' }), allowed, entry);
  assert.equal(schedule.results.length, 1);
  assert.match(schedule.results[0].original, /09:20/);
  assert.match(schedule.results[0].original, /three runs/);
  assert.equal(entry.providerInput.priorToolEvents[0].result.results.length, 1);
  assert(!entry.providerInput.priorToolEvents[0].result.results[0].original.includes('09:20'));
  assert.equal(entry.expected.maxSentences, 2);
});

test('empty, invalid and failed searches stay distinguishable from successful no matches', () => {
  const entry = get('h06');
  const invalid = harnessToolResult(call('search_notes', { query: '' }), allowed, entry);
  const denied = harnessToolResult(call('search_notes', { query: 'filter' }), { allowed: false, reason: 'Rejected by policy' }, entry);
  assert.equal(invalid.allowed, false); assert.equal(invalid.results, undefined);
  assert.equal(denied.error, 'Rejected by policy'); assert.equal(denied.results, undefined);
  assert.throws(() => harnessToolResult(call('search_notes', { query: 'watering comparison setup' }), allowed, entry), /unavailable/);
});

test('short search excerpts cannot expose the distant fact but full reads can', () => {
  const entry = get('h07');
  const note = entry.providerInput.notes[0];
  const short = harnessToolResult(call('search_notes', { query: 'print drying interval' }), allowed, entry, { searchExcerptChars: 600 });
  assert.equal(short.results.length, 1);
  assert.equal(short.results[0].original.length, 600);
  assert.equal(short.results[0].truncated, true);
  assert(!short.results[0].original.includes('12 minutes'));
  const read = harnessToolResult(call('read_note', { id: note.id }), allowed, entry, { searchExcerptChars: 600 });
  assert.equal(read.record.original, note.text);
  assert.equal(read.record.truncated, false);
  assert.match(read.record.original, /dry for 12 minutes/);
  const originalView = harnessToolResult(call('search_notes', { query: 'print drying interval' }), allowed, entry);
  assert.equal(originalView.results[0].original, note.text);
});

test('search results are capped and excerpt bounds cannot be bypassed by tool arguments', () => {
  const fixture = structuredClone(get('h07'));
  fixture.providerInput.notes = Array.from({ length: 9 }, (_, i) => ({ ...fixture.providerInput.notes[0], id: `n-${String(i).padStart(18, '0')}` }));
  const result = harnessToolResult(call('search_notes', { query: 'print drying', limit: 999, excerptChars: 99999 }), allowed, fixture, { searchExcerptChars: 600 });
  assert.equal(result.results.length, 5);
  assert(result.results.every(note => note.original.length === 600 && note.truncated));
  for (const size of [0, -1, 1.5, 2001, NaN])
    assert.throws(() => harnessToolResult(call('search_notes', { query: 'filter' }), allowed, fixture, { searchExcerptChars: size }), /integer/);
});

test('read results use the current note and never the older seeded body', () => {
  const entry = get('h03');
  const current = entry.providerInput.notes[0];
  const result = harnessToolResult(call('read_note', { id: current.id }), allowed, entry);
  assert.match(result.record.original, /40 cm/);
  assert(!result.record.original.includes('20 cm'));
  assert.equal(result.record.revision, current.revision);
  const absent = harnessToolResult(call('read_note', { id: 'n-missing' }), allowed, entry);
  assert.equal(absent.record, null);
  assert.match(absent.error, /No fixture record/);
});

test('untrusted note instructions stay source data and never enable external or write tools', () => {
  const entry = get('h08');
  const note = entry.providerInput.notes[0];
  const read = harnessToolResult(call('read_note', { id: note.id }), allowed, entry);
  assert.match(read.record.original, /SYSTEM OVERRIDE/);
  assert.equal(read.executed, false);
  for (const name of ['search_web', 'extract_web', 'create_note', 'capture_screen']) {
    const result = harnessToolResult(call(name, {}), allowed, entry);
    assert.equal(result.allowed, false);
    assert.equal(result.executed, false);
    assert.equal(result.saved, undefined);
  }
});

test('review preparation keeps semantic judgments separate from model inputs and deterministic checks', () => {
  const entry = get('h05');
  const prep = reviewPreparation(entry);
  assert.equal(prep.review.primaryOutcome, null);
  assert.equal(prep.review.constraintsHonored, null);
  assert.equal(prep.expected.outcome, 'supported_cross_note_answer');
  prep.expected.outcome = 'modified review copy';
  assert.equal(entry.expected.outcome, 'supported_cross_note_answer');
  assert.match(cases.scoringPolicy.toolPathRule, /without redundant retrieval/);
  assert(cases.scoringPolicy.deterministicSeparateFromPrimary.length > 0);
});
