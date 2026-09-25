import { agentLoopContinue, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import type { AgentReply, ChatMessage, ToolDefinition } from "../../../packages/contracts/src/index.js";
import type { ResponseRunner } from "../../../packages/agent/src/response-runner.js";
import { assertReply, assertTools, prepareFrame, textContent, type Trace } from "./common.js";

const model: Model<"openai-completions"> = {
  id: "moolai-metered-transport", name: "Moolai metered transport", provider: "moolai", api: "openai-completions",
  baseUrl: "http://unused.invalid", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(reply: AgentReply): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: structuredClone(usage), timestamp: Date.now(),
    stopReason: reply.toolCalls.length ? "toolUse" : "stop", content: [
      ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
      ...reply.toolCalls.map(c => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: JSON.parse(JSON.stringify(c.arguments)) })),
    ] };
}

export function toPiMessages(messages: ChatMessage[]): AgentMessage[] {
  const names = new Map(messages.flatMap(m => (m.toolCalls ?? []).map(c => [c.id, c.name] as const)));
  return messages.map(m => {
    if (m.role === "assistant") return assistant({ text: m.content, toolCalls: m.toolCalls ?? [] });
    if (m.role === "tool") return { role: "toolResult", toolCallId: m.toolCallId!, toolName: names.get(m.toolCallId!) ?? "unknown",
      content: [{ type: "text", text: m.content }], isError: false, timestamp: Date.now() };
    return { role: m.role, content: m.content, timestamp: Date.now() };
  });
}

export function fromPiMessages(messages: AgentMessage[]): ChatMessage[] {
  return messages.map((m: any) => {
    if (m.role === "toolResult") return { role: "tool" as const, toolCallId: m.toolCallId, content: textContent(m.content) };
    const message: ChatMessage = { role: m.role, content: textContent(m.content) };
    if (m.role === "system" && m.sections) message.content += Object.values(m.sections).filter(Boolean).join("\n");
    if (m.role === "assistant") message.toolCalls = m.content.filter((c: any) => c.type === "toolCall")
      .map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments }));
    return message;
  }).filter(message => message.role !== "system" || message.content.length > 0);
}

/** Pi owns the continuation and tool-execution loop; only its transport is injected. */
export function createPiRunner(onTrace: Trace = () => {}): ResponseRunner {
  return { name: "pi@0.86.1", async run(input) {
    let steps = 0, lastReply: AgentReply | undefined, failure: unknown, currentMode = "auto";
    const first = await prepareFrame(input, input.messages, 0);
    assertTools(first.tools);
    const tools: AgentTool<any>[] = first.tools.map((t: ToolDefinition) => ({ ...t, label: t.name, parameters: t.parameters as any,
      executionMode: "sequential", execute: async (id: string, args: unknown) => {
        input.signal.throwIfAborted();
        if (currentMode !== "auto") throw new Error("Tool execution forbidden in answer_only");
        const result = await input.execute({ id, name: t.name, arguments: args as Record<string, unknown> });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: JSON.parse(JSON.stringify(result)) };
      } }));
    const loop = agentLoopContinue({ messages: toPiMessages(input.messages), tools }, {
      model, toolExecution: "sequential", convertToLlm: messages => messages as Message[],
      shouldStopAfterTurn: async ({ context }) => {
        try { await input.checkpoint(fromPiMessages(context.messages)); }
        catch (error) { failure = error; return true; }
        return steps >= input.maxSteps;
      },
    }, input.signal, (_model, context) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const step = steps;
          const frame = step === 0 ? first : await prepareFrame(input, fromPiMessages(context.messages), step);
          currentMode = frame.responseMode;
          steps++;
          const reply = await input.generate(frame, step);
          assertReply(reply, frame);
          lastReply = reply;
          const completed = assistant(reply);
          stream.push({ type: "start", partial: completed });
          stream.push({ type: "done", reason: completed.stopReason as "stop" | "toolUse", message: completed });
          stream.end(completed);
        } catch (error) {
          failure = error;
          const message = assistant({ text: "", toolCalls: [] });
          message.stopReason = input.signal.aborted ? "aborted" : "error";
          message.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
          stream.end(message);
        }
      })();
      return stream;
    });
    for await (const event of loop) {
      onTrace({ harness: "pi", type: event.type, event: structuredClone(event) });
    }
    await loop.result();
    if (failure) throw failure;
    input.signal.throwIfAborted();
    return lastReply && !lastReply.toolCalls.length ? { reply: lastReply, steps, stopReason: "answered" } : { steps, stopReason: "limit" };
  } };
}
