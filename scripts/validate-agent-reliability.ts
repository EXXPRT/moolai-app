/** Isolated reliability experiment. Default is a no-call, no-write manifest preview. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, readResponseEvidence, seedResponseExperiment } from "../packages/agent/src/index.js";
import { SQLiteBrain } from "../packages/brain/src/index.js";
import type { AgentReply, BrainRecord, ChatMessage, Segment, TagDecision, ToolCall, ToolDefinition } from "../packages/contracts/src/index.js";
// @ts-expect-error Fixture helpers are also covered directly by node:test.
import { loadReliabilityFixtures, fixtureToolResult, scoreOcr } from "./reliability-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const mode = flag("--live") ? "live" : flag("--offline") ? "offline" : "dry-run";
if (flag("--live") && flag("--offline")) throw new Error("Choose live or offline");
if (mode === "live" && !flag("--allow-paid")) throw new Error("Explicit --allow-paid is required");
const fixtures = await loadReliabilityFixtures();
const manifest = fixtures.cases;
const EXPERIMENT = "agent_reliability_v1";
if (mode === "dry-run") {
  console.log(JSON.stringify({ mode, paidCalls: 0, productionDefaultsChanged: false, casesSha256: fixtures.casesSha256,
    budget: manifest.budget, profiles: manifest.profiles,
    agentCases: manifest.agentCases.map((c: any) => ({ id: c.id, scenario: c.scenario, request: c.providerInput.latestRequest, expected: c.expected })),
    agentRepeats: manifest.agentRepeats, ocr: fixtures.images.map((i: any) => ({ id: i.id, description: i.description, sha256: i.sha256 })),
    j7: manifest.j7Cases.map((c: any) => ({ id: c.id, source: c.providerInput.record.segments, summary: c.providerInput.record.summary, expected: c.expected })),
  }, null, 2));
  process.exit(0);
}
const runName = option("--run-id") ?? `reliability-${mode}-${randomUUID()}`;
if (!/^[a-z0-9-]{1,100}$/.test(runName)) throw new Error("Invalid run ID");
const directory = path.join(root, ".data/validation", runName);
if (await access(directory).then(() => true, () => false)) throw new Error("Preserve existing results; run directory already exists");
await mkdir(directory, { recursive: true, mode: 0o700 });
const output = path.join(directory, "report.json");
const freezePath = path.join(directory, "freeze.json");
const python = path.join(root, "backend/.venv/bin/python");
const bridge = path.join(root, "scripts/reliability-provider.py");
const timestamp = "2026-09-20T00:00:00.000Z";
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const opaque = (value: string) => `r-${hash(value).slice(0, 20)}`;
const calls: any[] = [];
const agentCases: any[] = [];
const images: any[] = [];
const tags: any[] = [];
const followThrough: any[] = [];
let forbiddenCapabilities = 0;
let writeQueue = Promise.resolve();
const report: any = { version: 1, experiment: EXPERIMENT, mode, startedAt: new Date().toISOString(), complete: false,
  productionDefaultsChanged: false, microphoneUsed: false, realScreensCaptured: false, realTasksExecuted: false,
  caseHashes: { cases: fixtures.casesSha256, ocrManifest: fixtures.manifestSha256 }, calls, agentCases, images, tags, followThrough,
  budget: manifest.budget, retries: 0, limitations: [
    "Injected failures measure recovery, not the frequency of spontaneous model errors.",
    "Profiles compare declared model settings, not model weights alone.",
    "Eight unique agent cases and six unique images; predefined repeats are consistency probes.",
    "Tools are simulated, and other Jev gates, summaries and speech are fixtures.",
    "OCR profile C reuses B raw output; consumer validation is scored separately from extraction.",
  ] };
async function save() {
  // Snapshot immediately: later mutation of messages/results cannot rewrite previous call evidence.
  const snapshot = structuredClone({ ...report, forbiddenCapabilities });
  const job = writeQueue.then(async () => {
    await writeFile(`${output}.tmp`, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    await rename(`${output}.tmp`, output);
  });
  writeQueue = job.catch(() => {});
  await job;
}
async function providerProcess(parameters: string[], input?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [bridge, ...parameters], { cwd: root, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.stdout.on("data", data => { stdout += data.toString(); if (stdout.length > 4_000_000) child.kill("SIGTERM"); });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Provider bridge stopped before returning evidence (exit ${code}); do not retry. ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Provider bridge returned invalid JSON; do not retry")); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
const sourcePaths = ["scripts/validate-agent-reliability.ts", "scripts/reliability-provider.py", "scripts/reliability-fixtures.mjs",
  "experiments/fixtures/agent-reliability-cases.json", "experiments/fixtures/agent-reliability-ocr/manifest.json",
  "packages/agent/src/index.ts", "packages/agent/src/reliability.ts", "packages/agent/src/tools.ts",
  "backend/moolai_backend/providers.py", "backend/moolai_backend/schemas.py"];
const sourceHashes: Record<string, string> = {};
for (const relative of sourcePaths) sourceHashes[relative] = hash(await readFile(path.join(root, relative)));
for (const image of fixtures.images) sourceHashes[`experiments/fixtures/agent-reliability-ocr/${image.image}`] = image.sha256;
report.sourceHashes = sourceHashes;
const preflight = mode === "live" ? await providerProcess(["--preflight"]) : { mode: "offline; no inventory or paid calls", at: new Date().toISOString() };
report.preflight = preflight;
const ledger = JSON.parse(await readFile(path.join(root, ".data/provider-validation.json"), "utf8"));
const beforeCents = ledger.calls.reduce((sum: number, e: any) => sum + Math.round(Number(e.reservedUsd) * 100), 0);
report.budgetBeforeUsd = (beforeCents / 100).toFixed(2);
if (mode === "live" && beforeCents + 684 > 2000) throw new Error("Full frozen comparison cannot fit the cumulative US$20 cap");
await writeFile(freezePath, JSON.stringify({ experiment: EXPERIMENT, sourceHashes, preflight }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await save();

async function invoke(phase: string, caseId: string, profile: string, repeat: number, step: number,
  input: unknown, offline: () => unknown): Promise<any> {
  const callId = `${EXPERIMENT}:${phase}:${caseId}:${profile}:${repeat}:${step}`;
  if (calls.some(c => c.callId === callId)) throw new Error("Duplicate logical request");
  const pending: any = { callId, phase, caseId, profile, repeat, step, input: structuredClone(input), status: "prepared" };
  calls.push(pending);
  await save();
  if (mode === "live") {
    try { Object.assign(pending, await providerProcess(["--call", "--freeze", freezePath], pending)); }
    catch (error) {
      pending.status = "bridge_failed_unknown_charge";
      pending.error = error instanceof Error ? error.message : String(error);
      await save();
      throw error; // Never continue blind after a bridge failure with uncertain reservation evidence.
    }
  } else Object.assign(pending, { output: offline(), status: "fixture", elapsedMs: 0, reservedUsd: "0" });
  await save();
  if (!["succeeded", "fixture"].includes(pending.status)) throw new Error(pending.error ?? "Provider failure; no retry");
  return pending.output;
}

const fixedTags: TagDecision = { purpose: "Reference", purposeConfidence: 1, topics: {}, doubt: 0, faithful: 1, understandable: 1 };
const forbidden = async () => { forbiddenCapabilities++; throw new Error("Real capability forbidden in reliability experiment"); };

async function runAgent(item: any, profile: string, repeat: number) {
  const brainPath = path.join(directory, opaque(`${item.id}:${profile}:${repeat}`));
  let brain = new SQLiteBrain(brainPath);
  let sequence = 0, generationCalls = 0, setup = true;
  const prefix = opaque(`${item.id}:${profile}:${repeat}:identity`);
  const toolEvents: any[] = [], responses: any[] = [], events: any[] = [], speech: string[] = [];
  const row: any = { id: item.id, scenario: item.scenario, profile, repeat, expected: item.expected,
    providerInput: item.providerInput, injectedEvents: { prior: item.providerInput.priorToolEvents, current: item.providerInput.currentToolEvents },
    toolEvents, responses, events, speech, status: "started", controller: "actual Agent; isolated SQLite and simulated task tools" };
  agentCases.push(row);
  const priorRecords = new Map<string, any>();
  for (const event of item.providerInput.priorToolEvents) {
    for (const note of event.result?.results ?? []) priorRecords.set(note.id, note);
    if (event.result?.record) priorRecords.set(event.result.record.id, event.result.record);
  }
  const changed: any[] = [];
  for (const note of item.providerInput.notes) {
    const old = priorRecords.get(note.id);
    const oldText = old?.original ?? old?.text;
    const initialText = oldText && oldText !== note.text ? oldText : note.text;
    await brain.createRecord({ id: note.id, kind: "note", createdAt: timestamp });
    const saved = await brain.upsertSegment(note.id, { id: `${note.id}:source`, turnId: `${note.id}:source`, revision: 1,
      speaker: "user", text: initialText, final: true, createdAt: timestamp });
    await brain.updateRecord(note.id, saved.revision, { title: note.title });
    if (initialText !== note.text) changed.push(note);
  }
  let agent!: Agent;
  agent = new Agent({ brain, id: () => `${prefix}-${++sequence}`, now: () => timestamp,
    ...(profile === "A" ? {} : { responseExperiment: profile === "B" ? "prompt" as const : "workflow" as const }),
    decisions: { route: async input => ({ route: input.activeConversation ? "continue_agent" : "start_agent", confidence: 1 }),
      tag: async () => fixedTags, connect: async () => ({}) },
    generation: {
      summarize: async record => ({ title: "Experiment transcript", summary: record.segments.map(s => s.text).join(" ").slice(0, 2000) }),
      respond: async (messages: ChatMessage[], definitions: ToolDefinition[]): Promise<AgentReply> => {
        if (setup) return { text: "Fixture setup only.", toolCalls: [] };
        if (generationCalls >= 2) throw new Error("Two-generation-call experiment limit reached");
        const step = generationCalls++;
        const source = await brain.getRecord(agent.getState().sessionId!);
        const sourceSavedBeforeGeneration = source?.segments.some(s => s.text === item.providerInput.latestRequest) === true;
        const input = structuredClone({ messages, tools: definitions });
        const entry: any = { step, input, sourceSavedBeforeGeneration };
        responses.push(entry);
        if (!sourceSavedBeforeGeneration) throw new Error("Source missing before provider dispatch");
        try {
          const result = await invoke("agent", item.id, profile, repeat, step, input, () => {
            if (step === 0) return { text: "", toolCalls: [{ id: opaque(`${prefix}:fixture-tool`), name: "search_notes", arguments: { query: "optical filter comparison" } }] };
            return { text: "Fixture-only response: consult the supplied evidence and retain uncertainty; no real task executed.", toolCalls: [] };
          });
          entry.output = structuredClone(result);
          return result;
        } catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
      },
    }, search: { search: forbidden, extract: forbidden }, capture: { capture: forbidden }, vision: { interpret: forbidden },
    speech: { speak: async text => { if (!setup) speech.push(text); }, stop: async () => {} },
    previewTool: async (call: ToolCall, validation) => {
      const entry: any = { call: structuredClone(call), validation: structuredClone(validation), simulated: true, executed: false };
      toolEvents.push(entry);
      try { const result = fixtureToolResult(call, validation, item); entry.result = structuredClone(result); return result; }
      catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
    },
    onEvent: event => { if (!setup && event.type !== "record") events.push(structuredClone(event)); },
  });
  try {
    await agent.initialize();
    await agent.startSession();
    await agent.submitText("Moo");
    await agent.drain();
    const state = agent.getState();
    if (!state.conversationId) throw new Error("Fixture setup did not open a conversation");
    row.conversationId = state.conversationId;
    for (const [index, message] of item.providerInput.conversation.entries()) {
      const segment: Segment = { id: opaque(`${prefix}:context:${index}`), turnId: opaque(`${prefix}:context-turn:${index}`),
        revision: 1, speaker: message.role, text: message.content, final: true, createdAt: timestamp };
      await agent.ingest(segment);
    }
    await seedResponseExperiment(brain, state.conversationId, {
      priorTools: item.providerInput.priorToolEvents, currentTools: item.providerInput.currentToolEvents,
    });
    row.evidenceBeforeCorrection = await readResponseEvidence(brain, state.conversationId);
    for (const note of changed) {
      await brain.upsertSegment(note.id, { id: `${note.id}:source`, turnId: `${note.id}:source`, revision: 2,
        speaker: "user", text: note.text, final: true, createdAt: timestamp });
    }
    row.before = agent.getState();
    setup = false;
    await agent.submitText(item.providerInput.latestRequest);
    await agent.drain();
    row.after = agent.getState();
    row.evidenceAfter = await readResponseEvidence(brain, state.conversationId);
    row.records = await brain.listRecords();
    row.operations = await brain.listOperations();
    row.finalAnswer = speech.join("\n");
    row.generationCalls = generationCalls;
    row.status = row.after.lastError ? "unresolved" : "completed";
    row.sourceRetained = row.records.some((r: BrainRecord) => r.id === state.sessionId && r.segments.some(s => s.text === item.providerInput.latestRequest));
    const beforeRestart = JSON.stringify(row.records);
    await brain.close();
    brain = new SQLiteBrain(brainPath);
    row.restartRetained = beforeRestart === JSON.stringify(await brain.listRecords());
    row.restartEvidenceRetained = JSON.stringify(row.evidenceAfter) === JSON.stringify(await readResponseEvidence(brain, state.conversationId));
  } catch (error) { row.status = "failed"; row.error = error instanceof Error ? error.message : String(error); }
  finally { await brain.close(); await save(); }
}

try {
  const schedule = [...manifest.agentCases.map((c: any) => ({ item: c, repeat: 0 })),
    ...manifest.agentRepeats.map((id: string) => ({ item: manifest.agentCases.find((c: any) => c.id === id), repeat: 1 }))];
  for (const [index, { item, repeat }] of schedule.entries()) {
    const profiles = [..."ABCDE"].map((_, offset) => "ABCDE"[(index + offset) % 5]!);
    for (const profile of profiles) {
      await runAgent(item, profile, repeat);
      console.log(JSON.stringify({ phase: "agent", id: item.id, profile, repeat, status: agentCases.at(-1)?.status, generationCalls: agentCases.at(-1)?.generationCalls }));
      if (calls.some(c => c.status === "bridge_failed_unknown_charge")) throw new Error("Bridge evidence incomplete; stop paid dispatch");
    }
  }
  const ocrManifest = JSON.parse(await readFile(path.join(root, "experiments/fixtures/agent-reliability-ocr/manifest.json"), "utf8"));
  const imageSchedule = [...fixtures.images.map((item: any) => ({ item, repeat: 0 })),
    ...ocrManifest.repeats.map((id: string) => ({ item: fixtures.images.find((c: any) => c.id === id), repeat: 1 }))];
  for (const [index, { item, repeat }] of imageSchedule.entries()) {
    const order = [..."ABDE"].map((_, offset) => "ABDE"[(index + offset) % 4]!);
    for (const profile of order) {
      const row: any = { id: item.id, profile, repeat, sha256: item.sha256, expected: item.expected };
      images.push(row);
      try {
        const result = await invoke("vision", item.id, profile, repeat, 0, { imageId: item.id, question: item.extractionPrompt }, () => ({ text: JSON.stringify(item.expected) }));
        row.raw = result.text;
        row.scoring = scoreOcr(item.expected, result.text);
        row.validated = row.scoring.normalized;
        row.status = "completed";
        if (profile === "B") images.push({ ...structuredClone(row), profile: "C", reusedFrom: { profile: "B", id: item.id, repeat }, additionalVisionCalls: 0 });
      } catch (error) { row.status = "failed"; row.error = error instanceof Error ? error.message : String(error); }
      await save();
      console.log(JSON.stringify({ phase: "vision", id: item.id, profile, repeat, status: row.status }));
      if (calls.some(c => c.status === "bridge_failed_unknown_charge")) throw new Error("Bridge evidence incomplete; stop paid dispatch");
    }
  }
  for (const item of manifest.ocrFollowThrough) {
    const image = images.find(row => row.id === item.imageId && row.profile === "B" && row.repeat === 0);
    for (const profile of ["raw", "validated"]) {
      const row: any = { imageId: item.imageId, profile, question: item.question };
      followThrough.push(row);
      if (!image?.raw) { row.status = "skipped_no_evidence"; continue; }
      // The validated consumer sees only usable observations, not the contradictory raw values.
      const evidence = profile === "raw" ? image.raw : JSON.stringify({ observations: image.validated.observations,
        interpretations: image.validated.interpretations, issues: image.validated.issues, valid: image.validated.valid });
      try {
        const result = await invoke("followthrough", item.imageId, profile, 0, 0, { evidence }, () => ({ text: "Fixture: the requested value is unavailable." }));
        row.output = result; row.status = "completed";
      } catch (error) { row.status = "failed"; row.error = error instanceof Error ? error.message : String(error); }
      await save();
    }
  }
  for (const item of manifest.j7Cases) {
    const row: any = { id: item.id, expected: item.expected, providerInput: item.providerInput };
    tags.push(row);
    try {
      row.output = await invoke("tag", item.id, "current", 0, 0, item.providerInput, () => ({ purpose: item.expected.purpose,
        purposeConfidence: 1, topics: {}, faithful: item.expected.faithful ? 1 : 0,
        understandable: item.expected.understandable ? 1 : 0, doubt: item.expected.doubt ? 1 : 0,
        ...(item.expected.relevant === null ? {} : { relevant: item.expected.relevant ? 1 : 0 }) }));
      row.status = "completed";
    } catch (error) { row.status = "failed"; row.error = error instanceof Error ? error.message : String(error); }
    await save();
    console.log(JSON.stringify({ phase: "tag", id: item.id, status: row.status }));
  }
  report.complete = true;
} catch (error) { report.fatalError = error instanceof Error ? error.message : String(error); }
finally {
  const current = JSON.parse(await readFile(path.join(root, ".data/provider-validation.json"), "utf8"));
  const afterCents = current.calls.reduce((sum: number, e: any) => sum + Math.round(Number(e.reservedUsd) * 100), 0);
  report.newReservationUsd = ((afterCents - beforeCents) / 100).toFixed(2);
  report.cumulativeReservationUsd = (afterCents / 100).toFixed(2);
  report.cumulativeCalls = current.calls.length;
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ output, complete: report.complete, fatalError: report.fatalError,
    calls: calls.length, newReservationUsd: report.newReservationUsd, cumulativeReservationUsd: report.cumulativeReservationUsd }));
}
