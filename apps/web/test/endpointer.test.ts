import test from "node:test";
import assert from "node:assert/strict";
import { Endpointer, WEB_ENDPOINTER, type EndpointerConfig, type EndpointerEvent } from "../src/voice/endpointer.js";

// Synthetic envelopes at 16 kHz, as in scripts/voice-endpoint-fixtures.mjs: alternating polarity keeps the RMS exact.
const tone = (ms: number, amplitude = 0.1) => Float32Array.from({ length: ms * 16 }, (_, i) => (i % 2 ? -amplitude : amplitude));
const quiet = (ms: number) => new Float32Array(ms * 16);
/** Syllables: 180 ms of sound and a 20 ms dip. Speech has gaps; a constant tone held 1.5 s is the room's floor. */
const speech = (ms: number, amplitude = 0.1) => tone(ms, amplitude).map((sample, i) => (i % 3200 < 2880 ? sample : 0));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
type Step = Float32Array | { gap: number } | { held: Float32Array };
/** Runs push, held push and gap steps in chunks of the given sizes; events carry the samples given by the end of the chunk that fired them. */
function run(steps: Step[], { sizes = [Infinity], config = WEB_ENDPOINTER, commit = false }: { sizes?: number[]; config?: Readonly<EndpointerConfig>; commit?: boolean } = {}) {
  const events: (EndpointerEvent & { at: number })[] = [];
  let at = 0, chunk = 0;
  const endpointer = new Endpointer(config, event => events.push({ ...event, at }));
  for (const step of steps) {
    const audio = step instanceof Float32Array ? step : "held" in step ? step.held : undefined;
    const length = audio ? audio.length : "gap" in step ? step.gap : 0;
    for (let offset = 0; offset < length;) {
      const size = Math.min(sizes[chunk++ % sizes.length]!, length - offset);
      at += size;
      if (audio) endpointer.push(audio.subarray(offset, offset + size), "held" in step);
      else endpointer.gap(size);
      offset += size;
    }
  }
  if (commit) endpointer.commit();
  const utterances = events.flatMap(event => (event.type === "utterance" ? [event] : []));
  return { events, utterances, endpointer, onsets: events.filter(event => event.type === "onset") };
}

test("an onset needs 120 ms at the onset level; clicks, broken runs and soft sounds open nothing", () => {
  const { onsets } = run([quiet(200), tone(500)], { sizes: [320] });
  assert.deepEqual(onsets.map(event => event.at), [(200 + 120) * 16], "The sixth loud 20 ms frame opens the utterance");
  for (const steps of [[tone(100), quiet(1500)], [tone(100), quiet(20), tone(100), quiet(1500)], [tone(2000, 0.011), quiet(1500)], [tone(20, 0.5), quiet(1500)]])
    assert.deepEqual(run(steps).events, []);
});

test("300 ms of pre-roll counts back from the first loud frame, and 1000 ms of silence ends the utterance", () => {
  const { utterances } = run([quiet(1000), tone(400), quiet(1500)], { sizes: [320] });
  assert.equal(utterances.length, 1);
  const [utterance] = utterances;
  assert.equal(utterance!.trigger, "pause");
  assert.equal(utterance!.continues, false);
  assert.equal(utterance!.voicedMs, 400);
  assert.equal(utterance!.samples.length, (300 + 400 + 1000) * 16);
  assert.equal(utterance!.samples[300 * 16 - 1], 0);
  assert.equal(utterance!.samples[300 * 16], Math.fround(0.1));
  assert.equal(utterance!.at, (1000 + 400 + 1000) * 16);
  assert.deepEqual(run([quiet(1000), tone(400), quiet(980)]).utterances, [], "980 ms of silence is not yet an endpoint");
  const atStart = run([tone(400), quiet(1000)]).utterances[0]!;
  assert.deepEqual(atStart.samples, join(tone(400), quiet(1000)), "With no history yet, the utterance starts at the first sample");
});

test("frames between the continuation and onset levels keep an utterance open", () => {
  const soft = run([quiet(1500), tone(200), tone(1000, 0.009), quiet(1100)]);
  assert.deepEqual(soft.utterances.map(u => [u.voicedMs, u.samples.length]), [[1200, (300 + 200 + 1000 + 1000) * 16]]);
  const tooSoft = run([quiet(1500), tone(200), tone(1000, 0.005), quiet(1100)]);
  assert.deepEqual(tooSoft.utterances.map(u => [u.voicedMs, u.samples.length]), [[200, (300 + 200 + 1000) * 16]]);
  assert.equal(tooSoft.onsets.length, 1);
});

test("speech with no pause is split at 30 s and continued, and every sample reaches recognition once", () => {
  const talk = speech(31_000);
  const { utterances, events } = run([talk], { commit: true });
  assert.deepEqual(events.map(event => event.type === "onset" ? "onset" : `${event.trigger}:${event.continues}`), ["onset", "limit:true", "commit:false"]);
  assert.equal(utterances[0]!.samples.length, 30 * 16000);
  assert.deepEqual(utterances.map(u => u.voicedMs), [27_000, 900]);
  assert.deepEqual(join(...utterances.map(u => u.samples)), talk);
});

test("reading aloud ends at a sentence gap once the utterance is long, and the next sentence opens its own (MOO-074)", () => {
  // 320 ms gaps: an utterance ending at a 300 ms gap leaves too little quiet for the desktop's 350 ms re-arm.
  const parts: Float32Array[] = [];
  for (let i = 0; i < 8; i++) parts.push(tone(800), quiet(320));
  parts.push(tone(800), quiet(1100));
  const reading = join(...parts);
  const { utterances, onsets } = run([reading], { config: { ...WEB_ENDPOINTER, maxUtteranceMs: 4000 } });
  assert.equal(utterances.length, 3);
  assert.equal(onsets.length, utterances.length);
  assert.ok(utterances[0]!.samples.length >= 0.75 * 4 * 16000, "Sentence gaps do not end a short utterance");
  assert.ok(utterances.every(u => u.trigger === "pause" && u.samples.length <= 4 * 16000));
  const heard = join(...utterances.map(u => u.samples));
  assert.deepEqual(heard, reading.subarray(0, heard.length), "Each next utterance's pre-roll starts where the last one ended");
  assert.equal(heard.length, reading.length - 800 * 16, "The last sentence is kept, with its 300 ms sentence gap");
});

test("the noise floor adapts: a steady hum opens at most one utterance, and speech over it ends when the speech does", () => {
  // Until 1.5 s has been heard the floor is zero, so a hum present from the start opens one utterance, which ends once
  // the floor has caught up. A hum that starts mid-capture does the same: a known energy-detector limit, now bounded.
  const { utterances, onsets } = run([tone(4000, 0.02), tone(600, 0.1), tone(2500, 0.02)]);
  assert.equal(onsets.length, 2);
  assert.ok(utterances[0]!.voicedMs <= 1500, `${utterances[0]!.voicedMs} ms`);
  assert.deepEqual(utterances.slice(1).map(u => [u.trigger, u.voicedMs, u.samples.length]), [["pause", 600, (300 + 600 + 1000) * 16]]);
  const fan = run([quiet(2000), tone(6000, 0.02)]);
  assert.equal(fan.onsets.length, 1);
  assert.equal(fan.utterances.length, 1);
  assert.ok(fan.utterances[0]!.voicedMs <= 1500, `${fan.utterances[0]!.voicedMs} ms`);
});

test("a gap is heard as silence and leaves the noise floor alone", () => {
  // Were the gap's zeros counted, the floor would drop and the hum after it would open an utterance.
  const hum = run([tone(3000, 0.02), { gap: 2000 * 16 }, tone(3000, 0.02)], { sizes: [320] });
  assert.equal(hum.utterances.length, 1);
  assert.ok(hum.onsets.every(event => event.at < 3000 * 16));
  const { utterances } = run([tone(500), { gap: 1200 * 16 }]);
  assert.deepEqual(utterances.map(u => [u.trigger, u.voicedMs]), [["pause", 500]]);
  assert.ok(utterances[0]!.samples.subarray(500 * 16).every(sample => sample === 0));
  assert.deepEqual(run([quiet(500), tone(80), { gap: 60 * 16 }, tone(80), quiet(1500)]).events, [], "A run cannot straddle a gap");
});

test("a run already loud at the first frame after a gap opens nothing, and the next onset needs the usual pause", () => {
  // Its start was under Moo's voice, so never heard. 340 ms of quiet is not yet the 350 ms re-arm.
  const straddle = run([quiet(1000), { gap: 500 * 16 }, tone(900), quiet(340), tone(400), quiet(400), tone(500), quiet(1100)], { sizes: [320] });
  assert.equal(straddle.onsets.length, 1);
  assert.deepEqual(straddle.utterances.map(u => u.samples), [join(quiet(300), tone(500), quiet(1000))]);
  const later = run([quiet(1000), { gap: 500 * 16 }, quiet(20), tone(400), quiet(1100)]);
  assert.deepEqual(later.utterances.map(u => u.voicedMs), [400], "A run that starts a frame later is an onset");
  const echo = run([quiet(1000), { gap: 500 * 16 }, tone(100), quiet(60), tone(400), quiet(1100)]);
  assert.deepEqual(echo.utterances.map(u => u.voicedMs), [400], "A run after the gap shorter than an onset leaves it armed");
  const held = run([quiet(1000), { gap: 500 * 16 }, { held: join(tone(200), quiet(100)) }, quiet(200), tone(400), quiet(1100)]);
  assert.deepEqual(held.events, [], "Its disarm doesn't wait for the hold to end: a phrase 300 ms after a run over within it opens nothing");
});

test("held audio reaches the pre-roll, and its onset waits for the first frame pushed without the hold", () => {
  const { onsets, utterances } = run([quiet(1000), { held: join(quiet(100), tone(200)) }, tone(400), quiet(1100)], { sizes: [320] });
  assert.deepEqual(onsets.map(event => event.at), [(1000 + 300 + 20) * 16]);
  assert.deepEqual(utterances.map(u => u.voicedMs), [600]);
  assert.deepEqual(utterances[0]!.samples, join(quiet(300), tone(600), quiet(1000)), "300 ms before the run's first frame, though the run outgrew 120 ms");
  // A short "Moo" and a pause: the onset is latched, and fires though its run is over.
  const over = run([quiet(1000), { held: join(tone(200), quiet(100)) }, quiet(1500)], { sizes: [320] });
  assert.deepEqual(over.onsets.map(event => event.at), [(1000 + 300 + 20) * 16], "A run over within the hold opens at the first frame after it");
  assert.deepEqual(over.utterances.map(u => [u.voicedMs, u.samples]), [[200, join(quiet(300), tone(200), quiet(120 + 1000))]]);
  assert.deepEqual(run([quiet(1000), { held: join(tone(100), quiet(200)) }, quiet(1500)]).events, [], "A run shorter than an onset still opens nothing");
  assert.deepEqual(run([quiet(1000), { held: join(tone(200), quiet(50)) }, { gap: 500 * 16 }, quiet(1500)]).events, [], "Moo audible again drops it");
});

test("chunk size and gap splitting never change an event", () => {
  const steps: Step[] = [quiet(300), tone(700), quiet(1200), tone(60), quiet(500), speech(2500, 0.05), tone(800, 0.009),
    { gap: 333 * 16 + 7 }, quiet(1500), tone(400), tone(30, 0.3), quiet(200), tone(500), quiet(1100), { gap: 200 * 16 + 5 },
    tone(300), quiet(500), { held: join(quiet(70), tone(250)) }, tone(300), quiet(1100)];
  const whole = run(steps, { commit: true });
  assert.equal(whole.utterances.length, 4);
  const strip = (events: typeof whole.events) => events.map(({ at: _at, ...event }) => event);
  for (const sizes of [[320], [1, 79, 257, 1019], [128], [960, 3]])
    assert.deepEqual(strip(run(steps, { sizes, commit: true }).events), strip(whole.events), `${sizes.join("/")}-sample chunks`);
});

test("commit keeps the final short frame and re-arms at once; discard drops everything", () => {
  const { utterances, endpointer, events } = run([tone(400), tone(1, 0.2)], { commit: true });
  assert.deepEqual(utterances.map(u => [u.trigger, u.continues, u.samples.length]), [["commit", false, 400 * 16 + 16]]);
  assert.equal(endpointer.open, false);
  endpointer.push(tone(120));
  assert.equal(endpointer.open, true, "Speech right after a commit opens a new utterance");
  assert.equal(events.length, 3);
  const dropped: EndpointerEvent[] = [];
  const discarded = new Endpointer(WEB_ENDPOINTER, event => dropped.push(event));
  discarded.push(tone(400));
  assert.equal(discarded.voicedMs, 400);
  discarded.discard();
  discarded.commit();
  assert.deepEqual(dropped.map(event => event.type), ["onset"]);
  assert.equal(discarded.open, false);
  const latched = run([quiet(1000), { held: tone(200) }], { commit: true });
  latched.endpointer.push(quiet(400));
  assert.deepEqual(latched.events, [], "Commit drops a latched onset, with no utterance open");
});

test("non-finite input is silence and cannot poison the noise floor", () => {
  const broken = quiet(20);
  broken[100] = NaN;
  const { events, endpointer } = run([quiet(1500), broken, tone(600), quiet(1100)]);
  assert.deepEqual(events.map(event => event.type), ["onset", "utterance"]);
  assert.ok(Number.isFinite(endpointer.rms));
});
