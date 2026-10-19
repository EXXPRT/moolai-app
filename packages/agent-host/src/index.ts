import { randomUUID } from "node:crypto";
import {join} from "node:path";
import { Agent } from "../../agent/src/index.js";
import type {
  AgentEvent,
  BrainPort,
  LocalFilesPort,
} from "../../contracts/src/index.js";
import { BackendProviders, FixtureProviders } from "./providers.js";
import { LocalSpeech } from "./speech.js";
import { NativeBridge } from "./native.js";
import { NativeInput, retainAsrDiagnostic } from "./native-input.js";
import { waitForLocalAsr } from "./asr-ready.js";
import { ThoughtSchedule } from "./thought-schedule.js";
export { BackendProviders, FixtureProviders } from "./providers.js";

/** Host assembly only. Storage, UI and conversation policy are supplied independently. */
export async function createAgentHost(options: {
  brain: BrainPort;
  providers: BackendProviders | FixtureProviders;
  localFiles?: LocalFilesPort;
  nativePath: string;
  speechRoot?: string;
  onEvent: (event: AgentEvent) => void;
  speech?: {speak(text:string):Promise<void>;stop():Promise<void>;warm():Promise<void>;close():void};
  waitForAsr?: (signal: AbortSignal) => Promise<void>;
  fixtureCapture?: () => Promise<{ mimeType: string; bytes: Uint8Array }>;
  /** Apps the companion leaves out of screen captures, such as the host's own window, and how to name them. */
  captureExclusions?: { bundleIds: string[]; label: string };
}) {
  const { brain, providers } = options;
  let thoughtSchedule:ThoughtSchedule|undefined;
  const emit=(event:AgentEvent)=>{
    options.onEvent(event);
  };
  let voiceEnabled = false;
  let captureMayBeOn = false;
  let voiceShutdownPending = false;
  let voiceRequestEpoch = 0;
  let voiceStartup: AbortController | undefined;
  let closed = false;
  let status: Record<string, unknown> = { listening: false, speaking: false };
  const input = new NativeInput(
    {
      ingest: (segment) => agent.ingest(segment),
      async settleTurn(id) { await agent.settleTurn(id); await updateRecognitionContext(); },
      async retainDiagnostic(text, message) {
        const record = await retainAsrDiagnostic(brain, text, message);
        emit({ type: "record", record });
        emit({ type: "notice", message });
      },
    },
    (error) => emit({ type: "notice", message: String(error) }),
  );
  const native = new NativeBridge(options.nativePath, (event) => {
    if (event.event === "transcript" && event.segment)
      input.ingest(event.segment);
    if (event.event === "turn_end" && event.turnId)
      input.settleTurn(event.turnId);
    if (event.event === "asr_diagnostic" && typeof event.text === "string")
      input.retainDiagnostic(
        event.text,
        String(event.message ?? "Speech recognition needs review"),
      );
    if (["recognition_rejected", "asr_diagnostic", "error"].includes(event.event) || (event.event === "status" && ["off","error","reconnecting"].includes(String(event.phase))))
      void agent.recognitionRejected().catch(e=>emit({type:"notice",message:String(e)}));
    if (event.event === "error")
      emit({ type: "notice", message: String(event.message ?? event.error) });
    if (event.event === "speech_started")
      void agent.speechStarted().catch(e => emit({type: "notice", message: String(e)}));
    if (event.event === "status") {
      status = { ...status, ...event };
      if (event.listening === true) captureMayBeOn = true;
      if (event.requestedOn === false && event.listening === false) captureMayBeOn = false;
      if (event.phase === "error" && event.requestedOn === false) voiceEnabled = false;
      emit({ type: "voice", voice: {...status, enabled: voiceEnabled} });
    }
  });
  const speech = options.speech ?? new LocalSpeech(native, message=>emit({type:"notice",message}), options.speechRoot ? {config:join(options.speechRoot,"tts-config.json"),worker:join(options.speechRoot,"native/tts/worker.py")} : undefined);
  const agent = new Agent({
    brain,
    localFiles: options.localFiles,
    decisions: providers,
    generation: providers,
    vision: providers,
    search: providers,
    capture: {
      async capture() {
        if (options.fixtureCapture) return options.fixtureCapture();
        const result = await native.request<{
          mimeType: string;
          dataBase64: string;
          excludedApplications?: string[];
        }>("capture", options.captureExclusions ? { excludeBundleIds: options.captureExclusions.bundleIds } : {});
        return {
          mimeType: result.mimeType,
          bytes: Buffer.from(result.dataBase64, "base64"),
          // Reported only from what the companion confirms; an older build that ignores the request reports nothing.
          ...(options.captureExclusions && result.excludedApplications?.length ? { excluded: [options.captureExclusions.label] } : {}),
        };
      },
    },
    speech: {
      async speak(text) {
        if (voiceEnabled && !closed) await speech.speak(text);
      },
      async stop() {
        if (voiceEnabled && !closed) await speech.stop();
      },
    },
    acceptance: providers instanceof BackendProviders ? providers : undefined,
    id: randomUUID,
    now: () => new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onEvent: emit,
    onThoughtsPending:()=>thoughtSchedule?.draftAvailable(),
  });
  thoughtSchedule=new ThoughtSchedule({run:()=>agent.consolidateThoughts(),enabled:()=>!closed,periodicEnabled:()=>agent.getState().listening,onError:e=>emit({type:"notice",message:String(e)})});
  try { await agent.initialize(); } catch(error) { thoughtSchedule.close(); throw error; }
  async function updateRecognitionContext(force = false) {
    if (closed || (!voiceEnabled && !force)) return;
    try { await native.request("recognitionContext", {text: await agent.recognitionContext()}); }
    catch (error) { emit({type:"notice",message:`Recognition context unavailable: ${String(error)}`}); }
  }
  let voiceIntent=0;
  let stoppingCapture: Promise<void> | undefined;
  async function voice(action: "start" | "stop" | "flush") {
    if(closed)throw Error("Host closed");
    const intent=action === "flush" ? voiceIntent : ++voiceIntent;
    if(action === "stop") {
      await stopCaptureOnce();
      await input.settled();
      return {voiceEnabled};
    }
    if(stoppingCapture)await stoppingCapture;
    if(intent!==voiceIntent || closed)return {voiceEnabled};
    return voiceRequest(action);
  }
  async function voiceRequest(action: "start" | "stop" | "flush") {
    if (closed) throw Error("Host closed");
    if (action === "start") {
      const startupIntent=voiceIntent;
      if (voiceEnabled) return {voiceEnabled};
      if (captureMayBeOn || voiceShutdownPending) {
        await stopCaptureOnce();
        if (startupIntent !== voiceIntent || closed) return {voiceEnabled};
      }
      const epoch = ++voiceRequestEpoch;
      const startup = new AbortController();
      voiceStartup = startup;
      voiceEnabled = true;
      void speech.warm().catch(e=>emit({type:"notice",message:String(e)}));
      status = {...status, requestedOn:true, listening:false, phase:"connecting_asr", error:null};
      emit({type:"voice", voice:{...status, enabled:true}});
      let nativeAttempted = false;
      try {
        await agent.startSession();
        if (epoch !== voiceRequestEpoch || closed) return {voiceEnabled};
        await (options.waitForAsr ?? waitForLocalAsr)(startup.signal);
        if (epoch !== voiceRequestEpoch || closed) return {voiceEnabled};
        await updateRecognitionContext(true);
        if (epoch !== voiceRequestEpoch || closed) return {voiceEnabled};
        nativeAttempted = true;
        captureMayBeOn = true;
        const started = await native.request<{listening?: boolean}>("startListening");
        if (started?.listening === false) throw Error("The microphone did not start. Click the microphone again to retry.");
      } catch (error) {
        if (epoch !== voiceRequestEpoch || closed) return {voiceEnabled};
        voiceEnabled = false;
        // Failed startup owns the same physical shutdown as explicit Stop. A new
        // start waits for it, and a superseded cleanup must not publish stale Off/error.
        if (nativeAttempted) await stopCaptureOnce().catch(()=>{});
        if(startupIntent!==voiceIntent || closed)return {voiceEnabled};
        status = {...status, requestedOn:false, listening:captureMayBeOn, phase:"error", error:String(error)};
        emit({type:"voice", voice:{...status, enabled:false}});
        throw error;
      } finally {
        if (voiceStartup === startup) voiceStartup = undefined;
      }
    } else if (action === "flush" && voiceEnabled) {
      try {
        await native.request("flushListening");
      } finally {
        await input.saved();
      }
      await input.settled();
    }
    return { voiceEnabled };
  }
  function stopCaptureOnce() {
    if(!stoppingCapture) {
      const pending=stopCapture();
      stoppingCapture=pending;
      void pending.finally(()=>{if(stoppingCapture===pending)stoppingCapture=undefined;}).catch(()=>{});
    }
    return stoppingCapture;
  }
  async function stopCapture() {
      voiceRequestEpoch++;
      voiceStartup?.abort();
      const captureWasRequested = voiceEnabled || captureMayBeOn || voiceShutdownPending;
      voiceEnabled = false;
      // Playback cancellation and capture shutdown must succeed independently.
      // Do not claim capture is off when its acknowledgment failed.
      const outcomes: PromiseSettledResult<void>[] = captureWasRequested ? await Promise.allSettled([
        speech.stop(), native.request("stopListening").then(() => { captureMayBeOn = false; }),
      ]) : [];
      await input.saved();
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      voiceShutdownPending = failures.length > 0;
      status = {...status, requestedOn:false, listening:captureMayBeOn,
        ...(outcomes[0]?.status === "fulfilled" ? {speaking:false} : {}),
        phase: failures.length ? "error" : "off",
        error: failures.length ? failures.map(item=>String(item.reason)).join("; ") : null};
      emit({type:"voice", voice:{...status, enabled:false}});
      if (failures.length) throw new AggregateError(failures.map(item=>item.reason), "Could not confirm all voice output and capture stopped");

  }
  return {
    agent,
    voice,
    async revokeVoice() {
      try { await voice("stop"); }
      catch(error) {
        // No owning surface remains to retry. Closing our companion is the
        // fail-closed fallback after its graceful capture flush failed.
        speech.close(); native.close(); captureMayBeOn=false; voiceEnabled=false; voiceShutdownPending=false;
        emit({type:"notice",message:`Voice owner lost; native companion closed after shutdown failure: ${String(error)}`});
      }
    },
    nativeHealth: () => native.request("health"),
    nativeSnapshot: (): Record<string, unknown> => ({ ...status, enabled: voiceEnabled }),
    async close() {
      if (closed) return;
      closed = true;
      voiceIntent++;
      voiceRequestEpoch++;
      voiceStartup?.abort();
      if (providers instanceof BackendProviders) providers.beginShutdown();
      const bounded = (work: Promise<unknown>, ms: number) => Promise.race([work, new Promise(resolve => setTimeout(resolve, ms).unref?.())]);
      try {
        if (voiceEnabled || captureMayBeOn || voiceShutdownPending) await bounded(native.request("stopListening"), 10000);
      } catch (e) {
        emit({ type: "notice", message: String(e) });
      }
      const schedulePass = thoughtSchedule.close();
      speech.close();
      closed = true;
      voiceEnabled = false;
      native.close();
      await input.saved();
      // initialize() re-checkpoints and recovers on the next start, so shutdown starts no finalize or provider work.
      await bounded(Promise.all([input.settled(), agent.drain(), schedulePass]), 3000);
      if (providers instanceof BackendProviders) providers.close();
      await bounded(agent.drain(), 1000);
    },
  };
}
