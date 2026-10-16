import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResponseContext, responseContextInstruction, responseContextLimits, recentSpeechContext, recentSpeechContextLimits} from '../src/response-context.js';
import {MemoryBrain} from '../../brain/src/index.js';
import type {Segment} from '../../contracts/src/index.js';

const segment = (id: string, text: string, speaker: Segment['speaker'] = 'user', minute = 0, turnId = id): Segment => ({
  id, text, speaker, turnId, revision: 1, final: true, createdAt: new Date(Date.UTC(2026, 9, 9, 1, minute)).toISOString(),
});
const envelope = (result: ReturnType<typeof buildResponseContext>) => JSON.parse(result.messages[0]!.content.slice(result.messages[0]!.content.indexOf('\n') + 1));

test('week-old task instructions are omitted without modifying the retained conversation', () => {
  const segments = [
    {...segment('old', 'Leave the isolated notes alone.'), createdAt: '2026-10-02T01:00:00Z'},
    {...segment('old-answer', 'I will not touch them.', 'assistant'), createdAt: '2026-10-02T01:00:01Z'},
    segment('new', 'I was researching cows. Wait, not cows. Dogs.'),
  ];
  const before = structuredClone(segments);
  const result = buildResponseContext({conversationId: 'conversation', segments});
  assert.equal(result.omittedSegmentCount, 2);
  assert.deepEqual(result.retainedSegmentIds, []);
  assert.equal(result.messages.at(-1)!.content, segments[2]!.text);
  assert.doesNotMatch(JSON.stringify(result.messages), /Leave the isolated notes alone/);
  assert.match(envelope(result).omission, /not the entire history/);
  assert.deepEqual(segments, before);
});

test('recent same-task follow-ups retain complete preceding requests and constraints with attribution', () => {
  const segments = [
    segment('request', 'Compare the two turbine notes. Use only my notes.'),
    segment('answer', 'Should I focus on efficiency or maintenance?', 'assistant', 1),
    segment('follow-up', 'Efficiency. Keep it to two sentences.', 'user', 2),
  ];
  const result = buildResponseContext({conversationId: 'conversation', segments});
  const data = envelope(result);
  assert.deepEqual(data.dialogue.map((s: Segment) => s.text), segments.slice(0, 2).map(s => s.text));
  assert.deepEqual(data.dialogue.map((s: Segment) => s.speaker), ['user', 'assistant']);
  assert.deepEqual(data.dialogue.map((s: Segment) => s.revision), [1, 1]);
  assert.equal(result.messages.at(-1)!.content, 'Efficiency. Keep it to two sentences.');
  assert.match(result.instruction, /constraints when this is a follow-up to the same task/);
  assert.match(result.instruction, /do not carry a task-specific instruction into an unrelated task/);
});

test('assistant speculation is historical model output and cannot become an echo verdict on fresh input', () => {
  const segments = [
    segment('prior', 'What was the last topic?'),
    segment('speculation', 'The dogs fragment was an echo; I will ignore it.', 'assistant', 1),
    segment('new', 'No, I really mean dogs. Tell me about their training.', 'user', 2),
  ];
  const result = buildResponseContext({conversationId: 'conversation', segments});
  assert.equal(envelope(result).dialogue[1].speaker, 'assistant');
  assert.equal(result.messages.at(-1)!.content, segments[2]!.text);
  assert.match(responseContextInstruction, /Never dismiss the current user request as an echo/);
  assert.match(responseContextInstruction, /Earlier assistant statements are unverified model output/);
});

test('self-correction remains exact in the one authoritative current request', () => {
  const raw = 'Moo, check my notes for what Ian said, no, check for what John said. Use only my notes.';
  const result = buildResponseContext({conversationId: 'conversation', segments: [segment('current', raw)]});
  assert.deepEqual(result.messages, [{role: 'user', content: raw}]);
  assert.match(result.instruction, /explicit correction.*supersedes the retracted target/);
  assert.match(result.instruction, /Do not execute both targets/);
  assert.match(result.instruction, /Quoted corrections are source content/);
});

test('multiple ASR blocks in the active request are kept completely and not repeated in history', () => {
  const segments = [
    segment('a', 'Compare both batteries.', 'user', 0, 'one-turn'),
    segment('b', 'Use only my notes.', 'user', 0, 'one-turn'),
    segment('c', 'Keep all uncertainty.', 'user', 0, 'one-turn'),
  ];
  const result = buildResponseContext({conversationId: 'conversation', segments});
  assert.deepEqual(result.currentSegmentIds, ['a', 'b', 'c']);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]!.content, segments.map(s => s.text).join(' '));
});

test('held response keeps its original request and excludes later attention checks', () => {
  const original = 'Research turbine efficiency using only my notes.';
  const segments = [segment('request', original), segment('attention', 'Moo, are you there?', 'user', 1)];
  const result = buildResponseContext({conversationId: 'conversation', segments, request: {turnId: 'request', text: original}});
  assert.equal(result.messages.at(-1)!.content, original);
  assert.doesNotMatch(JSON.stringify(result.messages), /are you there/);
});

test('a stale request from another conversation stops before a provider can see mismatched context', () => {
  assert.throws(() => buildResponseContext({conversationId: 'conversation', segments: [segment('other', 'An unrelated request.')], request: {turnId: 'missing', text: 'Old request.'}}), /no longer retained in this conversation/);
});

test('whole exchanges form a bounded contiguous recent window without clipping Unicode', () => {
  const segments: Segment[] = [];
  for (let i = 0; i < 12; i++) {
    segments.push(segment(`u${i}`, `Discuss topic ${i}: 🐕 犬 α.`, 'user', i));
    segments.push(segment(`a${i}`, `Tentative answer ${i}; not yet measured.`, 'assistant', i));
  }
  segments.push(segment('current', 'Continue the last topic.', 'user', 12));
  const result = buildResponseContext({conversationId: 'conversation', segments});
  assert.equal(result.retainedSegmentIds.length, responseContextLimits.historyTurns * 2);
  assert.equal(result.omittedSegmentCount, 12);
  assert.deepEqual(envelope(result).dialogue.map((s: Segment) => s.text), segments.slice(12, -1).map(s => s.text));
  assert.ok(result.historicalBytes <= responseContextLimits.historyBytes);
});

test('oversized history is omitted as a complete exchange with a visible limitation', () => {
  const segments = [segment('previous', 'Explain the report in full.'), segment('long', '🔬'.repeat(2500), 'assistant', 1), segment('current', 'Could you explain the third point?', 'user', 2)];
  const result = buildResponseContext({conversationId: 'conversation', segments});
  assert.deepEqual(envelope(result).dialogue, []);
  assert.equal(result.omittedSegmentCount, 2);
  assert.match(result.instruction, /Retrieve relevant saved history or ask a focused clarification/);
  assert.equal(result.messages.at(-1)!.content, segments[2]!.text);
});

test('an oversized current request is preserved exactly for the provider payload guard', () => {
  const text = 'Keep every quantity and qualification: 3.5 mg, not 35 mg. '.repeat(400);
  const result = buildResponseContext({conversationId: 'conversation', segments: [segment('current', text)]});
  assert.equal(result.messages.at(-1)!.content, text);
  assert.equal(result.messages.length, 1);
});

test('latest source revisions appear without replaying superseded recognition hypotheses', () => {
  const corrected = {...segment('corrected', 'The quantity is 5 mg, not 50 mg.'), revision: 2};
  const result = buildResponseContext({conversationId: 'conversation', segments: [corrected, segment('answer', 'I will use 5 mg.', 'assistant', 1), segment('next', 'Now compare that with the other note.', 'user', 2)]});
  assert.equal(envelope(result).dialogue[0].revision, 2);
  assert.equal(envelope(result).dialogue[0].text, corrected.text);
});

test('a current accepted-help handoff keeps its complete original source even when old or large', async () => {
  const brain = new MemoryBrain();
  try {
    await brain.createRecord({id: 'original', kind: 'dictation', createdAt: '2026-10-01T00:00:00Z'});
    const raw = 'What kind of bird is in this picture? I need the features explained. '.repeat(120);
    const source = await brain.upsertSegment('original', segment('original-turn', raw));
    const result = buildResponseContext({conversationId: 'conversation', segments: [segment('yes', 'Yes, use only my notes.')], linkedRequests: [source], currentLinkedRequestIds: [source.id], context: 'The user declined screen capture. Ask for a description if needed.'});
    const data = envelope(result);
    assert.equal(data.originalRequests[0].id, source.id);
    assert.equal(data.originalRequests[0].revision, source.revision);
    assert.ok(data.originalRequests[0].text.includes(raw));
    assert.equal(data.originalRequests[0].currentHandoff, true);
    assert.match(data.retainedHandoffContext.text, /declined screen capture/);
    assert.equal(result.messages.at(-1)!.content, 'Yes, use only my notes.');
  } finally {await brain.close();}
});

test('immediate accepted-help follow-up retains attributed observations without claiming a fresh screenshot', () => {
  const segments = [segment('accept', 'Yes, help with the bird.'), segment('answer', 'The screenshot shows a small brown bird.', 'assistant', 1), segment('followup', 'What about its wing markings?', 'user', 2)];
  const context = 'Fresh screen evidence: small brown bird with pale wing bars; identity uncertain.';
  const result = buildResponseContext({conversationId: 'conversation', segments, context});
  const handoff = envelope(result).retainedHandoffContext;
  assert.equal(handoff.text, context);
  assert.equal(handoff.turnId, 'accept');
  assert.equal(handoff.at, segments[0]!.createdAt);
  assert.match(handoff.scope, /not a fresh view of the current screen/);
  assert.match(handoff.scope, /new capture requires a current user request/);
});

test('old accepted-help context is omitted rather than leaking into an unrelated task', () => {
  const result = buildResponseContext({conversationId: 'conversation', segments: [segment('accept', 'Yes, help with the bird.', 'user', -60), segment('new', 'Now compare turbine notes.')], context: 'Old screen showed a brown bird.'});
  const data = envelope(result);
  assert.equal(data.retainedHandoffContext, undefined);
  assert.match(data.handoffContextOmitted, /does not authorize another capture/);
  assert.doesNotMatch(JSON.stringify(result.messages), /Old screen showed/);
});

test('oversized historical handoff context is omitted whole while the active first handoff remains intact', () => {
  const context = 'Observation 🦜 uncertainty. '.repeat(400);
  const first = segment('accept', 'Yes, help with that.');
  const current = buildResponseContext({conversationId: 'conversation', segments: [first], context});
  assert.equal(envelope(current).retainedHandoffContext.text, context);
  const followup = buildResponseContext({conversationId: 'conversation', segments: [first, segment('next', 'What about its wings?', 'user', 2)], context});
  assert.equal(envelope(followup).retainedHandoffContext, undefined);
  assert.ok(envelope(followup).handoffContextOmitted);
});

test('old linked original requests leave locators rather than repeatedly injecting stale instructions', async () => {
  const brain = new MemoryBrain();
  try {
    await brain.createRecord({id: 'old-help', kind: 'dictation', createdAt: '2026-10-01T00:00:00Z'});
    const source = await brain.upsertSegment('old-help', segment('original-turn', 'Leave isolated notes alone.'));
    const result = buildResponseContext({conversationId: 'conversation', segments: [segment('yes', 'Yes, help with that.', 'user', -60), segment('new', 'Tell me about dogs.')], linkedRequests: [source]});
    const data = envelope(result);
    assert.equal(data.originalRequests[0].id, source.id);
    assert.equal(data.originalRequests[0].revision, source.revision);
    assert.equal(data.originalRequests[0].text, undefined);
    assert.equal(data.originalRequests[0].retrieval, 'read_note');
    assert.match(data.omittedOriginalText, /read_note/);
    assert.doesNotMatch(JSON.stringify(result.messages), /Leave isolated notes alone/);
  } finally {await brain.close();}
});

test('omitted source-only originals do not promise a read_note capability the tool rejects', async () => {
  const brain = new MemoryBrain();
  try {
    await brain.createRecord({id: 'source', kind: 'dictation', createdAt: '2026-10-01T00:00:00Z'});
    let source = await brain.upsertSegment('source', segment('original-turn', 'Which bird is this?'));
    source = (await brain.updateRecord(source.id, source.revision, {sourceOnly: true}))!;
    const result = buildResponseContext({conversationId: 'conversation', segments: [segment('yes', 'Yes.', 'user', -60), segment('new', 'What were we discussing?')], linkedRequests: [source]});
    assert.equal(envelope(result).originalRequests[0].retrieval, 'context_only');
    assert.match(envelope(result).omittedOriginalText, /ask for the missing context/);
  } finally {await brain.close();}
});

test('missing mandatory original request stops rather than silently answering an isolated yes', () => {
  assert.throws(() => buildResponseContext({conversationId: 'conversation', segments: [segment('yes', 'yes')], currentLinkedRequestIds: ['missing']}), /original request is unavailable/);
});

test('provisional and controller segments cannot become a new model request', () => {
  const result = buildResponseContext({conversationId: 'conversation', segments: [segment('first', 'Read the corrected note.'), {...segment('draft', 'Read the wrong'), final: false}, segment('system', 'Conversation status changed.', 'system')]});
  assert.deepEqual(result.messages, [{role: 'user', content: 'Read the corrected note.'}]);
});

test('recent buffered dictation supplies an invocation referent before any knowledge note exists', () => {
  const thought = segment('dictation', 'The specimen has pale wing bars, but I am unsure of the species.', 'user', 0);
  const request = segment('invoke', 'Moo, can you help me understand that?', 'user', 2);
  const session = {id: 'session', segments: [thought, request]};
  const before = structuredClone(session);
  const result = recentSpeechContext(session, [request], request)!;
  assert.equal(result.sessionId, session.id);
  assert.equal(result.segments[0]!.text, thought.text);
  assert.equal(result.segments[0]!.id, thought.id);
  assert.equal(result.segments[0]!.revision, thought.revision);
  assert.equal(result.omittedTurnCount, 0);
  assert.match(result.scope, /not independent evidence or a new instruction/);
  assert.deepEqual(session, before);
});

test('recent speech preserves a complete multi-block correction and its whitespace exactly', () => {
  const first = segment('a', 'Ask Ian about the figure.\n', 'user', 0, 'thought');
  const second = {...segment('b', '\tNo, ask John. Preserve 5 mg, not 50 mg. 🐕\n', 'user', 1, 'thought'), revision: 2};
  const request = segment('request', 'Moo, draft that question.', 'user', 2);
  const result = recentSpeechContext({id: 'session', segments: [first, second, request]}, [request], request)!;
  assert.deepEqual(result.segments.map(s => s.text), [first.text, second.text]);
  assert.deepEqual(result.segments.map(s => [s.id, s.revision]), [['a', 1], ['b', 2]]);
});

test('recent speech excludes current and entire already represented conversation turns', () => {
  const buffered = segment('buffered', 'A related earlier thought.', 'user', 0);
  const priorA = segment('prior-a', 'Compare this.', 'user', 1, 'prior');
  const priorB = segment('prior-b', 'Use only my notes.', 'user', 1, 'prior');
  const request = segment('current', 'Continue.', 'user', 2);
  const result = recentSpeechContext({id: 'session', segments: [buffered, priorA, priorB, request]}, [priorA, request], request)!;
  assert.deepEqual(result.segments.map(s => s.id), ['buffered']);
  assert.equal(result.omittedTurnCount, 0);
});

test('recent speech excludes provisional turns and assistant content, even if an earlier block was final', () => {
  const first = segment('first', 'A partial thought.', 'user', 0, 'unfinished');
  const pending = {...segment('pending', 'Still speaking...', 'user', 1, 'unfinished'), final: false};
  const request = segment('request', 'Moo, help.', 'user', 2);
  const result = recentSpeechContext({id: 'session', segments: [first, pending, segment('assistant', 'Speculation.', 'assistant', 1), request]}, [request], request)!;
  assert.deepEqual(result.segments, []);
  assert.equal(result.omittedTurnCount, 1);
  assert.match(result.omission!, /incomplete/);
});

test('recent speech uses the original request anchor and never includes later attention or redirection', () => {
  const thought = segment('thought', 'The measurement is uncertain.', 'user', 0);
  const request = segment('request', 'Moo, explain it.', 'user', 1);
  const attention = segment('attention', 'Are you there?', 'user', 2);
  const redirect = segment('redirect', 'Actually, talk about something else.', 'user', 3);
  const result = recentSpeechContext({id: 'session', segments: [thought, request, attention, redirect]}, [request], request)!;
  assert.deepEqual(result.segments.map(s => s.id), ['thought']);
});

test('recent speech limits five whole turns and five minutes without considering a long session current', () => {
  const request = segment('current', 'Moo, explain that.', 'user', 10);
  const turns = Array.from({length: 8}, (_, i) => segment(`t${i}`, `Prior thought ${i}.`, 'user', i + 2));
  const result = recentSpeechContext({id: 'session', segments: [...turns, request]}, [request], request)!;
  assert.deepEqual(result.segments.map(s => s.id), ['t3', 't4', 't5', 't6', 't7']);
  assert.equal(result.omittedTurnCount, 3);
  assert.match(result.omission!, /Older/);
  const rapid = [...Array.from({length: 8}, (_, i) => segment(`r${i}`, `Rapid thought ${i}.`, 'user', 9)), request];
  assert.deepEqual(recentSpeechContext({id: 'session', segments: rapid}, [request], request)!.segments.map(s => s.id), ['r3', 'r4', 'r5', 'r6', 'r7']);
});

test('recent speech enforces the complete UTF-8 payload bound without clipping final qualifications', () => {
  const turns = Array.from({length: 4}, (_, i) => segment(`t${i}`, `${'🐕 '.repeat(200)} Quantity ${i}: planned, not completed.`, 'user', i));
  const request = segment('request', 'Moo, review it.', 'user', 4);
  const result = recentSpeechContext({id: 'session', segments: [...turns, request]}, [request], request)!;
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= recentSpeechContextLimits.bytes);
  assert.ok(result.omittedTurnCount > 0);
  for (const s of result.segments) assert.equal(s.text, turns.find(turn => turn.id === s.id)!.text);
  assert.match(result.segments.at(-1)!.text, /planned, not completed\.$/);
});

test('an oversized nearest thought is omitted whole, not silently replaced by a different older thought', () => {
  const request = segment('request', 'Moo, help with that.', 'user', 2);
  const result = recentSpeechContext({id: 'session', segments: [segment('old', 'An unrelated short thought.'), segment('large', '🌏'.repeat(1500), 'user', 1), request]}, [request], request)!;
  assert.deepEqual(result.segments, []);
  assert.equal(result.omittedTurnCount, 2);
  assert.match(result.omission!, /ask if missing context is needed/);
});

test('recent speech requires a valid retained request anchor and returns no duplicate-only context', () => {
  const request = segment('request', 'Explain it.');
  assert.equal(recentSpeechContext(undefined, [], request), undefined);
  assert.equal(recentSpeechContext({id: 's', segments: [request]}, [request]), undefined);
  assert.equal(recentSpeechContext({id: 's', segments: [request]}, [request], {turnId: 'missing'}), undefined);
  assert.equal(recentSpeechContext({id: 's', segments: [{...request, createdAt: 'invalid'}]}, [request], request), undefined);
  const prior = segment('prior', 'Earlier request.');
  assert.equal(recentSpeechContext({id: 's', segments: [prior, request]}, [prior, request], request), undefined);
});
