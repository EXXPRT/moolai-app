import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
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
 if(failed==='capture'){
  // Start first re-runs the unconfirmed stop (HRV-01); here it succeeds, so the microphone starts cleanly.
  await host.voice('start');
  const after=await host.nativeHealth() as {listening:boolean;stops:number};
  assert.equal(after.stops,2);assert.equal(after.listening,true);
  await host.voice('stop');assert.equal(host.nativeSnapshot().listening,false);
 }
 }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('Start still refuses when the re-run of an unconfirmed stop fails again (fail closed)',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'moolai-stop-closed-'));const nativePath=join(directory,'companion.mjs');
 await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';let starts=0;
createInterface({input:process.stdin}).on('line',s=>{const c=JSON.parse(s);if(c.method==='startListening')starts++;
if(c.method==='stopListening'){console.log(JSON.stringify({id:c.id,error:'capture stop failed'}));return;}
console.log(JSON.stringify({id:c.id,result:c.method==='health'?{starts}:{}}));});`,{mode:0o700});
 const brain=new MemoryBrain();
 const host=await createAgentHost({brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{},waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}}});
 try{
  await host.voice('start');await assert.rejects(host.voice('stop'),/Could not confirm/);
  await assert.rejects(host.voice('start'),/Could not confirm/);
  assert.equal(((await host.nativeHealth()) as {starts:number}).starts,1,'No second startListening while capture-off is unconfirmed');
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

test('a real speech_started while J1 routes a dictated turn keeps both sentences for the growing note',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-onset-host-'));
  const nativePath=join(directory,'companion.mjs');
  // Each health request makes the fake companion emit its next scripted batch, as the Swift companion would.
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
const at=new Date().toISOString();
const seg=(id,text)=>({id,turnId:id,revision:1,speaker:'user',text,final:true,createdAt:at});
const batches=[
  [{event:'speech_started',interruptedPlayback:false},{event:'transcript',segment:seg('A','The enzyme works best at 37 degrees.')},{event:'turn_end',turnId:'A'}],
  [{event:'speech_started',interruptedPlayback:false}],
  [{event:'transcript',segment:seg('B','Above 45 degrees it denatures.')},{event:'turn_end',turnId:'B'}],
];
let step=0;
createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.method==='health') for(const e of batches[step++]??[]) console.log(JSON.stringify(e));
  console.log(JSON.stringify({id:r.id,result:{step}}));
});`,{mode:0o700});
  const brain=new MemoryBrain(),providers=new FixtureProviders();
  const route=providers.route.bind(providers);
  let entered!:()=>void,release!:()=>void;
  const inFlight=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  providers.route=async input=>{if(input.text.startsWith('The enzyme')){entered();await gate;}return route(input);};
  const host=await createAgentHost({brain,providers,nativePath,onEvent:()=>{},waitForAsr:async()=>{},
    speech:{async warm(){},async speak(){},async stop(){},close(){}}});
  try{
    await host.nativeHealth();await inFlight;   // A finished; J1(A) is in flight
    await host.nativeHealth();                  // a real speech_started for the next utterance
    await new Promise(r=>setTimeout(r,20));release();
    await host.nativeHealth();                  // B final and turn_end
    for(let i=0;i<200 && !(await brain.getState('thought-eligible:B'));i++) await new Promise(r=>setTimeout(r,5));
    const buffer=await brain.getState<{spans?:{segmentId:string}[]}>(`thought-buffer:${host.agent.getState().sessionId}`);
    assert.deepEqual(buffer?.spans?.map(s=>s.segmentId),['A','B']);
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('Mic Off returns while an organization call is still running',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-mic-off-'));const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import{createInterface}from'node:readline';
createInterface({input:process.stdin}).on('line',s=>{const c=JSON.parse(s);console.log(JSON.stringify({id:c.id,result:{}}));});`,{mode:0o700});
  const brain=new MemoryBrain(),providers=new FixtureProviders();
  let release!:()=>void;const held=new Promise<void>(r=>release=r);let calls=0;
  const consolidate=providers.consolidate.bind(providers);
  providers.consolidate=async input=>{calls++;await held;return consolidate(input);};
  const host=await createAgentHost({brain,providers,nativePath,onEvent:()=>{},waitForAsr:async()=>{},speech:{async warm(){},async speak(){},async stop(){},close(){}}});
  try{
    await host.voice('start');
    await host.agent.submitText('A dictated thought about enzymes.');
    const organizing=host.agent.consolidateThoughts();
    for(let i=0;i<100 && !calls;i++) await new Promise(r=>setTimeout(r,2));
    assert.equal(calls,1,'An organizer call is in flight');
    const returned=await Promise.race([host.voice('stop').then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))]);
    assert.equal(returned,true,'Mic Off does not wait for the organizer call');
    release();await organizing;
  }finally{release();await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

// Step 11 / MOO-060: voice failures are heard, not only shown.
test('a recognition failure mid-capture turns the microphone off and says so',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-asr-fail-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
const methods=[];const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);methods.push(r.method);
 if(r.method==='startListening'){
  emit({event:'status',requestedOn:true,listening:true,speaking:false,phase:'listening'});
  setTimeout(()=>emit({event:'status',requestedOn:true,listening:false,speaking:false,phase:'error',error:'Local ASR connection failed'}),20);
 }
 if(r.method==='stopListening')emit({event:'status',requestedOn:false,listening:false,speaking:false,phase:'off'});
 emit({id:r.id,result:r.method==='health'?{methods}:{}});
});`,{mode:0o700});
  const brain=new MemoryBrain();const events:AgentEvent[]=[];const spoken:string[]=[];
  const host=await createAgentHost({waitForAsr:async()=>{},speech:{async warm(){},async speak(text){spoken.push(text);},async stop(){},close(){}},
    brain,providers:new FixtureProviders(),nativePath,onEvent:e=>events.push(e)});
  try {
    await host.voice('start');
    for(let i=0;i<200&&!spoken.length;i++)await new Promise(r=>setTimeout(r,5));
    assert.match(spoken[0]??'',/Speech recognition stopped, so I turned the microphone off/);
    assert.ok(events.some(e=>e.type==='notice'&&/turned the microphone off/.test(e.message??'')));
    assert.ok(((await host.nativeHealth()) as {methods:string[]}).methods.includes('stopListening'),'The microphone is switched off');
    assert.equal(host.nativeSnapshot().enabled,false);
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

test('a voice turn whose routing fails is said to be saved but not acted on',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-route-fail-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='startListening'){
  emit({event:'status',requestedOn:true,listening:true,speaking:false,phase:'listening'});
  setTimeout(()=>{emit({event:'transcript',segment:{id:'s1',turnId:'t1',revision:1,speaker:'user',text:'Glycolysis makes two ATP.',final:true,createdAt:new Date().toISOString()}});emit({event:'turn_end',turnId:'t1'});},20);
 }
 if(r.method==='stopListening')emit({event:'status',requestedOn:false,listening:false,speaking:false,phase:'off'});
 emit({id:r.id,result:{}});
});`,{mode:0o700});
  const brain=new MemoryBrain();const spoken:string[]=[];
  const providers=Object.assign(new FixtureProviders(),{async route():Promise<never>{throw Error('Backend 503: TypeSafe is not configured');}});
  const host=await createAgentHost({waitForAsr:async()=>{},speech:{async warm(){},async speak(text){spoken.push(text);},async stop(){},close(){}},
    brain,providers,nativePath,onEvent:()=>{}});
  try {
    await host.voice('start');
    for(let i=0;i<200&&!spoken.length;i++)await new Promise(r=>setTimeout(r,5));
    assert.deepEqual(spoken,["Moo saved what you said but couldn't act on it. Try saying it again in a moment."]);
    const session=(await brain.listRecords()).find(r=>r.kind==='session')!;
    assert.ok(session.segments.some(s=>s.text==='Glycolysis makes two ATP.'),'The words are saved');
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

// Ian, 20 Oct: a sound pauses Moo's reading; when it holds no words, the host asks the companion to resume.
test('a sound that paused the reading and held no words resumes playback in the companion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-resume-'));
  const nativePath=join(directory,'companion.mjs');
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
const methods=[];const emit=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);methods.push(r.method);
 if(r.method==='startListening'){
  emit({event:'status',requestedOn:true,listening:true,speaking:false,phase:'listening'});
  setTimeout(()=>{emit({event:'speech_started',interruptedPlayback:true,paused:true});setTimeout(()=>emit({event:'recognition_rejected'}),20);},20);
 }
 if(r.method==='stopListening')emit({event:'status',requestedOn:false,listening:false,speaking:false,phase:'off'});
 emit({id:r.id,result:r.method==='health'?{methods}:{}});
});`,{mode:0o700});
  const brain=new MemoryBrain();
  const host=await createAgentHost({waitForAsr:async()=>{},brain,providers:new FixtureProviders(),nativePath,onEvent:()=>{}});
  try {
    await host.voice('start');
    let methods:string[]=[];
    for(let i=0;i<200&&!methods.includes('resumeSpeaking');i++){await new Promise(r=>setTimeout(r,5));methods=((await host.nativeHealth()) as {methods:string[]}).methods;}
    assert.ok(methods.includes('resumeSpeaking'),'The companion is asked to resume');
    assert.ok(!methods.includes('stopSpeaking'),'The reading is not stopped');
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});

// Code review, 22 Oct: Mic Off, Stop session or a newer line while Moo read an answer said "Moo’s voice is unavailable", though the voice worked.
for(const ending of ['Mic Off','Stop session','a newer line','a worker crash'] as const) test(`${ending} while Moo reads an answer ${ending==='a worker crash'?'is':'is not'} reported as a voice failure`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'moolai-answer-stop-'));
  const nativePath=join(directory,'companion.mjs'),pidFile=join(directory,'worker.pid');
  // As in the Swift companion, endSpeechAudio returns once the audio has played; the answer's plays until stopSpeaking.
  // A flush hands over a voice turn J1 cannot route, so the host's failure line is said over the answer.
  await writeFile(nativePath,`#!${process.execPath}
import {createInterface} from 'node:readline';
const emit=x=>console.log(JSON.stringify(x));const answers=new Set();let playing;
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='speechAudio'&&Buffer.from(r.params.pcm,'base64')[0]===1)answers.add(r.params.utteranceId);
 if(r.method==='endSpeechAudio'&&answers.has(r.params.utteranceId)){playing=r.id;return;}
 if(r.method==='stopSpeaking'&&playing!==undefined){emit({id:playing,result:{}});playing=undefined;}
 if(r.method==='flushListening'){emit({event:'transcript',segment:{id:'s2',turnId:'t2',revision:1,speaker:'user',text:'Moo, also mention chlorophyll.',final:true,createdAt:new Date().toISOString()}});emit({event:'turn_end',turnId:'t2'});}
 emit({id:r.id,result:r.method==='health'?{playing:playing!==undefined}:{}});
});`,{mode:0o700});
  // The real LocalSpeech runs this stand-in for the Kokoro worker; the answer's audio begins with byte 1.
  await mkdir(join(directory,'native/tts'),{recursive:true});
  await writeFile(join(directory,'tts-config.json'),JSON.stringify({provider:'kokoro',python:relative(directory,process.execPath)}));
  await writeFile(join(directory,'native/tts/worker.py'),`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const emit=x=>console.log(JSON.stringify(x));emit({event:'ready'});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method==='cancel')return;
 emit({id:x.id,pcm:Buffer.alloc(400,x.text.startsWith('Photosynthesis')?1:0).toString('base64')});emit({id:x.id,done:true});});`);
  const brain=new MemoryBrain(),providers=new FixtureProviders(),events:AgentEvent[]=[];
  providers.respond=async()=>({text:'Photosynthesis turns light, water and carbon dioxide into sugar.',toolCalls:[]});
  const route=providers.route.bind(providers);providers.route=async input=>{if(input.text.includes('chlorophyll'))throw Error('J1 unavailable');return route(input);};
  const host=await createAgentHost({brain,providers,nativePath,speechRoot:directory,waitForAsr:async()=>{},onEvent:e=>events.push(e)});
  const playing=async()=>((await host.nativeHealth()) as {playing:boolean}).playing;
  try {
    await host.voice('start');
    await host.agent.submitText('Moo, explain how photosynthesis works.');
    for(let i=0;i<500&&!await playing();i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(await playing(),true,'Moo is reading the answer');
    if(ending==='a worker crash')process.kill(Number(await readFile(pidFile,'utf8')));
    else if(ending==='a newer line')await host.voice('flush');
    else {await host.voice('stop');if(ending==='Stop session')await host.agent.stopSession();}
    await host.agent.drain();
    const failed=ending==='a worker crash',notices=events.flatMap(e=>e.type==='notice'?[e.message]:[]);
    if(ending==='a newer line')assert.ok(notices.includes("Moo saved what you said but couldn't act on it. Try saying it again in a moment."),notices.join('\n'));
    assert.equal(notices.includes('Moo’s voice is unavailable. The full response is on screen.'),failed,notices.join('\n'));
    const trace=await brain.getState<{action:string;reason?:string}[]>('interaction-trace')??[];
    assert.equal(trace.some(e=>e.action==='narration_unavailable'&&e.reason==='playback_failed'),failed,'Only a real failure is traced as one');
  }finally{await host.close();await brain.close();await rm(directory,{recursive:true,force:true});}
});
