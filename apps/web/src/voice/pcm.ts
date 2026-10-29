// In-memory PCM helpers for browser voice. Nothing here records to disk or imports Node.
export const SPEECH_RATE = 16000;
// Below the 8 kHz Nyquist of the output, with room for the filter's transition band.
const CUTOFF_HZ = 7000;

/** Mono samples at any rate to 16 kHz. State carries across chunks, so chunking never changes the output. */
export class Downsampler {
  private readonly taps: Float64Array;
  private readonly ring: Float64Array;
  private at = 0;
  private consumed = 0;
  private produced = 0;
  private previous = 0;
  constructor(readonly inputRate: number) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 384000)
      throw new RangeError(`Unsupported microphone sample rate: ${inputRate}`);
    this.taps = inputRate > SPEECH_RATE ? lowPass(inputRate) : new Float64Array(0);
    this.ring = new Float64Array(this.taps.length * 2);
  }
  process(input: Float32Array): Float32Array {
    if (this.inputRate === SPEECH_RATE) return Float32Array.from(input, sample => (Number.isFinite(sample) ? sample : 0));
    const out = new Float32Array(Math.ceil(input.length * SPEECH_RATE / this.inputRate) + 1);
    const { taps, ring, inputRate } = this, size = taps.length;
    let count = 0;
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]!;
      let value = Number.isFinite(sample) ? sample : 0;
      if (size) {
        // Each sample is written twice, so the newest `size` samples are always contiguous.
        ring[this.at] = ring[this.at + size] = value;
        this.at = (this.at + 1) % size;
        value = 0;
        for (let m = 0; m < size; m++) value += taps[m]! * ring[this.at + m]!;
      }
      const index = this.consumed++;
      // Output k sits at input position k × inputRate / 16000, between samples index − 1 and index.
      while (index > 0 && this.produced * inputRate < index * SPEECH_RATE) {
        const fraction = (this.produced * inputRate - (index - 1) * SPEECH_RATE) / SPEECH_RATE;
        out[count++] = this.previous + (value - this.previous) * fraction;
        this.produced++;
      }
      this.previous = value;
    }
    return out.subarray(0, count);
  }
}

/** Hamming-windowed sinc; the length scales with the ratio so the transition stays about 3 kHz wide. */
function lowPass(rate: number) {
  const size = 2 * Math.round(8 * rate / SPEECH_RATE) + 1, middle = (size - 1) / 2, cutoff = CUTOFF_HZ / rate;
  const taps = new Float64Array(size);
  let sum = 0;
  for (let m = 0; m < size; m++) {
    const t = m - middle;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    sum += taps[m] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * m / (size - 1)));
  }
  return taps.map(tap => tap / sum);
}

/** RIFF WAVE, PCM format 1, mono, 16 kHz, 16-bit, as the gateway's transcription route expects. */
export function encodeWav(samples16k: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples16k.length * 2), view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples16k.length * 2, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_RATE, true); view.setUint32(28, SPEECH_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples16k.length * 2, true);
  for (let i = 0; i < samples16k.length; i++) {
    const sample = samples16k[i]!;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample || 0;
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

// Copied from scripts/whisper-bridge.mjs, which can't be bundled.
// Reject obvious repeated-output failures. This is not a confidence or semantic score.
export function repetitiveOutput(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 12) return false;
  for (let width = 1; width <= 6; width++) {
    let run = width;
    for (let i = width; i < words.length; i++) {
      run = words[i] === words[i - width] ? run + 1 : width;
      if (run >= Math.max(12, width * 6) && run >= words.length * 0.5) return true;
    }
  }
  return false;
}

// On a cough or click the recognizer can print its own hint: the wake word and context phrases, in any
// order or repeated. Any other word means real speech.
export function hintEcho(text: string, initialPrompt = "", context = ""): boolean {
  const wordsOf = (value: string): string[] => value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const heard = wordsOf(text);
  const phrases = [initialPrompt, ...context.split(/(?<=[.!?…])\s+/u)].map(wordsOf).filter(phrase => phrase.length).sort((a, b) => b.length - a.length);
  if (!heard.length || !phrases.length) return false;
  for (let i = 0; i < heard.length;) {
    const phrase = phrases.find(words => words.every((word, j) => heard[i + j] === word));
    if (!phrase) return false;
    i += phrase.length;
  }
  return true;
}
