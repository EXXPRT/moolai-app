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
  async function rig(options:{resume?:boolean,stopEnds?:boolean}={}) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-accidental-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let n=0,responses=0,captures=0,fails=false;
    const speech={spoken:[] as string[],stops:0,resumes:0,playing:false};
    const routes:RouteInput[]=[],overrides:Record<string,RouteDecision|Error|Promise<RouteDecision>>={};
    const route=p.route.bind(p);p.route=async input=>{routes.push(input);const o=overrides[input.text];if(o instanceof Error)throw o;return o ?? route(input);};
    let release:(()=>void)|undefined;
    let answer:Promise<void>|undefined;
    // A held speak stays pending until the test releases it, as a reading of minutes does; stop() alone does not settle
    // it unless the rig is made with stopEnds, as LocalSpeech.stop() does.
    let hold=false,finish:(()=>void)|undefined;
    p.respond=async():Promise<AgentReply>=>{responses++;if(answer)await answer;if(fails)throw Error('Model unavailable');return {text:'Osmosis moves water across a membrane.',toolCalls:[]};};
    const port={async speak(text:string){speech.spoken.push(text);if(!hold)return;hold=false;speech.playing=true;await new Promise<void>(r=>finish=r);speech.playing=false;},
      async stop(){speech.stops++;if(options.stopEnds)finish?.();},...(options.resume===false?{}:{async resume(){speech.resumes++;}})};
    const agent=new Agent({brain,decisions:p,generation:p,search:p,vision:p,capture:{async capture(){captures++;return {mimeType:'image/png',bytes:new Uint8Array([137,80,78,71])};}},speech:port,id:()=>`id-${++n}`,now:()=>at});
    await agent.initialize();await agent.startSession();
    return {brain,agent,speech,routes,overrides,get responses(){return responses;},get captures(){return captures;},
      holdAnswer(){answer=new Promise<void>(r=>release=r);return ()=>{answer=undefined;release?.();};},
      failAnswer(){fails=true;},
      holdSpeech(){hold=true;return ()=>finish?.();},
      async turn(id:string,text:string){await agent.ingest(seg(id,text));await agent.settleTurn(id);},
      async close(){finish?.();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
  }
  /** Whether the work finishes within a second, while a held reading or line still plays; one awaited on the turn queue holds it up. */
  const soon=(work:Promise<unknown>)=>Promise.race([work.then(()=>true),new Promise<boolean>(res=>setTimeout(res,1000,false).unref())]);
  const until=async(done:()=>boolean)=>{for(let i=0;i<500&&!done();i++)await new Promise(res=>setTimeout(res,2));};
  /** Moo answers, then reads the answer in full until the test releases it. */
  async function reading(r:Awaited<ReturnType<typeof rig>>) {
    await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
    const end=r.holdSpeech();void r.turn('read','Moo. Read it in full.');
    for(let i=0;i<500&&!r.speech.playing;i++)await new Promise(res=>setTimeout(res,2));
    assert.equal(r.speech.playing,true,'The reading has started');
    assert.equal(r.speech.spoken.at(-1),'Osmosis moves water across a membrane.');
    return {routed:r.routes.length,stops:r.speech.stops,end};
  }
  /** Moo answers a turn with a line of its own, such as "I'm listening…" or the screen offer, which plays until the test releases it. */
  async function line(r:Awaited<ReturnType<typeof rig>>,id:string,text:string,said:RegExp) {
    const end=r.holdSpeech();void r.turn(id,text);
    await until(()=>r.speech.playing);
    assert.equal(r.speech.playing,true,'The line has started');
    assert.match(r.speech.spoken.at(-1)!,said);
    return {routed:r.routes.length,stops:r.speech.stops,end};
  }
  /** Waits until the answer is published and about to be spoken. */
  async function answerReady(r:Awaited<ReturnType<typeof rig>>) {
    const ready=async()=>((await r.brain.getState<{action:string}[]>('interaction-trace')) ?? []).some(e=>e.action==='narration_selected');
    for(let i=0;i<500&&!await ready();i++)await new Promise(res=>setTimeout(res,2));
    assert.equal(await ready(),true,'The answer is ready to be spoken');
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
      r.overrides["I don't."]=r.overrides["No, I don't."]={route:'no_action',confidence:.24};
      await r.turn('reply',"I don't.");await r.turn('three',"No, I don't.");await r.agent.drain();
      assert.deepEqual(r.routes.slice(-2).map(x=>x.text),["I don't.","No, I don't."]);
      assert.ok(!r.speech.spoken.some(t=>/clarify/.test(t)),'No clarifying question, up to three words');
      assert.equal(r.agent.getState().pendingOffer,undefined);
      assert.equal(r.agent.getState().conversationId,conversation,'The conversation stays open');
    }finally{await r.close();}
  });

  test(`${kind}: an unsure reply of four or more words still asks to clarify`,async()=>{
    const r=await rig();try{
      await r.turn('ask','Moo, explain osmosis.');await r.agent.drain();
      r.overrides['I am not sure.']={route:'no_action',confidence:.4};
      await r.turn('reply','I am not sure.');await r.agent.drain();
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
      assert.equal(r.agent.getState().pendingOffer,undefined);
      await r.turn('spaced','Mm hmm.');await r.agent.drain();
      assert.equal(r.routes.at(-1)!.text,'Mm hmm.','Spelled with a space too');
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

  test(`${kind}: an unsure "Mm-hm." to a pending offer is asked again`,async()=>{
    const r=await rig();try{
      const doubt="Sample A kept a lower minimum. I'm not sure why.";
      r.overrides[doubt]={route:'dictate',confidence:1,doubt:.95};
      await r.turn('doubt',doubt);await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer?.kind,'help');
      const said=r.speech.spoken.length;
      r.overrides['Mm-hm.']={route:'start_agent',confidence:.6,helpAccepted:true};
      await r.turn('agree','Mm-hm.');await r.agent.drain();
      assert.deepEqual(r.speech.spoken.slice(said),['Would you like Moo to answer that?']);
      assert.equal(r.agent.getState().pendingOffer?.kind,'help','The offer stays open');
    }finally{await r.close();}
  });

  test(`${kind}: a filler J1 failed on clears that failure once it is routed`,async()=>{
    const r=await rig();try{
      r.overrides['Um.']=Error('J1 offline');
      await assert.rejects(r.turn('um','Um.'),/J1 offline/);await r.agent.drain();
      assert.equal(r.agent.getState().lastError,'J1 offline');
      r.overrides['Um.']={route:'unclear',confidence:.3};
      await r.agent.settleTurn('um');await r.agent.drain();
      assert.equal(r.agent.getState().lastError,undefined);
      assert.deepEqual(r.speech.spoken,[],'Still nothing is asked');
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

  // Ian, 21 Oct test A: Moo could not read a whole answer without stopping. The reading held the turn queue, so the
  // sound that paused it was heard only after the eight-second stop, and real words waited as long.
  test(`${kind}: "Mm." during a held reading resumes it once, without stopping or routing it`,async()=>{
    const r=await rig();try{
      const {routed,stops}=await reading(r);
      await r.agent.speechStarted({paused:true});await soon(r.turn('noise','Mm.'));
      assert.equal(r.speech.resumes,1,'The filler resumes the reading at once');
      assert.equal(r.speech.stops,stops,'It does not stop it');
      assert.equal(r.routes.length,routed,'J1 is never asked about the filler');
      assert.equal(r.speech.playing,true);
    }finally{await r.close();}
  });

  test(`${kind}: "Mm-hm." during a reading is not routed, and the reading resumes`,async()=>{
    const r=await rig();try{
      const {routed,stops,end}=await reading(r);
      await r.agent.speechStarted({paused:true});await soon(r.turn('agree','Mm-hm.'));
      assert.equal(r.speech.resumes,1,'The reading resumes at once');
      // A sound too short to pause Moo can still reach the recognizer; with Moo idle, J1 would hear this "mm-hm".
      assert.equal(await soon(r.turn('again','Mm-hm.')),true,'The second filler is handled while the reading plays');
      assert.equal(r.routes.length,routed,'J1 is never asked about either filler');
      assert.equal(r.speech.stops,stops,'Neither filler stops the reading');
      assert.equal(r.speech.playing,true);
      end();await r.agent.drain();
      await r.turn('idle','Mm-hm.');await r.agent.drain();
      assert.deepEqual(r.routes.slice(routed).map(x=>x.text),['Mm-hm.'],'Once the reading has ended, J1 hears an "mm-hm" again');
    }finally{await r.close();}
  });

  test(`${kind}: real words during a reading stop it at once and are routed`,async()=>{
    const r=await rig();try{
      const {routed,stops}=await reading(r);
      await r.agent.speechStarted({paused:true});await soon(r.turn('real','Wait, what about osmosis in plant roots?'));
      assert.equal(r.speech.stops,stops+1,'The reading is stopped at once');
      assert.equal(r.speech.playing,true,'The stop does not wait for the reading to end');
      assert.deepEqual(r.routes.slice(routed).map(x=>x.text),['Wait, what about osmosis in plant roots?']);
    }finally{await r.close();}
  });

  test(`${kind}: a later turn is handled while the reading is still being spoken`,async()=>{
    const r=await rig();try{
      const {routed}=await reading(r);
      assert.equal(await soon(r.turn('later','And how does it differ from diffusion?')),true,'The turn queue is free');
      assert.equal(await r.brain.getState('handled:later'),'later:1');
      assert.deepEqual(r.routes.slice(routed).map(x=>x.text),['And how does it differ from diffusion?']);
      assert.equal(r.speech.playing,true,'The reading is still being spoken');
    }finally{await r.close();}
  });

  // Code review, 22 Oct: Moo's other lines still held the turn queue, as readings once did, so a reply said over "I'm
  // listening…" or the screen offer waited for the eight-second stop, and a click heard as "Moo." cut the offer.
  test(`${kind}: a request said over "I'm listening…" stops it at once and is answered`,async()=>{
    const r=await rig();try{
      const {routed,stops}=await line(r,'call','Moo.',/^I'm listening/);
      await r.agent.speechStarted({paused:true});
      assert.equal(await soon(r.turn('ask','Explain osmosis.')),true,'The turn queue is free');
      assert.equal(r.speech.stops,stops+1,'The line is stopped at once');
      assert.deepEqual(r.routes.slice(routed).map(x=>x.text),['Explain osmosis.']);
      await until(()=>r.responses>0);
      assert.equal(r.responses,1,'The answer is requested');
      assert.equal(r.speech.playing,true,'Before the held line settles');
    }finally{await r.close();}
  });

  test(`${kind}: "Yes please." over the screen offer starts the help at once`,async()=>{
    const r=await rig();try{
      const doubt="Sample A kept a lower minimum. I'm not sure why.";
      r.overrides[doubt]={route:'dictate',confidence:1,doubt:.95};
      const {stops}=await line(r,'doubt',doubt,/^I saved your thought/);
      assert.equal(r.agent.getState().pendingOffer?.kind,'help');
      await r.agent.speechStarted({paused:true});
      assert.equal(await soon(r.turn('yes','Yes please.')),true,'The turn queue is free');
      assert.equal(r.speech.stops,stops+1,'The offer is stopped at once');
      await until(()=>r.captures>0);
      assert.equal(r.captures,1,'The screen is captured for the help');
      assert.equal(r.speech.playing,true,'Before the held offer settles');
    }finally{await r.close();}
  });

  test(`${kind}: "Mm." over the screen offer resumes it once, without stopping or routing it`,async()=>{
    const r=await rig();try{
      const doubt="Sample A kept a lower minimum. I'm not sure why.";
      r.overrides[doubt]={route:'dictate',confidence:1,doubt:.95};
      const {routed,stops}=await line(r,'doubt',doubt,/^I saved your thought/);
      await r.agent.speechStarted({paused:true});await soon(r.turn('noise','Mm.'));
      assert.equal(r.speech.resumes,1,'The filler resumes the offer at once');
      assert.equal(r.speech.stops,stops,'It does not stop it');
      assert.equal(r.routes.length,routed,'J1 is never asked about the filler');
      assert.equal(r.agent.getState().pendingOffer?.kind,'help','The offer stays open');
    }finally{await r.close();}
  });

  test(`${kind}: an answer ready while "I'm listening…" plays is spoken after it, not over it`,async()=>{
    const r=await rig();try{
      const {end}=await line(r,'ask','Moo, explain osmosis.',/^I'm listening/);
      const ready=async()=>((await r.brain.getState<{action:string}[]>('interaction-trace')) ?? []).some(e=>e.action==='narration_selected');
      for(let i=0;i<500&&!await ready();i++)await new Promise(res=>setTimeout(res,2));
      assert.equal(r.responses,1,'The answer is prepared while the line plays');
      assert.equal(await ready(),true,'The answer is ready to be spoken');
      await new Promise(res=>setTimeout(res,50));
      assert.match(r.speech.spoken.at(-1)!,/^I'm listening/,'The answer waits for the line');
      end();await r.agent.drain();
      assert.equal(r.speech.spoken.at(-1),'Osmosis moves water across a membrane.','Then it is spoken');
    }finally{await r.close();}
  });

  // Code review, 22 Oct: an answer ready during "I'm listening…" waited only for the line; when real words stopped it,
  // the answer found the user still being heard and was never said.
  test(`${kind}: an answer waiting on "I'm listening…" is still said once words that stopped it are handled`,async()=>{
    const r=await rig({stopEnds:true});let decide!:(d:RouteDecision)=>void;try{
      r.overrides['Okay.']=new Promise<RouteDecision>(res=>decide=res);
      await line(r,'ask','Moo, explain osmosis.',/^I'm listening/);
      await answerReady(r);
      await r.agent.speechStarted({paused:true});
      const said=r.turn('ok','Okay.');
      await until(()=>r.routes.some(x=>x.text==='Okay.'));
      assert.equal(r.speech.playing,false,'The words stop the line');
      await new Promise(res=>setTimeout(res,50));
      decide({route:'no_action',confidence:1});await said;await r.agent.drain();
      assert.equal(r.speech.spoken.at(-1),'Osmosis moves water across a membrane.','The answer is said after the words are handled');
    }finally{decide({route:'no_action',confidence:1});await r.close();}
  });

  test(`${kind}: a status line said in reply to words over "I'm listening…" is not cut off by the waiting answer`,async()=>{
    const r=await rig({stopEnds:true});try{
      await line(r,'ask','Moo, explain osmosis.',/^I'm listening/);
      await answerReady(r);
      await r.agent.speechStarted({paused:true});
      const end=r.holdSpeech();
      assert.equal(await soon(r.turn('status','Are you there?')),true,'The turn queue is free');
      await until(()=>r.speech.playing);
      await new Promise(res=>setTimeout(res,50));
      assert.match(r.speech.spoken.at(-1)!,/^I’m preparing the answer/,'The answer waits for the status line');
      end();await r.agent.drain();
      assert.equal(r.speech.spoken.at(-1),'Osmosis moves water across a membrane.','Then it is said');
    }finally{await r.close();}
  });

  test(`${kind}: an answer that fails while "I'm listening…" plays is reported after the line and the words said over it`,async()=>{
    const r=await rig({stopEnds:true});let decide!:(d:RouteDecision)=>void;try{
      r.failAnswer();r.overrides['Okay.']=new Promise<RouteDecision>(res=>decide=res);
      await line(r,'ask','Moo, explain osmosis.',/^I'm listening/);
      await until(()=>!!r.agent.getState().lastError);
      await new Promise(res=>setTimeout(res,50));
      assert.match(r.speech.spoken.at(-1)!,/^I'm listening/,'The failure waits for the line');
      await r.agent.speechStarted({paused:true});
      const said=r.turn('ok','Okay.');
      await until(()=>r.routes.some(x=>x.text==='Okay.'));
      await new Promise(res=>setTimeout(res,50));
      decide({route:'no_action',confidence:1});await said;await r.agent.drain();
      assert.match(r.speech.spoken.at(-1)!,/^I couldn't finish that answer/,'Then the failure is said');
    }finally{decide({route:'no_action',confidence:1});await r.close();}
  });

  // A line said without a staleness check, such as the finish question, no longer holds the turn queue either.
  test(`${kind}: "Cancel." said over "Work is still running…?" is acted on at once`,async()=>{
    const r=await rig(),release=r.holdAnswer();try{
      await r.turn('ask','Moo, explain osmosis.');
      assert.equal(r.agent.getState().busy,true);
      const {stops}=await line(r,'end','Moo, finish conversation.',/^Work is still running/);
      await r.agent.speechStarted({paused:true});
      assert.equal(await soon(r.turn('cancel','Cancel.')),true,'The turn queue is free');
      assert.equal(r.speech.stops,stops+1,'The question is stopped at once');
      assert.equal(r.agent.getState().conversationId,undefined,'The work is cancelled and the conversation closed');
    }finally{release();await r.close();}
  });
}
