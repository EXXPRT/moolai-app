# J1, complexity routing and harness comparison

An isolated follow-up to the deterministic evaluation checkpoint. No production policy, model or desktop default is changed. The experiment calls the existing Agent and BrainPort with synthetic source records; tools simulate note search/read only.

The shared response policy is **revised Moolai** for both native and Nanobot. This compares loops beneath the same controller, evidence, prompts and tools. It does not compare native production H0 against Nanobot defaults. Codex remains an explicit unsupported cell unless a runner satisfies the same tool and context restrictions. No substitute fills an unsupported cell.

## Prepared comparisons

- Eight closed tasks on native/Super and Nanobot/Super, alternating order by case.
- The same eight tasks on native/Lightning and native/GLM 5.3, alternating model order.
- Twelve authored Jev complexity decisions, plus fresh decisions and selected-model executions for the eight closed tasks. Confidence below 0.8 falls back to Super; confident clarification/unsupported decisions do no task work. A provider failure stays unresolved.
- Twenty J1 phrases through the actual controller with simulated final transcript events. Model labels and executed transitions are recorded separately. Generation/enrichment in this section use fixtures. The current controller calls J1 for completed active turns as well as idle turns; it does not implement the earlier bypass design. A deterministic three-block check verifies assembly, retention and one continued exchange.

`router-policy.json` is experimental. Its typed choices do not create another production Jev gate. The high-complexity examples test classification only; the eight answered tasks emphasize retrieval/recovery, so results cannot establish performance on complex plans generally. Routed executions occur after fixed-model runs; cache/order effects can influence observed latency. No statistical generalization or automatic adoption is warranted by eight cases.

## Bounds

Exact Nebius profiles: `nvidia/Nemotron-3_5-Lightning`, `nvidia/nemotron-3-super-120b-a12b`, `zai-org/GLM-5.3`. Jev stays `jev-1.13.0` at threshold 0.8. All generation uses temperature 0.2, provider-default reasoning, a 4,000-token reasoning-inclusive output cap, six requests maximum and a final answer-only stage. Complete provider payloads are bounded at 12,000 UTF-8 bytes, priced against a conservative 15,000-token input allowance. Reasoning compute is not equalized across models.

Reservations are $0.003 Lightning, $0.01 Super, $0.04 GLM and $0.01 Jev per request. The full theoretical matrix, including the unavailable Codex cell, at most two compatibility requests per model/runner, and 40 decision requests totals **$5.97**. The cumulative ledger ceiling remains **$25.87**. Reserves precede dispatch and survive failure; IDs cannot repeat. There are no automatic retries, dedicated endpoints, purchases or rentals. Models absent from the account/pricing preflight remain unavailable.

The frozen inputs, source hashes, exact preflight and raw provider requests/responses are stored before/as requests execute. Scoring uses the original closed-task oracle without exposing it to providers. Earlier baselines are not modified. Framework logs are auxiliary; BrainPort persists source/evidence. A simple JSONL subprocess carries Nanobot callbacks; it receives no provider keys. Its own argument validation is delegated to the parent so both loops use Moolai's guards. Blank/failing responses stop before SDK recovery. No general Nanobot app, shell, browser, compaction or auxiliary agent is enabled.

## Local setup and execution

Install the root Node dependencies and the pinned isolated Python environment from [the preparation guide](../evaluation/README.md). No extra Node package install is needed here. Tests for this optional harness remain outside the root application's mandatory test glob.

```sh
npm --prefix experiments/router-harness run typecheck
npm --prefix experiments/router-harness test
backend/.venv/bin/python -m unittest discover -s experiments/router-harness -p '*_test.py'
node --import tsx experiments/router-harness/run.ts
node --import tsx experiments/router-harness/run.ts --offline --directory .data/a-fresh-rehearsal
```

The preview prints all exact phrases without calls. Offline runs intentionally return oracle fixture answers and cannot be presented as model-quality results. Some tests require localhost capability; the Codex probe always uses a fake local server with no inference.

Paid execution is a separate action after local checks, model inventory and prices have been reviewed:

```sh
backend/.venv/bin/python experiments/router-harness/provider.py --preflight > .data/router-harness-preflight-20260924.json
node --import tsx experiments/router-harness/run.ts --live --allow-paid --directory .data/a-fresh-live-run
```

An existing run is immutable. Starting a new directory does not authorize repeating paid operation IDs. Do not rerun or modify frozen source files during dispatch. Preserve failed compatibility as incomplete. Full results and recommendations are recorded after execution; a completed script is not proof that all model/harness cells passed.
