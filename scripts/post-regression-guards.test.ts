import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateVision, usableVision} from '../packages/agent/src/evidence.js';
import {MemoryBrain, SQLiteBrain} from '../packages/brain/src/index.js';
import {rig, note} from '../experiments/agent-closeout/support.js';

// Synthetic OCR response fixtures: no inference or personal screenshots.
for (const id of ['o01','o02','o03','o04']) test(`frozen vision replay ${id}: usable observations preserve field support`,async()=>{
  const cases=JSON.parse(await readFile(new URL('../experiments/fixtures/vision-guard-cases.json',import.meta.url),'utf8'));
  const call=cases.find((c:any)=>c.id===id);
  const result=validateVision(call.output,call.question);
  const usable=JSON.stringify(usableVision(result));
  if(id==='o01') for(const value of ['LX-38','45 cm','136 lux','10:35'])assert.ok(usable.includes(value));
  if(id==='o02'){assert.ok(!usable.includes('G8-29'));assert.ok(result.observations.some(o=>o.status==='unreadable'&&o.value===null));}
  if(id==='o03'){assert.ok(!usable.includes('PV-9'));assert.ok(usable.includes('175 mL'));assert.ok(result.validationErrors.length);}
  if(id==='o04'){assert.ok(!usable.includes('R-619'));assert.ok(usable.includes('14 boxes'));assert.ok(result.validationErrors.length);}
  assert.equal(result.raw,call.output.raw);
});

test('field guard applies to unseen labels, not a fixed receipt or batch phrase',()=>{
  const raw={raw:'raw preserved',observations:[{field:'Invoice',status:'readable' as const,value:'XQ-41',label:'Invoice',sourceExcerpt:'Invoice: XQ-41'}, {field:'Weight',status:'readable' as const,value:'82 kg',label:'Weight',sourceExcerpt:'Weight: 82 kg'}],interpretation:'Warranty reference is XQ-41',validationErrors:[],validated:true};
  const checked=validateVision(raw,'What warranty reference and weight are shown? Do not use the invoice.');
  assert.equal(checked.observations[0]!.value,null);assert.equal(checked.observations[1]!.value,'82 kg');
  assert.ok(!JSON.stringify(usableVision(checked)).includes('XQ-41'));
});
for (const kind of ['memory','sqlite']) test(`${kind}: exact ID retrieval respects scope and notes-only paraphrases block web`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moolai-post-guards-'));
  const brain=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
  try{
    await note(brain,{id:'record-opaque-982',title:'Compressor checklist',text:'Check the inlet at 08:45.'});
    assert.equal((await brain.search('record-opaque-982',5))[0]!.id,'record-opaque-982');
    assert.deepEqual(await brain.search('record-opaque-982',5,{excludeIds:['record-opaque-982']}),[]);
    assert.deepEqual(await brain.search('record-opaque-982',5,{kinds:['dictation']}),[]);
    const f=rig(brain);await f.agent.initialize();
    for(const phrase of ['Stay with my notes.','Stick to our notes.','Limit yourself to these notes.']){
      await f.agent.submitText('Moo, '+phrase+' Explain the compressor.');await f.agent.drain();
      assert.equal(f.agent.getState().webAllowed,false);
      assert.ok(!f.observed.generations.at(-1).tools.some((t:any)=>t.name==='search_web'));
      await f.agent.requestEnd();await f.agent.drain();
    }
  }finally{await brain.close();await rm(dir,{recursive:true,force:true});}
});
