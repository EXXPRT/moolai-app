# Moolai

A second-brain workspace for talking through ideas with **Moo**, retaining their source and exploring connections between them. The app combines a continuous conversation with a graph of your notes, backed by an independent TypeScript Agent, SQLite/files storage, a Swift voice/screen companion and one FastAPI provider backend.

**Save transcript → J1 / continuous Moo → Lightning topic episodes → J7 tags/summary quality → J6 connections.** Every route retains source text. Uncertain and off-topic thoughts remain accessible. Local saving and backend acceptance are separate statuses.

This is a development build. Fixture mode labels simulated responses; model output can still be wrong or incomplete. Review saved evidence and unresolved work before relying on an answer.

## For hackathon judges

Moolai is a macOS desktop app, entered in the **Best Apps and Agents** track. You talk through what you're studying; Moo keeps every word, organizes your thoughts into connected notes in the background, and answers out loud from your notes, your screen (only when you ask or say yes) or the web.

### How it uses NVIDIA Nemotron on Nebius Token Factory

**Nemotron 3 Ultra** answers every request: it plans the tool calls (search, read, create and connect notes, conversation history, screen reading, web research) and writes the cited answer and its spoken summary in the same call. **Nemotron 3.5 Lightning** handles the frequent background work: organizing dictation into topic notes, titles and summaries, and writing a spoken summary when an answer arrives without one. All four hosted models go through Token Factory's OpenAI-compatible API with one key, and the model is chosen per request. The backend checks the account's model list and fails visibly if a configured model is missing; it never substitutes another.

| Model | Maker | Job in Moolai | Where it runs | Override |
| --- | --- | --- | --- | --- |
| Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) | NVIDIA | Answers, tool use, spoken summaries | Nebius Token Factory | `NEBIUS_AGENT_MODEL` |
| Nemotron 3.5 Lightning (`nvidia/Nemotron-3_5-Lightning`) | NVIDIA | Topic notes, titles, summaries | Nebius Token Factory | `NEBIUS_SUMMARY_MODEL` |
| GLM 5.3 Flash (`zai-org/GLM-5.3-Flash`) | Z.ai | Exact text and table values on screen | Nebius Token Factory | `NEBIUS_OCR_MODEL` |
| MiniCPM-V 4.5 (`openbmb/MiniCPM-V-4_5`) | OpenBMB | Describing a visual scene | Nebius Token Factory | `NEBIUS_VISION_MODEL` |
| Jev 1.13 (`jev-1.13.0`) | TypeSafe | J1 routing of each turn, J7 tags and summary review, J6 connections | TypeSafe API | `JEV_MODEL` |
| Whisper large-v3-turbo | OpenAI | Speech recognition (default) | Your Mac, whisper.cpp | `asr-config.json` |
| Qwen3-ASR 1.7B | Qwen (Alibaba) | Optional speech recognition with live captions | Your Mac, MLX | [Qwen option](docs/whisper-integration.md#optional-local-qwen-trial) |
| Kokoro (`af_heart`) | hexgrad | Moo's voice | Your Mac, MLX | `tts-config.json` |

[Tavily](https://tavily.com) supplies web search and page extraction. Model IDs are pinned in `backend/moolai_backend/settings.py`; set the override variables in `backend/.env` if an ID changes.

### Try it

- **Without keys:** [Quick start](#quick-start-without-provider-accounts) runs fixture mode. Responses are simulated and labelled, and nothing is sent to a model.
- **With your own keys:** [Enable real providers](#enable-real-providers) and [Enable local voice](#enable-local-voice). You need Docker Desktop and Nebius Token Factory, TypeSafe and Tavily keys.
- **The demo video's live captions** use the optional local Qwen recognizer: `MOOLAI_ASR_CONFIG=scripts/qwen-asr/trial-config.json npm run asr` after its [one-time setup](docs/whisper-integration.md#optional-local-qwen-trial).

### Known limitations

- If you pause for about a second and start again, Moo may treat it as one turn.
- The spoken summary can leave out a qualification. The full answer is always on screen, and "read it in full" reads all of it.
- On dense tables, screen reading may leave out a value; it does not invent one, and Moo says when it could not read a value. Reading a screenshot can take up to a minute; after 60 seconds Moo stops and says so.
- Long or dense dictation may need **Retry organization**. The transcript is always saved.
- Search returns the top matching notes; it is not an inventory of the whole Brain.
- When notes disagree, Moo can misjudge which dated statement is current. Check the cited notes.
- Screen help captures the whole main display, leaving out Moolai's own window. A screenshot is attached to every note from the conversation it was taken in.
- In the desktop app, save title or summary edits before switching notes.
- If storage or a provider fails, Moo says so; repeat the request or press **Retry**. Moo never repeats a failed provider call by itself. It makes extra calls only to finish an answer: one shorter retry when an answer runs out of room, a spoken summary when the answer has none, and the screenshot you asked for when the answer skipped it.
- A very long single session uses more storage than it needs. Start a new session for each sitting.
- There is no sync yet. Use one device per data folder and backend.
- Local-folder search is off in this build.
- Live use needs an Apple Silicon Mac with local speech set up, plus your own provider keys. Fixture mode needs neither.

### Roadmap

The Agent reaches storage only through one Brain port, and the same acceptance suite runs it against two adapters, SQLite and in-memory. An Obsidian adapter behind the same port and two-way sync between people's Brains are later work; neither is part of this submission.

## Quick start without provider accounts

Requirements: Apple Silicon Mac, macOS 14+, Apple command-line tools, Node 22.13 or newer, and npm. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run build:desktop
npm run build:native
MOOLAI_MODE=fixture npm run desktop
```

The desktop starts the independent Agent runtime when needed. Type a thought and press **Send**. Try “Moo, help me understand this note,” followed by more turns, then **Finish conversation**. Fixture mode exercises saving, routing and UI behavior with clearly marked simulated generation; it is not a model-quality test. Screen help in fixture mode uses a simulated image and never takes a real screenshot.

The runtime can run without Electron:

```sh
npm run demo
```

Local data is stored in `~/Library/Application Support/Moolai`: SQLite records, pending operations, immutable attachments and an authenticated runtime connection file. Set `MOOLAI_DATA_DIR` to use an isolated test directory. Only one runtime should use a data directory/port. Closing the window stops microphone capture and playback while retaining the conversation. Use **Mic off** to stop capture or **Stop session** to end the study session. Both return at once; organization of the remaining speech continues in the background ("Organizing your thoughts…"). Each **Start session** begins a new session transcript, and quitting or restarting also ends the current one. Start also closes a conversation left open by an earlier session, quietly and keeping its transcript, unless its answer is still being prepared. An answer still being prepared when you stop lands in the next session's transcript. Start a new study session for each sitting. Stop a terminal-hosted runtime with Ctrl-C. To change fixture/live mode, stop the existing runtime first; the interface shows its actual mode.

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

The configured exact models are Jev 1.13, Nemotron 3.5 Lightning (`nvidia/Nemotron-3_5-Lightning`) for summaries, Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) for answers/tools, GLM 5.3 Flash (`zai-org/GLM-5.3-Flash`, low reasoning) for exact OCR fields, and MiniCPM-V 4.5 (`openbmb/MiniCPM-V-4_5`) for visual scenes. The backend checks Nebius account inventory and fails visibly if a model is missing. It never chooses another model silently. Tavily supplies web research. See [backend setup and API](backend/README.md). Nano remains an explicit configuration option; models are never substituted automatically. Standalone summaries disable thinking; topic organization retains provider-default reasoning with a 16,384-token reasoning-inclusive allowance (`NEBIUS_ORGANIZATION_MAX_TOKENS`).

Moo keeps the complete current request and a bounded recent dialogue window (six exchanges, 8 KB and 30 minutes). Omitted exchanges remain saved and are explicitly marked as unavailable context; date-based recall uses the history tool. Earlier task-specific instructions are historical context, not permanent settings. Controller constraints such as notes-only remain enforced.

A corrected request can show a separate **Moo understood** line generated with the answer; original captions remain unchanged. It disappears on a new response or corrected source. Speech renders unambiguous dates, process arrows and unit rates naturally while preserving the written answer. Ambiguous symbols rely on the generated spoken explanation.

Provider calls use bounded context/output. A failed provider call is never repeated automatically. Three automatic extra calls only complete an answer: one shorter retry of an Agent answer that exhausts its output allowance, a Lightning spoken summary for a long or structured answer that arrives without one, and the screenshot the user asked for when the answer was written without it. This build is not an account-wide spending limiter. After local saving succeeds, provider failure leaves the original text available. Backend connectivity is shown separately from a note’s processing state; reconnecting does not replay failed work. An affected note offers **Retry summary**, which retries only its processing and does not replay earlier agent requests or tools. Technical diagnostics stay outside the note reader.

## Everyday startup after setup

Run `npm run moo`, or double-click **Moo.command** in the project folder. This rebuilds the desktop/native companion/backend, starts Docker Desktop if needed, refreshes Moolai's backend container, restarts the owned ASR and Agent runtime, then opens the app with the microphone off. Existing database volumes remain in place and SQLite is backed up before reopening. Unrecognized port owners are left alone; startup reports the conflict instead.

To restart a running Moo from the command line, for example to free memory, run `npm run restart`: it is the same full rebuild and restart. Stop the session first and wait until organizing finishes; notes still being organized when Moo closes need **Retry organization**.

Install dependencies and voice assets once using the setup commands below. Run this launcher again after code or configuration changes; a simple `npm run desktop` can otherwise reuse an older runtime. Startup logs and backups are stored in the selected data directory. A machine-specific entry may live in ignored `.data/start-moo.local.mjs`; the repository launcher works without it.

New speech immediately appears as a **Growing note** with a source-based title and attributed preview, clearly distinguished from an AI summary. The first background organization pass is scheduled after about six seconds; subsequent new content is coalesced at roughly one-minute intervals. Lightning can extend the same note or start another topic episode, followed by classification and connections. The previous accepted summary remains visible during updates. Pauses and timer boundaries do not split notes. A complete summary remains eligible for same-topic continuation. Ending the study session settles the current note without duplicating it; stopping the microphone or closing a Moo conversation only checkpoints it. Your manual edits survive processing; failed work requires **Retry organization** and is never automatically resubmitted. Successful batches with more saved source can continue in the background even when the microphone is off. Closing processes at most four batches; **Continue organization** makes remaining work explicit while keeping the accepted summary visible. Existing historical notes are not reorganized.

**Live note generation** follows the current growing note and shows revisable speech separately from its accepted summary. It is on initially; switching it off stops automatic navigation, not background saving. Selecting another note, editing, or closing the inspector pauses following until **Resume live note**. Provisional speech is a temporary preview, not a permanent knowledge note.

Say **“Don’t save that”** to suppress the current derived note while retaining the original transcript/conversation and history. Moo asks for clarification if the active episode and pending speech are ambiguous. Suppressed source cannot recreate the note after processing or restart; later speech can start a fresh note. This is not transcript deletion.

Enable **Auto-follow latest** above the conversation to follow incoming messages. Scrolling up pauses following so you can read earlier messages; **Jump to latest** returns to the newest message.

## Enable local voice

Download the selected ASR artifacts once, then keep the ASR process running during a study session:

```sh
npm run setup:asr
npm run setup:tts
npm run asr
```

In a second terminal, launch the desktop, choose **Start session**, then enable the microphone toggle. The installer verifies exact hashes from [whisper-artifacts.json](docs/whisper-artifacts.json): Whisper **large-v3-turbo F16** (1.51 GiB), Silero VAD 6.2.0 and whisper.cpp 1.9.4 on Apple Silicon Metal. It requires Python 3.12+, Apple command-line tools and ffmpeg. Audio stays local.

Select `large-v3-turbo` or `large-v3` through the `model` field in [asr-config.json](asr-config.json). Then rerun setup and restart ASR; there is no automatic model substitution. The same file configures the Moo vocabulary hint and bounded pause detection. See [speech configuration and behavior](docs/whisper-integration.md), which also covers the optional local Qwen recognizer with live captions.

The first microphone request may show a macOS permission prompt. Screen permission is requested only for an authorized capture. macOS checks it for the app that ran `npm run moo`, such as Warp or Terminal, not for Moolai Native; `npm run moo` warns at startup when that app does not have it. Direct requests open a conversation with or without **Moo**; subsequent speech stays in it across ASR chunks and pauses. J1 assesses assembled turns, including natural endings. Say **“Moo, finish conversation”** or use **Finish conversation**. If work is running, choose finish, cancel or continue. Voice turns complete through local endpoint detection; **Send** submits typed text.

The microphone waits up to 90 seconds for the local recognition service to report ready, without capturing audio during that wait. You can switch it off to cancel startup. If startup fails, start or check `npm run asr`, then turn the microphone on again; the app does not reopen it automatically after failure or an explicit stop. A saved-text summary failure is separate from microphone/recognition availability.

Select the microphone in System Settings → Sound → Input before enabling the microphone. The adapter emits complete utterances, preserves line breaks inside them, and saves rejected repetitive output for review without routing it. Test microphone accuracy, final-word retention and speech-output echo handling on the device you intend to use.

Local Kokoro Heart (`af_heart`) is the default voice. `npm run setup:tts` installs the pinned runtime/model; Python 3.12+ is required. The worker warms when voice is enabled and stays loaded in the Agent host. Configure `tts-config.json`; `provider: "apple"` explicitly selects Apple speech instead. Kokoro streams in-memory PCM through the same native voice-processing engine as active capture. Output-only playback uses a separate engine that never opens microphone input. Detected user speech pauses playback and holds further tool dispatch and publication. A sound with no words, or only a filler such as “uh huh” or a bare “Moo” while Moo is speaking or working, resumes playback: nothing is routed, and the sound is hidden from the chat but kept in the session record. Real words stop playback and go to J1; a pause still unresolved after 8 seconds also stops it. A bare “Moo” while Moo waits gets “I'm here and listening.”, and while it works silently, a short status line; a repeat within about 10 seconds is ignored as echo. Attention checks preserve the original task; substantive new requests supersede it. An answer stopped by real words is not restarted automatically. **Stop speech** ends playback only; the answer, the conversation and any walkthrough offer stay. **Stop response** appears while an answer is being prepared and nothing is playing, and cancels that answer. Turning the microphone on never cancels an answer. Each answer requests a concise spoken summary paragraph in the same generation call. If a short plain-prose answer omits it, the complete answer can be spoken without another model call; for a long or structured answer, Lightning writes the summary in a second call. Optional detailed walkthroughs cannot block that summary. Ask “read it in full,” “repeat that,” or “walk me through it” to replay the saved answer without restarting research; walkthroughs continue in batches of five. Missing narration is reported separately from a saved written answer. Full detail remains onscreen in Markdown. Acoustic interruption and echo rejection must be validated on the intended headset and speakers; a build alone does not establish them. Microphone PCM stays in memory; the app retains transcripts and requested screen evidence, not microphone recordings. See [native protocol and permissions](native/README.md).

## Use and boundaries

- Set a study subject when useful. Off-topic is relative to that subject; it does not rate the thought's value.
- J7 assigns Question, Reference, Idea or Action and assesses fidelity/context independently. Lightning proposes up to three topic/subcategory suggestions; existing manual tags are preserved.
- Ready, Needs review and Pending describe summary fidelity/context. A summary needs review when J7 rates source fidelity below 0.4 or understandability below 0.6. Missing assessment never implies Ready.
- J1 can offer contextual screen help for a visual question, and Moo offers it after saving a doubt you state (“I saved your thought. Would you like me to look at your screen to help with it?”). The controller keeps the original request/revision through the offer and “yes,” then captures once and sends the original question plus added constraints to MiniCPM for a visual question, or to GLM OCR for a saved doubt. Ordinary general-help offers capture nothing. Declining, unrelated replies or revoked capture do not trigger the offered screenshot; corrected requests require fresh acceptance.
- Ultra receives structured evidence from GLM for OCR or MiniCPM for visual scenes, not raw image bytes. A requested screen analysis is attempted once; failed extraction does not trigger another capture or a change of mode without a new user request. A reading that takes more than 60 seconds is stopped, and Moo says so. Visual features and tentative identifications are separate from OCR text fields. Unsupported or contradictory OCR values are withheld; uncertain/absent visual targets need clarification. Image instructions are source data.
- Moo can search/read Brain notes, create notes, interpret requested screenshots and research the web. “Use only my notes” disables web tools for the conversation. Web pages and screen readings reach the model once, in the request that fetched them; later requests see only short receipts, and a follow-up may open a page an earlier search returned.
- J6 compares at most five candidates using retained source, up to two of them conversation neighbours and the rest content matches, and automatically accepts associations scoring at least 0.8. Generated provenance and confidence remain stored; removing an association is persistent. Summary review status does not by itself block connections. It never merges or deletes notes.
- Transcripts save immediately. Roughly once a minute, Lightning organizes new dictation and Moo dialogue into consecutive topic episodes. A pause is not a note boundary; the latest topic remains available for continuation even after a complete summary. Session stop finalizes remaining content. Full conversations remain source records, while graph notes retain attributed source spans, original requests and execution context. Failed/interrupted provider calls require explicit retry; oversized source is never silently clipped. Existing historical notes are not automatically reorganized.
- Each note opens on its summary. Recorded text and connections are separate tabs, with speaker attribution and linked original conversations preserved. Title and summary edits are protected from later processing.

### Read-only local folders (off in this build)

Local-folder search is switched off in the submitted build: the desktop hides the folder control and the runtime refuses grants. It is development-only and needs `MOOLAI_LOCAL_FOLDERS=on` in `runtime.env`. The rest of this section applies only then.

Install [ripgrep](https://github.com/BurntSushi/ripgrep#installation) (`brew install ripgrep` on macOS), or set `MOOLAI_RG_PATH` in `runtime.env` to an installed `rg` executable. The desktop inherits the runtime environment; a missing executable is reported explicitly. Open **Local folder access → Choose folder** to grant access. No folders are selected initially. Remove a folder from this list to revoke future reads. Grants are kept in `local-folders.json` in the app data directory.

Retrieved excerpts may be sent to the configured model provider. Search is literal by default, with explicit regex and filename modes; results contain relative paths, lines and content fingerprints. Limits are 50 matches, five seconds per operation, 200 lines/16,000 characters per read and 4 MiB per UTF-8 file. Ignored, hidden, credential, log, database and binary files are excluded; symlinks are not followed. Large folders can exceed the bounded file listing; select a narrower folder. These are read-only tools, not terminal access or an Obsidian adapter.

The Agent imports only [shared contracts](packages/contracts/src/index.ts), with capabilities injected through `BrainPort` and narrow provider ports. It runs against SQLite and an independent in-memory adapter in the same acceptance suite. The Brain workspace exposes a focused note reader and graph through these same contracts. The shared records retain revision history and storage compatibility independently of the desktop surface. Two-way collaboration remains later-phase work. See [architecture](docs/architecture.md).

## Verify

```sh
npm run check
npm run test:desktop
sh native/test.sh
npm run build:native
python3.13 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt -c backend/constraints.txt
cd backend
.venv/bin/python -m pytest -q
```

The application tests call ripgrep and FFmpeg from your PATH (`brew install ripgrep ffmpeg`); without ripgrep, the local-file tests fail. CI installs both. The backend needs Python 3.13.

With the ASR server running, `npm run test:asr` performs real local streaming inference on temporary synthetic speech, writes transcript/timing results under ignored `.data/validation/`, and deletes the audio. It requires macOS `say` and FFmpeg. It does not validate microphone accuracy or a user's accent. The [native guide](native/README.md) also covers the multi-block synthetic speech check.

GitHub Actions runs TypeScript/build and Python checks on Linux, real Postgres acceptance/replay tests, and a backend container smoke. The desktop smoke runs locally on macOS in isolated fixture storage and stops its own runtime. Automated checks do not call paid providers.

Optional harness and model experiments live under `experiments/`, with separate setup instructions. Their synthetic inputs are versioned; generated outputs and provider traces are local artifacts. They do not select production defaults automatically.

Keep internal development notes, session logs, provider reports, speech transcripts, screenshots and source snapshots out of Git. Use Obsidian for project records and ignored `.data/` for local test artifacts. Only setup, architecture, API documentation and reusable synthetic fixtures belong in the repository. See [contribution guidance](CONTRIBUTING.md).

## Chat, graph and notes

Moo and the graph share the main screen. Talk or type to retain a thought; Lightning organizes accumulated dictation and conversation by topic, then J7 reviews each summary and J6 connects relevant notes. The compact recent-note strip and graph both open the same inspector, leaving chat accessible.

The inspector always opens on **Summary**, with exactly three tabs:

- **Summary:** a readable title and summary, a discreet Edit action and a small processing/review message when needed. Failed processing offers **Retry summary** without rerunning an earlier conversation or task.
- **Recorded text:** original dictation, Moo conversation or written content, with You/Moo attribution, attachments and links to original conversation sources. A note can contain more than one source type.
- **Connections:** related titles and previews; click to explore or remove an unwanted association.

Search, topic and category filters are available in the collapsed **Search & filters** control. Internal IDs, raw provider errors, revision numbers and confidence scores are excluded from the reader. Titles are clickable references to stable internal records. The graph shows up to 100 recent notes plus a selected note and up to 30 linked or same-session neighbours, with its visible scope indicated. A study session with two or more visible notes is drawn as a hub linked to them. Zoom and selection remain stable as notes arrive.

The first schema upgrade creates `brain.before-v2.sqlite` beside the local database before enabling revision history. History begins at the upgrade; earlier versions are not reconstructed. Source records, attachment references, archived records and manual edits remain stored even when their management controls are absent from the desktop. This focused interface has no manual note-creation, reply/correction, archive, snapshot-transfer or export controls. Moo can still create a note when requested through its guarded tools. Two-way synchronization remains future work.

Topic grouping is a model judgment, not a guarantee of the ideal note size. Corrections to a whole source block update its retained excerpt and mark the note for review; a correction spanning already-separated topics is retained for explicit review instead of guessing new boundaries. Existing historical notes are not automatically regrouped.

Use `npm run check` for deterministic application checks and `npm run test:desktop` for the real Electron reader/graph smoke test. Fixture mode makes no paid inference requests and the smoke test disables microphone capture.

### Recall and connections

Moo uses `conversation_history` for calendar-day recall, based on actual transcript timestamps in the host timezone. A successful empty result can include the latest earlier discussion; failed retrieval does not establish absence. `connect_notes` links existing notes on explicit request, with exact-title/ID resolution and ambiguity checks; it does not create a combined note. Automatic J6 associations remain source-grounded, using up to two conversation neighbours among at most five candidates. Removed associations remain dismissed.

Related enumerated reviews stay together during topic consolidation. Failed batches remain saved for explicit retry; corrections invalidate stale results, while later unrelated work does not. Technical routing/connection traces stay in local Brain state.

Runtime ownership is exclusive per workspace. A slow health response does not start a second Agent; use `npm run moo` to perform a managed restart. The desktop registers its process as the voice owner, so a detached runtime stops capture if that app process exits. A failed graceful shutdown closes the owned native companion rather than leaving hidden capture running. These controls are covered by synthetic tests; microphone/device and acoustic acceptance remain separate.

`npm run test:desktop:regressions` checks pending note saves, citation links and event/poll ordering in an isolated Electron renderer. It does not open your workspace or microphone.
