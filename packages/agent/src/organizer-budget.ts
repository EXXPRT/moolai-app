import type { Segment, ThoughtInput } from "../../contracts/src/index.js";
import { safeEnd } from "../../contracts/src/records.js";

/** The backend's organizer request bound (providers.py max_request_bytes) and a fixed allowance for its prompt,
 * schema and framing. backend/tests/test_organizer_request_fit.py pins both against the real request builder. */
export const ORGANIZER_REQUEST = { bytes: 32000, fixedReserveBytes: 5200, excerptFloorBytes: 4000, summaryEchoChars: 4000 } as const;

// Python's str whitespace (what `\s` matches in the backend's unit regex), spelled out so the split matches exactly.
const WHITESPACE = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SEPARATOR = new RegExp(`[.!?;](?:[${WHITESPACE}]+|$)`, "g");

/** The backend's mechanical source units (providers.py _thought_source_units). */
export function organizerUnits(segments: Pick<Segment, "speaker" | "text">[]) {
  const units: { speaker: Segment["speaker"]; text: string }[] = [];
  for (const segment of segments) {
    const ends = [...segment.text.matchAll(SEPARATOR)].map(match => match.index! + match[0].length);
    if (!ends.length || ends.at(-1) !== segment.text.length) ends.push(segment.text.length);
    let start = 0;
    for (const end of ends) {
      const text = segment.text.slice(start, end); start = end;
      if (text) units.push({ speaker: segment.speaker, text });
    }
  }
  return units;
}

const encoder = new TextEncoder();
/** UTF-8 bytes of a value once JSON-encoded as the state string and then again inside the provider payload. */
export const payloadBytes = (value: unknown) => encoder.encode(JSON.stringify(JSON.stringify(value))).length - 2;

/** Bytes the organizer state occupies in the backend request, in the backend's key order. */
export function organizerStateBytes(input: ThoughtInput): number {
  const units = organizerUnits(input.segments).map((unit, i) => ({ id: `u${i}`, speaker: unit.speaker, text: unit.text }));
  const a = input.activeNote;
  return payloadBytes({ units, finalize: input.finalize, context: input.context ?? null, incremental: input.incremental ?? false,
    activeNote: a ? { id: a.id, title: a.title, summary: a.summary, sourceRevision: a.sourceRevision,
      sourceExcerpt: a.sourceExcerpt, sourceTruncated: a.sourceTruncated } : null });
}
export const organizerRequestBytes = (input: ThoughtInput) => ORGANIZER_REQUEST.fixedReserveBytes + organizerStateBytes(input);
export const fitsOrganizerRequest = (input: ThoughtInput, bytes: number = ORGANIZER_REQUEST.bytes) => organizerRequestBytes(input) <= bytes;

export const SUMMARY_OMISSION = "\n[Later summary text retained; omitted here]";
/** The active note's summary is echoed to the organizer as a draft; a long (for example manual) summary is bounded here only. */
export function echoSummary(summary: string, maxChars: number = ORGANIZER_REQUEST.summaryEchoChars) {
  return summary.length <= maxChars ? summary : summary.slice(0, safeEnd(summary, maxChars - SUMMARY_OMISSION.length)) + SUMMARY_OMISSION;
}
