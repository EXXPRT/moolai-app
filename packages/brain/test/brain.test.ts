import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrainPort, Segment } from "../../contracts/src/index.js";
import { formatMarkdown, parseMarkdown } from "../../contracts/src/markdown.js";
import { MemoryBrain, SQLiteBrain } from "../src/index.js";

const createdAt = "2026-09-20T10:00:00.000Z";
const segment = (id: string, text: string, revision = 0): Segment => ({
  id,
  text,
  revision,
  turnId: "turn-1",
  speaker: "user",
  final: true,
  createdAt,
});

for (const adapter of ["memory", "sqlite"] as const) {
  test(`${adapter}: BrainPort retains revisions, protects edits, searches actual content and isolates returned values`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "moolai-brain-"));
    const brain: BrainPort =
      adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
    try {
      const empty = await brain.createRecord({
        id: "note-1",
        kind: "dictation",
        createdAt,
      });
      const first = await brain.upsertSegment(
        empty.id,
        segment("s1", "I want to grow orchids."),
      );
      const stale = await brain.upsertSegment(
        empty.id,
        segment("s1", "wrong same revision"),
      );
      assert.deepEqual(stale, first);
      const revised = await brain.upsertSegment(
        empty.id,
        segment("s1", "I want to grow orchids indoors.", 2),
      );
      assert.equal(revised.segments.length, 1);
      assert.equal(revised.sourceRevision, 2);
      assert.equal(
        (
          await brain.upsertSegment(
            empty.id,
            segment("s1", "late incorrect revision", 1),
          )
        ).sourceRevision,
        2,
      );
      assert.equal(
        await brain.updateRecord(empty.id, first.revision, {
          summary: "Stale generated result",
        }),
        null,
      );
      const manual = (await brain.updateRecord(empty.id, revised.revision, {
        summary: "My personal orchid note",
        topics: ["Gardening"],
        manualFields: ["summary", "topics"],
        offTopic: { subject: "Algebra" },
        quality: "ready",
        summarySourceRevision: revised.sourceRevision,
      }))!;
      const enriched = (await brain.updateRecord(empty.id, manual.revision, {
        summary: "Wrong overwrite",
        topics: ["Math"],
        title: "Orchids",
      }))!;
      assert.equal(enriched.summary, "My personal orchid note");
      assert.deepEqual(enriched.topics, ["Gardening"]);
      const amended = await brain.upsertSegment(
        empty.id,
        segment("s2", "Use indirect sunlight."),
      );
      assert.equal(amended.summary, "My personal orchid note");
      assert.equal(amended.quality, "pending");
      assert.equal(amended.summarySourceRevision, 2);
      assert.equal((await brain.search("orchids", 5))[0]?.id, empty.id);
      assert.deepEqual(await brain.search("unrelated term", 5), []);
      const accepted = (await brain.updateRecord(empty.id, amended.revision, {
        acceptedRevision: amended.revision,
      }))!;
      assert.equal(
        accepted.revision,
        amended.revision,
        "A backend acknowledgment must not create another unaccepted content revision",
      );
      assert.equal(accepted.acceptedRevision, accepted.revision);
      const delayedAck = (await brain.updateRecord(
        empty.id,
        accepted.revision,
        { acceptedRevision: 1 },
      ))!;
      assert.equal(delayedAck.acceptedRevision, amended.revision);
      delayedAck.segments[0]!.text = "mutation outside adapter";
      assert.equal(
        (await brain.getRecord(empty.id))?.segments[0]?.text,
        "I want to grow orchids indoors.",
      );
      assert.equal(
        (await brain.createRecord({ id: empty.id, kind: "note", createdAt }))
          .kind,
        "dictation",
      );
      assert.equal(await brain.updateRecord("missing", 0, {}), null);
      await assert.rejects(
        brain.upsertSegment("missing", segment("s1", "text")),
        /Unknown record/,
      );
    } finally {
      await brain.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${adapter}: attachment IDs are safe and immutable; operations and state are isolated`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "moolai-brain-"));
    const brain: BrainPort =
      adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      assert.equal(
        (await brain.putAttachment("screen-1.png", "image/png", bytes)).size,
        3,
      );
      bytes[0] = 9;
      assert.deepEqual(
        (await brain.getAttachment("screen-1.png"))?.bytes,
        new Uint8Array([1, 2, 3]),
      );
      await brain.putAttachment(
        "screen-1.png",
        "image/png",
        new Uint8Array([1, 2, 3]),
      );
      await assert.rejects(
        brain.putAttachment("screen-1.png", "image/png", bytes),
        /immutable/,
      );
      for (const id of ["../escape", "/absolute", "..", "a/b", "a\\b", ""]) {
        await assert.rejects(
          brain.putAttachment(id, "image/png", bytes),
          /Unsafe attachment ID/,
        );
        await assert.rejects(brain.getAttachment(id), /Unsafe attachment ID/);
      }
      await brain.putOperation({
        id: "enrich:note:1",
        kind: "enrich",
        recordId: "note",
        sourceRevision: 1,
        status: "pending",
        attempts: 0,
      });
      await brain.putOperation({
        id: "enrich:note:1",
        kind: "enrich",
        recordId: "note",
        sourceRevision: 1,
        status: "done",
        attempts: 1,
      });
      assert.equal((await brain.listOperations()).length, 1);
      assert.equal((await brain.listOperations())[0]?.status, "done");
      const state = { pendingOffer: { kind: "help", recordId: "note" } };
      await brain.setState("session", state);
      state.pendingOffer.recordId = "mutated";
      assert.equal(
        (await brain.getState<typeof state>("session"))?.pendingOffer.recordId,
        "note",
      );
      assert.equal(await brain.getState("missing"), undefined);
    } finally {
      await brain.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("SQLite survives restart with source, pending work, attachment and session state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolai-restart-"));
  let brain = new SQLiteBrain(directory);
  try {
    await brain.createRecord({
      id: "conversation",
      kind: "conversation",
      createdAt,
    });
    await brain.upsertSegment(
      "conversation",
      segment("u1", "Moo, help me understand this."),
    );
    await brain.upsertSegment("conversation", {
      ...segment("a1", "What part is unclear?"),
      speaker: "assistant",
    });
    await brain.putOperation({
      id: "accept:conversation:2",
      recordId: "conversation",
      kind: "accept",
      sourceRevision: 2,
      status: "running",
      attempts: 1,
    });
    await brain.putAttachment("shot", "image/png", new Uint8Array([4, 5]));
    await brain.setState("agent", { conversationId: "conversation" });
    await brain.close();
    brain = new SQLiteBrain(directory);
    assert.deepEqual(
      (await brain.getRecord("conversation"))?.segments.map((s) => s.speaker),
      ["user", "assistant"],
    );
    assert.equal((await brain.listOperations())[0]?.status, "running");
    assert.equal(
      (await brain.getState<{ conversationId: string }>("agent"))
        ?.conversationId,
      "conversation",
    );
    assert.deepEqual(
      (await brain.getAttachment("shot"))?.bytes,
      new Uint8Array([4, 5]),
    );
  } finally {
    await brain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable Markdown preserves unknown frontmatter, prose and full source roles/revisions", async () => {
  const brain = new MemoryBrain();
  await brain.createRecord({ id: "portable", kind: "conversation", createdAt });
  await brain.upsertSegment(
    "portable",
    segment("u1", "Question\n<!-- moolai:generated:end -->"),
  );
  const record = await brain.upsertSegment("portable", {
    ...segment("a1", "Answer with a source.", 2),
    speaker: "assistant",
  });
  record.title = "A portable note";
  record.summary = "Generated content.";
  const userFrontmatter = "custom:\n  nested: [one, two]\naliases: [My name]\n";
  const userBody = "# My writing\n\nKeep this prose and [[My link]].\n";
  const original = `---\n${userFrontmatter}---\n${userBody}`;
  const generated = formatMarkdown(record, original);
  const parsed = parseMarkdown(generated);
  assert.deepEqual(parsed.record, record);
  assert.equal(parsed.userFrontmatter, userFrontmatter);
  assert.equal(parsed.userBody, userBody);
  const regenerated = formatMarkdown(
    { ...record, summary: "Updated summary." },
    generated,
  );
  assert.equal(parseMarkdown(regenerated).userBody, userBody);
  assert.equal(parseMarkdown(regenerated).userFrontmatter, userFrontmatter);
  assert.equal(regenerated.split("<!-- moolai:generated:start -->").length, 2);
  assert.match(regenerated, /### assistant/);
  assert.equal(parseMarkdown("Just an ordinary note.").record, undefined);
  assert.throws(
    () => parseMarkdown("<!-- moolai:generated:start -->unterminated"),
    /Unclosed/,
  );
});

test("SQLite keeps the real disk-full error and leaves no transaction open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolai-disk-full-"));
  const brain = new SQLiteBrain(directory);
  try {
    await brain.createRecord({ id: "full", kind: "note", createdAt });
    const db = (brain as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    db.exec(`PRAGMA max_page_count = ${pages + 1}`);
    await assert.rejects(brain.setState("large", "x".repeat(400_000)), (error: Error & { errcode?: number }) =>
      /full/i.test(error.message) || error.errcode === 13);
    assert.equal(db.isTransaction, false);
    db.exec(`PRAGMA max_page_count = 1073741823`);
    await brain.setState("after", 1);
    assert.equal(await brain.getState("after"), 1, "The Brain still works after the fault");
  } finally { await brain.close(); await rm(directory, { recursive: true, force: true }); }
});
