import test from "node:test";
import assert from "node:assert/strict";
import type { BrainRecord, Segment } from "../../../packages/contracts/src/index.js";
import { sessionHubs } from "../../desktop/src/session-hubs.js";

const segment = (id: string, createdAt = "2026-10-18T03:40:00Z"): Segment => ({ id, turnId: `turn-${id}`, speaker: "user", text: id, revision: 1, final: true, createdAt });
const record = (id: string, overrides: Partial<BrainRecord> = {}): BrainRecord => ({
  id, kind: "dictation", revision: 1, sourceRevision: 1, title: id, summary: "", createdAt: "2026-10-18T03:40:00Z", updatedAt: "2026-10-18T03:40:00Z",
  segments: [], links: [], attachmentIds: [], topics: [], quality: "ready", qualityReasons: [], doubt: false, manualFields: [], acceptedRevision: 0, ...overrides,
});
const session = (id: string, segments: Segment[]) => record(id, { kind: "session", segments });
const grown = (id: string, sessionId: string, extra: Partial<BrainRecord> = {}) => record(id, {
  thoughtStatus: "growing", sources: [{ recordId: sessionId, spans: [] }], links: [{ targetId: sessionId, provenance: "source" }], ...extra,
});

test("growing notes and captured dictation from one study session share its hub", () => {
  const s = session("s1", [segment("a"), segment("b")]);
  const thought = grown("thought", "s1");
  const captured = record("captured", { segments: [segment("b")] });
  const unrelated = record("unrelated", { segments: [segment("z")] });
  const records = [s, thought, captured, unrelated];
  assert.deepEqual(sessionHubs(records, [thought, captured, unrelated]).map(hub => [hub.id, hub.members]),
    [["s1", ["captured", "thought"]]]);
});

test("a note made in a conversation joins that conversation's session; a growing note keeps its own", () => {
  const first = session("first", [segment("q1", "2026-10-18T03:35:00Z")]);
  const second = session("second", [segment("q2", "2026-10-18T03:41:00Z")]);
  const conversation = record("conversation", { kind: "conversation", sourceOnly: true, segments: [segment("q1"), segment("q2")] });
  const made = record("made", { kind: "note", links: [{ targetId: "conversation", provenance: "source" }] });
  const thought = grown("thought", "second", { links: [{ targetId: "second", provenance: "source" }, { targetId: "conversation", provenance: "source" }] });
  const sibling = grown("sibling", "second");
  const earlier = grown("earlier", "first");
  const records = [first, second, conversation, made, thought, sibling, earlier];
  assert.deepEqual(sessionHubs(records, [made, thought, sibling, earlier]).map(hub => [hub.id, hub.members]),
    [["first", ["earlier", "made"]], ["second", ["made", "sibling", "thought"]]]);
});

test("a hub needs two visible notes; hidden, filtered and empty sessions draw none", () => {
  const s = session("s1", [segment("a")]);
  const empty = session("empty", []);
  const visible = grown("visible", "s1");
  const hidden = grown("hidden", "s1", { sourceOnly: true });
  const archived = grown("archived", "s1", { archived: true });
  const filtered = grown("filtered", "s1");
  const records = [s, empty, visible, hidden, archived, filtered];
  assert.deepEqual(sessionHubs(records, [visible]), []);
  assert.deepEqual(sessionHubs(records, [visible, filtered]).map(hub => hub.members), [["filtered", "visible"]]);
  assert.deepEqual(sessionHubs([...records.filter(item => item !== s), { ...s, suppressed: { at: "", operationId: "", sessionId: "" } }], [visible, filtered]), []);
});

test("a session whose speech spans more than a day predates Start and Stop sessions and draws no hub", () => {
  const old = session("old", [segment("a", "2026-09-26T05:55:58Z"), segment("b", "2026-10-10T14:55:16Z")]);
  const one = grown("one", "old"), two = grown("two", "old");
  assert.deepEqual(sessionHubs([old, one, two], [one, two]), []);
});

test("hubs are labelled by when the session started and listed in that order", () => {
  const later = session("later", [segment("l", "2026-10-18T05:00:00Z")]);
  const earlier = session("earlier", [segment("e", "2026-10-18T03:00:00Z")]);
  const notes = [grown("l1", "later"), grown("l2", "later"), grown("e1", "earlier"), grown("e2", "earlier")];
  const hubs = sessionHubs([later, earlier, ...notes], notes);
  assert.deepEqual(hubs.map(hub => hub.id), ["earlier", "later"]);
  for (const hub of hubs) assert.match(hub.label, /^Session · \S/);
});
