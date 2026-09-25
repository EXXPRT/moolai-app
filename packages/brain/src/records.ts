import type {
  BrainRecord,
  RecordPatch,
  Segment,
} from "../../contracts/src/index.js";

export const copy = <T>(value: T): T => structuredClone(value);

export function newRecord(input: {
  id: string;
  kind: BrainRecord["kind"];
  createdAt: string;
}): BrainRecord {
  if (!input.id.trim()) throw new Error("A record ID is required");
  return {
    ...input,
    revision: 0,
    sourceRevision: 0,
    updatedAt: input.createdAt,
    segments: [],
    title: "",
    summary: "",
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
  for (const [key, value] of Object.entries(patch)) {
    if (key === "acceptedRevision") continue;
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
  // A server acknowledgment is local synchronization metadata, not a new content revision.
  if (Object.keys(patch).some((key) => key !== "acceptedRevision")) {
    result.revision += 1;
    result.updatedAt = new Date().toISOString();
  }
  return result;
}

/** Whole-word, weighted lexical search. Scope is applied before ranking/limiting. */
const stopWords = new Set("a an the and or but if to of in on at by for from with is are was were be been being it its this that these those as i we you they my our your not only user assistant reports notes note please what how why can could do does did have has had will would should may still than then".split(" "));
const tokens = (text: string) => new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !stopWords.has(w)));
export function searchRecords(records: BrainRecord[], query: string, limit: number,
  options?: import("../../contracts/src/index.js").BrainSearchOptions): BrainRecord[] {
  const words = tokens(query);
  if (!Number.isFinite(limit) || limit <= 0 || !words.size) return [];
  const scoped = records.filter(r => !options?.excludeIds?.includes(r.id) && (!options?.kinds || options.kinds.includes(r.kind)));
  const exact = scoped.find(record => record.id === query.trim());
  if (exact) return [exact];
  const documents = scoped.map(record => ({record, title: tokens(record.title), topics: tokens(record.topics.join(" ")), body: tokens(record.summary + " " + record.segments.map(s => s.text).join(" "))}));
  const frequency = new Map<string, number>();
  for (const d of documents) for (const word of new Set([...d.title, ...d.topics, ...d.body])) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return documents.map(d => ({record: d.record, score: [...words].reduce((score, word) => {
    const weight = 1 + Math.log(1 + documents.length / (frequency.get(word) ?? 1));
    return score + weight * (Number(d.title.has(word)) * 3 + Number(d.topics.has(word)) * 3 + Number(d.body.has(word)));
  }, 0)})).filter(d => d.score > 0).sort((a,b) => b.score-a.score || b.record.updatedAt.localeCompare(a.record.updatedAt)).slice(0, Math.floor(limit)).map(d => d.record);
}

export function attachmentId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))
    throw new Error("Unsafe attachment ID");
}
