/** Frozen, bounded production regression. The default invocation makes no paid calls. */
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,access,readdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteBrain} from '../../packages/brain/src/index.js';
import {rig,note,segment,snapshot,userSource,observedAction} from '../agent-closeout/support.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const corpus=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const experiment='agent_final_regression_20260925_v1';
const directory=path.join(root,'.data',experiment);
const freezePath=path.join(directory,'freeze.json');
const preflightPath=path.join(root,'.data/agent-final-regression-preflight.json');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function files(relative:string):Promise<string[]>{return (await Promise.all((await readdir(path.join(root,relative),{withFileTypes:true})).filter(e=>!e.name.startsWith('.')&&e.name!=='__pycache__').map(e=>e.isDirectory()?files(relative+'/'+e.name):[relative+'/'+e.name]))).flat();}
async function processJson(command:string,args:string[],input?:unknown):Promise<any>{return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:root,env:{PATH:process.env.PATH??'',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>child.kill(),120000);
  child.stdout.on('data',data=>{out+=data;if(out.length>5_000_000)child.kill();});child.stderr.on('data',data=>{err=(err+data).slice(-2000);});
  child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(`Process failed (${code}); no retry: ${err} ${out.slice(-1000)}`));try{resolve(JSON.parse(out));}catch{reject(Error('Invalid process result; no retry'));}});
  child.stdin.end(input===undefined?undefined:JSON.stringify(input));
});}
if(process.argv.includes('--freeze')){
  if(process.argv.includes('--live'))throw Error('Freeze and dispatch must be separate commands.');
  if(await access(directory).then(()=>true,()=>false))throw Error('Freeze/run already exists; do not overwrite it.');
  const preflight=JSON.parse(await readFile(preflightPath,'utf8'));
  const age=Date.now()-Date.parse(preflight.at);
  if(!Number.isFinite(age)||age<0||age>=4*60*60*1000)throw Error('Fresh read-only preflight required.');
  if(preflight.historicalLedger.reservedUsd!=='23.536'||preflight.inferenceCalls!==0)throw Error('Unexpected preflight.');
  const sources=[...await files('experiments/agent-final-regression'),...await files('packages/agent/src'),...await files('packages/brain/src'),...await files('packages/contracts/src'),
    'experiments/agent-closeout/support.ts',...corpus.ocr.map((c:any)=>c.image),
    'backend/moolai_backend/providers.py','backend/moolai_backend/schemas.py','backend/moolai_backend/settings.py','backend/moolai_backend/validate_live.py','package-lock.json'];
  const freeze={experiment,frozenAt:new Date().toISOString(),sourceHashes:Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(path.join(root,p)))]))),preflight,
    settings:{productionPolicy:true,threshold:.8,responseCallsPerTurn:6,temperature:.2,reasoning:'provider-default',outputCaps:{summary:1200,respond:2400,vision:1600},textBytes:16000,inputTokenAllowance:20000,noRetries:true,runCapUsd:4,cumulativeCapUsd:35.87},scoring:corpus.scoring};
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(freezePath,JSON.stringify(freeze,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({experiment,paidCalls:0,freeze:freezePath,sourceCount:sources.length}));process.exit(0);
}
if(!process.argv.includes('--live')){console.log(JSON.stringify({experiment,paidCalls:0,corpus},null,2));process.exit(0);}
if(!process.argv.includes('--allow-paid'))throw Error('--allow-paid required');
const freeze=JSON.parse(await readFile(freezePath,'utf8'));
for(const [relative,expected]of Object.entries(freeze.sourceHashes))if(hash(await readFile(path.join(root,relative)))!==expected)throw Error('Frozen source changed: '+relative);
await writeFile(path.join(directory,'dispatch-started.json'),JSON.stringify({at:new Date().toISOString()})+'\n',{flag:'wx'});
const report:any={experiment,startedAt:new Date().toISOString(),complete:false,freeze,calls:[],j1:[],answers:[],ocr:[],enrichment:[],limitations:[
  'No microphone, private screenshots, live voice acceptance or web requests. All screen images and notes are synthetic.',
  'J1 uses live Jev with fixture answers/enrichment. Agent workflows use live Ultra with deterministic routing and fixture enrichment; enrichment cases use live Nano/J7/J6. OCR uses live MiniCPM and Ultra.',
  'The unchanged production Agent executes read/search/create only against isolated SQLite experiment records. Controlled retrieval failures measure recovery, not their occurrence rate.',
  'Source retention, actions and tool execution are observed. Prose correctness needs manual claim review; diagnostic fact presence is not a correctness score.',
  'Safe abstention is separate from correct intended behavior. No model settings or prompts change after freezing. Previous closeout images are reused regression evidence, not held-out OCR data.'
]};
async function save(){await writeFile(path.join(directory,'report.tmp'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(path.join(directory,'report.tmp'),path.join(directory,'report.json'));}
const counts=new Map<string,number>();
async function invoke(caseId:string,method:string,input:unknown){
  const key=caseId+':'+method;const step=(counts.get(key)??0)+1;counts.set(key,step);
  const req={callId:`${experiment}:${caseId}:${method}:${step}`,caseId,method,step,input:structuredClone(input)};
  const entry=await processJson(path.join(root,'backend/.venv/bin/python'),['experiments/agent-final-regression/provider.py','--freeze',freezePath],req)
    .catch(error=>({...req,status:'process_failed_unknown_charge',error:String(error),reservedUsd:'unknown'}));
  report.calls.push(entry);await save();
  if(entry.status!=='succeeded')throw Error(entry.error??'Provider failed');return entry.output;
}
async function withBrain(group:string,c:any,work:(f:ReturnType<typeof rig>,brain:SQLiteBrain,row:any)=>Promise<void>){
  const folder=path.join(directory,'brains',c.id);let brain=new SQLiteBrain(folder);const f=rig(brain,c.id);const row:any={id:c.id,input:c,status:'incomplete'};report[group].push(row);
  try{await f.agent.initialize();await work(f,brain,row);await f.agent.drain();row.status='completed';}
  catch(error){row.error=String(error);await f.agent.drain();}
  finally{
    Object.assign(row,await snapshot(brain,f));
    const before=JSON.stringify(row.records),state=JSON.stringify(await brain.getState('agent')),ops=JSON.stringify(row.operations);
    await brain.close();brain=new SQLiteBrain(folder);
    row.restartRetained=before===JSON.stringify(await brain.listRecords())&&state===JSON.stringify(await brain.getState('agent'))&&ops===JSON.stringify(await brain.listOperations());
    row.userSource=userSource(row.records);await brain.close();
    row.providerFailures=report.calls.filter((r:any)=>r.caseId===c.id&&r.status!=='succeeded').length;
    if(row.providerFailures)row.status='incomplete';
    await save();console.log(JSON.stringify({group,id:c.id,status:row.status,restart:row.restartRetained,calls:report.calls.filter((r:any)=>r.caseId===c.id).length}));
  }
}
for(const c of corpus.j1)await withBrain('j1',c,async(f,brain,row)=>{
  f.hooks.decisions.route=input=>invoke(c.id,'route',input);row.turns=[];
  for(const [index,turn]of c.turns.entries()){
    const before=f.agent.getState(),oldRecords=await brain.listRecords(),oldG=f.observed.generations.length,oldR=f.observed.routes.length;
    const text=turn.text??turn.blocks.join(' ');
    if(turn.blocks){for(const [i,block]of turn.blocks.entries())await f.agent.ingest(segment(`${c.id}-block-${i}`,block,`${c.id}-turn-${index}`));await f.agent.settleTurn(`${c.id}-turn-${index}`);}
    else await f.agent.submitText(text);
    await f.agent.drain();
    const after=f.agent.getState(),records=await brain.listRecords();
    const action=observedAction(before,after,f.observed.generations.length-oldG,records.filter(r=>!oldRecords.some(old=>old.id===r.id)));
    const matches=(turn.allowedActions??[turn.action]).includes(action);
    row.turns.push({text,expected:turn.allowedActions??[turn.action],observedAction:action,actionMatches:matches,
      classification:matches?'matched':action==='clarify'?'safe_abstention':(action==='start'||action==='stop')?'wrong_transition':'review',
      before,after,routes:f.observed.routes.slice(oldR),generationDelta:f.observed.generations.length-oldG,
      assembledTextPreserved:turn.blocks?f.observed.routes.slice(oldR).some(r=>r.input.text===text):true});
  }
});
for(const c of corpus.answers)await withBrain('answers',c,async(f,brain,row)=>{
  for(const item of c.notes)await note(brain,item);
  f.hooks.generation.respond=(messages,tools,_signal,options)=>invoke(c.id,'respond',{messages,tools,responseMode:options?.responseMode??'auto'});row.turns=[];
  const search=brain.search.bind(brain);
  for(const [index,request]of c.turns.entries()){
    if(index===1&&c.correction){const saved=(await brain.getRecord(c.correction.id))!;await brain.upsertSegment(saved.id,segment(saved.id+'-source',c.correction.text,saved.id+'-source',2));row.correctedRecord=await brain.getRecord(saved.id);}
    brain.search=c.failSearchOnTurn===index+1?async()=>{throw Error('Synthetic storage lookup unavailable');}:search;
    const before=f.observed.generations.length;await f.agent.submitText(request);await f.agent.drain();
    row.turns.push({request,generations:f.observed.generations.slice(before),state:f.agent.getState(),answer:f.observed.generations.slice(before).filter(g=>g.reply?.text&&!g.reply.toolCalls.length).at(-1)?.reply.text??null});
  }
  brain.search=search;
  if(c.expected.createdTitle)row.createdNotes=(await brain.listRecords()).filter(r=>r.kind==='note'&&!c.notes.some((n:any)=>n.id===r.id));
});
for(const c of corpus.ocr)await withBrain('ocr',c,async(f,_brain,row)=>{
  f.hooks.generation.respond=(messages,tools,_signal,options)=>invoke(c.id,'respond',{messages,tools,responseMode:options?.responseMode??'auto'});
  f.hooks.vision.interpret=(image,question)=>invoke(c.id,'vision',{image,question});
  f.hooks.capture.capture=async()=>{const bytes=await readFile(path.join(root,c.image));row.imageSha256=hash(bytes);return {mimeType:'image/png',bytes};};
  await f.agent.submitText(c.question+' Use only my notes and this screen.');await f.agent.drain();
});
for(const c of corpus.enrichment)await withBrain('enrichment',c,async(f,brain,row)=>{
  for(const item of corpus.relatedNotes)await note(brain,item);
  if(c.subject)await f.agent.setSubject(c.subject);
  f.hooks.generation.summarize=record=>invoke(c.id,'summary',{record});
  f.hooks.decisions.tag=input=>invoke(c.id,'tag',input);
  f.hooks.decisions.connect=(record,candidates)=>invoke(c.id,'connect',{record,candidates});
  f.hooks.decisions.route=async()=>({route:'dictate',confidence:1});
  await f.agent.submitText(c.text);await f.agent.drain();
  row.result=(await brain.listRecords()).find(r=>r.kind==='dictation');
  row.searchable=(await brain.search(c.text,20)).some(r=>r.id===row.result?.id);
  row.sourceRetained=row.result&&row.result.segments.map((s:any)=>s.text).join('\n')===c.text;
  row.suggestedLinkBound=row.result.links.filter((l:any)=>l.provenance==='suggested').length<=5;
  row.expectedConnection=row.result.links.some((l:any)=>l.targetId===c.related&&l.provenance==='suggested');
});
report.complete=true;report.finishedAt=new Date().toISOString();
const ledger=JSON.parse(await readFile(path.join(root,'.data/provider-validation.json'),'utf8'));
report.reservations=ledger.calls.filter((r:any)=>r.validation===experiment);
report.newReservedUsd=report.reservations.reduce((n:number,r:any)=>n+Number(r.reservedUsd),0);
report.cumulativeReservedUsd=ledger.calls.reduce((n:number,r:any)=>n+Number(r.reservedUsd),0);
await save();console.log(JSON.stringify({complete:true,calls:report.calls.length,reserved:report.newReservedUsd,report:path.join(directory,'report.json')}));
