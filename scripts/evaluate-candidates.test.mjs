import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, loadEvaluationCorpus, compareAsr } from './evaluate-candidates.mjs';

test('default preview makes no model call and excludes exact oracle answers',async()=>{
  const result=await main([]);
  assert.equal(result.paidCalls,0);assert.equal(result.microphoneUsed,false);
  assert.equal(result.agent.cases.length,8);assert.equal(result.asr.cases.length,12);
  assert.equal(result.asr.model,'nvidia/canary-qwen-2.5b');
  assert(!JSON.stringify(result.agent.cases).includes('"expected"'));
  assert(result.agent.cases.every(c=>!c.facts));
});
test('ASR pooling weights errors by reference length rather than averaging per-clip percentages',()=>{
  const cases=[{id:'one',reference:'one',criticalPhrases:[]},{id:'many',reference:'one two three four five six seven eight nine',criticalPhrases:[]}];
  const rows=compareAsr(cases,[{id:'a',runs:[{caseId:'one',status:'completed',transcript:'wrong'},
    {caseId:'many',status:'completed',transcript:cases[1].reference}]}]);
  assert.equal(rows[0].pooledWer,0.1);
  assert.equal(rows[0].routing.observed,0);
});
test('empty and incomplete ASR observations cannot create a winning score',()=>{
  const cases=[{id:'one',reference:'one',criticalPhrases:[]}];
  const [row]=compareAsr(cases,[{id:'not-run',runs:[]}]);
  assert.equal(row.pooledWer,null);assert.equal(row.eligibleForComparison,false);
  assert.throws(()=>compareAsr(cases,[{id:'x',runs:[{caseId:'unexpected'}]}]),/unexpected/);
});
test('silence hallucinations are reported separately from pooled speech WER',()=>{
  const cases=[{id:'speech',reference:'one two',criticalPhrases:[]},{id:'silence',reference:'',criticalPhrases:[]}];
  const [row]=compareAsr(cases,[{id:'candidate',runs:[
    {caseId:'speech',status:'completed',transcript:'one two'},
    {caseId:'silence',status:'completed',transcript:'thank you'},
  ]}]);
  assert.equal(row.pooledWer,0);assert.equal(row.speechErrors,0);
  assert.equal(row.errors,2);assert.equal(row.silenceInsertions,2);
});
test('scoring binds observations to exact corpus and refuses overwriting evidence or results',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moolai-evaluation-'));
  try {
    const file=path.join(dir,'input.json'),output=path.join(dir,'output.json');
    await writeFile(file,JSON.stringify({corpusSha256:'old',profiles:[]}));
    await assert.rejects(main(['--agent',file]),/Corpus hash/);
    const {sha256}=await loadEvaluationCorpus('closed-task-cases');
    await writeFile(file,JSON.stringify({corpusSha256:sha256,profiles:[{id:'pending',runs:[]}]}));
    await assert.rejects(main(['--agent',file,'--output',file]),/overwrite/);
    const result=await main(['--agent',file,'--output',output]);
    assert.equal(result.profiles[0].incomplete,8);
    await assert.rejects(main(['--agent',file,'--output',output]),/EEXIST/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
