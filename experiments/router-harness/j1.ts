import { Agent } from '../../packages/agent/src/index.js';
import type { BrainPort, RouteDecision, RouteInput } from '../../packages/contracts/src/index.js';

export async function runJ1Case(item: any, brain: BrainPort, decide: (input: RouteInput) => Promise<RouteDecision>) {
  const at='2026-09-24T08:00:00.000Z',sessionId=item.id+'-session',conversationId=item.activeConversation?item.id+'-conversation':undefined;
  await brain.createRecord({id:sessionId,kind:'session',createdAt:at});
  if(conversationId)await brain.createRecord({id:conversationId,kind:'conversation',createdAt:at});
  const prior={id:item.id+'-prior-segment',turnId:item.id+'-prior-turn',revision:1,speaker:'user' as const,text:item.priorContext,final:true,createdAt:at};
  await brain.upsertSegment(sessionId,prior);
  if(conversationId)await brain.upsertSegment(conversationId,prior);
  let pendingOffer: any;
  if(item.pendingOffer) {
    const recordId=item.id+'-prior-note';await brain.createRecord({id:recordId,kind:'dictation',createdAt:at});
    await brain.upsertSegment(recordId,prior);pendingOffer={kind:item.pendingOffer,recordId};
  }
  await brain.setState('agent',{sessionId,conversationId,pendingOffer,busy:false,listening:true,webAllowed:true});
  let sequence=0,responses=0,captures=0;const speech:string[]=[],summaries:any[]=[],inputs:RouteInput[]=[],decisions:RouteDecision[]=[];
  const agent=new Agent({brain,id:()=>item.id+'-new-'+(++sequence),now:()=>at,
    decisions:{route:async(input)=>{if(inputs.length)throw new Error('Unexpected additional J1 call');inputs.push(structuredClone(input));const result=await decide(input);decisions.push(result);return result;},
      tag:async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,faithful:1,understandable:1}),connect:async()=>({})},
    generation:{summarize:async(record)=>{summaries.push({id:record.id,kind:record.kind});return {title:'Fixture note',summary:'Retained synthetic source.'};},
      respond:async()=>{responses++;return {text:'Fixture response; no task executed.',toolCalls:[]};}},
    search:{search:async()=>{throw new Error('No real search');},extract:async()=>[]},vision:{interpret:async()=>{throw new Error('No vision');}},
    capture:{capture:async()=>{captures++;throw new Error('No screen capture');}},
    speech:{speak:async(text)=>{speech.push(text);},stop:async()=>{}},
  });
  await agent.initialize();const before=agent.getState();
  const blocks:string[]=item.blocks??[item.text];
  for(const [i,text]of blocks.entries())await agent.ingest({id:item.id+'-received-'+i,turnId:item.id+'-received-turn',revision:1,speaker:'user',text,final:true,createdAt:at});
  await agent.settleTurn(item.id+'-received-turn');await agent.drain();
  const after=agent.getState(),records=await brain.listRecords();
  const sourceRetained=blocks.every(text=>records.some(r=>r.id===sessionId&&r.segments.some(s=>s.text===text)));
  const started=!before.conversationId&&!!after.conversationId,ended=!!before.conversationId&&!after.conversationId;
  const action=started?'start':ended?'end':after.pendingOffer?.kind==='general_help'?'offer_help'
    :after.pendingOffer?.kind==='clarification'||speech.some(s=>/Could you clarify|Did you want to talk/i.test(s))?'clarify'
    :conversationId&&after.conversationId===conversationId?'continue':summaries.some(s=>s.kind==='dictation')?'summary':'retain_control';
  return {id:item.id,text:item.text,expectedRoute:item.expectedRoute,expectedAction:item.expectedAction,inputs,decisions,
    gateBypassed:inputs.length===0,labelMatches:decisions[0]?decisions[0].route===item.expectedRoute:null,
    observedAction:action,actionMatches:action===item.expectedAction,incorrectStart:started&&item.expectedAction!=='start',
    incorrectStop:ended&&item.expectedAction!=='end',sourceRetained,responses,captures,speech,summaries,before,after,
    notesOnlyHonored:!item.notesOnly||after.webAllowed===false,recordCount:records.length};
}
