import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentReply, BrainPort, GenerationProvider} from '../../contracts/src/index.js';
import {MemoryBrain, SQLiteBrain} from '../../brain/src/index.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

// Ian's 21 Oct test A: Ultra spent all 4,096 output tokens reasoning on the misheard "They spin the conveyor belt."
// and the answer failed. An answer that hits its output limit now gets one automatic retry, asked to be brief.
const at = '2026-10-21T10:00:00.000Z';
const ANSWER_FAILED = "I couldn't finish that answer. Your request is saved; ask again when you're ready.";
const BRIEF = 'Your previous attempt ran out of output allowance.';
const TOOL_CLAUSE = 'call only the one tool you still need';
const STEP_LINE = '\nYour previous attempt ran out of output allowance. Keep this step short: call only the one tool you still need, or answer in under 200 words with spokenOutline null; if the request is unclear or looks misheard, ask one short clarifying question.';
const FINAL_LINE = '\nYour previous attempt ran out of output allowance. Answer in under 200 words with spokenOutline null; if the request is unclear or looks misheard, ask one short clarifying question.';
const outputLimit = () => Object.assign(new Error('Backend 422: Generation exceeded its 4,096-token output limit; source remains saved locally. Explicit retry required.'), {status: 422});
const answer: AgentReply = {text: 'Osmosis moves water across a membrane toward the side with more dissolved solute.',
  spokenText: 'Osmosis moves water toward the side with more dissolved solute.', toolCalls: []};
const search = (n: number): AgentReply => ({text: '', toolCalls: [{id: `search-${n}`, name: 'search_notes', arguments: {query: `osmosis membrane ${n}`}}]});
const deferred = () => {let release!: () => void; const promise = new Promise<void>(r => release = r); return {promise, release};};
type Step = AgentReply | Error | (() => Promise<AgentReply>);

for (const kind of ['memory', 'sqlite'] as const) {
  async function rig(options: {responseExperiment?: 'prompt'} = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'moolai-answer-limit-'));
    const brain: BrainPort = kind === 'memory' ? new MemoryBrain() : new SQLiteBrain(dir);
    const p = new FixtureProviders(); let n = 0;
    const script: Step[] = [];
    const calls: {system: string; tools: string[]; settings?: Parameters<GenerationProvider['respond']>[3]; signal?: AbortSignal}[] = [];
    const spoken: string[] = [];
    const respond: GenerationProvider['respond'] = async (messages, tools, signal, settings) => {
      calls.push({system: messages[0]!.content, tools: tools.map(tool => tool.name), settings, signal});
      const step = script[calls.length - 1] ?? answer;
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : structuredClone(step);
    };
    const agent = new Agent({brain, decisions: p, search: p, vision: p,
      generation: {consolidate: p.consolidate.bind(p), summarize: p.summarize.bind(p), respond},
      capture: {async capture() {throw Error('Capture is unavailable in this fixture');}},
      speech: {async speak(text) {spoken.push(text);}, async stop() {}},
      id: () => `${kind}-${++n}`, now: () => at, ...options});
    await agent.initialize();
    return {agent, script, calls, spoken,
      failures: () => spoken.filter(text => text === ANSWER_FAILED).length,
      retries: async () => ((await brain.getState<{action: string; step?: number}[]>('interaction-trace')) ?? [])
        .filter(entry => entry.action === 'answer_retry_after_output_limit'),
      published: async () => (await brain.getRecord(agent.getState().conversationId!))!.segments.filter(s => s.speaker === 'assistant').map(s => s.text),
      async ask(text = 'Moo, explain osmosis.') {await agent.submitText(text); await agent.drain();},
      async started(count: number) {for (let i = 0; i < 500 && calls.length < count; i++) await new Promise(r => setTimeout(r, 2)); assert.equal(calls.length, count);},
      async close() {await agent.interrupt(); await agent.drain(); await brain.close(); await rm(dir, {recursive: true, force: true});}};
  }
  const run = (name: string, body: (t: Awaited<ReturnType<typeof rig>>) => Promise<void>, options: Parameters<typeof rig>[0] = {}) =>
    test(`${kind}: ${name}`, {timeout: 10000}, async () => {const t = await rig(options); try {await body(t);} finally {await t.close();}});

  run('one output-limit failure is retried, and the answer is published and spoken', async t => {
    t.script.push(outputLimit(), answer);
    await t.ask();
    assert.equal(t.calls.length, 2, 'One automatic retry');
    assert.equal(t.agent.getState().lastError, undefined);
    assert.ok((await t.published()).includes(answer.text), 'The retried answer is in the conversation');
    assert.equal(t.spoken.at(-1), answer.spokenText);
    assert.equal(t.failures(), 0, 'No failure line is spoken');
    assert.deepEqual((await t.retries()).map(entry => entry.step), [0]);
    assert.ok(!t.calls[0]!.system.includes(BRIEF), 'The first call is unchanged');
    assert.ok(t.calls[1]!.system.endsWith(STEP_LINE), 'The retry asks for a short step, after the other per-step lines');
  });

  run('a second output-limit failure is not retried and fails once', async t => {
    t.script.push(outputLimit(), outputLimit());
    await t.ask();
    assert.equal(t.calls.length, 2, 'Exactly one retry');
    assert.equal(t.failures(), 1);
    assert.match(t.agent.getState().lastError ?? '', /output limit/);
    assert.equal((await t.retries()).length, 1);
  });

  run('a retry after step 0 still offers the tools, and the step after its tool call is not asked to be brief', async t => {
    t.script.push(outputLimit(), search(1), answer);
    await t.ask();
    assert.equal(t.calls.length, 3);
    assert.ok(t.calls[1]!.tools.includes('search_notes'));
    assert.deepEqual(t.calls[1]!.tools, t.calls[0]!.tools, 'The retry keeps every tool');
    assert.equal(t.calls[1]!.settings?.responseMode, undefined, 'The retry is an ordinary step, not answer-only');
    assert.ok(t.calls[1]!.system.includes(STEP_LINE));
    assert.ok(!t.calls[2]!.system.includes(BRIEF), 'Only the step after the failure carries the brevity line');
    assert.ok((await t.published()).includes(answer.text));
    assert.equal(t.failures(), 0);
  });

  run('a failure at step 4 is retried as the final answer-only step, without the tool clause', async t => {
    t.script.push(search(1), search(2), search(3), search(4), outputLimit(), answer);
    await t.ask();
    assert.equal(t.calls.length, 6, 'The retry uses the last of the six steps; none is added');
    assert.deepEqual((await t.retries()).map(entry => entry.step), [4]);
    const final = t.calls[5]!;
    assert.equal(final.settings?.responseMode, 'answer_only');
    assert.deepEqual(final.tools, []);
    assert.ok(final.system.includes(FINAL_LINE));
    assert.ok(!final.system.includes(TOOL_CLAUSE), 'No tool can run in the final step');
    assert.ok(!t.calls[4]!.system.includes(BRIEF));
    assert.ok((await t.published()).includes(answer.text));
    assert.equal(t.failures(), 0);
  });

  run('guard: a failure at the final step 5 is not retried', async t => {
    t.script.push(search(1), search(2), search(3), search(4), search(5), outputLimit());
    await t.ask();
    assert.equal(t.calls.length, 6);
    assert.equal(t.calls[5]!.settings?.responseMode, 'answer_only');
    assert.equal((await t.retries()).length, 0);
    assert.match(t.agent.getState().lastError ?? '', /output limit/, 'It fails with the provider error, not the step limit');
    assert.equal(t.failures(), 1);
  });

  run('guard: a request cancelled while its first call is pending is not retried', async t => {
    const gate = deferred();
    t.script.push(async () => {await gate.promise; throw outputLimit();});
    await t.agent.submitText('Moo, explain osmosis.');
    await t.started(1);
    await t.agent.interrupt();
    gate.release(); await t.agent.drain();
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0]!.signal?.aborted, true);
    assert.equal((await t.retries()).length, 0);
    assert.equal(t.failures(), 0, 'A cancelled request stays silent');
  });

  run('guard: a request superseded while its first call is pending is not retried', async t => {
    const gate = deferred();
    const next: AgentReply = {text: 'Diffusion spreads particles from high to low concentration.', spokenText: 'Diffusion spreads particles from high to low concentration.', toolCalls: []};
    t.script.push(async () => {await gate.promise; throw outputLimit();}, next);
    await t.agent.submitText('Moo, explain osmosis.');
    await t.started(1);
    await t.agent.submitText('What about diffusion?');
    await t.started(2);
    gate.release(); await t.agent.drain();
    assert.equal(t.calls.length, 2, 'One call for each request');
    assert.equal(t.calls[0]!.signal?.aborted, true);
    assert.equal((await t.retries()).length, 0);
    assert.ok((await t.published()).includes(next.text));
    assert.equal(t.failures(), 0);
  });

  for (const [name, error] of [
    ['an incomplete-output 502', Object.assign(new Error('Backend 502: Nebius output was incomplete; source remains saved locally. Finish reason: content_filter. Explicit retry required.'), {status: 502})],
    ['a 422 that is not an output limit', Object.assign(new Error('Backend 422: Tool names must be unique'), {status: 422})],
    ['an output-limit message without the 422 status', new Error('Generation exceeded its 4,096-token output limit; source remains saved locally. Explicit retry required.')],
  ] as const) run(`guard: ${name} is not retried and fails once`, async t => {
    t.script.push(error);
    await t.ask();
    assert.equal(t.calls.length, 1);
    assert.equal(t.failures(), 1);
    assert.equal(t.agent.getState().lastError, error.message);
    assert.equal((await t.retries()).length, 0);
  });

  run('guard: a validation experiment is not retried', async t => {
    t.script.push(outputLimit());
    await t.ask();
    assert.equal(t.calls.length, 1, 'Only the production path retries');
    assert.equal(t.failures(), 1);
    assert.equal((await t.retries()).length, 0);
  }, {responseExperiment: 'prompt'});
}
