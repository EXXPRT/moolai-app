// Local ASR adapter with bounded cumulative previews. PCM and WAV buffers stay in RAM.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { PcmEndpointer } from './pcm-endpointer.mjs';

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

/** The per-launch Whisper route prefix from start-asr: '/' plus 32 hex characters. */
export function whisperRequestPath(value) {
  if (typeof value !== 'string' || !/^\/[0-9a-f]{32}$/.test(value))
    throw new Error('Local Whisper needs its per-launch request path; start ASR with npm run asr');
  return value;
}

export async function decodeWhisper(pcm16k, config, { signal, fetchImpl = fetch, requestPath = '' } = {}) {
  const form = new FormData();
  form.set('file', new Blob([pcmWav(pcm16k)], { type: 'audio/wav' }), 'in-memory.wav');
  const fields = { response_format: 'json', language: config.language, prompt: config.initialPrompt,
    temperature: '0', temperature_inc: '0', best_of: '1', beam_size: String(config.beamSize ?? 1), vad: 'true' };
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  const response = await fetchImpl(`http://127.0.0.1:${config.inferencePort}${requestPath}/inference`, { method: 'POST', body: form, signal });
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

// On a cough or click Qwen can print its own hint: the wake word and context phrases, in any
// order or repeated. Any other word means real speech.
export function hintEcho(text, initialPrompt = '', context = '') {
  const wordsOf = value => value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const heard = wordsOf(text);
  const phrases = [initialPrompt, ...context.split(/(?<=[.!?…])\s+/u)].map(wordsOf).filter(phrase => phrase.length).sort((a, b) => b.length - a.length);
  if (!heard.length || !phrases.length) return false;
  for (let i = 0, phrase; i < heard.length; i += phrase.length) {
    phrase = phrases.find(words => words.every((word, j) => heard[i + j] === word));
    if (!phrase) return false;
  }
  return true;
}

export function createWhisperBridge(config, dependencies = {}) {
  const decode = dependencies.decode ?? decodeWhisper;
  const resample = dependencies.resample ?? resamplePcm;
  const decodeTimeoutMs = dependencies.decodeTimeoutMs ?? 10000;
  const previewCancelTimeoutMs = dependencies.previewCancelTimeoutMs ?? 5000;
  const configureTimeoutMs = dependencies.configureTimeoutMs ?? 5000;
  const maxQueuedUtterances = dependencies.maxQueuedUtterances ?? 2;
  const livePreview = config.livePreview ?? false;
  if (livePreview && config.model !== 'qwen3-asr-1.7b')
    throw new Error('Live previews currently require Qwen cancellation acknowledgements; Whisper remains final-only');
  let active, closing = false;
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/health') { response.writeHead(404); response.end('{}'); return; }
    response.end(JSON.stringify({ ready: !closing, model: config.model, language: config.language,
      initialPrompt: config.initialPrompt, beamSize: config.beamSize ?? 1, activeCapture: Boolean(active), inferencePort: config.inferencePort,
      finalsOnly: !livePreview, livePreview, previewIntervalMs: livePreview ? (config.previewIntervalMs ?? 2000) : null, audioFilesCreated: false,
      endpointing: dependencies.endpointing ?? 'local PCM energy/pause; Silero VAD runs during server decode',
      timestampSupport: 'host transcript times; no word alignment' }));
  });
  const server = new WebSocketServer({ server: http, path: REALTIME_PATH, maxPayload: 512 * 1024,
    // This is a native-only endpoint. No browser origin (including a local web
    // page or opaque "null" origin) is authorized to acquire microphone ASR.
    // URLSession/native websocket clients legitimately send no Origin header.
    verifyClient: ({ req }, done) => done(req.headers.origin === undefined, 403, 'Native ASR clients only'),
  });
  // ws forwards HTTP bind errors; both emitters need handlers for listen() to reject safely.
  server.on('error', error => {
    closing = true;
    active?.stop();
    dependencies.onError?.(error);
  });
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
    let sampleRate, endpointer;
    let queue = [], queuedBytes = 0, running = false, draining = false, failed = false, closed = false;
    let controller, currentItem, preview, shutdownTimer, configureTimer, context = '';
    const captureId = randomUUID();
    const updateContext = value => {
      if (typeof value !== 'string' || value.length > 400) throw new Error('Recognition context must be at most 400 characters');
      context = value.replace(/[\r\n]/g, ' ');
    };
    const discard = () => { endpointer?.discard(); queue = []; preview = undefined; queuedBytes = 0; };
    const fail = (error, transcript) => {
      if (closed || failed) return;
      failed = true; clearTimeout(configureTimer); controller?.abort(); discard();
      try { send({ type: 'error', error: { code: 'asr_failed', message: error.message, ...(transcript === undefined ? {} : { transcript }) } }); } catch { /* Socket may already be unusable. */ }
      socket.close(1011, 'ASR failed; review the reported error and retry');
      shutdownTimer = setTimeout(() => socket.terminate(), 1000); shutdownTimer.unref();
    };
    const release = () => {
      closed = true; clearTimeout(shutdownTimer); clearTimeout(configureTimer); controller?.abort(); discard();
      if (active?.socket === socket) active = undefined;
    };
    active = { socket, stop: release };
    configureTimer = setTimeout(() => {
      // Expire before configuration, releasing ownership even if an abandoned
      // peer never answers the close handshake. No audio/decode exists yet.
      try { send({ type: 'error', error: { code: 'configuration_timeout', message: 'Configure local ASR within five seconds; reconnect to start capture' } }); }
      catch { /* The abandoned client may no longer be reading. */ }
      release(); socket.close(1008, 'ASR configuration timed out');
      shutdownTimer = setTimeout(() => socket.terminate(), 1000); shutdownTimer.unref();
    }, configureTimeoutMs);
    configureTimer.unref();
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
        while ((queue.length || preview) && !failed && !closed) {
          const item = queue.length ? queue.shift() : preview;
          if (item === preview) preview = undefined;
          currentItem = item; controller = new AbortController();
          const jobController = controller;
          const isPreview = item.trigger === 'preview';
          let timeout, abortListener, cancelTimer, emptyReason = 'empty';
          try {
            const timedOut = new Promise((_, reject) => {
              timeout = setTimeout(() => { const error = new Error('Local ASR decode timed out; the utterance was not committed'); jobController.abort(error); reject(error); }, decodeTimeoutMs);
            });
            const cancelled = new Promise((_, reject) => {
              abortListener = () => {
                if (!isPreview || closed || failed) reject(jobController.signal.reason ?? new Error('ASR capture cancelled'));
                // A decoder must settle cancellation before the final decode starts. Starting a
                // second inference immediately can overlap an uninterruptible model prefill.
                else cancelTimer = setTimeout(() => reject(new Error('Local ASR preview did not stop within its cancellation bound; restart local ASR')), previewCancelTimeoutMs);
              };
              jobController.signal.addEventListener('abort', abortListener, { once: true });
            });
            const work = async () => {
              const pcm = await resample(item.pcm, sampleRate, { signal: jobController.signal });
              jobController.signal.throwIfAborted();
              const heard = await decode(pcm, {...config, initialPrompt: [config.initialPrompt, item.context].filter(Boolean).join(' ')}, { signal: jobController.signal });
              if (typeof heard !== 'string' || !hintEcho(heard, config.initialPrompt, item.context)) return heard;
              // Never show or route an echo. A final gets one hint-free decode; anything unusable there is rejected, never failed.
              emptyReason = 'hint_echo';
              if (isPreview) return '';
              let plain;
              try { plain = await decode(pcm, {...config, initialPrompt: ''}, { signal: jobController.signal }); }
              catch (error) { if (jobController.signal.aborted) throw error; return ''; }
              if (typeof plain !== 'string' || !/[\p{L}\p{N}]/u.test(plain) || repetitiveOutput(plain)) return '';
              // The hinted decode heard only the wake word; keep its spelling ("Moo.", not "Mu."), unless it looped, which would fail the capture.
              return hintEcho(heard, config.initialPrompt) && !repetitiveOutput(heard) ? heard : plain;
            };
            const task = work();
            // For previews the timeout requests cancellation; wait for the decoder's actual
            // settlement (or the bounded cancellation failure) before dispatching another job.
            const transcript = await Promise.race(isPreview ? [task, cancelled, timedOut.catch(error => {
              if (!jobController.signal.aborted) jobController.abort(error);
              return new Promise(() => {});
            })] : [task, timedOut, cancelled]);
            if (closed || failed) return;
            if (jobController.signal.aborted) continue;
            if (typeof transcript !== 'string') throw new Error('Local ASR decoder returned an invalid transcript');
            if (repetitiveOutput(transcript)) {
              if (isPreview) { send({ type: 'session.preview_warning', reason: 'repetitive_output' }); continue; }
              fail(new Error('Local ASR produced repetitive text. The rejected transcript is included for review; no final was accepted.'), transcript);
              return;
            }
            const identity = { utterance_id: `${captureId}:${item.utteranceSequence}`, revision: item.revision };
            // Preserve embedded newlines and wording; one completed utterance is one transcript event.
            if (isPreview) {
              if (transcript.trim()) send({ type: 'conversation.item.input_audio_transcription.partial', transcript, ...identity });
            } else if (transcript.trim()) send({ type: 'conversation.item.input_audio_transcription.completed', transcript, ...identity });
            else send({ type: 'conversation.item.input_audio_transcription.rejected', reason: emptyReason, transcript: '', ...identity });
          } catch (error) {
            if (!isPreview || error.message.includes('cancellation bound')) throw error;
            // Preview failure never rejects the retained utterance or silently submits it.
            // A final decode still gets the complete PCM when a real endpoint is reached.
            if (!closed && !failed && !jobController.signal.aborted) send({ type: 'session.preview_warning', reason: 'decode_failed' });
          } finally {
            clearTimeout(timeout); clearTimeout(cancelTimer); jobController.signal.removeEventListener('abort', abortListener);
            if (!isPreview) queuedBytes = Math.max(0, queuedBytes - item.pcm.length);
            item.pcm = null; controller = undefined; currentItem = undefined;
          }
        }
      } catch (error) { fail(error); }
      finally { running = false; finishCommit(); }
    }
    function enqueue(item) {
      const maxBytes = sampleRate * 2 * config.maxUtteranceSeconds;
      if (queue.length + (currentItem && currentItem.trigger !== 'preview' ? 1 : 0) >= maxQueuedUtterances || queuedBytes + item.pcm.length > maxBytes * maxQueuedUtterances) {
        throw new Error('Local ASR processing is behind: pending audio limit reached. Stop and retry; this capture was not committed.');
      }
      if (preview?.utteranceSequence === item.utteranceSequence) preview = undefined;
      queuedBytes += item.pcm.length; queue.push(item);
      if (currentItem?.trigger === 'preview') controller?.abort(new Error('Final recognition takes priority over a preview'));
      void pump();
    }
    function enqueuePreview(item) {
      if (closed || failed || draining) return;
      // Coalesce: one active decode and only the newest cumulative snapshot may wait.
      preview = item;
      void pump();
    }
    function receivePcm(data) {
      if (!sampleRate) throw new Error('PCM arrived before session.update configured its sample rate');
      endpointer.push(data, context);
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
          endpointer = new PcmEndpointer(config, rate, enqueue, livePreview ? enqueuePreview : undefined);
          if (event.session.context !== undefined) updateContext(event.session.context);
          clearTimeout(configureTimer);
          send({ type: 'session.updated', session: { sample_rate: sampleRate, input_audio_format: 'pcm16', model: config.model,
            language: config.language, initial_prompt: config.initialPrompt, endpointing_ms: config.endpointSilenceMs,
            live_preview: livePreview, preview_interval_ms: livePreview ? (config.previewIntervalMs ?? 2000) : null } });
        } else if (event.type === 'session.context') {
          updateContext(event.context); send({type:'session.context.updated'});
        } else if (event.type === 'input_audio_buffer.commit') {
          if (!sampleRate) throw new Error('Configure the session before commit');
          if (committed) throw new Error('This capture has already been committed');
          committed = true; draining = true; endpointer.commit(); finishCommit();
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
  // Keep the secret out of child processes (ffmpeg) and every response.
  const requestPath = whisperRequestPath(process.env.MOOLAI_WHISPER_REQUEST_PATH);
  delete process.env.MOOLAI_WHISPER_REQUEST_PATH;
  const bridge = createWhisperBridge(config, { decode: (pcm, settings, options) => decodeWhisper(pcm, settings, { ...options, requestPath }) });
  await bridge.listen();
  console.log(JSON.stringify({ event: 'whisper_bridge_ready', url: `ws://127.0.0.1:${config.port}${REALTIME_PATH}`, model: config.model, audioFilesCreated: false }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void bridge.close().then(() => process.exit(0)); });
}
