import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type {Nodes} from 'mdast';

const parser=unified().use(remarkParse).use(remarkGfm);
/** Interpret only simple legacy presentation breaks. Source stays unchanged;
 * literal code, quotations and other HTML are never executed or rewritten. */
export function presentMarkdown(source:string):string {
  if(!/<br\s*\/?>/i.test(source))return source;
  const literal:[number,number][]=[],cells:[number,number][]=[];
  const range=(node:Nodes)=>[node.position?.start.offset ?? 0,node.position?.end.offset ?? 0] as [number,number];
  const visit=(node:Nodes)=> {
    if(['code','inlineCode','blockquote'].includes(node.type)) {literal.push(range(node));return;}
    if(node.type==='tableCell')cells.push(range(node));
    if('children' in node)node.children.forEach(child=>visit(child as Nodes));
  };
  visit(parser.parse(source));
  for(const match of source.matchAll(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\p{L})'[^'\n]*'(?!\p{L})/gu))
    literal.push([match.index!,match.index!+match[0].length]);
  const within=(ranges:[number,number][],index:number)=>ranges.some(([start,end])=>index>=start&&index<end);
  return source.replace(/<br\s*\/?>/gi,(tag,index:number)=> {
    const preceding=/\\+$/.exec(source.slice(0,index))?.[0].length ?? 0;
    if(preceding%2 || within(literal,index))return tag;
    // A newline inside a pipe-table cell would accidentally split its row.
    return within(cells,index)?' ':'\n';
  });
}
