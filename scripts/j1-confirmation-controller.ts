/** Experimental comparison only. Nothing here changes the production Agent. */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { BrainPort, RouteDecision, Segment } from "../packages/contracts/src/index.js";
import { MemoryBrain } from "../packages/brain/src/memory.js";

export type Method = "baseline" | "double_j1" | "super_j1";
export type Action = "start_agent" | "end_agent";
export interface Turn { turnId: string; revision: number; text: string }
export interface ConfirmationDecision {
  action: Action | "reject" | "unclear";
  confidence: number;
  endAction?: "finish" | "cancel" | "continue";
}
export interface SuperAssessment {
  verdict: "confirmed" | "rejected" | "unclear";
  evidenceQuote: string;
}
export interface Proposal {
  id: string;
  action: Action;
  originalTurnId: string;
  originalRevision: number;
  conversationId?: string;
  question: string;
  firstDecision: RouteDecision;
}
export interface OriginalInput {
  original: Turn;
  recentContext: string;
  sessionId: string;
  conversationId?: string;
  pendingWork: boolean;
}
export interface ConfirmationInput extends OriginalInput {
  proposal: Proposal;
  reply: Turn;
  superAssessment?: SuperAssessment;
}
export interface TraceEntry {
  kind: "saved" | "first_decision" | "confirmation_decision" | "super_assessment" |
    "question" | "started" | "closed" | "rejected" | "unresolved" |
    "pending_work" | "continued" | "stale" | "provider_failure";
  reason?: string;
  turnId?: string;
  revision?: number;
  data?: unknown;
}
export interface Snapshot {
  sessionId: string;
  recentContext: string;
  conversationId?: string;
  pendingWork: boolean;
  pendingEnd?: "ask" | "finish";
  pendingProposal?: Proposal;
  turns: Record<string, Turn>;
  lastTurnId?: string;
  version: number;
  sourceRecordRevision: number;
  transitionCount: number;
  trace: TraceEntry[];
  startedRequest?: { originalText: string; confirmationText?: string; recentContext: string };
}
interface Options {
  brain: BrainPort;
  namespace: string;
  method: Method;
  routeOriginal(input: OriginalInput): Promise<RouteDecision>;
  routeConfirmation(input: ConfirmationInput): Promise<ConfirmationDecision>;
  assessConfirmation?(input: ConfirmationInput): Promise<SuperAssessment>;
  now?: () => string;
}
export const QUESTIONS: Record<Action, string> = {
  start_agent: "Would you like me to help with that request?",
  end_agent: "Would you like me to end this conversation?",
};
const validConfidence = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

/** One serialized writer, with provider calls outside the write queue. */
export class ExperimentalConfirmationController {
  private state!: Snapshot;
  private writes = Promise.resolve();
  constructor(private readonly options: Options) {}
  private get key() { return `j1-confirmation:${this.options.namespace}:${this.options.method}`; }
  private now() { return this.options.now?.() ?? new Date().toISOString(); }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writes.then(fn);
    this.writes = result.then(() => {}, () => {});
    return result;
  }
  private async persist() { await this.options.brain.setState(this.key, this.state); }
  private trace(entry: TraceEntry) { this.state.trace.push(entry); }
  getSnapshot(): Snapshot { return structuredClone(this.state); }
  getTrace(): TraceEntry[] { return structuredClone(this.state.trace); }

  async initialize(initial: { sessionId: string; conversationId?: string; pendingWork?: boolean; recentContext?: string }) {
    await this.mutate(async () => {
      const saved = await this.options.brain.getState<Snapshot>(this.key);
      if (saved) { this.state = saved; return; }
      this.state = { ...initial, recentContext: initial.recentContext ?? "", pendingWork: initial.pendingWork ?? false,
        turns: {}, version: 0, sourceRecordRevision: 0, transitionCount: 0, trace: [] };
      const source = await this.options.brain.createRecord({ id: initial.sessionId, kind: "session", createdAt: this.now() });
      this.state.sourceRecordRevision = source.revision;
      if (this.state.recentContext) {
        const retained = await this.options.brain.upsertSegment(initial.sessionId, this.contextSegment(initial.sessionId));
        this.state.sourceRecordRevision = retained.revision;
      }
      if (initial.conversationId) await this.options.brain.createRecord({
        id: initial.conversationId, kind: "conversation", createdAt: this.now(),
      });
      if (initial.conversationId && this.state.recentContext)
        await this.options.brain.upsertSegment(initial.conversationId, this.contextSegment(initial.conversationId));
      await this.persist();
    });
  }

  private segment(turn: Turn, audit = false): Segment {
    return { id: audit ? `${turn.turnId}@${turn.revision}` : turn.turnId,
      turnId: turn.turnId, revision: turn.revision, speaker: "user", text: turn.text,
      final: true, createdAt: this.now() };
  }
  private contextSegment(recordId: string): Segment {
    return { id: `${recordId}:prior-context`, turnId: `${recordId}:prior-context`, revision: 0,
      speaker: "system", text: this.state.recentContext, final: true, createdAt: this.now() };
  }
  private async saveTurn(turn: Turn): Promise<boolean> {
    if (!turn.turnId || !Number.isSafeInteger(turn.revision) || turn.revision < 0)
      throw new Error("A turn identity and nonnegative revision are required");
    const previous = this.state.turns[turn.turnId];
    if (previous && previous.revision >= turn.revision) return false;
    // Every received revision stays in this isolated audit session; the conversation
    // contains the current revision of each turn, as in the production Brain contract.
    const source = await this.options.brain.upsertSegment(this.state.sessionId, this.segment(turn, true));
    this.state.sourceRecordRevision = source.revision;
    if (this.state.conversationId)
      await this.options.brain.upsertSegment(this.state.conversationId, this.segment(turn));
    this.state.turns[turn.turnId] = structuredClone(turn);
    this.state.lastTurnId = turn.turnId;
    this.state.version += 1;
    this.trace({ kind: "saved", turnId: turn.turnId, revision: turn.revision });
    await this.persist();
    return true;
  }
  /** Retain a correction without automatically asking another question. */
  async reviseTurn(turn: Turn) { return this.mutate(() => this.saveTurn(turn)); }
  /** Simulates an explicit session/conversation change while a provider is running. */
  async changeContext(context: { sessionId?: string; conversationId?: string | null; pendingWork?: boolean }) {
    await this.mutate(async () => {
      if (context.sessionId) {
        const source = await this.options.brain.createRecord({ id: context.sessionId, kind: "session", createdAt: this.now() });
        this.state.sourceRecordRevision = source.revision;
        this.state.sessionId = context.sessionId;
      }
      if (context.conversationId !== undefined) {
        this.state.conversationId = context.conversationId ?? undefined;
        if (context.conversationId) await this.options.brain.createRecord({
          id: context.conversationId, kind: "conversation", createdAt: this.now(),
        });
      }
      if (context.pendingWork !== undefined) this.state.pendingWork = context.pendingWork;
      this.state.pendingProposal = undefined;
      this.state.version += 1;
      await this.persist();
    });
  }
  private input(original: Turn): OriginalInput {
    return { original: structuredClone(original), recentContext: this.state.recentContext, sessionId: this.state.sessionId,
      conversationId: this.state.conversationId, pendingWork: this.state.pendingWork };
  }
  private current(snapshot: Snapshot, original: Turn, reply?: Turn): boolean {
    return this.state.version === snapshot.version && this.state.sessionId === snapshot.sessionId &&
      this.state.conversationId === snapshot.conversationId &&
      this.state.turns[original.turnId]?.revision === original.revision &&
      (!reply || this.state.turns[reply.turnId]?.revision === reply.revision);
  }
  private async outdated(reason: string) {
    this.trace({ kind: "stale", reason }); await this.persist();
  }
  private async failed(stage: string, snapshot: Snapshot, original: Turn, reply?: Turn) {
    await this.mutate(async () => {
      if (!this.current(snapshot, original, reply)) return this.outdated(`${stage}: source or context changed`);
      this.state.pendingProposal = undefined;
      this.trace({ kind: "provider_failure", reason: `${stage} failed; no transition` });
      await this.persist();
    });
  }
  async submitOriginal(original: Turn) {
    const prepared = await this.mutate(async () => {
      if (!await this.saveTurn(original)) return undefined;
      this.state.pendingProposal = undefined;
      await this.persist();
      return { snapshot: this.getSnapshot(), input: this.input(original) };
    });
    if (!prepared) return;
    let decision: RouteDecision;
    try { decision = await this.options.routeOriginal(prepared.input); }
    catch { await this.failed("first J1", prepared.snapshot, original); return; }
    await this.mutate(async () => {
      if (!this.current(prepared.snapshot, original)) return this.outdated("first J1: source or context changed");
      this.trace({ kind: "first_decision", data: decision });
      const action = decision?.route;
      if (!validConfidence(decision.confidence) || (action !== "start_agent" && action !== "end_agent")) {
        this.trace({ kind: "unresolved", reason: "First J1 did not propose a start or end" });
      } else if ((action === "start_agent") === Boolean(this.state.conversationId)) {
        this.trace({ kind: "unresolved", reason: "Proposed action is invalid in the current conversation state" });
      } else if (this.options.method === "baseline") {
        if (decision.confidence >= 0.8) await this.apply(action, original, undefined, decision.endAction);
        else this.trace({ kind: "unresolved", reason: "First J1 below the unchanged 0.8 threshold" });
      } else {
        this.state.pendingProposal = {
          id: `${this.key}:${original.turnId}:${original.revision}`,
          action, originalTurnId: original.turnId, originalRevision: original.revision,
          conversationId: this.state.conversationId, question: QUESTIONS[action], firstDecision: decision,
        };
        this.trace({ kind: "question", data: this.state.pendingProposal });
      }
      await this.persist();
    });
  }
  async submitReply(reply: Turn) {
    const prepared = await this.mutate(async () => {
      const proposal = structuredClone(this.state.pendingProposal);
      if (!await this.saveTurn(reply)) return undefined;
      if (!proposal) {
        this.trace({ kind: "unresolved", reason: "No pending confirmation proposal" });
        await this.persist(); return undefined;
      }
      const original = this.state.turns[proposal.originalTurnId];
      if (!original || original.revision !== proposal.originalRevision ||
          this.state.conversationId !== proposal.conversationId) {
        this.state.pendingProposal = undefined;
        await this.outdated("Confirmation refers to an outdated original request"); return undefined;
      }
      if (!reply.text.trim()) {
        this.state.pendingProposal = undefined;
        this.trace({ kind: "unresolved", reason: "Silence cannot confirm a transition" });
        await this.persist(); return undefined;
      }
      const input: ConfirmationInput = { ...this.input(original), proposal, reply: structuredClone(reply) };
      return { snapshot: this.getSnapshot(), input, original };
    });
    if (!prepared) return;
    const { snapshot, original, input } = prepared;
    let assessment: SuperAssessment | undefined;
    let decision: ConfirmationDecision;
    try {
      if (this.options.method === "super_j1") {
        if (!this.options.assessConfirmation) throw new Error("Missing assessor");
        assessment = await this.options.assessConfirmation(structuredClone(input));
        input.superAssessment = assessment;
      }
      // Do not make a second provider call if the source changed during Super.
      if (!this.current(snapshot, original, reply)) {
        await this.mutate(() => this.outdated("Source changed during Super assessment")); return;
      }
      decision = await this.options.routeConfirmation(structuredClone(input));
    } catch { await this.failed("confirmation", snapshot, original, reply); return; }
    await this.mutate(async () => {
      if (!this.current(snapshot, original, reply)) return this.outdated("Confirmation: source or context changed");
      this.trace({ kind: "confirmation_decision", data: decision });
      if (assessment) this.trace({ kind: "super_assessment", data: assessment });
      this.state.pendingProposal = undefined;
      const quoteValid = assessment && typeof assessment.evidenceQuote === "string" && assessment.evidenceQuote.trim().length > 0 &&
        reply.text.includes(assessment.evidenceQuote);
      if (this.options.method === "super_j1" && (!assessment || !quoteValid || assessment.verdict === "unclear")) {
        this.trace({ kind: "unresolved", reason: "Super is unclear or its quote is not grounded in the reply" });
      } else if (assessment?.verdict === "rejected" || decision?.action === "reject") {
        this.trace({ kind: "rejected", reason: "Confirmation rejected the pending proposal" });
      } else if ((assessment && assessment.verdict !== "confirmed") ||
          !decision || !validConfidence(decision.confidence) || decision.confidence < 0.8 ||
          decision.action !== input.proposal.action) {
        this.trace({ kind: "unresolved", reason: "Both required decisions did not confidently confirm the same action" });
      } else {
        await this.apply(input.proposal.action, original, reply, decision.endAction);
      }
      await this.persist();
    });
  }
  private async apply(action: Action, original: Turn, reply?: Turn, endAction?: "finish" | "cancel" | "continue") {
    // A CAS catches external edits through the injected Brain while a provider ran.
    const session = await this.options.brain.getRecord(this.state.sessionId);
    if (!session) { this.trace({ kind: "stale", reason: "Source session no longer exists" }); return; }
    const originalSegment = session.segments.find(s => s.id === `${original.turnId}@${original.revision}`);
    const replySegment = reply && session.segments.find(s => s.id === `${reply.turnId}@${reply.revision}`);
    if (originalSegment?.text !== original.text || (reply && replySegment?.text !== reply.text)) {
      this.trace({ kind: "stale", reason: "Durable source differs from the confirmed source" }); return;
    }
    const acknowledged = await this.options.brain.updateRecord(session.id, this.state.sourceRecordRevision, { quality: "pending" });
    if (!acknowledged) {
      this.trace({ kind: "stale", reason: "Source compare-and-set failed" }); return;
    }
    this.state.sourceRecordRevision = acknowledged.revision;
    if (action === "start_agent") {
      const id = `${this.options.namespace}:${this.options.method}:conversation:${this.state.transitionCount + 1}`;
      await this.options.brain.createRecord({ id, kind: "conversation", createdAt: this.now() });
      if (this.state.recentContext) await this.options.brain.upsertSegment(id, this.contextSegment(id));
      await this.options.brain.upsertSegment(id, this.segment(original));
      if (reply) await this.options.brain.upsertSegment(id, this.segment(reply));
      this.state.conversationId = id;
      this.state.startedRequest = { originalText: original.text, confirmationText: reply?.text,
        recentContext: this.state.recentContext };
      this.state.transitionCount += 1;
      this.trace({ kind: "started", data: this.state.startedRequest });
    } else if (endAction === "continue") {
      this.state.pendingEnd = undefined;
      this.trace({ kind: "continued", reason: "User chose to continue the conversation" });
    } else if (this.state.pendingWork) {
      if (endAction === "cancel") {
        this.state.pendingWork = false;
        this.close("User explicitly chose to cancel pending work");
      } else {
        this.state.pendingEnd = endAction === "finish" ? "finish" : "ask";
        this.trace({ kind: "pending_work", reason: endAction === "finish"
          ? "Finish pending work before closing" : "Ask whether to finish, cancel, or continue" });
      }
    } else this.close("Confirmed end intent");
    this.state.version += 1;
  }
  private close(reason: string) {
    this.state.conversationId = undefined;
    this.state.pendingEnd = undefined;
    this.state.pendingProposal = undefined;
    this.state.transitionCount += 1;
    this.trace({ kind: "closed", reason });
  }
  async finishWork() {
    await this.mutate(async () => {
      this.state.pendingWork = false;
      if (this.state.pendingEnd === "finish") this.close("Pending work finished after the user's finish choice");
      this.state.version += 1;
      await this.persist();
    });
  }
}

export interface ReplayCase {
  id: string;
  initial: { activeConversation: boolean; pendingWork?: boolean };
  recentContext?: string;
  original: Turn;
  reply: Turn;
  firstDecision: RouteDecision;
  secondDecision: { double_j1: ConfirmationDecision; super_j1: ConfirmationDecision };
  superAssessment: SuperAssessment;
  [key: string]: unknown;
}
export async function replayCases(cases: ReplayCase[]) {
  const results: Array<ReplayCase & { methods: Record<string, unknown> }> = [];
  for (const item of cases) {
    const methods: Record<string, unknown> = {};
    for (const method of ["baseline", "double_j1", "super_j1"] as const) {
      const brain = new MemoryBrain();
      const namespace = `${item.id}:${method}`;
      const controller = new ExperimentalConfirmationController({ brain, namespace, method,
        routeOriginal: async () => {
          if (!item.firstDecision) throw new Error("Missing live original decision");
          return item.firstDecision;
        },
        routeConfirmation: async () => {
          const decision = method !== "baseline" && item.secondDecision[method];
          if (!decision) throw new Error("Missing live confirmation decision");
          return decision;
        },
        assessConfirmation: async () => {
          if (!item.superAssessment) throw new Error("Missing live Super assessment");
          return item.superAssessment;
        },
      });
      await controller.initialize({ sessionId: `${namespace}:session`,
        conversationId: item.initial.activeConversation ? `${namespace}:initial-conversation` : undefined,
        pendingWork: item.initial.pendingWork, recentContext: item.recentContext });
      await controller.submitOriginal(item.original);
      // Baseline does not receive a reply to a question it never asked.
      if (method !== "baseline" && controller.getSnapshot().pendingProposal)
        await controller.submitReply(item.reply);
      methods[method] = { implementation: method === "baseline" ? "experimental_threshold_replay" : "experimental_confirmation_controller",
        snapshot: controller.getSnapshot(), records: await brain.listRecords() };
      await brain.close();
    }
    results.push({ ...item, methods });
  }
  return { kind: "experimental_controller_replay", productionDefaultChanged: false, cases: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.argv[process.argv.indexOf("--input") + 1];
  const outputPath = process.argv[process.argv.indexOf("--output") + 1];
  if (!process.argv.includes("--input") || !process.argv.includes("--output") || !inputPath || !outputPath)
    throw new Error("Usage: --input results.json --output replay.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const output = await replayCases(input.replay?.cases ?? input.cases);
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ cases: output.cases.length, output: outputPath }) + "\n");
}
