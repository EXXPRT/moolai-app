import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { AgentReply, ChatMessage } from "../../../packages/contracts/src/index.js";
import type { ResponseRunner } from "../../../packages/agent/src/response-runner.js";
import { assertReply, assertTools, prepareFrame, textContent, type Trace } from "./common.js";

const BOOTSTRAP = "Moolai experiment: process the pending request through the supplied transport.";
const disabled = ["deepseek-llm-api-extensions", "session-log-deepseek", "plugin-package-inventory-deepseek", "llm-deepseek",
  "sandbox", "sandbox-policy", "subprocess", "pty", "terminal-bash", "terminal-pwsh", "persistent-bash", "persistent-pwsh",
  "llm-retry", "jobs", "session-title"];

export function fromDshMessages(messages: any[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    // The initial Moolai transcript is already owned by the parent. DSH's empty
    // persona and one bootstrap receipt are runtime scaffolding, not user input.
    if (message.role === "system") continue;
    if (message.role === "user" && textContent(message.content) === BOOTSTRAP) continue;
    const blocks = message.content ?? [];
    const results = blocks.filter((b: any) => b.type === "tool-result");
    if (results.length) {
      for (const block of results) result.push({ role: "tool", toolCallId: block.toolCallId, content: textContent(block.content) });
    } else if (message.role === "assistant") {
      result.push({ role: "assistant", content: textContent(blocks), toolCalls: blocks.filter((b: any) => b.type === "tool-call")
        .map((b: any) => ({ id: b.id, name: b.name, arguments: JSON.parse(b.arguments) })) });
    } else if (textContent(blocks)) result.push({ role: message.role, content: textContent(blocks) });
  }
  return result;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > 256_000) throw new Error("Experiment bridge payload too large");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The supported SDK subprocess owns DSH's real loop and tool registry. */
export function createDeepSeekRunner(onTrace: Trace = () => {}): ResponseRunner {
  return { name: "deepseek-harness@0.1.5-rc.2", async run(input) {
    const first = await prepareFrame(input, input.messages, 0);
    assertTools(first.tools);
    const dir = await mkdtemp(path.join(tmpdir(), "moolai-dsh-"));
    const home = path.join(dir, "home"); const workspace = path.join(dir, "workspace");
    const token = randomBytes(32).toString("hex");
    let steps = 0, lastReply: AgentReply | undefined, failure: unknown, sdkFrames = 0;
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      try {
        if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(403).end(JSON.stringify({ error: "Forbidden" })); return;
        }
        input.signal.throwIfAborted();
        const data = await readJson(req);
        let result: unknown;
        if (req.url === "/setup") result = { tools: first.tools, maxSteps: input.maxSteps };
        else if (req.url === "/execute") {
          if (!first.tools.some(t => t.name === data.name)) throw new Error("Tool outside experiment allowlist");
          result = await input.execute(data);
        } else if (req.url === "/generate") {
          if (data.step !== steps) throw new Error("Duplicate or unordered SDK generation");
          assertTools(data.tools);
          if (data.tools.length !== first.tools.length) throw new Error("DSH loaded an unexpected tool roster");
          const messages = [...input.messages, ...fromDshMessages(data.messages)];
          if (steps) await input.checkpoint(messages);
          const frame = steps === 0 ? first : await prepareFrame(input, messages, steps);
          const step = steps++;
          sdkFrames++;
          onTrace({ harness: "deepseek", type: "model_request", step, sdkMessages: data.messages, sdkTools: data.tools });
          const reply = await input.generate(frame, step);
          assertReply(reply, frame);
          lastReply = reply;
          result = { reply, responseMode: frame.responseMode };
        } else { res.writeHead(404).end(JSON.stringify({ error: "Unknown bridge route" })); return; }
        res.end(JSON.stringify(result));
      } catch (error) {
        // Tool failures remain tool outcomes for the SDK to recover from.
        // Provider/transport failures terminate the case without a retry.
        if (req.url !== "/execute") failure ??= error;
        res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    let harness: DeepSeekHarness | undefined;
    const abort = () => { void harness?.close().catch(() => {}); };
    try {
      await mkdir(home); await mkdir(workspace);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback server address");
      const plugin = fileURLToPath(new URL("./dsh-plugin.mjs", import.meta.url));
      const patch = path.join(dir, "notes-only.patch.yml");
      await writeFile(patch, [
        ...disabled.map(id => `- id: ${id}\n  disabled: true`),
        "- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: ''",
        `- insert:\n    - id: moolai-experiment\n      name: ${JSON.stringify(plugin)}`,
      ].join("\n") + "\n");
      harness = new DeepSeekHarness({ profile: "sdk-minimal", patches: [patch], dshHome: home, cwd: workspace,
        processCwd: workspace, provider: "moolai", model: "metered", maxTokens: 4000, initializeTimeoutMs: 20000,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir, MOOLAI_HARNESS_BRIDGE: `http://127.0.0.1:${address.port}`,
          MOOLAI_HARNESS_TOKEN: token, MOOLAI_HARNESS_SETUP: JSON.stringify({ tools: first.tools, maxSteps: input.maxSteps }),
          NODE_ENV: "test", NO_COLOR: "1" },
      });
      input.signal.addEventListener("abort", abort, { once: true });
      const result = await harness.run(BOOTSTRAP, { onNotification: notification => {
        onTrace({ harness: "deepseek", type: notification.method, notification });
      } });
      if (failure) throw failure;
      input.signal.throwIfAborted();
      if (!sdkFrames) throw new Error("DSH produced no model requests");
      onTrace({ harness: "deepseek", type: "completed", sdkEvents: result.events, steps });
      return lastReply && !lastReply.toolCalls.length ? { reply: lastReply, steps, stopReason: "answered" } : { steps, stopReason: "limit" };
    } finally {
      input.signal.removeEventListener("abort", abort);
      try { await harness?.close(); }
      finally {
        try {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        } finally { await rm(dir, { recursive: true, force: true }); }
      }
    }
  } };
}

/** Keep the SDK trace beside the orchestrator's case artifacts, separate from ephemeral runtime files. */
export function createDshRunner(options: { directory: string; onTrace?: Trace }): ResponseRunner {
  return { name: "deepseek-harness@0.1.5-rc.2", async run(input) {
    const trace: unknown[] = [];
    try {
      return await createDeepSeekRunner(event => { trace.push(structuredClone(event)); options.onTrace?.(event); }).run(input);
    } finally {
      await mkdir(options.directory, { recursive: true });
      await writeFile(path.join(options.directory, `deepseek-trace-${randomBytes(8).toString("hex")}.json`), JSON.stringify(trace, null, 2));
    }
  } };
}
