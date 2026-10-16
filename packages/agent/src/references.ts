import type { AgentReply, BrainRecord } from "../../contracts/src/index.js";
import { noteTitle } from "../../contracts/src/records.js";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const addressBoundary = (pattern: string) => `(?<![\\p{L}\\p{N}_-])(?:${pattern})(?![\\p{L}\\p{N}_-])`;

/** Resolve only known addresses; never strip arbitrary alphanumeric facts. */
export function resolveNoteReferences(reply: AgentReply, records: BrainRecord[]): AgentReply {
  const used = records.filter(r => reply.references?.some(ref=>ref.recordId===r.id) ||
    (r.id.length >= 16 && (reply.text.includes(r.id) || reply.spokenText?.includes(r.id) || JSON.stringify(reply.spokenOutline)?.includes(r.id))));
  const references = used.filter(r=>!r.archived && !r.suppressed && !r.sourceOnly && r.kind !== 'session')
    .map(r=>({recordId:r.id,title:noteTitle(r,records)}));
  const titles = new Map(used.map(record => [record.id, noteTitle(record, records)]));
  const readable = [...new Set(used.flatMap(record => [record.title.trim(), titles.get(record.id)!]).filter(Boolean))];
  const render = (text: string) => {
    if (!used.length) return text;
    // A short imported ID can be a word within its own title. Protect complete
    // titles and substitute addresses once, without rewriting inserted titles.
    const protectedRanges = readable.flatMap(title => [...text.matchAll(new RegExp(addressBoundary(escape(title)), 'giu'))]
      .map(match => [match.index, match.index + match[0].length] as const));
    const addresses = [...titles.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');
    return text.replace(new RegExp(addressBoundary(addresses), 'gu'), (id: string, offset: number) =>
      protectedRanges.some(([start, end]) => offset >= start && offset + id.length <= end) ? id : titles.get(id)!);
  };
  return {...reply,text:render(reply.text),spokenText:reply.spokenText ? render(reply.spokenText):undefined,references, spokenOutline:reply.spokenOutline ? {overview:render(reply.spokenOutline.overview),points:reply.spokenOutline.points.map(p=>({...p,label:render(p.label),explanation:render(p.explanation)}))}:undefined};
}
