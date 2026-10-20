import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryBrain} from '../../brain/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import {Agent} from '../src/index.js';

// J7's review flags use calibrated thresholds (21 Oct): faithful summaries score 0.57-0.86 for fidelity and planted
// errors 0.02-0.17; complete notes score 0.69-0.94 for context and fragments 0.43-0.50.
for (const [faithful, understandable, reasons] of [
  [0.62, 0.78, []],
  [0.12, 0.9, ['source fidelity']],
  [0.8, 0.45, ['missing context']],
] as const) test(`a note J7 scores ${faithful} for fidelity and ${understandable} for context is flagged for ${reasons.join(', ') || 'nothing'}`, async () => {
  const brain = new MemoryBrain(); const p = new FixtureProviders(); let n = 0;
  p.tag = async () => ({purpose: 'Reference', purposeConfidence: 1, topics: {}, doubt: 0, faithful, understandable, relevant: undefined});
  const agent = new Agent({brain, decisions: p, generation: p, search: p, vision: p, capture: {async capture() { throw Error('unused'); }},
    speech: {async speak() {}, async stop() {}}, id: () => `n-${++n}`, now: () => '2026-10-21T01:00:00Z'});
  await agent.initialize(); await agent.startSession();
  await agent.submitText('Glaciers move because ice deforms under its own weight.'); await agent.drain();
  await agent.consolidateThoughts(true); await agent.drain();
  const note = (await brain.listRecords()).find(r => r.kind === 'dictation' && !r.sourceOnly)!;
  assert.deepEqual(note.qualityReasons, [...reasons]);
  assert.equal(note.quality, reasons.length ? 'needs_review' : 'ready');
  await agent.stopSession(); await agent.drain(); await brain.close();
});
