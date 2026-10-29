import test from "node:test";
import assert from "node:assert/strict";
import type { Segment } from "../../../packages/contracts/src/index.js";
import type { VoiceControllerOptions, VoiceSink } from "../src/types.js";
import { createVoiceController } from "../src/voice/controller.js";

const tone = (ms: number, amplitude = 0.1) => Float32Array.from({ length: ms * 16 }, (_, i) => (i % 2 ? -amplitude : amplitude));
const quiet = (ms: number) => new Float32Array(ms * 16);
/** Syllables: 180 ms of sound and a 20 ms dip, so long speech is not taken for the room's floor. */
const speech = (ms: number) => tone(ms).map((sample, i) => (i % 3200 < 2880 ? sample : 0));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
/** Sound, then enough silence for the 1000 ms endpoint. */
const said = (ms: number) => join(tone(ms), quiet(1100));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

interface Request { wav: Uint8Array; prompt: string; signal: AbortSignal; resolve(text: string): void; reject(error: unknown): void }
function harness(options: Partial<VoiceControllerOptions> = {}, hooks: {
  ingest?: (segment: Segment) => Promise<void>; settle?: (turnId: string) => Promise<void>; context?: () => Promise<string>;
} = {}) {
  const log: string[] = [], segments: Segment[] = [], requests: Request[] = [];
  const errors: { stage: string; message: string }[] = [], activity: { onset?: true; pending: number; rms?: number }[] = [];
  const speechGate = { audible: false, quietSince: -Infinity, heldPaused: false };
  let ids = 0, time = 0;
  const sink: VoiceSink = {
    async speechStarted(hold) { log.push(hold?.paused ? "hold paused" : "hold"); },
    async recognitionRejected() { log.push("rejected"); },
    async ingest(segment) {
      log.push(`${segment.final ? "final" : "preview"} ${segment.turnId} r${segment.revision} ${JSON.stringify(segment.text)}`);
      segments.push(segment);
      await hooks.ingest?.(segment);
    },
    async settleTurn(turnId) { log.push(`settle ${turnId}`); await hooks.settle?.(turnId); },
    recognitionContext: hooks.context ?? (async () => "Osmosis"),
  };
  const controller = createVoiceController({
    sink, speech: speechGate,
    transcribe: (wav, prompt, signal) => new Promise((resolve, reject) => requests.push({ wav, prompt, signal, resolve, reject })),
    id: () => `id${++ids}`,
    now: () => new Date(Date.UTC(2026, 9, 29, 9, 0, 0, ids)).toISOString(),
    clock: () => time,
    onError: (stage, error) => errors.push({ stage, message: String(error) }),
    onActivity: change => activity.push(change),
    ...options,
  });
  return {
    controller, log, segments, requests, errors, activity, speechGate,
    at(ms: number) { time = ms; },
    feed(samples: Float32Array, sampleRate = 16000) { controller.accept(samples, sampleRate); },
  };
}

test("an utterance is previewed, then its final replaces the preview and its turn settles", async () => {
  const h = harness();
  h.feed(said(800));
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"']);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.prompt, "Moo. Osmosis");
  assert.equal(h.requests[0]!.wav.length, 44 + (800 + 1000) * 32);
  h.requests[0]!.resolve(" Osmosis is water moving across a membrane. ");
  await settle();
  assert.deepEqual(h.log.slice(2), ['final id2 r2 "Osmosis is water moving across a membrane."', "settle id2"]);
  const [preview, final] = h.segments;
  assert.deepEqual(preview, { id: "id1", turnId: "id2", revision: 1, speaker: "user", text: "…", final: false, createdAt: "2026-10-29T09:00:00.002Z" });
  assert.deepEqual(final, { ...preview, revision: 2, text: "Osmosis is water moving across a membrane.", final: true });
  assert.equal(h.controller.pending, 0);
  assert.deepEqual(h.activity.map(({ onset, pending }) => ({ onset, pending })), [{ onset: true, pending: 0 }, { onset: undefined, pending: 1 }, { onset: undefined, pending: 0 }]);
  assert.ok(Math.abs(h.activity[0]!.rms! - 0.1) < 1e-6, "The onset reports its level for the debug overlay");
});

test("an utterance voiced under 600 ms has no preview, so its final is revision 1", async () => {
  const h = harness();
  h.feed(said(400));
  await settle();
  assert.deepEqual(h.log, ["hold"]);
  h.requests[0]!.resolve("Yes.");
  await settle();
  assert.deepEqual(h.log, ["hold", 'final id2 r1 "Yes."', "settle id2"]);
});

test("a rejection never settles a turn, and a preview already shown is replaced by an empty final", async () => {
  const outcomes: [string, (request: Request) => void][] = [
    ["empty", request => request.resolve("   ")],
    ["the wake word echoed", request => request.resolve("Moo.")],
    ["the context echoed", request => request.resolve("Moo. Osmosis.")],
    ["repetitive output", request => request.resolve("Thank you. ".repeat(12))],
    ["a failed request", request => request.reject(new Error("Backend 503: voice_unavailable"))],
  ];
  for (const [name, answer] of outcomes) {
    for (const ms of [800, 400]) {
      const h = harness();
      h.feed(said(ms));
      await settle();
      answer(h.requests[0]!);
      await settle();
      assert.deepEqual(h.log, ms === 800 ? ["hold", 'preview id2 r1 "…"', 'final id2 r2 ""', "rejected"] : ["hold", "rejected"], `${name}, ${ms} ms`);
      assert.deepEqual(h.errors, name === "a failed request" ? [{ stage: "transcribe", message: "Error: Backend 503: voice_unavailable" }] : [], name);
    }
  }
  const short = harness();
  short.feed(said(200));
  await settle();
  assert.equal(short.requests.length, 0, "Under 300 ms voiced is never sent");
  assert.deepEqual(short.log, ["hold", "rejected"]);
});

test("outcomes apply in utterance order when a later result is ready first, and each takes the hold for the speech after it", async () => {
  const h = harness();
  h.feed(said(800)); // id2: previewed; its transcription is held open
  await settle();
  h.feed(said(200)); // id4: too short, so rejected at once, yet it waits for id2
  await settle();
  h.feed(said(400)); // id6: queued behind id2
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"', "hold", "hold"]);
  assert.equal(h.requests.length, 1, "One transcription in flight");
  assert.equal(h.controller.pending, 3);
  h.requests[0]!.resolve("First.");
  await settle();
  assert.deepEqual(h.log.slice(4), ['final id2 r2 "First."', "settle id2", "hold", "rejected", "hold"]);
  assert.equal(h.requests.length, 2);
  h.requests[1]!.resolve("Third.");
  await settle();
  assert.deepEqual(h.log.slice(9), ['final id6 r1 "Third."', "settle id6"]);
  assert.equal(h.controller.pending, 0);
});

test("the hold-release race: an onset before settleTurn(N) takes the hold again right after the call", async () => {
  const routing = deferred();
  const h = harness({}, { settle: () => routing.promise });
  h.feed(said(400)); // id2 ended
  h.feed(tone(300)); // id4 is open before id2 is transcribed
  await settle();
  assert.deepEqual(h.log, ["hold", "hold"]);
  assert.equal(h.controller.utteranceOpen, true);
  h.speechGate.heldPaused = true;
  h.requests[0]!.resolve("Explain osmosis.");
  await settle();
  assert.deepEqual(h.log.slice(2), ['final id2 r1 "Explain osmosis."', "settle id2", "hold paused"], "Taken again while settleTurn(id2) still runs, keeping a held pause");
  routing.resolve();
  const alone = harness();
  alone.feed(said(400));
  await settle();
  alone.requests[0]!.resolve("Yes.");
  await settle();
  assert.deepEqual(alone.log, ["hold", 'final id2 r1 "Yes."', "settle id2"], "With no later speech the turn keeps its own release");
});

test("a 30 s limit split continues in a new utterance that holds Moo, and the split turn takes the hold again", async () => {
  const h = harness();
  h.feed(speech(30_400));
  await settle();
  assert.deepEqual(h.log, ["hold", "hold", 'preview id2 r1 "…"'], "The continuation holds at the split");
  assert.equal(h.requests[0]!.wav.length, 44 + 30 * 32000, "Within the gateway's 34 s and 1.1 MB");
  assert.equal(h.controller.utteranceOpen, true);
  h.requests[0]!.resolve("A long reading.");
  await settle();
  assert.deepEqual(h.log.slice(3), ['final id2 r2 "A long reading."', "settle id2", "hold"]);
  h.feed(quiet(1100));
  await settle();
  h.requests[1]!.resolve("Its end.");
  await settle();
  assert.deepEqual(h.log.slice(6), ['final id4 r1 "Its end."', "settle id4"]);
  assert.notEqual(h.segments.at(-1)!.createdAt, h.segments[0]!.createdAt);
});

test("half-duplex: input is ignored while Moo is audible and for 300 ms after it stops", async () => {
  const h = harness();
  h.speechGate.audible = true;
  h.feed(said(500));
  h.speechGate.audible = false;
  h.speechGate.quietSince = 1000;
  h.at(1200);
  h.feed(said(500));
  await settle();
  assert.deepEqual(h.log, []);
  h.at(1300);
  h.feed(tone(500));
  assert.deepEqual(h.log, ["hold"]);
  const overlap = harness();
  overlap.feed(tone(500));
  overlap.speechGate.audible = true;
  overlap.feed(tone(1200));
  await settle();
  assert.equal(overlap.requests.length, 1, "An utterance Moo talks over ends after a second of silence");
  const pcm = new DataView(overlap.requests[0]!.wav.buffer, 44);
  assert.equal(pcm.byteLength, 1500 * 32);
  assert.equal(pcm.getInt16(500 * 32 - 2, true), -3277);
  for (let at = 500 * 32; at < pcm.byteLength; at += 2) assert.equal(pcm.getInt16(at, true), 0);
});

test("one transcription in flight and two queued; the next is rejected without a request", async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) { h.feed(said(400)); await settle(); }
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.errors, [{ stage: "transcribe", message: "Error: Speech recognition is behind. Please say that again." }]);
  for (let i = 0; i < 3; i++) { h.requests[i]!.resolve(`Line ${i + 1}.`); await settle(); }
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.log, ["hold", "hold", "hold", "hold",
    'final id2 r1 "Line 1."', "settle id2", "hold", 'final id4 r1 "Line 2."', "settle id4", "hold",
    'final id6 r1 "Line 3."', "settle id6", "hold", "rejected"]);
});

test("a transcription past its timeout is aborted and its utterance rejected", async () => {
  const h = harness({ transcribeTimeoutMs: 30 });
  h.feed(said(400));
  await new Promise(resolve => setTimeout(resolve, 60));
  await settle();
  assert.equal(h.requests[0]!.signal.aborted, true);
  assert.deepEqual(h.log, ["hold", "rejected"]);
  assert.deepEqual(h.errors, [{ stage: "transcribe", message: "Error: Speech recognition timed out. Please say that again." }]);
  h.requests[0]!.resolve("Too late.");
  await settle();
  assert.deepEqual(h.log, ["hold", "rejected"]);
});

test("finish commits the open utterance and waits for its outcome; input meanwhile is ignored", async () => {
  const routing = deferred();
  const h = harness({}, { settle: () => routing.promise });
  h.feed(tone(800));
  let finished = false;
  const finishing = h.controller.finish().then(() => { finished = true; });
  assert.equal(h.controller.utteranceOpen, false);
  h.feed(said(500));
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.wav.length, 44 + 800 * 32);
  h.requests[0]!.resolve("Done.");
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"', 'final id2 r2 "Done."', "settle id2"]);
  assert.equal(finished, false, "Still routing");
  routing.resolve();
  await finishing;
  assert.equal(h.controller.pending, 0);
  h.feed(said(400));
  await settle();
  assert.equal(h.requests.length, 2, "The controller listens again after a flush");
  const bounded = harness();
  bounded.feed(tone(400));
  await bounded.controller.finish(20);
  assert.equal(bounded.controller.pending, 1, "A bounded finish returns with the outcome still pending");
});

test("discard drops the open utterance and pending work, and the sink hears nothing more", async () => {
  const h = harness();
  h.feed(said(400));
  h.feed(said(400));
  h.feed(tone(300));
  await settle();
  const before = [...h.log];
  await h.controller.discard();
  assert.equal(h.requests[0]!.signal.aborted, true);
  h.requests[0]!.resolve("Late.");
  h.feed(said(400));
  await h.controller.finish();
  await settle();
  assert.deepEqual(h.log, before);
  assert.deepEqual(h.errors, []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.controller.utteranceOpen, false);
});

test("a turn settles only once its final is saved", async () => {
  const saving = deferred();
  const h = harness({}, { ingest: () => saving.promise });
  h.feed(said(400));
  await settle();
  h.requests[0]!.resolve("Saved first.");
  await settle();
  assert.deepEqual(h.log, ["hold", 'final id2 r1 "Saved first."']);
  saving.resolve();
  await settle();
  assert.deepEqual(h.log.slice(2), ["settle id2"]);
});

test("a failed save or route is reported, and later utterances still go through", async () => {
  let failures = 2;
  const h = harness({}, {
    ingest: async () => { if (failures-- === 2) throw new Error("Brain write failed"); },
    settle: async () => { if (failures === 1) throw new Error("Route failed"); },
  });
  h.feed(said(400));
  await settle();
  h.requests[0]!.resolve("First.");
  await settle();
  h.feed(said(400));
  await settle();
  h.requests[1]!.resolve("Second.");
  await settle();
  assert.deepEqual(h.errors, [{ stage: "save", message: "Error: Brain write failed" }, { stage: "route", message: "Error: Route failed" }]);
  assert.deepEqual(h.log.filter(line => line.startsWith("settle")), ["settle id2", "settle id4"]);
});

test("the recognition prompt is 'Moo. ' and the context, cut to 400 characters without splitting a character", async () => {
  const cases: [string, string][] = [
    ["", "Moo."],
    ["Osmosis. Dilution", "Moo. Osmosis. Dilution"],
    ["a".repeat(500), `Moo. ${"a".repeat(395)}`],
    [`${"a".repeat(394)}😀 tail`, `Moo. ${"a".repeat(394)}`],
  ];
  for (const [context, prompt] of cases) {
    const h = harness({}, { context: async () => context });
    h.feed(said(400));
    await settle();
    assert.equal(h.requests[0]!.prompt, prompt);
  }
  const unavailable = harness({}, { context: async () => { throw new Error("No state"); } });
  unavailable.feed(said(400));
  await settle();
  assert.equal(unavailable.requests[0]!.prompt, "Moo.", "The words are still transcribed without the hint");
  assert.deepEqual(unavailable.errors, []);
});

test("native-rate input is downsampled to 16 kHz, and batch size never changes what is sent", async () => {
  const rate = 48000;
  const sine = Float32Array.from({ length: 800 * 48 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / rate));
  const input = join(sine, new Float32Array(1100 * 48));
  const whole = harness(), batched = harness();
  whole.feed(input, rate);
  for (let at = 0; at < input.length; at += 960) batched.feed(input.subarray(at, at + 960), rate);
  await settle();
  assert.deepEqual(whole.log, ["hold", 'preview id2 r1 "…"']);
  const sent = (whole.requests[0]!.wav.length - 44) / 2;
  assert.ok(Math.abs(sent - 1800 * 16) <= 320, `${sent} samples at 16 kHz, within a frame of the filter's tail`);
  assert.deepEqual(batched.requests[0]!.wav, whole.requests[0]!.wav);
});
