import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BrainPort, ChatMessage, GenerationProvider} from '../../contracts/src/index.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import {presentationInstruction, finalAnswerInstruction, responseInstructionVersion} from '../src/response-instructions.js';

const at = '2026-10-11T02:00:00.000Z';
// More than one hundred words deliberately puts the limiting evidence at the end.
// This fixture tests transport/playback preservation, not whether a model will write it.
const spokenText = 'The workshop comparison favours the revised inspection process for the next trial, while the result remains provisional. The earlier procedure required two separate visits, whereas the revised procedure completed the same documented checks during one visit. The team recorded fewer delays, preserved the original measurements, and kept the unresolved sensor calibration question visible. The record does not support a conclusion about other sites, and the follow-up inspection is planned rather than completed. These are reported observations from Avery, not independently verified outcomes or a guarantee that the change caused the improvement. Avery observed no leak during a twelve-minute check, which does not establish long-term reliability.';
const text = `## Conclusion\nThe revised process is the provisional next-trial choice.\n## Evidence and limitations\n${spokenText}\n## Next step\nThe follow-up inspection remains planned.`;

for (const adapter of ['memory', 'sqlite'] as const) for (const finalPhase of [false, true]) {
  test(`${adapter}: ${finalPhase ? 'final' : 'ordinary'} response preserves a late evidence limit through publication, restart and repeat`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moolai-spoken-fidelity-'));
    let brain: BrainPort = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    const providers = new FixtureProviders();
    const calls: {messages: ChatMessage[]; settings?: Parameters<GenerationProvider['respond']>[3]; tools: string[]}[] = [];
    const playback: string[] = [];
    let counter = 0, routes = 0;
    const route = providers.route.bind(providers);
    providers.route = async input => {routes++; return route(input);};
    const respond: GenerationProvider['respond'] = async (messages, tools, _signal, settings) => {
      calls.push({messages: structuredClone(messages), tools: tools.map(tool => tool.name), settings});
      if (finalPhase && calls.length < 6) return {text: '', toolCalls: [{id: `search-${calls.length}`, name: 'search_notes',
        arguments: {query: `inspection missing appendix ${calls.length}`}}]};
      return {text, spokenText, toolCalls: [], spokenOutline: {overview: 'Incomplete optional outline.',
        points: [{label: 'Conclusion', explanation: 'A provisional choice.', sourceSections: [1]}]}};
    };
    const makeAgent = () => new Agent({brain, decisions: providers, generation: {consolidate: providers.consolidate.bind(providers), summarize: providers.summarize.bind(providers), respond}, search: providers, vision: providers,
      capture: {async capture() {throw Error('Capture is unavailable in this fixture');}},
      speech: {async speak(value) {playback.push(value);}, async stop() {}},
      id: () => `generated-${++counter}`, now: () => at});
    let agent = makeAgent();
    try {
      assert.ok(spokenText.split(/\s+/).length > 100);
      const note = await brain.createRecord({id: 'inspection-record', kind: 'note', createdAt: at});
      await brain.updateRecord(note.id, note.revision, {title: 'Workshop inspection results', body: spokenText});
      await agent.initialize();
      await agent.submitText('Moo, explain the inspection findings and what the evidence cannot establish. Use only my notes.');
      await agent.drain();
      assert.equal(agent.getState().lastError, undefined);
      assert.equal(calls.length, finalPhase ? 6 : 1);
      assert.equal(playback.at(-1), spokenText, 'A later qualification is not mechanically truncated or replaced by an outline error');
      // The policy is loaded into actual production calls, including the final phase.
      for (const call of calls) {
        assert.ok(call.messages[0]!.content.includes(presentationInstruction));
        assert.ok(call.messages[0]!.content.includes(responseInstructionVersion));
      }
      if (finalPhase) {
        assert.ok(calls.at(-1)!.messages[0]!.content.includes(finalAnswerInstruction));
        assert.equal(calls.at(-1)!.settings?.responseMode, 'answer_only');
        assert.deepEqual(calls.at(-1)!.tools, []);
      }
      const conversationId = agent.getState().conversationId!;
      const source = (await brain.getRecord(conversationId))!.segments.find(segment => segment.speaker === 'assistant' && segment.text === text)!;
      assert.ok(source, 'Written answer remains independent of incomplete optional narration');
      const originalCalls = calls.length, originalRoutes = routes;
      await agent.interrupt(); await agent.drain();
      if (adapter === 'sqlite') {await brain.close(); brain = new SQLiteBrain(directory);}
      agent = makeAgent(); await agent.initialize();
      await agent.submitText('Repeat that.'); await agent.drain();
      assert.equal(playback.at(-1), spokenText);
      assert.equal(calls.length, originalCalls, 'Repeating the saved paragraph cannot trigger paid regeneration');
      assert.equal(routes, originalRoutes);
      const saved = (await brain.getRecord(conversationId))!.segments.find(segment => segment.id === source.id)!;
      assert.equal(saved.text, text);
      assert.equal(saved.revision, source.revision);
    } finally {await agent.interrupt(); await agent.drain(); await brain.close(); await rm(directory, {recursive: true, force: true});}
  });
}
