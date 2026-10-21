import type { AgentReply, AgentState, BrainPort, Segment, SpokenOutline } from '../../contracts/src/index.js';
import { narratePoints, narrationDecision, plainSpeech, playbackRequest, speechOutline, spokenAnswer, walkthroughUnavailable } from './response-output.js';

export interface AnswerNarrationAnchor {
  conversationId: string;
  segmentId: string;
  revision: number;
}
interface SavedPresentation {
  version: 1;
  anchor: AnswerNarrationAnchor;
  spokenText?: string;
  spokenOutline?: SpokenOutline;
  narrationError?: string;
}
export interface AnswerPlayback {
  action: 'full' | 'repeat' | 'walkthrough';
  speech: string;
  anchor?: AnswerNarrationAnchor;
  continuation?: AgentState['narration'];
  unavailable?: 'no_answer' | 'answer_changed' | 'summary_missing' | 'walkthrough_invalid';
}
const latestKey = (conversationId: string) => `answer-narration:latest:${conversationId}`;
const presentationKey = (anchor: AnswerNarrationAnchor) => `answer-narration:${anchor.conversationId}:${anchor.segmentId}:${anchor.revision}`;

/** Store presentation separately from source prose; the original segment is authoritative.
 * Call only for generated answer content, never acknowledgements or playback notices. */
export async function rememberAnswerNarration(brain: BrainPort, conversationId: string, segment: Segment, reply: AgentReply): Promise<boolean> {
  if (segment.speaker !== 'assistant' || !segment.final || segment.text !== reply.text || !segment.text.trim()) return false;
  const anchor = {conversationId, segmentId: segment.id, revision: segment.revision};
  if (!await answerNarrationIsCurrent(brain, anchor)) return false;
  const presentation: SavedPresentation = {version: 1, anchor,
    spokenText: reply.spokenText, spokenOutline: reply.spokenOutline, narrationError: reply.narrationError};
  // A crash between these writes leaves an orphaned presentation, never a pointer
  // that could accidentally resolve to another answer or require paid regeneration.
  await brain.setState(presentationKey(anchor), presentation);
  await brain.setState(latestKey(conversationId), anchor);
  return true;
}

/** Recheck immediately before playback after asynchronous controller work. */
export async function answerNarrationIsCurrent(brain: BrainPort, anchor: AnswerNarrationAnchor): Promise<boolean> {
  const record = await brain.getRecord(anchor.conversationId);
  const source = record?.segments.find(segment => segment.id === anchor.segmentId);
  return !!record && !record.archived && !record.suppressed && !!source && source.final && source.speaker === 'assistant' && source.revision === anchor.revision;
}

/** Resolve only unambiguous playback controls, without generation, J1 or tool work.
 * The controller retains the user turn first, cancels superseded work, and persists
 * continuation before speaking. It must not call remember() for the playback itself. */
export async function resolveAnswerNarration(brain: BrainPort, conversationId: string | undefined, text: string): Promise<AnswerPlayback | undefined> {
  const action = playbackRequest(text);
  if (!action) return;
  let anchor = conversationId ? await brain.getState<AnswerNarrationAnchor>(latestKey(conversationId)) : undefined;
  if (!anchor && conversationId) {
    // Older answer writes marked content for consolidation but did not retain its
    // presentation. Only that positive marker identifies an answer; never infer
    // one from acknowledgement wording, length or the latest assistant alone.
    const record = await brain.getRecord(conversationId);
    if (record && !record.archived && !record.suppressed && record.kind === 'conversation') {
      for (const segment of [...record.segments].reverse()) {
        if (segment.speaker !== 'assistant' || !segment.final || !segment.text.trim() ||
            await brain.getState(`thought-eligible:${segment.id}`) !== true) continue;
        if (await rememberAnswerNarration(brain, conversationId, segment, {text: segment.text, toolCalls: []}))
          anchor = {conversationId, segmentId: segment.id, revision: segment.revision};
        break;
      }
    }
  }
  if (!anchor || anchor.conversationId !== conversationId)
    return {action, speech: 'Which saved answer would you like me to read? Please return to its conversation.', unavailable: 'no_answer'};
  const presentation = await brain.getState<SavedPresentation>(presentationKey(anchor));
  if (!presentation || presentation.version !== 1 || !sameAnchor(presentation.anchor, anchor) || !await answerNarrationIsCurrent(brain, anchor))
    return {action, speech: 'That answer changed or is no longer available. Please select the current answer before asking me to read it.', unavailable: 'answer_changed'};
  const record = await brain.getRecord(anchor.conversationId);
  const source = record?.segments.find(segment => segment.id === anchor.segmentId && segment.revision === anchor.revision);
  if (!source) return {action, speech: 'That answer changed before playback. Please select the current answer.', unavailable: 'answer_changed'};
  const reply: AgentReply = {text: source.text, toolCalls: [],
    spokenText: typeof presentation.spokenText === 'string' ? presentation.spokenText : undefined,
    spokenOutline: validOutlineShape(presentation.spokenOutline) ? presentation.spokenOutline : undefined,
    narrationError: typeof presentation.narrationError === 'string' ? presentation.narrationError : undefined};
  if (action === 'full') return {action, anchor, speech: plainSpeech(source.text)};
  // With no valid summary, saying it again reads the answer instead of the unavailable notice once more.
  if (action === 'repeat') return narrationDecision(reply).mode === 'fallback'
    ? {action, anchor, speech: plainSpeech(source.text), unavailable: 'summary_missing'} : {action, anchor, speech: spokenAnswer(reply)};
  const outline = speechOutline(reply);
  if (!outline) return {action, anchor, speech: walkthroughUnavailable, unavailable: 'walkthrough_invalid'};
  const more = outline.points.length > 5;
  return {action, anchor, speech: narratePoints(outline) + (more ? ' Shall I continue with the next points?' : ''),
    continuation: more ? {conversationId: anchor.conversationId, outline, next: 5,
      sourceResponse: {segmentId: anchor.segmentId, revision: anchor.revision}} : undefined};
}

function sameAnchor(a: AnswerNarrationAnchor | undefined, b: AnswerNarrationAnchor) {
  return a?.conversationId === b.conversationId && a.segmentId === b.segmentId && a.revision === b.revision;
}
function validOutlineShape(value: unknown): value is SpokenOutline {
  if (!value || typeof value !== 'object') return false;
  const outline = value as SpokenOutline;
  return typeof outline.overview === 'string' && Array.isArray(outline.points) && outline.points.every(point =>
    point && typeof point.label === 'string' && typeof point.explanation === 'string' &&
    (point.sourceSections === undefined || Array.isArray(point.sourceSections) && point.sourceSections.every(ref => Number.isInteger(ref) && ref > 0)));
}
