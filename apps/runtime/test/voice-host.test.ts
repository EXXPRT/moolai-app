import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain} from '../../../packages/brain/src/index.js';
import {createAgentHost,FixtureProviders} from '../../../packages/agent-host/src/index.js';
import type {AgentEvent} from '../../../packages/contracts/src/index.js';

test('failed ASR startup resets capture intent; one later click retries and stop cancels a pending start',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-asr-start-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
let starts=0;
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.method==='startListening')starts++;
 console.log(JSON.stringify({id:r.id,result:{starts}}));
});`,{mode:0o700});
  const brain=new MemoryBrain();let attempts=0, release:()=>void=()=>{};
  const host=await createAgentHost({brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{},
    speech:{async warm(){},async speak(){},async stop(){},close(){}},
    waitForAsr:async()=>{attempts++;if(attempts===1)throw Error('Local speech recognition is unavailable');
      if(attempts===3)await new Promise<void>(r=>release=r);},
  });
  try {
    await assert.rejects(host.voice('start'),/unavailable/);
    assert.equal(host.nativeSnapshot().enabled,false);
    assert.equal(host.nativeSnapshot().requestedOn,false);
    assert.deepEqual(await host.nativeHealth(),{starts:0});
    await host.voice('start');
    assert.deepEqual(await host.nativeHealth(),{starts:1});
    await host.voice('stop');
    const pending=host.voice('start');
    while(attempts<3)await new Promise(r=>setImmediate(r));
    await host.voice('stop');release();await pending;
    assert.deepEqual(await host.nativeHealth(),{starts:1});
    assert.equal(host.nativeSnapshot().phase,'off');
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('voice host separates capture intent from actual state, delivers immediate updates, and respects explicit off',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-voice-host-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
let requested=false,starts=0;
const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);let result={};
 if(r.method==='startListening'){
  requested=true;starts++;
  emit({event:'status',requestedOn:true,listening:true,speaking:false,phase:'listening'});
  emit({event:'status',speaking:true,phase:'speaking'});
 }
 if(r.method==='stopListening'){requested=false;emit({event:'status',requestedOn:false,listening:false,speaking:false,phase:'off'});}
 if(r.method==='health')result={requested,starts};
 emit({id:r.id,result});
});`,{mode:0o700});
  const brain=new MemoryBrain();const events:AgentEvent[]=[];
  const host=await createAgentHost({waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}},brain,providers:new FixtureProviders(),nativePath,onEvent:e=>events.push(e)});
  try {
    const starting=host.voice('start');
    await host.voice('stop'); await starting;
    assert.deepEqual(await host.nativeHealth(),{requested:false,starts:0},'Stop during startup prevents a late microphone open');
    await host.voice('start');
    assert.equal(host.nativeSnapshot().requestedOn,true);
    assert.equal(host.nativeSnapshot().listening,true,'Partial speaking event does not erase capture state');
    assert.ok(events.some(e=>e.type==='voice'&&e.voice?.speaking===true));
    await host.voice('stop');await host.agent.stopSpeech();
    assert.equal(host.nativeSnapshot().listening,false);
    assert.equal(host.nativeSnapshot().enabled,false);
    assert.deepEqual(await host.nativeHealth(),{requested:false,starts:1},'No implicit reopen after explicit Stop');
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('typed session can stop and restart when no native companion is installed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-no-native-'));
  const brain=new MemoryBrain();
  const host=await createAgentHost({waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}},brain,providers:new FixtureProviders(),nativePath:join(directory,'missing'),onEvent:()=>{}});
  try {
    await host.agent.startSession();
    await host.agent.submitText('The measured length is five metres.');
    await host.voice('stop');
    await host.agent.stopSession();
    assert.equal(host.agent.getState().listening,false);
    await host.agent.startSession();
    assert.equal(host.agent.getState().listening,true);
    assert.ok((await brain.search('measured',10)).length);
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('a native connection failure after ASR readiness can be retried with one start request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-native-retry-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
let starts=0;const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='startListening'&&++starts===1){
  emit({event:'status',requestedOn:true,listening:false,phase:'error',error:'Local ASR connection failed'});
  emit({id:r.id,error:'Local ASR connection failed'});return;
 }
 if(r.method==='startListening')emit({event:'status',requestedOn:true,listening:true,phase:'listening',error:null});
 emit({id:r.id,result:{starts}});
});`,{mode:0o700});
  const brain=new MemoryBrain();
  const host=await createAgentHost({waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}},brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{}});
  try{
    await assert.rejects(host.voice('start'),/Local ASR connection failed/);
    assert.equal(host.nativeSnapshot().enabled,false);
    assert.equal(host.nativeSnapshot().requestedOn,false);
    await host.voice('start');
    assert.equal(host.nativeSnapshot().listening,true);
    assert.equal(host.nativeSnapshot().error,null);
    assert.deepEqual(await host.nativeHealth(),{starts:2});
    await host.voice('stop');
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('active capture still flushes the final transcript before stopping',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-flush-native-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='stopListening'){
  emit({event:'transcript',segment:{id:'final-segment',turnId:'final-turn',revision:1,speaker:'user',text:'The final word is telescope.',final:true,createdAt:'2026-09-27T00:00:00Z'}});
  emit({event:'turn_end',turnId:'final-turn'});
 }
 emit({id:r.id,result:{}});
});`,{mode:0o700});
  const brain=new MemoryBrain();
  const host=await createAgentHost({waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}},brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{}});
  try {
    await host.voice('start');
    await host.voice('stop');
    await host.agent.stopSession();
    const records=await brain.search('telescope',10);
    assert.ok(records.some(r=>r.segments.some(s=>s.text==='The final word is telescope.')));
    assert.equal(host.nativeSnapshot().enabled,false);
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

for(const failed of ['speech','capture'] as const) test(`failed ${failed} stop does not skip the other shutdown or falsely report Off`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moolai-stop-failure-'));const nativePath=join(directory,'companion.mjs');
 await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';let listening=false,stops=0;
createInterface({input:process.stdin}).on('line',s=>{const c=JSON.parse(s);if(c.method==='startListening')listening=true;if(c.method==='stopListening'){stops++;if(${JSON.stringify(failed)}==='capture'&&stops===1){console.log(JSON.stringify({id:c.id,error:'capture stop failed'}));return;}listening=false;}console.log(JSON.stringify({id:c.id,result:c.method==='health'?{listening,stops}:{}}));});`,{mode:0o700});
 const brain=new MemoryBrain();let speechStops=0;
 const host=await createAgentHost({brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{},waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){speechStops++;if(failed==='speech'&&speechStops===1)throw Error('speech stop failed');},close(){}}});
 try{await host.voice('start');await assert.rejects(host.voice('stop'),/Could not confirm/);
 const health=await host.nativeHealth() as {listening:boolean;stops:number};assert.equal(health.stops,1);assert.equal(speechStops,1);
 assert.equal(host.nativeSnapshot().phase,'error');assert.equal(host.nativeSnapshot().listening,failed==='capture');assert.equal(health.listening,failed==='capture');
 if(failed==='capture'){await assert.rejects(host.voice('start'),/unconfirmed/);await host.voice('stop');assert.equal(host.nativeSnapshot().listening,false);}
 }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('a new start waits for pending stop and cannot inherit its stale Off status',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moolai-stop-start-')),nativePath=join(directory,'native.mjs');
 await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';let listening=false,starts=0;const emit=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.method==='startListening'){listening=true;starts++;}if(c.method==='stopListening')listening=false;if(['startListening','stopListening'].includes(c.method))emit({event:'status',listening,requestedOn:listening,speaking:false,phase:listening?'listening':'off'});emit({id:c.id,result:{listening,starts}});});`,{mode:0o700});
 const brain=new MemoryBrain();let release:()=>void=()=>{},stops=0;
 const host=await createAgentHost({brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{},waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){if(++stops===1)await new Promise<void>(r=>release=r);},close(){}}});
 try{await host.voice('start');const stopping=host.voice('stop');const duplicateStop=host.voice('stop');const starting=host.voice('start');
 await new Promise(r=>setImmediate(r));assert.equal((await host.nativeHealth() as {starts:number}).starts,1);assert.equal(stops,1);
 release();await Promise.all([stopping,duplicateStop,starting]);assert.equal(host.nativeSnapshot().phase,'listening');assert.equal(host.nativeSnapshot().requestedOn,true);assert.equal(host.nativeSnapshot().enabled,true);
 }finally{release();await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('a later Stop cancels a Start queued behind an earlier shutdown',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moolai-stop-intent-')),nativePath=join(directory,'native.mjs');
 await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';let listening=false,starts=0;const emit=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.method==='startListening'){listening=true;starts++;}if(c.method==='stopListening')listening=false;emit({id:c.id,result:{listening,starts}});});`,{mode:0o700});
 const brain=new MemoryBrain();let release:()=>void=()=>{},stops=0;
 const host=await createAgentHost({brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{},waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){if(++stops===1)await new Promise<void>(r=>release=r);},close(){}}});
 try{await host.voice('start');const firstStop=host.voice('stop');const queuedStart=host.voice('start');const lastStop=host.voice('stop');release();
 await Promise.all([firstStop,queuedStart,lastStop]);assert.deepEqual(await host.nativeHealth(),{listening:false,starts:1});assert.equal(host.nativeSnapshot().enabled,false);assert.equal(host.nativeSnapshot().requestedOn,false);
 }finally{release();await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('owner loss closes a failed companion before unrelated generation finishes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moolai-owner-loss-')),nativePath=join(directory,'native.mjs');
 await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';let issued=false;const emit=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.method==='stopListening'){emit({id:c.id,error:'capture stop failed'});return;}if(c.method==='health'&&!issued){issued=true;emit({event:'transcript',segment:{id:'s',turnId:'t',revision:1,speaker:'user',text:'Moo, explain this note.',final:true,createdAt:'2026-10-07T00:00:00Z'}});emit({event:'turn_end',turnId:'t'});}emit({id:c.id,result:{pid:process.pid}});});`,{mode:0o700});
 const brain=new MemoryBrain(),providers=new FixtureProviders();let finish:()=>void=()=>{},started=false,closedSpeech=false;
 providers.respond=async()=>{started=true;await new Promise<void>(resolve=>finish=resolve);return {text:'Fixture answer',toolCalls:[]};};
 const host=await createAgentHost({brain,providers,nativePath,onEvent:()=>{},waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){closedSpeech=true;}}});
 try{await host.voice('start');const {pid}=await host.nativeHealth() as {pid:number};while(!started)await new Promise(r=>setImmediate(r));
 await host.revokeVoice();assert.equal(closedSpeech,true);assert.equal(host.nativeSnapshot().enabled,false);
 let alive=true;for(let n=0;n<50&&alive;n++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,5));}catch{alive=false;}}assert.equal(alive,false,'Owned companion exited while generation remained deferred');
 }finally{finish();await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('failed native startup shares cleanup with Stop and cannot overwrite a later successful Start',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moolai-start-cleanup-')),nativePath=join(directory,'native.mjs'),releasePath=join(directory,'release');
 await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';import{existsSync}from'node:fs';let listening=false,starts=0,stops=0,held;const emit=x=>console.log(JSON.stringify(x));createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.method==='startListening'){starts++;if(starts===1){emit({id:c.id,error:'first start failed'});return;}listening=true;emit({event:'status',requestedOn:true,listening:true,phase:'listening'});}if(c.method==='stopListening'){listening=false;stops++;if(stops===1){held=c.id;return;}}if(c.method==='health'&&existsSync(${JSON.stringify(releasePath)})&&held){emit({id:held,result:{}});held=undefined;}emit({id:c.id,result:{listening,starts,stops}});});`,{mode:0o700});
 const brain=new MemoryBrain();const events:AgentEvent[]=[];
 const host=await createAgentHost({brain,providers:new FixtureProviders(),nativePath,onEvent:e=>events.push(e),waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}}});
 const first=host.voice('start').catch(e=>e);
 try {
  let health={listening:false,starts:0,stops:0};
  for(let n=0;n<200&&health.stops!==1;n++){health=await host.nativeHealth() as typeof health;if(health.stops!==1)await new Promise(r=>setTimeout(r,2));}
  assert.equal(health.stops,1,'Startup cleanup reached its deferred physical stop');
  const stopping=host.voice('stop'),starting=host.voice('start');
  assert.deepEqual(await host.nativeHealth(),{listening:false,starts:1,stops:1},'Explicit stop joins startup cleanup; new start waits');
  await writeFile(releasePath,'release');await host.nativeHealth();await Promise.all([first,stopping,starting]);
  assert.deepEqual(await host.nativeHealth(),{listening:true,starts:2,stops:1});
  assert.equal(host.nativeSnapshot().enabled,true);assert.equal(host.nativeSnapshot().requestedOn,true);assert.equal(host.nativeSnapshot().listening,true);assert.equal(host.nativeSnapshot().phase,'listening');
  const last=events.filter(e=>e.type==='voice').at(-1)!;assert.equal(last.voice?.phase,'listening');assert.equal(last.voice?.error,null);
 }finally{await writeFile(releasePath,'release');await host.nativeHealth();await first;await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});
