import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {MemoryBrain} from '../../packages/brain/src/index.js';
import {prepare,type Case} from './scenario.js';
import {snapshot} from '../agent-closeout/support.js';
const root=process.cwd(),dir=resolve('.data/j1-closing-20260926');
const cases=JSON.parse(await readFile('experiments/j1-closing/cases.json','utf8'));
async function bridge(args:string[],input?:unknown) {
  return await new Promise<any>((resolve,reject)=>{
    const proc=spawn(root+'/backend/.venv/bin/python',['experiments/j1-closing/provider.py',...args],{cwd:root,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'}});
    let stdout='',stderr='';proc.stdout.on('data',x=>stdout+=x);proc.stderr.on('data',x=>stderr+=x);
    const timer=setTimeout(()=>{proc.kill();reject(new Error('Provider timeout; no retry'));},115000);
    proc.on('error',reject);proc.on('close',code=>{clearTimeout(timer);if(code)reject(new Error(stderr.slice(-1800)));else try{resolve(JSON.parse(stdout));}catch(e){reject(e);}});
    proc.stdin.end(input?JSON.stringify(input):'');
  });
}
await mkdir(dir,{recursive:true});
const freeze=dir+'/freeze.json';
if(process.argv.includes('--freeze')) {
  await writeFile(freeze,JSON.stringify(await bridge(['--preflight']),null,2),{flag:'wx',mode:0o600});
  console.log('Frozen cases, scoring, source hashes, prices and historical ledger. No inference.');
} else {
  await access(freeze);
  if(process.argv.includes('--compatibility')) {
    for(const c of cases.compatibility) {
      const path=dir+'/'+c.id+'.json';try{await access(path);throw new Error('Existing result; no retry');}catch(e:any){if(e.code!=='ENOENT')throw e;}
      const result=await bridge(['--freeze',freeze],{callId:`j1_closing_20260926_v1:${c.id}:contextual:respond:1`,caseId:c.id,profile:'contextual',method:'respond',step:1,input:{messages:c.messages,tools:[],closingMode:'contextual'}});
      await writeFile(path,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(c.id,result.status,result.output?.controlProposal?.action??'answer');
    }
  } else {
    const sequence=[...cases.cases,...cases.repeats.map((id:string)=>({...cases.cases.find((c:Case)=>c.id===id),id:id+'r',repeatOf:id}))];
    for(const [index,item] of sequence.entries())for(const profile of index%2?['contextual','current']:['current','contextual']) {
      const path=dir+'/'+item.id+'-'+profile+'.json';try{await access(path);continue;}catch(e:any){if(e.code!=='ENOENT')throw e;}
      const brain=new MemoryBrain(),{f,release}=await prepare(brain,item,profile as any);
      const before=f.agent.getState(),calls:any[]=[];let step=0;
      const generations=f.observed.generations.length,speech=f.observed.speech.length;
      f.hooks.decisions.route=async input=>{
        if(++step>2)throw new Error('Case call limit; no retries');
        const result=await bridge(['--freeze',freeze],{callId:`j1_closing_20260926_v1:${item.id}:${profile}:route:${step}`,caseId:item.id,profile,method:'route',step,input});
        calls.push(result);await writeFile(dir+'/'+item.id+'-'+profile+'-call'+step+'.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
        if(result.status!=='succeeded')throw new Error(result.error??result.status);return result.output;
      };
      let error:string|undefined;
      try{if(item.text!==null)await f.agent.submitText(item.text);}catch(e){error=String(e);}
      const beforeWorkCompletes=f.agent.getState();release();await f.agent.drain();
      const after=f.agent.getState(),snap=await snapshot(brain,f);
      const closed=!after.conversationId,source=(await brain.getRecord(before.sessionId!))!.segments.filter(s=>s.speaker==='user');
      const retained=item.text===null||source.some(s=>s.text===item.text);
      const generated=f.observed.generations.length-generations;
      const record=snap.records.find(r=>r.id===before.conversationId)!;
      const workStatus=await brain.getState('work-status:'+before.conversationId);
      const pass=!error&&closed===(item.expected==='closed')&&retained&&(!item.work||generated>0)&&
        (item.endAction!=='cancel'||String(workStatus).toLowerCase().includes('cancel'));
      const result={item,profile,before,beforeWorkCompletes,after,closed,retained,generated,workStatus,pass,
        wrongClose:closed&&item.expected==='open',missedClose:!closed&&item.expected==='closed',
        extraClarifications:f.observed.speech.slice(speech).filter(s=>s.includes('Could you clarify')).length,
        modelCalls:calls.length,latencyMs:calls.reduce((n,c)=>n+c.elapsedMs,0),reservedUsd:calls.reduce((n,c)=>n+Number(c.reservedUsd),0),
        error,outputs:calls.map(c=>c.output),record,observed:snap.observed};
      await writeFile(path,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
      console.log(item.id,profile,pass?'pass':'FAIL',closed?'closed':'open',calls.map(c=>c.output?.route+':'+c.output?.confidence).join(','));
    }
  }
}
