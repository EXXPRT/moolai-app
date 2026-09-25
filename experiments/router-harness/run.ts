/** Isolated experiment. Preview by default; offline fixtures and live results remain distinct. */
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,access,readdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteBrain} from '../../packages/brain/src/index.js';
import {nativeResponseRunner, type ResponseRunner} from '../../packages/agent/src/response-runner.js';
import type {AgentReply} from '../../packages/contracts/src/index.js';
import {createNanobotRunner} from './nanobot.js';
import {runWorkflow,scoreRun} from './workflow.js';
import {runJ1Case} from './j1.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const load=async(p:string)=>JSON.parse(await readFile(path.join(root,p),'utf8'));
const closed=await load('experiments/evaluation/closed-task-cases.json');
const legacy=await load('experiments/fixtures/agent-harness-cases.json');
const routers=await load('experiments/router-harness/router-cases.json');
const j1=await load('experiments/router-harness/j1-cases.json');
const policy=await load('experiments/router-harness/router-policy.json');
const args=process.argv.slice(2),mode=args.includes('--live')?'live':args.includes('--offline')?'offline':'preview';
const EXPERIMENT='router_harness_20260924_v1';
if(mode==='preview') {
  console.log(JSON.stringify({mode,paidCalls:0,maximumReservationUsd:'5.97',cumulativeCeilingUsd:'25.87',
    agentCases:closed.cases.map((c:any)=>({id:c.id,request:c.request})),j1Cases:j1.cases.map((c:any)=>({id:c.id,text:c.text,activeConversation:c.activeConversation})),
    complexityCases:routers.cases.map((c:any)=>({id:c.id,request:c.request})),harnesses:['native','nanobot','codex (local qualification incomplete)']},null,2));process.exit(0);
}
if(mode==='live'&&!args.includes('--allow-paid'))throw new Error('--allow-paid is required');
if(args.includes('--live')&&args.includes('--offline'))throw new Error('Choose one mode');
const dirArg=args.indexOf('--directory'),directory=path.resolve(dirArg>=0?args[dirArg+1]!:path.join(root,'.data',EXPERIMENT+'-'+mode));
if(await access(directory).then(()=>true,()=>false))throw new Error('Run directory exists; no overwrite or automatic resume');
await mkdir(directory,{recursive:true,mode:0o700});
const report:any={experiment:EXPERIMENT,mode,startedAt:new Date().toISOString(),complete:false,productionDefaultsChanged:false,
  budget:{maximumReservationUsd:'5.97',cumulativeCeilingUsd:'25.87'},calls:[],compatibility:[],complexity:[],j1:[],runs:[],
  limitations:['Synthetic notes and tool effects; no real tasks, microphone or OCR.','Structured extraction scores do not grade general prose quality.',
    'Eight end-to-end cases emphasize retrieval/recovery; high-complexity planning is classified but not answered in this small corpus.',
    'Codex excluded after local capability/payload qualification failed; no model substituted.',
    'Observed current controller calls J1 once per completed active turn; it does not implement the earlier ordinary-turn bypass design. Three blocks remain one assembled request.']};
let saving=Promise.resolve();
async function save(){const value=JSON.stringify(report,null,2)+'\n';const next=saving.then(async()=>{await writeFile(path.join(directory,'report.tmp'),value,{mode:0o600});await rename(path.join(directory,'report.tmp'),path.join(directory,'report.json'));});saving=next.catch(()=>{});await next;}
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function filesUnder(relative:string):Promise<string[]> {
  const rows=await readdir(path.join(root,relative),{withFileTypes:true});
  return (await Promise.all(rows.filter(e=>!e.name.startsWith('.')&&e.name!=='__pycache__').map(e=>e.isDirectory()?filesUnder(relative+'/'+e.name):Promise.resolve([relative+'/'+e.name])))).flat();
}
const sources=[...await filesUnder('experiments/router-harness'),...await filesUnder('packages/agent/src'),...await filesUnder('packages/brain/src'),...await filesUnder('packages/contracts/src'),
  'experiments/evaluation/closed-task-cases.json','experiments/evaluation/requirements-nanobot.lock','experiments/fixtures/agent-harness-cases.json','scripts/harness-fixtures.mjs',
  'scripts/evaluation-metrics.mjs','backend/moolai_backend/providers.py','backend/moolai_backend/schemas.py','backend/moolai_backend/settings.py','backend/moolai_backend/validate_live.py'];
const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(path.join(root,p)))])));
const preflight=mode==='live'?await load('.data/router-harness-preflight-20260924.json'):undefined;
const freeze={experiment:EXPERIMENT,sourceHashes,preflight,settings:{temperature:.2,maxOutputTokens:4000,maxInputTokenAllowance:15000,maxWireBytes:12000,reasoning:'provider-default',maxCallsPerCase:6,threshold:.8},
  frozenAt:new Date().toISOString(),corpusSha256:hash(await readFile(path.join(root,'experiments/evaluation/closed-task-cases.json')))};
await writeFile(path.join(directory,'freeze.json'),JSON.stringify(freeze,null,2)+'\n',{flag:'wx'});
report.freeze=freeze;
let routingBrain=new SQLiteBrain(path.join(directory,'routing-brain'));
async function persistSource(id:string,text:string) {
  await routingBrain.createRecord({id,kind:'session',createdAt:'2026-09-24T08:00:00.000Z'});
  await routingBrain.upsertSegment(id,{id:id+'-source',turnId:id+'-source',revision:1,speaker:'user',text,final:true,createdAt:'2026-09-24T08:00:00.000Z'});
}
async function invoke(phase:string,caseId:string,profile:string,modelProfile:string,step:number,input:unknown,fixture:()=>unknown):Promise<any> {
  const request={callId:`${EXPERIMENT}:${phase}:${caseId}:${profile}:${modelProfile}:${step}`,phase,caseId,profile,modelProfile,step,input:structuredClone(input)};
  let entry:any;
  if(mode==='offline')entry={...request,status:'fixture',output:fixture(),reservedUsd:'0',elapsedMs:0};
  else entry=await new Promise((resolve,reject)=>{
    const child=spawn(path.join(root,'backend/.venv/bin/python'),[path.join(root,'experiments/router-harness/provider.py'),'--freeze',path.join(directory,'freeze.json')],
      {cwd:root,env:{PATH:process.env.PATH??'',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
    child.stdout.on('data',b=>{out+=b;if(out.length>2_000_000)child.kill('SIGTERM');});child.stderr.on('data',b=>{err=(err+b).slice(-2000);});
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Provider process failed; no retry: '+err));try{resolve(JSON.parse(out));}catch{reject(new Error('Invalid provider evidence; no retry'));}});
    child.stdin.end(JSON.stringify(request));
  }).catch(error=>({...request,status:'process_failed_unknown_charge',error:String(error),reservedUsd:'unknown',elapsedMs:0}));
  report.calls.push(entry);await save();
  if(!['succeeded','fixture'].includes(entry.status))throw new Error(entry.error??'Provider call failed');
  return entry.output;
}
const runners:Record<string,ResponseRunner>={native:nativeResponseRunner,nanobot:createNanobotRunner()};
async function qualify(profile:string,model:string) {
  const tool={name:'read_note',description:'Read the synthetic note',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}};
  let used=0;const observed:any[]=[];const row:any={profile,model,status:'incomplete'};report.compatibility.push(row);
  try {
    const result=await runners[profile]!.run({messages:[{role:'user',content:'First call read_note with id fixture-marker. Then return its marker as digits only. Use only my notes.'}],signal:new AbortController().signal,maxSteps:2,
      prepare:async(messages,step)=>({messages,tools:step===0?[tool]:[],responseMode:step===0?'auto':'answer_only'}),
      generate:async(frame)=>{used++;return invoke('compatibility','compatibility',profile,model,used,frame,()=>used===1?{text:'',toolCalls:[{id:'read-marker',name:'read_note',arguments:{id:'fixture-marker'}}]}:{text:'73',toolCalls:[]});},
      execute:async(call)=>{if(call.name!=='read_note'||call.arguments.id!=='fixture-marker')throw new Error('Invalid compatibility tool');observed.push(call);return {id:'fixture-marker',revision:1,marker:73};},checkpoint:async()=>{}});
    row.answer=result.reply?.text;row.status=used===2&&observed.length===1&&result.reply?.text.trim()==='73'?'qualified':'incomplete';
  } catch(error){row.error=String(error);}
  row.calls=used;row.observedTools=observed;await save();console.log(JSON.stringify({phase:'compatibility',profile,model,status:row.status}));return row.status==='qualified';
}
const oracle=(c:any)=>({status:c.expected.status,facts:c.expected.facts,sources:c.expected.sourceIds.map((id:string)=>({id,revision:c.sources.find((n:any)=>n.id===id).revision})),acknowledgedFailures:c.expected.failureIds,scope:c.expected.scope});
async function runCase(phase:string,c:any,profile:string,model:string) {
  const target=path.join(directory,'brains',phase+'-'+profile+'-'+model+'-'+c.id);await mkdir(path.dirname(target),{recursive:true});
  const startCalls=report.calls.length;
  try {
    const row=await runWorkflow(c,legacy.agentCases[Number(c.id.slice(1))-1],new SQLiteBrain(target),async(frame,step)=>invoke(phase,c.id,profile,model,step,frame,()=>c.requiredRead&&step===1?{text:'',toolCalls:[{id:'read-full',name:'read_note',arguments:{id:c.requiredRead.id}}]}:{text:JSON.stringify(oracle(c)),toolCalls:[]}),runners[profile],async()=>new SQLiteBrain(target));
    scoreRun(c,row,report.calls.slice(startCalls));Object.assign(row,{phase,profile,model});report.runs.push(row);
    console.log(JSON.stringify({phase,caseId:c.id,profile,model,status:row.score.status,calls:row.providerCalls}));
  } catch(error){report.runs.push({phase,caseId:c.id,profile,model,status:'incomplete',error:String(error)});console.log(JSON.stringify({phase,caseId:c.id,status:'incomplete',error:String(error)}));}
  await save();
}
function selection(output:any) {
  const answer=output?.complexity;if(!answer||!Number.isFinite(answer.confidence))return {action:'unresolved',reason:'Missing decision'};
  if(answer.confidence<policy.threshold)return {action:'agent',model:'super',uncertain:true};
  if(['clarify','unsupported'].includes(answer.choice))return {action:answer.choice};
  return policy.models[answer.choice]?{action:'agent',model:policy.models[answer.choice],uncertain:false}:{action:'unresolved'};
}
async function classify(item:any,measured=false) {
  const input={request:item.request,context:measured?legacy.agentCases[Number(item.id.slice(1))-1].providerInput.conversation.map((m:any)=>`${m.role}: ${m.content}`).join('\n'):item.context,
    tools:['search_notes','read_note'],notesOnly:true};
  await persistSource('complexity-'+item.id,item.request);
  const row:any={id:item.id,input,expected:measured?undefined:item.expected,measured};
  try {
    row.output=await invoke('complexity',item.id,'jev','jev',1,input,()=>({complexity:{type:'choice',choice:measured?(item.id==='c05'?'medium':'low'):item.expected,confidence:1}}));
    row.selection=selection(row.output);row.labelMatches=measured?null:row.output.complexity.choice===item.expected;
  } catch(error){row.error=String(error);row.selection={action:'unresolved'};}
  await routingBrain.setState('decision:'+item.id,row);report.complexity.push(row);await save();return row;
}
try {
  report.compatibility.push({profile:'codex',model:'super',status:'incomplete',paidCalls:0,reason:'Installed CLI local probe exposed non-Brain tools and a 43265-byte payload; no provider request dispatched.'});
  const ready=new Map<string,boolean>();
  for(const [profile,model]of [['native','super'],['nanobot','super'],['native','lightning'],['native','glm']])ready.set(profile+':'+model,await qualify(profile!,model!));
  for(const [i,c]of closed.cases.entries()) {
    const profiles=i%2?['nanobot','native']:['native','nanobot'];
    for(const profile of profiles)if(ready.get(profile+':super'))await runCase('harness',c,profile,'super');
    for(const model of (i%2?['glm','lightning']:['lightning','glm']))if(ready.get('native:'+model))await runCase('fixed',c,'native',model);
  }
  for(const c of routers.cases)await classify(c);
  for(const c of closed.cases) {
    const row=await classify(c,true);
    if(row.selection.action==='agent'&&ready.get('native:'+row.selection.model))await runCase('routed',c,'native',row.selection.model);
    else report.runs.push({phase:'routed',caseId:c.id,profile:'native',status:'incomplete',selection:row.selection,reason:'No qualified generation selected; source retained in routing Brain.'});
  }
  for(const c of j1.cases) {
    const folder=path.join(directory,'j1-brains',c.id);await mkdir(path.dirname(folder),{recursive:true});let brain=new SQLiteBrain(folder);
    try {
      const row:any=await runJ1Case(c,brain,async(input)=>invoke('j1',c.id,'jev','jev',1,input,()=>({route:c.expectedRoute,confidence:1,...(c.pendingOffer?{helpAccepted:c.id==='j11'}:{})})));
      const before=JSON.stringify(await brain.listRecords());await brain.close();brain=new SQLiteBrain(folder);
      row.restartRetained=before===JSON.stringify(await brain.listRecords());report.j1.push(row);
      console.log(JSON.stringify({phase:'j1',caseId:c.id,action:row.observedAction,match:row.actionMatches,bypass:row.gateBypassed}));
    } catch(error){report.j1.push({id:c.id,status:'incomplete',error:String(error)});} finally {await brain.close();}
    await save();
  }
  const retained=JSON.stringify(await routingBrain.listRecords());await routingBrain.close();routingBrain=new SQLiteBrain(path.join(directory,'routing-brain'));
  report.routingRestartRetained=retained===JSON.stringify(await routingBrain.listRecords());
  report.complete=true;report.finishedAt=new Date().toISOString();report.newReservedUsd=mode==='offline'?0:Math.round((await load('.data/provider-validation.json')).calls.filter((c:any)=>c.validation===EXPERIMENT).reduce((n:number,c:any)=>n+Number(c.reservedUsd),0)*1000)/1000;await save();
} finally {await routingBrain.close();}
console.log(JSON.stringify({complete:report.complete,mode,calls:report.calls.length,newReservedUsd:report.newReservedUsd,report:path.join(directory,'report.json')}));
