import { safeEnd } from "../../../packages/contracts/src/records.js";
import type { Synthesize, WebSpeechPort } from "./types.js";

/** What WebSpeech uses of its one audio element. An HTMLAudioElement satisfies it; tests drive a fake. */
export interface AudioLike {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: "ended" | "error", listener: () => void): void;
  removeEventListener(type: "ended" | "error", listener: () => void): void;
}
export interface WebSpeechOptions {
  synthesize: Synthesize;
  audio: AudioLike;
  urls?: { create(blob: Blob): string; revoke(url: string): void };
  partLimit?: number;
  clock?: () => number;
}

/** The desktop's wording for a voice that failed (apps/desktop/src/feedback.ts). */
const VOICE_UNAVAILABLE = "Moo’s voice is unavailable. The full response is on screen.";
/** 10 ms of 8 kHz silence, as a WAV. */
const SILENCE = Uint8Array.from(atob("UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=="), char => char.charCodeAt(0));

/** Copied from agent-host/src/speech.ts, which imports Node. Whole sentences where they fit, else a cut at the last
 * space, never inside a surrogate pair. Each part is one speech request, so a long answer starts playing sooner. */
export function speechParts(text: string, limit = 450): string[] {
  if(text.length<=limit)return [text];
  const parts:string[]=[];let rest=text.trim();
  while(rest.length>limit){
    const head=rest.slice(0,limit+1),space=head.search(/\s\S*$/);
    const end=/^[\s\S]*[.!?…](?=\s)/.exec(head)?.[0].length ?? (space>0?space:safeEnd(rest,limit));
    parts.push(rest.slice(0,end).trimEnd());rest=rest.slice(end).trimStart();
  }
  return [...parts,rest];
}

/** Call synchronously inside the Start click: an element that played with user activation may play later without it (Safari).
 * The clip is a blob URL like every spoken part, which the page's `media-src 'self' blob:` allows and `data:` would not be. */
export function unlockAudio(audio: HTMLAudioElement) {
  const url = URL.createObjectURL(new Blob([SILENCE], { type: "audio/wav" }));
  audio.src = url;
  audio.play().catch(() => {}).finally(() => URL.revokeObjectURL(url));
}

interface Reading {
  readonly abort: AbortController;
  /** Settles the speak() promise; only the first call counts. */
  settle(error?: Error): void;
  url?: string;
  detach?: () => void;
}

/** The Agent's SpeechPort: each part is synthesized by the gateway and played through one audio element. */
export class WebSpeech implements WebSpeechPort {
  private reading?: Reading;
  private readonly listeners = new Set<(audible: boolean) => void>();
  private playing = false;
  private quiet = -Infinity;
  private held = false;
  private closed = false;
  private readonly urls: NonNullable<WebSpeechOptions["urls"]>;
  private readonly clock: () => number;
  constructor(private readonly p: WebSpeechOptions) {
    this.urls = p.urls ?? { create: blob => URL.createObjectURL(blob), revoke: url => URL.revokeObjectURL(url) };
    this.clock = p.clock ?? (() => performance.now());
  }
  get audible() { return this.playing; }
  get quietSince() { return this.quiet; }
  get heldPaused() { return this.held; }
  async speak(text: string) {
    if (!text.trim()) throw new Error("Speech text is empty; playback was not started.");
    if (this.closed) throw new Error("Speech session closed");
    // A cut made on purpose, here or by stop(), is marked stopped so it is never reported as a voice failure.
    this.cut(Object.assign(new Error("Speech superseded"), { stopped: true }));
    let settled = false, resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const reading: Reading = { abort: new AbortController(), settle: error => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    } };
    this.reading = reading;
    void this.read(reading, speechParts(text, this.p.partLimit ?? 450));
    return done;
  }
  private async read(reading: Reading, parts: string[]) {
    try {
      let current = this.fetch(reading, parts[0]!);
      for (let index = 0; index < parts.length; index++) {
        // Waiting on the network is silence; a part fetched while the one before played follows it at once.
        if (!current.ready) this.setAudible(false);
        const blob = await current.blob;
        if (this.reading !== reading) return;
        const next = index + 1 < parts.length ? this.fetch(reading, parts[index + 1]!) : undefined;
        await this.play(reading, blob);
        if (this.reading !== reading) return;
        if (next) current = next;
      }
      this.finish(reading);
    } catch (error) {
      if (this.reading === reading) this.finish(reading, new Error(VOICE_UNAVAILABLE, { cause: error }));
    }
  }
  /** One part's audio, requested at most one part ahead of playback. */
  private fetch(reading: Reading, text: string) {
    const part = { ready: false, blob: new Promise<Blob>(resolve => resolve(this.p.synthesize(text, reading.abort.signal))) };
    part.blob.then(() => { part.ready = true; }, () => {});
    return part;
  }
  /** Resolves when the part ends. A cut never settles it; read() checks the reading is still current instead. */
  private play(reading: Reading, blob: Blob) {
    const { audio } = this.p;
    return new Promise<void>((resolve, reject) => {
      const ended = () => { detach(); this.revoke(reading); resolve(); };
      const failed = (error: unknown) => { detach(); reject(error); };
      const broken = () => failed(new Error("Audio playback failed"));
      const detach = () => {
        audio.removeEventListener("ended", ended);
        audio.removeEventListener("error", broken);
        if (reading.detach === detach) reading.detach = undefined;
      };
      reading.url = this.urls.create(blob);
      reading.detach = detach;
      audio.addEventListener("ended", ended);
      audio.addEventListener("error", broken);
      audio.src = reading.url;
      audio.load();
      const current = () => this.reading === reading && reading.detach === detach;
      audio.play().then(
        () => { if (current() && !this.held) this.setAudible(true); },
        // A held pause interrupts a play() still starting; resume() plays the element again.
        error => { if (current() && !this.held) failed(error); },
      );
    });
  }
  /** Continues the paused element where it stopped; it never replays. */
  async resume() {
    const reading = this.reading;
    if (!reading || !this.held) return;
    this.held = false;
    try { await this.p.audio.play(); }
    catch (error) {
      if (this.reading !== reading || this.held) return;
      const failure = new Error(VOICE_UNAVAILABLE, { cause: error });
      this.finish(reading, failure);
      throw failure;
    }
    if (this.reading === reading && !this.held) this.setAudible(true);
  }
  pause() {
    if (!this.reading || this.held || !this.playing || this.p.audio.paused) return false;
    this.p.audio.pause();
    this.held = true;
    this.setAudible(false);
    return true;
  }
  async stop() {
    this.cut(Object.assign(new Error("Speech interrupted"), { stopped: true }));
  }
  close() {
    this.closed = true;
    this.cut(new Error("Speech session closed"));
    this.listeners.clear();
  }
  onAudibleChange(listener: (audible: boolean) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private cut(error: Error) {
    if (this.reading) this.finish(this.reading, error);
  }
  private finish(reading: Reading, error?: Error) {
    reading.abort.abort();
    reading.detach?.();
    this.revoke(reading);
    this.reading = undefined;
    this.held = false;
    this.p.audio.pause();
    this.setAudible(false);
    reading.settle(error);
  }
  private revoke(reading: Reading) {
    if (reading.url) this.urls.revoke(reading.url);
    reading.url = undefined;
  }
  private setAudible(audible: boolean) {
    if (audible === this.playing) return;
    this.playing = audible;
    if (!audible) this.quiet = this.clock();
    for (const listener of [...this.listeners])
      try { listener(audible); } catch (error) { console.error(`Speech state listener failed: ${String(error)}`); }
  }
}

export function createWebSpeech(options: WebSpeechOptions): WebSpeechPort {
  return new WebSpeech(options);
}
