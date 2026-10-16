// Real Electron lifecycle with a synthetic runtime; never starts native audio or providers.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const scenario = process.argv[2] || 'close';
assert.ok(['close', 'quit', 'renderer'].includes(scenario));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moolai-voice-lifecycle-'));
process.env.MOOLAI_DATA_DIR = dir;
delete process.env.MOOLAI_DESKTOP_DEV_URL;
app.setPath('userData', path.join(dir, 'electron'));
const requests = [];
let listening = true, speaking = true;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const runtime = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-lifecycle');
  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"state","state":{"listening":true,"busy":false}}\n\n');
    return;
  }
  if (req.method === 'POST') {
    let body = ''; for await (const part of req) body += part;
    requests.push({ path: req.url, body: JSON.parse(body) });
    if (req.url === '/api/speech/stop') speaking = false;
    if (req.url === '/api/voice') { assert.equal(JSON.parse(body).action, 'stop'); listening = false; }
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/state' ? {
    state: { listening: true, busy: false }, records: [], mode: 'fixture', localFolders: [],
    processing: { status: 'available' }, native: { enabled: listening, listening, speaking },
  } : { ok: true }));
});
function finish(error) {
  clearTimeout(deadline);
  runtime.closeAllConnections(); runtime.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (error) console.error(error);
  else console.log(JSON.stringify({ scenario, passed: true, requests, realAudioUsed: false }));
  app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error('Lifecycle check timed out')), 15000);
runtime.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
    port: runtime.address().port, token: 'fixture-lifecycle', pid: process.pid,
  }));
  require(path.join(root, 'apps/desktop/electron.cjs'));
  app.on('will-quit', event => {
    event.preventDefault();
    try {
      assert.equal(listening, false); assert.equal(speaking, false);
      assert.ok(requests.some(r => r.path === '/api/voice'));
      assert.ok(requests.some(r => r.path === '/api/speech/stop'));
      assert.ok(requests.every(r => ['/api/voice', '/api/speech/stop'].includes(r.path)));
      finish();
    } catch (error) { finish(error); }
  });
  app.whenReady().then(async () => {
    try {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
      if (scenario === 'renderer') {
        window.webContents.forcefullyCrashRenderer();
        for (let n = 0; n < 100 && (listening || speaking); n++) await pause(20);
        assert.equal(listening, false); assert.equal(speaking, false);
        window.close();
      } else if (scenario === 'quit') app.quit();
      else window.close();
    } catch (error) { finish(error); }
  });
});
