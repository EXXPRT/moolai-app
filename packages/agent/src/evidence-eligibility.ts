import type {BrainRecord} from '../../contracts/src/index.js';

/** A projection of the unanswered request cannot independently support its answer.
 * Keep prior settled episodes in the same conversation available. This policy
 * affects retrieval, not source retention or the growing-note preview.
 * A draft or growing note that took in this conversation's turns is evidence without them, so the user's
 * other dictation in it stays available and an answer never cites its own conversation. With nothing else
 * in it, or no conversation record to tell its turns apart, it is left out.
 */
export function independentNote(record: BrainRecord | undefined, conversationId: string,
  requestTurnIds: readonly string[] = [], conversation?: BrainRecord): BrainRecord | undefined {
  if (!record || record.archived || record.suppressed || record.sourceOnly ||
      record.kind === 'session' || record.id === conversationId) return undefined;
  if (record.segments.some(segment => segment.speaker === 'user' && requestTurnIds.includes(segment.turnId))) return undefined;
  if (!((record.thoughtStatus === 'draft' || record.thoughtStatus === 'growing') &&
    record.links.some(link => link.provenance === 'source' && link.targetId === conversationId))) return record;
  const turns = new Set(conversation?.segments.map(segment => segment.turnId));
  const segments = conversation ? record.segments.filter(segment => !turns.has(segment.turnId)) : [];
  return segments.length ? {...record, segments} : undefined;
}
