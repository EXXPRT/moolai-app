import http from "node:http";
import { VoiceOwner } from "./voice-owner.js";
import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Agent } from "../../../packages/agent/src/index.js";
import type {
  AgentEvent,
  BrainPort,
  LocalFilesPort,
  RecordPatch,
} from "../../../packages/contracts/src/index.js";
import { validateEdit } from "../../../packages/contracts/src/workspace.js";
import type { ProcessingAvailability } from "../../../packages/agent-host/src/providers.js";

export function createRuntimeServer(options: {
  agent: Agent;
  brain: BrainPort;
  localFiles?: LocalFilesPort;
  token: string;
  mode: string;
  processingStatus?: () => ProcessingAvailability;
  voice: (action: "start" | "stop" | "flush") => Promise<unknown>;
  nativeHealth: () => Promise<unknown>;
  nativeSnapshot?: () => Record<string, unknown>;
  ownerLost?: () => Promise<void>;
  heartbeatMs?: number;
}) {
  const listeners = new Set<http.ServerResponse>();
  let sequence = 0;
  const emit = (event: AgentEvent) => {
    sequence++;
    for (const stream of listeners)
      stream.write(`data: ${JSON.stringify({...event, sequence})}\n\n`);
  };
  // Electron's fetch ends a stream idle for 300 s; a comment frame keeps it open without making an event.
  const heartbeat = setInterval(() => {
    for (const stream of listeners) stream.write(": ping\n\n");
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();
  const voiceOwner = new VoiceOwner(async()=>{
    try { if(options.ownerLost) await options.ownerLost(); else await options.voice("stop"); }
    catch(error) { emit({type:"notice",message:`App closed; microphone shutdown failed: ${String(error)}`}); }
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${options.token}`;
    const valid =
      Buffer.byteLength(header) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    if (!valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Runtime authentication required" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ type: "state", state: options.agent.getState(), sequence })}\n\n`,
        );
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const snapshotSequence = sequence;
        const state = options.agent.getState();
        const native = options.nativeSnapshot?.() ?? {listening:false,speaking:false};
        json(res, {
          sequence: snapshotSequence,
          state,
          liveThought: await options.agent.liveThoughtPreview(),
          thoughtProcessing: await options.brain.getState<{status?:string;error?:string;spans:unknown[];continuationRequired?:boolean;activeId?:string;draftId?:string}>(`thought-buffer:${options.agent.getState().sessionId}`)
            .then(value=>value?{status:value.status??"collecting",error:value.error,pending:!!value.spans.length,continuationRequired:value.continuationRequired===true,recordId:value.activeId??value.draftId}:undefined),
          records: await options.brain.listRecords(),
          mode: options.mode,
          processing: options.processingStatus?.() ?? {
            status: options.mode === "fixture" ? "available" : "checking",
          },
          localFolders: (await options.localFiles?.roots()) ?? [],
          localFoldersAvailable: !!options.localFiles,
          native,
        });
        return;
      }
      const resource = /^\/api\/(related|attachment)\/([^/]+)$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && resource) {
        const id = decodeURIComponent(resource[2]!);
        if (resource[1] === "related")
          json(res, await options.brain.related(id));
        else {
          const attachment = await options.brain.getAttachment(id);
          if (!attachment) throw new Error("Attachment unavailable");
          json(res, {
            mimeType: attachment.mimeType,
            base64: Buffer.from(attachment.bytes).toString("base64"),
          });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/native") {
        json(res, await options.nativeHealth());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/local-folders") {
        json(res, (await options.localFiles?.roots()) ?? []);
        return;
      }
      if (req.method !== "POST") {
        json(res, { error: "Not found" }, 404);
        return;
      }
      const body = await readJson(req);
      switch (url.pathname) {
        case "/api/session":
          if (body.action === "start") await options.agent.startSession();
          else if (body.action === "stop") {
            await options.voice("stop");
            await options.agent.stopSession();
          } else throw new Error("Invalid session action");
          break;
        case "/api/input":
          if (typeof body.text !== "string" || body.text.length > 60000)
            throw new Error("Invalid text");
          await options.agent.submitText(body.text);
          break;
        case "/api/end":
          await options.agent.requestEnd();
          break;
        case "/api/end/resolve":
          if (!["finish", "cancel", "continue"].includes(body.action))
            throw new Error("Invalid end action");
          await options.agent.resolveEnd(body.action);
          break;
        case "/api/subject":
          if (typeof body.subject !== "string" || body.subject.length > 200)
            throw new Error("Invalid subject");
          await options.agent.setSubject(body.subject);
          break;
        case "/api/retry":
          if (
            body.scope !== "summary" ||
            typeof body.recordId !== "string" ||
              !body.recordId.trim() ||
              body.recordId.length > 512
          )
            throw new Error("Choose one saved note to retry its summary");
          await options.agent.retrySummary(body.recordId);
          break;
        case "/api/speech/stop":
          await options.agent.stopSpeech();
          break;
        case "/api/response/cancel":
          await options.agent.interrupt();
          break;
        case "/api/voice": {
          if (
            body.action !== "start" &&
            body.action !== "stop" &&
            body.action !== "flush"
          )
            throw new Error("Invalid voice action");
          const ownerToken=body.action === "start" && body.ownerPid !== undefined
            ? voiceOwner.claim(body.ownerPid) : voiceOwner.token;
          // A failed shutdown keeps supervision; an older stop cannot clear
          // ownership acquired by a later start while the stop was draining.
          await options.voice(body.action);
          if(body.action === "stop") voiceOwner.clear(ownerToken);
          // Only explicit capture-stop checkpoints. Native pauses during speech
          // never pass through this route and must not finalize a conversation.
          if (body.action === "stop")
            await options.agent.checkpointConversation();
          break;
        }
        case "/api/local-folders/grant":
          // Electron keeps this endpoint out of its renderer request allowlist.
          // The host calls it only with a path returned by its native picker.
          if (!options.localFiles)
            throw new Error("Local files are unavailable");
          if (
            typeof body.path !== "string" ||
            !body.path.trim() ||
            body.path.length > 4096
          )
            throw new Error("Invalid folder path");
          json(res, await options.localFiles.grant(body.path));
          return;
        case "/api/local-folders/revoke":
          if (!options.localFiles)
            throw new Error("Local files are unavailable");
          if (
            typeof body.id !== "string" ||
            !body.id.trim() ||
            body.id.length > 512
          )
            throw new Error("Invalid folder ID");
          await options.localFiles.revoke(body.id);
          break;
        default: {
          const match = /^\/api\/record\/([^/]+)$/.exec(url.pathname);
          if (!match) {
            json(res, { error: "Not found" }, 404);
            return;
          }
          if (!Number.isSafeInteger(body.revision) || body.revision < 0)
            throw new Error("Invalid revision");
          validateEdit(body.patch);
          if (Object.keys(body.patch).some(key => !["title", "summary", "links"].includes(key)))
            throw new Error("Only title, summary and connection removal are available in this view");
          if (body.patch.links) await validateConnectionRemoval(
            options.brain, decodeURIComponent(match[1]!), body.patch.links,
          );
          json(
            res,
            await options.agent.editRecord(
              decodeURIComponent(match[1]!),
              body.revision,
              body.patch as RecordPatch,
            ),
          );
          return;
        }
      }
      json(res, { ok: true, state: options.agent.getState() });
    } catch (e) {
      json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    voiceOwner.clear();
    for (const stream of listeners) stream.end();
    listeners.clear();
  });
  return { server, emit };
}
function json(res: http.ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
async function readJson(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw new Error("Request too large");
    parts.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(parts).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value;
}

/** Desktop may dismiss associations, never add links or rewrite source provenance. */
async function validateConnectionRemoval(brain: BrainPort, id: string, links: NonNullable<RecordPatch["links"]>) {
  const record = await brain.getRecord(id);
  if (!record) throw new Error("Record not found");
  if (links.length !== record.links.length) throw new Error("Keep removed connections as dismissed");
  for (const [index, link] of links.entries()) {
    const previous = record.links[index]!;
    const association = ["suggested", "manual"].includes(previous.provenance);
    const unchanged = isDeepStrictEqual(link, previous);
    const dismissed = association && link.decision === "dismissed" &&
      isDeepStrictEqual({ ...link, decision: previous.decision }, { ...previous, decision: previous.decision });
    if (!unchanged && !dismissed) throw new Error("Only existing associations can be dismissed");
  }
}
