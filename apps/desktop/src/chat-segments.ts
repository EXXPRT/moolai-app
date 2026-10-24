import type { BrainRecord, Segment } from "../../../packages/contracts/src/index.js";
import { fillerOnly, wakeOnly } from "../../../packages/contracts/src/utterances.js";

/** The lines the chat shows. A conversation holds only the sounds and bare calls Moo acted on, but the session record
 * keeps every one, so with no conversation open they are hidden (Ian, 24 Oct). An empty line is a cleared preview. */
export function chatSegments(transcript: Pick<BrainRecord, "kind" | "segments"> | undefined): Segment[] {
  return transcript?.segments.filter(segment => segment.text.trim() &&
    !(transcript.kind === "session" && segment.speaker === "user" && (fillerOnly(segment.text) || wakeOnly(segment.text)))) ?? [];
}
