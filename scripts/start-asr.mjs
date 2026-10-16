import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { asrConfigPath, readAsrConfig } from './asr-config.mjs';
import { existingAsr, requireFreePort } from './asr-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, '.data/asr/whisper');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireArtifact(artifact) {
  const filename = path.join(assets, 'models', artifact.filename);
  try {
    if ((await stat(filename)).size !== artifact.size || await sha256(filename) !== artifact.sha256) throw new Error('size or SHA256 mismatch');
  } catch (error) { throw new Error(`ASR artifact ${artifact.filename} is missing or does not match its pin. Run npm run setup:asr.`, { cause: error }); }
  return filename;
}

/** Whisper's HTTP routes (including /load) answer only under a per-launch secret path, so web pages cannot reach them. */
export function whisperServerArgs({ model, vad, config, requestPath }) {
  return ['-m', model, '--host', '127.0.0.1', '--port', String(config.inferencePort), '--request-path', requestPath,
    '-t', '8', '-l', config.language, '-fa', '-nf', '-bo', '1', '-bs', String(config.beamSize ?? 1), '--prompt', config.initialPrompt,
    '--vad', '-vm', vad];
}

async function ready(port, signal, timeoutMs = 60000, route = '/health') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (response.ok) return;
    } catch { signal.throwIfAborted(); }
    await delay(150);
  }
  throw new Error(`ASR service on ${port} did not become ready within ${timeoutMs / 1000} seconds`);
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local ASR requires macOS Apple Silicon with Metal');
  const config = await readAsrConfig(root);
  const running = await existingAsr(config);
  if (running) {
    console.log(`Local ASR already running: ${running.model} on port ${config.port} (microphone ${running.activeCapture ? 'active' : 'off'}). Use the existing app connection. No second service started; its existing configuration remains in use.`);
    return;
  }
  if (config.model === 'qwen3-asr-1.7b') {
    const { startQwen } = await import('./qwen-asr/start.mjs');
    return startQwen(config);
  }
  console.log(`Verifying local ASR assets for ${config.model}...`);
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/whisper-artifacts.json'), 'utf8'));
  const server = path.join(assets, 'build/bin/whisper-server');
  try {
    await access(server, constants.X_OK);
    const stamp = JSON.parse(await readFile(path.join(assets, 'runtime-install.json'), 'utf8'));
    if (stamp.revision !== manifest.runtime.revision || stamp.sourceSha256 !== manifest.runtime.sha256 || stamp.serverSha256 !== await sha256(server)) throw new Error('Runtime pin mismatch');
  } catch (error) { throw new Error('Pinned Whisper runtime is missing or changed. Run npm run setup:asr.', { cause: error }); }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('ffmpeg is required for in-memory audio resampling; install it before starting ASR');
  await access(path.join(root, 'scripts/whisper-bridge.mjs'));
  const model = await requireArtifact(manifest.models[config.model]);
  const vad = await requireArtifact(manifest.vad);
  await requireFreePort(config.inferencePort);
  await requireFreePort(config.port);

  const children = [];
  const abort = new AbortController();
  let stopped = false, finish;
  const stopping = new Promise(resolve => { finish = resolve; });
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    finish(reason);
  };
  const onSignal = () => stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  function launch(name, executable, args, quiet = false, env = {}) {
    const child = spawn(executable, args, { cwd: root,
      env: { ...process.env, MOOLAI_ASR_CONFIG: asrConfigPath(root), ...env },
      stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
    let diagnostic = '';
    child.stderr?.on('data', data => { diagnostic = (diagnostic + data).slice(-4000); });
    child.once('error', error => stop(new Error(`${name} failed to start: ${error.message}`)));
    child.once('exit', (code, signal) => { if (!stopped) stop(new Error(`${name} exited (${signal ?? code}). ${diagnostic}`)); });
    children.push(child);
    return child;
  }
  let failure;
  try {
    console.log(`Loading ${config.model} with Metal and Silero VAD...`);
    const requestPath = '/' + randomBytes(16).toString('hex');
    launch('Whisper', server, whisperServerArgs({ model, vad, config, requestPath }), true);
    await ready(config.inferencePort, abort.signal, 60000, `${requestPath}/health`);
    // The bridge receives the path through its environment; its own /health never reports it.
    launch('Speech bridge', process.execPath, [path.join(root, 'scripts/whisper-bridge.mjs')], false, { MOOLAI_WHISPER_REQUEST_PATH: requestPath });
    await ready(config.port, abort.signal);
    console.log(`Local ASR ready: ${config.model} + Silero VAD at ws://127.0.0.1:${config.port}/v1/audio/transcriptions/realtime`);
    failure = await stopping;
  } catch (error) { failure = stopped ? await stopping : error; }
  finally {
    stopped = true;
    abort.abort();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    // Stop owned children and avoid leaving an orphan if a service hangs on shutdown.
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      let timer;
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); }),
      ]);
      clearTimeout(timer);
    }));
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
