import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBrain, SQLiteBrain } from "../packages/brain/src/index.js";
import { Agent } from "../packages/agent/src/index.js";
import { transcriptText, type AgentReply, type BrainPort, type BrainRecord, type LocalFilesPort, type Summary } from "../packages/contracts/src/index.js";
import { note, rig, segment } from "../experiments/agent-closeout/support.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const answer = (text: string): AgentReply => ({ text, toolCalls: [] });
const tool = (id: string, name: string, args: Record<string, unknown>): AgentReply => ({ text: "", toolCalls: [{ id, name, arguments: args }] });
type Context = { f: ReturnType<typeof rig>; brain: BrainPort; restart: () => Promise<void> };

for (const adapter of ["memory", "sqlite"] as const) {
  function run(name: string, action: (context: Context) => Promise<void>) {
    test(`${adapter}: finalization ${name}`, { timeout: 8_000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "moolai-finalization-"));
      let restartCount = 0;
      const context = { brain: adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory) } as Context;
      context.f = rig(context.brain, `${adapter}-finalization`);
      context.restart = async () => {
        await context.f.agent.drain();
        if (adapter === "sqlite") {
          await context.brain.close();
          context.brain = new SQLiteBrain(directory);
        }
        let sequence = 0;
        const prefix = `${adapter}-restart-${++restartCount}`;
        context.f.options.brain = context.brain;
        context.f.agent = new Agent({ ...context.f.options, id: () => `${prefix}-${++sequence}` });
        await context.f.agent.initialize();
      };
      try {
        await context.f.agent.initialize();
        await action(context);
        await context.f.agent.drain();
      } finally {
        await context.brain.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  run("selected low-confidence continuation keeps the active exchange", async ({ f, brain }) => {
    await f.agent.submitText("Moo, compare the two methods using only my notes.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId;
    f.hooks.decisions.route = async () => ({ route: "continue_agent", confidence: 0.31 });
    await f.agent.submitText("Make the comparison about reliability, and keep it to two sentences.");
    await f.agent.drain();
    assert.equal(f.agent.getState().conversationId, id);
    assert.equal(f.agent.getState().pendingOffer, undefined);
    assert.equal(f.observed.generations.length, 2);
    assert(!f.observed.speech.some(text => /Could you clarify/.test(text)));
    assert.match(transcriptText((await brain.getRecord(id!))!), /two sentences/);
    assert.equal(f.agent.getState().webAllowed, false);
  });

  run("selected low-confidence idle dictation is saved and enriched", async ({ f, brain }) => {
    f.hooks.decisions.route = async () => ({ route: "dictate", confidence: 0.25 });
    await f.agent.submitText("The goalpost is five metres wide.");
    await f.agent.drain();
    const thought = (await brain.listRecords()).find(record => record.kind === "dictation");
    assert.ok(thought);
    assert.match(thought.summary, /five metres/);
    assert.equal(thought.quality, "ready");
    assert.equal(f.agent.getState().pendingOffer, undefined);
    assert.equal(f.observed.generations.length, 0);
  });

  run("start and stop still require the fixed 0.8 threshold", async ({ f }) => {
    f.hooks.decisions.route = async () => ({ route: "start_agent", confidence: 0.79 });
    await f.agent.submitText("Could you explain the method?");
    await f.agent.drain();
    assert.equal(f.agent.getState().conversationId, undefined);
    assert.equal(f.agent.getState().pendingOffer?.kind, "clarification");
    assert.equal(f.observed.generations.length, 0);
    f.hooks.decisions.route = async () => ({ route: "start_agent", confidence: 0.8 });
    await f.agent.submitText("Yes, explain the method using only my notes.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId;
    assert.ok(id);
    f.hooks.decisions.route = async () => ({ route: "end_agent", confidence: 0.79, substantiveContentProbability: 0 });
    await f.agent.submitText("Moo, finish conversation.");
    await f.agent.drain();
    assert.equal(f.agent.getState().conversationId, id);
    f.hooks.decisions.route = async () => ({ route: "end_agent", confidence: 0.8, substantiveContentProbability: 0 });
    await f.agent.submitText("Moo, finish conversation.");
    await f.agent.drain();
    assert.equal(f.agent.getState().conversationId, undefined);
  });

  run("Nano supplies at most three suggestions and J7 keeps fixed classification separate", async ({ f, brain }) => {
    f.hooks.decisions.route = async () => ({ route: "dictate", confidence: 1 });
    f.hooks.generation.summarize = async () => ({ title: "Irrigation idea", summary: "Try watering the basil in the morning.", topicSuggestions: ["Basil", " Gardening ", "Basil", "Watering", "Extra"] });
    f.hooks.decisions.tag = async () => ({ purpose: "Idea", purposeConfidence: 0.95, topics: { "J7 should not choose this": 1 }, doubt: 0, faithful: 1, understandable: 1 });
    await f.agent.submitText("Maybe I could water the basil in the morning.");
    await f.agent.drain();
    const thought = (await brain.listRecords()).find(record => record.kind === "dictation")!;
    assert.deepEqual(thought.topics, ["Basil", "Gardening", "Watering"]);
    assert.deepEqual(await brain.getState(`suggested-topics:${thought.id}`), thought.topics);
    assert.equal(thought.purpose, "Idea");
    assert.equal(thought.quality, "ready");
    assert.deepEqual(f.observed.tags[0].input.topicCandidates, []);
  });

  run("manual topics survive fresh Nano suggestions and legacy singular suggestions remain supported", async ({ f, brain }) => {
    const record = await note(brain, { id: "editable-tags", title: "Orchid care", text: "Orchids prefer indirect light." });
    await brain.updateRecord(record.id, record.revision, { summary: "", topics: ["My category"], manualFields: ["topics"] });
    f.hooks.generation.summarize = async () => ({ title: "Orchids", summary: "Use indirect light.", topicSuggestion: "Plant care" });
    await f.agent.queueEnrichment(record.id);
    await f.agent.drain();
    assert.deepEqual((await brain.getRecord(record.id))!.topics, ["My category"]);
    assert.deepEqual(await brain.getState(`suggested-topics:${record.id}`), ["Plant care"]);
  });

  for (const ending of ["close", "cancel", "session stop"] as const) {
    run(`${ending} consolidates the same conversation without claiming unfinished work`, async ({ f, brain }) => {
      const started = deferred<void>();
      const pending = deferred<AgentReply>();
      const inputs: BrainRecord[] = [];
      f.hooks.generation.summarize = async record => { inputs.push(structuredClone(record)); return { title: "Conversation", summary: transcriptText(record) }; };
      if (ending === "cancel") f.hooks.generation.respond = async () => { started.resolve(); return pending.promise; };
      await f.agent.submitText("Moo, use only my notes and explain the lens experiment.");
      if (ending === "cancel") await started.promise;
      else await f.agent.drain();
      const id = f.agent.getState().conversationId!;
      if (ending === "close") await f.agent.requestEnd();
      else if (ending === "session stop") await f.agent.stopSession();
      else {
        await f.agent.requestEnd();
        await f.agent.resolveEnd("cancel");
        pending.resolve(answer("This answer arrived after cancellation."));
      }
      await f.agent.drain();
      const conversations = (await brain.listRecords()).filter(record => record.kind === "conversation");
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0]!.id, id);
      assert.match(conversations[0]!.summary, /lens experiment/);
      assert.equal(conversations[0]!.summarySourceRevision, conversations[0]!.sourceRevision);
      assert.equal(conversations[0]!.quality, "ready");
      assert.equal(f.agent.getState().conversationId, ending === "session stop" ? id : undefined);
      assert.equal(inputs.filter(record => record.kind === "conversation").length, 1);
      if (ending === "cancel") {
        assert.match(conversations[0]!.summary, /Cancelled by user; unfinished work was not completed/);
        assert.doesNotMatch(conversations[0]!.summary, /answer arrived after cancellation/);
      }
      if (ending === "session stop") assert.match(conversations[0]!.summary, /conversation remains open/);
    });
  }

  run("a tool completing after cancellation retains its executed outcome and updates the closed summary", async ({ f, brain }) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const closedSummaryStarted = deferred<void>();
    const createRecord = brain.createRecord.bind(brain);
    brain.createRecord = async input => {
      if (input.kind === "note") {
        entered.resolve();
        await release.promise;
      }
      return createRecord(input);
    };
    const summaryInputs: BrainRecord[] = [];
    f.hooks.generation.summarize = async source => {
      if (source.kind === "conversation") {
        summaryInputs.push(structuredClone(source));
        closedSummaryStarted.resolve();
      }
      return { title: "Saved result", summary: transcriptText(source) };
    };
    let calls = 0;
    f.hooks.generation.respond = async () => ++calls === 1
      ? tool("late-note", "create_note", { title: "Packing list", text: "Bring the lens cloth and slide tray." })
      : answer("This stale assistant answer should not be published after cancellation.");
    try {
      await f.agent.submitText("Moo, save a packing list with the lens cloth and slide tray.");
      await entered.promise;
      const conversationId = f.agent.getState().conversationId!;
      await f.agent.requestEnd();
      await f.agent.resolveEnd("cancel");
      await closedSummaryStarted.promise;
      release.resolve();
      await f.agent.drain();
      const records = await brain.listRecords();
      const created = records.filter(record => record.kind === "note");
      assert.equal(created.length, 1, "Cancellation cannot erase a write that already began and then completed");
      assert.equal(created[0]!.title, "Packing list");
      assert.match(transcriptText(created[0]!), /lens cloth and slide tray/);
      const ledger: any[] = (await brain.getState(`tool-ledger:${conversationId}`))!;
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].call.id, "late-note");
      assert.equal(ledger[0].result.status, "success");
      assert.equal(ledger[0].result.executed, true);
      assert.deepEqual(ledger[0].result.result, { id: created[0]!.id, saved: true });
      const conversation = records.find(record => record.id === conversationId)!;
      assert.equal(f.agent.getState().conversationId, undefined);
      assert(summaryInputs.length >= 2, "The completed tool must refresh the earlier cancellation checkpoint");
      assert.match(conversation.summary, /Tool outcome.*create_note/);
      assert.match(conversation.summary, /"executed":true/);
      assert.match(conversation.summary, /Cancelled by user; unfinished work was not completed/);
      assert.doesNotMatch(transcriptText(conversation), /stale assistant answer/);
      assert.equal(calls, 1, "No further generation call follows the cancelled tool completion");
      assert.equal(conversation.quality, "ready");
      assert.equal(records.filter(record => record.kind === "conversation").length, 1);
    } finally {
      release.resolve();
      brain.createRecord = createRecord;
    }
  });

  run("overlapping superseded and current tools retain both actual writes while only the latest answer is published", async ({ f, brain }) => {
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const release = deferred<void>();
    const createRecord = brain.createRecord.bind(brain);
    const getState = brain.getState.bind(brain);
    brain.getState = async <T>(key: string) => {
      const value = await getState<T>(key);
      // A read that completed before another write may resolve later. Give both
      // workflows a turn to expose unguarded read/append races in either ledger.
      if (value === undefined && /^(tool-ledger|evidence-index):/.test(key))
        await new Promise<void>(resolve => setImmediate(resolve));
      return value;
    };
    let pausedNotes = 0;
    brain.createRecord = async input => {
      if (input.kind === "note") {
        if (++pausedNotes === 1) firstEntered.resolve();
        else secondEntered.resolve();
        await release.promise;
      }
      return createRecord(input);
    };
    let calls = 0;
    f.hooks.generation.respond = async () => {
      if (++calls === 1) return {
        ...tool("superseded-write", "create_note", { title: "Initial checklist", text: "Bring the lens cloth." }),
        text: "The superseded answer must not be published.",
      };
      if (calls === 2) return tool("current-write", "create_note", { title: "Additional equipment", text: "Bring the slide tray as well." });
      return answer("The latest request has been saved in Additional equipment.");
    };
    try {
      await f.agent.submitText("Moo, save a checklist to bring the lens cloth.");
      await firstEntered.promise;
      const conversationId = f.agent.getState().conversationId!;
      await f.agent.submitText("Also save a separate note to bring the slide tray as well.");
      await secondEntered.promise;
      release.resolve();
      await f.agent.drain();
      const notes = (await brain.listRecords()).filter(record => record.kind === "note");
      assert.equal(pausedNotes, 2);
      assert.equal(notes.length, 2);
      assert.deepEqual(notes.map(record => record.title).sort(), ["Additional equipment", "Initial checklist"]);
      const ledger: any[] = (await brain.getState(`tool-ledger:${conversationId}`))!;
      assert.equal(ledger.length, 2, "Concurrent read/append must retain both completed tool outcomes");
      assert.deepEqual(ledger.map(item => item.call.id).sort(), ["current-write", "superseded-write"]);
      assert(ledger.every(item => item.result.status === "success" && item.result.executed === true));
      assert.deepEqual(ledger.map(item => item.result.result.id).sort(), notes.map(record => record.id).sort());
      const retained: any = await brain.getState(`evidence-index:${conversationId}`);
      assert.deepEqual(retained.outcomes.map((item: any) => item.result.id).sort(), notes.map(record => record.id).sort());
      const conversation = (await brain.getRecord(conversationId))!;
      const replies = conversation.segments.filter(item => item.speaker === "assistant").map(item => item.text);
      assert.equal(replies.filter(text => text === "The latest request has been saved in Additional equipment.").length, 1);
      assert(!replies.some(text => text.includes("superseded answer")));
      assert.equal(calls, 3, "Only the current run may generate an answer after both tool writes finish");
      assert.equal(f.agent.getState().conversationId, conversationId);
      assert.equal(f.agent.getState().busy, false);
    } finally {
      release.resolve();
      brain.createRecord = createRecord;
      brain.getState = getState;
    }
  });

  run("a checkpoint contains the original linked request and observed tool outcomes", async ({ f, brain }) => {
    await note(brain, { id: "lamp", title: "Lamp measurement", text: "The sensor read 128 lux at 40 cm." });
    f.hooks.decisions.route = async input => input.pendingOffer ? { route: "start_agent", confidence: 1, helpAccepted: true } : { route: "offer_help", confidence: 1 };
    let calls = 0;
    f.hooks.generation.respond = async () => ++calls === 1 ? tool("lookup-lamp", "read_note", { id: "lamp" }) : answer("The recorded result is 128 lux [lamp].");
    const inputs: BrainRecord[] = [];
    f.hooks.generation.summarize = async record => { inputs.push(structuredClone(record)); return { title: "Help with lamp", summary: transcriptText(record) }; };
    await f.agent.submitText("I do not understand why the lamp measurement fell at 40 cm.");
    await f.agent.submitText("Yes, help me using only my notes.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    await f.agent.requestEnd();
    await f.agent.drain();
    const input = inputs.find(record => record.id === id)!;
    assert.ok(input);
    const source = transcriptText(input);
    assert.match(source, /do not understand why the lamp measurement fell at 40 cm/);
    assert.match(source, /Tool outcome.*read_note/);
    assert.match(source, /"status":"success"/);
    assert.match(source, /128 lux/);
    assert.match(source, /Only successful executed tool outcomes establish completed actions/);
    assert.equal((await brain.getRecord(id))!.links.filter(link => link.provenance === "reply").length, 1);
  });

  run("repeating an unchanged checkpoint makes no duplicate summary, operation or node", async ({ f, brain }) => {
    let summaries = 0;
    f.hooks.generation.summarize = async record => { summaries++; return { title: "Checkpoint", summary: transcriptText(record) }; };
    await f.agent.submitText("Moo, explain the recorded observation.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    await f.agent.checkpointConversation();
    await f.agent.drain();
    const before = (await brain.listOperations()).filter(operation => operation.kind === "enrich");
    await f.agent.checkpointConversation();
    await f.agent.drain();
    assert.equal(summaries, 1);
    assert.deepEqual((await brain.listOperations()).filter(operation => operation.kind === "enrich"), before);
    assert.equal((await brain.listRecords()).filter(record => record.kind === "conversation").length, 1);
    assert.equal(f.agent.getState().conversationId, id);
  });

  run("restart dispatches never-started finalization once and preserves an open conversation", async context => {
    const { f } = context;
    await f.agent.submitText("Moo, explain the microscope observation.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    const record = (await context.brain.getRecord(id))!;
    // Model the durable state immediately after checkpoint enqueue, before its
    // provider call begins. Checkpoint reason is written before the operation.
    await context.brain.setState(`checkpoint:${id}`, "capture stopped; conversation remains open");
    await context.brain.putOperation({ id: "undispatched-checkpoint", kind: "enrich", recordId: id, sourceRevision: record.sourceRevision, status: "pending", attempts: 0 });
    let summaries = 0;
    f.hooks.generation.summarize = async source => { summaries++; return { title: "Recovered", summary: transcriptText(source) }; };
    await context.restart();
    await f.agent.drain();
    assert.equal(summaries, 1);
    assert.equal(f.agent.getState().conversationId, id);
    assert.equal((await context.brain.listOperations()).find(operation => operation.id === "undispatched-checkpoint")!.status, "done");
    await context.restart();
    await f.agent.drain();
    assert.equal(summaries, 1, "Restart alone must not spend another summary call on unchanged input");
  });

  for (const status of ["running", "failed"] as const) {
    run(`restart leaves ${status} provider finalization visible for explicit retry`, async context => {
      const { f } = context;
      await f.agent.submitText("Moo, explain the observation.");
      await f.agent.drain();
      const id = f.agent.getState().conversationId!;
      const record = (await context.brain.getRecord(id))!;
      await context.brain.putOperation({ id: "ambiguous-provider-call", kind: "enrich", recordId: id, sourceRevision: record.sourceRevision, status, attempts: 1, error: status === "failed" ? "Provider unavailable" : undefined });
      let summaries = 0;
      f.hooks.generation.summarize = async () => { summaries++; return { title: "Should not run", summary: "Should not run" }; };
      await context.restart();
      await f.agent.drain();
      const operation = (await context.brain.listOperations()).find(item => item.id === "ambiguous-provider-call")!;
      assert.equal(summaries, 0);
      assert.equal(operation.status, "failed");
      assert.equal(operation.attempts, 1);
      assert.match(operation.error!, /retry|unavailable/);
      assert.equal(f.agent.getState().conversationId, id);
    });
  }

  run("recovery checkpoints interrupted work without closing the conversation or asserting task completion", async context => {
    const { f } = context;
    await f.agent.submitText("Moo, explain the pressure observation using only my notes.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    await context.brain.setState("agent", { ...f.agent.getState(), listening: true, busy: true });
    await context.brain.setState(`work-status:${id}`, "Response in progress; unfinished requested work remains unresolved.");
    const inputs: BrainRecord[] = [];
    f.hooks.generation.summarize = async source => { inputs.push(structuredClone(source)); return { title: "Interrupted request", summary: transcriptText(source) }; };
    await context.restart();
    await f.agent.drain();
    assert.equal(f.agent.getState().conversationId, id);
    assert.equal(f.agent.getState().listening, false);
    assert.equal(f.agent.getState().busy, false);
    assert.equal(f.agent.getState().webAllowed, false);
    assert.match(f.agent.getState().lastError!, /interrupted/);
    assert.equal(inputs.length, 1);
    assert.match(transcriptText(inputs[0]!), /unfinished requested work remains unresolved/);
    assert.match(transcriptText(inputs[0]!), /interrupted; requested work may be unresolved/);
    assert.match((await context.brain.getRecord(id))!.summary, /pressure observation/);
  });

  run("closing during a pending checkpoint creates a fresh successor and discards the stale summary", async ({ f, brain }) => {
    await f.agent.submitText("Moo, explain the current result.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    const entered = deferred<void>();
    const pending = deferred<Summary>();
    let calls = 0;
    const inputs: string[] = [];
    f.hooks.generation.summarize = async source => {
      inputs.push(transcriptText(source));
      if (++calls === 1) { entered.resolve(); return pending.promise; }
      return { title: "Closed conversation", summary: transcriptText(source) };
    };
    await f.agent.checkpointConversation();
    await entered.promise;
    await f.agent.requestEnd();
    pending.resolve({ title: "Stale checkpoint", summary: "This stale checkpoint says the conversation is still active." });
    await f.agent.drain();
    assert.equal(calls, 2);
    const record = (await brain.getRecord(id))!;
    assert.doesNotMatch(record.summary, /stale checkpoint/);
    assert.match(record.summary, /conversation closed/);
    assert.match(inputs[0]!, /conversation remains open/);
    assert.match(inputs[1]!, /conversation closed/);
    assert.equal(f.agent.getState().conversationId, undefined);
    assert.equal((await brain.listOperations()).filter(operation => operation.recordId === id && operation.status === "pending").length, 0);
  });

  run("linked source corrections invalidate pending consolidation even when conversation text is unchanged", async ({ f, brain }) => {
    f.hooks.decisions.route = async input => input.pendingOffer ? { route: "start_agent", confidence: 1, helpAccepted: true } : { route: "offer_help", confidence: 1 };
    await f.agent.submitText("I do not understand the 28 C incubation setting.");
    const linked = (await brain.listRecords()).find(record => record.kind === "dictation")!;
    await f.agent.submitText("Yes, please help me.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    const entered = deferred<void>();
    const pending = deferred<Summary>();
    let summaries = 0;
    f.hooks.generation.summarize = async source => {
      if (source.kind === "conversation" && ++summaries === 1) { entered.resolve(); return pending.promise; }
      return { title: "Current request", summary: transcriptText(source) };
    };
    await f.agent.checkpointConversation();
    await entered.promise;
    const original = linked.segments.find(item => item.speaker === "user")!;
    await brain.upsertSegment(linked.id, { ...original, revision: original.revision + 1, text: "Correction: I do not understand the 31 C incubation setting." });
    pending.resolve({ title: "Obsolete value", summary: "The current request concerns 28 C." });
    await f.agent.drain();
    const record = (await brain.getRecord(id))!;
    assert.equal(summaries, 2);
    assert.match(record.summary, /31 C/);
    assert.doesNotMatch(record.summary, /current request concerns 28 C/);
    assert.equal(record.quality, "ready");
  });

  run("an earlier conversation turn corrected during generation blocks the stale answer", async ({ f, brain }) => {
    await f.agent.ingest(segment("initial-dose", "Moo, we measured 12 mL. Use only my notes.", "first"));
    await f.agent.settleTurn("first");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    const entered = deferred<void>();
    const pending = deferred<AgentReply>();
    f.hooks.generation.respond = async () => { entered.resolve(); return pending.promise; };
    await f.agent.submitText("What quantity should I put in the report?");
    await entered.promise;
    await f.agent.ingest(segment("initial-dose", "Moo, correction: we measured 15 mL. Use only my notes.", "first", 2));
    pending.resolve(answer("Put 12 mL in the report."));
    await f.agent.drain();
    const record = (await brain.getRecord(id))!;
    assert.match(transcriptText(record), /15 mL/);
    assert(!record.segments.some(item => item.speaker === "assistant" && item.text.includes("Put 12 mL")));
    assert.match(f.agent.getState().lastError!, /changed|stale/);
  });

  run("retained evidence reloads corrected note revisions after a real adapter restart", async context => {
    const { f } = context;
    await note(context.brain, { id: "incubator", title: "Incubation", text: "The current setting is 28 C." });
    let calls = 0;
    f.hooks.generation.respond = async () => ++calls === 1 ? tool("first-read", "read_note", { id: "incubator" }) : answer("I have read the note.");
    await f.agent.submitText("Moo, read the incubator note using only my notes.");
    await f.agent.drain();
    const id = f.agent.getState().conversationId!;
    await context.restart();
    await f.agent.drain();
    await context.brain.upsertSegment("incubator", segment("incubator-source", "Correction: the current setting is 31 C.", "incubator-source", 2));
    f.hooks.generation.respond = async () => answer("The current note says 31 C [incubator].");
    const before = f.observed.generations.length;
    await f.agent.submitText("What is the current setting? Keep it to one sentence.");
    await f.agent.drain();
    const system = f.observed.generations[before]!.messages.find((message: any) => message.role === "system").content;
    assert.match(system, /current setting is 31 C/);
    assert.doesNotMatch(system, /current setting is 28 C/);
    assert.match(system, /"revision":/);
    assert.equal(f.agent.getState().conversationId, id);
    assert.equal(f.agent.getState().webAllowed, false);
    assert.equal(f.observed.generations.length - before, 1, "Unchanged retained evidence should not require another read tool");
  });

  run("the sixth generation is answer-only and receives no task tools", async ({ f, brain }) => {
    for (let index = 0; index < 5; index++) await note(brain, { id: `source-${index}`, title: `Part ${index}`, text: `Recorded observation ${index}.` });
    let calls = 0;
    f.hooks.generation.respond = async () => {
      calls++;
      return calls <= 5 ? tool(`read-${calls}`, "read_note", { id: `source-${calls - 1}` }) : answer("The notes do not establish the requested conclusion.");
    };
    await f.agent.submitText("Moo, read the five recorded parts and determine what they support, using only my notes.");
    await f.agent.drain();
    assert.equal(calls, 6);
    assert.deepEqual(f.observed.generations[5]!.tools, []);
    assert.deepEqual(f.observed.generations[5]!.settings, { responseMode: "answer_only" });
    assert(f.observed.generations.slice(0, 5).every(row => row.tools.length > 0));
    assert.match(transcriptText((await brain.getRecord(f.agent.getState().conversationId!))!), /do not establish/);
  });

  run("structured contradictory OCR values are withheld while raw evidence stays retained", async ({ f, brain }) => {
    const raw = JSON.stringify({ observations: [{ field: "calibration", status: "unreadable", value: "FOOTER-927" }] });
    f.hooks.vision.interpret = async () => ({ raw, observations: [{ field: "calibration", status: "unreadable", value: "FOOTER-927", label: "Calibration", sourceExcerpt: "Footer: FOOTER-927" }], interpretation: "The calibration is FOOTER-927.", validationErrors: [], validated: true });
    let calls = 0;
    f.hooks.generation.respond = async () => ++calls === 1 ? tool("screen", "capture_screen", { question: "Read the calibration value." }) : answer("The calibration value is unreadable.");
    await f.agent.submitText("Moo, read my screen and tell me the calibration value.");
    await f.agent.drain();
    const evidence = JSON.parse(f.observed.generations[1]!.messages.find((message: any) => message.role === "tool").content).result;
    assert.equal(evidence.observations[0].value, null);
    assert.equal(evidence.validated, false);
    assert(evidence.validationErrors.length > 0);
    assert.doesNotMatch(JSON.stringify(f.observed.generations[1]!.messages), /FOOTER-927/);
    const record = (await brain.getRecord(f.agent.getState().conversationId!))!;
    assert.equal(record.attachmentIds.length, 1);
    const stored: any = await brain.getState(`evidence:${record.attachmentIds[0]}`);
    assert.equal(stored.evidence.raw, raw);
    assert(stored.evidence.validationErrors.length > 0);
  });

  for (const alteration of ["changed", "revoked"] as const) {
    run(`local file evidence ${alteration} during generation cannot support a published answer`, async ({ f, brain }) => {
      let version = 1;
      let granted = true;
      const local: LocalFilesPort = {
        roots: async () => granted ? [{ id: "selected", name: "Notes", path: "/fixture" }] : [],
        grant: async () => ({ id: "selected", name: "Notes", path: "/fixture" }),
        revoke: async () => { granted = false; },
        search: async () => ({ matches: [], truncated: false }),
        read: async () => {
          if (!granted) throw new Error("Folder access revoked");
          return { rootId: "selected", path: "procedure.md", startLine: 1, text: `Current value is ${version === 1 ? "28" : "31"} C.`, fingerprint: `revision-${version}`, truncated: false };
        },
      };
      f.options.localFiles = local;
      f.agent = new Agent(f.options);
      await f.agent.initialize();
      const entered = deferred<void>();
      const pending = deferred<AgentReply>();
      let calls = 0;
      f.hooks.generation.respond = async () => {
        if (++calls === 1) return tool("local-read", "read_local_file", { rootId: "selected", path: "procedure.md" });
        entered.resolve();
        return pending.promise;
      };
      await f.agent.submitText("Moo, use only my notes and read procedure.md in the selected folder.");
      await entered.promise;
      if (alteration === "changed") version = 2;
      else granted = false;
      pending.resolve(answer("The current setting is 28 C [selected/procedure.md:1]."));
      await f.agent.drain();
      const record = (await brain.getRecord(f.agent.getState().conversationId!))!;
      assert(!record.segments.some(item => item.speaker === "assistant" && item.text.includes("current setting is 28")));
      assert.match(f.agent.getState().lastError!, /changed|stale/);
      assert.equal(f.observed.webCalls, 0);
      assert(f.observed.generations[0]!.tools.some((item: any) => item.name === "read_local_file"));
      assert(!f.observed.generations[0]!.tools.some((item: any) => item.name === "search_web"));
    });
  }
}
