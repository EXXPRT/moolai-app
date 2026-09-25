import type {
  AcceptancePort,
  AgentReply,
  BrainRecord,
  ChatMessage,
  DecisionProvider,
  GenerationProvider,
  RouteInput,
  RouteDecision,
  SearchProvider,
  Summary,
  TagInput,
  ToolDefinition,
  VisionProvider,
} from "../../../packages/contracts/src/index.js";
import { transcriptText } from "../../../packages/contracts/src/index.js";

/** Transport only: the Agent owns routing policy, tool execution and retries. */
export class BackendProviders
  implements
    DecisionProvider,
    GenerationProvider,
    SearchProvider,
    VisionProvider,
    AcceptancePort
{
  constructor(
    private url: string,
    private token: string,
  ) {}
  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.token)
      throw new Error(
        "MOOLAI_BACKEND_TOKEN is not configured. Configure backend/.env and start the backend.",
      );
    const response = await fetch(new URL(path, this.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
        : AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      const data = (await response
        .json()
        .catch(() => ({ detail: `HTTP ${response.status}` }))) as {
        detail?: unknown;
      };
      throw new Error(
        `Backend ${response.status}: ${typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)}`,
      );
    }
    return response.json() as Promise<T>;
  }
  route(input: RouteInput, signal?: AbortSignal) {
    return this.post<Awaited<ReturnType<DecisionProvider["route"]>>>(
      "/v1/route",
      input,
      signal,
    );
  }
  tag(input: TagInput, signal?: AbortSignal) {
    return this.post<Awaited<ReturnType<DecisionProvider["tag"]>>>(
      "/v1/tag",
      input,
      signal,
    );
  }
  connect(
    record: BrainRecord,
    candidates: BrainRecord[],
    signal?: AbortSignal,
  ) {
    return this.post<Record<string, number>>(
      "/v1/connect",
      { record, candidates },
      signal,
    );
  }
  summarize(record: BrainRecord, signal?: AbortSignal) {
    return this.post<Summary>("/v1/summarize", { record }, signal);
  }
  respond(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    options?: { responseMode?: "auto" | "answer_only"; closingMode?: "current" | "contextual" },
  ) {
    return this.post<AgentReply>("/v1/respond", {
      messages, tools,
      ...(options?.responseMode ? { responseMode: options.responseMode } : {}),
      ...(options?.closingMode ? { closingMode: options.closingMode } : {}),
    }, signal);
  }
  async search(query: string, signal?: AbortSignal) {
    return (
      await this.post<{
        results: Awaited<ReturnType<SearchProvider["search"]>>;
      }>("/v1/search", { query }, signal)
    ).results;
  }
  async extract(urls: string[], signal?: AbortSignal) {
    return (
      await this.post<{
        results: Awaited<ReturnType<SearchProvider["extract"]>>;
      }>("/v1/extract", { urls }, signal)
    ).results;
  }
  async interpret(
    image: { mimeType: string; dataBase64: string },
    question: string,
    signal?: AbortSignal,
    options?: { mode: "ocr" | "visual" },
  ) {
    const result = await this.post<import("../../../packages/contracts/src/index.js").VisionEvidence | {text:string}>("/v1/vision", {image, question, mode:options?.mode ?? "ocr"}, signal);
    return "text" in result ? result.text : result;
  }
  accept(record: BrainRecord, operationId: string) {
    return this.post<{ revision: number }>("/v1/records/accept", {
      record,
      operationId,
    });
  }
}

/** Explicit offline demonstration fixtures. Never selected as a silent provider fallback. */
export class FixtureProviders
  implements
    DecisionProvider,
    GenerationProvider,
    SearchProvider,
    VisionProvider
{
  async route(input: RouteInput): Promise<RouteDecision> {
    const text = input.text.trim();
    // These deterministic examples support the offline demo, not routing accuracy claims.
    const help = input.pendingOffer?.kind === "help" ||
      input.pendingOffer?.kind === "general_help";
    if (input.pendingOffer?.kind === "end_work") {
      const endAction = /\bcancel\b/i.test(text)
        ? "cancel"
        : /\b(?:continue|keep|stay)\b/i.test(text)
          ? "continue"
          : /\b(?:finish|save)\b/i.test(text)
            ? "finish"
            : undefined;
      return {
        route: endAction ? "end_agent" : "unclear",
        confidence: 1,
        endAction,
      };
    }
    if (help && /^(yes|sure|please|okay|ok)\b/i.test(text))
      return {
        route: "start_agent",
        confidence: 1,
        helpAccepted: true,
      };
    if (help && /^(no|not now|nope)\b/i.test(text))
      return { route: "no_action", confidence: 1 };
    const end = /^(?:(?:hey\s+)?moo[,.!:\s]+)?(?:(?:finish|end|close|stop)\s+(?:the\s+)?conversation|that[’']s all|we[’']re done|(?:i am|i[’']m) done|let[’']s stop here)[.!?\s]*$/i.test(text);
    if (end)
      return {
        route: input.activeConversation ? "end_agent" : "no_action",
        confidence: 1,
        substantiveContentProbability: 0,
      };
    if (input.activeConversation)
      return { route: "continue_agent", confidence: 1 };
    if (/^(?:what[’']s (?:even )?going on|i (?:do not|don[’']t) understand(?: this)?|i[’']m confused)[.!?\s]*$/i.test(text))
      return { route: "offer_help", confidence: 1 };
    if (/^(?:(?:hey\s+)?moo\b|(?:can|could|would) you\b|please (?:explain|help|find|show|tell|summari[sz]e)\b|(?:explain|help me|tell me|show me)\b)/i.test(text))
      return { route: "start_agent", confidence: 1 };
    if (/^(?:yes|no|sure|okay|ok|maybe|hmm|that thing)(?:[,.]?\s+(?:please|thanks))?[.!?\s]*$/i.test(text))
      return { route: "unclear", confidence: 1 };
    return { route: "dictate", confidence: 1 };
  }
  async summarize(record: BrainRecord) {
    const user = record.segments
      .filter((s) => s.speaker === "user")
      .map((s) => s.text)
      .join(" ");
    const text = user || record.segments.map((s) => s.text).join(" ");
    return {
      title: text.slice(0, 70) || "Saved thought",
      summary: `[Fixture summary — no model call]\n${text}`,
      topicSuggestion: "General",
    };
  }
  async tag(input: TagInput) {
    const text = transcriptText(input.record);
    const doubt = /don.?t understand|confus|unsure|why|how|\?/i.test(text);
    return {
      purpose: doubt
        ? ("Question" as const)
        : /need to|remind|tomorrow/i.test(text)
          ? ("Action" as const)
          : /idea|maybe|could/i.test(text)
            ? ("Idea" as const)
            : ("Reference" as const),
      purposeConfidence: 1,
      topics: Object.fromEntries(input.topicCandidates.map((t) => [t, 1])),
      doubt: doubt ? 1 : 0,
      relevant: input.currentSubject
        ? text.toLowerCase().includes(input.currentSubject.toLowerCase())
          ? 1
          : 0
        : undefined,
      faithful: 1,
      understandable: 1,
    };
  }
  async connect(_record: BrainRecord, candidates: BrainRecord[]) {
    return Object.fromEntries(candidates.map((c) => [c.id, 0]));
  }
  async respond(messages: ChatMessage[]) {
    const last =
      messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    return {
      text: `[Fixture response — no AI inference]\nI retained your request: ${last}`,
      toolCalls: [],
    };
  }
  async search(_query: string) {
    return [
      {
        url: "https://example.com/fixture",
        title: "Fixture source",
        content: "Offline fixture; no web search was performed.",
      },
    ];
  }
  async extract(urls: string[]) {
    return urls.map((url) => ({
      url,
      title: "Fixture source",
      content: "Offline fixture; no URL was fetched.",
    }));
  }
  async interpret() {
    return "[Fixture interpretation — screenshot was not analyzed by a model]";
  }
}
