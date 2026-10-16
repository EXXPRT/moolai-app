import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,ThoughtInput,ThoughtPlan} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';
import {GraphRetrieval} from '../src/graph-retrieval.js';
import {ThoughtConsolidator} from '../src/thoughts.js';
import {validatePlan} from '../src/thought-planning.js';
import {retireFailedThought} from '../src/thought-maintenance.js';
import {inputDigest,rememberEvidence,loadEvidence} from '../src/evidence.js';
import {note,rig,segment,at} from '../../../experiments/agent-closeout/support.js';

for(const storage of ['memory','sqlite']) {
  async function setup(t:any) {
    const dir=await mkdtemp(join(tmpdir(),'moo-graph-'));
    let brain:BrainPort=storage==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    t.after(async()=>{await brain.close();await rm(dir,{recursive:true,force:true});});
    return {get brain(){return brain},async restart(){if(storage==='sqlite'){await brain.close();brain=new SQLiteBrain(dir);}}};
  }
  async function link(brain:BrainPort,a:string,b:string,provenance:any='manual',decision:any='accepted') {
    const r=(await brain.getRecord(a))!;await brain.updateRecord(a,r.revision,{links:[...r.links,{targetId:b,provenance,decision}]});
  }
  test(`${storage}: graph follows accepted current sources with two-hop/cycle/dismissal bounds`,async t=>{
    const s=await setup(t),b=s.brain;
    for(const id of ['seed','bridge','answer','cycle','dismissed','archived','hub','active','suggestion'])await note(b,{id,title:id,text:id==='answer'?'The valve opens at 12 kPa.':id});
    await link(b,'seed','bridge');await link(b,'bridge','answer','correction');await link(b,'bridge','seed');
    await link(b,'seed','dismissed');await link(b,'dismissed','seed','suggested','dismissed');
    await link(b,'seed','archived');await link(b,'seed','hub','source');await link(b,'seed','active');
    await link(b,'seed','suggestion','suggested',undefined);
    const archived=(await b.getRecord('archived'))!;await b.updateRecord(archived.id,archived.revision,{archived:true});
    const g=new GraphRetrieval(b,'active','valve pressure');
    await assert.rejects(g.expand('seed'),/Retrieve/);
    await g.retrieved([{id:'seed'}]);
    // Explicitly unaccepted suggestions are not edges for retrieval.
    const seed=(await b.getRecord('seed'))!;await b.updateRecord(seed.id,seed.revision,{links:seed.links.map(l=>l.targetId==='suggestion'?{targetId:'suggestion',provenance:'suggested'}:l)});
    assert.deepEqual((await g.expand('seed')).map(n=>n.id),['bridge']);
    const second=await g.expand('bridge');assert.deepEqual(second.map(n=>n.id),['answer']);assert.equal(second[0]!.via.hop,2);
    assert.match(second[0]!.original,/12 kPa/);await assert.rejects(g.expand('answer'),/limit/);
    assert.equal(await g.current(),true);
    const answer=(await b.getRecord('answer'))!;await b.updateRecord(answer.id,answer.revision,{body:'Corrected to 9 kPa.'});
    assert.equal(await g.current(),false);await s.restart();assert.equal((await s.brain.getRecord('answer'))!.body,'Corrected to 9 kPa.');
  });
  test(`${storage}: five neighbours maximum; new request cannot expand previous evidence`,async t=>{
    const {brain:b}=await setup(t);await note(b,{id:'seed',title:'Seed',text:'Root'});
    for(let i=0;i<8;i++){await note(b,{id:`n${i}`,title:`Valve ${i}`,text:'pressure'});await link(b,'seed',`n${i}`);}
    const g=new GraphRetrieval(b,'active','pressure');await g.retrieved({id:'seed'});assert.equal((await g.expand('seed')).length,5);
    await assert.rejects(g.expand('seed'),/already/);await assert.rejects(new GraphRetrieval(b,'active','pressure').expand('seed'),/Retrieve/);
  });
  test(`${storage}: a graph passage near the end remains the current retained passage`,async t=>{
    const {brain:b}=await setup(t);await note(b,{id:'seed',title:'Index',text:'See specification.'});
    await note(b,{id:'target',title:'Specification',text:'Background. '.repeat(500)+'The valve limit is 9 kPa.'});await link(b,'seed','target');
    const graph=new GraphRetrieval(b,'active','valve limit');await graph.retrieved({id:'seed'});const output=await graph.expand('seed');
    assert.ok(output[0]!.offset>4000);
    await rememberEvidence(b,'active',{call:{id:'expand',name:'related_notes',arguments:{id:'seed'}},status:'success',result:output,executed:true});
    const retained=await loadEvidence(b,'active');assert.equal(retained.notes[0]!.offset,output[0]!.offset);assert.match(retained.notes[0]!.original,/9 kPa/);
    const r=(await b.getRecord('target'))!;await b.updateRecord(r.id,r.revision,{archived:true});assert.deepEqual((await loadEvidence(b,'active')).notes,[]);
  });
  test(`${storage}: actual Agent exposes graph only when enabled, executes sources and refreshes evidence`,async t=>{
    const {brain:b}=await setup(t);await note(b,{id:'s',title:'Air circuit',text:'The cooling unit uses circuit Delta.'});
    await note(b,{id:'a',title:'Delta limits',text:'Delta uses a 12 kPa valve.'});await link(b,'s','a');
    const f=rig(b);let calls=0;
    f.hooks.generation.respond=async(messages,tools)=>{
      assert.ok(tools.some(t=>t.name==='related_notes'));
      calls++;
      if(calls===1)return {text:'',toolCalls:[{id:'t1',name:'search_notes',arguments:{query:'cooling unit'}}]};
      if(calls===2)return {text:'',toolCalls:[{id:'t2',name:'related_notes',arguments:{id:'s'}}]};
      const expanded=JSON.parse(messages.find(message=>message.toolCallId==='t2')!.content);
      assert.match(expanded.result.notes[0].original,/12 kPa/);
      assert.equal(expanded.result.notes[0].via.id,'s');
      return {text:'Delta limits says 12 kPa.',spokenText:'Delta limits says twelve kilopascals.',toolCalls:[]};
    };
    const agent=new Agent({...f.options,graphRetrieval:true,allowedTools:['search_notes','read_note','related_notes']});
    await agent.startSession();await agent.ingest(segment('request','Moo, find the cooling unit pressure using only my notes.'));await agent.settleTurn('request');await agent.drain();
    assert.equal(calls,3);assert.equal(f.observed.webCalls,0);assert.equal(agent.getState().lastError,undefined);
    const disabled=rig(b,'disabled');disabled.hooks.generation.respond=async(_,tools)=>{assert.ok(!tools.some(t=>t.name==='related_notes'));return {text:'Done.',toolCalls:[]};};
    await disabled.agent.startSession();await disabled.agent.ingest(segment('r2','Moo, hello.'));await disabled.agent.settleTurn('r2');await disabled.agent.drain();
  });
  test(`${storage}: separate plan/write stages preserve growing IDs, edits, exact Unicode and explicit retry`,async t=>{
    const s=await setup(t);await s.brain.createRecord({id:'study',kind:'session',createdAt:at});
    let plans=0,writes=0,fail=false;const sources:string[]=[];
    const generation={planThoughts:async(i:ThoughtInput):Promise<ThoughtPlan>=>{plans++;return {groups:[{spans:i.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}))}],remainder:[],extendsActive:!!i.activeNote,ongoing:!i.finalize};},
      summarize:async(r:any)=>{writes++;if(fail)throw Error('provider unavailable');const text=r.segments.map((s:any)=>s.text).join('');sources.push(text);return {title:'Review',summary:text.slice(-800),topicSuggestions:['Review']};},respond:async()=>({text:'',toolCalls:[]})};
    const make=()=>new ThoughtConsolidator({brain:s.brain,generation,strategy:'plan_then_summarize',now:()=>at,emit:()=>{},notice:()=>{},enrich:async()=>{},context:async()=>''});let engine=make();
    const add=async(id:string,text:string)=>{const v=segment(id,text);await s.brain.upsertSegment('study',v);await engine.append('study',[v]);};
    await add('a','Four points: first 12 kg, corrected to 9 kg. 🦵');await engine.process('study');
    let n=(await s.brain.listRecords()).find(n=>n.kind==='dictation')!;const id=n.id;
    await s.brain.updateRecord(id,n.revision,{title:'My review',manualFields:['title']});
    await add('b',' Second, attribution; third, links; fourth, timing.');fail=true;await engine.process('study');
    assert.equal(plans,2);assert.equal(writes,2);assert.equal((await s.brain.getRecord(id))!.title,'My review');
    await s.restart();engine=make();await engine.recover('study');await engine.process('study');assert.equal(writes,2);
    fail=false;await engine.process('study',true,true);assert.equal(plans,3); // finalize changes the frozen plan input.
    n=(await s.brain.getRecord(id))!;assert.match(n.summary,/9 kg/);assert.match(n.summary,/fourth/);assert.equal(n.title,'My review');assert.equal(n.thoughtStatus,'settled');
    await add('c','New discussion.');fail=true;await engine.process('study');const pc=plans;fail=false;await engine.process('study',false,true);assert.equal(plans,pc); // unchanged explicit retry reuses successful planning.
  });
  test(`${storage}: archival maintenance is restart-safe, retains watermarks and leaves other state alone`,async t=>{
    const s=await setup(t);await s.brain.createRecord({id:'study',kind:'session',createdAt:at});
    await note(s.brain,{id:'failed',title:'Failed growing thought',text:'Original saved source'});await note(s.brain,{id:'other',title:'Other',text:'Untouched'});
    const before=await s.brain.getRecord('other');await s.brain.setState('agent',{conversationId:'open'});
    const buffer={spans:[{segmentId:'a',revision:1,start:0,end:4}],seen:{a:1},lengths:{a:4},published:[],draftId:'failed',status:'failed',error:'output limit'};
    await s.brain.setState('thought-buffer:study',buffer);const n=(await s.brain.getRecord('failed'))!;
    const request={sessionId:'study',noteId:'failed',expectedRevision:n.revision,bufferDigest:await inputDigest(JSON.stringify(buffer))};
    const original=s.brain.setState.bind(s.brain);let crash=true;s.brain.setState=async(k,v)=>{if(k==='thought-buffer:study'&&crash){crash=false;throw Error('crash');}return original(k,v);};
    await assert.rejects(retireFailedThought(s.brain,request),/crash/);s.brain.setState=original;await s.restart();
    await retireFailedThought(s.brain,request);await retireFailedThought(s.brain,request);
    assert.equal((await s.brain.getRecord('failed'))!.archived,true);const next=await s.brain.getState<any>('thought-buffer:study');
    assert.deepEqual(next.spans,[]);assert.deepEqual(next.seen,{a:1});assert.equal(next.error,undefined);
    assert.deepEqual(await s.brain.getRecord('other'),before);assert.deepEqual(await s.brain.getState('agent'),{conversationId:'open'});
    // The original span must not be requeued on restart, but genuinely new speech can grow normally.
    const engine=new ThoughtConsolidator({brain:s.brain,now:()=>at,emit:()=>{},notice:()=>{},context:async()=>'',enrich:async()=>{},
      generation:{summarize:async()=>({title:'Unused',summary:'Unused'}),respond:async()=>({text:'',toolCalls:[]}),
        consolidate:async input=>({groups:[{title:'New discussion',summary:input.segments.map(s=>s.text).join(' '),ongoing:true,
          spans:input.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}))}],remainder:[]})}});
    const old=segment('a','Old.');await s.brain.upsertSegment('study',old);await engine.append('study',[old]);
    assert.deepEqual((await s.brain.getState<any>('thought-buffer:study')).spans,[]);
    const fresh=segment('new','A fresh useful thought.');await s.brain.upsertSegment('study',fresh);await engine.append('study',[fresh]);await engine.process('study');
    const growing=(await s.brain.listRecords()).find(n=>n.thoughtStatus==='growing')!;
    assert.ok(growing);assert.notEqual(growing.id,'failed');assert.equal(growing.summary,'A fresh useful thought.');
    assert.equal((await s.brain.getRecord('failed'))!.archived,true);
  });
}
test('planning rejects missing, reversed, overlapping or impossible coverage and flags',()=>{
  const input:ThoughtInput={sessionId:'s',segments:[segment('a','First. Second.')],finalize:true};
  const base:ThoughtPlan={groups:[{spans:[{segmentId:'a',revision:1,start:0,end:14}]}],remainder:[],extendsActive:false,ongoing:false};
  assert.doesNotThrow(()=>validatePlan(input,base));
  for(const plan of [{...base,extendsActive:true},{...base,ongoing:true},{...base,groups:[]},
    {...base,groups:[{spans:[{segmentId:'a',revision:1,start:1,end:14}]}]},
    {...base,groups:[...base.groups,...base.groups]}])assert.throws(()=>validatePlan(input,plan));
});
