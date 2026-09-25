import { transcriptText } from "../../contracts/src/index.js";
import type { BrainPort, ChatMessage, ToolCall, ToolDefinition } from "../../contracts/src/index.js";

/** Opt-in experiment support. These records are not consulted by ordinary sessions. */
export interface ExperimentToolEvent {
  call: ToolCall;
  result?: unknown;
  status: "success" | "no_matches" | "rejected" | "failed";
  error?: string;
  previewOnly?: boolean;
  executed?: boolean;
}
export interface ExperimentToolOutcome {
  status: ExperimentToolEvent["status"];
  tool: string;
  query?: string;
  executed: boolean;
  previewOnly: boolean;
  result?: unknown;
  error?: string;
}
export interface ResponseEvidence {
  version: 1;
  notes: { id: string; revision: number; sourceRevision: number; title: string; excerpt: string; previewOnly: boolean }[];
  recentOutcomes: (Omit<ExperimentToolOutcome, "result"> & { noteIds: string[] })[];
  webAllowed?: boolean;
}
export interface ResponseExperimentSeed {
  priorTools: ExperimentToolEvent[];
  currentTools?: ExperimentToolEvent[];
}
const evidenceKey = (id: string) => `response-experiment:evidence:${id}`;
const seedKey = (id: string) => `response-experiment:seed:${id}`;
const emptyEvidence = (): ResponseEvidence => ({ version: 1, notes: [], recentOutcomes: [] });

export const responseReliabilityPrompt =
  " Distinguish rejected arguments, retrieval failure, successful retrieval with no matches, and successful retrieval with evidence. A failed or rejected search says nothing about whether notes exist. No matches applies only to that query, never the whole Brain. Retain the user's latest constraints. Prefer available relevant evidence to redundant searches, and cite only evidence that supports the claim. If evidence is related but insufficient, say so. You may propose one specific corrected query grounded in the user's request or available evidence; do not repeat rejected or duplicate searches. If recovery cannot finish within two responses, describe what remains unresolved without claiming completion. Preview fixtures are simulated evidence, not executed actions.";

export function responseExperimentTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map(tool => ({ ...tool, description: tool.description +
    (tool.name === "search_notes" ? " Supply a nonempty, specific query grounded in the request. A rejected or failed query does not mean no notes exist; no matches describes only this query." :
      tool.name === "read_note" ? " Use an ID actually returned in evidence. Read current note content; previously quoted excerpts may have changed." : "") }));
}

/** Seed the same preceding events for every model profile without invoking a model or task tool. */
export async function seedResponseExperiment(brain: BrainPort, conversationId: string, seed: ResponseExperimentSeed) {
  await brain.setState(seedKey(conversationId), seed);
  for (const event of [...seed.priorTools, ...(seed.currentTools ?? [])]) {
    await brain.setState(`tool:${conversationId}:${event.call.id}`, { call: event.call, result: rawExperimentResult(event), seeded: true });
    await rememberResponseTool(brain, conversationId, event);
  }
}

export async function takeResponseExperimentSeed(brain: BrainPort, conversationId: string): Promise<ResponseExperimentSeed | undefined> {
  const seed = await brain.getState<ResponseExperimentSeed | null>(seedKey(conversationId));
  if (seed) await brain.setState(seedKey(conversationId), null);
  return seed ?? undefined;
}

export async function readResponseEvidence(brain: BrainPort, conversationId: string): Promise<ResponseEvidence> {
  return (await brain.getState<ResponseEvidence>(evidenceKey(conversationId))) ?? emptyEvidence();
}

export function rawExperimentResult(event: ExperimentToolEvent): unknown {
  if (event.status === "failed" || event.status === "rejected") return { error: event.error ?? event.status };
  return event.previewOnly
    ? { executed: false, previewOnly: true, fixture: event.result }
    : event.result;
}

export function typedExperimentResult(event: ExperimentToolEvent): ExperimentToolOutcome {
  return {
    status: event.status,
    tool: event.call.name,
    ...(typeof event.call.arguments.query === "string" ? { query: event.call.arguments.query } : {}),
    executed: event.executed ?? (!event.previewOnly && event.status !== "rejected"),
    previewOnly: event.previewOnly ?? false,
    ...(event.result === undefined ? {} : { result: event.result }),
    ...(event.error ? { error: event.error } : {}),
  };
}

export function experimentSeedMessages(seed: ResponseExperimentSeed, workflow: boolean): ChatMessage[] {
  return (seed.currentTools ?? []).flatMap(event => [
    { role: "assistant" as const, content: "", toolCalls: [event.call] },
    { role: "tool" as const, toolCallId: event.call.id, content: JSON.stringify(workflow ? responseToolMessage(typedExperimentResult(event)) : rawExperimentResult(event)) },
  ]);
}

/** Keep historical bodies in the audit log. The model reads current bodies from the revisioned index. */
export function responseToolMessage(outcome: ExperimentToolOutcome): ExperimentToolOutcome {
  if (outcome.status !== "success" || !["read_note", "search_notes"].includes(outcome.tool)) return outcome;
  return { ...outcome, result: { retrievedNoteIds: [...new Set(noteResults(outcome.result).map(note => note.id))],
    source: "Use the current retained evidence index for source text and revisions. IDs absent from that index have no available excerpt." } };
}

function noteResults(value: unknown): { id: string }[] {
  if (Array.isArray(value)) return value.flatMap(noteResults);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if ("results" in item) return noteResults(item.results);
  if ("record" in item) return noteResults(item.record);
  if (typeof item.fixture === "object" && item.fixture !== null) return noteResults(item.fixture);
  return typeof item.id === "string" ? [{ id: item.id }] : [];
}

export function responseToolEvent(call: ToolCall, output: unknown): ExperimentToolEvent {
  const wrapper = output && typeof output === "object" ? output as Record<string, unknown> : {};
  const previewOnly = wrapper.previewOnly === true;
  const result = previewOnly ? wrapper.fixture : output;
  const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const error = typeof body.error === "string" ? body.error : undefined;
  const empty = call.name === "search_notes" &&
    ((Array.isArray(result) && !result.length) || (Array.isArray(body.results) && !body.results.length));
  return { call, result, status: error ? "failed" : empty ? "no_matches" : "success", ...(error ? { error } : {}), previewOnly,
    executed: !previewOnly };
}

export async function rememberResponseTool(brain: BrainPort, conversationId: string, event: ExperimentToolEvent) {
  const evidence = await readResponseEvidence(brain, conversationId);
  const ids = event.status === "success" && ["search_notes", "read_note"].includes(event.call.name)
    ? [...new Set(noteResults(event.result).map(note => note.id))] : [];
  for (const id of ids) {
    const record = await brain.getRecord(id);
    if (!record) continue; // A citation/fixture ID alone cannot manufacture note content.
    evidence.notes = evidence.notes.filter(note => note.id !== id);
    evidence.notes.push({ id, revision: record.revision, sourceRevision: record.sourceRevision, title: record.title,
      excerpt: transcriptText(record).slice(0, 2000), previewOnly: event.previewOnly ?? false });
  }
  evidence.notes = evidence.notes.slice(-5);
  const { result: _raw, ...outcome } = typedExperimentResult(event);
  evidence.recentOutcomes = [...evidence.recentOutcomes, { ...outcome, noteIds: ids }].slice(-5);
  await brain.setState(evidenceKey(conversationId), evidence);
}

/** Resolve current revisions before each response; stale tool text remains only in the audit log. */
export async function refreshResponseEvidence(brain: BrainPort, conversationId: string, request: string, webAllowed: boolean) {
  const evidence = await readResponseEvidence(brain, conversationId);
  const current: ResponseEvidence["notes"] = [];
  for (const ref of evidence.notes) {
    const record = await brain.getRecord(ref.id);
    if (record) current.push({ ...ref, revision: record.revision, sourceRevision: record.sourceRevision,
      title: record.title, excerpt: transcriptText(record).slice(0, 2000) });
  }
  const words = new Set(request.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const relevance = (note: ResponseEvidence["notes"][number]) =>
    (note.title + " " + note.excerpt).toLowerCase().split(/\W+/).filter(word => words.has(word)).length;
  evidence.notes = current.sort((a, b) => relevance(b) - relevance(a)).slice(0, 5);
  evidence.webAllowed = webAllowed;
  await brain.setState(evidenceKey(conversationId), evidence);
  return evidence;
}

export async function responseEvidenceIsCurrent(brain: BrainPort, snapshot: ResponseEvidence) {
  for (const ref of snapshot.notes) {
    const record = await brain.getRecord(ref.id);
    if (!record || record.revision !== ref.revision) return false;
  }
  return true;
}

export function toolSignature(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(Object.fromEntries(Object.entries(call.arguments).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, typeof value === "string" ? value.trim().toLowerCase() : value])))}`;
}

/** A minimal lexical grounding guard, not an intent classifier or additional Jev gate. */
export function groundedRepair(call: ToolCall, context: string): boolean {
  if (call.name !== "search_notes" || typeof call.arguments.query !== "string") return false;
  const stop = new Set(["the", "and", "this", "that", "with", "from", "notes", "note", "find", "search", "please", "what", "does", "only", "use", "tell"]);
  const tokens = (text: string) => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(word => !stop.has(word));
  const available = new Set(tokens(context));
  return tokens(call.arguments.query).some(word => available.has(word));
}
