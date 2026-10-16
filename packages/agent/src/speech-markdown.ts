import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes, RootContent, PhrasingContent } from 'mdast';
import {presentMarkdown} from '../../contracts/src/markdown-presentation.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const clean = (text: string) => text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
function tree(text: string) {
  // A mathematical comparison at the start of a line is not a quotation marker.
  return parser.parse(presentMarkdown(text).replace(/^(\s{0,3})>(?==?\s*[+-]?(?:\d|\.\d))/gm, '$1\\>'));
}
function words(node: Nodes, literal?: (text: string) => string): string {
  if (node.type === 'break') return ' ';
  if (node.type === 'code') return 'Code is on screen.';
  if (node.type === 'inlineCode' && literal) return literal(node.value);
  if (node.type === 'image' || node.type === 'imageReference') return node.alt || '';
  if (node.type === 'html' || node.type === 'definition' || node.type === 'thematicBreak') return '';
  if ('value' in node) return node.value;
  if ('children' in node) {
    const inline = ['paragraph', 'heading', 'strong', 'emphasis', 'delete', 'link', 'linkReference', 'tableCell'].includes(node.type);
    return node.children.map(child => words(child as Nodes, literal)).join(inline ? '' : ' ');
  }
  return '';
}
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const days = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
  'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];
const smallNumbers = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function smallNumber(value: number): string {
  return value < 20 ? smallNumbers[value]! : `${tens[Math.floor(value / 10)]}${value % 10 ? `-${smallNumbers[value % 10]}` : ''}`;
}
function yearWords(year: number) {
  if (year >= 2000 && year < 2010) return `two thousand${year % 100 ? ` and ${smallNumber(year % 100)}` : ''}`;
  return `${smallNumber(Math.floor(year / 100))} ${year % 100 === 0 ? 'hundred' : year % 100 < 10 ? `oh ${smallNumber(year % 100)}` : smallNumber(year % 100)}`;
}
function spokenDate(value: string): string | undefined {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  // Do not reinterpret malformed dates. The explicit range avoids JavaScript's
  // special handling of years 00–99 and keeps this a calendar-date formatter.
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return;
  return `the ${days[day - 1]} of ${months[month - 1]}, ${yearWords(year)}`;
}
const units: Record<string, [string, string]> = {
  kg: ['kilogram', 'kilograms'], g: ['gram', 'grams'], mg: ['milligram', 'milligrams'],
  ml: ['millilitre', 'millilitres'], mL: ['millilitre', 'millilitres'], L: ['litre', 'litres'],
  km: ['kilometre', 'kilometres'], m: ['metre', 'metres'], cm: ['centimetre', 'centimetres'],
};
const denominators: Record<string, string> = {
  s: 'second', sec: 'second', min: 'minute', h: 'hour', hr: 'hour', hour: 'hour', day: 'day', week: 'week',
  kg: 'kilogram', g: 'gram', L: 'litre', ml: 'millilitre', mL: 'millilitre',
};
function naturalSpeech(text: string) {
  // Date syntax is deliberately unambiguous; do not guess the locale of 02/03/26.
  // Boundaries also protect filenames, path components, IDs and ISO timestamps.
  const start = String.raw`(?<![\p{L}\p{N}_./-])`;
  const end = String.raw`(?![\p{L}\p{N}_/:-]|\.[\p{L}\p{N}])`;
  const date = String.raw`\d{4}-\d{2}-\d{2}`;
  text = text.replace(new RegExp(`${start}(${date})\\s*(?:→|–|—|to)\\s*(${date})${end}`, 'gu'), (match, from: string, to: string) => {
    const first = spokenDate(from), last = spokenDate(to);
    return first && last ? `${first} to ${last}` : match;
  });
  text = text.replace(new RegExp(`${start}${date}${end}`, 'gu'), match => spokenDate(match) ?? match);
  // Only numeric, recognised rates have an unambiguous "per" meaning. Ordinary
  // slashes can mean alternatives, fractions, paths or identifiers and stay intact.
  text = text.replace(/(?<![\p{L}\p{N}_/.-])(\d+(?:\.\d+)?)\s*(kg|mg|g|ml|mL|L|km|cm|m)\/(s|sec|min|h|hr|hour|day|week|kg|g|L|ml|mL)(?![\p{L}\p{N}_/-]|\.[\p{L}\p{N}])/gu,
    (_match, quantity: string, unit: string, denominator: string) => `${quantity} ${units[unit]![Number(quantity) === 1 ? 0 : 1]} per ${denominators[denominator]}`);
  // Worded process steps can be spoken as a sequence. Single-letter variables,
  // numeric mappings, identifiers and all comparison operators remain untouched.
  return text.replace(/(?<=\b[A-Z]?[a-z]{2,})\s*→\s*(?=(?:\d+[.)]\s*)?[A-Z]?[a-z]{2,}\b)/g, ', then ');
}
/** Formatting changes only the playback string. Markdown and inline literals are
 * retained in storage, and ambiguous symbols are left for a semantic spoken outline. */
export function markdownSpeech(text: string): string {
  const literals: string[] = [];
  let prefix = '\uE000speech';
  while (text.includes(prefix)) prefix += '_';
  const spoken = naturalSpeech(clean(words(tree(text), value => {
    const token = `${prefix}${literals.length}\uE001`;
    literals.push(value);
    return token;
  })));
  return literals.reduce((result, value, i) => result.replace(`${prefix}${i}\uE001`, () => value), spoken);
}

export interface SpeechSection { label: string; explanation: string }
function boldHeading(node: RootContent): string | undefined {
  if (node.type !== 'paragraph') return;
  const meaningful = node.children.filter(child => child.type !== 'text' || child.value.trim());
  if (meaningful.length === 1 && meaningful[0]!.type === 'strong') return clean(words(meaningful[0]!));
}
function standaloneBoldLines(node: RootContent): RootContent[] {
  if (node.type !== 'paragraph') return [node];
  // CommonMark keeps a bold-only line and its following prose in one paragraph
  // when no blank line separates them. Recognize that structural line boundary.
  const lines: PhrasingContent[][] = [[]];
  for (const child of node.children) {
    if (child.type !== 'text') { lines.at(-1)!.push(child); continue; }
    child.value.split('\n').forEach((value, i) => {
      if (i) lines.push([]);
      if (value) lines.at(-1)!.push({type: 'text', value});
    });
  }
  const result: RootContent[] = [];
  let prose: PhrasingContent[] = [];
  const flush = () => { if (prose.length) result.push({type: 'paragraph', children: prose}); prose = []; };
  for (const children of lines) {
    const line = {type: 'paragraph' as const, children};
    if (boldHeading(line)) { flush(); result.push(line); }
    else { if (prose.length) prose.push({type: 'text', value: ' '}); prose.push(...children); }
  }
  flush();
  return result;
}
function tableRows(node: Extract<RootContent, {type: 'table'}>): SpeechSection[] {
  const headers = node.children[0]?.children.map(cell => clean(words(cell))) ?? [];
  return node.children.slice(1).map(row => ({
    label: clean(words(row.children[0]!)),
    explanation: row.children.slice(1).map((cell, i) => `${headers[i + 1] || 'Value'}: ${clean(words(cell))}`).join('; '),
  }));
}
function blockSpeech(node: RootContent) {
  return node.type === 'table' ? tableRows(node).map(row => `${row.label}: ${row.explanation}`).join('; ') : clean(words(node));
}

/** Main sections come from document structure, not a global search for list markers.
 * A section owns all its nested bullets/tables; an inline next-step label stays in it. */
export function speechSections(text: string): SpeechSection[] {
  const nodes = tree(text).children.flatMap(standaloneBoldLines);
  const headings = nodes.filter(node => node.type === 'heading');
  const bold = nodes.some(node => boldHeading(node));
  // A lone leading document title is not one of the sections beneath it.
  const depths = headings.map(node => node.depth);
  const level = [1, 2, 3, 4, 5, 6].find(depth => depths.filter(d => d === depth).length > 1);
  const sections: SpeechSection[] = [];
  let prefix = '';
  const append = (value: string) => {
    if (!value) return;
    if (sections.length) sections.at(-1)!.explanation = clean(`${sections.at(-1)!.explanation} ${value}`);
    else prefix = clean(`${prefix} ${value}`);
  };
  const add = (section: SpeechSection) => {
    if (!sections.length && prefix) section.explanation = clean(`${prefix} ${section.explanation}`);
    sections.push(section);
  };
  if (level || bold) {
    for (const node of nodes) {
      // When explicit heading hierarchy exists, bold labels inside it are supporting content.
      const label = node.type === 'heading' && node.depth === level ? clean(words(node)) : !level ? boldHeading(node) : undefined;
      if (label) add({label: label.replace(/^\d+[.)]\s*/, ''), explanation: ''});
      else if (node.type !== 'heading' || sections.length) append(blockSpeech(node));
    }
    if (sections.length > 1 && !sections[0]!.explanation) sections.shift();
    return sections;
  }
  const numbered = nodes.some(node => node.type === 'list' && node.ordered);
  for (const node of nodes) {
    if (node.type === 'list' && (!numbered || node.ordered)) {
      for (const item of node.children) add({label: '', explanation: clean(words(item))});
    } else if (node.type === 'table' && !numbered) {
      for (const row of tableRows(node)) add(row);
    } else append(blockSpeech(node));
  }
  return sections;
}
