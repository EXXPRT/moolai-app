# Configurable local speech

The selected ASR is **Whisper large-v3-turbo F16 with Silero 6.2.0 speech detection**, running through pinned whisper.cpp 1.9.4 on Apple Silicon Metal. The primary close phrase is **“Moo, finish conversation.”** Full large-v3 remains an explicit configuration choice. There is no automatic model fallback.

## Setup and model selection

Install Node dependencies, Python 3.12+, Apple command-line tools and ffmpeg. Then run:

```sh
npm ci
npm run setup:asr
npm run asr
```

Setup verifies the pinned source, build tool, selected model and VAD artifacts in [whisper-artifacts.json](whisper-artifacts.json). It builds the local runtime and downloads only the selected Whisper model. Artifacts and build output stay under ignored `.data/asr/whisper`. Setup starts no microphone or inference session.

Edit [asr-config.json](../asr-config.json) to select:

```json
"model": "large-v3-turbo"
```

or:

```json
"model": "large-v3"
```

Stop ASR, run `npm run setup:asr` for the selected artifact, then restart `npm run asr`. Restart the Agent if changing its connection port. `MOOLAI_ASR_CONFIG=/absolute/path/to/config.json` selects a separate complete configuration; a relative path resolves against the repository. `MOOLAI_ASR_URL` remains an explicit native-connection override. An unknown model, malformed configuration or missing/mismatched artifact fails visibly.

The same file controls the English language, short `Moo.` vocabulary hint, localhost ports, pause duration, microphone energy threshold, pre-roll and maximum utterance duration. These thresholds are provisional and configurable. They do not change Agent conversation membership. The configuration contains no API keys; provider keys remain in ignored `backend/.env`.

## Optional local Qwen trial

Qwen3-ASR-1.7B BF16 is an explicit trial option. It runs through pinned MLX Audio on Apple Silicon. It does not automatically replace the default Whisper configuration.

With Python 3.13+, set up the isolated environment and verified artifacts:

```sh
python3 scripts/qwen-asr/setup.py
```

Turn the microphone off and stop the running ASR service before starting the trial on the same local port:

```sh
MOOLAI_ASR_CONFIG=scripts/qwen-asr/trial-config.json npm run asr
```

Wait for `Local Qwen trial ready`, then use the app's microphone control. To return to Whisper, stop the trial and run `npm run asr` without the override. `npm run moo` restarts the recognizer it manages with the default configuration, so to use Qwen through the everyday launcher, pass the override to it instead: `MOOLAI_ASR_CONFIG=scripts/qwen-asr/trial-config.json npm run moo`. Changing the model on the same port does not require restarting the Agent or replaying saved work. Never replace an ASR process while capture is active.

Repeating the startup command for the same running model reports `Local ASR already running` and exits without loading another copy or changing microphone state. The running service keeps its existing configuration; apply configuration changes by explicitly stopping and restarting it with the microphone off. A different model or unrecognized occupied port is reported without stopping that service.

Pins and dependency versions are in `scripts/qwen-asr/`. Assets stay under ignored `.data/asr/qwen`; runtime loading is offline. The Qwen trial enables provisional text with `livePreview: true` and `previewIntervalMs: 2000`. Bounded audio snapshots are decoded serially, with only the latest pending preview retained. Final utterances take priority and late previews are discarded; preview failure does not by itself reject a final utterance. Silero first checks whether an utterance contains speech; the original audio is then decoded without trimming. The existing energy/pause endpoint, context snapshot, memory/queue bounds and Stop/Send protocol remain. Incomplete, repetitive or cancelled output is not published as a successful transcript; there are no automatic retries or model substitutions. `beamSize` is Whisper-only and must be omitted for Qwen.

Qwen's optional **ForcedAligner** is needed for word-level timing, not plain dictation. This trial does not install it or use the runtime's estimated token timings. Moolai retains its existing host-generated transcript times and turn identities; these are not precise acoustic word boundaries. Microphone audio stays in RAM.

`node scripts/compare-qwen-asr.mjs` compares two already-running isolated bridges on ports 8178 (Whisper) and 8188 (Qwen), using frozen generated speech. It records the model outputs and timing under ignored `.data/validation/`, deletes temporary synthetic audio, and opens no microphone. These checks do not establish personal dictation accuracy or natural live-stream latency.

## Capture and transcript boundaries

Swift streams mono PCM16 at the actual microphone rate to one local WebSocket bridge. The bridge keeps pre-roll, assembles an utterance using energy and a silence interval, resamples through ffmpeg pipes, and sends an in-memory WAV to the resident Whisper server. **Pause detection uses PCM energy; Silero VAD screens speech inside the server before decoding.** This is not a claim of frame-by-frame Silero endpointing.

The loopback WebSocket is native-only: connections with a browser `Origin` header are rejected before acquiring the capture slot. Native clients send no Origin. A connection must configure its sample rate within five seconds or its unused slot is released; an idle web page cannot hold it indefinitely. This is a browser-origin and abandoned-handshake guard, not authentication against other local processes. The Whisper inference server behind the bridge answers only under a random request path chosen at each launch and passed to the bridge alone, so a web page cannot reach its `/inference`, `/load` or `/health` routes; every other path returns 404.

The bridge assembles fixed 20 ms analysis frames across socket packets. Packet boundaries do not determine speech boundaries. Stop processes the remaining short frame before acknowledging completion; retained PCM is not rewritten.

The first implementation emits final utterances only. It preserves Whisper's wording and embedded newlines as one transcript. It does not feed replacement hypotheses into an append-only delta assembler. The existing native identity/revision contract and Agent's longer Moo conversation remain intact, with no new Jev gate.

Each utterance is bounded by `maxUtteranceSeconds` (60 by default). Reading aloud rarely pauses for the full endpoint, so past three quarters of the limit a 300 ms sentence gap ends the utterance; speech with no such gap is emitted at the limit and the next frame starts a new utterance. Continuous speech is therefore split into consecutive finals, with every captured sample sent once and none dropped; a word can be cut only at a hard split. At most two queued/active utterances are decoded sequentially, each with a ten-second timeout. Exact digital silence causes no inference. Model repetition triggers a visible failure; rejected text is saved as an unconfirmed Brain record, without routing, tool execution or summarization.

Stop/Send drains already-captured PCM, completes pending transcriptions, emits all final text, and only then acknowledges commit. Native Stop waits up to 35 seconds; the host allows 40 seconds for Stop and 60 seconds for Flush plus reconnection. Concurrent Stop/Flush/TTS calls share a drain. Failed Stop still drains diagnostic storage before closing the Brain. Disconnected requests cannot deliver stale text into a new capture.

Audio buffers are released after completion, cancellation or failure. The server runs without `--convert`, so it reads uploaded WAV bytes in memory. Microphone recordings are not written to disk. Recognition stays active through voice-processed synthesis. Local speech onset pauses playback; real words stop it and redirect the current exchange, while a sound with no words or a lone filler resumes it; acoustic echo rejection remains device-dependent and requires acceptance testing.

## Conversation controls and validation

Conversation intent belongs to J1 and the Agent controller. The source transcript is preserved as recognized. New Moo conversations announce “Moo, finish conversation”; the End button remains available. Quoted and negated endings are content, and work in progress retains finish/cancel/continue handling. Recognition of a control phrase alone does not establish that the controller acted correctly.

Run `npm run test:asr` with the local ASR service loaded for a synthetic streaming check. For multi-block speech and native synthesis, run `node --import tsx scripts/validate-synthetic-speech.ts .data/validation/synthetic-speech.json`. Neither starts the microphone. Outputs belong under ignored `.data/`; generated audio is deleted.

Separately test the selected microphone, ordinary pauses, complete final words on Stop/Send, spoken interruption during TTS, echo rejection, and quiet/noisy speech. A successful build or synthetic check does not establish human-speech accuracy. Use typed controls when recognition is ambiguous.

## Context and decoder comparison

The host supplies up to 400 characters of the current subject, relevant note titles and explicitly corrected terminology. The bridge snapshots hints when an utterance begins; later updates cannot alter a queued decode. Source transcripts are never rewritten through word replacements. The base `initialPrompt` remains limited to 200 characters. A transcript made only of the wake word and these hints, as Qwen prints for a cough or click, is not shown as a preview, and as a final is decoded once more without hints: if that decode hears nothing usable it is rejected (`hint_echo`), otherwise the hint-free words are used, though a lone `Moo.` is kept. Real speech made only of these words, such as a lone corrected term, is treated the same way.

Optional `beamSize` accepts integers 1–5; omitted means the current greedy setting (1). `node scripts/compare-whisper-decoder.mjs` compares 1 with 3 using identical temporary synthetic speech, alternating order and recording strict WER, latency and audio fingerprints under ignored `.data/validation/`. It refuses an active microphone capture, removes generated audio and makes no cloud calls or production changes. Synthetic accuracy does not measure an individual speaker’s ASR performance.

## Offline endpoint tests

`npm run test:voice-endpoints` compares the current configuration with a 750 ms pre-roll and 400/500/600 ms silence candidates. It runs ten annotated PCM envelopes at four sample rates entirely in memory and writes `.data/validation/voice-endpoints.json`. It opens no microphone, plays no audio, requires no ASR server, downloads no models and makes no provider requests. It never changes the selected configuration.

The report separates sample retention, thought splitting, missed quiet input, noise activation and endpoint wait. These are segmentation checks, **not WER, recognizer command accuracy, end-to-end latency or acoustic echo acceptance**. Automated regressions also verify packet-size independence, final-tail draining and that incomplete transcript revisions cannot route requests or execute tools.

Shortening the silence threshold can split a thinking pause; longer pre-roll does not make energy detection understand quiet speech. Use the report to choose candidates for later representative speech testing, not to promote a setting automatically. Whisper remains the saved ASR default and Kokoro Heart is the configured voice; a trial recognizer needs its own controlled accuracy and listening comparison before promotion.

## Live text and spoken corrections

Provisional text replaces one in-progress utterance; it is not a separate command each time a word changes. The final transcript alone reaches J1. The source keeps what was actually said, including self-corrections such as “check Ian … no, check John”; the Agent is instructed to follow the explicit correction without silently rewriting source. A correction after a pause may redirect already-started work, so live text is not an undo mechanism.

`livePreview` is optional and off unless configured; the Qwen trial enables it. It currently requires Qwen; Whisper remains final-only until its inference cancellation can be verified. `previewIntervalMs` bounds preview scheduling (default 2,000 ms when enabled), not guaranteed display latency. Decode time and local resource contention add delay. Previews use RAM only, and need no word-alignment model. Empty/rejected finals clear the provisional line without executing it; unconfirmed text remains diagnostic evidence.
