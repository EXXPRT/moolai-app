# Deterministic evaluation preparation

Offline scoring, fixed synthetic corpora and a Nanobot loop probe. Production ASR, routing and model defaults are unchanged. The integrated experimental runner is in `../router-harness/`; the local speech comparison is in `../canary-comparison/`.

## Run without providers or a microphone

From the repository root, with its normal Node dependencies installed:

```sh
node scripts/evaluate-candidates.mjs
node --test scripts/evaluation-metrics.test.mjs scripts/evaluate-candidates.test.mjs
```

The first command previews eight agent requests, twelve speech cases and their corpus hashes. It neither loads a model nor generates audio. Agent oracle answers are excluded from the preview. Proposed complexity tiers come from authored fixture features; they are not the output of an evaluated language router.

For the actual Nanobot loop probe, use an isolated Python environment. The lock records the versions exercised on Python 3.13.5/macOS arm64; it is not a production dependency or a guarantee for other platforms.

```sh
python3 -m venv .data/nanobot-eval-venv
.data/nanobot-eval-venv/bin/python -m pip install -r experiments/evaluation/requirements-nanobot.lock
.data/nanobot-eval-venv/bin/python experiments/evaluation/nanobot-compatibility.py .data/nanobot-compatibility-new.json
```

The probe uses `nanobot-ai==0.3.5`'s real `AgentRunner`, a scripted provider and one synthetic read tool. It does not start Nanobot's general application, read its user configuration or use credentials. Its provider overrides the SDK retry wrapper with a one-attempt transport. Output files must be new; previous traces cannot be overwritten.

## What the scoring does

`closed-task-cases.json` defines **new structured extraction tasks**, derived from the earlier eight regressions. Each answer must be a JSON object containing exactly:

- `status`: `supported`, `no_matches` or `insufficient_evidence`.
- `facts`: only the requested fact fields, with evidence-grounded values; use `null` for an unsupported requested value. Numeric quantities use the unit in the field name. Strings use lowercase; lists use source order. A missing result is not evidence that nothing was planned or that an effect is zero.
- `sources`: objects with `id` and current integer `revision` for the relevant sources used, including related evidence supporting a limitation.
- `acknowledgedFailures`: IDs of preceding failed retrievals. A rejected argument or successful no-match query is not a failed retrieval.
- `scope`: `query` for a no-match search; otherwise `sources`. No fixture establishes an empty corpus.

There is no free-form answer field. Exact fact equality deliberately scores a narrow machine contract, including its formatting requirements; it does not judge semantically equivalent prose. The two-sentence instruction from the historical case is removed because these responses are structured data. Historical prose scores are **not** comparable to these scores. Additional natural-language quality checks still require human review; no evaluator agent is used here.

Controller observations are separate from model output. The evaluator requires observed executed tools, call count, maximum complete outbound payload size, retries, retention and cancellation status. The truncated-note case also requires an observed successful full read of the current note; a lucky answer alone cannot pass. A forbidden **proposal** belongs in the retained trace; only actual tool dispatch belongs in `execution.tools`.

`expected`, `requestFeatures`, `requiredRead` and source corpora are evaluator/controller data. Do not serialize entire fixtures to a provider. A future runner must construct provider messages from the request, declared answer contract and the appropriate seeded evidence. Sources stay behind fixture Brain tools; in particular, the full truncated note must not leak into the initial prompt. The runner must simulate `setup` events, refresh revisions and collect observations itself. The integrated runner records these observations separately.

The speech scorer measures word errors, critical phrase retention, final words and optional inference/audio duration. Pooled WER is total speech errors divided by total reference speech words, with silence insertions reported separately. Normalization preserves negation, numbers and distinctions such as Moo/Move and end/and. Missing measurements remain unknown. A correct transcript does not establish J1 success: `observedRoute` must come from a separate actual routing/controller check, normalized to Moolai route labels. J1 evaluates assembled turns, not individual ASR chunks. Compare the observed transition as well as any model label before claiming activation success.

Synthetic speech cannot validate a user’s accent, microphone, live endpointing, sustained streaming or TTS echo behavior.

## Import observations

Observation files use this envelope:

```json
{
  "corpusSha256": "the exact hash printed by the preview",
  "profiles": [
    { "id": "candidate-and-settings", "runs": [] }
  ]
}
```

An agent run contains `caseId`, `status`, `output` and `execution`:

```json
{
  "caseId": "c01",
  "status": "completed",
  "output": {
    "status": "supported",
    "facts": {},
    "sources": [],
    "acknowledgedFailures": [],
    "scope": "sources"
  },
  "execution": {
    "tools": [],
    "generationCalls": 2,
    "maximumWireBytes": 5000,
    "retries": 0,
    "sourceRetained": true,
    "cancelled": false
  }
}
```

This demonstrates the shape, **not a passing answer**. For a full read, the controller's tool event contains `name: "read_note"`, `id`, `revision`, `complete: true`, `status: "success"`. ASR runs contain `caseId`, `status: "completed"`, `transcript` and optionally `audioMs`, `inferenceMs`, `observedRoute`.

```sh
node scripts/evaluate-candidates.mjs --agent observations.json --output fresh-agent-scores.json
node scripts/evaluate-candidates.mjs --asr observations.json --output fresh-asr-scores.json
```

The scorer rejects corpus mismatches, duplicate/unexpected cases and attempts to overwrite input/results. Missing cases remain incomplete and ineligible for a complete comparison. It preserves ties and never selects a production default. Corpus hashes establish which fixtures were used; they do not authenticate manually supplied execution claims. Retain the originating raw traces, exact model/runtime versions, settings, timing and ledger records alongside every imported report.

## Output policy

Store reports and traces in ignored `.data/` paths. Internal model/harness decisions and session notes belong in Obsidian. Preserve existing paid reservations; a new output directory does not authorize new paid work or reset its budget.
