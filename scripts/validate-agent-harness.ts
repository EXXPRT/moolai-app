/** Reproducible Agent/harness comparison. No flags means a no-write, no-call preview. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, seedResponseExperiment, readResponseEvidence } from "../packages/agent/src/index.js";
import { nativeResponseRunner, type ResponseRunner } from "../packages/agent/src/response-runner.js";
import { SQLiteBrain } from "../packages/brain/src/index.js";
import type { AgentReply, ChatMessage, Segment, ToolCall } from "../packages/contracts/src/index.js";
import { createPiRunner, createDshRunner } from "../experiments/harness-comparison/src/index.js";
// @ts-expect-error Fixture helpers are independently tested JavaScript.
import { loadHarnessFixtures, harnessToolResult, reviewPreparation } from "./harness-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const option = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const mode = has("--live") ? "live" : has("--offline") ? "offline" : "preview";
if (has("--live") && has("--offline")) throw new Error("Choose live or offline");
if (mode === "live" && !has("--allow-paid")) throw new Error("Explicit --allow-paid is required");
const { cases: corpus, casesSha256 } = await loadHarnessFixtures();
const EXPERIMENT = "agent_harness_v1";
if (mode === "preview") {
  console.log(JSON.stringify({ mode, paidCalls: 0, casesSha256, budget: corpus.budget, models: corpus.models,
    cases: corpus.agentCases.map((c: any) => ({ id: c.id, request: c.providerInput.latestRequest, expected: c.expected })),
    repeats: corpus.agentRepeats }, null, 2));
  process.exit(0);
}
const runId = option("--run-id") ?? `harness-${mode}-${randomUUID()}`;
if (!/^[a-z0-9-]{1,100}$/.test(runId)) throw new Error("Invalid run ID");
const directory = path.join(root, ".data/validation", runId);
if (await access(directory).then(() => true, () => false)) throw new Error("Existing run is immutable; choose a new directory (paid IDs still cannot repeat)");
await mkdir(directory, { recursive: true, mode: 0o700 });
const output = path.join(directory, "report.json");
const freezePath = path.join(directory, "freeze.json");
const python = path.join(root, "backend/.venv/bin/python");
const bridge = path.join(root, "scripts/harness-provider.py");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const opaque = (value: string) => `r-${hash(value).slice(0, 18)}`;
const at = "2026-09-21T08:00:00.000Z";
const calls: any[] = [], compatibility: any[] = [], agentCases: any[] = [];
const report: any = { experiment: EXPERIMENT, version: 1, mode, startedAt: new Date().toISOString(), complete: false,
  productionDefaultsChanged: false, syntheticOnly: true, microphoneUsed: false, realTasksExecuted: false,
  calls, compatibility, agentCases, budget: corpus.budget, casesSha256, retries: 0,
  limitations: ["Eight unique cases; repeats are consistency checks, not independent examples.",
    "Shared six-call allowance and 4000-token output cap differ from the prior two-call experiment.",
    "H0 retains its existing prompts, evidence policy and loop behavior with the common synthetic tool allowlist.",
    "H1-H3 compare configured harnesses using the same revised policy; frameworks alone are not the intervention.",
    "Other Jev gates, enrichment and speech are fixtures. No microphone, OCR, web or real tasks.",
    "Provider-default reasoning is not an equal-compute comparison; reservations are not invoices."] };
let saving = Promise.resolve();
async function save() {
  const snapshot = JSON.stringify(report, null, 2) + "\n";
  const next = saving.then(async () => {
    await writeFile(`${output}.tmp`, snapshot, { mode: 0o600 });
    await rename(`${output}.tmp`, output);
  });
  saving = next.catch(() => {});
  await next;
}
async function providerProcess(parameters: string[], input?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [bridge, ...parameters], { cwd: root, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.stdout.on("data", data => { stdout += data.toString(); if (stdout.length > 2_000_000) child.kill("SIGTERM"); });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Provider bridge exited ${code}; do not retry. ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid bridge evidence; do not retry")); }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function filesBelow(relative: string): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const lists = await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesBelow(`${relative}/${entry.name}`) : Promise.resolve([`${relative}/${entry.name}`])));
  return lists.flat();
}
const sources = ["scripts/validate-agent-harness.ts", "scripts/harness-provider.py", "scripts/harness-fixtures.mjs",
  "scripts/validate-j1.py", "experiments/fixtures/agent-harness-cases.json", "packages/contracts/src/index.ts",
  "packages/agent/src/index.ts", "packages/agent/src/reliability.ts", "packages/agent/src/harness-evidence.ts",
  "packages/agent/src/response-runner.ts", "packages/agent/src/tools.ts", "packages/brain/src/records.ts",
  "packages/brain/src/sqlite.ts", "backend/moolai_backend/providers.py", "backend/moolai_backend/schemas.py",
  "backend/moolai_backend/validate_live.py", "experiments/harness-comparison/package.json",
  "experiments/harness-comparison/package-lock.json", ...await filesBelow("experiments/harness-comparison/src")];
const sourceHashes: Record<string, string> = {};
for (const relative of sources) sourceHashes[relative] = hash(await readFile(path.join(root, relative)));
report.sourceHashes = sourceHashes;
report.preflight = mode === "live" ? await providerProcess(["--preflight"]) : { mode: "offline", at: new Date().toISOString(), inferenceCalls: 0 };
const ledger = JSON.parse(await readFile(path.join(root, ".data/provider-validation.json"), "utf8"));
const before = ledger.calls.reduce((sum: number, entry: any) => sum + Math.round(Number(entry.reservedUsd) * 100), 0);
report.budgetBeforeUsd = (before / 100).toFixed(2);
if (mode === "live" && before + 992 > 2587) throw new Error("Full comparison cannot fit the cumulative ceiling");
await writeFile(freezePath, JSON.stringify({ experiment: EXPERIMENT, sourceHashes, preflight: report.preflight,
  settings: { temperature: 0.2, reasoning: "provider-default", maxCompletionTokens: 4000, maximumWireBytes: 12000 },
  rubric: corpus.scoringPolicy }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await save();

async function invoke(phase: string, caseId: string, profile: string, modelProfile: string, repeat: number, step: number,
  input: unknown, offline: () => AgentReply): Promise<AgentReply> {
  const callId = `${EXPERIMENT}:${phase}:${caseId}:${profile}:${modelProfile}:${repeat}:${step}`;
  if (calls.some(call => call.callId === callId)) throw new Error("Duplicate logical request");
  const request = { callId, phase, caseId, profile, modelProfile, repeat, step, input: structuredClone(input) };
  const entry: any = { ...request, status: "prepared" };
  calls.push(entry); await save();
  if (mode === "live") {
    try { Object.assign(entry, await providerProcess(["--call", "--freeze", freezePath], request)); }
    catch (error) { entry.status = "bridge_failed_unknown_charge"; entry.error = String(error); await save(); throw error; }
  } else Object.assign(entry, { status: "fixture", output: offline(), elapsedMs: 0, reservedUsd: "0" });
  await save();
  if (!["succeeded", "fixture"].includes(entry.status)) throw new Error(entry.error ?? "Provider failure; no retry");
  return entry.output;
}
const runners = (profile: string, suffix: string): ResponseRunner => profile === "H2" ? createPiRunner()
  : profile === "H3" ? createDshRunner({ directory: path.join(directory, "framework", suffix) }) : nativeResponseRunner;
const cells = corpus.profiles.flatMap((p: any) => ["super", "ultra"].map(modelProfile => ({ profile: p.id, modelProfile })));

async function qualify(profile: string, modelProfile: string) {
  const started = performance.now();
  const row: any = { profile, modelProfile, status: "started", toolEvents: [] };
  compatibility.push(row);
  let used = 0;
  try {
    const runner = runners(profile, `compatibility-${profile}-${modelProfile}`);
    const result = await runner.run({ messages: [
      { role: "system", content: "This is a transport compatibility check. Use read_note to obtain the requested marker; do not guess." },
      { role: "user", content: "Read note compatibility-note, then report its calibration marker." },
    ], signal: new AbortController().signal, maxSteps: 2,
    prepare: async (messages, step) => ({ messages, tools: step === 0 ? [{ name: "read_note", description: "Read the requested fixture note.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }] : [],
      responseMode: step === 0 ? "auto" : "answer_only" }),
    generate: async (frame, step) => {
      if (step !== used || used >= 2) throw new Error("Compatibility call limit");
      used++;
      return invoke("compatibility", "compatibility", profile, modelProfile, 0, used, frame, () => step === 0
        ? { text: "", toolCalls: [{ id: "compat-call", name: "read_note", arguments: { id: "compatibility-note" } }] }
        : { text: "The calibration marker is 73.", toolCalls: [] });
    },
    execute: async call => {
      if (used !== 1 || call.name !== "read_note" || call.arguments.id !== "compatibility-note" || row.toolEvents.length)
        throw new Error("Unexpected compatibility tool");
      row.toolEvents.push({ call, simulated: true, executed: false });
      return { status: "success", record: { id: "compatibility-note", marker: 73 }, previewOnly: true, executed: false };
    }, checkpoint: async () => {},
    });
    row.result = result; row.calls = used;
    row.status = used === 2 && row.toolEvents.length === 1 && result.stopReason === "answered" &&
      /\b73\b/.test(result.reply?.text ?? "") && !result.reply?.toolCalls.length && !result.reply?.controlProposal ? "qualified" : "incomplete";
  } catch (error) { row.status = "incomplete"; row.error = error instanceof Error ? error.message : String(error); row.calls = used; }
  row.wallMs = Math.round(performance.now() - started);
  await save();
  console.log(JSON.stringify({ phase: "compatibility", profile, modelProfile, status: row.status, calls: used }));
  return row.status === "qualified";
}
const forbidden = async (): Promise<never> => { throw new Error("Real capability forbidden in harness comparison"); };
async function runAgent(item: any, profile: string, modelProfile: string, repeat: number) {
  const started = performance.now();
  const identity = `${item.id}:${profile}:${modelProfile}:${repeat}`;
  const brainPath = path.join(directory, "brains", opaque(identity));
  let brain = new SQLiteBrain(brainPath);
  let sequence = 0, used = 0;
  const speech: string[] = [], toolEvents: any[] = [];
  const row: any = { id: item.id, profile, modelProfile, repeat, scenario: item.scenario, expected: item.expected,
    providerInput: item.providerInput, toolEvents, status: "started" };
  agentCases.push(row);
  const sessionId = opaque(identity + ":session"), conversationId = opaque(identity + ":conversation");
  try {
    await brain.createRecord({ id: sessionId, kind: "session", createdAt: at });
    await brain.createRecord({ id: conversationId, kind: "conversation", createdAt: at });
    const oldNotes = new Map<string, any>();
    for (const event of item.providerInput.priorToolEvents) {
      for (const note of event.result?.results ?? []) oldNotes.set(note.id, note);
      if (event.result?.record) oldNotes.set(event.result.record.id, event.result.record);
    }
    const changed: any[] = [];
    for (const note of item.providerInput.notes) {
      const old = oldNotes.get(note.id)?.original;
      await brain.createRecord({ id: note.id, kind: "note", createdAt: at });
      const saved = await brain.upsertSegment(note.id, { id: `${note.id}:source`, turnId: `${note.id}:source`, revision: 1,
        speaker: "user", text: old ?? note.text, final: true, createdAt: at });
      await brain.updateRecord(note.id, saved.revision, { title: note.title });
      if (old && old !== note.text) changed.push(note);
    }
    for (const [index, message] of item.providerInput.conversation.entries()) {
      const segment: Segment = { id: opaque(identity + ":context:" + index), turnId: opaque(identity + ":context:" + index),
        revision: 1, speaker: message.role, text: message.content, final: true, createdAt: at };
      await brain.upsertSegment(conversationId, segment);
      await brain.upsertSegment(sessionId, segment);
    }
    await brain.setState("agent", { sessionId, conversationId, busy: false, listening: true, webAllowed: true });
    await seedResponseExperiment(brain, conversationId, { priorTools: item.providerInput.priorToolEvents, currentTools: item.providerInput.currentToolEvents });
    for (const note of changed) await brain.upsertSegment(note.id, { id: `${note.id}:source`, turnId: `${note.id}:source`, revision: 2,
      speaker: "user", text: note.text, final: true, createdAt: at });
    // Every measured request starts after reopening its durable source/evidence store.
    await brain.close(); brain = new SQLiteBrain(brainPath);
    const agent = new Agent({ brain, id: () => opaque(identity + ":generated:" + ++sequence), now: () => at,
      responseHarness: { runner: runners(profile, opaque(identity)), policy: profile === "H0" ? "current" : "revised" },
      decisions: { route: async () => ({ route: "continue_agent", confidence: 1 }),
        tag: async () => ({ purpose: "Reference", purposeConfidence: 1, topics: {}, doubt: 0, faithful: 1, understandable: 1 }), connect: async () => ({}) },
      generation: { summarize: async () => ({ title: "Fixture", summary: "Fixture" }),
        respond: async (messages, tools, _signal, options) => {
          if (used >= 6) throw new Error("Six-call experiment limit");
          if (!(await brain.getRecord(sessionId))?.segments.some(segment => segment.text === item.providerInput.latestRequest))
            throw new Error("Source missing before generation");
          used++;
          return invoke("agent", item.id, profile, modelProfile, repeat, used,
            { messages, tools, responseMode: options?.responseMode ?? "auto" }, () => used === 1
              ? { text: "", toolCalls: [{ id: opaque(identity + ":offline-tool"), name: "search_notes",
                arguments: { query: item.providerInput.notes[0]?.title ?? "fixture" } }] }
              : { text: "Fixture response only; no real task executed.", toolCalls: [] });
        } },
      search: { search: forbidden, extract: forbidden }, vision: { interpret: forbidden }, capture: { capture: forbidden },
      speech: { speak: async text => { speech.push(text); }, stop: async () => {} },
      previewTool: async (call, validation) => {
        const event: any = { call: structuredClone(call), validation, executed: false, simulated: true };
        toolEvents.push(event);
        try { event.result = harnessToolResult(call, validation, item, profile === "H0" ? {} : { searchExcerptChars: 600 }); return event.result; }
        catch (error) { event.error = String(error); throw error; }
      },
    });
    await agent.initialize();
    const responseStarted = performance.now();
    await agent.submitText(item.providerInput.latestRequest); await agent.drain();
    row.responseWallMs = Math.round(performance.now() - responseStarted);
    row.state = agent.getState(); row.finalAnswer = speech.join("\n"); row.generationCalls = used;
    row.status = row.state.lastError ? "unresolved" : "completed";
    row.trace = await brain.getState(`harness:run:${conversationId}`);
    row.evidence = await readResponseEvidence(brain, conversationId);
    row.records = await brain.listRecords();
    row.sourceRetained = row.records.some((record: any) => record.id === sessionId && record.segments.some((s: any) => s.text === item.providerInput.latestRequest));
    const stateBefore = JSON.stringify(row.records), evidenceBefore = JSON.stringify(row.evidence);
    await brain.close(); brain = new SQLiteBrain(brainPath);
    row.restartRetained = stateBefore === JSON.stringify(await brain.listRecords());
    row.restartEvidenceRetained = evidenceBefore === JSON.stringify(await readResponseEvidence(brain, conversationId));
  } catch (error) { row.status = "failed"; row.error = error instanceof Error ? error.message : String(error); row.generationCalls = used; }
  finally { await brain.close(); row.wallMs = Math.round(performance.now() - started); await save(); }
  console.log(JSON.stringify({ phase: "agent", id: item.id, profile, modelProfile, repeat, status: row.status, calls: used }));
}

try {
  const qualified = new Set<string>();
  for (const cell of cells) {
    if (await qualify(cell.profile, cell.modelProfile)) qualified.add(`${cell.profile}:${cell.modelProfile}`);
    if (calls.some(call => call.status === "bridge_failed_unknown_charge")) throw new Error("Bridge evidence incomplete; stop dispatch");
  }
  const schedule = [...corpus.agentCases.map((item: any) => ({ item, repeat: 0 })),
    ...corpus.agentRepeats.map((id: string) => ({ item: corpus.agentCases.find((c: any) => c.id === id), repeat: 1 }))];
  for (const [index, { item, repeat }] of schedule.entries()) {
    for (let offset = 0; offset < cells.length; offset++) {
      const cell = cells[(index + offset) % cells.length]!;
      if (qualified.has(`${cell.profile}:${cell.modelProfile}`)) await runAgent(item, cell.profile, cell.modelProfile, repeat);
      else agentCases.push({ id: item.id, profile: cell.profile, modelProfile: cell.modelProfile, repeat, status: "incomplete_incompatible", generationCalls: 0 });
      if (calls.some(call => call.status === "bridge_failed_unknown_charge")) throw new Error("Bridge evidence incomplete; stop dispatch");
    }
  }
  report.complete = true;
} catch (error) { report.fatalError = error instanceof Error ? error.message : String(error); }
report.finishedAt = new Date().toISOString();
report.returnedReservationUsd = (calls.reduce((sum, call) => sum + Math.round(Number(call.reservedUsd ?? 0) * 100), 0) / 100).toFixed(2);
// A terminated child may already have reserved money without returning its evidence.
// The durable ledger, not the subprocess response, is authoritative for spend bounds.
const finalLedger = JSON.parse(await readFile(path.join(root, ".data/provider-validation.json"), "utf8"));
const callIds = new Set(calls.map(call => call.callId));
const reservedCents = finalLedger.calls.filter((entry: any) => callIds.has(entry.callId))
  .reduce((sum: number, entry: any) => sum + Math.round(Number(entry.reservedUsd) * 100), 0);
report.reservedUsd = (reservedCents / 100).toFixed(2);
report.cumulativeReservationUsd = (finalLedger.calls.reduce((sum: number, entry: any) => sum + Math.round(Number(entry.reservedUsd) * 100), 0) / 100).toFixed(2);
report.reservationReconciledFromLedger = true;
await save();
const reviewMap: any[] = [], blinded: any[] = [];
for (const row of agentCases) {
  const reviewId = opaque(`${runId}:${row.id}:${row.profile}:${row.modelProfile}:${row.repeat}:blind`);
  reviewMap.push({ reviewId, id: row.id, profile: row.profile, modelProfile: row.modelProfile, repeat: row.repeat });
  const item = corpus.agentCases.find((c: any) => c.id === row.id);
  blinded.push({ reviewId, ...reviewPreparation(item), answer: row.finalAnswer ?? "", status: row.status,
    toolEvents: row.toolEvents ?? [], controllerError: row.state?.lastError ?? row.error ?? null });
}
blinded.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
await writeFile(path.join(directory, "review-map.json"), JSON.stringify(reviewMap, null, 2) + "\n", { mode: 0o600 });
await writeFile(path.join(directory, "blinded-cases.json"), JSON.stringify(blinded, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ report: output, complete: report.complete, calls: calls.length, reservedUsd: report.reservedUsd, fatalError: report.fatalError }));
if (!report.complete) process.exitCode = 1;
