/** Host-neutral contracts. No UI, database, OS or provider implementation belongs here. */
export type Purpose = "Question" | "Reference" | "Idea" | "Action";
export type Quality = "pending" | "ready" | "needs_review";
export type Speaker = "user" | "assistant" | "system";
export interface Segment {
  id: string;
  turnId: string;
  revision: number;
  speaker: Speaker;
  text: string;
  final: boolean;
  createdAt: string;
  references?: NoteReference[];
}
export interface NoteReference { recordId: string; title: string }
export interface SourceSpan { segmentId: string; revision: number; start: number; end: number }
export interface ActiveThought {
  id: string; title: string; summary: string; sourceRevision: number;
  sourceExcerpt: string; sourceTruncated: boolean;
}
export interface ThoughtInput { sessionId: string; segments: Segment[]; finalize: boolean; context?: string; activeNote?: ActiveThought; incremental?: boolean }
export interface ThoughtGroup extends Summary {
  spans: SourceSpan[];
  /** Only the first group may extend the supplied active note. */
  continuesActive?: boolean;
  /** Only the last group may remain open for further speech. */
  ongoing?: boolean;
}
/** Planning returns exact ordered source spans; writing remains a separate provider call. */
export interface ThoughtPlan {
  groups: {spans: SourceSpan[]}[];
  remainder: SourceSpan[];
  extendsActive: boolean;
  ongoing: boolean;
}
export interface ThoughtResult { groups: ThoughtGroup[]; remainder: SourceSpan[] }
export interface RelatedLink {
  targetId: string;
  provenance: "suggested" | "source" | "reply" | "manual" | "correction";
  decision?: "accepted" | "dismissed";
  confidence?: number;
  sourceRevision?: number;
  targetRevision?: number;
}
export interface Author {
  id: string;
  name: string;
  kind: "user" | "agent" | "unknown";
}
export interface RecordRevision {
  record: BrainRecord;
  reason: "capture" | "manual" | "generated" | "import";
  at: string;
}
export interface BrainRecord {
  id: string;
  kind: "session" | "dictation" | "conversation" | "note";
  revision: number;
  sourceRevision: number;
  createdAt: string;
  updatedAt: string;
  segments: Segment[];
  title: string;
  summary: string;
  /** Authored Markdown, separate from retained source transcripts and generated summaries. */
  body?: string;
  author?: Author;
  resolution?: "open" | "resolved";
  archived?: boolean;
  /** Hidden derived note; original transcript and historical revisions are retained. */
  suppressed?: { at: string; operationId: string; sessionId: string };
  summarySourceRevision?: number;
  purpose?: Purpose;
  topics: string[];
  offTopic?: { subject: string };
  quality: Quality;
  qualityReasons: string[];
  doubt: boolean;
  links: RelatedLink[];
  attachmentIds: string[];
  manualFields: string[];
  acceptedRevision: number;
  error?: string;
  /** Retained transcript/request, not an independently generated knowledge note. */
  sourceOnly?: boolean;
  sourceContext?: string;
  sources?: { recordId: string; spans: SourceSpan[] }[];
  connectionStatus?: "pending" | "connected" | "no_match" | "failed";
  thoughtStatus?: "draft" | "growing" | "settled";
}
export type RecordPatch = Partial<
  Pick<
    BrainRecord,
    | "title"
    | "summary"
    | "body"
    | "author"
    | "resolution"
    | "archived"
    | "suppressed"
    | "summarySourceRevision"
    | "purpose"
    | "topics"
    | "offTopic"
    | "quality"
    | "qualityReasons"
    | "doubt"
    | "links"
    | "attachmentIds"
    | "manualFields"
    | "acceptedRevision"
    | "error"
    | "sourceContext"
    | "sourceOnly"
    | "sources"
    | "connectionStatus"
    | "thoughtStatus"
  >
> & {
  /** Atomic replacement of a derived note's source projection, never an original transcript. */
  derivedSegments?: Segment[];
};
export interface Attachment {
  id: string;
  mimeType: string;
  size: number;
}
export interface PendingOperation {
  id: string;
  kind: "route" | "enrich" | "accept" | "consolidate";
  recordId: string;
  /** Present for durable J1 work; source record is the retained session. */
  turnId?: string;
  sourceRevision: number;
  status: "pending" | "running" | "failed" | "done";
  attempts: number;
  error?: string;
}
/** Write-failure contract.
 * Adapters: a call is all-or-nothing. A rejected write is not applied, now or later; once a change is durable the
 * adapter reports success and repairs its own bookkeeping. Reject with the original error.
 * Callers: retry only the identical call (createRecord, upsertSegment, setState and putOperation are idempotent;
 * updateRecord stays compare-and-set). Write the source or intent before any done or handled marker. Traces,
 * acceptance, narration and previews are best-effort. A stored "running" marker with nothing in flight means
 * interrupted: never start paid work from it. Error handlers and timers never throw. */
export interface BrainPort {
  createRecord(input: {
    id: string;
    kind: BrainRecord["kind"];
    createdAt: string;
  }): Promise<BrainRecord>;
  getRecord(id: string): Promise<BrainRecord | undefined>;
  listRecords(): Promise<BrainRecord[]>;
  query(options: BrainQuery): Promise<BrainRecord[]>;
  related(id: string): Promise<BrainRecord[]>;
  history(id: string): Promise<RecordRevision[]>;
  /** Explicit transfer of a missing record; never overwrite an existing ID. */
  importRecord(record: BrainRecord, history?: RecordRevision[]): Promise<void>;
  upsertSegment(recordId: string, segment: Segment): Promise<BrainRecord>;
  /** Compare-and-set against the complete record revision. Return null on conflict. */
  updateRecord(
    id: string,
    expectedRevision: number,
    patch: RecordPatch,
  ): Promise<BrainRecord | null>;
  search(
    query: string,
    limit: number,
    options?: BrainSearchOptions,
  ): Promise<BrainRecord[]>;
  putAttachment(
    id: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<Attachment>;
  getAttachment(
    id: string,
  ): Promise<{ mimeType: string; bytes: Uint8Array } | undefined>;
  putOperation(operation: PendingOperation): Promise<void>;
  listOperations(): Promise<PendingOperation[]>;
  getState<T>(key: string): Promise<T | undefined>;
  setState<T>(key: string, value: T): Promise<void>;
  close(): Promise<void>;
}
export type Route =
  | "start_agent"
  | "end_agent"
  | "offer_help"
  | "continue_agent"
  | "check_status"
  | "suppress_note"
  | "dictate"
  | "no_action"
  | "unclear";
export interface RouteInput {
  text: string;
  recentContext: string;
  activeConversation: boolean;
  pendingOffer?:
    | {
        kind: "help" | "general_help" | "clarification";
        recordId: string;
        sourceRevision?: number;
        screenQuestion?: string;
      }
    | { kind: "end_work" }
    | { kind: "note_suppression"; proposalId: string; question: string }
    | {
        kind: "close";
        conversationId: string;
        sessionId: string;
        turnId: string;
        revisionKey: string;
        question: string;
      };
}
export interface RouteDecision {
  route: Route;
  confidence: number;
  endAction?: "finish" | "cancel" | "continue";
  helpAccepted?: boolean;
  /** J1 proposes screen assistance; the controller must offer it before capture. */
  screenHelp?: boolean;
  substantiveText?: string;
  /** Probability that a closing utterance also contains a substantive request or constraint. */
  substantiveContentProbability?: number;
  /** Probability that an idle dictated turn states the user's own specific study doubt; used only to offer screen help. */
  doubt?: number;
}
export interface TagInput {
  record: BrainRecord;
  currentSubject?: string;
  topicCandidates: string[];
}
export interface TagDecision {
  purpose?: Purpose;
  purposeConfidence: number;
  topics: Record<string, number>;
  doubt: number;
  relevant?: number;
  faithful: number;
  understandable: number;
}
export interface DecisionProvider {
  route(input: RouteInput, signal?: AbortSignal): Promise<RouteDecision>;
  tag(input: TagInput, signal?: AbortSignal): Promise<TagDecision>;
  connect(
    record: BrainRecord,
    candidates: BrainRecord[],
    signal?: AbortSignal,
  ): Promise<Record<string, number>>;
}
export interface Summary {
  title: string;
  summary: string;
  topicSuggestion?: string;
  topicSuggestions?: string[];
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface SpokenOutline {
  overview: string;
  points: {
    label: string;
    explanation: string;
    /** One-based main-section indices in the complete answer, in reading order. */
    sourceSections?: number[];
  }[];
}
export interface AgentReply {
  text: string;
  /** Optional model interpretation of a self-corrected request; never replaces source. */
  understoodRequest?: string;
  /** Brief plain-text speech produced with the full answer in the same call. */
  spokenText?: string;
  /** Presentation failure only; the written answer remains available. */
  narrationError?: string;
  spokenOutline?: SpokenOutline;
  references?: NoteReference[];
  toolCalls: ToolCall[];
  /** A suggestion only. The controller asks J1 to verify the latest user turn. */
  controlProposal?: {
    action: "end_conversation" | "offer_close";
    reason: string;
  };
}
export interface GenerationProvider {
  planThoughts?(input: ThoughtInput, signal?: AbortSignal): Promise<ThoughtPlan>;
  consolidate?(input: ThoughtInput, signal?: AbortSignal): Promise<ThoughtResult>;
  summarize(record: BrainRecord, signal?: AbortSignal): Promise<Summary>;
  respond(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    options?: {
      responseMode?: "auto" | "answer_only";
      closingMode?: "current" | "contextual";
    },
  ): Promise<AgentReply>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface SearchResult {
  url: string;
  title: string;
  content: string;
}
export interface SearchProvider {
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  extract(urls: string[], signal?: AbortSignal): Promise<SearchResult[]>;
}
export interface VisionProvider {
  interpret(
    image: { mimeType: string; dataBase64: string },
    question: string,
    signal?: AbortSignal,
    options?: { mode: "ocr" | "visual" },
  ): Promise<VisionEvidence | string>;
}
export interface CapturePort {
  /** `excluded` names what the capturing host confirms it left out of the image. */
  capture(): Promise<{ mimeType: string; bytes: Uint8Array; excluded?: string[] }>;
}
export interface SpeechPort {
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}
export interface AcceptancePort {
  accept(
    record: BrainRecord,
    operationId: string,
  ): Promise<{ revision: number }>;
}
export interface AgentState {
  sessionId?: string;
  conversationId?: string;
  listening: boolean;
  pendingOffer?: RouteInput["pendingOffer"];
  busy: boolean;
  activity?: "listening" | "searching" | "preparing" | "interrupted";
  narration?: {
    conversationId: string;
    outline: SpokenOutline;
    next: number;
    /** Optional only for legacy state. New offers always anchor the original answer. */
    sourceResponse?: { segmentId: string; revision: number };
  };
  currentSubject?: string;
  /** Presentation only, tied to the exact user turn the response interpreted. */
  understoodRequest?: { text: string; conversationId: string; turnId: string; revisionKey: string };
  webAllowed: boolean;
  lastError?: string;
}
export interface LiveThoughtPreview {
  sessionId: string;
  recordId?: string;
  revision: string;
  segments: Pick<Segment, "id" | "speaker" | "text" | "final">[];
  status?: "pending" | "running" | "failed";
}
export interface AgentEvent {
  type: "state" | "record" | "notice" | "voice" | "thought_preview";
  preview?: LiveThoughtPreview;
  voice?: Record<string, unknown>;
  state?: AgentState;
  record?: BrainRecord;
  message?: string;
}
export const transcriptText = (record: BrainRecord): string =>
  [
    record.body ? `Authored note:\n${record.body}` : "",
    record.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

export interface BrainQuery extends BrainSearchOptions {
  text?: string;
  limit?: number;
}
export interface BrainSearchOptions {
  topic?: string;
  purpose?: Purpose;
  quality?: Quality;
  unresolved?: boolean;
  archived?: boolean;
  since?: string;
  until?: string;
  excludeIds?: string[];
  kinds?: BrainRecord["kind"][];
}
export interface LocalFolder {
  id: string;
  name: string;
  path: string;
}
export interface LocalFileMatch {
  rootId: string;
  path: string;
  line: number;
  excerpt: string;
  fingerprint: string;
}
export interface LocalFileSearch {
  matches: LocalFileMatch[];
  truncated: boolean;
}
export interface LocalFileRead {
  rootId: string;
  path: string;
  startLine: number;
  text: string;
  fingerprint: string;
  truncated: boolean;
}
export interface LocalFilesPort {
  roots(): Promise<LocalFolder[]>;
  grant(path: string): Promise<LocalFolder>;
  revoke(id: string): Promise<void>;
  search(
    input: {
      query: string;
      mode?: "text" | "filename";
      regex?: boolean;
      rootId?: string;
    },
    signal?: AbortSignal,
  ): Promise<LocalFileSearch>;
  read(
    input: {
      rootId: string;
      path: string;
      startLine?: number;
      lineCount?: number;
    },
    signal?: AbortSignal,
  ): Promise<LocalFileRead>;
}
export interface VisionObservation {
  field: string;
  status: "readable" | "unreadable" | "absent";
  value: string | null;
  label: string | null;
  sourceExcerpt: string | null;
}
export interface VisionEvidence {
  raw: string;
  observations: VisionObservation[];
  interpretation: string;
  validationErrors: string[];
  validated: boolean;
  scene?: VisualScene;
}
/** Model observations and hypotheses, not independently verified image truth. */
export interface VisualScene {
  status: "observed" | "absent" | "unclear";
  features: { id: string; description: string; region: string }[];
  hypotheses: {
    label: string;
    featureIds: string[];
    confidence: "low" | "medium" | "high";
  }[];
  limitation: string;
}
