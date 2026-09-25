import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentReply, ChatMessage, ToolCall } from "../../packages/contracts/src/index.js";
import type { ResponseRunner } from "../../packages/agent/src/response-runner.js";
import { assertReply, assertTools, prepareFrame } from "../harness-comparison/src/common.js";

function toSdk(messages: ChatMessage[]): unknown[] {
  return messages.map(m => ({ role: m.role, content: m.content,
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) }));
}
function fromSdk(messages: any[]): ChatMessage[] {
  return messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : "",
    ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
    ...(m.tool_calls?.length ? { toolCalls: m.tool_calls.map((c: any) => ({ id: c.id, name: c.function.name,
      arguments: typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments) : c.function.arguments })) } : {}) }));
}

export function createNanobotRunner(): ResponseRunner {
  return { name: "nanobot-0.3.5", async run(input) {
    input.signal.throwIfAborted();
    const first = await prepareFrame(input, input.messages, 0);
    assertTools(first.tools);
    const child = spawn(fileURLToPath(new URL("../../.data/nanobot-eval-venv/bin/python", import.meta.url)),
      [fileURLToPath(new URL("./nanobot-worker.py", import.meta.url))], {
        cwd: fileURLToPath(new URL("./", import.meta.url)), stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
      });
    let steps = 0, bytes = 0, stderr = "", last: AgentReply | undefined;
    const pending = new Map<string, ToolCall>();
    const lines = createInterface({ input: child.stdout });
    const abort = () => child.kill("SIGTERM");
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, input.maxSteps * 120_000);
    child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-2000); });
    child.stdout.on("data", b => { bytes += b.length; if (bytes > 2_000_000) abort(); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    child.stdin.write(JSON.stringify({ messages: toSdk(input.messages), tools: first.tools, maxSteps: input.maxSteps }) + "\n");
    try {
      for await (const line of lines) {
        input.signal.throwIfAborted();
        const event = JSON.parse(line);
        if (event.kind === "failed" || (event.kind === "done" && event.error)) throw new Error(event.error);
        if (event.kind === "done") {
          await input.checkpoint(fromSdk(event.messages));
          if (!last?.text.trim() || last.toolCalls.length) throw new Error("Nanobot ended without a supported final response");
          child.stdin.end();
          return { reply: last, steps, stopReason: "answered" };
        }
        let result: unknown;
        try {
          if (event.kind === "generate") {
            if (pending.size) throw new Error("Nanobot generated before resolving its tools");
            const history = fromSdk(event.messages);
            await input.checkpoint(history);
            const frame = steps === 0 ? first : await prepareFrame(input, history, steps);
            last = await input.generate(frame, steps++);
            assertReply(last, frame);
            if (!last.text.trim() && !last.toolCalls.length) throw new Error("Empty model response; no automatic retry");
            for (const call of last.toolCalls) {
              if (pending.has(call.id) || !frame.tools.some(t => t.name === call.name)) throw new Error("Unavailable or duplicate tool proposal");
              pending.set(call.id, call);
            }
            result = last;
          } else if (event.kind === "execute") {
            const call = [...pending.values()].find(c => c.name === event.name && JSON.stringify(c.arguments) === JSON.stringify(event.arguments));
            if (!call) throw new Error("Unproposed Nanobot tool call");
            pending.delete(call.id);
            result = await input.execute(call);
          } else throw new Error("Unknown Nanobot RPC");
          child.stdin.write(JSON.stringify({ id: event.id, result }) + "\n");
        } catch (error) {
          // Stop here instead of allowing SDK retries, empty recovery or auxiliary generation.
          throw error;
        }
      }
      const code = await exited;
      input.signal.throwIfAborted();
      throw new Error(`Nanobot worker ended ${code}: ${stderr}`);
    } finally {
      clearTimeout(timeout); input.signal.removeEventListener("abort", abort);
      lines.close(); child.stdin.destroy(); child.kill("SIGTERM");
      await exited.catch(() => {});
    }
  } };
}
