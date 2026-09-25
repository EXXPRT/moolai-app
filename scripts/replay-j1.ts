/** Prepare real controller inputs, then replay recorded J1 decisions without provider calls. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Agent } from "../packages/agent/src/index.js";
import { MemoryBrain } from "../packages/brain/src/memory.js";
import { transcriptText } from "../packages/contracts/src/index.js";
import type { Route, RouteDecision, RouteInput } from "../packages/contracts/src/index.js";

type Action = "start" | "end" | "summary" | "clarify" | "retain_control" | "keep_open";
interface Case {
  id: string;
  category: string;
  scoring: "strict" | "exploratory";
  text: string;
  activeConversation: boolean;
  expectedRoutes: Route[];
  expectedAction: Action;
  note?: string;
}
interface Recorded {
  id: string;
  input: RouteInput;
  output?: RouteDecision;
  error?: unknown;
}
const directory = new URL("../.data/validation/", import.meta.url);
const timestamp = "2026-09-20T10:00:00.000Z";
const load = async (name: string) => JSON.parse(await readFile(new URL(name, directory), "utf8"));
const save = async (name: string, report: unknown) => {
  const target = new URL(name, directory);
  await mkdir(new URL(".", target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Saved ${target.pathname}`);
};
// Compare the JSON provider wire representation: omitted optionals and undefined are identical.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function run(item: Case, mode: "prepare" | "replay", recorded?: Recorded) {
  const brain = new MemoryBrain();
  let sequence = 0;
  let testing = false;
  const inputs: RouteInput[] = [];
  const speech: string[] = [];
  const summaries: { recordId: string; kind: string; source: string }[] = [];
  let responseCalls = 0;
  const agent = new Agent({
    brain,
    id: () => `${item.id}-${++sequence}`,
    now: () => timestamp,
    decisions: {
      route: async (input) => {
        if (!testing) return { route: "start_agent", confidence: 1 };
        inputs.push(structuredClone(input));
        if (mode === "prepare") return { route: "unclear", confidence: 1 };
        if (!recorded?.output) throw new Error("No successful recorded Jev decision for this case");
        return structuredClone(recorded.output);
      },
      tag: async () => ({ purpose: "Idea", purposeConfidence: 1, topics: {}, doubt: 0,
        faithful: 1, understandable: 1, relevant: 1 }),
      connect: async () => ({}),
    },
    generation: {
      summarize: async (record) => {
        const source = transcriptText(record);
        if (testing) summaries.push({ recordId: record.id, kind: record.kind, source });
        return { title: "Simulated J1 routing fixture", summary: source };
      },
      respond: async () => {
        if (testing) responseCalls++;
        return { text: "Understood.", toolCalls: [] };
      },
    },
    search: { search: async () => [], extract: async () => [] },
    capture: { capture: async () => { throw new Error("This replay must not capture screens"); } },
    vision: { interpret: async () => { throw new Error("This replay must not invoke vision"); } },
    speech: { speak: async (text) => { if (testing) speech.push(text); }, stop: async () => {} },
  });
  await agent.initialize();
  await agent.startSession();
  if (item.activeConversation) {
    await agent.submitText("Moo, help me organize my notes.");
    await agent.drain();
  }
  const before = agent.getState();
  testing = true;
  const sourceSegment = { id: `${item.id}-source`, turnId: `${item.id}-turn`, revision: 1,
    speaker: "user" as const, text: item.text, final: true, createdAt: timestamp };
  await agent.ingest(sourceSegment);
  // Snapshot before settling so an ordinary active turn's fixture answer cannot leak into J1 context.
  const sourceBeforeRouting = await brain.getRecord(before.sessionId!);
  const hypotheticalInput: RouteInput = {
    text: item.text.trim(),
    recentContext: sourceBeforeRouting!.segments.slice(-20).map((s) => `${s.speaker}: ${s.text}`).join("\n"),
    activeConversation: !!before.conversationId,
    pendingOffer: before.pendingOffer,
  };
  let error: string | undefined;
  try {
    await agent.settleTurn(sourceSegment.turnId);
    await agent.drain();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    await agent.drain();
  }
  const after = agent.getState();
  const sourceAfterRouting = await brain.getRecord(before.sessionId!);
  const sourceRetained = sourceAfterRouting?.segments.some((s) => isDeepStrictEqual(s, sourceSegment)) ?? false;
  const input = wire(inputs[0] ?? hypotheticalInput);
  const reachedGate = inputs.length > 0;
  if (inputs.length > 1 || (reachedGate && !isDeepStrictEqual(input, wire(hypotheticalInput))))
    throw new Error(`Unexpected routing context or repeated call for ${item.id}`);
  if (mode === "prepare") {
    await brain.close();
    return { ...item, input, controllerWouldRoute: reachedGate, sourceRetained };
  }
  const started = !before.conversationId && !!after.conversationId;
  const ended = !!before.conversationId && !after.conversationId;
  const stayedOpen = !!before.conversationId && after.conversationId === before.conversationId;
  const transitionUnchanged = before.conversationId === after.conversationId;
  const endingConfirmationPending = stayedOpen && after.pendingOffer?.kind === "end_work";
  const clarified = speech.some((s) => /couldn't confirm the closing request|Did you want to talk to Moo/i.test(s));
  const summarizedDictation = summaries.some((s) => s.kind === "dictation");
  const controlRetained = !started && !ended && !clarified && !summarizedDictation && responseCalls === 0;
  const observedAction = error ? "error" : started ? "start" : ended ? "end"
    : endingConfirmationPending ? "end_confirmation_pending" : clarified ? "clarify"
    : summarizedDictation ? "summary" : stayedOpen ? "keep_open" : "retain_control";
  const actionMatches = ({ start: started, end: ended || endingConfirmationPending, summary: summarizedDictation,
    clarify: clarified, retain_control: controlRetained, keep_open: transitionUnchanged && !endingConfirmationPending })[item.expectedAction];
  const inputMatches = reachedGate && recorded ? isDeepStrictEqual(input, wire(recorded.input)) : null;
  await brain.close();
  return {
    ...item,
    input,
    controllerWouldRoute: reachedGate,
    recordedDecisionAvailable: !!recorded?.output,
    recordedDecisionUsed: reachedGate && !!recorded?.output,
    inputMatchesRecorded: inputMatches,
    recordedDecision: recorded?.output,
    providerError: recorded?.error,
    observedAction,
    actionMatches: !error && actionMatches,
    endCompleted: ended,
    endingConfirmationPending,
    sourceRetained,
    summaryCalls: summaries,
    responseCalls,
    clarification: clarified,
    speech,
    before,
    after,
    error,
  };
}

const command = process.argv[2];
if (command !== "prepare" && command !== "replay")
  throw new Error("Usage: node --import tsx scripts/replay-j1.ts prepare|replay [recorded-report URL] [output-report URL]");
const manifest = JSON.parse(await readFile(new URL("../experiments/fixtures/j1-cases.json", import.meta.url), "utf8")) as { cases: Case[] };
if (!Array.isArray(manifest.cases) || new Set(manifest.cases.map((c) => c.id)).size !== manifest.cases.length)
  throw new Error("The manifest must contain cases with unique IDs");
if (command === "prepare") {
  const cases = [];
  for (const item of manifest.cases) cases.push(await run(item, "prepare"));
  await save("j1-prepared-inputs.json", { mode: "real-controller-input-preparation", cases });
} else {
  const report = await load(process.argv[3] ?? "j1-routing-simulated.json") as { results?: Recorded[]; cases?: Recorded[] };
  const recordings = report.results ?? report.cases;
  if (!Array.isArray(recordings)) throw new Error("Recorded report must contain results or cases");
  const results = [];
  for (const item of manifest.cases) results.push(await run(item, "replay", recordings.find((r) => r.id === item.id)));
  await save(process.argv[4] ?? "j1-controller-replay.json", {
    mode: "offline-controller-replay-of-recorded-Jev-decisions",
    limitations: ["No fresh provider, microphone, ASR or acoustic validation.",
      "Generation, summaries, tagging, connections and speech use local fixtures.",
      "MemoryBrain verifies this routing workflow, not SQLite restart durability.",
      "Direct decisions for controller-bypassed cases are not injected or acted on.",
      "A pending-work confirmation counts as an accepted end request, but is never automatically answered."],
    results,
  });
}
