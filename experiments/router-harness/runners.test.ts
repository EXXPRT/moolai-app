import assert from 'node:assert/strict';
import test from 'node:test';
import { createNanobotRunner } from './nanobot.js';
import { nativeResponseRunner, type ResponseRun } from '../../packages/agent/src/response-runner.js';
import type { AgentReply } from '../../packages/contracts/src/index.js';

const tool={name:'read_note',description:'Read synthetic note',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}};
const proposal: AgentReply={text:'',toolCalls:[{id:'read-1',name:'read_note',arguments:{id:'fixture'}}]};
function input(replies: (AgentReply|Error)[], maxSteps=6) {
  const calls: unknown[]=[],events:unknown[]=[],checkpoints:unknown[]=[];
  const controller=new AbortController();
  const run: ResponseRun={messages:[{role:'user',content:'Read fixture, report its marker. Only my notes.'}],signal:controller.signal,maxSteps,
    prepare:async(messages,step)=>({messages,tools:step===maxSteps-1?[]:[tool],responseMode:step===maxSteps-1?'answer_only':'auto'}),
    generate:async(frame,step)=>{calls.push({frame,step});const reply=replies[Math.min(step,replies.length-1)]!;if(reply instanceof Error)throw reply;return reply;},
    execute:async(call)=>{events.push(call);return {status:'success',id:'fixture',revision:2,marker:73};},
    checkpoint:async(messages)=>{checkpoints.push(structuredClone(messages));},
  };
  return {run,calls,events,checkpoints,controller};
}
for(const runner of [nativeResponseRunner,createNanobotRunner()]) {
  test(`${runner.name}: actual loop dispatches a note and receives its evidence`,async()=>{
    const r=input([proposal,{text:'73',toolCalls:[]}]);
    const result=await runner.run(r.run);
    assert.equal(result.reply?.text,'73');assert.equal(r.calls.length,2);
    assert.deepEqual(r.events,[proposal.toolCalls[0]]);
    const next=(r.calls[1] as any).frame.messages;
    assert(next.some((m:any)=>m.role==='tool'&&m.toolCallId==='read-1'&&m.content.includes('73')));
  });
  test(`${runner.name}: failed provider and pre-abort make no additional attempts`,async()=>{
    const failed=input([new Error('injected failure')]);
    await assert.rejects(runner.run(failed.run),/injected failure/);assert.equal(failed.calls.length,1);
    const cancelled=input([{text:'never',toolCalls:[]}]);cancelled.controller.abort();
    await assert.rejects(runner.run(cancelled.run));assert.equal(cancelled.calls.length,0);
  });
}
test('Nanobot: empty output cannot trigger its SDK recovery request',async()=>{
  const r=input([{text:'',toolCalls:[]}]);
  await assert.rejects(createNanobotRunner().run(r.run),/Empty model response/);assert.equal(r.calls.length,1);
});
test('Nanobot: final answer mode rejects further tools, shell is never executed',async()=>{
  for(const tools of [proposal.toolCalls,[{id:'s',name:'shell',arguments:{command:'never'}}]]) {
    const r=input([{text:'',toolCalls:tools}],1);
    await assert.rejects(createNanobotRunner().run(r.run),/answer_only/);assert.equal(r.events.length,0);assert.equal(r.calls.length,1);
  }
});
test('Nanobot: updated evidence reaches the next model call and cancellation stops continuation',async()=>{
  const r=input([proposal,{text:'current revision 3',toolCalls:[]}]);
  r.run.prepare=async(messages,step)=>({messages:[...messages,{role:'system',content:`authoritative revision ${step+2}`}],tools:[tool],responseMode:'auto'});
  await createNanobotRunner().run(r.run);
  assert((r.calls[1] as any).frame.messages.at(-1).content.includes('revision 3'));
  const c=input([proposal]);c.run.execute=async()=>{c.controller.abort();return {status:'success'};};
  await assert.rejects(createNanobotRunner().run(c.run));assert.equal(c.calls.length,1);
});
