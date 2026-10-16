import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import type {AgentReply, BrainPort} from '../../contracts/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import {Agent} from '../src/index.js';

for (const adapter of ['memory', 'sqlite']) {
  async function setup(reply: AgentReply) {
    const directory = await mkdtemp(join(tmpdir(), 'moo-answer-admission-'));
    let brain: BrainPort = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    const provider = new FixtureProviders();
    let ids = 0, calls = 0, stopped = false;
    const spoken: string[] = [], rejected: string[] = [];
    const setState = brain.setState.bind(brain);
    brain.setState = async (key, value) => {if (key.startsWith('rejected-answer:')) rejected.push(key); await setState(key, value);};
    provider.respond = async () => {calls++; return reply;};
    const agent = new Agent({brain, generation: provider, decisions: provider, search: provider, vision: provider,
      capture: {async capture() {throw Error('No capture expected');}}, speech: {async speak(text) {spoken.push(text);}, async stop() {}},
      id: () => `id-${++ids}`, now: () => '2026-10-10T12:00:00.000Z'});
    await agent.initialize();
    return {agent, get brain() {return brain;}, get calls() {return calls;}, rejected, spoken,
      async restartStorage() {if (adapter === 'sqlite') {await agent.interrupt(); await agent.drain(); stopped = true; await brain.close(); brain = new SQLiteBrain(directory);}},
      async close() {if (!stopped) {await agent.interrupt(); await agent.drain();} await brain.close(); await rm(directory, {recursive: true, force: true});}};
  }

  for (const [label, text, reason] of [
    ['empty', '', 'empty_or_punctuation'],
    ['retrieval promise', "I'll search the notes and get back to you.", 'retrieval_promise'],
    ['incomplete quoted JSON', 'The saved JSON example is: `{', 'incomplete_structured_example'],
  ]) test(`${adapter}: native admission retains ${label} draft without publishing or paid retries`, async () => {
    const reply = {text: text!, toolCalls: []}, t = await setup(reply);
    try {
      await t.agent.submitText(label === 'incomplete quoted JSON' ? 'Moo, reproduce the complete JSON example from my notes.' : 'Moo, compare the two reports.');
      await t.agent.drain();
      assert.equal(t.calls, 1, 'A structural rejection does not spend another model call');
      assert.match(t.agent.getState().lastError ?? '', /incomplete answer/i);
      assert.equal(t.rejected.length, 1);
      const record = (await t.brain.getRecord(t.agent.getState().conversationId!))!;
      assert.ok(!record.segments.some(segment => segment.speaker === 'assistant' && segment.text === text));
      assert.ok(record.segments.some(segment => segment.speaker === 'user'));
      const rejectedKey = t.rejected[0]!;
      await t.restartStorage();
      const draft = await t.brain.getState<any>(rejectedKey);
      assert.equal(draft.reason, reason);
      assert.equal(draft.reply.text, text);
    } finally {await t.close();}
  });

  for (const [label, request, reply] of [
    ['short answer', 'Moo, how many participants were recorded?', {text: '12.', spokenText: 'Twelve participants were recorded.', toolCalls: []}],
    ['literal tool JSON', 'Moo, reproduce the complete JSON tool example, do not execute it.',
      {text: '{"tool":"search_notes","query":"calibration"}', spokenText: 'This is the saved search example; it has not executed.', toolCalls: []}],
    ['malformed optional outline', 'Moo, explain the result and its limitations.',
      {text: '## Result\nThe local fixture passed.\n## Limits\nPhysical validation remains pending.', spokenText: 'The fixture passed, but physical validation is still pending.',
        spokenOutline: {overview: 'Wrong outline.', points: [{label: 'Result', explanation: 'Local fixture passed.', sourceSections: [1]}]}, toolCalls: []}],
  ] satisfies [string, string, AgentReply][]) test(`${adapter}: native admission preserves ${label}`, async () => {
    const t = await setup(structuredClone(reply));
    try {
      await t.agent.submitText(request); await t.agent.drain();
      assert.equal(t.calls, 1); assert.equal(t.rejected.length, 0);
      assert.equal(t.agent.getState().lastError, undefined);
      assert.equal(t.spoken.at(-1), reply.spokenText);
      assert.ok((await t.brain.getRecord(t.agent.getState().conversationId!))!.segments.some(segment => segment.text === reply.text));
    } finally {await t.close();}
  });
}
