import test from "node:test";
import assert from "node:assert/strict";
import { createWebSpeech, speechParts, unlockAudio, type AudioLike } from "../src/speech.js";

const VOICE_UNAVAILABLE = "Moo’s voice is unavailable. The full response is on screen.";
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
type Stopped = Error & { stopped?: boolean };

/** An audio element the test plays to the end, breaks or refuses. */
class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  paused = true;
  loads = 0;
  readonly played: string[] = [];
  /** What play() does once the element starts. */
  starting: () => Promise<void> = async () => {};
  private readonly listeners = { ended: new Set<() => void>(), error: new Set<() => void>() };
  play() { this.paused = false; this.played.push(this.src); return this.starting(); }
  pause() { this.paused = true; }
  load() { this.loads++; this.currentTime = 0; }
  addEventListener(type: "ended" | "error", listener: () => void) { this.listeners[type].add(listener); }
  removeEventListener(type: "ended" | "error", listener: () => void) { this.listeners[type].delete(listener); }
  end() { this.paused = true; for (const listener of [...this.listeners.ended]) listener(); }
  fail() { for (const listener of [...this.listeners.error]) listener(); }
  get attached() { return this.listeners.ended.size + this.listeners.error.size; }
}

function rig(partLimit?: number) {
  const audio = new FakeAudio(), live = new Set<string>(), changes: boolean[] = [];
  const requests: { text: string; signal: AbortSignal; resolve(): void; reject(error: Error): void }[] = [];
  let time = 0, made = 0;
  const speech = createWebSpeech({
    audio, partLimit, clock: () => time,
    synthesize: (text, signal) => new Promise<Blob>((resolve, reject) => {
      requests.push({ text, signal, resolve: () => resolve(new Blob([text], { type: "audio/mpeg" })), reject });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    urls: { create: () => { const url = `blob:part-${++made}`; live.add(url); return url; }, revoke: url => { live.delete(url); } },
  });
  speech.onAudibleChange(audible => { changes.push(audible); });
  return { audio, speech, requests, live, changes, at(next: number) { time = next; } };
}

test("a long answer plays its parts in order, each fetched while the one before plays, and resolves after the last", async () => {
  const r = rig(60);
  const text = "Osmosis moves water across a membrane. It moves toward more solute. Dilution adds solvent to a solution.";
  const parts = speechParts(text, 60);
  assert.deepEqual(parts, ["Osmosis moves water across a membrane.", "It moves toward more solute.", "Dilution adds solvent to a solution."]);
  let done = false;
  const speaking = r.speech.speak(text).then(() => { done = true; });
  assert.deepEqual(r.requests.map(request => request.text), [parts[0]], "Only the first part is requested at first");
  assert.equal(r.speech.audible, false, "Nothing is audible while the first part downloads");
  r.requests[0]!.resolve(); await tick();
  assert.deepEqual(r.audio.played, ["blob:part-1"]);
  assert.equal(r.speech.audible, true);
  assert.deepEqual(r.requests.map(request => request.text), parts.slice(0, 2), "The next part is fetched while this one plays");
  r.requests[1]!.resolve(); await tick();
  assert.equal(r.requests.length, 2, "Never more than one part ahead");
  r.audio.end(); await tick();
  assert.deepEqual(r.audio.played, ["blob:part-1", "blob:part-2"]);
  assert.deepEqual(r.changes, [true], "A part already fetched follows without a silent gap");
  assert.ok(!r.live.has("blob:part-1"), "An ended part's URL is revoked");
  r.at(1500); r.audio.end(); await tick();
  assert.equal(r.speech.audible, false, "Waiting for a part still downloading is silence");
  assert.equal(r.speech.quietSince, 1500);
  assert.equal(done, false);
  r.requests[2]!.resolve(); await tick();
  assert.equal(r.speech.audible, true);
  r.at(3000); r.audio.end(); await speaking;
  assert.deepEqual(r.audio.played, ["blob:part-1", "blob:part-2", "blob:part-3"]);
  assert.deepEqual(r.changes, [true, false, true, false]);
  assert.equal(r.speech.quietSince, 3000);
  assert.equal(r.live.size, 0, "Every URL is revoked");
  assert.equal(r.audio.attached, 0);
});

test("newer speech supersedes the current one, marked stopped, and aborts its synthesis", async () => {
  const r = rig();
  const unheard = r.speech.speak("Never heard.");
  const first = r.speech.speak("The first answer.");
  await assert.rejects(unheard, (error: Stopped) => error.message === "Speech superseded" && error.stopped === true);
  assert.equal(r.requests[0]!.signal.aborted, true, "The superseded part's request is aborted");
  r.requests[1]!.resolve(); await tick();
  assert.equal(r.speech.audible, true);
  const second = r.speech.speak("The second answer.");
  await assert.rejects(first, (error: Stopped) => error.message === "Speech superseded" && error.stopped === true);
  assert.equal(r.audio.paused, true);
  assert.equal(r.speech.audible, false);
  assert.equal(r.live.size, 0);
  r.requests[2]!.resolve(); await tick();
  assert.equal(r.audio.src, "blob:part-2");
  r.audio.end(); await second;
});

test("stop interrupts at once: marked stopped, paused, the next part's request aborted and nothing left behind", async () => {
  const r = rig(60);
  const speaking = r.speech.speak("Osmosis moves water across a membrane. It moves toward more solute. Dilution adds solvent.");
  r.requests[0]!.resolve(); await tick();
  assert.equal(r.requests.length, 2, "The next part is downloading");
  await r.speech.stop();
  await assert.rejects(speaking, (error: Stopped) => error.message === "Speech interrupted" && error.stopped === true);
  assert.equal(r.requests[1]!.signal.aborted, true);
  assert.equal(r.audio.paused, true);
  assert.equal(r.live.size, 0);
  assert.equal(r.audio.attached, 0, "No listener is left on the element");
  assert.deepEqual(r.changes, [true, false]);
  await tick();
  assert.deepEqual(r.audio.played, ["blob:part-1"], "Nothing more plays");
  await r.speech.stop();
});

test("a held pause continues where it stopped on resume and never replays", async () => {
  const r = rig();
  assert.equal(r.speech.pause(), false, "Nothing is playing");
  const speaking = r.speech.speak("A short answer.");
  assert.equal(r.speech.pause(), false, "Audio still downloading is not playing");
  r.requests[0]!.resolve(); await tick();
  r.audio.currentTime = 2.5;
  const loads = r.audio.loads;
  assert.equal(r.speech.pause(), true);
  assert.equal(r.speech.heldPaused, true);
  assert.equal(r.speech.audible, false);
  assert.equal(r.audio.paused, true);
  assert.equal(r.speech.pause(), false, "Already held");
  await r.speech.resume();
  assert.equal(r.speech.heldPaused, false);
  assert.equal(r.speech.audible, true);
  assert.equal(r.audio.currentTime, 2.5, "Playback continues from where it paused");
  assert.equal(r.audio.loads, loads, "The element is not reloaded");
  assert.deepEqual(r.audio.played, ["blob:part-1", "blob:part-1"]);
  assert.equal(r.requests.length, 1, "Nothing is synthesized again");
  r.audio.end(); await speaking;
  await r.speech.resume();
  assert.equal(r.audio.played.length, 2, "Resume after the end plays nothing");
  assert.deepEqual(r.changes, [true, false, true, false]);
});

test("a held reading that is stopped stays stopped", async () => {
  const r = rig();
  const speaking = r.speech.speak("A held answer.");
  r.requests[0]!.resolve(); await tick();
  assert.equal(r.speech.pause(), true);
  await r.speech.stop();
  await assert.rejects(speaking, /Speech interrupted/);
  assert.equal(r.speech.heldPaused, false);
  await r.speech.resume();
  assert.deepEqual(r.audio.played, ["blob:part-1"]);
});

test("empty text is refused before anything starts, and the current reading plays on", async () => {
  const r = rig();
  const speaking = r.speech.speak("Still playing.");
  r.requests[0]!.resolve(); await tick();
  await assert.rejects(r.speech.speak("  \n "), /^Error: Speech text is empty; playback was not started\.$/);
  assert.equal(r.requests.length, 1);
  assert.equal(r.speech.audible, true);
  r.audio.end(); await speaking;
});

test("a failed synthesis, a broken file or refused playback rejects with the readable voice failure, not marked stopped", async () => {
  const r = rig();
  const failed = r.speech.speak("Unlucky.");
  r.requests[0]!.reject(new Error("Speech failed: HTTP 502 provider_failed"));
  await assert.rejects(failed, (error: Stopped) => error.message === VOICE_UNAVAILABLE && error.stopped === undefined);
  const broken = r.speech.speak("Broken audio.");
  r.requests[1]!.resolve(); await tick();
  r.audio.fail();
  await assert.rejects(broken, (error: Stopped) => error.message === VOICE_UNAVAILABLE && error.stopped === undefined);
  assert.equal(r.speech.audible, false);
  assert.equal(r.live.size, 0);
  r.audio.starting = async () => { throw new DOMException("play() can only be initiated by a user gesture", "NotAllowedError"); };
  const refused = r.speech.speak("Refused.");
  r.requests[2]!.resolve();
  await assert.rejects(refused, (error: Error) => error.message === VOICE_UNAVAILABLE && (error.cause as Error).name === "NotAllowedError");
  assert.equal(r.audio.attached, 0);
});

test("audible changes reach each listener until it unsubscribes, and a failing listener stops nothing", async () => {
  const r = rig(), seen: boolean[] = [];
  const unsubscribe = r.speech.onAudibleChange(audible => { seen.push(audible); });
  r.speech.onAudibleChange(() => { throw Error("listener failed"); });
  const errors: unknown[] = [], log = console.error;
  console.error = (...items: unknown[]) => { errors.push(items); };
  try {
    const first = r.speech.speak("One.");
    r.requests[0]!.resolve(); await tick();
    r.audio.end(); await first;
    unsubscribe();
    const second = r.speech.speak("Two.");
    r.requests[1]!.resolve(); await tick();
    r.audio.end(); await second;
  } finally { console.error = log; }
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(r.changes, [true, false, true, false]);
  assert.equal(errors.length, 4);
});

test("close ends the current reading as closed and refuses more", async () => {
  const r = rig();
  const speaking = r.speech.speak("Goodbye.");
  r.speech.close();
  await assert.rejects(speaking, /^Error: Speech session closed$/);
  assert.equal(r.requests[0]!.signal.aborted, true);
  await assert.rejects(r.speech.speak("Again."), /^Error: Speech session closed$/);
  assert.equal(r.requests.length, 1);
});

test("speech parts stay within the limit, end on sentences where they can, and never split a surrogate pair", () => {
  const sentences = Array.from({ length: 30 }, (_, i) => `Sentence ${i + 1} explains one more part of the saved answer.`).join(" ");
  const parts = speechParts(sentences);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 450 && /[.!?…]$/.test(part)));
  assert.equal(parts.join(" "), sentences);
  const emoji = `a${"😀".repeat(300)}`;
  const cut = speechParts(emoji);
  assert.equal(cut[0]!.length, 449, "The cut moves back off the pair's first half");
  assert.ok(cut.every(part => part.length <= 450 && !/[\uD800-\uDBFF]$/.test(part)));
  assert.equal(cut.join(""), emoji);
  assert.deepEqual(speechParts("Short."), ["Short."]);
});

test("unlocking plays a silent clip at once, ignores a refusal, and releases the clip", async t => {
  const created: Blob[] = [], revoked: string[] = [];
  t.mock.method(URL, "createObjectURL", (blob: Blob) => { created.push(blob); return "blob:silence"; });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  let plays = 0;
  const element = { src: "", play: () => { plays++; return Promise.reject(new DOMException("blocked", "NotAllowedError")); } };
  unlockAudio(element as unknown as HTMLAudioElement);
  assert.equal(plays, 1, "play() is called synchronously, inside the click");
  assert.equal(element.src, "blob:silence", "A blob URL, which the page's media-src allows");
  assert.equal(created[0]!.type, "audio/wav");
  const wav = new Uint8Array(await created[0]!.arrayBuffer());
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.ok(wav.slice(44).every(sample => sample === 0x80), "Silence");
  await tick();
  assert.deepEqual(revoked, ["blob:silence"]);
});
