# Contributing

Commit application code, pinned dependencies and model manifests, setup and API documentation, and reusable synthetic test fixtures. Keep test expectations out of provider inputs.

Keep secrets, provider traces, spending records, microphone transcripts, screenshots, test reports and personal notes out of Git. Provider keys belong only in `backend/.env` and `runtime.env`, which are ignored; use ignored `.data/` for local test output. A pull request description should explain the change and summarize how it was checked, without private artifacts.

`docs/` and `experiments/` are allowlisted in `.gitignore`: a new document or experiment folder stays local until it is reviewed and added to the allowlist. Ignoring a tracked file does not untrack it, so inspect `git diff --cached` and `git ls-files` before publishing, and never use `git add -f`.

Run `npm run check` after code or fixture changes. The backend suite and the native and desktop checks are described in the [README](README.md#verify) and their setup guides. Automated tests use fixtures and never call paid providers; local speech checks need no provider account.
