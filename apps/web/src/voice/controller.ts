import type { Segment } from "../../../../packages/contracts/src/index.js";
import { safeEnd } from "../../../../packages/contracts/src/records.js";
import type { VoiceController, VoiceControllerOptions } from "../types.js";
import { Endpointer, WEB_ENDPOINTER, type EndpointerEvent } from "./endpointer.js";
import { Downsampler, encodeWav, hintEcho, repetitiveOutput } from "./pcm.js";

const WAKE = "Moo.";
const PROMPT_LIMIT = 400;
const QUEUED_LIMIT = 2;
const TIMED_OUT = "Speech recognition timed out. Please say that again.";
const BEHIND = "Speech recognition is behind. Please say that again.";

/** One utterance, from its onset (or the limit split that continued it) to its outcome. */
interface Turn { seq: number; id: string; turnId: string; createdAt: string; previewed: boolean }
interface Job { wav: Uint8Array; resolve(text: string | null): void }

export function createVoiceController(options: VoiceControllerOptions): VoiceController {
  return new WebVoiceController(options);
}

/** One outcome per utterance, applied in utterance order: the Swift assembler's protocol
 * (native/TranscriptAssembler.swift) over NativeInput's ordered writes and turns (agent-host/src/native-input.ts). */
class WebVoiceController implements VoiceController {
  private readonly endpointer: Endpointer;
  private readonly clock: () => number;
  private downsampler?: Downsampler;
  private current?: Turn;
  private started = 0;
  private order: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private turns: Promise<void> = Promise.resolve();
  private waiting: Job[] = [];
  /** Utterances sent for transcription whose outcomes are not yet applied: words still to come. */
  private readonly queued = new Set<number>();
  private transcribing = 0;
  private readonly aborts = new Set<AbortController>();
  private outstanding = 0;
  private finishing = 0;
  private closed = false;
  constructor(private readonly p: VoiceControllerOptions) {
    this.clock = p.clock ?? (() => performance.now());
    this.endpointer = new Endpointer(WEB_ENDPOINTER, event => this.handle(event));
  }
  get utteranceOpen() { return this.endpointer.open; }
  get pending() { return this.outstanding; }

  accept(samples: Float32Array, sampleRate: number) {
    if (this.closed || this.finishing) return;
    const downsampler = this.downsampler?.inputRate === sampleRate ? this.downsampler : (this.downsampler = new Downsampler(sampleRate));
    const audio = downsampler.process(samples);
    // Half-duplex: Moo's own voice, a line of it still downloading, and its tail in the room are heard as silence.
    const speech = this.p.speech;
    if (speech.audible || speech.busy || this.clock() - speech.quietSince < (this.p.tailMs ?? 300)) this.endpointer.gap(audio.length);
    else this.endpointer.push(audio);
    const turn = this.current;
    if (turn && !turn.previewed && this.endpointer.voicedMs >= (this.p.previewMinVoicedMs ?? 600)) this.preview(turn);
  }

  async finish(timeoutMs?: number) {
    if (this.closed) return;
    this.finishing++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.endpointer.commit();
      const drained = this.drained();
      await (timeoutMs === undefined ? drained : Promise.race([drained, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]));
    } finally {
      clearTimeout(timer);
      this.finishing--;
    }
  }

  async discard() {
    if (this.closed) return;
    this.closed = true;
    this.endpointer.discard();
    this.current = undefined;
    for (const job of this.waiting.splice(0)) job.resolve(null);
    for (const abort of this.aborts) abort.abort(new Error("Voice capture closed"));
  }

  private handle(event: EndpointerEvent) {
    if (event.type === "onset") { this.begin(); this.activity(true); return; }
    const turn = this.current;
    this.current = undefined;
    if (turn) this.end(turn, event.samples, event.voicedMs);
    // A limit split continues the same speech in a new utterance, which holds Moo as an onset does.
    if (event.continues) this.begin();
  }
  private begin() {
    this.current = { seq: ++this.started, id: this.p.id(), turnId: this.p.id(), createdAt: this.p.now(), previewed: false };
    this.hold();
  }
  private end(turn: Turn, samples: Float32Array, voicedMs: number) {
    if (!turn.previewed && voicedMs >= (this.p.previewMinVoicedMs ?? 600)) this.preview(turn);
    const result = voicedMs < (this.p.minVoicedMs ?? 300) ? Promise.resolve(null) : this.transcribe(samples, turn.seq);
    this.outstanding++;
    this.activity();
    this.order = this.order.then(() => result).then(text => {
      void this.apply(turn, text).then(() => { this.outstanding--; this.activity(); });
    }).catch(error => this.p.onError("route", error));
  }
  private preview(turn: Turn) {
    turn.previewed = true;
    const segment = this.segment(turn, 1, "…", false);
    this.order = this.order.then(() => this.ingest(segment));
  }
  private apply(turn: Turn, text: string | null): Promise<void> {
    this.queued.delete(turn.seq);
    if (this.closed) return Promise.resolve();
    if (text !== null) {
      this.ingest(this.segment(turn, turn.previewed ? 2 : 1, text, true));
      return this.settle(turn);
    }
    if (turn.previewed) this.ingest(this.segment(turn, 2, "", true));
    return this.reject(turn);
  }
  private segment(turn: Turn, revision: number, text: string, final: boolean): Segment {
    return { id: turn.id, turnId: turn.turnId, revision, speaker: "user", text, final, createdAt: turn.createdAt };
  }

  private ingest(segment: Segment) {
    this.writes = this.writes
      .then(() => (this.closed ? undefined : this.p.sink.ingest(segment)))
      .then(() => {})
      .catch(error => this.p.onError("save", error));
  }
  private settle(turn: Turn) {
    const precedingWrites = this.writes;
    return this.turns = this.turns
      .then(() => precedingWrites)
      .then(() => {
        if (this.closed) return;
        const settled = this.p.sink.settleTurn(turn.turnId);
        // settleTurn captures the speech epoch when called and, if it is unchanged when the turn is done, releases
        // the hold. Speech that came first and may still bring words is the next utterance's: take the hold again,
        // or Moo answers over it. A sound already over and refused unheard (a cough) is not: holding for it would
        // only drop this turn's offer or question.
        if (this.speechAfter(turn.seq)) this.hold();
        return settled;
      })
      .then(() => {})
      .catch(error => this.p.onError("route", error));
  }
  private reject(turn: Turn) {
    const precedingWrites = this.writes;
    return this.turns = this.turns
      .then(() => precedingWrites)
      .then(async () => {
        if (this.closed) return;
        // A rejection releases the hold outright, so speech since that may still bring words takes it again.
        try { await this.p.sink.recognitionRejected(); }
        finally { if (this.speechAfter(turn.seq) && !this.closed) this.hold(); }
      })
      .catch(error => this.p.onError("route", error));
  }
  private hold() {
    const paused = this.p.speech.heldPaused === true;
    try { void this.p.sink.speechStarted({ paused }).catch(error => this.p.onError("route", error)); }
    catch (error) { this.p.onError("route", error); }
  }

  /** An open utterance, or a later one still being transcribed. */
  private speechAfter(seq: number) {
    return this.endpointer.open || [...this.queued].some(later => later > seq);
  }
  private transcribe(samples: Float32Array, seq: number): Promise<string | null> {
    if (this.transcribing + this.waiting.length > QUEUED_LIMIT) {
      this.p.onError("transcribe", new Error(BEHIND));
      return Promise.resolve(null);
    }
    this.queued.add(seq);
    const wav = encodeWav(samples);
    return new Promise(resolve => { this.waiting.push({ wav, resolve }); this.pump(); });
  }
  private pump() {
    if (this.closed || this.transcribing) return;
    const job = this.waiting.shift();
    if (!job) return;
    this.transcribing++;
    void this.recognize(job.wav).then(job.resolve).finally(() => { this.transcribing--; this.pump(); });
  }
  private async recognize(wav: Uint8Array): Promise<string | null> {
    const abort = new AbortController();
    this.aborts.add(abort);
    const timer = setTimeout(() => abort.abort(new Error(TIMED_OUT)), this.p.transcribeTimeoutMs ?? 20_000);
    timer.unref?.();
    try {
      // The hint only helps recognition; without it the words are still transcribed.
      const hint = await untilAborted(this.p.sink.recognitionContext().catch(() => ""), abort.signal);
      const prompt = cut(`${WAKE} ${typeof hint === "string" ? hint : ""}`.trim(), PROMPT_LIMIT);
      const text = await untilAborted(this.p.transcribe(wav, prompt, abort.signal), abort.signal);
      if (typeof text !== "string") throw new Error("Speech recognition returned no text");
      const heard = text.trim();
      if (!heard) return null;
      if (!hintEcho(heard, WAKE, prompt.slice(WAKE.length + 1))) return repetitiveOutput(heard) ? null : heard;
      // Never route an echo of the prompt. As in the desktop's whisper-bridge, one hint-free transcription decides: a bare
      // wake word keeps the hinted spelling ("Moo.", not "Mu."), and anything else is taken as heard without the hint.
      let plain: string;
      try { plain = await untilAborted(this.p.transcribe(wav, "", abort.signal), abort.signal); }
      catch (error) { if (abort.signal.aborted) throw error; return null; }
      if (typeof plain !== "string" || !/[\p{L}\p{N}]/u.test(plain) || repetitiveOutput(plain)) return null;
      return hintEcho(heard, WAKE) && !repetitiveOutput(heard) ? heard : plain.trim();
    } catch (error) {
      if (!this.closed) this.p.onError("transcribe", error);
      return null;
    } finally {
      clearTimeout(timer);
      this.aborts.delete(abort);
    }
  }

  private async drained() {
    for (let seen: Promise<void> | undefined; seen !== this.order;) { seen = this.order; await seen; }
    await this.writes;
    await this.turns;
  }
  private activity(onset = false) {
    if (this.closed || !this.p.onActivity) return;
    const rms = this.endpointer.rms;
    this.p.onActivity(onset ? { onset: true, pending: this.outstanding, rms } : { pending: this.outstanding, rms });
  }
}

function cut(text: string, limit: number) {
  return text.slice(0, safeEnd(text, limit));
}

/** Settles with `work`, or rejects with the abort reason first: a transcriber that ignores its signal cannot stall the queue. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
