/** Replay recorded first-J1 decisions through the unmodified production Agent.
 * This is an offline controller check: no provider calls or hypothetical replies.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Agent } from "../packages/agent/src/index.js";
import { MemoryBrain } from "../packages/brain/src/memory.js";
import { transcriptText } from "../packages/contracts/src/index.js";
import type {
  AgentReply, ChatMessage, RouteDecision, RouteInput, Segment,
} from "../packages/contracts/src/index.js";

interface Fixture {
  id: string;
  group: "start" | "end";
  input: RouteInput;
  source: { turnId: string; revision: number };
  conversation: { id: string | null; active: boolean; pendingWork: boolean };
  originalIntendedAction: "start" | "end" | "none";
}
interface RecordedCase { fixture: Fixture; firstDecision: RouteDecision | null }
interface RecordedReport { complete: boolean; cases: RecordedCase[] }
const timestamp = "2026-09-20T10:00:00.000Z";
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const deferred = <T>() => {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
};
const fixtureAnswer: AgentReply = {
  text: "[Offline replay fixture: no answer model or agent task executed.]", toolCalls: [],
};

export async function replayProductionBaseline(recorded: RecordedCase) {
  const { fixture: item } = recorded;
  if (item.input.activeConversation !== item.conversation.active)
    throw new Error(`Inconsistent active state for ${item.id}`);
  if (item.conversation.pendingWork && !item.input.activeConversation)
    throw new Error(`Pending work requires an active conversation for ${item.id}`);
  const brain = new MemoryBrain();
  let sequence = 0;
  let stage: "setup" | "pending_work_setup" | "target" = "setup";
  const pendingResponse = deferred<AgentReply>();
  const pendingStarted = deferred<void>();
  const routeCalls: { stage: string; input: RouteInput; sourceSavedBeforeRouting: boolean }[] = [];
  const responses: { stage: string; messages: ChatMessage[]; deferred: boolean }[] = [];
  const speech: { stage: string; text: string }[] = [];
  const summaries: { recordId: string; source: string }[] = [];
  const notices: string[] = [];
  const blockedCapabilities: string[] = [];
  let targetSource: Segment | undefined;
  const forbidden = async (name: string): Promise<never> => {
    blockedCapabilities.push(name);
    throw new Error(`Offline baseline replay cannot execute ${name}`);
  };
  const agent = new Agent({
    brain,
    id: () => `${item.id}:baseline:${++sequence}`,
    now: () => timestamp,
    decisions: {
      route: async input => {
        const sessionId = agent.getState().sessionId;
        const session = sessionId ? await brain.getRecord(sessionId) : undefined;
        routeCalls.push({ stage, input: wire(input), sourceSavedBeforeRouting:
          !targetSource || !!session?.segments.some(s => isDeepStrictEqual(s, targetSource)) });
        if (stage === "setup") return { route: "start_agent", confidence: 1 };
        if (stage === "pending_work_setup") return { route: "continue_agent", confidence: 1 };
        if (!recorded.firstDecision) throw new Error("Recorded first J1 failed; no replacement decision");
        return structuredClone(recorded.firstDecision);
      },
      tag: async () => ({ purpose: "Reference", purposeConfidence: 1, topics: {},
        doubt: 0, faithful: 1, understandable: 1, relevant: 1 }),
      connect: async () => ({}),
    },
    generation: {
      summarize: async record => {
        const source = transcriptText(record);
        summaries.push({ recordId: record.id, source });
        return { title: "Offline baseline replay fixture", summary: source };
      },
      respond: async messages => {
        const hold = stage === "pending_work_setup";
        responses.push({ stage, messages: structuredClone(messages), deferred: hold });
        if (hold) { pendingStarted.resolve(); return pendingResponse.promise; }
        return structuredClone(fixtureAnswer);
      },
    },
    search: { search: () => forbidden("web search"), extract: () => forbidden("web extraction") },
    capture: { capture: () => forbidden("screen capture") },
    vision: { interpret: () => forbidden("vision") },
    speech: { speak: async text => { speech.push({ stage, text }); }, stop: async () => {} },
    previewTool: async call => forbidden(`task tool ${call.name}`),
    onEvent: event => { if (event.type === "notice" && event.message) notices.push(event.message); },
  });

  try {
    await agent.initialize();
    await agent.startSession();
    if (item.input.activeConversation) {
      // Pure invocation opens the production conversation without generating an answer.
      await agent.submitText("Moo");
      await agent.drain();
    }
    const seededContext: Segment[] = [];
    for (const [index, line] of item.input.recentContext.split("\n").entries()) {
      if (!line.trim()) continue;
      const match = /^(user|assistant):\s?(.*)$/.exec(line);
      const segment: Segment = {
        id: `${item.id}:context:${index}`, turnId: `${item.id}:context-turn:${index}`,
        revision: 1, speaker: match?.[1] === "assistant" ? "assistant" : "user",
        text: match?.[2] ?? line, final: true, createdAt: timestamp,
      };
      seededContext.push(segment);
      // Public ingestion saves background without classifying it as another command.
      await agent.ingest(segment);
    }
    if (item.conversation.pendingWork) {
      stage = "pending_work_setup";
      await agent.submitText("[Replay setup] Keep preparing the requested comparison.");
      await pendingStarted.promise;
      if (!agent.getState().busy) throw new Error(`Failed to establish pending work for ${item.id}`);
    }
    const before = agent.getState();
    stage = "target";
    targetSource = {
      id: `${item.id}:original-source`, turnId: item.source.turnId,
      revision: item.source.revision, speaker: "user", text: item.input.text,
      final: true, createdAt: timestamp,
    };
    await agent.ingest(targetSource);
    const sourceBeforeRouting = await brain.getRecord(before.sessionId!);
    let error: string | undefined;
    try { await agent.settleTurn(targetSource.turnId); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const afterSettlement = agent.getState();
    // Busy cases are observed while the deliberately held fixture remains pending.
    // No confirmation reply or end-work choice is submitted by this baseline.
    if (!item.conversation.pendingWork) await agent.drain();
    const after = agent.getState();
    const recordsAtObservation = await brain.listRecords();
    const source = recordsAtObservation.find(record => record.id === before.sessionId);
    const targetCalls = routeCalls.filter(call => call.stage === "target");
    if (targetCalls.length !== 1) throw new Error(`Expected exactly one target J1 replay for ${item.id}`);
    const actualInput = targetCalls[0]!.input;
    const started = !before.conversationId && !!after.conversationId;
    const closed = !!before.conversationId && !after.conversationId;
    const pendingWork = !!before.conversationId && before.conversationId === after.conversationId &&
      after.pendingOffer?.kind === "end_work";
    const observedAction = started ? "start" : closed ? "closed" : pendingWork ? "pending_work" : "none";
    const acceptedAction = started ? "start" : closed || pendingWork ? "end" : "none";
    const sourceRetained = !!source?.segments.some(segment => isDeepStrictEqual(segment, targetSource));
    const targetOwner = await brain.getState<string>(`turn-record:${targetSource.turnId}`);
    const result = {
      id: item.id, group: item.group,
      mode: "recorded-first-J1-decision-in-unmodified-production-Agent",
      originalIntendedAction: item.originalIntendedAction,
      before, afterSettlement, after, observedAction, acceptedAction,
      matchesOriginalIntent: acceptedAction === item.originalIntendedAction,
      liveProviderInput: item.input, actualControllerInput: actualInput,
      inputComparison: {
        textMatches: actualInput.text === item.input.text,
        activeStateMatches: actualInput.activeConversation === item.input.activeConversation,
        fullInputMatches: isDeepStrictEqual(wire(actualInput), wire(item.input)),
        recentContextMatches: actualInput.recentContext === item.input.recentContext,
        note: "Public setup adds invocation/control history and the current turn to the Agent's recent context. The recorded decision is injected without a fresh provider call; full inputs are not claimed identical.",
      },
      recordedFirstDecision: recorded.firstDecision,
      recordedDecisionInjected: !!recorded.firstDecision,
      hypotheticalConfirmationReplySubmitted: false,
      sourceSavedBeforeRouting: targetCalls[0]!.sourceSavedBeforeRouting,
      sourceRetained, sourceBeforeRouting, sourceAtObservation: source,
      targetOwner: targetOwner ?? null,
      targetNode: targetOwner ? await brain.getRecord(targetOwner) : null,
      recordsAtObservation, seededContext, routeCalls, responses, speech, summaries, notices,
      blockedCapabilities, error,
    };
    // Release only after capturing the pending-work observation. This is fixture
    // cleanup, not user acceptance of finish/cancel or successful task execution.
    pendingResponse.resolve(structuredClone(fixtureAnswer));
    await agent.drain();
    return { ...result, afterFixtureCleanup: agent.getState() };
  } finally {
    pendingResponse.resolve(structuredClone(fixtureAnswer));
    await agent.drain();
    await brain.close();
  }
}

async function main() {
  const inputPath = resolve(process.argv[2] ?? ".data/validation/j1-confirmation-live.json");
  const outputPath = resolve(process.argv[3] ?? ".data/validation/j1-confirmation-production-baseline.json");
  if (inputPath === outputPath) throw new Error("Replay output must not overwrite provider evidence");
  const live = JSON.parse(await readFile(inputPath, "utf8")) as RecordedReport;
  if (!live.complete || !Array.isArray(live.cases) || live.cases.length !== 16)
    throw new Error("Expected a completed 16-case provider report");
  const cases = [];
  for (const recorded of live.cases) cases.push(await replayProductionBaseline(recorded));
  const report = {
    mode: "offline cached-decision replay through production Agent and MemoryBrain",
    providerReport: inputPath, productionDefaultsChanged: false, freshProviderCalls: 0,
    microphoneUsed: false, agentTasksExecuted: false,
    limitations: [
      "The first J1 decision is replayed; this is not a fresh model accuracy measurement.",
      "Actual controller context includes public setup turns and original input; exact context equality is reported per case.",
      "Generation, summaries, tagging, connections and speech are fixtures. No tool calls or confirmation replies are submitted.",
      "Pending-work observations precede release of a deferred fixture answer. No user finish/cancel/continue choice is invented.",
      "MemoryBrain source retention and controller behavior do not prove SQLite restart durability.",
    ],
    checks: {
      allSourcesSavedBeforeRouting: cases.every(item => item.sourceSavedBeforeRouting),
      allSourcesRetained: cases.every(item => item.sourceRetained),
      allTargetTextAndActiveStatesMatch: cases.every(item => item.inputComparison.textMatches && item.inputComparison.activeStateMatches),
      noForbiddenCapabilitiesInvoked: cases.every(item => item.blockedCapabilities.length === 0),
      allTargetCasesReachedJ1Once: cases.every(item => item.routeCalls.filter(call => call.stage === "target").length === 1),
    }, cases,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ output: outputPath, checks: report.checks,
    cases: cases.map(item => ({ id: item.id, action: item.observedAction, error: item.error })) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
