/** Synthetic paired dialogues; production controller, simulated task/voice providers. */
import {Agent} from '../../packages/agent/src/index.js';
import type {BrainPort, AgentReply} from '../../packages/contracts/src/index.js';
import {rig} from '../agent-closeout/support.js';
export type Case = {id:string;text:string|null;context?:string;expected:'open'|'closed';work?:boolean;ambiguous?:boolean;endAction?:string};
export async function prepare(brain:BrainPort, item:Case, policy:'current'|'contextual') {
  const f=rig(brain,'paired');
  let release:()=>void=()=>{};
  const options={...f.options,closingPolicy:'contextual' as 'current'|'contextual'};
  f.agent=new Agent(options);
  f.hooks.generation.respond=async()=>item.context==='closing'
    ? {text:'The two ideas are saved separately.',toolCalls:[],controlProposal:{action:'offer_close',reason:'The requested explanation is complete.'}}
    : {text:item.context==='task'?'Would you like the shorter version?':'The two ideas are saved separately.',toolCalls:[]};
  await f.agent.initialize();await f.agent.startSession();
  await f.agent.submitText('Moo, help me distinguish these two study ideas.');await f.agent.drain();
  // Both methods see exactly the same stored dialogue, including the closing question.
  // Only the candidate retains the typed question state. No expected labels reach J1.
  // The policy is switched on the same instance: a restart would end the session, and the next Start closes the
  // conversation (MOO-075). The closing question stays in the session that receives the reply.
  options.closingPolicy=policy;
  const state=f.agent.getState();
  if(policy==='current'&&state.pendingOffer?.kind==='close') {
    (f.agent as unknown as {state:typeof state}).state.pendingOffer=undefined;
    state.pendingOffer=undefined;await brain.setState('agent',state);
  }
  f.hooks.generation.respond=async()=>({text:'The requested follow-up is retained.',toolCalls:[]});
  if(item.context==='busy') {
    let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    f.hooks.generation.respond=async(_m,_t,signal)=>{
      entered();return await new Promise<AgentReply>(resolve=>{
        release=()=>resolve({text:'The requested fixture work is complete.',toolCalls:[]});
        signal?.addEventListener('abort',release,{once:true});
      });
    };
    await f.agent.submitText('Please organize the two ideas.');await started;
    await f.agent.requestEnd();
  }
  return {f,release};
}
