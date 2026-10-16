import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {ThoughtConsolidator} from '../src/thoughts.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import type {Segment} from '../../contracts/src/index.js';

for (const adapter of ['memory', 'sqlite']) test(`${adapter}: suppressing one topic cannot hide source corrections to another topic from the same speech block`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moo-suppression-review-'));
  const brain = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(directory);
  const now = () => '2026-10-10T12:00:00.000Z';
  let calls = 0;
  const engine = new ThoughtConsolidator({brain, now, emit() {}, notice() {}, async enrich() {}, async context() {return '';},
    generation: {async respond() {return {text: '', toolCalls: []};}, async summarize() {return {title: '', summary: ''};},
      async consolidate(input) {
        calls++;
        const source = input.segments[0]!, boundary = source.text.indexOf('The label');
        return {groups: [
          {title: 'Cooling plan', summary: source.text.slice(0, boundary), ongoing: false,
            spans: [{segmentId: source.id, revision: source.revision, start: 0, end: boundary}]},
          {title: 'Label colour', summary: source.text.slice(boundary), ongoing: true,
            spans: [{segmentId: source.id, revision: source.revision, start: boundary, end: source.text.length}]},
        ], remainder: []};
      }}});
  try {
    await brain.createRecord({id: 'session', kind: 'session', createdAt: now()});
    const source: Segment = {id: 'two-topics', turnId: 'speech', speaker: 'user', revision: 1, final: true,
      createdAt: now(), text: 'The cooling plan is 12 minutes. The label colour is blue.'};
    await brain.upsertSegment('session', source); await engine.append('session', [source]); await engine.process('session');
    const notes = await brain.query({kinds: ['dictation']}), cooling = notes.find(note => note.title === 'Cooling plan')!, label = notes.find(note => note.title === 'Label colour')!;
    assert.ok(cooling && label);
    await brain.updateRecord(cooling.id, cooling.revision, {quality: 'ready'});
    assert.equal((await engine.suppress('session')).status, 'suppressed');
    const correction = {...source, revision: 2, text: source.text.replace('12 minutes', '9 minutes')};
    await brain.upsertSegment('session', correction); await engine.append('session', [correction]);
    assert.equal((await brain.getRecord(cooling.id))!.quality, 'needs_review', 'A shared source correction must remain visible on the unsuppressed note');
    assert.ok((await brain.getRecord(label.id))!.suppressed);
    await engine.process('session'); assert.equal(calls, 1, 'No suppressed source is regenerated');
    assert.equal((await brain.query({kinds: ['dictation']})).length, 1);
    let paidCalls=0;
    const provider=new FixtureProviders();
    provider.summarize=async record=>{paidCalls++;return {title:record.title,summary:record.segments.map(s=>s.text).join(' '),topicSuggestion:'Cooling'};};
    provider.tag=async()=>{paidCalls++;return {purpose:'Reference',purposeConfidence:1,doubt:0,faithful:1,understandable:1,topics:{},relevant:1};};
    const agent=new Agent({brain,generation:provider,decisions:provider,search:provider,vision:provider,
      capture:{async capture(){throw Error('No capture');}},speech:{async speak(){},async stop(){}},id:()=> 'unused',now});
    await agent.queueEnrichment(cooling.id);await agent.drain();
    assert.equal(paidCalls,0,'A changed partial source projection cannot be resummarized or certified against obsolete copied text');
    await agent.retrySummary(cooling.id);await agent.drain();
    assert.equal(paidCalls,0,'A changed partial source projection cannot be resummarized or certified against obsolete copied text');
    assert.equal((await brain.getRecord(cooling.id))!.quality,'needs_review');
    assert.match((await brain.getRecord(cooling.id))!.error!,/source.*correct|projection/i);
    await brain.putOperation({id:'retained-pending-enrichment',kind:'enrich',recordId:cooling.id,
      sourceRevision:cooling.sourceRevision,status:'pending',attempts:0});
    await agent.initialize();await agent.drain();
    assert.equal(paidCalls,0,'Restarting undispatched work also checks the authoritative source');
    assert.equal((await brain.getRecord(cooling.id))!.quality,'needs_review');
    assert.equal((await brain.listOperations()).find(op=>op.id==='retained-pending-enrichment')!.status,'failed');
  } finally {await brain.close(); await rm(directory, {recursive: true, force: true});}
});
