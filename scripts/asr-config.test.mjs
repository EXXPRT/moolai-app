import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { asrConfigPath, readAsrConfig, validateAsrConfig } from './asr-config.mjs';

const config = { model: 'large-v3-turbo', language: 'en', initialPrompt: 'Moo.', port: 8178, inferencePort: 8177, endpointSilenceMs: 1200, maxUtteranceSeconds: 60, rmsThreshold: 0.008, preRollMs: 500 };

test('explicit model selection preserves the chosen model and freezes config', () => {
  assert.equal(validateAsrConfig(config).model, 'large-v3-turbo');
  assert.equal(validateAsrConfig({ ...config, model: 'large-v3' }).model, 'large-v3');
  assert.equal(validateAsrConfig({ ...config, model: 'qwen3-asr-1.7b' }).model, 'qwen3-asr-1.7b');
  assert.throws(() => validateAsrConfig({ ...config, model: 'qwen3-asr-1.7b', beamSize: 1 }), /Whisper-only/);
  assert.ok(Object.isFrozen(validateAsrConfig(config)));
  assert.throws(() => validateAsrConfig({ ...config, model: 'small.en' }), /no automatic fallback/);
});

test('invalid ports, resource limits and unknown options fail before startup', () => {
  for (const change of [
    { host: '0.0.0.0' }, { port: 80 }, { port: 65536 }, { port: 8177 },
    { maxUtteranceSeconds: 61 }, { maxUtteranceSeconds: 5, endpointSilenceMs: 5000 },
    { rmsThreshold: NaN }, { rmsThreshold: 0 }, { rmsThreshold: '0.008' },
    { preRollMs: 2001 }, { endpointSilenceMs: 1.5 }, { language: 'auto' },
    { initialPrompt: 'x'.repeat(201) },
  ]) assert.throws(() => validateAsrConfig({ ...config, ...change }));
  const { model, ...missing } = config;
  assert.throws(() => validateAsrConfig(missing), /Missing ASR config key: model/);
  assert.throws(() => validateAsrConfig(null));
  assert.throws(() => validateAsrConfig([]));
});

test('config override resolves relative to the project, and malformed files do not fall back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'moolai-asr-config-'));
  const previous = process.env.MOOLAI_ASR_CONFIG;
  try {
    delete process.env.MOOLAI_ASR_CONFIG;
    await writeFile(path.join(root, 'asr-config.json'), JSON.stringify(config));
    assert.deepEqual(await readAsrConfig(root), config);
    await writeFile(path.join(root, 'custom.json'), JSON.stringify({ ...config, model: 'large-v3' }));
    process.env.MOOLAI_ASR_CONFIG = 'custom.json';
    assert.equal(asrConfigPath(root), path.join(root, 'custom.json'));
    assert.equal((await readAsrConfig(root)).model, 'large-v3');
    process.env.MOOLAI_ASR_CONFIG = path.join(root, 'custom.json');
    assert.equal((await readAsrConfig(root)).model, 'large-v3');
    await writeFile(path.join(root, 'custom.json'), '{broken');
    await assert.rejects(readAsrConfig(root), /Cannot read ASR config/);
    process.env.MOOLAI_ASR_CONFIG = 'missing.json';
    await assert.rejects(readAsrConfig(root), /Cannot read ASR config/);
  } finally {
    if (previous === undefined) delete process.env.MOOLAI_ASR_CONFIG;
    else process.env.MOOLAI_ASR_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('beam search is optional, bounded and explicit',()=>{
  assert.equal(validateAsrConfig(config).beamSize,undefined);
  assert.equal(validateAsrConfig({...config,beamSize:3}).beamSize,3);
  for(const beamSize of [0,6,1.5,'3']) assert.throws(()=>validateAsrConfig({...config,beamSize}));
});

test('live transcription options are explicit and bounded without changing model or endpoint settings', () => {
  assert.equal(validateAsrConfig(config).livePreview, undefined);
  assert.equal(validateAsrConfig({ ...config, model: 'qwen3-asr-1.7b', livePreview: true, previewIntervalMs: 2000 }).livePreview, true);
  assert.throws(() => validateAsrConfig({ ...config, livePreview: true }), /cancellation acknowledgements/);
  assert.equal(validateAsrConfig({ ...config, model: 'qwen3-asr-1.7b', livePreview: false }).livePreview, false);
  for (const change of [{ livePreview: 'yes' }, { previewIntervalMs: 999 }, { previewIntervalMs: 10001 }, { previewIntervalMs: 1000.5 }])
    assert.throws(() => validateAsrConfig({ ...config, ...change }));
});
