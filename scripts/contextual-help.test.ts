import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent} from '../packages/agent/src/index.js';
import {MemoryBrain,SQLiteBrain} from '../packages/brain/src/index.js';
import {transcriptText,type VisionEvidence} from '../packages/contracts/src/index.js';
import {validateVision,usableVision} from '../packages/agent/src/evidence.js';
import {rig,segment} from '../experiments/agent-closeout/support.js';
const scene = ():VisionEvidence => ({raw:'raw model output',observations:[],interpretation:'Do not use this as a fact',validated:true,validationErrors:[],scene:{status:'observed',features:[{id:'f1',description:'A small bird has a red breast and brown wings.',region:'center'}],hypotheses:[{label:'Possibly a robin',featureIds:['f1'],confidence:'medium'}],limitation:'Location and clearer plumage detail would help.'}});
const closed = new WeakSet<object>();
for (const adapter of ['memory','sqlite']) {
  async function run(work:(f:ReturnType<typeof rig>,brain:MemoryBrain|SQLiteBrain,folder:string)=>Promise<void>) {
    const folder=await mkdtemp(join(tmpdir(),'moolai-context-'));const brain=adapter==='memory'?new MemoryBrain():new SQLiteBrain(folder);
    const f=rig(brain);f.hooks.decisions.route=async input=>input.pendingOffer
      ? /^no\b/i.test(input.text)?{route:'no_action',confidence:1}:/^yes\b/i.test(input.text)?{route:'start_agent',confidence:1,helpAccepted:true}:{route:'start_agent',confidence:1}
      : {route:'offer_help',confidence:1,screenHelp:true};
    f.hooks.vision.interpret=async()=>scene();
    try {await f.agent.initialize();await work(f,brain,folder);await f.agent.drain();}finally{if(!closed.has(brain))await brain.close();await rm(folder,{recursive:true,force:true});}
  }
  test(`${adapter}: accepted visual help sends original question/image/constraints and consolidates one conversation`,()=>run(async(f,b)=>{
    let question='';let bytes='';f.hooks.vision.interpret=async(image,q)=>{question=q;bytes=image.dataBase64;return scene();};
    await f.agent.submitText('What breed is this bird?');await f.agent.drain();
    assert.equal(f.observed.captures,0);assert.equal(f.observed.generations.length,0);
    assert.match(f.observed.speech.at(-1)!,/look at your screen/);
    await f.agent.submitText('Yes, stay with my notes and keep it brief.');await f.agent.drain();
    assert.equal(f.observed.captures,1);assert.equal(bytes,'AQID');assert.match(question,/What breed is this bird/);assert.match(question,/keep it brief/);
    assert.equal(f.agent.getState().webAllowed,false);
    const messages=JSON.stringify(f.observed.generations[0].messages);assert.match(messages,/Possibly a robin/);assert.match(messages,/What breed is this bird/);
    assert.ok(!f.observed.generations[0].tools.some((t:any)=>t.name==='search_web'));
    const id=f.agent.getState().conversationId!;await f.agent.requestEnd();await f.agent.drain();
    assert.equal((await b.listRecords()).filter(r=>r.kind==='conversation').length,1);
    const record=(await b.getRecord(id))!;assert.equal(record.attachmentIds.length,1);assert.match(record.summary,/What breed is this bird/);assert.match(record.summary,/capture_screen/);
  }));
  for(const reply of ['No, just save it.','Moo, explain photosynthesis instead.','Yes, but do not capture my screen.'])
    test(`${adapter}: no unsolicited capture for ${reply}`,()=>run(async(f,b)=>{
      await f.agent.submitText('What breed is this bird?');await f.agent.drain();await f.agent.submitText(reply);await f.agent.drain();
      assert.equal(f.observed.captures,0);assert.ok((await b.listRecords()).some(r=>transcriptText(r).includes('What breed')));
    }));
  test(`${adapter}: pending question survives restart`,()=>run(async(f,b,folder)=>{
    await f.agent.submitText('What does this diagram show?');await f.agent.drain();
    let restored=b;if(adapter==='sqlite'){await b.close();closed.add(b);restored=new SQLiteBrain(folder);}
    const agent=new Agent({...f.options,brain:restored});await agent.initialize();await agent.submitText('Yes please.');await agent.drain();
    assert.equal(f.observed.captures,1);assert.match(JSON.stringify(f.observed.generations),/What does this diagram show/);
    if(restored!==b)await restored.close();
  }));
  test(`${adapter}: original correction requires fresh acceptance`,()=>run(async(f,b)=>{
    await f.agent.submitText('What bird is this?');await f.agent.drain();
    const offer=f.agent.getState().pendingOffer!;assert.ok('recordId' in offer);const r=(await b.getRecord(offer.recordId))!;
    const s=r.segments[0]!;await f.agent.ingest({...s,text:'What flower is this?',revision:s.revision+1});
    await f.agent.submitText('Yes');await f.agent.drain();assert.equal(f.observed.captures,0);assert.match(f.observed.speech.at(-1)!,/changed/);
    await f.agent.submitText('Yes');await f.agent.drain();assert.equal(f.observed.captures,1);assert.match(JSON.stringify(f.observed.generations),/What flower/);
  }));
  test(`${adapter}: correction during capture prevents provider dispatch`,()=>run(async(f,b)=>{
    let vision=0;f.hooks.vision.interpret=async()=>{vision++;return scene();};
    await f.agent.submitText('What bird is this?');await f.agent.drain();const offer=f.agent.getState().pendingOffer!;assert.ok('recordId' in offer);
    f.hooks.capture.capture=async()=>{const source=(await b.getRecord(offer.recordId))!;await b.upsertSegment(source.id,{...source.segments[0]!,revision:2,text:'What flower is this?'});return {mimeType:'image/png',bytes:new Uint8Array([1])};};
    await f.agent.submitText('Yes');await f.agent.drain();assert.equal(vision,0);assert.equal(f.observed.generations.length,0);assert.match(f.agent.getState().lastError!,/changed/);
  }));
  test(`${adapter}: failed capture is retained and never automatically retried`,()=>run(async(f,b)=>{
    f.hooks.capture.capture=async()=>{throw Error('Permission denied');};
    await f.agent.submitText('What bird is this?');await f.agent.drain();await f.agent.submitText('Yes');await f.agent.drain();
    assert.equal(f.observed.captures,1);assert.equal(f.observed.generations.length,0);assert.match(f.agent.getState().lastError!,/Permission denied/);
    await f.agent.stopSession();await f.agent.drain();assert.match((await b.getRecord(f.agent.getState().conversationId!))!.summary,/What bird/);assert.equal(f.observed.captures,1);
  }));
  test(`${adapter}: failed vision does not publish an invented identification`,()=>run(async(f,b)=>{
    f.hooks.vision.interpret=async()=>{throw Error('Vision unavailable');};await f.agent.submitText('What bird is this?');await f.agent.drain();await f.agent.submitText('Yes');await f.agent.drain();
    assert.equal(f.observed.generations.length,0);assert.match(f.agent.getState().lastError!,/Vision unavailable/);assert.equal((await b.getRecord(f.agent.getState().conversationId!))!.attachmentIds.length,1);
  }));
  for(const status of ['absent','unclear'] as const)
    test(`${adapter}: changed/multiple targets ${status} never become identification evidence`,()=>run(async(f)=>{
      f.hooks.vision.interpret=async()=>({...scene(),scene:{...scene().scene!,status,limitation:'No unique bird can be identified on the current screen.'}});
      await f.agent.submitText('What bird is this?');await f.agent.drain();await f.agent.submitText('Yes');await f.agent.drain();
      const context=f.observed.generations[0].messages[0].content;assert.match(context,/No unique bird/);assert.doesNotMatch(context,/Possibly a robin/);
    }));
}
test('visual hypotheses require concrete feature references; raw contradictions remain',()=>{
  const raw=scene();raw.scene!.hypotheses[0]!.featureIds=['missing'];const evidence=validateVision(raw,'What is this bird?','visual');
  assert.equal(evidence.scene!.hypotheses.length,0);assert.equal(evidence.raw,'raw model output');assert.equal(evidence.validated,false);
});
test('legacy JSON cannot bypass visual validation',()=>assert.equal(validateVision(JSON.stringify(scene())).scene,undefined));
test('visual evidence does not require printed labels and does not expose raw interpretation',()=>{
  const usable=usableVision(validateVision(scene(),'What species is this bird?','visual'));assert.equal(usable.scene!.hypotheses.length,1);assert.doesNotMatch(JSON.stringify(usable),/Do not use this as a fact/);
});

test('mixed visual hypotheses cannot rescue contradictory OCR values; clear neighbors survive',()=>{
  const value={...scene(),interpretation:'The identifier is partially obscured.',observations:[
    {field:'Identifier',label:'Identifier',sourceExcerpt:'Identifier: A-2',status:'readable' as const,value:'A-2'},
    {field:'Volume',label:'Volume',sourceExcerpt:'Volume: 140 mL',status:'readable' as const,value:'140 mL'}]};
  const usable=usableVision(validateVision(value,'Read the identifier and volume'));
  assert.equal(usable.scene,undefined);assert.equal(usable.observations[0]!.value,null);assert.equal(usable.observations[1]!.value,'140 mL');
});

test('OCR mode refuses scene-only text even if the provider marks it validated',()=>{
  const evidence=validateVision(scene(),'Read the serial number','ocr');
  assert.equal(evidence.scene,undefined);assert.equal(evidence.validated,false);
});
test('one capture per user turn prevents automatic OCR-to-visual fallback and paid retry',async()=>{
  const b=new MemoryBrain();const f=rig(b);let calls=0,visions=0;
  f.hooks.vision.interpret=async()=>{visions++;return {raw:'unusable text',observations:[],interpretation:'A guessed value',validated:false,validationErrors:['No field observations']};};
  f.hooks.generation.respond=async()=>++calls<=2?{text:'',toolCalls:[{id:`capture-${calls}`,name:'capture_screen',arguments:{question:'Read the identifier',mode:calls===1?'ocr':'visual'}}]}:{text:'The identifier remains unresolved.',toolCalls:[]};
  await f.agent.initialize();await f.agent.submitText('Moo, read my screen.');await f.agent.drain();
  assert.equal(f.observed.captures,1);assert.equal(visions,1);assert.match(JSON.stringify(f.observed.generations),/already attempted/);
  calls=0;await f.agent.submitText('Please capture my screen again.');await f.agent.drain();
  assert.equal(f.observed.captures,2);assert.equal(visions,2);await b.close();
});
