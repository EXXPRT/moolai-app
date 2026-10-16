import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForLocalAsr} from '../../../packages/agent-host/src/asr-ready.js';

test('ASR readiness waits for a loaded model, not merely an HTTP listener', async()=>{
  let calls=0;
  await waitForLocalAsr(new AbortController().signal, {intervalMs:1, timeoutMs:1000,
    fetch:async(url, options)=>{
      assert.equal(String(url),'http://127.0.0.1:8178/health');
      assert.equal(options?.redirect,'error');
      calls++;
      if(calls===1) throw Error('connection refused');
      return Response.json({ready:calls===3});
    }});
  assert.equal(calls,3);
});

test('ASR startup has a bounded failure and does not trust remote redirects/addresses', async()=>{
  await assert.rejects(waitForLocalAsr(new AbortController().signal,{timeoutMs:8,intervalMs:1,
    fetch:async()=>Response.json({ready:false})}), /Start npm run asr/);
  for(const url of ['ws://example.com/asr','http://127.0.0.1:8178/asr','ws://secret@localhost:8178/asr'])
    await assert.rejects(waitForLocalAsr(new AbortController().signal,{url}), /local ws/);
});

test('explicit stop cancels readiness without a late microphone-start opportunity', async()=>{
  const controller=new AbortController();let calls=0;
  const pending=waitForLocalAsr(controller.signal,{intervalMs:1000,fetch:async()=>{
    calls++; controller.abort();return Response.json({ready:false});
  }});
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(calls,1);
});
