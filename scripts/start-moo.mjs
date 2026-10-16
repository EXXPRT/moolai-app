import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAsrConfig } from './asr-config.mjs';
import { requireFreePort } from './asr-service.mjs';

const exec = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const ownedCommand = (command, cwd, repo, entry) => cwd === repo && command.includes(entry);
export function composeArgs({ composeFiles = ['compose.yaml'], composeEnv } = {}) {
  return ['compose', ...(composeEnv ? ['--env-file', composeEnv] : []), ...composeFiles.flatMap(file => ['-f', file])];
}
export async function waitFor(check, { timeout = 60000, interval = 500, label = 'Service' } = {}) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await sleep(interval); } while (Date.now() < deadline);
  throw Error(`${label} did not become ready. Check the local startup logs; no service was force-killed.`);
}
async function command(file, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`${path.basename(file)} failed (${code}). Startup stopped.`)));
  });
}
async function processInfo(pid) {
  try {
    const [ps, cwd] = await Promise.all([exec('ps', ['-p', String(pid), '-o', 'command=']), exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])]);
    return { command: ps.stdout.trim(), cwd: cwd.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) };
  } catch { return undefined; }
}
async function stopOwned(pid, entry, label) {
  if (!pid || !alive(pid)) return;
  const info = await processInfo(pid);
  if (!info || !ownedCommand(info.command, info.cwd, root, entry)) throw Error(`${label} ownership could not be verified. Close it manually, then run npm run moo again.`);
  console.log(`Closing ${label}…`);
  process.kill(pid, 'SIGTERM');
  await waitFor(() => !alive(pid), { label: `${label} shutdown` });
}
async function listener(port) {
  try { return Number((await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).stdout.trim().split('\n')[0]); }
  catch { return undefined; }
}
async function health(url, headers) {
  try { return (await fetch(url, { headers, signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}
async function launch(file, args, env, logPath) {
  const log = await open(logPath, 'a', 0o600);
  try {
    const child = spawn(file, args, { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); return child.pid;
  } finally { await log.close(); }
}
/** One personal host. Local overrides live outside version control; no credentials are read here. */
export async function startMoo(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.MOOLAI_DATA_DIR ?? path.join(homedir(), 'Library/Application Support/Moolai'));
  const port = Number(options.port ?? process.env.MOOLAI_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid Moolai runtime port');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, 'startup.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid)) throw Error('Another Moolai startup is in progress. Wait for it to finish.');
    await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid)); await lock.close();
  try {
    const env = { ...process.env, ...options.env, MOOLAI_DATA_DIR: dataDir, MOOLAI_PORT: String(port) };
    const node = options.node ?? process.execPath;
    // Config loading must use the same explicit override as both child processes.
    const config = await readAsrConfig(root, options.asrConfig ?? env.MOOLAI_ASR_CONFIG);
    if (options.asrConfig) env.MOOLAI_ASR_CONFIG = options.asrConfig;
    await access(path.join(root, 'node_modules/.bin/electron'));
    try { await exec('docker', ['info', '--format', '{{.ServerVersion}}']); }
    catch {
      if (process.platform !== 'darwin') throw Error('Start Docker, then run npm run moo again.');
      console.log('Starting Docker Desktop…'); await command('open', ['-a', 'Docker']);
      await waitFor(async () => { try { await exec('docker', ['info', '--format', '{{.ServerVersion}}']); return true; } catch { return false; } }, { timeout: 120000, label: 'Docker' });
    }
    // Build first: a compile failure leaves the old app and runtime usable.
    console.log('Building Moolai UI and native companion…');
    await command('npm', ['run', 'build:desktop'], env);
    await command('npm', ['run', 'build:native'], env);
    await options.beforeBackend?.(command);
    const compose = composeArgs(options);
    await command('docker', [...compose, 'build', 'api'], env);
    // Close only desktop instances from this checkout, then their matching runtime.
    const processes = (await exec('ps', ['-axo', 'pid=,command='])).stdout.split('\n');
    for (const line of processes) {
      if (!line.includes('Electron apps/desktop/electron.cjs')) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      const info = await processInfo(pid);
      if (info && ownedCommand(info.command, info.cwd, root, 'apps/desktop/electron.cjs')) await stopOwned(pid, 'apps/desktop/electron.cjs', 'Moo desktop');
    }
    let previous;
    try { previous = JSON.parse(await readFile(path.join(dataDir, 'runtime.json'), 'utf8')); } catch {}
    if (previous) await stopOwned(previous.pid, 'apps/runtime/src/main.ts', 'Moo runtime');
    await requireFreePort(port);
    let asrOwner = await listener(config.port);
    if (asrOwner) {
      const info = await processInfo(asrOwner);
      if (info && ownedCommand(info.command, info.cwd, root, 'scripts/whisper-bridge.mjs')) {
        asrOwner = Number((await exec('ps', ['-p', String(asrOwner), '-o', 'ppid='])).stdout.trim());
      }
      await stopOwned(asrOwner, 'scripts/start-asr.mjs', 'local ASR');
    }
    await requireFreePort(config.port);
    const backup = path.join(dataDir, 'backups', new Date().toISOString().replaceAll(':', '-'));
    let hasDatabase = true;
    try { await access(path.join(dataDir, 'brain.sqlite')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hasDatabase = false; }
    if (hasDatabase) {
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await command('python3', ['-c', 'import sqlite3,sys\ns=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()', path.join(dataDir, 'brain.sqlite'), path.join(backup, 'brain.sqlite')]);
    }
    console.log('Refreshing Moolai backend; saved data and database volumes stay in place…');
    await command('docker', [...compose, 'up', '-d', '--wait', 'postgres'], env);
    await command('docker', [...compose, 'up', '-d', '--no-deps', '--force-recreate', 'api'], env);
    await waitFor(() => health(`${env.MOOLAI_BACKEND_URL ?? 'http://127.0.0.1:8000'}/health`), { label: 'Backend' });
    console.log(`Loading ${config.model}; microphone stays off…`);
    const asrPid = await launch(node, ['scripts/start-asr.mjs'], env, path.join(dataDir, 'asr-startup.log'));
    await waitFor(async () => {
      if (!alive(asrPid)) throw Error(`ASR stopped. See ${path.join(dataDir, 'asr-startup.log')}`);
      try { const r = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1500) }); const h = await r.json(); return r.ok && h.ready === true && h.activeCapture === false && h.model === config.model; } catch { return false; }
    }, { timeout: 180000, label: 'ASR' });
    const runtimePid = await launch(node, ['--env-file-if-exists=runtime.env', '--import', 'tsx', 'apps/runtime/src/main.ts'], env, path.join(dataDir, 'runtime.log'));
    await waitFor(async () => {
      if (!alive(runtimePid)) throw Error(`Runtime stopped. See ${path.join(dataDir, 'runtime.log')}`);
      try { const info = JSON.parse(await readFile(path.join(dataDir, 'runtime.json'), 'utf8'));
        return info.pid === runtimePid && await health(`http://127.0.0.1:${info.port}/api/state`, { Authorization: `Bearer ${info.token}` });
      } catch { return false; }
    }, { timeout: 45000, label: 'Moo runtime' });
    const desktopPid = await launch(path.join(root, 'node_modules/.bin/electron'), ['apps/desktop/electron.cjs'], env, path.join(dataDir, 'desktop-startup.log'));
    await writeFile(path.join(dataDir, 'startup.json'), JSON.stringify({ startedAt: new Date().toISOString(), runtimePid, asrPid, desktopPid, port, model: config.model, backup }), { mode: 0o600 });
    console.log('Moo is ready. Turn on the microphone in the app when you want to speak.');
  } finally { await unlink(lockPath).catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMoo().catch(error => { console.error(error.message); process.exitCode = 1; });
}
