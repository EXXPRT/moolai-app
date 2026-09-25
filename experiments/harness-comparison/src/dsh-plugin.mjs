import { LlmAdapter } from "@deepseek-ai/dsh-llm";

// This trusted experiment plugin has no provider credential or external network URL.
// The real SDK loop invokes its model and tool seams; the parent owns all capabilities.
export const name = "moolai-harness-experiment";
export const inject = ["llm", "tools"];

export function apply(ctx) {
  const endpoint = process.env.MOOLAI_HARNESS_BRIDGE;
  const token = process.env.MOOLAI_HARNESS_TOKEN;
  const parsed = new URL(endpoint);
  if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:") throw new Error("Only a loopback bridge is allowed");
  const call = async (route, value, signal) => {
    const response = await fetch(`${endpoint}/${route}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(value), signal,
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Bridge rejected ${route}`);
    return body;
  };
  const setup = JSON.parse(process.env.MOOLAI_HARNESS_SETUP);
  let requests = 0;
  let answerOnly = false;
  for (const tool of setup.tools) {
    if (!["search_notes", "read_note"].includes(tool.name)) throw new Error("Unexpected experiment tool");
    ctx.tools.register({ ...tool,
      output: { schema: { type: "object", properties: {}, additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (answerOnly) throw new Error("Tool execution forbidden in answer_only");
        return call("execute", { id: exec.callId, name: tool.name, arguments: args }, exec.signal);
      },
    });
  }
  ctx.tools.guard(exec => ["search_notes", "read_note"].includes(exec.name) && !answerOnly ? undefined : "Tool outside experiment allowlist");
  class MeteredAdapter extends LlmAdapter {
    providerInfo() { return { id: "moolai", name: "Moolai metered transport" }; }
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ["text"],
      context: { contextWindow: 32768 }, defaultMaxTokens: 4000 }; }
    async *stream(options) {
      if (options.purpose) throw new Error("Auxiliary model calls are disabled");
      if (requests >= setup.maxSteps) throw new Error("External harness generation limit reached");
      const step = requests++;
      const result = await call("generate", { step, messages: options.messages, tools: options.tools ?? [] }, options.signal);
      answerOnly = result.responseMode === "answer_only";
      const reply = result.reply;
      if (answerOnly && reply.toolCalls.length) throw new Error("Model returned tools during answer_only");
      let index = 0;
      if (reply.text) {
        yield { type: "block-start", index, blockType: "text" };
        yield { type: "text-delta", index, text: reply.text };
        yield { type: "block-end", index, block: { type: "text", text: reply.text } };
        index++;
      }
      for (const tool of reply.toolCalls) {
        const args = JSON.stringify(tool.arguments);
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id: tool.id, name: tool.name, argumentsDelta: args };
        yield { type: "block-end", index, block: { type: "tool-call", id: tool.id, name: tool.name, arguments: args } };
        index++;
      }
      yield { type: "finish", reason: { kind: reply.toolCalls.length ? "tool-calls" : "stop" } };
    }
  }
  ctx.llm.registerAdapter(["moolai"], new MeteredAdapter());
  ctx.on("agent/pre-step", (payload, next) => requests >= setup.maxSteps ? { kind: "reject" } : next());
}
