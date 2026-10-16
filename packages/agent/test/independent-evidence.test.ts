import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BrainPort, BrainRecord, GenerationProvider} from '../../contracts/src/index.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import {loadEvidence} from '../src/evidence.js';
import {GraphRetrieval} from '../src/graph-retrieval.js';

const at = '2026-10-11T02:00:00.000Z';
async function note(brain: BrainPort, id: string, turnId: string, conversationId: string, status: BrainRecord['thoughtStatus'] = 'settled', title = 'Inspection archive') {
  const created = await brain.createRecord({id, kind: 'dictation', createdAt: at});
  await brain.upsertSegment(id, {id: `${id}-source`, turnId, revision: 1, speaker: 'user', text: 'Inspection: an earlier observation is retained.', final: true, createdAt: at});
  const current = (await brain.getRecord(created.id))!;
  return brain.updateRecord(id, current.revision, {title, thoughtStatus: status, links: [{targetId: conversationId, provenance: 'source'}]});
}

for (const adapter of ['memory', 'sqlite'] as const) {
  async function setup(t: any) {
    const directory = await mkdtemp(join(tmpdir(), 'moolai-independent-evidence-'));
    let brain: BrainPort = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    t.after(async () => {await brain.close(); await rm(directory, {recursive: true, force: true});});
    return {get brain() {return brain;}, async restart() {
      if (adapter === 'sqlite') {await brain.close(); brain = new SQLiteBrain(directory);}
    }};
  }

  test(`${adapter}: actual search excludes current projections before top five while retaining earlier settled conversation notes`, async t => {
    const s = await setup(t), providers = new FixtureProviders();
    let ids = 0, calls = 0;
    let agent: Agent;
    const respond: GenerationProvider['respond'] = async () => {
      calls++;
      if (calls === 1) {
        const state = agent.getState();
        const session = (await s.brain.getRecord(state.sessionId!))!;
        const turn = session.segments.filter(segment => segment.speaker === 'user').at(-1)!;
        for (let i = 0; i < 6; i++) await note(s.brain, `projection-${i}`, turn.turnId, state.conversationId!,
          i < 2 ? 'draft' : i < 4 ? 'growing' : 'settled', 'Inspection calibration');
        for (let i = 0; i < 5; i++) await note(s.brain, `evidence-${i}`, `older-turn-${i}`, state.conversationId!);
        assert.equal((await s.brain.search('Inspection calibration', 5)).filter(record => record.id.startsWith('projection-')).length, 5,
          'Without exclusion the projections fill the result limit');
        return {text: '', toolCalls: [{id: 'lookup', name: 'search_notes', arguments: {query: 'Inspection calibration'}}]};
      }
      const state = agent.getState();
      const outcome = await s.brain.getState<any>(`tool:${state.conversationId}:lookup`);
      assert.equal(outcome.result.status, 'success');
      assert.deepEqual(outcome.result.result.map((record: BrainRecord) => record.id).sort(),
        ['evidence-0', 'evidence-1', 'evidence-2', 'evidence-3', 'evidence-4']);
      return {text: 'Five earlier inspection records remain available.', spokenText: 'Five earlier inspection records remain available.', toolCalls: []};
    };
    agent = new Agent({brain: s.brain, decisions: providers, generation: {summarize: providers.summarize.bind(providers), respond},
      search: providers, vision: providers, capture: {async capture() {throw Error('Capture forbidden');}},
      speech: {async speak() {}, async stop() {}}, id: () => `agent-${++ids}`, now: () => at});
    try {
      await agent.initialize(); await agent.submitText('Moo, inspect the saved records. Use only my notes.'); await agent.drain();
      assert.equal(agent.getState().lastError, undefined); assert.equal(calls, 2);
      assert.ok(await s.brain.getRecord('projection-0'), 'Exclusion does not delete source projections');
    } finally {await agent.interrupt(); await agent.drain();}
  });

  test(`${adapter}: direct reads and retained evidence cannot bypass current-turn or current-growing exclusions`, async t => {
    const s = await setup(t), providers = new FixtureProviders();
    let ids = 0, calls = 0, turnId = '', stopped = false;
    let agent: Agent;
    const respond: GenerationProvider['respond'] = async messages => {
      calls++;
      const state = agent.getState();
      if (calls === 1) {
        turnId = (await s.brain.getRecord(state.sessionId!))!.segments.filter(segment => segment.speaker === 'user').at(-1)!.turnId;
        await note(s.brain, 'settled-current', turnId, state.conversationId!, 'settled');
        await note(s.brain, 'active-growing', 'older-turn', state.conversationId!, 'growing');
        await note(s.brain, 'earlier-settled', 'older-turn', state.conversationId!, 'settled');
        await s.brain.setState(`evidence-index:${state.conversationId}`, {
          refs: ['settled-current', 'active-growing', 'earlier-settled'].map(id => ({id, offset: 0, length: 2400})), outcomes: [],
        });
        return {text: '', toolCalls: [
          {id: 'current-read', name: 'read_note', arguments: {id: 'settled-current'}},
          {id: 'growing-read', name: 'read_note', arguments: {id: 'active-growing'}},
          {id: 'earlier-read', name: 'read_note', arguments: {id: 'earlier-settled'}},
        ]};
      }
      for (const call of ['current-read', 'growing-read']) {
        const outcome = await s.brain.getState<any>(`tool:${state.conversationId}:${call}`);
        assert.equal(outcome.result.status, 'failed');
        assert.match(outcome.result.error, /independent evidence/);
      }
      assert.equal((await s.brain.getState<any>(`tool:${state.conversationId}:earlier-read`)).result.status, 'success');
      const evidence = await loadEvidence(s.brain, state.conversationId!, undefined, false, [turnId]);
      assert.deepEqual(evidence.notes.map(record => record.id), ['earlier-settled']);
      assert.doesNotMatch(messages[0]!.content, /"id":"(?:settled-current|active-growing)"/);
      return {text: 'Only the earlier settled observation is independent evidence.', spokenText: 'Only the earlier settled observation is independent evidence.', toolCalls: []};
    };
    agent = new Agent({brain: s.brain, decisions: providers, generation: {summarize: providers.summarize.bind(providers), respond},
      search: providers, vision: providers, capture: {async capture() {throw Error('Capture forbidden');}},
      speech: {async speak() {}, async stop() {}}, id: () => `agent-${++ids}`, now: () => at});
    try {
      await agent.initialize(); await agent.submitText('Moo, check the inspection evidence using only my notes.'); await agent.drain();
      assert.equal(agent.getState().lastError, undefined); assert.equal(calls, 2);
      const conversationId = agent.getState().conversationId!;
      await agent.interrupt(); await agent.drain(); stopped = true; await s.restart();
      assert.deepEqual((await loadEvidence(s.brain, conversationId, undefined, false, [turnId])).notes.map(record => record.id), ['earlier-settled']);
    } finally {if (!stopped) {await agent.interrupt(); await agent.drain();}}
  });

  test(`${adapter}: graph origins, neighbours and cached evidence respect current request and later constraint turns`, async t => {
    const s = await setup(t), brain = s.brain;
    await note(brain, 'seed', 'past', 'other-conversation');
    for (const [id, turn, status] of [
      ['current', 'request-turn', 'settled'], ['constraint', 'constraint-turn', 'settled'],
      ['growing', 'past', 'growing'], ['prior', 'past', 'settled'],
    ] as const) await note(brain, id, turn, 'active', status);
    const seed = (await brain.getRecord('seed'))!;
    await brain.updateRecord(seed.id, seed.revision, {links: [...seed.links,
      ...['current', 'constraint', 'growing', 'prior'].map(targetId => ({targetId, provenance: 'manual' as const, decision: 'accepted' as const}))]});
    const graph = new GraphRetrieval(brain, 'active', 'inspection', ['request-turn', 'constraint-turn']);
    await graph.retrieved([{id: 'current'}, {id: 'constraint'}, {id: 'growing'}]);
    for (const id of ['current', 'constraint', 'growing']) await assert.rejects(graph.expand(id), /Retrieve the starting note/);
    await graph.retrieved({id: 'seed'});
    assert.deepEqual((await graph.expand('seed')).map(record => record.id), ['prior']);
    assert.equal(await graph.current(), true);
    const prior = (await brain.getRecord('prior'))!;
    await brain.updateRecord(prior.id, prior.revision, {thoughtStatus: 'growing'});
    assert.equal(await graph.current(), false, 'A note that starts growing in the current conversation invalidates pending evidence');
    await brain.setState('evidence-index:active', {
      refs: ['current', 'constraint', 'growing', 'prior', 'seed'].map(id => ({id, offset: 0, length: 2400})), outcomes: [],
    });
    assert.deepEqual((await loadEvidence(brain, 'active', undefined, false, ['request-turn', 'constraint-turn'])).notes.map(record => record.id), ['seed']);
  });
}
