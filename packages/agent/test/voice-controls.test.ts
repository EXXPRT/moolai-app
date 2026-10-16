import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {AgentReply,BrainPort} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

const now=()=> '2026-10-16T12:00:00Z';
for(const kind of ['memory','sqlite']) {
  // Production hosts run FixtureProviders/BackendProviders with growing notes (consolidate) on.
  async function setup() {
    const dir=await mkdtemp(join(tmpdir(),'moolai-voice-controls-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let release:((reply:AgentReply)=>void)|undefined;
    p.respond=()=>new Promise(resolve=>release=resolve);
    let n=0,stops=0;
    const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
      speech:{async speak(){},async stop(){stops++;}},id:()=>`voice-${++n}`,now});
    await agent.initialize();await agent.startSession();
    await agent.submitText('Moo, explain hamstring anatomy.');
    while(!release)await new Promise(r=>setTimeout(r,1));
    const answers=async()=>(await brain.listRecords()).filter(r=>r.kind==='conversation')
      .flatMap(r=>r.segments).filter(s=>s.speaker==='assistant' && s.text.includes('flex the knee'));
    return {brain,agent,release:(text:string)=>release!({text,toolCalls:[]}),answers,get stops(){return stops},
      async close(){release?.({text:'',toolCalls:[]});await agent.stopSession();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
  }
  test(`${kind}: stopping speech keeps the answer Moo is preparing`,async()=>{
    const t=await setup();try{
      assert.equal(t.agent.getState().busy,true);
      const before=t.stops;await t.agent.stopSpeech();
      assert.equal(t.stops,before+1,'Playback stops');
      assert.equal(t.agent.getState().busy,true,'The response keeps running');
      assert.notEqual(t.agent.getState().activity,'interrupted');
      t.release('Hamstrings flex the knee.');await t.agent.drain();
      assert.equal((await t.answers()).length,1,'The prepared answer is published');
    }finally{await t.close();}
  });
  test(`${kind}: cancelling the response is a separate, explicit action`,async()=>{
    const t=await setup();try{
      await t.agent.interrupt();
      assert.equal(t.agent.getState().busy,false);assert.equal(t.agent.getState().activity,'interrupted');
      t.release('Hamstrings flex the knee.');await t.agent.drain();
      assert.equal((await t.answers()).length,0,'A cancelled answer is not published');
    }finally{await t.close();}
  });
}
test('a typed message stops playback even when no response is running',async()=>{
  const brain=new MemoryBrain(),p=new FixtureProviders();let n=0,stops=0;
  const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
    speech:{async speak(){},async stop(){stops++;}},id:()=>`typed-${++n}`,now});
  try{
    await agent.initialize();await agent.startSession();
    assert.equal(agent.getState().busy,false);
    await agent.submitText('A note about the knee joint.');
    assert.ok(stops>=1);
  }finally{await agent.stopSession();await agent.drain();await brain.close();}
});
