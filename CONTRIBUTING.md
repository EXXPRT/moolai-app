# Repository scope

Commit application code, pinned dependencies/model manifests, setup and API documentation, and reusable synthetic test fixtures. Keep test expectations out of provider inputs.

Keep internal development plans, session logs, decisions and experiment findings in the project’s Obsidian records. Keep raw provider traces, budgets/ledgers, microphone transcripts, screenshots, test reports and frozen source snapshots in ignored `.data/` storage. Do not attach these to commits or paste them into PR descriptions. A PR description should explain the final change and summarize validation without private artifacts.

`docs/` has an explicit public-document allowlist in `.gitignore`. Review any addition before changing that allowlist. Ignoring a tracked file does not untrack it; inspect `git diff --cached` and `git ls-files` before publishing. Never use `git add -f` for internal artifacts. Removing a tracked artifact preserves older commits; changing shared history is a separate operation.

Run `npm run check` after code or fixture-path changes. The backend suite and native/desktop checks are described in their setup guides. Automated tests use fixtures; paid provider calls require a separately bounded validation run and an intact local ledger. Local ASR checks do not require a provider account.
