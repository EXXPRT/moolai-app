import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {LocalSpeech} from '../../../packages/agent-host/src/speech.js';

async function fixture(mode='normal') {
 const dir=await mkdtemp(join(tmpdir(),'moolai-tts-test-')),config=join(dir,'config.json'),worker=join(dir,'worker.mjs');
 await writeFile(config,JSON.stringify({provider:'kokoro',python:relative(dir,process.execPath)}));
 await writeFile(worker,`import {createInterface} from 'node:readline';
 const emit=x=>console.log(JSON.stringify(x));
 setTimeout(()=>emit({event:'ready'}),${mode==='loading'?100:1});
 createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);if(x.method==='cancel')return;
 if(${JSON.stringify(mode)}==='failure'){emit({id:x.id,error:'Synthetic synthesis failure'});return;}
 const chunk=()=>{emit({id:x.id,pcm:Buffer.alloc(400).toString('base64')});emit({id:x.id,done:true});};
 if(${JSON.stringify(mode)}==='late')setTimeout(chunk,50);else chunk();
 });`);
 const calls:{method:string;params:any}[]=[];
 const speech=new LocalSpeech({async request<T>(method:string,params?:any){calls.push({method,params});return {} as T;}},()=>{},{config,worker});
 return {speech,calls,async close(){speech.close();await rm(dir,{recursive:true,force:true});}};
}
test('Kokoro stream uses native PCM playback, keeps the model warm, and never requests capture',async()=>{
 const f=await fixture();try{await f.speech.speak('A short answer.');await f.speech.speak('A follow-up.');
 assert.deepEqual(f.calls.map(c=>c.method),['beginSpeechAudio','speechAudio','endSpeechAudio','beginSpeechAudio','speechAudio','endSpeechAudio']);
 }finally{await f.close();}
});
test('empty narration is rejected before model loading or native playback starts',async()=>{
 const f=await fixture();try {await assert.rejects(f.speech.speak('  \n  '),/empty/);assert.deepEqual(f.calls,[]);}
 finally {await f.close();}
});
test('speech during model loading can be cancelled without late playback',async()=>{
 const f=await fixture('loading');try{const speaking=f.speech.speak('This must not play.');await new Promise(r=>setTimeout(r,10));await f.speech.stop();await speaking;
 assert.deepEqual(f.calls.map(c=>c.method),['stopSpeaking']);}finally{await f.close();}
});
test('interrupt discards late PCM and does not resume the interrupted answer',async()=>{
 const f=await fixture('late');try{const speaking=f.speech.speak('Original answer.');const rejected=assert.rejects(speaking,/interrupted/);
 while(!f.calls.some(c=>c.method==='beginSpeechAudio'))await new Promise(r=>setTimeout(r,1));
 await f.speech.stop();await rejected;await new Promise(r=>setTimeout(r,80));
 assert.ok(!f.calls.some(c=>c.method==='speechAudio'));}finally{await f.close();}
});
test('synthesis failure is explicit and never silently uses Apple voice',async()=>{
 const f=await fixture('failure');try{await assert.rejects(f.speech.speak('A short answer.'),/Synthetic synthesis failure/);assert.ok(!f.calls.some(c=>c.method==='speak'));}finally{await f.close();}
});

test('concurrent warm calls own exactly one worker and share readiness',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'moolai-warm-race-'));
 const config=join(dir,'config.json'),worker=join(dir,'worker.mjs'),pids=join(dir,'pids');
 await writeFile(config,JSON.stringify({provider:'kokoro',python:process.execPath}));
 await writeFile(worker,`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');console.log(JSON.stringify({event:'ready'}));process.stdin.resume();`);
 const speech=new LocalSpeech({async request<T>(){return {} as T;}},()=>{},{config,worker});
 try{const {readFile}=await import('node:fs/promises');await Promise.all([speech.warm(),speech.warm(),speech.warm()]);
 assert.equal((await readFile(pids,'utf8')).trim().split('\n').length,1);
 }finally{speech.close();await rm(dir,{recursive:true,force:true});}
});
test('a newer utterance settles its predecessor and old chunks cannot stop new playback',async()=>{
 const f=await fixture('late');try{
 const first=f.speech.speak('Long initial answer');const rejected=assert.rejects(first,/superseded/);
 while(!f.calls.some(c=>c.method==='beginSpeechAudio'))await new Promise(r=>setTimeout(r,1));
 const second=f.speech.speak('Finish or continue?');await rejected;await second;
 const begins=f.calls.filter(c=>c.method==='beginSpeechAudio');assert.equal(begins.length,2);
 const audio=f.calls.filter(c=>c.method==='speechAudio');assert.equal(audio.length,1);assert.equal(audio[0]!.params.utteranceId,begins[1]!.params.utteranceId);
 const last=f.calls.map(c=>c.method).lastIndexOf('beginSpeechAudio');assert.ok(!f.calls.slice(last+1).some(c=>c.method==='stopSpeaking'));
 }finally{await f.close();}
});
test('closing while warmup reads config never launches an orphan worker',async()=>{
 const f=await fixture();const warming=f.speech.warm();f.speech.close();
 await assert.rejects(warming,/closed/);assert.equal(f.calls.length,0);await f.close();
});
