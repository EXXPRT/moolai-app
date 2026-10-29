// The web demo's bootstrap (docs/web-demo.md): the capability check, consent and the bot check, then the real Agent
// in this tab behind window.moolai, then the desktop renderer, which renders as soon as it is imported.
import "../../desktop/src/style.css";
import "./demo.css";
import type { HostTextKey } from "../../desktop/src/snapshot.js";
import { createDebugOverlay, loadTurnstile, renderChrome, renderIntro, renderMessage, renderNarrowNotice } from "./demo-ui.js";
import type { DemoGate } from "./gate.js";
import type { DemoConfig, DemoLimit, DemoSession, Emit, SeedFile, VoiceRuntime, WebHost } from "./types.js";

declare global {
  interface Window {
    /** ?e2e=1 on localhost only: samples fed here take the microphone's path to the voice controller. */
    __moolaiE2E?: { feed(samples: Float32Array, sampleRate: number): void };
  }
}

/** The desktop's host-specific lines, worded for the web (apps/desktop/src/main.tsx hostText). */
const WEB_TEXT: Partial<Record<HostTextKey, string>> = {
  fixtureBanner: "Fixture mode: the live demo is unavailable right now, so replies are simulated. Watch the video to see Moo live.",
  connecting: "Starting Moo…",
  reconnecting: "Reconnecting… Your draft stays here.",
  speaking: "Moo is speaking · press Stop speech to interrupt",
  screenOffer: "Would you like help with your saved doubt? In this web demo Moo looks at the sample worksheet, not your screen.",
  footerSaved: "Nothing is saved · refresh to start over",
  footerEmpty: "Nothing is saved · refresh to start over",
};
/** Lasting banners: the renderer's own notices hide after 8 s, and it hides "Backend 5xx" ones altogether. */
const LIMITS: Record<DemoLimit, string> = {
  budget_exhausted: "Today's live budget for this demo is used up. Refresh to keep exploring in fixture mode, or watch the video.",
  session_limit: "This demo session has reached its limit. Refresh to start a new one.",
  session_expired: "This demo session has expired. Refresh to continue.",
  unavailable: "The live demo is unavailable right now. Refresh to explore in fixture mode.",
  voice_unavailable: "Moo's voice and listening are unavailable right now. You can keep typing.",
};
const UNSUPPORTED = "Use a recent Chrome, Edge, Firefox or Safari 17.4+.";
const MIC_UNAVAILABLE = "The microphone isn't available (permission or device). You can still type.";
const NOT_STARTED = "Moolai's web demo couldn't start. Refresh the page to try again.";

/** An error whose message is written for the visitor. */
class Readable extends Error {}

/** What the Agent needs before any of it loads: AbortSignal.any (providers.ts), crypto.subtle (evidence.ts), regex
 * lookbehind (index.ts), and crypto.randomUUID for every ID. */
function capable() {
  try {
    return typeof AbortSignal.any === "function" && typeof crypto.randomUUID === "function" && !!crypto.subtle
      && new RegExp("(?<=a)b").test("ab");
  } catch {
    return false;
  }
}

/** Loaded only after the check: a browser without lookbehind cannot even parse a module that contains one. */
async function load() {
  const [memory, providers, bridge, gate, host, seed, speech, controller, mic] = await Promise.all([
    import("../../../packages/brain/src/memory.js"), import("../../../packages/agent-host/src/providers.js"),
    import("./bridge.js"), import("./gate.js"), import("./host.js"), import("./seed.js"), import("./speech.js"),
    import("./voice/controller.js"), import("./voice/mic.js"),
  ]);
  return { ...memory, ...providers, ...bridge, ...gate, ...host, ...seed, ...speech, ...controller, ...mic };
}
type Modules = Awaited<ReturnType<typeof load>>;

/** public/seed.json, written once by apps/web/scripts/generate-seed.ts: the two sample sessions. */
async function loadSeed(m: Modules, baseFetch: typeof fetch): Promise<SeedFile> {
  let response: Response;
  try {
    // JSON only, so a dev server answers a missing file with 404, not its HTML page.
    response = await baseFetch("/seed.json", { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new Readable("The demo's sample notes couldn't be loaded. Check your connection, then refresh the page.", { cause: error });
  }
  if (response.status === 404) throw new Readable("This copy of the demo is missing its sample notes (seed.json), so it can't start.");
  try {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return m.parseSeed(await response.json());
  } catch (error) {
    throw new Readable("The demo's sample notes couldn't be read, so it can't start.", { cause: error });
  }
}

/** What "your screen" means in this demo: the one image the gateway lets vision read. */
async function worksheet(baseFetch: typeof fetch) {
  const response = await baseFetch("/sample-worksheet.png");
  if (!response.ok) throw new Error(`The sample worksheet is unavailable: HTTP ${response.status}`);
  return { mimeType: "image/png", bytes: new Uint8Array(await response.arrayBuffer()) };
}

function voiceRuntime(m: Modules, gate: DemoGate, ctx: AudioContext | undefined, options: { e2e: boolean; root: HTMLElement; debug: boolean }): VoiceRuntime {
  const feed = options.e2e ? m.createE2EFeed() : undefined;
  if (feed) window.__moolaiE2E = { feed: (samples, sampleRate) => feed.feed(samples, sampleRate) };
  const debug = options.debug ? createDebugOverlay(options.root) : undefined;
  return {
    open: feed ? feed.open : ctx ? m.openMicrophone(ctx, "/voice-worklet.js")
      : () => Promise.reject(new Error("This browser couldn't start audio capture")),
    createController: controllerOptions => m.createVoiceController({ ...controllerOptions, onActivity: activity => {
      controllerOptions.onActivity?.(activity);
      debug?.(activity);
    } }),
    transcribe: m.createTranscriber(gate),
  };
}

async function main() {
  const root = document.getElementById("demo")!;
  if (!capable()) return renderMessage(root, UNSUPPORTED);
  renderNarrowNotice(root);
  const intro = renderIntro(root);
  const params = new URLSearchParams(location.search);
  // Unwrapped, and taken before the gate replaces fetch: config, sessions and the page's own files never go through it.
  const baseFetch = fetch.bind(globalThis);
  let m: Modules, config: DemoConfig, seed: SeedFile;
  try {
    m = await load();
    [config, seed] = await Promise.all([m.getDemoConfig(baseFetch), loadSeed(m, baseFetch)]);
  } catch (error) {
    console.error(error);
    return intro.fail(error instanceof Readable ? error.message : NOT_STARTED);
  }
  const live = config.live;
  const audio = new Audio();
  let ctx: AudioContext | undefined, token: string | undefined, widget: string | undefined;
  let starting = false, failure = "";

  const check = intro.offer(config, voice => {
    if (starting || (live && !token)) return;
    starting = true;
    intro.ready(false);
    intro.status("Starting Moo…");
    // Synchronously, inside the click: browsers start audio only with the visitor's gesture.
    if (live) {
      try {
        if (!ctx) ctx = new AudioContext();
        void ctx.resume().catch(() => {});
      } catch (error) {
        console.error(`Audio could not start: ${String(error)}`);
      }
      m.unlockAudio(audio);
    }
    void launch(voice);
  });
  if (live) {
    intro.status("Complete the check above to start.");
    loadTurnstile().then(turnstile => {
      widget = turnstile.render(check, {
        sitekey: config.turnstileSiteKey, action: "moolai-demo", theme: "light",
        callback: value => {
          token = value;
          if (starting) return;
          intro.ready(true);
          intro.status(failure, !!failure);
        },
        "expired-callback": () => {
          token = undefined;
          if (!starting) { intro.ready(false); intro.status("The check expired. It renews by itself in a moment."); }
        },
        "error-callback": () => {
          token = undefined;
          if (!starting) { intro.ready(false); intro.status("The bot check didn't work. Refresh the page to try again.", true); }
        },
      });
    }).catch(error => {
      console.error(error);
      intro.status("The bot check couldn't load. Check your connection, then refresh the page.", true);
    });
  } else {
    intro.ready(true);
    intro.status("");
  }

  async function launch(voice: boolean) {
    let session: DemoSession | undefined;
    if (live) {
      try {
        session = await m.openDemoSession(baseFetch, token!);
      } catch (error) {
        console.error(error);
        // The gateway spends a check's token when it verifies it, so trying again needs a fresh check.
        token = undefined;
        starting = false;
        failure = error instanceof Error ? error.message : NOT_STARTED;
        intro.status(failure, true);
        if (widget !== undefined) window.turnstile?.reset(widget);
        return;
      }
    }
    try {
      await run(voice, session);
    } catch (error) {
      console.error(error);
      renderMessage(root, error instanceof Readable ? error.message : NOT_STARTED);
    }
  }

  async function run(voice: boolean, session: DemoSession | undefined) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const brain = new m.MemoryBrain();
    await m.importSeed(brain, m.shiftIsoTimestamps(seed, m.seedOffsetMs(seed, new Date(), timeZone)));
    const chrome = renderChrome(root, { live, voice: live && config.voice });
    // The renderer reads every /api/voice failure as a microphone problem, so its button goes once voice can't work.
    const voiceOff = () => document.body.classList.add("voice-off");
    let host: WebHost | undefined, toBridge: Emit = () => {};
    const gate = session && m.createDemoGate({
      origin: location.origin, baseFetch, token: () => session.token,
      onLimit: (limit: DemoLimit) => {
        host?.onLimit(limit);
        chrome.banner(LIMITS[limit]);
        voiceOff();
      },
    });
    if (gate) m.installDemoFetch(gate);
    const runtime = gate && config.voice
      ? voiceRuntime(m, gate, ctx, { e2e: params.has("e2e") && ["localhost", "127.0.0.1"].includes(location.hostname), root, debug: params.get("debug") === "1" })
      : undefined;
    if (!runtime) voiceOff();
    const web = await m.createWebHost({
      brain,
      providers: gate ? new m.BackendProviders(location.origin, "web-demo") : new m.FixtureProviders(),
      emit: event => toBridge(event),
      speech: m.createWebSpeech({ audio, synthesize: gate ? m.createSynthesizer(gate) : () => Promise.reject(new Error("Moo's voice is off in fixture mode")) }),
      worksheet: () => worksheet(baseFetch),
      onWorksheet: () => chrome.openWorksheet(),
      voice: runtime,
      timeZone,
    });
    host = web;
    const bridge = m.createBridge({
      agent: web.agent, brain, mode: gate ? "live" : "fixture",
      voice: action => web.voice(action),
      nativeSnapshot: () => web.nativeSnapshot(),
      processing: () => gate ? gate.processing() : { status: "available" },
      text: () => WEB_TEXT,
      open: url => void window.open(url, "_blank", "noopener"),
    });
    toBridge = bridge.emit;
    // The api object itself: its `text` is a getter.
    window.moolai = bridge.api;
    await web.agent.startSession();
    // Removed, the check's widget stops renewing its token in the background; failing to remove it costs nothing more.
    try {
      if (widget !== undefined) window.turnstile?.remove(widget);
    } catch (error) {
      console.error(error);
    }
    intro.close();
    await import("../../desktop/src/main.tsx");
    if (!voice || !runtime) return;
    try {
      await bridge.api.request("POST", "/api/voice", { action: "start" });
    } catch (error) {
      console.error(error);
      chrome.banner(MIC_UNAVAILABLE, true);
      voiceOff();
    }
  }
}

void main();
