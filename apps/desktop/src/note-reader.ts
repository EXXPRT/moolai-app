import { visibleLinksBetween } from "../../../packages/contracts/src/records.js";
import type { BrainRecord, RecordPatch, Segment } from "../../../packages/contracts/src/index.js";

export type SourceKind = "Dictation" | "Moo conversation" | "Written note";
export type SourceGroup = { kind: SourceKind; segments: Segment[] };

/** Segment turn membership survives semantic consolidation's new segment identities. */
export function sourceGroups(record: BrainRecord, records: BrainRecord[]): SourceGroup[] {
  const conversationTurns = new Set(records.filter(r => r.kind === "conversation")
    .flatMap(r => r.segments.map(segment => segment.turnId)));
  const groups: SourceGroup[] = [];
  for (const segment of record.segments) {
    const kind: SourceKind = record.kind === "conversation" || segment.speaker === "assistant" || conversationTurns.has(segment.turnId)
      ? "Moo conversation" : "Dictation";
    const previous = groups.at(-1);
    if (previous?.kind === kind) previous.segments.push(segment);
    else groups.push({ kind, segments: [segment] });
  }
  return groups;
}

/** Source records and original help requests stay inspectable without exposing operational JSON. */
export function originalSources(record: BrainRecord, records: BrainRecord[]): BrainRecord[] {
  const byId = new Map(records.map(item => [item.id, item]));
  const ids = new Set([
    ...record.links.filter(link => link.decision !== "dismissed" && ["source", "reply", "correction"].includes(link.provenance)).map(link => link.targetId),
    ...(record.sources ?? []).map(source => source.recordId),
  ]);
  // The complete originating conversation also carries requests retained before help was accepted.
  for (const id of [...ids]) {
    const source = byId.get(id);
    if (source?.kind === "conversation") {
      for (const link of source.links) if (link.provenance === "reply" && link.decision !== "dismissed") ids.add(link.targetId);
    }
  }
  return [...ids].map(id => byId.get(id)).filter((source): source is BrainRecord => Boolean(source && !source.suppressed && source.id !== record.id));
}

export function connectionsFor(record: BrainRecord, records: BrainRecord[]) {
  return records.filter(other => other.id !== record.id && !other.archived && !other.suppressed && !other.sourceOnly && other.kind !== "session")
    .flatMap(other => {
      const links = visibleLinksBetween(record, other);
      if (!links.length) return [];
      return [{ record: other, removable: links.some(link => link.provenance === "suggested" || link.provenance === "manual"),
        label: links.some(link => link.provenance === "suggested") ? "Related thought" : links.some(link => link.provenance === "manual") ? "Linked note" : "Source connection" }];
    });
}

/** Dismiss both directions and retain tombstones so future automatic passes respect removal. */
export function connectionDismissals(record: BrainRecord, other: BrainRecord): { id: string; revision: number; patch: RecordPatch }[] {
  return [record, other].flatMap(owner => {
    const target = owner.id === record.id ? other.id : record.id;
    const canDismiss = (link: BrainRecord["links"][number]) => link.targetId === target &&
      (link.provenance === "suggested" || link.provenance === "manual") && link.decision !== "dismissed";
    if (!owner.links.some(canDismiss)) return [];
    return [{ id: owner.id, revision: owner.revision, patch: { links: owner.links.map(link => canDismiss(link) ? { ...link, decision: "dismissed" as const } : link) } }];
  });
}

export function readerError(error: unknown, conflict = "This note changed while you were editing. Reopen it to use the latest version."): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/conflict|revision|changed|409/i.test(message)) return conflict;
  return "That action could not be confirmed. Reopen the note before trying again.";
}
