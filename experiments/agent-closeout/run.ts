/** Current production Agent, real isolated Brain tools, metered production providers. */
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,access,readdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteBrain} from '../../packages/brain/src/index.js';
import {transcriptText} from '../../packages/contracts/src/index.js';
import {rig,note,segment,snapshot,userSource,observedAction} from './support.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const corpus=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const images=JSON.parse(await readFile(new URL('./images/manifest.json',import.meta.url),'utf8'));
const experiment='agent_closeout_20260924_v1';
if(!process.argv.includes('--live')){console.log(JSON.stringify({experiment,paidCalls:0,cases:corpus,images},null,2));process.exit(0);}
if(!process.argv.includes('--allow-paid'))throw Error('--allow-paid required');
const directory=path.join(root,'.data',experiment);
if(await access(directory).then(()=>true,()=>false))throw Error('Run exists. No overwrite, retries or automatic resume.');
await mkdir(directory,{recursive:true,mode:0o700});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function files(relative:string):Promise<string[]>{return (await Promise.all((await readdir(path.join(root,relative),{withFileTypes:true})).filter(e=>!e.name.startsWith('.')&&e.name!=='__pycache__').map(e=>e.isDirectory()?files(relative+'/'+e.name):[relative+'/'+e.name]))).flat();}
const sources=[...await files('experiments/agent-closeout'),...await files('packages/agent/src'),...await files('packages/brain/src'),...await files('packages/contracts/src'),
  'backend/moolai_backend/providers.py','backend/moolai_backend/schemas.py','backend/moolai_backend/settings.py','backend/moolai_backend/validate_live.py','native/MoolaiNative.swift','native/TranscriptAssembler.swift'];
const freeze={experiment,frozenAt:new Date().toISOString(),sourceHashes:Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(path.join(root,p)))]))),
  preflight:JSON.parse(await readFile(path.join(root,'.data/agent-closeout-preflight-20260924.json'),'utf8')),
  settings:{productionPolicy:true,threshold:.8,responseCallsPerTurn:6,temperature:.2,reasoning:'provider-default',outputCaps:{summary:1200,respond:2400,vision:1600},noRetries:true},
  scoring:corpus.scoring};
await writeFile(path.join(directory,'freeze.json'),JSON.stringify(freeze,null,2)+'\n',{flag:'wx'});
const report:any={experiment,startedAt:new Date().toISOString(),complete:false,productionDefaultsChanged:false,freeze,calls:[],j1:[],answers:[],ocr:[],enrichment:[],limitations:[
  'No microphone, voice acceptance, backend acceptance or release/CI work. Speech output recorded by a test port, not played.',
  'J1 tests use live Jev and fixture answers/enrichment. Answer and OCR tests isolate live production generation behind deterministic routing. Enrichment uses live Nano/J7/J6 behind deterministic dictation routing.',
  'Actual Brain search/read/create tools operate only on synthetic SQLite records; external web is disabled. Retrieval failure cases deliberately inject storage errors.',
  'OCR o01 uses fresh native capture of a controlled fullscreen worksheet; remaining images enter the same controller capture/vision path through a fixture CapturePort. This is not final renderer acceptance.',
  'No model or prompt tuning during this frozen run. Prose correctness is manually reviewed separately from deterministic source/tool assertions.'
]};
async function save(){await writeFile(path.join(directory,'report.tmp'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(path.join(directory,'report.tmp'),path.join(directory,'report.json'));}
async function processJson(command:string,args:string[],input?:unknown):Promise<any>{return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:root,env:{PATH:process.env.PATH??'',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>child.kill(),120000);
  child.stdout.on('data',data=>{out+=data;if(out.length>5_000_000)child.kill();});child.stderr.on('data',data=>{err=(err+data).slice(-2000);});
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(`Process failed (${code}); no retry: ${err} ${out.slice(-1000)}`));try{resolve(JSON.parse(out));}catch{reject(Error('Invalid process result; no retry'));}});
  child.stdin.end(input===undefined?undefined:JSON.stringify(input));
});}
const counts=new Map<string,number>();
async function invoke(caseId:string,method:string,input:unknown){
  const key=caseId+':'+method;const step=(counts.get(key)??0)+1;counts.set(key,step);
  const req={callId:`${experiment}:${caseId}:${method}:${step}`,caseId,method,step,input:structuredClone(input)};
  const entry=await processJson(path.join(root,'backend/.venv/bin/python'),['experiments/agent-closeout/provider.py','--freeze',path.join(directory,'freeze.json')],req)
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
    row.userSource=userSource(row.records);await brain.close();await save();
    console.log(JSON.stringify({group,id:c.id,status:row.status,restart:row.restartRetained,calls:report.calls.filter((r:any)=>r.caseId===c.id).length}));
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
    row.turns.push({text,expected:turn.action,observedAction:action,actionMatches:action===turn.action,before,after,routes:f.observed.routes.slice(oldR),generationDelta:f.observed.generations.length-oldG,
      assembledTextPreserved:turn.blocks?f.observed.routes.slice(oldR).some(r=>r.input.text===text):true});
  }
});
for(const c of corpus.answers)await withBrain('answers',c,async(f,brain,row)=>{
  for(const item of c.notes)await note(brain,item);
  f.hooks.generation.respond=(messages,tools)=>invoke(c.id,'respond',{messages,tools});row.turns=[];
  const search=brain.search.bind(brain);
  for(const [index,request]of c.turns.entries()){
    if(index===1&&c.correction){const saved=(await brain.getRecord(c.correction.id))!;await brain.upsertSegment(saved.id,segment(saved.id+'-source',c.correction.text,saved.id+'-source',2));row.correctedRecord=await brain.getRecord(saved.id);}
    brain.search=c.failSearchOnTurn===index+1?async()=>{throw Error('Synthetic storage lookup unavailable');}:search;
    const before=f.observed.generations.length;await f.agent.submitText(request);await f.agent.drain();
    row.turns.push({request,generations:f.observed.generations.slice(before),state:f.agent.getState(),answer:f.observed.generations.slice(before).filter(g=>g.reply?.text&&!g.reply.toolCalls.length).at(-1)?.reply.text??null});
  }
  brain.search=search;
});
for(const c of images)await withBrain('ocr',c,async(f,brain,row)=>{
  f.hooks.generation.respond=(messages,tools)=>invoke(c.id,'respond',{messages,tools});
  f.hooks.vision.interpret=(image,question)=>invoke(c.id,'vision',{image,question});
  f.hooks.capture.capture=async()=>{
    let file=path.join(root,'experiments/agent-closeout/images',c.image);
    if(c.id==='o01'){
      file=path.join(directory,'native-capture.png');
      row.capture=await processJson(path.join(root,'node_modules/.bin/electron'),['experiments/agent-closeout/screen.cjs',path.join('experiments/agent-closeout/images',c.image),file]);
    }
    const bytes=await readFile(file);row.imageSha256=hash(bytes);return {mimeType:'image/png',bytes};
  };
  await f.agent.submitText(c.question);await f.agent.drain();
});
for(const c of corpus.enrichment)await withBrain('enrichment',c,async(f,brain,row)=>{
  for(const item of corpus.relatedNotes)await note(brain,item);
  if(c.subject)await f.agent.setSubject(c.subject);
  f.hooks.generation.summarize=record=>invoke(c.id,'summary',{record});
  f.hooks.decisions.tag=input=>invoke(c.id,'tag',input);
  f.hooks.decisions.connect=(record,candidates)=>invoke(c.id,'connect',{record,candidates});
  f.hooks.decisions.route=async()=>({route:'dictate',confidence:1});
  if(c.manualSummary){
    const r=await note(brain,{id:c.id+'-record',title:'Workshop record',text:c.text});
    await brain.updateRecord(r.id,r.revision,{summary:c.manualSummary,manualFields:['summary'],quality:'pending'});
    await f.agent.queueEnrichment(r.id);
  }else await f.agent.submitText(c.text);
  await f.agent.drain();
  row.result=(await brain.listRecords()).find(r=>r.kind==='dictation'||r.id===c.id+'-record');
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
