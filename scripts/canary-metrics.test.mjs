import test from 'node:test';
import assert from 'node:assert/strict';
import {assess,canonicalWords} from '../experiments/canary-comparison/metrics.mjs';
const c={reference:'Forty centimeters, not twenty centimeters.',criticalPhrases:['forty centimeters','not twenty centimeters'],finalWord:'centimeters'};
const observation=transcript=>({status:'completed',transcript,audioMs:3000,inferenceMs:200});
test('Canary comparison reports number formatting separately from strict WER',()=>{
  const r=assess(c,observation('40 centimetres, not 20 centimetres.'));
  assert.ok(r.strict.accuracy.wer>0);assert.equal(r.criticalPass,false);assert.equal(r.semanticCriticalPass,true);
});
test('Canary comparison never normalizes away negation',()=>{
  assert.equal(assess(c,observation('40 centimeters, 20 centimeters.')).semanticCriticalPass,false);
});
test('Canary comparison does not equate Moo with Move or end with and',()=>{
  assert.notDeepEqual(canonicalWords('Moo, end conversation'),canonicalWords('Move and conversation'));
});
test('Canary comparison retains final-word and silence failures',()=>{
  assert.equal(assess(c,observation('40 centimeters, not 20')).semanticCriticalPass,false);
  const silence={reference:'',criticalPhrases:[],finalWord:null};
  assert.equal(assess(silence,observation('Thank you')).criticalPass,false);
  assert.equal(assess(silence,observation('')).criticalPass,true);
});
test('Canary comparison cannot turn a failed runtime into an empty successful transcript',()=>{
  assert.equal(assess({reference:'',criticalPhrases:[]},{status:'incomplete',transcript:''}).semanticCriticalPass,false);
});
