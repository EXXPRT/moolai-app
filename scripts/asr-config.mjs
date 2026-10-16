import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys = ['model', 'language', 'initialPrompt', 'port', 'inferencePort', 'endpointSilenceMs', 'maxUtteranceSeconds', 'rmsThreshold', 'preRollMs'];
const optionalKeys = ['beamSize', 'livePreview', 'previewIntervalMs'];

export function asrConfigPath(root = repositoryRoot, override = process.env.MOOLAI_ASR_CONFIG) {
  return path.resolve(root, override || 'asr-config.json');
}

/** One validation boundary for setup, the resident runtime and the speech bridge. */
export function validateAsrConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ASR config must be an object');
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optionalKeys.includes(key)) throw new Error(`Unknown ASR config key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`Missing ASR config key: ${key}`);
  if (!['large-v3-turbo', 'large-v3', 'qwen3-asr-1.7b'].includes(value.model)) throw new Error('ASR model must be large-v3-turbo, large-v3 or qwen3-asr-1.7b; no automatic fallback is used');
  if (value.language !== 'en') throw new Error('This Agent phase supports ASR language en');
  if (typeof value.initialPrompt !== 'string' || value.initialPrompt.length > 200) throw new Error('ASR initialPrompt must be a string of at most 200 characters');
  const integer = (key, min, max) => {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`ASR ${key} must be an integer from ${min} to ${max}`);
  };
  if (value.beamSize !== undefined) integer('beamSize', 1, 5);
  if (value.livePreview !== undefined && typeof value.livePreview !== 'boolean') throw new Error('ASR livePreview must be a boolean');
  if (value.livePreview === true && value.model !== 'qwen3-asr-1.7b')
    throw new Error('Live previews currently require Qwen cancellation acknowledgements; Whisper remains final-only');
  if (value.previewIntervalMs !== undefined) integer('previewIntervalMs', 1000, 10000);
  if (value.model === 'qwen3-asr-1.7b' && value.beamSize !== undefined) throw new Error('Qwen uses greedy decoding; omit the Whisper-only beamSize option');
  integer('port', 1024, 65535);
  integer('inferencePort', 1024, 65535);
  if (value.port === value.inferencePort) throw new Error('ASR port and inferencePort must differ');
  integer('endpointSilenceMs', 250, 5000);
  integer('maxUtteranceSeconds', 5, 60);
  if (value.endpointSilenceMs >= value.maxUtteranceSeconds * 1000) throw new Error('ASR silence endpoint must be shorter than the utterance limit');
  integer('preRollMs', 0, 2000);
  if (typeof value.rmsThreshold !== 'number' || !Number.isFinite(value.rmsThreshold) || value.rmsThreshold <= 0 || value.rmsThreshold > 0.25) throw new Error('ASR rmsThreshold must be greater than 0 and at most 0.25');
  return Object.freeze({ ...value });
}

export async function readAsrConfig(root = repositoryRoot, override) {
  const filename = asrConfigPath(root, override);
  let value;
  try { value = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ASR config ${filename}: ${error.message}`, { cause: error }); }
  return validateAsrConfig(value);
}
