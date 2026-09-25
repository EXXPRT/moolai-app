# Agent phase final regression

One frozen run exercises the production Agent with Ultra, Nano, Jev and MiniCPM. It does not run audio or touch personal notes. SQLite records, screenshots and source text are synthetic. The six answer workflows execute real Brain adapter tools only against isolated experiment data; no web/app automation is available.

The cases are in `cases.json`: 12 J1 dialogues, six agent workflows, six enrichment records and four prior synthetic OCR images. Expected labels and scoring stay in the local runner/report and are never sent as provider inputs. The OCR cases are reused regression evidence, not a held-out score. The default command prints the full phrases and makes no network requests.

```sh
node --import tsx experiments/agent-final-regression/run.ts
backend/.venv/bin/python -m pytest -c backend/pytest.ini experiments/agent-final-regression/provider_test.py -q
```

After implementation and local checks finish, run the read-only model inventory and price preflight. This loads keys from the ignored backend environment file without printing them. It checks the historical ledger balance is US$23.536 and that the model IDs match the declared production choices. It refuses a reused experiment identifier.

```sh
backend/.venv/bin/python experiments/agent-final-regression/provider.py --preflight > .data/agent-final-regression-preflight.json
node --import tsx experiments/agent-final-regression/run.ts --freeze
```

Review the freeze and the corpus before dispatch. Do not change files after freezing. Every paid call checks the source hashes, preflight age (four hours), historical ledger fingerprint, model, output settings, UTF-8 request size, category cap and stable per-case call ID before reserving against the existing ledger. Agent calls reserve US$0.03, Nano/Jev US$0.01 and vision US$0.03. Category caps sum to US$3.58, below the US$4 run cap and US$35.87 cumulative ceiling. The complete text request is limited to 16,000 UTF-8 bytes with a 20,000-input-token pricing allowance. Vision image bytes are separately bounded and priced conservatively against the model's full catalog context length.

```sh
node --import tsx experiments/agent-final-regression/run.ts --live --allow-paid
```

The runner writes `.data/agent_final_regression_20260925_v1/report.json` atomically after each call/case. `dispatch-started.json` prevents overwriting or automatically resuming a partial run. Reservations survive failures; there are no retries. Oversized or failed calls are recorded as incomplete. No production defaults change.

The report separates raw wire/model responses, generated tool proposals, durable executed tool outcomes, controller actions and SQLite restart retention. A clarification is recorded as a safe abstention when the expected action differs; it is not counted as successful activation. Cases with swallowed provider failures are still marked incomplete. Prose claims, citations, quantity/intent fidelity and J7 assessments require manual source review before publishing scores. Reading a plausible word or final answer alone does not establish a pass.

Jev pricing is checked explicitly against the current [model documentation](https://docs.typesafe.ai/models): US$0.042 per million input tokens, with free output. The preflight requires the pinned model ID, exact listed input price and explicit free-output statement, and preserves the fetched document hash. With the 20,000-token input allowance, the estimate is US$0.00084, covered by the US$0.01 reservation. This allowance is a conservative bound for the complete 16KB request, not a measured tokenizer count. Provider-reported usage is retained separately; reservations are not invoices and are never refunded by a lower usage estimate. Changed/unverifiable pricing stops dispatch pending review.
