import type { BrainPort, BrainRecord } from "../../../packages/contracts/src/index.js";
import { attachmentId, filterRecords, validateRecord } from "../../../packages/contracts/src/records.js";
import { sessionHubs } from "../../desktop/src/session-hubs.js";
import type { SeedFile } from "./types.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// A date in Moo's words would contradict the moved timestamps; relative words ("yesterday") stay true.
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE = new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\b|\b${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b`);
/** The notes the Brain workspace lists by default (BrainWorkspace.tsx). */
const VISIBLE: { kinds: BrainRecord["kind"][] } = { kinds: ["note", "dictation", "conversation"] };

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, ...keys: string[]) => Object.keys(value).sort().join() === keys.sort().join();
const timestamp = (value: unknown) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Records and attachments only: history, state or operations in a seed would make loading it call providers. */
export function parseSeed(value: unknown): SeedFile {
  if (!plain(value) || !hasKeys(value, "version", "generatedAt", "records", "attachments") || value.version !== 1 ||
      !timestamp(value.generatedAt) || !Array.isArray(value.records) || !Array.isArray(value.attachments))
    throw Error("Invalid seed file");
  const records = new Set<string>(), attachments = new Set<string>();
  for (const record of value.records as BrainRecord[]) {
    try { validateRecord(record); } catch (error) { throw Error(`Invalid seed record: ${message(error)}`); }
    if (records.has(record.id)) throw Error(`Duplicate seed record: ${record.id}`);
    records.add(record.id);
  }
  for (const item of value.attachments as unknown[]) {
    if (!plain(item) || !hasKeys(item, "id", "mimeType", "base64") || typeof item.id !== "string" || typeof item.mimeType !== "string" ||
        !MIME.test(item.mimeType) || typeof item.base64 !== "string" || !BASE64.test(item.base64))
      throw Error("Invalid seed attachment");
    attachmentId(item.id);
    // MemoryBrain compares a repeated attachment ID with Buffer, which the browser lacks.
    if (attachments.has(item.id)) throw Error(`Duplicate seed attachment: ${item.id}`);
    attachments.add(item.id);
  }
  return value as unknown as SeedFile;
}

/** What would make the loaded demo look broken or unfinished. Empty means the seed is fit to ship. */
export function checkSeed(seed: SeedFile): string[] {
  const problems: string[] = [];
  const ids = new Set(seed.records.map(record => record?.id));
  const attachments = new Set(seed.attachments.map(item => item.id));
  if (ids.size !== seed.records.length) problems.push("Record IDs repeat");
  if (attachments.size !== seed.attachments.length) problems.push("Attachment IDs repeat");
  const valid = seed.records.filter(record => {
    try { validateRecord(record); return true; } catch (error) { problems.push(`Record ${record?.id}: ${message(error)}`); return false; }
  });
  const visible = filterRecords(valid, VISIBLE);
  for (const record of valid) {
    const name = `${record.kind} ${record.id}`;
    if (record.error !== undefined) problems.push(`${name} has an error: ${record.error}`);
    if (record.thoughtStatus === "draft" || record.thoughtStatus === "growing") problems.push(`${name} is still a ${record.thoughtStatus} note`);
    if (record.connectionStatus === "pending" || record.connectionStatus === "failed") problems.push(`${name} has ${record.connectionStatus} connections`);
    if (record.quality === "pending" && visible.includes(record)) problems.push(`${name} is shown with a pending quality check`);
    const targets = [...record.links.map(link => link.targetId), ...(record.sources ?? []).map(source => source.recordId),
      ...record.segments.flatMap(segment => segment.references ?? []).map(reference => reference.recordId)];
    for (const id of new Set(targets)) if (!ids.has(id)) problems.push(`${name} points to a missing record: ${id}`);
    for (const id of record.attachmentIds) if (!attachments.has(id)) problems.push(`${name} names a missing attachment: ${id}`);
    for (const value of [record.createdAt, record.updatedAt, ...record.segments.map(segment => segment.createdAt)])
      if (!timestamp(value)) problems.push(`${name} has a timestamp the loader cannot move: ${value}`);
    for (const text of [record.title, record.summary, record.body ?? "", ...record.segments.filter(segment => segment.speaker === "assistant").map(segment => segment.text)]) {
      const date = DATE.exec(text)?.[0];
      if (date) problems.push(`Generated text names a date: "${date}"`);
    }
  }
  const hubs = sessionHubs(valid, visible).length;
  if (hubs !== 2) problems.push(`The Brain shows ${hubs} session hubs, not 2`);
  return [...new Set(problems)];
}

/** A deep copy in which every string that is exactly a UTC timestamp is moved; a timestamp inside other text stays. */
export function mapIsoTimestamps<T>(value: T, move: (ms: number) => number): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      const ms = ISO.test(item) ? Date.parse(item) : NaN;
      if (!Number.isFinite(ms)) return item;
      const moved = move(ms);
      return moved === ms ? item : new Date(moved).toISOString();
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return visit(value) as T;
}
export const shiftIsoTimestamps = <T>(value: T, offsetMs: number): T => mapIsoTimestamps(value, ms => ms + offsetMs);

/** The local wall-clock time at `instant` in `timeZone`, written as if it were UTC. */
function wallClock(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}
/** The instant whose wall-clock time in `timeZone` is `wall`; the second pass settles a daylight-saving change in between. */
function fromWallClock(wall: number, timeZone: string) {
  const offset = (instant: number) => wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;
  return wall - offset(wall - offset(wall));
}

/** Moves the latest session to start at 16:00 yesterday in the visitor's time zone, as the Agent's `localDay` reads it.
 * Nothing moves past `now`, so the newest note never looks as if it came from the future. */
export function seedOffsetMs(seed: SeedFile, now: Date, timeZone: string): number {
  let latest = -Infinity;
  mapIsoTimestamps(seed, ms => { latest = Math.max(latest, ms); return ms; });
  const starts = seed.records.filter(record => record.kind === "session").map(record => Date.parse(record.createdAt)).filter(Number.isFinite);
  const today = Math.floor(wallClock(now.getTime(), timeZone) / DAY_MS) * DAY_MS;
  const offset = starts.length ? fromWallClock(today - DAY_MS + 16 * HOUR_MS, timeZone) - Math.max(...starts) : 0;
  return Number.isFinite(latest) ? Math.min(offset, now.getTime() - latest) : offset;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunks keep String.fromCharCode under the engine's argument limit.
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Attachments first, so every record's attachment is readable as soon as the record is. */
export async function importSeed(brain: BrainPort, seed: SeedFile): Promise<void> {
  for (const item of seed.attachments) await brain.putAttachment(item.id, item.mimeType, decodeBase64(item.base64));
  for (const record of seed.records) await brain.importRecord(record, []);
}
