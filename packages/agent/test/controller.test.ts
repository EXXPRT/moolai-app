import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentReply,
  BrainPort,
  BrainRecord,
  ChatMessage,
  RouteDecision,
  RouteInput,
  Segment,
  Summary,
  TagDecision,
  TagInput,
} from "../../contracts/src/index.js";
import { transcriptText } from "../../contracts/src/index.js";
import { MemoryBrain, SQLiteBrain } from "../../brain/src/index.js";
import { Agent, type AgentOptions } from "../src/index.js";

const timestamp = "2026-09-20T10:00:00.000Z";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const segment = (
  id: string,
  text: string,
  revision = 1,
  turnId = "turn",
): Segment => ({
  id,
  text,
  revision,
  turnId,
  speaker: "user",
  final: true,
  createdAt: timestamp,
});
const tags: TagDecision = {
  purpose: "Idea",
  purposeConfidence: 1,
  topics: { Gardening: 1 },
  doubt: 0,
  faithful: 1,
  understandable: 1,
  relevant: 1,
};

function fixture(brain: BrainPort) {
  let nextId = 0;
  const calls = {
    routes: [] as RouteInput[],
    responses: [] as ChatMessage[][],
    toolNames: [] as string[][],
    speech: [] as string[],
    captures: 0,
    searches: 0,
    connections: [] as string[][],
  };
  const hooks = {
    route: async (input: RouteInput): Promise<RouteDecision> => {
      if (input.pendingOffer?.kind === "help") {
        if (/^yes/i.test(input.text))
          return { route: "start_agent", confidence: 1, helpAccepted: true };
        return {
          route: /^moo/i.test(input.text) ? "start_agent" : "no_action",
          confidence: 1,
        };
      }
      if (input.pendingOffer?.kind === "end_work")
        return {
          route: "end_agent",
          confidence: 1,
          endAction: /cancel/i.test(input.text)
            ? "cancel"
            : /continue/i.test(input.text)
              ? "continue"
              : "finish",
        };
      return {
        route: /(?:end|finish)\s+(?:the\s+)?conversation/i.test(input.text)
          ? "end_agent"
          : input.activeConversation ? "continue_agent"
          : /^moo\b/i.test(input.text)
            ? "start_agent"
            : "dictate",
        confidence: 1,
      };
    },
    summarize: async (record: BrainRecord): Promise<Summary> => ({
      title: "Orchids",
      summary: transcriptText(record),
      topicSuggestion: "Gardening",
    }),
    tag: async (_input: TagInput): Promise<TagDecision> => ({ ...tags }),
    connect: async (
      _record: BrainRecord,
      candidates: BrainRecord[],
    ): Promise<Record<string, number>> =>
      Object.fromEntries(candidates.map((c) => [c.id, 1])),
    respond: async (_messages: ChatMessage[]): Promise<AgentReply> => ({
      text: "Understood.",
      toolCalls: [],
    }),
    capture: async (): Promise<{ mimeType: string; bytes: Uint8Array }> => ({
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }),
  };
  const options: AgentOptions = {
    brain,
    id: () => `id-${++nextId}`,
    now: () => timestamp,
    decisions: {
      route: (input) => {
        calls.routes.push(structuredClone(input));
        return hooks.route(input);
      },
      tag: (input) => hooks.tag(input),
      connect: async (_record, candidates) => {
        calls.connections.push(candidates.map((c) => c.id));
        return hooks.connect(_record, candidates);
      },
    },
    generation: {
      summarize: (record) => hooks.summarize(record),
      respond: (messages, tools) => {
        calls.responses.push(structuredClone(messages));
        calls.toolNames.push(tools.map((t) => t.name));
        return hooks.respond(messages);
      },
    },
    search: {
      search: async () => {
        calls.searches++;
        return [];
      },
      extract: async () => [],
    },
    capture: {
      capture: () => {
        calls.captures++;
        return hooks.capture();
      },
    },
    vision: {
      interpret: async () => "Fresh screenshot evidence: orchid leaves.",
    },
    speech: {
      speak: async (text) => {
        calls.speech.push(text);
      },
      stop: async () => {},
    },
  };
  return { hooks, calls, options, agent: new Agent(options) };
}

for (const adapter of ["memory", "sqlite"] as const) {
  const run = (
    name: string,
    action: (f: ReturnType<typeof fixture>, brain: BrainPort) => Promise<void>,
  ) => {
    test(`${adapter}: ${name}`, { timeout: 5000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "moolai-agent-"));
      const brain: BrainPort =
        adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
      const f = fixture(brain);
      try {
        await f.agent.initialize();
        await action(f, brain);
        await f.agent.drain();
      } finally {
        await brain.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  };

  run(
    "saves source before a routing provider failure",
    async ({ agent, hooks }, brain) => {
      hooks.route = async () => {
        assert.match(
          transcriptText((await brain.listRecords())[0]!),
          /A thought worth keeping/,
        );
        throw new Error("Provider offline");
      };
      await assert.rejects(
        agent.submitText("A thought worth keeping"),
        /Provider offline/,
      );
      await agent.drain();
      assert.match(
        transcriptText((await brain.listRecords())[0]!),
        /A thought worth keeping/,
      );
      assert.match(agent.getState().lastError ?? "", /Provider offline/);
    },
  );

  run("general help waits for consent and keeps original request without screen capture", async ({ agent, hooks, calls }, brain) => {
    hooks.route = async input => input.pendingOffer?.kind === "general_help"
      ? { route: "start_agent", confidence: 1, helpAccepted: true }
      : { route: "offer_help", confidence: 1 };
    hooks.tag = async () => ({ ...tags, doubt: 1 });
    await agent.submitText("What's even going on?");
    await agent.drain();
    assert.equal(agent.getState().pendingOffer?.kind, "general_help");
    assert.equal(calls.responses.length, 0);
    await agent.submitText("Yes, please.");
    await agent.drain();
    assert.equal(calls.captures, 0);
    assert.equal(calls.responses.length, 1);
    assert.match(calls.responses[0]![0]!.content, /What's even going on/);
    await agent.requestEnd();
    await agent.drain();
    assert.equal(agent.getState().pendingOffer, undefined);
    assert.ok((await brain.listRecords()).some(record => record.kind === "dictation"));
  });

  run("clarification uses the original request and declining help does not repeat an offer", async ({ agent, hooks, calls }) => {
    hooks.route = async input => input.pendingOffer?.kind === "clarification"
      ? { route: "start_agent", confidence: 1 }
      : { route: "unclear", confidence: 1 };
    await agent.submitText("The second one, that thing.");
    assert.equal(agent.getState().pendingOffer?.kind, "clarification");
    await agent.submitText("Please explain it.");
    await agent.drain();
    assert.match(calls.responses[0]![0]!.content, /The second one, that thing/);
    await agent.requestEnd();
    await agent.drain();
    hooks.tag = async () => ({ ...tags, doubt: 1 });
    hooks.route = async input => input.pendingOffer ? { route: "no_action", confidence: 1 } : { route: "offer_help", confidence: 1 };
    await agent.submitText("I am lost.");
    await agent.drain();
    await agent.submitText("No, just save it.");
    await agent.drain();
    assert.equal(agent.getState().pendingOffer, undefined);
    assert.equal(calls.captures, 0);
  });

  run("preview validates all task proposals without executing them or reporting a saved note", async ({ agent, options, hooks, calls }, brain) => {
    const observed: {name: string; allowed: boolean}[] = [];
    options.previewTool = async (call, validation) => {
      observed.push({ name: call.name, allowed: validation.allowed });
      return call.name === "search_web" ? [{ url: "https://example.com/evidence", title: "Fixture", content: "Prepared evidence" }] : { saved: true, id: "invented" };
    };
    let step = 0;
    hooks.respond = async () => ++step === 1 ? { text: "Proposals", toolCalls: [
      { id: "search", name: "search_notes", arguments: { query: "garden" } },
      { id: "read", name: "read_note", arguments: { id: "fixture" } },
      { id: "write", name: "create_note", arguments: { title: "Title", text: "Content" } },
      { id: "web", name: "search_web", arguments: { query: "garden" } },
      { id: "extract", name: "extract_web", arguments: { urls: ["https://example.com/evidence"] } },
      { id: "screen", name: "capture_screen", arguments: { question: "Read screen" } },
      { id: "bad", name: "create_note", arguments: { title: "", text: "Content" } },
    ] } : { text: "These actions were proposed, not executed.", toolCalls: [] };
    await agent.submitText("Moo, please capture my screen and research this garden.");
    await agent.drain();
    assert.deepEqual(observed.map(x => x.allowed), [true, true, true, true, true, true, false]);
    assert.equal(calls.captures, 0);
    assert.equal(calls.searches, 0);
    assert.equal((await brain.listRecords()).filter(x => x.kind === "note").length, 0);
    const output = await brain.getState<{result: Record<string, unknown>}>(`tool:${agent.getState().conversationId}:write`);
    assert.equal(output?.result.executed, false);
    assert.equal(output?.result.saved, undefined);
    assert.equal(output?.result.id, undefined);
  });

  run("preview also covers accepted saved-doubt capture and blocks forbidden web", async ({ agent, options, hooks, calls }) => {
    const observed: {name: string; allowed: boolean}[] = [];
    options.previewTool = async (call, validation) => { observed.push({name:call.name, allowed:validation.allowed}); return "Prepared image fixture"; };
    hooks.tag = async () => ({ ...tags, doubt: 1 });
    await agent.submitText("I do not understand this garden diagram.");
    await agent.drain();
    await agent.submitText("Yes, use only my notes.");
    await agent.drain();
    let count = 0;
    hooks.respond = async () => ++count === 1 ? { text: "", toolCalls: [{id:"forbidden", name:"search_web", arguments:{query:"garden"}}] } : {text:"Done", toolCalls:[]};
    await agent.submitText("Continue please.");
    await agent.drain();
    assert.deepEqual(observed, [{name:"capture_screen",allowed:true},{name:"search_web",allowed:false}]);
    assert.equal(calls.captures, 0);
    assert.equal(calls.searches, 0);
  });

  run("hybrid verifies natural closure after response scope and only once per revision", async ({ agent, hooks, calls }, brain) => {
    await agent.submitText("Moo");
    const id = agent.getState().conversationId!;
    let checks = 0;
    hooks.route = async () => ++checks === 1 ? {route:"continue_agent",confidence:1} : {route:"end_agent",confidence:1};
    hooks.respond = async () => ({ text:"Goodbye", toolCalls:[], controlProposal:{action:"end_conversation",reason:"User finished"} });
    await agent.ingest(segment("close", "That's all.", 1, "closing"));
    await agent.settleTurn("closing");
    await agent.drain();
    assert.equal(agent.getState().conversationId, undefined);
    assert.equal(agent.getState().pendingOffer, undefined);
    assert.equal(checks, 2);
    assert.doesNotMatch(calls.routes.at(-1)!.recentContext, /Goodbye/);
    assert.equal((await brain.listOperations()).filter(op => op.id.startsWith("verify-close:")).length, 1);
    await agent.settleTurn("closing");
    await agent.retryPending();
    await agent.drain();
    assert.equal(checks, 2);
    assert.match(transcriptText((await brain.getRecord(id))!), /That's all/);
  });

  run("Super task completion cannot close unless J1 confirms actual user intent", async ({ agent, hooks }) => {
    hooks.respond = async () => ({ text:"Task completed",toolCalls:[],controlProposal:{action:"end_conversation",reason:"All work finished"} });
    await agent.submitText("Moo");
    hooks.route = async () => ({ route:"continue_agent",confidence:1 });
    await agent.submitText("Explain this please.");
    await agent.drain();
    assert.ok(agent.getState().conversationId);
  });

  run("new user text invalidates a delayed hybrid closing verdict", async ({ agent, hooks }, brain) => {
    await agent.submitText("Moo");
    const id = agent.getState().conversationId;
    const entered = deferred<void>();
    const verdict = deferred<RouteDecision>();
    let checks = 0;
    hooks.route = async () => { if (++checks === 1) return {route:"continue_agent",confidence:1}; entered.resolve(); return verdict.promise; };
    hooks.respond = async () => ({text:"Goodbye",toolCalls:[],controlProposal:{action:"end_conversation",reason:"User finished"}});
    await agent.submitText("That's all.");
    await entered.promise;
    await agent.ingest(segment("new", "Wait, explain another idea.", 1, "new-turn"));
    verdict.resolve({route:"end_agent",confidence:1});
    await agent.drain();
    assert.equal(agent.getState().conversationId, id);
    assert.ok((await brain.listOperations()).some(op => op.id.startsWith("verify-close:") && op.error?.includes("Superseded")));
  });

  run("routing retry waits for its original conversation context", async ({ agent, hooks, calls }, brain) => {
    const normalRoute = hooks.route;
    hooks.route = async () => { throw new Error("Jev offline"); };
    await assert.rejects(agent.submitText("An earlier orchid thought."), /Jev offline/);
    await agent.drain();
    const failed = (await brain.listOperations()).find(operation => operation.kind === "route" && operation.status === "failed")!;
    hooks.route = normalRoute;
    await agent.submitText("Moo");
    const conversationId = agent.getState().conversationId!;
    const routeCalls = calls.routes.length;
    await agent.retryPending();
    await agent.drain();
    assert.equal(calls.routes.length, routeCalls);
    assert.equal(agent.getState().conversationId, conversationId);
    assert.doesNotMatch(transcriptText((await brain.getRecord(conversationId))!), /earlier orchid thought/);
    assert.match(agent.getState().lastError ?? "", /Routing context changed/);
    assert.equal((await brain.listOperations()).find(operation => operation.id === failed.id)?.status, "failed");
    await agent.requestEnd();
    await agent.drain();
    await agent.retryPending();
    await agent.drain();
    assert.equal((await brain.listOperations()).find(operation => operation.id === failed.id)?.status, "done");
    const notes = (await brain.listRecords()).filter(record => record.kind === "dictation");
    assert.equal(notes.length, 1);
    assert.match(transcriptText(notes[0]!), /earlier orchid thought/);
  });

  run("routing retry cannot apply an old Yes to a different help offer", async ({ agent, hooks, calls }, brain) => {
    hooks.tag = async () => ({ ...tags, doubt: 1 });
    await agent.submitText("I am unsure about my first thought.");
    await agent.drain();
    const firstOffer = agent.getState().pendingOffer;
    const normalRoute = hooks.route;
    hooks.route = async () => { throw new Error("Jev offline"); };
    await assert.rejects(agent.submitText("Yes"), /Jev offline/);
    await agent.drain();
    hooks.route = normalRoute;
    await agent.submitText("No");
    await agent.submitText("I am unsure about a different thought.");
    await agent.drain();
    const secondOffer = agent.getState().pendingOffer;
    assert.notDeepEqual(secondOffer, firstOffer);
    assert.equal(secondOffer?.kind, "help");
    const routeCalls = calls.routes.length;
    await agent.retryPending();
    await agent.drain();
    assert.equal(calls.routes.length, routeCalls);
    assert.equal(calls.captures, 0);
    assert.deepEqual(agent.getState().pendingOffer, secondOffer);
    assert.equal(agent.getState().conversationId, undefined);
    assert.ok((await brain.listOperations()).some(operation => operation.kind === "route" && operation.status === "failed" && operation.error?.includes("context changed")));
  });

  run(
    "routes three assembled ASR blocks once while preserving one Moo exchange",
    async ({ agent, calls }, brain) => {
      await agent.submitText("Moo");
      const conversationId = agent.getState().conversationId!;
      await agent.ingest(segment("a", "Explain the first part."));
      await agent.ingest(segment("b", "Then compare the second part."));
      await agent.ingest(segment("c", "Use only my notes."));
      await agent.settleTurn("turn");
      await agent.drain();
      assert.equal(agent.getState().conversationId, conversationId);
      assert.equal(calls.routes.length, 2);
      assert.deepEqual(
        (await brain.getRecord(conversationId))?.segments
          .filter((s) => ["a", "b", "c"].includes(s.id))
          .map((s) => s.text),
        [
          "Explain the first part.",
          "Then compare the second part.",
          "Use only my notes.",
        ],
      );
      assert.match(
        calls.responses[0]!.map((m) => m.content).join("\n"),
        /first part[\s\S]*second part[\s\S]*only my notes/,
      );
    },
  );

  run(
    "turns queued during Moo routing are attached before their response starts",
    async ({ agent, hooks, calls }, brain) => {
      const invoked = deferred<void>();
      const decision = deferred<RouteDecision>();
      hooks.route = async (input) => {
        if (input.activeConversation) return { route: "continue_agent", confidence: 1 };
        invoked.resolve();
        return decision.promise;
      };
      await agent.ingest(segment("invocation", "Moo", 1, "invocation-turn"));
      const opening = agent.settleTurn("invocation-turn");
      await invoked.promise;
      await agent.ingest(
        segment("queued-a", "First part of my request.", 1, "queued-turn-a"),
      );
      const first = agent.settleTurn("queued-turn-a");
      await agent.ingest(
        segment(
          "queued-b",
          "Second part; keep both together.",
          1,
          "queued-turn-b",
        ),
      );
      const second = agent.settleTurn("queued-turn-b");
      decision.resolve({ route: "start_agent", confidence: 1 });
      await Promise.all([opening, first, second]);
      await agent.drain();
      const conversation = (await brain.getRecord(
        agent.getState().conversationId!,
      ))!;
      assert.deepEqual(
        conversation.segments
          .filter((s) => s.speaker === "user")
          .map((s) => s.id),
        ["invocation", "queued-a", "queued-b"],
      );
      assert.equal(calls.routes.length, 3);
      assert.match(
        calls.responses
          .at(-1)!
          .map((m) => m.content)
          .join("\n"),
        /First part[\s\S]*Second part/,
      );
    },
  );

  run(
    "a later dictation correction updates its original note without duplicating it or entering a new conversation",
    async ({ agent, calls }, brain) => {
      await agent.ingest(
        segment("thought", "Grow orchids outdoors.", 1, "thought-turn"),
      );
      await agent.settleTurn("thought-turn");
      await agent.drain();
      const original = (await brain.listRecords()).find(
        (record) => record.kind === "dictation",
      )!;
      await agent.submitText("Moo");
      const conversationId = agent.getState().conversationId!;
      await agent.ingest(
        segment("thought", "Grow orchids indoors.", 2, "thought-turn"),
      );
      await agent.settleTurn("thought-turn");
      await agent.drain();
      const notes = (await brain.listRecords()).filter(
        (record) => record.kind === "dictation",
      );
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.id, original.id);
      assert.equal(notes[0]?.segments[0]?.text, "Grow orchids indoors.");
      assert.match(notes[0]!.summary, /indoors/);
      assert.equal(
        (await brain.getRecord(conversationId))?.segments.some(
          (s) => s.id === "thought",
        ),
        false,
      );
      assert.equal(calls.routes.length, 2);
    },
  );

  run(
    "quoted, negated and malformed end phrases cannot close an active exchange",
    async ({ agent, calls, hooks }, brain) => {
      await agent.submitText("Moo");
      const id = agent.getState().conversationId!;
      hooks.route = async () => ({ route: "continue_agent", confidence: 1 });
      const ordinarySpeech = [
        'What does "Moo, end conversation" mean?',
        '"Moo. Finish the conversation."',
        "‘Moo:\nfinish conversation.’",
        "`Moo. End conversation.`",
        "Moo, don't end conversation.",
        "Moo. Do not finish the conversation.",
        "Moo:\nnever finish conversation.",
        "I said Moo. Finish conversation.",
        "If I say Moo. End the conversation.",
        "Moo and the conversation.",
        "Move, finish conversation.",
        "Mu, end conversation.",
      ];
      for (const text of ordinarySpeech) {
        await agent.submitText(text);
        await agent.drain();
        assert.equal(agent.getState().conversationId, id, text);
      }
      assert.equal(calls.routes.length, ordinarySpeech.length + 1);
      const source = transcriptText((await brain.getRecord(id))!);
      for (const text of ordinarySpeech) assert.ok(source.includes(text), text);
      hooks.route = async () => ({ route: "end_agent", confidence: 1 });
      await agent.submitText("Moo, end conversation");
      await agent.drain();
      assert.equal(agent.getState().conversationId, undefined);
    },
  );

  run(
    "literal finish and end controls retain source but require the same confidence as natural controls",
    async ({ agent, hooks, calls }, brain) => {
      const normalRoute = hooks.route;
      for (const text of [
        "Moo, end conversation.",
        "moo end conversation",
        "MOO,  END CONVERSATION!",
        "Moo. End conversation.",
        "Moo\nEnd the conversation.",
        "Moo: end the conversation.",
        "Moo, finish conversation.",
        "Moo. Finish the conversation.",
        "Moo\nfinish conversation",
        "Moo:\nFinish the conversation!",
      ]) {
        hooks.route = normalRoute;
        await agent.submitText("Moo");
        const conversationId = agent.getState().conversationId!;
        hooks.route = async () => ({ route: "end_agent", confidence: 0.61 });
        await agent.submitText(text);
        await agent.drain();
        assert.equal(agent.getState().conversationId, conversationId);
        await agent.requestEnd();
        await agent.drain();
        assert.ok(transcriptText((await brain.getRecord(conversationId))!).includes(text));
        assert.ok(transcriptText((await brain.getRecord(agent.getState().sessionId!))!).includes(text));
        assert.equal(calls.routes.at(-1)?.text, text);
        assert.equal(calls.routes.at(-1)?.activeConversation, true);
      }
      assert.equal(calls.responses.length, 0, "a control alone must not launch an answer");
      assert.equal(calls.speech.some(text => text.includes("talk to Moo or keep it as a note")), false);
    },
  );

  run(
    "an exact end control still requires an active conversation and Jev agreement",
    async ({ agent, hooks }, brain) => {
      const normalRoute = hooks.route;
      hooks.route = async () => ({ route: "end_agent", confidence: 0.61 });
      await agent.submitText("Moo. Finish the conversation.");
      assert.equal(agent.getState().conversationId, undefined);
      hooks.route = normalRoute;
      await agent.submitText("Moo");
      const conversationId = agent.getState().conversationId;
      for (const route of ["unclear", "dictate", "no_action", "start_agent"] as const) {
        hooks.route = async () => ({ route, confidence: 1 });
        await agent.submitText("Moo. Finish the conversation.");
        await agent.drain();
        assert.equal(agent.getState().conversationId, conversationId, route);
      }
      assert.ok(transcriptText((await brain.getRecord(agent.getState().sessionId!))!).includes("Moo. Finish the conversation."));
    },
  );

  run(
    "low-confidence quoted, negated, hypothetical and longer end speech stays open",
    async ({ agent, hooks, calls }) => {
      await agent.submitText("Moo");
      const conversationId = agent.getState().conversationId;
      hooks.route = async () => ({ route: "end_agent", confidence: 0.61 });
      for (const text of [
        '"Moo, end conversation."',
        '"Moo. Finish the conversation."',
        "Moo, don't end conversation.",
        "Moo:\ndo not finish the conversation.",
        "If I say Moo, end conversation.",
        "I said Moo. Finish conversation.",
        "Moo, stop conversation.",
        "Finish the conversation.",
        "Keep this thought. Moo, end conversation.",
        "Keep this thought. Moo. Finish the conversation.",
        "Moo and the conversation.",
      ]) {
        await agent.submitText(text);
        await agent.drain();
        assert.equal(agent.getState().conversationId, conversationId, text);
      }
      // Alternate and compound end requests still pass through the ordinary confidence gate.
      assert.ok(calls.routes.some(input => input.text === "Moo, stop conversation."));
      assert.ok(calls.routes.some(input => input.text === "Keep this thought. Moo, end conversation."));
    },
  );

  run(
    "the verified canonical end asks about running work and cannot resolve that choice itself",
    async ({ agent, hooks, calls }, brain) => {
      const entered = deferred<void>();
      const response = deferred<AgentReply>();
      hooks.respond = async () => {
        entered.resolve();
        return response.promise;
      };
      await agent.submitText("Moo, prepare a garden note.");
      await entered.promise;
      const conversationId = agent.getState().conversationId!;
      try {
        hooks.route = async () => ({ route: "end_agent", confidence: 0.93 });
        await agent.submitText("Moo. Finish the conversation.");
        assert.equal(agent.getState().conversationId, conversationId);
        assert.equal(agent.getState().busy, true);
        assert.equal(agent.getState().pendingOffer?.kind, "end_work");
        assert.ok(calls.speech.some(text => text.includes("Should I finish and save it, cancel it")));

        // A repeated end phrase is not permission to cancel work; the pending-choice gate stays intact.
        hooks.route = async () => ({ route: "end_agent", confidence: 0.61, endAction: "cancel" });
        await agent.submitText("Moo:\nfinish conversation.");
        assert.equal(agent.getState().conversationId, conversationId);
        assert.equal(agent.getState().busy, true);
        assert.equal(agent.getState().pendingOffer?.kind, "end_work");
        await agent.resolveEnd("finish");
      } finally {
        response.resolve({ text: "Garden note prepared.", toolCalls: [] });
      }
      await agent.drain();
      assert.equal(agent.getState().conversationId, undefined);
      assert.ok(transcriptText((await brain.getRecord(conversationId))!).includes("Garden note prepared."));
    },
  );

  run(
    "a new exchange announces the finish control once and retains the guidance",
    async ({ agent, calls }, brain) => {
      const announcement = "I'm listening. Say ‘Moo, finish conversation’ when you're done.";
      await agent.submitText("Moo");
      const id = agent.getState().conversationId!;
      await agent.submitText("The first idea is to group the garden notes.");
      await agent.drain();
      await agent.submitText("Keep watering reminders together.");
      await agent.drain();
      assert.equal(calls.speech.filter(text => text === announcement).length, 1);
      assert.ok(transcriptText((await brain.getRecord(id))!).includes(announcement));
      await agent.submitText("Moo, finish conversation.");
      await agent.drain();
      await agent.submitText("Moo");
      assert.notEqual(agent.getState().conversationId, id);
      assert.equal(calls.speech.filter(text => text === announcement).length, 2);
    },
  );

  run(
    "J1 closing-only assessment avoids inventing work from a misheard address",
    async ({ agent, hooks, calls }, brain) => {
      await agent.submitText("Moo");
      const id = agent.getState().conversationId!;
      const before = calls.responses.length;
      hooks.route = async () => ({ route: "end_agent", confidence: 0.93, substantiveContentProbability: 0.02 });
      const text = "Boo.\n Finish conversation.";
      await agent.submitText(text);
      await agent.drain();
      assert.equal(agent.getState().conversationId, undefined);
      assert.equal(agent.getState().pendingOffer, undefined);
      assert.equal(calls.responses.length, before);
      assert.ok(transcriptText((await brain.getRecord(id))!).includes(text));
    },
  );

  run(
    "closing-only assessment does not bypass route confidence or pending work",
    async ({ agent, hooks }, brain) => {
      await agent.submitText("Moo");
      const id = agent.getState().conversationId!;
      hooks.route = async () => ({ route: "end_agent", confidence: 0.4, substantiveContentProbability: 0 });
      await agent.submitText("Boo. Finish conversation.");
      assert.equal(agent.getState().conversationId, id);
      const response = deferred<AgentReply>();
      hooks.respond = async () => response.promise;
      hooks.route = async () => ({ route: "continue_agent", confidence: 1 });
      await agent.submitText("Please summarize the garden notes.");
      hooks.route = async () => ({ route: "end_agent", confidence: 0.93, substantiveContentProbability: 0 });
      try {
        await agent.submitText("Boo. Finish conversation.");
        assert.equal(agent.getState().conversationId, id);
        assert.equal(agent.getState().pendingOffer?.kind, "end_work");
        assert.ok(transcriptText((await brain.getRecord(id))!).includes("Please summarize the garden notes."));
        await agent.resolveEnd("finish");
      } finally {
        response.resolve({ text: "Garden summary.", toolCalls: [] });
      }
      await agent.drain();
      assert.equal(agent.getState().conversationId, undefined);
    },
  );

  run(
    "substantive speech before a punctuated finish control stays available for work",
    async ({ agent, hooks, calls }, brain) => {
      const originalRoute = hooks.route;
      for (const assessment of [0.97, 0.5, undefined]) {
        hooks.route = originalRoute;
        await agent.submitText("Moo");
        const id = agent.getState().conversationId!;
        const entered = deferred<void>();
        const response = deferred<AgentReply>();
        hooks.respond = async () => {
          entered.resolve();
          return response.promise;
        };
        hooks.route = async () => ({ route: "end_agent", confidence: 1, substantiveContentProbability: assessment });
        const text = "Please organize the garden notes. Moo. Finish the conversation.";
        try {
          await agent.submitText(text);
          await entered.promise;
          assert.equal(agent.getState().conversationId, id);
          assert.equal(agent.getState().pendingOffer?.kind, "end_work");
          assert.ok(calls.responses.at(-1)!.some(message => message.role === "user" && message.content === text));
          assert.ok(transcriptText((await brain.getRecord(id))!).includes(text));
          await agent.resolveEnd("finish");
        } finally {
          response.resolve({ text: "Garden notes organized.", toolCalls: [] });
        }
        await agent.drain();
        assert.equal(agent.getState().conversationId, undefined);
        assert.ok(transcriptText((await brain.getRecord(id))!).includes("Garden notes organized."));
      }
    },
  );

  run(
    "an ASR correction invalidates a pending canonical end decision",
    async ({ agent, hooks }, brain) => {
      await agent.submitText("Moo");
      const conversationId = agent.getState().conversationId!;
      const entered = deferred<void>();
      const decision = deferred<RouteDecision>();
      hooks.route = async () => {
        entered.resolve();
        return decision.promise;
      };
      await agent.ingest(segment("corrected-end", "Moo. Finish the conversation.", 1, "end-turn"));
      const settling = agent.settleTurn("end-turn");
      await entered.promise;
      await agent.ingest(segment("corrected-end", "Moo. Do not finish the conversation.", 2, "end-turn"));
      decision.resolve({ route: "end_agent", confidence: 0.61 });
      await settling;
      await agent.drain();
      assert.equal(agent.getState().conversationId, conversationId);
      const corrected = (await brain.getRecord(conversationId))!.segments.find(item => item.id === "corrected-end");
      assert.equal(corrected?.text, "Moo. Do not finish the conversation.");
      assert.equal(corrected?.revision, 2);
    },
  );

  run(
    "declining a saved doubt captures no screen and retains the thought",
    async ({ agent, hooks, calls }, brain) => {
      hooks.tag = async () => ({ ...tags, doubt: 1 });
      await agent.submitText("I do not understand this idea.");
      await agent.drain();
      const offer = agent.getState().pendingOffer;
      assert.equal(offer?.kind, "help");
      await agent.submitText("No thanks");
      await agent.drain();
      assert.equal(calls.captures, 0);
      assert.equal(agent.getState().pendingOffer, undefined);
      assert.ok(
        (await brain.listRecords()).some(
          (r) =>
            r.kind === "dictation" && transcriptText(r).includes("understand"),
        ),
      );
    },
  );

  run(
    "an unrelated Moo request does not accept a pending screen-help offer",
    async ({ agent, hooks, calls }, brain) => {
      hooks.tag = async () => ({ ...tags, doubt: 1 });
      await agent.submitText("I do not understand this idea.");
      await agent.drain();
      assert.equal(agent.getState().pendingOffer?.kind, "help");
      await agent.submitText("Moo, help me plan my weekend instead.");
      await agent.drain();
      assert.equal(calls.captures, 0);
      const conversation = (await brain.getRecord(
        agent.getState().conversationId!,
      ))!;
      assert.equal(
        conversation.links.some((link) => link.provenance === "reply"),
        false,
      );
      assert.equal(agent.getState().pendingOffer, undefined);
    },
  );

  run(
    "accepted help captures fresh evidence and finish waits for capture and answer",
    async ({ agent, hooks, calls }, brain) => {
      hooks.tag = async () => ({ ...tags, doubt: 1 });
      const captureStarted = deferred<void>();
      const image = deferred<{ mimeType: string; bytes: Uint8Array }>();
      hooks.capture = async () => {
        captureStarted.resolve();
        return image.promise;
      };
      await agent.submitText("I do not understand these leaves.");
      await agent.drain();
      await agent.submitText("Yes please");
      await captureStarted.promise;
      const conversationId = agent.getState().conversationId!;
      assert.equal(agent.getState().busy, true);
      await agent.requestEnd();
      assert.equal(agent.getState().pendingOffer?.kind, "end_work");
      await agent.resolveEnd("finish");
      image.resolve({ mimeType: "image/png", bytes: new Uint8Array([7, 8]) });
      await agent.drain();
      assert.equal(calls.captures, 1);
      assert.equal(agent.getState().conversationId, undefined);
      assert.match(
        calls.responses[0]![0]!.content,
        /Legacy output is unvalidated/,
      );
      assert.doesNotMatch(calls.responses[0]![0]!.content, /\[object Object\]/);
      const attachmentId = (await brain.getRecord(conversationId))!
        .attachmentIds[0]!;
      assert.deepEqual(
        (await brain.getAttachment(attachmentId))?.bytes,
        new Uint8Array([7, 8]),
      );
    },
  );

  run(
    "an ASR correction during J1 supersedes the old decision and is re-routed",
    async ({ agent, hooks, calls }, brain) => {
      const entered = deferred<void>();
      const route = deferred<RouteDecision>();
      hooks.route = async (input) => {
        if (input.text === "Moo") {
          entered.resolve();
          return route.promise;
        }
        return { route: "dictate", confidence: 1 };
      };
      await agent.ingest(segment("corrected", "Moo"));
      const settling = agent.settleTurn("turn");
      await entered.promise;
      await agent.ingest(segment("corrected", "Grow orchids indoors.", 2));
      route.resolve({ route: "start_agent", confidence: 1 });
      await settling;
      await agent.drain();
      assert.equal(calls.routes.length, 2);
      assert.equal(agent.getState().conversationId, undefined);
      const note = (await brain.listRecords()).find(
        (r) => r.kind === "dictation",
      )!;
      assert.equal(note.segments[0]?.text, "Grow orchids indoors.");
    },
  );

  run(
    "delayed summaries cannot overwrite manual edits or strand enrichment operations",
    async ({ agent, hooks }, brain) => {
      const entered = deferred<void>();
      const summary = deferred<Summary>();
      hooks.summarize = async () => {
        entered.resolve();
        return summary.promise;
      };
      await agent.submitText("Grow orchids indoors.");
      await entered.promise;
      const note = (await brain.listRecords()).find(
        (r) => r.kind === "dictation",
      )!;
      await agent.editRecord(note.id, note.revision, {
        summary: "My exact wording",
        title: "My title",
      });
      summary.resolve({
        title: "Stale generated title",
        summary: "Stale generated summary",
        topicSuggestion: "Gardening",
      });
      await agent.drain();
      const saved = (await brain.getRecord(note.id))!;
      assert.equal(saved.summary, "My exact wording");
      assert.equal(saved.title, "My title");
      assert.equal(saved.quality, "ready");
      assert.ok(
        (await brain.listOperations()).every(
          (op) => op.status !== "running" && op.status !== "pending",
        ),
      );
    },
  );

  run(
    "source changes during enrichment retry the newer source and retain off-topic ready notes",
    async ({ agent, hooks, calls }, brain) => {
      await agent.setSubject("Algebra");
      const seed = await brain.createRecord({
        id: "existing-orchid",
        kind: "note",
        createdAt: timestamp,
      });
      await brain.updateRecord(seed.id, seed.revision, {
        title: "Orchids",
        topics: ["Gardening"],
      });
      const entered = deferred<void>();
      const summary = deferred<Summary>();
      let attempts = 0;
      hooks.summarize = async (record) => {
        if (++attempts === 1) {
          entered.resolve();
          return summary.promise;
        }
        return {
          title: "Orchids",
          summary: transcriptText(record),
          topicSuggestion: "Gardening",
        };
      };
      hooks.tag = async (input) => {
        assert.equal(input.currentSubject, "Algebra");
        return { ...tags, relevant: 0 };
      };
      await agent.submitText("Grow orchids.");
      await entered.promise;
      const note = (await brain.listRecords()).find(
        (r) => r.kind === "dictation",
      )!;
      await brain.upsertSegment(note.id, {
        ...note.segments[0]!,
        revision: 2,
        text: "Grow orchids in indirect sunlight.",
      });
      await agent.setSubject("Biology");
      summary.resolve({ title: "Stale", summary: "Stale" });
      await agent.drain();
      const saved = (await brain.getRecord(note.id))!;
      assert.match(saved.summary, /indirect sunlight/);
      assert.equal(saved.quality, "ready");
      assert.equal(saved.offTopic?.subject, "Algebra");
      assert.equal(
        (await brain.search("indirect sunlight", 5))[0]?.id,
        note.id,
      );
      assert.ok(calls.connections.flat().includes(seed.id));
      assert.ok(
        (await brain.listOperations()).every((op) => op.status === "done"),
      );
    },
  );

  run(
    "J6 retrieves from original content when title, summary and tags do not name the topic",
    async ({ agent, hooks, calls }, brain) => {
      const seed = await brain.createRecord({
        id: "heliconia-reference",
        kind: "note",
        createdAt: timestamp,
      });
      await brain.updateRecord(seed.id, seed.revision, {
        title: "Heliconia propagation by division",
      });
      await agent.setSubject("Algebra");
      hooks.summarize = async () => ({
        title: "A thought",
        summary: "An observation worth keeping.",
      });
      hooks.tag = async () => ({ ...tags, topics: {}, relevant: 0 });
      await agent.submitText(
        "Heliconia propagation by division takes patience.",
      );
      await agent.drain();
      const note = (await brain.listRecords()).find(
        (record) => record.kind === "dictation",
      )!;
      assert.deepEqual(note.topics, []);
      assert.equal(note.offTopic?.subject, "Algebra");
      assert.ok(calls.connections.flat().includes(seed.id));
      assert.ok(note.links.some((link) => link.targetId === seed.id));
    },
  );

  run(
    "failed connections remain retryable without downgrading a Ready summary or summarizing again",
    async ({ agent, hooks }, brain) => {
      const seed = await brain.createRecord({
        id: "orchid-source",
        kind: "note",
        createdAt: timestamp,
      });
      await brain.updateRecord(seed.id, seed.revision, {
        title: "Orchids",
        topics: ["Gardening"],
      });
      let summaries = 0,
        connections = 0;
      hooks.summarize = async (record) => {
        summaries++;
        return {
          title: "Orchids",
          summary: transcriptText(record),
          topicSuggestion: "Gardening",
        };
      };
      hooks.connect = async (_record, candidates) => {
        if (++connections === 1)
          throw new Error("Connection service unavailable");
        return Object.fromEntries(candidates.map((c) => [c.id, 1]));
      };
      await agent.submitText("Grow orchids in the shade.");
      await agent.drain();
      const note = (await brain.listRecords()).find(
        (record) => record.kind === "dictation",
      )!;
      assert.equal(note.quality, "ready");
      assert.match(note.error ?? "", /Connections pending/);
      assert.ok(
        (await brain.listOperations()).some(
          (op) => op.kind === "enrich" && op.status === "failed",
        ),
      );
      await agent.retryPending(note.id);
      await agent.drain();
      const retried = (await brain.getRecord(note.id))!;
      assert.equal(retried.quality, "ready");
      assert.equal(retried.error, undefined);
      assert.ok(retried.links.some((link) => link.targetId === seed.id));
      assert.equal(summaries, 1);
      assert.equal(connections, 2);
    },
  );

  run("incidental and quoted screen mentions cannot authorize capture", async ({ agent, hooks, calls }) => {
    hooks.respond = async messages => messages.at(-1)?.role === "tool"
      ? { text: "Understood.", toolCalls: [] }
      : { text: "", toolCalls: [{ id: "capture-attempt", name: "capture_screen", arguments: { question: "What is visible?" } }] };
    await agent.submitText("Moo, explain screen printing.");
    await agent.drain();
    await agent.submitText('What does "take a screenshot" mean?');
    await agent.drain();
    await agent.submitText("The phrase 'capture my screen' appeared in a manual.");
    await agent.drain();
    assert.equal(calls.captures, 0);
    assert.ok(calls.responses.filter(messages => messages.at(-1)?.role === "tool").every(messages => messages.at(-1)!.content.includes("explicit request")));
  });

  run("explicit screen requests work until a later refusal revokes them", async ({ agent, hooks, calls }) => {
    hooks.respond = async messages => messages.at(-1)?.role === "tool"
      ? { text: "Understood.", toolCalls: [] }
      : { text: "", toolCalls: [{ id: "capture-attempt", name: "capture_screen", arguments: { question: "Read the visible content." } }] };
    await agent.submitText("Moo, take a screenshot.");
    await agent.drain();
    assert.equal(calls.captures, 1);
    await agent.submitText("Explain the next part too.");
    await agent.drain();
    assert.equal(calls.captures, 2, "A prior clear request remains valid in the same exchange");
    await agent.submitText("Do not capture my screen anymore.");
    await agent.drain();
    assert.equal(calls.captures, 2);
    await agent.submitText("Tell me about screen printing.");
    await agent.drain();
    assert.equal(calls.captures, 2, "An incidental mention cannot undo refusal");
    await agent.submitText("Please take a fresh screenshot now.");
    await agent.drain();
    assert.equal(calls.captures, 3);
  });

  run("a screen refusal split across speech blocks still revokes capture", async ({ agent, hooks, calls }) => {
    hooks.respond = async messages => messages.at(-1)?.role === "tool"
      ? { text: "Understood.", toolCalls: [] }
      : { text: "", toolCalls: [{ id: "capture-attempt", name: "capture_screen", arguments: { question: "Read the screen." } }] };
    await agent.submitText("Moo, can you look at my screen?");
    await agent.drain();
    assert.equal(calls.captures, 1);
    await agent.ingest(segment("refusal-a", "Do not", 1, "refusal-turn"));
    await agent.ingest(segment("refusal-b", "capture my screen.", 1, "refusal-turn"));
    await agent.settleTurn("refusal-turn");
    await agent.drain();
    assert.equal(calls.captures, 1);
  });

  run(
    "notes-only disables both advertised and attempted web tools",
    async ({ agent, hooks, calls }) => {
      let replies = 0;
      hooks.respond = async () =>
        ++replies === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "web-attempt",
                  name: "search_web",
                  arguments: { query: "orchids" },
                },
              ],
            }
          : { text: "Using your notes.", toolCalls: [] };
      await agent.submitText("Moo, use only my notes to explain this.");
      await agent.drain();
      assert.equal(calls.searches, 0);
      assert.ok(
        calls.toolNames.every(
          (names) =>
            !names.includes("search_web") && !names.includes("extract_web"),
        ),
      );
      assert.match(
        calls.responses[1]!.find((m) => m.role === "tool")!.content,
        /Web access disabled/,
      );
    },
  );

  run(
    "an explicit notes restriction survives the observed possessive error without rewriting source",
    async ({ agent, hooks, calls }, brain) => {
      await agent.submitText("Moo");
      const id = agent.getState().conversationId!;
      const text = "Use only by notes. The final word is Telescope.";
      let replies = 0;
      hooks.respond = async () => ++replies === 1
        ? { text: "", toolCalls: [{ id: "attempt", name: "search_web", arguments: { query: "orchids" } }] }
        : { text: "Using saved notes.", toolCalls: [] };
      await agent.submitText(text);
      await agent.drain();
      assert.equal(agent.getState().webAllowed, false);
      assert.equal(calls.searches, 0);
      assert.ok(calls.toolNames.every(names => !names.includes("search_web") && !names.includes("extract_web")));
      assert.ok((await brain.getRecord(id))!.segments.some(s => s.text === text));
      await agent.submitText("Please search the web.");
      await agent.drain();
      assert.equal(agent.getState().webAllowed, true);
    },
  );

  run("a natural mixed closure preserves its final request and asks about pending work", async ({ agent, hooks, calls }, brain) => {
    await agent.submitText("Moo");
    const conversationId = agent.getState().conversationId!;
    const entered = deferred<void>();
    const reply = deferred<AgentReply>();
    hooks.route = async () => ({ route: "end_agent", confidence: .96, substantiveContentProbability: .94 });
    hooks.respond = async () => { entered.resolve(); return reply.promise; };
    const request = "Please explain why the goalpost is five metres wide, then that's all.";
    await agent.submitText(request);
    await entered.promise;
    assert.equal(agent.getState().pendingOffer?.kind, "end_work");
    assert.equal(agent.getState().conversationId, conversationId);
    assert.ok(calls.responses.at(-1)!.some(message => message.role === "user" && message.content === request));
    await agent.resolveEnd("finish");
    reply.resolve({ text: "The requested final explanation is retained.", toolCalls: [] });
    await agent.drain();
    assert.equal(agent.getState().conversationId, undefined);
    assert.match(transcriptText((await brain.getRecord(conversationId))!), /requested final explanation/);
  });

  run("successive clarification turns keep the original request and every added constraint", async ({ agent, hooks, calls }, brain) => {
    let routed = 0;
    hooks.route = async () => ({ route: ++routed < 4 ? "unclear" : "start_agent", confidence: .96 });
    const requests = [
      "Maybe work through the goalpost measurement with me, or just save this thought.",
      "Use only my notes and keep the explanation course neutral.",
      "Focus on the five metre width and preserve the units.",
      "Yes, explain that measurement now.",
    ];
    for (const request of requests) await agent.submitText(request);
    await agent.drain();
    assert.equal(calls.responses.length, 1);
    const context = calls.responses[0]!.map(message => message.content).join("\n");
    for (const request of requests) assert.ok(context.includes(request), request);
    assert.equal(agent.getState().webAllowed, false);
    assert.equal(calls.captures, 0);
    const thoughts = (await brain.listRecords()).filter(record => record.kind === "dictation");
    assert.equal(thoughts.length, 1);
    for (const request of requests) assert.ok(transcriptText(thoughts[0]!).includes(request));
    assert.ok(calls.routes.at(-1)!.recentContext.includes(requests[1]!));
    assert.equal(agent.getState().pendingOffer, undefined);
  });

  run("declining clarification does not offer the saved doubt again after enrichment", async ({ agent, hooks, calls }, brain) => {
    hooks.route = async (input) => ({ route: input.pendingOffer ? "no_action" : "unclear", confidence: .96 });
    hooks.tag = async () => ({ ...tags, doubt: 1 });
    await agent.submitText("I do not understand this, but I have not decided whether to ask.");
    assert.equal(agent.getState().pendingOffer?.kind, "clarification");
    await agent.submitText("No, just keep it as a note.");
    await agent.drain();
    assert.equal(agent.getState().pendingOffer, undefined);
    assert.equal(agent.getState().conversationId, undefined);
    assert.equal(calls.responses.length, 0);
    assert.equal(calls.captures, 0);
    assert.ok(calls.speech.every(text => !/would you like help/i.test(text)));
    const thought = (await brain.listRecords()).find(record => record.kind === "dictation")!;
    assert.equal(thought.doubt, true);
    assert.match(transcriptText(thought), /No, just keep it as a note/);
  });

  run("continuing after choosing finish retracts the pending automatic close", async ({ agent, hooks }, brain) => {
    const entered = deferred<void>();
    const reply = deferred<AgentReply>();
    hooks.respond = async () => { entered.resolve(); return reply.promise; };
    await agent.submitText("Moo, explain the retained measurement.");
    await entered.promise;
    const conversationId = agent.getState().conversationId!;
    await agent.requestEnd();
    await agent.resolveEnd("finish");
    await agent.resolveEnd("continue");
    reply.resolve({ text: "The explanation finished, while the conversation stays open.", toolCalls: [] });
    await agent.drain();
    assert.equal(agent.getState().conversationId, conversationId);
    assert.equal(agent.getState().pendingOffer, undefined);
    assert.equal(agent.getState().busy, false);
    assert.match(transcriptText((await brain.getRecord(conversationId))!), /conversation stays open/);
  });

  run("a spoken continue can retract finish while the final response is still running", async ({ agent, hooks, calls }, brain) => {
    const entered = deferred<void>();
    const reply = deferred<AgentReply>();
    const normalRoute = hooks.route;
    hooks.route = async (input) => input.pendingOffer?.kind === "end_work"
      ? { route: /keep.*open/i.test(input.text) ? "no_action" : "end_agent", confidence: .96,
          endAction: /keep.*open/i.test(input.text) ? "continue" : "finish" }
      : normalRoute(input);
    hooks.respond = async () => { entered.resolve(); return reply.promise; };
    await agent.submitText("Moo, explain the retained measurement.");
    await entered.promise;
    const conversationId = agent.getState().conversationId!;
    await agent.requestEnd();
    await agent.submitText("Finish the work, then close.");
    assert.equal(agent.getState().pendingOffer?.kind, "end_work");
    await agent.submitText("Actually, keep this conversation open.");
    assert.equal(calls.routes.at(-1)!.pendingOffer?.kind, "end_work");
    assert.equal(agent.getState().pendingOffer, undefined);
    reply.resolve({ text: "The requested explanation is complete.", toolCalls: [] });
    await agent.drain();
    assert.equal(agent.getState().conversationId, conversationId);
    assert.equal(agent.getState().busy, false);
    assert.equal(calls.responses.length, 1);
    assert.match(transcriptText((await brain.getRecord(conversationId))!), /keep this conversation open/);
  });

  run("a delayed incoming J1 close cannot end a conversation after newer user speech", async ({ agent, hooks, calls }, brain) => {
    await agent.submitText("Moo");
    const conversationId = agent.getState().conversationId!;
    const entered = deferred<void>();
    const decision = deferred<RouteDecision>();
    hooks.route = async () => { entered.resolve(); return decision.promise; };
    const closing = agent.submitText("That's all.");
    await entered.promise;
    const continuation = segment("later-speech", "Actually, keep going and explain the units.", 1, "later-turn");
    await agent.ingest(continuation);
    decision.resolve({ route: "end_agent", confidence: .97, substantiveContentProbability: .02 });
    await closing;
    assert.equal(agent.getState().conversationId, conversationId);
    hooks.route = async () => ({ route: "continue_agent", confidence: .96 });
    await agent.settleTurn(continuation.turnId);
    await agent.drain();
    assert.equal(agent.getState().conversationId, conversationId);
    assert.equal(calls.responses.length, 1);
    assert.ok(calls.responses[0]!.some(message => message.content === continuation.text));
    const retained = transcriptText((await brain.getRecord(conversationId))!);
    assert.match(retained, /That's all/);
    assert.match(retained, /Actually, keep going/);
  });

  run(
    "cancel pending work closes safely and a late answer cannot append",
    async ({ agent, hooks, calls }, brain) => {
      const entered = deferred<void>();
      const reply = deferred<AgentReply>();
      hooks.respond = async () => {
        entered.resolve();
        return reply.promise;
      };
      await agent.submitText("Moo, explain this.");
      await entered.promise;
      const id = agent.getState().conversationId!;
      await agent.requestEnd();
      assert.equal(agent.getState().pendingOffer?.kind, "end_work");
      assert.match(calls.speech.at(-1)!, /finish.*cancel.*open/);
      await agent.resolveEnd("cancel");
      reply.resolve({ text: "Late cancelled answer", toolCalls: [] });
      await agent.drain();
      assert.equal(agent.getState().conversationId, undefined);
      assert.doesNotMatch(
        transcriptText((await brain.getRecord(id))!),
        /Late cancelled answer/,
      );
    },
  );

  run(
    "an older acceptance conflict completes when a newer revision is already accepted",
    async ({ agent, options }, brain) => {
      let offline = true;
      options.acceptance = {
        accept: async (record) => {
          if (offline) throw new Error("Offline");
          const current = (await brain.getRecord(record.id))!;
          await brain.updateRecord(current.id, current.revision, {
            acceptedRevision: current.revision,
          });
          throw new Error("Backend 409: A newer revision was already accepted");
        },
      };
      await agent.submitText("Original thought");
      await agent.drain();
      const session = (await brain.listRecords()).find(
        (record) => record.kind === "session",
      )!;
      await brain.upsertSegment(
        session.id,
        segment("new-source", "Later content", 1, "later-turn"),
      );
      offline = false;
      await agent.retryPending(session.id);
      await agent.drain();
      const operations = (await brain.listOperations()).filter(
        (op) => op.kind === "accept" && op.recordId === session.id,
      );
      assert.ok(operations.length > 0);
      assert.ok(operations.every((op) => op.status === "done"));
    },
  );

  run(
    "backend retries reuse the original immutable acceptance snapshot",
    async ({ agent, options }, brain) => {
      const calls: { id: string; record: BrainRecord }[] = [];
      let fail = true;
      options.acceptance = {
        accept: async (record, id) => {
          calls.push({ id, record: structuredClone(record) });
          if (fail) throw new Error("Offline");
          return { revision: record.revision };
        },
      };
      await agent.submitText("First original thought");
      await agent.drain();
      const session = (await brain.listRecords()).find(
        (r) => r.kind === "session",
      )!;
      const original = calls.find((call) => call.record.id === session.id)!;
      await brain.upsertSegment(
        session.id,
        segment("later", "Newer content", 1, "later-turn"),
      );
      fail = false;
      await agent.retryPending();
      await agent.drain();
      const sameOperation = calls.filter((call) => call.id === original.id);
      assert.equal(sameOperation.length, 2);
      assert.deepEqual(sameOperation[1]?.record, original.record);
      assert.doesNotMatch(
        transcriptText(sameOperation[1]!.record),
        /Newer content/,
      );
    },
  );
}

test("SQLite restart preserves source for all seven J1 outcomes despite downstream provider failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolai-route-matrix-"));
  let brain = new SQLiteBrain(directory);
  let closed = false;
  const expected: { sessionId: string; source: string; route: string }[] = [];
  try {
    for (const [index, route] of (
      ["start_agent", "end_agent", "dictate", "no_action", "unclear", "offer_help", "continue_agent"] as const
    ).entries()) {
      const f = fixture(brain);
      // Unique IDs across independent sessions sharing this durable database.
      let sequence = 0;
      f.options.id = () => `matrix-${index}-${++sequence}`;
      f.hooks.route = async () => ({ route, confidence: 1 });
      f.hooks.summarize = async () => {
        throw new Error("Summary provider offline");
      };
      f.hooks.respond = async () => {
        throw new Error("Agent provider offline");
      };
      if (route === "end_agent") {
        f.hooks.route = async () => ({ route: "start_agent", confidence: 1 });
        await f.agent.submitText("Moo");
        f.hooks.route = async () => ({ route, confidence: 1 });
      }
      const source =
        route === "end_agent"
          ? "Moo, end conversation"
          : `Retain matrix source for ${route}`;
      await f.agent.submitText(source);
      await f.agent.drain();
      expected.push({
        sessionId: f.agent.getState().sessionId!,
        source,
        route,
      });
    }
    await brain.close();
    closed = true;
    brain = new SQLiteBrain(directory);
    closed = false;
    for (const item of expected) {
      const record = await brain.getRecord(item.sessionId);
      assert.ok(record, item.route);
      assert.ok(
        record!.segments.some(
          (s) => s.speaker === "user" && s.text === item.source,
        ),
        item.route,
      );
    }
    const failed = (await brain.listOperations()).filter(
      (op) => op.status === "failed",
    );
    assert.ok(failed.some((op) => op.kind === "enrich"));
  } finally {
    if (!closed) await brain.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const adapter of ["memory", "sqlite"] as const) {
  test(`${adapter}: failed J1 work retries after restart without duplicating handled notes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "moolai-route-retry-"));
    let brain: BrainPort = adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
    let closed = false;
    try {
      const original = fixture(brain);
      await original.agent.initialize();
      original.hooks.route = async () => { throw new Error("Jev temporarily unavailable"); };
      await assert.rejects(original.agent.submitText("Keep my thought about orchids."), /Jev temporarily unavailable/);
      await original.agent.drain();
      const failed = (await brain.listOperations()).find(operation => operation.kind === "route")!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.attempts, 1);
      assert.ok(failed.turnId);
      if (adapter === "sqlite") {
        await brain.close(); closed = true;
        brain = new SQLiteBrain(directory); closed = false;
      }
      const restarted = fixture(brain);
      let nextId = 0;
      restarted.options.id = () => `restart-${++nextId}`;
      await restarted.agent.initialize();
      await restarted.agent.retryPending();
      await restarted.agent.drain();
      const route = (await brain.listOperations()).find(operation => operation.id === failed.id)!;
      assert.equal(route.status, "done");
      assert.equal(route.attempts, 2);
      assert.equal(restarted.agent.getState().lastError, undefined);
      assert.equal((await brain.listRecords()).filter(record => record.kind === "dictation").length, 1);
      await restarted.agent.retryPending();
      await restarted.agent.settleTurn(failed.turnId!);
      await restarted.agent.drain();
      assert.equal(restarted.calls.routes.length, 1);
      assert.equal((await brain.listRecords()).filter(record => record.kind === "dictation").length, 1);
      assert.match(transcriptText((await brain.getRecord(failed.recordId))!), /Keep my thought about orchids/);
    } finally {
      if (!closed) await brain.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${adapter}: retry supersedes a failed route with the corrected transcript identity`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "moolai-route-revision-"));
    const brain: BrainPort = adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(directory);
    try {
      const f = fixture(brain);
      await f.agent.initialize();
      f.hooks.route = async () => { throw new Error("Offline"); };
      await f.agent.ingest(segment("correctable", "Wrong transcription.", 1, "correctable-turn"));
      await assert.rejects(f.agent.settleTurn("correctable-turn"), /Offline/);
      await f.agent.drain();
      const old = (await brain.listOperations()).find(operation => operation.kind === "route")!;
      await f.agent.ingest(segment("correctable", "Corrected orchid thought.", 2, "correctable-turn"));
      f.hooks.route = async () => ({ route: "dictate", confidence: 1 });
      await f.agent.retryPending();
      await f.agent.drain();
      const routes = (await brain.listOperations()).filter(operation => operation.kind === "route");
      assert.equal(routes.length, 2);
      assert.ok(routes.every(operation => operation.status === "done"));
      assert.match(routes.find(operation => operation.id === old.id)!.error ?? "", /Superseded/);
      const notes = (await brain.listRecords()).filter(record => record.kind === "dictation");
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.segments[0]?.text, "Corrected orchid thought.");
    } finally {
      await brain.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
