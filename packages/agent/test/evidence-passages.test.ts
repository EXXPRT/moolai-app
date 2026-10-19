import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BrainPort, BrainRecord} from '../../contracts/src/index.js';
import {transcriptText} from '../../contracts/src/index.js';
import {newRecord} from '../../contracts/src/records.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {loadEvidence, noteEvidence, rememberEvidence, evidenceCurrent} from '../src/evidence.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

const at = '2026-10-10T12:00:00.000Z';
const background = 'General context concerns unrelated instrument labels and packaging. '.repeat(50);
const note = (): BrainRecord => ({...newRecord({id: 'journal', kind: 'note', createdAt: at}), title: 'Cooling journal',
  body: `Imported copy on 2026-10-10.\n\n# General\n${background}\n\n## Cooling trial — 2026-06-12\nThe cooling trial failed after 12 minutes. The pressure remains uncertain.\n\n## Cooling follow-up — 2026-06-14\nA repeat trial is planned, not completed.\n\n## Other material\n${background}`});
const visible = (value: ReturnType<typeof noteEvidence>) => [value.original, ...value.additionalPassages.map(p => p.original)].join('\n<omitted>\n');

test('production packets preserve exact disjoint passages, unchanged source allowance and dated scope', () => {
  const source = note(), result = noteEvidence(source, 0, 2400, 'What is the latest cooling trial status?');
  assert.match(visible(result), /failed after 12 minutes.*repeat trial is planned, not completed/s);
  const windows = [result, ...result.additionalPassages];
  assert.equal(result.returnedCharacters, windows.reduce((sum, window) => sum + window.original.length, 0));
  assert.ok(result.returnedCharacters <= 2400);
  for (const window of windows) assert.equal(window.original, transcriptText(source).slice(window.offset, window.nextOffset));
  assert.ok(windows.flatMap(window => window.dates ?? []).some(date => date.meaning === 'document_section_date'));
  assert.equal(result.recordTimes.meaning, 'record_lifecycle_not_event_time');
  assert.equal(noteEvidence(source, 0, 6000).original.length, 6000);
  assert.equal(noteEvidence(source, 0, 100000).original.length, 6000, 'Legacy callers cannot bypass the existing read cap');
  assert.equal(noteEvidence(source, 200, 99, 'cooling').original, transcriptText(source).slice(200, 299), 'A positive explicit offset always stays exact');
});

for (const adapter of ['memory', 'sqlite']) {
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'moo-evidence-passages-'));
    let brain: BrainPort = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
    await brain.importRecord(note());
    return {get brain() {return brain;}, async restart() {if (adapter === 'sqlite') {await brain.close(); brain = new SQLiteBrain(directory);}},
      async close() {await brain.close(); await rm(directory, {recursive: true, force: true});}};
  }

  test(`${adapter}: current source corrections reselect query passages after restart rather than retaining obsolete offsets`, async () => {
    const t = await setup();
    try {
      const source = (await t.brain.getRecord('journal'))!, query = 'latest cooling trial status';
      const output = noteEvidence(source, 0, 2400, query);
      await rememberEvidence(t.brain, 'conversation', {call: {id: 'search', name: 'search_notes', arguments: {query}}, status: 'success', result: [output]});
      const before = await loadEvidence(t.brain, 'conversation');
      await t.brain.updateRecord(source.id, source.revision, {body: `Extra background. ${background}\n\n${source.body!.replace('12 minutes', '9 minutes, corrected from 12')}`, title: 'My cooling journal', manualFields: ['title']});
      assert.equal(await evidenceCurrent(t.brain, before), false);
      await t.restart();
      const refreshed = await loadEvidence(t.brain, 'conversation');
      assert.match(visible(refreshed.notes[0]!), /9 minutes, corrected from 12/);
      assert.equal(refreshed.notes[0]!.title, 'My cooling journal');
      assert.notEqual(refreshed.notes[0]!.offset, output.offset);
      assert.equal(await evidenceCurrent(t.brain, refreshed), true);
    } finally {await t.close();}
  });

  test(`${adapter}: explicit continuation passages survive alongside preceding evidence within eight retained references`, async () => {
    const t = await setup();
    try {
      const source = (await t.brain.getRecord('journal'))!;
      for (const offset of [100, 400, 400]) {
        await rememberEvidence(t.brain, 'conversation', {call: {id: `read-${offset}`, name: 'read_note', arguments: {id: source.id, offset, length: 200}},
          status: 'success', result: noteEvidence(source, offset, 200)});
      }
      await t.restart();
      const result = await loadEvidence(t.brain, 'conversation');
      assert.deepEqual(result.notes.map(item => item.offset), [100, 400]);
      for (let i = 0; i < 6; i++) await rememberEvidence(t.brain, 'conversation', {call: {id: `read-more-${i}`, name: 'read_note', arguments: {id: source.id, offset: 600 + 200 * i, length: 200}},
        status: 'success', result: noteEvidence(source, 600 + 200 * i, 200)});
      // The last five distinct notes are kept, at most eight references in all (ATR-02).
      assert.equal((await loadEvidence(t.brain, 'conversation')).notes.length, 8);
    } finally {await t.close();}
  });

  test(`${adapter}: the real Agent read tool uses a query for dated passages and an explicit zero offset for the source start`, async () => {
    const t = await setup(), providers = new FixtureProviders();
    let count = 0, calls = 0;
    providers.respond = async messages => {
      calls++;
      if (calls === 1) return {text: '', toolCalls: [{id: 'dated', name: 'read_note', arguments: {id: 'journal', query: 'latest cooling trial status'}}]};
      if (calls === 2) {
        const dated = JSON.parse(messages.find(message => message.toolCallId === 'dated')!.content);
        assert.equal(dated.status, 'success');
        assert.match(JSON.stringify(dated.result.notes), /Cooling trial.*failed after 12 minutes.*not completed/s);
        assert.equal(dated.result.notes[0].recordTimes.meaning, 'record_lifecycle_not_event_time');
        assert.doesNotMatch(messages[0]!.content, /failed after 12 minutes/, 'Source prose is not duplicated in the system index');
        return {text: '', toolCalls: [{id: 'head', name: 'read_note', arguments: {id: 'journal', query: 'cooling', offset: 0, length: 80}}]};
      }
      const head = JSON.parse(messages.find(message => message.toolCallId === 'head')!.content);
      assert.equal(head.status, 'success');
      const prefix = head.result.notes.find((note: {offset: number}) => note.offset === 0);
      assert.match(prefix.original, /Imported copy on 2026-10-10/);
      assert.equal(prefix.original, transcriptText(note()).slice(0, 80));
      assert.match(JSON.stringify(head.result.notes), /failed after 12 minutes/, 'The earlier dated passage remains available alongside the explicit prefix');
      assert.equal(JSON.parse(messages.find(message => message.toolCallId === 'dated')!.content).result.notes.length, 0);
      return {text: 'The cooling trial failed; the later entry is a plan, not a completed retest.',
        spokenText: 'The trial failed and its repeat remains planned.', toolCalls: []};
    };
    const agent = new Agent({brain: t.brain, decisions: providers, generation: providers, search: providers, vision: providers,
      capture: {async capture() {throw Error('not used');}}, speech: {async speak() {}, async stop() {}}, id: () => `agent-${++count}`, now: () => at});
    try {
      await agent.initialize(); await agent.submitText('Moo, explain the latest cooling trial status using only my notes.'); await agent.drain();
      assert.equal(agent.getState().lastError, undefined);
      assert.equal(calls, 3);
    } finally {await agent.interrupt(); await agent.drain(); await t.close();}
  });
}
