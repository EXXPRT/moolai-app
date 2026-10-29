import test from "node:test";
import assert from "node:assert/strict";
import { Downsampler, encodeWav, hintEcho, repetitiveOutput } from "../src/voice/pcm.js";

const sine = (seconds: number, rate: number, hz: number, amplitude = 0.5) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
const noise = (length: number) => {
  let seed = 7;
  return Float32Array.from({ length }, () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 1073741824 - 1);
};
const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
const chunked = (rate: number, input: Float32Array, sizes: number[]) => {
  const downsampler = new Downsampler(rate), parts: Float32Array[] = [];
  for (let offset = 0, i = 0; offset < input.length; i++) {
    const size = sizes[i % sizes.length]!;
    parts.push(downsampler.process(input.subarray(offset, offset + size)));
    offset += size;
  }
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

test("one second at any microphone rate becomes one second at 16 kHz", () => {
  for (const rate of [8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000]) {
    const out = new Downsampler(rate).process(new Float32Array(rate));
    assert.equal(out.length, rate === 16000 ? 16000 : Math.ceil((rate - 1) * 16000 / rate), `${rate} Hz`);
    assert.ok(Math.abs(out.length - 16000) <= 2, `${rate} Hz`);
  }
});

test("chunk boundaries never change the downsampled audio", () => {
  for (const rate of [8000, 16000, 22050, 44100, 48000]) {
    const input = noise(Math.round(rate * 0.3));
    const whole = chunked(rate, input, [input.length]);
    for (const sizes of [[128], [1, 7, 333], [960, 1, 2048, 5]])
      assert.deepEqual(chunked(rate, input, sizes), whole, `${rate} Hz in ${sizes.join("/")}-sample chunks`);
  }
});

test("speech frequencies pass and frequencies above 8 kHz are filtered, not folded into the speech band", () => {
  for (const rate of [44100, 48000]) {
    const voice = new Downsampler(rate).process(sine(1, rate, 1000)).subarray(200);
    assert.ok(Math.abs(rms(voice) - 0.5 / Math.SQRT2) < 0.01, `1 kHz at ${rate} Hz: ${rms(voice)}`);
    const hiss = new Downsampler(rate).process(sine(1, rate, 11000)).subarray(200);
    assert.ok(rms(hiss) < 0.01, `11 kHz at ${rate} Hz would alias to ${16000 - 11000} Hz: ${rms(hiss)}`);
  }
});

test("non-finite input becomes silence and unsupported rates are refused", () => {
  assert.deepEqual([...new Downsampler(16000).process(Float32Array.from([NaN, 0.25, Infinity]))], [0, 0.25, 0]);
  assert.ok(new Downsampler(48000).process(Float32Array.from({ length: 4800 }, (_, i) => (i === 100 ? NaN : 0))).every(Number.isFinite));
  for (const rate of [0, 4000, NaN, Infinity, 500000]) assert.throws(() => new Downsampler(rate), RangeError);
});

test("the WAV is RIFF PCM format 1, mono, 16 kHz, 16-bit, with clamped samples", () => {
  const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2, NaN]));
  const view = new DataView(wav.buffer), text = (at: number, length: number) => String.fromCharCode(...wav.subarray(at, at + length));
  assert.equal(wav.length, 44 + 16);
  assert.equal(text(0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 16);
  assert.equal(text(8, 8), "WAVEfmt ");
  assert.deepEqual([view.getUint32(16, true), view.getUint16(20, true), view.getUint16(22, true)], [16, 1, 1]);
  assert.deepEqual([view.getUint32(24, true), view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)], [16000, 32000, 2, 16]);
  assert.equal(text(36, 4), "data");
  assert.equal(view.getUint32(40, true), 16);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true)), [0, 16384, -16383, 32767, -32767, 32767, -32767, 0]);
  assert.equal(encodeWav(new Float32Array(30 * 16000)).length, 960_044, "A 30 s utterance fits the gateway's 1.1 MB limit");
});

// The cases of scripts/whisper-bridge.test.mjs, which these copies must keep passing.
const titles = "Osmosis: definition, mechanism, and applications. Common exam question about minimum and maximum. Brain Replacement Contract. Pressure difference between Sample A and Sample B and exploratory discussion. Module Boundaries";
const topics = "Osmosis: definition, mechanism, and applications. Okay, can you tell me how this whole other cleaning process leads to. A web search brought back to me by Moo. I think the interesting thing. Wind-driven ocean currents, Coriolis effect, and gyres. Osmosis definition and water filtration use";
const correction = "rag, r a g, databases. Retrieval-augmented generation pipeline";

test("a hint echo holds only the wake word and context phrases; any other word is speech", () => {
  assert.equal(hintEcho(`Moo. ${topics}`, "Moo.", topics), true);
  assert.equal(hintEcho(`Moo. ${titles}.`, "Moo.", titles), true);
  assert.equal(hintEcho("Moo.", "Moo.", ""), true);
  assert.equal(hintEcho(`Moo. ${correction}.`, "Moo.", correction), true);
  assert.equal(hintEcho("Module Boundaries. Moo. Brain Replacement Contract. Module Boundaries.", "Moo.", titles), true);
  assert.equal(hintEcho("Moo. module boundaries.", "Moo.", titles), true);
  // Longest phrase first: a title can begin with another one.
  assert.equal(hintEcho("Moo. Osmosis definition and water filtration use. Osmosis.", "Moo.", "Osmosis. Osmosis definition and water filtration use"), true);
  assert.equal(hintEcho(`Moo. ${titles}. Please.`, "Moo.", titles), false);
  for (const context of ["", `Conveyor belt mechanics. Enzyme catalase. ${titles}`])
    for (const speech of ["Moo. Tell me more about the conveyor belt.", "Moo, continue explaining the conveyor belt.", "They spin the conveyor belt.",
      "Moo, search the web for how the enzyme catalase works.", "What does the second source say about the temperature?", "Um.", "Yes.", ""])
      assert.equal(hintEcho(speech, "Moo.", context), false, speech);
});

test("repeated output is flagged; ordinary repetition is not", () => {
  assert.equal(repetitiveOutput(`${"*shh* ".repeat(40)}The final word is telescope.`), true);
  assert.equal(repetitiveOutput("Thank you. ".repeat(12)), true);
  assert.equal(repetitiveOutput("I said Moo as an example. Moo, end conversation."), false);
  assert.equal(repetitiveOutput("Water moves across the membrane toward the side with more solute, so the water level there rises."), false);
});
