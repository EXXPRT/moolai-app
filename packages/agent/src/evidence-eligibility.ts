import type {BrainRecord} from '../../contracts/src/index.js';

/** A projection of the unanswered request cannot independently support its answer.
 * Keep prior settled episodes in the same conversation available. This policy
 * affects retrieval, not source retention or the growing-note preview.
 */
export function independentNote(record: BrainRecord | undefined, conversationId: string,
  requestTurnIds: readonly string[] = []): record is BrainRecord {
  if (!record || record.archived || record.suppressed || record.sourceOnly ||
      record.kind === 'session' || record.id === conversationId) return false;
  if (record.segments.some(segment => segment.speaker === 'user' && requestTurnIds.includes(segment.turnId))) return false;
  return !((record.thoughtStatus === 'draft' || record.thoughtStatus === 'growing') &&
    record.links.some(link => link.provenance === 'source' && link.targetId === conversationId));
}
