import test from "node:test";
import assert from "node:assert/strict";
import type { BrainRecord, Segment } from "../../../packages/contracts/src/index.js";
import { thoughtPreview } from "../../../packages/agent/src/thought-preview.js";
import { matchesSearch, notePreview, plainText } from "../../desktop/src/note-text.js";

const segment = (text: string, speaker: Segment["speaker"] = "user"): Segment => ({ id: text, turnId: `turn-${text}`, speaker, text, revision: 1, final: true, createdAt: "2026-10-29T01:00:00Z" });
const note = (overrides: Partial<BrainRecord> = {}): BrainRecord => ({
  id: "note", kind: "dictation", revision: 1, sourceRevision: 1, title: "", summary: "", createdAt: "2026-10-29T01:00:00Z", updatedAt: "2026-10-29T01:00:00Z",
  segments: [], links: [], attachmentIds: [], topics: [], quality: "ready", qualityReasons: [], doubt: false, manualFields: [], acceptedRevision: 0, ...overrides,
});

test("the Brain's search matches as you type, ignoring case, and every word must appear", () => {
  const osmosis = note({ title: "Water Potential and Osmosis", summary: "Water moves toward the lower water potential." });
  const water = note({ title: "Tonicity and Water Movement", summary: "Water crosses the membrane." });
  for (const query of ["o", "os", "osm", "osmo", "osmos", "osmosi", "osmosis", "OSMO", "water potential", "potential WATER", "  osmo  "])
    assert.ok(matchesSearch(osmosis, query), query);
  assert.ok(!matchesSearch(water, "water potential"), "More words narrow the results");
  assert.ok(!matchesSearch(osmosis, "osmosis pizza"));
  assert.ok(matchesSearch(water, "") && matchesSearch(water, "   "), "An empty search matches every note");
});

test("search reads the title, topics, summary, written body and recorded words, but a word never spans two fields", () => {
  const fields = note({ title: "Trial B", topics: ["Dilution factor"], summary: "Find the final volume.", body: "Pipette 25.0 mL first.",
    segments: [segment("Why isn't 60.0 mL the answer?"), segment("Because c1V1 = c2V2.", "assistant")] });
  for (const query of ["trial b", "factor", "final volume", "pipette", "why", "isn't", "60.0", "ML", "c1V1"])
    assert.ok(matchesSearch(fields, query), query);
  assert.ok(!matchesSearch(note({ title: "Osmo", summary: "sis" }), "osmosis"));
  assert.ok(!matchesSearch(note({ summary: "60 mL and 0.5 mol" }), "60.0"), "A decimal is one word");
  assert.ok(!matchesSearch(note({ summary: "Volumes don't add up." }), "isn't"), "A contraction is one word");
});

test("a card shows a growing note's preview as plain text, without its Markdown quote, labels' emphasis or escapes", () => {
  const draft = thoughtPreview([segment("Use c1*V1 = c2*V2 and the [stock] volume_1 for #trial B <quickly>."), segment("Moles: 2*3*4 = 24.")]).summary;
  assert.match(draft, /^> \*\*You:\*\* /);
  assert.equal(notePreview(note({ summary: draft })), "You: Use c1*V1 = c2*V2 and the [stock] volume_1 for #trial B <quickly>. You: Moles: 2*3*4 = 24.");
});

test("Markdown summaries lose their syntax in previews while literal symbols stay", () => {
  assert.equal(plainText("# Osmosis\n\n> Water moves **toward** the *more* concentrated side; see [the notes](https://example.com/a) and ![a chart](chart.png)."),
    "Osmosis Water moves toward the more concentrated side; see the notes and a chart.");
  assert.equal(plainText("See [Cell (biology)](https://en.wikipedia.org/wiki/Cell_(biology)) and [Osmosis](https://en.wikipedia.org/wiki/Osmosis)."),
    "See Cell (biology) and Osmosis.", "A link's destination may hold balanced parentheses");
  assert.equal(plainText("## Steps\n__Measure__, _then_ ~~guess~~ ***dilute***, a **bold _nested_ phrase**"), "Steps Measure, then guess dilute, a bold nested phrase");
  assert.equal(plainText("2*3*4 = 24, snake_case, #hashtag and \\*escaped\\* stay; \\[not a link\\](x)"), "2*3*4 = 24, snake_case, #hashtag and *escaped* stay; [not a link](x)");
  assert.equal(plainText("**Unclosed emphasis stays"), "**Unclosed emphasis stays");
});

test("a card without a summary or written note shows the user's words as written and Moo's without Markdown", () => {
  assert.equal(notePreview(note({ segments: [segment("Moles: 2*3*4 = 24 and *not* x<y")] })), "Moles: 2*3*4 = 24 and *not* x<y");
  assert.equal(notePreview(note({ segments: [segment("**Moo** suggests a [source](https://example.com).", "assistant")] })), "Moo suggests a source.");
  assert.equal(notePreview(note({ body: "# Field notes\n\n**Important**" })), "Field notes Important");
  assert.equal(notePreview(note()), "");
});
