import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, seedResponseExperiment } from "../../../packages/agent/src/index.js";
import { currentHarnessEvidence } from "../../../packages/agent/src/harness-evidence.js";
import type { ResponseRunner } from "../../../packages/agent/src/response-runner.js";
import { MemoryBrain, SQLiteBrain } from "../../../packages/brain/src/index.js";
import type { AgentReply, BrainPort, ChatMessage, ToolCall } from "../../../packages/contracts/src/index.js";
import { createPiRunner, createDeepSeekRunner } from "../src/index.js";

// These tests exercise each real SDK loop through Agent.submitText and each Brain
// adapter. Only the model and task-tool results are simulated; no network model,
// microphone, screen, web, or task capability is available to the fixture.
const at = "2026-09-21T08:00:00.000Z";
let counter = 0;
const source = (text: string, revision = 1) => ({ id: "source", turnId: "source", revision,
  speaker: "user" as const, text, final: true, createdAt: at });
const read = (): ToolCall => ({ id: "read-n1", name: "read_note", arguments: { id: "n1" } });

async function prepare(brain: BrainPort) {
  for (const [id, kind] of [["session", "session"], ["conversation", "conversation"], ["n1", "note"]] as const)
    await brain.createRecord({ id, kind, createdAt: at });
  await brain.upsertSegment("n1", source("The current garden measurement is 40 cm."));
  await brain.setState("agent", { sessionId: "session", conversationId: "conversation",
    listening: true, busy: false, webAllowed: true });
  await seedResponseExperiment(brain, "conversation", { priorTools: [{
    call: { id: "prior", name: "search_notes", arguments: { query: "garden" } },
    status: "success", previewOnly: true, executed: false,
    result: { results: [{ id: "n1", original: "The old garden measurement was 20 cm." }] },
  }] });
}

function fixture(brain: BrainPort, runner: ResponseRunner) {
  const calls: { messages: ChatMessage[]; tools: string[]; mode?: string }[] = [];
  const previews: ToolCall[] = [];
  const spoken: string[] = [];
  const hooks = {
    respond: async (): Promise<AgentReply> => ({ text: "40 cm [n1].", toolCalls: [] }),
    tool: async (call: ToolCall): Promise<unknown> => call.name === "read_note"
      ? { record: { id: "n1" } } : { results: [{ id: "n1" }] },
  };
  let forbiddenCalls = 0;
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error("Real capability forbidden in integration test"); };
  const agent = new Agent({ brain, id: () => `integration-${++counter}`, now: () => at,
    responseHarness: { runner, policy: "revised" },
    decisions: { route: async () => ({ route: "continue_agent", confidence: 1 }),
      tag: async () => ({ purposeConfidence: 1, topics: {}, doubt: 0, faithful: 1, understandable: 1 }),
      connect: async () => ({}) },
    generation: { summarize: async () => ({ title: "Fixture", summary: "Fixture" }),
      respond: async (messages, tools, _signal, options) => {
        calls.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.name), mode: options?.responseMode });
        return hooks.respond();
      } },
    search: { search: forbidden, extract: forbidden }, vision: { interpret: forbidden }, capture: { capture: forbidden },
    speech: { speak: async text => { spoken.push(text); }, stop: async () => {} },
    previewTool: async (call, validation) => {
      assert.equal(validation.allowed, true, validation.reason ?? "Expected an allowed synthetic note tool");
      previews.push(structuredClone(call));
      return hooks.tool(call);
    },
  });
  return { agent, calls, previews, spoken, hooks, forbiddenCalls: () => forbiddenCalls };
}

async function assertSource(brain: BrainPort, text: string) {
  for (const id of ["session", "conversation"])
    assert((await brain.getRecord(id))!.segments.some(segment => segment.speaker === "user" && segment.text === text),
      `${id} should retain the original source`);
}
async function assertUnpublished(brain: BrainPort, spoken: string[]) {
  assert.deepEqual(spoken, []);
  assert.equal((await brain.getRecord("conversation"))!.segments.filter(segment => segment.speaker === "assistant").length, 0);
}

for (const [sdk, create] of [["Pi", createPiRunner], ["DSH", createDeepSeekRunner]] as const) {
  for (const adapter of ["memory", "sqlite"] as const) {
    const run = (name: string, action: (context: { brain: BrainPort; reopen: () => Promise<BrainPort> }) => Promise<void>) =>
      test(`${sdk}/${adapter} Agent integration: ${name}`, { timeout: 60000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "moolai-sdk-agent-"));
        const context = {
          brain: adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory),
          async reopen(): Promise<BrainPort> {
            // A new Agent reuses MemoryBrain; SQLite additionally closes and
            // reopens its actual database. These are distinct restart claims.
            if (adapter === "sqlite") {
              await context.brain.close();
              context.brain = new SQLiteBrain(directory);
            }
            return context.brain;
          },
        };
        try { await prepare(context.brain); await action(context); }
        finally { await context.brain.close(); await rm(directory, { recursive: true, force: true }); }
      });

    run("source precedes generation, notes-only full read and evidence survive restart", async context => {
      const brain = context.brain;
      await brain.upsertSegment("n1", source("Garden observation. ".repeat(50) + "The interval is 17 seconds.", 2));
      const f = fixture(brain, create());
      const request = "Use only my notes; explain the garden interval in two sentences.";
      f.hooks.respond = async () => {
        await assertSource(brain, request);
        assert.deepEqual(f.calls.at(-1)!.tools, ["search_notes", "read_note"]);
        assert.equal(f.agent.getState().webAllowed, false);
        if (f.calls.length === 1) return { text: "", toolCalls: [read()] };
        assert.match(JSON.stringify(f.calls.at(-1)!.messages), /17 seconds/);
        assert(f.calls.at(-1)!.messages.some(message => message.role === "user" && message.content.includes(request)));
        return { text: "The interval is 17 seconds [n1].", toolCalls: [] };
      };
      await f.agent.initialize(); await f.agent.submitText(request); await f.agent.drain();
      assert.equal(f.agent.getState().lastError, undefined);
      assert.equal(f.calls.length, 2); assert.equal(f.previews.length, 1);
      assert.deepEqual(f.spoken, ["The interval is 17 seconds [n1]."]);
      assert.equal(f.forbiddenCalls(), 0);
      const before = await currentHarnessEvidence(brain, "conversation", "garden interval", false);
      assert.equal(before.notes[0]!.truncated, false);
      const reopened = await context.reopen();
      await assertSource(reopened, request);
      assert.deepEqual(await currentHarnessEvidence(reopened, "conversation", "garden interval", false), before);
      assert.equal((await reopened.getState<Record<string, number>>("harness:full-reads:conversation"))?.n1,
        (await reopened.getRecord("n1"))!.revision);
      const next = fixture(reopened, create());
      next.hooks.respond = async () => ({ text: "17 seconds [n1].", toolCalls: [] });
      await next.agent.initialize();
      assert.equal(next.agent.getState().webAllowed, false);
      await next.agent.submitText("Remind me of the interval."); await next.agent.drain();
      assert.match(JSON.stringify(next.calls[0]!.messages), /17 seconds/);
      assert.doesNotMatch(JSON.stringify(next.calls[0]!.messages), /old garden measurement was 20/);
      assert(next.calls.every(call => !call.tools.includes("search_web")));
      assert.equal(next.forbiddenCalls(), 0);
    });

    run("provider failure makes one attempt and keeps source through restart", async context => {
      const f = fixture(context.brain, create());
      const request = "Keep this garden thought through a provider failure.";
      f.hooks.respond = async () => {
        await assertSource(context.brain, request);
        throw new Error("Injected provider unavailable");
      };
      await f.agent.initialize(); await f.agent.submitText(request); await f.agent.drain();
      assert.equal(f.calls.length, 1); assert.equal(f.previews.length, 0);
      assert.match(f.agent.getState().lastError!, /Injected provider unavailable/);
      await assertUnpublished(context.brain, f.spoken);
      await assertSource(await context.reopen(), request);
      assert.equal(f.forbiddenCalls(), 0);
    });

    run("note source changed during generation rejects stale answer and reloads current evidence", async context => {
      const f = fixture(context.brain, create());
      f.hooks.respond = async () => {
        await context.brain.upsertSegment("n1", source("The corrected garden measurement is 55 cm.", 2));
        return { text: "The measurement is 40 cm [n1].", toolCalls: [] };
      };
      await f.agent.initialize(); await f.agent.submitText("Explain the garden measurement."); await f.agent.drain();
      assert.equal(f.calls.length, 1);
      assert.match(f.agent.getState().lastError!, /changed/);
      await assertUnpublished(context.brain, f.spoken);
      await assertSource(context.brain, "Explain the garden measurement.");
      const next = fixture(await context.reopen(), create());
      next.hooks.respond = async () => ({ text: "55 cm [n1].", toolCalls: [] });
      await next.agent.initialize(); await next.agent.submitText("Explain the corrected garden measurement."); await next.agent.drain();
      assert.match(JSON.stringify(next.calls[0]!.messages), /55 cm/);
      assert.doesNotMatch(JSON.stringify(next.calls[0]!.messages), /The current garden measurement is 40 cm|old garden measurement was 20/);
      assert.deepEqual(next.spoken, ["55 cm [n1]."]);
    });

    run("manual edit during generation rejects stale answer without overwriting the edit", async context => {
      const f = fixture(context.brain, create());
      f.hooks.respond = async () => {
        const note = (await context.brain.getRecord("n1"))!;
        await context.brain.updateRecord("n1", note.revision, { summary: "My manually corrected garden summary", manualFields: ["summary"] });
        return { text: "An answer prepared before the manual edit.", toolCalls: [] };
      };
      await f.agent.initialize(); await f.agent.submitText("Explain my garden note."); await f.agent.drain();
      assert.equal(f.calls.length, 1); assert.match(f.agent.getState().lastError!, /changed/);
      await assertUnpublished(context.brain, f.spoken);
      const reopened = await context.reopen();
      await currentHarnessEvidence(reopened, "conversation", "garden", false);
      const note = (await reopened.getRecord("n1"))!;
      assert.equal(note.summary, "My manually corrected garden summary");
      assert(note.manualFields.includes("summary"));
      await assertSource(reopened, "Explain my garden note.");
    });

    run("transcript correction during generation rejects the superseded answer", async context => {
      const f = fixture(context.brain, create());
      f.hooks.respond = async () => {
        for (const id of ["session", "conversation"]) {
          const record = (await context.brain.getRecord(id))!;
          const segment = record.segments.find(item => item.speaker === "user")!;
          await context.brain.upsertSegment(id, { ...segment, revision: segment.revision + 1, text: "Explain the corrected request instead." });
        }
        return { text: "Answer to the superseded request.", toolCalls: [] };
      };
      await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
      assert.equal(f.calls.length, 1); assert.match(f.agent.getState().lastError!, /changed/);
      await assertUnpublished(context.brain, f.spoken);
      await assertSource(await context.reopen(), "Explain the corrected request instead.");
    });

    run("cancel during generation prevents returned tools and speech while retaining the source", async context => {
      const f = fixture(context.brain, create());
      f.hooks.respond = async () => {
        await f.agent.resolveEnd("cancel");
        return { text: "", toolCalls: [read()] };
      };
      await f.agent.initialize(); await f.agent.submitText("Explain the garden, unless I cancel."); await f.agent.drain();
      assert.equal(f.calls.length, 1); assert.equal(f.previews.length, 0);
      assert.equal(f.agent.getState().conversationId, undefined);
      assert.equal(f.agent.getState().busy, false);
      await assertUnpublished(context.brain, f.spoken);
      await assertSource(await context.reopen(), "Explain the garden, unless I cancel.");
      assert.equal(f.forbiddenCalls(), 0);
    });
  }
}
