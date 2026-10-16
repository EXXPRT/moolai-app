import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { RootContent, ListItem } from 'mdast';
import { transcriptText, type BrainRecord, type Speaker } from '../../contracts/src/index.js';
import { noteTitle } from '../../contracts/src/records.js';

const MAX_CHARACTERS = 6000;
const DEFAULT_CHARACTERS = 2400;
const MAX_PASSAGES = 3;
const TEMPORAL = new Set('current latest status historical superseded dated earlier later implemented demonstrated updated update updates now still when before after'.split(' '));
const STOP = new Set(`a an the and or but if to of in on at by for from with is are was were be been being it its this that these those as i we you they my our your not only user assistant please what how why when where who which can could do does did have has had will would should may me us their them than then about into through tell explain show give find search read compare summarize summary note notes record records document documents saved information details relevant following using use`.split(/\s+/));
type Range = { start: number; end: number };
type OffsetRange = { offset: number; nextOffset: number };
type Origin = Range & { contentStart: number; kind: 'authored' | 'transcript'; speaker?: Speaker; segmentId?: string; segmentRevision?: number; capturedAt?: string };
type Section = Range & { heading?: Range; ancestors?: Range[]; blocks: Range[]; origin: Origin };
type Token = Range & { value: string };
export interface SectionContext extends OffsetRange {
  /** Bounds only: omitted headings are not smuggled into unmetered metadata. */
  heading?: OffsetRange & { included: boolean };
  ancestors?: Array<OffsetRange & { included: boolean }>;
  /** First byte-equivalent UTF-16 position in this section absent from this evidence entry. */
  firstUnreadOffset?: number;
}
export interface SourceDate extends OffsetRange {
  scope: 'section_heading' | 'source_text';
  format: 'iso' | 'named_month' | 'ambiguous_numeric';
  meaning: 'document_section_date' | 'record_lifecycle_marker' | 'unclassified_source_date';
}
export interface SelectedPassage extends OffsetRange {
  original: string;
  startsMidLine: boolean;
  endsMidLine: boolean;
  attribution: Array<{kind: 'authored' | 'transcript'; speaker?: Speaker; segmentId?: string;
    segmentRevision?: number; capturedAt?: string; continuedFromEarlier: boolean}>;
  sections: SectionContext[];
  /** Written dates retain location/type, not an inferred event or successful outcome. */
  dates: SourceDate[];
}
export interface PassageEvidence {
  id: string; title: string; revision: number; sourceRevision: number;
  passages: SelectedPassage[];
  truncated: boolean;
  totalCharacters: number;
  returnedCharacters: number;
  omittedRanges: OffsetRange[];
  selection: 'whole_word_query' | 'prefix_fallback' | 'complete_source';
  matchedTerms: string[];
  quality: BrainRecord['quality']; qualityReasons: string[]; topics: string[]; offTopic?: BrainRecord['offTopic'];
  recordTimes: { createdAt: string; updatedAt: string; meaning: 'record_lifecycle_not_event_time' };
}

function tokens(text: string, offset = 0): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)].map(m => ({ value: m[0].toLowerCase(), start: offset + m.index, end: offset + m.index + m[0].length }));
}
function boundaries(text: string): number[] {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(s => s.index).concat(text.length);
}
function snap(points: number[], n: number, ceil = false): number {
  let low = 0, high = points.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (points[mid]! < n) low = mid + 1; else high = mid; }
  return points[low]! > n && !ceil ? points[Math.max(0, low - 1)]! : points[low]!;
}
function origins(record: BrainRecord): Origin[] {
  const out: Origin[] = []; let start = 0;
  if (record.body) {
    const end = 'Authored note:\n'.length + record.body.length;
    out.push({ start, contentStart: 'Authored note:\n'.length, end, kind: 'authored' });
    start = end + (record.segments.length ? 2 : 0);
  }
  record.segments.forEach(segment => {
    const contentStart = start + `${segment.speaker}: `.length, end = contentStart + segment.text.length;
    out.push({ start, contentStart, end, kind: 'transcript', speaker: segment.speaker, segmentId: segment.id, segmentRevision: segment.revision, capturedAt: segment.createdAt });
    start = end + 1;
  });
  return out;
}
function nodeRange(node: RootContent | ListItem, offset: number): Range {
  return { start: offset + node.position!.start.offset!, end: offset + node.position!.end.offset! };
}
function isHeading(node: RootContent): boolean {
  return node.type === 'heading' || (node.type === 'paragraph' && node.children.length === 1 && node.children[0]?.type === 'strong');
}
function parts(node: RootContent, source: string, base: number): Array<Range & { heading: boolean; depth?: number }> {
  const range = nodeRange(node, base);
  if (isHeading(node)) return [{ ...range, heading: true, depth: node.type === 'heading' ? node.depth : 2 }];
  if (node.type === 'list') return node.children.map(item => ({ ...nodeRange(item, base), heading: false }));
  if (node.type === 'thematicBreak') return [];
  if (node.type !== 'paragraph') return [{ ...range, heading: false }];
  // Markdown permits a bold heading and its body without a blank line. They are
  // one paragraph in the AST, but a standalone strong line remains a section.
  const headings = node.children.filter(child => child.type === 'strong').map(child => {
    const start = base + child.position!.start.offset!, end = base + child.position!.end.offset!;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const newline = source.indexOf('\n', end), lineEnd = newline < 0 ? source.length : newline;
    return { start, end, standalone: source.slice(Math.max(base, lineStart), lineEnd).trim() === source.slice(start, end).trim() };
  }).filter(item => item.standalone);
  if (!headings.length) return [{ ...range, heading: false }];
  const out: Array<Range & { heading: boolean; depth?: number }> = []; let cursor = range.start;
  for (const heading of headings) {
    if (source.slice(cursor, heading.start).trim()) out.push({ start: cursor, end: heading.start, heading: false });
    out.push({ start: heading.start, end: heading.end, heading: true, depth: 2 }); cursor = heading.end;
  }
  if (source.slice(cursor, range.end).trim()) out.push({ start: cursor, end: range.end, heading: false });
  return out;
}
/** Parse each attributed turn separately, so its first Markdown line can really be a heading. */
function sections(source: string, sourceOrigins: Origin[]): Section[] {
  const output: Section[] = [];
  for (const origin of sourceOrigins) {
    const nodes = unified().use(remarkParse).parse(source.slice(origin.contentStart, origin.end)).children;
    const ancestors: Array<Range & { depth: number }> = [];
    let current: Section = { start: origin.start, end: origin.end, blocks: [], origin };
    for (const range of nodes.flatMap(node => parts(node, source, origin.contentStart))) {
      if (range.heading) {
        if (current.blocks.length || current.heading) { current.end = range.start; output.push(current); }
        while (ancestors.length && ancestors[ancestors.length - 1]!.depth >= range.depth!) ancestors.pop();
        current = { start: range.start, end: origin.end, heading: range, ancestors: ancestors.slice(-2), blocks: [], origin };
        ancestors.push({ start: range.start, end: range.end, depth: range.depth! });
      } else current.blocks.push(range);
    }
    if (current.blocks.length || current.heading || current.end > current.start) output.push(current);
  }
  return output;
}
function overlap(a: Range, b: Range): boolean { return a.start < b.end && a.end > b.start; }
function covered(range: Range, windows: Range[]): boolean { return windows.some(w => w.start <= range.start && w.end >= range.end); }
function merged(windows: Range[]): Range[] {
  const result: Range[] = [];
  for (const window of windows.filter(w => w.end > w.start).sort((a, b) => a.start - b.start)) {
    const last = result[result.length - 1];
    if (last && last.end >= window.start) last.end = Math.max(last.end, window.end);
    else result.push({ ...window });
  }
  return result;
}
function terms(range: Range, hits: Token[]): Set<string> { return new Set(hits.filter(h => h.start >= range.start && h.end <= range.end).map(h => h.value)); }

function focus(source: string, block: Range, hits: Token[], limit: number): Range {
  if (block.end - block.start <= limit) return block;
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source.slice(block.start, block.end))]
    .map(s => ({ start: block.start + s.index, end: block.start + s.index + s.segment.length }));
  const best = sentences.map((sentence, index) => ({ sentence, index, score: terms(sentence, hits).size }))
    .filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.sentence.start - b.sentence.start)[0];
  if (!best) return block;
  if (best.sentence.end - best.sentence.start > limit) {
    const hit = hits.find(h => h.start >= best.sentence.start && h.end <= best.sentence.end)!;
    const start = Math.max(best.sentence.start, hit.start - Math.floor(limit / 3));
    return { start, end: Math.min(best.sentence.end, start + limit) };
  }
  const next = sentences[best.index + 1];
  return { start: best.sentence.start, end: next && next.end - best.sentence.start <= Math.min(limit, 400) ? next.end : best.sentence.end };
}

function contextualWindow(section: Section, anchor: Range, limit: number, points: number[]): Range[] {
  if (section.end - section.start <= limit) return [{ start: section.start, end: section.end }];
  const endAt = (start: number, amount: number): number => snap(points, Math.min(section.end, start + amount));
  const heading = section.heading;
  // Prefer a whole paragraph/list item with its real heading. This is not a fixed-width keyword window.
  if (anchor.end - section.start <= limit) {
    let end = anchor.end;
    for (const block of section.blocks) if (block.end >= end && block.end - section.start <= limit) end = block.end;
    return [{ start: section.start, end }];
  }
  const headingCost = heading ? heading.end - heading.start : 0;
  // A long heading must not consume the complete allowance while returning no statement.
  if (heading && headingCost < limit / 2 && anchor.start > heading.end) {
    const available = limit - headingCost;
    let end = endAt(anchor.start, available);
    if (anchor.end <= end) {
      end = anchor.end;
      for (const block of section.blocks) if (block.start >= anchor.end && block.end - anchor.start <= available) end = block.end;
    }
    return [{ ...heading }, { start: anchor.start, end }];
  }
  const start = snap(points, anchor.start, true);
  return [{ start, end: endAt(start, limit) }];
}
function contextualWithAncestors(source: string, section: Section, anchor: Range, limit: number, points: number[], existing: Range[]): Range[] {
  const ancestors = (section.ancestors ?? []).filter(a => !covered(a, existing));
  if (section.heading && sourceDates(source, section.heading, [section]).length) return contextualWindow(section, anchor, limit, points);
  // Prefer a dated enclosing scope, otherwise the nearest enclosing heading.
  // Its literal text is a normal metered passage, never a fabricated metadata prefix.
  const dated = ancestors.filter(a => /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\s+[A-Z][a-z]+\s+\d{4})\b/.test(source.slice(a.start, a.end)));
  const ancestor = dated[dated.length - 1] ?? ancestors[ancestors.length - 1];
  const size = ancestor ? ancestor.end - ancestor.start : 0;
  if (!ancestor || size >= limit / 3 || existing.length >= MAX_PASSAGES - 1) return contextualWindow(section, anchor, limit, points);
  const body = contextualWindow(section, anchor, limit - size, points);
  return existing.length + body.length + 1 <= MAX_PASSAGES ? [ancestor, ...body] : body;
}

/** Dates are copied only from returned source; no parsing into an assumed event chronology/timezone. */
function sourceDates(source: string, window: Range, structural: Section[]): SourceDate[] {
  const months = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const re = new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?|\\d{1,2}[ /-]\\d{1,2}[ /-]\\d{2,4}|\\d{1,2}\\s+${months}\\s+\\d{4}|${months}\\s+\\d{1,2},?\\s+\\d{4})\\b`, 'gi');
  return [...source.slice(window.start, window.end).matchAll(re)].slice(0, 6).map(m => {
    const start = window.start + m.index, end = start + m[0].length;
    const inHeading = structural.some(s => s.heading && start >= s.heading.start && end <= s.heading.end);
    const lineStart = source.lastIndexOf('\n', start - 1) + 1, newline = source.indexOf('\n', end);
    const line = source.slice(lineStart, newline < 0 ? source.length : newline).replace(/^\s*>\s*/, '');
    const lifecycle = /^\s*(?:created|updated|imported(?:\s+(?:at|on))?)\s*:/i.test(line) || /^\s*Imported (?:copy|record|document)\b/i.test(line);
    return { offset: start, nextOffset: end, scope: inHeading ? 'section_heading' : 'source_text', meaning: inHeading ? 'document_section_date' : lifecycle ? 'record_lifecycle_marker' : 'unclassified_source_date', format: /^\d{4}-/.test(m[0]) ? 'iso' : /[a-z]/i.test(m[0]) ? 'named_month' : 'ambiguous_numeric' };
  });
}
function finish(record: BrainRecord, source: string, sourceOrigins: Origin[], structural: Section[], windows: Range[], selection: PassageEvidence['selection'], hits: Token[]): PassageEvidence {
  const passages = windows.map(window => ({
    original: source.slice(window.start, window.end), offset: window.start, nextOffset: window.end,
    startsMidLine: window.start > 0 && !/[\r\n]/.test(source[window.start - 1]!),
    endsMidLine: window.end < source.length && !/[\r\n]/.test(source[window.end]!),
    attribution: sourceOrigins.filter(origin => overlap(origin, window)).map(({ kind, speaker, segmentId, segmentRevision, capturedAt, start }) => ({ kind, speaker, segmentId, segmentRevision, capturedAt, continuedFromEarlier: start < window.start })),
    sections: structural.filter(section => overlap(section, window)).slice(0, 3).map(section => {
      let cursor = section.start;
      for (const part of windows) { if (part.start > cursor) break; if (part.end > cursor) cursor = Math.min(section.end, part.end); }
      return { offset: section.start, nextOffset: section.end, ...(section.heading ? { heading: { offset: section.heading.start, nextOffset: section.heading.end, included: covered(section.heading, windows) } } : {}), ...(section.ancestors?.length ? { ancestors: section.ancestors.map(a => ({ offset: a.start, nextOffset: a.end, included: covered(a, windows) })) } : {}), ...(cursor < section.end ? { firstUnreadOffset: cursor } : {}) };
    }),
    dates: sourceDates(source, window, structural),
  }));
  const omittedRanges: OffsetRange[] = []; let cursor = 0;
  for (const passage of passages) { if (cursor < passage.offset) omittedRanges.push({ offset: cursor, nextOffset: passage.offset }); cursor = passage.nextOffset; }
  if (cursor < source.length) omittedRanges.push({ offset: cursor, nextOffset: source.length });
  return { id: record.id, title: noteTitle(record).trim() || 'Saved thought', revision: record.revision, sourceRevision: record.sourceRevision,
    passages, truncated: omittedRanges.length > 0, totalCharacters: source.length, returnedCharacters: passages.reduce((n, p) => n + p.original.length, 0), omittedRanges, selection,
    matchedTerms: [...new Set(windows.flatMap(window => [...terms(window, hits)]))].sort(),
    quality: record.quality, qualityReasons: [...record.qualityReasons], topics: [...record.topics], offTopic: record.offTopic,
    recordTimes: { createdAt: record.createdAt, updatedAt: record.updatedAt, meaning: 'record_lifecycle_not_event_time' },
  };
}
function checkedBudget(budget: number): number {
  if (!Number.isFinite(budget) || budget < 1) throw new RangeError('Passage budget must be positive and finite.');
  return Math.min(MAX_CHARACTERS, Math.floor(budget));
}

export function selectPassages(record: BrainRecord, query: string, budget = DEFAULT_CHARACTERS): PassageEvidence {
  const limit = checkedBudget(budget), source = transcriptText(record), sourceOrigins = origins(record), structural = sections(source, sourceOrigins), points = boundaries(source);
  const queryTerms = new Set(tokens(query).map(t => t.value).filter(t => !STOP.has(t)));
  const contextualTerms = new Set(tokens([record.title, ...record.topics].join(' ')).map(t => t.value));
  const hits = tokens(source).filter(t => queryTerms.has(t.value));
  const temporalQuery = tokens(query).some(t => TEMPORAL.has(t.value));
  const subjectTerms = new Set([...queryTerms].filter(t => !TEMPORAL.has(t)));
  const weight = (term: string): number => contextualTerms.has(term) ? 1.5 : 1;
  let selection: PassageEvidence['selection'] = source.length <= limit ? 'complete_source' : hits.length ? 'whole_word_query' : 'prefix_fallback';
  let windows: Range[] = [];
  if (source.length <= limit || !hits.length) { const end = snap(points, Math.min(limit, source.length)); if (end) windows = [{ start: 0, end }]; }
  else {
    const candidates = structural.map(section => {
      const sectionTerms = terms(section, hits), headingTerms = section.heading ? terms(section.heading, hits) : new Set<string>();
      const ranked = section.blocks.map(block => ({ block, score: [...terms(block, hits)].reduce((n, term) => n + weight(term), 0) })).sort((a, b) => b.score - a.score || a.block.start - b.block.start);
      const anchor = ranked.find(item => item.score > 0)?.block ?? ranked[0]?.block ?? section;
      const score = [...sectionTerms].reduce((n, term) => n + weight(term), 0) + headingTerms.size * .25;
      return { section, anchor, score, terms: sectionTerms };
    }).filter(c => c.score > 0 && c.section.blocks.length > 0).sort((a, b) => b.score - a.score || a.section.start - b.section.start);
    const selected: typeof candidates = [], used = new Set<string>();
    // A status question needs the applicable update as well as a keyword-dense
    // historical paragraph. Reserve one section for a dated, relevant heading;
    // never sort dates into a truth order (a future plan is not a completed test).
    // Dates in prose, frontmatter or import notices do not qualify as headings.
    const dated = temporalQuery ? candidates.find(c => {
      const scopes = [...(c.section.ancestors ?? []), ...(c.section.heading ? [c.section.heading] : [])];
      return c.section.blocks.length > 0 && [...c.terms].some(t => subjectTerms.has(t)) && scopes.some(scope => sourceDates(source, scope, structural).length > 0);
    }) : undefined;
    if (dated) {
      // The heading and lead establish what the dated update actually says.
      // A later caveat may repeat the query more often but cannot replace that
      // statement. Unread offsets expose further evidence for a bounded read.
      selected.push({ ...dated, anchor: dated.section.blocks[0]! });
      candidates.splice(candidates.indexOf(dated), 1); dated.terms.forEach(term => used.add(term));
    }
    // Keep room for substantive prose from both claims. Three thin heading
    // fragments have worse evidence coverage than two useful status sections.
    if (dated && candidates.some(c => c.section.heading)) {
      // A generic import notice may match every historical-status word without
      // stating a status. Prefer another actual section when one is available;
      // its literal lifecycle context is still accessible by explicit read.
      for (let i = candidates.length - 1; i >= 0; i--) if (!candidates[i]!.section.heading || ![...candidates[i]!.terms].some(t => subjectTerms.has(t))) candidates.splice(i, 1);
    }
    const sectionLimit = dated ? 2 : MAX_PASSAGES;
    while (selected.length < sectionLimit && candidates.length) {
      candidates.sort((a, b) => {
        const score = (c: typeof a): number => c.score + [...c.terms].filter(t => !used.has(t)).reduce((n, t) => n + weight(t), 0);
        return score(b) - score(a) || a.section.start - b.section.start;
      });
      const next = candidates.shift()!; selected.push(next); next.terms.forEach(term => used.add(term));
    }
    let remaining = limit;
    for (let index = 0; index < selected.length && remaining > 0; index++) {
      const candidate = selected[index]!;
      const reserve = selected.slice(index + 1).reduce((n, c) => n + Math.min(240, c.anchor.end - c.anchor.start + (c.section.heading ? c.section.heading.end - c.section.heading.start : 0)), 0);
      const allowance = Math.max(1, remaining - Math.min(reserve, Math.floor(remaining / 2)));
      const anchor = focus(source, candidate.anchor, hits, allowance);
      let added = contextualWithAncestors(source, candidate.section, anchor, allowance, points, windows);
      if (windows.length + added.length > MAX_PASSAGES) {
        // Keep a complete contextual prefix when only one slot remains; continuation is explicit.
        const end = snap(points, Math.min(candidate.section.end, candidate.section.start + allowance));
        added = end > candidate.section.start ? [{ start: candidate.section.start, end }] : [];
      }
      if (windows.length + added.length > MAX_PASSAGES) break;
      const safe = added.map(w => ({ start: snap(points, w.start, true), end: snap(points, w.end) })).filter(w => w.end > w.start);
      windows.push(...safe); remaining -= safe.reduce((n, w) => n + w.end - w.start, 0);
    }
    // A single long paragraph may contain several distant supporting facts. Use
    // remaining slots for uncovered query terms, preserving exact sentence text.
    while (remaining > 0 && windows.length < MAX_PASSAGES) {
      const already = new Set(windows.flatMap(w => [...terms(w, hits)]));
      const uncovered = hits.filter(h => !already.has(h.value));
      if (!uncovered.length) break;
      const options = structural.flatMap(section => section.blocks.map(block => ({ section, block, score: terms(block, uncovered).size })))
        .filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.block.start - b.block.start);
      const best = options[0]; if (!best) break;
      const headingPresent = best.section.heading && covered(best.section.heading, windows);
      const context = headingPresent ? { ...best.section, start: best.block.start, heading: undefined } : best.section;
      const anchor = focus(source, best.block, uncovered, remaining);
      const extra = contextualWithAncestors(source, context, anchor, remaining, points, windows)
        .map(w => ({ start: snap(points, w.start, true), end: snap(points, w.end) }))
        .filter(w => w.end > w.start && windows.every(old => !overlap(old, w)));
      if (!extra.length || windows.length + extra.length > MAX_PASSAGES || !extra.some(w => terms(w, uncovered).size)) break;
      windows.push(...extra); remaining -= extra.reduce((n, w) => n + w.end - w.start, 0);
    }
    windows = merged(windows);
    if (!windows.length) { selection = 'prefix_fallback'; const end = snap(points, limit); if (end) windows = [{ start: 0, end }]; }
  }
  return finish(record, source, sourceOrigins, structural, windows, selection, hits);
}

/** Explicit reads retain the requested contiguous source offsets. They never silently add a heading outside the allowance. */
export function readPassage(record: BrainRecord, offset = 0, length = DEFAULT_CHARACTERS): PassageEvidence & { offset: number; nextOffset: number } {
  const limit = checkedBudget(length);
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('Read offset must be a nonnegative UTF-16 integer.');
  const source = transcriptText(record), sourceOrigins = origins(record), end = Math.min(source.length, offset + limit);
  const windows = offset < source.length ? [{ start: offset, end }] : [];
  const evidence = finish(record, source, sourceOrigins, sections(source, sourceOrigins), windows, offset === 0 && end === source.length ? 'complete_source' : 'whole_word_query', []);
  return { ...evidence, offset, nextOffset: end };
}
