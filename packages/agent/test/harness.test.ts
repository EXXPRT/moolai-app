import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, seedResponseExperiment } from "../src/index.js";
import { nativeResponseRunner } from "../src/response-runner.js";
import type { ResponseRunner } from "../src/response-runner.js";
import { currentHarnessEvidence, rememberFullRead } from "../src/harness-evidence.js";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import type { AgentReply, BrainPort, ChatMessage, ToolCall } from "../../contracts/src/index.js";

const at = "2026-09-21T08:00:00.000Z";
let counter = 0;
const source = (text: string, revision = 1) => ({ id: "source", turnId: "source", revision, speaker: "user" as const, text, final: true, createdAt: at });
const search = (query: string, id = query): ToolCall => ({ id, name: "search_notes", arguments: { query } });
const prior = { call: search("garden", "prior"), status: "success" as const, previewOnly: true, executed: false,
  result: { results: [{ id: "n1", original: "The old garden measurement was 20 cm." }] } };

async function prepare(brain: BrainPort) {
  for (const [id, kind] of [["session", "session"], ["conversation", "conversation"], ["n1", "note"]] as const)
    await brain.createRecord({ id, kind, createdAt: at });
  await brain.upsertSegment("n1", source("The current garden measurement is 40 cm."));
  await brain.setState("agent", { sessionId: "session", conversationId: "conversation", listening: true, busy: false, webAllowed: true });
  await seedResponseExperiment(brain, "conversation", { priorTools: [prior] });
}
function fixture(brain: BrainPort, policy: "current" | "revised" = "revised", runner: ResponseRunner = nativeResponseRunner) {
  const calls: { messages: ChatMessage[]; mode?: string; tools: string[] }[] = [];
  const previews: { call: ToolCall; allowed: boolean }[] = [];
  const spoken: string[] = [];
  const hooks = {
    respond: async (): Promise<AgentReply> => ({ text: "The current measurement is 40 cm [n1].", toolCalls: [] }),
    tool: async (call: ToolCall): Promise<unknown> => call.name === "read_note"
      ? { record: { id: "n1" } } : { results: [{ id: "n1" }] },
  };
  const forbidden = async (): Promise<never> => { throw new Error("Forbidden real capability"); };
  const agent = new Agent({ brain, id: () => `generated-${++counter}`, now: () => at,
    responseHarness: { runner, policy },
    decisions: { route: async () => ({ route: "continue_agent", confidence: 1 }),
      tag: async () => ({ purposeConfidence: 1, topics: {}, doubt: 0, faithful: 1, understandable: 1 }), connect: async () => ({}) },
    generation: { summarize: async () => ({ title: "Fixture", summary: "Fixture" }),
      respond: async (messages, tools, _signal, options) => {
        calls.push({ messages: structuredClone(messages), mode: options?.responseMode, tools: tools.map(tool => tool.name) });
        return hooks.respond();
      } },
    search: { search: forbidden, extract: forbidden }, vision: { interpret: forbidden }, capture: { capture: forbidden },
    speech: { speak: async text => { spoken.push(text); }, stop: async () => {} },
    previewTool: async (call, validation) => {
      previews.push({ call, allowed: validation.allowed });
      return validation.allowed ? hooks.tool(call) : { error: validation.reason };
    },
  });
  return { agent, hooks, calls, previews, spoken };
}

for (const adapter of ["memory", "sqlite"] as const) {
  const run = (name: string, action: (brain: BrainPort, directory: string) => Promise<void>) =>
    test(`${adapter} harness: ${name}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "moolai-harness-"));
      const brain = adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
      try { await prepare(brain); await action(brain, directory); }
      finally { await brain.close(); await rm(directory, { recursive: true, force: true }); }
    });

  run("sixth response reserves an answer and every source is saved before generation", async brain => {
    const f = fixture(brain);
    f.hooks.respond = async () => {
      assert.ok((await brain.getRecord("session"))!.segments.some(segment => segment.text === "Explain the garden measurement."));
      return f.calls.length < 6 ? { text: "", toolCalls: [search(`garden ${f.calls.length}`)] } : { text: "40 cm [n1].", toolCalls: [] };
    };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden measurement."); await f.agent.drain();
    assert.equal(f.calls.length, 6);
    assert.deepEqual(f.calls.at(-1)!.tools, []);
    assert.equal(f.calls.at(-1)!.mode, "answer_only");
    assert.equal(f.previews.length, 5);
    assert.deepEqual(f.spoken, ["40 cm [n1]."]);
  });

  run("current policy keeps six tool-capable calls and unresolved status", async brain => {
    const f = fixture(brain, "current");
    f.hooks.respond = async () => ({ text: "", toolCalls: [search(`garden ${f.calls.length}`)] });
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.equal(f.calls.length, 6);
    assert.ok(f.calls.every(call => call.mode === "auto" && call.tools.length === 2));
    assert.equal(f.previews.length, 6);
    assert.match(f.agent.getState().lastError!, /six-step/);
  });

  run("stale evidence is not published and a subsequent turn gets current text", async brain => {
    const f = fixture(brain);
    f.hooks.respond = async () => {
      await brain.upsertSegment("n1", source("The corrected garden measurement is 55 cm.", 2));
      return { text: "The old measurement is 40 cm.", toolCalls: [] };
    };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    // Only the spoken failure line plays; no stale or unfinished answer is spoken (MOO-060).
    assert.deepEqual(f.spoken, ["I couldn't finish that answer. Your request is saved; ask again when you're ready."]);
    assert.match(f.agent.getState().lastError!, /changed/);
    const next = fixture(brain); await next.agent.initialize();
    await next.agent.submitText("Use only my notes; explain the corrected garden."); await next.agent.drain();
    assert.match(JSON.stringify(next.calls[0]!.messages), /55 cm/);
    assert.doesNotMatch(JSON.stringify(next.calls[0]!.messages), /old garden measurement was 20/);
    assert.equal(next.agent.getState().webAllowed, false);
  });

  run("manual source corrections and provider failure retain user input without retries", async brain => {
    const f = fixture(brain);
    f.hooks.respond = async () => { throw new Error("Provider unavailable"); };
    await f.agent.initialize(); await f.agent.submitText("Keep this thought through failure."); await f.agent.drain();
    assert.equal(f.calls.length, 1);
    // Only the spoken failure line plays; no stale or unfinished answer is spoken (MOO-060).
    assert.deepEqual(f.spoken, ["I couldn't finish that answer. Your request is saved; ask again when you're ready."]);
    assert.ok((await brain.getRecord("session"))!.segments.some(s => s.text === "Keep this thought through failure."));
    const record = (await brain.getRecord("n1"))!;
    await brain.updateRecord("n1", record.revision, { summary: "My manual summary", manualFields: ["summary"] });
    await currentHarnessEvidence(brain, "conversation", "garden", false);
    assert.equal((await brain.getRecord("n1"))!.summary, "My manual summary");
  });

  run("one grounded repair, query-scoped outcomes and duplicate guard", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior], currentTools: [
      { call: search("", "bad"), status: "rejected", error: "Empty query", executed: false, previewOnly: true },
    ] });
    const f = fixture(brain);
    f.hooks.respond = async () => f.calls.length === 1
      ? { text: "", toolCalls: [search("garden measurement", "repair"), search("garden measurement", "duplicate"), search("garden height", "extra")] }
      : { text: "The measurement is 40 cm [n1].", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.deepEqual(f.previews.map(p => p.allowed), [true, false, false]);
    const results = f.calls[1]!.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content));
    assert.deepEqual(results.map(r => r.status), ["rejected", "success", "rejected", "rejected"]);
    assert.match(results[1].result.results[0].excerpt, /The current garden measurement is 40 cm\./);
  });

  run("retrieval failure and no matches remain distinct; unauthorized tools never execute", async brain => {
    const f = fixture(brain);
    f.hooks.tool = async call => {
      if (call.arguments.query === "garden failure") throw new Error("Retrieval unavailable");
      return { results: [] };
    };
    f.hooks.respond = async () => f.calls.length === 1 ? { text: "", toolCalls: [
      search("garden failure", "failed"), search("garden unknown", "none"),
      { id: "web", name: "search_web", arguments: { query: "garden" } },
    ] } : { text: "One query failed; the other had no matches.", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Use only my notes for the garden."); await f.agent.drain();
    const results = f.calls[1]!.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content));
    assert.deepEqual(results.map(r => r.status), ["failed", "no_matches", "rejected"]);
    assert.deepEqual(f.previews.map(p => p.allowed), [true, true, false]);
  });

  run("full read is reused only at its revision and truncation is explicit", async brain => {
    await brain.upsertSegment("n1", source("Garden log. ".repeat(65) + "The interval is 17 seconds.", 2));
    let evidence = await currentHarnessEvidence(brain, "conversation", "garden interval", false);
    assert.equal(evidence.notes[0]!.truncated, true);
    assert.doesNotMatch(evidence.notes[0]!.excerpt, /17 seconds/);
    await rememberFullRead(brain, "conversation", "n1");
    evidence = await currentHarnessEvidence(brain, "conversation", "garden interval", false);
    assert.equal(evidence.notes[0]!.truncated, false);
    assert.match(evidence.notes[0]!.excerpt, /17 seconds/);
    const f = fixture(brain);
    f.hooks.respond = async () => f.calls.length < 3
      ? { text: "", toolCalls: [{ id: `read-${f.calls.length}`, name: "read_note", arguments: { id: "n1" } }] }
      : { text: "17 seconds [n1].", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden interval."); await f.agent.drain();
    assert.equal(f.previews.length, 1);
    await brain.upsertSegment("n1", source("Garden corrected log. ".repeat(45) + "The interval is 19 seconds.", 3));
    evidence = await currentHarnessEvidence(brain, "conversation", "garden interval", false);
    assert.equal(evidence.notes[0]!.truncated, true);
  });

  run("concurrent runner reads retain both evidence entries and full-read revisions", async brain => {
    await brain.upsertSegment("n1", source("Garden alpha log. ".repeat(65) + "The first interval is 17 seconds.", 2));
    await brain.createRecord({ id: "n2", kind: "note", createdAt: at });
    await brain.upsertSegment("n2", source("Garden beta log. ".repeat(65) + "The second interval is 29 seconds."));
    const concurrentRunner: ResponseRunner = {
      name: "concurrent-test-runner",
      async run(input) {
        const messages = structuredClone(input.messages);
        const first = await input.generate(await input.prepare(messages, 0), 0);
        assert.equal(first.toolCalls.length, 2);
        messages.push({ role: "assistant", content: first.text, toolCalls: first.toolCalls });
        // An SDK may schedule a batch concurrently; the shared Agent must serialize persistence.
        const outputs = await Promise.all(first.toolCalls.map(call => input.execute(call)));
        for (const [index, result] of outputs.entries())
          messages.push({ role: "tool", toolCallId: first.toolCalls[index]!.id, content: JSON.stringify(result) });
        await input.checkpoint(messages);
        const reply = await input.generate(await input.prepare(messages, 1), 1);
        return { reply, steps: 2, stopReason: "answered" };
      },
    };
    const f = fixture(brain, "revised", concurrentRunner);
    f.hooks.tool = async call => ({ record: { id: call.arguments.id } });
    f.hooks.respond = async () => f.calls.length === 1
      ? { text: "", toolCalls: [
        { id: "read-alpha", name: "read_note", arguments: { id: "n1" } },
        { id: "read-beta", name: "read_note", arguments: { id: "n2" } },
      ] }
      : { text: "17 seconds [n1] and 29 seconds [n2].", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain both garden intervals."); await f.agent.drain();
    assert.equal(f.agent.getState().lastError, undefined);
    assert.equal(f.previews.length, 2);
    const evidence = await currentHarnessEvidence(brain, "conversation", "garden intervals", false);
    assert.deepEqual(evidence.notes.map(note => note.id).sort(), ["n1", "n2"]);
    assert(evidence.notes.every(note => !note.truncated));
    assert.match(evidence.notes.find(note => note.id === "n1")!.excerpt, /17 seconds/);
    assert.match(evidence.notes.find(note => note.id === "n2")!.excerpt, /29 seconds/);
    const full = await brain.getState<Record<string, number>>("harness:full-reads:conversation");
    assert.equal(full?.n1, (await brain.getRecord("n1"))!.revision);
    assert.equal(full?.n2, (await brain.getRecord("n2"))!.revision);
    assert.deepEqual(f.spoken, ["17 seconds [n1] and 29 seconds [n2]."]);
  });

  run("unexpected final tool cannot execute or publish", async brain => {
    const f = fixture(brain);
    f.hooks.respond = async () => ({ text: "", toolCalls: [search(`garden ${f.calls.length}`)] });
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.equal(f.previews.length, 5);
    assert.match(f.agent.getState().lastError!, /answer-only/);
    // Only the spoken failure line plays; no stale or unfinished answer is spoken (MOO-060).
    assert.deepEqual(f.spoken, ["I couldn't finish that answer. Your request is saved; ask again when you're ready."]);
  });
}

test("native loop cancellation cannot execute a returned tool", async () => {
  const controller = new AbortController();
  let executed = 0;
  await assert.rejects(nativeResponseRunner.run({ messages: [], signal: controller.signal, maxSteps: 6,
    prepare: async messages => ({ messages, tools: [], responseMode: "auto" }),
    generate: async () => { controller.abort(); return { text: "", toolCalls: [search("garden")] }; },
    execute: async () => { executed++; }, checkpoint: async () => {},
  }), /abort/i);
  assert.equal(executed, 0);
});

test("SQLite restarts retain source revisions, evidence and full-read state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolai-harness-restart-"));
  let brain = new SQLiteBrain(directory);
  try {
    await prepare(brain);
    await brain.upsertSegment("n1", source("Garden log. ".repeat(65) + "17 seconds.", 2));
    await rememberFullRead(brain, "conversation", "n1");
    const before = await currentHarnessEvidence(brain, "conversation", "garden", false);
    await brain.close(); brain = new SQLiteBrain(directory);
    assert.deepEqual(await currentHarnessEvidence(brain, "conversation", "garden", false), before);
    const f = fixture(brain); await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.match(JSON.stringify(f.calls[0]!.messages), /17 seconds/);
  } finally { await brain.close(); await rm(directory, { recursive: true, force: true }); }
});
