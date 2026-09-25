import type { AgentReply, ChatMessage, ToolCall, ToolDefinition } from "../../contracts/src/index.js";

/** A loop boundary, not another conversation controller. All capabilities remain injected. */
export interface ResponseFrame {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  responseMode: "auto" | "answer_only";
}
export interface ResponseRun {
  messages: ChatMessage[];
  signal: AbortSignal;
  maxSteps: number;
  /** Refresh evidence and enforce the shared policy immediately before each generation. */
  prepare(messages: ChatMessage[], step: number): Promise<ResponseFrame>;
  /** Sole model transport; owns the hard request counter and provider options. */
  generate(frame: ResponseFrame, step: number): Promise<AgentReply>;
  /** Validates and executes one permitted tool, recording its outcome. */
  execute(call: ToolCall): Promise<unknown>;
  checkpoint(messages: ChatMessage[]): Promise<void>;
}
export interface ResponseRunResult {
  reply?: AgentReply;
  steps: number;
  stopReason: "answered" | "limit";
}
export interface ResponseRunner {
  name: string;
  run(input: ResponseRun): Promise<ResponseRunResult>;
}

export const nativeResponseRunner: ResponseRunner = {
  name: "moolai",
  async run(input) {
    const messages = structuredClone(input.messages);
    for (let step = 0; step < input.maxSteps; step++) {
      input.signal.throwIfAborted();
      const frame = await input.prepare(messages, step);
      const reply = await input.generate(frame, step);
      if (!reply.toolCalls.length) return { reply, steps: step + 1, stopReason: "answered" };
      messages.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        input.signal.throwIfAborted();
        const result = await input.execute(call);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
      await input.checkpoint(messages);
    }
    return { steps: input.maxSteps, stopReason: "limit" };
  },
};
