// window.moolai in the page: apps/runtime/src/server.ts ported route for route behind the desktop's request allowlist
// (apps/desktop/local-content.cjs), so the renderer's error matching and snapshot replay work unchanged.
import type { Agent } from "../../../packages/agent/src/index.js";
import type { AgentEvent, BrainPort, BrainRecord, RecordPatch } from "../../../packages/contracts/src/index.js";
import { validateEdit } from "../../../packages/contracts/src/workspace.js";
import type { HostTextKey, Snapshot } from "../../desktop/src/snapshot.js";
import { intentsFromTrace } from "./intents.js";
import type { Emit, MoolaiApi, Processing, VoiceAction, VoiceStatus } from "./types.js";

export interface BridgeOptions {
  agent: Pick<Agent, "getState" | "liveThoughtPreview" | "startSession" | "stopSession" | "checkpointConversation" | "submitText"
    | "requestEnd" | "resolveEnd" | "setSubject" | "retrySummary" | "stopSpeech" | "interrupt" | "editRecord">;
  brain: BrainPort;
  mode: "live" | "fixture";
  voice(action: VoiceAction): Promise<void>;
  nativeSnapshot(): VoiceStatus;
  processing(): Processing;
  text(): Partial<Record<HostTextKey, string>>;
  /** Applied to each notice after the bridge's own wording; undefined leaves the notice out. */
  rewriteNotice?(message: string): string | undefined;
  /** Opens a checked http(s) link. Defaults to window.open. */
  open?(url: string): void;
}

const SCREEN_NOTICE = "Reading your screen. This can take up to a minute.";
const WORKSHEET_NOTICE = "Moo is reading the sample worksheet (this web demo can't see your screen).";
/** Longer typed text keeps the live organizer past its time limit, which cuts the note's summary short and holds back
 * later notes. The renderer shows this message as it is (apps/desktop/src/feedback.ts). */
const TYPED_LIMIT = 2000;
const TOO_LONG = `Too long for this demo: send up to ${TYPED_LIMIT.toLocaleString("en-US")} characters at a time.`;

/** The user turns in each saved thought Moo offered help with: the Agent marks one `offered:<record id>` once it asks.
 * It also marks a thought whose clarifying question was declined, so `clarified` names the ones to skip. */
async function offeredTurns(brain: BrainPort, records: readonly BrainRecord[], clarified: ReadonlySet<string>) {
  const turns = new Set<string>();
  for (const record of records)
    if (!clarified.has(record.id) && await brain.getState(`offered:${record.id}`))
      for (const segment of record.segments) if (segment.speaker === "user") turns.add(segment.turnId);
  return turns;
}

export function createBridge(options: BridgeOptions): { api: MoolaiApi; emit: Emit } {
  const { agent, brain } = options;
  const listeners = new Set<(event: AgentEvent) => void>();
  let sequence = 0;
  // Each listener gets its own JSON copy, as each event stream did. One that throws reaches neither the others nor the Agent.
  const deliver = (listener: (event: AgentEvent) => void, data: string) => {
    try { listener(JSON.parse(data)); } catch (error) { console.error("Moolai event listener failed:", error); }
  };
  // Thoughts Moo only asked "Would you like Moo to answer that?" about, seen while the question is pending.
  const clarified = new Set<string>();
  const watchOffer = (state = agent.getState()) => {
    const offer = state.pendingOffer;
    if (offer?.kind === "clarification") clarified.add(offer.recordId);
    // A thought that then gets a real help offer keeps its chip.
    else if (offer?.kind === "help" || offer?.kind === "general_help") clarified.delete(offer.recordId);
  };
  const emit: Emit = (event) => {
    watchOffer();
    if (event.type === "notice" && typeof event.message === "string") {
      const own = event.message === SCREEN_NOTICE ? WORKSHEET_NOTICE : event.message;
      const message = options.rewriteNotice ? options.rewriteNotice(own) : own;
      if (message === undefined) return;
      event = { ...event, message };
    }
    sequence++;
    const data = JSON.stringify({ ...event, sequence });
    for (const listener of listeners) deliver(listener, data);
  };

  async function read(path: string): Promise<unknown> {
    if (path === "/api/state") {
      // Captured before any await: events emitted while the rest is read carry later sequences, so the renderer replays them.
      const snapshotSequence = sequence;
      const state = agent.getState();
      watchOffer(state);
      const native = options.nativeSnapshot();
      const records = await brain.listRecords();
      const snapshot: Snapshot = {
        sequence: snapshotSequence,
        state,
        liveThought: await agent.liveThoughtPreview(),
        thoughtProcessing: await brain.getState<{status?: string; error?: string; spans: unknown[]; continuationRequired?: boolean; activeId?: string; draftId?: string}>(`thought-buffer:${agent.getState().sessionId}`)
          .then(value => value ? {status: value.status ?? "collecting", error: value.error, pending: !!value.spans.length,
            continuationRequired: value.continuationRequired === true, recordId: value.activeId ?? value.draftId} : undefined),
        records,
        mode: options.mode,
        processing: options.processing(),
        localFolders: [],
        localFoldersAvailable: false,
        native: { ...native },
        intents: intentsFromTrace(await brain.getState("interaction-trace"), await offeredTurns(brain, records, clarified)),
      };
      return snapshot;
    }
    const resource = /^\/api\/(related|attachment)\/([^/]+)$/.exec(path);
    if (resource) {
      const id = decodeURIComponent(resource[2]!);
      if (resource[1] === "related") return brain.related(id);
      const attachment = await brain.getAttachment(id);
      if (!attachment) throw new Error("Attachment unavailable");
      return { mimeType: attachment.mimeType, base64: base64(attachment.bytes) };
    }
    return path === "/api/native" ? options.nativeSnapshot() : [];
  }

  async function act(path: string, body: any): Promise<unknown> {
    switch (path) {
      case "/api/session":
        if (body.action === "start") await agent.startSession();
        else if (body.action === "stop") {
          await options.voice("stop");
          await agent.stopSession();
        } else throw new Error("Invalid session action");
        break;
      case "/api/input":
        if (typeof body.text !== "string") throw new Error("Invalid text");
        if (body.text.length > TYPED_LIMIT) throw new Error(TOO_LONG);
        await agent.submitText(body.text);
        break;
      case "/api/end":
        await agent.requestEnd();
        break;
      case "/api/end/resolve":
        if (!["finish", "cancel", "continue"].includes(body.action)) throw new Error("Invalid end action");
        await agent.resolveEnd(body.action);
        break;
      case "/api/subject":
        if (typeof body.subject !== "string" || body.subject.length > 200) throw new Error("Invalid subject");
        await agent.setSubject(body.subject);
        break;
      case "/api/retry":
        if (body.scope !== "summary" || typeof body.recordId !== "string" || !body.recordId.trim() || body.recordId.length > 512)
          throw new Error("Choose one saved note to retry its summary");
        await agent.retrySummary(body.recordId);
        break;
      case "/api/speech/stop":
        await agent.stopSpeech();
        break;
      case "/api/response/cancel":
        await agent.interrupt();
        break;
      case "/api/voice":
        if (body.action !== "start" && body.action !== "stop" && body.action !== "flush") throw new Error("Invalid voice action");
        await options.voice(body.action);
        // Only the microphone button's stop checkpoints; the host's own stops (auto-off, page close) never do.
        if (body.action === "stop") await agent.checkpointConversation();
        break;
      case "/api/local-folders/revoke":
        throw new Error("Local files are unavailable");
      default: {
        const match = /^\/api\/record\/([^/]+)$/.exec(path);
        if (!match) throw new Error("Not found");
        const id = decodeURIComponent(match[1]!);
        if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error("Invalid revision");
        validateEdit(body.patch);
        if (Object.keys(body.patch).some(key => !["title", "summary", "links"].includes(key)))
          throw new Error("Only title, summary and connection removal are available in this view");
        if (body.patch.links) await validateConnectionRemoval(brain, id, body.patch.links);
        return agent.editRecord(id, body.revision, body.patch as RecordPatch);
      }
    }
    return { ok: true, state: agent.getState() };
  }

  const api: MoolaiApi = {
    async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      if (!allowedRequest(method, path)) throw new Error("Not found");
      const value = method === "GET" ? await read(path) : await act(path, readBody(body));
      // The renderer gets JSON, as over HTTP: never a live Agent, Brain or host object.
      return JSON.parse(JSON.stringify(value ?? null)) as T;
    },
    subscribe(callback) {
      const listener = (event: AgentEvent) => callback(event);
      listeners.add(listener);
      deliver(listener, JSON.stringify({ type: "state", state: agent.getState(), sequence }));
      return () => { listeners.delete(listener); };
    },
    async chooseFolder() {
      throw new Error("Local folders are unavailable in the web demo");
    },
    async openExternal(value) {
      const url = externalURL(value);
      if (!url) throw new Error("Only public HTTP or HTTPS links can be opened");
      // Before any await, inside the click: a popup blocker allows a new tab only there.
      if (options.open) options.open(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    },
    get text() { return options.text(); },
  };
  return { api, emit };
}

/** apps/desktop/local-content.cjs allowedRequest: what the desktop renderer may ask of its runtime. */
function allowedRequest(method: string, path: string) {
  if (typeof path !== "string") return false;
  if (method === "GET")
    return ["/api/state", "/api/native", "/api/local-folders"].includes(path) || /^\/api\/(related|attachment)\/[a-zA-Z0-9._-]+$/.test(path);
  return method === "POST" && ([
    "/api/session", "/api/input", "/api/end", "/api/end/resolve",
    "/api/subject", "/api/retry", "/api/speech/stop", "/api/response/cancel", "/api/voice",
    "/api/local-folders/revoke",
  ].includes(path) || /^\/api\/record\/[a-zA-Z0-9_-]+$/.test(path));
}

/** What server.ts readJson made of Electron's JSON.stringify(body || {}). */
function readBody(body: unknown): any {
  const text = JSON.stringify(body || {});
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("Request too large");
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

/** apps/desktop/local-content.cjs externalURL: http(s) links only, without credentials or control characters. */
function externalURL(value: unknown) {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** btoa takes a binary string; building it in chunks keeps a large attachment under the engine's argument limit. */
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** Desktop may dismiss associations, never add links or rewrite source provenance. */
async function validateConnectionRemoval(brain: BrainPort, id: string, links: NonNullable<RecordPatch["links"]>) {
  const record = await brain.getRecord(id);
  if (!record) throw new Error("Record not found");
  if (links.length !== record.links.length) throw new Error("Keep removed connections as dismissed");
  for (const [index, link] of links.entries()) {
    const previous = record.links[index]!;
    const association = ["suggested", "manual"].includes(previous.provenance);
    const unchanged = same(link, previous);
    const dismissed = association && link.decision === "dismissed" &&
      same({ ...link, decision: previous.decision }, { ...previous, decision: previous.decision });
    if (!unchanged && !dismissed) throw new Error("Only existing associations can be dismissed");
  }
}

/** node:util isDeepStrictEqual for JSON data, as the renderer sent and received it: key order and undefined members don't count. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const defined = (value: object) => Object.entries(value).filter(([, item]) => item !== undefined);
  const left = defined(a), right = new Map(defined(b));
  return left.length === right.size && left.every(([key, item]) => right.has(key) && same(item, right.get(key)));
}
