import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentReply, BrainPort, ChatMessage, RouteDecision, RouteInput, ThoughtInput, ThoughtResult, ToolDefinition } from "../../contracts/src/index.js";
import { transcriptText } from "../../contracts/src/index.js";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";
import { Agent } from "../src/index.js";

// Blocker 5: with growing notes on (production), the saved-doubt offer is decided on the spoken turn by J1,
// not on organizer output, and a help answer survives organizer passes.
const OFFER = "I saved your thought. Would you like me to look at your screen to help with it?";
/** Ian's test B doubt, 21 Oct. */
const TEST_B = "Sample A kept a lower minimum pressure than sample B. I'm not sure why sample A's minimum pressure is lower than sample B.";
const now = () => "2026-10-19T10:00:00Z";
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; };

for (const kind of ["memory", "sqlite"] as const) {
  async function rig() {
    const dir = await mkdtemp(join(tmpdir(), "moolai-doubt-"));
    let brain: BrainPort = kind === "memory" ? new MemoryBrain() : new SQLiteBrain(dir);
    const p = new FixtureProviders(); let n = 0;
    const calls = { organized: [] as ThoughtInput[], routes: [] as RouteInput[], spoken: [] as string[], captures: 0,
      vision: [] as { question: string; mode?: string }[], tags: 0, tools: [] as string[][] };
    const hooks = {
      /** J1's doubt answer for idle turns; the route itself comes from the fixture router. */
      doubt: (_input: RouteInput): number | undefined => undefined,
      route: undefined as undefined | ((input: RouteInput) => Promise<RouteDecision>),
      tagDoubt: 0,
      organizerFails: false,
      answerHold: undefined as Promise<void> | undefined,
      captureHold: undefined as Promise<void> | undefined,
      captureFails: false,
    };
    const consolidate = p.consolidate.bind(p);
    p.consolidate = async (input): Promise<ThoughtResult> => {
      calls.organized.push(input);
      if (hooks.organizerFails) throw Error("Organizer unavailable");
      return consolidate(input);
    };
    const route = p.route.bind(p);
    p.route = async input => {
      calls.routes.push(structuredClone(input));
      const decision = hooks.route ? await hooks.route(input) : await route(input);
      const idle = !input.activeConversation && !input.pendingOffer;
      const doubt = idle ? hooks.doubt(input) : undefined;
      return { ...decision, doubt };
    };
    const tag = p.tag.bind(p);
    p.tag = async input => { calls.tags++; const decision = await tag(input); return { ...decision, doubt: hooks.tagDoubt }; };
    const respond = p.respond.bind(p);
    p.respond = (async (messages: ChatMessage[], tools?: ToolDefinition[]): Promise<AgentReply> => {
      calls.tools.push((tools ?? []).map(t => t.name)); if (hooks.answerHold) await hooks.answerHold; return respond(messages);
    }) as typeof p.respond;
    const make = () => new Agent({ brain, decisions: p, generation: p, search: p, id: () => `${kind}-${++n}`, now,
      vision: { interpret: async (_image, question, _signal, options) => { calls.vision.push({ question, mode: options?.mode }); return "Sample A minimum 12 kPa."; } },
      capture: { async capture() { calls.captures++; if (hooks.captureHold) await hooks.captureHold; if (hooks.captureFails) throw Error("Screen Recording permission is required"); return { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }; } },
      speech: { async speak(text) { calls.spoken.push(text); }, async stop() {} } });
    let agent = make(); await agent.initialize(); await agent.startSession();
    const offers = () => calls.spoken.filter(text => text === OFFER).length;
    const answers = async () => (await brain.listRecords()).filter(r => r.kind === "conversation")
      .flatMap(r => r.segments).filter(s => s.speaker === "assistant" && /Fixture response/.test(s.text)).length;
    return { get brain() { return brain; }, get agent() { return agent; }, calls, hooks, offers, answers,
      async restart() { if (kind === "sqlite") { await brain.close(); brain = new SQLiteBrain(dir); } agent = make(); await agent.initialize(); },
      async close() { await agent.stopSession(); await agent.drain(); await brain.close(); await rm(dir, { recursive: true, force: true }); } };
  }
  const run = (name: string, body: (t: Awaited<ReturnType<typeof rig>>) => Promise<void>) =>
    test(`${kind}: ${name}`, { timeout: 10000 }, async () => { const t = await rig(); try { await body(t); } finally { await t.close(); } });
  const doubtful = (input: RouteInput) => /not sure why/i.test(input.text) ? 0.95 : 0.05;

  run("a dictated doubt is offered before any organizer pass", async t => {
    t.hooks.doubt = doubtful;
    await t.agent.submitText("Sample A has a lower minimum than B. I'm not sure why sample A's minimum is lower."); await t.agent.drain();
    assert.equal(t.calls.organized.length, 0, "No organizer pass ran");
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    assert.equal(t.offers(), 1);
    const doubt = await t.brain.getRecord((t.agent.getState().pendingOffer as { recordId: string }).recordId);
    assert.equal(doubt?.sourceOnly, true, "The per-turn record is a retained source, not a second note");
  });

  run("with the organizer failing, yes captures once and the answer is published", async t => {
    t.hooks.doubt = doubtful; t.hooks.organizerFails = true;
    await t.agent.submitText("Glycolysis makes two ATP."); await t.agent.drain();
    await t.agent.consolidateThoughts().catch(() => {});
    await t.agent.submitText("I'm not sure why the net yield is two."); await t.agent.drain();
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    await t.agent.submitText("Yes please"); await t.agent.drain();
    assert.equal(t.calls.captures, 1);
    assert.equal(await t.answers(), 1);
  });

  run("a long doubt turn gives a bounded question with only the user's words, read with OCR", async t => {
    t.hooks.doubt = doubtful;
    const long = "The table lists pressures for each sample in order. ".repeat(50) + "I'm not sure why sample A's minimum is lower.";
    assert.ok(long.length > 2500);
    await t.agent.submitText(long); await t.agent.drain();
    await t.agent.submitText("Yes"); await t.agent.drain();
    assert.equal(t.calls.captures, 1);
    const { question, mode } = t.calls.vision[0]!;
    assert.ok(question.length <= 2000, `question is ${question.length} characters`);
    assert.match(question, /not sure why sample A's minimum is lower/, "The doubt at the end is kept");
    assert.doesNotMatch(question, /saved your thought|look at your screen/, "Moo's lines never reach the vision question");
    assert.equal(mode, "ocr", "A saved doubt is read with GLM OCR");
  });

  run("a declined doubt is never offered again across organizer passes, finalize and restart", async t => {
    t.hooks.doubt = doubtful; t.hooks.tagDoubt = 1;
    await t.agent.submitText("I'm not sure why the minimum is lower."); await t.agent.drain();
    await t.agent.submitText("No thanks"); await t.agent.drain();
    await t.agent.consolidateThoughts(); await t.agent.drain();
    await t.agent.consolidateThoughts(true); await t.agent.drain();
    await t.restart(); await t.agent.drain();
    assert.ok(t.calls.tags > 0, "J7 still judged the organized note");
    assert.equal(t.offers(), 1, "Only the spoken turn's offer was made");
    assert.equal(t.calls.captures, 0);
    assert.equal(t.agent.getState().pendingOffer, undefined);
  });

  run("an answered conversation never brings a new offer, even when J7 marks a doubt", async t => {
    t.hooks.tagDoubt = 1;
    await t.agent.submitText("Moo, explain why the minimum is lower."); await t.agent.drain();
    await t.agent.submitText("Moo, finish conversation"); await t.agent.drain();
    await t.agent.consolidateThoughts(true); await t.agent.drain();
    assert.equal(t.offers(), 0);
    assert.equal(t.agent.getState().pendingOffer, undefined);
    const notes = (await t.brain.listRecords()).filter(r => r.kind === "dictation" && !r.sourceOnly);
    assert.ok(notes.some(r => r.doubt), "J7 still marks the open question on the growing note");
  });

  run("an organizer pass requested while Moo answers waits until the answer is published", async t => {
    t.hooks.doubt = doubtful;
    await t.agent.submitText("I'm not sure why the minimum is lower."); await t.agent.drain();
    const answer = deferred(); t.hooks.answerHold = answer.promise;
    const accepting = t.agent.submitText("Yes");
    for (let i = 0; i < 200 && !t.agent.getState().busy; i++) await new Promise(r => setTimeout(r, 2));
    assert.equal(t.agent.getState().busy, true);
    const before = t.calls.organized.length;
    await t.agent.consolidateThoughts();
    assert.equal(t.calls.organized.length, before, "The background pass is held while Moo answers");
    t.hooks.answerHold = undefined; answer.release(); await accepting; await t.agent.drain();
    assert.equal(await t.answers(), 1, "The help answer is published");
    assert.ok(t.calls.organized.length > before, "The held pass runs once the answer ends");
  });

  run("an organizer pass during capture keeps the help answer", async t => {
    t.hooks.doubt = doubtful;
    await t.agent.submitText("Glycolysis makes two ATP."); await t.agent.drain();
    await t.agent.submitText("I'm not sure why the net yield is two."); await t.agent.drain();
    const capture = deferred(); t.hooks.captureHold = capture.promise;
    const accepting = t.agent.submitText("Yes");
    for (let i = 0; i < 200 && t.calls.captures === 0; i++) await new Promise(r => setTimeout(r, 2));
    await t.agent.consolidateThoughts();
    t.hooks.captureHold = undefined; capture.release(); await accepting; await t.agent.drain();
    assert.equal(t.calls.captures, 1);
    assert.equal(await t.answers(), 1);
  });

  run("a 'what is this' screen offer keeps the visual model", async t => {
    t.hooks.route = async () => ({ route: "offer_help", confidence: 1, screenHelp: true });
    await t.agent.submitText("What breed is this bird?"); await t.agent.drain();
    t.hooks.route = undefined;
    assert.equal(t.agent.getState().pendingOffer?.kind, "general_help");
    await t.agent.submitText("Yes"); await t.agent.drain();
    assert.equal(t.calls.vision.at(-1)?.mode, "visual");
  });

  run("a confident doubt routed as 'offer help' gets the screen offer; vague confusion keeps the general one", async t => {
    t.hooks.route = async input => input.pendingOffer ? { route: "no_action", confidence: 1 } : { route: "offer_help", confidence: 1 };
    t.hooks.doubt = input => /not sure why/i.test(input.text) ? 0.9 : 0.2;
    await t.agent.submitText("What is even going on?"); await t.agent.drain();
    assert.equal(t.agent.getState().pendingOffer?.kind, "general_help");
    await t.agent.submitText("No"); await t.agent.drain();
    await t.agent.submitText("I'm not sure why sample A's minimum is lower."); await t.agent.drain();
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    assert.equal(t.offers(), 1);
  });

  run("a doubt J1 is unsure how to act on gets the screen offer instead of the clarifying question", async t => {
    // The 19 Oct paid J1 check: spoken doubts route as start_agent below 0.8 confidence.
    t.hooks.route = async input => input.pendingOffer ? { route: /^yes/i.test(input.text) ? "start_agent" : "no_action", confidence: 1, helpAccepted: /^yes/i.test(input.text) || undefined }
      : { route: "start_agent", confidence: 0.58 };
    t.hooks.doubt = input => /not sure why/i.test(input.text) ? 0.96 : 0.02;
    await t.agent.submitText("Moo, the glossary entry on enzymes is long."); await t.agent.drain();
    assert.equal(t.agent.getState().pendingOffer?.kind, "clarification", "Without a doubt, the clarifying question is unchanged");
    await t.agent.submitText("No"); await t.agent.drain();
    await t.agent.submitText("I'm not sure why sample A's minimum pressure is lower than sample B's."); await t.agent.drain();
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    assert.equal(t.calls.spoken.at(-1), OFFER);
    await t.agent.submitText("Yes"); await t.agent.drain();
    assert.equal(t.calls.captures, 1);
    assert.equal(t.calls.vision[0]!.mode, "ocr");
  });

  run("J1 sees the utterance once, not again at the end of its recent context (20 Oct part 4)", async t => {
    await t.agent.submitText("Glaciers move because ice deforms under its own weight."); await t.agent.drain();
    await t.agent.submitText("I'm not sure why sample A's minimum pressure is lower than sample B's."); await t.agent.drain();
    const last = t.calls.routes.at(-1)!;
    assert.equal(last.text, "I'm not sure why sample A's minimum pressure is lower than sample B's.");
    assert.doesNotMatch(last.recentContext, /not sure why sample A/, "The current utterance is not repeated");
    assert.match(last.recentContext, /Glaciers move/, "Earlier speech stays in the context");
  });

  run("a stray \"Moo.\" stays out of J1's context, so the doubt after it still gets the screen offer (21 Oct)", async t => {
    // The 21 Oct paid J1 check: test B routed start_agent 0.84 with "user: Moo." in recentContext, 0.52-0.58 without it.
    t.hooks.route = async input => input.text === "Moo." ? { route: "no_action", confidence: 1 }
      : { route: "start_agent", confidence: /user: Moo\./.test(input.recentContext) ? 0.84 : 0.55 };
    t.hooks.doubt = doubtful;
    await t.agent.submitText("Moo."); await t.agent.drain();
    await t.agent.submitText(TEST_B); await t.agent.drain();
    assert.equal(t.calls.spoken.at(-1), OFFER);
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    assert.doesNotMatch(t.calls.routes.find(r => r.text === TEST_B)!.recentContext, /Moo\./);
  });

  run("a stated doubt J1 routes as a confident start_agent still gets the screen offer (21 Oct)", async t => {
    t.hooks.route = async () => ({ route: "start_agent", confidence: 0.84 });
    t.hooks.doubt = doubtful;
    await t.agent.submitText(TEST_B); await t.agent.drain();
    assert.equal(t.calls.routes.at(-1)!.recentContext, "");
    assert.equal(t.calls.spoken.at(-1), OFFER);
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    assert.equal(await t.answers(), 0);
  });

  run("a doubt asked as a request is answered, with no offer", async t => {
    t.hooks.route = async () => ({ route: "start_agent", confidence: 1 });
    t.hooks.doubt = () => 0.96;
    await t.agent.submitText("Moo, can you explain why sample A's minimum is lower?"); await t.agent.drain();
    assert.equal(t.offers(), 0);
    assert.equal(await t.answers(), 1);
  });

  run("a confident start_agent J1 does not hear as a doubt is answered", async t => {
    t.hooks.route = async () => ({ route: "start_agent", confidence: 0.84 });
    t.hooks.doubt = () => 0.1;
    await t.agent.submitText(TEST_B); await t.agent.drain();
    assert.equal(t.offers(), 0);
    assert.equal(await t.answers(), 1);
  });

  run("an explicit screenshot request in a conversation is captured before Moo answers", async t => {
    await t.agent.submitText("Moo, help me with the pressure table."); await t.agent.drain();
    assert.ok(t.agent.getState().conversationId);
    await t.agent.submitText("Can you take a screenshot of my screen and tell me why this happens?"); await t.agent.drain();
    assert.equal(t.calls.captures, 1, "Moo captures once, without waiting for the model to call the tool");
    assert.equal(t.calls.vision[0]!.mode, "ocr");
    assert.match(t.calls.vision[0]!.question, /tell me why this happens/);
    assert.ok(!t.calls.tools.at(-1)!.includes("capture_screen"), "The answer is not offered a second capture");
    assert.equal(await t.answers(), 2);
    const trace = await t.brain.getState<{action: string}[]>("interaction-trace");
    assert.ok(trace!.some(e => e.action === "screen_capture_requested"), "Moo made the capture the model skipped");
  });

  run("a failed requested capture still gets an answer that knows the screen was not seen", async t => {
    t.hooks.captureFails = true;
    await t.agent.submitText("Moo, take a screenshot and read the table."); await t.agent.drain();
    assert.equal(t.calls.captures, 1);
    assert.equal(await t.answers(), 1, "The request is still answered");
    assert.equal(t.agent.getState().lastError, undefined);
    const ledger = JSON.stringify(await t.brain.getState(`tool-ledger:${t.agent.getState().conversationId}`));
    assert.match(ledger, /Screen Recording permission is required/, "The model is told the capture failed");
  });

  run("no doubt offer while a conversation is open or another offer is pending", async t => {
    t.hooks.doubt = () => 0.99;
    await t.agent.submitText("Moo, explain glycolysis."); await t.agent.drain();
    await t.agent.submitText("I'm not sure why the net yield is two."); await t.agent.drain();
    assert.equal(t.offers(), 0, "Inside a conversation the turn is a reply");
    assert.ok(t.calls.routes.filter(r => r.activeConversation).length > 0);
  });

  run("a pending doubt offer survives a restart and yes captures once", async t => {
    t.hooks.doubt = doubtful;
    await t.agent.submitText("I'm not sure why the minimum is lower."); await t.agent.drain();
    await t.restart();
    assert.equal(t.agent.getState().pendingOffer?.kind, "help");
    await t.agent.submitText("Yes"); await t.agent.drain();
    assert.equal(t.calls.captures, 1);
  });

  run("a corrected doubt turn needs fresh acceptance and captures the corrected words", async t => {
    t.hooks.doubt = doubtful;
    await t.agent.submitText("I'm not sure why sample A's minimum is lower."); await t.agent.drain();
    const offer = t.agent.getState().pendingOffer as { recordId: string };
    const original = (await t.brain.getRecord(offer.recordId))!.segments[0]!;
    await t.agent.ingest({ ...original, revision: original.revision + 1, text: "I'm not sure why sample B's minimum is lower." });
    await t.agent.drain();
    await t.agent.submitText("Yes"); await t.agent.drain();
    assert.equal(t.calls.captures, 0, "The first yes after a correction only asks again");
    assert.match(t.calls.spoken.at(-1)!, /saved request changed/);
    await t.agent.submitText("Yes"); await t.agent.drain();
    assert.equal(t.calls.captures, 1);
    assert.match(t.calls.vision[0]!.question, /sample B's minimum/);
    assert.ok(transcriptText((await t.brain.getRecord(offer.recordId))!).includes("sample B"));
  });
}
