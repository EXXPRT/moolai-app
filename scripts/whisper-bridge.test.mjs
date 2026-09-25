import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createWhisperBridge, decodeWhisper, pcmWav, repetitiveOutput, resamplePcm } from './whisper-bridge.mjs';

const config = { model: 'large-v3-turbo', language: 'en', initialPrompt: 'Moo.', port: 0, inferencePort: 8177,
  endpointSilenceMs: 100, maxUtteranceSeconds: 2, rmsThreshold: 0.008, preRollMs: 40 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); } throw new Error('Condition was not reached'); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function pcm(ms, rate = 16000, amplitude = 1000) {
  const result = Buffer.alloc(Math.round(ms * rate / 1000) * 2);
  for (let i = 0; i < result.length; i += 2) result.writeInt16LE(amplitude, i);
  return result;
}
async function harness(t, overrides = {}, deps = {}) {
  const bridge = createWhisperBridge({ ...config, ...overrides }, { resample: async p => p, decode: async () => 'Moo, a complete thought.', ...deps });
  await bridge.listen();
  const clients = [];
  t.after(async () => { for (const c of clients) c.socket.terminate(); await bridge.close(); });
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/v1/audio/transcriptions/realtime`);
    const events = []; const waiters = new Set();
    socket.on('message', bytes => { events.push(JSON.parse(bytes.toString())); for (const wake of waiters) wake(); });
    socket.on('error', () => {});
    const client = { socket, events, send: event => socket.send(JSON.stringify(event)),
      wait: (type, count = 1) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(events)}`)); }, 1500);
        function check() { const matches = events.filter(e => e.type === type); if (matches.length >= count) { clearTimeout(timeout); waiters.delete(check); resolve(matches[count - 1]); } }
        waiters.add(check); check();
      }),
      configure: async function (rate = 16000) { this.send({ type: 'session.update', session: { sample_rate: rate } }); await this.wait('session.updated'); },
    };
    clients.push(client); await once(socket, 'open'); return client;
  }
  return { bridge, connect };
}
const completed = 'conversation.item.input_audio_transcription.completed';
const commit = 'input_audio_buffer.committed';

test('48 kHz is passed accurately to memory-only resampling; decode receives configured prompt and preserves newlines', async t => {
  const calls = [];
  const { connect } = await harness(t, {}, {
    resample: async (raw, rate, { signal }) => { assert.equal(rate, 48000); assert.equal(raw.length, 9600); assert.equal(signal.aborted, false); return pcm(100); },
    decode: async (raw, settings) => { calls.push(raw.length); assert.equal(settings.initialPrompt, 'Moo.'); return 'Moo.\nUse only my notes.\nKeep the final word telescope.'; },
  });
  const c = await connect(); await c.configure(48000); c.socket.send(pcm(100, 48000)); c.send({ type: 'input_audio_buffer.commit' });
  await c.wait(commit);
  assert.deepEqual(calls, [3200]);
  assert.equal(c.events.filter(e => e.type === completed).length, 1);
  assert.equal(c.events.find(e => e.type === completed).transcript, 'Moo.\nUse only my notes.\nKeep the final word telescope.');
  assert.ok(c.events.findIndex(e => e.type === completed) < c.events.findIndex(e => e.type === commit));
});

test('digital silence acknowledges without decoding or emitting an empty final', async t => {
  let decodes = 0;
  const { connect } = await harness(t, {}, { decode: async () => { decodes++; return 'hallucination'; } });
  const c = await connect(); await c.configure(); c.socket.send(pcm(1500, 16000, 0)); c.send({ type: 'input_audio_buffer.commit' });
  await c.wait(commit); assert.equal(decodes, 0); assert.equal(c.events.filter(e => e.type === completed).length, 0);
});

test('pause endpoints serialize decodes, preserve preroll, and drain the final tail before committed', async t => {
  const first = deferred(); const second = deferred(); let calls = 0; const lengths = [];
  const { connect } = await harness(t, {}, { decode: async raw => { lengths.push(raw.length); return (++calls === 1 ? first : second).promise; } });
  const c = await connect(); await c.configure();
  c.socket.send(pcm(40, 16000, 50)); // Below threshold; retained as contextual preroll.
  c.socket.send(pcm(100)); c.socket.send(pcm(100, 16000, 0));
  await delay(20); assert.equal(calls, 1);
  c.socket.send(pcm(80)); c.send({ type: 'input_audio_buffer.commit' });
  await delay(20); assert.equal(calls, 1); assert.equal(c.events.some(e => e.type === commit), false);
  first.resolve('First thought.'); await c.wait(completed); await delay(10); assert.equal(calls, 2);
  assert.equal(c.events.some(e => e.type === commit), false);
  second.resolve('Tail word telescope.'); await c.wait(commit);
  assert.deepEqual(c.events.filter(e => e.type === completed).map(e => e.transcript), ['First thought.', 'Tail word telescope.']);
  assert.deepEqual(lengths, [7680, 2560]);
  assert.equal(c.events.at(-1).type, commit);
});

test('disconnect aborts in-flight work and discards stale output before a new capture', async t => {
  const late = deferred(); let signal, calls = 0;
  const { connect } = await harness(t, {}, { decode: async (_, __, opts) => { signal = opts.signal; calls++; return calls === 1 ? late.promise : 'New capture.'; } });
  const c = await connect(); await c.configure(); c.socket.send(pcm(100)); c.send({ type: 'input_audio_buffer.commit' });
  await delay(20); const close = once(c.socket, 'close'); c.socket.close(); await close;
  await until(() => signal.aborted);
  const fresh = await connect(); await fresh.configure(); fresh.socket.send(pcm(100)); fresh.send({ type: 'input_audio_buffer.commit' });
  await fresh.wait(commit); late.resolve('Stale old result.'); await delay(20);
  assert.deepEqual(fresh.events.filter(e => e.type === completed).map(e => e.transcript), ['New capture.']);
});

test('a second simultaneous capture is visibly refused', async t => {
  const { connect } = await harness(t); const c = await connect(); await c.configure();
  const second = await connect(); const error = await second.wait('error'); assert.equal(error.error.code, 'capture_busy');
});

test('duration overflow fails visibly and never reports a successful commit', async t => {
  const { connect } = await harness(t, { maxUtteranceSeconds: 0.1 });
  const c = await connect(); await c.configure(); c.socket.send(pcm(120));
  const error = await c.wait('error'); assert.match(error.error.message, /duration limit/); assert.equal(c.events.some(e => e.type === commit), false);
});

test('pending work is bounded; overload aborts active decoding instead of an unbounded queue', async t => {
  const gate = deferred(); let signal;
  const { connect } = await harness(t, {}, { decode: async (_, __, opts) => { signal = opts.signal; return gate.promise; } });
  const c = await connect(); await c.configure();
  c.socket.send(pcm(40)); c.socket.send(pcm(100, 16000, 0));
  await until(() => Boolean(signal));
  for (let i = 0; i < 2; i++) { c.socket.send(pcm(40)); c.socket.send(pcm(100, 16000, 0)); }
  const error = await c.wait('error'); assert.match(error.error.message, /pending audio limit/); assert.equal(signal.aborted, true);
  gate.resolve('Too late.'); await delay(20); assert.equal(c.events.some(e => e.type === completed || e.type === commit), false);
});

test('provider failure and timeout do not acknowledge a successful flush', async t => {
  for (const mode of ['failure', 'timeout']) {
    await t.test(mode, async t => {
      const { connect } = await harness(t, {}, { decodeTimeoutMs: 30, decode: async () => { if (mode === 'failure') throw new Error('Provider unavailable'); return new Promise(() => {}); } });
      const c = await connect(); await c.configure(); c.socket.send(pcm(100)); c.send({ type: 'input_audio_buffer.commit' });
      const error = await c.wait('error'); assert.match(error.error.message, mode === 'failure' ? /unavailable/ : /timed out/);
      assert.equal(c.events.some(e => e.type === commit), false);
    });
  }
});

test('repeated output is retained as a visible diagnostic, never submitted as an accepted transcript', async t => {
  const rejected = `${'*shh* '.repeat(40)}The final word is telescope.`;
  assert.equal(repetitiveOutput(rejected), true); assert.equal(repetitiveOutput('I said Moo as an example. Moo, end conversation.'), false);
  const { connect } = await harness(t, {}, { decode: async () => rejected });
  const c = await connect(); await c.configure(); c.socket.send(pcm(100)); c.send({ type: 'input_audio_buffer.commit' });
  const error = await c.wait('error'); assert.equal(error.error.transcript, rejected);
  assert.equal(c.events.some(e => e.type === completed || e.type === commit), false);
});

test('malformed PCM and premature input fail explicitly', async t => {
  for (const mode of ['unconfigured', 'odd']) {
    await t.test(mode, async t => {
      const { connect } = await harness(t); const c = await connect(); if (mode === 'odd') await c.configure();
      c.socket.send(Buffer.alloc(mode === 'odd' ? 3 : 8)); const error = await c.wait('error');
      assert.match(error.error.message, mode === 'odd' ? /even byte/ : /before session/);
    });
  }
});

test('Whisper request uses only a memory WAV, fixed decoding settings and the explicit vocabulary hint', async () => {
  const text = await decodeWhisper(pcm(100), config, { fetchImpl: async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:8177/inference');
    const form = request.body; assert.equal(form.get('prompt'), 'Moo.'); assert.equal(form.get('vad'), 'true');
    for (const name of ['temperature', 'temperature_inc']) assert.equal(form.get(name), '0');
    for (const name of ['best_of', 'beam_size']) assert.equal(form.get(name), '1');
    const wav = Buffer.from(await form.get('file').arrayBuffer()); assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt32LE(40), 3200);
    return Response.json({ text: 'Moo.\nA whole utterance.' });
  } });
  assert.equal(text, 'Moo.\nA whole utterance.');
  assert.equal(pcmWav(Buffer.alloc(0)).length, 44);
});

test('real ffmpeg pipe resamples 48 kHz to 16 kHz without recording files', async () => {
  const input = pcm(100, 48000);
  const output = await resamplePcm(input, 48000, { signal: AbortSignal.timeout(2000) });
  assert.equal(output.length, 3200); assert.ok(output.readInt16LE(100) > 900);
  assert.equal(await resamplePcm(output, 16000), output);
});

test('health reports the selected model and endpointing distinction', async t => {
  const { bridge } = await harness(t);
  const response = await fetch(`http://127.0.0.1:${bridge.address().port}/health`); const health = await response.json();
  assert.equal(health.model, 'large-v3-turbo'); assert.equal(health.initialPrompt, 'Moo.');
  assert.equal(health.audioFilesCreated, false); assert.match(health.endpointing, /Silero VAD runs during server decode/);
});
