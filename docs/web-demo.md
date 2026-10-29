# Web demo

A stateless, voice-first version of Moolai that runs in the browser:
- **The page** (`apps/web`) runs the real Agent with an in-memory Brain seeded with two study sessions. A refresh resets it.
- **Model calls** go through a small gateway (`backend/moolai_backend/demo_gateway.py`) in front of the same FastAPI backend the desktop uses.
- **Hosting:** the gateway runs as a Vercel Python function (`api/index.py`) next to the static page.
- **What is stored:** nothing a visitor says. The gateway keeps only spending counters, hashed IP buckets and hashed search-result URLs in Upstash Redis. All of them expire except the running spend total and the off switch, neither of which holds visitor data.

**How it differs from the desktop app:**
- Speech uses OpenAI (speech-to-text and Moo's voice) instead of on-device Whisper/Qwen and Kokoro.
- Listening is half-duplex: Moo doesn't listen while it speaks, and **Stop speech** interrupts it.
- Screen help reads a sample worksheet instead of your screen.
- Nothing is saved: a refresh starts again from the two sample sessions.
- Moo speaks only while the microphone is on, so a visitor who starts with typing gets answers on screen only.

## The page

`apps/web/src/main.ts` boots in this order:
1. **Capability check.** The Agent and its host need `AbortSignal.any`, `crypto.subtle`, `crypto.randomUUID` and regex lookbehind. Without them the page asks for a recent Chrome, Edge, Firefox or Safari 17.4+. Everything that needs them loads only after the check, so an older browser still gets that message.
2. **Intro.** It loads `GET /api/demo/config` and the sample sessions (`public/seed.json`), then says what the demo sends where. When live, it shows the Turnstile check, then **Start with voice** (if voice is available) and **Start with typing**. When not live, it gives the reason and offers **Explore in fixture mode**: simulated replies, typing only, and nothing the visitor types leaves the page. A live intro offers fixture mode too when the bot check can't load or fails, or when the gateway refuses the session.
3. **Start.** In the click, a live page creates the AudioContext and unlocks its one audio element, then opens a session with the Turnstile token. The page loads the sample sessions into an in-memory Brain, with their times moved so that the later session started at 16:00 yesterday in the visitor's time zone. A live page then installs the fetch wrapper. Last, the page starts the host, the bridge (`window.moolai`) and a study session, imports the desktop renderer (`apps/desktop/src/main.tsx`) and, for **Start with voice**, turns the microphone on.

Above the renderer, a demo bar names the models and opens the sample worksheet and a **Try saying** card. Each user turn shows how Jev routed it, for example **Saved as a thought**. Limits show as lasting banners. Once voice can't work, the microphone button is hidden, because the renderer would describe any voice failure as a microphone problem.

## HTTP contract

All paths are same-origin. Every error is JSON `{"detail": "<code>"}`.

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/health` | — | `{"status":"ok","service":"moolai-demo-gateway"}` |
| `GET /api/demo/config` | — | `{live, voice, reason?, turnstileSiteKey, budget: "ok"\|"low"\|"exhausted"}`; `reason` comes only when not live |
| `GET /api/demo/selftest` | — | `{ok, checks: {configured, counters, reserveSettle, inner, voice}, pathMode: "original"\|"rewrite"}` (booleans only) |
| `POST /api/demo/session` | `{"turnstileToken": string}` | `{token, expiresAt}`; the token lasts 2 h |
| `POST /api/v1/{route,tag,connect,summarize,consolidate,respond,vision,search,extract}` | the backend's JSON body; `Authorization: Bearer <session token>` | the backend's JSON response |
| `POST /api/v1/transcribe` | raw `audio/wav` (16 kHz mono PCM16, 0.2–34 s, ≤ 1.1 MB); header `X-Moolai-Prompt` = URI-encoded prompt (≤ 400 characters); `Authorization` | `{"text": string}` |
| `POST /api/v1/speech` | `{"text": string}` (1–1,000 characters); `Authorization` | `audio/mpeg` |

**Error codes:**

| Status | `detail` |
| --- | --- |
| 401 | `invalid_session`, `session_expired` |
| 403 | `turnstile_failed`, `extract_not_allowed`, `image_not_allowed` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 413 | `body_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_json`, `invalid_audio` |
| 429 | `session_limit` (the session's budget), `call_limit` (one endpoint's quota, or the session's extract URL checks), `session_rate_limited` |
| 500 | `internal_error` |
| 502 | `provider_failed` (speech, or a backend call that ended without a response) |
| 503 | `demo_budget_exhausted`, `demo_unavailable`, `voice_unavailable`, `counters_unavailable` (Upstash didn't answer; the next call may succeed) |
| 504 | `provider_timeout` (speech) |

Backend errors from the forwarded `/api/v1/*` routes keep the backend's own `{"detail": ...}` and status.

`reason` in config is one of `disabled`, `off`, `ended`, `budget_exhausted`, `counters_unavailable`, `not_production`, or a configuration problem such as `provider_keys_missing` or `counters_unconfigured`. The page shows it in plain words; when it can't reach config at all it uses `unreachable`.

**Browser rules:**
- `BackendProviders` builds `new URL("/v1/…", origin)`. The page's fetch wrapper rewrites same-origin `/v1/*` to `/api/v1/*`, swaps in the session token, and answers `/health` itself.
- These refusals end live calls for the page: 401 `invalid_session` or `session_expired`, 429 `session_limit` or `session_rate_limited`, and 503 `demo_budget_exhausted`, `demo_unavailable` or `voice_unavailable`. A 429 `call_limit` from `/api/v1/transcribe` or `/api/v1/speech` counts as `voice_unavailable`. The page stops voice for the rest of the session and shows a lasting banner. Except for `voice_unavailable`, it also reports processing as unavailable. It never retries a model call by itself, and it never renews a session silently.
- A `call_limit` from any other route, and 503 `counters_unavailable`, are ordinary failures: the Agent reports that tool call or turn, and the session goes on.

**Caching:** every response is `Cache-Control: no-store`, except config (`s-maxage=15`) and selftest (`s-maxage=60`).

## Spending and safety

- **The budget** is counted in micro-dollars in Upstash. Every guarded call reserves its worst case before it is sent and settles to the real cost afterwards:
  - Nebius calls are priced from the token usage the provider reports;
  - Jev calls cost `DEMO_JEV_CALL_USD` (default US$0.01) per started 32 KB;
  - Tavily calls cost US$0.01;
  - OpenAI calls are priced from audio length or text length. In Moo's speech, any character other than an A–Z letter, a space or plain punctuation counts as five, because a digit, a symbol or another script is read as a word or more. Only `gpt-transcribe` or `gpt-4o-mini-transcribe` and `gpt-4o-mini-tts` are priced; with `OPENAI_TRANSCRIBE_MODEL` or `OPENAI_TTS_MODEL` set to anything else, voice is off;
  - every guarded call also costs a non-refundable US$0.0005.
- **What is sent to OpenAI** is a WAV the gateway rebuilds from the audio it measured, never the upload itself.
- **Caps:**

  | Variable | Default | Ceiling |
  | --- | --- | --- |
  | `DEMO_BUDGET_TOTAL_USD` | 45 | 60 |
  | `DEMO_BUDGET_DAILY_USD` (UTC days) | 6 | 10 |
  | `DEMO_SESSION_BUDGET_USD` | 1.5 | 3 |

  Each session also has per-endpoint call quotas, and at most six model calls in flight on an instance; more wait their turn. A used-up quota answers `429 call_limit` from the gateway itself, without asking Upstash again.
- **Not live** when any check fails:
  - `DEMO_ENABLED` isn't `on`;
  - a Nebius, TypeSafe or Tavily key is missing, or a Turnstile key is missing;
  - the session secret is under 32 bytes;
  - a cap is unparsable or above its ceiling;
  - there is no allowed hostname, or no Upstash;
  - it is past `DEMO_END_AT` (default `2026-12-16T00:00:00Z`);
  - on Vercel, the deployment isn't production, or a Turnstile key is one of Cloudflare's test keys.

  The page then offers fixture mode, with simulated responses and typing only. Without `OPENAI_API_KEY` the demo is live but typing only.
- **Kill switches:**
  - in the Upstash console, `SET moolai:demo:production:off 1`, which is instant;
  - or set `DEMO_ENABLED=off` and redeploy.
- **Vision** only accepts the sample worksheet.
- **Extract** only accepts URLs from the same session's earlier search results.

## Deploy on Vercel (about 25 minutes)

The repository must include `apps/web/public/seed.json` (see [Run it locally](#run-it-locally)); the Vercel build fails without it, and so does CI's `npm test`. Deploy only through Vercel's Git integration. **Never run the Vercel CLI from a working copy that has `backend/.env` or `.data/`**: the CLI uploads files that Git ignores.

1. **Import the project.** At vercel.com, choose **Add New → Project** and import the public GitHub repository. Leave the build settings alone; `vercel.json` sets them. The first deployment isn't live yet, which is expected: `/api/demo/config` reports `live: false`, and the page offers fixture mode.
2. **Counters.** Choose **Storage → Marketplace → Upstash for Redis**. Create a free database in `us-east-1` and connect it to the project, all environments, with no custom prefix. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. **Bot check.** In the Cloudflare dashboard, choose **Turnstile → Add widget**, mode **Managed**, and set the hostname to your production domain, for example `moolai-app.vercel.app`. Copy the site key and the secret key.
4. **Environment variables.** Under **Settings → Environment Variables**, set these for the **Production** environment only:

   | Variable | Value |
   | --- | --- |
   | `NEBIUS_API_KEY`, `TYPESAFE_API_KEY`, `TAVILY_API_KEY` | your keys |
   | `OPENAI_API_KEY` | your key |
   | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | from step 3 |
   | `DEMO_SESSION_SECRET` | the output of `openssl rand -hex 32` |
   | `DEMO_ENABLED` | `on` |
   | `DEMO_BUDGET_TOTAL_USD` | `45` |
   | `DEMO_BUDGET_DAILY_USD` | `6` |
   | `DEMO_SESSION_BUDGET_USD` | `1.5` |

5. **Firewall.** Under **Firewall → Rules**, add one rate-limit rule: requests whose path starts with `/api/`, at most 600 per 60 s per IP.
6. **Redeploy.** Choose **Deployments → ⋯ → Redeploy**; environment variables only reach new deployments. Then open `https://<your-domain>/api/demo/selftest`. Every check should be `true`.
7. **OpenAI limit.** In the OpenAI console, open the project, then **Limits**, and set a monthly budget of US$10 with **Enforce hard limit** on.
8. **Share only the production domain.** Vercel protects preview and per-deployment URLs by default.

## Run it locally

The gateway needs the backend's virtual environment from [backend setup](../backend/README.md#start-locally), and the provider keys in `backend/.env` (`OPENAI_API_KEY` too, for voice).

```sh
npm ci
npm run demo:api      # gateway on 127.0.0.1:8787; Turnstile test keys, in-memory counters, US$2 total and daily caps, US$1 per session
npm run dev:web       # page on http://127.0.0.1:5174, /api proxied to the gateway
```

`npm run build:web` then `npm run preview:web` serves the built page on http://127.0.0.1:4174 with the same proxy. The local gateway refuses to start on Vercel.

The page needs `apps/web/public/seed.json`, the two sample sessions; without it, the intro says the sample notes are missing. `apps/web/scripts/generate-seed.ts` writes it by speaking both sessions to the real Agent against a running backend. That run makes paid calls (about US$0.50), so run it only on purpose.

`?debug=1` shows the voice pipeline's last onset, its queue and the level it measured. On `localhost` or `127.0.0.1` only, `?e2e=1` replaces the microphone with `window.__moolaiE2E.feed(samples, sampleRate)` for automated voice tests.

## Smoke test (5 minutes)

1. Open the page, pass the bot check, and choose **Start with voice**. Allow the microphone.
2. Say: "Osmosis is water moving across a membrane toward the side with more solute." The line appears with the chip **Saved as a thought**. A growing note forms within about a minute.
3. Say: "Moo, how does dilution connect to osmosis?" Moo answers on screen with note references, then speaks a summary.
4. Say: "I don't get how to find V2 on this worksheet." Moo saves the doubt and offers to look. Say "yes". The worksheet drawer opens, and the answer quotes 0.50 mol/L.
5. Press **Stop speech** while Moo talks; it stops at once. Refresh; the sample notes are back, and your new lines are gone.
