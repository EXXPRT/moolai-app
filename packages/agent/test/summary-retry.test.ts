import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/index.js";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";
import type { BrainPort, BrainRecord, Summary, PendingOperation } from "../../contracts/src/index.js";

const now = () => "2026-09-28T00:00:00Z";
for (const storage of ["memory", "sqlite"]) {
  test(`${storage}: a corrected summary retry keeps its narrow intent when undispatched work resumes after restart`, async () => {
    const directory=await mkdtemp(join(tmpdir(),"moolai-retry-recovery-"));
    let brain:BrainPort=storage==="memory"?new MemoryBrain():new SQLiteBrain(directory);
    const p=new FixtureProviders(), effects:string[]=[];
    let calls=0,release!:(value:Summary)=>void,reachedPending!:()=>void;
    const pendingSaved=new Promise<void>(resolve=>reachedPending=resolve);
    const make=()=>new Agent({brain,id:()=>"unused",now,decisions:{
      route:async()=>{effects.push("route");return {route:"start_agent",confidence:1};},
      tag:async()=>({purpose:"Question",purposeConfidence:1,topics:{},doubt:1,faithful:1,understandable:1}),
      connect:p.connect.bind(p)},generation:{
      summarize:async record=>{calls++;return calls===1?new Promise(resolve=>release=resolve):{title:"Current question",summary:record.body!};},
      respond:async()=>{effects.push("response");return {text:"",toolCalls:[]};}},
      search:p,vision:p,capture:{capture:async()=>{effects.push("capture");throw Error("unused");}},
      speech:{speak:async()=>{effects.push("speech");},stop:async()=>{}},
      acceptance:{accept:async record=>{effects.push("accept");return {revision:record.revision};}},
    });
    try{
      let note=await brain.createRecord({id:"question",kind:"dictation",createdAt:now()});
      note=(await brain.updateRecord(note.id,note.revision,{body:"Why does the original mechanism work?",error:"Backend 502: incomplete output"}))!;
      await brain.putOperation({id:"original-retry",kind:"enrich",recordId:note.id,sourceRevision:note.sourceRevision,status:"failed",attempts:1});
      const original=make();await original.initialize();await original.retrySummary(note.id);
      while(!release)await new Promise(resolve=>setImmediate(resolve));
      const during=(await brain.getRecord(note.id))!;
      await brain.updateRecord(note.id,during.revision,{body:"Why does the corrected mechanism work?"});
      const persist=brain.putOperation.bind(brain);
      brain.putOperation=async(op:PendingOperation)=>{
        await persist(op);
        if(op.kind==="enrich"&&op.status==="pending"){
          reachedPending();
          // Simulate process death after durable enqueue, before dispatch. This old process never resumes.
          await new Promise<void>(()=>{});
        }
      };
      release({title:"Old result",summary:"Old explanation"});await pendingSaved;
      brain.putOperation=persist;
      if(storage==="sqlite"){await brain.close();brain=new SQLiteBrain(directory);}
      const restarted=make();await restarted.initialize();await restarted.drain();
      assert.equal(calls,2,"one stale request plus the previously undispatched corrected request");
      const saved=(await brain.getRecord(note.id))!;
      assert.equal(saved.summary,"Why does the corrected mechanism work?");assert.equal(saved.error,undefined);
      assert.equal(saved.doubt,true);assert.equal(restarted.getState().pendingOffer,undefined);
      assert.deepEqual(effects,[],"recovery must not widen a summary action into conversation or acceptance work");
    }finally{await brain.close();await rm(directory,{recursive:true,force:true});}
  });

  test(`${storage}: dispatched scoped retries remain failed after restart until explicit retry`,async()=>{
    const directory=await mkdtemp(join(tmpdir(),"moolai-interrupted-retry-"));
    let brain:BrainPort=storage==="memory"?new MemoryBrain():new SQLiteBrain(directory);
    let calls=0,reached!:()=>void;
    const called=new Promise<void>(resolve=>reached=resolve);
    const p=new FixtureProviders();
    const make=()=>new Agent({brain,id:()=>"unused",now,generation:{
      summarize:async()=>{calls++;reached();return new Promise<Summary>(()=>{});},respond:p.respond.bind(p)},
      decisions:p,vision:p,search:p,capture:{capture:async()=>{throw Error("unused");}},speech:{speak:async()=>{},stop:async()=>{}},
    });
    try{
      let note=await brain.createRecord({id:"retained",kind:"note",createdAt:now()});
      note=(await brain.updateRecord(note.id,note.revision,{body:"This source must survive an interrupted retry.",error:"Backend 502"}))!;
      await brain.putOperation({id:"interrupted-retry",kind:"enrich",recordId:note.id,sourceRevision:note.sourceRevision,status:"failed",attempts:1});
      const original=make();await original.initialize();await original.retrySummary(note.id);await called;
      if(storage==="sqlite"){await brain.close();brain=new SQLiteBrain(directory);}
      const restarted=make();await restarted.initialize();await restarted.drain();
      assert.equal(calls,1,"restart cannot re-dispatch an ambiguously completed paid call");
      assert.equal((await brain.listOperations()).find(op=>op.id==="interrupted-retry")!.status,"failed");
      assert.equal((await brain.getRecord(note.id))!.body,note.body);
      assert.match((await brain.getRecord(note.id))!.error!,/explicit retry/);
    }finally{await brain.close();await rm(directory,{recursive:true,force:true});}
  });

  test(`${storage}: summary retry preserves old 502 until success and never replays routes, acceptance or tools`, async () => {
    const directory = await mkdtemp(join(tmpdir(),"moolai-summary-retry-"));
    const brain: BrainPort = storage === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
    const fixture = new FixtureProviders();
    let counter=0, summaries=0, fail=true;
    let release: (()=>void) | undefined;
    const effects: string[]=[];
    const agent = new Agent({brain,id:()=>`retry-${++counter}`,now,
      decisions:{route:async()=>{effects.push("route");return {route:"start_agent",confidence:1};},
        tag:async()=>({purpose:"Question",purposeConfidence:1,topics:{},doubt:1,faithful:1,understandable:1}),
        connect:fixture.connect.bind(fixture)},
      generation:{summarize:async(record:BrainRecord):Promise<Summary>=>{
        summaries++;
        if(release===undefined && summaries===3) await new Promise<void>(resolve=>release=resolve);
        if(fail)throw new Error("Backend 502: incomplete output");
        return {title:"Model title",summary:record.body ?? "Retained source"};
      },respond:async()=>{effects.push("response");return {text:"",toolCalls:[]};}},
      search:{search:async()=>{effects.push("web");return [];},extract:async()=>{effects.push("web-extract");return [];}},
      vision:fixture,capture:{capture:async()=>{effects.push("capture");throw Error("unused");}},
      speech:{speak:async()=>{effects.push("speech");},stop:async()=>{}},
      acceptance:{accept:async r=>{effects.push("accept");return {revision:r.revision};}},
    });
    try {
      await agent.initialize();
      let note=await brain.createRecord({id:"saved-question",kind:"dictation",createdAt:now()});
      note=await brain.upsertSegment(note.id,{id:"original",turnId:"old-start",revision:1,text:"Moo, explain how hamstrings flex the knee.",speaker:"user",final:true,createdAt:now()});
      note=(await brain.updateRecord(note.id,note.revision,{title:"My original title",body:"Why do hamstrings flex the knee?",manualFields:["title"]}))!;
      await agent.queueEnrichment(note.id);
      await agent.drain();
      const failed=(await brain.getRecord(note.id))!;
      assert.match(failed.error!,/502/);assert.equal(failed.summary,"");
      for(const kind of ["route","accept"] as const)
        await brain.putOperation({id:`old-${kind}`,kind,recordId:note.id,sourceRevision:failed.sourceRevision,status:"failed",attempts:1,turnId:"old-start"});
      await brain.setState("route-context:old-route",{conversationId:null,pendingOffer:null});
      await brain.setState("accept-payload:old-accept",failed);
      effects.length=0;
      await agent.retrySummary(note.id);await agent.drain();
      assert.equal(summaries,2);assert.match((await brain.getRecord(note.id))!.error!,/502/);
      fail=false;
      await agent.retrySummary(note.id);
      while(!release)await new Promise(resolve=>setImmediate(resolve));
      assert.match((await brain.getRecord(note.id))!.error!,/502/,"keep failure visible until successful processing");
      release();await agent.drain();
      const saved=(await brain.getRecord(note.id))!;
      assert.equal(saved.error,undefined);assert.equal(saved.summary,failed.body);
      assert.equal(saved.title,"My original title");assert.equal(saved.body,failed.body);
      assert.equal(saved.quality,"ready");assert.equal(saved.doubt,true);
      assert.equal(agent.getState().pendingOffer,undefined,"retried doubt does not open a new conversation or offer");
      assert.deepEqual(effects,[]);
      for(const kind of ["route","accept"])
        assert.equal((await brain.listOperations()).find(op=>op.id===`old-${kind}`)!.status,"failed");
      assert.equal(summaries,3);await agent.drain();assert.equal(summaries,3,"no automatic retries");
    } finally { await brain.close();await rm(directory,{recursive:true,force:true}); }
  });
}

test("summary retry can resume a failed thought buffer without rerouting its retained request",async()=>{
  const brain=new MemoryBrain(),p=new FixtureProviders();
  const consolidate=p.consolidate.bind(p);let failed=true,calls=0,routes=0,n=0;
  p.consolidate=async input=>{calls++;if(failed)throw Error("Backend 502: incomplete output");return consolidate(input);};
  const route=p.route.bind(p);p.route=async input=>{routes++;return route(input);};
  const agent=new Agent({brain,generation:p,decisions:p,vision:p,search:p,
    capture:{capture:async()=>{throw Error("unused");}},speech:{speak:async()=>{},stop:async()=>{}},
    id:()=>`thought-retry-${++n}`,now});
  try{
    await agent.initialize();await agent.submitText("My saved thought about the hamstring.");await agent.drain();
    await agent.stopSession();await agent.drain();
    const id=agent.getState().sessionId!,previousRoutes=routes;
    assert.equal(calls,1);assert.match((await brain.getRecord(id))!.error!,/502/);
    failed=false;await agent.retrySummary(id);await agent.drain();
    assert.equal(calls,2);assert.equal(routes,previousRoutes);
    assert.equal((await brain.getRecord(id))!.error,undefined);
    const notes=(await brain.listRecords()).filter(r=>r.kind==="dictation"&&!r.sourceOnly);
    assert.equal(notes.length,1);assert.match(notes[0]!.summary,/My saved thought/);
  }finally{await brain.close();}
});
