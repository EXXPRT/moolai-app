import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,RouteInput} from '../../contracts/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import {Agent} from '../src/index.js';

// Step 11: storage and provider failures are readable and never crash, skip a turn or re-send paid work.
// Production configuration: growing notes on (FixtureProviders provides consolidate).
const now=()=> '2026-10-19T12:00:00Z';
type Fault=(method:string,args:unknown[])=>boolean;
/** Throws once (or every time) for the writes a rule selects; everything else passes through. */
function faulty(brain:BrainPort,rules:{fault:Fault;once?:boolean}[]) {
  const hits=new Set<number>();
  return new Proxy(brain,{get(target,key,receiver){
    const value=Reflect.get(target,key,receiver);
    if(typeof value!=='function')return value;
    return (...args:unknown[])=>{
      for(const [index,rule] of rules.entries()) if(!(rule.once && hits.has(index)) && rule.fault(String(key),args)) {
        hits.add(index);return Promise.reject(Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'}));
      }
      return value.apply(target,args);
    };
  }});
}
for(const kind of ['memory','sqlite'] as const) {
  async function rig(rules:{fault:Fault;once?:boolean}[]=[]) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-failures-'));
    const real:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const brain=faulty(real,rules);
    const p=new FixtureProviders();let n=0;const spoken:string[]=[];const routes:RouteInput[]=[];const organized:unknown[]=[];
    const route=p.route.bind(p);p.route=async input=>{routes.push(input);return route(input);};
    const consolidate=p.consolidate.bind(p);p.consolidate=async input=>{organized.push(input);return consolidate(input);};
    const agent=new Agent({brain,decisions:p,generation:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
      speech:{async speak(text){spoken.push(text);},async stop(){}},id:()=>`${kind}-${++n}`,now});
    await agent.initialize();await agent.startSession();
    return {real,agent,p,spoken,routes,organized,
      async close(){await agent.stopSession().catch(()=>{});await agent.drain();await real.close();await rm(dir,{recursive:true,force:true});}};
  }
  const run=(name:string,body:(t:Awaited<ReturnType<typeof rig>>)=>Promise<void>,rules?:{fault:Fault;once?:boolean}[])=>
    test(`${kind}: ${name}`,{timeout:10000},async()=>{const t=await rig(rules);try{await body(t);}finally{await t.close();}});

  run('a failed write after an answer is shown never reports that answer as failed',async t=>{
    await t.agent.submitText('Moo, explain glycolysis.');await t.agent.drain();
    assert.equal(t.agent.getState().lastError,undefined);
    const conversation=(await t.real.getRecord(t.agent.getState().conversationId!))!;
    assert.ok(conversation.segments.some(s=>s.speaker==='assistant'&&/Fixture response/.test(s.text)),'The answer is in the conversation');
    assert.doesNotMatch(String(await t.real.getState(`work-status:${conversation.id}`)),/Unresolved/);
    assert.ok(!t.spoken.some(s=>/couldn't finish that answer/.test(s)));
  },[{once:true,fault:(m,a)=>m==='setState'&&String(a[0]).startsWith('work-status:')&&String(a[1]).startsWith('Response run finished')}]);

  run('an answer that fails before it is shown is said aloud and the request is kept',async t=>{
    t.p.respond=async()=>{throw Error('Backend 502: incomplete output');};
    await t.agent.submitText('Moo, explain glycolysis.');await t.agent.drain();
    assert.match(t.agent.getState().lastError!,/502/);
    assert.ok(t.spoken.includes("I couldn't finish that answer. Your request is saved; ask again when you're ready."));
  });

  run('typed input that was saved but not acted on says it was saved',async t=>{
    t.p.route=async()=>{throw Error('Backend 503: TypeSafe is not configured');};
    await assert.rejects(t.agent.submitText('Glycolysis makes two ATP.'),/^Error: Saved; Moo couldn't act on it/);
    const session=(await t.real.getRecord(t.agent.getState().sessionId!))!;
    assert.ok(session.segments.some(s=>s.text==='Glycolysis makes two ATP.'),'The text is saved');
  });

  run('a failed error-path write cannot skip the next turn',async t=>{
    let failRoute=true;const route=t.p.route.bind(t.p);
    t.p.route=async input=>{if(failRoute){failRoute=false;throw Error('Backend 502');}return route(input);};
    await assert.rejects(t.agent.submitText('First thought.'));
    await t.agent.submitText('Second thought.');await t.agent.drain();
    assert.ok(t.routes.some(r=>r.text==='Second thought.'),'The next turn is routed');
  },[{once:true,fault:(m,a)=>m==='setState'&&a[0]==='agent'&&/Backend 502/.test(JSON.stringify(a[1]))}]);

  run('trace write failures never drop a routed dictation',async t=>{
    await t.agent.submitText('The Krebs cycle runs in the mitochondria.');await t.agent.drain();
    await t.agent.consolidateThoughts(true);await t.agent.drain();
    const notes=(await t.real.listRecords()).filter(r=>r.kind==='dictation'&&!r.sourceOnly);
    assert.ok(notes.some(r=>r.segments.some(s=>/Krebs/.test(s.text))),'The dictation reached the growing note');
  },[{fault:(m,a)=>m==='setState'&&a[0]==='interaction-trace'}]);

  run('Retry sends an interrupted organization once, without a restart',async t=>{
    await t.agent.submitText('Enzymes lower activation energy.');await t.agent.drain();
    const sessionId=t.agent.getState().sessionId!;
    const buffer=(await t.real.getState<any>(`thought-buffer:${sessionId}`))!;
    await t.real.setState(`thought-buffer:${sessionId}`,{...buffer,status:'running'});
    await t.agent.retrySummary(sessionId);await t.agent.drain();
    assert.equal(t.organized.length,1,'Exactly one organizer call');
  });

  run('an interrupted summary shows its error and accepts Retry on the next pass',async t=>{
    const record=await t.real.createRecord({id:'stuck',kind:'note',createdAt:now()});
    await t.real.updateRecord('stuck',record.revision,{title:'Stuck',body:'A note whose summary was interrupted.'});
    await t.real.putOperation({id:'enrich:stuck:1',kind:'enrich',recordId:'stuck',sourceRevision:1,status:'running',attempts:1});
    await t.agent.consolidateThoughts();
    assert.match((await t.real.getRecord('stuck'))!.error!,/Interrupted summary requires explicit retry/,'The note shows a Retry');
    await t.agent.retrySummary('stuck');await t.agent.drain();
  });

  run('J1 context is bounded by the JSON length the backend measures',async t=>{
    const paste='"quoted\\path"\n'.repeat(4000);
    for(let i=0;i<3;i++){await t.agent.submitText(`Note ${i}: ${paste}`);await t.agent.drain();}
    for(const input of t.routes) {
      const state=JSON.stringify({activeConversation:input.activeConversation,pendingOffer:input.pendingOffer,recentContext:input.recentContext,latestUserUtterance:input.text});
      assert.ok(state.length<=180_000,`J1 state is ${state.length} characters`);
    }
    assert.ok(/characters of earlier context omitted/.test(t.routes.at(-1)!.recentContext),'The oversized context is cut with a marker');
    const short=t.routes[0]!;
    assert.doesNotMatch(short.recentContext,/omitted/,'A context under the limit is unchanged');
  });
}
