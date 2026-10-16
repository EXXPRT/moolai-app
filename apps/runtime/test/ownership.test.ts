import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireRuntimeOwnership} from '../src/ownership.js';
import {VoiceOwner} from '../src/voice-owner.js';

test('workspace ownership rejects a duplicate before any recovery and permits release/restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'moolai-owner-'));
 try{const first=acquireRuntimeOwnership(dir);assert.throws(()=>acquireRuntimeOwnership(dir),/already has/);first.release();const second=acquireRuntimeOwnership(dir);second.release();}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('dead owners are reclaimed but a live legacy runtime is never displaced',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'moolai-owner-'));
 try{await writeFile(join(dir,'runtime-owner.json'),JSON.stringify({pid:1234,nonce:'dead'}));
 const current=acquireRuntimeOwnership(dir,pid=>pid!==1234);assert.equal(JSON.parse(await readFile(join(dir,'runtime-owner.json'),'utf8')).pid,process.pid);current.release();
 await writeFile(join(dir,'runtime.json'),JSON.stringify({pid:2345}));assert.throws(()=>acquireRuntimeOwnership(dir,()=>true),/already has/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('malformed or unfinished ownership fails closed without rewriting it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'moolai-owner-'));
 try{await writeFile(join(dir,'runtime-owner.guard'),'interrupted claim');assert.throws(()=>acquireRuntimeOwnership(dir),/claiming/);assert.equal(await readFile(join(dir,'runtime-owner.guard'),'utf8'),'interrupted claim');}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('losing the owning UI process stops voice once; focus/minimize and explicit stop do not reopen it',async()=>{
 let live=true,stops=0;const owner=new VoiceOwner(async()=>{stops++;},()=>live);
 owner.claim(123);await owner.check();assert.equal(stops,0);live=false;await owner.check();await owner.check();assert.equal(stops,1);
 live=true;owner.claim(123);owner.clear();live=false;await owner.check();assert.equal(stops,1);
});

test('real owner-process death revokes synthetic voice without losing conversation state',async()=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');
 let capture=true;const retained={conversationId:'still-open',text:'Last saved words'};
 const owner=new VoiceOwner(async()=>{capture=false;});owner.claim(child.pid!);
 try{assert.equal(capture,true);const exited=once(child,'exit');child.kill('SIGKILL');await exited;await owner.check();assert.equal(capture,false);assert.deepEqual(retained,{conversationId:'still-open',text:'Last saved words'});}
 finally{owner.clear();child.kill();}
});

test('a completed old stop cannot clear newer ownership',async()=>{
 let alive=true,stops=0;const owner=new VoiceOwner(async()=>{stops++;},()=>alive);
 const old=owner.claim(42);owner.claim(42);owner.clear(old);alive=false;await owner.check();assert.equal(stops,1);
});
