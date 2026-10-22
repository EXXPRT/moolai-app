import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,RouteDecision,Segment} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

// Speech onsets while J1 routes a finished turn (blocker 3, MOO-030 follow-up). Production hosts run in thought mode
// (FixtureProviders provides consolidate); every scenario drives the real speechStarted()/recognitionRejected() API.
const at='2026-10-16T10:00:00.000Z';
const seg=(id:string,text:string):Segment=>({id,turnId:id,revision:1,speaker:'user',text,final:true,createdAt:at});
/** Lets work started by a mocked timer finish; setImmediate is not mocked. */
const settle=async()=>{for(let i=0;i<20;i++)await new Promise<void>(r=>setImmediate(r));};
for(const kind of ['memory','sqlite']) {
  async function rig(options:{legacy?:boolean,hold?:RegExp}={}) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-onset-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let n=0,captures=0;
    const spoken:string[]=[],requests:string[]=[],visionQuestions:string[]=[],notices:string[]=[],activities:unknown[]=[];
    const overrides:Record<string,RouteDecision>={};
    let gateNext=false,entered!:()=>void,enteredP=Promise.resolve(),release!:(d:RouteDecision)=>void;
    // A held line plays as LocalSpeech plays it: until stop(), or until newer speech rejects it with "Speech superseded".
    let playing:((e:Error)=>void)|undefined;
    const route=p.route.bind(p);
    p.route=async input=>{
      if(gateNext){gateNext=false;entered();return new Promise<RouteDecision>(r=>release=r);}
      return overrides[input.text] ?? route(input);
    };
    p.respond=async messages=>{requests.push(String(messages.at(-1)?.content));return {text:'Here is a complete answer to that request.',toolCalls:[]};};
    const vision={async interpret(_image:{mimeType:string;dataBase64:string},question:string){visionQuestions.push(question);return p.interpret();}};
    // Legacy mode (no organizer) is the only one where enrichment still makes help offers.
    const generation=options.legacy?{summarize:(r:Parameters<typeof p.summarize>[0])=>p.summarize(r),respond:(...a:Parameters<typeof p.respond>)=>p.respond(...a)}:p;
    const agent=new Agent({brain,decisions:p,generation,search:p,vision,
      capture:{async capture(){captures++;return {mimeType:'image/png',bytes:new Uint8Array([137,80,78,71])};}},
      speech:{async speak(text){playing?.(Error('Speech superseded'));playing=undefined;spoken.push(text);if(options.hold?.test(text))await new Promise<void>((_,reject)=>playing=reject);},
        async stop(){playing?.(Error('Speech interrupted'));playing=undefined;}},id:()=>`id-${++n}`,now:()=>at,
      onEvent:e=>{if(e.type==='notice')notices.push(e.message!);if(e.state)activities.push(e.state.activity);}});
    await agent.initialize();await agent.startSession();
    const sessionId=agent.getState().sessionId!;
    return {brain,p,agent,spoken,requests,visionQuestions,notices,activities,overrides,get captures(){return captures},get playing(){return !!playing},
      /** The next J1 call stays in flight until resolve(). */
      gate(){gateNext=true;enteredP=new Promise<void>(r=>entered=r);return ()=>enteredP;},
      resolve(d:RouteDecision){release(d);},
      async turn(id:string,text:string){await agent.ingest(seg(id,text));return agent.settleTurn(id);},
      async spans(){return ((await brain.getState<{spans?:{segmentId:string}[]}>(`thought-buffer:${sessionId}`))?.spans ?? []).map(s=>s.segmentId);},
      async close(){playing?.(Error('Speech interrupted'));await agent.recognitionRejected();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
  }

  test(`${kind}: a pause during dictation keeps both sentences for the growing note`,async()=>{
    const r=await rig();try{
      const entered=r.gate();const a=r.turn('A','The enzyme works best at 37 degrees.');await entered();
      await r.agent.speechStarted();r.resolve({route:'dictate',confidence:1});await a;
      await r.turn('B','Above 45 degrees it denatures.');await r.agent.drain();
      assert.deepEqual(await r.spans(),['A','B']);
    }finally{await r.close();}
  });

  test(`${kind}: "Moo", a pause and a request open one conversation without a greeting over the request`,async()=>{
    const r=await rig();try{
      const entered=r.gate();const a=r.turn('A','Moo.');await entered();
      await r.agent.speechStarted();r.resolve({route:'start_agent',confidence:1});await a;
      assert.ok(r.agent.getState().conversationId,'The conversation opens');
      assert.ok(!r.spoken.some(t=>/I'm listening/.test(t)),'No greeting is spoken over new speech');
      r.overrides['What is ATP?']={route:'continue_agent',confidence:1};
      await r.turn('B','What is ATP?');await r.agent.drain();
      assert.equal(r.requests.length,1);assert.match(r.requests[0]!,/What is ATP/);
    }finally{await r.close();}
  });

  for(const outcome of ['noise','redirect'] as const) test(`${kind}: a request followed by ${outcome} is held, then ${outcome==='noise'?'answered':'replaced by the redirect'}`,async()=>{
    const r=await rig();try{
      r.overrides['Moo.']={route:'start_agent',confidence:1};await r.turn('M','Moo.');await r.agent.drain();
      const entered=r.gate();const a=r.turn('A','Compare aerobic and anaerobic respiration yields.');await entered();
      await r.agent.speechStarted();r.resolve({route:'continue_agent',confidence:1});await a;
      assert.equal(r.requests.length,0,'No generation call while the new speech is unknown');
      if(outcome==='noise') await r.agent.recognitionRejected();
      else {r.overrides['Actually, just the ATP totals.']={route:'continue_agent',confidence:1};await r.turn('B','Actually, just the ATP totals.');}
      await r.agent.drain();
      assert.equal(r.requests.length,1);
      assert.match(r.requests[0]!,outcome==='noise'?/aerobic and anaerobic/:/ATP totals/);
    }finally{await r.close();}
  });

  test(`${kind}: a help offer decided over new speech is not asked, and the words still reach the notes`,async()=>{
    const r=await rig();try{
      const entered=r.gate();const a=r.turn('A',"I really don't get why the sky is blue.");await entered();
      await r.agent.speechStarted();r.resolve({route:'offer_help',confidence:.95});await a;await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer,undefined);
      assert.ok(!r.spoken.some(t=>/Would you like/.test(t)));
      assert.deepEqual(await r.spans(),['A']);
    }finally{await r.close();}
  });

  test(`${kind}: Stop response during routing starts no answer but keeps the words`,async()=>{
    const r=await rig();try{
      r.overrides['Moo.']={route:'start_agent',confidence:1};await r.turn('M','Moo.');await r.agent.drain();
      const entered=r.gate();const a=r.turn('A','Explain oxidative phosphorylation.');await entered();
      await r.agent.interrupt();r.resolve({route:'continue_agent',confidence:1});await a;await r.agent.drain();
      assert.equal(r.requests.length,0);assert.equal(r.agent.getState().busy,false);
      assert.ok((await r.spans()).includes('A'));
    }finally{await r.close();}
  });

  // With growing notes, J1 decides doubt offers on the spoken turn and enrichment never offers (blocker 5),
  // so this race remains only without the organizer, where J7 enrichment can offer while J1 routes.
  test(`${kind}: a help offer created while J1 routes later dictation survives (ACL-04)`,async()=>{
    const r=await rig({legacy:true});try{
      let tagged!:()=>void;const tagGate=new Promise<void>(res=>tagged=res);
      r.p.tag=async i=>{await tagGate;return {purpose:'Question',purposeConfidence:1,topics:{},doubt:JSON.stringify(i.record).includes('sky')?1:0,relevant:undefined,faithful:1,understandable:1};};
      r.overrides["I don't understand why the sky is blue."]={route:'dictate',confidence:1};
      await r.turn('A',"I don't understand why the sky is blue.");
      const entered=r.gate();const b=r.turn('B','Next, the lecture covered refraction.');await entered();
      tagged();
      for(let i=0;i<200 && !r.agent.getState().pendingOffer;i++) await new Promise(res=>setTimeout(res,5));
      assert.ok(r.agent.getState().pendingOffer,'Enrichment offers help while J1 runs');
      r.resolve({route:'dictate',confidence:1});await b;await r.agent.drain();
      assert.ok(r.agent.getState().pendingOffer,'The stale dictate does not withdraw the spoken offer');
    }finally{await r.close();}
  });

  test(`${kind}: the finish/cancel/continue question clears when its work ends, and a stale Cancel changes nothing (ACL-05)`,async()=>{
    const r=await rig();try{
      let finish!:()=>void;const held=new Promise<void>(res=>finish=res);
      r.p.respond=async()=>{await held;return {text:'The Calvin cycle fixes carbon.',toolCalls:[]};};
      r.overrides['Moo.']={route:'start_agent',confidence:1};await r.turn('M','Moo.');await r.agent.drain();
      r.overrides['Explain the Calvin cycle.']={route:'continue_agent',confidence:1};await r.turn('A','Explain the Calvin cycle.');
      await r.agent.requestEnd();
      assert.equal(r.agent.getState().pendingOffer?.kind,'end_work');
      finish();await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer,undefined);
      const id=r.agent.getState().conversationId;assert.ok(id);
      await r.agent.resolveEnd('cancel');await r.agent.drain();
      assert.equal(r.agent.getState().conversationId,id,'A stale Cancel does not close the conversation');
    }finally{await r.close();}
  });

  // Code review, 22 Oct: Finish conversation while Moo read a published answer asked about running work, cut the reading
  // as a voice failure, then said "The work ended. The conversation is still open." and left it open.
  test(`${kind}: Finish conversation while Moo reads a published answer closes it, with no question about running work`,async()=>{
    const r=await rig({hold:/^ATP carries energy/});try{
      r.p.respond=async()=>({text:'ATP is the main energy carrier in cells.',spokenText:'ATP carries energy in cells.',toolCalls:[]});
      r.overrides['Moo.']={route:'start_agent',confidence:1};await r.turn('M','Moo.');await r.agent.drain();
      r.overrides['What is ATP?']={route:'continue_agent',confidence:1};await r.turn('A','What is ATP?');
      for(let i=0;i<500 && !r.playing;i++) await new Promise(res=>setTimeout(res,2));
      assert.equal(r.playing,true,'Moo is reading the published answer');assert.equal(r.agent.getState().busy,true);
      await r.agent.requestEnd();await r.agent.drain();
      assert.equal(r.agent.getState().conversationId,undefined,'One click closes the conversation');
      const said=(await r.brain.listRecords()).flatMap(x=>x.segments).filter(s=>s.speaker==='assistant').map(s=>s.text);
      assert.ok(said.includes('ATP is the main energy carrier in cells.'),'The answer is kept');
      assert.ok(!said.some(t=>/^(?:Work is still running|The work ended)/.test(t)),'No question about running work, and none withdrawn');
      assert.ok(!r.notices.some(m=>/voice is unavailable/.test(m)),'The cut reading is not a voice failure');
      assert.ok(!((await r.brain.getState<{action:string}[]>('interaction-trace')) ?? []).some(e=>e.action==='narration_unavailable'),'No playback failure is traced');
      assert.equal(r.spoken.at(-1),'Conversation closed. Your transcript is saved.');
    }finally{await r.close();}
  });

  // Review, 23 Oct: Finish while a published answer still waited for "I'm listening…" cut the greeting, then read the
  // answer, and the conversation closed only when the reading ended.
  test(`${kind}: Finish conversation while a published answer waits for "I'm listening…" closes it, and the answer is not read`,async()=>{
    const r=await rig({hold:/^I'm listening/});try{
      r.p.respond=async()=>({text:'ATP is the main energy carrier in cells.',spokenText:'ATP carries energy in cells.',toolCalls:[]});
      r.overrides['Moo, what is ATP?']={route:'start_agent',confidence:1};await r.turn('M','Moo, what is ATP?');
      const ready=async()=>((await r.brain.getState<{action:string}[]>('interaction-trace')) ?? []).some(e=>e.action==='narration_selected');
      for(let i=0;i<500 && !await ready();i++) await new Promise(res=>setTimeout(res,2));
      assert.equal(await ready(),true,'The answer is published');assert.equal(r.playing,true,'It waits for the greeting');
      await r.agent.requestEnd();await r.agent.drain();
      assert.ok(!r.spoken.includes('ATP carries energy in cells.'),'The answer is not read after Finish');
      assert.equal(r.agent.getState().conversationId,undefined,'One click closes the conversation');
      assert.equal(r.spoken.at(-1),'Conversation closed. Your transcript is saved.');
    }finally{await r.close();}
  });

  test(`${kind}: new dictation during a "which note?" question is kept for the notes (ACL-07)`,async()=>{
    const r=await rig();try{
      await r.turn('A','The first reading covers glycolysis.');await r.agent.drain();
      r.overrides["Don't save that."]={route:'suppress_note',confidence:.5};
      await r.turn('S',"Don't save that.");await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer?.kind,'note_suppression','Moo asks which note');
      r.overrides['Moving on, the Krebs cycle produces two ATP per glucose.']={route:'unclear',confidence:.9};
      await r.turn('B','Moving on, the Krebs cycle produces two ATP per glucose.');await r.agent.drain();
      assert.equal(r.agent.getState().pendingOffer,undefined);
      assert.ok((await r.spans()).includes('B'));
    }finally{await r.close();}
  });

  test(`${kind}: "yes", a pause and more detail add to screen help and keep the capture`,async()=>{
    const r=await rig();try{
      r.overrides["I don't understand this diagram."]={route:'offer_help',confidence:.95,screenHelp:true};
      await r.turn('A',"I don't understand this diagram.");await r.agent.drain();
      const offer=r.agent.getState().pendingOffer;
      assert.ok(offer && 'screenQuestion' in offer && offer.screenQuestion,'A screen-help offer is pending');
      const entered=r.gate();const y=r.turn('Y','Yes.');await entered();
      await r.agent.speechStarted();r.resolve({route:'start_agent',confidence:1,helpAccepted:true});await y;
      assert.equal(r.captures,0,'No capture while the new speech is unknown');
      r.overrides['The second diagram, please.']={route:'continue_agent',confidence:1};
      await r.turn('D','The second diagram, please.');await r.agent.drain();
      assert.equal(r.captures,1);
      assert.match(r.visionQuestions.at(-1)!,/second diagram/);
    }finally{await r.close();}
  });

  test(`${kind}: known limitation, pinned: speech that starts before the turn is scheduled counts as part of it`,async()=>{
    const r=await rig();try{
      r.overrides['Moo.']={route:'start_agent',confidence:1};await r.turn('M','Moo.');await r.agent.drain();
      r.overrides['Moo, finish conversation.']={route:'end_agent',confidence:1,substantiveContentProbability:0};
      await r.agent.speechStarted();
      await r.turn('E','Moo, finish conversation.');await r.agent.drain();
      // The onset arrived before turn E reached the controller, so it cannot be told apart from E itself.
      assert.equal(r.agent.getState().conversationId,undefined);
    }finally{await r.close();}
  });

  // Code review, 22 Oct: the lost-recognition timer ran a minute from the first onset while each sentence began as J1
  // routed the one before, so reading aloud showed "couldn't interpret" and dropped the request being routed.
  test(`${kind}: over a minute of sentences each begun while J1 routes the one before is not interrupted, and its request is answered`,async t=>{
    const r=await rig();try{
      t.mock.timers.enable({apis:['setTimeout']});
      await r.agent.speechStarted();
      for(const [id,text,route] of [['A','The enzyme works best at 37 degrees.','dictate'],['B','Above 45 degrees it denatures.','dictate'],
        ['Q','Moo, what is osmosis?','start_agent']] as const) {
        const entered=r.gate();const turn=r.turn(id,text);await entered();
        t.mock.timers.tick(25000);await settle();
        await r.agent.speechStarted();r.resolve({route,confidence:1});await turn;
      }
      await r.agent.recognitionRejected();await r.agent.drain();
      // Releasing the hold cancels the timer the last onset restarted, so nothing fires a minute later.
      t.mock.timers.tick(60000);await settle();
      assert.ok(!r.notices.some(m=>/interpret the interruption/.test(m)),'No lost-recognition interrupt');
      assert.ok(!r.activities.includes('interrupted'));
      assert.ok(r.agent.getState().conversationId,'The request routed over the minute mark opens a conversation');
      assert.equal(r.requests.length,1);assert.match(r.requests[0]!,/osmosis/);
    }finally{t.mock.timers.reset();await r.close();}
  });

  test(`${kind}: speech that is never recognized still times out a minute after its own onset`,async t=>{
    const r=await rig();try{
      t.mock.timers.enable({apis:['setTimeout']});
      const timeouts=()=>r.notices.filter(m=>m==='I couldn’t interpret the interruption. Your request is saved; please say it again.').length;
      await r.agent.speechStarted();
      t.mock.timers.tick(59999);await settle();
      assert.equal(timeouts(),0);
      t.mock.timers.tick(1);await settle();
      assert.equal(timeouts(),1,'A lost recognition event times out visibly');
      assert.equal(r.agent.getState().activity,'interrupted');
      // Speech begun while J1 routes a sentence, then lost, times out a minute after it began, not after the first onset.
      await r.agent.speechStarted();
      const entered=r.gate();const a=r.turn('A','The enzyme works best at 37 degrees.');await entered();
      t.mock.timers.tick(30000);await r.agent.speechStarted();r.resolve({route:'dictate',confidence:1});await a;
      t.mock.timers.tick(59999);await settle();
      assert.equal(timeouts(),1,'Timed from the latest onset');
      t.mock.timers.tick(1);await settle();
      assert.equal(timeouts(),2);
    }finally{t.mock.timers.reset();await r.close();}
  });
}

test('new speech during the hybrid closing check keeps the conversation open (ACL-02)',async()=>{
  for(const onset of [false,true]) {
    const brain=new MemoryBrain();let n=0,verifyEntered!:()=>void,verdict!:(d:RouteDecision)=>void;
    const verifying=new Promise<void>(r=>verifyEntered=r);
    const agent=new Agent({brain,id:()=>`h-${++n}`,now:()=>at,
      decisions:{
        route:async(i,signal)=>{
          if(!i.activeConversation) return {route:'start_agent',confidence:1};
          if(signal){verifyEntered();return new Promise<RouteDecision>(r=>verdict=r);} // only verifyClosure passes a signal
          return {route:'continue_agent',confidence:1};
        },
        tag:async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,faithful:1,understandable:1}),
        connect:async()=>({}),
      },
      generation:{summarize:async()=>({title:'t',summary:'s'}),
        respond:async m=>/that's all/i.test(JSON.stringify(m.at(-1)))
          ? {text:"You're welcome; glad that helped.",toolCalls:[],controlProposal:{action:'end_conversation',reason:"User said that's all."}}
          : {text:'Photosynthesis converts light into chemical energy.',toolCalls:[]}},
      search:{search:async()=>[],extract:async()=>[]},vision:{interpret:async()=>''},
      capture:{capture:async()=>{throw Error('unused');}},speech:{speak:async()=>{},stop:async()=>{}}});
    try{
      await agent.initialize();
      await agent.submitText('Moo, explain photosynthesis.');await agent.drain();
      const id=agent.getState().conversationId;assert.ok(id);
      await agent.submitText("Thanks, that's all.");await verifying;
      if(onset) await agent.speechStarted();
      verdict({route:'end_agent',confidence:.95,substantiveContentProbability:0});
      await agent.drain();
      assert.equal(agent.getState().conversationId,onset?id:undefined,onset?'New speech keeps it open':'Without new speech the verified close goes through');
    }finally{if(onset)await agent.recognitionRejected();await agent.drain();await brain.close();}
  }
});

test('a failing interrupt from the lost-recognition timer is reported, not thrown (ACL-12)',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const brain=new MemoryBrain(),p=new FixtureProviders();let n=0;const notices:string[]=[];
  const failures:unknown[]=[];const onRejection=(e:unknown)=>failures.push(e);process.on('unhandledRejection',onRejection);
  let stopFails=false;
  const agent=new Agent({brain,decisions:p,generation:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
    speech:{async speak(){},async stop(){if(stopFails)throw Error('speaker gone');}},id:()=>`t-${++n}`,now:()=>at,
    onEvent:e=>{if(e.type==='notice')notices.push(String(e.message));}});
  try{
    await agent.initialize();await agent.startSession();
    await agent.speechStarted();stopFails=true;
    t.mock.timers.tick(60000);
    for(let i=0;i<20;i++) await new Promise<void>(r=>setImmediate(r));
    assert.deepEqual(failures,[]);
    assert.ok(notices.some(m=>/speaker gone/.test(m)),'The failure is shown as a notice');
  }finally{process.off('unhandledRejection',onRejection);t.mock.timers.reset();stopFails=false;await agent.drain();await brain.close();}
});
