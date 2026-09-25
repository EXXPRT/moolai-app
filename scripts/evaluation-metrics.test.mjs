import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { words, wordErrors, scoreAsr, scoreClosedTask, proposedTier, compareClosedTasks } from './evaluation-metrics.mjs';
const corpus = JSON.parse(await readFile(new URL('../experiments/evaluation/closed-task-cases.json', import.meta.url)));
const speech = JSON.parse(await readFile(new URL('../experiments/evaluation/asr-cases.json', import.meta.url)));
const good = c => ({ caseId:c.id, status:'completed', output:{status:c.expected.status, facts:structuredClone(c.expected.facts),
  scope:c.expected.scope, sources:c.expected.sourceIds.map(id => ({id, revision:c.sources.find(s => s.id === id).revision})),
  acknowledgedFailures:[...c.expected.failureIds]}, execution:{tools:c.requiredRead ? [{name:'read_note', ...c.requiredRead, complete:true,status:'success'}]:[],
  generationCalls:2, maximumWireBytes:5000, retries:0, sourceRetained:true, cancelled:false} });

test('word alignment records substitutions, deletions and insertions without hiding control confusions',()=>{
  assert.deepEqual(words("Moo, don’t use 1.5 meters!"),['moo',"don't",'use','1.5','meters']);
  assert.equal(wordErrors('Moo finish conversation','Move finish conversation').substitutions,1);
  assert.equal(wordErrors('end conversation','and conversation').errors,1);
  assert.equal(wordErrors('do not search web','do search web').deletions,1);
  assert.equal(wordErrors('keep going','please keep going').insertions,1);
});
test('WER uses total reference words and can exceed one; silence gets its own metric',()=>{
  assert.equal(wordErrors('hello','hello one two three').wer,3);
  assert.equal(wordErrors('','thank you').wer,null);
  assert.equal(wordErrors('','thank you').silenceInsertions,2);
  assert.equal(wordErrors('','').silenceInsertions,0);
  assert.equal(wordErrors('Moo!','moo').wer,0);
  assert.equal(wordErrors('forty','40').wer,1); // No undocumented normalizer advantage.
});
test('critical constraints and final words are measured separately from average WER',()=>{
  const c=speech.cases.find(c=>c.id==='s07');
  const r=scoreAsr(c,{status:'completed',transcript:'Use my notes. Search the web.',audioMs:4000,inferenceMs:400});
  assert(r.criticalPhrases.every(x=>!x.preserved));
  assert.equal(r.finalWordPreserved,true); assert.equal(r.realTimeFactor,0.1); assert.equal(r.routeCorrect,null);
});
test('text retention never fabricates a passed J1 result and missing ASR stays incomplete',()=>{
  const c=speech.cases[0];
  assert.equal(scoreAsr(c,{status:'completed',transcript:c.reference}).routeCorrect,null);
  assert.equal(scoreAsr(c,{status:'completed',transcript:c.reference,observedRoute:'dictate'}).routeCorrect,false);
  assert.equal(scoreAsr(c,{status:'failed'}).status,'incomplete');
  assert.equal(scoreAsr(c,{status:'completed',transcript:c.reference,audioMs:0,inferenceMs:-2}).realTimeFactor,null);
});
test('all frozen closed-task reference responses pass the declared machine contract',()=>{
  for(const c of corpus.cases) assert.equal(scoreClosedTask(c,good(c)).status,'passed',c.id);
});
test('corrected measurements and citations must both use the current revision',()=>{
  const c=corpus.cases[2], wrong=good(c); wrong.output.facts.lampDistanceCm=20;
  assert(scoreClosedTask(c,wrong).failedChecks.includes('facts'));
  const stale=good(c);stale.output.sources[0].revision=1;
  assert(scoreClosedTask(c,stale).failedChecks.includes('currentCitations'));
});
test('no matches is query-scoped and never establishes corpus-wide absence',()=>{
  const c=corpus.cases[1], r=good(c);r.output.scope='corpus';
  assert(scoreClosedTask(c,r).failedChecks.includes('claimScope'));
  r.output.scope='query';r.output.facts={brainEmpty:true};
  assert(scoreClosedTask(c,r).failedChecks.includes('facts'));
});
test('missing results cannot be converted into proved-nothing or none-planned facts',()=>{
  for(const index of [3,7]) {
    const c=corpus.cases[index],r=good(c);
    r.output.facts=index===3?{filterEffect:'none'}:{discoveriesPlanned:false};
    assert(scoreClosedTask(c,r).failedChecks.includes('facts'));
  }
});
test('a correct substantive answer still fails the explicit failure-disclosure contract',()=>{
  const c=corpus.cases[5],r=good(c);r.output.acknowledgedFailures=[];
  assert(scoreClosedTask(c,r).failedChecks.includes('failureDisclosure'));
});
test('guessed correct facts beyond an excerpt require observed complete current evidence',()=>{
  const c=corpus.cases[6];
  for(const patch of [{tools:[]},{tools:[{name:'read_note',...c.requiredRead,complete:false,status:'success'}]},
    {tools:[{name:'read_note',...c.requiredRead,complete:true,status:'failed'}]}]) {
    const r=good(c);Object.assign(r.execution,patch);
    assert(scoreClosedTask(c,r).failedChecks.includes('requiredRead'));
  }
});
test('a source instruction cannot authorize a web call or note write',()=>{
  const c=corpus.cases[7];
  for(const name of ['search_web','create_note','shell']) {
    const r=good(c);r.execution.tools.push({name});
    assert(scoreClosedTask(c,r).failedChecks.includes('toolAllowlist'));
  }
});
test('call, payload, retry, cancellation and source-retention failures remain visible',()=>{
  for(const [field,value,check] of [['generationCalls',7,'callBound'],['maximumWireBytes',12001,'wireBound'],['retries',1,'zeroRetries'],['cancelled',true,'notCancelled'],['sourceRetained',false,'sourceRetained']]) {
    const c=corpus.cases[0],r=good(c);r.execution[field]=value;
    assert(scoreClosedTask(c,r).failedChecks.includes(check));
  }
});
test('malformed, added or missing output fields are not repaired into success',()=>{
  for(const output of ['not JSON','```json\n{}\n```',[],null,{...good(corpus.cases[0]).output,answer:'an unchecked assertion'}]) {
    const r=good(corpus.cases[0]);r.output=output;
    assert(scoreClosedTask(corpus.cases[0],r).failedChecks.includes('structuredOutput'));
  }
});
test('unknown and duplicate citations cannot pass by copying a valid fact',()=>{
  for(const sources of [[{id:'invented',revision:2}], [good(corpus.cases[0]).output.sources[0],good(corpus.cases[0]).output.sources[0]]]) {
    const r=good(corpus.cases[0]);r.output.sources=sources;
    assert(scoreClosedTask(corpus.cases[0],r).failedChecks.includes('currentCitations'));
  }
});
test('missing execution observations and missing cases are incomplete, not zero-cost successes',()=>{
  const r=good(corpus.cases[0]);delete r.execution;
  assert.equal(scoreClosedTask(corpus.cases[0],r).status,'incomplete');
  const [cell]=compareClosedTasks(corpus.cases,[{id:'not-run',runs:[]}]);
  assert.equal(cell.incomplete,8);assert.equal(cell.passed,0);assert.equal(cell.eligibleForComparison,false);
});
test('comparisons preserve ties and refuse duplicated or unexpected case coverage',()=>{
  const runs=corpus.cases.map(good);
  const rows=compareClosedTasks(corpus.cases,[{id:'one',runs},{id:'two',runs}]);
  assert.deepEqual(rows.map(r=>r.passed),[8,8]);assert(rows.every(r=>r.proseQuality==='not_scored'));
  assert.throws(()=>compareClosedTasks(corpus.cases,[{id:'one',runs:[runs[0],runs[0]]}]),/Duplicate/);
  assert.throws(()=>compareClosedTasks(corpus.cases,[{id:'one',runs:[{...runs[0],caseId:'missing'}]}]),/unexpected/);
});
test('complexity policy separates ambiguity, synthesis and difficult evidence; no length heuristic',()=>{
  const f={ambiguous:false,task:'lookup',sourceCount:1,conflictingEvidence:false,dependentSteps:false};
  assert.equal(proposedTier(f),'low');
  assert.equal(proposedTier({...f,sourceCount:2}),'medium');
  assert.equal(proposedTier({...f,conflictingEvidence:true}),'high');
  assert.equal(proposedTier({...f,dependentSteps:true}),'high');
  assert.equal(proposedTier({...f,ambiguous:true}),'clarify');
  assert.throws(()=>proposedTier({...f,sourceCount:undefined}),/explicit/);
});
