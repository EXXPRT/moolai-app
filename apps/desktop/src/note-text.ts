import type { BrainRecord } from "../../../packages/contracts/src/index.js";

/** The Brain's search matches as you type: every query word appears, ignoring case, in a field Moo's search reads.
 * Moo's own search_notes keeps its whole-word ranking. */
export function matchesSearch(record: BrainRecord, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [record.title, ...record.topics, record.summary, record.body ?? "", ...record.segments.map(segment => segment.text)]
    .join("\n").toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

// Paired markers only, so 2*3*4 and snake_case read as written; nested emphasis is stripped from the inside too.
const unemphasised = (text: string): string =>
  text.replace(/(?<![\\\p{L}\p{N}*_~])(\*{1,3}|_{1,3}|~~)(?=[^\s*_~])((?:\\.|[^\\])*?[^\s\\])\1(?![\p{L}\p{N}*_~])/gu, (_match, _marker, inner: string) => unemphasised(inner));

/** Markdown prose as plain text for a short preview: no quote or heading markers, emphasis, escapes or link syntax. */
export function plainText(markdown: string): string {
  return unemphasised(markdown
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*#{1,6}(?=[ \t]|$)/gm, "")
    // A destination may hold one level of parentheses, as Wikipedia's Cell_(biology) does.
    .replace(/(?<!\\)!?\[((?:\\.|[^\\\]])*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1"))
    .replace(/\\([!-\/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ").trim();
}

/** A note card's text. Summaries, written notes and Moo's words are Markdown; the user's own words show as written. */
export function notePreview(record: BrainRecord): string {
  const first = record.segments[0];
  if (record.summary || record.body || !first) return plainText(record.summary || record.body || "");
  return first.speaker === "user" ? first.text : plainText(first.text);
}
