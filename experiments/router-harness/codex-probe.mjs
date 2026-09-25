/** No-provider compatibility probe of the installed Codex CLI. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(tmpdir(),'moolai-codex-probe-'));
const observed=[];
const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000){res.writeHead(413);res.end();return;}}
  const item={method:req.method,path:req.url};
  if(req.url==='/responses'&&req.method==='POST') {
    const p=JSON.parse(body);item.keys=Object.keys(p);item.tools=(p.tools??[]).map(t=>t.name??t.type);item.bytes=Buffer.byteLength(body);
    observed.push(item);
    // No request reaches a model. Capture advertised capabilities, then terminate visibly.
    res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture probe completed; no inference dispatched',type:'invalid_request_error'}}));
  } else {observed.push(item);res.writeHead(404,{'Content-Type':'application/json'});res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const configs={model_provider:'moolai_probe',model:'fixture-only',web_search:'disabled',
  'model_providers.moolai_probe':{name:'Moolai fixture',base_url:`http://127.0.0.1:${port}`,wire_api:'responses',env_key:'MOOLAI_FIXTURE_TOKEN',request_max_retries:0,stream_max_retries:0,requires_openai_auth:false},
  'features.shell_tool':false,'features.unified_exec':false,'features.apply_patch_freeform':false,'features.multi_agent':false,
  'features.apps':false,'features.js_repl':false,'features.skill_mcp_dependency_install':false,
  'memories.generate_memories':false,'memories.use_memories':false,'project_doc_max_bytes':0,
  'model_auto_compact_token_limit':1000000,'notify':[],
};
function toml(v){if(Array.isArray(v))return '['+v.map(toml).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).map(([k,v])=>`${k}=${toml(v)}`).join(',')+'}';return JSON.stringify(v);}
let stdout='',stderr='';
try {
  const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never','-C',dir];
  for(const [k,v] of Object.entries(configs))args.push('-c',`${k}=${toml(v)}`);
  args.push('Return the synthetic marker 73. No tasks or files.');
  const child=spawn('/Applications/ChatGPT.app/Contents/Resources/codex',args,{cwd:dir,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',MOOLAI_FIXTURE_TOKEN:'local-probe-only'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>{stdout=(stdout+d).slice(-20000);});child.stderr.on('data',d=>{stderr=(stderr+d).slice(-5000);});
  const timer=setTimeout(()=>child.kill('SIGTERM'),25000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timer);
  const report={mode:'no-provider-codex-probe',paidCalls:0,code,observed,stdout,stderr};
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report,null,2));
} finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
