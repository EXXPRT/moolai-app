import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrainPort } from "../packages/contracts/src/index.js";
import { MemoryBrain } from "../packages/brain/src/memory.js";
import { SQLiteBrain } from "../packages/brain/src/sqlite.js";
import { ExperimentalConfirmationController, QUESTIONS, replayCases,
  type ConfirmationDecision, type Method, type SuperAssessment, type Turn } from "./j1-confirmation-controller.js";

const original: Turn = { turnId: "original", revision: 1, text: "Can you explain this?" };
const reply: Turn = { turnId: "reply", revision: 1, text: "Yes, use only my notes." };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(brain: BrainPort, options: {
  method?: Method; active?: boolean; pendingWork?: boolean;
  recentContext?: string;
  firstConfidence?: number; firstAction?: "start_agent" | "end_agent" | "dictate";
  confirmation?: ConfirmationDecision; assessment?: SuperAssessment;
  routeOriginal?: () => Promise<any>; routeConfirmation?: () => Promise<ConfirmationDecision>;
  assessConfirmation?: () => Promise<SuperAssessment>;
} = {}) {
  const action = options.firstAction ?? (options.active ? "end_agent" : "start_agent");
  const controller = new ExperimentalConfirmationController({ brain, namespace: "test",
    method: options.method ?? "double_j1",
    routeOriginal: options.routeOriginal ?? (async () => ({ route: action, confidence: options.firstConfidence ?? .95 })),
    routeConfirmation: options.routeConfirmation ?? (async () => options.confirmation ?? { action: action as "start_agent" | "end_agent", confidence: .95 }),
    assessConfirmation: options.assessConfirmation ?? (async () => options.assessment ?? { verdict: "confirmed", evidenceQuote: "Yes" }),
  });
  await controller.initialize({ sessionId: "session", conversationId: options.active ? "conversation" : undefined,
    pendingWork: options.pendingWork, recentContext: options.recentContext });
  return controller;
}

for (const adapter of ["memory", "sqlite"] as const) {
  const run = (name: string, action: (brain: BrainPort) => Promise<void>) => test(`${adapter}: ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "moolai-confirmation-"));
    const brain = adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
    try { await action(brain); } finally { await brain.close(); await rm(directory, { recursive: true, force: true }); }
  });
  run("baseline retains 0.8 threshold and never receives a confirmation reply", async brain => {
    const controller = await fixture(brain, { method: "baseline", firstConfidence: .79 });
    await controller.submitOriginal(original);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getSnapshot().pendingProposal, undefined);
    assert.equal(controller.getTrace().filter(x => x.kind === "question").length, 0);
  });
  run("tentative start asks fixed question and confirmed start retains original plus added constraints", async brain => {
    const controller = await fixture(brain, { firstConfidence: .4 });
    await controller.submitOriginal(original);
    assert.equal(controller.getSnapshot().pendingProposal?.question, QUESTIONS.start_agent);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    await controller.submitReply(reply);
    const state = controller.getSnapshot();
    assert.ok(state.conversationId);
    assert.deepEqual(state.startedRequest, { originalText: original.text, confirmationText: reply.text, recentContext: "" });
    const record = await brain.getRecord(state.conversationId);
    assert.deepEqual(record?.segments.map(x => x.text), [original.text, reply.text]);
  });
  run("confirmed request preserves the preceding context in source and conversation", async brain => {
    const recentContext = "We are discussing why the object accelerated. Use my lab notes.";
    const controller = await fixture(brain, { recentContext });
    await controller.submitOriginal(original); await controller.submitReply(reply);
    const state = controller.getSnapshot();
    assert.equal(state.startedRequest?.recentContext, recentContext);
    assert.equal((await brain.getRecord("session"))?.segments[0]?.text, recentContext);
    assert.equal((await brain.getRecord(state.conversationId!))?.segments[0]?.text, recentContext);
  });
  run("no start/end candidate does not force a confirmation stage", async brain => {
    const controller = await fixture(brain, { firstAction: "dictate" });
    await controller.submitOriginal(original);
    assert.equal(controller.getSnapshot().pendingProposal, undefined);
    assert.equal(controller.getTrace().some(x => x.kind === "question"), false);
  });
  run("quoted title rejection keeps the current conversation", async brain => {
    const controller = await fixture(brain, { active: true,
      confirmation: { action: "reject", confidence: .99 } });
    await controller.submitOriginal({ ...original, text: "The note title is ‘That’s all’." });
    await controller.submitReply({ ...reply, text: "No, that's the name." });
    assert.equal(controller.getSnapshot().conversationId, "conversation");
    assert.equal(controller.getSnapshot().pendingProposal, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "rejected");
  });
  run("Super flag alone cannot authorize a transition", async brain => {
    const controller = await fixture(brain, { method: "super_j1",
      confirmation: { action: "unclear", confidence: .99 } });
    await controller.submitOriginal(original); await controller.submitReply(reply);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "unresolved");
  });
  run("Super rejection vetoes confident J1 agreement", async brain => {
    const controller = await fixture(brain, { method: "super_j1", active: true,
      assessment: { verdict: "rejected", evidenceQuote: "No" } });
    await controller.submitOriginal({ ...original, text: "That's all." });
    await controller.submitReply({ ...reply, text: "No, continue please." });
    assert.equal(controller.getSnapshot().conversationId, "conversation");
    assert.equal(controller.getTrace().at(-1)?.kind, "rejected");
  });
  run("fabricated Super evidence cannot authorize a transition", async brain => {
    const controller = await fixture(brain, { method: "super_j1",
      assessment: { verdict: "confirmed", evidenceQuote: "start the agent" } });
    await controller.submitOriginal(original); await controller.submitReply(reply);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "unresolved");
  });
  run("both grounded confirmations authorize the same pending action", async brain => {
    const controller = await fixture(brain, { method: "super_j1" });
    await controller.submitOriginal(original); await controller.submitReply(reply);
    assert.ok(controller.getSnapshot().conversationId);
    assert.equal(controller.getTrace().filter(x => x.kind === "started").length, 1);
    await controller.submitReply(reply);
    assert.equal(controller.getTrace().filter(x => x.kind === "started").length, 1);
  });
  run("second J1 cannot substitute the opposite action", async brain => {
    const controller = await fixture(brain, { confirmation: { action: "end_agent", confidence: .99 } });
    await controller.submitOriginal(original); await controller.submitReply(reply);
    assert.equal(controller.getSnapshot().conversationId, undefined);
  });
  run("silence is saved and never authorizes or calls a provider", async brain => {
    let calls = 0;
    const controller = await fixture(brain, { routeConfirmation: async () => {
      calls++; return { action: "start_agent", confidence: 1 };
    } });
    await controller.submitOriginal(original); await controller.submitReply({ ...reply, text: "" });
    assert.equal(calls, 0);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal((await brain.getRecord("session"))?.segments.length, 2);
  });
  run("provider failure preserves both source turns", async brain => {
    const controller = await fixture(brain, { routeConfirmation: async () => { throw new Error("fixture outage"); } });
    await controller.submitOriginal(original); await controller.submitReply(reply);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "provider_failure");
    assert.deepEqual((await brain.getRecord("session"))?.segments.map(x => x.text), [original.text, reply.text]);
  });
  run("correcting the original invalidates a pending confirmation and retains both revisions", async brain => {
    const controller = await fixture(brain);
    await controller.submitOriginal(original);
    await controller.reviseTurn({ ...original, revision: 2, text: "I was dictating: can you explain this?" });
    await controller.submitReply(reply);
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "stale");
    assert.equal((await brain.getRecord("session"))?.segments.length, 3);
  });
  run("delayed second J1 cannot act on a corrected reply", async brain => {
    const pending = deferred<ConfirmationDecision>();
    const entered = deferred<void>();
    const controller = await fixture(brain, { routeConfirmation: async () => { entered.resolve(); return pending.promise; } });
    await controller.submitOriginal(original);
    const task = controller.submitReply(reply); await entered.promise;
    await controller.reviseTurn({ ...reply, revision: 2, text: "No, I was dictating." });
    pending.resolve({ action: "start_agent", confidence: .99 }); await task;
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "stale");
    assert.equal((await brain.getRecord("session"))?.segments.length, 3);
  });
  for (const changed of ["session", "conversation"] as const) {
    run(`delayed confirmation cannot cross a ${changed} change`, async brain => {
      const pending = deferred<ConfirmationDecision>();
      const entered = deferred<void>();
      const controller = await fixture(brain, { active: true,
        routeConfirmation: async () => { entered.resolve(); return pending.promise; } });
      await controller.submitOriginal({ ...original, text: "That's all." });
      const task = controller.submitReply(reply); await entered.promise;
      await controller.changeContext(changed === "session" ? { sessionId: "other-session" } : { conversationId: "other-conversation" });
      pending.resolve({ action: "end_agent", confidence: .99 }); await task;
      assert.equal(controller.getTrace().at(-1)?.kind, "stale");
      assert.ok(controller.getSnapshot().conversationId);
    });
  }
  run("delayed original J1 cannot act on a correction", async brain => {
    const pending = deferred<any>(); const entered = deferred<void>();
    const controller = await fixture(brain, { method: "baseline", routeOriginal: async () => { entered.resolve(); return pending.promise; } });
    const task = controller.submitOriginal(original); await entered.promise;
    await controller.reviseTurn({ ...original, revision: 2, text: "The request is a quote." });
    pending.resolve({ route: "start_agent", confidence: .99 }); await task;
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "stale");
  });
  run("source compare-and-set protects a manual edit during a confirmation", async brain => {
    const pending = deferred<ConfirmationDecision>(); const entered = deferred<void>();
    const controller = await fixture(brain, { routeConfirmation: async () => { entered.resolve(); return pending.promise; } });
    await controller.submitOriginal(original);
    const task = controller.submitReply(reply); await entered.promise;
    const record = (await brain.getRecord("session"))!;
    await brain.updateRecord(record.id, record.revision, { title: "User corrected source context", manualFields: ["title"] });
    pending.resolve({ action: "start_agent", confidence: .99 }); await task;
    assert.equal(controller.getSnapshot().conversationId, undefined);
    assert.equal(controller.getTrace().at(-1)?.kind, "stale");
  });
  run("Super delayed past a correction skips second J1", async brain => {
    const pending = deferred<SuperAssessment>(); const entered = deferred<void>(); let calls = 0;
    const controller = await fixture(brain, { method: "super_j1",
      assessConfirmation: async () => { entered.resolve(); return pending.promise; },
      routeConfirmation: async () => { calls++; return { action: "start_agent", confidence: 1 }; } });
    await controller.submitOriginal(original);
    const task = controller.submitReply(reply); await entered.promise;
    await controller.reviseTurn({ ...reply, revision: 2, text: "Actually, no." });
    pending.resolve({ verdict: "confirmed", evidenceQuote: "Yes" }); await task;
    assert.equal(calls, 0); assert.equal(controller.getSnapshot().conversationId, undefined);
  });
  for (const endAction of [undefined, "finish", "cancel", "continue"] as const) {
    run(`pending work keeps explicit ${endAction ?? "unresolved"} semantics`, async brain => {
      const controller = await fixture(brain, { active: true, pendingWork: true,
        confirmation: { action: "end_agent", confidence: .99, endAction } });
      await controller.submitOriginal({ ...original, text: "That's all." });
      await controller.submitReply({ ...reply, text: "Yes, finish." });
      const state = controller.getSnapshot();
      if (endAction === "cancel") {
        assert.equal(state.conversationId, undefined); assert.equal(state.pendingWork, false);
      } else {
        assert.equal(state.conversationId, "conversation"); assert.equal(state.pendingWork, true);
        assert.equal(state.pendingEnd, endAction === "finish" ? "finish" : endAction === "continue" ? undefined : "ask");
        await controller.finishWork();
        assert.equal(Boolean(controller.getSnapshot().conversationId), endAction !== "finish");
      }
    });
  }
}

test("SQLite restart retains pending proposal, source revisions and completed transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolai-confirmation-restart-"));
  let brain = new SQLiteBrain(directory);
  try {
    let controller = await fixture(brain);
    await controller.submitOriginal(original);
    const pending = controller.getSnapshot().pendingProposal;
    await brain.close(); brain = new SQLiteBrain(directory);
    controller = await fixture(brain);
    assert.deepEqual(controller.getSnapshot().pendingProposal, JSON.parse(JSON.stringify(pending)));
    await controller.submitReply(reply);
    const conversationId = controller.getSnapshot().conversationId;
    assert.ok(conversationId);
    await brain.close(); brain = new SQLiteBrain(directory);
    controller = await fixture(brain);
    assert.equal(controller.getSnapshot().conversationId, conversationId);
    assert.equal((await brain.getRecord(conversationId))?.segments.length, 2);
    assert.equal((await brain.getRecord("session"))?.segments.length, 2);
  } finally { await brain.close(); await rm(directory, { recursive: true, force: true }); }
});

test("replay preserves case labels and does not give baseline future confirmation content", async () => {
  const result = await replayCases([{ id: "case", initial: { activeConversation: false }, original, reply,
    originalIntendedAction: "start", finalIntendedAction: "none",
    firstDecision: { route: "start_agent", confidence: .99 },
    secondDecision: { double_j1: { action: "reject", confidence: .99 }, super_j1: { action: "reject", confidence: .99 } },
    superAssessment: { verdict: "rejected", evidenceQuote: "Yes" } }]);
  const item = result.cases[0]!;
  assert.equal(item.originalIntendedAction, "start");
  assert.equal(item.finalIntendedAction, "none");
  const baseline = item.methods.baseline as { snapshot: { startedRequest: { confirmationText?: string } }; records: { segments: unknown[] }[] };
  assert.equal(baseline.snapshot.startedRequest.confirmationText, undefined);
  assert.equal(baseline.records[0]?.segments.length, 1);
});
