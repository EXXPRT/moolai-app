import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys = ['model', 'language', 'initialPrompt', 'port', 'inferencePort', 'endpointSilenceMs', 'maxUtteranceSeconds', 'rmsThreshold', 'preRollMs'];

export function asrConfigPath(root = repositoryRoot) {
  return path.resolve(root, process.env.MOOLAI_ASR_CONFIG || 'asr-config.json');
}

/** One validation boundary for setup, the resident runtime and the speech bridge. */
export function validateAsrConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ASR config must be an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ASR config key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`Missing ASR config key: ${key}`);
  if (!['large-v3-turbo', 'large-v3'].includes(value.model)) throw new Error('ASR model must be large-v3-turbo or large-v3; no automatic fallback is used');
  if (value.language !== 'en') throw new Error('This Agent phase supports ASR language en');
  if (typeof value.initialPrompt !== 'string' || value.initialPrompt.length > 200) throw new Error('ASR initialPrompt must be a string of at most 200 characters');
  const integer = (key, min, max) => {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`ASR ${key} must be an integer from ${min} to ${max}`);
  };
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

export async function readAsrConfig(root = repositoryRoot) {
  const filename = asrConfigPath(root);
  let value;
  try { value = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ASR config ${filename}: ${error.message}`, { cause: error }); }
  return validateAsrConfig(value);
}
