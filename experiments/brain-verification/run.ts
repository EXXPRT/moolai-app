/** Synthetic evaluation through the actual Agent/Brain ports; no microphone or task side effects. */
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MemoryBrain,SQLiteBrain} from '../../packages/brain/src/index.js';
import {Agent} from '../../packages/agent/src/index.js';
import {GraphRetrieval} from '../../packages/agent/src/graph-retrieval.js';
import {ThoughtConsolidator} from '../../packages/agent/src/thoughts.js';
import {speechOutline,spokenAnswer,narratePoints,narrationDecision} from '../../packages/agent/src/response-output.js';
import {validateVision,usableVision} from '../../packages/agent/src/evidence.js';
import {note,rig,segment,at,snapshot} from '../agent-closeout/support.js';
import type {BrainPort,BrainRecord,ThoughtInput,Segment,TagInput} from '../../packages/contracts/src/index.js';
const out='.data/validation/growing-graph-20261008',mode=process.argv[2];
const fixtures=JSON.parse(await readFile('experiments/brain-verification/fixtures.json','utf8'));
await mkdir(out+'/calls',{recursive:true});
const save=async(name:string,data:unknown)=>writeFile(`${out}/${name}.json`,JSON.stringify(data,null,2)+'\n');
export async function seed(brain:BrainPort) {
  for(const item of fixtures.notes) {
    if(item.kind==='session')await brain.createRecord({id:item.id,kind:'session',createdAt:at});
    else {const r=await note(brain,item);if(item.archived)await brain.updateRecord(r.id,r.revision,{archived:true});}
  }
  for(const [a,b,provenance,decision] of fixtures.links){const r=(await brain.getRecord(a))!;await brain.updateRecord(a,r.revision,{links:[...r.links,{targetId:b,provenance,decision}]});}
}
function metric(ids:string[],q:any) {
  const required=new Set<string>(q.required),bridges=new Set<string>(q.bridges);
  const top=ids.slice(0,5),gain=(id:string)=>required.has(id)?2:bridges.has(id)?1:0;
  const dcg=top.reduce((s,id,i)=>s+(2**gain(id)-1)/Math.log2(i+2),0);
  const ideal=[...q.required.map(()=>2),...q.bridges.map(()=>1)].sort((a,b)=>b-a).slice(0,5).reduce((s,g,i)=>s+(2**g-1)/Math.log2(i+2),0);
  return {ids:top,recall:required.size?top.filter(id=>required.has(id)).length/required.size:null,ndcg:ideal?dcg/ideal:null,
    complete:required.size?q.required.every((id:string)=>top.includes(id)):null,irrelevant:top.filter(id=>!gain(id)).length,
    bridges:top.filter(id=>bridges.has(id)).length};
}
async function offline() {
 const rows=[];const brain=new MemoryBrain();await seed(brain);
 for(const q of fixtures.queries) {
  const hits=await brain.search(q.question,5,{kinds:['note','dictation','conversation']});
  const graph=new GraphRetrieval(brain,'active',q.question);await graph.retrieved(hits);
  const expansion:any[]=[];
  if(hits[0]) {
   const first=await graph.expand(hits[0].id);expansion.push(...first);
   if(first[0])expansion.push(...await graph.expand(first[0].id));
  }
  // Mirrors the controller's most recent five evidence refs, no gold-label selection.
  const combined=[...new Set([...hits.map(r=>r.id),...expansion.map(r=>r.id)])].slice(-5);
  rows.push({id:q.id,question:q.question,lexical:metric(hits.map(r=>r.id),q),graph:metric(combined,q),expansion});
 }
 await save('offline-retrieval',{policy:'Expand first lexical result, then first new neighbour. Rank neighbours by current query; keep latest five refs. No label-dependent traversal.',rows});await brain.close();
 console.log(JSON.stringify({offline:rows.length}));
}
if(mode==='offline'){await offline();process.exit(0);}
if(mode!=='paid')throw Error('Use offline or paid');
const child=spawn('backend/.venv/bin/python',['experiments/brain-verification/provider.py','paid'],{stdio:['pipe','pipe','inherit']});
let pending:any,buffer='';let readyResolve!:()=>void,readyReject!:(e:Error)=>void;const ready=new Promise<void>((r,j)=>{readyResolve=r;readyReject=j});
child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(row.ready)readyResolve();else {const cb=pending;pending=undefined;cb?.resolve(row);}}});
child.on('exit',code=>{const error=Error('Meter bridge exited '+code);readyReject(error);pending?.reject(error);});
let count=0;const calls:any[]=[],results:any[]=[];
async function rpc(method:string,input:any,area:string,workflow:string) {
 const id=`${workflow}-${method}-${++count}`;
 const reply:any=await new Promise((resolve,reject)=>{if(pending)throw Error('Concurrent inference not allowed');pending={resolve,reject};child.stdin.write(JSON.stringify({id,method,input,area,workflow})+'\n');});
 calls.push({id,method,area,workflow,...reply});await save('progress',{calls:count,latest:id,ok:reply.ok,seconds:reply.seconds});
 if(!reply.ok)throw Error(reply.error);return reply.result;
}
const recordResult=async(row:any)=>{results.push(row);await save('results',results);console.log(JSON.stringify({area:row.area,id:row.id,profile:row.profile,complete:row.complete,error:row.error,calls:count}));};
async function agentRun(q:any,graph:boolean) {
 const profile=graph?'graph':'lexical',id=`${q.id}-${profile}`,brain=new SQLiteBrain(`${out}/workspaces/${id}`);await seed(brain);
 const f=rig(brain,id);f.hooks.generation.respond=(messages,tools,_signal,options)=>rpc('respond',{messages,tools,...options},'graph',id);
 const agent=new Agent({...f.options,graphRetrieval:graph,allowedTools:['search_notes','read_note',...(graph?['related_notes']:[])]});f.agent=agent;
 const start=performance.now();let error;
 try{await agent.startSession();await agent.submitText('Moo, '+q.question+' Use only my notes.');await agent.drain();}catch(e){error=String(e);}
 const snap=await snapshot(brain,f);await recordResult({area:'graph',id:q.id,profile,seconds:(performance.now()-start)/1000,error,...snap});await brain.close();
}
async function organize(item:any,candidate:boolean) {
 const profile=candidate?'staged':'baseline',id=`${item.id}-${profile}`,brain=new SQLiteBrain(`${out}/workspaces/${id}`);
 await brain.createRecord({id:'study',kind:'session',createdAt:at});
 const publications:any[]=[],notices:string[]=[];const start=performance.now();let first:number|undefined;
 const generation={planThoughts:(i:ThoughtInput)=>rpc('plan',i,'organization',id),consolidate:(i:ThoughtInput)=>rpc('consolidate',i,'organization',id),summarize:(r:BrainRecord)=>rpc('summary',r,'organization',id),respond:async()=>({text:'',toolCalls:[]})};
 const engine=new ThoughtConsolidator({brain,generation,strategy:candidate?'plan_then_summarize':undefined,now:()=>at,notice:s=>notices.push(s),
  emit:r=>{if(r.summarySourceRevision!==undefined && r.thoughtStatus!=='draft' && !publications.some(p=>p.id===r.id&&p.summary===r.summary)){
    first??=(performance.now()-start)/1000;publications.push(structuredClone(r));}},context:async()=>'',
  enrich:async r=>{ // Normal decisions, source remains authoritative; tests score independently of Jev.
   try {const tags=await rpc('tag',{record:r,topicCandidates:r.topics} satisfies TagInput,'organization',id);await brain.setState(`evaluation-tags:${r.id}:${r.revision}`,tags);
     const candidates=(await brain.search(r.title,5,{excludeIds:[r.id,'study']}));
     if(candidates.length)await brain.setState(`evaluation-connections:${r.id}:${r.revision}`,await rpc('connect',{record:r,candidates},'organization',id));
   }catch(e){notices.push('Enrichment incomplete: '+e);}
  }});
 let error,halted=false;
 for(const [i,[speaker,text]] of item.turns.entries()) {
  const source={...segment(`s${i}`,text),speaker} as Segment;
  await brain.upsertSegment('study',source);await engine.append('study',[source]);
  if(halted)continue;
  // Each successful batch may continue; a failed provider/validation call stops the workflow.
  for(let batch=0;batch<12;batch++) {
   const before=await brain.getState<any>('thought-buffer:study');if(!before.spans.length)break;
   await engine.process('study');const after=await brain.getState<any>('thought-buffer:study');
   if(after.status==='failed'){error=after.error;halted=true;break;}
   if(JSON.stringify(after.spans)===JSON.stringify(before.spans)){error='No progress';halted=true;break;}
  }
 }
 if(!halted)await engine.process('study',true);
 const state=await brain.getState<any>('thought-buffer:study');const records=await brain.listRecords();
 const notes=records.filter(r=>r.kind==='dictation'&&r.summarySourceRevision!==undefined);
 const original=records.find(r=>r.kind==='session')!;
 const coverage=original.segments.every(s=>{const spans=notes.flatMap(n=>n.sources?.flatMap(x=>x.spans.filter(p=>p.segmentId===s.id))??[]).sort((a,b)=>a.start-b.start);let end=0;for(const p of spans){if(p.start!==end||p.revision!==s.revision)return false;end=p.end;}return end===s.text.length;});
 const complete=!state.spans.length&&state.status!=='failed'&&!halted&&original.segments.length===item.turns.length;
 await recordResult({area:'organization',id:item.id,profile,error,complete,coverage,expectedNotes:item.notes,noteCount:notes.length,
   firstSummarySeconds:first,seconds:(performance.now()-start)/1000,notes,publications,notices,buffer:state});await brain.close();
}
try {
 await ready;await offline();
 for(const [i,q] of fixtures.queries.filter((q:any)=>fixtures.liveQueries.includes(q.id)).entries())for(const graph of i%2?[true,false]:[false,true])await agentRun(q,graph);
 for(const [i,item] of fixtures.organization.entries())for(const candidate of i%2?[true,false]:[false,true])await organize(item,candidate);
 for(const item of fixtures.narration) {
  const id=item.id,brain=new MemoryBrain(),f=rig(brain,id);f.hooks.generation.respond=(messages,tools,_signal,options)=>rpc('respond',{messages,tools,...options},'narration',id);
  const agent=new Agent({...f.options,allowedTools:[]});f.agent=agent;
  await agent.startSession();await agent.submitText('Moo, explain all the main sections of this supplied synthetic answer, preserving facts and qualifications. Keep its section structure in the written answer:\n'+item.text);await agent.drain();
  const reply=f.observed.generations.at(-1)?.reply;const outline=reply?speechOutline(reply):undefined;
  const initial=[...f.observed.speech];
  if(outline && outline.points.length>5){await agent.submitText('yes');await agent.drain();await agent.submitText('continue');await agent.drain();}
  await recordResult({area:'narration',id,expectedSections:item.sections,reply,decision:reply?narrationDecision(reply):undefined,outline,initialSpeech:initial,speech:f.observed.speech,complete:!!outline&&outline.points.length===item.sections});await brain.close();
 }
 const visions=new Map<string,any>();
 for(const item of fixtures.ocr) {
  let result,error;try{result=await rpc('vision',{question:item.question,mode:item.mode??'ocr',image:{mimeType:'image/png',dataBase64:(await readFile(`${out}/images/${item.id}.png`)).toString('base64')}},'ocr',item.id);}catch(e){error=String(e);}
  const validated=result?validateVision(result,item.question,item.mode??'ocr'):undefined;visions.set(item.id,validated);
  await recordResult({area:'ocr',id:item.id,result,validated,error});
 }
 for(const id of fixtures.handoffs) {
  const image=fixtures.ocr.find((o:any)=>o.id===id),evidence=visions.get(id);if(!evidence){await recordResult({area:'handoff',id,error:'Vision unavailable'});continue;}
  let reply,error;try{reply=await rpc('respond',{messages:[{role:'system',content:'Answer only from the validated screenshot evidence. Unreadable or absent values and rejected observations cannot support facts. State limitations. Do not infer missing identifiers. Retained interpretation is not factual evidence.'},{role:'user',content:image.question+'\nValidated evidence:\n'+JSON.stringify(usableVision(evidence))}],tools:[],responseMode:'answer_only'},'handoff',`handoff-${id}`);}catch(e){error=String(e);}
  await recordResult({area:'handoff',id,reply,error,evidence:usableVision(evidence)});
 }
}finally{child.stdin.end();await save('call-index',calls);}
