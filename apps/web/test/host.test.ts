import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBrain } from "../../../packages/brain/src/memory.js";
import { FixtureProviders } from "../../../packages/agent-host/src/providers.js";
import type { AgentEvent, VisionProvider } from "../../../packages/contracts/src/index.js";
import { createWebHost } from "../src/host.js";
import type { VoiceController, VoiceControllerOptions, VoiceRuntime, VoiceStatus, WebSpeechPort } from "../src/types.js";

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const OFF: VoiceStatus = { enabled: false, requestedOn: false, listening: false, speaking: false, phase: "off", error: null };
const WORKSHEET = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** The speech port as the host sees it; the test decides when Moo is audible. */
class FakeSpeech implements WebSpeechPort {
  audible = false;
  quietSince = -Infinity;
  heldPaused = false;
  closed = false;
  readonly spoken: string[] = [];
  private readonly listeners = new Set<(audible: boolean) => void>();
  constructor(private readonly log: string[]) {}
  async speak(text: string) { this.spoken.push(text); }
  async stop() { this.log.push("speech stop"); this.setAudible(false); }
  async resume() { this.log.push("speech resume"); }
  pause() { return false; }
  onAudibleChange(listener: (audible: boolean) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { this.closed = true; this.log.push("speech close"); }
  setAudible(audible: boolean) {
    if (audible === this.audible) return;
    this.audible = audible;
    for (const listener of this.listeners) listener(audible);
  }
}

class FakeController implements VoiceController {
  utteranceOpen = false;
  pending = 0;
  accepted = 0;
  /** finish() waits for this. */
  hold?: Promise<void>;
  constructor(readonly options: VoiceControllerOptions, private readonly log: string[]) {}
  accept() { this.accepted++; }
  async finish() { this.log.push("finish"); await this.hold; this.utteranceOpen = false; }
  async discard() { this.log.push("discard"); }
}

async function rig(options: { voice?: false; idleMicOffMs?: number; open?: () => Promise<void> } = {}) {
  const log: string[] = [], events: AgentEvent[] = [], controllers: FakeController[] = [];
  const brain = new MemoryBrain(), providers = new FixtureProviders(), speech = new FakeSpeech(log);
  let feed: ((samples: Float32Array, sampleRate: number) => void) | undefined, worksheets = 0, n = 0;
  const runtime: VoiceRuntime = {
    async open(onSamples) {
      log.push("open");
      await options.open?.();
      feed = onSamples;
      return { sampleRate: 48000, stop() { log.push("mic stop"); } };
    },
    createController(controllerOptions) {
      const controller = new FakeController(controllerOptions, log);
      controllers.push(controller);
      return controller;
    },
    transcribe: async () => "",
  };
  const host = await createWebHost({
    brain, providers, speech, emit: event => { events.push(event); },
    worksheet: async () => ({ mimeType: "image/png", bytes: WORKSHEET }), onWorksheet: () => { worksheets++; },
    voice: options.voice === false ? undefined : runtime, idleMicOffMs: options.idleMicOffMs,
    id: () => `id-${++n}`, now: () => "2026-10-29T10:00:00.000Z", timeZone: "UTC",
  });
  return {
    host, brain, providers, speech, runtime, log, events, controllers,
    get worksheets() { return worksheets; },
    statuses: () => events.filter(event => event.type === "voice").map(event => event.voice as unknown as VoiceStatus),
    notices: () => events.filter(event => event.type === "notice").map(event => event.message!),
    feed() { feed?.(new Float32Array(960), 48000); },
    async close() { await host.close(); await host.agent.drain(); await brain.close(); },
  };
}

/** Console errors the host logs on purpose, kept out of the test output. */
async function quietly<T>(work: () => Promise<T>) {
  const log = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = log; }
}

test("voice start opens a study session, reports connecting then listening, and feeds the controller", async () => {
  const r = await rig();
  try {
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    await r.host.voice("start");
    assert.equal(r.host.agent.getState().listening, true, "Voice start begins a study session");
    assert.deepEqual(r.statuses(), [
      { ...OFF, enabled: true, requestedOn: true, phase: "connecting_asr" },
      { ...OFF, enabled: true, requestedOn: true, listening: true, phase: "listening" },
    ]);
    assert.deepEqual(r.host.nativeSnapshot(), r.statuses().at(-1));
    const [controller] = r.controllers;
    assert.equal(controller!.options.sink, r.host.agent, "Voice turns go straight to the Agent");
    assert.equal(controller!.options.transcribe, r.runtime.transcribe);
    assert.equal(controller!.options.speech, r.speech, "Half-duplex reads the real playback state");
    assert.match(controller!.options.id(), /^id-\d+$/);
    assert.equal(controller!.options.now(), "2026-10-29T10:00:00.000Z");
    r.feed(); r.feed();
    assert.equal(controller!.accepted, 2);
    await r.host.voice("start");
    assert.equal(r.controllers.length, 1, "A second start while on changes nothing");
    assert.deepEqual(r.log, ["open"]);
  } finally { await r.close(); }
});

test("speaking follows the speech port, merged into the whole status", async () => {
  const r = await rig();
  try {
    await r.host.voice("start");
    r.speech.setAudible(true);
    assert.deepEqual(r.statuses().at(-1), { ...OFF, enabled: true, requestedOn: true, listening: true, phase: "listening", speaking: true });
    r.speech.setAudible(false);
    assert.equal(r.host.nativeSnapshot().speaking, false);
    assert.equal(r.host.nativeSnapshot().listening, true);
  } finally { await r.close(); }
});

test("Moo speaks only while the microphone is on", async () => {
  const r = await rig();
  try {
    await r.host.agent.startSession();
    await r.host.agent.submitText("Moo, explain osmosis.");
    await r.host.agent.drain();
    assert.ok(r.events.some(event => event.record?.segments.some(segment => segment.speaker === "assistant")), "Typed requests are answered on screen");
    assert.deepEqual(r.speech.spoken, [], "Typing alone means a silent Moo");
    await r.host.agent.speechStarted({ paused: true });
    await r.host.agent.recognitionRejected();
    await r.host.agent.stopSpeech();
    assert.deepEqual([...r.log], [], "Nor does the Agent stop or resume speech that cannot be playing");
    await r.host.voice("start");
    await r.host.agent.submitText("Moo, explain diffusion.");
    await r.host.agent.drain();
    assert.ok(r.speech.spoken.length > 0, "With the microphone on, the answer is spoken");
    await r.host.agent.speechStarted({ paused: true });
    await r.host.agent.recognitionRejected();
    assert.ok(r.log.includes("speech resume"), "A held reading resumes through the port");
  } finally { await r.close(); }
});

test("voice stop quiets Moo, stops the tracks, finishes the last words, reports off, and never checkpoints", async () => {
  const r = await rig();
  try {
    let checkpoints = 0;
    r.host.agent.checkpointConversation = async () => { checkpoints++; };
    await r.host.voice("start");
    await r.host.agent.submitText("Moo, explain osmosis.");
    await r.host.agent.drain();
    const conversation = r.host.agent.getState().conversationId;
    assert.ok(conversation);
    const [controller] = r.controllers;
    let release!: () => void;
    controller!.hold = new Promise<void>(resolve => { release = resolve; });
    controller!.utteranceOpen = true;
    r.speech.setAudible(true);
    r.log.length = 0;
    const stopping = r.host.voice("stop");
    await settle();
    assert.deepEqual(r.log, ["mic stop", "speech stop", "finish"]);
    assert.equal(r.host.nativeSnapshot().phase, "finishing_transcription");
    assert.equal(r.host.nativeSnapshot().listening, false);
    r.feed();
    assert.equal(controller!.accepted, 0, "No new audio reaches a finishing controller");
    release();
    await stopping;
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    assert.deepEqual(r.statuses().at(-1), OFF);
    assert.equal(checkpoints, 0, "Only the bridge's /api/voice stop checkpoints");
    assert.equal(r.host.agent.getState().conversationId, conversation, "The conversation stays open");
    assert.equal(r.host.agent.getState().listening, true, "The study session stays on");
  } finally { await r.close(); }
});

test("flush finishes the open utterance and keeps listening", async () => {
  const r = await rig();
  try {
    await r.host.voice("start");
    await r.host.voice("flush");
    assert.deepEqual(r.log, ["open", "finish"]);
    assert.equal(r.host.nativeSnapshot().phase, "listening");
    r.feed();
    assert.equal(r.controllers[0]!.accepted, 1);
  } finally { await r.close(); }
});

test("a stop during startup leaves no microphone open", async () => {
  let opened!: () => void;
  const r = await rig({ open: () => new Promise<void>(resolve => { opened = resolve; }) });
  try {
    const starting = r.host.voice("start");
    await settle();
    await r.host.voice("stop");
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    opened();
    await starting;
    assert.deepEqual(r.log, ["open", "speech stop", "mic stop"], "The late microphone is closed as soon as it opens");
    assert.equal(r.controllers.length, 0);
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
  } finally { await r.close(); }
});

test("a start clicked while a stop finishes waits for it, and a stop clicked after that start wins", async () => {
  const r = await rig();
  try {
    const holdFinish = (controller: FakeController) => {
      let release!: () => void;
      controller.hold = new Promise<void>(resolve => { release = resolve; });
      controller.utteranceOpen = true;
      return () => release();
    };
    await r.host.voice("start");
    let release = holdFinish(r.controllers[0]!);
    const stopping = r.host.voice("stop"), restarting = r.host.voice("start");
    await settle();
    assert.equal(r.controllers.length, 1, "The start waits for the last words");
    release();
    await Promise.all([stopping, restarting]);
    assert.equal(r.controllers.length, 2);
    assert.equal(r.host.nativeSnapshot().phase, "listening");
    release = holdFinish(r.controllers[1]!);
    const requests = [r.host.voice("stop"), r.host.voice("start"), r.host.voice("stop")];
    await settle();
    release();
    await Promise.all(requests);
    assert.equal(r.controllers.length, 2, "The start between two stops never opens the microphone");
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
  } finally { await r.close(); }
});

test("a microphone that cannot open reports the error and a readable message, and a later start works", async () => {
  let refuse = true;
  const r = await rig({ open: async () => { if (refuse) throw new DOMException("Permission denied", "NotAllowedError"); } });
  try {
    await assert.rejects(r.host.voice("start"),
      /^Error: The microphone could not connect\. Check its permission and connection, then try again\.$/);
    assert.deepEqual(r.statuses().at(-1), { ...OFF, phase: "error", error: "NotAllowedError: Permission denied" });
    assert.equal(r.host.nativeSnapshot().enabled, false);
    refuse = false;
    await r.host.voice("start");
    assert.deepEqual(r.host.nativeSnapshot(), { ...OFF, enabled: true, requestedOn: true, listening: true, phase: "listening" });
  } finally { await r.close(); }
});

test("without a voice runtime, voice start says to type instead", async () => {
  const r = await rig({ voice: false });
  try {
    await assert.rejects(r.host.voice("start"), /^Error: Voice is not available in fixture mode\. Type instead\.$/);
    assert.deepEqual(r.statuses(), []);
    await r.host.voice("stop");
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
  } finally { await r.close(); }
});

test("a demo limit stops voice once and keeps it off", async () => {
  const r = await rig();
  try {
    await r.host.voice("start");
    r.log.length = 0;
    r.host.onLimit("budget_exhausted");
    r.host.onLimit("budget_exhausted");
    r.host.onLimit("session_expired");
    await settle();
    assert.deepEqual(r.log, ["mic stop", "speech stop", "finish"]);
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    await assert.rejects(r.host.voice("start"), /Voice is off for the rest of this demo session/);
    assert.equal(r.controllers.length, 1);
    // A transcription the limit refused adds no notice of its own: the page's lasting banner explains it.
    await quietly(async () => r.controllers[0]!.options.onError("transcribe", new Error("Transcription failed: HTTP 401 session_expired")));
    assert.deepEqual(r.notices(), []);
  } finally { await r.close(); }
});

test("a voice turn that fails is shown as a readable notice", async () => {
  const r = await rig();
  try {
    await r.host.voice("start");
    const { onError } = r.controllers[0]!.options;
    await quietly(async () => {
      onError("transcribe", new Error("Transcription failed: HTTP 502 provider_failed"));
      onError("save", new Error("Concurrent record update; retry needed"));
      onError("route", new Error("Backend 500: Model provider unavailable"));
    });
    assert.deepEqual(r.notices(), ["Moo couldn't transcribe what you just said. Please say it again.",
      "Moo couldn't save what you just said. Please say it again.",
      "Moo saved what you said but couldn't act on it. Try saying it again in a moment."]);
  } finally { await r.close(); }
});

test("the microphone turns itself off after the idle time without an onset, never while Moo speaks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = await rig({ idleMicOffMs: 1000 });
  try {
    await r.host.voice("start");
    t.mock.timers.tick(999); await settle();
    r.controllers[0]!.options.onActivity!({ onset: true, pending: 0 });
    t.mock.timers.tick(999); await settle();
    assert.equal(r.host.nativeSnapshot().phase, "listening", "An onset restarts the wait");
    r.controllers[0]!.options.onActivity!({ pending: 1 });
    r.speech.setAudible(true);
    t.mock.timers.tick(5000); await settle();
    assert.equal(r.host.nativeSnapshot().phase, "listening", "Moo's own speech is not the visitor's silence");
    r.speech.setAudible(false);
    t.mock.timers.tick(999); await settle();
    assert.equal(r.host.nativeSnapshot().phase, "listening", "The wait starts again once Moo is quiet");
    t.mock.timers.tick(1); await settle();
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    assert.deepEqual(r.notices(), ["The microphone turned off after a few minutes without speech. Turn it on to continue."]);
    assert.equal(r.log.filter(entry => entry === "finish").length, 1);
  } finally { t.mock.timers.reset(); await r.close(); }
});

test("hiding the tab turns the microphone off", async () => {
  const listeners = new Map<string, () => void>();
  const page = {
    hidden: false,
    addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
    removeEventListener(type: string, listener: () => void) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const scope = globalThis as { document?: unknown };
  scope.document = page;
  try {
    const r = await rig();
    try {
      await r.host.voice("start");
      listeners.get("visibilitychange")!();
      await settle();
      assert.equal(r.host.nativeSnapshot().phase, "listening");
      page.hidden = true;
      listeners.get("visibilitychange")!();
      await settle();
      assert.deepEqual(r.host.nativeSnapshot(), OFF);
      assert.deepEqual(r.notices(), ["The microphone turned off while this tab was in the background. Turn it on to continue."]);
    } finally { await r.close(); }
    assert.equal(listeners.size, 0, "Close removes the listener");
  } finally { delete scope.document; }
});

test("close stops the tracks before anything awaits, drops pending work, and closes speech", async () => {
  const r = await rig();
  try {
    await r.host.voice("start");
    r.controllers[0]!.utteranceOpen = true;
    r.log.length = 0;
    const closing = r.host.close();
    assert.deepEqual(r.log, ["mic stop", "speech close", "discard"], "All of it before the first await");
    await closing;
    assert.ok(!r.log.includes("finish"), "Nothing is drained");
    assert.equal(r.speech.closed, true);
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    r.feed();
    assert.equal(r.controllers[0]!.accepted, 0);
    await assert.rejects(r.host.voice("start"), /Host closed/);
    await r.host.close();
  } finally { await r.close(); }
});

test("a close while the last words finish drops them and stops the microphone only once", async () => {
  const r = await rig();
  try {
    await r.host.voice("start");
    const [controller] = r.controllers;
    controller!.utteranceOpen = true;
    controller!.hold = new Promise<void>(() => {});
    const stopping = r.host.voice("stop");
    await settle();
    assert.equal(r.host.nativeSnapshot().phase, "finishing_transcription");
    await r.host.close();
    assert.deepEqual(r.log, ["open", "mic stop", "speech stop", "finish", "speech close", "discard"]);
    assert.deepEqual(r.host.nativeSnapshot(), OFF);
    void stopping;
  } finally { await r.close(); }
});

test("screen help reads the sample worksheet and opens its drawer", async () => {
  const r = await rig();
  try {
    const images: string[] = [];
    const interpret = r.providers.interpret.bind(r.providers);
    (r.providers as VisionProvider).interpret = async image => { images.push(`${image.mimeType}:${image.dataBase64}`); return interpret(); };
    await r.host.agent.startSession();
    await r.host.agent.submitText("I'm not sure why V2 is half of V1 on this worksheet.");
    await r.host.agent.drain();
    assert.equal(r.host.agent.getState().pendingOffer?.kind, "help");
    assert.equal(r.worksheets, 0, "Nothing is shown before the visitor accepts");
    await r.host.agent.submitText("Yes please");
    await r.host.agent.drain();
    assert.equal(r.worksheets, 1);
    assert.deepEqual(images, [`image/png:${Buffer.from(WORKSHEET).toString("base64")}`]);
  } finally { await r.close(); }
});
