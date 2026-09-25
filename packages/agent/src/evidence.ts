import {transcriptText, type BrainPort, type BrainRecord, type LocalFilesPort, type LocalFileRead, type VisionEvidence, type VisualScene} from '../../contracts/src/index.js';
import type {ExperimentToolEvent} from './reliability.js';
import {typedExperimentResult} from './reliability.js';
export interface EvidenceRef { id: string; offset: number; length: number; query?: string }
export interface EvidenceIndex { refs: EvidenceRef[]; outcomes: unknown[]; files?: {rootId:string;path:string;startLine:number}[] }
export function noteEvidence(record: BrainRecord, offset = 0, length = 2400, query = '') {
  const original = transcriptText(record);
  if (query && offset === 0 && original.length > length) {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    const found = words.map(w => original.toLowerCase().indexOf(w)).filter(n => n >= 0);
    if (found.length) offset = Math.max(0, Math.min(...found) - 200);
  }
  return {id: record.id, title: record.title, revision: record.revision, sourceRevision: record.sourceRevision,
    original: original.slice(offset, offset + length), offset, nextOffset: Math.min(original.length, offset + length),
    truncated: offset > 0 || offset + length < original.length, totalCharacters: original.length,
    quality: record.quality, qualityReasons: record.qualityReasons, topics: record.topics, offTopic: record.offTopic};
}
export async function loadEvidence(brain: BrainPort, id: string, local?: LocalFilesPort) {
  const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`) ?? {refs: [], outcomes: []};
  const notes = [];
  for (const ref of index.refs) {
    const record = await brain.getRecord(ref.id);
    if (record && record.kind !== 'session' && record.id !== id) notes.push(noteEvidence(record, ref.offset, ref.length, ref.query));
  }
  const files: LocalFileRead[] = [];
  const unavailableFiles: string[] = [];
  for (const ref of index.files ?? []) {
    try { if (!local) throw new Error("Local file access unavailable"); files.push(await local.read({...ref, lineCount: 80})); }
    catch { unavailableFiles.push(`${ref.rootId}/${ref.path}: unavailable; do not reuse an earlier excerpt.`); }
  }
  return {notes, files, unavailableFiles, recentOutcomes: index.outcomes};
}
export async function rememberEvidence(brain: BrainPort, id: string, event: ExperimentToolEvent) {
  const index = await brain.getState<EvidenceIndex>(`evidence-index:${id}`) ?? {refs: [], outcomes: []};
  if (event.status === 'success' && ['read_note','search_notes'].includes(event.call.name)) {
    const output = Array.isArray(event.result) ? event.result : [event.result];
    for (const item of output) if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
      index.refs = index.refs.filter(r => r.id !== item.id);
      index.refs.push({id: item.id, offset: Number(event.call.arguments.offset) || 0, length: Number(event.call.arguments.length) || 2400,
        query: typeof event.call.arguments.query === 'string' ? event.call.arguments.query : undefined});
    }
    index.refs = index.refs.slice(-5);
  }
  if (event.status === 'success' && ['search_local_files','read_local_file'].includes(event.call.name)) {
    const result = event.result as any;
    for (const f of result?.matches ?? [result]) if (f?.rootId && f?.path) {
      index.files = [...(index.files ?? []).filter(ref => ref.rootId !== f.rootId || ref.path !== f.path), {rootId:f.rootId,path:f.path,startLine:f.startLine ?? f.line ?? 1}].slice(-5);
    }
  }
  const outcome = typedExperimentResult(event);
  index.outcomes = [...index.outcomes, {...outcome, result: ['read_note','search_notes','search_local_files','read_local_file'].includes(event.call.name) ? undefined : outcome.result}].slice(-5);
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
  const observations = (Array.isArray(parsed.observations) ? parsed.observations : []).map((o: any) => {
    const status = ['readable','unreadable','absent'].includes(o.status) ? o.status : 'unreadable';
    const valid = typeof value !== 'string' && status === 'readable' && typeof o.value === 'string' &&
      typeof o.label === 'string' && !!o.label.trim() && typeof o.sourceExcerpt === 'string' && o.sourceExcerpt.includes(o.value) && o.sourceExcerpt.toLowerCase().includes(o.label.toLowerCase()) && [...words(o.field)].some(w => words(o.label).has(w));
    const limitation = `${parsed.interpretation ?? ''} ${parsed.scene?.limitation ?? ''}`;
    const contradictory = limitation.split(/[.!?;\n]/).some((clause: string) =>
      /\b(?:obscured|unreadable|hidden|incomplete|partially|uncertain)\b/i.test(clause) && [...words(o.field)].some(w => words(clause).has(w)));
    const supported = valid && !contradictory && (!requested || [...words(`${o.field} ${o.label} ${o.sourceExcerpt}`)].some(w => requested.has(w)));
    if ((status !== 'readable' && o.value != null) || (status === 'readable' && !supported)) errors.push(`Unsupported observation: ${String(o.field)}.`);
    return {field: String(o.field ?? 'unknown'), status, value: supported ? o.value : null, label: supported ? o.label : null, sourceExcerpt: supported ? o.sourceExcerpt : null};
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
  return {observations: evidence.observations, validated: evidence.validated, validationErrors: evidence.validationErrors,
    ...(evidence.scene ? {scene:evidence.scene, visualEvidenceNotice:'Model-reported visual features and tentative hypotheses; not verified identity or extracted text. Clarify absent/unclear targets.'} : {}),
    interpretation: 'Model interpretation is retained for review, not usable factual evidence.'};
}
