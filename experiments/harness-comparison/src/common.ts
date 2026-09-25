import type { AgentReply, ChatMessage, ToolDefinition } from "../../../packages/contracts/src/index.js";
import type { ResponseFrame, ResponseRun } from "../../../packages/agent/src/response-runner.js";

export const NOTES_TOOLS = new Set(["search_notes", "read_note"]);
export type Trace = (event: { harness: string; type: string; [key: string]: unknown }) => void;

export function assertTools(tools: ToolDefinition[]): void {
  for (const tool of tools) if (!NOTES_TOOLS.has(tool.name)) throw new Error(`External harness disallows tool: ${tool.name}`);
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error("Duplicate tool definition");
}

export async function prepareFrame(input: ResponseRun, messages: ChatMessage[], step: number): Promise<ResponseFrame> {
  input.signal.throwIfAborted();
  if (step >= input.maxSteps) throw new Error("External harness generation limit reached");
  const frame = await input.prepare(structuredClone(messages), step);
  assertTools(frame.tools);
  if (step === input.maxSteps - 1 && frame.responseMode !== "answer_only") {
    throw new Error("Final external harness call must be answer_only");
  }
  if (frame.responseMode === "answer_only" && frame.tools.length) throw new Error("answer_only must expose no tools");
  return frame;
}

export function assertReply(reply: AgentReply, frame: ResponseFrame): void {
  if (frame.responseMode === "answer_only" && reply.toolCalls.length) throw new Error("Model returned tools during answer_only");
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b?.type === "text").map(b => b.text).join("");
}
