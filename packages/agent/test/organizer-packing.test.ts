import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {AgentReply,BrainPort,Segment,SourceSpan,ThoughtInput,ThoughtResult} from '../../contracts/src/index.js';
import {ThoughtConsolidator} from '../src/thoughts.js';
import {thoughtContext} from '../src/thought-context.js';
import {ORGANIZER_REQUEST,SUMMARY_OMISSION,organizerRequestBytes} from '../src/organizer-budget.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

// Blocker 2: organizer requests are packed to the backend's 32,000-byte bound, and Retry can make progress.
const now=()=> '2026-10-16T12:00:00Z';
const seg=(id:string,text:string,speaker:Segment['speaker']='user'):Segment=>({id,turnId:id,revision:1,text,speaker,final:true,createdAt:now()});
const spans=(input:ThoughtInput):SourceSpan[]=>input.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}));
const continuing=(input:ThoughtInput):ThoughtResult=>({groups:[{title:'One continuing topic',summary:'A faithful bounded summary.',spans:spans(input),
  continuesActive:!!input.activeNote,ongoing:!input.finalize,topicSuggestions:[]}],remainder:[]});
const tooLarge=()=>Object.assign(Error('Backend 413: Generation request is 33,390 bytes, over its 32,000-byte limit; source remains saved locally'),{status:413});
// About 8 minutes of same-topic speech with numbers, quotes and non-ASCII text.
const backlog=(n:number)=>Array.from({length:n},(_,i)=>seg(`s${i}`,`Point ${i}: the “Krebs” cycle — ATP ${i*2} µmol, NADH ${i*3}; Renée’s notes say it is not yet confirmed. `.repeat(6)));

for(const kind of ['memory','sqlite']) {
  async function setup(options:{context?:(segments:Segment[])=>Promise<string>}={}) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-pack-'));
    let brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    await brain.createRecord({id:'study',kind:'session',createdAt:now()});
    const inputs:ThoughtInput[]=[];const refused:number[]=[];
    let infer=async(input:ThoughtInput):Promise<ThoughtResult>=>continuing(input);
    const engine=new ThoughtConsolidator({brain,now,emit:()=>{},notice:()=>{},enrich:async()=>{},context:options.context ?? (async()=>''),
      generation:{summarize:async()=>{throw Error('unused')},respond:async()=>{throw Error('unused')},
        consolidate:async input=>{
          const bytes=organizerRequestBytes(input);
          if(bytes>ORGANIZER_REQUEST.bytes){refused.push(bytes);throw tooLarge();}
          inputs.push(structuredClone(input));return infer(input);
        }}});
    return {get brain(){return brain},engine,inputs,refused,set infer(fn:typeof infer){infer=fn},
      async add(s:Segment){await brain.upsertSegment('study',s);await engine.append('study',[s]);},
      async state(){return (await brain.getState<{spans:SourceSpan[];status?:string;error?:string}>('thought-buffer:study'))!;},
      async close(){await brain.close();await rm(dir,{recursive:true,force:true});}};
  }

  test(`${kind}: a long same-topic backlog organizes under the byte bound without a refused request`,async()=>{
    const t=await setup();try{
      for(const s of backlog(40)) await t.add(s);
      for(let i=0;i<12 && (await t.state()).spans.length;i++) await t.engine.process('study');
      assert.deepEqual((await t.state()).spans,[]);
      assert.equal((await t.state()).status,undefined);
      assert.deepEqual(t.refused,[],'Packing never sends a request the backend would refuse');
      assert.ok(t.inputs.length>1 && t.inputs.every(i=>organizerRequestBytes(i)<=ORGANIZER_REQUEST.bytes));
    }finally{await t.close();}
  });

  test(`${kind}: a backend 413 is repacked smaller in the same pass, with no extra provider call`,async()=>{
    const t=await setup();let refuseNext=false;
    try{
      // A large active note first, so the next request is near the bound.
      for(const s of backlog(20)) await t.add(s);
      await t.engine.process('study');await t.engine.process('study');
      for(const s of backlog(20).map(s=>({...s,id:`n-${s.id}`,turnId:`n-${s.id}`}))) await t.add(s);
      refuseNext=true;const before=t.inputs.length;
      t.infer=async input=>{if(refuseNext){refuseNext=false;throw Object.assign(Error('Backend 413: Generation request is 40,000 bytes, over its 32,000-byte limit; source remains saved locally'),{status:413});}return continuing(input);};
      await t.engine.process('study');
      assert.equal((await t.state()).status,undefined,'The pass succeeds after repacking');
      const [refused,sent]=t.inputs.slice(before);
      assert.ok(refused && sent && t.inputs.length===before+2,'One refused request, then one smaller request');
      assert.ok(organizerRequestBytes(sent)<=organizerRequestBytes(refused)-8000,'Repacked by the reported overshoot');
      assert.ok((await t.brain.listOperations()).some(op=>op.error?.includes('Refused before dispatch')));
    }finally{await t.close();}
  });

  for(const status of [422,502,504]) test(`${kind}: a ${status} makes exactly one call and waits for an explicit Retry`,async()=>{
    const t=await setup();
    t.infer=async()=>{throw Object.assign(Error(`Backend ${status}: failed`),{status});};
    try{
      for(const s of backlog(3)) await t.add(s);
      await t.engine.process('study');await t.engine.process('study');await t.engine.process('study',true);
      assert.equal(t.inputs.length,1);assert.equal((await t.state()).status,'failed');
    }finally{await t.close();}
  });

  test(`${kind}: a buffer already failed by a refused request recovers with one explicit Retry`,async()=>{
    const t=await setup();
    try{
      // A large active note, then more speech: the old controller built a request over the bound and failed on 413.
      for(const s of backlog(20)) await t.add(s);
      await t.engine.process('study');await t.engine.process('study');
      for(const s of backlog(20).map(s=>({...s,id:`w-${s.id}`,turnId:`w-${s.id}`}))) await t.add(s);
      t.inputs.length=0;
      // As left by the old controller: failed after a 413 with an identical request.
      const state=await t.state();
      await t.brain.setState('thought-buffer:study',{...state,status:'failed',error:'Error: Backend 413: Generation request exceeds its 32,000-byte limit'});
      await t.engine.process('study');await t.engine.process('study',true);
      assert.equal(t.inputs.length,0,'Background passes and finalize leave a failed buffer alone');
      await t.engine.process('study',false,true);
      assert.equal(t.inputs.length,1,'One explicit Retry makes one call');
      assert.notEqual((await t.state()).status,'failed');
    }finally{await t.close();}
  });

  test(`${kind}: a turn with heavy linked context at position 20 does not block the turns before it`,async()=>{
    const heavy='x'.repeat(40000);
    const t=await setup({context:async segments=>segments.some(s=>s.id==='s19') ? heavy : ''});
    try{
      for(const s of backlog(24).map(s=>({...s,text:s.text.slice(0,200)}))) await t.add(s);
      await t.engine.process('study');
      assert.notEqual((await t.state()).status,'failed');
      assert.ok(t.inputs.length===1 && !t.inputs[0]!.segments.some(s=>s.id==='s19'),'The prefix before the heavy turn is organized');
    }finally{await t.close();}
  });

  test(`${kind}: a cut never leaves only whitespace pending`,async()=>{
    const t=await setup();
    try{
      await t.add(seg('a','word '.repeat(1599)+'Done.\n\n\n'));
      await t.engine.process('study');
      const rest=(await t.state()).spans;
      assert.ok(rest.every(span=>span.end-span.start>3),'No whitespace-only remainder');
    }finally{await t.close();}
  });

  test(`${kind}: a 9,000-character manual summary on the active note does not block organization`,async()=>{
    const t=await setup();
    try{
      await t.add(seg('a','The first idea about enzymes.'));await t.engine.process('study');
      const note=(await t.brain.listRecords()).find(r=>r.kind==='dictation')!;
      const manual='My own summary. '.repeat(570);assert.ok(manual.length>9000);
      await t.brain.updateRecord(note.id,note.revision,{summary:manual,manualFields:['summary']});
      await t.add(seg('b','A second idea about enzymes.'));await t.engine.process('study');
      assert.notEqual((await t.state()).status,'failed');
      const sent=t.inputs.at(-1)!.activeNote!.summary;
      assert.ok(sent.length<=ORGANIZER_REQUEST.summaryEchoChars && sent.endsWith(SUMMARY_OMISSION));
      assert.equal((await t.brain.getRecord(note.id))!.summary,manual,'The manual summary itself is unchanged');
    }finally{await t.close();}
  });
}

test('the linked original request is sent as a bounded head and tail',async()=>{
  const brain=new MemoryBrain();
  try{
    const original=await brain.createRecord({id:'note',kind:'dictation',createdAt:'2026-10-16T11:00:00Z'});
    await brain.upsertSegment('note',{...seg('n','Growing note text. '.repeat(1500)),createdAt:'2026-10-16T11:00:00Z'});
    const conversation=await brain.createRecord({id:'help',kind:'conversation',createdAt:now()});
    await brain.updateRecord('help',conversation.revision,{links:[{targetId:original.id,provenance:'reply'}]});
    await brain.setState('turn-record:q','help');
    const context=JSON.parse(await thoughtContext(brain,[seg('q','Why does that happen?')]));
    const source=context[0].requests[0].source as string;
    assert.ok(source.length<4200,`linked request is bounded (${source.length})`);
    assert.match(source,/middle omitted/);
  }finally{await brain.close();}
});

test('fixture organization keeps its own summary within the echo bound',async()=>{
  const p=new FixtureProviders();let summary='';
  for(let i=0;i<40;i++) {
    const result=await p.consolidate({sessionId:'s',incremental:true,finalize:false,context:'',segments:[seg(`f${i}`,`Line ${i}: `+'detail '.repeat(30))],
      ...(summary?{activeNote:{id:'n',title:'t',summary,sourceRevision:i,sourceExcerpt:'',sourceTruncated:false}}:{})});
    summary=result.groups[0]!.summary;
  }
  assert.ok(summary.length<=ORGANIZER_REQUEST.summaryEchoChars);
  assert.ok(!summary.includes(SUMMARY_OMISSION.trim()));
  assert.match(summary,/Line 39/);
});

for(const kind of ['memory','sqlite']) test(`${kind}: tool outcomes recorded while Moo answers do not discard organization (BGN-02)`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moolai-answering-'));
  const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
  const p=new FixtureProviders();let n=0,release:((r:AgentReply)=>void)|undefined;
  const organized:string[][]=[];
  const consolidate=p.consolidate.bind(p);
  p.consolidate=async input=>{organized.push(input.segments.map(s=>s.text));return consolidate(input);};
  p.respond=async()=>{if(!release) return await new Promise<AgentReply>(r=>release=r);return {text:'Done.',toolCalls:[]};};
  const agent=new Agent({brain,decisions:p,generation:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
    speech:{async speak(){},async stop(){}},id:()=>`b-${++n}`,now});
  try{
    await agent.initialize();await agent.startSession();
    await agent.submitText('The enzyme works best at 37 degrees.');
    await agent.submitText('Moo, explain enzyme denaturation.');
    while(!release) await new Promise(r=>setTimeout(r,1));
    // The answer is still running here, so wait for the organizer pass only, not for every tracked task.
    await agent.consolidateThoughts();
    const session=agent.getState().sessionId!;
    const during=await brain.getState<{status?:string}>(`thought-buffer:${session}`);
    assert.notEqual(during?.status,'failed');
    assert.ok(!organized.flat().some(t=>/denaturation/.test(t)),'The running request is left pending');
    release({text:'Enzymes lose their shape when heated.',toolCalls:[]});await agent.drain();
    await agent.consolidateThoughts();await agent.drain();
    assert.ok(organized.flat().some(t=>/denaturation/.test(t)),'It is organized once the answer finishes');
    assert.notEqual((await brain.getState<{status?:string}>(`thought-buffer:${session}`))?.status,'failed');
  }finally{release?.({text:'',toolCalls:[]});await agent.stopSession();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}
});
