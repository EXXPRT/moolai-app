import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRouterHarness } from './summarize-router-harness.mjs';

const sample = () => {
  const calls = [
    {callId:'a',phase:'routed',caseId:'c01',profile:'native',modelProfile:'lightning',step:1,status:'succeeded',reservedUsd:'.003',elapsedMs:200,usage:{prompt_tokens:100,completion_tokens:20}},
    {callId:'b',phase:'complexity',caseId:'c01',profile:'jev',modelProfile:'jev',step:1,status:'succeeded',reservedUsd:'.01',elapsedMs:100,usage:{input_tokens:100,output_tokens:20}},
  ];
  return { report: {complete:true,mode:'live',experiment:'x',budget:{maximumReservationUsd:'1',cumulativeCeilingUsd:'2'},calls,
    runs:[{phase:'routed',caseId:'c01',profile:'native',model:'lightning',status:'completed',output:'a correct prose answer',providerMs:200,providerCalls:1,restartRetained:true,execution:{sourceRetained:true,tools:[]},score:{status:'failed',failedChecks:['structuredOutput']}}],
    compatibility:[{profile:'codex',status:'incomplete'}],complexity:[{id:'c01',measured:true,selection:{model:'lightning'}}],
    j1:[{id:'j1',expectedAction:'continue',labelMatches:false,observedAction:'continue',actionMatches:true,incorrectStart:false,incorrectStop:false,sourceRetained:true,restartRetained:true,notesOnlyHonored:true,captures:0}],routingRestartRetained:true},
    ledger: {calls:[{callId:'old',reservedUsd:'1'},...calls.map(c=>({...c,validation:'x'}))]} };
};
test('includes the routing request in end-to-end cost and latency without forgiving format failures',()=>{
  const {report,ledger}=sample(), result=summarizeRouterHarness(report,ledger), routed=result.profiles.find(p=>p.id==='routed-native');
  assert.equal(routed.strictPassed,0);assert.equal(routed.returnedAnswers,1);assert.equal(routed.reservationUsd,.013);
  assert.equal(routed.medianProviderPathMs,300);assert.equal(result.j1.labelMatches,0);assert.equal(result.j1.actionMatches,1);
  assert.equal(result.incompatibleHarnesses.length,1);assert.equal(result.budget.previousReservedUsd,1);
});
test('rejects duplicate calls or a missing ledger charge',()=>{
  const {report,ledger}=sample();report.calls.push(report.calls[0]);assert.throws(()=>summarizeRouterHarness(report,ledger),/Duplicate/);
  report.calls.pop();ledger.calls.pop();assert.throws(()=>summarizeRouterHarness(report,ledger),/disagree/);
});
test('rejects offline controls and budget overruns',()=>{
  const {report,ledger}=sample();report.mode='offline';assert.throws(()=>summarizeRouterHarness(report,ledger),/live/);
  report.mode='live';report.budget.maximumReservationUsd='.01';assert.throws(()=>summarizeRouterHarness(report,ledger),/Budget/);
});
test('retains a failed call reservation and never converts a missing answer into a pass',()=>{
  const {report,ledger}=sample();report.calls[0].status='failed_or_unknown_charge';report.runs[0].status='failed';report.runs[0].output='';
  const result=summarizeRouterHarness(report,ledger),routed=result.profiles.find(p=>p.id==='routed-native');
  assert.equal(result.budget.newReservedUsd,.013);assert.equal(routed.returnedAnswers,0);assert.deepEqual(routed.noCompletedAnswer,['c01']);
});
