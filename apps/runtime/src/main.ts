import { randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteBrain } from "../../../packages/brain/src/index.js";
import { LocalFiles } from "../../../packages/local-files/src/index.js";
import type { AgentEvent } from "../../../packages/contracts/src/index.js";
import { BackendProviders, FixtureProviders } from "./providers.js";
import { createAgentHost } from "../../../packages/agent-host/src/index.js";
import { createRuntimeServer } from "./server.js";
import { captureOptions } from "./capture-options.js";
import { acquireRuntimeOwnership } from "./ownership.js";
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
const ownership = acquireRuntimeOwnership(dir);
const brain = new SQLiteBrain(dir);
// Folder grants belong to this host, not to portable Brain records. Local-folder search is off in the
// submitted build; MOOLAI_LOCAL_FOLDERS=on enables it for development.
const localFiles = process.env.MOOLAI_LOCAL_FOLDERS === "on" ? new LocalFiles(
  path.join(dir, "local-folders.json"),
  process.env.MOOLAI_RG_PATH,
) : undefined;
let emit = (event: AgentEvent) => {};
const host = await createAgentHost({
  brain,
  localFiles,
  providers,
  nativePath:
    process.env.MOOLAI_NATIVE_PATH ??
    path.join(
      root,
      "native/build/Moolai Native.app/Contents/MacOS/MoolaiNative",
    ),
  ...captureOptions(mode),
  onEvent: (event) => emit(event),
});
const { agent } = host;
const token = randomBytes(32).toString("hex");
const runtime = createRuntimeServer({
  agent,
  brain,
  localFiles,
  token,
  mode,
  processingStatus: () => providers.processingStatus(),
  voice: host.voice,
  ownerLost: host.revokeVoice,
  nativeHealth: host.nativeHealth,
  nativeSnapshot: host.nativeSnapshot,
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
  void shutdown(1);
});
let closing = false;
async function shutdown(exitCode=0) {
  if (closing) return;
  closing = true;
  // Shutdown can never outlast start-moo's wait or the macOS logout grace.
  setTimeout(() => {
    try { ownership.release(); } catch {}
    try { unlinkSync(path.join(dir, "runtime.json")); } catch {}
    process.exit(exitCode || 1);
  }, 20000).unref();
  runtime.server.closeAllConnections();
  runtime.server.close();
  await host.close();
  await brain.close();
  await unlink(path.join(dir, "runtime.json")).catch(() => {});
  ownership.release();
  process.exit(exitCode);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
