// Energy endpointing over 16 kHz mono, not a speech classifier. Analysis frames never depend on how audio
// arrives, so chunk size cannot change which audio reaches recognition. The onset is the desktop's rule
// (native/VoiceActivity.swift) over an adaptive floor; the pause, limit and sentence-gap rules are those of
// scripts/pcm-endpointer.mjs. Past three quarters of the limit a sentence gap ends the utterance; at the
// limit it is emitted as it stands and the next frame continues it, so speech is split and never dropped.
// Half-duplex adds two rules: a run already loud when a gap ends opens nothing, and held audio's onset waits.
const RATE = 16000;
const FRAME_MS = 20;
const FRAME = RATE * FRAME_MS / 1000;
const LONG_UTTERANCE_SHARE = 0.75;
const SENTENCE_GAP_MS = 300;

export interface EndpointerConfig {
  /** An onset is `onsetMs` of frames at or above max(onsetRms, onsetFloorRatio × noise floor), re-armed after `rearmMs` below it. */
  onsetRms: number;
  onsetFloorRatio: number;
  onsetMs: number;
  rearmMs: number;
  /** An open utterance keeps frames at or above max(continueRms, continueFloorRatio × noise floor) as voiced, so in a
   * room whose floor is above continueRms an utterance still ends instead of running to the limit. */
  continueRms: number;
  continueFloorRatio: number;
  endSilenceMs: number;
  /** Counted back from the first frame of the onset run. */
  preRollMs: number;
  maxUtteranceMs: number;
  /** The noise floor is the quietest frame heard in this window: speech has gaps, a steady fan or hum does not.
   * It is zero until a full window has been heard, so speech at the first sample is not mistaken for the room. */
  floorWindowMs: number;
}
export const WEB_ENDPOINTER: Readonly<EndpointerConfig> = {
  onsetRms: 0.012, onsetFloorRatio: 3, onsetMs: 120, rearmMs: 350,
  continueRms: 0.008, continueFloorRatio: 2, endSilenceMs: 1000,
  preRollMs: 300, maxUtteranceMs: 30_000, floorWindowMs: 1500,
};

export type EndpointerEvent =
  | { type: "onset" }
  | { type: "utterance"; samples: Float32Array; voicedMs: number; trigger: "pause" | "limit" | "commit"; continues: boolean };

export class Endpointer {
  private frame = new Float32Array(FRAME);
  private filled = 0;
  private frameMuted = false;
  private frameHeld = false;
  private history: Float32Array[] = [];
  private readonly historyFrames: number;
  private readonly levels: Float32Array;
  private levelCount = 0;
  private levelAt = 0;
  private loud = 0;
  private quiet = 0;
  private armed = true;
  // Whether the last frame was a gap, and whether the loud run under way was already loud right after one.
  private lastGapped = false;
  private unheard = false;
  // A heard run that reached onsetMs while held: ms from its first frame on, and its loud ms once it is over.
  private latched = 0;
  private latchedLoud = 0;
  private chunks?: Float32Array[];
  private length = 0;
  private voiced = 0;
  private silence = 0;
  private level = 0;
  constructor(private readonly config: Readonly<EndpointerConfig>, private readonly onEvent: (event: EndpointerEvent) => void) {
    this.historyFrames = Math.ceil((config.preRollMs + config.onsetMs) / FRAME_MS);
    this.levels = new Float32Array(Math.max(1, Math.round(config.floorWindowMs / FRAME_MS)));
  }
  get open() { return this.chunks !== undefined; }
  /** Voiced audio in the open utterance, from its onset run on. */
  get voicedMs() { return this.chunks ? this.voiced : 0; }
  /** RMS of the latest frame. */
  get rms() { return this.level; }
  /** `holdOnset`: Moo's tail in the room. The audio is heard and reaches the pre-roll, but an onset in it waits for the
   * first frame pushed without it. */
  push(samples: Float32Array, holdOnset = false) { this.take(samples, samples.length, holdOnset); }
  /** Time that passed without usable input (Moo was audible): heard as silence and kept out of the noise floor. */
  gap(count: number) { this.take(undefined, Math.max(0, Math.floor(count)), false); }
  /** Ends the open utterance now, with its final short frame. */
  commit() {
    if (this.chunks) {
      if (this.filled) {
        const tail = this.frame.slice(0, this.filled);
        if (this.frameMuted) tail.fill(0);
        this.chunks.push(tail);
        this.length += tail.length;
      }
      this.emit("commit");
    }
    this.filled = 0; this.frameMuted = false; this.frameHeld = false;
    this.rearm();
  }
  discard() {
    this.chunks = undefined; this.length = 0; this.voiced = 0; this.silence = 0;
    this.filled = 0; this.frameMuted = false; this.frameHeld = false; this.history = [];
    this.rearm();
  }

  private take(samples: Float32Array | undefined, count: number, hold: boolean) {
    for (let offset = 0; offset < count;) {
      const size = Math.min(count - offset, FRAME - this.filled);
      if (samples) this.frame.set(samples.subarray(offset, offset + size), this.filled);
      else { this.frame.fill(0, this.filled, this.filled + size); this.frameMuted = true; }
      if (hold) this.frameHeld = true;
      this.filled += size; offset += size;
      if (this.filled < FRAME) continue;
      const frame = this.frame, muted = this.frameMuted, held = this.frameHeld;
      this.frame = new Float32Array(FRAME); this.filled = 0; this.frameMuted = false; this.frameHeld = false;
      this.analyse(frame, muted, held);
    }
  }
  private analyse(frame: Float32Array, gapped: boolean, held: boolean) {
    let rms = 0, muted = gapped;
    if (!muted) {
      let sum = 0;
      for (const sample of frame) sum += sample * sample;
      rms = Math.sqrt(sum / frame.length);
      if (!Number.isFinite(rms)) { muted = true; rms = 0; }
    }
    if (muted) frame.fill(0);
    else {
      this.levels[this.levelAt] = rms;
      this.levelAt = (this.levelAt + 1) % this.levels.length;
      this.levelCount = Math.min(this.levelCount + 1, this.levels.length);
    }
    this.level = rms;
    const floor = this.floor(), c = this.config;
    let onset = false;
    if (this.latched) this.latched += FRAME_MS;
    if (rms >= Math.max(c.onsetRms, c.onsetFloorRatio * floor)) {
      // Already loud at the first frame after a gap, a run began while Moo was audible and its start was never heard:
      // it opens nothing, and the next onset needs the usual pause. A heard onset in held audio is latched: it fires at
      // the first frame after the hold even if its run is over by then, so a short "Moo" and a pause keep the "Moo".
      if (!this.loud) this.unheard = this.lastGapped;
      this.loud += FRAME_MS; this.quiet = 0;
      if (this.armed && this.loud >= c.onsetMs) {
        if (this.unheard || !held) { this.armed = false; onset = !this.unheard; }
        else if (!this.latched && !this.chunks) this.latched = this.loud;
      }
    } else {
      if (this.latched && !this.latchedLoud) this.latchedLoud = this.loud;
      this.loud = 0; this.quiet += FRAME_MS;
      if (this.quiet >= c.rearmMs) this.armed = true;
    }
    this.lastGapped = gapped;
    // The first frame pushed without the hold fires a latched onset, loud or not; Moo audible again drops it.
    if (gapped) { this.latched = 0; this.latchedLoud = 0; }
    else if (this.latched && !held) { this.armed = false; onset = true; }
    if (!this.chunks) {
      // A held onset's run outgrows onsetMs or is over, and its pre-roll still counts back from the run's first frame.
      const needed = Math.ceil(((this.latched || this.loud) + c.preRollMs) / FRAME_MS);
      this.history.push(frame);
      if (this.history.length > Math.max(this.historyFrames, this.armed || onset ? needed : 0)) this.history.shift();
      if (!onset) return;
      const keep = Math.min(this.history.length, needed);
      this.chunks = this.history.slice(this.history.length - keep);
      this.history = [];
      this.length = keep * FRAME; this.voiced = this.latchedLoud || this.loud; this.silence = 0;
      this.latched = 0; this.latchedLoud = 0;
      this.onEvent({ type: "onset" });
      return;
    }
    this.chunks.push(frame);
    this.length += FRAME;
    if (rms >= Math.max(c.continueRms, c.continueFloorRatio * floor)) { this.voiced += FRAME_MS; this.silence = 0; }
    else this.silence += FRAME_MS;
    const limit = c.maxUtteranceMs * RATE / 1000;
    const endMs = this.length >= limit * LONG_UTTERANCE_SHARE ? Math.min(SENTENCE_GAP_MS, c.endSilenceMs) : c.endSilenceMs;
    if (this.silence >= endMs) this.emit("pause");
    else if (this.length + FRAME > limit) this.emit("limit");
  }
  private floor() {
    if (this.levelCount < this.levels.length) return 0;
    let min = Infinity;
    for (const level of this.levels) min = Math.min(min, level);
    return min;
  }
  // An utterance boundary re-arms onsets: a long reading can end at a 300 ms sentence gap, and the next
  // sentence must still open its own utterance.
  private rearm() { this.loud = 0; this.quiet = 0; this.armed = true; this.latched = 0; this.latchedLoud = 0; }
  private emit(trigger: "pause" | "limit" | "commit") {
    const chunks = this.chunks ?? [], samples = new Float32Array(this.length);
    let at = 0;
    for (const chunk of chunks) { samples.set(chunk, at); at += chunk.length; }
    const event = { type: "utterance" as const, samples, voicedMs: this.voiced, trigger, continues: trigger === "limit" };
    this.chunks = trigger === "limit" ? [] : undefined;
    this.length = 0; this.voiced = 0; this.silence = 0;
    if (trigger !== "limit") this.rearm();
    this.onEvent(event);
  }
}
