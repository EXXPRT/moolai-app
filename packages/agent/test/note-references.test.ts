import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBrain} from '../../brain/src/index.js';
import {resolveNoteReferences} from '../src/references.js';
import {buildResponseContext} from '../src/response-context.js';
import {newRecord} from '../../contracts/src/records.js';

test('retained suppressed/source records cannot become clickable note references', async () => {
  const brain = new MemoryBrain();
  const cases = [
    {id: 'available', kind: 'note' as const},
    {id: 'archived', kind: 'note' as const, archived: true},
    {id: 'suppressed', kind: 'dictation' as const,
      suppressed: {at: '2026-01-01T00:00:00Z', operationId: 'suppress', sessionId: 'session'}},
    {id: 'source', kind: 'conversation' as const, sourceOnly: true},
    {id: 'session', kind: 'session' as const},
  ];
  const records = [];
  for (const item of cases) {
    let record = await brain.createRecord({id: item.id, kind: item.kind, createdAt: '2026-01-01T00:00:00Z'});
    record = (await brain.updateRecord(record.id, record.revision, {...item, title: item.id}))!;
    records.push(record);
  }
  const reply = resolveNoteReferences({text: 'The prior conversation is retained.', toolCalls: [],
    references: records.map(record => ({recordId: record.id, title: record.title}))}, records);
  assert.deepEqual(reply.references, [{recordId: 'available', title: 'available'}]);
  assert.equal(reply.text, 'The prior conversation is retained.');
  const context = buildResponseContext({conversationId: 'active', segments: [], linkedRequests: [records[2]!]});
  const envelope = JSON.parse(context.messages[0]!.content.split('\n').slice(1).join('\n'));
  assert.equal(envelope.originalRequests[0].retrieval, 'context_only');
  await brain.close();
});

test('an imported address inside a complete readable title is not expanded again', () => {
  const record = {...newRecord({id: 'review-slip', kind: 'note', createdAt: '2026-01-01T00:00:00Z'}),
    title: 'Library review-slip proposal'};
  const text = 'See Library review-slip proposal. The heading LIBRARY REVIEW-SLIP PROPOSAL is readable. Use review-slip for the note; lot AB123 remains 12 kg.';
  const reply = resolveNoteReferences({text, spokenText: text, toolCalls: [],
    references: [{recordId: record.id, title: record.title}],
    spokenOutline: {overview: record.title, points: [{label: record.title, explanation: 'See review-slip.'}]}}, [record]);
  assert.equal(reply.text, text.replace('Use review-slip', 'Use Library review-slip proposal'));
  assert.equal(reply.spokenText, reply.text);
  assert.equal(reply.spokenOutline!.overview, record.title);
  assert.equal(reply.spokenOutline!.points[0]!.label, record.title);
  assert.equal(reply.spokenOutline!.points[0]!.explanation, 'See Library review-slip proposal.');
});

test('address replacements do not cascade into another inserted readable title', () => {
  const a = {...newRecord({id: 'first-note-address', kind: 'note', createdAt: '2026-01-01T00:00:00Z'}), title: 'Summary of second-note-address'};
  const b = {...a, id: 'second-note-address', title: 'Related thought'};
  const text = `See ${a.id}; separately see ${b.id}. Lot AB123 and path /AB123 remain literal.`;
  const result = resolveNoteReferences({text, toolCalls: []}, [a, b]);
  assert.equal(result.text, 'See Summary of second-note-address; separately see Related thought. Lot AB123 and path /AB123 remain literal.');
});
