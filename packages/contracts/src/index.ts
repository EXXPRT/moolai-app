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
}
export interface RelatedLink {
  targetId: string;
  provenance: "suggested" | "source" | "reply";
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
}
export type RecordPatch = Partial<
  Pick<
    BrainRecord,
    | "title"
    | "summary"
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
  >
>;
export interface Attachment {
  id: string;
  mimeType: string;
  size: number;
}
export interface PendingOperation {
  id: string;
  kind: "route" | "enrich" | "accept";
  recordId: string;
  /** Present for durable J1 work; source record is the retained session. */
  turnId?: string;
  sourceRevision: number;
  status: "pending" | "running" | "failed" | "done";
  attempts: number;
  error?: string;
}
export interface BrainPort {
  createRecord(input: {
    id: string;
    kind: BrainRecord["kind"];
    createdAt: string;
  }): Promise<BrainRecord>;
  getRecord(id: string): Promise<BrainRecord | undefined>;
  listRecords(): Promise<BrainRecord[]>;
  upsertSegment(recordId: string, segment: Segment): Promise<BrainRecord>;
  /** Compare-and-set against the complete record revision. Return null on conflict. */
  updateRecord(
    id: string,
    expectedRevision: number,
    patch: RecordPatch,
  ): Promise<BrainRecord | null>;
  search(query: string, limit: number, options?: BrainSearchOptions): Promise<BrainRecord[]>;
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
  | "dictate"
  | "no_action"
  | "unclear";
export interface RouteInput {
  text: string;
  recentContext: string;
  activeConversation: boolean;
  pendingOffer?: { kind: "help" | "general_help" | "clarification"; recordId: string; sourceRevision?: number; screenQuestion?: string } | { kind: "end_work" } | {
    kind: "close"; conversationId: string; sessionId: string; turnId: string; revisionKey: string; question: string;
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
export interface AgentReply {
  text: string;
  toolCalls: ToolCall[];
  /** A suggestion only. The controller asks J1 to verify the latest user turn. */
  controlProposal?: { action: "end_conversation" | "offer_close"; reason: string };
}
export interface GenerationProvider {
  summarize(record: BrainRecord, signal?: AbortSignal): Promise<Summary>;
  respond(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    options?: { responseMode?: "auto" | "answer_only"; closingMode?: "current" | "contextual" },
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
  capture(): Promise<{ mimeType: string; bytes: Uint8Array }>;
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
  currentSubject?: string;
  webAllowed: boolean;
  lastError?: string;
}
export interface AgentEvent {
  type: "state" | "record" | "notice";
  state?: AgentState;
  record?: BrainRecord;
  message?: string;
}
export const transcriptText = (record: BrainRecord): string =>
  record.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");

export interface BrainSearchOptions {
  excludeIds?: string[];
  kinds?: BrainRecord["kind"][];
}
export interface LocalFolder { id: string; name: string; path: string }
export interface LocalFileMatch { rootId: string; path: string; line: number; excerpt: string; fingerprint: string }
export interface LocalFileSearch { matches: LocalFileMatch[]; truncated: boolean }
export interface LocalFileRead { rootId: string; path: string; startLine: number; text: string; fingerprint: string; truncated: boolean }
export interface LocalFilesPort {
  roots(): Promise<LocalFolder[]>;
  grant(path: string): Promise<LocalFolder>;
  revoke(id: string): Promise<void>;
  search(input: { query: string; mode?: "text" | "filename"; regex?: boolean; rootId?: string }, signal?: AbortSignal): Promise<LocalFileSearch>;
  read(input: { rootId: string; path: string; startLine?: number; lineCount?: number }, signal?: AbortSignal): Promise<LocalFileRead>;
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
  hypotheses: { label: string; featureIds: string[]; confidence: "low" | "medium" | "high" }[];
  limitation: string;
}
