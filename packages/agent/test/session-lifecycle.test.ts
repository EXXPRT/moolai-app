import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {AcceptancePort,BrainPort,ThoughtInput,ThoughtResult} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';
import {BackendProviders,FixtureProviders} from '../../agent-host/src/providers.js';

// Blocker 1: a study session runs from Start to Stop; restart also ends it. Production hosts run with growing notes on.
const now=()=> '2026-10-16T12:00:00Z';
for(const kind of ['memory','sqlite']) {
  async function rig(options:{acceptance?:AcceptancePort}={}) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-sessions-'));
    let brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let n=0;const organized:ThoughtInput[]=[];
    let hold:Promise<void>|undefined,failWith:Error|undefined;
    const consolidate=p.consolidate.bind(p);
    p.consolidate=async(input):Promise<ThoughtResult>=>{organized.push(input);if(hold)await hold;if(failWith)throw failWith;return consolidate(input);};
    const make=()=>new Agent({brain,decisions:p,generation:p,search:p,vision:p,acceptance:options.acceptance,
      capture:{async capture(){throw Error('unused')}},speech:{async speak(){},async stop(){}},id:()=>`${kind}-${++n}`,now});
    let agent=make();await agent.initialize();
    const sessions=async()=>(await brain.listRecords()).filter(r=>r.kind==='session').map(r=>r.id);
    const buffer=async(id:string)=>await brain.getState<{spans:unknown[];status?:string;error?:string}>(`thought-buffer:${id}`);
    return {get brain(){return brain},get agent(){return agent},organized,sessions,buffer,
      hold(){let release!:()=>void;hold=new Promise<void>(r=>release=r);return ()=>{hold=undefined;release();};},
      fail(error?:Error){failWith=error;},
      /** New calls run normally; a call already held (the crashed one) never completes. */
      unhold(){hold=undefined;},
      /** A crash: the old Agent is abandoned mid-work and a new one starts on the same store. */
      async restart(){if(kind==='sqlite'){await brain.close();brain=new SQLiteBrain(dir);}agent=make();await agent.initialize();},
      async close(){hold=undefined;failWith=undefined;await agent.stopSession();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
  }

  test(`${kind}: Start after Stop opens a new session; the stopped one stays visible until then`,async()=>{
    const t=await rig();try{
      await t.agent.startSession();const first=t.agent.getState().sessionId!;
      await t.agent.submitText('Monday: glycolysis makes two ATP.');await t.agent.drain();
      await t.agent.stopSession();await t.agent.drain();
      assert.equal(t.agent.getState().sessionId,first,'Stop keeps the stopped session');
      await t.agent.startSession();const second=t.agent.getState().sessionId!;
      assert.notEqual(second,first);
      await t.agent.submitText('Tuesday: the Krebs cycle.');await t.agent.drain();
      assert.ok(!(await t.brain.getRecord(first))!.segments.some(s=>/Tuesday/.test(s.text)),'New speech lands in the new session');
    }finally{await t.close();}
  });

  test(`${kind}: Stop returns while organization is still running`,async()=>{
    const t=await rig();try{
      await t.agent.startSession();await t.agent.submitText('A long dictated thought about enzymes.');await t.agent.drain();
      const release=t.hold();
      const stopped=await Promise.race([t.agent.stopSession().then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))]);
      assert.equal(stopped,true,'Stop does not wait for the organizer call');
      assert.equal(t.agent.getState().listening,false);
      release();await t.agent.drain();
      assert.equal((await t.buffer(t.agent.getState().sessionId!))?.spans.length,0,'The background close-out finishes');
    }finally{await t.close();}
  });

  test(`${kind}: Start while listening never rotates, and a double Start rotates once`,async()=>{
    const t=await rig();try{
      await t.agent.startSession();const first=t.agent.getState().sessionId;
      await t.agent.startSession();assert.equal(t.agent.getState().sessionId,first);
      await t.agent.stopSession();await t.agent.drain();
      await Promise.all([t.agent.startSession(),t.agent.startSession()]);
      assert.equal((await t.sessions()).length,2,'One new session, not two');
    }finally{await t.close();}
  });

  test(`${kind}: an organizer dead end stays in its own session`,async()=>{
    const t=await rig();try{
      await t.agent.startSession();const first=t.agent.getState().sessionId!;
      t.fail(Object.assign(Error('Backend 422: Invalid thought organization'),{status:422}));
      await t.agent.submitText('A thought the organizer cannot handle.');await t.agent.drain();
      await t.agent.consolidateThoughts();await t.agent.drain();
      assert.equal((await t.buffer(first))?.status,'failed');
      t.fail(undefined);
      await t.agent.stopSession();await t.agent.drain();await t.agent.startSession();
      await t.agent.submitText('A fresh thought in the next session.');await t.agent.drain();
      await t.agent.consolidateThoughts();await t.agent.drain();
      const second=t.agent.getState().sessionId!;assert.notEqual(second,first);
      assert.notEqual((await t.buffer(second))?.status,'failed','The next session organizes normally');
    }finally{await t.close();}
  });

  test(`${kind}: after a restart without Stop, Start closes out the unstopped session`,async()=>{
    const t=await rig();try{
      await t.agent.startSession();const first=t.agent.getState().sessionId!;
      await t.agent.submitText('Speech from before the restart.');await t.agent.drain();
      await t.restart();await t.agent.startSession();await t.agent.drain();
      assert.notEqual(t.agent.getState().sessionId,first);
      assert.equal((await t.buffer(first))?.spans.length,0,'The previous session was organized and finalized');
      assert.ok((await t.brain.listRecords()).some(r=>r.kind==='dictation' && r.thoughtStatus==='settled'));
    }finally{await t.close();}
  });

  test(`${kind}: a crash during the background close-out leaves a note that Retry can organize`,async()=>{
    const t=await rig();try{
      await t.agent.startSession();const first=t.agent.getState().sessionId!;
      await t.agent.submitText('Speech organized while the app crashes.');await t.agent.drain();
      t.hold();await t.agent.stopSession();
      for(let i=0;i<100 && (await t.buffer(first))?.status!=='running';i++) await new Promise(r=>setTimeout(r,2));
      assert.equal((await t.buffer(first))?.status,'running','The close-out call is in flight');
      const calls=t.organized.length;
      await t.restart();t.unhold();await t.agent.drain();
      assert.equal((await t.buffer(first))?.status,'failed','Sent work is marked failed, not re-sent');
      assert.equal(t.organized.length,calls,'No paid call is repeated automatically');
      const note=(await t.brain.listRecords()).find(r=>r.kind==='dictation')!;
      await t.agent.retrySummary(note.id);await t.agent.drain();
      assert.equal(t.organized.length,calls+1,'One explicit Retry makes one call');
      assert.equal((await t.buffer(first))?.spans.length,0);
    }finally{await t.close();}
  });

  test(`${kind}: acknowledged acceptance payloads are cleared and each record keeps one failed snapshot`,async()=>{
    let failing=true;
    const t=await rig({acceptance:{async accept(record){if(failing)throw Error('backend offline');return {revision:record.revision};}}});
    try{
      await t.agent.startSession();
      for(const text of ['First dictated thought.','Second dictated thought.','Third dictated thought.']) {await t.agent.submitText(text);await t.agent.drain();}
      const session=t.agent.getState().sessionId!;
      const failed=(await t.brain.listOperations()).filter(o=>o.kind==='accept' && o.recordId===session && o.status==='failed');
      assert.equal(failed.length,1,'Older failed snapshots of the same record are superseded');
      failing=false;
      await t.agent.submitText('Fourth dictated thought.');await t.agent.drain();
      const done=(await t.brain.listOperations()).filter(o=>o.kind==='accept' && o.status==='done');
      assert.ok(done.length);
      for(const op of done) assert.equal(await t.brain.getState(`accept-payload:${op.id}`),null,`${op.id} payload cleared`);
    }finally{await t.close();}
  });
}

test('shutdown refuses new paid backend work at once and aborts calls still running',async()=>{
  const seen:string[]=[];let held:import('node:http').ServerResponse|undefined;
  const server=createServer((request,response)=>{
    seen.push(request.url!);
    if(request.url==='/v1/consolidate'){held=response;return;}
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify(request.url==='/v1/route'?{route:'dictate',confidence:1}:{}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const providers=new BackendProviders(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,'token');
  try{
    const running=providers.consolidate({sessionId:'s',segments:[],finalize:false,incremental:true,context:''});
    for(let i=0;i<100 && !held;i++) await new Promise(r=>setTimeout(r,2));
    providers.beginShutdown();
    await assert.rejects(providers.tag({} as never),/Moolai stopped/);
    assert.deepEqual(await providers.route({text:'Late words.',recentContext:'',activeConversation:false}),{route:'dictate',confidence:1},'Routing may still finish');
    providers.close();
    await assert.rejects(running,/Moolai stopped|abort/i);
    assert.ok(!seen.includes('/v1/tag'),'No new paid request reached the backend');
  }finally{held?.destroy();server.closeAllConnections();server.close();}
});
