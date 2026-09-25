import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MemoryBrain} from '../../packages/brain/src/memory.js';
import {SQLiteBrain} from '../../packages/brain/src/index.js';
import {createNanobotRunner} from './nanobot.js';
import {nativeResponseRunner} from '../../packages/agent/src/response-runner.js';
import {runWorkflow,scoreRun} from './workflow.js';
import {runJ1Case} from './j1.js';
const load=async(p:string)=>JSON.parse(await readFile(new URL(p,import.meta.url),'utf8'));
const closed=await load('../evaluation/closed-task-cases.json'),legacy=await load('../../experiments/fixtures/agent-harness-cases.json');
const j1=await load('./j1-cases.json');
const oracle=(c:any)=>({status:c.expected.status,facts:c.expected.facts,sources:c.expected.sourceIds.map((id:string)=>({id,revision:c.sources.find((n:any)=>n.id===id).revision})),acknowledgedFailures:c.expected.failureIds,scope:c.expected.scope});
for(const storage of ['memory','sqlite'])for(const runner of [nativeResponseRunner,createNanobotRunner()]) {
  test(`${runner.name}/${storage}: all eight fixture flows retain current evidence and score their machine contract`,async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'moolai-router-fixtures-'));
    try {
      for(const [i,c]of closed.cases.entries()) {
        const create=()=>storage==='memory'?new MemoryBrain():new SQLiteBrain(path.join(dir,c.id));
        const row=await runWorkflow(c,legacy.agentCases[i],create(),async(frame,step)=>{
          assert(!JSON.stringify(frame).includes('requestFeatures'));
          if(c.requiredRead&&step===1){assert(!JSON.stringify(frame).includes('12 minutes'));return {text:'',toolCalls:[{id:'complete-read',name:'read_note',arguments:{id:c.requiredRead.id}}]};}
          return {text:JSON.stringify(oracle(c)),toolCalls:[]};
        },runner,storage==='sqlite'?async()=>create():undefined);
        scoreRun(c,row,[]);assert.equal(row.score.status,'passed',JSON.stringify({case:c.id,score:row.score,state:row.state}));
        assert(row.restartRetained);assert.equal(row.state.webAllowed,false);
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  });
}
for(const storage of ['memory','sqlite'])test(`J1 ${storage}: observed start, help offer and decline preserve source and capture nothing`,async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'moolai-j1-fixtures-'));
  try {
    for(const id of ['j01','j10','j12']) {
      const item=j1.cases.find((c:any)=>c.id===id),brain=storage==='memory'?new MemoryBrain():new SQLiteBrain(path.join(dir,id));
      const result=await runJ1Case(item,brain,async()=>({route:item.expectedRoute,confidence:1}));
      assert(result.actionMatches,JSON.stringify(result));assert(result.sourceRetained);assert.equal(result.captures,0);await brain.close();
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('current controller routes one assembled active turn through J1, preserving all three blocks',async()=>{
  const brain=new MemoryBrain();
  const item={id:'continuous',text:'',blocks:['Explain the comparison.','Use only my notes.','Keep it to two sentences.'],activeConversation:true,
    priorContext:'We are discussing my notes.',expectedRoute:'continue_agent',expectedAction:'continue',notesOnly:true};
  const result=await runJ1Case(item,brain,async()=>({route:'continue_agent',confidence:1}));
  assert.equal(result.inputs.length,1);assert.equal(result.inputs[0]?.text,item.blocks.join(' '));assert.equal(result.gateBypassed,false);assert(result.actionMatches);assert(result.sourceRetained);assert(result.notesOnlyHonored);
  assert.equal(result.responses,1);await brain.close();
});
test('Nanobot preserves source and withholds an answer after provider failure or a concurrent manual correction',async()=>{
  const c=closed.cases[2],fixture=legacy.agentCases[2];
  for(const change of [false,true]) {
    const brain=new MemoryBrain();
    const row=await runWorkflow(c,fixture,brain,async()=>{
      if(!change)throw new Error('Injected provider failure');
      const note=await brain.getRecord(c.sources[0].id);assert(note);
      await brain.updateRecord(note.id,note.revision,{summary:'Manual correction',manualFields:['summary']});
      return {text:JSON.stringify(oracle(c)),toolCalls:[]};
    },createNanobotRunner());
    assert(row.execution.sourceRetained);assert.equal(row.status,'failed');assert.equal(row.output,'');
  }
});
