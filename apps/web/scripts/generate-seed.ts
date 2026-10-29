// Writes apps/web/public/seed.json: two study sessions spoken to the real Agent, organized and connected by the
// backend's models. It makes paid calls (about US$0.50), so run it only on purpose, with the backend running:
//   node --env-file=<file with MOOLAI_BACKEND_URL and MOOLAI_BACKEND_TOKEN> --import tsx apps/web/scripts/generate-seed.ts [--force]
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../../packages/agent/src/index.js";
import { BackendProviders } from "../../../packages/agent-host/src/providers.js";
import { MemoryBrain } from "../../../packages/brain/src/memory.js";
import type { BrainPort, DecisionProvider, GenerationProvider, SearchProvider, VisionProvider } from "../../../packages/contracts/src/index.js";
import { filterRecords } from "../../../packages/contracts/src/records.js";
import { sessionHubs } from "../../desktop/src/session-hubs.js";
import { checkSeed, encodeBase64, mapIsoTimestamps } from "../src/seed.js";
import type { SeedAttachment, SeedFile } from "../src/types.js";

export type Providers = DecisionProvider & GenerationProvider & SearchProvider & VisionProvider;
const CALL_LIMIT = 150;
const DAY_MS = 86_400_000;
const ENDPOINTS: Record<string, string> = { interpret: "vision", planThoughts: "plan-thoughts" };

/** One line per spoken turn; SETTLE marks a pause where the current topic note is settled before the next topic.
 * Session 1 is chemistry with a worksheet doubt; session 2, the next day, is osmosis and leans on it. */
export const SETTLE = "";
export const SESSIONS: string[][] = [[
  "Chemistry revision. Concentration is the moles of solute divided by the volume of the solution in litres, so the unit is mol per litre.",
  "So 0.25 moles of sodium chloride made up to 500 millilitres gives 0.5 mol per litre, because 500 millilitres is half a litre.",
  SETTLE,
  "Diluting a solution means adding more solvent. The moles of solute stay the same, only the volume goes up.",
  "That's where c1 V1 equals c2 V2 comes from. Both sides are just the number of moles of solute.",
  "The usual mistake is treating V2 as the water added. V2 is the total final volume, so the water to add is V2 minus V1.",
  SETTLE,
  "In the lab you pipette the stock into a volumetric flask and add water up to the mark, rather than adding a measured volume of water.",
  "Filling to the mark matters because volumes don't always simply add up when solutions mix.",
  SETTLE,
  "Serial dilution repeats the dilution step, so the dilution factors multiply. Two tenfold dilutions in a row make a hundredfold dilution.",
  "So a 1 mol per litre stock becomes 0.01 mol per litre after two tenfold steps.",
  SETTLE,
  "I'm stuck on trial B on this worksheet. I don't get how to use c1, V1 and c2 to find the final volume.",
  "Yes, please.",
  "Moo, for trial B, how much water do I actually need to add?",
  "Moo, finish conversation.",
], [
  "Osmosis is the movement of water across a partially permeable membrane, from the dilute side to the more concentrated side.",
  "It's the same concentration idea as dilution in chemistry. The water moving across dilutes the stronger solution.",
  SETTLE,
  "A hypotonic solution has a lower solute concentration than the cell, so water moves into the cell.",
  "A hypertonic solution has a higher solute concentration, so water moves out. In an isotonic solution there's no net movement.",
  SETTLE,
  "Red blood cells only have a cell membrane, so in pure water they swell and can burst. That's haemolysis.",
  "Plant cells have a cellulose cell wall, so they swell against it and become turgid instead of bursting.",
  "In a hypertonic solution a plant cell loses water and the membrane pulls away from the wall. That's plasmolysis.",
  SETTLE,
  "Pure water has the highest water potential, and adding solute lowers it.",
  "Water moves from higher to lower water potential, which is osmosis described with a number.",
  SETTLE,
  "Moo, why would a red blood cell burst in pure water but a plant cell not?",
  "Moo, finish conversation.",
]];

export const callTotal = (calls: Map<string, number>) => [...calls.values()].reduce((sum, count) => sum + count, 0);
/** Counts every provider call by endpoint. Past `limit` calls it refuses them, so a runaway script stops spending. */
export function countCalls<T extends object>(target: T, calls: Map<string, number>, limit = Infinity): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const name = ENDPOINTS[String(key)] ?? String(key);
        calls.set(name, (calls.get(name) ?? 0) + 1);
        if (callTotal(calls) > limit) throw Error(`Stopped: more than ${limit} provider calls`);
        return value.apply(object, args);
      };
    },
  });
}

/** One study session spoken line by line: each line is a final voice turn, settled and drained before the next. */
export async function runSession(agent: Agent, lines: string[], afterTurn?: (text: string, turnId: string) => Promise<void>,
  afterSettle?: (sessionId: string) => Promise<void>) {
  await agent.startSession();
  const sessionId = agent.getState().sessionId!;
  for (const text of lines) {
    // A settle is the pause between topics: the current note is organized and settled before the next topic starts.
    if (text === SETTLE) { await agent.consolidateThoughts(true); await agent.drain(); await afterSettle?.(sessionId); continue; }
    const turnId = crypto.randomUUID();
    await agent.ingest({ id: crypto.randomUUID(), turnId, revision: 1, speaker: "user", text, final: true, createdAt: new Date().toISOString() });
    await agent.settleTurn(turnId);
    await agent.drain();
    await afterTurn?.(text, turnId);
  }
  await agent.stopSession();
  await agent.drain();
  await afterSettle?.(sessionId);
}

/** Records and the attachments they name, as JSON carries them. No history, state or operations. */
export async function exportSeed(brain: BrainPort, generatedAt = new Date().toISOString()): Promise<SeedFile> {
  const records = JSON.parse(JSON.stringify(await brain.listRecords())) as SeedFile["records"];
  const attachments: SeedAttachment[] = [];
  for (const id of new Set(records.flatMap(record => record.attachmentIds))) {
    const item = await brain.getAttachment(id);
    if (!item) throw Error(`Attachment ${id} is missing from the Brain`);
    attachments.push({ id, mimeType: item.mimeType, base64: encodeBase64(item.bytes) });
  }
  return { version: 1, generatedAt, records, attachments };
}

/** Moves only the timestamps before `cutoff`: run on session 2's start, it puts session 1 on the day before. */
export function shiftBefore<T>(value: T, cutoff: string, offsetMs: number): T {
  const end = Date.parse(cutoff);
  if (!Number.isFinite(end)) throw Error(`Invalid cutoff: ${cutoff}`);
  return mapIsoTimestamps(value, ms => ms < end ? ms + offsetMs : ms);
}

/** Runs both sessions through a real Agent with these providers and returns the seed with what checkSeed finds. */
export async function generateSeed(options: { providers: Providers; worksheet: Uint8Array; limit?: number; pauseMs?: number; log?: (line: string) => void }) {
  const log = options.log ?? (() => {});
  const limit = options.limit ?? CALL_LIMIT;
  const calls = new Map<string, number>();
  const guard = () => { if (callTotal(calls) > limit) throw Error(`Stopped after ${limit} provider calls; nothing was written.`); };
  const providers = countCalls(options.providers, calls, limit);
  const brain = new MemoryBrain();
  // What Moo says and the notices it shows, printed under the turn that caused them.
  const said: string[] = [];
  const flush = () => { for (const line of said.splice(0)) log(`    Moo: ${line}`); };
  const agent = new Agent({
    brain, decisions: providers, generation: providers, search: providers, vision: providers,
    capture: { capture: async () => ({ mimeType: "image/png", bytes: options.worksheet.slice() }) },
    speech: { speak: async () => {}, stop: async () => {} },
    id: () => crypto.randomUUID(), now: () => new Date().toISOString(), timeZone: "Asia/Singapore",
    onEvent: event => { if (event.type === "notice" && event.message) said.push(event.message); },
  });
  await agent.initialize();
  const afterTurn = async (text: string, turnId: string) => {
    const trace = await brain.getState<{ action: string; turnId?: string; route?: string; confidence?: number; doubt?: number }[]>("interaction-trace") ?? [];
    const routed = trace.filter(entry => entry.turnId === turnId && ["route", "filler_ignored", "wake_acknowledged"].includes(entry.action)).at(-1);
    const decision = routed ? [routed.route ?? routed.action, routed.confidence, routed.doubt === undefined ? "" : `doubt ${routed.doubt}`].join(" ").trim() : "not routed";
    log(`  > ${text}\n    ${decision} · ${callTotal(calls)} calls so far`);
    flush();
    guard();
  };
  // An invalid organization (Backend 422) is retried the way Retry organization does, at most twice per settle.
  const retryFailedOrganization = async (sessionId: string) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const buffer = await brain.getState<{ status?: string }>(`thought-buffer:${sessionId}`);
      if (buffer?.status !== "failed") return;
      log(`    organization failed; retry ${attempt}`);
      await agent.retrySummary(sessionId);
      await agent.drain();
      guard();
    }
  };
  for (const [index, lines] of SESSIONS.entries()) {
    // Session 2 starts strictly after everything session 1 wrote, so the day shift splits them cleanly.
    if (index) await new Promise(done => setTimeout(done, options.pauseMs ?? 1000));
    log(`Session ${index + 1}`);
    await runSession(agent, lines, afterTurn, retryFailedOrganization);
    flush();
    guard();
  }
  const sessions = (await brain.listRecords()).filter(record => record.kind === "session").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const seed = shiftBefore(await exportSeed(brain), sessions.at(-1)!.createdAt, -DAY_MS);
  const problems = checkSeed(seed);
  if (!seed.attachments.length) problems.push("Moo never read the sample worksheet");
  return { seed, problems, calls };
}

/** A few lines to read before committing the seed. */
export function seedSummary(seed: SeedFile, calls: Map<string, number>): string[] {
  const kinds = new Map<string, number>();
  for (const record of seed.records) kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
  const visible = filterRecords(seed.records, { kinds: ["note", "dictation", "conversation"] });
  const links = seed.records.flatMap(record => record.links);
  const found = links.filter(link => link.provenance === "suggested" && link.decision === "accepted").length;
  const hubs = sessionHubs(seed.records, visible);
  const review = visible.filter(record => record.quality === "needs_review").length;
  return [
    `Records: ${[...kinds].map(([kind, count]) => `${count} ${kind}`).join(", ")}; ${visible.length} shown in the Brain, ${review} marked Needs review`,
    `Links: ${links.length}, ${found} of them connections Moo found`,
    `Hubs: ${hubs.map(hub => `${hub.label} with ${hub.members.length} notes`).join("; ") || "none"}`,
    `Attachments: ${seed.attachments.length}`,
    `Calls: ${callTotal(calls)} (${[...calls].map(([name, count]) => `${name} ${count}`).join(", ")})`,
  ];
}

async function main() {
  const url = process.env.MOOLAI_BACKEND_URL, token = process.env.MOOLAI_BACKEND_TOKEN;
  if (!url || !token) throw Error("Set MOOLAI_BACKEND_URL and MOOLAI_BACKEND_TOKEN, for example with node --env-file.");
  const backend = new BackendProviders(url, token);
  try {
    const worksheet = new Uint8Array(await readFile(new URL("../public/sample-worksheet.png", import.meta.url)));
    const { seed, problems, calls } = await generateSeed({ providers: backend, worksheet, log: line => console.log(line) });
    for (const line of seedSummary(seed, calls)) console.log(line);
    for (const problem of problems) console.error(`Problem: ${problem}`);
    if (problems.length && !process.argv.includes("--force")) throw Error("seed.json was not written. Run again, or pass --force to write it anyway.");
    await writeFile(new URL("../public/seed.json", import.meta.url), `${JSON.stringify(seed, null, 2)}\n`);
    console.log("Wrote apps/web/public/seed.json");
  } finally { backend.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(() => process.exit(), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
