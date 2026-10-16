import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { existingAsr } from './asr-service.mjs';
import { createWhisperBridge } from './whisper-bridge.mjs';
import { startQwen } from './qwen-asr/start.mjs';

const config = { model: 'qwen3-asr-1.7b', port: 0, livePreview: true };
async function bridgeFixture(t) {
  const bridge = createWhisperBridge(config);
  await bridge.listen(); t.after(() => bridge.close());
  return { bridge, port: bridge.address().port };
}

test('free ASR port permits startup', async () => {
  assert.equal(await existingAsr(config), undefined);
});

test('duplicate Qwen startup recognizes the running service without disturbing capture', async t => {
  const { port } = await bridgeFixture(t);
  const client = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/transcriptions/realtime`);
  t.after(() => client.terminate()); await once(client, 'open');
  const health = await existingAsr({ ...config, port });
  assert.equal(health.model, config.model); assert.equal(health.activeCapture, true);
  assert.equal(health.livePreview, true); assert.equal(health.finalsOnly, false);
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())).activeCapture, true);
});

test('legacy final-only ASR remains reusable without requiring preview settings', async t => {
  const bridge = createWhisperBridge({ model: 'large-v3-turbo', port: 0 });
  await bridge.listen(); t.after(() => bridge.close());
  const health = await existingAsr({ model: 'large-v3-turbo', port: bridge.address().port });
  assert.equal(health.finalsOnly, true); assert.equal(health.livePreview, false);
});

test('a different running model is reported without substitution or shutdown', async t => {
  const { port } = await bridgeFixture(t);
  await assert.rejects(existingAsr({ model: 'large-v3-turbo', port }), /already running qwen3-asr-1.7b/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

for (const kind of ['unrelated', 'malformed', 'oversized', 'timeout']) {
  test(`occupied ${kind} service cannot be mistaken for a usable ASR`, async t => {
    const server = createServer((_, response) => {
      if (kind === 'timeout') return;
      response.end(kind === 'malformed' ? '{' : kind === 'oversized' ? 'x'.repeat(9000) : '{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    await assert.rejects(existingAsr({ ...config, port: server.address().port }, { timeoutMs: 100 }), /No model was loaded/);
  });
}

test('late port collision rejects listen, closes cleanly and preserves the first bridge', async t => {
  const { port } = await bridgeFixture(t);
  const duplicate = createWhisperBridge({ ...config, port });
  await assert.rejects(duplicate.listen(), { code: 'EADDRINUSE' });
  await duplicate.close();
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())).ready, true);
});

test('Qwen releases its own decoder and signal handlers after a port race', async t => {
  const { port } = await bridgeFixture(t);
  let closed = 0;
  const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
  await assert.rejects(startQwen({ ...config, port }, { createDecoder: () => ({
    ready: Promise.resolve(), child: new EventEmitter(), decode: async () => '', close: async () => { closed++; },
  }) }), { code: 'EADDRINUSE' });
  assert.equal(closed, 1);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s)), before);
});
