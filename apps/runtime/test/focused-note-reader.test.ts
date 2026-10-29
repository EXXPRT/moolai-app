import test from "node:test";
import assert from "node:assert/strict";
import type { BrainRecord, Segment } from "../../../packages/contracts/src/index.js";
import { connectionDismissals, connectionsFor, originalSources, readerError, sourceGroups } from "../../desktop/src/note-reader.js";

const segment = (id: string, turnId: string, speaker: Segment["speaker"], text: string): Segment => ({ id, turnId, speaker, text, revision: 1, final: true, createdAt: "2026-09-28T01:00:00Z" });
const note = (id: string, overrides: Partial<BrainRecord> = {}): BrainRecord => ({
  id, kind: "dictation", revision: 8, sourceRevision: 3, title: "A useful thought", summary: "A summary", createdAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z",
  segments: [], links: [], attachmentIds: [], topics: [], quality: "ready", qualityReasons: [], doubt: false, manualFields: [], acceptedRevision: 0, ...overrides,
});

test("consolidated dictation record identifies conversation from turn membership, including user-only excerpts", () => {
  const original = segment("original", "moo-turn", "user", "What breed is this bird?");
  const conversation = note("conversation", { kind: "conversation", sourceOnly: true, segments: [original] });
  const thought = note("thought", { segments: [{ ...original, id: "original:part:0" }] });
  const groups = sourceGroups(thought, [conversation, thought]);
  assert.equal(groups[0]?.kind, "Moo conversation");
  assert.equal(groups[0]?.segments[0]?.text, "What breed is this bird?");
});

test("mixed source notes retain dictation, conversation and speaker order without rewriting raw text", () => {
  const dictation = segment("d", "dictation-turn", "user", "The hamstring feels tight.");
  const question = segment("q", "question-turn", "user", "Why might that happen?");
  const answer = segment("a", "answer-turn", "assistant", "There are several possible explanations.");
  const correction = segment("c", "dictation-again", "user", "Not pain, just tightness.");
  const conversation = note("conversation", { kind: "conversation", segments: [question, answer] });
  const thought = note("mixed", { body: "Written reflection", segments: [dictation, question, answer, correction] });
  const groups = sourceGroups(thought, [thought, conversation]);
  assert.deepEqual(groups.map(group => group.kind), ["Dictation", "Moo conversation", "Dictation"]);
  assert.deepEqual(groups.flatMap(group => group.segments), thought.segments);
  assert.equal(thought.body, "Written reflection");
});

test("Recorded text exposes original help request and full conversation without processing JSON", () => {
  const request = note("request", { sourceOnly: true, segments: [segment("q", "q", "user", "What breed is this bird?")] });
  const conversation = note("conversation", { kind: "conversation", sourceOnly: true, links: [{ targetId: request.id, provenance: "reply" }], attachmentIds: ["screen.png"] });
  const session = note("session", { kind: "session" });
  const thought = note("thought", { sourceContext: '{"toolOutcome":"internal diagnostics"}', sources: [{ recordId: session.id, spans: [] }], links: [{ targetId: conversation.id, provenance: "source" }] });
  assert.deepEqual(originalSources(thought, [thought, request, conversation, session]).map(source => source.id), [conversation.id, session.id, request.id]);
  assert.equal(originalSources(thought, [thought, request, conversation, session])[0]?.attachmentIds[0], "screen.png");
});

test("removing an incoming and outgoing association updates their owners with revision checks and persistent dismissal", () => {
  const first = note("first", { links: [{ targetId: "second", provenance: "suggested", confidence: .92, sourceRevision: 3, targetRevision: 7, decision: "accepted" }, { targetId: "session", provenance: "source" }] });
  const second = note("second", { revision: 12, links: [{ targetId: "first", provenance: "manual" }] });
  const changes = connectionDismissals(first, second);
  assert.deepEqual(changes.map(change => [change.id, change.revision]), [["first", 8], ["second", 12]]);
  assert.deepEqual(changes[0]?.patch.links?.[0], { ...first.links[0], decision: "dismissed" });
  assert.deepEqual(changes[0]?.patch.links?.[1], first.links[1]);
  assert.equal(changes[1]?.patch.links?.[0]?.decision, "dismissed");
  const updatedFirst = { ...first, links: changes[0]!.patch.links! }, updatedSecond = { ...second, links: changes[1]!.patch.links! };
  assert.equal(connectionsFor(updatedFirst, [updatedFirst, updatedSecond]).length, 0);
  assert.equal(connectionDismissals(updatedFirst, updatedSecond).length, 0);
});

test("connections show incoming associations, exclude retained sessions and archives, and keep source links read-only", () => {
  const current = note("current", { links: [{ targetId: "source", provenance: "source" }, { targetId: "archived", provenance: "manual" }, { targetId: "retained", provenance: "source" }] });
  const incoming = note("incoming", { links: [{ targetId: current.id, provenance: "suggested", decision: "accepted" }] });
  const source = note("source");
  const archived = note("archived", { archived: true });
  const retained = note("retained", { kind: "conversation", sourceOnly: true });
  const displayed = connectionsFor(current, [current, incoming, source, archived, retained]);
  assert.deepEqual(displayed.map(item => [item.record.id, item.removable]), [["incoming", true], ["source", false]]);
  assert.equal(connectionDismissals(current, source).length, 0);
});

test("reader failures disclose neither raw backend errors nor an unsupported unchanged guarantee", () => {
  const error = readerError(new Error("HTTP 502 provider failed at secret internal URL"));
  assert.doesNotMatch(error, /502|provider|secret|unchanged/);
  assert.match(error, /could not be confirmed/);
  assert.match(readerError(new Error("409 revision conflict")), /latest version/);
  // The editor passes its own conflict text; other failures keep theirs.
  assert.equal(readerError(new Error("Record changed; reload before editing"), "Save again."), "Save again.");
  assert.match(readerError(new Error("HTTP 502"), "Save again."), /could not be confirmed/);
});

test('one-sided removal suppresses reverse associations but retains source connections',()=>{
 const a=note('a',{links:[{targetId:'b',provenance:'suggested',decision:'dismissed'}]});
 const b=note('b',{links:[{targetId:'a',provenance:'manual',decision:'accepted'}]});
 assert.deepEqual(connectionsFor(a,[a,b]),[]);
 b.links.push({targetId:'a',provenance:'source'});
 const connections=connectionsFor(a,[a,b]);assert.equal(connections.length,1);assert.equal(connections[0]!.removable,false);assert.equal(connections[0]!.label,'Source connection');
});

test('suppressed derived notes disappear from connections and linked-note browsing while source transcripts remain',()=>{
 const hidden=note('hidden',{suppressed:{at:'2026-10-10T01:00:00Z',operationId:'suppression',sessionId:'session'}});
 const session=note('session',{kind:'session',sourceOnly:true});
 const current=note('current',{links:[{targetId:hidden.id,provenance:'manual'},{targetId:session.id,provenance:'source'}]});
 assert.deepEqual(connectionsFor(current,[current,hidden,session]),[]);
 assert.deepEqual(originalSources(current,[current,hidden,session]).map(source=>source.id),['session']);
});
