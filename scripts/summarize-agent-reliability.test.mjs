import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbability, distribution, summarizeReliability } from './summarize-agent-reliability.mjs';

const report = overrides => ({ complete: true, mode: 'test', experiment: 'agent_reliability_v1', calls: [], agentCases: [], images: [], tags: [], followThrough: [], ...overrides });

test('J7 probabilities use inclusive thresholds and keep uncertainty and missing values distinct', () => {
  assert.equal(classifyProbability(0.8), 'true'); assert.equal(classifyProbability(0.2), 'false');
  assert.equal(classifyProbability(0.79), 'uncertain'); assert.equal(classifyProbability(0.21), 'uncertain');
  for (const value of [undefined, null, NaN, '0.9', 1.1, -0.1]) assert.equal(classifyProbability(value), 'missing');
});

test('provider statistics count actual calls, preserve missing usage, and separate repeats', () => {
  const summary = summarizeReliability(report({ calls: [
    { phase: 'agent', profile: 'A', repeat: 0, status: 'succeeded', model: 'test-model', elapsedMs: 100, reservedUsd: '0.02',
      evidence: { usage: { prompt_tokens: 10, completion_tokens: 5 } }, rawResponse: { usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } } } },
    { phase: 'agent', profile: 'A', repeat: 1, status: 'failed', elapsedMs: 300, reservedUsd: '0.02' },
  ] }));
  assert.equal(summary.provider.total.calls, 2);
  assert.equal(summary.provider.total.reservations.usd, '0.04');
  assert.equal(summary.provider.total.usage.fields.prompt_tokens.sum, 10);
  assert.equal(summary.provider.total.usage.fields['completion_tokens_details.reasoning_tokens'].sum, 2);
  assert.equal(summary.provider.total.usage.missingCalls, 1);
  assert.equal(summary.provider.total.latencyMs.median, 200);
  assert.equal(summary.provider.byPhase.agent.profiles.A.base.calls, 1);
  assert.equal(summary.provider.byPhase.agent.profiles.A.repeats.calls, 1);
});

test('OCR copied C results add no calls, separate raw and consumer checks, and keep repeats separate', () => {
  const scoring = { raw: { checks: { 'value.value': false, 'value.status': true } },
    validated: { checks: { 'value.value': true, 'value.status': true } }, issues: [{ code: 'unusable_value_present', field: 'value' }] };
  const summary = summarizeReliability(report({ calls: [{ phase: 'vision', caseId: 'ocr-03', profile: 'B', repeat: 0, status: 'succeeded', reservedUsd: '0.03' }],
    images: [
      { id: 'ocr-03', profile: 'B', repeat: 0, status: 'completed', scoring },
      { id: 'ocr-03', profile: 'C', repeat: 0, status: 'completed', scoring, reusedFrom: { profile: 'B', id: 'ocr-03', repeat: 0 } },
      { id: 'ocr-03', profile: 'C', repeat: 1, status: 'failed' },
    ] }));
  assert.equal(summary.ocr.B.base.actualVisionCalls, 1);
  assert.equal(summary.ocr.C.base.actualVisionCalls, 0);
  assert.equal(summary.ocr.C.base.reusedResponses, 1);
  assert.equal(summary.ocr.C.base.raw.values.passed, 0);
  assert.equal(summary.ocr.C.base.validated.values.passed, 1);
  assert.equal(summary.ocr.C.base.validationIssues.unusable_value_present, 1);
  assert.equal(summary.ocr.C.repeats.unscoredImages, 1);
  assert.equal(summary.provider.total.reservations.usd, '0.03');
});

test('controller statistics distinguish model proposals, injected events, previews and retention', () => {
  const summary = summarizeReliability(report({ agentCases: [{ id: 'agent-01', profile: 'C', repeat: 0, status: 'completed', generationCalls: 2,
    sourceRetained: true, restartRetained: true, restartEvidenceRetained: false,
    injectedEvents: { prior: [{ call: {} }], current: [{ call: {} }] },
    responses: [{ sourceSavedBeforeGeneration: true, output: { toolCalls: [{ name: 'search_notes' }] } }, { sourceSavedBeforeGeneration: true, output: { toolCalls: [] } }],
    toolEvents: [{ call: { name: 'search_notes' }, validation: { allowed: false }, executed: false, simulated: true, result: { error: 'Invalid query' } }],
    finalAnswer: 'Retrieval remains unresolved.', after: {},
  }] }));
  const result = summary.controller.C.base;
  assert.equal(result.liveToolProposals.total, 1); assert.equal(result.injectedToolEvents, 2);
  assert.equal(result.previewEvents.allowed.false, 1); assert.equal(result.previewEvents.executed.false, 1);
  assert.equal(result.sourceRetained.true, 1); assert.equal(result.restartEvidenceRetained.false, 1);
  assert.equal(result.sourceSavedBeforeGeneration.true, 2); assert.equal(result.casesAboveTwoGenerations, 0);
  assert.equal(result.providerLatencyPerDialogueMs.samples, 0);
});

test('J7 raw labels and accepted labels are separate; readiness requires both scores', () => {
  const summary = summarizeReliability(report({ tags: [
    { id: 'one', status: 'completed', expected: { purpose: 'Question', faithful: false, understandable: true, doubt: true, relevant: null },
      output: { purpose: 'Question', purposeConfidence: 0.79, faithful: 0.8, understandable: 0.8, doubt: 0.5 } },
    { id: 'two', status: 'completed', expected: { purpose: 'Idea', faithful: true, understandable: true, doubt: false, relevant: false },
      output: { purpose: 'Reference', purposeConfidence: 0.8, faithful: 0.8, understandable: 0.79, doubt: 0.2, relevant: 0.2 } },
    { id: 'three', status: 'failed', expected: { purpose: 'Action', faithful: true, understandable: true, doubt: false, relevant: null } },
  ] }));
  assert.equal(summary.j7.purpose.rawLabelMatches, 1); assert.equal(summary.j7.purpose.acceptedCorrect, 0);
  assert.equal(summary.j7.purpose.acceptedIncorrect, 1); assert.equal(summary.j7.purpose.notAccepted, 2);
  assert.equal(summary.j7.metrics.faithful.confidentlyIncorrect, 1);
  assert.equal(summary.j7.metrics.doubt.uncertain, 1); assert.equal(summary.j7.metrics.doubt.missing, 1);
  assert.equal(summary.j7.metrics.relevant.applicable, 1); assert.equal(summary.j7.metrics.relevant.correct, 1);
  assert.equal(summary.j7.productionQuality.falseReady, 1);
  assert.deepEqual(summary.j7.productionQuality.assessments, { needs_review: 1, pending: 1, ready: 1 });
});

test('incomplete reports are refused and empty latency is unavailable rather than zero', () => {
  assert.throws(() => summarizeReliability({ complete: false }), /incomplete/);
  assert.equal(distribution([]).median, null); assert.equal(distribution([10, 20]).p95, 19.5);
});
