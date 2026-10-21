import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ownedCommand, composeArgs, waitFor, screenPermissionWarning, startupScreenWarning } from './start-moo.mjs';
import { readAsrConfig } from './asr-config.mjs';

test('startup ownership requires the intended checkout and entry point', () => {
  assert.equal(ownedCommand('node scripts/start-asr.mjs', '/moo', '/moo', 'scripts/start-asr.mjs'), true);
  assert.equal(ownedCommand('node scripts/start-asr.mjs', '/other', '/moo', 'scripts/start-asr.mjs'), false);
  assert.equal(ownedCommand('node unrelated.mjs', '/moo', '/moo', 'scripts/start-asr.mjs'), false);
});
test('compose options remain distinct arguments, preserving spaces without a shell', () => {
  assert.deepEqual(composeArgs(), ['compose', '-f', 'compose.yaml']);
  assert.deepEqual(composeArgs({ composeFiles:['compose.yaml','/local space/overlay.json'],composeEnv:'/private env/.env' }), ['compose','--env-file','/private env/.env','-f','compose.yaml','-f','/local space/overlay.json']);
});
test('readiness checks wait for success and stop visibly on bounded failure', async () => {
  let n=0;await waitFor(()=>++n===3,{interval:1,timeout:100});assert.equal(n,3);
  await assert.rejects(waitFor(()=>false,{interval:1,timeout:3,label:'Synthetic ASR'}),/Synthetic ASR did not become ready/);
  await assert.rejects(waitFor(()=>{throw Error('Child exited')},{interval:1,timeout:100}),/Child exited/);
});
test('startup and child processes can select the same explicit ASR config',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moo-startup-'));
  try {const config=JSON.parse(await readFile(new URL('../asr-config.json',import.meta.url),'utf8'));config.port=8188;
    await writeFile(path.join(dir,'trial.json'),JSON.stringify(config));
    assert.equal((await readAsrConfig(dir,'trial.json')).port,8188);
  }finally{await rm(dir,{recursive:true,force:true});}
});
// 21 Oct: macOS checks Screen Recording for the terminal that ran npm run moo (Warp), not for Moolai Native.
test('startup names the app that needs Screen Recording, only when screenshots are off', () => {
  assert.equal(screenPermissionWarning({screenPermission:false},{TERM_PROGRAM:'WarpTerminal'}),
    'Screenshots are off: macOS has not given Screen Recording permission to Warp, the app that started Moo. Turn on Warp in System Settings > Privacy & Security > Screen & System Audio Recording, quit and reopen Warp, then run npm run moo again.');
  for (const [program,app] of [['Apple_Terminal','Terminal'],['iTerm.app','iTerm'],['vscode','Visual Studio Code'],['ghostty','Ghostty']])
    assert.match(screenPermissionWarning({screenPermission:false},{TERM_PROGRAM:program}),new RegExp(`permission to ${app}, the app that started Moo\\. Turn on ${app} .* reopen ${app}, then`));
  for (const env of [{TERM_PROGRAM:'Hyper'},{TERM_PROGRAM:'constructor'},{}]) {
    const warning=screenPermissionWarning({screenPermission:false},env);
    assert.match(warning,/^Screenshots are off: macOS has not given Screen Recording permission to the app that ran npm run moo\. Turn on that app in System Settings > Privacy & Security > Screen & System Audio Recording, quit and reopen it, then run npm run moo again\.$/);
  }
  for (const health of [{screenPermission:true},{},{error:'Native companion unavailable'},undefined])
    assert.equal(screenPermissionWarning(health,{TERM_PROGRAM:'WarpTerminal'}),undefined);
});
test('the startup screen check uses the runtime token, waits for the companion and never fails startup', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'moo-screen-'));
  let requests=0,mode='denied';
  const server=createServer((req,res)=>{
    requests++;
    if (req.url!=='/api/native' || req.headers.authorization!=='Bearer secret') { res.writeHead(401).end('{}'); return; }
    if (mode==='silent') return;
    // Answers without the field, as while the companion starts, are asked again.
    const answer=mode==='unavailable' || requests<3 ? {error:'Native health timed out'} : {screenPermission:mode!=='denied'};
    res.writeHead(answer.error?400:200,{'Content-Type':'application/json'}).end(JSON.stringify(answer));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    assert.equal(await startupScreenWarning(dir,{TERM_PROGRAM:'WarpTerminal'},200),undefined,'No runtime.json');
    await writeFile(path.join(dir,'runtime.json'),JSON.stringify({port:server.address().port,token:'secret',pid:1,mode:'live'}));
    assert.match(await startupScreenWarning(dir,{TERM_PROGRAM:'WarpTerminal'}),/permission to Warp/);
    assert.equal(requests,3);
    mode='granted';
    assert.equal(await startupScreenWarning(dir,{TERM_PROGRAM:'WarpTerminal'}),undefined);
    for (const quiet of ['unavailable','silent']) {
      mode=quiet; const started=Date.now();
      assert.equal(await startupScreenWarning(dir,{TERM_PROGRAM:'WarpTerminal'},400),undefined,mode);
      assert.ok(Date.now()-started<2500,`An ${mode} companion holds startup only briefly`);
    }
  } finally { server.closeAllConnections(); server.close(); await rm(dir,{recursive:true,force:true}); }
});
test('one launcher keeps private profiles optional and never deletes storage or forces process termination', async()=>{
  const source=await readFile(new URL('./start-moo.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("'--force-recreate', 'api'"));assert.ok(source.includes('s.backup(d)'));
  assert.ok(!source.includes('SIGKILL'));assert.ok(!source.includes("'down'"));
  const wrapper=await readFile(new URL('./start-moo.sh',import.meta.url),'utf8');assert.match(wrapper,/\.data\/start-moo.local.mjs/);
});
