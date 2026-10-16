import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transcriptText, type AgentReply, type BrainPort, type ChatMessage, type GenerationProvider, type ToolCall} from '../../contracts/src/index.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import {Agent} from '../src/index.js';
import {loadEvidence, noteEvidence} from '../src/evidence.js';
import {retrievalMessages} from '../src/retrieval-messages.js';

const at = '2026-10-11T03:00:00.000Z';
let fixtureId = 0;
const call = (id: string, name: string, args: ToolCall['arguments']): ToolCall => ({id, name, arguments: args});
const proposal = (...toolCalls: ToolCall[]): AgentReply => ({text: '', toolCalls});
const answer = (text: string): AgentReply => ({text, spokenText: text, toolCalls: []});
function result(messages: ChatMessage[], callId: string) {
  return JSON.parse(messages.find(message => message.role === 'tool' && message.toolCallId === callId)!.content);
}
async function add(brain: BrainPort, id: string, title: string, text: string) {
  const record = await brain.createRecord({id, kind: 'note', createdAt: at});
  await brain.updateRecord(id, record.revision, {title, body: text});
  return (await brain.getRecord(id))!;
}
function fixture(brain: BrainPort, respond: GenerationProvider['respond'], graphRetrieval = false) {
  const providers = new FixtureProviders(); const prefix = ++fixtureId; let next = 0;
  return new Agent({brain, decisions: providers, graphRetrieval,
    generation: {summarize: providers.summarize.bind(providers), respond},
    search: providers, vision: providers, capture: {async capture() {throw Error('Capture not permitted');}},
    speech: {async speak() {}, async stop() {}}, id: () => `agent-${prefix}-${++next}`, now: () => at});
}
for (const adapter of ['memory', 'sqlite'] as const) {
  async function setup(t: any) {
    const directory = await mkdtemp(join(tmpdir(), 'moolai-retrieval-messages-'));
    const brain = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    let closed = false;
    t.after(async () => {if (!closed) await brain.close(); await rm(directory, {recursive: true, force: true});});
    return {brain, directory, async close() {await brain.close(); closed = true;}};
  }

  test(`${adapter}: native search supplies both complete sources directly and an evidence-driven fixture answers without confirmatory reads`, async t => {
    const {brain} = await setup(t);
    await add(brain, 'plan', 'Bench load proposal', 'Avery corrected the proposed bench load from 16 kg to 12 kg. No test was performed.');
    await add(brain, 'review', 'Bench load review', 'Jordan requires independent testing before adoption. A proposal is not an adopted setting.');
    const calls: ChatMessage[][] = [];
    const agent = fixture(brain, async messages => {
      calls.push(structuredClone(messages));
      const tool = messages.find(message => message.toolCallId === 'search');
      if (!tool) return proposal(call('search', 'search_notes', {query: 'bench load'}));
      const outcome = result(messages, 'search');
      assert.equal(outcome.status, 'success'); assert.equal(outcome.executed, true);
      const notes = outcome.result.notes;
      assert.deepEqual(notes.map((note: any) => note.id).sort(), ['plan', 'review']);
      assert.ok(notes.every((note: any) => note.sourceCoverage === 'complete_source'));
      assert.match(JSON.stringify(notes), /16 kg to 12 kg/);
      assert.match(JSON.stringify(notes), /independent testing before adoption/);
      assert.doesNotMatch(messages[0]!.content, /16 kg to 12 kg|independent testing before adoption/);
      assert.match(outcome.result.evidenceNotice, /already read and usable/);
      return answer('Avery proposed 12 kg, correcting 16 kg. This is untested; Jordan requires independent testing before adoption.');
    });
    await agent.initialize(); await agent.submitText('Moo, what is the corrected bench load and is it approved? Use only my notes.'); await agent.drain();
    assert.equal(agent.getState().lastError, undefined); assert.equal(calls.length, 2);
    assert.equal((await brain.getState<any>(`tool:${agent.getState().conversationId}:search`)).result.result.length, 2,
      'Full executed outcome remains in the audit ledger');
    await agent.interrupt(); await agent.drain();
  });

  test(`${adapter}: incomplete search permits a distinct passage read and retains earlier qualification without copying passages twice`, async t => {
    const {brain} = await setup(t);
    const record = await add(brain, 'long', 'Calibration archive', '# Calibration\nThese are planned observations, not a completed test.\n' +
      'An unrelated archived discussion about storage. '.repeat(100) + '\n# Later appendix\nThe selected nozzle is 7 mm; validation remains pending.');
    const offset = transcriptText(record).indexOf('# Later appendix');
    let count = 0;
    const agent = fixture(brain, async messages => {
      count++;
      if (count === 1) return proposal(call('find', 'search_notes', {query: 'calibration observations'}));
      if (count === 2) {
        const note = result(messages, 'find').result.notes[0];
        assert.equal(note.sourceCoverage, 'partial_source');
        assert.doesNotMatch(JSON.stringify(note), /selected nozzle is 7 mm/);
        return proposal(call('appendix', 'read_note', {id: 'long', offset, length: 2400}));
      }
      const outcome = result(messages, 'appendix');
      assert.equal(outcome.status, 'success'); assert.equal(outcome.executed, true);
      assert.match(JSON.stringify(outcome.result.notes), /planned observations, not a completed test/);
      assert.match(JSON.stringify(outcome.result.notes), /selected nozzle is 7 mm/);
      assert.equal(result(messages, 'find').result.notes.length, 0);
      assert.equal(JSON.stringify(messages).split('selected nozzle is 7 mm').length - 1, 1);
      return answer('The appendix selects a 7 mm nozzle, but validation remains pending and the observations are planned.');
    });
    await agent.initialize(); await agent.submitText('Moo, check the calibration archive and nozzle using only my notes.'); await agent.drain();
    assert.equal(agent.getState().lastError, undefined); assert.equal(count, 3);
    await agent.interrupt(); await agent.drain();
  });

  test(`${adapter}: repeated rejected read supplies reusable current evidence without disguising its execution status`, async t => {
    const {brain} = await setup(t);
    await add(brain, 'valve', 'Valve record', 'The valve observation lasted ten minutes; it does not establish long-term reliability.');
    let count = 0;
    const agent = fixture(brain, async messages => {
      count++;
      if (count <= 2) return proposal(call(`read-${count}`, 'read_note', {id: 'valve'}));
      const first = result(messages, 'read-1'), second = result(messages, 'read-2');
      assert.equal(first.status, 'success'); assert.equal(first.result.notes.length, 0);
      assert.equal(second.status, 'rejected'); assert.equal(second.executed, false);
      assert.match(second.error, /Duplicate/); assert.equal(second.result.notes.length, 1);
      assert.match(second.result.notes[0].original, /does not establish long-term reliability/);
      return answer('The observation lasted ten minutes and does not establish long-term reliability.');
    });
    await agent.initialize(); await agent.submitText('Moo, explain the saved valve observation.'); await agent.drain();
    assert.equal(agent.getState().lastError, undefined); assert.equal(count, 3);
    await agent.interrupt(); await agent.drain();
  });

  test(`${adapter}: source corrected after a tool completes replaces historical tool prose and permits the same read at the new revision`, async t => {
    const {brain} = await setup(t);
    await add(brain, 'limit', 'Current limit', 'The proposed limit is 16 kg.');
    const setState = brain.setState.bind(brain); let corrected = false;
    brain.setState = async (key, value) => {
      await setState(key, value);
      if (!corrected && key.startsWith('tool:') && key.endsWith(':read-1')) {
        corrected = true; const record = (await brain.getRecord('limit'))!;
        await brain.updateRecord(record.id, record.revision, {body: 'Correction: the proposed limit is 12 kg; no test was performed.'});
      }
    };
    let count = 0;
    const agent = fixture(brain, async messages => {
      count++;
      if (count === 1) return proposal(call('read-1', 'read_note', {id: 'limit'}));
      assert.match(JSON.stringify(messages), /proposed limit is 12 kg/);
      assert.doesNotMatch(JSON.stringify(messages), /proposed limit is 16 kg/);
      if (count === 2) return proposal(call('read-2', 'read_note', {id: 'limit'}));
      const outcome = result(messages, 'read-2');
      assert.equal(outcome.status, 'success'); assert.equal(outcome.executed, true);
      assert.equal(outcome.result.notes[0].revision, (await brain.getRecord('limit'))!.revision);
      assert.match(JSON.stringify(await brain.getState(`tool:${agent.getState().conversationId}:read-1`)), /proposed limit is 16 kg/);
      return answer('The corrected proposal is 12 kg; no test was performed.');
    });
    await agent.initialize(); await agent.submitText('Moo, read the proposed limit in my note.'); await agent.drain();
    assert.equal(agent.getState().lastError, undefined); assert.equal(count, 3);
    await agent.interrupt(); await agent.drain();
  });

  test(`${adapter}: failed, rejected and empty searches keep their query-specific statuses and never acquire fabricated evidence`, async t => {
    const {brain} = await setup(t);
    const search = brain.search.bind(brain);
    brain.search = async (query, ...args) => {if (query === 'unavailable archive') throw Error('Storage temporarily unavailable'); return search(query, ...args);};
    let count = 0;
    const agent = fixture(brain, async messages => {
      count++;
      if (count === 1) return proposal(call('absent', 'search_notes', {query: 'absent calibration'}),
        call('failed', 'search_notes', {query: 'unavailable archive'}), call('invalid', 'search_notes', {query: ''}));
      assert.equal(result(messages, 'absent').status, 'no_matches');
      assert.equal(result(messages, 'absent').query, 'absent calibration');
      assert.equal(result(messages, 'absent').executed, true);
      assert.equal(result(messages, 'failed').status, 'failed');
      assert.equal(result(messages, 'failed').query, 'unavailable archive');
      assert.match(result(messages, 'failed').error, /Storage temporarily unavailable/);
      assert.equal(result(messages, 'failed').executed, true);
      assert.equal(result(messages, 'invalid').status, 'rejected');
      assert.equal(result(messages, 'invalid').query, '');
      assert.equal(result(messages, 'invalid').executed, false);
      assert.ok(['absent', 'failed', 'invalid'].every(id => result(messages, id).result.notes.length === 0));
      return answer('The calibration query found no matches. The archive search failed, so I cannot infer whether that information is saved.');
    });
    await agent.initialize(); await agent.submitText('Moo, find calibration information in my notes.'); await agent.drain();
    assert.equal(agent.getState().lastError, undefined); assert.equal(count, 2);
    await agent.interrupt(); await agent.drain();
  });

  test(`${adapter}: source change during answer generation still blocks publication after evidence moves into tool messages`, async t => {
    const {brain} = await setup(t);
    await add(brain, 'change', 'Draft approval', 'The proposal is approved.');
    let count = 0;
    const agent = fixture(brain, async messages => {
      count++;
      if (count === 1) return proposal(call('read', 'read_note', {id: 'change'}));
      assert.match(result(messages, 'read').result.notes[0].original, /proposal is approved/);
      const record = (await brain.getRecord('change'))!;
      await brain.updateRecord(record.id, record.revision, {body: 'Correction: the proposal is not approved.'});
      return answer('The proposal is approved.');
    });
    await agent.initialize(); await agent.submitText('Moo, is the saved proposal approved?'); await agent.drain();
    assert.match(agent.getState().lastError!, /stale answer/);
    assert.ok((await brain.getRecord(agent.getState().conversationId!))!.segments.every(segment => segment.text !== 'The proposal is approved.'),
      'The stale answer is withheld; an explanatory failure message may remain');
    await agent.interrupt(); await agent.drain();
  });

  test(`${adapter}: retained evidence survives restart and is available without a fictional current-request tool`, async t => {
    const {brain, directory, close} = await setup(t);
    await add(brain, 'saved', 'Earlier observation', 'An observed result is not a proven guarantee.');
    await brain.setState('evidence-index:conversation', {refs: [{id: 'saved', offset: 0, length: 2400}], outcomes: []});
    if (adapter === 'sqlite') {
      await close();
      const reopened = new SQLiteBrain(directory);
      t.after(() => reopened.close());
      const prepared = retrievalMessages([{role: 'system', content: ''}], await loadEvidence(reopened, 'conversation'));
      assert.equal(prepared.messages.length, 1); assert.match(prepared.evidence.notes[0]!.original, /not a proven guarantee/);
    } else {
      const prepared = retrievalMessages([{role: 'system', content: ''}], await loadEvidence(brain, 'conversation'));
      assert.equal(prepared.messages.length, 1); assert.match(prepared.evidence.notes[0]!.original, /not a proven guarantee/);
    }
  });

  test(`${adapter}: graph excerpts retain accepted relationship provenance and changed links block the next provider call`, async t => {
    const {brain} = await setup(t);
    const seed = await add(brain, 'seed', 'Calibration plan', 'The plan references a separate inspection record.');
    await add(brain, 'inspection', 'Inspection result', 'Morgan observed no leak for ten minutes, not proof of long-term reliability.');
    await brain.updateRecord(seed.id, seed.revision, {links: [{targetId: 'inspection', provenance: 'manual', decision: 'accepted'}]});
    let count = 0;
    const agent = fixture(brain, async messages => {
      count++;
      if (count === 1) return proposal(call('read-seed', 'read_note', {id: 'seed'}));
      if (count === 2) return proposal(call('expand', 'related_notes', {id: 'seed'}));
      const note = result(messages, 'expand').result.notes[0];
      assert.equal(note.id, 'inspection'); assert.equal(note.via.id, 'seed'); assert.equal(note.via.hop, 1);
      assert.equal(note.via.relationships[0].provenance, 'manual'); assert.equal(note.via.relationships[0].decision, 'accepted');
      assert.match(note.relationshipNotice, /never proof/);
      return answer('The connected inspection records a ten-minute observation, not proof of long-term reliability.');
    }, true);
    await agent.initialize(); await agent.submitText('Moo, follow the calibration plan to its inspection result.'); await agent.drain();
    assert.equal(agent.getState().lastError, undefined); assert.equal(count, 3);
    await agent.interrupt(); await agent.drain();

    // A separate native request loses its link after the tool completes. No
    // stale source/provenance is allowed into a subsequent provider request.
    const setState = brain.setState.bind(brain); let changed = false;
    brain.setState = async (key, value) => {
      await setState(key, value);
      if (!changed && key.startsWith('tool:') && key.endsWith(':changed-expand')) {
        changed = true; const current = (await brain.getRecord('seed'))!;
        await brain.updateRecord(current.id, current.revision, {links: [{targetId: 'inspection', provenance: 'manual', decision: 'dismissed'}]});
      }
    };
    let changedCalls = 0;
    const again = fixture(brain, async () => {
      changedCalls++;
      return changedCalls === 1 ? proposal(call('changed-read', 'read_note', {id: 'seed'}))
        : proposal(call('changed-expand', 'related_notes', {id: 'seed'}));
    }, true);
    await again.initialize(); await again.submitText('Moo, check that calibration connection again.'); await again.drain();
    assert.equal(changedCalls, 2); assert.match(again.getState().lastError!, /Graph source or relationships changed/);
    await again.interrupt(); await again.drain();
  });
}

test('bounded current passages appear once across repeated search, reads and graph receipts; unavailable IDs have no old prose', async () => {
  const brain = new MemoryBrain();
  const records = [];
  for (let index = 0; index < 5; index++) records.push(await add(brain, `note-${index}`, `Calibration ${index}`, `Unique fact ${index}: ` + 'An exact source passage. '.repeat(120)));
  const current = {notes: records.map(record => noteEvidence(record, 0, 2400)), files: [], unavailableFiles: [], recentOutcomes: []};
  const history: ChatMessage[] = [{role: 'system', content: ''}];
  for (const [id, name] of [['lookup', 'search_notes'], ['graph', 'related_notes'], ['read', 'read_note']] as const) {
    history.push({role: 'assistant', content: '', toolCalls: [call(id, name, {id: 'note-0', query: 'calibration'})]},
      {role: 'tool', toolCallId: id, content: JSON.stringify({tool: name, status: 'success', executed: true, previewOnly: false,
        result: records.map(record => ({id: record.id, original: 'OLD STALE CONTENT'})).concat([{id: 'removed', original: 'DELETED CONTENT'}])})});
  }
  const prepared = retrievalMessages(history, current);
  assert.equal(prepared.evidence.notes.length, 0);
  assert.equal(result(prepared.messages, 'read').result.notes.length, 5);
  assert.equal(result(prepared.messages, 'lookup').result.notes.length, 0);
  const serialized = JSON.stringify(prepared);
  for (let index = 0; index < 5; index++) assert.equal(serialized.split(`Unique fact ${index}`).length - 1, 1);
  assert.doesNotMatch(serialized, /OLD STALE CONTENT|DELETED CONTENT/);
  assert.ok(result(prepared.messages, 'read').result.unavailableNoteIds.includes('removed'));
  assert.ok(Buffer.byteLength(serialized) < 24000, 'Five bounded references must not multiply through historical tool messages');
  assert.match(JSON.stringify(history), /OLD STALE CONTENT/, 'Preparing messages does not rewrite the audit history');
  const short = await add(brain, 'short', 'Exact complete source', 'Do not turn a proposal into completed work.');
  const duplicate = retrievalMessages([{role: 'system', content: ''}], {...current,
    notes: [noteEvidence(short, 0, 2400, 'proposal'), noteEvidence(short)]});
  assert.equal(duplicate.evidence.notes.length, 1, 'An identical complete search/read excerpt is not repeated');
  await brain.close();
});
