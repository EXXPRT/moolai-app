import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import type { BrainPort, BrainRecord, Segment, SourceSpan, ThoughtInput, ThoughtResult } from "../../contracts/src/index.js";
import { connectNotes } from "../src/connections.js";
import { ThoughtConsolidator } from "../src/thoughts.js";

const now = () => "2026-10-03T12:00:00Z";
const source = (id: string, text: string): Segment =>
  ({ id, turnId: id, text, revision: 1, speaker: "user", final: true, createdAt: now() });
const spans = (segments: Segment[]): SourceSpan[] => segments.map(s =>
  ({ segmentId: s.id, revision: s.revision, start: 0, end: s.text.length }));
const organized = (input: ThoughtInput): ThoughtResult => ({
  groups: [{ title: "Generated title", summary: "Generated summary", spans: spans(input.segments) }], remainder: [],
});

for (const kind of ["memory", "sqlite"] as const) {
  for (const publication of ["incremental", "legacy staged"] as const) {
    test(`${kind}: draft manual relationships and attachments survive append and ${publication} publication`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "moolai-thought-metadata-"));
      let brain: BrainPort = kind === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
      let calls = 0;
      const make = () => new ThoughtConsolidator({
        brain, now, emit: () => {}, notice: () => {}, enrich: async () => {}, context: async () => "",
        sourceRecords: async segments => (await Promise.all([...new Set(segments.map(s => s.turnId))]
          .map(id => brain.getRecord(`source-${id}`)))).filter((record): record is BrainRecord => !!record),
        generation: {
          summarize: async () => { throw Error("Unexpected summary call"); },
          respond: async () => { throw Error("Unexpected Agent call"); },
          consolidate: async input => { calls++; return organized(input); },
        },
      });
      let engine = make();
      const restart = async () => {
        if (kind === "sqlite") { await brain.close(); brain = new SQLiteBrain(directory); }
        engine = make(); await engine.recover("study");
      };
      try {
        await brain.createRecord({ id: "study", kind: "session", createdAt: now() });
        await brain.createRecord({ id: "zz-related", kind: "note", createdAt: now() });
        for (const id of ["one", "two"]) {
          const record = await brain.createRecord({ id: `source-${id}`, kind: "conversation", createdAt: now() });
          await brain.putAttachment(`source-${id}-image`, "image/png", Uint8Array.of(id === "one" ? 1 : 2));
          await brain.updateRecord(record.id, record.revision, { attachmentIds: [`source-${id}-image`] });
        }
        const first = source("one", "The first retained source."), second = source("two", "More speech about this same topic.");
        await brain.upsertSegment("study", first); await engine.append("study", [first]);
        const buffer = (await brain.getState<{ draftId: string }>("thought-buffer:study"))!;
        const draftId = buffer.draftId;
        await connectNotes(brain, draftId, "zz-related");
        let draft = (await brain.getRecord(draftId))!;
        assert.ok(draft.links.some(link => link.targetId === "zz-related" && link.provenance === "manual"));
        await brain.putAttachment("manual-image", "image/png", Uint8Array.of(7, 8, 9));
        draft = (await brain.updateRecord(draftId, draft.revision, {
          title: "My title", summary: "My summary", manualFields: ["title", "summary"],
          links: [...draft.links.map(link => link.targetId === "study" ? { ...link, decision: "dismissed" as const } : link),
            { targetId: "source-two", provenance: "suggested", decision: "dismissed", confidence: 0.9, sourceRevision: draft.sourceRevision, targetRevision: 1 }],
          attachmentIds: [...draft.attachmentIds, "manual-image"],
        }))!;
        const retainedLinks = structuredClone(draft.links);
        const assertMetadata = async () => {
          const record = (await brain.getRecord(draftId))!;
          assert.equal(record.title, "My title"); assert.equal(record.summary, "My summary");
          assert.deepEqual(record.links.slice(0, retainedLinks.length), retainedLinks);
          assert.equal(record.links.filter(link => link.targetId === "source-two" && link.provenance === "source").length, 1);
          assert.deepEqual(record.attachmentIds, ["source-one-image", "manual-image", "source-two-image"]);
          assert.deepEqual((await brain.getAttachment("manual-image"))!.bytes, Uint8Array.of(7, 8, 9));
          return record;
        };
        await brain.upsertSegment("study", second); await engine.append("study", [second]);
        assert.equal(calls, 0);
        assert.equal((await assertMetadata()).thoughtStatus, "draft");
        await restart(); await restart(); await assertMetadata();
        if (publication === "incremental") {
          await engine.process("study", true);
          assert.equal(calls, 1);
        } else {
          const input: ThoughtInput = { sessionId: "study", segments: [first, second], finalize: true, context: "" };
          const state = (await brain.getState<Record<string, unknown>>("thought-buffer:study"))!;
          await brain.putOperation({ id: "legacy-operation", kind: "consolidate", recordId: "study", sourceRevision: 2, status: "running", attempts: 1 });
          await brain.setState("thought-buffer:study", { ...state, status: "running", finalize: true,
            staged: { input, result: organized(input), spans: spans(input.segments), operation: "legacy-operation" } });
          await restart();
          assert.equal(calls, 0, "A durable staged result publishes without another generation call");
        }
        const published = await assertMetadata();
        assert.equal(published.thoughtStatus, "settled");
        assert.deepEqual(published.segments.map(segment => segment.text), [first.text, second.text]);
        assert.equal((await brain.listRecords()).filter(record => record.kind === "dictation").length, 1);
        await restart(); await assertMetadata();
      } finally { await brain.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
}
