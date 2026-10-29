import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Agent } from "../../../packages/agent/src/index.js";
import { FixtureProviders } from "../../../packages/agent-host/src/providers.js";
import { MemoryBrain } from "../../../packages/brain/src/memory.js";
import type { BrainRecord, RouteInput, Segment, ThoughtInput, ThoughtResult } from "../../../packages/contracts/src/index.js";
import { checkSeed, decodeBase64, encodeBase64, importSeed, parseSeed, seedOffsetMs, shiftIsoTimestamps } from "../src/seed.js";
import type { SeedFile } from "../src/types.js";
import { callTotal, countCalls, generateSeed, shiftBefore } from "../scripts/generate-seed.js";

const DAY = 86_400_000;
const segment = (id: string, createdAt: string, speaker: Segment["speaker"] = "user", text = `${id} text`): Segment =>
  ({ id, turnId: `turn-${id}`, revision: 1, speaker, text, final: true, createdAt });
const record = (id: string, overrides: Partial<BrainRecord> = {}): BrainRecord => ({
  id, kind: "dictation", revision: 1, sourceRevision: 1, createdAt: "2026-10-27T08:00:00.000Z", updatedAt: "2026-10-27T08:00:00.000Z",
  segments: [], title: `${id} title`, summary: `${id} summary`, topics: [], quality: "ready", qualityReasons: [], doubt: false,
  links: [], attachmentIds: [], manualFields: [], acceptedRevision: 0, ...overrides,
});
const note = (id: string, session: string, overrides: Partial<BrainRecord> = {}) => record(id, {
  thoughtStatus: "settled", connectionStatus: "no_match", sources: [{ recordId: session, spans: [] }],
  links: [{ targetId: session, provenance: "source" }], ...overrides,
});
/** Two sessions a day apart, each the hub of two settled notes, and a worksheet conversation. */
function seed(): SeedFile {
  const session = (id: string, day: string, extra: Segment[] = []) => record(id, {
    kind: "session", title: "", summary: "", quality: "pending", createdAt: `${day}T07:59:00.000Z`, updatedAt: `${day}T08:10:00.000Z`,
    segments: [segment(`${id}-a`, `${day}T08:00:00.000Z`), segment(`${id}-b`, `${day}T08:05:00.000Z`), ...extra],
  });
  const answer = segment("answer", "2026-10-27T08:06:00.000Z", "assistant", "The worksheet gives c2 = 0.50 mol/L, so V2 for trial B is 60.0 mL.");
  return {
    version: 1, generatedAt: "2026-10-28T08:20:00.000Z",
    records: [
      session("s1", "2026-10-27", [answer]), session("s2", "2026-10-28"),
      record("talk", { kind: "conversation", sourceOnly: true, quality: "pending", attachmentIds: ["sheet"], segments: [answer] }),
      note("dilution", "s1", { attachmentIds: ["sheet"], links: [{ targetId: "s1", provenance: "source" }, { targetId: "talk", provenance: "source" }] }),
      note("volumes", "s1"),
      note("osmosis", "s2", { connectionStatus: "connected", links: [{ targetId: "s2", provenance: "source" },
        { targetId: "dilution", provenance: "suggested", decision: "accepted", confidence: 0.9 }] }),
      note("cells", "s2", { updatedAt: "2026-10-28T08:15:00.000Z" }),
    ],
    attachments: [{ id: "sheet", mimeType: "image/png", base64: encodeBase64(new Uint8Array([137, 80, 78, 71, 13, 10])) }],
  };
}
const edit = (change: (value: SeedFile) => void) => { const value = seed(); change(value); return value; };
const find = (value: SeedFile, id: string) => value.records.find(item => item.id === id)!;
/** The zone's wall clock, read independently of the code under test. */
function local(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}
const yesterday = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
function timestamps(value: unknown): number[] {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) ? [Date.parse(value)] : [];
  if (value && typeof value === "object") return Object.values(value).flatMap(timestamps);
  return [];
}

test("parseSeed accepts exactly the seed shape", () => {
  const good = JSON.parse(JSON.stringify(seed()));
  assert.equal(parseSeed(good), good);
  const bad: [unknown, RegExp][] = [
    [null, /Invalid seed file/], [[], /Invalid seed file/], [{ ...good, state: {} }, /Invalid seed file/], [{ ...good, operations: [] }, /Invalid seed file/],
    [{ ...good, version: 2 }, /Invalid seed file/], [{ ...good, generatedAt: "yesterday" }, /Invalid seed file/], [{ ...good, records: {} }, /Invalid seed file/],
    [{ version: 1, generatedAt: good.generatedAt, records: [] }, /Invalid seed file/],
    [{ ...good, records: [{ ...good.records[0], quality: "great" }] }, /Invalid seed record: Invalid record/],
    [{ ...good, records: [...good.records, good.records[0]] }, /Duplicate seed record: s1/],
    [{ ...good, attachments: [{ ...good.attachments[0], size: 6 }] }, /Invalid seed attachment/],
    [{ ...good, attachments: [{ ...good.attachments[0], base64: "abc" }] }, /Invalid seed attachment/],
    [{ ...good, attachments: [{ ...good.attachments[0], mimeType: "png" }] }, /Invalid seed attachment/],
    [{ ...good, attachments: [{ ...good.attachments[0], id: "../sheet" }] }, /Unsafe attachment ID/],
    [{ ...good, attachments: [good.attachments[0], good.attachments[0]] }, /Duplicate seed attachment: sheet/],
  ];
  for (const [value, error] of bad) assert.throws(() => parseSeed(value), error);
});

test("checkSeed passes a finished seed and names each way a seed can look broken", () => {
  assert.deepEqual(checkSeed(seed()), []);
  const cases: [SeedFile, RegExp][] = [
    [edit(value => { find(value, "volumes").error = "Connections pending: Backend 502"; }), /dictation volumes has an error/],
    [edit(value => { find(value, "volumes").thoughtStatus = "growing"; }), /volumes is still a growing note/],
    [edit(value => { find(value, "cells").thoughtStatus = "draft"; }), /cells is still a draft note/],
    [edit(value => { find(value, "cells").connectionStatus = "pending"; }), /cells has pending connections/],
    [edit(value => { find(value, "cells").connectionStatus = "failed"; }), /cells has failed connections/],
    [edit(value => { find(value, "cells").quality = "pending"; }), /cells is shown with a pending quality check/],
    [edit(value => { find(value, "osmosis").links.push({ targetId: "gone", provenance: "suggested", decision: "accepted" }); }), /osmosis points to a missing record: gone/],
    [edit(value => { find(value, "cells").sources = [{ recordId: "lost", spans: [] }]; }), /cells points to a missing record: lost/],
    [edit(value => { value.attachments = []; }), /names a missing attachment: sheet/],
    [edit(value => { find(value, "cells").updatedAt = "2026-10-28 08:15"; }), /cells has a timestamp the loader cannot move/],
    [edit(value => { find(value, "talk").segments[0]!.text = "As of 29 October, V2 is 60.0 mL."; }), /Generated text names a date: "29 October"/],
    [edit(value => { find(value, "s1").segments[2]!.text = "Today, 2026-10-29, V2 is 60.0 mL."; }), /Generated text names a date: "2026-10-29"/],
    [edit(value => { find(value, "dilution").summary = "Reviewed on Thursday."; }), /Generated text names a date: "Thursday"/],
    [edit(value => { find(value, "cells").kind = "session"; }), /The Brain shows 1 session hubs, not 2/],
    [edit(value => { find(value, "cells").archived = true; }), /The Brain shows 1 session hubs, not 2/],
    [edit(value => { find(value, "volumes").revision = -1; }), /Record volumes: Invalid record/],
    [edit(value => { value.records.push(record("cells")); }), /Record IDs repeat/],
  ];
  for (const [value, problem] of cases) assert.ok(checkSeed(value).some(text => problem.test(text)), `${problem}: ${JSON.stringify(checkSeed(value))}`);
  // Retained transcripts and sessions are never assessed, so their quality stays pending without a problem.
  assert.deepEqual(checkSeed(edit(value => { find(value, "talk").quality = "pending"; find(value, "s2").quality = "pending"; })), []);
});

test("shiftIsoTimestamps moves only strings that are exactly a UTC timestamp", () => {
  const input = {
    at: "2026-10-28T08:00:00Z", precise: "2026-10-28T08:00:00.123Z", micro: "2026-10-28T08:00:00.123456Z",
    list: ["2026-10-28T08:00:00.000Z", 5, null, true],
    left: { text: "Saved at 2026-10-28T08:00:00Z.", day: "2026-10-28", zoned: "2026-10-28T08:00:00+08:00", padded: " 2026-10-28T08:00:00Z", newline: "2026-10-28T08:00:00Z\n" },
    "2026-10-28T08:00:00Z": "a key is not a value",
  };
  const before = structuredClone(input);
  const output = shiftIsoTimestamps(input, -DAY);
  assert.deepEqual(input, before, "the input is not changed");
  assert.deepEqual(output, {
    at: "2026-10-27T08:00:00.000Z", precise: "2026-10-27T08:00:00.123Z", micro: "2026-10-27T08:00:00.123Z",
    list: ["2026-10-27T08:00:00.000Z", 5, null, true], left: input.left, "2026-10-28T08:00:00Z": "a key is not a value",
  });
  assert.notEqual(output.left, input.left, "a deep copy");
  assert.deepEqual(shiftIsoTimestamps(input, 0), input);
});

test("seedOffsetMs starts the latest session at 16:00 yesterday in the visitor's zone, never in the future", () => {
  const zones = ["Asia/Singapore", "Europe/London", "America/Los_Angeles", "America/St_Johns", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"];
  // Around midnight, across both daylight-saving changes, and on the days after them.
  const nows = ["2026-10-29T03:00:00.000Z", "2026-10-29T15:59:30.000Z", "2026-10-29T23:45:00.000Z", "2026-11-01T10:30:00.000Z",
    "2026-11-02T08:00:00.000Z", "2027-03-28T00:30:00.000Z", "2027-03-29T12:00:00.000Z", "2027-03-15T07:00:00.000Z"];
  const value = seed();
  for (const timeZone of zones) for (const now of nows) {
    const shifted = shiftIsoTimestamps(value, seedOffsetMs(value, new Date(now), timeZone));
    const start = local(Date.parse(find(shifted, "s2").createdAt), timeZone);
    assert.deepEqual(start, { day: yesterday(local(Date.parse(now), timeZone).day), time: "16:00:00" }, `${timeZone} at ${now}`);
    assert.ok(Math.max(...timestamps(shifted)) <= Date.parse(now), `${timeZone} at ${now}: nothing after now`);
    assert.ok(Date.parse(find(shifted, "s1").createdAt) < Date.parse(find(shifted, "s2").createdAt) - 23 * 3_600_000, "session 1 stays a day earlier");
  }
  // A seed whose work ran on long after its last session started is held back to now instead.
  const late = edit(item => { find(item, "cells").updatedAt = "2026-10-30T12:00:00.000Z"; });
  const now = new Date("2026-10-29T03:00:00.000Z");
  const shifted = shiftIsoTimestamps(late, seedOffsetMs(late, now, "Asia/Singapore"));
  assert.equal(find(shifted, "cells").updatedAt, now.toISOString());
  assert.ok(Date.parse(find(shifted, "s2").createdAt) < Date.parse("2026-10-28T08:00:00.000Z"), "the latest session starts before 16:00 yesterday");
  const sessionless = edit(item => { item.records = item.records.filter(entry => entry.kind !== "session"); });
  assert.ok(seedOffsetMs(sessionless, now, "UTC") <= now.getTime() - Date.parse(sessionless.generatedAt));
});

test("base64 round-trips bytes without Buffer, beyond one chunk", () => {
  for (const length of [0, 1, 2, 3, 4, 0x8000, 100_003]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) % 256);
    const text = encodeBase64(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64"));
    assert.deepEqual(decodeBase64(text), bytes);
  }
});

test("importSeed loads records and attachments into a fresh MemoryBrain without history, state or operations", async () => {
  const value = seed();
  const brain = new MemoryBrain();
  await importSeed(brain, value);
  assert.deepEqual(await brain.listRecords(), value.records);
  assert.deepEqual(await brain.getAttachment("sheet"), { mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 13, 10]) });
  assert.deepEqual((await brain.history("dilution")).map(entry => [entry.reason, entry.at]), [["import", "2026-10-27T08:00:00.000Z"]]);
  assert.deepEqual(await brain.listOperations(), []);
  assert.equal(await brain.getState("agent"), undefined);
});

test("the generator's piecewise shift moves only what came before session 2", () => {
  const value = { early: "2026-10-28T08:00:00.000Z", edge: "2026-10-28T08:59:59.999Z", start: "2026-10-28T09:00:00.000Z", late: "2026-10-28T09:30:00Z",
    text: "2026-10-28T08:00:00.000Z was early", nested: [{ at: "2026-10-28T07:00:00Z" }] };
  assert.deepEqual(shiftBefore(value, "2026-10-28T09:00:00.000Z", -DAY), { early: "2026-10-27T08:00:00.000Z", edge: "2026-10-27T08:59:59.999Z",
    start: "2026-10-28T09:00:00.000Z", late: "2026-10-28T09:30:00Z", text: "2026-10-28T08:00:00.000Z was early", nested: [{ at: "2026-10-27T07:00:00.000Z" }] });
});

test("the generator's call counter names endpoints and refuses calls past its limit", async () => {
  const calls = new Map<string, number>();
  const target = { forwarded: 0, label: "plain", async route() { this.forwarded++; return "routed"; }, async interpret() { this.forwarded++; return "read"; } };
  const counted = countCalls(target, calls, 2);
  assert.equal(counted.label, "plain");
  assert.equal(await counted.route(), "routed");
  assert.equal(await counted.interpret(), "read");
  assert.throws(() => counted.route(), /more than 2 provider calls/);
  assert.equal(target.forwarded, 2, "the refused call is never sent");
  assert.deepEqual([...calls], [["route", 2], ["vision", 1]]);
  assert.equal(callTotal(calls), 3);
});

/** A fresh Agent on a loaded seed, started as the page starts it: the provider calls it made, and its Brain. */
async function startOn(seed: SeedFile) {
  const brain = new MemoryBrain();
  await importSeed(brain, seed);
  const calls = new Map<string, number>();
  const providers = countCalls(new FixtureProviders(), calls);
  const agent = new Agent({ brain, decisions: providers, generation: providers, search: providers, vision: providers,
    capture: { capture: async () => { throw Error("No capture while loading"); } }, speech: { speak: async () => {}, stop: async () => {} },
    id: () => crypto.randomUUID(), now: () => new Date().toISOString(), timeZone: "Europe/London" });
  await agent.initialize();
  await agent.startSession();
  await agent.drain();
  return { brain, calls };
}

const COMMITTED = new URL("../public/seed.json", import.meta.url);
// The paid generator writes it once. Until then a local run skips this, but CI never passes without it: the page can't
// start without its sample sessions, and a seed forced past checkSeed (generate-seed --force) fails here.
test("the committed seed loads, passes checkSeed, and a fresh Agent on it makes no provider call",
  { skip: !existsSync(COMMITTED) && !process.env.CI && "apps/web/public/seed.json is not generated yet" }, async () => {
    assert.ok(existsSync(COMMITTED), "apps/web/public/seed.json is missing: generate it (apps/web/scripts/generate-seed.ts) and commit it");
    const loaded = parseSeed(JSON.parse(await readFile(COMMITTED, "utf8")));
    const now = new Date();
    const shifted = shiftIsoTimestamps(loaded, seedOffsetMs(loaded, now, "Europe/London"));
    assert.deepEqual(checkSeed(shifted), []);
    const latest = shifted.records.filter(item => item.kind === "session").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    assert.deepEqual(local(Date.parse(latest.createdAt), "Europe/London"), { day: yesterday(local(now.getTime(), "Europe/London").day), time: "16:00:00" });
    assert.ok(Math.max(...timestamps(shifted)) <= now.getTime(), "nothing in the seed lands in the future");
    const { brain, calls } = await startOn(shifted);
    assert.deepEqual([...calls], [], "loading the seed makes no provider call");
    assert.equal((await brain.listRecords()).length, shifted.records.length + 1, "the seed plus the visitor's new session");
  });

/** The stock fixtures count only "don't understand why" as a stated doubt; Jev also reads the seed's "I'm stuck on trial B…" as one. */
class SeedFixtures extends FixtureProviders {
  override async route(input: RouteInput) {
    const decision = await super.route(input);
    return decision.route === "dictate" && /^I[’']m stuck on\b/i.test(input.text) ? { ...decision, doubt: 1 } : decision;
  }
}

/** Fixtures that file each spoken line as its own settled note, so both sessions grow the two notes a hub needs. */
class LineFixtures extends SeedFixtures {
  override async consolidate(input: ThoughtInput): Promise<ThoughtResult> {
    return { remainder: [], groups: input.segments.map(item => ({ title: item.text.trim().slice(0, 60) || "Saved thought", summary: item.text.trim() || "Saved thought",
      spans: [{ segmentId: item.id, revision: item.revision, start: 0, end: item.text.length }] })) };
  }
}

// Settling between topics gives each session at least two notes, so even the stock fixtures make a seed checkSeed passes.
for (const [name, fixtures, problems] of [["SeedFixtures", SeedFixtures, []], ["LineFixtures", LineFixtures, []]] as const) {
  test(`a seed generated with ${name} loads, and a fresh Agent on it makes no provider call`, async () => {
    const worksheet = new Uint8Array(await readFile(new URL("../public/sample-worksheet.png", import.meta.url)));
    const generated = await generateSeed({ providers: new fixtures(), worksheet, limit: Infinity, pauseMs: 5 });
    assert.deepEqual(generated.problems, problems);
    assert.equal(generated.calls.get("vision"), 1, "Moo read the worksheet once");
    const sessions = generated.seed.records.filter(item => item.kind === "session").map(item => Date.parse(item.createdAt)).sort();
    assert.equal(sessions.length, 2);
    assert.ok(sessions[1]! - sessions[0]! >= DAY, "session 1 was moved to the day before");
    const loaded = parseSeed(JSON.parse(JSON.stringify(generated.seed)));
    const now = new Date();
    const shifted = shiftIsoTimestamps(loaded, seedOffsetMs(loaded, now, "Europe/London"));
    assert.deepEqual(checkSeed(shifted), problems);
    const latest = shifted.records.filter(item => item.kind === "session").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    assert.deepEqual(local(Date.parse(latest.createdAt), "Europe/London"), { day: yesterday(local(now.getTime(), "Europe/London").day), time: "16:00:00" });

    const { brain, calls } = await startOn(shifted);
    assert.deepEqual([...calls], [], "loading the seed makes no provider call");
    assert.equal((await brain.listRecords()).length, shifted.records.length + 1, "the seed plus the visitor's new session");
    const [attachment] = shifted.attachments;
    assert.deepEqual((await brain.getAttachment(attachment!.id))?.bytes, worksheet);
  });
}
