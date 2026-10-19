import {transcriptText, type BrainPort, type BrainRecord, type LocalFilesPort, type LocalFileRead, type VisionEvidence, type VisualScene} from '../../contracts/src/index.js';
import type {ExperimentToolEvent} from './reliability.js';
import {typedExperimentResult} from './reliability.js';
import {readPassage, selectPassages} from './note-passages.js';
import {independentNote} from './evidence-eligibility.js';
import {safeEnd} from '../../contracts/src/records.js';
export interface EvidenceRef { id: string; offset: number; length: number; query?: string; selection?: 'query' | 'window' }
export interface EvidenceIndex { refs: EvidenceRef[]; outcomes: unknown[]; files?: {rootId:string;path:string;startLine:number;lineCount?:number}[] }
const cut = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, safeEnd(value, max)) : undefined;
/** History excerpts are revision-checked in their active run and retained in the
 * raw tool ledger. They must not become stale, duplicated evidence on later turns.
 * Web pages and screen readings reach the model once, in the request that fetched them; later
 * requests see short receipts, so a few web questions can no longer lock a conversation (blocker 7).
 * A rebuilt request keeps its own screen reading, because it cannot capture twice. */
function retainedOutcome(outcome: unknown, requestTurnIds: readonly string[] = []): unknown {
  if (!outcome || typeof outcome !== 'object' || !('tool' in outcome)) return outcome;
  const value = outcome as Record<string, unknown>;
  const result = value.result as any;
  if (value.tool === 'conversation_history') return {...value, result: {
    requestedInterval: result?.requestedInterval,
    source: 'Historical retrieval receipt only. Use the current tool response for checked excerpts; retrieve again for a new request. Full original output remains in the local tool ledger.',
  }};
  if ((value.tool === 'search_web' || value.tool === 'extract_web') && Array.isArray(result)) return {...value, result: {
    pages: result.filter(page => typeof page?.url === 'string').slice(0, 10).map(page => ({url: page.url, title: cut(page.title, 120),
      ...(value.tool === 'extract_web' && typeof page.content === 'string' ? {characters: page.content.length} : {})})),
    source: "Receipt of an earlier request's call; its text was not kept. Retrieve again only if this request needs it.",
  }};
  if (value.tool === 'capture_screen' && result && typeof result === 'object' && !result.source &&
      !(typeof value.requestTurnId === 'string' && requestTurnIds.includes(value.requestTurnId))) return {...value, result: {
    attachmentId: result.attachmentId, capturedAt: value.at, validated: result.validated,
    observationCount: Array.isArray(result.observations) ? result.observations.length : undefined,
    source: 'Receipt of an earlier screen reading; its values were not kept and do not describe the screen now. A new screen capture needs a new user request.',
  }};
  return outcome;
}
/** Call, request and time bookkeeping stays in storage. Shown to the model, it was copied into a printed tool
 * call instead of a real one (19 Oct paid check). */
function modelFacing(outcome: unknown): unknown {
  if (!outcome || typeof outcome !== 'object') return outcome;
  const {callId: _call, requestTurnId: _turn, at: _at, ...shown} = outcome as Record<string, unknown>;
  return shown;
}
/** Pages an earlier web search in this conversation returned may be opened by a follow-up (ATR-11). */
export async function earlierSearchUrls(brain: BrainPort, id: string) {
  const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`) ?? {refs: [], outcomes: []};
  return index.outcomes.flatMap((outcome: any) => outcome?.tool === 'search_web' && outcome.status === 'success'
    ? (Array.isArray(outcome.result) ? outcome.result : outcome.result?.pages ?? []).map((page: any) => page?.url) : [])
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url));
}
export function noteEvidence(record: BrainRecord, offset = 0, length = 2400, query = '') {
  const selecting = !!query.trim() && offset === 0;
  const {passages, ...evidence} = selecting ? selectPassages(record, query, length) : readPassage(record, offset, length);
  const first = passages[0];
  // Keep the first exact source window in original for older consumers. Additional
  // passages are separate, never joined into a fabricated contiguous quotation.
  return {...evidence, ...first, original: first?.original ?? '', offset: first?.offset ?? offset,
    nextOffset: first?.nextOffset ?? Math.min(transcriptText(record).length, offset),
    additionalPassages: passages.slice(1), selectionQuery: selecting ? query : undefined,
    evidenceNotice: 'Offsets are UTF-16 source positions. Omitted text is not evidence. Written section dates describe document sections, not proof of completed work; record creation/import/update timestamps are not event dates.'};
}
export async function loadEvidence(brain: BrainPort, id: string, local?: LocalFilesPort, webAllowed = true,
  requestTurnIds: readonly string[] = [], runCallIds: ReadonlySet<string> = new Set()) {
  const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`) ?? {refs: [], outcomes: []};
  const notes = [];
  for (const ref of index.refs) {
    const record = await brain.getRecord(ref.id);
    if (independentNote(record, id, requestTurnIds))
      notes.push(noteEvidence(record, ref.selection === 'query' ? 0 : ref.offset, ref.length, ref.query));
  }
  const files: LocalFileRead[] = [];
  const unavailableFiles: string[] = [];
  for (const ref of index.files ?? []) {
    try { if (!local) throw new Error("Local file access unavailable"); files.push(await local.read({...ref, lineCount: ref.lineCount ?? 80})); }
    catch { unavailableFiles.push(`${ref.rootId}/${ref.path}: unavailable; do not reuse an earlier excerpt.`); }
  }
  // An outcome whose tool message is already in this request is not repeated in the index.
  const recentOutcomes = (webAllowed ? index.outcomes : index.outcomes.filter(outcome =>
    !outcome || typeof outcome !== 'object' || !('tool' in outcome) || !['search_web','extract_web'].includes(String(outcome.tool)))
  ).filter((outcome: any) => !(typeof outcome?.callId === 'string' && runCallIds.has(outcome.callId)))
    .map(outcome => modelFacing(retainedOutcome(outcome, requestTurnIds)));
  return {notes, files, unavailableFiles, recentOutcomes};
}
export async function rememberEvidence(brain: BrainPort, id: string, event: ExperimentToolEvent,
  scope: {requestTurnId?: string; at?: string} = {}) {
  const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`) ?? {refs: [], outcomes: []};
  if (event.status === 'success' && ['read_note','search_notes','related_notes'].includes(event.call.name)) {
    const output = Array.isArray(event.result) ? event.result : [event.result];
    for (const item of output) if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
      const offset = 'offset' in item ? Number(item.offset) : Number(event.call.arguments.offset) || 0;
      // Retain the requested window, not the old text length: a correction may be longer.
      const length = event.call.name === 'related_notes' ? 1600 : Number(event.call.arguments.length) || 2400;
      const query = 'selectionQuery' in item && typeof item.selectionQuery === 'string' ? item.selectionQuery
        : event.call.name === 'search_notes' && typeof event.call.arguments.query === 'string' ? event.call.arguments.query : undefined;
      const selection = query ? 'query' : 'window';
      // A continuation read must not discard the earlier passage establishing its
      // scope/qualification. Keep at most five bounded references overall.
      index.refs = index.refs.filter(ref => ref.id !== item.id ||
        (ref.selection ?? (ref.query ? 'query' : 'window')) !== selection ||
        (selection === 'query' ? ref.query !== query : ref.offset !== offset || ref.length !== length));
      index.refs.push({id: item.id, offset, length, query, selection});
    }
    // The last five distinct notes, at most eight references: one read never evicts the search hit it continues (ATR-02).
    const kept = new Set<string>();
    for (const ref of [...index.refs].reverse()) if (kept.size < 5) kept.add(ref.id);
    index.refs = index.refs.filter(ref => kept.has(ref.id)).slice(-8);
  }
  if (event.status === 'success' && ['search_local_files','read_local_file'].includes(event.call.name)) {
    const result = event.result as any;
    for (const f of result?.matches ?? [result]) if (f?.rootId && f?.path) {
      const startLine=f.startLine ?? f.line ?? 1;
      const receivedLines=typeof f.text==='string' ? f.text.split(/\r?\n/).length : 80;
      const lineCount=event.call.name==='read_local_file' ? Math.min(200,Math.max(1,Number(event.call.arguments.lineCount)||receivedLines)) : 80;
      // Different passages from one file remain distinct evidence; a refresh keeps its bounds.
      index.files = [...(index.files ?? []).filter(ref => ref.rootId !== f.rootId || ref.path !== f.path || ref.startLine !== startLine || (ref.lineCount ?? 80) !== lineCount), {rootId:f.rootId,path:f.path,startLine,lineCount}].slice(-5);
    }
  }
  const outcome = typedExperimentResult(event);
  const requestTurnIds = scope.requestTurnId ? [scope.requestTurnId] : [];
  index.outcomes = [...index.outcomes, {...outcome, callId: event.call.id, ...(scope.requestTurnId ? {requestTurnId: scope.requestTurnId} : {}),
    ...(scope.at ? {at: scope.at} : {}),
    result: ['read_note','search_notes','related_notes','search_local_files','read_local_file'].includes(event.call.name) ? undefined : outcome.result}]
    .slice(-5).map(outcome => retainedOutcome(outcome, requestTurnIds));
  await brain.setState(`evidence-index:${id}`, index);
}
export async function evidenceCurrent(brain: BrainPort, snapshot: Awaited<ReturnType<typeof loadEvidence>>, local?: LocalFilesPort) {
  const {notes, files} = snapshot;
  for (const note of notes) if ((await brain.getRecord(note.id))?.revision !== note.revision) return false;
  for (const f of files) {
    try { if (!local || (await local.read({rootId:f.rootId,path:f.path,startLine:f.startLine,lineCount:1})).fingerprint !== f.fingerprint) return false; }
    catch { return false; }
  }
  return true;
}
export async function inputDigest(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}
/** Raw vision output is retained separately and never used as answer evidence. */
/** Mirrors the backend's excerpt_supports: the value must stand alone, never as part of a longer number or after a sign. */
function excerptSupports(value: string, excerpt: string) {
  const normal = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const needle = normal(value), text = normal(excerpt);
  if (!needle || !text) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_.+\\-\u2212\u2013])${escaped}(?![\\p{L}\\p{N}_]|[.,]\\d)`, "u").test(text);
}
export function validateVision(value: VisionEvidence | string, question?: string, mode: "ocr" | "visual" = "ocr"): VisionEvidence {
  const raw = typeof value === 'string' ? value : value.raw;
  let parsed: any = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = {}; } }
  const errors: string[] = [...(Array.isArray(parsed.validationErrors) ? parsed.validationErrors : [])];
  if (typeof value === 'string') errors.push('Legacy output is unvalidated.');
  const generic = new Set("a an the is are was were be of and or to in on at from with what which how many please read report give tell me my this that screen screenshot shown appears value field number no id identifier identifiers code use only notes other not absent unreadable readable if any complete do it its as for you can could".split(" "));
  const words = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !generic.has(w)));
  // Excluded material is not a requested field. This conservative lexical check
  // may withhold synonyms; it never invents a label equivalence.
  const requested = question ? words(question.replace(/\b(?:do not|don't|never|ignore|exclude|without)\b[^.!?;]*/gi, "")) : undefined;
  const observations = (Array.isArray(parsed.observations) ? parsed.observations : []).flatMap((o: any) => {
    const status = ['readable','unreadable','absent'].includes(o.status) ? o.status : 'unreadable';
    if (status !== 'readable') {
      const fieldWords = words(String(o.field ?? ''));
      // An unrelated absence is not evidence that the requested field is absent.
      // Require the complete field identity, so a value hidden in its name cannot
      // bypass the null-value safeguard. Do not strip digits from genuine labels.
      const requestedField = fieldWords.size > 0 && (!requested || [...fieldWords].every(word => requested.has(word)));
      const contradictoryAbsence = status === 'absent' &&
        [o.label, o.sourceExcerpt].some(text => typeof text === 'string' && text.trim());
      if (!requestedField || contradictoryAbsence || typeof value === 'string') {
        errors.push('A nonreadable observation lacks an unambiguous requested field or contradicts visible text.');
        return [];
      }
      if (o.value != null) errors.push('A nonreadable observation supplied an unusable value.');
      // Partial identifiers and unrelated source excerpts remain in raw evidence,
      // never in the answer packet. Only the requested field/status is usable.
      return [{field: String(o.field), status, value: null, label: null, sourceExcerpt: null}];
    }
    const valid = typeof value !== 'string' && status === 'readable' && typeof o.value === 'string' &&
      typeof o.label === 'string' && !!o.label.trim() && typeof o.sourceExcerpt === 'string' && excerptSupports(o.value, o.sourceExcerpt) && o.sourceExcerpt.toLowerCase().includes(o.label.toLowerCase()) && [...words(o.field)].some(w => words(o.label).has(w));
    const limitation = `${parsed.interpretation ?? ''} ${parsed.scene?.limitation ?? ''}`;
    const contradictory = limitation.split(/[.!?;\n]/).some((clause: string) =>
      /\b(?:obscured|unreadable|hidden|incomplete|partially|uncertain)\b/i.test(clause) && [...words(o.field)].some(w => words(clause).has(w)));
    const supported = valid && !contradictory && (!requested || [...words(`${o.field} ${o.label} ${o.sourceExcerpt}`)].some(w => requested.has(w)));
    if ((status !== 'readable' && o.value != null) || (status === 'readable' && !supported)) errors.push(`Unsupported observation: ${String(o.field)}.`);
    return [{field: String(o.field ?? 'unknown'), status, value: supported ? o.value : null, label: supported ? o.label : null, sourceExcerpt: supported ? o.sourceExcerpt : null}];
  });
  if (mode === 'ocr' && !observations.length) errors.push('OCR mode requires field observations; visual prose is not extracted text.');
  const scene = typeof value === 'string' || observations.length || mode === 'ocr' ? undefined : validateScene(parsed.scene, errors);
  return {raw, observations, ...(scene ? {scene} : {}), interpretation: typeof parsed.interpretation === 'string' ? parsed.interpretation : '', validationErrors: [...new Set(errors)], validated: typeof value !== 'string' && parsed.validated === true && !errors.length};
}
function validateScene(value: unknown, errors: string[]): VisualScene | undefined {
  if (value == null) return undefined;
  const s = value as VisualScene;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!s || !['observed','absent','unclear'].includes(s.status) || !Array.isArray(s.features) || s.features.length > 12 ||
      !Array.isArray(s.hypotheses) || s.hypotheses.length > 5 || typeof s.limitation !== 'string' || s.limitation.length > 2000 ||
      !s.features.every(f => f && text(f.id,80) && text(f.description,1000) && text(f.region,200)) ||
      new Set(s.features.map(f => f.id)).size !== s.features.length || (s.status === 'observed' && !s.features.length)) {
    errors.push('Visual scene structure is invalid; no visual claims are usable.');
    return undefined;
  }
  const ids = new Set(s.features.map(f => f.id));
  const hypotheses = s.hypotheses.filter(h => {
    const usable = h && s.status === 'observed' && text(h.label,500) && ['low','medium','high'].includes(h.confidence) &&
      Array.isArray(h.featureIds) && h.featureIds.length > 0 && h.featureIds.length <= 12 && h.featureIds.every(id => ids.has(id));
    if (!usable) errors.push('Visual hypothesis lacks usable supporting features.');
    return usable;
  });
  return {status:s.status, features:s.status === 'absent' ? [] : s.features, hypotheses, limitation:s.limitation};
}
export function usableVision(evidence: VisionEvidence) {
  return {observations: evidence.observations.filter(observation => observation.status !== 'readable' ||
      (typeof observation.value === 'string' && !!observation.value.trim() &&
       typeof observation.label === 'string' && !!observation.label.trim() &&
       typeof observation.sourceExcerpt === 'string' && !!observation.sourceExcerpt.trim())),
    validated: evidence.validated,
    // Detailed validation errors can themselves contain discarded OCR values.
    // Preserve them locally; hand only a value-free limitation to generation.
    validationErrors: evidence.validationErrors.length ? ['Some requested visual evidence could not be validated.'] : [],
    evidenceNotice: 'Only listed observations support claims. A missing requested observation is an extraction limitation, not evidence that the field is absent.',
    ...(evidence.scene ? {scene:evidence.scene, visualEvidenceNotice:'Model-reported visual features and tentative hypotheses; not verified identity or extracted text. Clarify absent/unclear targets.'} : {}),
    interpretation: 'Model interpretation is retained for review, not usable factual evidence.'};
}
