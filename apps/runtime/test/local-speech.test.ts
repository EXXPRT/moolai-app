import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {LocalSpeech} from '../../../packages/agent-host/src/speech.js';

async function fixture(mode='normal') {
 const dir=await mkdtemp(join(tmpdir(),'moolai-tts-test-')),config=join(dir,'config.json'),worker=join(dir,'worker.mjs'),requests=join(dir,'requests.jsonl');
 await writeFile(config,JSON.stringify({provider:'kokoro',python:relative(dir,process.execPath)}));
 await writeFile(worker,`import {createInterface} from 'node:readline';
 import {appendFileSync} from 'node:fs';
 const emit=x=>console.log(JSON.stringify(x));
 setTimeout(()=>emit({event:'ready'}),${mode==='loading'?100:1});
 createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);if(x.method==='cancel')return;
 appendFileSync(${JSON.stringify(requests)},JSON.stringify(x.text)+'\\n');
 if(${JSON.stringify(mode)}==='failure'){emit({id:x.id,error:'Synthetic synthesis failure'});return;}
 const chunk=()=>{emit({id:x.id,pcm:Buffer.alloc(400).toString('base64')});emit({id:x.id,done:true});};
 if(${JSON.stringify(mode)}==='late')setTimeout(chunk,50);else chunk();
 });`);
 const calls:{method:string;params:any}[]=[],hooks:{request?:(method:string)=>void}={};
 const speech=new LocalSpeech({async request<T>(method:string,params?:any){calls.push({method,params});hooks.request?.(method);return {} as T;}},()=>{},{config,worker});
 // The texts the worker was asked to synthesize, in order.
 const texts=async():Promise<string[]>=>(await readFile(requests,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
 return {speech,calls,texts,hooks,async close(){speech.close();await rm(dir,{recursive:true,force:true});}};
}
/** Whole sentences until the text is at least this long. */
const reading=(length:number)=>{let text='';for(let i=1;text.length<length;i++)text+=`${text?' ':''}Sentence ${i} explains one more part of the saved answer.`;return text;};
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

// Ian, 21 Oct test A: a long answer read in full stopped partway, past one utterance's 180 s and four-minute bounds.
test('a long reading plays as parts of at most 1,600 characters, cut at sentence ends and begun, fed and ended in order',async()=>{
 const f=await fixture();try{const text=reading(4000);await f.speech.speak(text);
 const begins=f.calls.filter(c=>c.method==='beginSpeechAudio');assert.ok(begins.length>=3,`${begins.length} parts`);
 assert.deepEqual(f.calls.map(c=>c.method),begins.flatMap(()=>['beginSpeechAudio','speechAudio','endSpeechAudio']));
 begins.forEach((begin,i)=>assert.deepEqual(f.calls.slice(i*3,i*3+3).map(c=>c.params.utteranceId),Array(3).fill(begin.params.utteranceId)));
 assert.equal(new Set(begins.map(c=>c.params.utteranceId)).size,begins.length);
 const parts=await f.texts();assert.equal(parts.length,begins.length);
 for(const part of parts){assert.ok(part.length<=1600,`${part.length} characters`);assert.match(part,/[.!?…]$/);}
 assert.equal(parts.join('').replace(/\s+/g,''),text.replace(/\s+/g,''));
 }finally{await f.close();}
});
test('stop() during the first part of a long reading begins no later part',async()=>{
 const f=await fixture('late');try{const speaking=f.speech.speak(reading(4000));const rejected=assert.rejects(speaking,/interrupted/);
 while(!f.calls.some(c=>c.method==='beginSpeechAudio'))await new Promise(r=>setTimeout(r,1));
 await f.speech.stop();await rejected;await new Promise(r=>setTimeout(r,120));
 assert.equal(f.calls.filter(c=>c.method==='beginSpeechAudio').length,1);
 const parts=await f.texts();assert.equal(parts.length,1);assert.ok(parts[0]!.length<=1600,'Only the first part reached the worker');
 }finally{await f.close();}
});
for(const kind of ['stop()','a newer speak()'])test(`${kind} after a part has played, while the next is begun, begins no further part`,async()=>{
 const f=await fixture();try{let begun=0,newer:Promise<void>|undefined;
 f.hooks.request=method=>{if(method==='beginSpeechAudio'&&++begun===2){if(kind==='stop()')void f.speech.stop();else newer=f.speech.speak('A newer answer.');}};
 await f.speech.speak(reading(4000));await newer;
 assert.equal(f.calls.filter(c=>c.method==='beginSpeechAudio').length,kind==='stop()'?2:3,f.calls.map(c=>c.method).join());
 assert.deepEqual((await f.texts()).slice(1),kind==='stop()'?[]:['A newer answer.'],'The rest of the reading never reached the worker');
 }finally{await f.close();}
});
test('a sentence longer than one part is cut at its last space before the limit',async()=>{
 const f=await fixture();try{let text='';for(let i=1;text.length<2000;i++)text+=`${text?' ':''}word${i}`;
 await f.speech.speak(text);const parts=await f.texts();
 assert.equal(parts.length,2);assert.ok(parts.every(part=>part.length<=1600));
 assert.equal(parts.join(' '),text,'The cut falls on a space, so no word is split');
 }finally{await f.close();}
});
test('a hard cut with no space never splits a surrogate pair',async()=>{
 const f=await fixture();try{const text='a'+'😀'.repeat(1000);await f.speech.speak(text);const parts=await f.texts();
 assert.equal(parts.length,2);assert.ok(parts.every(part=>part.length<=1600));
 for(const part of parts)assert.doesNotMatch(part,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
 assert.equal(parts.join(''),text);
 }finally{await f.close();}
});
test('guard: a reading under 1,600 characters is still one utterance and one worker request',async()=>{
 const f=await fixture();try{const text=reading(1500);assert.ok(text.length<1600);await f.speech.speak(text);
 assert.deepEqual(f.calls.map(c=>c.method),['beginSpeechAudio','speechAudio','endSpeechAudio']);
 assert.deepEqual(await f.texts(),[text]);
 }finally{await f.close();}
});
