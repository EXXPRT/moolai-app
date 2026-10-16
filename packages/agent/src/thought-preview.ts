import type { Segment } from "../../contracts/src/index.js";

const compact = (value:string) => value.replace(/\s+/g," ").trim();
const excerpt = (value:string, limit:number) => {
  if(value.length<=limit)return value;
  const cut=value.slice(0,limit);const space=cut.lastIndexOf(" ");
  return cut.slice(0,space>limit/2?space:limit).trimEnd()+"…";
};
const quote = (value:string) => value.replace(/([\\`*_{}\[\]<>#])/g,"\\$1");
/** Extractive preview only: selected attributed source, never invented or marked as a Nano summary. */
export function thoughtPreview(segments:Segment[]):{title:string;summary:string} {
  const source=segments.filter(s=>s.final && s.speaker!=="system" && compact(s.text));
  const first=source.find(s=>s.speaker==="user") ?? source[0];
  const title=excerpt(compact(first?.text ?? "Recorded thought"),80);
  const selected=source.length<=4?source:[source[0]!,source[1]!,source[source.length-2]!,source[source.length-1]!];
  const summary=selected.map(s=>`> **${s.speaker==="user"?"You":"Moo"}:** ${quote(excerpt(compact(s.text),260))}`).join("\n\n");
  return {title,summary};
}
