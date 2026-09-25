import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, renderHarnessMarkdown, summarizeHarness } from './summarize-agent-harness.mjs';

function report() {
  const result = { experiment: 'agent_harness_v1', mode: 'fixture', complete: true, agentCases: [], calls: [], compatibility: [],
    reservedUsd: '1.00', returnedReservationUsd: '0.97', cumulativeReservationUsd: '16.87' };
  for (const profile of ['H0', 'H1', 'H2', 'H3']) for (const modelProfile of ['super', 'ultra']) {
    result.compatibility.push({ profile, modelProfile, status: 'qualified', calls: 2, wallMs: 1000 });
    for (const [repeat, ids] of [[0, ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08']], [1, ['h01', 'h03']]]) for (const id of ids) {
      result.agentCases.push({ id, profile, modelProfile, repeat, status: 'completed', finalAnswer: 'An answer is present; this does not establish correctness.', generationCalls: 1,
        wallMs: 2500, responseWallMs: 1800, sourceRetained: true, restartRetained: true, restartEvidenceRetained: true,
        providerInput: { latestRequest: 'Explain the current note.' }, toolEvents: [], trace: { trace: [] } });
      result.calls.push({ callId: `${id}:${profile}:${modelProfile}:${repeat}:1`, phase: 'agent', caseId: id, profile, modelProfile, repeat,
        status: 'fixture', output: { text: 'answer', toolCalls: [] }, elapsedMs: 1000, reservedUsd: '0.01',
        evidence: { usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } } } });
    }
  }
  result.calls.push({ callId: 'compatibility:H0:super:0:1', phase: 'compatibility', caseId: 'compatibility', profile: 'H0', modelProfile: 'super', repeat: 0,
    status: 'fixture', elapsedMs: 250, reservedUsd: '0.01', output: { text: '73', toolCalls: [] } });
  return result;
}
const review = (id, primary = true) => ({ reviewId: id, primaryOutcome: primary, unsupportedClaims: [], supportedClaims: ['Current note supports the answer.'], constraintsHonored: true, citationsSupported: true, explanation: 'Compared final answer with the current source.' });
const map = (reviewId, id = 'h01', profile = 'H0', modelProfile = 'super', repeat = 0) => ({ reviewId, id, profile, modelProfile, repeat });

test('eight cells preserve independent primary and repeat counts; controller completion is not semantic success', () => {
  const summary = summarizeHarness(report());
  assert.equal(summary.cells.length, 8); assert.equal(summary.cases.length, 80);
  assert.equal(summary.coverage.complete, true);
  for (const cell of summary.cells) {
    assert.equal(cell.primary.expectedCases, 8); assert.equal(cell.repeats.expectedCases, 2);
    assert.equal(cell.primary.controller.completed, 8);
    assert.equal(cell.primary.semantic.evaluatedTrue, 0); assert.equal(cell.primary.semantic.evaluatedFalse, 0);
    assert.equal(cell.primary.semantic.unreviewed, 8); assert.equal(cell.repeats.semantic.unreviewed, 2);
    assert.equal(cell.primary.provider.calls, 8); assert.equal(cell.repeats.provider.calls, 2);
  }
  assert.equal(summary.provider.measured.calls, 80); assert.equal(summary.provider.compatibility.calls, 1);
});

test('blinded reviews join only through the exact runner map; pending is neither pass nor failure', () => {
  const bad = { ...review('blind-b', false), unsupportedClaims: ['Invented measured result.'], constraintsHonored: false };
  const summary = summarizeHarness(report(), { reviews: { reviews: [review('blind-a'), bad, review('blind-c', null), review('blind-repeat')] },
    reviewMap: [map('blind-a'), map('blind-b', 'h02'), map('blind-c', 'h03'), map('blind-repeat', 'h01', 'H0', 'super', 1)] });
  const cell = summary.cells[0];
  assert.equal(cell.primary.semantic.evaluatedTrue, 1); assert.equal(cell.primary.semantic.evaluatedFalse, 1);
  assert.equal(cell.primary.semantic.reviewPending, 1); assert.equal(cell.primary.semantic.unreviewed, 5);
  assert.equal(cell.primary.semantic.unsupportedClaimCount, 1); assert.equal(cell.primary.semantic.casesWithUnsupportedClaims, 1);
  assert.equal(cell.repeats.semantic.evaluatedTrue, 1);
  assert.equal(summary.cases.find(r => r.key === 'h01:H0:super:0').reviewId, 'blind-a');
});

test('answer keywords never become unsupported-claim or success heuristics', () => {
  const input = report(); input.agentCases[0].finalAnswer = 'There are no saved notes. The operation completed.';
  const summary = summarizeHarness(input);
  assert.equal(summary.cells[0].primary.semantic.evaluatedTrue, 0);
  assert.equal(summary.cells[0].primary.semantic.casesWithUnsupportedClaims, 0);
  assert.equal(summary.cells[0].primary.semantic.claimsReviewedCases, 0);
});

test('missing and incompatible cases remain explicit without inventing completed or failed semantic outcomes', () => {
  const input = report(); input.complete = false;
  input.agentCases = input.agentCases.filter(row => row.id !== 'h08' || row.profile !== 'H3' || row.modelProfile !== 'ultra');
  Object.assign(input.agentCases[0], { status: 'incomplete_incompatible', finalAnswer: '', generationCalls: 0 });
  const summary = summarizeHarness(input);
  assert.equal(summary.sourceComplete, false); assert.equal(summary.coverage.complete, false);
  assert.deepEqual(summary.coverage.missing, ['h08:H3:ultra:0']);
  assert.equal(summary.cells[0].primary.controller.statuses.incomplete_incompatible, 1);
  assert.equal(summary.cells[7].primary.controller.statuses.missing, 1);
  assert.equal(summary.cells[7].primary.semantic.unreviewed, 8);
  assert.equal(summary.cases.find(r => r.key === 'h08:H3:ultra:0').sourceRetained, null);
});

test('provider latency, response wall time, whole-case wall time and ledger reservations are distinct', () => {
  const summary = summarizeHarness(report()); const first = summary.cells[0].primary;
  assert.equal(first.provider.elapsedMs.median, 1000);
  assert.equal(first.providerElapsedPerDialogueMs.median, 1000);
  assert.equal(first.controller.responseWallMs.median, 1800);
  assert.equal(first.controller.wholeCaseWallMs.median, 2500);
  assert.equal(summary.run.ledgerReconciledReservationUsd, '1.00');
  assert.equal(summary.run.returnedReservationUsd, '0.97');
  assert.equal(summary.run.cumulativeReservationUsd, '16.87');
  assert.equal(summary.provider.all.reservations.recordedUsd, '0.81');
});

test('usage fields are aggregated once with missing calls retained, without summing components as total tokens', () => {
  const input = report();
  input.calls[0].rawResponse = { usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } };
  delete input.calls[1].evidence;
  const summary = summarizeHarness(input);
  assert.equal(summary.provider.measured.usage.reportedCalls, 79);
  assert.equal(summary.provider.measured.usage.missingCalls, 1);
  assert.equal(summary.provider.measured.usage.fields.prompt_tokens.sum, 20 + 78 * 10);
  assert.equal(summary.provider.measured.usage.fields.total_tokens.sum, 27);
  assert.equal(summary.provider.measured.usage.fields.total_tokens.reportedCalls, 1);
});

test('tool proposals, fresh allowed callbacks, cached reuse, rejection and framework gaps are separate', () => {
  const input = report(); const row = input.agentCases[0]; const call = input.calls[0];
  call.output.toolCalls = ['one', 'two', 'three', 'four'].map(id => ({ id, name: 'read_note', arguments: { id } }));
  row.toolEvents = [{ call: call.output.toolCalls[0], validation: { allowed: true }, executed: false, simulated: true },
    { call: call.output.toolCalls[1], validation: { allowed: false }, executed: false, simulated: true }];
  row.trace.trace = [{ kind: 'tool', call: call.output.toolCalls[2], reused: true }];
  const stats = summarizeHarness(input).cells[0].primary.tools;
  assert.equal(stats.proposed, 4); assert.equal(stats.allowedFreshSimulations, 1);
  assert.equal(stats.blocked, 1); assert.equal(stats.reusedReads, 1);
  assert.equal(stats.proposalCallbackDifference, 1);
  assert.deepEqual(stats.actualExecutionFlags, { true: 0, false: 2, missing: 0 });
});

test('missing latency and retention do not become zeros or successes', () => {
  const input = report(); delete input.calls[0].elapsedMs; delete input.agentCases[0].restartRetained;
  const result = summarizeHarness(input).cells[0].primary;
  assert.equal(result.provider.elapsedMs.samples, 7);
  assert.equal(result.providerElapsedPerDialogueMs.samples, 7);
  assert.deepEqual(result.controller.restartRetained, { true: 7, false: 0, missing: 1 });
  assert.deepEqual(distribution([]), { samples: 0, min: null, median: null, p95: null, max: null, sum: null });
});

test('duplicate case/call/review identities and unmapped reviews cannot silently inflate the score', () => {
  const duplicateCase = report(); duplicateCase.agentCases.push(structuredClone(duplicateCase.agentCases[0]));
  assert.throws(() => summarizeHarness(duplicateCase), /Duplicate case/);
  const duplicateCall = report(); duplicateCall.calls.push(structuredClone(duplicateCall.calls[0]));
  assert.throws(() => summarizeHarness(duplicateCall), /Duplicate provider call/);
  assert.throws(() => summarizeHarness(report(), { reviews: { reviews: [review('x')] }, reviewMap: [] }), /Unmapped review/);
  assert.throws(() => summarizeHarness(report(), { reviews: { reviews: [review('x'), review('x')] }, reviewMap: [map('x')] }), /Duplicate review/);
  assert.throws(() => summarizeHarness(report(), { reviews: { reviews: [] }, reviewMap: [map('x'), map('y')] }), /Duplicate review-map/);
});

test('Markdown lists every primary/repeat scenario with bounded escaped excerpts, not full raw provider output', () => {
  const input = report(); input.agentCases[0].finalAnswer = 'A | B <tag>\n' + 'long '.repeat(500);
  const markdown = renderHarnessMarkdown(summarizeHarness(input));
  assert.equal((markdown.match(/^## h/gm) ?? []).length, 10);
  assert(markdown.includes('h01 — consistency repeat'));
  assert(markdown.includes('A \\| B &lt;tag&gt;'));
  assert(!markdown.includes('long '.repeat(100)));
  assert(markdown.includes('Unreviewed'));
});

test('optional frozen outcome categories are preserved and counted separately from primary booleans', () => {
  const summary = summarizeHarness(report(), { reviews: { reviews: [
    { ...review('one', true), outcomeCategory: 'complete_supported' },
    { ...review('two', false), outcomeCategory: 'safe_unresolved' },
    { ...review('three', false), outcomeCategory: 'incorrect_or_unsupported', unsupportedClaims: ['Wrong figure.'] },
    { ...review('four', false), outcomeCategory: 'provider_or_harness_failure' },
  ] }, reviewMap: [map('one'), map('two', 'h02'), map('three', 'h03'), map('four', 'h04')] });
  assert.deepEqual(summary.cells[0].primary.semantic.outcomeCategories, {
    complete_supported: 1, incorrect_or_unsupported: 1, provider_or_harness_failure: 1, safe_unresolved: 1, unreviewed: 4,
  });
  assert.equal(summary.cells[0].primary.semantic.evaluatedTrue, 1);
  assert.equal(summary.cells[0].primary.semantic.evaluatedFalse, 3);
  assert.throws(() => summarizeHarness(report(), { reviews: { reviews: [{ ...review('bad'), outcomeCategory: 'probably_ok' }] }, reviewMap: [map('bad')] }), /outcomeCategory/);
});
