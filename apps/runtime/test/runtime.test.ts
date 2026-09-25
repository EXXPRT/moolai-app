import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Agent } from "../../../packages/agent/src/index.js";
import type {
  AgentEvent,
  AgentState,
  RecordPatch,
  LocalFilesPort,
} from "../../../packages/contracts/src/index.js";
import { MemoryBrain } from "../../../packages/brain/src/index.js";
import { createRuntimeServer } from "../src/server.js";
import { BackendProviders, FixtureProviders } from "../src/providers.js";
import { NativeBridge } from "../src/native.js";

const token = "test-runtime-token";
const state: AgentState = { listening: false, busy: false, webAllowed: true };

async function runtime(localFiles?: LocalFilesPort) {
  const actions: { name: string; value?: unknown }[] = [];
  const brain = new MemoryBrain();
  const agent = {
    getState: () => state,
    startSession: async () => {
      actions.push({ name: "session-start" });
    },
    stopSession: async () => {
      actions.push({ name: "session-stop" });
    },
    checkpointConversation: async () => {
      actions.push({ name: "checkpoint" });
    },
    submitText: async (text: string) => {
      actions.push({ name: "input", value: text });
    },
    requestEnd: async () => {
      actions.push({ name: "end" });
    },
    resolveEnd: async (action: string) => {
      actions.push({ name: "resolve", value: action });
    },
    setSubject: async (subject: string) => {
      actions.push({ name: "subject", value: subject });
    },
    retryPending: async (id?: string) => {
      actions.push({ name: "retry", value: id });
    },
    stopSpeech: async () => {
      actions.push({ name: "speech-stop" });
    },
    editRecord: async (id: string, revision: number, patch: RecordPatch) => {
      actions.push({ name: "edit", value: { id, revision, patch } });
      return { id, revision, ...patch };
    },
  } as unknown as Agent;
  const host = createRuntimeServer({
    agent,
    brain,
    localFiles,
    token,
    mode: "fixture",
    voice: async (action) => {
      actions.push({ name: "voice", value: action });
    },
    nativeHealth: async () => ({ status: "test" }),
    nativeSnapshot: () => ({
      listening: false,
      speaking: false,
      error: "permission pending",
    }),
  });
  await new Promise<void>((resolve, reject) => {
    host.server.once("error", reject);
    host.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  return {
    ...host,
    base,
    actions,
    brain,
    post: (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    close: async () => {
      host.server.closeAllConnections();
      await new Promise<void>((resolve) => host.server.close(() => resolve()));
      await brain.close();
    },
  };
}

test("runtime requires the exact bearer token and reports its explicit mode/native status", async () => {
  const host = await runtime();
  try {
    for (const authorization of ["", "Bearer invalid", `Bearer ${token}x`]) {
      const result = await fetch(host.base + "/api/state", {
        headers: { Authorization: authorization },
      });
      assert.equal(result.status, 401);
      assert.match(await result.text(), /authentication required/);
    }
    const result = await fetch(host.base + "/api/state", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(result.status, 200);
    const snapshot = (await result.json()) as {
      mode: string;
      native: { listening: boolean; error: string };
      localFolders: unknown[];
    };
    assert.equal(snapshot.mode, "fixture");
    assert.equal(snapshot.native.listening, false);
    assert.equal(snapshot.native.error, "permission pending");
    assert.deepEqual(snapshot.localFolders, []);
    assert.equal(result.headers.get("cache-control"), "no-store");
  } finally {
    await host.close();
  }
});

test("explicit microphone stop checkpoints after capture stops; flush and speech stop do not", async () => {
  const host = await runtime();
  try {
    for (const action of ["start", "flush", "stop"])
      assert.equal((await host.post("/api/voice", { action })).status, 200);
    assert.equal((await host.post("/api/speech/stop", {})).status, 200);
    assert.deepEqual(host.actions, [
      { name: "voice", value: "start" },
      { name: "voice", value: "flush" },
      { name: "voice", value: "stop" },
      { name: "checkpoint" },
      { name: "speech-stop" },
    ]);
    assert.equal((await host.post("/api/session", { action: "stop" })).status, 200);
    assert.deepEqual(host.actions.slice(-2), [
      { name: "voice", value: "stop" }, { name: "session-stop" },
    ]);
  } finally { await host.close(); }
});

test("folder access has no defaults, validates requests and reflects revocation", async () => {
  const folders: { id: string; name: string; path: string }[] = [];
  const files = {
    roots: async () => [...folders],
    grant: async (path: string) => {
      const folder = { id: "chosen-folder", name: "Selected notes", path };
      folders.push(folder);
      return folder;
    },
    revoke: async (id: string) => {
      const index = folders.findIndex((folder) => folder.id === id);
      if (index >= 0) folders.splice(index, 1);
    },
  } as LocalFilesPort;
  const host = await runtime(files);
  const get = () => fetch(host.base + "/api/local-folders", {
    headers: { Authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  try {
    assert.deepEqual(await get(), []);
    assert.equal((await host.post("/api/local-folders/grant", { path: [] })).status, 400);
    assert.equal((await host.post("/api/local-folders/revoke", { id: "" })).status, 400);
    assert.deepEqual(folders, []);
    const granted = await host.post("/api/local-folders/grant", { path: "/selected/notes" });
    assert.equal(granted.status, 200);
    assert.equal((await granted.json()).id, "chosen-folder");
    assert.equal((await get()).length, 1);
    assert.equal((await host.post("/api/local-folders/revoke", { id: "chosen-folder" })).status, 200);
    assert.deepEqual(await get(), []);
  } finally { await host.close(); }
});

test("runtime rejects malformed action/edit bodies before changing Agent state", async () => {
  const host = await runtime();
  try {
    const invalid: [string, unknown][] = [
      ["/api/input", { text: 123 }],
      ["/api/input", { text: "x".repeat(60001) }],
      ["/api/subject", { subject: [] }],
      ["/api/voice", { action: "record-forever" }],
      ["/api/end/resolve", { action: "discard-everything" }],
      ["/api/retry", { recordId: {} }],
      ["/api/record/note", { revision: -1, patch: { summary: "text" } }],
      ["/api/record/note", { revision: 1, patch: { summary: 42 } }],
      ["/api/record/note", { revision: 1, patch: { title: {} } }],
      ["/api/record/note", { revision: 1, patch: { topics: [false] } }],
      ["/api/record/note", { revision: 1, patch: { purpose: "Bad" } }],
      ["/api/record/note", { revision: 1, patch: { segments: [] } }],
      ["/api/record/note", { revision: 1, patch: {} }],
    ];
    for (const [path, body] of invalid)
      assert.equal(
        (await host.post(path, body)).status,
        400,
        JSON.stringify(body),
      );
    const malformed = await fetch(host.base + "/api/input", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{invalid",
    });
    assert.equal(malformed.status, 400);
    assert.equal(host.actions.length, 0);
    assert.equal(
      (
        await host.post("/api/record/note", {
          revision: 2,
          patch: {
            title: "A title",
            summary: "Saved text",
            topics: ["Gardening"],
            purpose: "Idea",
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (await host.post("/api/voice", { action: "flush" })).status,
      200,
    );
    assert.equal(host.actions[0]?.name, "edit");
    assert.deepEqual(host.actions[1], { name: "voice", value: "flush" });
  } finally {
    await host.close();
  }
});

test("runtime SSE delivers valid initial state and serialized Agent events", async () => {
  const host = await runtime();
  const controller = new AbortController();
  try {
    const response = await fetch(host.base + "/api/events", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.deepEqual(JSON.parse(initial.replace(/^data: /, "").trim()), {
      type: "state",
      state,
    });
    const event: AgentEvent = {
      type: "notice",
      message: "Source saved\nEnrichment pending",
    };
    host.emit(event);
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.deepEqual(JSON.parse(next.replace(/^data: /, "").trim()), event);
    await reader.cancel();
  } finally {
    controller.abort();
    await host.close();
  }
});

test("live provider errors remain errors and never fall back to fixtures", async (t) => {
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests++;
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer backend-token",
      );
      return new Response(JSON.stringify({ detail: "Model unavailable" }), {
        status: 503,
      });
    },
  );
  const backend = new BackendProviders(
    "http://127.0.0.1:8000",
    "backend-token",
  );
  await assert.rejects(
    backend.route({
      text: "Moo",
      recentContext: "",
      activeConversation: false,
    }),
    /Backend 503: Model unavailable/,
  );
  assert.equal(requests, 1);
  const unconfigured = new BackendProviders("http://127.0.0.1:8000", "");
  await assert.rejects(
    unconfigured.route({
      text: "Moo",
      recentContext: "",
      activeConversation: false,
    }),
    /not configured/,
  );
  assert.equal(requests, 1);
});

test("explicit fixture providers label generated output and perform no fetches", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network access");
  });
  const fixture = new FixtureProviders();
  assert.match(
    (await fixture.respond([{ role: "user", content: "Moo, explain this." }]))
      .text,
    /Fixture response — no AI inference/,
  );
  assert.match(
    (await fixture.search("orchids"))[0]!.content,
    /no web search was performed/,
  );
  assert.match(await fixture.interpret(), /screenshot was not analyzed/);
});

async function companion() {
  const directory = await mkdtemp(join(tmpdir(), "moolai-protocol-"));
  const path = join(directory, "companion.mjs");
  await writeFile(
    path,
    `#!${process.execPath}\nimport {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{\n const request=JSON.parse(line);\n if(request.method==='wait')return;\n if(request.method==='exit'){process.exit(7);return;}\n if(request.method==='malformed'){console.log('bad json');return;}\n if(request.method==='event')console.log(JSON.stringify({event:'status',listening:false}));\n if(request.method==='reject'){console.log(JSON.stringify({id:request.id,error:'Permission not granted'}));return;}\n console.log(JSON.stringify({id:request.id,result:{echo:request.params}}));\n});\n`,
    { mode: 0o700 },
  );
  return { directory, path };
}

test("native request timeouts and protocol errors do not corrupt later responses", async () => {
  const fixture = await companion();
  const events: { event: string; [key: string]: unknown }[] = [];
  const timeouts = { request: 5000 };
  const bridge = new NativeBridge(
    fixture.path,
    (event) => events.push(event),
    timeouts,
  );
  try {
    assert.deepEqual(await bridge.request("echo", { word: "hello" }), {
      echo: { word: "hello" },
    });
    // Process launch can be slower under the full suite; only the deliberate stalls use a short timeout.
    timeouts.request = 500;
    await assert.rejects(bridge.request("reject"), /Permission not granted/);
    await assert.rejects(bridge.request("wait"), /timed out/);
    await assert.rejects(bridge.request("malformed"), /timed out/);
    assert.ok(events.some((event) => event.event === "error"));
    await bridge.request("event");
    assert.ok(
      events.some(
        (event) => event.event === "status" && event.listening === false,
      ),
    );
    assert.deepEqual(await bridge.request("echo", { after: "timeout" }), {
      echo: { after: "timeout" },
    });
  } finally {
    bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("native process exit, missing executable and close reject pending requests promptly", async () => {
  const fixture = await companion();
  const bridge = new NativeBridge(fixture.path, () => {}, { request: 1000 });
  try {
    await assert.rejects(bridge.request("exit"), /exited \(7\)/);
    // Restart is possible after exit, and closing rejects an in-flight request immediately.
    assert.deepEqual(await bridge.request("echo"), { echo: {} });
    const pending = bridge.request("wait");
    bridge.close();
    await assert.rejects(pending, /closed/);
    assert.deepEqual(await bridge.request("echo"), { echo: {} });
    const missing = new NativeBridge(
      join(fixture.directory, "missing"),
      () => {},
      { request: 1000 },
    );
    await assert.rejects(missing.request("health"), /unavailable/);
    missing.close();
  } finally {
    bridge.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
