import type {AgentReply} from '../../contracts/src/index.js';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import type {RootContent} from 'mdast';
import {presentMarkdown} from '../../contracts/src/markdown-presentation.js';

export type AnswerRejection = 'empty_or_punctuation' | 'question_echo' | 'retrieval_promise' |
  'meta_only' | 'protocol_only' | 'heading_only' | 'narration_only_findings' | 'preface_only' | 'incomplete_structured_example';

const parser=unified().use(remarkParse);
const normalize=(value:string)=>value.toLowerCase().replace(/[`*_#]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const has=(value:Record<string,unknown>,keys:string[])=>keys.some(key=>Object.hasOwn(value,key));

/** Only positive format requests relax protocol-shaped output checks. Source
 * quotations and examples inside the request are not formatting instructions. */
function asksForStructuredContent(request:string) {
  const instruction=request.replace(/```[\s\S]*?```/g,' ').replace(/`[^`]*`/g,' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g,' ');
  return /\b(?:return|output|respond|answer|format|give|provide|show|write|produce|generate|print|demonstrate|explain|describe|quote|include|copy|reproduce)\b[^.!?\n]{0,100}\b(?:jsonl?|code|snippet|example|schema|function(?: call)?|tool(?: call| output)?|receipt)\b/i.test(instruction)
    || /\b(?:jsonl?|code|schema)\s+(?:only|format)\b/i.test(instruction);
}
function asksForHeading(request:string) {
  return /\b(?:title|heading|headline|name|label)\b/i.test(request)
    && /\b(?:give|suggest|return|write|provide|generate|what|name)\b/i.test(request)
    && !/\b(?:explain|compare|summari[sz]e|findings|evidence|why|details|analysis|along with)\b/i.test(request);
}
function protocol(value:unknown):boolean {
  if(Array.isArray(value))return value.length>0&&value.every(protocol);
  if(!object(value))return false;
  if(has(value,['tool_calls','toolCalls','function_call','functionCall']))return true;
  if(has(value,['toolCallId','tool_call_id'])&&has(value,['status','result','output','content','error']))return true;
  if(has(value,['name','tool','tool_name','function','recipient'])&&has(value,['arguments','parameters','input','args']))return true;
  if(has(value,['tool','tool_name'])&&has(value,['query','queries','id','recordId','record_id','offset','length','revision','limit']))return true;
  // A printed request envelope, as Ultra produced in the 19 Oct paid web check (MOO-059).
  if(has(value,['tool','tool_name'])&&has(value,['request','requestTurnId','callId','urls']))return true;
  if(has(value,['executed'])&&has(value,['status','tool','result','output','error','retrieved']))return true;
  if(has(value,['tool','tool_name'])&&has(value,['status','result','output','retrieved','error']))return true;
  if(value.role==='tool'&&has(value,['content','result','output']))return true;
  // A re-serialized answer envelope is not the written answer. Never unwrap it
  // into tool calls or an answer; only the provider's typed reply is executable.
  if(has(value,['text'])&&has(value,['spokenOutline','spokenText','toolCalls','references']))return true;
  return false;
}
function jsonProtocol(text:string) {
  try{return protocol(JSON.parse(text));}catch{/* JSONL has one complete value per line. */}
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(!lines.length)return false;
  try{return lines.every(line=>protocol(JSON.parse(line)));}catch{return false;}
}
function plain(node:RootContent):string {
  if('value' in node)return String(node.value);
  if('children' in node)return node.children.map(child=>plain(child as RootContent)).join('');
  return '';
}
const preface=/^(?:(?:here (?:is|are)|below (?:is|are)) (?:the |your |a )?(?:answer|summary|comparison|findings|results?|requested (?:answer|summary|information))|(?:answer|summary|comparison|findings|results?|tool (?:calls?|results?)|retrieval (?:results?|receipts?)))(?:\s+(?:from|based on) (?:the |your )?(?:notes|evidence|sources))?\s*[:.!]?$/i;
function heading(node:RootContent):boolean {
  if(node.type==='heading'||node.type==='thematicBreak')return true;
  if(node.type!=='paragraph')return false;
  const meaningful=node.children.filter(child=>child.type!=='text'||child.value.trim());
  // Bold sentences and short factual values are still answers. Standalone
  // bold heading conventions must not impose a minimum answer length.
  const text=plain(node).trim();
  if(/[.!?]$/.test(text)||shortValue(text))return false;
  return meaningful.length>0&&meaningful.every(child=>child.type==='strong');
}
const shortValue=(text:string)=>/^(?:yes|no|unknown|unavailable|not yet|planned|completed|passed|failed)[.!]?$/i.test(text)
  || /^(?:[$€£]?\d[\d\s,.:/%+−–-]*)(?:\s*(?:kg|g|m|cm|mm|s|ms|seconds?|minutes?|hours?|days?|months?|years?))?[.!]?$/i.test(text)
  || /^(?=[A-Za-z\d._/+-]*\d)[A-Za-z][A-Za-z\d._/+-]*$/.test(text)
  || /^(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})$/.test(text);
function protocolOnly(text:string) {
  const nodes=parser.parse(text).children;
  let found=false;
  for(const node of nodes) {
    if(heading(node)||preface.test(plain(node).trim()))continue;
    if(node.type==='blockquote')return false; // Intentionally quoted content is not an attempted call.
    const value=plain(node).trim();
    const functionLike=/^(?:(?:call|tool|function)\s*:\s*)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\(\s*([\s\S]*)\s*\)\s*;?$/.exec(value);
    let shaped=jsonProtocol(value) || /^<(function|tool_call|tool_calls|function_call|invoke)\b[^>]*>[\s\S]*<\/\1>\s*$/i.test(value);
    if(!shaped&&functionLike) {
      try {shaped=object(JSON.parse(functionLike[1]!));}catch{/* Not a parseable invocation-shaped body. */}
    }
    if(!shaped)return false;
    found=true;
  }
  return found;
}
function hasNarration(reply:AgentReply) {
  const points=Array.isArray(reply.spokenOutline?.points)?reply.spokenOutline.points:[];
  return !![reply.spokenText,reply.spokenOutline?.overview,...points.map(point=>point?.explanation)]
    .some(value=>typeof value==='string'&&/[\p{L}\p{N}]/u.test(value));
}

function asksForPartialSyntax(request:string) {
  return /\b(?:opening|closing|first|last|single|literal)\s+(?:brace|bracket|parenthesis|character|delimiter)\b|\b(?:prefix|partial|incomplete|unfinished)\s+(?:json|code|example|snippet|object|array|prefix)\b|\b(?:json|code|example|snippet)\s+(?:prefix|fragment)\b/i.test(request);
}
function unquoteSyntax(text:string) {
  return text.trim().replace(/^```[^\n]*\n/,'').replace(/\n?```$/,'').replace(/^`|`$/g,'').trim();
}
/** This narrow post-run guard catches a delivery introduction followed only by
 * an opening delimiter. It does not attempt general code compilation or grade
 * whether an otherwise complete example implements the user's requirements. */
function incompleteStructuredExample(text:string,request:string) {
  if(!asksForStructuredContent(request)||asksForPartialSyntax(request))return false;
  const nodes=parser.parse(text).children.filter(node=>node.type!=='definition'&&node.type!=='thematicBreak');
  const content=nodes.filter(node=>!heading(node));
  if(!content.length)return false;
  const last=content.at(-1)!;
  const onlyOpening=(value:string)=>/^[{[(]$/.test(unquoteSyntax(value));
  const introduction=(value:string)=>/\b(?:json|code|snippet|example|sample|object|array|function)\b/i.test(value)&&/:\s*$/.test(value);
  if(content.length===1&&onlyOpening(plain(last)))return true;
  if(onlyOpening(plain(last))&&content.slice(0,-1).every(node=>introduction(plain(node))))return true;
  if(content.length!==1||last.type==='blockquote')return false;
  const match=/^([\s\S]*:)\s*(`?[{[(]`?)\s*$/.exec(plain(last));
  return !!match&&introduction(match[1]!);
}
function requestedPunctuationValue(text:string,request:string) {
  const value=unquoteSyntax(text);
  if(asksForPartialSyntax(request)&&/^[{}[\]()]$/.test(value))return true;
  if(!asksForStructuredContent(request))return false;
  try {const parsed:unknown=JSON.parse(value);return object(parsed)||Array.isArray(parsed);}catch{return false;}
}

/** Structural admission only. A valid result still requires independent review
 * for factual support, chronology, completeness and actual citation support. */
export function nonAnswerReason(reply:AgentReply,request:string):AnswerRejection|undefined {
  const text=presentMarkdown(reply.text).trim();
  if(incompleteStructuredExample(text,request))return 'incomplete_structured_example';
  if(text&&requestedPunctuationValue(text,request))return undefined;
  if(!text||!/[\p{L}\p{N}]/u.test(text))return hasNarration(reply)?'narration_only_findings':'empty_or_punctuation';
  const normalized=normalize(text).replace(/^(?:question|your question|user request) /,'');
  if(normalized===normalize(request))return 'question_echo';
  if(!asksForStructuredContent(request)&&protocolOnly(text))return 'protocol_only';
  const nodes=parser.parse(text).children.filter(node=>node.type!=='definition'&&node.type!=='thematicBreak');
  const onlyShortValue=nodes.length===1&&shortValue(plain(nodes[0]!).trim());
  if(nodes.length&&nodes.every(heading)&&!asksForHeading(request)&&!onlyShortValue)return hasNarration(reply)?'narration_only_findings':'heading_only';
  if(nodes.length&&nodes.every(node=>heading(node)||preface.test(plain(node).trim()))&&!asksForHeading(request)&&!onlyShortValue)return hasNarration(reply)?'narration_only_findings':'preface_only';
  const parts=text.replace(/^[ \t]*[-*#]+[ \t]*/gm,'').split(/[.!?]+(?:\s+|$)|\n+/).map(p=>p.trim()).filter(Boolean);
  const futureRead=/^(?:i(?:['’]ll| will| am going to)|let me)\s+(?:search|look|check|read|retrieve|find|pull|review|inspect)\b/i;
  const continuation=/^(?:then i(?:['’]ll| will)|i(?:['’]ll| will))\s+(?:answer|explain|summarize|get back|report|compare)\b/i;
  if(parts.length&&parts.every(p=>(futureRead.test(p)||continuation.test(p))&&!/\b(?:but|however|found|shows?|states?|recorded|according)\b/i.test(p)))return 'retrieval_promise';
  const reasoning=/^(?:the user (?:is asking|asks|wants)|(?:this|the) (?:question|request) (?:asks|is asking)|i (?:need|should|must) (?:to )?(?:search|look|check|read|retrieve|find|pull|review|inspect|answer|explain|compare))\b/i;
  if(parts.length&&parts.every(p=>reasoning.test(p)))return 'meta_only';
  return undefined;
}
