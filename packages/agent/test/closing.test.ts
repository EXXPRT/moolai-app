import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import {Agent} from '../src/index.js';
import {prepare} from '../../../experiments/j1-closing/scenario.js';
import type {RouteDecision} from '../../contracts/src/index.js';
const close:RouteDecision={route:'end_agent',confidence:.9,substantiveContentProbability:0};
for(const storage of ['memory','sqlite'] as const) {
  for(const check of ['accept','decline','low confidence','continuation','silence','provider failure','restart','corrected source','late result','corrected reply','finish work','cancel work','continue work','task question','default unchanged'] as const) {
    test(`${storage}: contextual closing ${check}`,async()=>{
      const dir=await mkdtemp(join(tmpdir(),'moolai-closing-'));
      let brain=storage==='memory'?new MemoryBrain():new SQLiteBrain(dir);
      try {
        const busy=check.endsWith('work');
        const {f,release}=await prepare(brain,{id:'fixture',text:null,expected:'open',context:busy?'busy':check==='task question'?'task':'closing'},check==='default unchanged'?'current':'contextual');
        const conversation=f.agent.getState().conversationId!;
        const session=f.agent.getState().sessionId!;
        const priorRoutes=f.observed.routes.length;
        f.hooks.decisions.route=async()=>close;
        if(check==='restart') {
          if(brain instanceof SQLiteBrain){brain.close();brain=new SQLiteBrain(dir);}
          f.agent=new Agent({...f.options,brain,closingPolicy:'contextual'});
          await f.agent.initialize();await f.agent.drain();
          assert.equal(f.agent.getState().pendingOffer?.kind,'close');
          await f.agent.startSession();
        }
        if(check==='decline')f.hooks.decisions.route=async()=>({route:'no_action',confidence:1});
        if(check==='low confidence')f.hooks.decisions.route=async()=>({...close,confidence:.79});
        if(check==='continuation')f.hooks.decisions.route=async()=>({route:'continue_agent',confidence:.3});
        if(check==='provider failure')f.hooks.decisions.route=async()=>{throw new Error('simulated unavailable');};
        if(check==='task question'||check==='default unchanged'){
          assert.equal(f.agent.getState().pendingOffer,undefined);
          f.hooks.decisions.route=async input=>{assert.equal(input.pendingOffer,undefined);return {route:'continue_agent',confidence:1};};
        }
        const original=(await brain.getRecord(session))!.segments.find(s=>s.speaker==='user')!;
        const correct=()=>f.agent.ingest({...original,text:'Keep this conversation open; I have more questions.',revision:original.revision+1});
        if(check==='corrected source')await correct();
        let finishing:Promise<void>|undefined;
        if(check==='late result'){
          let ready!:()=>void,done!: (d:RouteDecision)=>void;
          const started=new Promise<void>(r=>ready=r);
          f.hooks.decisions.route=async()=>{ready();return new Promise<RouteDecision>(r=>done=r);};
          finishing=f.agent.submitText('Yes.');await started;await correct();done(close);
        } else if(check==='corrected reply') {
          let ready!:()=>void,done!: (d:RouteDecision)=>void;let count=0;
          const started=new Promise<void>(r=>ready=r);
          f.hooks.decisions.route=async()=>{if(++count===1){ready();return new Promise<RouteDecision>(r=>done=r);}return {route:'no_action',confidence:1};};
          finishing=f.agent.submitText('Yes.');await started;
          const reply=(await brain.getRecord(session))!.segments.filter(s=>s.speaker==='user').at(-1)!;
          await f.agent.ingest({...reply,text:'No, keep talking.',revision:reply.revision+1});done(close);
        } else if(check!=='silence') {
          if(busy)f.hooks.decisions.route=async()=>({route:check==='continue work'?'no_action':'end_agent',confidence:1,endAction:check==='finish work'?'finish':check==='cancel work'?'cancel':'continue'});
          finishing=f.agent.submitText(check==='decline'?'No, keep it open.':check==='continuation'?'Explain the second idea.':'Yes.');
        }
        if(check==='provider failure')await assert.rejects(finishing!,/simulated unavailable/);
        else await finishing;
        release();await f.agent.drain();
        const shouldClose=['accept','restart','finish work','cancel work'].includes(check);
        assert.equal(!f.agent.getState().conversationId,shouldClose);
        assert.equal(f.agent.getState().listening,true,'closing never stops capture');
        assert.ok(await brain.getRecord(conversation),'same source remains retained');
        if(check==='silence')assert.equal(f.observed.routes.length,priorRoutes);
        if(check==='provider failure')assert.equal(f.observed.routes.length,priorRoutes+1,'no automatic retry');
        if(check==='continuation')assert.ok(!f.observed.speech.some(s=>s.includes('Could you clarify')));
        if(check==='decline')assert.equal(f.agent.getState().pendingOffer,undefined);
        if(check==='low confidence') {
          assert.equal(f.agent.getState().pendingOffer,undefined,'clarification supersedes the closing question');
          f.hooks.decisions.route=async input=>{assert.equal(input.pendingOffer,undefined);return {route:'continue_agent',confidence:1};};
          await f.agent.submitText('Yes.');await f.agent.drain();
          assert.equal(f.agent.getState().conversationId,conversation);
        }
      } finally {if(brain instanceof SQLiteBrain)brain.close();await rm(dir,{recursive:true,force:true});}
    });
  }
}
