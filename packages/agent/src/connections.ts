import type { BrainPort, BrainRecord } from '../../contracts/src/index.js';
import { noteTitle, rankRecords } from '../../contracts/src/records.js';

const origins = (r: BrainRecord, all: BrainRecord[], kind: BrainRecord['kind']) => new Set(r.links.filter(l=>l.provenance==='source' && all.some(n=>n.id===l.targetId && n.kind===kind)).map(l=>l.targetId));
const overlap = (a:Set<string>,b:Set<string>)=>[...a].some(id=>b.has(id));
const time = (r:BrainRecord)=>Date.parse(r.segments[0]?.createdAt ?? r.createdAt);
export function dismissed(a:BrainRecord,b:BrainRecord) {
  return a.links.some(l=>l.targetId===b.id && l.decision==='dismissed') || b.links.some(l=>l.targetId===a.id && l.decision==='dismissed');
}
export async function connectionCandidates(brain:BrainPort, record:BrainRecord, active?:string) {
  const all=await brain.listRecords();
  const eligible=all.filter(r=>r.id!==record.id && r.id!==active && r.kind!=='session' && !r.sourceOnly && !r.archived && !r.suppressed && !dismissed(record,r));
  const conversation=origins(record,all,'conversation'), session=origins(record,all,'session');
  const neighbours=eligible.filter(r=>overlap(conversation,origins(r,all,'conversation')))
    .sort((a,b)=>Math.abs(time(a)-time(record))-Math.abs(time(b)-time(record)) || a.id.localeCompare(b.id)).slice(0,2);
  const query=[record.body??'',...record.segments.map(s=>s.text)].join(' ');
  const close=(r:BrainRecord)=>overlap(session,origins(r,all,'session')) && Math.abs(time(r)-time(record))<=600000 ? 1:0;
  const content=rankRecords(eligible.filter(r=>!neighbours.some(n=>n.id===r.id)),query).map(x=>({r:x.record,score:x.score}))
    .sort((a,b)=>b.score-a.score || close(b.r)-close(a.r) || a.r.id.localeCompare(b.r.id));
  const candidates=[...neighbours,...content.slice(0,5-neighbours.length).map(x=>x.r)];
  const contextual=(r:BrainRecord):BrainRecord=> {
    const ids=origins(r,all,'conversation');
    // Nearby source turns resolve pronouns; source metadata and unrelated days are excluded.
    const segments=all.filter(n=>ids.has(n.id)).flatMap(n=>n.segments).filter(s=>Math.abs(Date.parse(s.createdAt)-time(r))<=600000)
      .sort((a,b)=>Math.abs(Date.parse(a.createdAt)-time(r))-Math.abs(Date.parse(b.createdAt)-time(r))).slice(0,8).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    return {...r,summary:'',topics:[],title:r.manualFields.includes('title')?r.title:'',
      sourceContext:JSON.stringify({scope:'Originating conversation context, not proof of association. Distinct projects remain distinct.',segments:segments.map(s=>({speaker:s.speaker,text:s.text.slice(0,500)}))})};
  };
  return {candidates,node:contextual(record),evidence:candidates.map(contextual),selection:candidates.map(r=>({id:r.id,reason:neighbours.includes(r)?'conversation_neighbour':'content_match'}))};
}
export async function connectNotes(brain:BrainPort, from:string, to:string) {
  const records=(await brain.listRecords()).filter(r=>r.kind!=='session' && !r.sourceOnly && !r.archived && !r.suppressed);
  function resolve(value:string) {
    const matches=records.filter(r=>r.id===value || r.title.trim().toLocaleLowerCase()===value.trim().toLocaleLowerCase() || noteTitle(r,records).toLocaleLowerCase()===value.trim().toLocaleLowerCase());
    if(matches.length!==1) throw Error(matches.length ? `Ambiguous note title: ${value}. Ask which note; do not guess.` : `No available note matches ${value}. Search for the exact titles first.`);
    return matches[0]!;
  }
  let a=resolve(from),b=resolve(to);
  if(a.id===b.id) throw Error('Choose two different notes.');
  // One canonical edge is enough; both readers already resolve incoming relationships.
  if(a.id>b.id) [a,b]=[b,a];
  if([a,b].some((r,i)=>r.links.some(l=>l.targetId===[b,a][i]!.id && ['manual','suggested'].includes(l.provenance) && l.decision!=='dismissed')) && !dismissed(a,b))
    return {saved:true,alreadyConnected:true,from:{id:a.id,title:noteTitle(a,records)},to:{id:b.id,title:noteTitle(b,records)}};
  if(dismissed(a,b)) throw Error('This connection was previously removed. It remains dismissed; ask the user to review it instead of silently restoring it.');
  if((await brain.getRecord(b.id))?.revision!==b.revision) throw Error('Target changed; connection not saved.');
  const result=await brain.updateRecord(a.id,a.revision,{links:[...a.links,{targetId:b.id,provenance:'manual',decision:'accepted',sourceRevision:a.sourceRevision,targetRevision:b.revision}],manualFields:a.manualFields,connectionStatus:'connected'});
  if(!result) throw Error('Note changed; connection not saved.');
  return {saved:true,from:{id:a.id,title:noteTitle(a,records)},to:{id:b.id,title:noteTitle(b,records)}};
}
