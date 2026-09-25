import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../../../packages/contracts/src/index.js";
import type { ResponseRun } from "../../../packages/agent/src/response-runner.js";
import { createPiRunner, createDeepSeekRunner } from "../src/index.js";

const tools = [
  { name: "search_notes", description: "Search synthetic notes.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "read_note", description: "Read one synthetic note.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];

function fixture(overrides: Partial<ResponseRun> = {}) {
  const calls: any[] = [], actions: any[] = [], snapshots: ChatMessage[][] = [];
  const input: ResponseRun = {
    messages: [{ role: "system", content: "Use only supplied notes." }, { role: "user", content: "What is the count in note-n?" }],
    signal: new AbortController().signal, maxSteps: 2,
    prepare: async (messages, step) => ({ messages, tools: step === 1 ? [] : tools, responseMode: step === 1 ? "answer_only" : "auto" }),
    generate: async (frame, step) => {
      calls.push({ frame: structuredClone(frame), step });
      if (step === 0) return { text: "", toolCalls: [{ id: "call-1", name: "read_note", arguments: { id: "note-n" } }] };
      assert(frame.messages.some(m => m.role === "tool" && m.toolCallId === "call-1" && m.content.includes("17")));
      return { text: "The count is 17 (note-n).", toolCalls: [] };
    },
    execute: async call => { actions.push(call); return { status: "retrieved", record: { id: "note-n", revision: 2, original: "Count: 17." } }; },
    checkpoint: async messages => { snapshots.push(structuredClone(messages)); }, ...overrides,
  };
  return { input, calls, actions, snapshots };
}

for (const [name, create] of [["Pi", createPiRunner], ["DSH", createDeepSeekRunner]] as const) {
  test(`${name}: actual SDK loop executes synthetic tool and returns answer-only final`, { timeout: 60000 }, async () => {
    const traces: any[] = [];
    const { input, calls, actions, snapshots } = fixture();
    const result = await create(event => traces.push(event)).run(input);
    assert.equal(result.reply?.text, "The count is 17 (note-n).");
    assert.equal(result.steps, 2);
    assert.equal(result.stopReason, "answered");
    assert.equal(calls.length, 2); assert.equal(actions.length, 1);
    assert.equal(actions[0].id, "call-1");
    assert.deepEqual(actions[0].arguments, { id: "note-n" });
    assert.equal(calls[1].frame.responseMode, "answer_only"); assert.deepEqual(calls[1].frame.tools, []);
    assert(snapshots.some(ms => ms.some(m => m.role === "tool" && m.content.includes("17"))));
    assert(traces.length > 1);
  });
  test(`${name}: provider failure is terminal with one attempt`, { timeout: 60000 }, async () => {
    let attempts = 0;
    const { input, actions } = fixture({ generate: async () => { attempts++; throw new Error("injected provider failure"); } });
    await assert.rejects(create().run(input), /injected provider failure/);
    assert.equal(attempts, 1); assert.equal(actions.length, 0);
  });
  test(`${name}: disallows filesystem tools before dispatch`, async () => {
    const { input } = fixture({ prepare: async messages => ({ messages, tools: [{ name: "bash", description: "forbidden", parameters: {} }], responseMode: "auto" }) });
    await assert.rejects(create().run(input), /disallows tool/);
  });
  test(`${name}: pre-aborted call dispatches nothing`, async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled fixture"));
    const { input, calls } = fixture({ signal: controller.signal });
    await assert.rejects(create().run(input), /cancelled fixture/);
    assert.equal(calls.length, 0);
  });
  test(`${name}: five tool steps then answer-only sixth stays within the hard bound`, { timeout: 60000 }, async () => {
    const frames: any[] = [];
    const { input, actions } = fixture({ maxSteps: 6,
      prepare: async (messages, step) => ({ messages, tools: step === 5 ? [] : tools, responseMode: step === 5 ? "answer_only" : "auto" }),
      generate: async (frame, step) => {
        frames.push({ frame, step });
        if (step === 5) return { text: "The count is 17.", toolCalls: [] };
        return { text: "", toolCalls: [{ id: `tool-${step}`, name: "read_note", arguments: { id: "note-n" } }] };
      },
    });
    const result = await create().run(input);
    assert.equal(result.steps, 6); assert.equal(frames.length, 6); assert.equal(actions.length, 5);
    assert.equal(frames[5].frame.messages.filter((m: ChatMessage) => m.role === "tool").length, 5);
  });
  test(`${name}: tool failure remains recoverable and is not a provider retry`, { timeout: 60000 }, async () => {
    let attempts = 0;
    const { input } = fixture({
      execute: async () => { throw new Error("injected retrieval failure"); },
      generate: async (frame, step) => {
        attempts++;
        if (step === 0) return { text: "", toolCalls: [{ id: "bad-read", name: "read_note", arguments: { id: "note-n" } }] };
        assert(frame.messages.some(m => m.role === "tool" && m.content.includes("injected retrieval failure")));
        return { text: "Retrieval failed; the count is unresolved.", toolCalls: [] };
      },
    });
    assert.equal((await create().run(input)).reply?.text, "Retrieval failed; the count is unresolved.");
    assert.equal(attempts, 2);
  });
  test(`${name}: illegal final tool proposal is never executed`, { timeout: 60000 }, async () => {
    const { input, actions } = fixture({ generate: async (_frame, step) => ({ text: "", toolCalls: [{ id: `call-${step}`, name: "read_note", arguments: { id: "note-n" } }] }) });
    await assert.rejects(create().run(input), /tools during answer_only/);
    assert.equal(actions.length, 1);
  });
  test(`${name}: re-prepares current evidence after tools and preserves the complete request`, { timeout: 60000 }, async () => {
    let revision = 1;
    const seen: number[] = [];
    const { input } = fixture({
      messages: [{ role: "system", content: "Use only my notes." }, { role: "user", content: "Explain note-n; keep it to two sentences." }],
      prepare: async (messages, step) => {
        seen.push(revision);
        return { messages: [{ role: "system", content: `Current authoritative note-n revision ${revision}: count ${revision === 1 ? 17 : 42}.` }, ...messages.filter(m => m.role !== "system")],
          tools: step ? [] : tools, responseMode: step ? "answer_only" : "auto" };
      },
      execute: async () => { revision = 2; return { status: "retrieved", record: { id: "note-n", revision: 1, original: "Count: 17." } }; },
      generate: async (frame, step) => {
        assert(frame.messages.some(m => m.role === "user" && m.content === "Explain note-n; keep it to two sentences."));
        if (!step) return { text: "", toolCalls: [{ id: "read-current", name: "read_note", arguments: { id: "note-n" } }] };
        assert.equal(frame.messages[0].content, "Current authoritative note-n revision 2: count 42.");
        return { text: "The current count is 42.", toolCalls: [] };
      },
    });
    assert.equal((await create().run(input)).reply?.text, "The current count is 42.");
    assert.deepEqual(seen, [1, 2]);
  });
}
