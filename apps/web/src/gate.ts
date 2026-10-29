import { safeEnd } from "../../../packages/contracts/src/records.js";
import type { DemoConfig, DemoLimit, DemoSession, Processing, Synthesize, Transcriber } from "./types.js";

/** The gateway refusals that end live calls for this page (docs/web-demo.md). Any other failure stays an ordinary error. */
const LIMITS = new Map<string, DemoLimit>([
  ["401 invalid_session", "session_expired"], ["401 session_expired", "session_expired"],
  ["429 session_limit", "session_limit"], ["429 session_rate_limited", "session_limit"],
  ["503 demo_budget_exhausted", "budget_exhausted"], ["503 demo_unavailable", "unavailable"], ["503 voice_unavailable", "voice_unavailable"],
]);
const SESSION_REFUSED = new Map<string, string>([
  ["turnstile_failed", "The bot check didn't pass. Refresh the page to try again."],
  ["session_rate_limited", "Too many demo sessions were started from this network. Try again later, or explore in fixture mode."],
  ["demo_budget_exhausted", "Today's live budget is used up. Refresh to explore in fixture mode."],
  ["demo_unavailable", "The live demo is unavailable right now. Refresh to explore in fixture mode."],
]);
const SESSION_FAILED = "The live demo session could not start. Refresh the page to try again.";

export interface DemoGate {
  /** The page's fetch: same-origin /v1/* goes to the gateway with the session token, /health is answered here. */
  fetch: typeof fetch;
  /** The speech endpoints, which the Agent's providers never call. */
  call(path: "/api/v1/transcribe" | "/api/v1/speech", init: RequestInit): Promise<Response>;
  processing(): Processing;
  readonly limit?: DemoLimit;
}

export function createDemoGate(options: {
  origin: string;
  /** The unwrapped fetch; the gate's own fetch must never be passed here. */
  baseFetch: typeof fetch;
  token(): string | undefined;
  onLimit(limit: DemoLimit, detail: string): void;
}): DemoGate {
  // Called detached: a browser's fetch throws "Illegal invocation" when called on another object.
  const { baseFetch } = options, origin = new URL(options.origin).origin;
  const reported = new Set<DemoLimit>();
  let limit: DemoLimit | undefined, unavailableAt: string | undefined;
  /** BackendProviders fixes its own token; every gateway call carries the session's current one instead. */
  function authorized(source?: HeadersInit) {
    const headers = new Headers(source), token = options.token();
    headers.delete("Authorization");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }
  async function send(request: Request) {
    const response = await baseFetch(request);
    if (![401, 429, 503].includes(response.status)) return response;
    const detail = await response.clone().json().then((body: { detail?: unknown }) => typeof body?.detail === "string" ? body.detail : "", () => "");
    const kind = LIMITS.get(`${response.status} ${detail}`);
    if (kind && !reported.has(kind)) {
      reported.add(kind);
      if (kind !== "voice_unavailable") unavailableAt ??= new Date().toISOString();
      if (kind !== "voice_unavailable" || !limit) limit = kind;
      // The caller still gets the response; a failing banner must not turn it into a network error.
      try { options.onLimit(kind, detail); } catch (error) { console.error(`Demo limit handler failed: ${String(error)}`); }
    }
    return response;
  }
  const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // BackendProviders passes URL objects with plain-object headers; a Request normalises every input form.
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== origin) return baseFetch(request);
    // The static host has no backend health route; processing availability is the gate's own.
    if (url.pathname === "/health" && request.method === "GET")
      return new Response(JSON.stringify({ status: unavailableAt ? "unavailable" : "ok", service: "moolai-backend" }),
        { status: unavailableAt ? 503 : 200, headers: { "Content-Type": "application/json" } });
    if (!url.pathname.startsWith("/v1/")) return baseFetch(request);
    // Read the body rather than re-wrapping the Request: a stream body needs duplex and HTTP/2 in Chrome.
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return send(new Request(new URL(`/api${url.pathname}${url.search}`, origin), {
      method: request.method, headers: authorized(request.headers), body, signal: request.signal,
      cache: request.cache, credentials: request.credentials, redirect: request.redirect,
    }));
  };
  return {
    fetch: gatedFetch,
    call: (path, init) => send(new Request(new URL(path, origin), { ...init, headers: authorized(init.headers) })),
    processing: () => unavailableAt ? { status: "unavailable", checkedAt: unavailableAt } : { status: "available" },
    get limit() { return limit; },
  };
}

/** Routes the page's own fetch, which BackendProviders calls, through the gate. Returns the uninstall. */
export function installDemoFetch(gate: DemoGate, target: { fetch: typeof fetch } = globalThis) {
  const previous = target.fetch;
  target.fetch = gate.fetch;
  return () => { if (target.fetch === gate.fetch) target.fetch = previous; };
}

/** Lone surrogates would make encodeURIComponent throw, and cannot be encoded for the providers. */
const wellFormed = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

async function failure(response: Response, label: string) {
  const detail = await response.json().then((body: { detail?: unknown }) => typeof body?.detail === "string" ? body.detail : undefined, () => undefined);
  return Object.assign(new Error(`${label} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`), { status: response.status, detail });
}

export function createTranscriber(gate: DemoGate): Transcriber {
  return async (wav, prompt, signal) => {
    const hint = wellFormed(prompt);
    const response = await gate.call("/api/v1/transcribe", {
      method: "POST", signal, body: wav as Uint8Array<ArrayBuffer>,
      headers: { "Content-Type": "audio/wav", "X-Moolai-Prompt": encodeURIComponent(hint.slice(0, safeEnd(hint, 400))) },
    });
    if (!response.ok) throw await failure(response, "Transcription");
    const body = await response.json() as { text?: unknown };
    if (typeof body?.text !== "string") throw new Error("Transcription returned no text");
    return body.text;
  };
}

export function createSynthesizer(gate: DemoGate): Synthesize {
  return async (text, signal) => {
    // Line breaks and other control characters carry nothing for the voice, and the gateway refuses control characters.
    const spoken = wellFormed(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
    const response = await gate.call("/api/v1/speech", {
      method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: spoken }),
    });
    if (!response.ok) throw await failure(response, "Speech");
    return response.blob();
  };
}

/** Fails closed: an unreachable or malformed config is a demo that is not live, so the page offers fixture mode. */
export async function getDemoConfig(fetchFn: typeof fetch): Promise<DemoConfig> {
  try {
    const response = await fetchFn("/api/demo/config", { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as Partial<DemoConfig>;
    if (response.ok && typeof body.live === "boolean" && typeof body.voice === "boolean" && typeof body.turnstileSiteKey === "string"
      && (body.budget === "ok" || body.budget === "low" || body.budget === "exhausted"))
      return { live: body.live, voice: body.live && body.voice, ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        turnstileSiteKey: body.turnstileSiteKey, budget: body.budget };
  } catch {}
  return { live: false, voice: false, reason: "unreachable", turnstileSiteKey: "", budget: "ok" };
}

/** Trades a Turnstile token for a session token. A refusal carries `status` and the gateway's `detail` code. */
export async function openDemoSession(fetchFn: typeof fetch, turnstileToken: string): Promise<DemoSession> {
  let response: Response;
  try {
    response = await fetchFn("/api/demo/session", {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnstileToken }),
    });
  } catch (error) {
    throw new Error("The live demo could not be reached. Check your connection, then refresh the page.", { cause: error });
  }
  const body = await response.json().catch(() => ({})) as { token?: unknown; expiresAt?: unknown; detail?: unknown };
  if (response.ok && typeof body?.token === "string" && body.token && typeof body.expiresAt === "string")
    return { token: body.token, expiresAt: body.expiresAt };
  const detail = typeof body?.detail === "string" ? body.detail : undefined;
  throw Object.assign(new Error((detail && SESSION_REFUSED.get(detail)) ?? SESSION_FAILED), { status: response.status, detail });
}
