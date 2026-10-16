import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import type {VisionEvidence, VisionObservation} from '../../contracts/src/index.js';
import {validateVision, usableVision} from '../src/evidence.js';
import {rig} from '../../../experiments/agent-closeout/support.js';

const evidence = (observations: VisionObservation[]): VisionEvidence => ({raw: JSON.stringify({observations}), observations,
  interpretation: '', validated: true, validationErrors: []});
const absent = (field: string): VisionObservation => ({field, status: 'absent', value: null, label: null, sourceExcerpt: null});
const question = 'Read Batch lot only. Do not use Receipt or Total.';

test('unrelated absent observations cannot prove absence of the requested field', () => {
  const input = evidence([{...absent('Receipt: 88241'), label: 'Receipt: 88241', sourceExcerpt: 'Receipt: 88241'},
    {...absent('Total: 31.20'), label: 'Total: 31.20', sourceExcerpt: 'Total: 31.20'}]);
  const checked = validateVision(input, question), usable = usableVision(checked);
  assert.deepEqual(usable.observations, []);
  assert.equal(usable.validated, false);
  assert.match(usable.evidenceNotice, /not evidence that the field is absent/);
  assert.doesNotMatch(JSON.stringify(usable), /88241|31\.20/);
  assert.equal(checked.raw, input.raw);
});

test('a valid requested absent field is preserved without inventing a value', () => {
  const usable = usableVision(validateVision(evidence([absent('Batch lot')]), question));
  assert.deepEqual(usable.observations, [absent('Batch lot')]);
  assert.equal(usable.validated, true);
});

test('even a matching absent field cannot carry a contradictory visible label', () => {
  const checked = validateVision(evidence([{...absent('Batch lot'), label: 'Batch lot', sourceExcerpt: 'Batch lot: QA-19'}]), question);
  assert.deepEqual(usableVision(checked).observations, []);
  assert.equal(checked.validated, false);
  assert.match(checked.raw, /QA-19/);
});

test('partial unreadable content stays local while its requested status remains usable', () => {
  const input = evidence([{field: 'Serial', status: 'unreadable', value: 'KL 4', label: 'Serial', sourceExcerpt: 'Serial: KL 4'}]);
  const checked = validateVision(input, 'Read the complete Serial.'), usable = usableVision(checked);
  assert.deepEqual(usable.observations, [{field: 'Serial', status: 'unreadable', value: null, label: null, sourceExcerpt: null}]);
  assert.doesNotMatch(JSON.stringify(usable), /KL 4/);
  assert.equal(checked.raw, input.raw);
  assert.equal(checked.validated, false);
});

test('numeric field names are preserved when requested, never stripped to guess a match', () => {
  const input = evidence([absent('Channel 12 pressure')]);
  assert.equal(validateVision(input, 'Read Channel 12 pressure.').observations[0]?.field, 'Channel 12 pressure');
  assert.deepEqual(validateVision(input, 'Read Channel 9 pressure.').observations, []);
});

test('diagnostic text and discarded values do not become answer evidence', () => {
  const input = {...evidence([absent('Serial')]), validationErrors: ['Serial supplied guessed value ZX-99'], validated: false};
  const checked = validateVision(input, 'Read Serial.');
  assert.doesNotMatch(JSON.stringify(usableVision(checked)), /ZX-99/);
  assert.match(checked.validationErrors.join(' '), /ZX-99/);
});

test('invalid readable field names cannot smuggle discarded values, while independent valid fields survive', () => {
  const input = evidence([
    {field: 'Batch lot Receipt 88241', status: 'readable', value: '88241', label: 'Receipt', sourceExcerpt: 'No visible identifier'},
    {field: 'Weight', status: 'readable', value: '18 kg', label: 'Weight', sourceExcerpt: 'Weight: 18 kg'},
  ]);
  const checked = validateVision(input, 'Read Batch lot and Weight.'), usable = usableVision(checked);
  assert.equal(checked.observations.length, 2, 'Full normalized observations remain available for local review');
  assert.deepEqual(usable.observations.map(observation => observation.field), ['Weight']);
  assert.equal(usable.observations[0]!.value, '18 kg');
  assert.doesNotMatch(JSON.stringify(usable), /88241/);
  assert.match(checked.raw, /88241/);
});

for (const adapter of ['memory', 'sqlite']) test(`${adapter}: native screenshot handoff omits unrelated absence claims and retains raw evidence`, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'moo-vision-absence-'));
  const brain = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(folder);
  const f = rig(brain), input = evidence([{...absent('Receipt: 88241'), label: 'Receipt: 88241', sourceExcerpt: 'Receipt: 88241'}]);
  f.hooks.vision.interpret = async () => input;
  let calls = 0;
  f.hooks.generation.respond = async () => ++calls === 1
    ? {text: '', toolCalls: [{id: 'capture', name: 'capture_screen', arguments: {question}}]}
    : {text: 'The screenshot extraction did not establish whether the requested field is present.', toolCalls: []};
  try {
    await f.agent.initialize();
    await f.agent.submitText('Moo, take a screenshot and read the Batch lot only.');
    await f.agent.drain();
    const messages = f.observed.generations[1]!.messages;
    const result = JSON.parse(messages.find((m: any) => m.role === 'tool')!.content).result;
    assert.deepEqual(result.observations, []);
    assert.equal(result.validated, false);
    assert.doesNotMatch(JSON.stringify(messages), /88241/);
    const record = (await brain.getRecord(f.agent.getState().conversationId!))!;
    const saved: any = await brain.getState(`evidence:${record.attachmentIds[0]}`);
    assert.equal(saved.evidence.raw, input.raw);
    assert.ok(saved.evidence.validationErrors.length > 0);
  } finally {await brain.close(); await rm(folder, {recursive: true, force: true});}
});

for (const adapter of ['memory', 'sqlite']) {
  for (const failure of ['unvalidated', 'provider']) test(`${adapter}: ${failure} screenshot attempt is removed from tools until a new request`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'moo-capture-availability-'));
    const brain = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(folder);
    const f = rig(brain);
    let calls = 0, captures = 0, interpretations = 0;
    f.hooks.capture.capture = async () => {captures++; return {mimeType: 'image/png', bytes: new Uint8Array([1, 2])};};
    f.hooks.vision.interpret = async () => {
      interpretations++;
      if (failure === 'provider') throw Error('Fixture provider unavailable');
      return {...evidence([]), validated: false, validationErrors: ['No supported observation']};
    };
    f.hooks.generation.respond = async (messages, tools) => {
      calls++;
      if (calls % 2) {
        assert.ok(tools.some(tool => tool.name === 'capture_screen'));
        return {text: '', toolCalls: [{id: `capture-${calls}`, name: 'capture_screen', arguments: {question}}]};
      }
      assert.ok(!tools.some(tool => tool.name === 'capture_screen'));
      assert.match(messages[0]!.content, /another|new user request/);
      return {text: 'I could not establish the requested field from that extraction.',
        spokenText: 'I could not establish the requested field from that extraction.', toolCalls: []};
    };
    try {
      await f.agent.initialize();
      await f.agent.submitText('Moo, take a screenshot and read the Batch lot only.');
      await f.agent.drain();
      assert.equal(captures, 1); assert.equal(interpretations, 1); assert.equal(calls, 2);
      await f.agent.submitText('Take a fresh screenshot and read the Batch lot again.');
      await f.agent.drain();
      assert.equal(captures, 2); assert.equal(interpretations, 2); assert.equal(calls, 4);
    } finally {await brain.close(); await rm(folder, {recursive: true, force: true});}
  });
}
