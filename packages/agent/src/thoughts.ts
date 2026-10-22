import {plannedThoughts} from "./thought-planning.js";
import type { BrainPort, BrainRecord, GenerationProvider, Segment, SourceSpan, ThoughtGroup, ThoughtInput, ThoughtResult, RecordPatch, LiveThoughtPreview } from "../../contracts/src/index.js";
import { inputDigest } from "./evidence.js";
import { thoughtPreview } from "./thought-preview.js";
import { safeEnd, safeStart } from "../../contracts/src/records.js";
import { ORGANIZER_REQUEST, echoSummary, fitsOrganizerRequest, payloadBytes } from "./organizer-budget.js";

interface BufferState {
  retentionRevision?: number;
  suppressedSegments?: string[];
  suppression?: Suppression;
  spans: SourceSpan[];
  seen: Record<string, number>;
  lengths?: Record<string,number>;
  published: string[];
  // Latest topic episode eligible for continuation, even when its current summary is complete.
  activeId?: string;
  draftId?: string;
  checked?: string;
  operation?: string;
  status?: "pending" | "running" | "failed";
  error?: string;
  /** Records a failure was copied onto, with its text, so the next successful pass clears those copies. */
  surfaced?: Record<string,string>;
  finalize?: boolean;
  /** A bounded close completed successfully but has more source awaiting explicit continuation. */
  continuationRequired?: boolean;
  staged?: { input: ThoughtInput; result: ThoughtResult; spans: SourceSpan[]; operation: string; targetStamp?: string; draftStamp?: string; plans?: Publication[]; retentionRevision?: number };
}
interface Suppression { id: string; recordId: string; at: string; spans: SourceSpan[]; pending: SourceSpan[]; operation?: string; applied?: boolean }
interface SuppressionProposal { id: string; recordId: string; stamp: string; title: string }
export interface RetentionScope {recordId:string;stamp:string}
const retentionStamp = (state: BufferState, record: BrainRecord) => JSON.stringify([state.activeId,state.draftId,state.spans,state.retentionRevision,record.revision]);
interface Publication {
  id: string; group: ThoughtGroup; spans: SourceSpan[]; segments: Segment[];
  sourceIds: string[]; attachmentIds: string[]; context: string;
  before: string; draft: boolean;
}
const manualStamp = (r: BrainRecord) => JSON.stringify([r.archived,r.manualFields.map(k=>[k,(r as any)[k]])]);
const noteStamp = (r: BrainRecord) => JSON.stringify([r.sourceRevision,r.title,r.summary,r.topics,r.sources,manualStamp(r)]);
const mergeSourceMetadata = (record: BrainRecord, sourceIds: string[], attachmentIds: string[]) => ({
  links: [...record.links,...[...new Set(sourceIds)]
    .filter(id=>!record.links.some(link=>link.targetId===id && link.provenance==="source"))
    .map(targetId=>({targetId,provenance:"source" as const}))],
  attachmentIds: [...new Set([...record.attachmentIds,...attachmentIds])],
});
const ORGANIZATION_BOUNDS = {
  baseline: { characters: 8000, spans: 24 },
  compact: { characters: 3000, spans: 12 },
};
const EXCERPT_OMISSION = "\n[Earlier source retained; excerpt omitted here]\n";
function assertUnicode(text: string) {
  for(let i=0;i<text.length;i++) {
    const code=text.charCodeAt(i);
    if(code>=0xd800 && code<=0xdbff) {
      const next=text.charCodeAt(++i);
      if(!(next>=0xdc00 && next<=0xdfff))throw Error("Saved text contains an incomplete Unicode character; source retained for review.");
    } else if(code>=0xdc00 && code<=0xdfff)throw Error("Saved text contains an incomplete Unicode character; source retained for review.");
  }
}
function assertInputUnicode(value: unknown): void {
  if(typeof value==="string")assertUnicode(value);
  else if(value && typeof value==="object")for(const child of Object.values(value))assertInputUnicode(child);
}
export function thoughtExcerpt(text: string, profile?: "compact"): {sourceExcerpt: string; sourceTruncated: boolean} {
  assertUnicode(text);
  const compact=profile==="compact";
  if(text.length<=(compact?4000:12000))return {sourceExcerpt:text,sourceTruncated:false};
  const head=text.slice(0,safeEnd(text,compact?1000:4000));
  // Baseline preserves its prior 4,000 + 8,000 source characters plus the omission marker.
  const tailBudget=compact?4000-head.length-EXCERPT_OMISSION.length:8000;
  const tail=text.slice(safeStart(text,text.length-tailBudget));
  return {sourceExcerpt:head+EXCERPT_OMISSION+tail,sourceTruncated:true};
}
/** A smaller old-note excerpt for request packing: the baseline head:tail shape, at most maxChars of source. */
export function fitExcerpt(text: string, maxChars: number): {sourceExcerpt: string; sourceTruncated: boolean} {
  if(text.length<=maxChars)return {sourceExcerpt:text,sourceTruncated:false};
  const headChars=Math.floor(maxChars/3);
  const head=text.slice(0,safeEnd(text,headChars));
  const tail=text.slice(safeStart(text,text.length-(maxChars-headChars)));
  return {sourceExcerpt:head+EXCERPT_OMISSION+tail,sourceTruncated:true};
}
/** Bound requests without dropping text or making the cut a semantic boundary. */
export function thoughtBatch(spans: SourceSpan[], segments: Pick<Segment,"id"|"revision"|"text">[], profile?: "compact", maxCharacters?: number): SourceSpan[] {
  const base=ORGANIZATION_BOUNDS[profile ?? "baseline"];
  const bounds={...base,characters:Math.min(base.characters,maxCharacters ?? base.characters)};
  const selected: SourceSpan[]=[]; let remaining=bounds.characters;
  for(const span of spans) {
    if(!remaining || selected.length===bounds.spans)break;
    const source=segments.find(segment=>segment.id===span.segmentId);
    if(!source || source.revision!==span.revision || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start<0 || span.end<=span.start || span.end>source.text.length)
      throw Error("Source changed; review the pending thought.");
    assertUnicode(source.text);
    if((span.start>0 && /[\uDC00-\uDFFF]/.test(source.text[span.start]!)) || safeEnd(source.text,span.end)!==span.end)
      throw Error("Saved source coverage splits a Unicode character; source retained for review.");
    let end=safeEnd(source.text,Math.min(span.end,span.start+remaining));
    if(end===span.start)break; // Carry the entire character into the next request, never an empty segment.
    // Never leave only whitespace behind: a whitespace-only batch is not organizable.
    if(end<span.end && !source.text.slice(end,span.end).trim())end=span.end;
    selected.push({...span,end});remaining=Math.max(0,remaining-(end-span.start));
    if(end<span.end)break; // A batch must consume an ordered prefix, including at a Unicode boundary.
  }
  if(spans.length && !selected.length)throw Error("No complete source character fits the organization batch; source retained for review.");
  return selected;
}
const consume = (pending: SourceSpan[], included: SourceSpan[]) => {
  const rest=structuredClone(pending);
  for(const span of included) {
    const current=rest[0];
    if(!current || current.segmentId!==span.segmentId || current.revision!==span.revision || current.start!==span.start || current.end<span.end)
      throw Error("Source changed before publishing; result retained for review.");
    if(current.end===span.end)rest.shift();else current.start=span.end;
  }
  return rest;
};
const key = (id: string) => `thought-buffer:${id}`;
const coalesce = (spans:SourceSpan[]) => spans.reduce<SourceSpan[]>((all,span)=>{
  const last=all.at(-1);
  if(last && last.segmentId===span.segmentId && last.revision===span.revision && last.end===span.start)last.end=span.end;
  else all.push({...span});
  return all;
},[]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Semantic boundaries must partition the input exactly, in order, without invented text. */
export function validateThoughts(input: ThoughtInput, result: ThoughtResult) {
  if (!result || !Array.isArray(result.groups) || !Array.isArray(result.remainder) || result.groups.length > 30)
    throw Error("Invalid thought groups; transcript retained.");
  result.groups.forEach((group,i)=>{
    if(group.continuesActive && (i!==0 || !input.activeNote))throw Error("Invalid active-note continuation");
    if(group.ongoing && (i!==result.groups.length-1 || input.finalize))throw Error("Invalid unfinished note position");
  });
  let index = 0, offset = 0;
  for (const spans of [...result.groups.map(g => {
    if (!g.title?.trim() || !g.summary?.trim() || !Array.isArray(g.spans) || !g.spans.length ||
      (g.topicSuggestions && (g.topicSuggestions.length > 3 || g.topicSuggestions.some(t => typeof t !== "string"))))
      throw Error("Incomplete thought summary; transcript retained.");
    return g.spans;
  }), result.remainder]) {
    for (const span of spans) {
      const segment = input.segments[index];
      if (!segment || span.segmentId !== segment.id || span.revision !== segment.revision ||
        !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start !== offset ||
        span.end <= span.start || span.end > segment.text.length)
        throw Error("Thought source coverage is invalid; transcript retained.");
      offset = span.end;
      if (offset === segment.text.length) { index++; offset = 0; }
    }
  }
  if (index !== input.segments.length || offset || (input.finalize && result.remainder.length))
    throw Error("Thought output omitted source content; transcript retained.");
}

/** One durable ordered buffer per study session. No timer or audio chunk chooses a note boundary. */
export class ThoughtConsolidator {
  private lock: Promise<unknown> = Promise.resolve();
  private active?: Promise<void>;
  constructor(private p: {
    brain: BrainPort; generation: GenerationProvider; now: () => string;
    emit: (record: BrainRecord) => void; notice: (message: string) => void;
    pending?: () => void;
    previewChanged?: () => void;
    /** Explicit candidate injection only; production retains the established workload. */
    profile?: "compact";
    strategy?: "plan_then_summarize";
    enrich: (record: BrainRecord) => Promise<void>;
    context: (segments: Segment[]) => Promise<string>;
    sourceRecords?: (segments: Segment[]) => Promise<BrainRecord[]>;
    /** Request turns whose answer is still running; their tool outcomes may still change the context. */
    answering?: () => Set<string>;
  }) {}
  /** Whether an organizer pass is in flight now; a stored 'running' without one was interrupted. */
  get organizing() { return !!this.active; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn); this.lock = next.catch(() => {}); return next;
  }
  private async state(id: string): Promise<BufferState> {
    return await this.p.brain.getState<BufferState>(key(id)) ?? {spans: [], seen: {}, published: []};
  }
  async preview(sessionId: string): Promise<LiveThoughtPreview | undefined> {
    const state=await this.state(sessionId);
    const session=await this.p.brain.getRecord(sessionId);
    const pending=state.spans.flatMap(span=>{
      const source=session?.segments.find(s=>s.id===span.segmentId && s.revision===span.revision);
      return source?[{id:source.id,speaker:source.speaker,text:source.text.slice(span.start,span.end),final:true}]:[];
    });
    const provisional=(session?.segments ?? []).filter(s=>!s.final && s.speaker==="user").map(s=>({id:s.id,speaker:s.speaker,text:s.text,final:false}));
    const recordId=state.activeId ?? state.draftId;
    const record=recordId?await this.p.brain.getRecord(recordId):undefined;
    const segments=[...pending,...provisional];
    if(!segments.length && (!record || record.suppressed || record.archived))return undefined;
    return {sessionId,recordId:record && !record.suppressed && !record.archived?record.id:undefined,
      revision:await inputDigest(JSON.stringify([record?.id,record?.sourceRevision,segments])),segments,status:state.status};
  }
  /** Freeze an ambiguous target; inspector selection never participates in retention policy. */
  async retentionScope(sessionId:string): Promise<RetentionScope | undefined> {
    const state=await this.state(sessionId), id=state.activeId ?? state.draftId;
    const record=id?await this.p.brain.getRecord(id):undefined;
    return record && !record.suppressed && !record.archived?{recordId:record.id,stamp:retentionStamp(state,record)}:undefined;
  }
  async suppress(sessionId: string, proposalId?: string, expected?: RetentionScope, questionOnly=false): Promise<{status:"suppressed"}|{status:"clarify";proposalId:string;question:string}|{status:"unavailable"}> {
    return this.serial(async()=>{
      const state=await this.state(sessionId);
      const id=state.activeId ?? state.draftId;
      const record=id?await this.p.brain.getRecord(id):undefined;
      if(!record || record.suppressed || record.archived)return {status:"unavailable"};
      const stamp=retentionStamp(state,record);
      if(expected && expected.recordId!==record.id)return {status:"unavailable"};
      const proposal=proposalId?await this.p.brain.getState<SuppressionProposal>(`note-suppression-proposal:${proposalId}`):undefined;
      if((state.activeId && state.spans.length) || proposalId || questionOnly || (expected && expected.stamp!==stamp)) {
        if(questionOnly || !proposal || proposal.recordId!==id || proposal.stamp!==stamp) {
          const next=await inputDigest(`${sessionId}:${stamp}`);
          await this.p.brain.setState(`note-suppression-proposal:${next}`,{id:next,recordId:record.id,stamp,title:record.title} satisfies SuppressionProposal);
          return {status:"clarify",proposalId:next,question:`Do you mean the current growing note “${record.title || "Untitled thought"}”${state.activeId && state.spans.length ? ", including the new speech waiting to be organized" : ""}? The transcript will remain.`};
        }
      }
      const spans=coalesce([...(record.sources?.find(s=>s.recordId===sessionId)?.spans ?? []),...state.spans]);
      const operationId=`suppress:${sessionId}:${await inputDigest(stamp)}`;
      state.retentionRevision=(state.retentionRevision ?? 0)+1;
      state.suppression={id:operationId,recordId:record.id,at:this.p.now(),spans,pending:structuredClone(state.spans),operation:state.operation};
      // Intent precedes record/buffer changes so restart completes the same operation.
      await this.p.brain.setState(key(sessionId),state);
      await this.applySuppression(sessionId,state);
      this.p.previewChanged?.();
      return {status:"suppressed"};
    });
  }
  private async applySuppression(sessionId:string,state:BufferState) {
    const intent=state.suppression;
    if(!intent || intent.applied)return;
    await this.p.brain.setState(`note-suppression:${intent.id}`,intent);
    const record=await this.p.brain.getRecord(intent.recordId);
    if(record && !record.suppressed) {
      const updated=await this.p.brain.updateRecord(record.id,record.revision,{suppressed:{at:intent.at,operationId:intent.id,sessionId}});
      if(!updated)throw Error("The note changed while applying retention; retry the retention request.");
      this.p.emit(updated);
    }
    if(state.staged)await this.p.brain.setState(`thought-suppressed-output:${intent.id}`,state.staged);
    state.suppressedSegments=[...new Set([...(state.suppressedSegments ?? []),...intent.spans.map(s=>s.segmentId)])];
    state.spans=state.spans.filter(s=>!intent.pending.some(p=>p.segmentId===s.segmentId && p.start===s.start && p.end===s.end));
    state.published=state.published.filter(id=>id!==intent.recordId);
    state.activeId=undefined;state.draftId=undefined;state.staged=undefined;state.operation=undefined;
    state.checked=undefined;state.status=undefined;state.error=undefined;state.continuationRequired=undefined;
    state.suppression={...intent,applied:true};
    await this.p.brain.setState(key(sessionId),state);
    for(const op of await this.p.brain.listOperations())if((op.id===intent.operation || op.recordId===intent.recordId) && op.status!=="done")
      await this.p.brain.putOperation({...op,status:"done",error:"Note suppressed by the user; source retained."});
  }
  async append(sessionId: string, segments: Segment[]) {
    await this.serial(async () => {
      const state = await this.state(sessionId);
      await this.applySuppression(sessionId,state);
      let changed=false;
      for (const s of segments.filter(s => s.final && s.speaker !== "system")) {
        if(state.suppressedSegments?.includes(s.id)) {
          if(s.revision>(state.seen[s.id] ?? 0))for(const id of state.published) {
            const note=await this.p.brain.getRecord(id);
            // One utterance can feed multiple episodes. Suppression blocks re-creation,
            // not correction notices on a different, retained episode from that utterance.
            if(note && !note.suppressed && note.sources?.some(source=>source.spans.some(span=>span.segmentId===s.id && span.revision!==s.revision))) {
              const updated=await this.p.brain.updateRecord(note.id,note.revision,{quality:"needs_review",
                qualityReasons:["Original transcript corrected; inspect the current source."],
                error:"A correction changed shared source boundaries. Original and corrected transcripts remain available for review."});
              if(updated)this.p.emit(updated);
            }
          }
          state.seen[s.id]=Math.max(state.seen[s.id] ?? 0,s.revision);continue;
        }
        if ((state.seen[s.id] ?? -1) >= s.revision || (!s.text.length && state.seen[s.id] === undefined)) continue;
        changed=true;
        const previous = state.seen[s.id];
        const oldLength=state.lengths?.[s.id];
        state.lengths ??= {}; state.lengths[s.id]=s.text.length;
        state.seen[s.id] = s.revision;
        const pending = state.spans.find(span => span.segmentId === s.id);
        if (!s.text.length) state.spans=state.spans.filter(span=>span.segmentId!==s.id);
        else if (previous === undefined || oldLength===0) state.spans.push({segmentId:s.id,revision:s.revision,start:0,end:s.text.length});
        else if (pending && pending.start === 0) Object.assign(pending, {revision:s.revision,end:s.text.length});
        else if (pending) {
          state.status = "failed";
          state.error = "A correction changed a partially organized thought. Review its original transcript before retrying.";
          state.continuationRequired=undefined;
        }
        if (previous !== undefined) for (const id of new Set([...state.published,...(state.draftId?[state.draftId]:[])])) {
          let record = await this.p.brain.getRecord(id);
          if (record?.sources?.some(source => source.spans.some(span => span.segmentId === s.id && span.revision !== s.revision))) {
            const ranges=coalesce(record.sources.flatMap(source=>source.spans.filter(span=>span.segmentId===s.id)));
            const full=ranges.length===1 && ranges[0]!.start===0 && ranges[0]!.end===oldLength;
            if(full || !s.text.length) {
              const parts=record.segments.filter(part=>part.id.startsWith(`${s.id}:part:`));
              for(const [index,part] of parts.entries())record=await this.p.brain.upsertSegment(id,{...part,text:index===0?s.text:"",revision:s.revision});
              record=await this.p.brain.updateRecord(id,record.revision,{sources:record.sources!.map(source=>({...source,spans:[...source.spans.filter(span=>span.segmentId!==s.id),...(s.text.length?[{segmentId:s.id,revision:s.revision,start:0,end:s.text.length}]:[])]}))}) ?? record;
            }
            const updated = await this.p.brain.updateRecord(id, record.revision, {
              ...(record.thoughtStatus==="draft" && !state.spans.length ? {thoughtStatus:"settled" as const} : {}),
              quality:"needs_review", qualityReasons:["Original transcript corrected; inspect the current source."],
              error:"Source was corrected after organization. Original and corrected revisions remain available.",
            });
            if (updated) this.p.emit(updated);
          }
        }
      }
      const session=await this.p.brain.getRecord(sessionId);
      const order=new Map(session?.segments.map((s,i)=>[s.id,i]) ?? []);
      state.spans.sort((a,b)=>(order.get(a.segmentId)??0)-(order.get(b.segmentId)??0)||a.start-b.start);
      await this.ensureDraft(sessionId,state);
      await this.p.brain.setState(key(sessionId), state);
      this.p.previewChanged?.();
      if(changed && state.spans.length && state.status!=="failed")this.p.pending?.();
    });
  }
  async recover(sessionId: string) {
    const state = await this.serial(async()=> {
      const current=await this.state(sessionId);
      await this.applySuppression(sessionId,current);
      await this.ensureDraft(sessionId,current);
      if(current.status==="running" && !current.staged) {
        current.status="failed";current.error="Interrupted organization request; source retained. Retry explicitly.";
        current.continuationRequired=undefined;
        await this.failOperation(sessionId,current);
      }
      await this.p.brain.setState(key(sessionId),current);
      return current;
    });
    if(state.spans.length && !state.status && !state.staged)this.p.pending?.();
    if (state.staged && state.status !== "failed") {
      try { await this.commit(sessionId,state.staged); }
      catch(error) {await this.serial(async()=>{const current=await this.state(sessionId);current.status="failed";current.error=String(error);current.continuationRequired=undefined;await this.p.brain.setState(key(sessionId),current);await this.failOperation(sessionId,current);this.p.notice(current.error);});}
      return;
    }
    if (state.status === "pending") await this.process(sessionId, !!state.finalize);
    const operations=await this.p.brain.listOperations();
    for(const id of state.published) if(!operations.some(o=>o.kind==="enrich"&&o.recordId===id)) {
      const record=await this.p.brain.getRecord(id); if(record?.summary && !record.suppressed && record.thoughtStatus!=="draft")await this.p.enrich(record);
    }
  }
  /** stillFinal: a finalize pass stops early (leaving speech pending, unfailed) once it returns false. */
  async process(sessionId: string, finalize = false, retry = false, stillFinal?: () => boolean): Promise<void> {
    if(this.active) { await this.active; if(finalize) return this.process(sessionId,true,retry,stillFinal); return; }
    const work=(async()=>{
      let stoppedWithoutProgress=false,deferred=false;
      for(let batch=0;batch<(finalize?4:1);batch++) {
        if(finalize && stillFinal && !stillFinal()){deferred=true;break;}
        const before=JSON.stringify((await this.state(sessionId)).spans);
        if(await this.run(sessionId,finalize,retry && batch===0)==="deferred"){deferred=true;break;}
        const after=await this.state(sessionId);
        if(after.status==="failed" || !after.spans.length)break;
        if(JSON.stringify(after.spans)===before){stoppedWithoutProgress=true;break;}
      }
      if(finalize)await this.serial(async()=>{
        const remaining=await this.state(sessionId);
        if(remaining.spans.length && remaining.status!=="failed" && !deferred) {
          remaining.status="failed";
          remaining.continuationRequired=stoppedWithoutProgress?undefined:true;
          remaining.error=stoppedWithoutProgress
            ? "Organization made no progress; source remains saved. Review it before retrying."
            : "More saved speech is waiting to be organized. Continue with Retry organization.";
          await this.p.brain.setState(key(sessionId),remaining);
          await this.surfaceError(sessionId,remaining);
          this.p.notice(remaining.error);
        }
      });
    })(); this.active=work;
    try { await work; } finally { if(this.active===work)this.active=undefined; }
  }
  private async run(sessionId:string,finalize:boolean,retry:boolean): Promise<"deferred" | void> {
    let retentionRevision: number | undefined;
    try {
      // Preparation mutates the same buffer as append/commit. Keep every read-modify-write
      // inside their lock, including no-source finalization, for asynchronous Brain adapters.
      const prepared = await this.serial(async () => {
        const current = await this.state(sessionId);
        if(current.status === "running" && !current.staged && !retry) {
          // A stored 'running' with no call in flight means the failure marker was never written; never re-send automatically.
          current.status="failed";current.error="Interrupted organization request; source retained. Retry explicitly.";
          await this.p.brain.setState(key(sessionId),current);await this.failOperation(sessionId,current);
          return undefined;
        }
        if(current.status === "failed" && !retry)return undefined;
        if (current.staged && retry && current.status === "failed") {
          await this.p.brain.setState(`thought-rejected:${current.staged.operation}`,current.staged);
          current.staged=undefined;
        }
        if(current.staged)return current;
        if (!current.spans.length) {
          if(finalize && current.activeId) {
            const active=await this.p.brain.getRecord(current.activeId);
            if(active){const updated=await this.p.brain.updateRecord(active.id,active.revision,{thoughtStatus:"settled"});if(updated)this.p.emit(updated);}
            current.activeId=undefined;
            await this.clearSurfaced(current);
          }
          await this.p.brain.setState(key(sessionId),current);
          return undefined;
        }
        await this.ensureDraft(sessionId,current);
        await this.p.brain.setState(key(sessionId),current);
        return current;
      });
      if(!prepared)return;
      let state=prepared;
      retentionRevision=state.retentionRevision ?? 0;
      if(state.staged){await this.commit(sessionId,state.staged);return;}
      const session = await this.p.brain.getRecord(sessionId);
      if (!session) return;
      const profile=this.p.strategy ? "compact" : this.p.profile;
      // BGN-02: a turn whose answer is still running stays pending; its tool outcomes may still change the context.
      const answering=this.p.answering?.() ?? new Set<string>();
      const runningAt=state.spans.findIndex(span=>answering.has(session.segments.find(s=>s.id===span.segmentId)?.turnId ?? ""));
      if(runningAt===0)return "deferred";
      const organizable=runningAt<0 ? state.spans : state.spans.slice(0,runningAt);
      const previous=state.activeId ? await this.p.brain.getRecord(state.activeId) : undefined;
      if(state.activeId && (!previous || previous.archived || previous.suppressed))throw Error("The growing note is unavailable; review the pending text before retrying.");
      const draft=state.draftId ? await this.p.brain.getRecord(state.draftId) : undefined;
      const targetStamp=previous ? noteStamp(previous) : undefined;
      const draftStamp=draft ? manualStamp(draft) : undefined;
      let sourceSpans: SourceSpan[]=[], segments: Segment[]=[], input!: ThoughtInput, operation="", result!: ThoughtResult;
      // Requests are packed to the backend's byte bound. A 413 is refused before any provider call,
      // so repacking smaller in the same pass costs nothing (decision 7); every other failure stops here.
      for(let attempt=0, bytes=ORGANIZER_REQUEST.bytes as number;;attempt++) {
        ({spans:sourceSpans,input}=await this.pack({sessionId,session,spans:organizable,all:state.spans,profile,previous,finalize,bytes}));
        segments=input.segments;
        if(segments.every(s=>!s.text.trim())) {
          // Only whitespace is pending here (left by an older cut): nothing to organize; the transcript keeps it.
          await this.serial(async()=>{state=await this.state(sessionId);state.spans=consume(state.spans,sourceSpans);await this.p.brain.setState(key(sessionId),state);});
          return;
        }
        assertInputUnicode(input);
        const stamp = await inputDigest(JSON.stringify(input));
        if (state.checked === stamp && !retry) return;
        operation = `consolidate:${sessionId}:${stamp}`;
        await this.serial(async () => {
          state = await this.state(sessionId);
          if((state.retentionRevision ?? 0)!==retentionRevision)throw Error("Retention policy changed");
          Object.assign(state, {operation,status:"pending",finalize,error:undefined,continuationRequired:undefined});
          await this.p.brain.setState(key(sessionId),state);
          await this.p.brain.putOperation({id:operation,kind:"consolidate",recordId:sessionId,sourceRevision:session.sourceRevision,status:"pending",attempts:0});
        });
        await this.serial(async () => {
          state = await this.state(sessionId); state.status = "running";
          if((state.retentionRevision ?? 0)!==retentionRevision)throw Error("Retention policy changed");
          await this.p.brain.setState(key(sessionId),state);
          await this.p.brain.putOperation({id:operation,kind:"consolidate",recordId:sessionId,sourceRevision:session.sourceRevision,status:"running",attempts:1});
        });
        try {
          result = this.p.strategy === "plan_then_summarize"
            ? await plannedThoughts(this.p.brain,this.p.generation,input,operation,previous)
            : await this.p.generation.consolidate!(input);
          break;
        } catch(error) {
          if((error as {status?:number}).status!==413 || attempt>=2) throw error;
          const op=(await this.p.brain.listOperations()).find(o=>o.id===operation);
          if(op)await this.p.brain.putOperation({...op,status:"done",error:"Refused before dispatch (no provider call); repacked smaller."});
          const measured=/([\d,]+) bytes, over its ([\d,]+)-byte/.exec(String(error));
          const over=measured ? Number(measured[1]!.replaceAll(",",""))-Number(measured[2]!.replaceAll(",","")) : 0;
          bytes=over>0 ? bytes-over-1024 : Math.floor(bytes/2);
        }
      }
      await this.p.brain.setState(`thought-output:${operation}`,result);
      validateThoughts(input,result);
      const current = await this.p.brain.getRecord(sessionId);
      if (sourceSpans.some(span => current?.segments.find(s => s.id === span.segmentId)?.revision !== span.revision) || input.context !== await this.p.context(segments))
        throw Error("Source or work context changed during organization; result discarded. Retry with current source.");
      const staged = {input,result,spans:sourceSpans,operation,targetStamp,draftStamp,retentionRevision};
      await this.serial(async () => {
        state = await this.state(sessionId);
        if((state.retentionRevision ?? 0)!==retentionRevision)throw Error("Retention policy changed");
        state.staged = staged;
        await this.p.brain.setState(key(sessionId),state);
      });
      await this.commit(sessionId,staged);
    } catch (error) {
      await this.serial(async () => {
        const state = await this.state(sessionId);
        if(retentionRevision!==undefined && (state.retentionRevision ?? 0)!==retentionRevision)return;
        state.status = "failed"; state.error = String(error);state.continuationRequired=undefined;
        await this.p.brain.setState(key(sessionId),state);
        await this.failOperation(sessionId,state);
        this.p.notice(`Transcript saved; thought organization needs attention: ${state.error}`);
        this.p.previewChanged?.();
      });
    }
  }
  private async pack(o:{sessionId:string;session:BrainRecord;spans:SourceSpan[];all:SourceSpan[];profile?:"compact";previous?:BrainRecord;finalize:boolean;bytes:number}) {
    const slice=(spans:SourceSpan[])=>spans.map(span => {
      const s = o.session.segments.find(s => s.id === span.segmentId);
      if (!s || s.revision !== span.revision || span.end > s.text.length) throw Error("Source changed; review the pending thought.");
      return {...s, text:s.text.slice(span.start,span.end)};
    });
    const sourceText=o.previous?.segments.map(s=>`${s.speaker}: ${s.text}`).join("\n") ?? "";
    const full=thoughtExcerpt(sourceText,o.profile);
    const fullChars=full.sourceTruncated ? full.sourceExcerpt.length-EXCERPT_OMISSION.length : sourceText.length;
    const excerpt=(chars:number)=>chars>=fullChars ? full : fitExcerpt(sourceText,chars);
    const build=(spans:SourceSpan[],chars:number,context:string):ThoughtInput=>({sessionId:o.sessionId, segments:slice(spans), incremental:true,
      finalize:o.finalize && !consume(o.all,spans).length, context, ...(o.previous?{activeNote:{id:o.previous.id,title:o.previous.title,
        summary:echoSummary(o.previous.summary),sourceRevision:o.previous.sourceRevision,...excerpt(chars)}}:{})});
    const fits=(input:ThoughtInput)=>fitsOrganizerRequest(input,o.bytes);
    const largest=(lo:number,hi:number,ok:(n:number)=>boolean)=>{while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ok(mid))lo=mid;else hi=mid-1;}return lo;};
    const length=(spans:SourceSpan[])=>spans.reduce((n,s)=>n+s.end-s.start,0);
    const natural=thoughtBatch(o.spans,o.session.segments,o.profile);
    const naturalContext=await this.p.context(slice(natural));
    let input=build(natural,fullChars,naturalContext);
    if(fits(input))return {spans:natural,input};
    // Too large: shrink the old-note excerpt to its floor first, then defer later speech. Source is never clipped.
    const floor=largest(0,fullChars,k=>payloadBytes(excerpt(k).sourceExcerpt)<=ORGANIZER_REQUEST.excerptFloorBytes);
    const prefix=(chars:number)=>thoughtBatch(o.spans,o.session.segments,o.profile,chars);
    const fitting=(limit:number,context:string)=>largest(0,limit,n=>n>0 && fits(build(prefix(n),floor,context)));
    let chars=fitting(length(natural),naturalContext);
    // A heavy linked context in the natural batch can leave no room; shorter prefixes carry their own, smaller context.
    for(let k=natural.length-1;!chars && k>=1;k--) chars=fitting(length(natural.slice(0,k)),await this.p.context(slice(natural.slice(0,k))));
    if(!chars)throw Error("This speech and its linked evidence are too large for one organization request. The transcript is saved.");
    const spans=prefix(chars),context=await this.p.context(slice(spans));
    input=build(spans,largest(0,fullChars,k=>fits(build(spans,k,context))),context);
    if(!fits(input))throw Error("This speech and its linked evidence are too large for one organization request. The transcript is saved.");
    return {spans,input};
  }
  private async failOperation(sessionId: string, state: BufferState) {
    if (state.operation) {
      const op = (await this.p.brain.listOperations()).find(o => o.id === state.operation);
      if (op && op.status!=="done") await this.p.brain.putOperation({...op,status:"failed",error:state.error});
    }
    await this.surfaceError(sessionId,state);
  }
  private async surfaceError(sessionId: string, state: BufferState) {
    const ids=new Set([sessionId,state.draftId,state.activeId].filter((id):id is string=>!!id));
    // Noted before the copies are written, so the next successful pass clears them even across a restart.
    if(state.error){state.surfaced ??= {}; for(const id of ids)state.surfaced[id]=state.error; await this.p.brain.setState(key(sessionId),state);}
    // Surface organization failures on the visible note as well as its retained session.
    for(const id of ids) {
      const r=await this.p.brain.getRecord(id);
      if(r && r.error!==state.error) {const updated=await this.p.brain.updateRecord(id,r.revision,{error:state.error});if(updated)this.p.emit(updated);}
    }
  }
  /** A later pass may file the speech elsewhere, so it clears every copy still showing that failure, and no other error. */
  private async clearSurfaced(state: BufferState) {
    for(const [id,error] of Object.entries(state.surfaced ?? {})) {
      const r=await this.p.brain.getRecord(id);
      if(r?.error===error) {const updated=await this.p.brain.updateRecord(id,r.revision,{error:undefined});if(updated)this.p.emit(updated);}
    }
    state.surfaced=undefined;
  }
  private async project(sessionId: string, spans: SourceSpan[]): Promise<Segment[]> {
    const session=await this.p.brain.getRecord(sessionId);
    return coalesce(spans).map((span,n)=>{
      const source=session?.segments.find(s=>s.id===span.segmentId);
      if(!source || source.revision!==span.revision || span.end>source.text.length)throw Error("Included source was corrected; organization needs review.");
      return {...source,id:`${source.id}:part:${n}`,text:source.text.slice(span.start,span.end)};
    });
  }
  private async ensureDraft(sessionId: string, state: BufferState) {
    if(!state.spans.length || state.activeId || state.staged)return;
    const first=state.spans[0]!;
    state.draftId ??= `thought-${await inputDigest(`${sessionId}:${first.segmentId}:${first.start}`)}`;
    let record=await this.p.brain.getRecord(state.draftId);
    if(record?.archived || record?.suppressed)throw Error("The pending note is unavailable; source remains in the session.");
    const segments=await this.project(sessionId,state.spans);
    record ??= await this.p.brain.createRecord({id:state.draftId,kind:"dictation",createdAt:segments[0]!.createdAt});
    // A committed note may still be named by a checkpoint interrupted before buffer advancement.
    if(record.thoughtStatus && record.thoughtStatus!=="draft")return;
    const preview=thoughtPreview(segments);
    // Previously generated or manually edited prose stays visible during background work.
    const title=record.manualFields.includes("title") || record.summarySourceRevision!==undefined ? record.title : preview.title;
    const summary=record.manualFields.includes("summary") || record.summarySourceRevision!==undefined ? record.summary : preview.summary;
    if(same(record.segments,segments) && record.thoughtStatus==="draft" && record.title===title && record.summary===summary && record.error===state.error)return;
    const originals=await this.p.sourceRecords?.(segments) ?? [];
    const updated=await this.p.brain.updateRecord(record.id,record.revision,{
      title,summary,error:state.error,thoughtStatus:"draft",derivedSegments:segments,
      sources:[{recordId:sessionId,spans:coalesce(state.spans)}],
      ...mergeSourceMetadata(record,[sessionId,...originals.map(r=>r.id)],originals.flatMap(r=>r.attachmentIds)),quality:"pending",
    });
    if(!updated)throw Error("The pending note changed; its source is retained.");
    this.p.emit(updated);
  }
  private async commit(sessionId: string, staged: NonNullable<BufferState["staged"]>) {
    if(!staged.input.incremental)return this.commitLegacy(sessionId,staged);
    const ready:BrainRecord[]=[];
    let moreSource=false;
    await this.serial(async()=>{
      const state=await this.state(sessionId);
      if((state.retentionRevision ?? 0)!==(staged.retentionRevision ?? 0))return;
      const rest=consume(state.spans,staged.spans);
      await this.project(sessionId,staged.spans); // Check originals again, including recovery.
      if(staged.input.context!==await this.p.context(staged.input.segments))throw Error("Included work context changed; result retained for review.");
      const absolute=(span:SourceSpan):SourceSpan=>{const base=staged.spans.find(s=>s.segmentId===span.segmentId)!;return {...span,start:base.start+span.start,end:base.start+span.end};};
      if(!staged.plans) {
        const active=state.activeId ? await this.p.brain.getRecord(state.activeId) : undefined;
        const draft=state.draftId ? await this.p.brain.getRecord(state.draftId) : undefined;
        if(staged.targetStamp!== (active?noteStamp(active):undefined) || staged.draftStamp!==(draft?manualStamp(draft):undefined))
          throw Error("The note was edited during organization; result retained for review. Retry with current edits.");
        const plans:Publication[]=[];
        for(const [i,group] of staged.result.groups.entries()) {
          const extending=!!group.continuesActive;
          const target=extending?active:i===0?draft:undefined;
          const id=target?.id ?? `thought-${await inputDigest(`${staged.operation}:${i}`)}`;
          const spans=coalesce([...(extending?active?.sources?.find(s=>s.recordId===sessionId)?.spans ?? []:[]),...group.spans.map(absolute)]);
          const segments=await this.project(sessionId,spans);
          const sources=await this.p.sourceRecords?.(segments) ?? [];
          const context=await this.p.context(segments);
          if(context.length>60000)throw Error("Thought context exceeds its limit; source retained for review.");
          plans.push({id,group,spans,segments,sourceIds:[...new Set([sessionId,...sources.map(s=>s.id)])],
            attachmentIds:[...new Set(sources.flatMap(s=>s.attachmentIds))],context,
            before:target?noteStamp(target):"",draft:target?.thoughtStatus==="draft"});
        }
        staged.plans=plans;state.staged=staged;await this.p.brain.setState(key(sessionId),state);
      }
      for(const plan of staged.plans) {
        await this.project(sessionId,plan.spans);
        if(plan.context!==await this.p.context(plan.segments))throw Error("Earlier evidence changed; organization needs review.");
        let record=await this.p.brain.getRecord(plan.id);
        const sources=[{recordId:sessionId,spans:plan.spans}];
        const status=plan.group.ongoing?"growing":"settled";
        // Source projection is the commit marker: record updates are atomic, unlike a second state write.
        const applied=record && same(record.sources,sources) && same(record.segments,plan.segments) && record.thoughtStatus===status && record.summarySourceRevision===record.sourceRevision;
        if(!applied) {
          if(record && !(plan.before==="" && record.revision===0 && !record.segments.length) && noteStamp(record)!==plan.before)throw Error("A staged note changed before publication; review the saved result.");
          record ??= await this.p.brain.createRecord({id:plan.id,kind:"dictation",createdAt:plan.segments[0]!.createdAt});
          const patch:RecordPatch={title:plan.group.title,summary:plan.group.summary,thoughtStatus:status,derivedSegments:plan.segments,
            sources,sourceContext:plan.context,summarySourceRevision:record.sourceRevision+(same(record.segments,plan.segments)?0:1),
            topics:plan.group.topicSuggestions ?? (plan.group.topicSuggestion?[plan.group.topicSuggestion]:[]),
            ...mergeSourceMetadata(record,plan.sourceIds,plan.attachmentIds),quality:"pending",qualityReasons:[],error:undefined,connectionStatus:"pending"};
          const updated=await this.p.brain.updateRecord(record.id,record.revision,patch);
          if(!updated)throw Error("The note changed before publication; source retained.");
          record=updated;
        }
        if(!state.published.includes(plan.id))state.published.push(plan.id);
        ready.push(record!);
      }
      if(staged.plans.length && state.activeId && !staged.plans.some(p=>p.id===state.activeId && p.group.ongoing)) {
        const previous=await this.p.brain.getRecord(state.activeId);
        if(previous?.thoughtStatus==="growing") {const updated=await this.p.brain.updateRecord(previous.id,previous.revision,{thoughtStatus:"settled"});if(updated)this.p.emit(updated);}
      }
      await this.clearSurfaced(state);
      // A complete summary does not establish a topic boundary. Only the latest episode
      // remains eligible; returning to an older topic must create a new episode.
      // Source arriving during finalization still needs the latest episode's context.
      if(staged.plans.length)state.activeId=staged.input.finalize && !rest.length ? undefined : staged.plans.at(-1)!.id;
      if(staged.plans.some(p=>p.id===state.draftId))state.draftId=undefined;
      state.spans=coalesce([...staged.result.remainder.map(absolute),...rest]);
      state.checked=staged.result.groups.length?undefined:await inputDigest(JSON.stringify(staged.input));
      state.staged=undefined;state.status=undefined;state.error=undefined;state.continuationRequired=undefined;
      await this.ensureDraft(sessionId,state);
      await this.p.brain.setState(key(sessionId),state);
      this.p.previewChanged?.();
      const op=(await this.p.brain.listOperations()).find(o=>o.id===staged.operation);
      if(op)await this.p.brain.putOperation({...op,status:"done",error:undefined});
      moreSource=!state.finalize && state.spans.length>0 && staged.result.groups.length>0;
    });
    if(moreSource)this.p.pending?.();
    const session=await this.p.brain.getRecord(sessionId);
    if(session?.error){const updated=await this.p.brain.updateRecord(sessionId,session.revision,{error:undefined});if(updated)this.p.emit(updated);}
    for(const record of ready){this.p.emit(record);await this.p.enrich(record);}
  }
  private async commitLegacy(sessionId: string, staged: NonNullable<BufferState["staged"]>) {
    const ready: BrainRecord[] = [];
    let moreSource=false;
    await this.serial(async () => {
      const state = await this.state(sessionId);
      if((state.retentionRevision ?? 0)!==(staged.retentionRevision ?? 0))return;
      const session = await this.p.brain.getRecord(sessionId);
      if (!same(state.spans.slice(0,staged.spans.length), staged.spans) || staged.spans.some(s => session?.segments.find(x=>x.id===s.segmentId)?.revision !== s.revision) ||
          staged.input.context !== await this.p.context(staged.input.segments))
        throw Error("Source changed before publishing; staged thoughts retained for review.");
      const absolute = (span: SourceSpan): SourceSpan => {
        const base = staged.spans.find(s=>s.segmentId===span.segmentId)!;
        return {...span,start:base.start+span.start,end:base.start+span.end};
      };
      for (const [i,group] of staged.result.groups.entries()) {
        const id = i===0 && state.draftId ? state.draftId : `thought-${await inputDigest(`${staged.operation}:${i}`)}`;
        let record = await this.p.brain.getRecord(id);
        if (!record) record = await this.p.brain.createRecord({id,kind:"dictation",createdAt:staged.input.segments.find(s=>s.id===group.spans[0]!.segmentId)!.createdAt});
        if (!record.sources || record.thoughtStatus==="draft") {
          const sources = await this.p.sourceRecords?.(staged.input.segments.filter(s=>group.spans.some(span=>span.segmentId===s.id))) ?? [];
          const derivedSegments=group.spans.map((span,n)=>{const source=staged.input.segments.find(s=>s.id===span.segmentId)!;return {...source,id:`${source.id}:part:${n}`,text:source.text.slice(span.start,span.end)};});
          record = await this.p.brain.updateRecord(id,record.revision,{
            title:group.title,summary:group.summary,derivedSegments,thoughtStatus:"settled",summarySourceRevision:record.sourceRevision+(same(record.segments,derivedSegments)?0:1),
            topics:group.topicSuggestions ?? (group.topicSuggestion ? [group.topicSuggestion] : []),
            sources:[{recordId:sessionId,spans:group.spans.map(absolute)}],sourceContext:staged.input.context,
            ...mergeSourceMetadata(record,[sessionId,...sources.map(s=>s.id)],sources.flatMap(s=>s.attachmentIds)),connectionStatus:"pending",
          }) ?? record;
        }
        if (!state.published.includes(id)) state.published.push(id);
        ready.push(record);
      }
      const remainder=coalesce(staged.result.remainder);
      state.spans = [...remainder.map(absolute),...state.spans.slice(staged.spans.length)];
      state.checked = await inputDigest(JSON.stringify({...staged.input,segments:staged.input.segments.filter(s=>remainder.some(r=>r.segmentId===s.id)).map(s=>{
        const span=remainder.find(r=>r.segmentId===s.id)!; return {...s,text:s.text.slice(span.start,span.end)};
      })}));
      state.draftId=undefined;
      state.staged=undefined; state.status=undefined; state.error=undefined;state.continuationRequired=undefined;
      await this.ensureDraft(sessionId,state);
      await this.p.brain.setState(key(sessionId),state);
      const op=(await this.p.brain.listOperations()).find(o=>o.id===staged.operation);
      if(op) await this.p.brain.putOperation({...op,status:"done",error:undefined});
      moreSource=!state.finalize && state.spans.length>0 && staged.result.groups.length>0;
    });
    if(moreSource)this.p.pending?.();
    const session=await this.p.brain.getRecord(sessionId);
    if(session?.error){const updated=await this.p.brain.updateRecord(sessionId,session.revision,{error:undefined});if(updated)this.p.emit(updated);}
    for (const record of ready) { this.p.emit(record); await this.p.enrich(record); }
  }
}
