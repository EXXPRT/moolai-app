import type {BrainPort, BrainRecord} from '../../contracts/src/index.js';
import {inputDigest} from './evidence.js';

interface FailedBuffer {spans: unknown[]; seen: Record<string,number>; lengths?: Record<string,number>;
  published: string[]; draftId?: string; activeId?: string; status?: string; operation?: string; [key:string]: unknown}
interface Snapshot {note: BrainRecord; buffer: FailedBuffer; history: unknown; operations: unknown;
  bufferDigest: string; archivedRevision?: number; done?: boolean}
/** Maintenance only, with exclusive workspace ownership and an external backup already taken. */
export async function retireFailedThought(brain: BrainPort, request: {
  sessionId: string; noteId: string; expectedRevision: number; bufferDigest: string;
}) {
  const key=`thought-buffer:${request.sessionId}`;
  const snapshotKey=`thought-maintenance:${request.sessionId}:${request.noteId}`;
  let snapshot=await brain.getState<Snapshot>(snapshotKey);
  if(snapshot?.done)return snapshot;
  if(!snapshot) {
    const note=await brain.getRecord(request.noteId);
    const buffer=await brain.getState<FailedBuffer>(key);
    if(!note || note.archived || note.revision!==request.expectedRevision || !buffer || buffer.status!=='failed' ||
       ![buffer.activeId,buffer.draftId].includes(note.id) || [buffer.activeId,buffer.draftId].some(id=>id && id!==note.id) ||
       await inputDigest(JSON.stringify(buffer))!==request.bufferDigest)
      throw Error('Selected failed note or buffer changed; maintenance did not start.');
    snapshot={note,buffer,bufferDigest:request.bufferDigest,history:await brain.history(note.id),
      operations:(await brain.listOperations()).filter(op=>op.id===buffer.operation || op.recordId===note.id)};
    await brain.setState(snapshotKey,snapshot); // Durable recovery intent before either mutation.
  }
  const current=await brain.getRecord(request.noteId);
  if(!current)throw Error('Selected note unavailable during maintenance.');
  if(!current.archived) {
    if(current.revision!==snapshot.note.revision)throw Error('Selected note was edited; maintenance stopped.');
    const archived=await brain.updateRecord(current.id,current.revision,{archived:true});
    if(!archived)throw Error('Selected note changed during archive.');
    snapshot.archivedRevision=archived.revision;
  } else if(current.revision!==(snapshot.archivedRevision ?? snapshot.note.revision+1)) {
    throw Error('Archived note changed during maintenance.');
  }
  await brain.setState(snapshotKey,snapshot);
  const buffer=await brain.getState<FailedBuffer>(key);
  const fresh: FailedBuffer={spans:[],seen:snapshot.buffer.seen,lengths:snapshot.buffer.lengths,
    published:snapshot.buffer.published.filter(id=>id!==request.noteId),maintenanceSnapshot:snapshotKey};
  // A crash after the replacement is safe; never overwrite subsequent fresh speech.
  if(buffer?.maintenanceSnapshot!==snapshotKey) {
    if(await inputDigest(JSON.stringify(buffer))!==snapshot.bufferDigest)throw Error('Buffer changed during maintenance.');
    await brain.setState(key,fresh);
  }
  snapshot.done=true;await brain.setState(snapshotKey,snapshot);
  return snapshot;
}
