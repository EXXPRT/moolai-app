import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import type { BrainPort, Segment, SourceSpan, ThoughtInput, ThoughtResult } from "../../contracts/src/index.js";
import { ThoughtConsolidator, thoughtBatch, thoughtExcerpt } from "../src/thoughts.js";
import { Agent } from "../src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";
import { ORGANIZER_REQUEST, organizerRequestBytes } from "../src/organizer-budget.js";

const now = () => "2026-10-03T01:00:00Z";
const segment = (id: string, text: string, revision = 1): Segment =>
  ({ id, turnId: id, text, revision, speaker: "user", final: true, createdAt: now() });
const spans = (input: ThoughtInput): SourceSpan[] => input.segments.map(s =>
  ({ segmentId: s.id, revision: s.revision, start: 0, end: s.text.length }));
const result = (input: ThoughtInput): ThoughtResult => ({
  groups: [{ title: "One continuing topic", summary: "A faithful bounded summary.", spans: spans(input),
    continuesActive: !!input.activeNote, ongoing: !input.finalize, topicSuggestions: [] }],
  remainder: [],
});
// A dense log stresses range reconstruction, not model quality. The live holdouts use
// independently written discussions rather than this deterministic transport fixture.
const longLog = (): Segment[] => ["arrival", "inspection", "packing", "dispatch"].map((phase, n) => ({
  ...segment(phase, Array.from({ length: 60 }, (_, row) =>
    `${phase} row ${row + 1}: Renée recorded crate ${n * 60 + row + 1}; the label reads “記録室 🐚”. Inspection is proposed, not completed.\r\n`,
  ).join("")),
  speaker: n === 1 ? "assistant" as const : "user" as const,
}));
type BufferState = {
  spans: SourceSpan[]; published: string[]; draftId?: string; activeId?: string;
  status?: string; error?: string; continuationRequired?: boolean; finalize?: boolean;
};

async function fixture(kind: "memory" | "sqlite", profile?: "compact") {
  const directory = await mkdtemp(join(tmpdir(), "moolai-thought-batch-"));
  let brain: BrainPort = kind === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
  await brain.createRecord({ id: "study", kind: "session", createdAt: now() });
  const inputs: ThoughtInput[] = [];
  let pending = 0;
  let infer = async (input: ThoughtInput): Promise<ThoughtResult> => result(input);
  const make = () => new ThoughtConsolidator({
    brain, now, profile, emit: () => {}, notice: () => {}, pending: () => { pending++; },
    enrich: async () => {}, context: async () => "",
    generation: {
      summarize: async () => { throw Error("Unexpected summary call"); },
      respond: async () => { throw Error("Unexpected Agent call"); },
      // Like the backend, refuse (413, before any provider call) a request over the byte bound.
      consolidate: async input => {
        if (organizerRequestBytes(input) > ORGANIZER_REQUEST.bytes) throw Object.assign(Error("Backend 413: request too large"), { status: 413 });
        inputs.push(structuredClone(input)); return infer(input);
      },
    },
  });
  let engine = make();
  return {
    get brain() { return brain; }, get engine() { return engine; },
    get pending() { return pending; }, inputs,
    set infer(value: typeof infer) { infer = value; },
    async add(source: Segment) { await brain.upsertSegment("study", source); await engine.append("study", [source]); },
    async state() { return (await brain.getState<BufferState>("thought-buffer:study"))!; },
    async notes() { return (await brain.listRecords()).filter(record => record.kind === "dictation"); },
    async restart() {
      if (kind === "sqlite") { await brain.close(); brain = new SQLiteBrain(directory); }
      engine = make(); await engine.recover("study");
    },
    async close() { await brain.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("batch edges preserve complete Unicode characters and never create a zero-length tail", () => {
  const source = [segment("first", "a".repeat(2999)), segment("next", "🦵\r\nnext")];
  const pending = source.map(s => ({ segmentId: s.id, revision: s.revision, start: 0, end: s.text.length }));
  const first = thoughtBatch(pending, source, "compact");
  assert.deepEqual(first, [pending[0]]);
  assert.deepEqual(thoughtBatch(pending.slice(1), source, "compact"), pending.slice(1));
  assert.throws(() => thoughtBatch([{ segmentId: "next", revision: 1, start: 1, end: 3 }], source, "compact"), /splits a Unicode/);
});

test("active excerpts are bounded, visibly truncated and safe at both emoji boundaries", () => {
  const source = "a".repeat(999) + "🦵" + "middle ".repeat(1000) + "👩‍👩‍👧‍👦\r\n".repeat(300);
  const excerpt = thoughtExcerpt(source, "compact");
  assert.equal(excerpt.sourceTruncated, true);
  assert.ok(excerpt.sourceExcerpt.length <= 4000);
  assert.match(excerpt.sourceExcerpt, /\[Earlier source retained; excerpt omitted here\]/);
  assert.ok(excerpt.sourceExcerpt.startsWith("a".repeat(999)));
  assert.ok(excerpt.sourceExcerpt.endsWith("👩‍👩‍👧‍👦\r\n"));
  assert.equal(Buffer.from(excerpt.sourceExcerpt).toString("utf8"), excerpt.sourceExcerpt);
  const short = "  First line.\r\n\nLast line 🦵\n";
  assert.deepEqual(thoughtExcerpt(short, "compact"), { sourceExcerpt: short, sourceTruncated: false });
  assert.throws(() => thoughtExcerpt("broken \ud800", "compact"), /incomplete Unicode/);
});

test("default excerpts retain the established 12000-source-character profile", () => {
  const exact = "x".repeat(12000);
  assert.deepEqual(thoughtExcerpt(exact), { sourceExcerpt: exact, sourceTruncated: false });
  const long = "a".repeat(4000) + "omitted".repeat(1000) + "b".repeat(8000);
  assert.deepEqual(thoughtExcerpt(long), {
    sourceExcerpt: "a".repeat(4000) + "\n[Earlier source retained; excerpt omitted here]\n" + "b".repeat(8000),
    sourceTruncated: true,
  });
  const unicode = "a".repeat(3999) + "🦵" + "middle".repeat(2000) + "🦵" + "b".repeat(7999);
  const excerpt = thoughtExcerpt(unicode);
  assert.equal(Buffer.from(excerpt.sourceExcerpt).toString("utf8"), excerpt.sourceExcerpt);
  assert.throws(() => thoughtExcerpt("broken \ud800"), /incomplete Unicode/);
});

for (const profile of [undefined, "compact"] as const) {
  test(`Agent uses ${profile ?? "baseline"} workload only through explicit profile injection`, async () => {
    const f = await fixture("memory");
    try {
      await f.add(segment("profile-source", "p".repeat(4001)));
      await f.brain.setState("agent", { sessionId: "study", listening: false, busy: false, webAllowed: false });
      const providers = new FixtureProviders();
      const inputs: ThoughtInput[] = [];
      providers.consolidate = async input => { inputs.push(input); return result(input); };
      const agent = new Agent({
        brain: f.brain, decisions: providers, generation: providers, search: providers, vision: providers,
        capture: { async capture() { throw Error("Capture is forbidden"); } },
        speech: { async speak() {}, async stop() {} }, id: () => "fixture-id", now,
        thoughtOrganizationProfile: profile,
      });
      await agent.initialize(); await agent.consolidateThoughts(); await agent.drain();
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]!.segments[0]!.text.length, profile === "compact" ? 3000 : 4001);
    } finally { await f.close(); }
  });
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: a dense four-batch discussion retains attribution, edits and exact ranges across restart`, async () => {
    const f = await fixture(kind);
    try {
      const source = longLog();
      const original = source.map(s => s.text).join("");
      assert.ok(original.length > 24000 && original.length <= 32000);
      for (const s of source) await f.add(s);
      await f.engine.process("study");
      const first = (await f.notes())[0]!;
      assert.equal(first.segments.map(s => s.text).join(""), original.slice(0, 8000));
      await f.brain.updateRecord(first.id, first.revision, {
        title: "My crate review", topics: ["Shipping review"], manualFields: ["title", "topics"],
      });
      await f.restart();
      assert.equal(f.inputs.length, 1, "Recovery schedules remaining source without dispatching it");
      await f.engine.process("study");
      await f.engine.process("study", true);

      assert.equal(f.inputs.length, 4);
      assert.deepEqual(f.inputs.map(input => input.finalize), [false, false, false, true]);
      const notes = await f.notes(), note = notes[0]!;
      assert.equal(notes.length, 1); assert.equal(note.id, first.id);
      assert.equal(note.title, "My crate review"); assert.deepEqual(note.topics, ["Shipping review"]);
      assert.equal(note.thoughtStatus, "settled"); assert.equal(note.error, undefined);
      assert.deepEqual(note.segments.map(s => ({ text: s.text, speaker: s.speaker })),
        source.map(s => ({ text: s.text, speaker: s.speaker })));
      assert.deepEqual(note.sources![0]!.spans, source.map(s =>
        ({ segmentId: s.id, revision: 1, start: 0, end: s.text.length })));
      assert.deepEqual((await f.brain.getRecord("study"))!.segments, source);
      assert.deepEqual((await f.state()).spans, []);
      assert.ok((await f.brain.listOperations()).every(op => op.status === "done"));
      await f.restart(); await f.engine.process("study", true);
      assert.equal(f.inputs.length, 4, "A completed restart must not resummarize historical speech");
      assert.equal((await f.notes())[0]!.id, first.id);
    } finally { await f.close(); }
  });

  test(`${kind}: invalid long continuation retains the accepted prefix and only explicit retry uses a corrected suffix`, async () => {
    const f = await fixture(kind);
    try {
      const source = longLog();
      for (const s of source) await f.add(s);
      await f.engine.process("study");
      const accepted = (await f.notes())[0]!;
      await f.brain.updateRecord(accepted.id, accepted.revision, {
        title: "My retained review", topics: ["Manual topic"], manualFields: ["title", "topics"],
      });
      const pendingBefore = (await f.state()).spans;
      f.infer = async input => {
        const invalid = result(input);
        invalid.groups[0]!.spans.at(-1)!.end--;
        return invalid;
      };
      await f.engine.process("study", true);
      assert.equal(f.inputs.length, 2);
      const failed = await f.state(), saved = (await f.brain.getRecord(accepted.id))!;
      assert.equal(failed.status, "failed"); assert.equal(failed.continuationRequired, undefined);
      assert.deepEqual(failed.spans, pendingBefore, "Rejected coverage must not advance any watermark");
      assert.deepEqual(saved.segments, accepted.segments); assert.equal(saved.summary, accepted.summary);
      assert.deepEqual((await f.brain.listOperations()).map(op => op.status).sort(), ["done", "failed"]);

      await f.restart();
      const last = source.at(-1)!;
      const corrected = { ...last, revision: 2, text: last.text + "Correction: dispatch remains unapproved.\r\n" };
      await f.add(corrected);
      await f.engine.process("study"); await f.engine.process("study", true);
      assert.equal(f.inputs.length, 2, "Restart and newer source do not authorize a paid retry");
      assert.deepEqual((await f.brain.getRecord(accepted.id))!.segments, accepted.segments);
      f.infer = async input => result(input);
      await f.engine.process("study", true, true);
      assert.equal(f.inputs.length, 5, "One rejected call plus four successful source batches");
      const note = (await f.brain.getRecord(accepted.id))!;
      assert.equal((await f.notes()).length, 1); assert.equal(note.title, "My retained review");
      assert.deepEqual(note.topics, ["Manual topic"]); assert.equal(note.error, undefined);
      assert.equal(note.thoughtStatus, "settled"); assert.deepEqual((await f.state()).spans, []);
      assert.equal(note.segments.map(s => s.text).join(""), [...source.slice(0, -1), corrected].map(s => s.text).join(""));
      assert.equal(note.sources![0]!.spans.at(-1)!.revision, 2);
      assert.ok(f.inputs.slice(2).flatMap(input => input.segments).filter(s => s.id === last.id).every(s => s.revision === 2));
      await f.restart(); await f.engine.process("study", true);
      assert.equal(f.inputs.length, 5);
    } finally { await f.close(); }
  });

  test(`${kind}: default batching retains the established 24-span limit`, async () => {
    const f = await fixture(kind);
    try {
      const source = Array.from({ length: 26 }, (_, i) => segment(`baseline-${i}`, ` ${i}. 🦵\r\n`));
      for (const s of source) await f.add(s);
      await f.engine.process("study");
      assert.equal(f.inputs[0]!.segments.length, 24);
      assert.equal((await f.state()).spans.length, 2);
      await f.engine.process("study", true);
      assert.equal(f.inputs.length, 2);
      assert.deepEqual((await f.notes())[0]!.segments.map(s => s.text), source.map(s => s.text));
    } finally { await f.close(); }
  });

  test(`${kind}: default close retains 8000-character batches and durable continuation after four successes`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("baseline-long", "x".repeat(32017)));
      await f.engine.process("study", true);
      assert.equal(f.inputs.length, 4);
      assert.ok(f.inputs.every(input => input.segments.reduce((n, s) => n + s.text.length, 0) === 8000));
      assert.equal((await f.state()).spans[0]!.start, 32000);
      assert.equal((await f.state()).continuationRequired, true);
      assert.ok((await f.brain.listOperations()).every(op => op.status === "done"));
      assert.equal(f.inputs[1]!.activeNote!.sourceTruncated, false);
      assert.equal(f.inputs[2]!.activeNote!.sourceTruncated, true);
      assert.equal(f.inputs[2]!.activeNote!.sourceExcerpt.length, 12000 + "\n[Earlier source retained; excerpt omitted here]\n".length);
      await f.restart(); await f.engine.process("study", true);
      assert.equal(f.inputs.length, 4, "A restart does not implicitly continue a bounded close");
      await f.engine.process("study", true, true);
      assert.equal(f.inputs.length, 5);
      assert.deepEqual((await f.state()).spans, []);
      assert.equal((await f.notes())[0]!.segments.map(s => s.text).join(""), "x".repeat(32017));
    } finally { await f.close(); }
  });

  test(`${kind}: twelve-span batches preserve ordered whitespace, Unicode and one continuing note ID`, async () => {
    const f = await fixture(kind, "compact");
    try {
      const source = Array.from({ length: 14 }, (_, i) => segment(`part-${i}`, `  ${i}. 🦵 é\r\n\t`));
      for (const s of source) await f.add(s);
      const id = (await f.notes())[0]!.id;
      const pending = f.pending;
      await f.engine.process("study");
      assert.equal(f.inputs[0]!.segments.length, 12);
      assert.equal((await f.state()).spans.length, 2);
      assert.equal(f.pending, pending + 1, "A committed prefix schedules its remaining undispatched source");
      await f.engine.process("study", true);
      const notes = await f.notes();
      assert.equal(notes.length, 1); assert.equal(notes[0]!.id, id);
      assert.equal(notes[0]!.thoughtStatus, "settled");
      assert.deepEqual(notes[0]!.segments.map(s => s.text), source.map(s => s.text));
      assert.deepEqual(notes[0]!.sources![0]!.spans, source.map(s =>
        ({ segmentId: s.id, revision: 1, start: 0, end: s.text.length })));
      assert.ok(f.inputs.every(input => input.segments.length <= 12 && input.segments.every(s => s.text.length > 0)));
    } finally { await f.close(); }
  });

  test(`${kind}: character-boundary spill keeps the complete emoji in the next request`, async () => {
    const f = await fixture(kind, "compact");
    try {
      await f.add(segment("first", "x".repeat(2999)));
      await f.add(segment("second", "🦵 second point\n"));
      await f.engine.process("study");
      assert.deepEqual(f.inputs[0]!.segments.map(s => s.id), ["first"]);
      await f.engine.process("study", true);
      assert.equal(f.inputs[1]!.segments[0]!.text, "🦵 second point\n");
      assert.ok(f.inputs.every(input => input.segments.reduce((length, s) => length + s.text.length, 0) <= 3000));
      assert.equal((await f.notes())[0]!.segments.map(s => s.text).join(""), "x".repeat(2999) + "🦵 second point\n");
    } finally { await f.close(); }
  });

  test(`${kind}: four successful close batches require durable explicit continuation without failing completed operations`, async () => {
    const f = await fixture(kind, "compact");
    try {
      const text = "x".repeat(15017);
      await f.add(segment("long", text));
      const source = await f.brain.getRecord("study");
      await f.engine.process("study", true);
      assert.equal(f.inputs.length, 4);
      let state = await f.state();
      assert.equal(state.continuationRequired, true); assert.equal(state.status, "failed");
      assert.equal(state.spans[0]!.start, 12000);
      const operations = await f.brain.listOperations();
      assert.equal(operations.length, 4); assert.ok(operations.every(op => op.status === "done" && !op.error));
      let note = (await f.notes())[0]!;
      assert.match(note.error!, /Continue with Retry organization/);
      assert.equal((await f.brain.getRecord("study"))!.error, note.error);
      const id = note.id, pending = f.pending;
      await f.engine.process("study"); await f.restart(); await f.engine.process("study", true);
      assert.equal(f.inputs.length, 4); assert.equal(f.pending, pending);
      assert.equal((await f.state()).continuationRequired, true);
      assert.deepEqual(await f.brain.listOperations(), operations);
      note = (await f.brain.getRecord(id))!;
      await f.brain.updateRecord(id, note.revision, { title: "My title", summary: "My interpretation", manualFields: ["title", "summary"] });
      await f.engine.process("study", true, true);
      assert.equal(f.inputs.length, 6);
      note = (await f.brain.getRecord(id))!;
      assert.equal((await f.notes()).length, 1); assert.equal(note.thoughtStatus, "settled");
      assert.equal(note.title, "My title"); assert.equal(note.summary, "My interpretation");
      assert.equal(note.segments.map(s => s.text).join(""), text);
      assert.equal(note.error, undefined); assert.equal((await f.brain.getRecord("study"))!.error, undefined);
      state = await f.state();
      assert.deepEqual(state.spans, []); assert.equal(state.continuationRequired, undefined); assert.equal(state.status, undefined);
      assert.ok((await f.brain.listOperations()).every(op => op.status === "done"));
      assert.deepEqual((await f.brain.getRecord("study"))!.segments, source!.segments, "Source originals are unchanged");
      const activeInputs = f.inputs.filter(input => input.activeNote?.sourceTruncated);
      assert.ok(activeInputs.length > 0);
      assert.ok(activeInputs.every(input => input.activeNote!.sourceExcerpt.length <= 4000));
    } finally { await f.close(); }
  });

  test(`${kind}: a provider failure after progress stays distinct from a close limit and is never automatically retried`, async () => {
    const f = await fixture(kind, "compact");
    try {
      f.infer = async input => { if (input.activeNote) throw Error("Provider completion limit"); return result(input); };
      await f.add(segment("long", "s".repeat(7500)));
      await f.engine.process("study", true);
      assert.equal(f.inputs.length, 2);
      const state = await f.state();
      assert.equal(state.status, "failed"); assert.equal(state.continuationRequired, undefined);
      assert.match((await f.notes())[0]!.error!, /Provider completion limit/);
      const operations = await f.brain.listOperations();
      assert.deepEqual(operations.map(op => op.status).sort(), ["done", "failed"]);
      const pending = f.pending;
      await f.restart(); await f.add(segment("later", "New retained speech."));
      await f.engine.process("study"); await f.engine.process("study", true);
      assert.equal(f.inputs.length, 2); assert.equal(f.pending, pending);
      assert.deepEqual(await f.brain.listOperations(), operations);
    } finally { await f.close(); }
  });

  test(`${kind}: unchanged remainder neither schedules another pass nor masquerades as four-call exhaustion`, async () => {
    const f = await fixture(kind, "compact");
    try {
      f.infer = async input => ({ groups: [], remainder: spans(input) });
      await f.add(segment("waiting", "w".repeat(3500)));
      const pending = f.pending;
      await f.engine.process("study"); await f.engine.process("study");
      assert.equal(f.inputs.length, 1); assert.equal(f.pending, pending);
      await f.engine.process("study", true);
      const state = await f.state();
      assert.equal(state.status, "failed"); assert.equal(state.continuationRequired, undefined);
      assert.match((await f.notes())[0]!.error!, /made no progress/);
      assert.ok((await f.brain.listOperations()).every(op => op.status === "done"));
    } finally { await f.close(); }
  });

  test(`${kind}: malformed Unicode never reaches generation and cannot corrupt a prior successful operation`, async () => {
    const f = await fixture(kind, "compact");
    try {
      await f.add(segment("valid", "A valid first thought.")); await f.engine.process("study");
      const successful = await f.brain.listOperations();
      let note = (await f.notes())[0]!;
      await f.brain.updateRecord(note.id, note.revision, { title: "Broken \ud800 title", manualFields: ["title"] });
      await f.add(segment("next", "Another valid thought.")); await f.engine.process("study");
      assert.equal(f.inputs.length, 1); assert.match((await f.state()).error!, /incomplete Unicode/);
      assert.deepEqual(await f.brain.listOperations(), successful);
      note = (await f.brain.getRecord(note.id))!;
      await f.brain.updateRecord(note.id, note.revision, { title: "Corrected title", manualFields: ["title"] });
      await f.add(segment("invalid", "Retained lone low surrogate \udfff"));
      await f.engine.process("study", false, true);
      assert.equal(f.inputs.length, 1); assert.match((await f.state()).error!, /incomplete Unicode/);
      assert.ok((await f.brain.getRecord("study"))!.segments.some(s => s.text.includes("\udfff")));
    } finally { await f.close(); }
  });

  test(`${kind}: a previously staged 7000-character canonical result recovers without another provider call`, async () => {
    const f = await fixture(kind, "compact");
    try {
      const source = segment("old-source", "Prior source 🦵.\r\n".repeat(400));
      assert.ok(source.text.length > 3000 && source.text.length <= 8000);
      await f.add(source);
      const draft = (await f.notes())[0]!;
      const input: ThoughtInput = { sessionId: "study", incremental: true, finalize: true, context: "", segments: [source] };
      const state = await f.state();
      await f.brain.putOperation({ id: "old-staged", kind: "consolidate", recordId: "study", sourceRevision: 1, status: "running", attempts: 1 });
      await f.brain.setState("thought-buffer:study", { ...state, status: "running", finalize: true, staged: {
        input, result: result(input), spans: spans(input), operation: "old-staged",
        draftStamp: JSON.stringify([draft.archived, draft.manualFields.map(key => [key, (draft as any)[key]])]),
      } });
      await f.restart(); await f.restart();
      assert.equal(f.inputs.length, 0);
      const notes = await f.notes(); assert.equal(notes.length, 1); assert.equal(notes[0]!.id, draft.id);
      assert.equal(notes[0]!.segments.map(s => s.text).join(""), source.text);
      assert.equal(notes[0]!.thoughtStatus, "settled");
      assert.deepEqual((await f.state()).spans, []);
      assert.equal((await f.brain.listOperations())[0]!.status, "done");
    } finally { await f.close(); }
  });
}
