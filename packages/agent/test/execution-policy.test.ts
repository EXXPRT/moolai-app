import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent} from '../src/index.js';
import {ExecutionPolicy, planFirstInstruction, type ResponseExecutionExperiment} from '../src/execution-policy.js';
import {loadEvidence} from '../src/evidence.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {note, rig} from '../../../experiments/agent-closeout/support.js';
import type {AgentReply, BrainPort, ToolCall} from '../../contracts/src/index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
const search = (query: string, id = query): ToolCall => ({id, name: 'search_notes', arguments: {query}});
const read = (id: string, offset = 0, callId = `${id}-${offset}`): ToolCall => ({id: callId, name: 'read_note', arguments: {id, offset, length: 2400}});
const answer = (): AgentReply => ({text: 'The available sources support this comparison.', toolCalls: []});
async function wait<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Error('Test barrier timed out')), 3000);})]);}
  finally {clearTimeout(timer);}
}

for (const adapter of ['memory', 'sqlite'] as const) {
  async function setup(t: any, mode?: ResponseExecutionExperiment['mode'], cap?: number) {
    const directory = await mkdtemp(join(tmpdir(), 'moo-execution-'));
    const brain: BrainPort = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    const f = rig(brain);
    const options = {...f.options, allowedTools: ['search_notes', 'read_note', 'conversation_history'],
      ...(mode ? {responseExecutionExperiment: {mode, ...(cap ? {maxToolCalls: cap} : {})}} : {})};
    const agent = new Agent(options);
    await agent.initialize();
    t.after(async () => {await agent.interrupt(); await agent.drain(); await brain.close(); await rm(directory, {recursive: true, force: true});});
    return {...f, agent, options, brain, directory};
  }
  for (const mode of [undefined, 'current', 'balanced', 'parallel', 'plan_first'] as const) {
    test(`${adapter} execution ${mode ?? 'absent'}: ordered results and bounded real read overlap`, async t => {
      const f = await setup(t, mode);
      await note(f.brain, {id: 'a', title: 'Alpha', text: 'Alpha is measured in seconds.'});
      await note(f.brain, {id: 'b', title: 'Beta', text: 'Beta is measured in metres.'});
      const started = deferred(), release = deferred();
      const running: string[] = [], finished: string[] = [];
      const underlying = f.brain.search.bind(f.brain);
      f.brain.search = async (query, limit, filter) => {
        running.push(query);
        if (query === 'Alpha') {started.resolve(); await release.promise;}
        const result = await underlying(query, limit, filter);
        finished.push(query); return result;
      };
      f.hooks.generation.respond = async () => f.observed.generations.length === 1
        ? {text: '', toolCalls: [search('Alpha'), search('Beta')]} : answer();
      await f.agent.submitText('Moo, compare Alpha and Beta using only my notes.');
      await wait(started.promise);
      // A zero-delay event-loop turn lets the second admitted read start; no
      // wall-clock performance claim is made from this synthetic barrier.
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(running, mode === 'parallel' || mode === 'plan_first' ? ['Alpha', 'Beta'] : ['Alpha']);
      release.resolve(); await f.agent.drain();
      assert.equal(f.agent.getState().lastError, undefined);
      assert.equal(f.observed.generations.length, 2);
      const results = f.observed.generations[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
      assert.deepEqual(results.map((r: any) => r.query), ['Alpha', 'Beta']);
      assert.deepEqual(finished, mode === 'parallel' || mode === 'plan_first' ? ['Beta', 'Alpha'] : ['Alpha', 'Beta']);
      assert.equal(f.observed.generations[0].messages[0].content.includes(planFirstInstruction), mode === 'plan_first');
      assert.equal(f.observed.generations[1].messages[0].content.includes(planFirstInstruction), false);
      const timing = await f.brain.getState<any[]>(`execution-tool-timings:${f.agent.getState().conversationId}`);
      if (!mode) assert.equal(timing, undefined);
      else {assert.equal(timing!.length, 2); assert.ok(timing!.every(row => row.durationMs >= 0 && row.execution === 'returned'));}
    });
  }
  test(`${adapter} execution: balanced queries retain both facets; baseline retains its original last-five policy`, async t => {
    for (const mode of ['current', 'balanced', 'parallel'] as const) {
      const f = await setup(t, mode);
      for (const prefix of ['Alpha', 'Beta']) for (let i = 0; i < 5; i++)
        await note(f.brain, {id: `${prefix}${i}`, title: `${prefix} detail ${i}`, text: `${prefix} supports measurement ${i}.`});
      f.hooks.generation.respond = async () => f.observed.generations.length === 1
        ? {text: '', toolCalls: [search('Alpha'), search('Beta')]} : answer();
      await f.agent.submitText('Moo, compare Alpha and Beta.'); await f.agent.drain();
      const evidence = await loadEvidence(f.brain, f.agent.getState().conversationId!);
      assert.equal(evidence.notes.length, 5);
      assert.equal(evidence.notes.some(n => n.id.startsWith('Alpha')), mode !== 'current');
      assert.ok(evidence.notes.some(n => n.id.startsWith('Beta')));
      assert.ok(evidence.notes.reduce((sum, n) => sum + n.original.length, 0) <= 12000);
    }
  });
  test(`${adapter} execution: explicit distant passages coexist and survive Agent restart with current revisions`, async t => {
    const f = await setup(t, 'balanced');
    await note(f.brain, {id: 'long', title: 'Specification', text: 'First limit: 7 kPa. ' + 'Background. '.repeat(300) + 'Later limit: 19 seconds.'});
    f.hooks.generation.respond = async () => f.observed.generations.length === 1
      ? {text: '', toolCalls: [read('long'), read('long', 3200)]} : answer();
    await f.agent.submitText('Moo, compare the two specification limits.'); await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    const evidence = await loadEvidence(f.brain, id);
    assert.equal(evidence.notes.length, 2);
    assert.match(evidence.notes[0]!.original, /7 kPa/); assert.match(evidence.notes[1]!.original, /19 seconds/);
    const current = (await f.brain.getRecord('long'))!;
    await f.brain.updateRecord(current.id, current.revision, {title: 'My manual title', manualFields: ['title']});
    await f.agent.interrupt(); const restarted = new Agent(f.options); await restarted.initialize(); await restarted.drain();
    const refreshed = await loadEvidence(f.brain, id);
    assert.equal(refreshed.notes.length, 2); assert.ok(refreshed.notes.every(n => n.title === 'My manual title'));
    await restarted.interrupt(); await restarted.drain();
  });
  test(`${adapter} execution: duplicate reads cannot race and unavailable mutations never execute`, async t => {
    const f = await setup(t, 'parallel'); await note(f.brain, {id: 'a', title: 'Alpha', text: 'Alpha remains unchanged.'});
    const before = await f.brain.getRecord('a');
    f.hooks.generation.respond = async () => f.observed.generations.length === 1 ? {text: '', toolCalls: [
      read('a', 0, 'one'), read('a', 0, 'two'), {id: 'write', name: 'create_note', arguments: {title: 'Forbidden', text: 'Must not exist.'}},
    ]} : answer();
    await f.agent.submitText('Moo, compare Alpha.'); await f.agent.drain();
    const outputs = f.observed.generations[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
    assert.deepEqual(outputs.map((r: any) => r.status), ['success', 'rejected', 'rejected']);
    assert.deepEqual(await f.brain.getRecord('a'), before);
    assert.ok(!(await f.brain.listRecords()).some(r => r.title === 'Forbidden'));
    assert.ok(f.observed.generations.every(g => !g.tools.some((tool: any) => ['create_note', 'connect_notes', 'search_web'].includes(tool.name))));
  });
  test(`${adapter} execution: parallel failure does not discard successful evidence or become no matches`, async t => {
    const f = await setup(t, 'parallel'); await note(f.brain, {id: 'a', title: 'Alpha', text: 'Alpha is supported.'});
    const original = f.brain.search.bind(f.brain);
    f.brain.search = async (query, ...rest) => {if (query === 'Beta') throw Error('Synthetic disk unavailable'); return original(query, ...rest);};
    f.hooks.generation.respond = async () => f.observed.generations.length === 1
      ? {text: '', toolCalls: [search('Alpha'), search('Beta'), search('Absent')]} : answer();
    await f.agent.submitText('Moo, compare Alpha and Beta.'); await f.agent.drain();
    const outputs = f.observed.generations[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
    assert.deepEqual(outputs.map((r: any) => r.status), ['success', 'failed', 'no_matches']);
    assert.deepEqual(outputs.map((r: any) => r.query), ['Alpha', 'Beta', 'Absent']);
    assert.match(outputs[0].result.notes[0].original, /Alpha is supported/);
    assert.match(outputs[1].error, /Synthetic disk unavailable/);
    assert.equal(outputs[1].result.notes.length, 0); assert.equal(outputs[2].result.notes.length, 0);
    assert.equal(JSON.stringify(f.observed.generations[1].messages).split('Alpha is supported').length - 1, 1);
    assert.equal(f.agent.getState().lastError, undefined);
  });
  test(`${adapter} execution: dependent read follows the next model observation, not an unresolved placeholder`, async t => {
    const f = await setup(t, 'plan_first'); await note(f.brain, {id: 'a', title: 'Alpha', text: 'Alpha is supported.'});
    f.hooks.generation.respond = async () => f.observed.generations.length === 1 ? {text: '', toolCalls: [search('Alpha')]}
      : f.observed.generations.length === 2 ? {text: '', toolCalls: [read('a')]} : answer();
    await f.agent.submitText('Moo, read the Alpha specification.'); await f.agent.drain();
    assert.equal(f.observed.generations.length, 3);
    assert.deepEqual(f.observed.generations[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content).tool), ['search_notes']);
    assert.equal(f.agent.getState().lastError, undefined);
  });
  test(`${adapter} execution: revised source during an answer prevents publication and preserves manual edits`, async t => {
    const f = await setup(t, 'parallel'); await note(f.brain, {id: 'a', title: 'Alpha', text: 'The limit is 7 kPa.'});
    f.hooks.generation.respond = async () => {
      if (f.observed.generations.length === 1) return {text: '', toolCalls: [search('Alpha')]};
      const r = (await f.brain.getRecord('a'))!;
      await f.brain.updateRecord(r.id, r.revision, {body: 'Corrected: 9 kPa.', title: 'My correction', manualFields: ['title', 'body']});
      return {text: 'The limit is 7 kPa.', toolCalls: []};
    };
    await f.agent.submitText('Moo, find the Alpha limit.'); await f.agent.drain();
    assert.match(f.agent.getState().lastError!, /changed|stale/i);
    assert.ok(!f.observed.speech.includes('The limit is 7 kPa.'));
    assert.equal((await f.brain.getRecord('a'))!.title, 'My correction');
  });
  test(`${adapter} execution: cancellation during parallel reads cannot publish or dispatch another generation`, async t => {
    const f = await setup(t, 'parallel'); const started = deferred(), release = deferred(); let calls = 0;
    await note(f.brain, {id: 'a', title: 'Alpha', text: 'Alpha remains saved after cancellation.'});
    await note(f.brain, {id: 'b', title: 'Beta', text: 'Beta is the independently completed sibling.'});
    const original = f.brain.search.bind(f.brain);
    f.brain.search = async (query, ...rest) => {calls++; if (calls === 2) started.resolve(); await release.promise; return original(query, ...rest);};
    f.hooks.generation.respond = async () => ({text: '', toolCalls: [search('Alpha'), search('Beta')]});
    await f.agent.submitText('Moo, compare Alpha and Beta.'); await wait(started.promise);
    await f.agent.interrupt(); release.resolve(); await f.agent.drain();
    assert.equal(f.observed.generations.length, 1);
    const conversationId = f.agent.getState().conversationId!;
    const conversation = (await f.brain.getRecord(conversationId))!;
    assert.ok(!conversation.segments.some(s => s.speaker === 'assistant' && s.text.includes('available sources')));
    const ledger = (await f.brain.getState<any[]>(`tool-ledger:${conversationId}`))!;
    assert.deepEqual(ledger.map(row => row.call.id), ['Alpha', 'Beta']);
    assert.deepEqual(ledger.map(row => row.result.status), ['success', 'success']);
    assert.match(ledger[0].result.result[0].original, /remains saved after cancellation/);
    assert.match(ledger[1].result.result[0].original, /independently completed sibling/);
    assert.ok(ledger.every(row => row.requestTurnId === conversation.segments.find(s => s.speaker === 'user')!.turnId));
    assert.deepEqual((await loadEvidence(f.brain, conversationId)).notes, []);
  });
  test(`${adapter} execution: attention holds completed parallel evidence until recognition resolves`, async t => {
    const f = await setup(t, 'parallel'); const started = deferred(), release = deferred(); let calls = 0;
    const original = f.brain.search.bind(f.brain);
    f.brain.search = async (query, ...rest) => {calls++; if (calls === 2) started.resolve(); await release.promise; return original(query, ...rest);};
    f.hooks.generation.respond = async () => f.observed.generations.length === 1
      ? {text: '', toolCalls: [search('Alpha'), search('Beta')]} : answer();
    await f.agent.submitText('Moo, compare Alpha and Beta.'); await wait(started.promise);
    await f.agent.speechStarted(); release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.observed.generations.length, 1);
    await f.agent.recognitionRejected(); await f.agent.drain();
    assert.equal(f.observed.generations.length, 2); assert.equal(f.agent.getState().lastError, undefined);
  });
  test(`${adapter} execution: source edited during a parallel batch rejects its stale passage before reuse`, async t => {
    const f = await setup(t, 'parallel');
    await note(f.brain, {id: 'a', title: 'Alpha', text: 'The limit is 7 kPa.'});
    await note(f.brain, {id: 'b', title: 'Beta', text: 'Beta is the independently completed sibling.'});
    const ready = deferred(), original = f.brain.search.bind(f.brain);
    f.brain.search = async (query, ...rest) => {
      if (query === 'Alpha') {const result = await original(query, ...rest); ready.resolve(); return result;}
      await ready.promise;
      const r = (await f.brain.getRecord('a'))!;
      await f.brain.updateRecord(r.id, r.revision, {body: 'The corrected limit is 9 kPa.'});
      return original(query, ...rest);
    };
    f.hooks.generation.respond = async () => ({text: '', toolCalls: [search('Alpha'), search('Beta')]});
    await f.agent.submitText('Moo, compare Alpha and Beta.'); await f.agent.drain();
    assert.equal(f.observed.generations.length, 1);
    assert.match(f.agent.getState().lastError!, /source changed during the tool batch/);
    const conversationId = f.agent.getState().conversationId!;
    assert.equal((await f.brain.getState<any[]>(`execution-tool-timings:${conversationId}`))!.length, 2);
    const ledger = (await f.brain.getState<any[]>(`tool-ledger:${conversationId}`))!;
    assert.deepEqual(ledger.map(row => row.call.id), ['Alpha', 'Beta']);
    assert.deepEqual(ledger.map(row => row.result.status), ['success', 'success']);
    assert.match(ledger[0].result.result[0].original, /7 kPa/);
    assert.match(ledger[1].result.result[0].original, /independently completed sibling/);
    assert.equal(ledger[0].requestTurnId, (await f.brain.getRecord(conversationId))!.segments.find(s => s.speaker === 'user')!.turnId);
    assert.deepEqual((await loadEvidence(f.brain, conversationId)).notes, []);
  });
  test(`${adapter} execution: six generations reserve answer-only and proposal cap rejects before I/O`, async t => {
    for (const mode of ['current', 'balanced', 'parallel', 'plan_first'] as const) {
      const f = await setup(t, mode);
      f.hooks.generation.respond = async () => f.observed.generations.length < 6
        ? {text: '', toolCalls: [search(`Alpha ${f.observed.generations.length}`)]} : answer();
      await f.agent.submitText('Moo, investigate Alpha.'); await f.agent.drain();
      assert.equal(f.observed.generations.length, 6); assert.deepEqual(f.observed.generations[5].tools, []);
      assert.equal(f.observed.generations[5].settings.responseMode, 'answer_only');
      assert.equal(f.agent.getState().lastError, undefined);
    }
    const capped = await setup(t, 'parallel', 1); let executed = 0;
    capped.brain.search = async () => {executed++; return [];};
    capped.hooks.generation.respond = async () => ({text: '', toolCalls: [search('Alpha'), search('Beta')]});
    await capped.agent.submitText('Moo, compare Alpha and Beta.'); await capped.agent.drain();
    assert.equal(executed, 0); assert.equal(capped.observed.generations.length, 1);
    assert.match(capped.agent.getState().lastError!, /tool-proposal limit/);
  });
}

test('SQLite execution passages survive closing the database and reopening it without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moo-execution-restart-'));
  let brain: BrainPort = new SQLiteBrain(directory);
  try {
    await note(brain, {id: 'long', title: 'Specification', text: 'First limit: 7 kPa. ' + 'Background. '.repeat(300) + 'Later limit: 19 seconds.'});
    const f = rig(brain), options = {...f.options, responseExecutionExperiment: {mode: 'parallel' as const}};
    const agent = new Agent(options); await agent.initialize();
    f.hooks.generation.respond = async () => f.observed.generations.length === 1
      ? {text: '', toolCalls: [read('long'), read('long', 3200)]} : answer();
    await agent.submitText('Moo, compare the specification limits.'); await agent.drain();
    const id = agent.getState().conversationId!; await agent.interrupt(); await agent.drain();
    await brain.close(); brain = new SQLiteBrain(directory);
    const restarted = new Agent({...options, brain}); await restarted.initialize(); await restarted.drain();
    assert.equal(f.observed.generations.length, 2);
    const retained = await loadEvidence(brain, id);
    assert.equal(retained.notes.length, 2); assert.match(retained.notes[0]!.original, /7 kPa/); assert.match(retained.notes[1]!.original, /19 seconds/);
    await restarted.interrupt(); await restarted.drain();
  } finally {await brain.close(); await rm(directory, {recursive: true, force: true});}
});

test('execution experiment validates hard limits and keeps dependency-like reads out of parallel batches', () => {
  for (const cap of [0, 9, 1.5, NaN]) assert.throws(() => new ExecutionPolicy({mode: 'parallel', maxToolCalls: cap}), /cap/);
  const p = new ExecutionPolicy({mode: 'parallel'});
  const calls = [search('Alpha'), read('#E1'), search('Beta')];
  assert.deepEqual(p.batches(calls).map(batch => batch.length), [1, 1, 1]);
  assert.equal(p.allows('create_note'), false);
});
