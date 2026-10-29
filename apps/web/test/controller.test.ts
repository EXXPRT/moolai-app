import test from "node:test";
import assert from "node:assert/strict";
import type { Segment } from "../../../packages/contracts/src/index.js";
import { createWebSpeech } from "../src/speech.js";
import type { VoiceControllerOptions, VoiceSink } from "../src/types.js";
import { createVoiceController } from "../src/voice/controller.js";

const tone = (ms: number, amplitude = 0.1) => Float32Array.from({ length: ms * 16 }, (_, i) => (i % 2 ? -amplitude : amplitude));
const quiet = (ms: number) => new Float32Array(ms * 16);
/** Below the onset and continuation levels: the room, or what echo cancellation leaves of Moo's voice. */
const room = (ms: number) => tone(ms, 0.004);
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
/** The samples of a WAV the controller sent, and samples as encodeWav writes them. */
const pcm16 = (wav: Uint8Array) => { const view = new DataView(wav.buffer, wav.byteOffset + 44); return Int16Array.from({ length: view.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true)); };
const int16 = (samples: Float32Array) => Int16Array.from(samples, sample => Math.round(sample * 32767));
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
  const speechGate = { audible: false, quietSince: -Infinity, heldPaused: false, busy: false };
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
    get time() { return time; },
    at(ms: number) { time = ms; },
    feed(samples: Float32Array, sampleRate = 16000) { controller.accept(samples, sampleRate); },
    /** As the microphone delivers it: 20 ms chunks, each at its own clock time. */
    stream(samples: Float32Array) { for (let at = 0; at < samples.length; at += 320, time += 20) controller.accept(samples.subarray(at, at + 320), 16000); },
  };
}
/** Moo speaks while `heard` comes in, then stops. */
function mooSpeaks(h: ReturnType<typeof harness>, heard: Float32Array) {
  h.speechGate.audible = true;
  h.stream(heard);
  h.speechGate.audible = false;
  h.speechGate.quietSince = h.time;
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
  // An echo of the prompt gets one hint-free transcription, which here hears nothing usable.
  const outcomes: [string, (request: Request) => void, ((request: Request) => void)?][] = [
    ["empty", request => request.resolve("   ")],
    ["the wake word echoed", request => request.resolve("Moo."), request => request.resolve("   ")],
    ["the context echoed", request => request.resolve("Moo. Osmosis."), request => request.resolve("...")],
    ["an echo whose hint-free retry loops", request => request.resolve("Moo."), request => request.resolve("Thank you. ".repeat(12))],
    ["an echo whose hint-free retry fails", request => request.resolve("Moo."), request => request.reject(new Error("Backend 502"))],
    ["repetitive output", request => request.resolve("Thank you. ".repeat(12))],
    ["a failed request", request => request.reject(new Error("Backend 503: voice_unavailable"))],
  ];
  for (const [name, answer, retry] of outcomes) {
    for (const ms of [800, 400]) {
      const h = harness();
      h.feed(said(ms));
      await settle();
      answer(h.requests[0]!);
      await settle();
      assert.equal(h.requests.length, retry ? 2 : 1, name);
      if (retry) {
        assert.equal(h.requests[1]!.prompt, "", `${name}: the retry has no hint`);
        retry(h.requests[1]!);
        await settle();
      }
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

test("a bare wake word is kept when a hint-free transcription hears speech, and an echoed sentence becomes its own words", async () => {
  // 29 Oct: "Moo" alone was always dropped as an echo of the prompt, so Moo could not be called by voice.
  const wake = harness();
  wake.feed(said(400));
  await settle();
  wake.requests[0]!.resolve("Moo.");
  await settle();
  wake.requests[1]!.resolve("Mu.");
  await settle();
  assert.deepEqual(wake.log, ["hold", 'final id2 r1 "Moo."', "settle id2"], "The hinted spelling is kept");
  const sentence = harness();
  sentence.feed(said(800));
  await settle();
  sentence.requests[0]!.resolve("Moo. Osmosis.");
  await settle();
  sentence.requests[1]!.resolve(" Osmosis needs a membrane. ");
  await settle();
  assert.deepEqual(sentence.log, ["hold", 'preview id2 r1 "…"', 'final id2 r2 "Osmosis needs a membrane."', "settle id2"]);
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

test("half-duplex: input is silence while Moo is audible, and an onset in the 300 ms after it stops waits for their end", async () => {
  const h = harness();
  h.speechGate.audible = true;
  h.feed(said(500));
  h.speechGate.audible = false;
  h.speechGate.quietSince = 1000;
  h.at(1200);
  h.feed(join(quiet(20), tone(500)));
  assert.deepEqual(h.log, [], "Heard, but held while Moo's voice may still ring in the room");
  h.at(1300);
  h.feed(said(500));
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"'], "The held onset opens at the first frame after the tail");
  assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(300), tone(1000), quiet(1000))), "Its pre-roll counts back from the run's first frame");
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

test("a reply begun in the 300 ms after Moo stops keeps its start, and opens once they are over", async () => {
  // 29 Oct: those 300 ms were silence, so "Moo, what do my notes say…" said at once lost its "Moo,". Moo stops at 1000 ms;
  // the reply's first 20 ms are soft, as speech's attack is (loud from its very first frame, see the next test).
  // [delay, where the upload starts, when the utterance opens, where it ends], in ms.
  for (const [delay, from, opens, to] of [[0, 720, 1300, 2820], [100, 820, 1300, 2920], [150, 860, 1300, 2980], [300, 1020, 1420, 3120]] as const) {
    const h = harness();
    mooSpeaks(h, room(1000));
    const reply = join(room(delay), tone(20, 0.006), tone(800), quiet(1100));
    h.stream(reply.subarray(0, (opens - 1000) * 16));
    assert.deepEqual(h.log, [], `${delay} ms: nothing opens before ${opens} ms`);
    h.stream(reply.subarray((opens - 1000) * 16));
    await settle();
    assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"'], `${delay} ms`);
    // Moo's own time is silence; from its stop on, every sample is as heard, from 300 ms before the reply's first loud frame.
    assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(1000), reply).subarray(from * 16, to * 16)), `${delay} ms`);
  }
});

test("a short wake word in the 300 ms after Moo stops, then a pause, keeps the whole wake word", async () => {
  // 29 Oct: its onset fired only if it was still loud when the 300 ms ended, so "Moo." and a pause lost the "Moo.".
  for (const [word, pause] of [[160, 300], [200, 200]] as const) {
    for (const delay of [20, 60, 100, 140]) {
      const h = harness();
      mooSpeaks(h, room(1000));
      const reply = join(room(delay), tone(word, 0.05), room(pause), tone(800), quiet(1100));
      h.stream(reply);
      await settle();
      const name = `"Moo" ${word} ms, ${pause} ms pause, ${delay} ms after Moo stops`;
      assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"'], name);
      // From 300 ms before the wake word's first frame to the question's endpoint.
      assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(1000), reply).subarray((700 + delay) * 16, (1000 + delay + word + pause + 1800) * 16)), name);
    }
  }
});

test("speech already under way when Moo stops opens nothing until a pause, and the next phrase is its own utterance", async () => {
  // 29 Oct: the rest of a sentence begun over Moo was sent as a turn of its own, saved as a fragment or answered.
  const h = harness();
  mooSpeaks(h, join(room(500), tone(500)));
  h.stream(join(tone(900), quiet(400), tone(800), quiet(1100)));
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"']);
  assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(300), tone(800), quiet(1000))), "Only the phrase after the pause");
  // Loud from the very first frame after Moo stops, a reply can't be told from speech begun under Moo's voice.
  const prompt = harness();
  mooSpeaks(prompt, room(1000));
  prompt.stream(said(800));
  await settle();
  assert.deepEqual(prompt.log, []);
  assert.equal(prompt.requests.length, 0);
});

test("speech begun over Moo is dropped when Moo stops mid-word, and its next words are a fragment when Moo stops in or near a pause", async () => {
  // A stop between words can't be told from a new reply by energy alone.
  // [ms into a 180 ms syllable when Moo stops at 1000 ms (180: its 20 ms dip), where the fragment's upload starts or null].
  for (const [phase, from] of [[0, null], [20, null], [40, null], [60, null], [80, 820], [100, 800], [120, 780], [140, 760], [160, 740], [180, 720]] as const) {
    const h = harness();
    const heard = join(quiet(600 - phase), speech(2000), quiet(1500));
    mooSpeaks(h, heard.subarray(0, 1000 * 16));
    h.stream(heard.subarray(1000 * 16));
    await settle();
    assert.deepEqual(h.log, from === null ? [] : ["hold", 'preview id2 r1 "…"'], `${phase} ms`);
    // A fragment starts 300 ms before the first syllable begun after Moo stops, and ends 1000 ms after the speech.
    if (from !== null) assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(1000), heard.subarray(1000 * 16)).subarray(from * 16, (3580 - phase) * 16)), `${phase} ms`);
  }
});

test("an echo of Moo shorter than an onset, right as it stops, doesn't keep a reply 150 ms later from opening", async () => {
  const h = harness();
  mooSpeaks(h, room(1000));
  const after = join(tone(80, 0.05), room(70), tone(800), quiet(1100));
  h.stream(after);
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"']);
  assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(1000), after).subarray(840 * 16, 2960 * 16)));
});

test("Stop speech stops Moo as a line's end does: a reply 100 ms after it keeps its start", async () => {
  // The real speech port, on an element that plays at once.
  const audio = { src: "", currentTime: 0, paused: true, ended: false, play: async () => {}, pause() {}, load() {}, addEventListener() {}, removeEventListener() {} };
  let h: ReturnType<typeof harness> | undefined;
  const speech = createWebSpeech({ audio, synthesize: async () => new Blob(), urls: { create: () => "blob:line", revoke() {} }, clock: () => h!.time });
  h = harness({ speech });
  speech.speak("Osmosis moves water toward the side with more solute.").catch(() => {});
  await settle();
  assert.equal(speech.audible, true);
  h.stream(room(1000));
  await speech.stop();
  assert.equal(speech.quietSince, 1000);
  const reply = join(room(100), tone(20, 0.006), tone(800), quiet(1100));
  h.stream(reply);
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"']);
  assert.deepEqual(pcm16(h.requests[0]!.wav), int16(join(quiet(1000), reply).subarray(820 * 16, 2920 * 16)));
});

test("the latest level reaches the debug overlay about every 100 ms, and is never an onset", async () => {
  // The host's idle auto-off restarts its wait only on an onset.
  const h = harness();
  h.stream(room(1000));
  assert.equal(h.activity.length, 9, "At 100, 200, … 900 ms");
  assert.ok(h.activity.every(report => report.onset === undefined && report.pending === 0 && Math.abs(report.rms! - 0.004) < 1e-6));
  h.speechGate.audible = true;
  h.stream(room(200));
  assert.equal(h.activity.length, 11);
  assert.equal(h.activity.at(-1)!.rms, 0, "Moo's own voice is heard as silence");
});

test("one transcription in flight and two queued; the next is rejected without a request", async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) { h.feed(said(400)); await settle(); }
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.errors, [{ stage: "transcribe", message: "Error: Speech recognition is behind. Please say that again." }]);
  for (let i = 0; i < 3; i++) { h.requests[i]!.resolve(`Line ${i + 1}.`); await settle(); }
  assert.equal(h.requests.length, 3);
  // The fourth was refused unheard, so no words can come from it: id6's turn keeps its own release.
  assert.deepEqual(h.log, ["hold", "hold", "hold", "hold",
    'final id2 r1 "Line 1."', "settle id2", "hold", 'final id4 r1 "Line 2."', "settle id4", "hold",
    'final id6 r1 "Line 3."', "settle id6", "rejected"]);
});

test("a cough after an utterance, over before its turn settles, doesn't take the hold again, so its offer stands", async () => {
  const h = harness();
  h.feed(said(800)); // id2: a stated doubt, still being transcribed
  await settle();
  h.feed(said(160)); // id4: a cough, over and refused without a request
  await settle();
  assert.deepEqual(h.log, ["hold", 'preview id2 r1 "…"', "hold"]);
  assert.equal(h.requests.length, 1, "The cough is never sent");
  h.requests[0]!.resolve("I don't get how to find V2.");
  await settle();
  // Taking the hold again here would make id2's routing see new speech and drop Moo's offer to help.
  assert.deepEqual(h.log.slice(3), ['final id2 r2 "I don\'t get how to find V2."', "settle id2", "rejected"]);
  const queued = harness();
  queued.feed(said(800)); // id2
  await settle();
  queued.feed(said(400)); // id4: real words, waiting for their transcription
  await settle();
  queued.requests[0]!.resolve("I don't get how to find V2.");
  await settle();
  assert.deepEqual(queued.log.slice(3), ['final id2 r2 "I don\'t get how to find V2."', "settle id2", "hold"], "Words still to come keep Moo waiting");
});

test("half-duplex also ignores input while a line of Moo's is still downloading", async () => {
  const h = harness();
  h.speechGate.busy = true;
  h.feed(said(500));
  await settle();
  assert.deepEqual(h.log, [], "A sound before the line is audible would otherwise cut it, with nothing held to resume");
  h.speechGate.busy = false;
  h.feed(join(quiet(100), said(500)));
  await settle();
  assert.deepEqual(h.log, ["hold"], "Speech begun after the line opens as usual");
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
