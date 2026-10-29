import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Agent } from "../../../packages/agent/src/index.js";
import { FixtureProviders } from "../../../packages/agent-host/src/providers.js";
import { MemoryBrain } from "../../../packages/brain/src/memory.js";
import type { AgentEvent, AgentState, RecordPatch } from "../../../packages/contracts/src/index.js";
import { actionMessage, readableNotice } from "../../desktop/src/feedback.js";
import { readerError } from "../../desktop/src/note-reader.js";
import { reconcileSnapshot, type Snapshot, type SnapshotEvent } from "../../desktop/src/snapshot.js";
import { createBridge, type BridgeOptions } from "../src/bridge.js";
import type { VoiceStatus } from "../src/types.js";

const require = createRequire(import.meta.url);
const desktop = require("../../desktop/local-content.cjs") as {
  allowedRequest(method: string, path: string): boolean;
  externalURL(value: unknown): string | null;
};
const off: VoiceStatus = { enabled: false, requestedOn: false, listening: false, speaking: false, phase: "off", error: null };
const WORKSHEET = "Moo is reading the sample worksheet (this web demo can't see your screen).";
const failure = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : `non-Error ${String(error)}`);

/** The real Agent on a MemoryBrain with fixture providers, as the web host builds it, without voice. */
async function live(t: TestContext) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
  const brain = new MemoryBrain();
  const providers = new FixtureProviders();
  const voice: string[] = [];
  let emit = (_event: AgentEvent) => {};
  const agent = new Agent({
    brain, decisions: providers, generation: providers, search: providers, vision: providers,
    capture: { async capture() { return { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }; } },
    speech: { async speak() {}, async stop() {} },
    id: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    onEvent: event => emit(event),
  });
  await agent.initialize();
  const bridge = createBridge({
    agent, brain, mode: "fixture", voice: async action => { voice.push(action); },
    nativeSnapshot: () => off, processing: () => ({ status: "available" }), text: () => ({}),
  });
  emit = bridge.emit;
  const events: SnapshotEvent[] = [];
  bridge.api.subscribe(event => events.push(event));
  return {
    agent, brain, events, voice,
    post: (path: string, body?: unknown) => bridge.api.request("POST", path, body),
    snapshot: () => bridge.api.request<Snapshot>("GET", "/api/state"),
    async userTurn(text: string) {
      const segment = (await brain.listRecords()).flatMap(record => record.segments).find(s => s.speaker === "user" && s.text === text);
      assert.ok(segment, text);
      return segment.turnId;
    },
  };
}

/** A recording Agent, as apps/runtime/test/runtime.test.ts uses for the runtime server. */
function stub(overrides: Partial<BridgeOptions> = {}) {
  const actions: { name: string; value?: unknown }[] = [];
  const brain = new MemoryBrain();
  const state: AgentState = { listening: false, busy: false, webAllowed: true };
  const status: VoiceStatus = { ...off };
  const record = (name: string) => async (value?: unknown) => { actions.push(value === undefined ? { name } : { name, value }); };
  const agent = {
    getState: () => state,
    liveThoughtPreview: async () => state.sessionId
      ? { sessionId: state.sessionId, revision: "fixture", segments: [{ id: "preview", speaker: "user", text: "Revisable source preview", final: false }] }
      : undefined,
    startSession: record("session-start"),
    stopSession: record("session-stop"),
    checkpointConversation: record("checkpoint"),
    submitText: record("input"),
    requestEnd: record("end"),
    resolveEnd: record("resolve"),
    setSubject: record("subject"),
    retrySummary: record("summary-retry"),
    stopSpeech: record("speech-stop"),
    interrupt: record("response-cancel"),
    editRecord: async (id: string, revision: number, patch: RecordPatch) => {
      actions.push({ name: "edit", value: { id, revision, patch } });
      return { id, revision, ...patch };
    },
  };
  const bridge = createBridge({
    agent: agent as unknown as BridgeOptions["agent"], brain, mode: "live",
    voice: async action => { actions.push({ name: "voice", value: action }); },
    nativeSnapshot: () => status,
    processing: () => ({ status: "checking" }),
    text: () => ({}),
    ...overrides,
  });
  return {
    ...bridge, actions, brain, agent, state, status,
    get: <T = unknown>(path: string) => bridge.api.request<T>("GET", path),
    post: <T = unknown>(path: string, body?: unknown) => bridge.api.request<T>("POST", path, body),
  };
}

test("typed dictation reaches the snapshot as the runtime assembles it, with the web's folders, status and the turn's chip", async t => {
  const h = await live(t);
  try {
    await h.post("/api/session", { action: "start" });
    const text = "Osmosis is water moving across a membrane toward the side with more solute.";
    const reply = await h.post("/api/input", { text }) as { ok: boolean; state: AgentState };
    assert.equal(reply.ok, true);
    assert.equal(reply.state.listening, true);
    await h.agent.drain();
    const snapshot = await h.snapshot();
    assert.equal(snapshot.mode, "fixture");
    assert.deepEqual(snapshot.processing, { status: "available" });
    assert.deepEqual(snapshot.localFolders, []);
    assert.equal(snapshot.localFoldersAvailable, false);
    assert.deepEqual(snapshot.native, off);
    assert.equal(snapshot.state.listening, true);
    assert.ok(snapshot.records.some(record => record.id === snapshot.state.sessionId && record.segments.some(segment => segment.text === text)));
    assert.deepEqual(snapshot.liveThought?.segments.map(segment => segment.text), [text]);
    assert.equal(snapshot.thoughtProcessing?.pending, true, "the dictation waits for the organizer");
    assert.deepEqual(snapshot.intents?.[await h.userTurn(text)], { label: "Saved as a thought", route: "dictate", confidence: 1 });
    // The first event is the subscriber's state; each later one carries the next sequence, and a snapshot sits at the last.
    assert.deepEqual(h.events[0], { type: "state", state: h.events[0]?.state, sequence: 0 });
    assert.deepEqual(h.events.map(event => event.sequence), h.events.map((_, index) => index));
    assert.equal(snapshot.sequence, h.events.at(-1)?.sequence);
    await h.post("/api/session", { action: "stop" });
    assert.deepEqual(h.voice, ["stop"], "the microphone stops before the session does");
    assert.equal((await h.snapshot()).state.listening, false);
  } finally { await h.agent.drain(); }
});

test("a request to Moo opens a conversation and gets its chip", async t => {
  const h = await live(t);
  try {
    await h.post("/api/session", { action: "start" });
    const text = "Moo, how does dilution connect to osmosis?";
    await h.post("/api/input", { text });
    await h.agent.drain();
    const snapshot = await h.snapshot();
    const conversation = snapshot.records.find(record => record.id === snapshot.state.conversationId);
    assert.ok(conversation?.segments.some(segment => segment.speaker === "assistant"), "the fixture answer is in the conversation");
    assert.deepEqual(snapshot.intents?.[await h.userTurn(text)], { label: "Request for Moo", route: "start_agent", confidence: 1 });
  } finally { await h.agent.drain(); }
});

test("a stated doubt gets Moo's offer, and accepting it reads the sample worksheet under the web's notice", async t => {
  const h = await live(t);
  try {
    await h.post("/api/session", { action: "start" });
    const doubt = "I'm not sure why sample A's minimum is lower.";
    await h.post("/api/input", { text: doubt });
    await h.agent.drain();
    let snapshot = await h.snapshot();
    assert.equal(snapshot.state.pendingOffer?.kind, "help");
    assert.deepEqual(snapshot.intents?.[await h.userTurn(doubt)], { label: "Doubt: Moo offers help", route: "dictate", confidence: 1 });
    await h.post("/api/input", { text: "Yes" });
    await h.agent.drain();
    snapshot = await h.snapshot();
    assert.equal(snapshot.intents?.[await h.userTurn("Yes")]?.label, "Request for Moo");
    assert.ok(snapshot.records.some(record => record.kind === "conversation" && record.attachmentIds.length), "the worksheet was read");
    const notices = h.events.filter(event => event.type === "notice").map(event => event.message);
    assert.ok(notices.includes(WORKSHEET), JSON.stringify(notices));
    assert.ok(!notices.some(message => message?.includes("Reading your screen")), JSON.stringify(notices));
    assert.equal(readableNotice(WORKSHEET), WORKSHEET, "the renderer shows it as it is");
  } finally { await h.agent.drain(); }
});

test("only the desktop renderer's allowlisted requests exist; everything else is Not found", async () => {
  const h = stub();
  const requests: [string, string][] = [
    ["GET", "/api/state"], ["GET", "/api/native"], ["GET", "/api/local-folders"], ["GET", "/api/related/note"],
    ["GET", "/api/attachment/screen.png"], ["POST", "/api/session"], ["POST", "/api/end"], ["POST", "/api/record/note"],
    ["POST", "/api/local-folders/revoke"], ["GET", "/api/events"], ["GET", "/api/state?full=1"], ["GET", "/api/history/note"],
    ["GET", "/api/export/note"], ["GET", "/api/related/"], ["GET", "/api/related/a/b"], ["GET", "/api/attachment/%2e%2e"],
    ["GET", "/api/record/note"], ["GET", "/api/input"], ["POST", "/api/state"], ["POST", "/api/local-folders/grant"],
    ["POST", "/api/local-folders/grant?path=/"], ["POST", "/api/local-folders%2fgrant"], ["POST", "/api/notes"],
    ["POST", "/api/brain/query"], ["POST", "/api/snapshot/export"], ["POST", "/api/snapshot/import"],
    ["POST", "/api/record/note.json"], ["POST", "/api/record/"], ["POST", "/api/voice/"], ["POST", "api/input"],
    ["PUT", "/api/input"], ["DELETE", "/api/record/note"],
  ];
  for (const [method, path] of requests) {
    const before = h.actions.length;
    const result = await failure(h.api.request(method as "GET" | "POST", path, { action: "start", text: "x" }));
    const allowed = desktop.allowedRequest(method, path);
    assert.equal(result === "Not found", !allowed, `${method} ${path}: ${result}`);
    if (!allowed) assert.equal(h.actions.length, before, `${method} ${path} reached the Agent`);
  }
});

test("malformed bodies are refused with the runtime's messages before the Agent changes", async () => {
  const h = stub();
  await h.brain.createRecord({ id: "note", kind: "note", createdAt: "2026-10-28T00:00:00Z" });
  const invalid: [string, unknown, string][] = [
    ["/api/input", [], "Expected an object"],
    ["/api/input", "text", "Expected an object"],
    ["/api/input", 42, "Expected an object"],
    ["/api/input", { text: "x".repeat(1024 * 1024) }, "Request too large"],
    ["/api/session", { action: "restart" }, "Invalid session action"],
    ["/api/session", undefined, "Invalid session action"],
    ["/api/input", { text: 123 }, "Invalid text"],
    ["/api/input", { text: "x".repeat(60001) }, "Invalid text"],
    ["/api/end/resolve", { action: "discard-everything" }, "Invalid end action"],
    ["/api/subject", { subject: [] }, "Invalid subject"],
    ["/api/subject", { subject: "x".repeat(201) }, "Invalid subject"],
    ["/api/retry", {}, "Choose one saved note to retry its summary"],
    ["/api/retry", { recordId: {}, scope: "summary" }, "Choose one saved note to retry its summary"],
    ["/api/retry", { recordId: "note" }, "Choose one saved note to retry its summary"],
    ["/api/retry", { recordId: "note", scope: "all" }, "Choose one saved note to retry its summary"],
    ["/api/retry", { recordId: "  ", scope: "summary" }, "Choose one saved note to retry its summary"],
    ["/api/retry", { recordId: "x".repeat(513), scope: "summary" }, "Choose one saved note to retry its summary"],
    ["/api/voice", { action: "record-forever" }, "Invalid voice action"],
    ["/api/voice", {}, "Invalid voice action"],
    ["/api/local-folders/revoke", { id: "folder" }, "Local files are unavailable"],
    ["/api/record/note", { revision: -1, patch: { summary: "text" } }, "Invalid revision"],
    ["/api/record/note", { revision: 1.5, patch: { summary: "text" } }, "Invalid revision"],
    ["/api/record/note", { revision: "1", patch: { summary: "text" } }, "Invalid revision"],
    ["/api/record/note", { revision: 1, patch: {} }, "Empty or invalid edit"],
    ["/api/record/note", { revision: 1, patch: [] }, "Empty or invalid edit"],
    ["/api/record/note", { revision: 1, patch: { summary: 42 } }, "Invalid summary"],
    ["/api/record/note", { revision: 1, patch: { title: {} } }, "Invalid title"],
    ["/api/record/note", { revision: 1, patch: { topics: [false] } }, "Invalid topics"],
    ["/api/record/note", { revision: 1, patch: { purpose: "Bad" } }, "Invalid purpose"],
    ["/api/record/note", { revision: 1, patch: { links: [{ targetId: "x" }] } }, "Invalid relationships"],
    ["/api/record/note", { revision: 1, patch: { segments: [] } }, "Only title, summary, body, purpose, topics, resolution, archived and links are editable"],
    ["/api/record/note", { revision: 1, patch: { body: "different source" } }, "Only title, summary and connection removal are available in this view"],
    ["/api/record/note", { revision: 1, patch: { archived: true } }, "Only title, summary and connection removal are available in this view"],
    ["/api/record/missing", { revision: 0, patch: { links: [] } }, "Record not found"],
  ];
  for (const [path, body, message] of invalid)
    assert.equal(await failure(h.post(path, body)), message, `${path} ${JSON.stringify(body)?.slice(0, 80)}`);
  assert.equal(h.actions.length, 0, JSON.stringify(h.actions));
  // Electron sent a missing body as {}.
  assert.deepEqual(await h.post("/api/end"), { ok: true, state: h.state });
  assert.deepEqual(await h.post("/api/end", null), { ok: true, state: h.state });
  assert.deepEqual(await h.post("/api/record/note", { revision: 2, patch: { title: "A title", summary: "Saved text" } }),
    { id: "note", revision: 2, title: "A title", summary: "Saved text" });
  assert.deepEqual(h.actions.map(action => action.name), ["end", "end", "edit"]);
});

test("each action reaches the Agent with its validated value and returns the runtime's reply", async () => {
  const h = stub();
  const calls: [string, unknown, { name: string; value?: unknown }][] = [
    ["/api/session", { action: "start" }, { name: "session-start" }],
    ["/api/input", { text: "A thought." }, { name: "input", value: "A thought." }],
    ["/api/end", {}, { name: "end" }],
    ["/api/end/resolve", { action: "finish" }, { name: "resolve", value: "finish" }],
    ["/api/subject", { subject: "Chemistry" }, { name: "subject", value: "Chemistry" }],
    ["/api/retry", { recordId: "note", scope: "summary" }, { name: "summary-retry", value: "note" }],
    ["/api/speech/stop", {}, { name: "speech-stop" }],
    ["/api/response/cancel", {}, { name: "response-cancel" }],
  ];
  for (const [path, body, action] of calls) {
    assert.deepEqual(await h.post(path, body), { ok: true, state: h.state }, path);
    assert.deepEqual(h.actions.at(-1), action, path);
  }
  assert.equal(h.actions.length, calls.length);
});

test("an explicit microphone stop checkpoints after capture stops; start, flush and speech stop do not", async () => {
  const h = stub();
  for (const action of ["start", "flush", "stop"]) await h.post("/api/voice", { action });
  await h.post("/api/speech/stop", {});
  assert.deepEqual(h.actions, [
    { name: "voice", value: "start" },
    { name: "voice", value: "flush" },
    { name: "voice", value: "stop" },
    { name: "checkpoint" },
    { name: "speech-stop" },
  ]);
  await h.post("/api/session", { action: "stop" });
  assert.deepEqual(h.actions.slice(-2), [{ name: "voice", value: "stop" }, { name: "session-stop" }]);
});

test("Agent and host errors reach the renderer unchanged, so its messages still match them", async () => {
  const saved = new Error("Saved; Moo couldn't act on it: Backend 503: demo_budget_exhausted");
  const changed = new Error("Record changed; reload before editing");
  const microphone = new Error("The microphone could not connect. Check its permission and connection, then try again.");
  const h = stub({ voice: async () => { throw microphone; } });
  Object.assign(h.agent, {
    submitText: async () => { throw saved; },
    editRecord: async () => { throw changed; },
  });
  await h.brain.createRecord({ id: "note", kind: "note", createdAt: "2026-10-28T00:00:00Z" });
  await assert.rejects(h.post("/api/input", { text: "A thought." }), error => error === saved);
  assert.equal(actionMessage(saved, "/api/input"), "Your message is saved, but Moo couldn't act on it. Send it again to retry.");
  await assert.rejects(h.post("/api/record/note", { revision: 0, patch: { title: "New" } }), error => error === changed);
  assert.equal(readerError(changed), "This note changed while you were editing. Reopen it to use the latest version.");
  await assert.rejects(h.post("/api/voice", { action: "start" }), error => error === microphone);
  assert.equal(actionMessage(microphone, "/api/voice"), microphone.message);
  await assert.rejects(h.post("/api/voice", { action: "stop" }), error => error === microphone);
  assert.ok(!h.actions.some(action => action.name === "checkpoint"), "a failed stop does not checkpoint");
});

test("a state snapshot takes its sequence before any await, so events emitted while it is read are replayed", async () => {
  const h = stub();
  Object.assign(h.agent, { getState: () => structuredClone(h.state) });
  h.emit({ type: "notice", message: "Before the snapshot" });
  let release!: () => void;
  const reading = new Promise<void>(resolve => { release = resolve; });
  const listRecords = h.brain.listRecords.bind(h.brain);
  h.brain.listRecords = async () => { await reading; return listRecords(); };
  const pending = h.get<Snapshot>("/api/state");
  // A state change lands while the records are still being read; the snapshot already holds the older state.
  Object.assign(h.state, { listening: true, sessionId: "study" });
  const events: SnapshotEvent[] = [];
  h.api.subscribe(event => events.push(event));
  h.emit({ type: "state", state: { ...h.state } });
  release();
  const snapshot = await pending;
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.state.listening, false);
  assert.equal(events.at(-1)?.sequence, 2);
  const replayed = reconcileSnapshot(snapshot, events);
  assert.equal(replayed.state.listening, true);
  assert.equal(replayed.sequence, 2);
});

test("the snapshot reports organizing progress without its source text, and passes processing and status through", async () => {
  const h = stub({ processing: () => ({ status: "unavailable", checkedAt: "2026-10-29T00:00:00Z" }) });
  h.state.sessionId = "study";
  Object.assign(h.status, { enabled: true, requestedOn: true, listening: true, phase: "listening" });
  await h.brain.setState("thought-buffer:study", { status: "failed", error: "More text remains", continuationRequired: true, activeId: "growing", spans: [{ text: "private retained text" }] });
  await h.brain.setState("interaction-trace", [{ at: "2026-10-29T00:00:00Z", action: "route", turnId: "turn", route: "dictate", confidence: 0.5 }]);
  let snapshot = await h.get<Snapshot>("/api/state");
  assert.deepEqual(snapshot.thoughtProcessing, { status: "failed", error: "More text remains", pending: true, continuationRequired: true, recordId: "growing" });
  assert.equal(snapshot.liveThought?.segments[0]?.text, "Revisable source preview");
  assert.deepEqual(snapshot.processing, { status: "unavailable", checkedAt: "2026-10-29T00:00:00Z" });
  assert.deepEqual(snapshot.native, h.status);
  assert.equal(snapshot.mode, "live");
  assert.deepEqual(snapshot.intents, { turn: { label: "Saved as a thought · unsure", route: "dictate", confidence: 0.5 } });
  assert.ok(!JSON.stringify(snapshot).includes("private retained text"));
  await h.brain.setState("thought-buffer:study", { status: "failed", error: "Provider unavailable", draftId: "draft", spans: [] });
  snapshot = await h.get<Snapshot>("/api/state");
  assert.deepEqual(snapshot.thoughtProcessing, { status: "failed", error: "Provider unavailable", pending: false, continuationRequired: false, recordId: "draft" });
  await h.brain.setState("thought-buffer:study", { spans: [{}] });
  assert.deepEqual((await h.get<Snapshot>("/api/state")).thoughtProcessing, { status: "collecting", pending: true, continuationRequired: false });
});

test("responses and events are JSON copies, as over HTTP", async () => {
  const h = stub();
  const reply = await h.post<{ state: AgentState & { sessionId?: string } }>("/api/input", { text: "A thought." });
  reply.state.listening = true;
  assert.equal(h.state.listening, false, "a reply never hands out the Agent's own state");
  const native = await h.get<VoiceStatus>("/api/native");
  assert.deepEqual(native, h.status);
  native.listening = true;
  assert.equal(h.status.listening, false);
  h.state.sessionId = undefined;
  assert.ok(!("sessionId" in (await h.get<Snapshot>("/api/state")).state), "undefined members are left out, as JSON leaves them");
  const body = { text: "Sent first" };
  const sent = h.post("/api/input", body);
  body.text = "Changed after sending";
  await sent;
  assert.deepEqual(h.actions.at(-1), { name: "input", value: "Sent first" });
  const first: AgentEvent[] = [], second: AgentEvent[] = [];
  h.api.subscribe(event => first.push(event));
  h.api.subscribe(event => second.push(event));
  const record = await h.brain.createRecord({ id: "note", kind: "note", createdAt: "2026-10-28T00:00:00Z" });
  h.emit({ type: "record", record });
  assert.deepEqual(first.at(-1), { type: "record", record, sequence: 1 });
  assert.notEqual(first.at(-1), second.at(-1));
  assert.notEqual(first.at(-1)?.record, record);
});

test("subscribers get the current state first and every later event once; one that throws stops neither the others nor the Agent", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const h = stub();
  h.emit({ type: "notice", message: "Before anyone listened" });
  const events: SnapshotEvent[] = [];
  const dispose = h.api.subscribe(event => events.push(event));
  h.api.subscribe(() => { throw new Error("Renderer bug"); });
  assert.deepEqual(events, [{ type: "state", state: h.state, sequence: 1 }]);
  assert.doesNotThrow(() => h.emit({ type: "notice", message: "Saved." }));
  assert.deepEqual(events.at(-1), { type: "notice", message: "Saved.", sequence: 2 });
  assert.equal(logged.mock.callCount(), 2, "the throwing listener's initial state and its notice were both logged");
  // One function subscribed twice is two subscriptions; disposing one leaves the other.
  const twice: SnapshotEvent[] = [];
  const listener = (event: AgentEvent) => twice.push(event);
  const once = h.api.subscribe(listener);
  h.api.subscribe(listener);
  once();
  dispose();
  h.emit({ type: "voice", voice: { ...off, speaking: true } });
  assert.equal(events.length, 2, "a disposed subscription gets nothing more");
  assert.deepEqual(twice.map(event => event.type), ["state", "state", "voice"]);
});

test("the screen-reading notice names the sample worksheet, and the host's hook words or drops the rest", async () => {
  const seen: string[] = [];
  const h = stub({ rewriteNotice: message => { seen.push(message); return message.startsWith("Backend 503") ? undefined : `Web: ${message}`; } });
  const notices: SnapshotEvent[] = [];
  h.api.subscribe(event => { if (event.type === "notice") notices.push(event); });
  h.emit({ type: "notice", message: "Reading your screen. This can take up to a minute." });
  h.emit({ type: "notice", message: "Backend 503: demo_budget_exhausted" });
  h.emit({ type: "notice", message: "Saved." });
  assert.deepEqual(seen, [WORKSHEET, "Backend 503: demo_budget_exhausted", "Saved."]);
  assert.deepEqual(notices, [
    { type: "notice", message: `Web: ${WORKSHEET}`, sequence: 1 },
    { type: "notice", message: "Web: Saved.", sequence: 2 },
  ]);
  const plain = stub();
  const unchanged: SnapshotEvent[] = [];
  plain.api.subscribe(event => unchanged.push(event));
  plain.emit({ type: "notice", message: "Reading your screen. This can take up to a minute." });
  plain.emit({ type: "notice", message: "Connections unavailable: offline" });
  assert.deepEqual(unchanged.slice(1).map(event => event.message), [WORKSHEET, "Connections unavailable: offline"]);
});

test("attachments come back as base64 of their bytes, and related records, status and folders as the Brain and host give them", async () => {
  const h = stub();
  const bytes = Uint8Array.from({ length: 0x8000 * 3 + 17 }, (_, index) => (index * 31) % 256);
  await h.brain.putAttachment("worksheet.png", "image/png", bytes);
  assert.deepEqual(await h.get("/api/attachment/worksheet.png"), { mimeType: "image/png", base64: Buffer.from(bytes).toString("base64") });
  assert.equal(await failure(h.get("/api/attachment/missing.png")), "Attachment unavailable");
  const note = await h.brain.createRecord({ id: "note", kind: "note", createdAt: "2026-10-28T00:00:00Z" });
  await h.brain.createRecord({ id: "other", kind: "note", createdAt: "2026-10-28T00:00:00Z" });
  await h.brain.updateRecord(note.id, note.revision, { links: [{ targetId: "other", provenance: "suggested", confidence: 0.9, decision: "accepted" }] });
  const related = await h.get<{ id: string }[]>("/api/related/note");
  assert.deepEqual(related, await h.brain.related("note"));
  assert.deepEqual(related.map(record => record.id), ["other"]);
  assert.deepEqual(await h.get("/api/related/unknown"), []);
  assert.deepEqual(await h.get("/api/native"), off);
  assert.deepEqual(await h.get("/api/local-folders"), []);
});

test("connection removal accepts a dismissal whatever its key order, and refuses any other change to links", async () => {
  const h = stub();
  let note = await h.brain.createRecord({ id: "note", kind: "note", createdAt: "2026-10-28T00:00:00Z" });
  note = (await h.brain.updateRecord(note.id, note.revision, { links: [
    { targetId: "other", provenance: "suggested", confidence: 0.95, decision: "accepted" },
    { targetId: "source", provenance: "source" },
    { targetId: "pinned", provenance: "manual", sourceRevision: 2, targetRevision: 1 },
  ] }))!;
  const [suggested, source, manual] = note.links as [typeof note.links[number], typeof note.links[number], typeof note.links[number]];
  const refused: [RecordPatch["links"], string][] = [
    [[], "Keep removed connections as dismissed"],
    [[...note.links, { targetId: "new", provenance: "manual" }], "Keep removed connections as dismissed"],
    [note.links.map(link => ({ ...link, confidence: 1 })), "Only existing associations can be dismissed"],
    [[suggested, { ...source, decision: "dismissed" }, manual], "Only existing associations can be dismissed"],
    [[source, suggested, manual], "Only existing associations can be dismissed"],
    [[{ ...suggested, decision: "dismissed", targetId: "elsewhere" }, source, manual], "Only existing associations can be dismissed"],
    [[{ ...suggested, provenance: "manual", decision: "dismissed" }, source, manual], "Only existing associations can be dismissed"],
  ];
  for (const [links, message] of refused)
    assert.equal(await failure(h.post("/api/record/note", { revision: note.revision, patch: { links } })), message, JSON.stringify(links));
  assert.deepEqual(h.actions, []);
  const dismissed = [
    { decision: "dismissed", confidence: 0.95, provenance: "suggested", targetId: "other" },
    { provenance: "source", targetId: "source" },
    { targetRevision: 1, decision: "dismissed", targetId: "pinned", sourceRevision: 2, provenance: "manual" },
  ];
  await h.post("/api/record/note", { revision: note.revision, patch: { links: dismissed } });
  assert.deepEqual(h.actions, [{ name: "edit", value: { id: "note", revision: note.revision, patch: { links: dismissed } } }]);
});

test("links open only when public http(s), before anything is awaited; folders stay unavailable; host text is read live", async () => {
  const opened: string[] = [];
  let text: Record<string, string> = { speaking: "Moo is speaking · press Stop speech to interrupt" };
  const h = stub({ open: url => { opened.push(url); }, text: () => text });
  const pending = h.api.openExternal!("https://example.com/docs?q=osmosis");
  assert.deepEqual(opened, ["https://example.com/docs?q=osmosis"], "opened inside the click, before the promise settles");
  await pending;
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "obsidian://open", "https://user:secret@example.com",
    "https://example.com/\nattack", "https://example.com/a b", "relative.md", "x".repeat(8193), null]) {
    assert.equal(await failure(h.api.openExternal!(value as string)), "Only public HTTP or HTTPS links can be opened", String(value));
    assert.equal(desktop.externalURL(value), null);
  }
  assert.equal(desktop.externalURL("HTTPS://Example.com/a"), "https://example.com/a");
  await h.api.openExternal!("HTTPS://Example.com/a");
  assert.deepEqual(opened, ["https://example.com/docs?q=osmosis", "https://example.com/a"], "the desktop's normalised URL is opened");
  assert.equal(await failure(h.api.chooseFolder()), "Local folders are unavailable in the web demo");
  assert.equal(h.api.text?.speaking, "Moo is speaking · press Stop speech to interrupt");
  text = { footerEmpty: "Nothing is saved; refresh to reset" };
  assert.deepEqual(h.api.text, { footerEmpty: "Nothing is saved; refresh to reset" });
  assert.equal(typeof Object.getOwnPropertyDescriptor(h.api, "text")?.get, "function");
});
