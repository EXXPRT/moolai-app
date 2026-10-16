import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenAnswer, compactToolOutcome } from '../src/response-output.js';

test('speech uses the generated brief answer, while full text remains unchanged', () => {
  const reply={text:'Detailed answer.\n| Quantity | Value |\n| Sample | 70 |\n[Source](https://example.org)',spokenText:'There are seventy samples. The source has more detail.',toolCalls:[]};
  assert.equal(spokenAnswer(reply),'There are seventy samples. The source has more detail.');
  assert.match(reply.text,/Quantity/);
});
test('legacy fallback preserves prose and explicitly discloses a long answer instead of silently clipping', () => {
  assert.equal(spokenAnswer({text:'First. Second. Third. Fourth.\n| a | b |\n```\ncode\n```',toolCalls:[]}), 'First. Second. Third. Fourth. | a | b | Code is on screen.');
  assert.ok(spokenAnswer({text:'word '.repeat(1000),toolCalls:[]}).length<660);
  assert.equal(spokenAnswer({text:'```\ncode\n```',toolCalls:[]}), 'Code is on screen.');
  assert.equal(spokenAnswer({text:'Use `batch_A` for the sample.',toolCalls:[]}), 'Use batch_A for the sample.');
});
test('only explicit unquoted narration requests opt into the full answer', () => {
  const reply={text:'One. Two. Three. Four.',spokenText:'Brief.',toolCalls:[]};
  assert.equal(spokenAnswer(reply,'Read the full answer.'),reply.text);
  assert.equal(spokenAnswer(reply,'Do not read the full answer.'),'Brief.');
  assert.equal(spokenAnswer(reply,'The note says “read the full answer”.'),'Brief.');
});
test('compaction distinguishes rejection and failure from completed work',()=>{
  for(const status of ['rejected','failed','no_matches']){
    const result=compactToolOutcome({call:{id:'t',name:'search_notes',arguments:{query:'tides'}},result:{status,executed:status!=='rejected',error:'specific query failed'}});
    assert.equal(result.status,status);assert.equal(result.executed,status!=='rejected');assert.equal(result.query,'tides');
  }
});
