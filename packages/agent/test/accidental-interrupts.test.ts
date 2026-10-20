import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {AgentReply,BrainPort,RouteInput,Segment} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

// Ian, 20 Oct: a tongue click while Moo was reading became "Moo." and stopped the reading, asked "Could you clarify?",
// or cancelled the answer being prepared. A sound now pauses Moo; only real words interrupt.
const at='2026-10-21T10:00:00.000Z';
const seg=(id:string,text:string):Segment=>({id,turnId:id,revision:1,speaker:'user',text,final:true,createdAt:at});
for(const kind of ['memory','sqlite']) {
  async function rig(options:{resume?:boolean}={}) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-accidental-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let n=0;
    const speech={spoken:[] as string[],stops:0,resumes:0};
    const routes:RouteInput[]=[];
    const route=p.route.bind(p);p.route=async input=>{routes.push(input);return route(input);};
    let release:(()=>void)|undefined;
    let answer:Promise<void>|undefined;
    p.respond=async():Promise<AgentReply>=>{if(answer)await answer;return {text:'Osmosis moves water across a membrane.',toolCalls:[]};};
    const port={async speak(text:string){speech.spoken.push(text);},async stop(){speech.stops++;},
      ...(options.resume===false?{}:{async resume(){speech.resumes++;}})};
    const agent=new Agent({brain,decisions:p,generation:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:port,id:()=>`id-${++n}`,now:()=>at});
    await agent.initialize();await agent.startSession();
    return {brain,agent,speech,routes,
      holdAnswer(){answer=new Promise<void>(r=>release=r);return ()=>{answer=undefined;release?.();};},
      async turn(id:string,text:string){await agent.ingest(seg(id,text));await agent.settleTurn(id);},
      async close(){await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
  }

  test(`${kind}: a sound with no words pauses Moo's reading and it resumes`,async()=>{
    const r=await rig();try{
      await r.agent.speechStarted({paused:true});
      assert.equal(r.speech.stops,0,'A sound pauses, it does not stop');
      await r.agent.recognitionRejected();
      assert.equal(r.speech.resumes,1);assert.equal(r.speech.stops,0);
    }finally{await r.close();}
  });

  test(`${kind}: a lone "Moo." heard during the reading resumes it, with no question and no routing`,async()=>{
    const r=await rig();try{
      await r.agent.speechStarted({paused:true});
      await r.turn('noise','Moo.');await r.agent.drain();
      assert.equal(r.speech.resumes,1);assert.equal(r.speech.stops,0);
      assert.equal(r.routes.length,0,'J1 is never asked about the filler');
      assert.ok(!r.speech.spoken.some(t=>/clarify|answer that/.test(t)),'No clarifying question');
      assert.ok((await r.brain.getRecord(r.agent.getState().sessionId!))!.segments.some(s=>s.text==='Moo.'),'The words stay in the transcript');
    }finally{await r.close();}
  });

  test(`${kind}: real words stop the paused reading and are handled as before`,async()=>{
    const r=await rig();try{
      await r.agent.speechStarted({paused:true});
      await r.turn('real','Wait, what about osmosis in plant roots?');await r.agent.drain();
      assert.equal(r.speech.stops>=1,true,'The reading stops');
      assert.equal(r.speech.resumes,0);
      assert.equal(r.routes.at(-1)!.text,'Wait, what about osmosis in plant roots?');
    }finally{await r.close();}
  });

  test(`${kind}: a lone filler while an answer is being prepared does not cancel it`,async()=>{
    const r=await rig();try{
      const finish=r.holdAnswer();
      await r.turn('ask','Moo, explain osmosis.');
      for(let i=0;i<200&&!r.agent.getState().busy;i++)await new Promise(res=>setTimeout(res,2));
      assert.equal(r.agent.getState().busy,true);
      await r.agent.speechStarted();
      await r.turn('noise','Mm.');
      finish();await r.agent.drain();
      const conversation=(await r.brain.getRecord(r.agent.getState().conversationId!))!;
      assert.ok(conversation.segments.some(s=>s.speaker==='assistant'&&/Osmosis moves water/.test(s.text)),'The answer is published');
      assert.equal(r.routes.filter(x=>x.text==='Mm.').length,0);
    }finally{await r.close();}
  });

  test(`${kind}: when Moo is idle, "Moo." is still routed`,async()=>{
    const r=await rig();try{
      await r.turn('call','Moo.');await r.agent.drain();
      assert.equal(r.routes.at(-1)!.text,'Moo.');
    }finally{await r.close();}
  });

  test(`${kind}: a host that cannot resume stops at the sound, as before`,async()=>{
    const r=await rig({resume:false});try{
      await r.agent.speechStarted({paused:true});
      assert.equal(r.speech.stops,1);
    }finally{await r.close();}
  });

  test(`${kind}: speech still unresolved after eight seconds stops the reading`,async(t)=>{
    const r=await rig();try{
      t.mock.timers.enable({apis:['setTimeout']});
      await r.agent.speechStarted({paused:true});
      t.mock.timers.tick(8000);
      for(let i=0;i<20&&!r.speech.stops;i++)await Promise.resolve();
      assert.equal(r.speech.stops,1);
      t.mock.timers.reset();
      await r.agent.recognitionRejected();
      assert.equal(r.speech.resumes,0,'A reading already stopped is not resumed');
    }finally{t.mock.timers.reset();await r.close();}
  });
}
