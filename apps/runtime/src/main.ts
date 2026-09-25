import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteBrain } from "../../../packages/brain/src/index.js";
import { LocalFiles } from "../../../packages/local-files/src/index.js";
import { Agent } from "../../../packages/agent/src/index.js";
import type { AgentEvent } from "../../../packages/contracts/src/index.js";
import { BackendProviders, FixtureProviders } from "./providers.js";
import { NativeBridge } from "./native.js";
import { NativeInput, retainAsrDiagnostic } from "./native-input.js";
import { createRuntimeServer } from "./server.js";
import { readAsrConfig } from "../../../scripts/asr-config.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
if (!process.env.MOOLAI_ASR_URL) {
  const asr = await readAsrConfig(root);
  process.env.MOOLAI_ASR_URL = `ws://127.0.0.1:${asr.port}/v1/audio/transcriptions/realtime`;
}
const dir =
  process.env.MOOLAI_DATA_DIR ??
  path.join(homedir(), "Library/Application Support/Moolai");
await mkdir(dir, { recursive: true, mode: 0o700 });
const mode = process.env.MOOLAI_MODE ?? "live";
if (!["live", "fixture"].includes(mode))
  throw new Error("MOOLAI_MODE must be live or fixture");
// The runtime reads its own token only; backend/.env belongs exclusively to Python.
const backendToken = process.env.MOOLAI_BACKEND_TOKEN ?? "";
const providers =
  mode === "fixture"
    ? new FixtureProviders()
    : new BackendProviders(
        process.env.MOOLAI_BACKEND_URL ?? "http://127.0.0.1:8000",
        backendToken,
      );
const brain = new SQLiteBrain(dir);
// Folder grants belong to this host, not to portable Brain records.
const localFiles = new LocalFiles(
  path.join(dir, "local-folders.json"),
  process.env.MOOLAI_RG_PATH,
);
let emit = (event: AgentEvent) => {};
let voiceEnabled = false;
const nativeInput = new NativeInput(
  {
    ingest: (segment) => agent.ingest(segment),
    settleTurn: (turnId) => agent.settleTurn(turnId),
    async retainDiagnostic(text, message) {
      const record = await retainAsrDiagnostic(brain, text, message);
      emit({ type: "record", record });
      emit({ type: "notice", message: `${message} The unconfirmed transcript was saved for review.` });
    },
  },
  (error) => emit({ type: "notice", message: String(error) }),
);
let nativeStatus: { listening: boolean; speaking: boolean; phase?: string; error?: string } = {
  listening: false,
  speaking: false,
};
const native = new NativeBridge(
  process.env.MOOLAI_NATIVE_PATH ??
    path.join(
      root,
      "native/build/Moolai Native.app/Contents/MacOS/MoolaiNative",
    ),
  (event) => {
    if (event.event === "transcript" && event.segment)
      nativeInput.ingest(event.segment);
    if (event.event === "turn_end" && event.turnId)
      nativeInput.settleTurn(event.turnId);
    if (event.event === "asr_diagnostic" && typeof event.text === "string")
      nativeInput.retainDiagnostic(event.text, String(event.message ?? "Speech recognition needs review"));
    if (event.event === "error")
      emit({
        type: "notice",
        message: String(event.message ?? event.error ?? "Native error"),
      });
    if (event.event === "status") {
      nativeStatus = {
        listening: event.listening === true,
        speaking: event.speaking === true,
        ...(event.phase ? { phase: String(event.phase) } : {}),
        ...(event.error ? { error: String(event.error) } : {}),
      };
      if (event.error) emit({ type: "notice", message: String(event.error) });
      // The renderer refreshes this snapshot on state events. Session state and microphone state are distinct.
      emit({ type: "state", state: agent.getState() });
    }
  },
);
const agent = new Agent({
  brain,
  localFiles,
  decisions: providers,
  generation: providers,
  search: providers,
  vision: providers,
  capture: {
    async capture() {
      const result = await native.request<{
        mimeType: string;
        dataBase64: string;
      }>("capture");
      return {
        mimeType: result.mimeType,
        bytes: Buffer.from(result.dataBase64, "base64"),
      };
    },
  },
  speech: {
    async speak(text) {
      if (voiceEnabled) await native.request("speak", { text });
    },
    async stop() {
      if (voiceEnabled) await native.request("stopSpeaking");
    },
  },
  acceptance: providers instanceof BackendProviders ? providers : undefined,
  id: randomUUID,
  now: () => new Date().toISOString(),
  onEvent: (event) => emit(event),
});
await agent.initialize();
const token = randomBytes(32).toString("hex");
const runtime = createRuntimeServer({
  agent,
  brain,
  localFiles,
  token,
  mode,
  async voice(action) {
    if (action === "start") {
      await agent.startSession();
      await native.request("startListening");
      voiceEnabled = true;
    } else if (action === "flush") {
      if (voiceEnabled) {
        try { await native.request("flushListening"); }
        finally { await nativeInput.saved(); }
        await nativeInput.settled();
      }
    } else if (voiceEnabled) {
      try { await native.request("stopListening"); }
      finally { await nativeInput.saved(); voiceEnabled = false; }
      // Settle the last routed turn before the host checkpoints its conversation.
      // Generation is scheduled independently and is not awaited here.
      await nativeInput.settled();
    }
    return { voiceEnabled };
  },
  nativeHealth: () => native.request("health"),
  nativeSnapshot: () => ({ ...nativeStatus, enabled: voiceEnabled }),
});
emit = runtime.emit;
const port = Number(process.env.MOOLAI_PORT ?? 4317);
runtime.server.listen(port, "127.0.0.1", async () => {
  await writeFile(
    path.join(dir, "runtime.json"),
    JSON.stringify({ port, token, pid: process.pid, mode }),
    { mode: 0o600 },
  );
  console.log(`Moolai Agent runtime: http://127.0.0.1:${port} (${mode})`);
  if (mode === "fixture")
    console.log(
      "FIXTURE MODE: generated content is simulated; no model or web calls.",
    );
});
runtime.server.on("error", (error) => {
  console.error(error.message);
  native.close();
  void brain.close();
  process.exitCode = 1;
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    if (voiceEnabled) await native.request("stopListening");
  } catch (e) {
    console.error(String(e));
  }
  // Stop Agent speech hooks from lazily respawning the companion during shutdown.
  voiceEnabled = false;
  native.close();
  // Error diagnostics can arrive immediately before a failed Stop response.
  // Drain those durable writes even when transcription could not be confirmed.
  await nativeInput.saved();
  await nativeInput.settled();
  await agent.stopSession().catch((e) => console.error(String(e)));
  runtime.server.closeAllConnections();
  runtime.server.close();
  await Promise.race([
    agent.drain(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await brain.close();
  await unlink(path.join(dir, "runtime.json")).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
