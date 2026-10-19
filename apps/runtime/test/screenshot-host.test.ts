import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain, SQLiteBrain} from '../../../packages/brain/src/index.js';
import {createAgentHost, FixtureProviders} from '../../../packages/agent-host/src/index.js';
import type {ChatMessage, AgentReply, VisionEvidence} from '../../../packages/contracts/src/index.js';
import {captureOptions} from '../src/capture-options.js';

// Exercise the real host, NativeBridge protocol, Agent and persistence without
// opening a microphone, capturing the desktop or calling a model provider.
for (const adapter of ['memory', 'sqlite'] as const) {
  for (const failure of ['none', 'permission', 'vision'] as const) {
    test(`${adapter}: screenshot host ${failure} preserves image provenance and never enables audio`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'moolai-screen-host-'));
      const nativePath = join(directory, 'companion.mjs');
      await writeFile(nativePath, `#!${process.execPath}
import {createInterface} from 'node:readline';
let captures=0;const methods=[];
createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);methods.push(c.method);let result={};
 if(c.method==='capture'){
  captures++;
  if(${JSON.stringify(failure)}==='permission'){console.log(JSON.stringify({id:c.id,error:'Screen Recording permission denied'}));return;}
  result={mimeType:'image/png',dataBase64:Buffer.from([137,80,78,71,captures]).toString('base64')};
 }
 if(c.method==='health')result={captures,methods,listening:false,requestedOn:false};
 console.log(JSON.stringify({id:c.id,result}));
});`, {mode: 0o700});
      const brain = adapter === 'memory' ? new MemoryBrain() : new SQLiteBrain(join(directory, 'brain'));
      let brainClosed = false;
      const images: {image: {mimeType: string; dataBase64: string}; question: string; mode?: string}[] = [];
      const frames: ChatMessage[][] = [];
      let generation = 0;
      const providers = Object.assign(new FixtureProviders(), {
        async respond(messages: ChatMessage[]): Promise<AgentReply> {
          frames.push(structuredClone(messages));
          generation++;
          return generation % 2 === 1
            ? {text: '', toolCalls: [{id: `capture-${generation}`, name: 'capture_screen', arguments: {question: 'Read the batch lot and weight. Do not use the receipt.', mode: 'ocr'}}]}
            : {text: failure === 'none' ? 'Weight is 82 kg. The batch lot remains unreadable.' : 'Screen analysis could not finish; the request is retained.', toolCalls: []};
        },
        async interpret(image: {mimeType: string; dataBase64: string}, question: string, _signal?: AbortSignal, options?: {mode: 'ocr' | 'visual'}): Promise<VisionEvidence> {
          images.push({image, question, mode: options?.mode});
          if (failure === 'vision') throw Error('Vision service unavailable');
          return {raw: 'PRIVATE_RAW_CONTRADICTION: receipt XQ-41 used as lot', observations: [
            {field: 'Batch lot', status: 'readable', value: 'XQ-41', label: 'Receipt', sourceExcerpt: 'Receipt XQ-41'},
            {field: 'Weight', status: 'readable', value: '82 kg', label: 'Weight', sourceExcerpt: 'Weight 82 kg'},
          ], interpretation: 'The batch lot is unreadable.', validated: true, validationErrors: []};
        },
      });
      const host = await createAgentHost({brain, providers, nativePath, onEvent() {},
        speech: {async warm() {throw Error('Speech must stay off');}, async speak() {throw Error('Speech must stay off');}, async stop() {}, close() {}},
        waitForAsr: async () => {throw Error('Recognition must stay off');}});
      try {
        await host.agent.submitText('Moo, take a screenshot and read the batch lot and weight.');
        await host.agent.drain();
        const id = host.agent.getState().conversationId!;
        const conversation = (await brain.getRecord(id))!;
        assert.match(conversation.segments.map(s => s.text).join('\n'), /take a screenshot/);
        const health = await host.nativeHealth() as {captures: number; methods: string[]; listening: boolean};
        assert.equal(health.captures, 1);
        assert.equal(health.listening, false);
        assert.ok(!health.methods.some(m => ['startListening', 'speak', 'beginSpeechAudio'].includes(m)));
        assert.equal(images.length, failure === 'permission' ? 0 : 1);
        assert.equal(conversation.attachmentIds.length, failure === 'permission' ? 0 : 1);
        if (images.length) {
          assert.equal(images[0]!.mode, 'ocr');
          assert.equal(images[0]!.image.mimeType, 'image/png');
          assert.deepEqual([...Buffer.from(images[0]!.image.dataBase64, 'base64')], [137,80,78,71,1]);
          const attachment = await brain.getAttachment(conversation.attachmentIds[0]!);
          assert.deepEqual([...attachment!.bytes], [137,80,78,71,1]);
        }
        if (failure === 'none') {
          const context = JSON.stringify(frames[1]);
          assert.match(context, /82 kg/);
          assert.doesNotMatch(context, /XQ-41|PRIVATE_RAW_CONTRADICTION|dataBase64/);
          const retained = await brain.getState<{evidence: VisionEvidence}>(`evidence:${conversation.attachmentIds[0]}`);
          assert.match(retained!.evidence.raw, /PRIVATE_RAW_CONTRADICTION/);
          assert.equal(retained!.evidence.observations[0]!.value, null);
          assert.ok(retained!.evidence.validationErrors.length);
        } else {
          assert.match(JSON.stringify(frames[1]), failure === 'permission' ? /permission denied/ : /Vision service unavailable/);
          assert.doesNotMatch(conversation.segments.filter(s => s.speaker === 'assistant').map(s => s.text).join(' '), /82 kg|XQ-41/);
        }
        await host.agent.drain();
        assert.equal((await host.nativeHealth() as {captures: number}).captures, 1, 'Failures and repeated drains cannot retry capture');
        if (adapter === 'sqlite') {
          await host.close();
          await brain.close();
          brainClosed = true;
          const restarted = new SQLiteBrain(join(directory, 'brain'));
          try {
            const saved = (await restarted.getRecord(id))!;
            assert.deepEqual(saved.attachmentIds, conversation.attachmentIds);
            if (saved.attachmentIds.length) assert.deepEqual([...(await restarted.getAttachment(saved.attachmentIds[0]!))!.bytes], [137,80,78,71,1]);
          } finally {await restarted.close();}
        }
      } finally {
        await host.close();
        if (!brainClosed) await brain.close();
        await rm(directory, {recursive: true, force: true});
      }
    });
  }
}

// Blocker 5: the desktop leaves its own window out of screen help, and says so only when the companion confirms it.
for (const companion of ['current', 'older'] as const) {
  test(`screenshot host asks the ${companion} companion to leave Moolai out and reports only what it confirms`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'moolai-screen-scope-'));
    const nativePath = join(directory, 'companion.mjs');
    await writeFile(nativePath, `#!${process.execPath}
import {createInterface} from 'node:readline';
const params=[];
createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);let result={};
 if(c.method==='capture'){
  params.push(c.params ?? {});
  result={mimeType:'image/png',dataBase64:Buffer.from([137,80,78,71]).toString('base64'),
   ...(${JSON.stringify(companion)}==='current' && (c.params?.excludeBundleIds ?? []).length ? {excludedApplications:['Electron']} : {})};
 }
 if(c.method==='health')result={params,listening:false,requestedOn:false};
 console.log(JSON.stringify({id:c.id,result}));
});`, {mode: 0o700});
    const brain = new MemoryBrain();
    const frames: ChatMessage[][] = [];
    let generation = 0;
    const providers = Object.assign(new FixtureProviders(), {
      async respond(messages: ChatMessage[]): Promise<AgentReply> {
        frames.push(structuredClone(messages));
        return ++generation === 1
          ? {text: '', toolCalls: [{id: 'capture-1', name: 'capture_screen', arguments: {question: 'Read the weight.', mode: 'ocr'}}]}
          : {text: 'Weight is 82 kg.', toolCalls: []};
      },
      async interpret(): Promise<VisionEvidence> {
        return {raw: '', observations: [{field: 'Weight', status: 'readable', value: '82 kg', label: 'Weight', sourceExcerpt: 'Weight 82 kg'}],
          interpretation: '', validated: true, validationErrors: []};
      },
    });
    const host = await createAgentHost({brain, providers, nativePath, onEvent() {}, ...captureOptions('live'),
      speech: {async warm() {}, async speak() {}, async stop() {}, close() {}}, waitForAsr: async () => {throw Error('Recognition must stay off');}});
    try {
      await host.agent.submitText('Moo, take a screenshot and read the weight.');
      await host.agent.drain();
      const health = await host.nativeHealth() as {params: {excludeBundleIds?: string[]}[]};
      assert.deepEqual(health.params, [{excludeBundleIds: ['com.github.Electron']}]);
      const context = JSON.stringify(frames[1]);
      if (companion === 'current') assert.match(context, /not captured: the Moolai window/);
      else assert.doesNotMatch(context, /not captured/, 'An older companion that ignores the request is not claimed to have left anything out');
    } finally {
      await host.close(); await brain.close(); await rm(directory, {recursive: true, force: true});
    }
  });
}

test('desktop fixture mode never asks the companion for a real screenshot (FU1-11)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moolai-screen-fixture-'));
  const nativePath = join(directory, 'companion.mjs');
  await writeFile(nativePath, `#!${process.execPath}
import {createInterface} from 'node:readline';
const methods=[];
createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);methods.push(c.method);
 console.log(JSON.stringify({id:c.id,result:c.method==='health'?{methods,listening:false,requestedOn:false}:{}}));
});`, {mode: 0o700});
  const brain = new MemoryBrain();
  let generation = 0;
  const providers = Object.assign(new FixtureProviders(), {
    async respond(): Promise<AgentReply> {
      return ++generation === 1
        ? {text: '', toolCalls: [{id: 'capture-1', name: 'capture_screen', arguments: {question: 'Read the weight.', mode: 'ocr'}}]}
        : {text: 'Done.', toolCalls: []};
    },
  });
  const host = await createAgentHost({brain, providers, nativePath, onEvent() {}, ...captureOptions('fixture'),
    speech: {async warm() {}, async speak() {}, async stop() {}, close() {}}, waitForAsr: async () => {throw Error('Recognition must stay off');}});
  try {
    await host.agent.submitText('Moo, take a screenshot and read the weight.');
    await host.agent.drain();
    const conversation = (await brain.getRecord(host.agent.getState().conversationId!))!;
    assert.equal(conversation.attachmentIds.length, 1, 'The simulated image is kept as the attachment');
    const health = await host.nativeHealth() as {methods: string[]};
    assert.ok(!health.methods.includes('capture'));
  } finally {
    await host.close(); await brain.close(); await rm(directory, {recursive: true, force: true});
  }
});
