import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReply, BrainPort, ChatMessage, Segment, ToolCall, ToolDefinition } from "../../contracts/src/index.js";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import { Agent, type AgentOptions, seedResponseExperiment, readResponseEvidence } from "../src/index.js";
import { refreshResponseEvidence, responseToolEvent, type ExperimentToolEvent } from "../src/reliability.js";

const at = "2026-09-20T12:00:00.000Z";
let nextId = 0;
const segment = (id: string, text: string, revision = 1): Segment => ({ id, turnId: id, text, revision, speaker: "user", final: true, createdAt: at });
const call = (id: string, query: string): ToolCall => ({ id, name: "search_notes", arguments: { query } });
const prior: ExperimentToolEvent = { call: call("prior", "garden"), status: "success", previewOnly: true, executed: false,
  result: { results: [{ id: "n1", original: "old fixture content" }] } };
const rejected: ExperimentToolEvent = { call: call("invalid", ""), status: "rejected", error: "Invalid query", previewOnly: true, executed: false };

async function prepare(brain: BrainPort) {
  await brain.createRecord({ id: "session", kind: "session", createdAt: at });
  await brain.createRecord({ id: "conversation", kind: "conversation", createdAt: at });
  await brain.createRecord({ id: "n1", kind: "note", createdAt: at });
  await brain.upsertSegment("n1", segment("source", "The garden comparison used three shaded plots and six sunny plots."));
  await brain.setState("agent", { listening: true, busy: false, webAllowed: true, sessionId: "session", conversationId: "conversation" });
}

function fixture(brain: BrainPort, responseExperiment?: AgentOptions["responseExperiment"]) {
  const messages: ChatMessage[][] = [];
  const definitions: ToolDefinition[][] = [];
  const previews: { call: ToolCall; validation: { allowed: boolean; reason?: string } }[] = [];
  const hooks = {
    respond: async (_messages: ChatMessage[]): Promise<AgentReply> => ({ text: "Response.", toolCalls: [] }),
    preview: async (call: ToolCall, validation: { allowed: boolean; reason?: string }): Promise<unknown> => {
      if (!validation.allowed) return undefined;
      if (call.name === "search_notes") {
        if (call.arguments.query === "failure") throw new Error("Fixture retrieval unavailable");
        if (call.arguments.query === "no matches") return { results: [] };
        return { results: [{ id: "n1", original: "Fixture garden excerpt" }] };
      }
      return {};
    },
  };
  const options: AgentOptions = {
    brain, responseExperiment, id: () => `generated-${++nextId}`, now: () => at,
    decisions: {
      route: async () => ({ route: "continue_agent", confidence: 1 }),
      tag: async () => ({ purposeConfidence: 1, topics: {}, doubt: 0, faithful: 1, understandable: 1 }),
      connect: async () => ({}),
    },
    generation: {
      summarize: async () => ({ title: "Summary", summary: "Summary" }),
      respond: async (input, tools) => { messages.push(structuredClone(input)); definitions.push(structuredClone(tools)); return hooks.respond(input); },
    },
    search: { search: async () => { throw new Error("Real search must not run"); }, extract: async () => { throw new Error("Real extraction must not run"); } },
    capture: { capture: async () => { throw new Error("Real capture must not run"); } },
    vision: { interpret: async () => { throw new Error("Real vision must not run"); } },
    speech: { speak: async () => {}, stop: async () => {} },
    previewTool: async (tool, validation) => { previews.push({ call: structuredClone(tool), validation }); return hooks.preview(tool, validation); },
  };
  return { agent: new Agent(options), hooks, messages, definitions, previews };
}

for (const adapter of ["memory", "sqlite"] as const) {
  const run = (name: string, action: (brain: BrainPort, dir: string) => Promise<void>) => test(`${adapter} reliability: ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "moolai-reliability-"));
    const brain = adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(dir);
    try { await prepare(brain); await action(brain, dir); }
    finally { await brain.close(); await rm(dir, { recursive: true, force: true }); }
  });

  run("production uses evidence workflow and reserves call six for a final answer", async brain => {
    const f = fixture(brain);
    f.hooks.respond = async () => ({ text: "", toolCalls: [call(`call-${f.messages.length}`, "garden")] });
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.equal(f.messages.length, 6);
    assert.match(f.agent.getState().lastError!, /Final answer requested/);
    assert.match(f.messages[0]![0]!.content, /Current authoritative evidence/);
    assert.deepEqual(f.definitions[5], []);
    assert.match(f.definitions[0]!.find(t=>t.name==="search_notes")!.description, /bounded exact passages/);
    assert.match(f.messages[5]![0]!.content, /Retrieval has ended/);
    assert.doesNotMatch(f.messages[5]![0]!.content, /Allow one grounded repair/);
    assert.deepEqual(await readResponseEvidence(brain, "conversation"), { version: 1, notes: [], recentOutcomes: [] });
  });

  run("prompt profile changes instructions but does not reload prior evidence", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior], currentTools: [rejected] });
    const f = fixture(brain, "prompt");
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.match(f.messages[0]![0]!.content, /failed or rejected search/);
    assert.doesNotMatch(JSON.stringify(f.messages[0]), /three shaded plots|old fixture content|Current retained evidence/);
    assert.deepEqual(JSON.parse(f.messages[0]!.at(-1)!.content), { error: "Invalid query" });
  });

  run("workflow reloads sources rather than stale fixture excerpts and labels preview outcomes", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior], currentTools: [rejected] });
    const f = fixture(brain, "workflow");
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.match(f.messages[0]![0]!.content, /three shaded plots/);
    assert.doesNotMatch(f.messages[0]![0]!.content, /old fixture content/);
    assert.deepEqual(JSON.parse(f.messages[0]!.at(-1)!.content), {
      status: "rejected", tool: "search_notes", query: "", executed: false, previewOnly: true, error: "Invalid query",
    });
    const evidence = await readResponseEvidence(brain, "conversation");
    assert.equal(evidence.notes[0]!.previewOnly, true);
    assert.equal(evidence.notes[0]!.revision, (await brain.getRecord("n1"))!.revision);
  });

  run("live retrieval evidence persists across responses and agent restart", async brain => {
    const f = fixture(brain, "workflow");
    f.hooks.respond = async () => f.messages.length === 1 ? { text: "", toolCalls: [call("retrieval", "garden")] } : { text: "Garden response.", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.equal((await readResponseEvidence(brain, "conversation")).notes[0]!.id, "n1");
    const again = fixture(brain, "workflow"); await again.agent.initialize();
    await again.agent.submitText("Use only my notes; keep it to two sentences."); await again.agent.drain();
    assert.match(again.messages[0]![0]!.content, /three shaded plots/);
    assert.equal(again.agent.getState().webAllowed, false);
    assert.match(JSON.stringify(again.messages[0]), /keep it to two sentences/);
    assert.ok(again.definitions[0]!.every(tool => !["search_web", "extract_web"].includes(tool.name)));
  });

  run("typed results distinguish no matches, invalid arguments, retrieval failure and success", async brain => {
    const f = fixture(brain, "workflow");
    f.hooks.respond = async () => f.messages.length === 1 ? { text: "", toolCalls: [
      call("empty-result", "no matches"), call("retrieval-error", "failure"), call("invalid-args", ""), call("ok", "garden"),
    ] } : { text: "Result.", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    const outcomes = f.messages[1]!.filter(message => message.role === "tool").map(message => JSON.parse(message.content));
    assert.deepEqual(outcomes.map(outcome => outcome.status), ["no_matches", "failed", "rejected", "success"]);
    assert.ok(outcomes.every(outcome => !outcome.executed && outcome.previewOnly));
    assert.equal(outcomes[0].query, "no matches");
    assert.equal(outcomes[1].error, "Fixture retrieval unavailable");
  });

  run("one grounded repair is allowed while duplicate and second repairs are rejected", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior], currentTools: [rejected] });
    const f = fixture(brain, "workflow");
    f.hooks.respond = async () => f.messages.length === 1 ? { text: "", toolCalls: [
      call("repair", "garden plots"), call("duplicate", "garden plots"), call("extra", "garden shade"),
    ] } : { text: "Recovery remains limited.", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.deepEqual(f.previews.map(preview => preview.validation.allowed), [true, false, false]);
    assert.match(f.previews[1]!.validation.reason!, /Duplicate/);
    assert.match(f.previews[2]!.validation.reason!, /one-query recovery limit/);
  });

  run("ungrounded repair does not execute and all source text remains saved", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior], currentTools: [rejected] });
    const f = fixture(brain, "workflow");
    f.hooks.respond = async () => ({ text: "", toolCalls: [call(`repair-${f.messages.length}`, "quantum chromodynamics")] });
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.equal(f.messages.length, 2); assert.ok(f.previews.every(preview => !preview.validation.allowed));
    assert.match(f.previews[0]!.validation.reason!, /grounded/);
    assert.match(f.agent.getState().lastError!, /two-response limit/);
    assert.equal((await brain.getRecord("session"))!.segments[0]!.text, "Explain the garden.");
  });

  run("notes-only blocks a tool even when the model proposes the omitted web capability", async brain => {
    const f = fixture(brain, "workflow");
    f.hooks.respond = async () => f.messages.length === 1 ? { text: "", toolCalls: [{ id: "web", name: "search_web", arguments: { query: "garden" } }] } : { text: "I will use your notes.", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Use only my notes; explain the garden."); await f.agent.drain();
    assert.equal(f.previews[0]!.validation.allowed, false);
    assert.match(f.previews[0]!.validation.reason!, /Web access disabled/);
    assert.equal(JSON.parse(f.messages[1]!.at(-1)!.content).status, "rejected");
  });

  run("corrected notes are refreshed on the next turn without overwriting manual edits", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior] });
    await brain.upsertSegment("n1", segment("source", "Correction: the garden comparison used nine shaded plots.", 2));
    const current = (await brain.getRecord("n1"))!;
    await brain.updateRecord(current.id, current.revision, { summary: "My manual correction", manualFields: ["summary"] });
    const f = fixture(brain, "workflow");
    await f.agent.initialize(); await f.agent.submitText("How many garden plots?"); await f.agent.drain();
    assert.match(f.messages[0]![0]!.content, /nine shaded plots/);
    assert.doesNotMatch(f.messages[0]![0]!.content, /three shaded plots|old fixture content/);
    const kept = (await brain.getRecord("n1"))!;
    assert.equal(kept.summary, "My manual correction"); assert.deepEqual(kept.manualFields, ["summary"]);
  });

  run("a source correction during generation blocks stale publication", async brain => {
    const f = fixture(brain, "workflow");
    let resolve!: (reply: AgentReply) => void;
    let ready!: () => void;
    const entered = new Promise<void>(done => { ready = done; });
    f.hooks.respond = async () => { ready(); return new Promise<AgentReply>(done => { resolve = done; }); };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await entered;
    const source = (await brain.getRecord("session"))!.segments.at(-1)!;
    await f.agent.ingest({ ...source, text: "Correction: explain the river.", revision: source.revision + 1 });
    resolve({ text: "Stale garden answer.", toolCalls: [] }); await f.agent.drain();
    assert.match(f.agent.getState().lastError!, /stale response/);
    assert.ok((await brain.getRecord("conversation"))!.segments.every(segment => !segment.text.includes("Stale garden answer")));
    assert.equal((await brain.getRecord("session"))!.segments.at(-1)!.text, "Correction: explain the river.");
  });

  run("manual note change during generation blocks stale publication", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [prior] });
    const f = fixture(brain, "workflow");
    let resolve!: (reply: AgentReply) => void; let ready!: () => void;
    const entered = new Promise<void>(done => { ready = done; });
    f.hooks.respond = async () => { ready(); return new Promise<AgentReply>(done => { resolve = done; }); };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await entered;
    const current = (await brain.getRecord("n1"))!;
    await brain.updateRecord(current.id, current.revision, { summary: "Manually revised while generation was pending", manualFields: ["summary"] });
    resolve({ text: "Stale note answer.", toolCalls: [] }); await f.agent.drain();
    assert.match(f.agent.getState().lastError!, /stale response/);
    assert.ok((await brain.getRecord("conversation"))!.segments.every(segment => !segment.text.includes("Stale note answer")));
  });

  run("provider failure retains sources without a retry", async brain => {
    const f = fixture(brain, "workflow"); f.hooks.respond = async () => { throw new Error("Provider unavailable"); };
    await f.agent.initialize(); await f.agent.submitText("Keep this garden request."); await f.agent.drain();
    assert.equal(f.messages.length, 1); assert.match(f.agent.getState().lastError!, /Provider unavailable/);
    assert.equal((await brain.getRecord("session"))!.segments[0]!.text, "Keep this garden request.");
  });

  run("evidence includes at most five actual notes and excludes fabricated IDs", async brain => {
    const ids = [];
    for (let index = 2; index <= 7; index++) {
      const id = `n${index}`; ids.push(id);
      await brain.createRecord({ id, kind: "note", createdAt: at }); await brain.upsertSegment(id, segment(`${id}-source`, `Garden fact ${index}`));
    }
    await seedResponseExperiment(brain, "conversation", { priorTools: [{ ...prior, result: { results: [{ id: "invented" }, ...ids.map(id => ({ id }))] } }] });
    const evidence = await refreshResponseEvidence(brain, "conversation", "garden fact", true);
    assert.equal(evidence.notes.length, 5); assert.ok(evidence.notes.every(note => note.id !== "invented"));
    assert.ok(evidence.recentOutcomes.every(outcome => !("result" in outcome)));
  });

  run("preview labels alongside results do not hide fixture note references", async brain => {
    await seedResponseExperiment(brain, "conversation", { priorTools: [{ ...prior,
      result: { fixture: true, previewOnly: true, results: [{ id: "n1", original: "Historical fixture" }] } }] });
    const evidence = await readResponseEvidence(brain, "conversation");
    assert.equal(evidence.notes[0]!.id, "n1");
  });

  run("provider tool messages use current revisioned evidence while raw historical output remains auditable", async brain => {
    const f = fixture(brain, "workflow");
    f.hooks.preview = async () => {
      await brain.upsertSegment("n1", segment("source", "The current garden count is thirteen.", 2));
      return { results: [{ id: "n1", original: "The outdated garden count is seven." }] };
    };
    f.hooks.respond = async () => f.messages.length === 1 ? { text: "", toolCalls: [call("lookup", "garden")] } : { text: "Response.", toolCalls: [] };
    await f.agent.initialize(); await f.agent.submitText("Explain the garden."); await f.agent.drain();
    assert.match(JSON.stringify(f.messages[1]), /current garden count is thirteen/);
    assert.doesNotMatch(JSON.stringify(f.messages[1]), /outdated garden count is seven/);
    assert.match(JSON.stringify(await brain.getState("tool:conversation:lookup")), /outdated garden count is seven/);
  });
}

test("SQLite reliability evidence survives closing and reopening the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moolai-reliability-restart-"));
  let brain = new SQLiteBrain(dir);
  try {
    await prepare(brain); await seedResponseExperiment(brain, "conversation", { priorTools: [prior], currentTools: [rejected] });
    await brain.close(); brain = new SQLiteBrain(dir);
    await brain.upsertSegment("n1", segment("source", "After restart: garden count is twelve.", 2));
    const f = fixture(brain, "workflow"); await f.agent.initialize(); await f.agent.submitText("Give the garden count."); await f.agent.drain();
    assert.match(f.messages[0]![0]!.content, /garden count is twelve/);
    assert.equal((await readResponseEvidence(brain, "conversation")).notes[0]!.sourceRevision, 2);
  } finally { await brain.close(); await rm(dir, { recursive: true, force: true }); }
});

test("tool outcome parser keeps errors distinct from a successful empty search", () => {
  assert.equal(responseToolEvent(call("q", "value"), { executed: false, previewOnly: true, fixture: { error: "Unavailable" } }).status, "failed");
  assert.equal(responseToolEvent(call("q", "value"), { executed: false, previewOnly: true, fixture: { results: [] } }).status, "no_matches");
});
