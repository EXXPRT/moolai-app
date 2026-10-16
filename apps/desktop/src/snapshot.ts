import type { AgentEvent, AgentState, BrainRecord, LiveThoughtPreview, LocalFolder } from '../../../packages/contracts/src/index.js';

export type Snapshot = {
  sequence?: number;
  state: AgentState;
  records: BrainRecord[];
  mode: string;
  processing?: {status:'available'|'unavailable'|'checking';checkedAt?:string};
  native?: Record<string, unknown>;
  thoughtProcessing?: {status:string;error?:string;pending:boolean;continuationRequired?:boolean;recordId?:string};
  liveThought?: LiveThoughtPreview;
  localFolders: LocalFolder[];
};
export type SnapshotEvent = AgentEvent & {sequence?:number};
export function applySnapshotEvent(current: Snapshot, event: SnapshotEvent): Snapshot {
  if (event.sequence !== undefined && current.sequence !== undefined && event.sequence < current.sequence) return current;
  let next=current;
  if(event.type==='state' && event.state) next={...current,state:event.state};
  if(event.type==='voice' && event.voice) next={...current,native:event.voice};
  if(event.type==='thought_preview') next={...current,liveThought:event.preview};
  if(event.type==='record' && event.record) {
    const old=current.records.find(record=>record.id===event.record!.id);
    if(!old || old.revision<=event.record.revision)
      next={...current,records:[event.record,...current.records.filter(record=>record.id!==event.record!.id)]};
  }
  return event.sequence===undefined ? next : {...next,sequence:event.sequence};
}
/** A snapshot represents the state at its sequence; replay only newer pushed changes. */
export function reconcileSnapshot(next: Snapshot, events: SnapshotEvent[]): Snapshot {
  return events.reduce((snapshot,event)=> event.sequence!==undefined && next.sequence!==undefined && event.sequence<=next.sequence
    ? snapshot : applySnapshotEvent(snapshot,event),next);
}
