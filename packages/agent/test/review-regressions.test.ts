import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent,type AgentOptions} from '../src/index.js';
import {ThoughtConsolidator} from '../src/thoughts.js';
import {rememberEvidence,loadEvidence} from '../src/evidence.js';
import {conversationHistory} from '../src/conversation-history.js';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,Segment,AgentReply,RouteDecision,ThoughtInput,ThoughtResult} from '../../contracts/src/index.js';
const at='2026-10-07T04:00:00Z';
const segment=(id:string,text:string,revision=1):Segment=>({id,turnId:id,revision,speaker:'user',text,final:true,createdAt:at});
function gate<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function waitFor(check:()=>boolean) {for(let n=0;n<200&&!check();n++)await new Promise(r=>setTimeout(r,2));assert.ok(check(),'Expected asynchronous checkpoint');}
const organized=(i:ThoughtInput):ThoughtResult=>({groups:[{title:'Ongoing review',summary:[i.activeNote?.summary,...i.segments.map(s=>s.text)].filter(Boolean).join(' '),spans:i.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length})),continuesActive:!!i.activeNote,ongoing:!i.finalize}],remainder:[]});
function consolidator(brain:BrainPort) {return new ThoughtConsolidator({brain,now:()=>at,emit:()=>{},notice:()=>{},context:async()=>'',enrich:async()=>{},generation:{summarize:async()=>({title:'Summary',summary:'Summary'}),respond:async()=>({text:'',toolCalls:[]}),consolidate:async i=>organized(i)}});}
function fixture(brain:BrainPort) {
 let n=0;const spoken:string[]=[];
 const options:AgentOptions={brain,id:()=>`fixture-${++n}`,now:()=>at,timeZone:'Asia/Singapore',
  decisions:{route:async i=>({route:i.activeConversation?'continue_agent':'start_agent',confidence:1}),tag:async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,faithful:1,understandable:1}),connect:async()=>({})},
  generation:{summarize:async()=>({title:'Summary',summary:'Summary'}),respond:async()=>({text:'Answer.',toolCalls:[]})},
  search:{search:async()=>[],extract:async()=>[]},vision:{interpret:async()=>''},capture:{capture:async()=>{throw Error('Capture forbidden in regression');}},speech:{speak:async text=>{spoken.push(text);},stop:async()=>{}}};
 const agent=new Agent(options);return {agent,options,spoken};
}
for(const kind of ['memory','sqlite']) {
 async function setup() {const dir=await mkdtemp(join(tmpdir(),'moolai-review-regression-'));const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);return {brain,async close(){await brain.close();await rm(dir,{recursive:true,force:true});}};}
 test(`${kind}: actual speech onset supersedes pending J1 close and leaves the new utterance held`,async()=>{
  const t=await setup();const f=fixture(t.brain);const route=gate<RouteDecision>(),entered=gate();
  try {await f.agent.initialize();await f.agent.submitText('Moo');const id=f.agent.getState().conversationId;
   f.options.decisions.route=async()=>{entered.resolve();return route.promise;};
   const closing=f.agent.submitText('End conversation.');await entered.promise;await f.agent.speechStarted();
   route.resolve({route:'end_agent',confidence:1,substantiveContentProbability:0});await closing;
   assert.equal(f.agent.getState().conversationId,id);assert.equal(f.agent.getState().activity,'listening');
   assert.ok(!f.spoken.some(s=>s.includes('Conversation closed')));
   assert.ok((await t.brain.listOperations()).some(o=>o.error?.includes('New speech superseded')));
   await f.agent.recognitionRejected();assert.equal(f.agent.getState().conversationId,id);
  } finally {route.resolve({route:'no_action',confidence:1});await f.agent.interrupt();await f.agent.drain();await t.close();}
 });
 for(const stage of ['file-check','reference-resolution']) test(`${kind}: correction during ${stage} cannot publish or speak obsolete source`,async()=>{
  const t=await setup();const f=fixture(t.brain);const reached=gate(),resume=gate();let calls=0,armed=false;
  const originalList=t.brain.listRecords.bind(t.brain);
  try {if(stage==='reference-resolution')t.brain.listRecords=async()=>{if(armed){armed=false;reached.resolve();await resume.promise;}return originalList();};
   f.options.localFiles={roots:async()=>[{id:'folder',name:'Folder',path:'/synthetic'}],grant:async()=>{throw Error('forbidden')},revoke:async()=>{},search:async()=>({matches:[],truncated:false}),read:async({rootId,path,startLine=1,lineCount=80})=>{if(stage==='file-check'&&lineCount===1&&!armed){armed=true;reached.resolve();await resume.promise;}return {rootId,path,startLine,text:'Source text',fingerprint:'unchanged',truncated:false};}};
   f.options.generation.respond=async()=>{if(stage==='file-check'&&calls++===0)return {text:'',toolCalls:[{id:'read',name:'read_local_file',arguments:{rootId:'folder',path:'source.md',lineCount:2}}]};if(stage==='reference-resolution')armed=true;return {text:'Obsolete ALPHA answer.',toolCalls:[]};};
   await f.agent.initialize();await f.agent.submitText('Moo, explain ALPHA from my notes.');await reached.promise;
   const source=(await t.brain.getRecord(f.agent.getState().sessionId!))!.segments.find(s=>s.speaker==='user')!;
   await f.agent.ingest({...source,revision:2,text:'Moo, explain BETA instead.'});resume.resolve();await f.agent.drain();
   const conversation=(await t.brain.getRecord(f.agent.getState().conversationId!))!;
   assert.ok(!conversation.segments.some(s=>s.text==='Obsolete ALPHA answer.'));assert.ok(!f.spoken.includes('Obsolete ALPHA answer.'));
   assert.match(f.agent.getState().lastError!,/stale|changed/i);assert.ok(conversation.segments.some(s=>s.text.includes('BETA')));
  }finally{resume.resolve();await f.agent.interrupt();await f.agent.drain();await t.close();}
 });
 test(`${kind}: a status reply adding notes-only rebuilds the original request without web evidence`,async()=>{
  const t=await setup();const f=fixture(t.brain);const pending=gate<AgentReply>();let calls=0;let newFrame='';let signal:AbortSignal|undefined;
  try {f.options.decisions.route=async i=>({route:i.text.includes('still working')?'check_status':i.activeConversation?'continue_agent':'start_agent',confidence:1});
   f.options.search.search=async()=>[{title:'Web source',url:'https://example.test/count',content:'WEB_ONLY_COUNT_17'}];
   f.options.generation.respond=async(messages,tools,s)=>{calls++;if(calls===1)return {text:'',toolCalls:[{id:'web',name:'search_web',arguments:{query:'testing count'}}]};if(calls===2){signal=s;return pending.promise;}newFrame=JSON.stringify(messages);assert.ok(!tools.some(t=>['search_web','extract_web'].includes(t.name)));return {text:'I need supporting notes to establish that count.',toolCalls:[]};};
   await f.agent.initialize();await f.agent.submitText('Moo, find the testing count.');await waitFor(()=>calls===2);
   await f.agent.submitText('Use only my notes; keep the answer to two sentences; are you still working?');await waitFor(()=>calls===3);
   pending.resolve({text:'The web count is 17.',toolCalls:[]});await f.agent.drain();
   assert.equal(signal?.aborted,true);assert.equal(f.agent.getState().webAllowed,false);
   assert.match(newFrame,/find the testing count/);assert.match(newFrame,/Use only my notes/);assert.match(newFrame,/two sentences/);assert.match(newFrame,/web access is disabled/);assert.doesNotMatch(newFrame,/WEB_ONLY_COUNT_17/);
   assert.ok(!f.spoken.includes('The web count is 17.'));assert.ok(f.spoken.includes('I need supporting notes to establish that count.'));
   const retained=await t.brain.getState<any>(`evidence-index:${f.agent.getState().conversationId}`);assert.match(JSON.stringify(retained),/WEB_ONLY_COUNT_17/,'Historical raw evidence is retained locally');
  }finally{pending.resolve({text:'',toolCalls:[]});await f.agent.interrupt();await f.agent.drain();await t.close();}
 });
 test(`${kind}: requested file ranges survive refresh and separate passages stay available`,async()=>{
  const t=await setup();const f=fixture(t.brain);let calls=0;let finalFrame='';const reads:number[]=[];
  try {f.options.localFiles={roots:async()=>[{id:'folder',name:'Folder',path:'/synthetic'}],grant:async()=>{throw Error('forbidden')},revoke:async()=>{},search:async()=>({matches:[],truncated:false}),read:async({rootId,path,startLine=1,lineCount=80})=>{reads.push(lineCount);return {rootId,path,startLine,text:Array.from({length:lineCount},(_,i)=>`LINE_${startLine+i}_VALUE`).join('\n'),fingerprint:'unchanged',truncated:true};}};
   f.options.generation.respond=async messages=>{calls++;if(calls<=2)return {text:'',toolCalls:[{id:`read-${calls}`,name:'read_local_file',arguments:{rootId:'folder',path:'source.md',startLine:calls===1?1:161,lineCount:calls===1?160:40}}]};finalFrame=JSON.stringify(messages);return {text:'Both passages are available.',toolCalls:[]};};
   await f.agent.initialize();await f.agent.submitText('Moo, compare the first 200 lines in source.md.');await f.agent.drain();
   for(const line of [1,80,81,160,161,200])assert.ok(finalFrame.includes(`LINE_${line}_VALUE`));
   assert.ok(reads.filter(n=>n===160).length>=2);assert.equal((await t.brain.getState<any>(`evidence-index:${f.agent.getState().conversationId}`)).files.length,2);
  }finally{await f.agent.interrupt();await f.agent.drain();await t.close();}
 });
 test(`${kind}: default file read retains the adapter's returned passage length`,async()=>{
  const t=await setup();try {const text=Array.from({length:100},(_,i)=>`Line ${i+1}`).join('\n');
   await rememberEvidence(t.brain,'conversation',{status:'success',call:{id:'read',name:'read_local_file',arguments:{rootId:'folder',path:'source.md'}},result:{rootId:'folder',path:'source.md',startLine:1,text,fingerprint:'same',truncated:true}});
   const f=fixture(t.brain);f.options.localFiles={roots:async()=>[],grant:async()=>{throw Error('forbidden')},revoke:async()=>{},search:async()=>({matches:[],truncated:false}),read:async input=>{assert.equal(input.lineCount,100);return {...input,startLine:input.startLine??1,text,fingerprint:'same',truncated:true};}};
   assert.equal((await loadEvidence(t.brain,'conversation',f.options.localFiles)).files[0]!.text,text);
  }finally{await t.close();}
 });
 for(const finalize of [false,true]) test(`${kind}: asynchronous buffer preparation ${finalize?'with no pending source':'with pending source'} cannot overwrite concurrent append`,async()=>{
  const t=await setup();const e=consolidator(t.brain);const reached=gate(),resume=gate();const set=t.brain.setState.bind(t.brain);let block=true;
  try {await t.brain.createRecord({id:'study',kind:'session',createdAt:at});const a=segment('a','First issue about recall.');await t.brain.upsertSegment('study',a);await e.append('study',[a]);if(finalize)await e.process('study');
   t.brain.setState=async(k,v)=>{if(k==='thought-buffer:study'&&block){block=false;reached.resolve();await resume.promise;}return set(k,v);};
   const processing=e.process('study',finalize);await reached.promise;
   const b=segment('b','Second issue about rendering.');await t.brain.upsertSegment('study',b);const appending=e.append('study',[b]);
   resume.resolve();await Promise.all([processing,appending]);
   const checkpoint=await t.brain.getState<any>('thought-buffer:study');
   assert.equal(checkpoint.seen.b,1);assert.ok(checkpoint.spans.some((s:any)=>s.segmentId==='b') || (await t.brain.listRecords()).some(n=>n.kind==='dictation'&&n.segments.some(s=>s.text===b.text)));
   await e.process('study',true,checkpoint.continuationRequired===true);
   const state=await t.brain.getState<any>('thought-buffer:study');const notes=(await t.brain.listRecords()).filter(r=>r.kind==='dictation');
   assert.equal(state.seen.b,1);assert.equal(state.spans.length,0,JSON.stringify(state));assert.ok(notes.some(n=>n.segments.some(s=>s.text===b.text)));assert.notEqual(state.status,'failed');
  }finally{resume.resolve();t.brain.setState=set;await t.close();}
 });
 for(const published of [true,false]) test(`${kind}: empty final correction invalidates ${published?'published':'draft'} content without a zero-length span or new inference`,async()=>{
  const t=await setup();const e=consolidator(t.brain);
  try {await t.brain.createRecord({id:'study',kind:'session',createdAt:at});const source=segment('a','Incorrect quantity: five units.');await t.brain.upsertSegment('study',source);await e.append('study',[source]);if(published)await e.process('study',true);
   let note=(await t.brain.listRecords()).find(r=>r.kind==='dictation')!;await t.brain.updateRecord(note.id,note.revision,{quality:'ready',title:'My protected title',manualFields:['title']});
   const correction={...source,text:'',revision:2};await t.brain.upsertSegment('study',correction);await e.append('study',[correction]);await e.process('study',true);
   note=(await t.brain.getRecord(note.id))!;const state=await t.brain.getState<any>('thought-buffer:study');
   assert.equal(note.quality,'needs_review');assert.match(note.qualityReasons.join(' '),/corrected/);assert.equal(note.segments.map(s=>s.text).join(''),'');assert.equal(note.title,'My protected title');
   assert.equal(state.seen.a,2);assert.deepEqual(state.spans,[]);assert.ok(note.sources!.every(s=>s.spans.every(p=>p.end>p.start)));assert.notEqual(note.thoughtStatus,'draft');
   assert.ok((await t.brain.history(note.id)).some(h=>h.record.segments.some(s=>s.text===source.text)),'Original source stays available in history');
  }finally{await t.close();}
 });
 test(`${kind}: oversized attributed context fails once without dropping source or retrying inference`,async()=>{
  const t=await setup();let calls=0;
  const e=new ThoughtConsolidator({brain:t.brain,now:()=>at,emit:()=>{},notice:()=>{},context:async()=>JSON.stringify({originalRequest:'x'.repeat(65000)}),enrich:async()=>{},generation:{summarize:async()=>({title:'Summary',summary:'Summary'}),respond:async()=>({text:'',toolCalls:[]}),consolidate:async i=>{calls++;return organized(i);}}});
  try {await t.brain.createRecord({id:'study',kind:'session',createdAt:at});const source=segment('a','Use the retained original discussion and preserve uncertainty.');await t.brain.upsertSegment('study',source);await e.append('study',[source]);
   await e.process('study');await e.process('study');await e.recover('study');
   const state=await t.brain.getState<any>('thought-buffer:study');assert.equal(calls,0);assert.equal(state.status,'failed');assert.match(state.error,/too large for one organization request/);assert.equal(state.spans[0].end,source.text.length);
   assert.equal((await t.brain.getRecord('study'))!.segments[0]!.text,source.text);assert.ok((await t.brain.listRecords()).some(r=>r.kind==='dictation'&&r.summary.includes('preserve uncertainty')));
  }finally{await t.close();}
 });
 test(`${kind}: onset during serialized publication check holds the answer until recognition resolves`,async()=>{
  const t=await setup();const f=fixture(t.brain);const reached=gate(),resume=gate();let calls=0,checks=0;
  try {f.options.localFiles={roots:async()=>[{id:'folder',name:'Folder',path:'/synthetic'}],grant:async()=>{throw Error('forbidden')},revoke:async()=>{},search:async()=>({matches:[],truncated:false}),read:async({rootId,path,startLine=1,lineCount=80})=>{if(lineCount===1&&++checks===2){reached.resolve();await resume.promise;}return {rootId,path,startLine,text:'Source',fingerprint:'same',truncated:false};}};
   f.options.generation.respond=async()=>++calls===1?{text:'',toolCalls:[{id:'read',name:'read_local_file',arguments:{rootId:'folder',path:'source.md',lineCount:2}}]}:{text:'The supported answer.',toolCalls:[]};
   await f.agent.initialize();await f.agent.submitText('Moo, explain my saved evidence.');await reached.promise;
   const onset=f.agent.speechStarted();resume.resolve();await onset;
   const id=f.agent.getState().conversationId!;assert.ok(!(await t.brain.getRecord(id))!.segments.some(s=>s.text==='The supported answer.'));
   await f.agent.recognitionRejected();await f.agent.drain();assert.ok(f.spoken.includes('The supported answer.'));assert.equal(calls,2);
  }finally{resume.resolve();await f.agent.interrupt();await f.agent.drain();await t.close();}
 });
 test(`${kind}: bounded history never expands when only speaker-prefix space remains`,async()=>{
  const t=await setup();try {await t.brain.createRecord({id:'history',kind:'conversation',createdAt:at});await t.brain.upsertSegment('history',segment('older','X'.repeat(10000)));
   for(const length of [1780,1789,1790,1791,1793,1794,1795,1799,1800,2200]) {
    await t.brain.upsertSegment('history',{...segment('newer','Y'.repeat(length),length),createdAt:'2026-10-07T04:01:00Z'});
    const result=await conversationHistory(t.brain,'2026-10-07','2026-10-07','UTC');const excerpt=result.discussions[0]!.excerpt;
    assert.ok(excerpt.length<=1800,`Length ${length} yielded ${excerpt.length}`);assert.match(excerpt,/Y/);assert.equal(result.discussions[0]!.truncated,true);
   }
  }finally{await t.close();}
 });
}
