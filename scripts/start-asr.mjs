import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asrConfigPath, readAsrConfig } from './asr-config.mjs';

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

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`ASR loopback port ${port} is occupied. Stop its existing service or change asr-config.json.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function ready(port, signal, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      if (response.ok) return;
    } catch { signal.throwIfAborted(); }
    await delay(150);
  }
  throw new Error(`ASR service on ${port} did not become ready within ${timeoutMs / 1000} seconds`);
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local ASR requires macOS Apple Silicon with Metal');
  const config = await readAsrConfig(root);
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
  function launch(name, executable, args, quiet = false) {
    const child = spawn(executable, args, { cwd: root,
      env: { ...process.env, MOOLAI_ASR_CONFIG: asrConfigPath(root) },
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
    launch('Whisper', server, ['-m', model, '--host', '127.0.0.1', '--port', String(config.inferencePort),
      '-t', '8', '-l', config.language, '-fa', '-nf', '-bo', '1', '-bs', '1', '--prompt', config.initialPrompt,
      '--vad', '-vm', vad], true);
    await ready(config.inferencePort, abort.signal);
    launch('Speech bridge', process.execPath, [path.join(root, 'scripts/whisper-bridge.mjs')]);
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

main().catch(error => { console.error(error.message); process.exitCode = 1; });
