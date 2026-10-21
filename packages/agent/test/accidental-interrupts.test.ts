import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {AgentReply,BrainPort,RouteDecision,RouteInput,Segment} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

// Ian, 20 Oct: a tongue click while Moo was reading became "Moo." and stopped the reading, asked "Could you clarify?",
// or cancelled the answer being prepared. A sound now pauses Moo; only real words interrupt.
// 21 Oct: with Moo idle in an open conversation, "Um." (J1 no_action 0.45) and "I don't." (0.24) each got
// "I saved that. Could you clarify what you want to do?"
const at='2026-10-21T10:00:00.000Z';
const seg=(id:string,text:string):Segment=>({id,turnId:id,revision:1,speaker:'user',text,final:true,createdAt:at});
for(const kind of ['memory','sqlite']) {
  async function rig(options:{resume?:boolean}={}) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-accidental-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let n=0;
    const speech={spoken:[] as string[],stops:0,resumes:0};
    const routes:RouteInput[]=[],overrides:Record<string,RouteDecision>={};
    const route=p.route.bind(p);p.route=async input=>{routes.push(input);return overrides[input.text] ?? route(input);};
    let release:(()=>void)|undefined;
    let answer:Promise<void>|undefined;
    p.respond=async():Promise<AgentReply>=>{if(answer)await answer;return {text:'Osmosis moves water across a membrane.',toolCalls:[]};};
    const port={async speak(text:string){speech.spoken.push(text);},async stop(){speech.stops++;},
      ...(options.resume===false?{}:{async resume(){speech.resumes++;}})};
    const agent=new Agent({brain,decisions:p,generation:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},speech:port,id:()=>`id-${++n}`,now:()=>at});
    await agent.initialize();await agent.startSession();
    return {brain,agent,speech,routes,overrides,
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

  test(`${kind}: with no conversation open, "Moo." is still routed`,async()=>{
    const r=await rig();try{
      await r.turn('call','Moo.');await r.agent.drain();
      assert.equal(r.routes.at(-1)!.text,'Moo.');
    }finally{await r.close();}
  });

  test(`${kind}: in an open conversation with Moo idle, "Um." and "Moo." are not routed and Moo says nothing`,async()=>{
    const r=await rig();try{
      await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
      const routed=r.routes.length,said=r.speech.spoken.length;
      r.overrides['Um.']={route:'no_action',confidence:.45};
      await r.turn('um','Um.');await r.turn('noise','Moo.');await r.agent.drain();
      assert.equal(r.routes.length,routed,'J1 is never asked about the fillers');
      assert.deepEqual(r.speech.spoken.slice(said),[],'Nothing is spoken');
      const texts=(await r.brain.getRecord(r.agent.getState().sessionId!))!.segments.map(s=>s.text);
      assert.ok(texts.includes('Um.') && texts.includes('Moo.'),'The words stay in the transcript');
      assert.ok(r.agent.getState().conversationId,'The conversation stays open');
    }finally{await r.close();}
  });

  test(`${kind}: a short unsure reply in an open conversation gets no clarifying question`,async()=>{
    const r=await rig();try{
      await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
      const conversation=r.agent.getState().conversationId;
      r.overrides["I don't."]={route:'no_action',confidence:.24};
      await r.turn('reply',"I don't.");await r.agent.drain();
      assert.equal(r.routes.at(-1)!.text,"I don't.");
      assert.ok(!r.speech.spoken.some(t=>/clarify/.test(t)),'No clarifying question');
      assert.equal(r.agent.getState().pendingOffer,undefined);
      assert.equal(r.agent.getState().conversationId,conversation,'The conversation stays open');
    }finally{await r.close();}
  });

  test(`${kind}: an unsure reply of four or more words still asks to clarify`,async()=>{
    const r=await rig();try{
      await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
      r.overrides['I am not so sure.']={route:'no_action',confidence:.4};
      await r.turn('reply','I am not so sure.');await r.agent.drain();
      assert.match(r.speech.spoken.at(-1)!,/Could you clarify/);
    }finally{await r.close();}
  });

  test(`${kind}: in a conversation, "Mm-hm." still reaches J1 while "which note?" is pending and when Moo is idle`,async()=>{
    const r=await rig();try{
      const asked=()=>r.routes.filter(x=>x.text==='Mm-hm.').length;
      await r.turn('note','The first reading covers glycolysis.');await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
      r.overrides["Don't save that."]={route:'suppress_note',confidence:.5};
      await r.turn('hide',"Don't save that.");await r.agent.drain();
      assert.ok(r.agent.getState().conversationId);assert.equal(r.agent.getState().pendingOffer?.kind,'note_suppression');
      await r.turn('agree','Mm-hm.');await r.agent.drain();
      assert.equal(asked(),1,'An affirmative may answer the question');
      await r.turn('keep','No.');await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer,undefined);
      await r.turn('again','Mm-hm.');await r.agent.drain();
      assert.equal(asked(),2);
    }finally{await r.close();}
  });

  test(`${kind}: in a conversation, "Um." while "which note?" is pending still reaches J1`,async()=>{
    const r=await rig();try{
      await r.turn('note','The first reading covers glycolysis.');await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
      r.overrides["Don't save that."]={route:'suppress_note',confidence:.5};
      await r.turn('hide',"Don't save that.");await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer?.kind,'note_suppression');
      await r.turn('um','Um.');await r.agent.drain();
      assert.equal(r.routes.at(-1)!.text,'Um.','With a question pending, J1 decides what a filler means');
    }finally{await r.close();}
  });

  test(`${kind}: with no conversation open, an unsure "Moo." asks nothing and saves no thought`,async()=>{
    const r=await rig();try{
      r.overrides['Moo.']={route:'unclear',confidence:.3};
      await r.turn('call','Moo.');await r.agent.drain();
      assert.equal(r.routes.at(-1)!.text,'Moo.');
      assert.ok(!r.speech.spoken.some(t=>/answer that/.test(t)),'No "Would you like Moo to answer that?"');
      assert.equal(r.agent.getState().pendingOffer,undefined);
      assert.ok(!(await r.brain.listRecords()).some(x=>x.kind==='dictation'&&x.segments.some(s=>s.text==='Moo.')),'No saved "Moo." thought');
      assert.equal(await r.brain.getState('handled:call'),'call:1','The turn is handled, not routed again');
      assert.deepEqual((await r.brain.listOperations()).filter(o=>o.turnId==='call').map(o=>o.status),['done']);
    }finally{await r.close();}
  });

  test(`${kind}: a confident "Moo." still opens the conversation even if J1 scores it as a doubt`,async()=>{
    const r=await rig();try{
      r.overrides['Moo.']={route:'start_agent',confidence:1,doubt:.95};
      await r.turn('call','Moo.');await r.agent.drain();
      assert.ok(r.agent.getState().conversationId);
      assert.equal(r.agent.getState().pendingOffer,undefined,'No saved-doubt offer for a filler');
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
