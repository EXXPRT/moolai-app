# External harness comparison adapters

This private package isolates two real SDK loops from the production Agent. It is used only by the synthetic harness comparison; no framework is imported by Agent core.

Pinned versions:

- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`: **0.86.1**. The runner invokes the official `agentLoopContinue` tool loop.
- `@deepseek-ai/dsh-sdk-client` and its matching runtime: **0.1.5-rc.2**. The runner launches the official SDK subprocess with a restricted `sdk-minimal` profile. The release corresponds to commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`.
- The package lock pins transitive dependencies. The SDK distribution contains additional packages, but its configured runtime enables only the required loop, tool, SDK and session services.

Requires **Node 22.19 or newer**, plus the repository's root development dependencies. From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

Tests use synthetic tool results and an in-process fake model callback. DeepSeek needs a local loopback listener; a sandbox that denies local listeners must grant that capability. No test requires provider keys or paid calls.

## Integration

`createPiRunner()` and `createDshRunner({ directory })` implement the shared `ResponseRunner`. Both SDKs own tool dispatch and continuation. Their custom model transports call the same injected `prepare` and `generate` callbacks as the revised native runner. This compares controller loops under a shared evidence policy and provider transport; it does not compare vendor provider adapters, default coding prompts, or the full packaged coding assistants.

Before every generation, `prepare` supplies the current evidence and constraints. The last allowed generation must be `answer_only` with no tools. A proposed tool at that stage is rejected before execution. Each model attempt enters `generate` once; its caller owns the per-case counter, provider payload bounds, reservations and recorded usage. Pi's local stream envelopes contain zero placeholder usage; billing measurements come exclusively from the shared provider record, not these envelopes. DeepSeek emits no synthetic provider usage.

Only `search_notes` and `read_note` may be registered. The injected `execute` callback still performs Moolai's validation and returns a simulated result. Tool failures remain model-visible tool outcomes. Provider failures end the run without retrying.

DeepSeek's profile disables native providers, shell/process capabilities, retries, jobs and title generation. It never loads the broad base profile, compaction, subagents or model-generated helpers. The child receives a small explicit environment containing its temporary home and an ephemeral loopback bridge credential, **no provider credentials**. The bridge authenticates every request and has a bounded body size. Its model endpoint delegates to the parent callback; it has no external provider URL. The runtime's temporary workspace and session files are removed after shutdown.

`createDshRunner({ directory })` retains SDK event traces alongside the case artifacts. Traces contain synthetic transcript/tool data and no bridge credentials. DSH's native session begins with a bootstrap receipt; the transport combines the parent-owned initial transcript with subsequent SDK messages, then applies the shared preparation policy. Therefore the authoritative provider context is the orchestrator's recorded prepared frame, not the DSH session log alone. The SDK trace is retained as evidence of its actual loop behavior.

The offline suite checks tool-to-answer continuation, exact call IDs, six-call bounds, forbidden capabilities, final-stage enforcement, provider failure without retry, recoverable tool failure, pre-abort and evidence refresh while retaining the user's complete request. Live model compatibility and answer quality are measured separately by the root experiment runner.

Official references:

- [Pi agent core at v0.86.1](https://github.com/earendil-works/pi/blob/v0.86.1/packages/agent/README.md)
- [DeepSeek SDK client at the pinned release](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/sdk/client/README.md)
- [DeepSeek minimal profile at the pinned release](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/bundle/sdk-minimal/cordis.patch.yml)
