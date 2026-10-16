import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { installVoiceLifecycle } from '../apps/desktop/voice-lifecycle.cjs';

function fixture(options = {}) {
  const app = new EventEmitter(); let quits = 0;
  app.quit = () => { quits++; };
  const calls = [], errors = [];
  const lifecycle = installVoiceLifecycle({ app,
    connection: async () => ({ base: 'http://127.0.0.1:1234', token: 'fixture-only' }),
    fetch: async (url, options) => { calls.push({ url, ...options }); return { ok: true }; },
    reportError: (...error) => errors.push(error), ...options,
  });
  return { app, calls, errors, lifecycle, quits: () => quits };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('desktop quit stops playback and capture before quitting, retaining the session', async () => {
  const f = fixture(); let prevented = 0;
  f.app.emit('before-quit', { preventDefault: () => prevented++ });
  f.app.emit('before-quit', { preventDefault: () => prevented++ });
  await tick();
  assert.equal(prevented, 2); assert.equal(f.quits(), 1);
  assert.deepEqual(f.calls.map(c => new URL(c.url).pathname), ['/api/speech/stop', '/api/voice']);
  assert.deepEqual(JSON.parse(f.calls[1].body), { action: 'stop' });
  assert.ok(f.calls.every(c => c.method === 'POST' && c.headers.Authorization === 'Bearer fixture-only'));
  f.app.emit('before-quit', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

test('renderer loss and simultaneous quit share one stop and never start capture', async () => {
  const f = fixture(); const stop = f.lifecycle.stop();
  f.app.emit('before-quit', { preventDefault() {} });
  await stop; await tick(); assert.equal(f.calls.length, 2); assert.equal(f.quits(), 1);
});

test('closing without a runtime does not launch or connect to one', async () => {
  const f = fixture({ connection: async () => { throw new Error('No runtime'); } });
  f.app.emit('before-quit', { preventDefault() {} }); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.quits(), 1);
});

test('capture stops even when stopping speech fails; failure stays visible in diagnostics', async () => {
  const calls = [];
  const f = fixture({ fetch: async url => {
    calls.push(url); if (url.endsWith('/speech/stop')) throw new Error('fixture transport failure');
    return { ok: true };
  } });
  await f.lifecycle.stop();
  assert.equal(calls.length, 2); assert.equal(f.errors.length, 1);
});

test('minimizing or losing focus does not change explicitly enabled capture', async () => {
  const f = fixture(); f.app.emit('blur'); f.app.emit('minimize'); await tick();
  assert.equal(f.calls.length, 0);
});
