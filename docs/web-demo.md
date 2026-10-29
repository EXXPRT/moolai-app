# Web demo

A stateless, voice-first version of Moolai that runs in the browser:
- **The page** (`apps/web`) runs the real Agent with an in-memory Brain seeded with two study sessions. A refresh resets it.
- **Model calls** go through a small gateway (`backend/moolai_backend/demo_gateway.py`) in front of the same FastAPI backend the desktop uses.
- **Hosting:** the gateway runs as a Vercel Python function (`api/index.py`) next to the static page.
- **What is stored:** nothing a visitor says. The gateway keeps only spending counters, hashed IP buckets and hashed search-result URLs, all expiring, in Upstash Redis.

**How it differs from the desktop app:**
- Speech uses OpenAI (speech-to-text and Moo's voice) instead of on-device Whisper/Qwen and Kokoro.
- Listening is half-duplex: Moo doesn't listen while it speaks, and **Stop speech** interrupts it.
- Screen help reads a sample worksheet instead of your screen.

## HTTP contract

All paths are same-origin. Every error is JSON `{"detail": "<code>"}`.

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/health` | — | `{"status":"ok","service":"moolai-demo-gateway"}` |
| `GET /api/demo/config` | — | `{live, voice, reason?, turnstileSiteKey, budget: "ok"\|"low"\|"exhausted"}` |
| `GET /api/demo/selftest` | — | `{ok, checks: {name: boolean}, pathMode}` (booleans only) |
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
| 429 | `session_limit`, `session_rate_limited` |
| 502 / 504 | `provider_failed` / `provider_timeout` (speech endpoints) |
| 503 | `demo_budget_exhausted`, `demo_unavailable`, `voice_unavailable` |

Backend errors from the forwarded `/api/v1/*` routes keep the backend's own `{"detail": ...}` and status.

**Browser rules:**
- `BackendProviders` builds `new URL("/v1/…", origin)`. The page's fetch wrapper rewrites same-origin `/v1/*` to `/api/v1/*`, swaps in the session token, and answers `/health` itself.
- On 401, 429 or 503 the page stops voice once and shows a lasting banner. It never retries a model call by itself.

**Caching:** every response is `Cache-Control: no-store`, except config (`s-maxage=15`) and selftest (`s-maxage=60`).

## Spending and safety

- **The budget** is counted in micro-dollars in Upstash. Every guarded call reserves its worst case before it is sent and settles to the real cost afterwards:
  - Nebius calls are priced from the token usage the provider reports;
  - Jev calls cost `DEMO_JEV_CALL_USD` (default US$0.01) per started 32 KB;
  - Tavily calls cost US$0.01;
  - OpenAI calls are priced from audio length or text length;
  - every guarded call also costs a non-refundable US$0.0005.
- **Caps:**

  | Variable | Default | Ceiling |
  | --- | --- | --- |
  | `DEMO_BUDGET_TOTAL_USD` | 45 | 60 |
  | `DEMO_BUDGET_DAILY_USD` (UTC days) | 6 | 10 |
  | `DEMO_SESSION_BUDGET_USD` | 1.5 | 3 |

  Each session also has per-endpoint call quotas.
- **Not live** when any check fails: a missing key, Turnstile test keys, a short session secret, a non-production deployment, a cap above its ceiling, no Upstash, or past `DEMO_END_AT` (default `2026-12-16T00:00:00Z`). The page then offers fixture mode, with simulated responses and typing only.
- **Kill switches:**
  - in the Upstash console, `SET moolai:demo:production:off 1`, which is instant;
  - or set `DEMO_ENABLED=off` and redeploy.
- **Vision** only accepts the sample worksheet.
- **Extract** only accepts URLs from the same session's earlier search results.

## Deploy on Vercel (about 25 minutes)

Deploy only through Vercel's Git integration. **Never run the Vercel CLI from a working copy that has `backend/.env` or `.data/`**: the CLI uploads files that Git ignores.

1. **Import the project.** At vercel.com, choose **Add New → Project** and import the public GitHub repository. Leave the build settings alone; `vercel.json` sets them. The first deployment reports "live demo not configured", which is expected.
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

```sh
npm ci
npm run build:web
npm run demo:api      # gateway on 127.0.0.1:8787, keys from backend/.env, Turnstile test keys, in-memory counters, US$2 caps
npm run dev:web       # page on http://127.0.0.1:5174, /api proxied to the gateway
```

The local gateway refuses to start on Vercel. `?debug=1` shows the microphone level and onsets.

## Smoke test (5 minutes)

1. Open the page, pass the bot check, and choose **Start with voice**. Allow the microphone.
2. Say: "Osmosis is water moving across a membrane toward the side with more solute." The line appears with the chip **Saved as a thought**. A growing note forms within about a minute.
3. Say: "Moo, how does dilution connect to osmosis?" Moo answers on screen with note references, then speaks a summary.
4. Say: "I don't get how to find V2 on this worksheet." Moo saves the doubt and offers to look. Say "yes". The worksheet drawer opens, and the answer quotes 0.50 mol/L.
5. Press **Stop speech** while Moo talks; it stops at once. Refresh; the sample notes are back, and your new lines are gone.
