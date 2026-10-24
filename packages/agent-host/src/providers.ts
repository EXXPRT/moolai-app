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
} from "../../contracts/src/index.js";
import { transcriptText } from "../../contracts/src/index.js";

export interface ProcessingAvailability {
  status: "available" | "unavailable" | "checking";
  checkedAt?: string;
}

/** Transport only: the Agent owns routing policy, tool execution and retries. */
/** A 16,384-token organizer generation takes about 80 s; the backend allows 150 s. */
export const ORGANIZATION_TIMEOUT_MS = 160_000;
/** A screen read gives up before the 90 s other calls get; the backend's 60 s deadline answers first with a readable 504. */
export const VISION_TIMEOUT_MS = 75_000;
export class BackendProviders
  implements
    DecisionProvider,
    GenerationProvider,
    SearchProvider,
    VisionProvider,
    AcceptancePort
{
  private availability: ProcessingAvailability = { status: "checking" };
  private healthInFlight?: Promise<void>;
  private stopping = false;
  private shutdown = new AbortController();
  private static readonly stoppedReason = "Moolai stopped before this request finished; your source is saved.";
  /** Step one of shutdown: refuse new paid work. Routing and acceptance may still finish. */
  beginShutdown() { this.stopping = true; }
  /** Step two: abort calls still running. Interrupted organization is offered as Retry, never re-sent automatically. */
  close() { this.stopping = true; this.shutdown.abort(new Error(BackendProviders.stoppedReason)); }
  private healthCheckedAt = -Infinity;
  constructor(
    private url: string,
    private token: string,
  ) {}
  /** Backend liveness only. Never delays local reads or calls an inference endpoint. */
  processingStatus(): ProcessingAvailability {
    if (!this.healthInFlight && Date.now() - this.healthCheckedAt >= 5000) {
      this.healthInFlight = this.checkHealth().finally(() => {
        this.healthInFlight = undefined;
      });
    }
    return { ...this.availability };
  }
  private async checkHealth() {
    let available = false;
    try {
      const response = await fetch(new URL("/health", this.url), {
        method: "GET",
        signal: AbortSignal.timeout(2000),
        cache: "no-store",
      });
      const body = await response.json() as { status?: string; service?: string };
      available = response.ok && body.status === "ok" && body.service === "moolai-backend";
    } catch {
      // Detailed request failures remain in per-operation diagnostics, not a sticky global error.
    }
    this.healthCheckedAt = Date.now();
    this.availability = {
      status: available ? "available" : "unavailable",
      checkedAt: new Date(this.healthCheckedAt).toISOString(),
    };
  }
  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = 90000,
  ): Promise<T> {
    if (!this.token)
      throw new Error(
        "MOOLAI_BACKEND_TOKEN is not configured. Configure backend/.env and start the backend.",
      );
    if (this.shutdown.signal.aborted || (this.stopping && path !== "/v1/route" && path !== "/v1/records/accept"))
      throw new Error(BackendProviders.stoppedReason);
    const response = await fetch(new URL(path, this.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      const data = (await response
        .json()
        .catch(() => ({ detail: `HTTP ${response.status}` }))) as {
        detail?: unknown;
      };
      // The status lets callers tell a request refused before dispatch (413) from a provider failure.
      throw Object.assign(new Error(
        `Backend ${response.status}: ${typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)}`,
      ), { status: response.status });
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
  planThoughts(input: import("../../contracts/src/index.js").ThoughtInput, signal?: AbortSignal) {
    return this.post<import("../../contracts/src/index.js").ThoughtPlan>("/v1/plan-thoughts",input,signal);
  }
  consolidate(input: import("../../contracts/src/index.js").ThoughtInput, signal?: AbortSignal) {
    // Outlasts the backend's 150 s organizer timeout, so a long generation reports its own readable error.
    return this.post<import("../../contracts/src/index.js").ThoughtResult>("/v1/consolidate",input,signal,ORGANIZATION_TIMEOUT_MS);
  }
  respond(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    options?: {
      responseMode?: "auto" | "answer_only";
      closingMode?: "current" | "contextual";
    },
  ) {
    return this.post<AgentReply>(
      "/v1/respond",
      {
        messages,
        tools,
        ...(options?.responseMode
          ? { responseMode: options.responseMode }
          : {}),
        ...(options?.closingMode ? { closingMode: options.closingMode } : {}),
      },
      signal,
    );
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
    const result = await this.post<
      import("../../contracts/src/index.js").VisionEvidence | { text: string }
    >("/v1/vision", { image, question, mode: options?.mode ?? "ocr" }, signal, VISION_TIMEOUT_MS);
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
  processingStatus(): ProcessingAvailability { return { status: "available" }; }
  async consolidate(input: import("../../contracts/src/index.js").ThoughtInput): Promise<import("../../contracts/src/index.js").ThoughtResult> {
    const spans=input.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}));
    // Fixture continuity is deliberately simple; it does not claim semantic topic detection.
    if(input.incremental) {
      // The Agent echoes at most 4,000 summary characters; keep the fixture's own summary within that by dropping its oldest lines.
      const lines=[...(input.activeNote?.summary ? input.activeNote.summary.split("\n") : []),...input.segments.map(s=>`${s.speaker}: ${s.text}`)];
      while(lines.length>1 && lines.join("\n").length>4000)lines.shift();
      return {groups:[{spans,title:input.activeNote?.title ?? "Saved study thought",summary:lines.join("\n"),
        topicSuggestions:[],continuesActive:!!input.activeNote,ongoing:!input.finalize}],remainder:[]};
    }
    return input.finalize ? {groups:[{spans,title:"Saved study thought",summary:input.segments.map(s=>`${s.speaker}: ${s.text}`).join("\n"),topicSuggestions:[]}],remainder:spans.slice(0,0)} : {groups:[],remainder:spans};
  }
  async route(input: RouteInput): Promise<RouteDecision> {
    const text = input.text.trim();
    // These deterministic examples support the offline demo, not routing accuracy claims.
    if(input.pendingOffer?.kind==="note_suppression") {
      if(/^(?:yes|yes please|sure|please do)[.!\s]*$/i.test(text))return {route:"suppress_note",confidence:1};
      if(/^(?:no|no thanks|keep it)[.!\s]*$/i.test(text))return {route:"no_action",confidence:1};
      return {route:"unclear",confidence:1};
    }
    if(/^(?:moo[, ]+)?(?:please )?(?:don['’]t|do not) (?:save|keep) (?:that|this)(?: (?:thought|note))?[.!\s]*$/i.test(text))
      return {route:"suppress_note",confidence:1};
    const help =
      input.pendingOffer?.kind === "help" ||
      input.pendingOffer?.kind === "general_help" ||
      input.pendingOffer?.kind === "clarification";
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
    const end =
      /^(?:(?:hey\s+)?moo[,.!:\s]+)?(?:(?:finish|end|close|stop)\s+(?:the\s+)?conversation|that[’']s all|we[’']re done|(?:i am|i[’']m) done|let[’']s stop here)[.!?\s]*$/i.test(
        text,
      );
    if (end)
      return {
        route: input.activeConversation ? "end_agent" : "no_action",
        confidence: 1,
        substantiveContentProbability: 0,
      };
    if (input.activeConversation && !input.pendingOffer && /^(?:moo|are you there|are you still (?:there|searching|working))[?!.\s]*$/i.test(input.text.trim())) return {route:"check_status",confidence:1};
    if (input.activeConversation)
      return { route: "continue_agent", confidence: 1 };
    // Idle turns carry J1's doubt answer; only a specific stated doubt counts, never vague confusion.
    const doubt = input.pendingOffer ? undefined : /\b(?:not sure why|(?:do not|don[’']t) understand why)\b/i.test(text) ? 1 : 0;
    const assessed = doubt === undefined ? {} : { doubt };
    if (
      /^(?:what[’']s (?:even )?going on|i (?:do not|don[’']t) understand(?: this)?|i[’']m confused)[.!?\s]*$/i.test(
        text,
      )
    )
      return { route: "offer_help", confidence: 1, ...assessed };
    if (
      /^(?:(?:hey\s+)?moo\b|(?:can|could|would) you\b|please (?:explain|help|find|show|tell|summari[sz]e)\b|(?:explain|help me|tell me|show me)\b)/i.test(
        text,
      )
    )
      return { route: "start_agent", confidence: 1 };
    if (
      /^(?:yes|no|sure|okay|ok|maybe|hmm|that thing)(?:[,.]?\s+(?:please|thanks))?[.!?\s]*$/i.test(
        text,
      )
    )
      return { route: "unclear", confidence: 1 };
    return { route: "dictate", confidence: 1, ...assessed };
  }
  async summarize(record: BrainRecord) {
    const user = record.segments
      .filter((s) => s.speaker === "user")
      .map((s) => s.text)
      .join(" ");
    const text =
      record.body || user || record.segments.map((s) => s.text).join(" ");
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
  async respond(messages: ChatMessage[]): Promise<AgentReply> {
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
