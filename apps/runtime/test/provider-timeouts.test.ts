import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ORGANIZATION_TIMEOUT_MS } from "../../../packages/agent-host/src/providers.js";

test("the client waits longer for the organizer than the backend does, so a long generation reports its own error", async () => {
  const backend = await readFile(new URL("../../../backend/moolai_backend/providers.py", import.meta.url), "utf8");
  const seconds = Number(/^ORGANIZATION_TIMEOUT_SECONDS = ([\d.]+)/m.exec(backend)?.[1]);
  assert.ok(seconds >= 120, "A 16,384-token organizer generation takes about 80 s");
  assert.ok(ORGANIZATION_TIMEOUT_MS > seconds * 1000);
});
