import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent} from '../src/index.js';
import {conversationHistory} from '../src/conversation-history.js';
import {connectionCandidates,connectNotes} from '../src/connections.js';
import {thoughtContext} from '../src/thought-context.js';
import {ThoughtConsolidator} from '../src/thoughts.js';
import {spokenAnswer,speechOutline} from '../src/response-output.js';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import type {AgentReply,BrainPort,Segment,SpokenOutline,ThoughtInput,ChatMessage,ToolDefinition} from '../../contracts/src/index.js';
const at='2026-09-30T14:00:00.000Z';
const segment=(id:string,text:string,createdAt=at,revision=1):Segment=>({id,turnId:id,text,createdAt,revision,speaker:'user',final:true});
const deferred=<T>()=> {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const wait=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),'Expected asynchronous checkpoint');};
const outline=(n:number):SpokenOutline=>({overview:'This covers access, evidence and review.',points:Array.from({length:n},(_,i)=>({label:`Point ${i+1}`,explanation:`Explanation ${i+1}, subject to verification.`}))});
for(const n of [1,5,6]) test(`requested narration covers ${n} points in batches of five`,()=>{
 const reply={text:'Full answer',toolCalls:[],spokenText:'This answer covers access, evidence and review.',spokenOutline:outline(n)};
 assert.equal(spokenAnswer(reply), reply.spokenText);
 const spoken=spokenAnswer(reply,'Walk me through the points');
 if(n<=5)for(let i=1;i<=n;i++)assert.match(spoken,new RegExp(`Explanation ${i}, subject to verification`));
 else {assert.match(spoken,/Explanation 5/);assert.match(spoken,/next points/);assert.doesNotMatch(spoken,/Explanation 6/);}
});
test('legacy nested supporting bullets stay with their numbered parent; table entries retain units',()=>{
 const s=speechOutline({text:'1) LLMs and MCPs\n- MCPs expose tools.\n- Tools increase capabilities.\n2) Limits\n  - Results still require review.',toolCalls:[]})!;
 assert.equal(s.points.length,2);assert.match(s.points[0]!.explanation,/MCPs expose tools.*increase/);assert.match(s.points[1]!.explanation,/require review/);
 const table=spokenAnswer({text:'| Material | Quantity |\n| --- | --- |\n| Salt | 5 g, approximate |\n| Water | 20 ml |',toolCalls:[]});
 assert.match(table,/Salt.*5 g, approximate/);assert.match(table,/Water.*20 ml/);
});

test('section headings and bold numbered points cannot silently lose later explanations',()=>{
 const headings={text:'# Overview\n## Tools\nMCP exposes tools.\n- Results still need review.\n## Context\nNotes retain context.\n## Limits\nConnections are provisional.',spokenText:'Tools are useful.',spokenOutline:{overview:'Overview',points:[{label:'Tools',explanation:'Tools help.'}]},toolCalls:[]};
 assert.equal(spokenAnswer(headings), headings.spokenText);
 const spoken=spokenAnswer(headings, 'Walk me through the sections');
 assert.match(spoken,/MCP exposes tools.*Results still need review.*Notes retain context.*Connections are provisional/);
 assert.equal(speechOutline(headings)!.points.length,3);
 const bold=spokenAnswer({text:'**1) Tools**\n- Expose capabilities.\n**2) Evidence**\n- Preserve uncertainty.',toolCalls:[]});
 assert.match(bold,/Expose capabilities.*Preserve uncertainty/);
 assert.equal(speechOutline({text:'- Tools\n  1. Read notes.\n  2. Search notes.\n- Limits\n  - Review results.',toolCalls:[]})!.points.length,2);
});

test('incomplete spoken table outline cannot hide later meaningful entries',()=>{
 const spoken=spokenAnswer({text:'| Topic | Detail |\n| --- | --- |\n| First | 5 g, approximate |\n| Last | Not yet measured |',spokenOutline:{overview:'Measurements',points:[{label:'First',explanation:'About 5 g.'}]},toolCalls:[]});
 assert.match(spoken,/5 g, approximate.*Not yet measured/);
});

for(const kind of ['memory','sqlite']) {
 async function setup() {
  const dir=await mkdtemp(join(tmpdir(),'moolai-continuity-'));let brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
  const providers=new FixtureProviders();const spoken:string[]=[];let count=0;const replies:any[]=[];
  const make=()=>new Agent({brain,decisions:providers,generation:providers,search:providers,vision:providers,capture:{async capture(){throw Error('not used');}},speech:{async speak(t){spoken.push(t);},async stop(){}},id:()=>`${kind}-${++count}`,now:()=>at,timeZone:'Asia/Singapore'});
  providers.respond=async(messages)=>{replies.push(structuredClone(messages));return {text:'Supported answer.',toolCalls:[]};};
  let agent=make();await agent.initialize();
  return {get brain(){return brain},providers,get agent(){return agent},spoken,replies,async restart(){await agent.drain();if(kind==='sqlite'){await brain.close();brain=new SQLiteBrain(dir);}agent=make();await agent.initialize();},async close(){await agent.interrupt();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
 }
 async function note(brain:BrainPort,id:string,title:string,text:string,date=at,links:any[]=[]){
  await brain.createRecord({id,kind:'note',createdAt:date});const r=await brain.upsertSegment(id,segment(id,text,date));
  return (await brain.updateRecord(id,r.revision,{title,links}))!;
 }
 test(`${kind}: history uses local transcript days, source-only multi-day conversations and latest earlier discussion`,async()=>{
  const t=await setup();try {
   let r=await t.brain.createRecord({id:'history',kind:'conversation',createdAt:'2026-09-01T00:00:00Z'});
   await t.brain.updateRecord(r.id,r.revision,{sourceOnly:true});
   await t.brain.upsertSegment(r.id,segment('before','Earlier discussion about turbines.','2026-09-28T15:59:59Z'));
   await t.brain.upsertSegment(r.id,segment('midnight','A new day, discussing batteries.','2026-09-28T16:00:00Z'));
   await t.brain.upsertSegment(r.id,segment('today','A later unrelated day.','2026-09-30T02:00:00Z'));
   let h=await conversationHistory(t.brain,'2026-09-29','2026-09-29','Asia/Singapore');
   assert.equal(h.matchingConversationCount,1);assert.match(h.discussions[0]!.excerpt,/batteries/);assert.doesNotMatch(h.discussions[0]!.excerpt,/turbines|unrelated/);
   h=await conversationHistory(t.brain,'2026-09-28','2026-09-29','Asia/Singapore');assert.equal(h.matchingConversationCount,1);assert.equal(h.matchingDayCount,2);
   h=await conversationHistory(t.brain,'2026-09-29','2026-09-29','UTC');assert.equal(h.matchingConversationCount,0);assert.match(h.latestEarlier!.excerpt,/turbines/);
   await assert.rejects(conversationHistory(t.brain,'2026-02-30','2026-03-01','UTC'),/valid/);
   h=await conversationHistory(t.brain,'2026-09-02','2026-09-02','Asia/Singapore');assert.equal(h.matchingConversationCount,0);assert.equal(h.latestEarlier,undefined);
  }finally{await t.close();}
 });
 test(`${kind}: history retrieval failure remains a tool failure, and prompts include installation date/timezone`,async()=>{
  const t=await setup();try{
   let calls=0;let received='';const original=t.brain.listRecords.bind(t.brain);
   t.providers.respond=async(m)=>{calls++;if(calls===1){assert.match(m[0]!.content,/2026-09-30.*Asia\/Singapore/);t.brain.listRecords=async()=>{throw Error('offline history');};return {text:'',toolCalls:[{id:'history',name:'conversation_history',arguments:{start:'2026-09-29',end:'2026-09-29'}}]};}
    t.brain.listRecords=original;received=m.at(-1)!.content;return {text:'I could not check saved history.',toolCalls:[]};};
   await t.agent.submitText('Moo, what did we discuss yesterday?');await t.agent.drain();
   assert.match(received,/failed.*offline history/);assert.doesNotMatch(received,/matchingConversationCount/);
  }finally{await t.close();}
 });
 for(const response of ['Moo?','Are you there?','empty']) test(`${kind}: ${response} preserves in-flight research and its request identity`,async()=>{
  const t=await setup();const result=deferred<AgentReply>();let calls=0;let signal:AbortSignal|undefined;
  try{
   t.providers.respond=async(_m:ChatMessage[],_tools?:ToolDefinition[],s?:AbortSignal)=>{calls++;signal=s;return result.promise;};
   await t.agent.submitText('Moo, research turbine efficiency.');await wait(()=>calls===1);
   await t.agent.speechStarted();result.resolve({text:'Turbine efficiency depends on temperature.',toolCalls:[]});
   await new Promise(r=>setTimeout(r,20));assert.ok(!(await t.brain.getRecord(t.agent.getState().conversationId!))!.segments.some(s=>s.text==='Turbine efficiency depends on temperature.'));
   if(response==='empty')await t.agent.recognitionRejected();else await t.agent.submitText(response);
   await t.agent.drain();assert.equal(calls,1);assert.equal(signal?.aborted,false);assert.ok(t.spoken.includes('Turbine efficiency depends on temperature.'));
   const trace=await t.brain.getState<any[]>('interaction-trace');assert.ok(trace!.some(x=>x.action==='speech_onset'));
  }finally{result.resolve({text:'',toolCalls:[]});await t.close();}
 });
 test(`${kind}: attention check holds tool dispatch, while substantive redirection cancels old work and rejects late output`,async()=>{
  const t=await setup();const old=deferred<AgentReply>();let calls=0,searches=0;let oldSignal:AbortSignal|undefined;
  try{
   t.providers.respond=async(_m:ChatMessage[],_tools?:ToolDefinition[],s?:AbortSignal)=>{calls++;if(calls===1){oldSignal=s;return old.promise;}return {text:'The new answer.',toolCalls:[]};};
   t.providers.search=async()=>{searches++;return [];};
   await t.agent.submitText('Moo, research turbines.');await wait(()=>calls===1);await t.agent.speechStarted();
   old.resolve({text:'',toolCalls:[{id:'s',name:'search_web',arguments:{query:'turbines'}}]});await new Promise(r=>setTimeout(r,15));assert.equal(searches,0);
   await t.agent.submitText('Instead explain batteries.');await t.agent.drain();
   assert.equal(oldSignal?.aborted,true);assert.equal(searches,0);assert.ok(t.spoken.includes('The new answer.'));assert.equal(t.agent.getState().busy,false);
  }finally{old.resolve({text:'',toolCalls:[]});await t.close();}
 });
 test(`${kind}: completed search remains reusable across attention checks`,async()=>{
  const t=await setup();const pending=deferred<any[]>();let calls=0;
  try{
   t.providers.search=async()=>pending.promise;
   t.providers.respond=async m=>{calls++;return calls===1?{text:'',toolCalls:[{id:'search',name:'search_web',arguments:{query:'turbines'}}]}:{text:'Retained turbine result.',toolCalls:[]};};
   await t.agent.submitText('Moo, research turbines.');await wait(()=>t.agent.getState().activity==='searching');await t.agent.speechStarted();
   pending.resolve([{url:'https://example.test/turbine',title:'Turbines',content:'Retained facts.'}]);await t.agent.submitText('Are you there?');await t.agent.drain();
   assert.equal(calls,2);assert.ok(t.spoken.includes('Retained turbine result.'));
   const ledger=await t.brain.getState<any[]>(`tool-ledger:${t.agent.getState().conversationId}`);assert.match(JSON.stringify(ledger),/Retained facts/);
  }finally{pending.resolve([]);await t.close();}
 });
 test(`${kind}: narration accepts batches of five, declines, clears on new work, and survives restart`,async()=>{
  const t=await setup();try{
   t.providers.respond=async()=>({text:'Eleven explained points.',spokenOutline:outline(11),toolCalls:[]});
   await t.agent.submitText('Moo, explain the points.');await t.agent.drain();assert.equal(t.agent.getState().narration,undefined);
   await t.agent.submitText('Walk me through the points.');assert.equal(t.agent.getState().narration?.next,5);
   assert.match(t.spoken.at(-1)!,/Explanation 5/);assert.doesNotMatch(t.spoken.at(-1)!,/Explanation 6/);
   assert.equal((await t.brain.getState<any>('agent')).narration.outline.points.length,11);
   await t.restart();assert.equal(t.agent.getState().narration?.outline.points.length,11);
   await t.agent.submitText('yes');assert.match(t.spoken.at(-1)!,/Explanation 10/);assert.doesNotMatch(t.spoken.at(-1)!,/Explanation 11/);
   await t.agent.submitText('No thanks');assert.equal(t.agent.getState().narration,undefined);
   await t.agent.submitText('Please explain again.');await t.agent.drain();await t.agent.interrupt();assert.equal(t.agent.getState().narration,undefined);
   assert.ok(!t.spoken.some(s=>/Explanation 11/.test(s)));
  }finally{await t.close();}
 });
 test(`${kind}: new substantive request clears a narration offer without replay`,async()=>{
  const t=await setup();try {
   t.providers.respond=async()=>({text:'Six points.',spokenOutline:outline(6),toolCalls:[]});
   await t.agent.submitText('Moo, explain six points.');await t.agent.drain();
   await t.agent.submitText('Walk me through the points.');
   const before=t.spoken.length;t.providers.respond=async()=>({text:'A different answer.',toolCalls:[]});
   await t.agent.submitText('Explain a different subject.');await t.agent.drain();
   assert.equal(t.agent.getState().narration,undefined);assert.deepEqual(t.spoken.slice(before),['A different answer.']);
  } finally {await t.close();}
 });
 test(`${kind}: corrected original response invalidates pending narration before acceptance`,async()=>{
  const t=await setup();try {
   t.providers.respond=async()=>({text:'Six points.',spokenOutline:outline(6),toolCalls:[]});
   await t.agent.submitText('Moo, explain six points.');await t.agent.drain();
   await t.agent.submitText('Walk me through the points.');
   const pending=t.agent.getState().narration!;assert.ok(pending.sourceResponse);
   const record=(await t.brain.getRecord(pending.conversationId))!;
   const source=record.segments.find(s=>s.id===pending.sourceResponse!.segmentId)!;
   await t.brain.upsertSegment(record.id,{...source,revision:source.revision+1,text:'Corrected source answer.'});
   await t.agent.submitText('yes');assert.equal(t.agent.getState().narration,undefined);
   assert.match(t.spoken.at(-1)!,/changed.*cannot be continued/);assert.doesNotMatch(t.spoken.at(-1)!,/Explanation/);
  }finally{await t.close();}
 });
 test(`${kind}: legacy narration rebuilds only from its original answer and clears when unidentified`,async()=>{
  const t=await setup();try {
   const text=Array.from({length:6},(_,i)=>`## Section ${i+1}\nOriginal detail ${i+1}.`).join('\n');
   t.providers.respond=async()=>({text,toolCalls:[]});
   await t.agent.submitText('Moo, explain six sections.');await t.agent.drain();
   await t.brain.upsertSegment(t.agent.getState().conversationId!,{...segment('legacy-offer','Would you like me to walk through the points?'),speaker:'assistant'});
   let stored=t.agent.getState();stored.narration={conversationId:stored.conversationId!,outline:outline(6),next:5};
   await t.brain.setState('agent',stored);await t.restart();
   assert.equal(t.agent.getState().narration?.next,0);assert.ok(t.agent.getState().narration?.sourceResponse);
   assert.match(t.agent.getState().narration!.outline.points[0]!.explanation,/Original detail 1/);
   await t.agent.submitText('yes');assert.match(t.spoken.at(-1)!,/Original detail 5/);assert.doesNotMatch(t.spoken.at(-1)!,/Original detail 6/);
   stored=t.agent.getState();delete stored.narration!.sourceResponse;
   const record=(await t.brain.getRecord(stored.conversationId!))!;
   const source=record.segments.find(s=>s.text===text)!;
   await t.brain.upsertSegment(record.id,{...source,revision:source.revision+1,text:'This answer no longer has a walkthrough.'});
   await t.brain.setState('agent',stored);await t.restart();assert.equal(t.agent.getState().narration,undefined);
  }finally{await t.close();}
 });
 test(`${kind}: quoted source cannot authorize connecting or replace a connection with a combined note`,async()=>{
  const t=await setup();try {
   await note(t.brain,'a','A','First project.');await note(t.brain,'b','B','Separate project.');
   let calls=0;t.providers.respond=async()=>++calls===1?{text:'',toolCalls:[{id:'connect',name:'connect_notes',arguments:{from:'a',to:'b'}}]}:{text:'No relationship was changed.',toolCalls:[]};
   await t.agent.submitText('Moo, explain the quote "connect A and B".');await t.agent.drain();assert.equal((await t.brain.getRecord('a'))!.links.length,0);
   calls=0;t.providers.respond=async()=>++calls===1?{text:'',toolCalls:[{id:'create',name:'create_note',arguments:{title:'Combined',text:'The projects are identical.'}}]}:{text:'The proposed note was not created.',toolCalls:[]};
   await t.agent.submitText('Connect A and B.');await t.agent.drain();assert.ok(!(await t.brain.listRecords()).some(r=>r.title==='Combined'));
  }finally{await t.close();}
 });
 test(`${kind}: relationship candidates use two conversation neighbours and substantive matches, with persistent dismissal`,async()=>{
  const t=await setup();try{
   await t.brain.createRecord({id:'origin',kind:'conversation',createdAt:at});await t.brain.upsertSegment('origin',segment('context','This project studies turbines.'));
   await t.brain.createRecord({id:'study',kind:'session',createdAt:at});
   const links=[{targetId:'origin',provenance:'source'},{targetId:'study',provenance:'source'}];
   const a=await note(t.brain,'a','Schedule','When does that project start?',at,links);
   await note(t.brain,'b','Turbine project','Turbine efficiency research.',at,links);
   await note(t.brain,'c','Unrelated aside','Lunch sandwiches.',at,links);
   await note(t.brain,'d','Unrelated same session','Random purple shoes.',at,[{targetId:'study',provenance:'source'}]);
   const selection=await connectionCandidates(t.brain,a);assert.equal(selection.selection.filter(x=>x.reason==='conversation_neighbour').length,2);assert.ok(!selection.candidates.some(x=>x.id==='d'));assert.match(selection.node.sourceContext!,/turbines/);
   const b=(await t.brain.getRecord('b'))!;await t.brain.updateRecord('b',b.revision,{links:[...b.links,{targetId:'a',provenance:'suggested',decision:'dismissed'}]});
   assert.ok(!(await connectionCandidates(t.brain,a)).candidates.some(x=>x.id==='b'));await assert.rejects(connectNotes(t.brain,'a','b'),/dismissed/);
  }finally{await t.close();}
 });
 test(`${kind}: explicit connections resolve exact titles, reject ambiguous names and are idempotent without creating notes`,async()=>{
  const t=await setup();try{
   await note(t.brain,'a','Turbine schedule','Turbine schedule.');await note(t.brain,'b','Turbine research','Turbine research.');
   const before=(await t.brain.listRecords()).length;
   assert.equal((await connectNotes(t.brain,'Turbine schedule','Turbine research')).saved,true);
   assert.equal((await connectNotes(t.brain,'b','a')).alreadyConnected,true);assert.equal((await t.brain.listRecords()).length,before);
   await note(t.brain,'dup','Turbine schedule','A different project.');await assert.rejects(connectNotes(t.brain,'Turbine schedule','b'),/Ambiguous/);
   let calls=0;t.providers.respond=async m=>++calls===1?{text:'',toolCalls:[{id:'connection',name:'connect_notes',arguments:{from:'a',to:'b'}}]}:{text:'The notes are connected.',toolCalls:[]};
   await t.agent.submitText('Moo, connect the turbine notes.');await t.agent.drain();
   assert.match(JSON.stringify(await t.brain.getState(`tool-ledger:${t.agent.getState().conversationId}`)),/alreadyConnected/);
  }finally{await t.close();}
 });
 test(`${kind}: batch context ignores later tool outcomes but changes for original source corrections`,async()=>{
  const t=await setup();try{
   await t.brain.createRecord({id:'conversation',kind:'conversation',createdAt:at});
   const original=await note(t.brain,'request','Original','Please explain pressure.');let c=(await t.brain.getRecord('conversation'))!;
   await t.brain.updateRecord(c.id,c.revision,{links:[{targetId:original.id,provenance:'reply'}]});
   const included=segment('included','First issue is evidence.');await t.brain.setState('turn-record:included','conversation');
   const context=await thoughtContext(t.brain,[included]);
   await t.brain.setState('work-status:conversation','Later unrelated request');
   await t.brain.setState('tool-ledger:conversation',[{call:{id:'later',name:'search_web',arguments:{query:'unrelated'}},result:{status:'success'},at:'2026-09-30T14:05:00.000Z'}]);
   assert.equal(await thoughtContext(t.brain,[included]),context);
   const outcome={call:{id:'completed',name:'create_note',arguments:{}},result:{status:'success',executed:true,result:{id:'saved-note'}},at:'2026-09-30T14:04:00.000Z',requestTurnId:'included'};
   await t.brain.setState('tool-ledger:conversation',[outcome]);
   const completedContext=await thoughtContext(t.brain,[included]);assert.match(completedContext,/saved-note/,'A completed tool after speech still belongs to the included request');
   await t.brain.setState('tool-ledger:conversation',[outcome,{...outcome,call:{...outcome.call,id:'later-unrelated'},requestTurnId:'other-request'}]);
   assert.equal(await thoughtContext(t.brain,[included]),completedContext);
   await t.brain.upsertSegment('request',segment('request','Correction: temperature.',at,2));assert.notEqual(await thoughtContext(t.brain,[included]),context);
  }finally{await t.close();}
 });
 test(`${kind}: four review issues span batches and restart as one umbrella note with complete sources`,async()=>{
  const t=await setup();try{
   await t.brain.createRecord({id:'study',kind:'session',createdAt:at});
   const spans=(i:ThoughtInput)=>i.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}));
   let n=0;const generation={...t.providers,summarize:t.providers.summarize.bind(t.providers),respond:t.providers.respond.bind(t.providers),consolidate:async(i:ThoughtInput)=>{n++;return i.finalize?{groups:[{title:'Four app review issues',summary:'Recall, recognition, Markdown and invocation need review.',spans:spans(i)}],remainder:[]}:{groups:[],remainder:spans(i)};}};
   const make=()=>new ThoughtConsolidator({brain:t.brain,generation,now:()=>at,emit:()=>{},notice:()=>{},enrich:async()=>{},context:s=>thoughtContext(t.brain,s)});
   let engine=make();const a=segment('a','A few issues: first, recall is confusing.');await t.brain.upsertSegment('study',a);await engine.append('study',[a]);await engine.process('study');
   engine=make();await engine.recover('study');const b=segment('b','Second, recognition. Third, Markdown. Fourth, invocation. That is the review.');await t.brain.upsertSegment('study',b);await engine.append('study',[b]);await engine.process('study',true);await engine.process('study',true);
   const notes=(await t.brain.listRecords()).filter(r=>r.kind==='dictation');assert.equal(notes.length,1);assert.equal(notes[0]!.segments.length,2);assert.match(notes[0]!.summary,/Recall.*recognition.*Markdown.*invocation/);assert.equal(n,2);
  }finally{await t.close();}
 });
}

test('interrupting spoken output is not a provider failure and does not resume the interrupted answer',async()=>{
 const brain=new MemoryBrain(),providers=new FixtureProviders();let next=0,started=false,rejectSpeech!:(e:Error)=>void;const spoken:string[]=[];
 providers.respond=async()=>({text:'The complete answer.',toolCalls:[]});
 const agent=new Agent({brain,decisions:providers,generation:providers,search:providers,vision:providers,capture:{async capture(){throw Error('unused');}},id:()=>`voice-${++next}`,now:()=>at,
  speech:{async speak(text){spoken.push(text);if(text==='The complete answer.'){started=true;await new Promise<void>((_,reject)=>rejectSpeech=reject);}},async stop(){rejectSpeech?.(Error('Speech interrupted'));}}});
 await agent.initialize();await agent.submitText('Moo, explain the result.');await wait(()=>started);await agent.speechStarted();await agent.recognitionRejected();await agent.drain();
 assert.equal(agent.getState().lastError,undefined);assert.equal(spoken.filter(s=>s==='The complete answer.').length,1);assert.ok(agent.getState().conversationId);await brain.close();
});

test('an incomplete supplied outline cannot silently drop a visible later list point',()=>{
 const spoken=spokenAnswer({text:'1. Tools expose capabilities.\n2. Results are uncertain and require review.',spokenOutline:{overview:'Tools.',points:[{label:'Tools',explanation:'Expose capabilities.'}]},toolCalls:[]});
 assert.match(spoken,/Results are uncertain and require review/);
});
