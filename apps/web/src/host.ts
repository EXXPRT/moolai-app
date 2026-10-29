import { Agent } from "../../../packages/agent/src/index.js";
import type { BackendProviders } from "../../../packages/agent-host/src/providers.js";
import { ThoughtSchedule } from "../../../packages/agent-host/src/thought-schedule.js";
import type { AgentEvent } from "../../../packages/contracts/src/index.js";
import type { MicHandle, VoiceAction, VoiceController, VoiceStatus, WebHost, WebHostOptions } from "./types.js";

// Not "local ASR": feedback.ts would read that as the desktop's recognition service.
const MIC_FAILED = "The microphone could not connect. Check its permission and connection, then try again.";
const NO_VOICE = "Voice is not available in fixture mode. Type instead.";
const VOICE_ENDED = "Voice is off for the rest of this demo session. You can keep typing.";
const IDLE_OFF = "The microphone turned off after a few minutes without speech. Turn it on to continue.";
const HIDDEN_OFF = "The microphone turned off while this tab was in the background. Turn it on to continue.";
const FINISH_FAILED = "Moo couldn't finish transcribing your last words. Please say them again.";
const VOICE_FAILED = {
  save: "Moo couldn't save what you just said. Please say it again.",
  route: "Moo saved what you said but couldn't act on it. Try saying it again in a moment.",
  transcribe: "Moo couldn't transcribe what you just said. Please say it again.",
} as const;

/** One microphone run: the controller its samples feed, until a stop or close cuts the feed. */
interface Capture { feeding: boolean; mic?: MicHandle; controller?: VoiceController }

/** The desktop's agent-host (packages/agent-host/src/index.ts) without its native parts. */
export async function createWebHost(options: WebHostOptions): Promise<WebHost> {
  const { brain, providers, speech } = options;
  const id = options.id ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const idleMs = options.idleMicOffMs ?? 300_000;
  let closed = false, voiceEnabled = false, limited = false, epoch = 0, intent = 0;
  let capture: Capture | undefined, stopping: Promise<void> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
  // Speaking includes a line still downloading, so Stop speech shows from the moment Moo is about to talk.
  const speaking = () => speech.audible || speech.busy;
  let status: VoiceStatus = { enabled: false, requestedOn: false, listening: false, speaking: speaking(), phase: "off", error: null };
  let schedule: ThoughtSchedule | undefined;
  // Read at each call, and a failing listener never fails the Agent work that emitted.
  const emit = (event: AgentEvent) => {
    try { options.emit(event); } catch (error) { console.error(`Host event listener failed: ${String(error)}`); }
  };
  const notice = (message: string) => emit({ type: "notice", message });
  // The renderer replaces `native` with each voice event (snapshot.ts), so every event carries the whole status.
  const update = (partial: Partial<VoiceStatus>) => {
    status = { ...status, ...partial };
    emit({ type: "voice", voice: { ...status } });
  };
  const agent = new Agent({
    brain,
    decisions: providers,
    generation: providers,
    search: providers,
    vision: providers,
    capture: {
      async capture() {
        const worksheet = await options.worksheet();
        try { options.onWorksheet?.(); } catch (error) { console.error(`Worksheet display failed: ${String(error)}`); }
        return worksheet;
      },
    },
    // Typing alone means a silent Moo: speech follows the microphone.
    speech: {
      async speak(text) { if (voiceEnabled && !closed) await speech.speak(text); },
      async stop() { if (voiceEnabled && !closed) await speech.stop(); },
      async resume() { if (voiceEnabled && !closed) await speech.resume(); },
    },
    id,
    now,
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    onEvent: emit,
    onThoughtsPending: () => schedule?.draftAvailable(),
  });
  schedule = new ThoughtSchedule({ run: () => agent.consolidateThoughts(), enabled: () => !closed,
    periodicEnabled: () => agent.getState().listening, onError: error => notice(String(error)),
    intervalMs: options.thoughtIntervalMs ?? 30_000 });
  try { await agent.initialize(); } catch (error) { schedule.close(); throw error; }

  const unsubscribe = speech.onSpeakingChange(now => {
    update({ speaking: now });
    rearm();
  });
  const page = typeof document === "undefined" ? undefined : document;
  const view = typeof window === "undefined" ? undefined : window;
  const hidden = () => { if (page?.hidden) void autoOff(HIDDEN_OFF); };
  const leave = () => void close();
  // A page restored from the back-forward cache was closed on pagehide; a reload starts the demo again.
  const restored = (event: PageTransitionEvent) => { if (event.persisted) view?.location.reload(); };
  page?.addEventListener("visibilitychange", hidden);
  view?.addEventListener("pagehide", leave);
  view?.addEventListener("pageshow", restored);

  function clearIdle() {
    clearTimeout(idle);
    idle = undefined;
  }
  /** `idleMicOffMs` without an onset turns the microphone off. Moo's own speech is not the visitor's silence. */
  function rearm() {
    clearIdle();
    if (voiceEnabled && !closed && capture?.controller && !speaking()) idle = setTimeout(() => void autoOff(IDLE_OFF), idleMs);
  }
  async function autoOff(message: string) {
    if (!voiceEnabled || closed) return;
    notice(message);
    await stop();
  }
  function voiceFailed(stage: keyof typeof VOICE_FAILED, error: unknown) {
    // The raw error stays in the log; a demo limit already shows its own lasting banner.
    console.error(`Voice turn ${stage} failed: ${String(error)}`);
    if (!closed && !(stage === "transcribe" && limited)) notice(VOICE_FAILED[stage]);
  }
  /** Cuts the feed and stops the tracks, once per handle, whatever else fails. */
  function release(own: Capture) {
    own.feeding = false;
    const mic = own.mic;
    own.mic = undefined;
    try { mic?.stop(); } catch (error) { console.error(`Microphone stop failed: ${String(error)}`); }
  }
  async function start(request: number) {
    const runtime = options.voice;
    if (!runtime) throw new Error(NO_VOICE);
    // A start waits for a stop still finishing; a newer click, start or stop, supersedes it (agent-host:154-165).
    if (stopping) await stopping;
    if (closed) throw new Error("Host closed");
    if (limited) throw new Error(VOICE_ENDED);
    if (request !== intent || voiceEnabled) return;
    const current = ++epoch, own: Capture = { feeding: true };
    const superseded = () => current !== epoch || closed;
    capture = own;
    voiceEnabled = true;
    update({ requestedOn: true, listening: false, phase: "connecting_asr", error: null, enabled: true });
    try {
      await agent.startSession();
      if (superseded()) return;
      const mic = await runtime.open((samples, sampleRate) => { if (own.feeding) own.controller?.accept(samples, sampleRate); });
      own.mic = mic;
      // A stop or close during startup must not leave a late microphone open.
      if (superseded()) { release(own); return; }
      own.controller = runtime.createController({ sink: agent, transcribe: runtime.transcribe, speech, id, now,
        onError: voiceFailed, onActivity: activity => { if (activity.onset) rearm(); } });
      update({ listening: true, phase: "listening" });
      rearm();
    } catch (error) {
      if (superseded()) return;
      voiceEnabled = false;
      release(own);
      if (capture === own) capture = undefined;
      update({ requestedOn: false, listening: false, phase: "error", error: String(error), enabled: false });
      throw new Error(MIC_FAILED, { cause: error });
    }
  }
  function stop() {
    stopping ??= stopCapture().finally(() => { stopping = undefined; });
    return stopping;
  }
  /** Never checkpoints: only the bridge's /api/voice stop does, so auto-off and session stop leave the conversation as it is. */
  async function stopCapture() {
    epoch++;
    voiceEnabled = false;
    clearIdle();
    const own = capture, controller = own?.controller;
    // As on the desktop, capture stops before the commit and Moo goes quiet at once; words already heard are still
    // transcribed, and nothing said after the click reaches the controller.
    if (own) release(own);
    try { await speech.stop(); } catch (error) { console.error(`Speech stop failed: ${String(error)}`); }
    // Off as requested at once, as on the desktop: the renderer's button then reads "Mic off" and stays disabled
    // while the last words finish, so a second click can't checkpoint the conversation again.
    if (controller && (controller.utteranceOpen || controller.pending > 0))
      update({ requestedOn: false, enabled: false, listening: false, phase: "finishing_transcription" });
    try { await controller?.finish(); }
    catch (error) {
      console.error(`Voice finish failed: ${String(error)}`);
      if (!closed) notice(FINISH_FAILED);
    }
    if (capture === own) capture = undefined;
    if (!closed) update({ requestedOn: false, listening: false, speaking: false, phase: "off", error: null, enabled: false });
  }
  async function flush() {
    if (voiceEnabled) await capture?.controller?.finish();
  }
  async function voice(action: VoiceAction) {
    if (closed) throw new Error("Host closed");
    if (action === "flush") return flush();
    const request = ++intent;
    return action === "start" ? start(request) : stop();
  }
  /** pagehide: the tracks stop before anything awaits, and unfinished work is dropped, never drained. */
  async function close() {
    if (closed) return;
    closed = true;
    epoch++;
    voiceEnabled = false;
    clearIdle();
    const own = capture;
    capture = undefined;
    if (own) release(own);
    page?.removeEventListener("visibilitychange", hidden);
    view?.removeEventListener("pagehide", leave);
    view?.removeEventListener("pageshow", restored);
    unsubscribe();
    (providers as Partial<Pick<BackendProviders, "close">>).close?.();
    speech.close();
    void schedule?.close();
    status = { ...status, requestedOn: false, listening: false, speaking: false, phase: "off", error: null, enabled: false };
    try { await own?.controller?.discard(); } catch (error) { console.error(`Voice discard failed: ${String(error)}`); }
  }
  return {
    agent,
    voice,
    nativeSnapshot: () => ({ ...status }),
    onLimit() {
      if (limited || closed) return;
      limited = true;
      if (voiceEnabled || capture) void stop();
    },
    close,
  };
}
