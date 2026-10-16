import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { QwenDecoder } from './qwen-asr/decoder.mjs';
import { createWhisperBridge } from './whisper-bridge.mjs';

function fixture(t, options = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit'); };
  const commands = [];
  child.stdin.on('data', data => commands.push(JSON.parse(data.toString())));
  const decoder = new QwenDecoder({ ...options, spawnProcess: (_, __, options) => {
    assert.equal(options.env.HF_HUB_OFFLINE, '1'); return child;
  }});
  child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
  t.after(() => decoder.close());
  return { decoder, child, commands, reply: value => child.stdout.write(JSON.stringify(value) + '\n') };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Qwen passes bounded PCM/context in memory and preserves the complete transcript', async t => {
  const { decoder, commands, reply } = fixture(t);
  const pcm = Buffer.alloc(3200);
  const result = decoder.decode(pcm, { initialPrompt: 'Moo. Iodine.' }); await tick();
  assert.deepEqual(Buffer.from(commands[0].pcm, 'base64'), pcm);
  assert.equal(commands[0].context, 'Moo. Iodine.');
  const text = 'I meant iodine, not iron.\nKeep the final word telescope.';
  reply({ id: commands[0].id, text }); assert.equal(await result, text);
});

test('Qwen cancellation waits for worker acknowledgement and ignores late output in the next request', async t => {
  const { decoder, commands, reply } = fixture(t); const controller = new AbortController();
  const old = decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }, { signal: controller.signal });
  const rejected = assert.rejects(old, /cancelled/); await tick();
  controller.abort(new Error('cancelled'));
  assert.equal(commands[1].method, 'cancel');
  const fresh = decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }); await tick();
  assert.equal(commands.length, 2, 'New capture waits while the old decoder is cancelling');
  reply({ id: commands[0].id, event: 'cancelled' }); await rejected;
  await tick();
  reply({ id: commands[0].id, text: 'wrong old words' });
  reply({ id: commands[2].id, text: 'new request' }); assert.equal(await fresh, 'new request');
});

test('Qwen cancellation has a bounded failure when worker never acknowledges', async t => {
  const { decoder, child, commands } = fixture(t, { cancelTimeoutMs: 20 });
  const controller = new AbortController();
  const old = decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }, { signal: controller.signal });
  const rejected = assert.rejects(old, /acknowledge cancellation/); await tick();
  controller.abort(); await rejected;
  assert.equal(commands.length, 2); assert.equal(child.signalCode, 'SIGTERM');
  await assert.rejects(decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }), /acknowledge cancellation/);
});

test('a success racing cancelled Qwen work is discarded before the next request', async t => {
  const { decoder, commands, reply } = fixture(t); const controller = new AbortController();
  const old = decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }, { signal: controller.signal });
  const rejected = assert.rejects(old, /superseded/); await tick();
  controller.abort(new Error('superseded'));
  reply({ id: commands[0].id, text: 'late preview' }); await rejected;
  assert.equal(decoder.pending, undefined);
});

test('Qwen rejects invalid/oversized input and incomplete provider responses', async t => {
  const { decoder, commands, reply } = fixture(t);
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(1920002)])
    await assert.rejects(decoder.decode(pcm, { initialPrompt: '' }), /PCM16/);
  const promise = decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }); await tick();
  await assert.rejects(decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }), /in flight/);
  reply({ id: commands[0].id, error: 'output limit reached' }); await assert.rejects(promise, /output limit/);
});

test('Qwen worker failure rejects pending input without retrying or fabricating text', async t => {
  const { decoder, child, commands } = fixture(t);
  const promise = decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }); await tick();
  child.emit('exit', 1); await assert.rejects(promise, /stopped/);
  await assert.rejects(decoder.decode(Buffer.alloc(3200), { initialPrompt: '' }), /stopped/);
  assert.equal(commands.length, 1);
});

test('alternate ASR health reports its real endpointing and no word alignment', async t => {
  const bridge = createWhisperBridge({ model: 'qwen3-asr-1.7b', port: 0 }, { endpointing: 'Qwen utterance speech gate' });
  await bridge.listen(); t.after(() => bridge.close());
  const health = await fetch(`http://127.0.0.1:${bridge.address().port}/health`).then(r => r.json());
  assert.equal(health.model, 'qwen3-asr-1.7b');
  assert.equal(health.endpointing, 'Qwen utterance speech gate');
  assert.match(health.timestampSupport, /no word alignment/);
  assert.equal(health.audioFilesCreated, false);
});
