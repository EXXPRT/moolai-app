import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,Segment,ThoughtInput,ThoughtResult} from '../../contracts/src/index.js';
import {ThoughtConsolidator,validateThoughts} from '../src/thoughts.js';
import {resolveNoteReferences} from '../src/references.js';
import {newRecord} from '../../contracts/src/records.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
const now=()=> '2026-09-27T12:00:00Z';
const seg=(id:string,text:string,revision=1,speaker:Segment['speaker']='user'):Segment=>({id,turnId:id,revision,text,speaker,createdAt:now(),final:true});
const spans=(input:ThoughtInput)=>input.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}));
const finish=(input:ThoughtInput):ThoughtResult=>({groups:[{title:'Hamstring revision',summary:input.segments.map(s=>`${s.speaker}: ${s.text}`).join('\n'),spans:spans(input),topicSuggestions:['Anatomy']}],remainder:[]});
for(const kind of ['memory','sqlite']) {
  async function setup() {
    const dir=await mkdtemp(join(tmpdir(),'moolai-thoughts-'));
    let brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    await brain.createRecord({id:'study',kind:'session',createdAt:now()});
    const notices:string[]=[];let calls=0;let infer=(input:ThoughtInput):Promise<ThoughtResult>=>Promise.resolve(finish(input));
    const make=()=>new ThoughtConsolidator({brain,now,emit:()=>{},notice:m=>notices.push(m),enrich:async()=>{},context:async()=>'',generation:{summarize:async()=>({title:'',summary:''}),respond:async()=>({text:'',toolCalls:[]}),consolidate:async i=>{calls++;return infer(i);}}});
    let engine=make();
    return {get brain(){return brain},get engine(){return engine},notices,get calls(){return calls},set infer(fn:typeof infer){infer=fn},
      async add(s:Segment){await brain.upsertSegment('study',s);await engine.append('study',[s]);},
      async restart(){if(kind==='sqlite'){await brain.close();brain=new SQLiteBrain(dir);}engine=make();await engine.recover('study');},
      async notes(){return (await brain.listRecords()).filter(r=>r.kind==='dictation');},
      async close(){await brain.close();await rm(dir,{recursive:true,force:true});}};
  }
  test(`${kind}: a visible draft becomes one growing note across batches, manual fields and restart`,async()=>{
    const t=await setup();try{
      t.infer=async i=>({groups:[{...finish(i).groups[0]!,summary:[i.activeNote?.summary,...i.segments.map(s=>s.text)].filter(Boolean).join(' '),continuesActive:!!i.activeNote,ongoing:!i.finalize}],remainder:[]});
      await t.add(seg('a','Four issues: first, recall needs dates.'));
      const draft=(await t.notes())[0]!;assert.equal(draft.thoughtStatus,'draft');assert.match(draft.summary,/recall needs dates/);assert.notEqual(draft.title,'New thought');assert.equal(draft.summarySourceRevision,undefined);assert.equal(t.calls,0);
      await t.engine.process('study');let note=(await t.notes())[0]!;assert.equal(note.id,draft.id);assert.equal(note.thoughtStatus,'growing');
      await t.brain.updateRecord(note.id,note.revision,{title:'My app review',topics:['My topic'],manualFields:['title','topics']});
      await t.add(seg('b','Second, Markdown should render.'));await t.engine.process('study');
      await t.restart();await t.add(seg('c','Third, invocation; fourth, related notes.'));await t.engine.process('study');
      note=(await t.notes())[0]!;assert.equal((await t.notes()).length,1);assert.equal(note.title,'My app review');assert.deepEqual(note.topics,['My topic']);
      assert.match(note.summary,/recall/);assert.match(note.summary,/Markdown/);assert.match(note.summary,/fourth/);assert.equal(note.segments.length,3);
      const calls=t.calls;await t.engine.process('study',true);await t.restart();assert.equal(t.calls,calls);
      assert.equal((await t.notes())[0]!.thoughtStatus,'settled');
    }finally{await t.close();}
  });
  test(`${kind}: topic return creates a separate episode while continuation reuses the current ID`,async()=>{
    const t=await setup();try{
      t.infer=async i=>({groups:[{...finish(i).groups[0]!,title:i.segments[0]!.text,continuesActive:false,ongoing:true}],remainder:[]});
      for(const [id,text] of [['a','Hamstring'],['b','Brain'],['c','Hamstring again']]){await t.add(seg(id!,text!));await t.engine.process('study');}
      const notes=await t.notes();assert.equal(notes.length,3);assert.equal(notes.filter(n=>n.thoughtStatus==='growing').length,1);
      assert.equal(new Set(notes.map(n=>n.id)).size,3);
    }finally{await t.close();}
  });
  test(`${kind}: new speech during inference stays queued; included manual edits reject stale output`,async()=>{
    const t=await setup();try{
      let release!:(v:ThoughtResult)=>void,captured!:ThoughtInput;
      t.infer=i=>{captured=i;return new Promise(r=>release=r)};
      await t.add(seg('a','First point.'));const work=t.engine.process('study');while(!release)await new Promise(r=>setTimeout(r,1));
      await t.add(seg('b','Second point.'));release({...finish(captured),groups:[{...finish(captured).groups[0]!,ongoing:true}]});await work;
      assert.equal((await t.notes()).length,1);assert.equal((await t.brain.getState<any>('thought-buffer:study')).spans[0].segmentId,'b');
      release=undefined!;const next=t.engine.process('study');while(!release)await new Promise(r=>setTimeout(r,1));
      const n=(await t.notes())[0]!;await t.brain.updateRecord(n.id,n.revision,{summary:'My manual correction',manualFields:['summary']});
      release({groups:[{...finish(captured).groups[0]!,continuesActive:true,ongoing:true}],remainder:[]});await next;
      assert.equal((await t.notes())[0]!.summary,'My manual correction');assert.equal((await t.brain.getState<any>('thought-buffer:study')).status,'failed');
      const calls=t.calls;await t.restart();await t.engine.process('study');assert.equal(t.calls,calls);
    }finally{await t.close();}
  });
  test(`${kind}: long source is bounded across growing batches without dropping characters`,async()=>{
    const t=await setup();try{
      const content='a'.repeat(7999)+'🦵'+'b'.repeat(10000);
      t.infer=async i=>{assert.ok(i.segments.reduce((n,s)=>n+s.text.length,0)<=8000);return {groups:[{title:'Long thought',summary:'A long retained source.',spans:spans(i),continuesActive:!!i.activeNote,ongoing:!i.finalize}],remainder:[]}};
      await t.add(seg('a',content));await t.engine.process('study',true);
      const notes=await t.notes();assert.equal(notes.length,1);assert.equal(notes[0]!.segments.map(s=>s.text).join(''),content);assert.equal(t.calls,3);
      assert.equal(notes[0]!.thoughtStatus,'settled');
    }finally{await t.close();}
  });
  test(`${kind}: interruption after a staged record write resumes once without another model call`,async()=>{
    const t=await setup();try{
      t.infer=async i=>({groups:[{...finish(i).groups[0]!,ongoing:true}],remainder:[]});
      await t.add(seg('a','A growing thought.'));
      const original=t.brain.setState.bind(t.brain);let injected=false;
      t.brain.setState=async(k,v)=>{if(k==='thought-buffer:study' && !(v as any).staged && (v as any).activeId && !injected){injected=true;throw Error('simulated crash after record commit')}return original(k,v);};
      await t.engine.process('study');t.brain.setState=original;
      const state=await t.brain.getState<any>('thought-buffer:study');assert.ok(state.staged?.plans?.length);
      // A real process loss leaves the dispatched status, unlike a caught test exception.
      await t.brain.setState('thought-buffer:study',{...state,status:'running'});
      await t.restart();await t.restart();assert.equal(t.calls,1);assert.equal((await t.notes()).length,1);
      assert.equal((await t.brain.getState<any>('thought-buffer:study')).spans.length,0);
    }finally{await t.close();}
  });
  test(`${kind}: pauses and repeated timers keep one pending thought, stop finalizes once`,async()=>{
    const t=await setup();try{
      t.infer=async i=>i.finalize?finish(i):{groups:[],remainder:spans(i)};
      await t.add(seg('a','The hamstring flexes the knee.'));await t.engine.process('study');await t.engine.process('study');
      assert.equal(t.calls,1);assert.equal((await t.notes()).filter(r=>r.thoughtStatus!=='draft').length,0);
      await t.add(seg('b','It also helps extend the hip.'));await t.engine.process('study');
      await t.restart();await t.engine.process('study',true);await t.engine.process('study',true);
      assert.equal((await t.notes()).length,1);assert.equal((await t.notes())[0]!.segments.length,2);
      assert.equal(t.calls,3);
    }finally{await t.close();}
  });
  test(`${kind}: hamstring brain hamstring keeps ordered separate episodes including within one ASR block`,async()=>{
    const t=await setup();try{
      await t.add(seg('a','Hamstring. Brain. Hamstring again.'));
      t.infer=async i=>({groups:[{title:'Hamstring',summary:'First hamstring thought',spans:[{segmentId:'a',revision:1,start:0,end:11}]},{title:'Brain',summary:'Brain thought',spans:[{segmentId:'a',revision:1,start:11,end:18}]}],remainder:[{segmentId:'a',revision:1,start:18,end:i.segments[0]!.text.length}]});
      await t.engine.process('study');assert.equal((await t.notes()).filter(r=>r.thoughtStatus!=='draft').length,2);
      t.infer=async i=>finish(i);await t.engine.process('study',true);
      const notes=await t.notes();assert.equal(notes.length,3);assert.equal(notes[2]!.segments[0]!.text,'Hamstring again.');
      assert.equal(notes[2]!.sources![0]!.spans[0]!.start,18);
    }finally{await t.close();}
  });
  test(`${kind}: restart publishes a staged result once without another Nano call`,async()=>{
    const t=await setup();try{
      const source=seg('a','Retained staged thought.');await t.add(source);
      const input:ThoughtInput={sessionId:'study',segments:[source],context:'',finalize:true};
      const state=await t.brain.getState<any>('thought-buffer:study');
      await t.brain.setState('thought-buffer:study',{...state,status:'running',staged:{input,result:finish(input),spans:spans(input),operation:'staged-once'}});
      await t.restart();await t.restart();await t.engine.process('study',true);
      assert.equal(t.calls,0);assert.equal((await t.notes()).length,1);
      assert.equal((await t.notes())[0]!.segments[0]!.text,source.text);
    }finally{await t.close();}
  });
  test(`${kind}: omitted duplicated reordered source and incomplete summaries never publish`,async()=>{
    const t=await setup();try{
      await t.add(seg('a','A faithful source.'));
      t.infer=async()=>({groups:[],remainder:[]});await t.engine.process('study',true);
      assert.equal((await t.notes()).filter(r=>r.thoughtStatus!=='draft').length,0);assert.equal(t.calls,1);
      await t.engine.process('study',true);assert.equal(t.calls,1,'no automatic paid retry');
      assert.ok(t.notices[0]?.includes('omitted'));assert.match((await t.brain.getRecord('study'))!.segments[0]!.text,/faithful/);
      t.infer=async i=>finish(i);await t.engine.process('study',true,true);assert.equal((await t.notes()).length,1);
    }finally{await t.close();}
  });
  test(`${kind}: source correction rejects delayed output and explicit retry uses current text`,async()=>{
    const t=await setup();try{
      let release!:(v:ThoughtResult)=>void;let captured!:ThoughtInput;
      t.infer=i=>{captured=i;return new Promise(r=>release=r);};await t.add(seg('a','Five grams.'));
      const running=t.engine.process('study',true);while(!release)await new Promise(r=>setTimeout(r,1));
      await t.add(seg('a','Fifteen grams.',2));release(finish(captured));await running;
      assert.equal((await t.notes()).filter(r=>r.thoughtStatus!=='draft').length,0);t.infer=async i=>finish(i);await t.engine.process('study',true,true);
      assert.equal((await t.notes())[0]!.segments[0]!.text,'Fifteen grams.');
    }finally{await t.close();}
  });
  test(`${kind}: finalization waits for background work and retains newly arrived speech`,async()=>{
    const t=await setup();try{
      let release!:(v:ThoughtResult)=>void;let captured!:ThoughtInput;
      t.infer=i=>{if(i.finalize)return Promise.resolve(finish(i));captured=i;return new Promise(r=>release=r);};
      await t.add(seg('a','Same thought begins.'));const running=t.engine.process('study');while(!release)await new Promise(r=>setTimeout(r,1));
      await t.add(seg('b','And now it concludes.'));const ending=t.engine.process('study',true);
      release({groups:[],remainder:spans(captured)});await Promise.all([running,ending]);
      assert.equal((await t.notes()).length,1);assert.equal((await t.notes())[0]!.segments.length,2);
    }finally{await t.close();}
  });
  test(`${kind}: interrupted dispatched work is not retried after restart; manual edits survive correction`,async()=>{
    const t=await setup();try{
      await t.add(seg('a','Original measurement.'));const state=await t.brain.getState<any>('thought-buffer:study');
      await t.brain.setState('thought-buffer:study',{...state,status:'running'});await t.restart();await t.engine.process('study',true);assert.equal(t.calls,0);
      await t.engine.process('study',true,true);const n=(await t.notes())[0]!;
      await t.brain.updateRecord(n.id,n.revision,{title:'My title',summary:'My interpretation',manualFields:['title','summary']});
      await t.add(seg('a','Corrected measurement.',2));
      const saved=await t.brain.getRecord(n.id);assert.equal(saved!.title,'My title');assert.equal(saved!.summary,'My interpretation');assert.equal(saved!.quality,'needs_review');
    }finally{await t.close();}
  });
}
test('coverage validator rejects overlap, reordering and missing title',()=>{
  const i:ThoughtInput={sessionId:'s',segments:[seg('a','123'),seg('b','456')],finalize:true};
  for(const result of [ {...finish(i),groups:[{...finish(i).groups[0]!,spans:spans(i).reverse()}]}, {...finish(i),groups:[{...finish(i).groups[0]!,title:''}]}])assert.throws(()=>validateThoughts(i,result));
});
test('note references use readable titles, disambiguate duplicates and preserve real alphanumeric facts',()=>{
  const a={...newRecord({id:'abc-123-xyz-456-789',kind:'note',createdAt:now()}),title:'Hamstrings'};
  const b={...a,id:'other-address',createdAt:'2026-09-26T12:00:00Z'};
  const lot={...a,id:'AB123',title:'Unrelated imported note'};
  const result=resolveNoteReferences({text:`See ${a.id}. Lot AB123 is five grams.`,spokenText:`${a.id} explains it.`,toolCalls:[],references:[{recordId:'invented',title:'Invalid'}]},[a,b,lot]);
  assert.ok(!result.text.includes(a.id));assert.match(result.text,/AB123/);assert.match(result.spokenText!,/Hamstrings/);assert.equal(result.references!.length,1);assert.match(result.references![0]!.title,/2026/);
});
test('Agent retains requests and assistant attribution without per-turn notes; J6 accepts source-grounded review-needed connections',async()=>{
  const brain=new MemoryBrain();const p=new FixtureProviders();let counter=0;let sources:string[]=[];
  p.summarize=async()=>{throw Error('Thoughts already summarized by consolidation must not be summarized again');};
  p.tag=async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,relevant:undefined,faithful:.2,understandable:1});
  p.connect=async (r,c)=>{assert.equal(r.summary,'');sources=c.map(x=>x.id);return Object.fromEntries(c.map(x=>[x.id,.95]));};
  let other=await brain.createRecord({id:'earlier',kind:'note',createdAt:now()});await brain.updateRecord(other.id,other.revision,{body:'Hamstring muscles extend the hip.'});
  const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:{async speak(){},async stop(){}},id:()=>`id-${++counter}`,now});
  await agent.initialize();await agent.submitText('The hamstring flexes the knee.');await agent.submitText('It also extends the hip.');
  assert.equal((await brain.listRecords()).filter(r=>r.kind==='dictation'&&!r.sourceOnly&&r.thoughtStatus!=='draft').length,0);
  await agent.submitText('Moo, explain that.');await agent.drain();await agent.stopSession();await agent.drain();
  const notes=(await brain.listRecords()).filter(r=>r.kind==='dictation'&&!r.sourceOnly);
  assert.equal(notes.length,1);assert.ok(notes[0]!.segments.some(s=>s.speaker==='assistant'));
  assert.equal(notes[0]!.quality,'needs_review');assert.ok(sources.includes('earlier'));assert.equal(notes[0]!.links.find(l=>l.targetId==='earlier')?.decision,'accepted');
  await brain.close();
});

test('automatic connections reject changed targets and preserve a later dismissal through reprocessing',async()=>{
 const brain=new MemoryBrain(), p=new FixtureProviders();let n=0,change=true;
 let target=await brain.createRecord({id:'target',kind:'note',createdAt:now()});target=(await brain.updateRecord(target.id,target.revision,{body:'Hamstring anatomy.'}))!;
 p.connect=async(_record,candidates)=>{
  if(change){change=false;const current=(await brain.getRecord(target.id))!;await brain.updateRecord(target.id,current.revision,{body:'Hamstring anatomy corrected.'});}
  return Object.fromEntries(candidates.map(c=>[c.id,.96]));
 };
 const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:{async speak(){},async stop(){}},id:()=>`link-${++n}`,now});
 await agent.initialize();const created=await agent.createNote({title:'Hamstring',body:'Hamstring muscles flex the knee.'});await agent.drain();
 let record=(await brain.getRecord(created.id))!;assert.equal(record.connectionStatus,'failed');assert.ok(!record.links.some(l=>l.targetId===target.id));
 await agent.retryPending(record.id);await agent.drain();record=(await brain.getRecord(record.id))!;assert.equal(record.links[0]!.decision,'accepted');
 await agent.editRecord(record.id,record.revision,{links:record.links.map(l=>({...l,decision:'dismissed'}))});
 record=(await brain.getRecord(record.id))!;await agent.editRecord(record.id,record.revision,{body:'Hamstring muscles flex the knee and extend the hip.'});await agent.drain();
 assert.equal((await brain.getRecord(record.id))!.links.find(l=>l.targetId===target.id)!.decision,'dismissed');await brain.close();
});

test('a failed Nano summary does not block a source-grounded connection',async()=>{
 const brain=new MemoryBrain(),p=new FixtureProviders();let n=0;
 let target=await brain.createRecord({id:'target',kind:'note',createdAt:now()});await brain.updateRecord(target.id,target.revision,{body:'Hamstring anatomy.'});
 p.summarize=async()=>{throw Error('summary unavailable')};p.connect=async(_r,c)=>Object.fromEntries(c.map(r=>[r.id,.9]));
 const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:{async speak(){},async stop(){}},id:()=>`failed-${++n}`,now});
 await agent.initialize();const record=await agent.createNote({title:'Hamstring',body:'Hamstring muscles flex the knee.'});await agent.drain();
 const saved=(await brain.getRecord(record.id))!;assert.equal(saved.quality,'pending');assert.equal(saved.connectionStatus,'connected');assert.match(saved.error!,/summary unavailable/);await brain.close();
});

test('staged publication rechecks work context and preserves conversation attachments',async()=>{
 const brain=new MemoryBrain();await brain.createRecord({id:'study',kind:'session',createdAt:now()});
 const source=seg('a','The image shows a hamstring.');await brain.upsertSegment('study',source);
 const conversation={...newRecord({id:'conversation',kind:'conversation',createdAt:now()}),attachmentIds:['image-evidence']};
 let context='Original request and completed screenshot',calls=0;
 const engine=new ThoughtConsolidator({brain,now,emit:()=>{},notice:()=>{},enrich:async()=>{},context:async()=>context,sourceRecords:async()=>[conversation],generation:{summarize:async()=>({title:'',summary:''}),respond:async()=>({text:'',toolCalls:[]}),consolidate:async i=>{calls++;return finish(i);}}});
 await engine.append('study',[source]);
 const input:ThoughtInput={sessionId:'study',segments:[source],context,finalize:true};
 const state=await brain.getState<any>('thought-buffer:study');
 await brain.setState('thought-buffer:study',{...state,status:'running',staged:{input,result:finish(input),spans:spans(input),operation:'synthetic-staged'}});
 context='Screenshot failed; request is unresolved';await engine.recover('study');
 assert.equal(calls,0);assert.equal((await brain.listRecords()).filter(r=>r.kind==='dictation'&&r.thoughtStatus!=='draft').length,0);
 await engine.process('study',true,true);
 const note=(await brain.listRecords()).find(r=>r.kind==='dictation')!;
 assert.deepEqual(note.attachmentIds,['image-evidence']);assert.ok(note.links.some(l=>l.targetId==='conversation'&&l.provenance==='source'));assert.equal(note.sourceContext,context);
 await brain.close();
});

test('a response completed after session stop is consolidated without losing assistant attribution',async()=>{
 const brain=new MemoryBrain(),p=new FixtureProviders();let n=0,release!:(value:any)=>void;
 p.respond=()=>new Promise(r=>release=r);
 const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:{async speak(){},async stop(){}},id:()=>`late-${++n}`,now});
 await agent.initialize();await agent.submitText('Moo, explain hamstring anatomy.');
 while(!release)await new Promise(r=>setTimeout(r,1));
 await agent.stopSession();release({text:'Hamstring muscles flex the knee.',toolCalls:[]});await agent.drain();
 const notes=(await brain.listRecords()).filter(r=>r.kind==='dictation'&&!r.sourceOnly);
 assert.ok(notes.some(r=>r.segments.some(s=>s.speaker==='assistant'&&s.text.includes('flex the knee'))));
 assert.equal(agent.getState().listening,false);await brain.close();
});

test('background organization publishes and connects while Moo is still answering',async()=>{
  const brain=new MemoryBrain(),p=new FixtureProviders();let n=0,release!:(v:any)=>void;
  p.respond=()=>new Promise(r=>release=r);
  p.connect=async(_r,c)=>Object.fromEntries(c.map(note=>[note.id,.95]));
  let prior=await brain.createRecord({id:'earlier-context',kind:'note',createdAt:now()});await brain.updateRecord(prior.id,prior.revision,{title:'Hamstring anatomy',body:'Hamstring muscles flex the knee.'});
  const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:{async speak(){},async stop(){}},id:()=>`busy-${++n}`,now});
  await agent.initialize();await agent.startSession();await agent.submitText('Moo, explain hamstring anatomy.');while(!release)await new Promise(r=>setTimeout(r,1));
  assert.equal(agent.getState().busy,true);await agent.consolidateThoughts();
  let note=(await brain.listRecords()).find(r=>r.thoughtStatus==='growing')!;
  assert.ok(note?.summary,'Summary is published before the answer finishes');const id=note.id;
  for(let i=0;i<30 && (await brain.getRecord(id))?.connectionStatus==='pending';i++)await new Promise(r=>setTimeout(r,1));
  assert.ok((await brain.getRecord(id))!.links.some(l=>l.targetId===prior.id && l.decision==='accepted'));
  release({text:'Hamstrings flex the knee.',toolCalls:[]});await agent.drain();await agent.consolidateThoughts();await agent.drain();
  note=(await brain.getRecord(id))!;assert.ok(note.segments.some(s=>s.speaker==='assistant'));
  assert.equal((await brain.listRecords()).filter(r=>r.thoughtStatus==='growing').length,1);
  await agent.stopSession();await agent.drain();await brain.close();
});
