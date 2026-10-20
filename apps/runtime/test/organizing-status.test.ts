import test from "node:test";
import assert from "node:assert/strict";
import type { BrainRecord } from "../../../packages/contracts/src/index.js";
import { organizingStatus } from "../../desktop/src/organizing-status.js";

const note = (id: string, overrides: Partial<BrainRecord> = {}): BrainRecord => ({
  id, kind: "dictation", revision: 1, sourceRevision: 1, title: id, summary: "s", createdAt: "2026-10-21T01:00:00Z", updatedAt: "2026-10-21T01:00:00Z",
  segments: [], links: [], attachmentIds: [], topics: [], quality: "ready", qualityReasons: [], doubt: false, manualFields: [], acceptedRevision: 0,
  thoughtStatus: "settled", ...overrides,
});

test("the graph says when organizing is running, finished or needs Retry", () => {
  assert.deepEqual(organizingStatus(undefined, [note("a")]), { label: "All notes organized", tone: "done" });
  assert.deepEqual(organizingStatus({ status: "collecting", pending: true }, [note("a")]), { label: "Organizing…", tone: "busy" });
  assert.deepEqual(organizingStatus({ status: "running", pending: false }, []), { label: "Organizing…", tone: "busy" });
  assert.deepEqual(organizingStatus({ status: "failed", pending: true, error: "Generation exceeded", recordId: "a" }, [note("a", { error: "Generation exceeded" })]),
    { label: "1 note needs Retry", tone: "attention" }, "A failed pass and its note count once");
  assert.equal(organizingStatus(undefined, [note("a", { error: "x" }), note("b", { error: "y" }), note("c", { error: "z", suppressed: { at: "", operationId: "", sessionId: "" } })]).label,
    "2 notes need Retry", "Hidden notes are not counted");
  assert.equal(organizingStatus(undefined, [note("plain", { thoughtStatus: undefined, error: "summary failed" })]).label, "All notes organized",
    "Only organized notes count; a standalone summary failure has its own Retry in the reader");
});
