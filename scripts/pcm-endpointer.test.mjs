import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmEndpointer } from './pcm-endpointer.mjs';
import { endpointCases, endpointProfiles, renderEndpointCase } from './voice-endpoint-fixtures.mjs';
import { evaluateEndpoint, endpointReport } from './benchmark-voice-endpoints.mjs';

const config = { endpointSilenceMs: 1200, preRollMs: 500, rmsThreshold: 0.008, maxUtteranceSeconds: 60 };
for (const rate of [8000, 16000, 24000, 44100, 48000]) {
  test(`${rate} Hz: packet sizes cannot change retained PCM or endpoint decisions`, () => {
    for (const profile of endpointProfiles(config)) {
      for (const input of endpointCases) {
        const whole = evaluateEndpoint(input, profile, rate, [rate * 10]);
        assert.deepEqual(evaluateEndpoint(input, profile, rate, [2048]), whole, `${profile.id}/${input.id}: native buffers`);
        assert.deepEqual(evaluateEndpoint(input, profile, rate, [1, 79, 257, 1019]), whole, `${profile.id}/${input.id}: fragmented buffers`);
      }
    }
  });
}

test('a final one-sample tail and its context survive Stop exactly once', () => {
  const received = [];
  const endpoint = new PcmEndpointer(config, 16000, u => received.push(u));
  const raw = Buffer.alloc(642); for (let i = 0; i < raw.length; i += 2) raw.writeInt16LE(2000, i);
  endpoint.push(raw.subarray(0, 200), 'iodine');
  endpoint.push(raw.subarray(200), 'new hint');
  endpoint.commit();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].pcm, raw);
  assert.equal(received[0].context, 'iodine', 'Context is fixed when the first analysis frame starts');
  assert.equal(received[0].endSample, 321);
  assert.throws(() => endpoint.commit(), /already been committed/);
  assert.throws(() => endpoint.push(raw), /after the final commit/);
});

test('discard clears unfinished frames and forbids a stale capture from resuming', () => {
  let calls = 0;
  const endpoint = new PcmEndpointer(config, 16000, () => { calls++; });
  endpoint.push(Buffer.from([255, 31]));
  endpoint.discard();
  assert.equal(endpoint.pending.length, 0);
  assert.equal(endpoint.bytes, 0);
  assert.throws(() => endpoint.commit(), /already been committed/);
  assert.equal(calls, 0);
});

test('retained buffers are owned: later caller mutation cannot rewrite the utterance', () => {
  const received = [];
  const endpoint = new PcmEndpointer(config, 16000, u => received.push(u));
  const { pcm } = renderEndpointCase(endpointCases.find(c => c.id === 'stop-with-short-final-frame'), 16000);
  const original = Buffer.from(pcm);
  endpoint.push(pcm); pcm.fill(0); endpoint.commit();
  assert.deepEqual(received[0].pcm, original);
});

test('invalid payloads fail; speech with no gap is split at the limit and never dropped', () => {
  const received = [];
  const endpoint = new PcmEndpointer({ ...config, maxUtteranceSeconds: 0.1 }, 16000, u => received.push(u));
  assert.throws(() => endpoint.push(Buffer.alloc(3)), /even byte/);
  const raw = Buffer.alloc(8000); for (let i = 0; i < raw.length; i += 2) raw.writeInt16LE(2000, i);
  endpoint.push(raw); endpoint.commit();
  assert.deepEqual(received.map(u => u.trigger), ['limit', 'limit', 'commit']);
  assert.deepEqual(received.map(u => u.utteranceSequence), [1, 2, 3]);
  assert.ok(received.every(u => u.pcm.length <= 3200), 'No utterance exceeds the limit');
  assert.deepEqual(Buffer.concat(received.map(u => u.pcm)), raw);
});

test('reading aloud with only sentence gaps ends at a gap once the utterance is long (MOO-074)', () => {
  const received = [];
  const endpoint = new PcmEndpointer({ ...config, maxUtteranceSeconds: 4 }, 16000, u => received.push(u));
  const tone = ms => { const b = Buffer.alloc(ms * 32); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(2000, i); return b; };
  const parts = [];
  for (let i = 0; i < 8; i++) parts.push(tone(800), Buffer.alloc(400 * 32));
  parts.push(tone(800));
  const raw = Buffer.concat(parts);
  endpoint.push(raw); endpoint.commit();
  assert.ok(received.length >= 3);
  assert.ok(received[0].pcm.length >= 0.75 * 4 * 32000, 'Sentence gaps do not end a short utterance');
  assert.ok(received.slice(0, -1).every(u => u.trigger === 'pause'), 'Long utterances end at a sentence gap, not at the limit');
  assert.ok(received.every(u => u.pcm.length <= 4 * 32000));
  assert.deepEqual(Buffer.concat(received.map(u => u.pcm)), raw, 'Every captured sample reaches ASR once');
});

test('comparison reports speed and segmentation risks separately, never an invented accuracy gain', () => {
  const report = endpointReport(config);
  assert.equal(report.rows.length, 200);
  const row = (profile, id) => report.rows.find(r => r.profile === profile && r.case === id && r.sampleRate === 16000);
  assert.equal(row('current', 'ordinary').boundaries[0].endpointWaitMs, 1200);
  assert.equal(row('pause-500', 'ordinary').boundaries[0].endpointWaitMs, 500);
  assert.equal(row('current', 'thinking-pause-700ms').splitThought, false);
  for (const ms of [400, 500, 600]) assert.equal(row(`pause-${ms}`, 'thinking-pause-700ms').splitThought, true);
  assert.equal(row('current', 'soft-first-syllable').firstSampleRetained, false);
  assert.equal(row('preroll-750', 'soft-first-syllable').firstSampleRetained, true);
  assert.equal(row('current', 'isolated-click').falseActivation, true, 'Known energy-detector limitation stays visible');
  assert.equal(row('current', 'quiet-whole-utterance').missedSpeech, true);
  assert.ok(report.rows.filter(r => r.case === 'stop-with-short-final-frame').every(r => r.finalSampleRetained));
  assert.equal(report.productionChanged, false);
  assert.equal(report.modelCalls, 0);
});

test('previews replace cumulative audio without changing final boundaries, context or one-sample tail', () => {
  const events = [], finals = [];
  const settings = { ...config, previewIntervalMs: 1000 };
  const endpoint = new PcmEndpointer(settings, 16000, value => finals.push(value), value => events.push(value));
  const raw = Buffer.alloc(32000 * 2 + 2); for (let i = 0; i < raw.length; i += 2) raw.writeInt16LE(2000, i);
  endpoint.push(raw.subarray(0, 32000), 'Iodine');
  endpoint.push(raw.subarray(32000), 'New context'); endpoint.commit();
  assert.deepEqual(events.map(e => e.pcm.length), [32000, 64000]);
  assert.deepEqual(events.map(e => e.revision), [1, 2]);
  assert.ok(events.every(e => e.context === 'Iodine' && e.utteranceSequence === 1));
  assert.deepEqual(finals[0].pcm, raw); assert.equal(finals[0].revision, 3);
  assert.equal(finals[0].utteranceSequence, 1); assert.equal(finals[0].endSample, 32001);
});

test('previews never originate from silence, share IDs until an endpoint and reset across utterances', () => {
  const events = [], finals = [];
  const endpoint = new PcmEndpointer({ ...config, previewIntervalMs: 1000 }, 16000, e => finals.push(e), e => events.push(e));
  endpoint.push(Buffer.alloc(64000)); assert.equal(events.length, 0);
  const raw = Buffer.alloc(32000); for (let i = 0; i < raw.length; i += 2) raw.writeInt16LE(2000, i);
  endpoint.push(raw); endpoint.push(Buffer.alloc(38400));
  endpoint.push(raw); endpoint.commit();
  assert.deepEqual(finals.map(e => e.utteranceSequence), [1, 2]);
  assert.deepEqual(events.map(e => e.utteranceSequence), [1, 2]);
  assert.ok(finals.every(e => e.revision === 2));
});
