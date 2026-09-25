/** Test-only dependencies. No experiment policy or preview tools are enabled. */
import {Agent, type AgentOptions} from '../../packages/agent/src/index.js';
import {transcriptText, type BrainPort, type BrainRecord, type Segment} from '../../packages/contracts/src/index.js';

export const at='2026-09-24T09:00:00.000Z';
export const segment=(id:string,text:string,turnId=id,revision=1):Segment=>({id,turnId,revision,speaker:'user',text,final:true,createdAt:at});
export async function note(brain:BrainPort, item:{id:string;title:string;text:string;topic?:string}) {
  await brain.createRecord({id:item.id,kind:'note',createdAt:at});
  const r=await brain.upsertSegment(item.id,segment(item.id+'-source',item.text));
  return (await brain.updateRecord(r.id,r.revision,{title:item.title,topics:item.topic?[item.topic]:[],summary:item.text,summarySourceRevision:r.sourceRevision,quality:'ready'}))!;
}
export function rig(brain:BrainPort,prefix='test') {
  let sequence=0;
  const observed={routes:[] as any[],generations:[] as any[],speech:[] as string[],events:[] as any[],tags:[] as any[],connections:[] as any[],captures:0,webCalls:0};
  const hooks: Pick<AgentOptions,'decisions'|'generation'|'capture'|'vision'>={
    decisions:{
      route:async input=>({route:input.activeConversation?'continue_agent':'start_agent',confidence:1}),
      tag:async()=>({purposeConfidence:0,topics:{},doubt:0,faithful:1,understandable:1,relevant:1}),
      connect:async()=>({}),
    },
    generation:{summarize:async record=>({title:'Saved thought',summary:transcriptText(record)}),respond:async()=>({text:'Fixture response.',toolCalls:[]})},
    capture:{capture:async()=>({mimeType:'image/png',bytes:new Uint8Array([1,2,3])})},
    vision:{interpret:async()=> 'Prepared fixture evidence.'},
  };
  const options:AgentOptions={brain,id:()=>`${prefix}-${++sequence}`,now:()=>at,
    decisions:{route:async(input,signal)=>{const row:any={input:structuredClone(input)};observed.routes.push(row);try{return row.output=await hooks.decisions.route(input,signal);}catch(e){row.error=String(e);throw e;}},
      tag:async(input,signal)=>{const row:any={input:structuredClone(input)};observed.tags.push(row);return row.output=await hooks.decisions.tag(input,signal);},
      connect:async(record,candidates,signal)=>{const row:any={record:structuredClone(record),candidates:structuredClone(candidates)};observed.connections.push(row);return row.output=await hooks.decisions.connect(record,candidates,signal);}},
    generation:{summarize:(record,signal)=>hooks.generation.summarize(record,signal),respond:async(messages,tools,signal,settings)=>{
      const row:any={messages:structuredClone(messages),tools:structuredClone(tools),settings};observed.generations.push(row);
      try{return row.reply=await hooks.generation.respond(messages,tools,signal,settings);}catch(e){row.error=String(e);throw e;}}},
    capture:{capture:async()=>{observed.captures++;return hooks.capture.capture();}},
    vision:{interpret:(image,question,signal,options)=>hooks.vision.interpret(image,question,signal,options)},
    search:{search:async()=>{observed.webCalls++;throw new Error('External web is disabled for closeout tests');},extract:async()=>{observed.webCalls++;throw new Error('External web is disabled for closeout tests');}},
    speech:{speak:async text=>{observed.speech.push(text);},stop:async()=>{}},onEvent:event=>observed.events.push(structuredClone(event)),
  };
  return {agent:new Agent(options),hooks,observed,options};
}
export async function snapshot(brain:BrainPort,f:ReturnType<typeof rig>) {
  const records=await brain.listRecords();
  const tools=[];
  for(const record of records.filter(r=>r.kind==='conversation'))for(const generation of f.observed.generations)for(const call of generation.reply?.toolCalls??[]) {
    const result=await brain.getState(`tool:${record.id}:${call.id}`);
    if(result)tools.push({conversationId:record.id,...result as object});
  }
  return {state:f.agent.getState(),records,operations:await brain.listOperations(),observed:f.observed,tools};
}
export function userSource(records:BrainRecord[]) {return records.filter(r=>r.kind==='session').flatMap(r=>r.segments.filter(s=>s.speaker==='user')).map(s=>s.text);}
export function observedAction(before:any,after:any,generationDelta:number,recordDelta:BrainRecord[]) {
  if(!before.conversationId&&after.conversationId)return 'start';
  if(before.conversationId&&!after.conversationId)return 'stop';
  if(after.pendingOffer?.kind==='clarification')return 'clarify';
  if(after.pendingOffer?.kind==='general_help'||after.pendingOffer?.kind==='help')return 'offer';
  if(before.pendingOffer&&!after.pendingOffer&&!after.conversationId)return 'decline';
  if(before.conversationId&&after.conversationId)return generationDelta?'continue':'retained_without_response';
  if(recordDelta.some(r=>r.kind==='dictation'))return 'dictation';
  return 'no_action';
}
