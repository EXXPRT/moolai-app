import type { BrainPort, Segment } from '../../contracts/src/index.js';
import { transcriptText } from '../../contracts/src/index.js';
import { compactToolOutcome } from './response-output.js';

/** Only included source and outcomes belonging to those requests affect batch identity.
 * Legacy outcomes without request IDs use the included source timestamp window.
 * Later work status, unrelated tools and generated metadata are not source revisions. */
export async function thoughtContext(brain:BrainPort, segments:Segment[]) {
  const times=segments.map(s=>s.createdAt).sort();
  const cutoff=times.at(-1) ?? '', start=times[0] ?? '';
  const turns=new Set(segments.map(s=>s.turnId));
  const ids=new Set<string>();
  for(const s of segments) { const id=await brain.getState<string>(`turn-record:${s.turnId}`); if(id)ids.add(id); }
  const result=[];
  for(const id of ids) {
    const record=await brain.getRecord(id); if(record?.kind!=='conversation') continue;
    const requests=[];
    for(const link of record.links.filter(l=>l.provenance==='reply')) {
      const original=await brain.getRecord(link.targetId);
      if(original && original.createdAt<=cutoff) requests.push({id:original.id,sourceRevision:original.sourceRevision,source:transcriptText(original)});
    }
    const outcomes=[];
    for(const item of await brain.getState<any[]>(`tool-ledger:${id}`) ?? []) {
      const at=item.at ?? (await brain.getState<{at?:string}>(`tool:${id}:${item.call.id}`))?.at;
      const included=item.requestTurnId ? turns.has(item.requestTurnId) : !!at && at>=start && at<=cutoff;
      if(included) outcomes.push(compactToolOutcome(item));
    }
    result.push({conversationId:id,requests,outcomes,scope:'Only confirmed outcomes establish completed work. Requests without outcomes remain unresolved.'});
  }
  return JSON.stringify(result);
}
