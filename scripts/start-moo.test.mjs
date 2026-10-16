import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ownedCommand, composeArgs, waitFor } from './start-moo.mjs';
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
test('one launcher keeps private profiles optional and never deletes storage or forces process termination', async()=>{
  const source=await readFile(new URL('./start-moo.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("'--force-recreate', 'api'"));assert.ok(source.includes('s.backup(d)'));
  assert.ok(!source.includes('SIGKILL'));assert.ok(!source.includes("'down'"));
  const wrapper=await readFile(new URL('./start-moo.sh',import.meta.url),'utf8');assert.match(wrapper,/\.data\/start-moo.local.mjs/);
});
