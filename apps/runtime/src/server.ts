import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Agent } from "../../../packages/agent/src/index.js";
import type {
  AgentEvent,
  BrainPort,
  LocalFilesPort,
  RecordPatch,
} from "../../../packages/contracts/src/index.js";
import { formatMarkdown } from "../../../packages/contracts/src/markdown.js";

export function createRuntimeServer(options: {
  agent: Agent;
  brain: BrainPort;
  localFiles?: LocalFilesPort;
  token: string;
  mode: string;
  voice: (action: "start" | "stop" | "flush") => Promise<unknown>;
  nativeHealth: () => Promise<unknown>;
  nativeSnapshot?: () => Record<string, unknown>;
}) {
  const listeners = new Set<http.ServerResponse>();
  const emit = (event: AgentEvent) => {
    for (const stream of listeners)
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
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
          `data: ${JSON.stringify({ type: "state", state: options.agent.getState() })}\n\n`,
        );
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(res, {
          state: options.agent.getState(),
          records: await options.brain.listRecords(),
          mode: options.mode,
          localFolders: await options.localFiles?.roots() ?? [],
          native: options.nativeSnapshot?.() ?? {
            listening: false,
            speaking: false,
          },
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/native") {
        json(res, await options.nativeHealth());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/local-folders") {
        json(res, await options.localFiles?.roots() ?? []);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/export/")) {
        const record = await options.brain.getRecord(
          decodeURIComponent(url.pathname.slice("/api/export/".length)),
        );
        if (!record) throw new Error("Record not found");
        res.writeHead(200, { "Content-Type": "text/markdown;charset=utf-8" });
        res.end(formatMarkdown(record));
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
            body.recordId !== undefined &&
            (typeof body.recordId !== "string" ||
              !body.recordId.trim() ||
              body.recordId.length > 512)
          )
            throw new Error("Invalid record ID");
          await options.agent.retryPending(
            typeof body.recordId === "string" ? body.recordId : undefined,
          );
          break;
        case "/api/speech/stop":
          await options.agent.stopSpeech();
          break;
        case "/api/voice":
          if (
            body.action !== "start" &&
            body.action !== "stop" &&
            body.action !== "flush"
          )
            throw new Error("Invalid voice action");
          await options.voice(body.action);
          // Only explicit capture-stop checkpoints. Native pauses during speech
          // never pass through this route and must not finalize a conversation.
          if (body.action === "stop")
            await options.agent.checkpointConversation();
          break;
        case "/api/local-folders/grant":
          // Electron keeps this endpoint out of its renderer request allowlist.
          // The host calls it only with a path returned by its native picker.
          if (!options.localFiles) throw new Error("Local files are unavailable");
          if (typeof body.path !== "string" || !body.path.trim() || body.path.length > 4096)
            throw new Error("Invalid folder path");
          json(res, await options.localFiles.grant(body.path));
          return;
        case "/api/local-folders/revoke":
          if (!options.localFiles) throw new Error("Local files are unavailable");
          if (typeof body.id !== "string" || !body.id.trim() || body.id.length > 512)
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
          validatePatch(body.patch);
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
    if (size > 1024 * 1024) throw new Error("Request too large");
    parts.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(parts).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value;
}

function validatePatch(patch: unknown): asserts patch is RecordPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Invalid patch");
  const values = Object.entries(patch);
  if (!values.length) throw new Error("Empty patch");
  for (const [key, value] of values) {
    if (key === "title" || key === "summary") {
      if (
        typeof value !== "string" ||
        value.length > (key === "title" ? 1000 : 60000)
      )
        throw new Error(`Invalid ${key}`);
    } else if (key === "purpose") {
      if (
        !["Question", "Reference", "Idea", "Action"].includes(value as string)
      )
        throw new Error("Invalid purpose");
    } else if (key === "topics") {
      if (
        !Array.isArray(value) ||
        value.length > 30 ||
        !value.every(
          (topic) =>
            typeof topic === "string" && topic.trim() && topic.length <= 200,
        )
      )
        throw new Error("Invalid topics");
    } else
      throw new Error("Only title, summary, purpose and topics are editable");
  }
}
