import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWhisperBridge, decodeWhisper, pcmWav, repetitiveOutput, resamplePcm, whisperRequestPath } from './whisper-bridge.mjs';
import { whisperServerArgs } from './start-asr.mjs';

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
const partial = 'conversation.item.input_audio_transcription.partial';

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

test('browser origins are rejected before capture ownership; native clients remain compatible', async t => {
  const { bridge, connect } = await harness(t);
  for (const origin of ['https://untrusted.example', 'http://127.0.0.1:3300', 'null']) {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/v1/audio/transcriptions/realtime`, { origin });
    socket.on('error', () => {});
    const [, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, 403);
    response.resume(); socket.terminate();
    const health = await fetch(`http://127.0.0.1:${bridge.address().port}/health`).then(r => r.json());
    assert.equal(health.activeCapture, false);
  }
  const native = await connect(); await native.configure();
  native.socket.send(pcm(100)); native.send({ type: 'input_audio_buffer.commit' });
  await native.wait(commit); assert.equal(native.events.filter(e => e.type === completed).length, 1);
});

test('abandoned unconfigured clients expire without decoding or preventing the next capture', async t => {
  let decodes = 0;
  const { connect } = await harness(t, {}, { configureTimeoutMs: 40, decode: async () => { decodes++; return 'Fresh source'; } });
  const abandoned = await connect();
  abandoned.send({ type: 'session.context', context: 'Context cannot extend ownership without configuration' });
  const error = await abandoned.wait('error');
  assert.equal(error.error.code, 'configuration_timeout'); assert.equal(decodes, 0);
  const fresh = await connect(); await fresh.configure();
  await delay(60); // The handshake deadline no longer applies to configured capture.
  fresh.socket.send(pcm(100)); fresh.send({ type: 'input_audio_buffer.commit' });
  await fresh.wait(commit);
  assert.equal(decodes, 1); assert.equal(fresh.events.some(e => e.type === 'error'), false);
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

test('context changes apply to the next utterance without resetting audio or altering queued decoder hints', async t => {
  const hints=[]; const {connect}=await harness(t,{}, {decode: async(_pcm,settings)=>{hints.push(settings.initialPrompt);return 'I meant iodine.';}});
  const c=await connect(); await c.configure();
  c.send({type:'session.context',context:'Iodine. Thyroid.'}); await c.wait('session.context.updated');
  c.socket.send(pcm(100));
  c.send({type:'session.context',context:'Buoyancy.'}); await c.wait('session.context.updated',2);
  c.socket.send(pcm(100,16000,0)); await c.wait(completed);
  c.socket.send(pcm(100));c.send({type:'input_audio_buffer.commit'});await c.wait(commit);
  assert.deepEqual(hints,['Moo. Iodine. Thyroid.','Moo. Buoyancy.']);
  assert.equal(c.events.filter(e=>e.type===completed).length,2);
});
test('decoder comparison can request a bounded beam without changing the default', async()=>{
  const captured=[];
  const fetchImpl=async(_url,request)=>{captured.push(request.body.get('beam_size'));return new Response(JSON.stringify({text:'telescope'}));};
  await decodeWhisper(pcm(100),config,{fetchImpl});
  await decodeWhisper(pcm(100),{...config,beamSize:3},{fetchImpl});
  assert.deepEqual(captured,['1','3']);
});

test('identical PCM cannot become speech merely because socket packets split an analysis frame', async t => {
  const decodes = [];
  const { connect } = await harness(t, {}, { decode: async raw => { decodes.push(raw.length); return 'False command.'; } });
  const audio = Buffer.concat([pcm(5, 16000, 400), pcm(315, 16000, 0)]);
  for (const packetBytes of [audio.length, 160]) {
    const c = await connect(); await c.configure();
    for (let offset = 0; offset < audio.length; offset += packetBytes)
      c.socket.send(audio.subarray(offset, offset + packetBytes));
    c.send({ type: 'input_audio_buffer.commit' }); await c.wait(commit);
    const closed = once(c.socket, 'close'); c.socket.close(); await closed;
  }
  assert.deepEqual(decodes, [], 'A below-threshold 20 ms frame must not become a command through packet fragmentation');
});

test('empty recognition explicitly releases attention without routing a fake transcript', async t => {
  const {connect}=await harness(t,{}, {decode:async()=>''});
  const client=await connect();await client.configure();
  client.socket.send(pcm(100));client.send({type:'input_audio_buffer.commit'});
  await client.wait('conversation.item.input_audio_transcription.rejected');await client.wait(commit);
  assert.equal(client.events.filter(e=>e.type===completed).length,0);
});

test('live previews are cumulative replaceable revisions; only the final preserves the completed utterance', async t => {
  const texts = ['Moo check what Ian said', 'Moo check what Ian said, no check what John said', 'Moo check what Ian said, no check what John said. Telescope.'];
  const lengths = [];
  const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000, maxUtteranceSeconds: 5 }, {
    decode: async raw => { lengths.push(raw.length); return texts[lengths.length - 1]; },
  });
  const c = await connect(); await c.configure();
  c.socket.send(pcm(1000)); const first = await c.wait(partial);
  c.socket.send(pcm(1000)); const second = await c.wait(partial, 2);
  c.socket.send(pcm(1)); c.send({ type: 'input_audio_buffer.commit' });
  const final = await c.wait(completed); await c.wait(commit);
  assert.deepEqual(lengths, [32000, 64000, 64032]);
  assert.deepEqual([first, second, final].map(e => e.transcript), texts);
  assert.equal(first.utterance_id, second.utterance_id); assert.equal(second.utterance_id, final.utterance_id);
  assert.deepEqual([first, second, final].map(e => e.revision), [1, 2, 3]);
  assert.equal(c.events.filter(e => e.type === completed).length, 1);
});

test('slow preview coalesces to the latest snapshot and does not start concurrent inference', async t => {
  const first = deferred(); const lengths = []; let active = 0, peak = 0;
  const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000, maxUtteranceSeconds: 6 }, {
    decode: async raw => { active++; peak = Math.max(peak, active); lengths.push(raw.length);
      const text = lengths.length === 1 ? await first.promise : 'Newest cumulative words'; active--; return text; },
  });
  const c = await connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => lengths.length === 1);
  c.socket.send(pcm(3000)); await delay(20); assert.equal(lengths.length, 1);
  first.resolve('First preview'); await c.wait(partial, 2);
  assert.deepEqual(lengths, [32000, 128000]); assert.equal(peak, 1);
  c.send({ type: 'input_audio_buffer.commit' }); await c.wait(commit);
  assert.deepEqual(lengths, [32000, 128000, 128000]);
});

test('endpoint cancels a preview, waits for actual decoder settlement, and dispatches final before a newer utterance preview', async t => {
  const settle = deferred(); const calls = []; let active = 0, peak = 0, previewSignal;
  const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000, maxUtteranceSeconds: 6 }, {
    decode: async (raw, _, { signal }) => {
      active++; peak = Math.max(peak, active); calls.push(raw.length);
      if (calls.length === 1) { previewSignal = signal; await settle.promise; }
      active--; return calls.length === 1 ? 'Stale preview' : `Transcript ${calls.length}`;
    },
  });
  const c = await connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => previewSignal);
  c.socket.send(pcm(100, 16000, 0)); await until(() => previewSignal.aborted);
  c.socket.send(pcm(1000)); await delay(20); assert.equal(calls.length, 1, 'Final must wait for real preview settlement');
  settle.resolve(); const firstFinal = await c.wait(completed); const nextPreview = await c.wait(partial);
  assert.deepEqual(calls, [32000, 35200, 32000]); assert.equal(peak, 1);
  assert.notEqual(firstFinal.utterance_id, nextPreview.utterance_id);
  assert.equal(c.events.some(e => e.transcript === 'Stale preview'), false);
  c.send({ type: 'input_audio_buffer.commit' }); const nextFinal = await c.wait(completed, 2); await c.wait(commit);
  assert.equal(nextPreview.utterance_id, nextFinal.utterance_id);
  assert.ok(nextFinal.revision > nextPreview.revision);
});

test('preview errors, empty text and repetitive text never discard the final utterance', async t => {
  for (const mode of ['error', 'empty', 'repetitive']) await t.test(mode, async t => {
    let calls = 0;
    const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000 }, { decode: async () => {
      if (++calls === 1) { if (mode === 'error') throw new Error('Temporary preview failure'); return mode === 'empty' ? '' : 'noise '.repeat(30); }
      return 'Final words retained.';
    } });
    const c = await connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => calls === 1); await delay(10);
    c.send({ type: 'input_audio_buffer.commit' }); await c.wait(commit);
    assert.equal(c.events.filter(e => e.type === completed)[0].transcript, 'Final words retained.');
    assert.equal(c.events.some(e => e.type === partial || e.type === 'error'), false);
    assert.equal(calls, 2);
  });
});

test('preview timeout is cancelled cooperatively before full final recognition', async t => {
  let calls = 0, aborted = false;
  const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000 }, {
    decodeTimeoutMs: 25, previewCancelTimeoutMs: 100,
    decode: async (_, __, { signal }) => {
      if (++calls > 1) return 'Complete final';
      return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    },
  });
  const c = await connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => aborted);
  c.send({ type: 'input_audio_buffer.commit' }); await c.wait(commit);
  assert.equal(c.events.some(e => e.type === 'error'), false); assert.equal(calls, 2);
});

test('a decoder ignoring preview cancellation fails visibly within its bound without overlapping inference', async t => {
  let calls = 0;
  const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000 }, {
    previewCancelTimeoutMs: 25, decode: async () => { calls++; return new Promise(() => {}); },
  });
  const c = await connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => calls === 1);
  c.send({ type: 'input_audio_buffer.commit' }); const error = await c.wait('error');
  assert.match(error.error.message, /cancellation bound/); assert.equal(calls, 1);
  assert.equal(c.events.some(e => e.type === commit || e.type === completed), false);
});

test('disconnect discards late live preview and final rejection identifies the provisional utterance', async t => {
  const late = deferred(); let calls = 0;
  const { connect } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000 }, {
    decode: async () => ++calls === 1 ? late.promise : calls === 2 ? 'Maybe words' : '',
  });
  const c = await connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => calls === 1);
  const closed = once(c.socket, 'close'); c.socket.close(); await closed;
  const fresh = await connect(); await fresh.configure(); fresh.socket.send(pcm(1000));
  const preview = await fresh.wait(partial); late.resolve('Old stale preview');
  fresh.send({ type: 'input_audio_buffer.commit' }); const rejected = await fresh.wait('conversation.item.input_audio_transcription.rejected'); await fresh.wait(commit);
  assert.equal(rejected.utterance_id, preview.utterance_id); assert.ok(rejected.revision > preview.revision);
  assert.equal(rejected.transcript, ''); assert.equal(fresh.events.some(e => e.transcript === 'Old stale preview'), false);
});

test('live preview is opt-in and final queue bounds remain enforced while preview is active', async t => {
  const omitted = await harness(t, { model: 'qwen3-asr-1.7b' });
  const defaultHealth = await fetch(`http://127.0.0.1:${omitted.bridge.address().port}/health`).then(r => r.json());
  assert.equal(defaultHealth.finalsOnly, true); assert.equal(defaultHealth.livePreview, false);
  const { bridge } = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: false });
  const health = await fetch(`http://127.0.0.1:${bridge.address().port}/health`).then(r => r.json());
  assert.equal(health.finalsOnly, true); assert.equal(health.livePreview, false);
  let calls = 0;
  const live = await harness(t, { model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 1000, maxUtteranceSeconds: 6 }, {
    decode: async () => { calls++; return new Promise(() => {}); },
  });
  const c = await live.connect(); await c.configure(); c.socket.send(pcm(1000)); await until(() => calls === 1);
  for (let i = 0; i < 3; i++) { if (i) c.socket.send(pcm(40)); c.socket.send(pcm(100, 16000, 0)); }
  const error = await c.wait('error'); assert.match(error.error.message, /pending audio limit/);
  assert.equal(calls, 1);
});


test('direct bridge configuration cannot opt Whisper into unsupported preview cancellation', () => {
  assert.throws(() => createWhisperBridge({ ...config, livePreview: true }), /cancellation acknowledgements/);
});

test('Whisper routes live under a per-launch secret path that only the bridge receives', async () => {
  const requestPath = '/' + 'a1'.repeat(16);
  const args = whisperServerArgs({ model: 'model.bin', vad: 'vad.bin', config, requestPath });
  assert.equal(args[args.indexOf('--request-path') + 1], requestPath);
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(whisperRequestPath(requestPath), requestPath);
  for (const bad of [undefined, '', '/', '/health', '/' + 'a'.repeat(31), '/' + 'A1'.repeat(16), requestPath + '/x'])
    assert.throws(() => whisperRequestPath(bad), /per-launch request path/, String(bad));
  await decodeWhisper(pcm(100), config, { requestPath, fetchImpl: async url => {
    assert.equal(url, `http://127.0.0.1:8177${requestPath}/inference`);
    return Response.json({ text: 'Moo.' });
  } });
});

test('the Whisper bridge refuses to start without its request path', () => {
  const env = { ...process.env }; delete env.MOOLAI_WHISPER_REQUEST_PATH;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./whisper-bridge.mjs', import.meta.url))],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /per-launch request path/);
});

