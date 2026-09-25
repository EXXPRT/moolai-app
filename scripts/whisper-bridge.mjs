// Local finals-only ASR adapter. PCM and WAV buffers stay in RAM.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const REALTIME_PATH = '/v1/audio/transcriptions/realtime';
const MAX_RESPONSE_BYTES = 256 * 1024;

export function pcmWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function resamplePcm(pcm, sampleRate, { signal, spawnProcess = spawn } = {}) {
  signal?.throwIfAborted();
  if (sampleRate === 16000) return pcm;
  return new Promise((resolve, reject) => {
    const child = spawnProcess('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']);
    let chunks = [], bytes = 0, stderr = '', settled = false;
    const limit = Math.ceil(pcm.length * 16000 / sampleRate) + 32000;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); chunks = []; reject(error); }
      else { resolve(Buffer.concat(chunks)); chunks = []; }
    };
    const abort = () => finish(signal.reason ?? new Error('ASR resampling cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', part => {
      bytes += part.length;
      if (bytes > limit) finish(new Error('ASR resampling exceeded its memory limit'));
      else if (!settled) chunks.push(part);
    });
    child.stderr.on('data', part => { stderr = (stderr + part).slice(-1000); });
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(`ASR resampling failed: ${stderr || code}`)));
    child.stdin.end(pcm);
  });
}

export async function decodeWhisper(pcm16k, config, { signal, fetchImpl = fetch } = {}) {
  const form = new FormData();
  form.set('file', new Blob([pcmWav(pcm16k)], { type: 'audio/wav' }), 'in-memory.wav');
  const fields = { response_format: 'json', language: config.language, prompt: config.initialPrompt,
    temperature: '0', temperature_inc: '0', best_of: '1', beam_size: '1', vad: 'true' };
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  const response = await fetchImpl(`http://127.0.0.1:${config.inferencePort}/inference`, { method: 'POST', body: form, signal });
  if (!response.ok) throw new Error(`Local Whisper returned HTTP ${response.status}`);
  let bytes = 0; const chunks = [];
  for await (const part of response.body) {
    bytes += part.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('Local Whisper response exceeded the bounded response limit');
    chunks.push(part);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof body.text !== 'string') throw new Error('Local Whisper returned no transcript field');
  return body.text;
}

// Reject obvious repeated-output failures. This is not a confidence or semantic score.
export function repetitiveOutput(text) {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 12) return false;
  for (let width = 1; width <= 6; width++) {
    let run = width;
    for (let i = width; i < words.length; i++) {
      run = words[i] === words[i - width] ? run + 1 : width;
      if (run >= Math.max(12, width * 6) && run >= words.length * 0.5) return true;
    }
  }
  return false;
}

export function createWhisperBridge(config, dependencies = {}) {
  const decode = dependencies.decode ?? decodeWhisper;
  const resample = dependencies.resample ?? resamplePcm;
  const decodeTimeoutMs = dependencies.decodeTimeoutMs ?? 10000;
  const maxQueuedUtterances = dependencies.maxQueuedUtterances ?? 2;
  let active, closing = false;
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/health') { response.writeHead(404); response.end('{}'); return; }
    response.end(JSON.stringify({ ready: !closing, model: config.model, language: config.language,
      initialPrompt: config.initialPrompt, activeCapture: Boolean(active), inferencePort: config.inferencePort,
      finalsOnly: true, audioFilesCreated: false, endpointing: 'local PCM energy/pause; Silero VAD runs during server decode' }));
  });
  const server = new WebSocketServer({ server: http, path: REALTIME_PATH, maxPayload: 512 * 1024 });
  server.on('connection', socket => {
    const send = event => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_RESPONSE_BYTES) throw new Error('ASR client is not reading responses');
      socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    };
    if (active || closing) {
      send({ type: 'error', error: { code: 'capture_busy', message: 'Only one microphone capture may use local ASR at a time' } });
      socket.close(1013, 'ASR capture busy'); return;
    }
    let sampleRate, preRoll = Buffer.alloc(0), chunks = [], utteranceBytes = 0, silenceSamples = 0;
    let queue = [], queuedBytes = 0, running = false, draining = false, failed = false, closed = false;
    let controller, shutdownTimer;
    const resetAudio = () => { preRoll = Buffer.alloc(0); chunks = []; utteranceBytes = 0; silenceSamples = 0; };
    const discard = () => { resetAudio(); queue = []; queuedBytes = 0; };
    const fail = (error, transcript) => {
      if (closed || failed) return;
      failed = true; controller?.abort(); discard();
      try { send({ type: 'error', error: { code: 'asr_failed', message: error.message, ...(transcript === undefined ? {} : { transcript }) } }); } catch { /* Socket may already be unusable. */ }
      socket.close(1011, 'ASR failed; review the reported error and retry');
      shutdownTimer = setTimeout(() => socket.terminate(), 1000); shutdownTimer.unref();
    };
    const release = () => {
      closed = true; clearTimeout(shutdownTimer); controller?.abort(); discard();
      if (active?.socket === socket) active = undefined;
    };
    active = { socket, stop: release };
    socket.on('close', release);
    socket.on('error', error => fail(error));
    const finishCommit = () => {
      if (draining && !running && queue.length === 0 && !failed && !closed) {
        send({ type: 'input_audio_buffer.committed' });
        // Native closes after this acknowledgment. Do not accept a new buffer on the same capture.
        draining = false;
      }
    };
    let committed = false;
    async function pump() {
      if (running || failed || closed) return;
      running = true;
      try {
        while (queue.length && !failed && !closed) {
          const item = queue.shift(); controller = new AbortController();
          const jobController = controller;
          let timeout, abortListener;
          try {
            const timedOut = new Promise((_, reject) => {
              timeout = setTimeout(() => { const error = new Error('Local ASR decode timed out; the utterance was not committed'); jobController.abort(error); reject(error); }, decodeTimeoutMs);
            });
            const cancelled = new Promise((_, reject) => {
              abortListener = () => reject(jobController.signal.reason ?? new Error('ASR capture cancelled'));
              jobController.signal.addEventListener('abort', abortListener, { once: true });
            });
            const work = async () => {
              const pcm = await resample(item.pcm, sampleRate, { signal: jobController.signal });
              jobController.signal.throwIfAborted();
              return decode(pcm, config, { signal: jobController.signal });
            };
            const transcript = await Promise.race([work(), timedOut, cancelled]);
            if (closed || failed) return;
            if (typeof transcript !== 'string') throw new Error('Local ASR decoder returned an invalid transcript');
            if (repetitiveOutput(transcript)) {
              fail(new Error('Local ASR produced repetitive text. The rejected transcript is included for review; no final was accepted.'), transcript);
              return;
            }
            // Preserve embedded newlines and wording; one completed utterance is one transcript event.
            if (transcript.trim()) send({ type: 'conversation.item.input_audio_transcription.completed', transcript });
          } finally {
            clearTimeout(timeout); jobController.signal.removeEventListener('abort', abortListener); queuedBytes = Math.max(0, queuedBytes - item.pcm.length); item.pcm = null; controller = undefined;
          }
        }
      } catch (error) { fail(error); }
      finally { running = false; finishCommit(); }
    }
    function enqueue() {
      if (!utteranceBytes) return;
      const maxBytes = sampleRate * 2 * config.maxUtteranceSeconds;
      if (queue.length + (running ? 1 : 0) >= maxQueuedUtterances || queuedBytes + utteranceBytes > maxBytes * maxQueuedUtterances) {
        throw new Error('Local ASR processing is behind: pending audio limit reached. Stop and retry; this capture was not committed.');
      }
      const pcm = Buffer.concat(chunks, utteranceBytes);
      queuedBytes += pcm.length; queue.push({ pcm }); resetAudio(); void pump();
    }
    function receivePcm(data) {
      if (!sampleRate) throw new Error('PCM arrived before session.update configured its sample rate');
      if (committed) throw new Error('PCM arrived after the final commit');
      if (data.length % 2) throw new Error('PCM16 payload must have an even byte length');
      const frameBytes = Math.max(2, Math.round(sampleRate * 0.02) * 2);
      const preRollBytes = Math.ceil(sampleRate * config.preRollMs / 1000) * 2;
      for (let offset = 0; offset < data.length; offset += frameBytes) {
        const frame = data.subarray(offset, Math.min(offset + frameBytes, data.length));
        let square = 0;
        for (let i = 0; i < frame.length; i += 2) square += (frame.readInt16LE(i) / 32768) ** 2;
        const voiced = Math.sqrt(square / (frame.length / 2)) >= config.rmsThreshold;
        if (!utteranceBytes && !voiced) {
          preRoll = Buffer.concat([preRoll, frame]);
          if (preRoll.length > preRollBytes) preRoll = Buffer.from(preRoll.subarray(preRoll.length - preRollBytes));
          continue;
        }
        if (!utteranceBytes && preRoll.length) { chunks.push(preRoll); utteranceBytes += preRoll.length; preRoll = Buffer.alloc(0); }
        chunks.push(Buffer.from(frame)); utteranceBytes += frame.length;
        silenceSamples = voiced ? 0 : silenceSamples + frame.length / 2;
        if (utteranceBytes > sampleRate * 2 * config.maxUtteranceSeconds) {
          throw new Error('Local ASR utterance exceeded its configured duration limit. Use Send or pause; this capture was not committed.');
        }
        if (silenceSamples * 1000 >= sampleRate * config.endpointSilenceMs) enqueue();
      }
    }
    socket.on('message', (data, binary) => {
      if (failed || closed) return;
      try {
        if (binary) { receivePcm(data); return; }
        const event = JSON.parse(data.toString());
        if (event.type === 'session.update') {
          if (sampleRate) throw new Error('The sample rate is fixed for a capture; reconnect to reconfigure');
          const rate = event.session?.sample_rate;
          if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new Error('Expected mono PCM16 at an integer rate between 8000 and 48000 Hz');
          if (event.session.input_audio_format && event.session.input_audio_format !== 'pcm16') throw new Error('Only PCM16 audio is supported');
          sampleRate = rate;
          send({ type: 'session.updated', session: { sample_rate: sampleRate, input_audio_format: 'pcm16', model: config.model,
            language: config.language, initial_prompt: config.initialPrompt, endpointing_ms: config.endpointSilenceMs } });
        } else if (event.type === 'input_audio_buffer.commit') {
          if (!sampleRate) throw new Error('Configure the session before commit');
          if (committed) throw new Error('This capture has already been committed');
          committed = true; draining = true; enqueue(); preRoll = Buffer.alloc(0); finishCommit();
        } else throw new Error(`Unsupported local ASR event: ${event.type ?? 'missing type'}`);
      } catch (error) { fail(error); }
    });
    send({ type: 'session.created', session: { model: config.model, input_audio_format: 'pcm16' } });
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      http.once('error', reject); http.listen(config.port, '127.0.0.1', () => { http.off('error', reject); resolve(http.address()); });
    }),
    address: () => http.address(),
    close: async () => {
      closing = true; active?.stop();
      for (const client of server.clients) client.terminate();
      await new Promise(resolve => server.close(resolve));
      await new Promise(resolve => http.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readAsrConfig } = await import('./asr-config.mjs');
  const config = await readAsrConfig();
  const bridge = createWhisperBridge(config);
  await bridge.listen();
  console.log(JSON.stringify({ event: 'whisper_bridge_ready', url: `ws://127.0.0.1:${config.port}${REALTIME_PATH}`, model: config.model, audioFilesCreated: false }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void bridge.close().then(() => process.exit(0)); });
}
