import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentReply, BrainPort, Segment} from '../../contracts/src/index.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {answerNarrationIsCurrent, rememberAnswerNarration, resolveAnswerNarration} from '../src/answer-narration.js';
import {narrationUnavailable, plainSpeech, playbackRequest} from '../src/response-output.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

const at = '2026-10-10T14:00:00.000Z';
const answer = (id = 'answer', text = 'The sample is approximately 12 ml, not 21 ml.'): Segment =>
  ({id, turnId: id, revision: 1, final: true, speaker: 'assistant', text, createdAt: at});

test('only complete referential playback commands bypass research and routing', () => {
  for (const text of ['Please read it in full.', 'Read the whole answer.', 'Moo, could you read your last answer aloud?', 'Read all of it.'])
    assert.equal(playbackRequest(text), 'full', text);
  for (const text of ['Repeat that.', 'Please say it again.', 'Moo repeat your last answer please'])
    assert.equal(playbackRequest(text), 'repeat', text);
  for (const text of ['Walk me through it.', 'Moo, explain each section.', 'Go through all the points.'])
    assert.equal(playbackRequest(text), 'walkthrough', text);
  for (const text of ['Do not read it in full.', 'Stop reading it in full.', 'The note says “read it in full”.', '“Read it in full”',
    'Read it in full and search my files.', 'Read my note about batteries in full.', 'Can you explain what read it in full means?',
    'Repeat the 12 ml experiment.', 'Walk me through photosynthesis.'])
    assert.equal(playbackRequest(text), undefined, text);
});

// Ian, 21 Oct: the recognizer wrote "Moo. Read it in full." and the request went to J1 and Ultra instead.
test('playback still matches after a spoken "Moo.", an opener or discourse word, or a trailing please', () => {
  for (const text of ['Moo. Read it in full.', 'Moo, read it in full please.', 'Read it in full, please.', 'Okay Moo, read it out.',
    'Moo. Okay, read it to me.', 'Read it aloud.', 'Read it out loud.', 'Read it all.', 'Read it again.', 'Read me the answer.', 'Read the whole thing.'])
    assert.equal(playbackRequest(text), 'full', text);
  for (const text of ['Moo. Say that again.', 'Say that again, please.'])
    assert.equal(playbackRequest(text), 'repeat', text);
  assert.equal(playbackRequest('Hey Moo, walk me through it.'), 'walkthrough');
});

test('guard: negated, compound and other-target requests, an unrelated request and a bare "Moo." are not playback', () => {
  for (const text of ["Don't read it in full.", 'Read it in full and then search the web.', 'Moo, read the second source in full.', 'Moo. Tell me more.', 'Moo.'])
    assert.equal(playbackRequest(text), undefined, text);
});

for (const adapter of ['memory', 'sqlite']) {
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'moo-answer-narration-'));
    let brain: BrainPort = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    await brain.createRecord({id: 'conversation', kind: 'conversation', createdAt: at});
    return {get brain() {return brain;}, async restart() {
      if (adapter === 'sqlite') {await brain.close(); brain = new SQLiteBrain(directory);}
    }, async close() {await brain.close(); await rm(directory, {recursive: true, force: true});}};
  }

  test(`${adapter}: summary and complete reading resolve the original answer across restart without regeneration`, async () => {
    const t = await setup();
    try {
      const source = answer();
      await t.brain.upsertSegment('conversation', source);
      const reply: AgentReply = {text: source.text, spokenText: 'The sample is about 12 ml; 21 ml was corrected.', toolCalls: []};
      assert.equal(await rememberAnswerNarration(t.brain, 'conversation', source, reply), true);
      // A later acknowledgement must not replace the last generated answer.
      await t.brain.upsertSegment('conversation', answer('acknowledgement', 'Your text is saved.'));
      await t.restart();
      const full = await resolveAnswerNarration(t.brain, 'conversation', 'Please read it in full.');
      assert.equal(full!.speech, source.text);
      assert.equal(full!.anchor!.segmentId, source.id);
      assert.equal(full!.unavailable, undefined);
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Repeat that.'))!.speech, reply.spokenText);
      assert.equal((await t.brain.getRecord('conversation'))!.segments.length, 2, 'Playback preparation does not rewrite source records');
    } finally {await t.close();}
  });

  test(`${adapter}: only requested walkthrough establishes the next five-point batch`, async () => {
    const t = await setup();
    try {
      const source = answer('six', Array.from({length: 6}, (_, i) => `## Section ${i + 1}\nDetail ${i + 1}, still uncertain.`).join('\n'));
      await t.brain.upsertSegment('conversation', source);
      const reply: AgentReply = {text: source.text, spokenText: 'Six observations remain uncertain.', toolCalls: [],
        spokenOutline: {overview: 'Six observations.', points: Array.from({length: 6}, (_, i) =>
          ({label: `Section ${i + 1}`, explanation: `Detail ${i + 1} remains uncertain.`, sourceSections: [i + 1]}))}};
      await rememberAnswerNarration(t.brain, 'conversation', source, reply);
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Repeat that'))!.continuation, undefined);
      const request = await resolveAnswerNarration(t.brain, 'conversation', 'Walk me through the points');
      assert.match(request!.speech, /Detail 1.*Detail 5.*next points/);
      assert.doesNotMatch(request!.speech, /Detail 6/);
      assert.equal(request!.continuation!.next, 5);
      assert.equal(request!.continuation!.sourceResponse!.segmentId, source.id);
      assert.equal(request!.continuation!.sourceResponse!.revision, source.revision);
    } finally {await t.close();}
  });

  test(`${adapter}: corrected or unavailable source prevents stale summaries and full playback`, async () => {
    const t = await setup();
    try {
      const source = answer();
      await t.brain.upsertSegment('conversation', source);
      await rememberAnswerNarration(t.brain, 'conversation', source, {text: source.text, spokenText: 'About 12 ml.', toolCalls: []});
      const pending = await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full');
      await t.brain.upsertSegment('conversation', {...source, revision: 2, text: 'The corrected sample is 10 ml.'});
      assert.equal(await answerNarrationIsCurrent(t.brain, pending!.anchor!), false);
      for (const command of ['Read it in full', 'Repeat that', 'Walk me through it']) {
        const result = await resolveAnswerNarration(t.brain, 'conversation', command);
        assert.equal(result!.unavailable, 'answer_changed');
        assert.doesNotMatch(result!.speech, /12 ml/);
      }
      const record = (await t.brain.getRecord('conversation'))!;
      await t.brain.updateRecord(record.id, record.revision, {archived: true});
      assert.equal(await answerNarrationIsCurrent(t.brain, {...pending!.anchor!, revision: 2}), false);
      assert.equal((await resolveAnswerNarration(t.brain, 'another-conversation', 'Read it in full'))!.unavailable, 'no_answer');
    } finally {await t.close();}
  });

  test(`${adapter}: missing summaries remain a narration limitation while complete saved answers stay readable`, async () => {
    const t = await setup();
    try {
      const source = answer();
      await t.brain.upsertSegment('conversation', source);
      await rememberAnswerNarration(t.brain, 'conversation', source, {text: source.text, narrationError: 'missing_spoken_summary', toolCalls: []});
      const repeat = await resolveAnswerNarration(t.brain, 'conversation', 'Repeat that');
      assert.equal(repeat!.unavailable, 'summary_missing');
      assert.equal(repeat!.speech, source.text, 'A repeat reads the answer itself, never the unavailable notice again');
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full'))!.speech, source.text);
      assert.equal((await t.brain.getRecord('conversation'))!.segments[0]!.text, source.text);
    } finally {await t.close();}
  });

  test(`${adapter}: partial persistence and invalid presentation data fail locally rather than target another answer`, async () => {
    const t = await setup();
    try {
      const source = answer();
      await t.brain.upsertSegment('conversation', source);
      assert.equal(await rememberAnswerNarration(t.brain, 'conversation', source, {text: 'Unrelated answer', toolCalls: []}), false);
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full'))!.unavailable, 'no_answer');
      await t.brain.setState('answer-narration:latest:conversation', {conversationId: 'conversation', segmentId: source.id, revision: 1});
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full'))!.unavailable, 'answer_changed');
      await rememberAnswerNarration(t.brain, 'conversation', source, {text: source.text, spokenText: 'About 12 ml.', toolCalls: []});
      const saved = await t.brain.getState<any>('answer-narration:conversation:answer:1');
      await t.brain.setState('answer-narration:conversation:answer:1', {...saved, spokenOutline: {overview: 'Wrong shape', points: null}});
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Repeat that'))!.speech, 'About 12 ml.');
    } finally {await t.close();}
  });

  test(`${adapter}: legacy playback anchors only a positively identified content answer, never a later acknowledgement`, async () => {
    const t = await setup();
    try {
      const source = answer('legacy-answer', 'The saved explanation states that the count is 12, with uncertainty.');
      await t.brain.upsertSegment('conversation', source);
      await t.brain.upsertSegment('conversation', answer('ack', 'Your transcript is saved.'));
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full'))!.unavailable, 'no_answer');
      await t.brain.setState(`thought-eligible:${source.id}`, true);
      const first = await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full');
      assert.equal(first!.anchor!.segmentId, source.id);
      assert.equal(first!.speech, source.text);
      await t.restart();
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full'))!.anchor!.segmentId, source.id);
      await t.brain.upsertSegment('conversation', {...source, revision: 2, text: 'Corrected to 9.'});
      assert.equal((await resolveAnswerNarration(t.brain, 'conversation', 'Read it in full'))!.unavailable, 'answer_changed', 'A legacy marker must not override an already anchored revision');
    } finally {await t.close();}
  });

  test(`${adapter}: Agent reads and repeats the saved answer after restart without another J1 or generation call`, async () => {
    const t = await setup();
    const providers = new FixtureProviders();
    let ids = 0, generations = 0, routes = 0;
    const spoken: string[] = [];
    const route = providers.route.bind(providers);
    providers.route = async input => {routes++; return route(input);};
    const reply: AgentReply = {text: '## Evidence\nThe count is approximately 12, not 21.\n## Limits\nThe measurement remains uncertain.',
      spokenText: 'The corrected count is approximately 12, with measurement uncertainty remaining.', toolCalls: [],
      spokenOutline: {overview: 'Two parts.', points: [{label: 'Evidence', explanation: 'Approximately 12.', sourceSections: [1]}]}};
    providers.respond = async () => {generations++; return reply;};
    const make = () => new Agent({brain: t.brain, decisions: providers, generation: providers, search: providers, vision: providers,
      capture: {async capture() {throw Error('Playback requests cannot capture');}},
      speech: {async speak(text) {spoken.push(text);}, async stop() {}}, id: () => `generated-${++ids}`, now: () => at});
    let agent = make();
    try {
      await agent.initialize();
      await agent.submitText('Moo, explain the corrected sample count.');
      await agent.drain();
      assert.equal(generations, 1);
      assert.equal(spoken.at(-1), reply.spokenText);
      assert.equal(agent.getState().narration, undefined, 'An optional malformed outline cannot create a walkthrough offer');
      const before = routes;
      await agent.drain(); await t.restart(); agent = make(); await agent.initialize();
      await agent.submitText('Please read it in full.'); await agent.drain();
      assert.match(spoken.at(-1)!, /approximately 12, not 21.*measurement remains uncertain/);
      await agent.submitText('Repeat that.'); await agent.drain();
      assert.equal(spoken.at(-1), reply.spokenText);
      assert.equal(generations, 1);
      assert.equal(routes, before);
      const record = (await t.brain.getRecord(agent.getState().conversationId!))!;
      assert.equal(record.segments.filter(segment => segment.text === reply.text).length, 1, 'Playback does not generate duplicate answers');
      assert.ok(record.segments.some(segment => segment.text === 'Please read it in full.'), 'Playback controls are retained');
    } finally {await agent.interrupt(); await agent.drain(); await t.close();}
  });

  // Ian's 21 Oct test A: an answer saved with narrationError and no spokenText, then a request that starts "Moo.".
  function summaryless(t: Awaited<ReturnType<typeof setup>>) {
    const providers = new FixtureProviders();
    const counts = {routes: 0, generations: 0};
    const spoken: string[] = [];
    const route = providers.route.bind(providers);
    providers.route = async input => {counts.routes++; return route(input);};
    const reply: AgentReply = {text: '## Evidence\nThe count is approximately 12, not 21.\n## Limits\nThe measurement remains uncertain.',
      narrationError: 'missing_spoken_summary', toolCalls: []};
    providers.respond = async () => {counts.generations++; return reply;};
    let ids = 0;
    const agent = new Agent({brain: t.brain, decisions: providers, generation: providers, search: providers, vision: providers,
      capture: {async capture() {throw Error('Playback requests cannot capture');}},
      speech: {async speak(text) {spoken.push(text);}, async stop() {}}, id: () => `generated-${++ids}`, now: () => at});
    return {agent, reply, spoken, counts, async answered() {
      await agent.initialize();
      await agent.submitText('Moo, explain the corrected sample count.'); await agent.drain();
      assert.equal(spoken.at(-1), narrationUnavailable);
      return counts.routes;
    }};
  }

  test(`${adapter}: Agent reads an answer without a summary in full after "Moo.", with no J1 route or respond call`, async () => {
    const t = await setup();
    const s = summaryless(t);
    try {
      const routes = await s.answered();
      await s.agent.submitText('Moo. Read it in full.'); await s.agent.drain();
      assert.equal(s.spoken.at(-1), plainSpeech(s.reply.text));
      assert.equal(s.counts.routes, routes, 'A playback request never reaches J1');
      assert.equal(s.counts.generations, 1, 'A playback request never asks for a new answer');
    } finally {await s.agent.interrupt(); await s.agent.drain(); await t.close();}
  });

  test(`${adapter}: Agent says an answer without a summary again by reading it, not the unavailable notice`, async () => {
    const t = await setup();
    const s = summaryless(t);
    try {
      const routes = await s.answered();
      await s.agent.submitText('Moo. Say that again.'); await s.agent.drain();
      assert.equal(s.spoken.at(-1), plainSpeech(s.reply.text));
      assert.doesNotMatch(s.spoken.at(-1)!, /spoken summary is unavailable/);
      assert.equal(s.counts.routes, routes, 'A playback request never reaches J1');
      assert.equal(s.counts.generations, 1, 'A playback request never asks for a new answer');
    } finally {await s.agent.interrupt(); await s.agent.drain(); await t.close();}
  });
}
