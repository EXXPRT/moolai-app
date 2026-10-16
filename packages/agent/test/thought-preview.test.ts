import test from 'node:test';
import assert from 'node:assert/strict';
import {thoughtPreview} from '../src/thought-preview.js';
import {ThoughtSchedule} from '../../agent-host/src/thought-schedule.js';
import type {Segment} from '../../contracts/src/index.js';
const segment=(text:string,speaker:Segment['speaker']='user',i=0):Segment=>({id:String(i),turnId:String(i),revision:1,text,speaker,final:true,createdAt:'2026-10-02T00:00:00Z'});

test('interim preview contains attributed source, uncertainty and quantities; no synthetic claims',()=>{
  const p=thoughtPreview([segment('Maybe 5 grams, not 50. We have not completed the experiment.'),segment('I suggested checking the scale.','assistant'),segment('Internal diagnostic.','system')]);
  assert.match(p.title,/Maybe 5 grams, not 50/);assert.match(p.summary,/not completed/);assert.match(p.summary,/\*\*You:\*\*/);assert.match(p.summary,/\*\*Moo:\*\*/);assert.ok(!p.summary.includes('Internal diagnostic'));
});
test('long previews are bounded, visibly excerpted, preserve original source and escape source markup',()=>{
  const source=Array.from({length:60},(_,i)=>segment(`Point ${i}: **Quoted** [link](https://example.com) `+'long words '.repeat(150),'user',i));
  const before=structuredClone(source),preview=thoughtPreview(source);
  assert.ok(preview.summary.length<1500);assert.ok(preview.title.length<=81);assert.match(preview.summary,/…/);assert.match(preview.summary,/Point 59/);assert.deepEqual(source,before);assert.ok(preview.summary.includes('\\*\\*Quoted'));
});
test('fresh work gets an early pass; subsequent drafts coalesce while work is running',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0,release!:()=>void;
  const schedule=new ThoughtSchedule({run:()=>{calls++;return new Promise<void>(r=>release=r)},enabled:()=>true,onError:()=>{}});
  schedule.draftAvailable();t.mock.timers.tick(3000);schedule.draftAvailable();t.mock.timers.tick(2999);assert.equal(calls,0);
  t.mock.timers.tick(1);assert.equal(calls,1);schedule.draftAvailable();t.mock.timers.tick(60000);assert.equal(calls,1);
  release();await Promise.resolve();t.mock.timers.tick(60000);assert.equal(calls,2);release();await Promise.resolve();schedule.close();
});
test('typed work can start while capture/session is off; periodic work stays off; shutdown cancels timers',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0;
  const schedule=new ThoughtSchedule({run:async()=>{calls++},enabled:()=>true,periodicEnabled:()=>false,onError:()=>{}});
  schedule.draftAvailable();t.mock.timers.tick(6000);await Promise.resolve();assert.equal(calls,1);
  t.mock.timers.tick(60000);assert.equal(calls,1);schedule.draftAvailable();schedule.close();t.mock.timers.tick(60000);assert.equal(calls,1);
});

test('typed source arriving during an in-flight pass gets one delayed follow-up with periodic work off',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  let calls=0,inFlight=0,maxInFlight=0,release!:()=>void;
  const schedule=new ThoughtSchedule({enabled:()=>true,periodicEnabled:()=>false,onError:()=>{},
    run:()=>{calls++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);return new Promise<void>(resolve=>release=()=>{inFlight--;resolve();});}});
  schedule.draftAvailable();t.mock.timers.tick(6000);assert.equal(calls,1);
  for(let i=0;i<5;i++)schedule.draftAvailable();
  t.mock.timers.tick(180000);assert.equal(calls,1,'No concurrent pass while the first one is pending');
  release();await Promise.resolve();
  t.mock.timers.tick(59999);assert.equal(calls,1);
  t.mock.timers.tick(1);assert.equal(calls,2,'One follow-up runs at the normal cadence');
  release();await Promise.resolve();t.mock.timers.tick(180000);
  assert.equal(calls,2,'The notification was consumed once');assert.equal(maxInFlight,1);schedule.close();
});

test('notifications after a completed first pass cannot repeatedly dispatch every six seconds',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0;
  const schedule=new ThoughtSchedule({run:async()=>{calls++;},enabled:()=>true,periodicEnabled:()=>false,onError:()=>{}});
  schedule.draftAvailable();t.mock.timers.tick(6000);await Promise.resolve();assert.equal(calls,1);
  for(let i=0;i<9;i++){schedule.draftAvailable();t.mock.timers.tick(6000);await Promise.resolve();assert.equal(calls,1);}
  schedule.draftAvailable();t.mock.timers.tick(5999);assert.equal(calls,1);
  t.mock.timers.tick(1);await Promise.resolve();assert.equal(calls,2);
  schedule.draftAvailable();t.mock.timers.tick(6000);assert.equal(calls,2);
  schedule.close();t.mock.timers.tick(180000);assert.equal(calls,2,'Closing cancels the coalesced follow-up');
});

test('periodic ticks do not preempt a scheduled source pass or consume an idle first-source deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0;
  const schedule=new ThoughtSchedule({run:async()=>{calls++;},enabled:()=>true,onError:()=>{}});
  t.mock.timers.tick(60000);await Promise.resolve();assert.equal(calls,1,'An idle periodic check may run');
  schedule.draftAvailable();t.mock.timers.tick(5999);assert.equal(calls,1);
  t.mock.timers.tick(1);await Promise.resolve();assert.equal(calls,2,'First new source still gets its six-second pass');
  t.mock.timers.tick(4000);schedule.draftAvailable();
  t.mock.timers.tick(50000);await Promise.resolve();assert.equal(calls,2,'Periodic tick does not shorten the source coalescing window');
  t.mock.timers.tick(10000);await Promise.resolve();assert.equal(calls,3);schedule.close();
});

test('closing during an in-flight pass discards its queued follow-up',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});let calls=0,release!:()=>void;
  const schedule=new ThoughtSchedule({run:()=>{calls++;return new Promise<void>(resolve=>release=resolve);},enabled:()=>true,periodicEnabled:()=>false,onError:()=>{}});
  schedule.draftAvailable();t.mock.timers.tick(6000);schedule.draftAvailable();schedule.close();
  release();await Promise.resolve();t.mock.timers.tick(180000);assert.equal(calls,1);
});
