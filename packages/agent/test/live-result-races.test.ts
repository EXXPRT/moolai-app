import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import type {AgentEvent, BrainPort, Segment} from '../../contracts/src/index.js';
import {Agent} from '../src/index.js';

const at='2026-10-10T14:00:00.000Z';
const answer='The complete saved answer states that the volume is twelve milliliters.';
function deferred() {let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}

for(const adapter of ['memory','sqlite']) {
  async function setup() {
    const directory=await mkdtemp(join(tmpdir(),'moo-live-races-'));
    const brain:BrainPort=adapter==='memory'?new MemoryBrain():new SQLiteBrain(directory);
    const provider=new FixtureProviders(),events:AgentEvent[]=[],spoken:string[]=[],routes:string[]=[];
    let ids=0,calls=0;
    provider.respond=async()=>{calls++;return {text:answer,spokenText:'About twelve milliliters.',toolCalls:[]};};
    provider.route=async input=>{routes.push(input.text);return {route:/^Do not/.test(input.text)?'no_action':input.activeConversation?'continue_agent':'start_agent',confidence:1};};
    const agent=new Agent({brain,generation:provider,decisions:provider,search:provider,vision:provider,
      capture:{async capture(){throw Error('No capture');}},speech:{async speak(text){spoken.push(text);},async stop(){}},
      onEvent:event=>events.push(event),id:()=>`id-${++ids}`,now:()=>at});
    await agent.initialize();
    return {brain,agent,provider,events,spoken,routes,get calls(){return calls;},async close(){await agent.interrupt();await agent.drain();await brain.close();await rm(directory,{recursive:true,force:true});}};
  }

  test(`${adapter}: older asynchronous preview completion cannot replace corrected caption or suppression clearing`,async()=>{
    const t=await setup();try {
      await t.agent.startSession();const id=t.agent.getState().sessionId!;
      const speech:Segment={id:'partial',turnId:'partial',revision:1,speaker:'user',text:'Ask Ian',final:false,createdAt:at};
      await t.brain.upsertSegment(id,speech);
      const read=t.brain.getRecord.bind(t.brain),waiting=deferred(),release=deferred();let held=false;
      t.brain.getRecord=async(recordId)=>{const value=await read(recordId);if(recordId===id&&!held){held=true;waiting.resolve();await release.promise;}return value;};
      const old=(t.agent as any).emitThoughtPreview();await waiting.promise;
      await t.brain.upsertSegment(id,{...speech,revision:2,text:'Ask John'});
      await (t.agent as any).emitThoughtPreview();release.resolve();await old;
      const previews=t.events.filter(e=>e.type==='thought_preview');
      assert.equal(previews.length,1);assert.equal(previews[0]!.preview?.segments[0]?.text,'Ask John');
      // A clearing event is also authoritative over a delayed old draft read.
      const before=t.events.length,clear=deferred();
      const live=t.agent.liveThoughtPreview.bind(t.agent);let count=0;
      t.agent.liveThoughtPreview=async()=>{if(++count===1){const value=await live();await clear.promise;return value;}return undefined;};
      const obsolete=(t.agent as any).emitThoughtPreview();await new Promise(resolve=>setTimeout(resolve,0));
      await (t.agent as any).emitThoughtPreview();clear.resolve();await obsolete;
      const clearing=t.events.slice(before).filter(e=>e.type==='thought_preview');
      assert.equal(clearing.length,1);assert.equal(clearing[0]!.preview,undefined);
    }finally{await t.close();}
  });

  for(const during of ['lookup','acknowledgement'])test(`${adapter}: command correction during narration ${during} prevents stale full playback`,async()=>{
    const t=await setup();try {
      await t.agent.submitText('Moo, explain the reading.');await t.agent.drain();
      const id=t.agent.getState().conversationId!,session=t.agent.getState().sessionId!,entered=deferred(),release=deferred();let held=false;
      const get=t.brain.getState.bind(t.brain),upsert=t.brain.upsertSegment.bind(t.brain);
      t.brain.getState=async<T>(key:string)=>{const value=await get<T>(key);if(during==='lookup'&&!held&&key===`answer-narration:latest:${id}`){held=true;entered.resolve();await release.promise;}return value;};
      t.brain.upsertSegment=async(recordId,segment)=>{if(during==='acknowledgement'&&!held&&recordId===session&&segment.speaker==='assistant'&&segment.text===answer){held=true;entered.resolve();await release.promise;}return upsert(recordId,segment);};
      const playback=t.agent.submitText('Read it in full.');await entered.promise;
      const command=(await t.brain.getRecord(session))!.segments.filter(s=>s.speaker==='user').at(-1)!;
      const corrected=t.agent.ingest({...command,revision:2,text:'Do not read it in full.'});
      if(during==='lookup')await corrected;
      release.resolve();await corrected;await playback;await t.agent.drain();
      assert.equal(t.calls,1);assert.ok(!t.spoken.includes(answer));
      assert.ok(t.routes.includes('Do not read it in full.'),'Route the actual corrected request instead of the obsolete playback command');
    }finally{await t.close();}
  });

  test(`${adapter}: new speech during narration lookup cancels the earlier playback request`,async()=>{
    const t=await setup();try {
      await t.agent.submitText('Moo, explain the reading.');await t.agent.drain();
      const id=t.agent.getState().conversationId!,get=t.brain.getState.bind(t.brain),entered=deferred(),release=deferred();let held=false;
      t.brain.getState=async<T>(key:string)=>{const value=await get<T>(key);if(!held&&key===`answer-narration:latest:${id}`){held=true;entered.resolve();await release.promise;}return value;};
      const playback=t.agent.submitText('Read it in full.');await entered.promise;
      await t.agent.speechStarted();release.resolve();await playback;await t.agent.recognitionRejected();await t.agent.drain();
      assert.equal(t.calls,1);assert.ok(!t.spoken.includes(answer));
    }finally{await t.close();}
  });

  test(`${adapter}: corrected walkthrough acceptance does not skip the unspoken batch`,async()=>{
    const t=await setup();try {
      t.provider.respond=async()=>({text:Array.from({length:11},(_,i)=>`## Section ${i+1}\nEvidence ${i+1} remains uncertain.`).join('\n'),
        spokenText:'Eleven observations remain uncertain.',toolCalls:[],spokenOutline:{overview:'Eleven observations.',
          points:Array.from({length:11},(_,i)=>({label:`Section ${i+1}`,explanation:`Evidence ${i+1} remains uncertain.`,sourceSections:[i+1]}))}});
      await t.agent.submitText('Moo, explain the observations.');await t.agent.drain();
      await t.agent.submitText('Walk me through the points.');await t.agent.drain();
      assert.equal(t.agent.getState().narration?.next,5);
      const session=t.agent.getState().sessionId!,upsert=t.brain.upsertSegment.bind(t.brain),entered=deferred(),release=deferred();let held=false;
      t.brain.upsertSegment=async(recordId,segment)=>{if(!held&&recordId===session&&segment.speaker==='assistant'&&segment.text.startsWith('6. ')){held=true;entered.resolve();await release.promise;}return upsert(recordId,segment);};
      const continuation=t.agent.submitText('Yes.');await entered.promise;
      assert.equal(t.agent.getState().narration?.next,5,'Preparing a batch does not consume it');
      const command=(await t.brain.getRecord(session))!.segments.filter(s=>s.speaker==='user').at(-1)!;
      const correction=t.agent.ingest({...command,revision:2,text:'Yes please.'});release.resolve();await correction;await continuation;await t.agent.drain();
      assert.match(t.spoken.at(-1)!,/^6\. .*Evidence 6.*Evidence 10.*next points/);
      assert.doesNotMatch(t.spoken.at(-1)!,/Evidence 11/);
      assert.equal(t.spoken.filter(s=>s.startsWith('6. ')).length,1);
      assert.equal(t.agent.getState().narration?.next,10);
    }finally{await t.close();}
  });
}
