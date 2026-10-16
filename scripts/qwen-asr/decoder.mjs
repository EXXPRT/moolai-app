import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** One resident local model, bounded PCM in RAM, cancellation keyed to each utterance. */
export class QwenDecoder {
  constructor({ spawnProcess = spawn, timeoutMs = 90000, cancelTimeoutMs = 5000 } = {}) {
    this.pending = undefined;
    this.failure = undefined;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.child = spawnProcess(path.join(root, '.data/asr/qwen/venv/bin/python'),
      ['-u', path.join(root, 'scripts/qwen-asr/worker.py')], {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
      });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.timer = setTimeout(() => this.fail(new Error('Qwen did not load within 90 seconds')), timeoutMs);
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', part => {
      buffer += part;
      if (Buffer.byteLength(buffer) > 256 * 1024) return this.fail(new Error('Qwen output exceeded its bound'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { this.receive(JSON.parse(line)); }
        catch { return this.fail(new Error('Qwen returned invalid protocol data')); }
      }
    });
    // Drain diagnostics without logging audio, context or user transcription.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error('Qwen input transport failed')));
    this.child.on('error', () => this.fail(new Error('Qwen runtime unavailable. Run python3 scripts/qwen-asr/setup.py.')));
    this.child.on('exit', () => this.fail(new Error('Qwen runtime stopped; restart local ASR.')));
  }
  receive(event) {
    if (event.event === 'ready') { clearTimeout(this.timer); this.readyResolve(); return; }
    if (event.event === 'failed') { this.fail(new Error(`Qwen startup failed: ${event.error}`)); return; }
    if (!this.pending || this.pending.id !== event.id) return; // Discard late/cancelled output.
    const job = this.pending; this.pending = undefined; job.cleanup();
    if (job.cancelled) job.reject(job.cancelled);
    else if (event.event === 'cancelled') job.reject(new Error('Qwen transcription cancelled'));
    else if (event.error) job.reject(new Error(`Qwen transcription failed: ${event.error}`));
    else if (typeof event.text !== 'string') job.reject(new Error('Qwen returned no transcript'));
    else job.resolve(event.text);
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error; clearTimeout(this.timer); this.readyReject(error);
    if (this.pending) { const job = this.pending; this.pending = undefined; job.cleanup(); job.reject(error); }
    this.child.kill('SIGTERM');
  }
  async decode(pcm, config, { signal } = {}) {
    signal?.throwIfAborted(); await this.ready; signal?.throwIfAborted();
    // A new capture may arrive while the previous socket's cancellation drains.
    // Wait for its acknowledgement, never overlap work or fail the fresh utterance.
    if (this.pending?.cancelled) { await this.pending.settled; signal?.throwIfAborted(); }
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('Qwen already has an utterance in flight');
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 16000 * 2 * 60)
      throw new Error('Qwen expects at most 60 seconds of mono 16 kHz PCM16');
    if (typeof config.initialPrompt !== 'string' || config.initialPrompt.length > 601)
      throw new Error('Qwen recognition context exceeded its bound');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let cancelTimer;
      let settle;
      const settled = new Promise(done => { settle = done; });
      const abort = () => {
        if (this.pending?.id !== id || this.pending.cancelled) return;
        this.pending.cancelled = signal.reason ?? new Error('Qwen transcription cancelled');
        this.child.stdin.write(JSON.stringify({ method: 'cancel', id }) + '\n');
        // Keep the decoder occupied until Python acknowledges cancellation after leaving
        // its model loop. In particular, an encoder/prefill may not stop immediately.
        cancelTimer = setTimeout(() => this.fail(new Error('Qwen did not acknowledge cancellation; restart local ASR')), this.cancelTimeoutMs);
      };
      this.pending = { id, resolve, reject, settled, cleanup: () => { clearTimeout(cancelTimer); signal?.removeEventListener('abort', abort); settle(); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(JSON.stringify({ id, pcm: pcm.toString('base64'), context: config.initialPrompt }) + '\n');
    });
  }
  async close() {
    this.fail(new Error('Qwen decoder closed'));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 3000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
