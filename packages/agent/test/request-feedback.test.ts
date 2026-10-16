import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent} from '../src/index.js';
import {loadEvidence, rememberEvidence} from '../src/evidence.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {rig} from '../../../experiments/agent-closeout/support.js';
import type {AgentReply} from '../../contracts/src/index.js';

for (const adapter of ['memory','sqlite']) {
 async function setup() {
  const dir=await mkdtemp(join(tmpdir(),'moo-request-feedback-'));
  const brain=adapter==='memory'?new MemoryBrain():new SQLiteBrain(dir);
  const f=rig(brain);await f.agent.initialize();
  return {...f,brain,async close(){await f.agent.interrupt();await f.agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
 }
 test(`${adapter}: interpreted correction is separate from exact source and clears for the next request`,async()=>{
  const f=await setup();try {
   f.hooks.generation.respond=async()=>({text:'I can help with that message.',understoodRequest:'Ask Ian for help studying Python.',toolCalls:[]});
   const original='Moo, ask John, no, Ian for help studying Python.';
   await f.agent.submitText(original);await f.agent.drain();
   const state=f.agent.getState();assert.equal(state.understoodRequest?.text,'Ask Ian for help studying Python.');
   const source=(await f.brain.getRecord(state.conversationId!))!;
   assert.equal(source.segments.find(s=>s.speaker==='user')!.text,original);
   assert.equal(f.observed.generations[0].messages.at(-1).content,original);
   f.hooks.generation.respond=async()=>({text:'A new answer.',toolCalls:[]});
   await f.agent.submitText('Now explain a different subject.');await f.agent.drain();
   assert.equal(f.agent.getState().understoodRequest,undefined);
  }finally{await f.close();}
 });
 test(`${adapter}: corrected transcript revision invalidates interpretation and late responses`,async()=>{
  const f=await setup();try {
   let release!:(reply:AgentReply)=>void;
   f.hooks.generation.respond=()=>new Promise(resolve=>release=resolve);
   await f.agent.submitText('Moo, ask Ian for help.');
   while(!release)await new Promise(resolve=>setTimeout(resolve,1));
   const source=(await f.brain.getRecord(f.agent.getState().conversationId!))!.segments.find(s=>s.speaker==='user')!;
   await f.agent.ingest({...source,revision:source.revision+1,text:'Moo, ask Jane for help.'});
   release({text:'The old target is Ian.',understoodRequest:'Ask Ian.',toolCalls:[]});await f.agent.drain();
   assert.equal(f.agent.getState().understoodRequest,undefined);
   assert.ok(!f.observed.speech.includes('The old target is Ian.'));
   assert.match(f.agent.getState().lastError!,/stale|changed/i);
  }finally{await f.close();}
 });
 test(`${adapter}: failed playback keeps the delivered answer and reports voice failure separately`,async()=>{
  const f=await setup();try {
   f.options.speech.speak=async()=>{throw Error('Synthetic audio failure');};
   f.hooks.generation.respond=async()=>({text:'The result is saved on screen.',toolCalls:[]});
   await f.agent.submitText('Moo, explain this.');await f.agent.drain();
   assert.equal(f.agent.getState().lastError,undefined);
   assert.ok((await f.brain.getRecord(f.agent.getState().conversationId!))!.segments.some(s=>s.text==='The result is saved on screen.'));
   assert.ok(f.observed.events.some(e=>e.type==='notice'&&/voice is unavailable/.test(e.message)));
   assert.ok((await f.brain.getState<any[]>('interaction-trace'))!.some(e=>e.reason==='playback_failed'));
  }finally{await f.close();}
 });
 test(`${adapter}: protocol-only legacy output is retained as a rejected draft without starting playback`,async()=>{
  const f=await setup();try {
   // Custom providers can bypass the backend contract; reject unusable output before publication.
   const text='<function>\n<name>read_note</name>\n</function>';
   let rejectedKey:string|undefined;
   const save=f.brain.setState.bind(f.brain);
   f.brain.setState=async(key,value)=>{if(key.startsWith('rejected-answer:'))rejectedKey=key;await save(key,value);};
   f.hooks.generation.respond=async()=>({text,toolCalls:[]});
   await f.agent.submitText('Moo, explain this.');await f.agent.drain();
   assert.equal(f.observed.speech.length,1);assert.match(f.observed.speech[0]!,/listening/);
   assert.match(f.agent.getState().lastError!,/incomplete answer \(protocol_only\)/);
   assert.ok(rejectedKey);assert.equal((await f.brain.getState<any>(rejectedKey))!.reply.text,text);
   assert.ok(!(await f.brain.getRecord(f.agent.getState().conversationId!))!.segments.some(s=>s.speaker==='assistant'&&s.text===text));
   assert.ok((await f.brain.getState<any[]>('interaction-trace'))!.some(e=>e.reason==='protocol_only'));
  }finally{await f.close();}
 });
 test(`${adapter}: stale interpreted request does not reappear after restart`,async()=>{
  const f=await setup();try {
   f.hooks.generation.respond=async()=>({text:'I will use the corrected target.',understoodRequest:'Ask Ian.',toolCalls:[]});
   await f.agent.submitText('Moo, ask John, no Ian.');await f.agent.drain();
   assert.ok(f.agent.getState().understoodRequest);
   const restarted=new Agent(f.options);await restarted.initialize();await restarted.drain();
   assert.equal(restarted.getState().understoodRequest,undefined);
  }finally{await f.close();}
 });
 test(`${adapter}: unorganized dictation supports a pronoun follow-up before notes exist`,async()=>{
  const f=await setup();let generated=0;try {
   f.hooks.decisions.route=async input=>({route:input.activeConversation?'continue_agent':/^Moo/.test(input.text)?'start_agent':'dictate',confidence:1});
   f.options.generation.consolidate=async()=>{throw Error('No organization should be required for recent context');};
   const agent=new Agent(f.options);await agent.initialize();
   await agent.submitText('The battery overheats at 42 degrees.');
   f.hooks.generation.respond=async messages=>{generated++;assert.match(JSON.stringify(messages),/battery overheats at 42 degrees/);return {text:'The cause needs supporting evidence.',toolCalls:[]};};
   await agent.submitText('Moo, why does that happen?');await agent.drain();
   assert.equal(generated,1);assert.equal(agent.getState().lastError,undefined);
   await agent.interrupt();await agent.drain();
  }finally{await f.close();}
 });
 test(`${adapter}: old task instructions leave working context while sources remain retrievable`,async()=>{
  const f=await setup();try {
   await f.agent.submitText('Moo, leave these isolated notes alone.');await f.agent.drain();
   f.options.now=()=> '2026-10-09T01:00:00.000Z';
   await f.agent.submitText('I am researching cows, no, dogs.');await f.agent.drain();
   const messages=f.observed.generations.at(-1).messages;
   assert.doesNotMatch(JSON.stringify(messages),/leave these isolated notes alone/);
   assert.equal(messages.at(-1).content,'I am researching cows, no, dogs.');
   assert.match(JSON.stringify(messages),/omittedSegmentCount/);
   assert.ok((await f.brain.getRecord(f.agent.getState().conversationId!))!.segments.some(s=>s.text.includes('leave these isolated')));
  }finally{await f.close();}
 });
 test(`${adapter}: interruption and unclear follow-up clear interpreted-request feedback`,async()=>{
  const f=await setup();try {
   f.hooks.generation.respond=async()=>({text:'I will use the corrected target.',understoodRequest:'Ask Ian.',toolCalls:[]});
   await f.agent.submitText('Moo, ask John, no Ian.');await f.agent.drain();
   await f.agent.interrupt();assert.equal(f.agent.getState().understoodRequest,undefined);
   await f.agent.submitText('Ask John, no Ian.');await f.agent.drain();assert.ok(f.agent.getState().understoodRequest);
   f.hooks.decisions.route=async()=>({route:'unclear',confidence:1});
   await f.agent.submitText('Wait, maybe something else.');await f.agent.drain();
   assert.equal(f.agent.getState().understoodRequest,undefined);
  }finally{await f.close();}
 });
 test(`${adapter}: missing original accepted-help source stops before answering isolated yes`,async()=>{
  const f=await setup();try {
   f.hooks.decisions.route=async input=>input.pendingOffer
     ? {route:'start_agent',confidence:1,helpAccepted:true}
     : {route:'offer_help',confidence:1};
   await f.agent.submitText('What does my saved question mean?');await f.agent.drain();
   const pending=f.agent.getState().pendingOffer!;
   assert.ok('recordId' in pending);const sourceId=pending.recordId;
   const original=f.brain.getRecord.bind(f.brain);
   f.brain.getRecord=async id=>id===sourceId&&f.agent.getState().conversationId?undefined:original(id);
   await f.agent.submitText('Yes');await f.agent.drain();
   assert.equal(f.observed.generations.length,0);
   assert.match(f.agent.getState().lastError!,/original request is unavailable/);
   f.brain.getRecord=original;
   assert.ok(await f.brain.getRecord(sourceId));
  }finally{await f.close();}
 });
 test(`${adapter}: retained history receipts cannot replay stale excerpts after restart`,async()=>{
  const f=await setup();try {
   const result={requestedInterval:{start:'2026-10-02',end:'2026-10-09'},matchingConversationCount:1,
    discussions:[{day:'2026-10-02',excerpt:'A now-corrected source value.'}]};
   // Existing stored indices are compacted on read as well as new writes.
   await f.brain.setState('evidence-index:conversation',{refs:[],outcomes:[{tool:'conversation_history',status:'success',result}]});
   assert.doesNotMatch(JSON.stringify(await loadEvidence(f.brain,'conversation')),/now-corrected|matchingConversationCount/);
   await rememberEvidence(f.brain,'conversation',{call:{id:'history',name:'conversation_history',arguments:{start:'2026-10-02',end:'2026-10-09'}},status:'success',result,executed:true});
   const stored=await f.brain.getState('evidence-index:conversation');assert.doesNotMatch(JSON.stringify(stored),/now-corrected/);
   assert.match(JSON.stringify(stored),/2026-10-02/);
  }finally{await f.close();}
 });
}
