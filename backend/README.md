# Moolai provider backend

This service holds provider credentials and accepts durable backend snapshots. Immediate transcript saving belongs to the local `BrainPort` adapter; a backend failure cannot undo that save. It has no microphone, screen, filesystem automation or Agent state machine.

## Start locally

Use Python 3.13 and Docker Desktop. From the repository root:

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt -c backend/constraints.txt
cp backend/.env.example backend/.env
```

Set a random `MOOLAI_BACKEND_TOKEN` and your three provider keys in `backend/.env`. Supply the same backend token to the desktop host; provider keys stay here. The example credentials for Postgres are for the loopback-only development database. Do not use this Compose file as a public deployment.

```sh
docker compose up --build -d
```

For Python development, run only Postgres in Docker, then start the API directly:

```sh
docker compose up -d postgres
cd backend
.venv/bin/uvicorn moolai_backend.app:app --env-file .env --host 127.0.0.1 --port 8000 --no-access-log
```

`GET /health` is unauthenticated **liveness**, not proof of database/provider access. Every `/v1` endpoint requires `Authorization: Bearer <MOOLAI_BACKEND_TOKEN>`. An empty configured token disables those endpoints. No browser CORS access is enabled; the desktop main process calls the API.

## Small API boundary

JSON field names match `packages/contracts/src/index.ts`. All requests and model outputs are validated. No output is silently repaired into success.

| Method and path | Request | Response |
|---|---|---|
| `GET /v1/models` | — | Configured model IDs, actual Nebius inventory, missing models and verification status. Jev/Tavily configuration is explicitly unverified. |
| `POST /v1/route` | `RouteInput` | `RouteDecision` |
| `POST /v1/tag` | `TagInput` | `TagDecision` |
| `POST /v1/connect` | `{record, candidates}` | `{candidateId: yesProbability}`; maximum five candidates |
| `POST /v1/summarize` | `{record}` | `{title, summary, topicSuggestions, topicSuggestion?}` |
| `POST /v1/respond` | `{messages, tools, responseMode?, closingMode?}` | `{text, toolCalls, controlProposal?}` |
| `POST /v1/vision` | `{image: {mimeType, dataBase64}, question, mode?: "ocr" | "visual"}` | `VisionEvidence` (raw, OCR observations, optional scene features/hypotheses, interpretation, validationErrors, validated) |
| `POST /v1/search` | `{query}` | `{results: [{url,title,content}]}` |
| `POST /v1/extract` | `{urls}` | Same as search; maximum three public HTTP(S) URLs |
| `POST /v1/records/accept` | `{record, operationId}` | `{revision}` |

`responseMode` defaults to `auto`, preserving the existing tool behavior. Optional `answer_only` removes task tools and the backend-injected conversation-control tool, requests no tool calls, and rejects unexpected tool proposals. The production controller reserves its sixth call for this mode.

`closingMode` defaults to `current`. The comparison-only `contextual` mode additionally permits `offer_conversation_close`, returned as a non-executable `controlProposal` with action `offer_close`. It requires answer text and no task proposals. The controller asks a fixed closing question, persists its source revision, then lets J1 evaluate the reply. Answer-only mode removes both control tools. No production host enables contextual closing. Route inputs can carry the corresponding `close` pending offer (conversation/session/turn IDs, revision key and exact question); task questions are never represented as closing offers.

Example route request and response:

```json
{"text":"Moo, explain the note","recentContext":"The user is studying their saved notes.","activeConversation":false}
```

```json
{"route":"start_agent","confidence":0.96}
```

This is a wire example, not a recorded inference result. `helpAccepted: true` is returned only for explicit acceptance of a pending help offer: J1 adds `accept_help` to that same Choice and maps it to `start_agent` plus this flag. An unrelated new request to Moo never authorizes the offer's screenshot. `endAction` is only returned when the pending offer is `{"kind":"end_work"}` and a finish/cancel/continue choice is supported. Jev never generates `substantiveText`; the original transcript remains authoritative.

For active closing checks, the same J1 request includes an independent substantive-content assessment. Its optional `substantiveContentProbability` lets the controller distinguish closing-only speech from a final request followed by closing, without rewriting the transcript or creating another gate. Missing/uncertain assessment stays conservative; work already running keeps its finish/cancel/continue prompt. J1 labels the latest utterance separately from full conversation history.

The native TypeSafe API receives `model`, a text `state`, and independent Choice/Noul `questions` at `/v1/systemone`. All questions in a call see the same source. J7's unresolved-doubt, relevance, fidelity and understandable-context questions remain independent of its purpose choice. The controller applies provisional thresholds; the backend returns probabilities.

Nebius uses its OpenAI-compatible chat endpoint. The configured exact model must appear in account inventory, cached for at most 60 seconds, and the served model must match. There is no silent fallback. Summaries use strict JSON schema output, conversations use supplied function tools, and screenshots use private data URLs. Each request sets `max_completion_tokens` (1,200 summary / 2,400 agent / 1,600 vision), which includes reasoning tokens, and `store: false` to disable the documented model-distillation storage option. Tavily returns attributed source excerpts; truncated excerpts are marked. A partial extraction failure is reported as an error because the current `SearchProvider` contract has no partial-result status.

`nvidia/Nemotron-3-Ultra-550b-a55b` is the default agent model in Settings and the example environment. `NEBIUS_AGENT_MODEL` overrides it; restart/recreate the backend after changing the environment. Configured models must appear in account inventory.

## Persistence and failure behavior

`accepted_records` stores the latest accepted JSON snapshot; `accepted_operations` stores operation identity, record revision and digest. Both update in one Postgres transaction. Per-operation and per-record transaction locks make concurrent retries safe. An exact replay returns its original accepted revision, even if the current record is newer. Reusing an operation ID for different content or submitting a stale/conflicting revision returns `409`. Persist the exact request snapshot alongside its operation ID in the local adapter before sending it.

Missing configuration returns `503`, invalid request `422`, excessive model context `413`, unavailable provider `502/503`, and timeout `504`. Provider error bodies and validation input values are never echoed. Automatic provider retries are **zero**; callers may retry explicitly, knowing a timed-out request could already be billable.

Model input is bounded at 180,000 JSON characters without silent truncation. Output caps are 1,200 summary tokens, 2,400 Agent tokens and 1,600 vision tokens. Search is basic depth with five results, extraction basic depth with three URLs, and returned excerpts have an explicit 12,000-character boundary. Tool definitions and call counts are bounded. These controls limit a call, not an account-wide dollar budget; live validation must check current pricing/account usage and respect the explicitly authorized budget for each experiment. Preserve existing ledger entries; changing a test directory does not reset spending.

## Verification

```sh
cd backend
.venv/bin/python -m pytest -q
```

The default suite uses `httpx.MockTransport`, never paid providers. It checks native Jev shapes, context retention, independent tag questions, model inventory/no fallback, structured generation, tool protocol, image transport, extraction failures, auth and redacted errors.

To test real Postgres persistence, concurrency and replay against the local development database:

```sh
TEST_DATABASE_URL=postgresql://moolai:moolai@127.0.0.1:5432/moolai .venv/bin/python -m pytest -q tests/test_store_integration.py
```

The integration test creates uniquely identified test rows and deletes only those rows afterward. It does not call a model.

### Explicit live smoke checks

From `backend`, this command checks configuration and the actual Nebius model inventory only. It makes no generation, Jev or Tavily calls:

```sh
.venv/bin/python -m moolai_backend.validate_live
```

For paid smoke checks, first verify current account pricing and any earlier project spending. Then choose a conservative per-call dollar **upper bound**, not an estimated average, and set all three explicit flags:

```sh
.venv/bin/python -m moolai_backend.validate_live --providers jev,nebius,tavily \
  --allow-paid --pricing-checked --max-call-usd 1.00
```

`1.00` is an example reservation, not a provider price claim. This run reserves up to US$3 against a cumulative US$5 ceiling in the checkout's ignored `.data/provider-validation.json`. Do not delete/reset this ledger to regain budget; account for any validation spending outside this script before using it. Reservations record operator-verified price bounds, not observed invoices. Check provider billing for actual spend. The script cannot enforce provider prices or detect calls made elsewhere.

All selected providers must pass available configuration/inventory preflight before paid dispatch. Each selected provider gets **at most one tiny call**, with zero retries: one Jev Noul, one Nebius completion capped at 32 total completion tokens (including reasoning), and one basic Tavily search returning one result. `--nebius-role agent` or `vision` selects another configured exact model instead of Nano; this remains a tiny **text/access smoke check**, not a tool-use or OCR benchmark. Reasoning that exhausts the cap is recorded as failure and is never retried with a larger cap.

Each reservation is written before dispatch and remains reserved after timeout/failure. The ledger is locked against concurrent runs and contains only provider names, model IDs, timestamps, usage counters and sanitized statuses—no keys, prompts or source content. By default the command is inventory-only, even with configured credentials.

## Primary references checked

- [TypeSafe quickstart and native API](https://docs.typesafe.ai/introduction/quickstart)
- [Choice response distribution](https://docs.typesafe.ai/primitives/choice) and [Noul probabilities](https://docs.typesafe.ai/primitives/noul)
- [Nebius structured output](https://docs.tokenfactory.nebius.com/ai-models-inference/json) and [model inventory](https://docs.tokenfactory.nebius.com/api-reference/models/list-models)
- [Nano model ID](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-nano-30b.md) and [Super model ID](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-super-120B.md)
- [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)

## Enrichment and vision contracts

Nano receives source transcript content without prior generated summaries or processing metadata. It proposes up to three editable topic tags. J7 returns fixed purpose/quality assessments; `topics` remains an empty compatibility field. J1's 0.8 threshold guards transitions and help acceptance; low-confidence selected dictation/active continuation no longer forces clarification.

Vision observations carry a field, readable/unreadable/absent status, value, visible label and source excerpt. Readable values require consistent visible support; contradictory values are nulled, with original output and validation failures retained. Interpretation stays separate. Legacy prose remains unvalidated and unusable as factual answer evidence. These checks establish textual consistency, not independent pixel truth.


### Contextual visual help

J1's existing route Choice includes `offer_screen_help`, mapped to `offer_help` with `screenHelp: true`; no extra gate or provider call is added. The controller persists the original source revision and screen question in the help offer. `helpAccepted` resumes that request only while its revision remains current. The visible offer describes screen access; unrelated/generic help acceptance does not authorize capture.

`POST /v1/vision` accepts image/question plus an optional analysis mode, defaulting to `ocr` for older callers. Contextual visual-help capture explicitly selects `visual`; the main agent can select either mode through the capture tool. Both backend and Agent enforce this distinction. MiniCPM receives an image data URL plus the actual retained request and acceptance constraints. Responses may contain only `scene` for visual questions: unused `observations` and `interpretation` default to empty. A scene contains status (`observed`, `absent`, `unclear`), located feature descriptions and tentative hypotheses referencing feature IDs. These are model claims, not independent verification of image truth. Invalid/ambiguous hypotheses are withheld; raw output remains retained.

OCR retains separate readable/unreadable/absent fields. A field-specific limitation contradicting readability nulls that field without discarding a readable neighbor. In OCR mode, and whenever OCR observations are present, scene hypotheses are not forwarded as answer evidence, preventing an alternative path around the OCR guard. Mixed scene-plus-text tasks may therefore require a narrower follow-up. Free-form interpretation never supplies facts. No image is sent to Ultra; it receives the validated structure through the controller and composes the answer.
