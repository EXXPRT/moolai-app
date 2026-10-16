// Local synthetic comparison only. Temporary generated audio is removed in finally.
import {execFile as callbackExec} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readAsrConfig} from './asr-config.mjs';
import {decodeWhisper} from './whisper-bridge.mjs';
import {wordErrors} from './evaluation-metrics.mjs';
const execFile=promisify(callbackExec);
const cases=[
  'Moo, explain how capillary action works. Use only my notes.',
  'I meant iodine, not iron. Explain the difference briefly.',
  'Do not end the conversation. I have another question.',
  'The title is That is all. Keep discussing the experiment.',
  'That is all, thanks. End conversation.',
  'The goalpost is five metres wide and two metres high.',
  'Add an observation about evapotranspiration and soil moisture.',
  'Explain the second phase of the collaboration plan.',
  'The batch identifier is unknown. Do not substitute the receipt number.',
  'Please keep the final word telescope.',
];
const settings=await readAsrConfig();
const output=process.argv[2]??'.data/validation/decoder-comparison.json';
const dir=await mkdtemp(path.join(tmpdir(),'moolai-decoder-'));
const rows=[];
try {
  for(let i=0;i<cases.length;i++) {
    const health=await fetch(`http://127.0.0.1:${settings.port}/health`).then(r=>r.json());
    if(health.activeCapture) throw Error('Microphone capture is active; comparison stopped without changing it.');
    if(health.model!==settings.model)throw Error('Running ASR model differs from the configured model.');
    const file=path.join(dir,'synthetic.aiff');
    await execFile('say',['-v','Samantha','-r','165','-o',file,cases[i]]);
    const {stdout:pcm}=await execFile('ffmpeg',['-loglevel','error','-i',file,'-ar','16000','-ac','1','-f','s16le','pipe:1'],{encoding:'buffer',maxBuffer:4*1024*1024});
    await rm(file);
    const digest=createHash('sha256').update(pcm).digest('hex');
    for(const beamSize of i%2?[3,1]:[1,3]) {
      const started=performance.now();
      try {
        const transcript=await decodeWhisper(pcm,{...settings,beamSize},{signal:AbortSignal.timeout(30000)});
        rows.push({case:i+1,reference:cases[i],beamSize,audioSha256:digest,audioSeconds:pcm.length/32000,transcript,inferenceMs:Math.round(performance.now()-started),...wordErrors(cases[i],transcript)});
      } catch(error) {rows.push({case:i+1,beamSize,error:String(error),audioSha256:digest});}
    }
    pcm.fill(0);
    console.log(`Completed synthetic case ${i+1}/${cases.length}`);
  }
} finally {
  await rm(dir,{recursive:true,force:true});
  await mkdir(path.dirname(output),{recursive:true});
  const totals=[1,3].map(beamSize=>{
    const completed=rows.filter(r=>r.beamSize===beamSize&&!r.error);
    const errors=completed.reduce((n,r)=>n+r.errors,0),words=completed.reduce((n,r)=>n+r.referenceWords,0);
    return {beamSize,completed:completed.length,errors,words,wer:words?errors/words:null,meanInferenceMs:completed.length?Math.round(completed.reduce((n,r)=>n+r.inferenceMs,0)/completed.length):null};
  });
  await writeFile(output,JSON.stringify({at:new Date().toISOString(),model:settings.model,kind:'synthetic Apple speech; no microphone; not user-session WER',frozenCases:cases,productionChanged:false,audioRemoved:true,totals,rows},null,2)+'\n');
  console.log(JSON.stringify({totals,audioRemoved:true,productionChanged:false}));
}
