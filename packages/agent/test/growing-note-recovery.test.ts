import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import type { BrainPort, BrainRecord, Segment, ThoughtInput, ThoughtResult } from "../../contracts/src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";
import { Agent } from "../src/index.js";
import { ThoughtConsolidator } from "../src/thoughts.js";

const now = () => "2026-10-02T02:00:00Z";
const failure = "Generation exceeded its 4,096-token output limit; explicit retry required.";
const segment = (id: string, text: string, revision = 1, speaker: Segment["speaker"] = "user"): Segment =>
  ({ id, turnId: id, text, revision, speaker, final: true, createdAt: now() });
const successfulResult = (input: ThoughtInput): ThoughtResult => ({
  groups: [{
    title: "Nano's organized title",
    summary: "Nano's faithful summary of the retained source.",
    spans: input.segments.map(s => ({ segmentId: s.id, revision: s.revision, start: 0, end: s.text.length })),
    continuesActive: !!input.activeNote,
    ongoing: !input.finalize,
    topicSuggestions: [],
  }],
  remainder: [],
});

async function fixture(kind: "memory" | "sqlite") {
  const directory = await mkdtemp(join(tmpdir(), "moolai-growing-recovery-"));
  let brain: BrainPort = kind === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
  await brain.createRecord({ id: "study", kind: "session", createdAt: now() });
  const calls: string[] = [];
  const emitted: BrainRecord[] = [];
  let notifications=0;
  let infer = async (input: ThoughtInput): Promise<ThoughtResult> => successfulResult(input);
  const consolidate = async (input: ThoughtInput) => { calls.push(input.sessionId); return infer(input); };
  const make = () => new ThoughtConsolidator({
    brain, now, emit: record => emitted.push(record), notice: () => {}, enrich: async () => {},
    pending:()=>{notifications++;},
    context: async () => "", generation: {
      consolidate,
      summarize: async () => { throw Error("A source preview must not call a summary provider"); },
      respond: async () => { throw Error("A source preview must not run an Agent response"); },
    },
  });
  let engine = make();
  return {
    get brain() { return brain; }, get engine() { return engine; }, get notifications(){return notifications;}, calls, emitted, consolidate,
    set infer(value: typeof infer) { infer = value; },
    async add(source: Segment, sessionId = "study") {
      await brain.upsertSegment(sessionId, source);
      await engine.append(sessionId, [source]);
    },
    async draft(sessionId = "study") {
      const state = await brain.getState<{ draftId: string }>(`thought-buffer:${sessionId}`);
      assert.ok(state?.draftId, "The session has a visible draft");
      const draft = await brain.getRecord(state.draftId);
      assert.ok(draft);
      return draft;
    },
    async restart(sessionId = "study") {
      if (kind === "sqlite") { await brain.close(); brain = new SQLiteBrain(directory); }
      engine = make();
      await engine.recover(sessionId);
    },
    async close() { await brain.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: only new eligible source schedules work, including continuation of a generated growing note`, async()=>{
    const f=await fixture(kind);
    try {
      const first=segment("one","First point.");
      await f.add(first);assert.equal(f.notifications,1);
      await f.engine.append("study",[first]);assert.equal(f.notifications,1);
      await f.engine.process("study");assert.equal(f.notifications,1,"Publishing output must not schedule another model call");
      await f.add(segment("two","Second point, same discussion."));assert.equal(f.notifications,2);
      f.infer=async()=>{throw Error(failure);};await f.engine.process("study");
      await f.add(segment("three","Keep this after the failure."));assert.equal(f.notifications,2,"New text does not authorize retrying a failed buffer");
      await f.restart();assert.equal(f.notifications,2);
    } finally {await f.close();}
  });
  test(`${kind}: a new draft exposes attributed source before any generation`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("one", "Maybe 5 grams, not 50. The experiment is not complete."));
      await f.add(segment("two", "I suggested checking the scale.", 1, "assistant"));
      const draft = await f.draft();
      assert.notEqual(draft.title, "New thought");
      assert.match(draft.title, /Maybe 5 grams, not 50/);
      assert.match(draft.summary, /> \*\*You:\*\* Maybe 5 grams, not 50/);
      assert.match(draft.summary, /experiment is not complete/);
      assert.match(draft.summary, /> \*\*Moo:\*\* I suggested checking the scale/);
      assert.equal(draft.thoughtStatus, "draft");
      assert.equal(draft.summarySourceRevision, undefined, "Extracted source is not marked as a completed Nano summary");
      assert.equal(draft.quality, "pending");
      assert.deepEqual(f.calls, []);
      assert.equal(draft.segments.length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: restart migrates an empty legacy draft and exposes its retained failure without inference`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("one", "Retain the uncertainty: the measurement may be wrong."));
      const before = await f.draft();
      await f.brain.updateRecord(before.id, before.revision, { title: "New thought", summary: "", error: undefined });
      const state = await f.brain.getState<Record<string, unknown>>("thought-buffer:study");
      await f.brain.setState("thought-buffer:study", { ...state, status: "failed", error: failure });
      const original = await f.brain.getRecord("study");
      await f.restart();
      const draft = await f.draft();
      assert.equal(draft.id, before.id);
      assert.match(draft.title, /Retain the uncertainty/);
      assert.match(draft.summary, /measurement may be wrong/);
      assert.equal(draft.error, failure);
      assert.equal(draft.summarySourceRevision, undefined);
      assert.deepEqual(await f.brain.getRecord("study"), original, "Migration does not rewrite source records");
      assert.equal((await f.brain.listRecords()).filter(r => r.thoughtStatus === "draft").length, 1);
      await f.restart();
      assert.equal((await f.draft()).revision, draft.revision, "Migration is idempotent");
      assert.deepEqual(f.calls, []);
    } finally { await f.close(); }
  });

  test(`${kind}: Nano failure is visible and new text, periodic passes and restart never retry it`, async () => {
    const f = await fixture(kind);
    try {
      f.infer = async () => { throw Error(failure); };
      await f.add(segment("one", "A useful first point."));
      const id = (await f.draft()).id;
      await f.engine.process("study");
      const failed = await f.draft();
      assert.match(failed.error!, /4,096-token output limit/);
      assert.match(failed.summary, /useful first point/);
      assert.ok(f.emitted.some(r => r.id === id && r.error?.includes("4,096-token")));
      const failedOperations = await f.brain.listOperations();
      await f.restart();
      await f.add(segment("two", "A later point must remain retained too."));
      for (let tick = 0; tick < 3; tick++) await f.engine.process("study");
      await f.engine.process("study", true);
      await f.restart();
      assert.deepEqual(f.calls, ["study"]);
      assert.deepEqual(await f.brain.listOperations(), failedOperations, "No hidden retry increments attempt counts");
      const retained = await f.draft();
      assert.equal(retained.id, id);
      assert.match(retained.error!, /4,096-token/);
      assert.match(retained.summary, /later point must remain retained/);
      assert.equal(retained.segments.length, 2);
      assert.equal((await f.brain.getState<{ status: string }>("thought-buffer:study"))!.status, "failed");
    } finally { await f.close(); }
  });

  test(`${kind}: manual title and summary survive preview refresh, source correction and restart`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("one", "The quantity is five grams."));
      const before = await f.draft();
      await f.brain.updateRecord(before.id, before.revision, {
        title: "My retained title", summary: "My own interpretation", manualFields: ["title", "summary"],
      });
      await f.add(segment("two", "There is a second point."));
      await f.add(segment("one", "Correction: the quantity is fifteen grams.", 2));
      await f.restart();
      const after = await f.draft();
      assert.equal(after.id, before.id);
      assert.equal(after.title, "My retained title");
      assert.equal(after.summary, "My own interpretation");
      assert.deepEqual(after.manualFields, ["title", "summary"]);
      assert.match(after.segments[0]!.text, /fifteen grams/);
      assert.equal(after.segments.length, 2);
      assert.deepEqual(f.calls, []);
    } finally { await f.close(); }
  });

  test(`${kind}: retrying a visible draft organizes only its owner and replaces the preview without replaying tasks`, async () => {
    const f = await fixture(kind);
    try {
      f.infer = async () => { throw Error(failure); };
      await f.add(segment("one", "The original source to organize."));
      await f.engine.process("study", true);
      const draft = await f.draft();
      await f.brain.createRecord({ id: "other", kind: "session", createdAt: now() });
      await f.add(segment("unrelated", "An unrelated failed backlog."), "other");
      await f.engine.process("other", true);
      const unrelated = await f.brain.getState("thought-buffer:other");
      const unrelatedDraft = await f.draft("other");
      const route = { id: "old-failed-route", kind: "route" as const, recordId: "study", sourceRevision: 1, turnId: "one", status: "failed" as const, attempts: 1, error: "old route failure" };
      await f.brain.putOperation(route);
      const ledger = [{ call: { id: "historical-tool", name: "search_notes", arguments: { query: "original" } }, result: { error: "old search failure" } }];
      await f.brain.setState("tool-ledger:historical-conversation", ledger);
      await f.brain.setState("agent", { sessionId: "other", listening: false, busy: false, webAllowed: false });
      const providers = new FixtureProviders();
      const forbidden: string[] = [];
      providers.route = async () => { forbidden.push("J1"); throw Error("Retry must not reroute historical speech"); };
      providers.respond = async () => { forbidden.push("Agent response"); throw Error("Retry must not replay tasks"); };
      providers.summarize = async () => { forbidden.push("summary"); throw Error("Organization must not make a duplicate summary call"); };
      providers.consolidate = f.consolidate;
      let nextId = 0;
      const agent = new Agent({
        brain: f.brain, decisions: providers, generation: providers, search: providers, vision: providers,
        capture: { async capture() { forbidden.push("capture"); throw Error("Capture is forbidden"); } },
        speech: { async speak() {}, async stop() {} }, id: () => `retry-${++nextId}`, now,
      });
      await agent.initialize();
      await agent.drain();
      assert.deepEqual(f.calls, ["study", "other"]);
      f.infer = async input => successfulResult(input);
      await agent.retrySummary(draft.id);
      await agent.drain();
      assert.deepEqual(f.calls, ["study", "other", "study"]);
      assert.deepEqual(forbidden, []);
      const organized = (await f.brain.getRecord(draft.id))!;
      assert.equal(organized.title, "Nano's organized title");
      assert.equal(organized.summary, "Nano's faithful summary of the retained source.");
      assert.equal(organized.thoughtStatus, "settled");
      assert.equal(organized.error, undefined);
      assert.equal(organized.summarySourceRevision, organized.sourceRevision);
      assert.equal((await f.brain.getRecord("study"))!.error, undefined);
      const buffer = (await f.brain.getState<{ spans: unknown[]; error?: string; status?: string }>("thought-buffer:study"))!;
      assert.deepEqual(buffer.spans, []);
      assert.equal(buffer.error, undefined);
      assert.equal(buffer.status, undefined);
      assert.deepEqual(await f.brain.getState("thought-buffer:other"), unrelated);
      assert.deepEqual(await f.brain.getRecord(unrelatedDraft.id), unrelatedDraft);
      assert.deepEqual((await f.brain.listOperations()).find(op => op.id === route.id), route);
      assert.deepEqual(await f.brain.getState("tool-ledger:historical-conversation"), ledger);
    } finally { await f.close(); }
  });
}
