import test from "node:test";
import assert from "node:assert/strict";
import { BackendProviders } from "../../../packages/agent-host/src/providers.js";
import { createDemoGate, createSynthesizer, createTranscriber, getDemoConfig, installDemoFetch, openDemoSession } from "../src/gate.js";
import type { DemoLimit } from "../src/types.js";

const origin = "https://moolai-demo.vercel.app";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const route = { text: "Osmosis moves water toward more solute.", recentContext: "", activeConversation: false };

/** A gate over a fake network that records each request it is sent. */
function rig(reply: (request: Request) => Response | Promise<Response> = () => json(200, { ok: true })) {
  const requests: Request[] = [], limits: [DemoLimit, string][] = [];
  let token: string | undefined = "v1.first";
  const gate = createDemoGate({
    origin, token: () => token, onLimit: (limit, detail) => { limits.push([limit, detail]); },
    baseFetch: async (input, init) => { const request = new Request(input, init); requests.push(request); return reply(request); },
  });
  return { gate, requests, limits, setToken(next?: string) { token = next; } };
}

test("same-origin /v1 calls go to /api/v1 with the session's current token, keeping method, headers and body", async () => {
  const r = rig();
  await r.gate.fetch(new URL("/v1/route", origin), { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixed" }, body: JSON.stringify(route) });
  r.setToken("v1.second");
  await r.gate.fetch(`${origin}/v1/tag`, { method: "POST", headers: { authorization: "Bearer fixed" }, body: "{}" });
  r.setToken(undefined);
  await r.gate.fetch(new Request(`${origin}/v1/connect`, { method: "POST", headers: { Authorization: "Bearer fixed" }, body: "{}" }));
  const [first, second, third] = r.requests;
  assert.equal(first!.url, `${origin}/api/v1/route`);
  assert.equal(first!.method, "POST");
  assert.equal(first!.headers.get("authorization"), "Bearer v1.first");
  assert.equal(first!.headers.get("content-type"), "application/json");
  assert.deepEqual(await first!.json(), route);
  assert.equal(second!.url, `${origin}/api/v1/tag`);
  assert.equal(second!.headers.get("authorization"), "Bearer v1.second");
  assert.equal(third!.url, `${origin}/api/v1/connect`);
  assert.equal(third!.headers.get("authorization"), null, "Without a session no token is sent, never the providers' fixed one");
});

test("the health check is answered locally, and other requests pass through untouched", async () => {
  const r = rig(() => json(503, { detail: "demo_budget_exhausted" }));
  const health = await r.gate.fetch(new URL("/health", origin), { method: "GET", cache: "no-store" });
  assert.deepEqual(await health.json(), { status: "ok", service: "moolai-backend" });
  assert.equal(r.requests.length, 0, "No network call for /health");
  await r.gate.fetch(`${origin}/api/demo/config`);
  await r.gate.fetch(`${origin}/seed.json`);
  await r.gate.fetch("https://challenges.cloudflare.com/turnstile/v0/api.js", { headers: { Authorization: "Bearer other" } });
  await r.gate.fetch("https://elsewhere.example/v1/route", { method: "POST", body: "{}" });
  assert.deepEqual(r.requests.map(request => request.url), [`${origin}/api/demo/config`, `${origin}/seed.json`,
    "https://challenges.cloudflare.com/turnstile/v0/api.js", "https://elsewhere.example/v1/route"]);
  assert.equal(r.requests[2]!.headers.get("authorization"), "Bearer other");
  assert.deepEqual(r.limits, [], "Only gateway calls the gate made can report a limit");
  assert.deepEqual(r.gate.processing(), { status: "available" });
});

test("each limit is reported once, makes processing unavailable, and leaves the response readable", async () => {
  const replies: Response[] = [json(401, { detail: "invalid_session" }), json(401, { detail: "session_expired" }),
    json(503, { detail: "Model provider unavailable" }), json(429, { detail: "session_rate_limited" }), json(503, { detail: "demo_budget_exhausted" })];
  const r = rig(() => replies.shift() ?? json(503, { detail: "demo_unavailable" }));
  const providers = new BackendProviders(origin, "placeholder");
  const uninstall = installDemoFetch(r.gate);
  try {
    // The Agent still sees the gateway's own error, as BackendProviders reads it.
    await assert.rejects(providers.route(route), /^Error: Backend 401: invalid_session$/);
    assert.deepEqual(r.limits, [["session_expired", "invalid_session"]]);
    assert.equal(r.gate.limit, "session_expired");
    assert.equal(r.gate.processing().status, "unavailable");
    await assert.rejects(providers.route(route), /Backend 401: session_expired/);
    await assert.rejects(providers.route(route), /Backend 503: Model provider unavailable/);
    assert.equal(r.limits.length, 1, "A repeated kind and a backend's own 503 report nothing");
    await assert.rejects(providers.route(route), /Backend 429/);
    await assert.rejects(providers.route(route), /Backend 503/);
    await assert.rejects(providers.route(route), /Backend 503/);
    assert.deepEqual(r.limits, [["session_expired", "invalid_session"], ["session_limit", "session_rate_limited"],
      ["budget_exhausted", "demo_budget_exhausted"], ["unavailable", "demo_unavailable"]]);
    assert.equal(r.requests.length, 6, "Nothing is retried");
    const health = await r.gate.fetch(new URL("/health", origin));
    assert.equal(health.status, 503, "BackendProviders' own health check agrees with the gate");
  } finally { uninstall(); }
});

test("an unavailable voice is reported but keeps typed processing available", async () => {
  const r = rig(() => json(503, { detail: "voice_unavailable" }));
  const transcribe = createTranscriber(r.gate);
  await assert.rejects(transcribe(new Uint8Array([1, 2]), "Moo.", new AbortController().signal), /Transcription failed: HTTP 503 voice_unavailable/);
  await assert.rejects(createSynthesizer(r.gate)("Hello.", new AbortController().signal), /Speech failed: HTTP 503 voice_unavailable/);
  assert.deepEqual(r.limits, [["voice_unavailable", "voice_unavailable"]]);
  assert.equal(r.gate.limit, "voice_unavailable");
  assert.deepEqual(r.gate.processing(), { status: "available" });
});

test("one endpoint's used-up quota ends voice when it is a voice route, and nothing for any other", async () => {
  const r = rig(() => json(429, { detail: "call_limit" }));
  for (const name of ["extract", "search", "vision", "respond", "route"])
    assert.equal((await r.gate.fetch(new URL(`/v1/${name}`, origin), { method: "POST", body: "{}" })).status, 429);
  assert.deepEqual(r.limits, [], "The Agent reports the failed tool or turn itself, and the session goes on");
  assert.deepEqual(r.gate.processing(), { status: "available" });
  await assert.rejects(createTranscriber(r.gate)(new Uint8Array([1]), "Moo.", new AbortController().signal), /HTTP 429 call_limit/);
  await assert.rejects(createSynthesizer(r.gate)("Hello.", new AbortController().signal), /HTTP 429 call_limit/);
  assert.deepEqual(r.limits, [["voice_unavailable", "call_limit"]]);
  assert.deepEqual(r.gate.processing(), { status: "available" }, "Typing still works");
  const spent = rig(() => json(429, { detail: "session_limit" }));
  await spent.gate.fetch(new URL("/v1/route", origin), { method: "POST", body: "{}" });
  assert.deepEqual(spent.limits, [["session_limit", "session_limit"]], "The session's own budget still ends it");
});

test("a passing counters error is an ordinary failure, not the end of the session", async () => {
  const r = rig(() => json(503, { detail: "counters_unavailable" }));
  assert.equal((await r.gate.fetch(new URL("/v1/route", origin), { method: "POST", body: "{}" })).status, 503);
  await assert.rejects(createSynthesizer(r.gate)("Hello.", new AbortController().signal), /HTTP 503 counters_unavailable/);
  assert.deepEqual(r.limits, []);
  assert.deepEqual(r.gate.processing(), { status: "available" });
});

test("a speech part that takes too long to arrive fails, so half-duplex can't keep the microphone deaf", async () => {
  const gate = createDemoGate({ origin, token: () => "v1.first", onLimit: () => {},
    baseFetch: async input => new Promise<Response>((_, reject) => {
      const { signal } = input as Request;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
  await assert.rejects(createSynthesizer(gate, 20)("Hello.", new AbortController().signal), (error: Error) => error.name === "TimeoutError");
});

test("a failing limit handler never turns the gateway's answer into a network error", async () => {
  const gate = createDemoGate({ origin, token: () => "v1.first", baseFetch: async () => json(401, { detail: "session_expired" }),
    onLimit: () => { throw Error("banner failed"); } });
  const errors: unknown[] = [], log = console.error;
  console.error = (...items: unknown[]) => { errors.push(items); };
  try { assert.equal((await gate.fetch(new URL("/v1/route", origin), { method: "POST", body: "{}" })).status, 401); }
  finally { console.error = log; }
  assert.equal(errors.length, 1);
  assert.equal(gate.limit, "session_expired");
});

test("installDemoFetch replaces the target's fetch and restores it", () => {
  const original = (async () => json(200, {})) as typeof fetch;
  const target = { fetch: original }, r = rig();
  const uninstall = installDemoFetch(r.gate, target);
  assert.equal(target.fetch, r.gate.fetch);
  uninstall();
  assert.equal(target.fetch, original);
});

test("transcription posts the WAV with its prompt cut to 400 characters, on whole characters", async () => {
  const r = rig(() => json(200, { text: "Osmosis moves water." }));
  const wav = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 3]), signal = new AbortController().signal;
  // A surrogate pair straddles the cut; a lone half would make encodeURIComponent throw.
  const prompt = `Moo. ${"a".repeat(394)}😀 osmosis`;
  assert.equal(await createTranscriber(r.gate)(wav, prompt, signal), "Osmosis moves water.");
  const [request] = r.requests;
  assert.equal(request!.url, `${origin}/api/v1/transcribe`);
  assert.equal(request!.method, "POST");
  assert.equal(request!.headers.get("content-type"), "audio/wav");
  assert.equal(request!.headers.get("authorization"), "Bearer v1.first");
  assert.equal(decodeURIComponent(request!.headers.get("x-moolai-prompt")!), `Moo. ${"a".repeat(394)}`);
  assert.deepEqual(new Uint8Array(await request!.arrayBuffer()), wav);
  await createTranscriber(r.gate)(wav, "Moo. Dilution, C1V1 = C2V2", signal);
  assert.equal(r.requests[1]!.headers.get("x-moolai-prompt"), encodeURIComponent("Moo. Dilution, C1V1 = C2V2"));
});

test("transcription without text in its answer is an error", async () => {
  const r = rig(() => json(200, { transcript: "wrong field" }));
  await assert.rejects(createTranscriber(r.gate)(new Uint8Array([1]), "Moo.", new AbortController().signal), /no text/);
});

test("speech posts the part's text as JSON and returns the audio", async () => {
  const audio = new Uint8Array([0xff, 0xf3, 0x44, 0xc4]);
  const r = rig(() => new Response(audio, { headers: { "Content-Type": "audio/mpeg" } }));
  const controller = new AbortController();
  const blob = await createSynthesizer(r.gate)("Osmosis moves water.\nIt needs a membrane.", controller.signal);
  assert.equal(blob.type, "audio/mpeg");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), audio);
  const [request] = r.requests;
  assert.equal(request!.url, `${origin}/api/v1/speech`);
  assert.equal(request!.headers.get("content-type"), "application/json");
  assert.equal(request!.headers.get("authorization"), "Bearer v1.first");
  assert.deepEqual(await request!.json(), { text: "Osmosis moves water. It needs a membrane." }, "Control characters never reach the gateway");
  controller.abort();
  assert.equal(request!.signal.aborted, true, "Stopping speech aborts its request");
});

test("the demo config is read as sent, and an unreachable or malformed one means not live", async () => {
  const config = { live: true, voice: true, turnstileSiteKey: "0x4AAA", budget: "low" };
  const asked: [string, RequestInit | undefined][] = [];
  assert.deepEqual(await getDemoConfig(async (input, init) => { asked.push([String(input), init]); return json(200, config); }), config);
  assert.equal(asked[0]![0], "/api/demo/config");
  assert.equal(asked[0]![1]?.cache, "no-store");
  assert.deepEqual(await getDemoConfig(async () => json(200, { live: false, voice: true, reason: "budget", turnstileSiteKey: "", budget: "exhausted" })),
    { live: false, voice: false, reason: "budget", turnstileSiteKey: "", budget: "exhausted" });
  const offline = { live: false, voice: false, reason: "unreachable", turnstileSiteKey: "", budget: "ok" };
  assert.deepEqual(await getDemoConfig(async () => { throw new TypeError("Failed to fetch"); }), offline);
  assert.deepEqual(await getDemoConfig(async () => new Response("<html>")), offline);
  assert.deepEqual(await getDemoConfig(async () => json(200, { live: "yes" })), offline);
  assert.deepEqual(await getDemoConfig(async () => json(500, config)), offline);
});

test("a demo session trades the Turnstile token for a session token, and a refusal is readable", async () => {
  let sent: Request | undefined;
  const session = await openDemoSession(async (input, init) => { sent = new Request(new URL(String(input), origin), init); return json(200, { token: "v1.abc", expiresAt: "2026-10-29T12:00:00Z" }); }, "turnstile-token");
  assert.deepEqual(session, { token: "v1.abc", expiresAt: "2026-10-29T12:00:00Z" });
  assert.equal(sent!.method, "POST");
  assert.equal(new URL(sent!.url).pathname, "/api/demo/session");
  assert.deepEqual(await sent!.json(), { turnstileToken: "turnstile-token" });
  await assert.rejects(openDemoSession(async () => json(403, { detail: "turnstile_failed" }), "t"),
    (error: Error & { status?: number; detail?: string }) => /bot check/.test(error.message) && error.status === 403 && error.detail === "turnstile_failed");
  await assert.rejects(openDemoSession(async () => json(503, { detail: "demo_budget_exhausted" }), "t"), /budget is used up/);
  await assert.rejects(openDemoSession(async () => json(200, { token: 7 }), "t"), /could not start/);
  await assert.rejects(openDemoSession(async () => { throw new TypeError("Failed to fetch"); }, "t"), /could not be reached/);
});
