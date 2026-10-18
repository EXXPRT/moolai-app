import type { BrainRecord } from "../../../packages/contracts/src/index.js";

export type SessionHub = { id: string; label: string; members: string[] };

// Before sessions ran from Start to Stop, one session record collected weeks of speech.
const SESSION_SPAN_MS = 24 * 60 * 60 * 1000;
const labelTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Study sessions as hubs for the visible notes made in them, derived from stored provenance only. */
export function sessionHubs(records: BrainRecord[], visible: BrainRecord[]): SessionHub[] {
  const sessions = records.filter(item => item.kind === "session" && !item.suppressed).map(item => {
    const times = item.segments.map(segment => Date.parse(segment.createdAt)).filter(Number.isFinite);
    return { record: item, start: times.length ? Math.min(...times) : Date.parse(item.createdAt),
      span: times.length ? Math.max(...times) - Math.min(...times) : 0, segments: new Set(item.segments.map(segment => segment.id)) };
  });
  const direct = new Map<string, string[]>();
  for (const item of records) {
    if (item.kind === "session") continue;
    const ids = sessions.filter(({ record, segments }) =>
      item.sources?.some(source => source.recordId === record.id)
      || item.links.some(link => link.provenance === "source" && link.targetId === record.id)
      || item.segments.some(segment => segments.has(segment.id))).map(({ record }) => record.id);
    if (ids.length) direct.set(item.id, ids);
  }
  // A note with no session of its own, such as one Moo made in a conversation, joins the sessions it came from.
  const of = (item: BrainRecord) => direct.get(item.id)
    ?? [...new Set(item.links.filter(link => link.provenance === "source").flatMap(link => direct.get(link.targetId) ?? []))];
  const members = new Map<string, string[]>();
  for (const item of visible) for (const id of of(item)) members.set(id, [...members.get(id) ?? [], item.id]);
  return sessions
    .filter(({ record, span }) => span <= SESSION_SPAN_MS && new Set(members.get(record.id)).size >= 2)
    .sort((a, b) => a.start - b.start || a.record.id.localeCompare(b.record.id))
    .map(({ record, start }) => ({ id: record.id, label: `Session · ${labelTime.format(start)}`, members: [...new Set(members.get(record.id))].sort() }));
}
