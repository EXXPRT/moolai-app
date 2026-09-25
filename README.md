# Moolai

An English study agent with durable transcripts and continuous **Moo** conversations. The first build provides an independent TypeScript Agent, SQLite/files storage, a small Electron interface, a Swift voice/screen companion, and one FastAPI provider backend.

**Save transcript → assemble turn → J1 → continuous Moo or Nano summary → J7 tags/summary quality → J6 suggested connections.** Every route retains source text. Uncertain and off-topic thoughts remain accessible. Local saving and backend acceptance are separate statuses.

This is a development build. Fixture mode labels simulated responses; model output can still be wrong or incomplete. Review saved evidence and unresolved work before relying on an answer.

## Quick start without provider accounts

Requirements: Apple Silicon Mac, macOS 14+, Apple command-line tools, Node 22.13 or newer, and npm. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run build:desktop
npm run build:native
MOOLAI_MODE=fixture npm run desktop
```

The desktop starts the independent Agent runtime when needed. Type a thought and press **Send**. Try “Moo, help me understand this note,” followed by more turns, then **End conversation**. Fixture mode exercises saving, routing and UI behavior with clearly marked simulated generation; it is not a model-quality test.

The runtime can run without Electron:

```sh
npm run demo
```

Local data is stored in `~/Library/Application Support/Moolai`: SQLite records, pending operations, immutable attachments and an authenticated runtime connection file. Set `MOOLAI_DATA_DIR` to use an isolated test directory. Only one runtime should use a data directory/port. Closing the window leaves an explicitly enabled session running; use **Stop session** to stop capture. Stop a terminal-hosted runtime with Ctrl-C. To change fixture/live mode, stop the existing runtime first; the interface shows its actual mode.

## Enable real providers

Use Docker Desktop and Python 3.13 for backend development. Provider keys belong only in `backend/.env`; the Agent and renderer do not read that file.

```sh
cp backend/.env.example backend/.env
cp runtime.env.example runtime.env
```

Fill TypeSafe/Jev, Nebius and Tavily keys in `backend/.env`. Choose a random `MOOLAI_BACKEND_TOKEN` and put the same token in both files. `runtime.env` contains only that local API token and endpoint. Both secret files are ignored by Git.

```sh
docker compose up --build -d
npm run desktop
```

The configured exact models are Jev 1.13, Nemotron 3 Nano for summaries, Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) for answers/tools, and MiniCPM-V 4.5 (`openbmb/MiniCPM-V-4_5`) for images. The backend checks Nebius account inventory and fails visibly if a model is missing. It never chooses another model silently. Tavily supplies web research. See [backend setup and API](backend/README.md). Existing installations should update `NEBIUS_AGENT_MODEL` in their ignored `backend/.env` and restart/recreate the backend to apply it.

Provider calls use bounded context/output and no automatic paid retries. This build is not an account-wide spending limiter. Provider failure leaves the original text saved locally and exposes retryable work.

## Enable local voice

Download the selected ASR artifacts once, then keep the ASR process running during a study session:

```sh
npm run setup:asr
npm run asr
```

In a second terminal, launch the desktop and choose **Listen**. The installer verifies exact hashes from [whisper-artifacts.json](docs/whisper-artifacts.json): Whisper **large-v3-turbo F16** (1.51 GiB), Silero VAD 6.2.0 and whisper.cpp 1.9.4 on Apple Silicon Metal. It requires Python 3.12+, Apple command-line tools and ffmpeg. Audio stays local.

Select `large-v3-turbo` or `large-v3` through the `model` field in [asr-config.json](asr-config.json). Then rerun setup and restart ASR; there is no automatic model substitution. The same file configures the Moo vocabulary hint and bounded pause detection. See [speech configuration and behavior](docs/whisper-integration.md).

The first microphone request may show a macOS permission prompt. Screen permission is requested only for an authorized capture. Direct requests open a conversation with or without **Moo**; subsequent speech stays in it across ASR chunks and pauses. J1 assesses assembled turns, including natural endings. Say **“Moo, finish conversation”** or use **End conversation**. If work is running, choose finish, cancel or continue. An explicit **Send voice turn** is available alongside endpoint detection.

Select the microphone in System Settings → Sound → Input before testing Listen. The adapter emits complete utterances, preserves line breaks inside them, and saves rejected repetitive output for review without routing it. Test microphone accuracy, final-word retention and speech-output echo handling on the device you intend to use.

Apple speech synthesis pauses recognition before speaking, then resumes it when appropriate. **Stop/Talk** interrupts speech. This phase uses turn-taking; overlapping speech is not a supported interaction. Microphone PCM stays in memory; the app retains transcripts and requested screen evidence, not microphone recordings. See [native protocol and permissions](native/README.md).

## Use and boundaries

- Set a study subject when useful. Off-topic is relative to that subject; it does not rate the thought's value.
- J7 assigns Question, Reference, Idea or Action and assesses fidelity/context independently. Nano proposes up to three editable topic/subcategory suggestions; manual tags are preserved.
- Ready, Needs review and Pending describe summary fidelity/context, with provisional 0.8 decision thresholds. Missing assessment never implies Ready.
- J1 can offer contextual screen help for a visual question. The controller keeps the original request/revision through the offer and “yes,” then captures once and sends the original question plus added constraints to MiniCPM. Ordinary general-help offers capture nothing. Declining, unrelated replies or revoked capture do not trigger the offered screenshot; corrected requests require fresh acceptance.
- Ultra receives structured evidence from MiniCPM, not raw image bytes. Visual features and tentative identifications are separate from OCR text fields. Unsupported or contradictory OCR values are withheld; uncertain/absent visual targets need clarification. Image instructions are source data.
- Moo can search/read Brain notes and selected local folders, create notes, interpret requested screenshots and research the web. “Use only my notes” includes Brain plus selected folders and disables web tools for the conversation.
- J6 compares at most five content-related candidates and saves suggested links. It never merges or deletes notes.
- Close, cancel, capture/session stop and interruption recovery consolidate the same conversation node, including linked requests and executed tool outcomes. Capture stop does not close the conversation. Failed/interrupted provider work stays visible for explicit retry.
- Source transcripts, speaker roles, manual edits, retries and Markdown export remain accessible from the interface.

### Read-only local folders

Install [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`brew install ripgrep` on macOS), or set `MOOLAI_RG_PATH` in `runtime.env` to an installed `rg` executable. The desktop inherits the runtime environment; a missing executable is reported explicitly. Open **Local folder access → Choose folder** to grant access. No folders are selected initially. Remove a folder from this list to revoke future reads. Grants are kept in `local-folders.json` in the app data directory.

Retrieved excerpts may be sent to the configured model provider. Search is literal by default, with explicit regex and filename modes; results contain relative paths, lines and content fingerprints. Limits are 50 matches, five seconds per operation, 200 lines/16,000 characters per read and 4 MiB per UTF-8 file. Ignored, hidden, credential, log, database and binary files are excluded; symlinks are not followed. Large folders can exceed the bounded file listing; select a narrower folder. These are read-only tools, not terminal access or an Obsidian adapter.

The Agent imports only [shared contracts](packages/contracts/src/index.ts), with capabilities injected through `BrainPort` and narrow provider ports. It runs against SQLite and an independent in-memory adapter in the same acceptance suite. This proves the boundary used in this phase; an actual Obsidian adapter, full Brain editor/graph, and two-way collaboration remain later phases. See [architecture](docs/architecture.md).

## Verify

```sh
npm run check
npm run test:desktop
sh native/test.sh
npm run build:native
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt -c backend/constraints.txt
cd backend
.venv/bin/python -m pytest -q
```

With the ASR server running, `npm run test:asr` performs real local streaming inference on temporary synthetic speech, writes transcript/timing results under ignored `.data/validation/`, and deletes the audio. It requires macOS `say` and FFmpeg. It does not validate microphone accuracy or a user's accent. The [native guide](native/README.md) also covers the multi-block synthetic speech check.

GitHub Actions runs TypeScript/build and Python checks on Linux, real Postgres acceptance/replay tests, and a backend container smoke. The desktop smoke runs locally on macOS in isolated fixture storage and stops its own runtime. Automated checks do not call paid providers.

Optional harness and model experiments live under `experiments/`, with separate setup instructions. Their synthetic inputs are versioned; generated outputs and provider traces are local artifacts. They do not select production defaults automatically.

Keep internal development notes, session logs, provider reports, speech transcripts, screenshots and source snapshots out of Git. Use Obsidian for project records and ignored `.data/` for local test artifacts. Only setup, architecture, API documentation and reusable synthetic fixtures belong in the repository. See [contribution guidance](CONTRIBUTING.md).
