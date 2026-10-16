import type { BrainRecord, RecordPatch, RecordRevision, Segment } from "./index.js";

export const copy = <T>(value: T): T => structuredClone(value);

function revisionContent(record: BrainRecord): string {
  // Acceptance can advance without a content revision. Compare persisted source
  // independently of JSON object-key order; array order still matters.
  const { acceptedRevision: _acknowledgment, ...content } = record;
  return JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value,
  );
}

/** Import known history plus the current snapshot; never invent prior revisions. */
export function importedHistory(
  record: BrainRecord,
  history: RecordRevision[] = [],
): RecordRevision[] {
  validateRecord(record);
  const seen = new Set<number>();
  for (const entry of history) {
    validateRecord(entry?.record);
    if (
      entry.record.id !== record.id ||
      entry.record.revision > record.revision ||
      (entry.record.revision === record.revision && revisionContent(entry.record) !== revisionContent(record)) ||
      seen.has(entry.record.revision) ||
      typeof entry.at !== "string" ||
      !["capture", "manual", "generated", "import"].includes(entry.reason)
    )
      throw new Error("Invalid imported revision history");
    seen.add(entry.record.revision);
  }
  const revisions = [...history];
  if (!seen.has(record.revision))
    revisions.push({ record, reason: "import", at: record.updatedAt });
  return copy(revisions.sort((a, b) => a.record.revision - b.record.revision));
}

export function newRecord(input: {
  id: string;
  kind: BrainRecord["kind"];
  createdAt: string;
}): BrainRecord {
  if (
    !input.id.trim() ||
    ["__proto__", "constructor", "prototype"].includes(input.id)
  )
    throw new Error("A record ID is required");
  return {
    ...input,
    revision: 0,
    sourceRevision: 0,
    updatedAt: input.createdAt,
    segments: [],
    title: "",
    summary: "",
    body: "",
    resolution: "open",
    archived: false,
    topics: [],
    quality: "pending",
    qualityReasons: [],
    doubt: false,
    links: [],
    attachmentIds: [],
    manualFields: [],
    acceptedRevision: 0,
  };
}

/** An ASR revision replaces only its own segment; receipt order is retained. */
export function reviseSegment(
  record: BrainRecord,
  segment: Segment,
): BrainRecord {
  if (
    !segment.id ||
    !Number.isSafeInteger(segment.revision) ||
    segment.revision < 0
  ) {
    throw new Error("Segment ID and nonnegative integer revision are required");
  }
  const index = record.segments.findIndex((item) => item.id === segment.id);
  if (index >= 0 && record.segments[index]!.revision >= segment.revision)
    return record;
  const result = copy(record);
  if (index < 0) result.segments.push(copy(segment));
  else result.segments[index] = copy(segment);
  result.sourceRevision += 1;
  result.revision += 1;
  result.updatedAt = new Date().toISOString();
  result.quality = "pending";
  result.qualityReasons = ["Source changed; enrichment needs review."];
  return result;
}

/** Manual fields survive delayed generated patches. A manual edit names its fields. */
export function patchRecord(
  record: BrainRecord,
  patch: RecordPatch,
): BrainRecord {
  const result = copy(record);
  if (patch.derivedSegments !== undefined) {
    if (record.kind !== "dictation" || record.sourceOnly || !(patch.sources ?? record.sources)?.length)
      throw new Error("Only derived notes may replace their source projection");
    result.segments = copy(patch.derivedSegments);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === "acceptedRevision" || key === "derivedSegments") continue;
    if (record.manualFields.includes(key) && !patch.manualFields?.includes(key))
      continue;
    Object.assign(result, { [key]: copy(value) });
  }
  if (patch.acceptedRevision !== undefined) {
    if (
      !Number.isSafeInteger(patch.acceptedRevision) ||
      patch.acceptedRevision < 0
    ) {
      throw new Error("Accepted revision must be a nonnegative integer");
    }
    result.acceptedRevision = Math.max(
      record.acceptedRevision,
      Math.min(record.revision, patch.acceptedRevision),
    );
  }
  if (result.body !== record.body || JSON.stringify(result.segments) !== JSON.stringify(record.segments)) {
    result.sourceRevision += 1;
    result.quality = "pending";
    result.qualityReasons = ["Source content changed; enrichment pending."];
  }
  // A server acknowledgment is local synchronization metadata, not a new content revision.
  if (Object.keys(patch).some((key) => key !== "acceptedRevision")) {
    result.revision += 1;
    result.updatedAt = new Date().toISOString();
  }
  return result;
}

/** Whole-word, weighted lexical search. Scope is applied before ranking/limiting. */
const stopWords = new Set(
  "a an the and or but if to of in on at by for from with is are was were be been being it its this that these those as i we you they my our your not only user assistant reports notes note please what how why can could do does did have has had will would should may still than then".split(
    " ",
  ),
);
const tokens = (text: string) =>
  new Set(
    (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (w) => !stopWords.has(w),
    ),
  );
export function searchRecords(
  records: BrainRecord[],
  query: string,
  limit: number,
  options?: import("./index.js").BrainSearchOptions,
): BrainRecord[] {
  const words = tokens(query);
  if (!Number.isFinite(limit) || limit <= 0 || !words.size) return [];
  const scoped = filterRecords(records, options);
  const exact = scoped.find((record) => record.id === query.trim());
  if (exact) return [exact];
  return rankRecords(scoped, query).slice(0, Math.floor(limit)).map(d=>d.record);
}

/** Shared content scores; consumers can add a bounded contextual tie-breaker. */
export function rankRecords(records: BrainRecord[], query: string) {
  const words = tokens(query);
  const documents = records.map((record) => ({
    record,
    title: tokens(record.title),
    topics: tokens(record.topics.join(" ")),
    body: tokens(
      (record.body ?? "") +
        " " +
        record.summary +
        " " +
        record.segments.map((s) => s.text).join(" "),
    ),
  }));
  const frequency = new Map<string, number>();
  for (const d of documents)
    for (const word of new Set([...d.title, ...d.topics, ...d.body]))
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return documents
    .map((d) => ({
      record: d.record,
      score: [...words].reduce((score, word) => {
        const weight =
          1 + Math.log(1 + documents.length / (frequency.get(word) ?? 1));
        return (
          score +
          weight *
            (Number(d.title.has(word)) * 3 +
              Number(d.topics.has(word)) * 3 +
              Number(d.body.has(word)))
        );
      }, 0),
    }))
    .filter((d) => d.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.record.updatedAt.localeCompare(a.record.updatedAt),
    );
}

export function attachmentId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))
    throw new Error("Unsafe attachment ID");
}

/** Shared filtering keeps the user interface and model tools on the same records. */
export function filterRecords(
  records: BrainRecord[],
  o?: import("./index.js").BrainSearchOptions,
): BrainRecord[] {
  return records.filter(
    (r) =>
      !r.suppressed &&
      (!r.sourceOnly || o?.kinds?.includes("session")) &&
      !o?.excludeIds?.includes(r.id) &&
      (!o?.kinds || o.kinds.includes(r.kind)) &&
      Boolean(r.archived) === (o?.archived ?? false) &&
      (!o?.topic || r.topics.includes(o.topic)) &&
      (!o?.purpose || r.purpose === o.purpose) &&
      (!o?.quality || r.quality === o.quality) &&
      (!o?.unresolved ||
        ((r.purpose === "Question" || r.doubt) &&
          r.resolution !== "resolved")) &&
      (!o?.since || r.createdAt.slice(0, 10) >= o.since) &&
      (!o?.until || r.createdAt.slice(0, 10) <= o.until),
  );
}
export function queryRecords(
  records: BrainRecord[],
  options: import("./index.js").BrainQuery,
): BrainRecord[] {
  const limit = Math.max(0, Math.min(options.limit ?? 200, 1000));
  return options.text?.trim()
    ? searchRecords(records, options.text, limit, options)
    : filterRecords(records, options)
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        )
        .slice(0, limit);
}
/** Pair-level association tombstones never erase retained evidence relationships. */
export function visibleLinksBetween(
  current: Pick<BrainRecord, "id" | "links">,
  other: Pick<BrainRecord, "id" | "links">,
): BrainRecord["links"] {
  const links = [
    ...current.links.filter((link) => link.targetId === other.id),
    ...other.links.filter((link) => link.targetId === current.id),
  ];
  const association = (link: BrainRecord["links"][number]) =>
    link.provenance === "manual" || link.provenance === "suggested";
  const dismissed = links.some((link) => association(link) && link.decision === "dismissed");
  return links.filter((link) => link.decision !== "dismissed" && (!association(link) || !dismissed));
}
export function relatedRecords(
  records: BrainRecord[],
  id: string,
): BrainRecord[] {
  const current = records.find((r) => r.id === id);
  if (!current || current.suppressed) return [];
  return records.filter((r) => {
    if (r.id === id || r.archived || r.suppressed) return false;
    return visibleLinksBetween(current, r).length > 0;
  });
}
export function validateRecord(record: BrainRecord): void {
  if (record?.suppressed !== undefined && (!record.suppressed || typeof record.suppressed!=="object" ||
      !record.suppressed.at || !record.suppressed.operationId || !record.suppressed.sessionId ||
      Object.values(record.suppressed).some(value=>typeof value!=="string"))) throw Error("Invalid note suppression metadata");
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  const revision = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0;
  if (
    !record ||
    typeof record.id !== "string" ||
    !record.id.trim() ||
    ["__proto__", "constructor", "prototype"].includes(record.id) ||
    record.id.length > 200 ||
    !["session", "dictation", "conversation", "note"].includes(record.kind) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Number.isSafeInteger(record.sourceRevision) ||
    record.sourceRevision < 0 ||
    !Array.isArray(record.segments) ||
    !Array.isArray(record.links) ||
    !strings(record.topics) ||
    !strings(record.manualFields) ||
    !strings(record.attachmentIds) ||
    !strings(record.qualityReasons) ||
    !["pending", "ready", "needs_review"].includes(record.quality) ||
    typeof record.doubt !== "boolean" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !revision(record.acceptedRevision) ||
    (record.summarySourceRevision !== undefined &&
      !revision(record.summarySourceRevision)) ||
    (record.purpose !== undefined &&
      !["Question", "Reference", "Idea", "Action"].includes(record.purpose)) ||
    (record.resolution !== undefined &&
      !["open", "resolved"].includes(record.resolution)) ||
    (record.archived !== undefined && typeof record.archived !== "boolean") ||
    (record.author !== undefined &&
      (!record.author ||
        typeof record.author.id !== "string" ||
        typeof record.author.name !== "string" ||
        !["user", "agent", "unknown"].includes(record.author.kind))) ||
    (record.offTopic !== undefined &&
      (!record.offTopic || typeof record.offTopic.subject !== "string")) ||
    (record.error !== undefined && typeof record.error !== "string") ||
    typeof record.title !== "string" ||
    typeof record.summary !== "string" ||
    (record.body !== undefined && typeof record.body !== "string")
  )
    throw new Error("Invalid record");
  if (
    record.segments.some(
      (s) =>
        !s ||
        typeof s.id !== "string" ||
        typeof s.turnId !== "string" ||
        !revision(s.revision) ||
        !["user", "assistant", "system"].includes(s.speaker) ||
        typeof s.text !== "string" ||
        typeof s.final !== "boolean" ||
        typeof s.createdAt !== "string",
    ) ||
    record.links.some(
      (l) =>
        !l ||
        typeof l.targetId !== "string" ||
        !["suggested", "source", "reply", "manual", "correction"].includes(
          l.provenance,
        ) ||
        (l.decision !== undefined &&
          !["accepted", "dismissed"].includes(l.decision)),
    )
  )
    throw new Error("Invalid record evidence or relationships");
  if ((record.sourceOnly !== undefined && typeof record.sourceOnly !== "boolean") ||
      (record.thoughtStatus !== undefined && !["draft","growing","settled"].includes(record.thoughtStatus)) ||
      (record.sourceContext !== undefined && (typeof record.sourceContext !== "string" || record.sourceContext.length > 60000)) ||
      (record.connectionStatus !== undefined && !["pending","connected","no_match","failed"].includes(record.connectionStatus)) ||
      (record.sources !== undefined && (!Array.isArray(record.sources) || record.sources.some(source=>
        !source || typeof source.recordId!=="string" || !Array.isArray(source.spans) || source.spans.some(span=>
          !span || typeof span.segmentId!=="string" || !revision(span.revision) || !revision(span.start) || !revision(span.end) || span.end<=span.start)))) ||
      record.links.some(link=>(link.confidence !== undefined && (!Number.isFinite(link.confidence) || link.confidence<0 || link.confidence>1)) ||
        (link.sourceRevision!==undefined&&!revision(link.sourceRevision)) || (link.targetRevision!==undefined&&!revision(link.targetRevision))) ||
      record.segments.some(segment=>segment.references!==undefined && (!Array.isArray(segment.references) || segment.references.some(ref=>!ref || typeof ref.recordId!=="string" || typeof ref.title!=="string"))))
    throw new Error("Invalid record source references or connection assessment");
  for (const id of record.attachmentIds) attachmentId(id);
}

/** A stable ID is a tool address, never a user-facing fallback title. */
export function noteTitle(record: BrainRecord, peers: BrainRecord[] = []): string {
  const title = record.title.trim() || (record.body || record.segments.find(s => s.speaker === "user")?.text || "Saved thought").replace(/\s+/g, " ").slice(0, 70);
  return peers.some(r => r.id !== record.id && r.title.trim() === title)
    ? `${title} · ${record.createdAt.replace("T", " ").slice(0, 19)}` : title;
}
