/** Local prerecorded comparison only: no microphone, cloud inference, or default switch. */
import {spawn,execFile as execFileCb} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {tmpdir,totalmem,cpus,release} from 'node:os';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assess} from './metrics.mjs';
const execFile=promisify(execFileCb),root=fileURLToPath(new URL('../../',import.meta.url));
const assets=path.join(root,'.data/asr/canary-experiment'),directory=path.join(assets,'run-v1');
const load=async file=>JSON.parse(await readFile(path.join(root,file),'utf8'));
const corpus=await load('experiments/evaluation/asr-cases.json');
if(!process.argv.includes('--run')){console.log(JSON.stringify({mode:'preview',microphone:false,paidCalls:0,corpus,repeatIds:['s01','s04']},null,2));process.exit(0);}
if(await access(directory).then(()=>true,()=>false))throw Error('Run already exists; preserve it.');
const hash=async file=>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
const lock=await load('.data/asr/canary-experiment/model-lock.json');
const source=path.join(assets,'runtime'),canary=path.join(assets,'build/bin/transcribe-cli'),canaryModel=path.join(assets,lock.file);
if((await execFile('git',['-C',source,'rev-parse','HEAD'])).stdout.trim()!==lock.runtimeCommit)throw Error('Runtime revision changed');
if(await hash(canaryModel)!==lock.sha256)throw Error('Canary artifact hash mismatch');
const whisperPins=await load('docs/whisper-artifacts.json'),config=await load('asr-config.json');
const whisperBase=path.join(root,'.data/asr/whisper'),whisper=path.join(whisperBase,'build/bin/whisper-server');
const whisperModel=path.join(whisperBase,'models',whisperPins.models[config.model].filename),vad=path.join(whisperBase,'models',whisperPins.vad.filename);
const installed=await load('.data/asr/whisper/runtime-install.json');
for(const [file,expected]of [[whisper,installed.serverSha256],[whisperModel,whisperPins.models[config.model].sha256],[vad,whisperPins.vad.sha256]])if(await hash(file)!==expected)throw Error('Whisper artifact changed: '+path.basename(file));
await mkdir(directory,{recursive:true,mode:0o700});
const temp=await mkdtemp(path.join(tmpdir(),'moolai-canary-synthetic-'));
const sources=['experiments/canary-comparison/run.mjs','experiments/canary-comparison/metrics.mjs','experiments/evaluation/asr-cases.json','scripts/evaluation-metrics.mjs','asr-config.json'];
const report={startedAt:new Date().toISOString(),complete:false,mode:'local synthetic whole-clip ASR comparison',microphoneStarted:false,paidCalls:0,productionDefaultsChanged:false,
  hardware:{chip:cpus()[0]?.model,memoryGiB:totalmem()/2**30,osRelease:release()},
  freeze:{corpus,sourceHashes:Object.fromEntries(await Promise.all(sources.map(async f=>[f,await hash(path.join(root,f))]))),
    canary:{...lock,binarySha256:await hash(canary),backend:'metal',nCtx:2048,threads:8,greedy:true,repeat:1,vad:false,prompt:'runtime default'},
    whisper:{model:config.model,runtime:whisperPins.runtime.revision,modelSha256:whisperPins.models[config.model].sha256,binarySha256:installed.serverSha256,initialPrompt:config.initialPrompt,language:config.language,vad:true,temperature:0,bestOf:1,beamSize:1},
    order:['canary','whisper'],repeats:['s01','s04'],warmup:'The speech recognizer is warming up.',scoring:'Strict WER unchanged; separately report predefined numeric/spelling aliases, critical phrases, final words and silence insertions.'},
  limitations:['Samantha synthetic clips do not establish personal voice, AirPods, accent or noise performance.','No J1 provider calls: recognizer text does not establish observed routing.','Canary uses whole-clip inference and has no streaming integration here.','Profiles differ: configured Whisper includes Moo hint and Silero VAD; candidate Canary is raw BF16 with no VAD.','Canary timings are internal compute; Whisper timings are HTTP round trips. Do not present them as equivalent latency or end-of-speech latency.'],
  audio:[],canary:[],whisper:[]};
const save=()=>writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
let server;let serverExit;
try{
  for(const c of [{id:'warmup',reference:report.freeze.warmup,audioKind:'speech',voice:'Samantha',rate:155},...corpus.cases]){
    const wav=path.join(temp,c.id+'.wav');
    if(c.audioKind==='silence'){
      const pcm=Buffer.alloc(c.silenceSeconds*16000*2),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);await writeFile(wav,Buffer.concat([header,pcm]));
    }else{
      const aiff=path.join(temp,c.id+'.aiff');await execFile('/usr/bin/say',['-v',c.voice,'-r',String(c.rate),'-o',aiff,c.reference],{timeout:15000});
      await execFile('ffmpeg',['-loglevel','error','-i',aiff,'-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{timeout:15000});
    }
    const result=await execFile('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',wav]);
    report.audio.push({id:c.id,file:wav,sha256:await hash(wav),audioMs:Number(result.stdout.trim())*1000});
  }
  const ordered=[...report.audio,...report.audio.filter(a=>report.freeze.repeats.includes(a.id))];
  const list=path.join(temp,'files.list');await writeFile(list,ordered.map(a=>a.file).join('\n')+'\n');
  await save();
  const started=performance.now();
  try{
    const result=await execFile(canary,['-m',canaryModel,'--backend','metal','--threads','8','--n-ctx','2048','-l','en','--timestamps','none','--batch',list,'--batch-jsonl'],{cwd:root,timeout:300000,maxBuffer:8*1024*1024});
    await writeFile(path.join(directory,'canary-stdout.jsonl'),result.stdout);await writeFile(path.join(directory,'canary-stderr.log'),result.stderr);
    const lines=result.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));report.canaryHeader=lines.find(r=>r.type==='batch_header');
    for(const [index,item]of lines.filter(r=>r.file).entries()){
      const audio=ordered[index];if(!audio||item.file!==audio.file)throw Error('Canary output order mismatch');
      const observation={id:audio.id,repeat:index>=report.audio.length,status:item.error?'incomplete':'completed',transcript:item.text,audioMs:audio.audioMs,inferenceMs:item.mel_ms+item.encode_ms+item.decode_ms,raw:item};
      const c=corpus.cases.find(c=>c.id===audio.id);if(c)observation.score=assess(c,observation);report.canary.push(observation);
    }
    if(report.canary.length!==ordered.length)throw Error('Missing Canary outputs');
  }catch(error){report.canaryError=String(error);if(error.stdout)await writeFile(path.join(directory,'canary-failed-stdout.txt'),error.stdout);if(error.stderr)await writeFile(path.join(directory,'canary-failed-stderr.log'),error.stderr);}
  report.canaryWallMs=performance.now()-started;await save();
  console.log(JSON.stringify({stage:'canary',rows:report.canary.length,error:report.canaryError}));

  // Own a separate temporary server. Never connect to or interrupt the user's runtime.
  const port=await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));});});
  const args=['-m',whisperModel,'--host','127.0.0.1','--port',String(port),'-t','8','-l',config.language,'-fa','-nf','-bo','1','-bs','1','--prompt',config.initialPrompt,'--vad','-vm',vad];
  server=spawn(whisper,args,{cwd:root,stdio:['ignore','ignore','pipe']});let logs='';server.stderr.on('data',b=>{logs=(logs+b).slice(-100000);});server.on('exit',(code,signal)=>{serverExit={code,signal};});
  server.on('error',error=>{serverExit={error:String(error)};});
  const deadline=Date.now()+60000;let ready=false;
  while(Date.now()<deadline){if(serverExit)throw Error('Owned Whisper server exited');try{const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(800)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  if(!ready)throw Error('Whisper startup timed out');
  for(const [index,audio]of ordered.entries()){
    const observation={id:audio.id,repeat:index>=report.audio.length,audioMs:audio.audioMs,status:'incomplete'};const started=performance.now();
    try{
      const form=new FormData();form.append('file',new Blob([await readFile(audio.file)],{type:'audio/wav'}),audio.id+'.wav');
      for(const [k,v]of Object.entries({response_format:'json',language:config.language,prompt:config.initialPrompt,temperature:'0',temperature_inc:'0',best_of:'1',beam_size:'1',vad:'true'}))form.append(k,v);
      const response=await fetch(`http://127.0.0.1:${port}/inference`,{method:'POST',body:form,signal:AbortSignal.timeout(60000)});
      const raw=await response.json();observation.raw=raw;if(!response.ok||typeof raw.text!=='string')throw Error('Whisper response unavailable');
      observation.transcript=raw.text.trim();observation.status='completed';
    }catch(error){observation.error=String(error);}
    observation.inferenceMs=performance.now()-started;
    const c=corpus.cases.find(c=>c.id===audio.id);if(c)observation.score=assess(c,observation);report.whisper.push(observation);await save();
  }
  await writeFile(path.join(directory,'whisper-server.log'),logs);
  report.complete=!report.canaryError&&report.canary.length===ordered.length&&report.whisper.length===ordered.length&&[...report.canary,...report.whisper].every(r=>r.status==='completed');
}catch(error){report.error=String(error);}
finally{
  if(server&&!serverExit){server.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{server.kill('SIGKILL');resolve();},3000);server.once('exit',()=>{clearTimeout(timer);resolve();});});}
  await rm(temp,{recursive:true,force:true});report.temporaryAudioRemoved=!(await access(temp).then(()=>true,()=>false));
  report.finishedAt=new Date().toISOString();await save();
}
console.log(JSON.stringify({complete:report.complete,error:report.error,canaryError:report.canaryError,temporaryAudioRemoved:report.temporaryAudioRemoved,report:path.join(directory,'report.json')}));
if(!report.complete)process.exitCode=1;
