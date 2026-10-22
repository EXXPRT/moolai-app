import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentReply, BrainPort, ChatMessage, ThoughtInput, ThoughtResult } from "../../contracts/src/index.js";
import { transcriptText } from "../../contracts/src/index.js";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";
import { Agent } from "../src/index.js";
import { loadEvidence } from "../src/evidence.js";

// F01 and F03 (22 Oct review): an answer from the user's notes is kept while the organizer folds the conversation into the
// growing note, and the note's earlier dictation stays evidence without the conversation's own questions and answers.
const STALE = "Source or evidence changed while answering; stale answer retained for review, not published.";
const ANSWER_FAILED = "I couldn't finish that answer.";
const DICTATION = "Sample A kept a minimum pressure of 12 kPa; sample B kept 15 kPa.";
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; };
const search = (id: string, query: string) => (): AgentReply => ({ text: "", toolCalls: [{ id, name: "search_notes", arguments: { query } }] });
const reply = (text: string): AgentReply => ({ text, spokenText: text, toolCalls: [] });
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 2500; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 2)); }
  throw Error(`Timed out waiting for ${label}`);
}

for (const kind of ["memory", "sqlite"] as const) {
  async function rig() {
    const dir = await mkdtemp(join(tmpdir(), "moolai-growing-answers-"));
    const brain: BrainPort = kind === "memory" ? new MemoryBrain() : new SQLiteBrain(dir);
    const p = new FixtureProviders(); let n = 0, clock = Date.parse("2026-10-22T10:00:00Z");
    const calls = { organized: 0, tags: 0, spoken: [] as string[], prompts: [] as ChatMessage[][] };
    const held: (() => void)[] = [];
    const hooks = { organizer: undefined as Promise<void> | undefined, tag: undefined as Promise<void> | undefined,
      organize: (_input: ThoughtInput, result: ThoughtResult) => result };
    const consolidate = p.consolidate.bind(p);
    p.consolidate = async input => { calls.organized++; if (hooks.organizer) await hooks.organizer; return hooks.organize(input, await consolidate(input)); };
    const tag = p.tag.bind(p);
    p.tag = async input => { calls.tags++; if (hooks.tag) await hooks.tag; return tag(input); };
    const script: ((messages: ChatMessage[]) => AgentReply | Promise<AgentReply>)[] = [];
    p.respond = (async (messages: ChatMessage[]): Promise<AgentReply> => { calls.prompts.push(structuredClone(messages)); return script.shift()!(messages); }) as typeof p.respond;
    const agent = new Agent({ brain, decisions: p, generation: p, search: p, vision: p, id: () => `${kind}-${++n}`, now: () => new Date(clock).toISOString(),
      capture: { async capture() { throw Error("Capture forbidden"); } },
      speech: { async speak(text) { calls.spoken.push(text); }, async stop() {} } });
    await agent.initialize(); await agent.startSession();
    return { brain, agent, calls, hooks, script,
      hold() { const gate = deferred(); held.push(gate.release); return gate; },
      minutes(m: number) { clock += m * 60_000; },
      growing: async () => (await brain.listRecords()).find(r => r.kind === "dictation" && r.thoughtStatus === "growing")!,
      answers: async () => (await brain.getRecord(agent.getState().conversationId!))!.segments.filter(s => s.speaker === "assistant").map(s => s.text),
      async close() { hooks.organizer = hooks.tag = undefined; held.forEach(release => release()); await agent.interrupt(); await agent.drain(); await brain.close(); await rm(dir, { recursive: true, force: true }); } };
  }
  const run = (name: string, body: (t: Awaited<ReturnType<typeof rig>>) => Promise<void>) =>
    test(`${kind}: ${name}`, { timeout: 15000 }, async () => { const t = await rig(); try { await body(t); } finally { await t.close(); } });
  /** Dictation, then the scheduler's pass: G is the growing note. Moo then starts answering from G and waits at its answer step. */
  async function answering(t: Awaited<ReturnType<typeof rig>>, answer = "Sample A kept a minimum of 12 kPa.") {
    await t.agent.submitText(DICTATION); await t.agent.drain();
    await t.agent.consolidateThoughts(); await t.agent.drain();
    const G = await t.growing(), step = t.hold();
    t.script.push(search("q1", "sample A minimum pressure"), async () => { await step.promise; return reply(answer); });
    await t.agent.submitText("Moo, what was sample A's minimum pressure?");
    await until(() => t.calls.prompts.length === 2, "the answer step that read G");
    assert.match(JSON.stringify(t.calls.prompts[1]), new RegExp(G.id), "Moo answers from G");
    return { G, step };
  }
  const said = async (t: Awaited<ReturnType<typeof rig>>, answer: string) => {
    assert.equal(t.agent.getState().lastError, undefined);
    assert.ok((await t.answers()).includes(answer), "The answer is published");
    assert.equal(t.calls.spoken.at(-1), answer, "and said");
  };
  const refused = async (t: Awaited<ReturnType<typeof rig>>, answer: string) => {
    assert.equal(t.agent.getState().lastError, STALE);
    assert.ok(!(await t.answers()).includes(answer), "The answer is not published");
    assert.ok(t.calls.spoken.at(-1)!.startsWith(ANSWER_FAILED));
  };

  run("the pass held while Moo answers folds that answer into the growing note during the follow-up, and the follow-up is still said", async t => {
    const { G, step } = await answering(t);
    await t.agent.consolidateThoughts();
    assert.equal(t.calls.organized, 1, "The scheduler's tick waits while Moo answers");
    const organizer = t.hold(); t.hooks.organizer = organizer.promise;
    step.release();
    await until(() => !t.agent.getState().busy && t.calls.organized === 2, "the held pass to start as the answer ends");
    const followUp = t.hold();
    t.script.push(async () => { await followUp.promise; return reply("Sample B kept 15 kPa."); });
    await t.agent.submitText("And sample B?");
    await until(() => t.calls.prompts.length === 3, "the follow-up's answer step");
    assert.match(JSON.stringify(t.calls.prompts[2]), new RegExp(G.id), "The follow-up reads G from the conversation's evidence");
    const conversation = t.agent.getState().conversationId!;
    t.hooks.organizer = undefined; organizer.release();
    await until(async () => { const note = (await t.brain.getRecord(G.id))!;
      return note.links.some(l => l.provenance === "source" && l.targetId === conversation) && note.connectionStatus === "no_match"; }, "the pass to fold the answer into G, then J7 and J6");
    assert.match(transcriptText((await t.brain.getRecord(G.id))!), /assistant: Sample A kept a minimum of 12 kPa\./);
    followUp.release(); await t.agent.drain();
    await said(t, "Sample B kept 15 kPa.");
  });

  run("J7 and J6 reviewing the growing note while Moo answers from it leave the answer to be said", async t => {
    await t.agent.submitText(DICTATION); await t.agent.drain();
    const review = t.hold(); t.hooks.tag = review.promise;
    const pass = t.agent.consolidateThoughts();
    await until(() => t.calls.tags === 1, "J7 to review the new growing note");
    const G = await t.growing(), step = t.hold();
    t.script.push(search("q1", "sample A minimum pressure"), async () => { await step.promise; return reply("Sample A kept a minimum of 12 kPa."); });
    await t.agent.submitText("Moo, what was sample A's minimum pressure?");
    await until(() => t.calls.prompts.length === 2, "the answer step that read G");
    t.hooks.tag = undefined; review.release();
    await until(async () => (await t.brain.getRecord(G.id))!.connectionStatus === "no_match", "J7 and J6 to patch G");
    const reviewed = (await t.brain.getRecord(G.id))!;
    assert.ok(reviewed.revision > G.revision && reviewed.sourceRevision === G.sourceRevision, "Only G's metadata changed");
    step.release(); await pass; await t.agent.drain();
    await said(t, "Sample A kept a minimum of 12 kPa.");
  });

  run("a pass already running when Moo starts answering extends the note it read, and the answer is still said", async t => {
    await t.agent.submitText(DICTATION); await t.agent.drain();
    await t.agent.consolidateThoughts(); await t.agent.drain();
    await t.agent.submitText("Sample C kept 9 kPa at the same flow rate."); await t.agent.drain();
    const organizer = t.hold(); t.hooks.organizer = organizer.promise;
    const pass = t.agent.consolidateThoughts();
    await until(() => t.calls.organized === 2, "the next pass to call the organizer");
    const G = await t.growing(), step = t.hold();
    t.script.push(search("q1", "sample A minimum pressure"), async () => { await step.promise; return reply("Sample A kept a minimum of 12 kPa."); });
    await t.agent.submitText("Moo, what was sample A's minimum pressure?");
    await until(() => t.calls.prompts.length === 2, "the answer step that read G");
    t.hooks.organizer = undefined; organizer.release();
    await until(async () => { const note = (await t.brain.getRecord(G.id))!; return note.sourceRevision > G.sourceRevision && note.connectionStatus === "no_match"; },
      "the pass to extend G, then J7 and J6");
    assert.match(transcriptText((await t.brain.getRecord(G.id))!), /Sample C kept 9 kPa/);
    step.release(); await pass; await t.agent.drain();
    await said(t, "Sample A kept a minimum of 12 kPa.");
  });

  for (const correction of ["text", "revision"] as const)
    run(`a corrected ${correction} in the passage Moo read still keeps the answer from being said`, async t => {
      const { G, step } = await answering(t);
      const segment = G.segments[0]!;
      await t.brain.upsertSegment(G.id, { ...segment, revision: segment.revision + 1, text: correction === "text" ? segment.text.replace("12 kPa", "13 kPa") : segment.text });
      step.release(); await t.agent.drain();
      await refused(t, "Sample A kept a minimum of 12 kPa.");
    });

  for (const change of ["archived", "suppressed"] as const)
    run(`a growing note ${change} while Moo answers from it still keeps the answer from being said`, async t => {
      const { G, step } = await answering(t);
      const note = (await t.brain.getRecord(G.id))!;
      await t.brain.updateRecord(G.id, note.revision, change === "archived" ? { archived: true }
        : { suppressed: { at: "2026-10-22T10:00:00Z", operationId: "suppress-test", sessionId: t.agent.getState().sessionId! } });
      step.release(); await t.agent.drain();
      await refused(t, "Sample A kept a minimum of 12 kPa.");
    });

  /** Two dictated turns, organized into growing note G; the question then comes after the dictation has left recent speech context. */
  async function pressureNotes(t: Awaited<ReturnType<typeof rig>>) {
    await t.agent.submitText("Pressure trial notes. Sample A kept a minimum pressure of 12 kPa and a maximum of 18 kPa."); await t.agent.drain();
    await t.agent.submitText("Sample B kept a minimum pressure of 15 kPa and a maximum of 22 kPa."); await t.agent.drain();
    await t.agent.consolidateThoughts(); await t.agent.drain();
    const G = await t.growing();
    t.minutes(6);
    t.script.push(search("s1", "sample A maximum pressure"), () => reply("Sample A's maximum pressure was 18 kPa."));
    await t.agent.submitText("Moo, what was sample A's maximum pressure?"); await t.agent.drain();
    assert.equal(t.calls.spoken.at(-1), "Sample A's maximum pressure was 18 kPa.");
    t.minutes(1);
    await t.agent.consolidateThoughts(); await t.agent.drain();
    t.minutes(1);
    return { G, conversation: t.agent.getState().conversationId! };
  }
  const ownTurns = /what was sample A's maximum pressure|Sample A's maximum pressure was 18 kPa/;

  run("the dictation in a growing note that took in this conversation's question and answer stays searchable and readable, without them", async t => {
    const { G, conversation } = await pressureNotes(t);
    const folded = (await t.brain.getRecord(G.id))!;
    assert.equal(folded.thoughtStatus, "growing");
    assert.ok(folded.links.some(l => l.provenance === "source" && l.targetId === conversation), "The organizer folded the question and answer into G");
    assert.match(transcriptText(folded), ownTurns);
    t.script.push(() => ({ text: "", toolCalls: [{ id: "s2", name: "search_notes", arguments: { query: "sample B minimum pressure" } },
      { id: "r2", name: "read_note", arguments: { id: G.id } }] }), () => reply("Sample B's minimum pressure was 15 kPa."));
    await t.agent.submitText("And what was sample B's minimum pressure?"); await t.agent.drain();
    const searched = (await t.brain.getState<any>(`tool:${conversation}:s2`)).result, read = (await t.brain.getState<any>(`tool:${conversation}:r2`)).result;
    assert.equal(searched.status, "success");
    assert.deepEqual(searched.result.map((note: { id: string }) => note.id), [G.id]);
    assert.equal(read.status, "success");
    for (const shown of [searched.result, read.result, t.calls.prompts.at(-1)!.filter(m => m.role === "tool"), (await loadEvidence(t.brain, conversation)).notes]) {
      assert.match(JSON.stringify(shown), /Sample B kept a minimum pressure of 15 kPa/);
      assert.doesNotMatch(JSON.stringify(shown), ownTurns, "A note never shows this conversation's own question or answer");
    }
    await said(t, "Sample B's minimum pressure was 15 kPa.");
  });

  run("a growing note made only of this conversation's question and answer is still left out", async t => {
    t.hooks.organize = (input, result) => input.activeNote
      ? { ...result, groups: result.groups.map(group => ({ ...group, title: "Pressure questions", continuesActive: false })) } : result;
    const { G, conversation } = await pressureNotes(t);
    const questions = await t.growing();
    assert.notEqual(questions.id, G.id);
    assert.equal((await t.brain.getRecord(G.id))!.thoughtStatus, "settled");
    assert.ok(questions.links.some(l => l.provenance === "source" && l.targetId === conversation));
    t.script.push(() => ({ text: "", toolCalls: [{ id: "s2", name: "search_notes", arguments: { query: "sample A maximum pressure" } },
      { id: "r2", name: "read_note", arguments: { id: questions.id } }] }), () => reply("Sample A's maximum was 18 kPa."));
    await t.agent.submitText("And sample A's maximum again?"); await t.agent.drain();
    const searched = (await t.brain.getState<any>(`tool:${conversation}:s2`)).result, read = (await t.brain.getState<any>(`tool:${conversation}:r2`)).result;
    assert.deepEqual(searched.result.map((note: { id: string }) => note.id), [G.id]);
    assert.equal(read.status, "failed");
    assert.match(read.error, /independent evidence/);
    assert.deepEqual((await loadEvidence(t.brain, conversation)).notes.map(note => note.id), [G.id]);
  });
}
