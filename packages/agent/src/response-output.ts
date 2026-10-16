import type { AgentReply, SpokenOutline, ToolCall } from '../../contracts/src/index.js';
import { markdownSpeech, speechSections } from './speech-markdown.js';

export function plainSpeech(text: string): string {
  return markdownSpeech(text);
}

/** Compatibility fallback: preserve complete point content, never just a sentence prefix.
 * New providers supply concise semantic explanations, including tables, in spokenOutline. */
export function speechOutline(reply: AgentReply): SpokenOutline | undefined {
  const supplied = reply.spokenOutline?.points.length ? reply.spokenOutline : undefined;
  const sections = speechSections(reply.text);
  if (supplied && !sections.length && supplied.points.every(p => p.explanation.trim())) return supplied;
  if (supplied && sections.length) {
    const key = (label: string) => plainSpeech(label).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const points = supplied.points.map(point => {
      // Older outlines may match unique section titles, but a point count is never coverage evidence.
      const matching = sections.map((section, i) => key(section.label) && key(section.label) === key(point.label) ? i + 1 : 0).filter(Boolean);
      return {...point, sourceSections: point.sourceSections ?? (matching.length === 1 ? matching : [])};
    });
    const refs = points.flatMap(point => point.sourceSections);
    if (points.every(point => point.explanation.trim() && point.sourceSections.length === 1) &&
        refs.length === sections.length && refs.every((ref, i) => ref === i + 1)) return {...supplied, points};
  }
  // Brief legacy sections can be read completely. Long sections need a model-written,
  // coverage-checked explanation: do not turn full documents into accidental narration.
  const count = (value: string) => value.split(/\s+/).filter(Boolean).length;
  if (!sections.length || sections.some(section => count(section.explanation) > 60) ||
      sections.reduce((total, section) => total + count(section.explanation), 0) > 100) return;
  return {overview: `There are ${sections.length} sections in this answer.`,
    points: sections.map((section, i) => ({...section, sourceSections: [i + 1]}))};
}
export const walkthroughOffer = "Would you like me to walk through the points?";
export function narratePoints(outline: SpokenOutline, start = 0): string {
  return outline.points.slice(start, start + 5).map((point, i) =>
    `${start+i+1}. ${plainSpeech(point.label)}${point.label ? '. ' : ''}${plainSpeech(point.explanation)}`).join(' ');
}
export function narrationReply(text: string): 'accept' | 'decline' | undefined {
  // Only complete, unambiguous replies consume this offer. New requests go through J1.
  if (/^(?:yes(?: please)?|sure|please do|go ahead|continue|next(?: five)?|walk me through(?: them| the points)?)[.!\s]*$/i.test(text.trim())) return 'accept';
  if (/^(?:no(?: thanks| thank you)?|not now|skip(?: it| that)?)[.!\s]*$/i.test(text.trim())) return 'decline';
}
export function requestsFullNarration(request: string) {
  const direct = request.replace(/[“"‘][\s\S]*?[”"’]/g, '');
  return !/\b(?:don't|do not|no need|stop)\b/i.test(direct) &&
    /\b(?:read|narrate|speak)\b.{0,40}\b(?:in full|full answer|whole answer|everything|all of it)\b/i.test(direct);
}
/** Only whole, referential playback requests bypass routing/research. Quoted,
 * negated and compound requests deliberately fall through to normal routing. */
export function playbackRequest(request: string): 'full' | 'repeat' | 'walkthrough' | undefined {
  const text = request.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
    .replace(/^moo[,!]?\s+/i, '').replace(/^(?:(?:please|can you|could you|would you)\s+)+/i, '');
  const target = '(?:it|that|this|(?:your|the) (?:(?:last|previous|full|whole) )?(?:answer|response)|everything|all of it)';
  if (new RegExp(`^(?:read|narrate|speak) ${target}(?: (?:in full|fully|out loud|aloud))?(?: please)?$`, 'i').test(text)) return 'full';
  if (new RegExp(`^(?:repeat ${target}|say ${target} again)(?: please)?$`, 'i').test(text)) return 'repeat';
  if (/^(?:walk me through (?:it|that|this|(?:the |your )?(?:points|sections|answer|response))|(?:explain|go through) (?:each|all the) (?:point|points|section|sections))(?: please)?$/i.test(text)) return 'walkthrough';
}

export const narrationUnavailable = 'The answer is on screen, but its spoken summary is unavailable. You can ask me to read it in full.';
export const walkthroughUnavailable = 'The answer is on screen, but I could not prepare a complete brief walkthrough. You can ask me to read it in full.';
function validSpokenSummary(reply: AgentReply): string | undefined {
  if (typeof reply.spokenText !== 'string' || !reply.spokenText.trim() || reply.spokenText.length > 1200) return;
  const text = plainSpeech(reply.spokenText);
  return text.trim() || undefined;
}
export function spokenAnswer(reply: AgentReply, request = ''): string {
  if (requestsFullNarration(request)) return plainSpeech(reply.text);
  if (playbackRequest(request) === 'walkthrough') {
    const outline = speechOutline(reply);
    return outline ? narratePoints(outline) + (outline.points.length > 5 ? ' Shall I continue with the next points?' : '') : walkthroughUnavailable;
  }
  // A malformed optional walkthrough must never veto a separately supplied summary.
  const summary = validSpokenSummary(reply);
  if (summary) return summary;
  // Legacy short replies can be spoken completely, never clipped. Current providers
  // mark missing/invalid summaries explicitly so they cannot take this compatibility path.
  if (reply.narrationError || reply.spokenText !== undefined) return narrationUnavailable;
  const text = plainSpeech(reply.text);
  // Legacy protocol-only output is not a narratable answer. The controller logs
  // empty speech without giving apparent legitimacy to a printed tool proposal.
  if (!text.trim()) return '';
  return text.split(/\s+/).length <= 100 ? text : narrationUnavailable;
}

/** Bounded diagnostics explain why narration was chosen without retaining answer prose. */
export function narrationDecision(reply: AgentReply, request = '') {
  const sections = speechSections(reply.text);
  const outline = speechOutline(reply);
  const summary = validSpokenSummary(reply);
  const walkthrough = playbackRequest(request) === 'walkthrough';
  const mode = requestsFullNarration(request) ? 'full' : walkthrough ? outline ? 'outline' : 'fallback'
    : summary ? 'summary' : !reply.narrationError && reply.spokenText === undefined && plainSpeech(reply.text).trim() && plainSpeech(reply.text).split(/\s+/).length <= 100 ? 'prose' : 'fallback';
  return {
    mode,
    reason: mode !== 'fallback' ? undefined : walkthrough && sections.length
      ? reply.spokenOutline?.points.length ? 'section_coverage_invalid' : 'outline_missing'
      : reply.spokenText !== undefined ? 'spoken_summary_invalid' : 'spoken_summary_missing',
    sectionCount: sections.length,
    suppliedPointCount: reply.spokenOutline?.points.length ?? 0,
  };
}

/** Keep facts about execution, not repeated documents, in consolidation input.
 * The complete raw result remains in the tool ledger and is part of its revision stamp. */
export function compactToolOutcome(item: {call: ToolCall; result: any}) {
  const wrapped = item.result ?? {};
  const result = wrapped.result ?? wrapped;
  const status = wrapped.status ?? (wrapped.error ? 'failed' : 'legacy_unvalidated');
  const references = (Array.isArray(result) ? result : result.matches ?? [result]).slice(0, 50)
    .filter((value: any) => value && typeof value === 'object')
    .map((value: any) => Object.fromEntries(['id','revision','sourceRevision','title','url','rootId','path','fingerprint','attachmentId']
      .filter(key => value[key] !== undefined).map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 240) : value[key]])))
    .filter((value: any) => Object.keys(value).length);
  return {tool: item.call.name, callId: item.call.id, status,
    query: typeof item.call.arguments?.query === 'string' ? item.call.arguments.query.slice(0, 300) : undefined,
    executed: wrapped.executed ?? null,
    error: typeof wrapped.error === 'string' ? wrapped.error.slice(0, 400) : undefined,
    references, rawResultRetained: true,
    scope: 'Tool outcomes establish execution only. Retrieval matches do not establish the entire Brain inventory.'};
}
