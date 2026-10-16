import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import type { BrainPort, Segment, SourceSpan, ThoughtInput, ThoughtResult } from "../../contracts/src/index.js";
import { ThoughtConsolidator } from "../src/thoughts.js";
import { Agent } from "../src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";

const now = () => "2026-10-03T12:00:00Z";
const segment = (id: string, text: string, revision = 1): Segment =>
  ({ id, turnId: id, text, revision, speaker: "user", final: true, createdAt: now() });
const spans = (input: ThoughtInput): SourceSpan[] => input.segments.map(source =>
  ({ segmentId: source.id, revision: source.revision, start: 0, end: source.text.length }));
// Deliberately imperfect: a complete current summary need not mean that this topic is over.
const summarized = (input: ThoughtInput, title = "App review"): ThoughtResult => ({
  groups: [{ title, summary: input.segments.map(source => source.text).join(" "),
    spans: spans(input), continuesActive: !!input.activeNote, ongoing: false }],
  remainder: [],
});
interface BufferState {
  activeId?: string; draftId?: string; spans: SourceSpan[]; status?: string; error?: string;
}

async function fixture(kind: "memory" | "sqlite") {
  const directory = await mkdtemp(join(tmpdir(), "moolai-continuity-"));
  let brain: BrainPort = kind === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
  await brain.createRecord({ id: "study", kind: "session", createdAt: now() });
  const inputs: ThoughtInput[] = [];
  let infer = async (input: ThoughtInput): Promise<ThoughtResult> => summarized(input);
  let scheduled = 0;
  const make = () => new ThoughtConsolidator({
    brain, now, emit: () => {}, notice: () => {}, context: async () => "",
    enrich: async () => {}, pending: () => { scheduled++; },
    generation: {
      summarize: async () => { throw Error("Consolidation already supplies the summary"); },
      respond: async () => { throw Error("No Agent task should run"); },
      consolidate: async input => { inputs.push(structuredClone(input)); return infer(input); },
    },
  });
  let engine = make();
  return {
    get brain() { return brain; }, get engine() { return engine; }, inputs,
    get scheduled() { return scheduled; },
    set infer(next: typeof infer) { infer = next; },
    async add(source: Segment) { await brain.upsertSegment("study", source); await engine.append("study", [source]); },
    async state() { return (await brain.getState<BufferState>("thought-buffer:study"))!; },
    async notes() { return (await brain.listRecords()).filter(record => record.kind === "dictation"); },
    async restart() {
      if (kind === "sqlite") { await brain.close(); brain = new SQLiteBrain(directory); }
      engine = make(); await engine.recover("study");
    },
    async close() { await brain.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

function deferred() {
  let started!: (input: ThoughtInput) => void;
  let release!: (output: ThoughtResult) => void;
  const input = new Promise<ThoughtInput>(resolve => { started = resolve; });
  const output = new Promise<ThoughtResult>(resolve => { release = resolve; });
  return { input, release, infer: (value: ThoughtInput) => { started(value); return output; } };
}

async function agentFixture(kind: "memory" | "sqlite") {
  const f = await fixture(kind), providers = new FixtureProviders();
  let counter = 0, routes = 0, summaries = 0, tags = 0, failOrganization = false, failTags = false;
  providers.route = async () => { routes++; return { route: "dictate", confidence: 1 }; };
  providers.consolidate = async input => {
    f.inputs.push(structuredClone(input));
    if (failOrganization) throw Error("Incomplete organization output");
    return summarized(input);
  };
  providers.summarize = async () => { summaries++; throw Error("Do not replace organization with standalone summary"); };
  providers.tag = async () => {
    tags++;
    if (failTags) throw Error("Classification unavailable");
    return { purpose: "Reference", purposeConfidence: 1, topics: {}, doubt: 0, faithful: 1, understandable: 1, relevant: undefined };
  };
  await f.brain.setState("agent", { sessionId: "study", listening: false, busy: false, webAllowed: false });
  const agent = new Agent({
    brain: f.brain, generation: providers, decisions: providers, search: providers, vision: providers,
    capture: { capture: async () => { throw Error("Capture must not run"); } },
    speech: { speak: async () => { throw Error("No spoken response expected"); }, stop: async () => {} },
    now, id: () => `continuity-${++counter}`,
  });
  await agent.initialize(); await agent.startSession();
  return {
    // Each Start opens a new session record, so read the buffer of the Agent's current session.
    ...f, async state() { return (await f.brain.getState<BufferState>(`thought-buffer:${agent.getState().sessionId}`))!; },
    agent, get routes() { return routes; }, get summaries() { return summaries; }, get tags() { return tags; },
    get failOrganization() { return failOrganization; }, get failTags() { return failTags; },
    set failOrganization(value: boolean) { failOrganization = value; },
    set failTags(value: boolean) { failTags = value; },
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: a premature completed flag keeps the latest topic available with its source and summary`, async () => {
    const f = await fixture(kind);
    try {
      const first = "Four app issues: first, recall should include dates.";
      await f.add(segment("one", first)); await f.engine.process("study");
      const original = (await f.notes())[0]!;
      assert.equal(original.thoughtStatus, "settled");
      assert.equal((await f.state()).activeId, original.id);
      await f.add(segment("two", "Second, render Markdown. Third, listen reliably. Fourth, connect related thoughts."));
      await f.engine.process("study");
      const input = f.inputs[1]!;
      assert.equal(input.activeNote!.id, original.id);
      assert.equal(input.activeNote!.summary, first);
      assert.equal(input.activeNote!.sourceExcerpt, `user: ${first}`);
      assert.equal(input.activeNote!.sourceTruncated, false);
      assert.equal((await f.notes()).length, 1);
      assert.equal((await f.notes())[0]!.id, original.id);
      assert.equal((await f.notes())[0]!.segments.length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: a real topic change replaces the candidate and a return creates a new episode`, async () => {
    const f = await fixture(kind);
    try {
      f.infer = async input => ({ groups: [{ ...summarized(input).groups[0]!,
        title: input.segments[0]!.text, continuesActive: false }], remainder: [] });
      const source = ["Hamstring flexes the knee.", "The brain stores memories.", "Returning to hamstring rehabilitation."];
      const ids: string[] = [];
      for (const [index, text] of source.entries()) {
        await f.add(segment(`topic-${index}`, text)); await f.engine.process("study");
        const id = (await f.state()).activeId;
        assert.ok(id); ids.push(id);
        assert.equal(f.inputs[index]!.activeNote?.id, ids[index - 1]);
      }
      assert.equal(new Set(ids).size, 3);
      assert.equal((await f.notes()).length, 3);
      assert.equal(f.inputs[2]!.activeNote!.sourceExcerpt, `user: ${source[1]}`);
      assert.ok(!f.inputs[2]!.activeNote!.sourceExcerpt.includes(source[0]!));
    } finally { await f.close(); }
  });

  test(`${kind}: capture checkpoints and pauses preserve continuity while true finalization retires it`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("first", "The survey had twelve participants.")); await f.engine.process("study");
      const id = (await f.notes())[0]!.id;
      await f.engine.process("study", false); await f.engine.process("study", false);
      assert.equal(f.inputs.length, 1, "A pause does not spend another model request");
      assert.equal((await f.state()).activeId, id);
      await f.add(segment("correction", "Correction: fifteen participants, according to the coordinator."));
      await f.engine.process("study", false);
      assert.equal((await f.notes()).length, 1);
      assert.equal(f.inputs[1]!.activeNote!.id, id);
      await f.engine.process("study", true);
      assert.equal(f.inputs.length, 2, "Finalizing an already summarized buffer is local");
      assert.equal((await f.state()).activeId, undefined);
      await f.add(segment("next", "A separate study starts now.")); await f.engine.process("study");
      assert.equal(f.inputs[2]!.activeNote, undefined);
      assert.equal((await f.notes()).length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: a deferred continuation survives empty groups and is consumed with the next completed speech`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("first", "First issue: recall lacks dates.")); await f.engine.process("study");
      const id = (await f.notes())[0]!.id;
      f.infer = async input => ({ groups: [], remainder: spans(input) });
      await f.add(segment("unfinished", "The second issue is")); await f.engine.process("study");
      const scheduled = f.scheduled;
      assert.equal((await f.state()).activeId, id);
      assert.equal((await f.notes()).length, 1, "A model deferral must not manufacture another visible note");
      await f.engine.process("study");
      assert.equal(f.inputs.length, 2); assert.equal(f.scheduled, scheduled);
      await f.restart();
      f.infer = async input => summarized(input);
      await f.add(segment("continued", "that tables show raw Markdown. Those are the two issues."));
      await f.engine.process("study");
      const latest = f.inputs.at(-1)!;
      assert.equal(latest.activeNote!.id, id);
      assert.deepEqual(latest.segments.map(s => s.id), ["unfinished", "continued"]);
      assert.equal((await f.notes()).length, 1); assert.deepEqual((await f.state()).spans, []);
      assert.deepEqual((await f.notes())[0]!.segments.map(s => s.text), [
        "First issue: recall lacks dates.", "The second issue is", "that tables show raw Markdown. Those are the two issues.",
      ]);
    } finally { await f.close(); }
  });

  test(`${kind}: a settled candidate survives restart and extension preserves manual title, summary and tags`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("source", "The lab estimate is five grams.")); await f.engine.process("study");
      const original = (await f.notes())[0]!;
      await f.brain.updateRecord(original.id, original.revision, {
        title: "My lab note", summary: "My interpretation: verify the estimate.", topics: ["Lab"],
        manualFields: ["title", "summary", "topics"],
      });
      await f.restart(); assert.equal(f.inputs.length, 1);
      await f.add(segment("follow-up", "Do not treat that estimate as a confirmed measurement."));
      await f.engine.process("study");
      const note = (await f.notes())[0]!;
      assert.equal((await f.notes()).length, 1); assert.equal(note.id, original.id);
      assert.equal(f.inputs[1]!.activeNote!.id, original.id);
      assert.equal(f.inputs[1]!.activeNote!.summary, "My interpretation: verify the estimate.");
      assert.equal(note.title, "My lab note"); assert.equal(note.summary, "My interpretation: verify the estimate.");
      assert.deepEqual(note.topics, ["Lab"]); assert.equal(note.segments.length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: recovery after record publication restores a completed continuation candidate without redispatch`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("first", "The first workshop point is capture latency."));
      const persist = f.brain.setState.bind(f.brain);
      let interrupted = false;
      f.brain.setState = async (key, value) => {
        const buffer = value as BufferState & { staged?: unknown };
        if (key === "thought-buffer:study" && buffer.activeId && !buffer.staged && !interrupted) {
          interrupted = true; throw Error("Process lost after note write and before buffer advancement");
        }
        return persist(key, value);
      };
      await f.engine.process("study"); f.brain.setState = persist;
      assert.equal(interrupted, true);
      const interruptedState = await f.state();
      // A killed host leaves dispatched work marked running, unlike the caught fixture error.
      await f.brain.setState("thought-buffer:study", { ...interruptedState, status: "running" });
      await f.restart(); await f.restart();
      const note = (await f.notes())[0]!;
      assert.equal(f.inputs.length, 1); assert.equal((await f.notes()).length, 1);
      assert.equal((await f.state()).activeId, note.id); assert.deepEqual((await f.state()).spans, []);
      await f.add(segment("next", "The second workshop point is playback latency.")); await f.engine.process("study");
      assert.equal(f.inputs[1]!.activeNote!.id, note.id); assert.equal((await f.notes()).length, 1);
      assert.equal((await f.notes())[0]!.segments.length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: failed continuation retains its candidate and does not retry on pause, restart or new speech`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("first", "The current review covers capture and playback.")); await f.engine.process("study");
      const id = (await f.notes())[0]!.id;
      f.infer = async () => { throw Error("Provider output incomplete"); };
      await f.add(segment("second", "Playback should stop when I speak.")); await f.engine.process("study");
      assert.equal((await f.state()).activeId, id); assert.equal((await f.state()).status, "failed");
      await f.engine.process("study"); await f.restart();
      await f.add(segment("third", "Keep the first spoken word after interruption.")); await f.engine.process("study");
      assert.equal(f.inputs.length, 2); assert.equal((await f.notes()).length, 1);
      f.infer = async input => summarized(input);
      await f.engine.process("study", false, true);
      assert.equal(f.inputs.length, 3); assert.equal(f.inputs[2]!.activeNote!.id, id);
      assert.equal((await f.notes())[0]!.segments.length, 3);
      assert.equal((await f.notes())[0]!.error, undefined);
    } finally { await f.close(); }
  });

  test(`${kind}: correcting earlier candidate source rejects a delayed extension and retry reads current evidence`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("measurement", "The vial contains five grams.")); await f.engine.process("study");
      const id = (await f.notes())[0]!.id;
      const waiting = deferred(); f.infer = waiting.infer;
      await f.add(segment("follow-up", "Use that measurement in the review."));
      const work = f.engine.process("study"); const input = await waiting.input;
      await f.add(segment("measurement", "The vial contains fifteen grams.", 2));
      waiting.release(summarized(input)); await work;
      assert.equal((await f.state()).status, "failed"); assert.equal((await f.state()).activeId, id);
      assert.equal((await f.notes()).length, 1);
      assert.equal((await f.notes())[0]!.segments[0]!.text, "The vial contains fifteen grams.");
      await f.restart(); await f.engine.process("study"); assert.equal(f.inputs.length, 2);
      f.infer = async current => summarized(current);
      await f.engine.process("study", false, true);
      assert.equal(f.inputs[2]!.activeNote!.id, id);
      assert.match(f.inputs[2]!.activeNote!.sourceExcerpt, /fifteen grams/);
      assert.doesNotMatch(f.inputs[2]!.activeNote!.sourceExcerpt, /contains five grams/);
      assert.equal((await f.notes())[0]!.segments.length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: manual edits during continuation block stale publication without replacing the note`, async () => {
    const f = await fixture(kind);
    try {
      await f.add(segment("one", "The first issue concerns retrieval.")); await f.engine.process("study");
      const original = (await f.notes())[0]!;
      const waiting = deferred(); f.infer = waiting.infer;
      await f.add(segment("two", "Second, distinguish a failed search from an empty notebook."));
      const work = f.engine.process("study"); const input = await waiting.input;
      const current = (await f.brain.getRecord(original.id))!;
      await f.brain.updateRecord(current.id, current.revision, { summary: "A user-edited review", manualFields: ["summary"] });
      waiting.release(summarized(input)); await work;
      assert.equal((await f.notes()).length, 1);
      assert.equal((await f.notes())[0]!.summary, "A user-edited review");
      assert.equal((await f.state()).status, "failed");
      await f.restart(); await f.engine.process("study"); assert.equal(f.inputs.length, 2);
      f.infer = async latest => summarized(latest);
      await f.engine.process("study", false, true);
      assert.equal((await f.notes()).length, 1); assert.equal((await f.notes())[0]!.id, original.id);
      assert.equal((await f.notes())[0]!.summary, "A user-edited review");
      assert.equal((await f.notes())[0]!.segments.length, 2);
    } finally { await f.close(); }
  });

  test(`${kind}: finalizing a long thought keeps the candidate across intermediate complete flags`, async () => {
    const f = await fixture(kind);
    try {
      const source = "A continuing workshop discussion. ".repeat(600);
      await f.add(segment("workshop", source)); await f.engine.process("study", true);
      assert.ok(f.inputs.length > 1);
      assert.ok(f.inputs.slice(0, -1).every(input => !input.finalize));
      assert.equal(f.inputs.at(-1)!.finalize, true);
      const notes = await f.notes();
      assert.equal(notes.length, 1, "Completed summary flags must not split one multi-batch topic");
      assert.ok(f.inputs.slice(1).every(input => input.activeNote?.id === notes[0]!.id));
      assert.equal(notes[0]!.segments.map(s => s.text).join(""), source);
      assert.equal((await f.state()).activeId, undefined); assert.deepEqual((await f.state()).spans, []);
    } finally { await f.close(); }
  });

  test(`${kind}: final words arriving during finalization keep the just-published episode as context`, async () => {
    const f = await fixture(kind);
    try {
      const waiting = deferred();
      f.infer = input => f.inputs.length === 1 ? waiting.infer(input) : Promise.resolve(summarized(input));
      await f.add(segment("first", "The survey estimate was twelve participants."));
      const work = f.engine.process("study", true); const input = await waiting.input;
      assert.equal(input.finalize, true);
      await f.add(segment("last", "Final correction: fifteen participants, not twelve."));
      waiting.release(summarized(input)); await work;
      const notes = await f.notes();
      assert.equal(f.inputs.length, 2); assert.equal(notes.length, 1);
      assert.equal(f.inputs[1]!.activeNote!.id, notes[0]!.id);
      assert.match(f.inputs[1]!.activeNote!.sourceExcerpt, /twelve participants/);
      assert.deepEqual(notes[0]!.segments.map(s => s.text), [
        "The survey estimate was twelve participants.", "Final correction: fifteen participants, not twelve.",
      ]);
      assert.deepEqual((await f.state()).spans, []); assert.equal((await f.state()).activeId, undefined);
    } finally { await f.close(); }
  });

  test(`${kind}: Retry summary resumes failed organization of a settled candidate without rerouting`, async () => {
    const f = await agentFixture(kind);
    try {
      await f.agent.submitText("The review covers two capture issues."); await f.agent.drain();
      await f.agent.consolidateThoughts(false); await f.agent.drain();
      const original = (await f.notes())[0]!;
      assert.equal(original.thoughtStatus, "settled");
      f.failOrganization = true;
      await f.agent.submitText("First, playback interrupts the beginning of my sentence."); await f.agent.drain();
      await f.agent.consolidateThoughts(false); await f.agent.drain();
      assert.equal((await f.state()).activeId, original.id); assert.equal((await f.state()).status, "failed");
      const routes = f.routes;
      f.failOrganization = false;
      await f.agent.retrySummary(original.id); await f.agent.drain();
      assert.equal(f.inputs.length, 3); assert.equal(f.summaries, 0); assert.equal(f.routes, routes);
      assert.equal(f.inputs[2]!.activeNote!.id, original.id);
      assert.equal((await f.notes()).length, 1); assert.equal((await f.notes())[0]!.segments.length, 2);
      assert.equal((await f.notes())[0]!.error, undefined); assert.deepEqual((await f.state()).spans, []);
    } finally { await f.close(); }
  });

  test(`${kind}: Agent capture checkpoint retains the candidate until explicit session stop`, async () => {
    const f = await agentFixture(kind);
    try {
      await f.agent.submitText("My workshop review begins with audio capture."); await f.agent.drain();
      await f.agent.consolidateThoughts(false); await f.agent.drain();
      const original = (await f.notes())[0]!;
      await f.agent.consolidateThoughts(false); await f.agent.drain();
      assert.equal((await f.state()).activeId, original.id); assert.equal(f.inputs.length, 1);
      await f.agent.submitText("The second review point concerns playback latency."); await f.agent.drain();
      await f.agent.consolidateThoughts(false); await f.agent.drain();
      assert.equal((await f.notes()).length, 1); assert.equal(f.inputs[1]!.activeNote!.id, original.id);
      await f.agent.stopSession(); await f.agent.drain();
      assert.equal((await f.state()).activeId, undefined); assert.equal(f.inputs.length, 2);
      assert.equal(f.agent.getState().listening, false); assert.equal(f.summaries, 0);
    } finally { await f.close(); }
  });

  test(`${kind}: a settled candidate with classification failure and no pending source retries enrichment`, async () => {
    const f = await agentFixture(kind);
    try {
      f.failTags = true;
      await f.agent.submitText("The workshop review covers playback latency."); await f.agent.drain();
      await f.agent.consolidateThoughts(false); await f.agent.drain();
      const note = (await f.notes())[0]!;
      assert.equal(note.thoughtStatus, "settled"); assert.match(note.error!, /Classification unavailable/);
      assert.deepEqual((await f.state()).spans, []); assert.equal((await f.state()).status, undefined);
      f.failTags = false;
      await f.agent.retrySummary(note.id); await f.agent.drain();
      assert.equal(f.inputs.length, 1, "An empty thought buffer must not consume the enrichment retry");
      assert.equal(f.tags, 2); assert.equal(f.summaries, 0);
      assert.equal((await f.notes())[0]!.quality, "ready"); assert.equal((await f.notes())[0]!.error, undefined);
    } finally { await f.close(); }
  });
}
