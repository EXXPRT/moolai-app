import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BackendProviders, ORGANIZATION_TIMEOUT_MS, VISION_TIMEOUT_MS } from "../../../packages/agent-host/src/providers.js";

test("the client waits longer for the organizer than the backend does, so a long generation reports its own error", async () => {
  const backend = await readFile(new URL("../../../backend/moolai_backend/providers.py", import.meta.url), "utf8");
  const seconds = Number(/^ORGANIZATION_TIMEOUT_SECONDS = ([\d.]+)/m.exec(backend)?.[1]);
  assert.ok(seconds >= 120, "A 16,384-token organizer generation takes about 80 s");
  assert.ok(ORGANIZATION_TIMEOUT_MS > seconds * 1000);
});

test("a screen reading gives up before the old 90 s limit, and the backend's own limit comes first (23-24 Oct)", async (t) => {
  const backend = await readFile(new URL("../../../backend/moolai_backend/providers.py", import.meta.url), "utf8");
  const seconds = Number(/^VISION_TIMEOUT_SECONDS = ([\d.]+)/m.exec(backend)?.[1]);
  assert.ok(seconds * 1000 < VISION_TIMEOUT_MS && VISION_TIMEOUT_MS < 90_000, `backend ${seconds} s, host ${VISION_TIMEOUT_MS} ms`);
  const timeout = t.mock.method(AbortSignal, "timeout");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ text: "Sample A minimum 12 kPa." })));
  const read = await new BackendProviders("http://127.0.0.1:8000", "backend-token").interpret({ mimeType: "image/png", dataBase64: "AQID" }, "Read the table.");
  assert.equal(read, "Sample A minimum 12 kPa.");
  assert.deepEqual(timeout.mock.calls.map(call => call.arguments[0]), [VISION_TIMEOUT_MS], "interpret() uses the screen-reading limit");
});
